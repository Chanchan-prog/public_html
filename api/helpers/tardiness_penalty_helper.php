<?php

require_once __DIR__ . '/notification_helper.php';

const TARDINESS_POLICY_CODE = 'SEMESTER_LATE_3';
const TARDINESS_RED_FLAG_THRESHOLD = 3;

function tardiness_penalty_schema_ready($mysqli) {
    static $ready = null;
    if ($ready !== null) return $ready;
    $required = ['semester_id', 'source', 'policy_code', 'trigger_attendance_id', 'trigger_stage', 'status', 'voided_at'];
    $found = [];
    $res = $mysqli->query('SHOW COLUMNS FROM tbl_penalties');
    if (!$res) return $ready = false;
    while ($row = $res->fetch_assoc()) $found[(string)$row['Field']] = true;
    foreach ($required as $column) {
        if (!isset($found[$column])) return $ready = false;
    }
    return $ready = true;
}

function tardiness_late_checkpoints($mysqli, $userId, $semesterId) {
    $sql = "SELECT checkpoint.attendance_id, checkpoint.late_date, checkpoint.stage
        FROM (
            SELECT MIN(ar.attendance_id) AS attendance_id, ar.date AS late_date, 'check_in' AS stage,
                   cs.start_time, cs.end_time
            FROM tbl_attendance_records ar
            JOIN tbl_class_schedules cs ON cs.schedule_id = ar.schedule_id
            WHERE ar.user_id = ? AND cs.semester_id = ? AND ar.flag_in_id = 5
            GROUP BY ar.date, cs.start_time, cs.end_time
            UNION ALL
            SELECT MIN(ar.attendance_id) AS attendance_id, ar.date AS late_date, 'mid_check' AS stage,
                   cs.start_time, cs.end_time
            FROM tbl_attendance_records ar
            JOIN tbl_class_schedules cs ON cs.schedule_id = ar.schedule_id
            WHERE ar.user_id = ? AND cs.semester_id = ? AND ar.flag_check_id = 5
            GROUP BY ar.date, cs.start_time, cs.end_time
        ) checkpoint
        ORDER BY checkpoint.late_date ASC, checkpoint.start_time ASC,
                 CASE checkpoint.stage WHEN 'check_in' THEN 1 ELSE 2 END ASC";
    $stmt = $mysqli->prepare($sql);
    if (!$stmt) throw new RuntimeException('Unable to prepare tardiness checkpoint query: ' . $mysqli->error);
    $stmt->bind_param('iiii', $userId, $semesterId, $userId, $semesterId);
    if (!$stmt->execute()) throw new RuntimeException('Unable to count tardiness checkpoints: ' . $stmt->error);
    $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $stmt->close();
    return $rows;
}

function tardiness_program_head_recipient_ids($mysqli, $deptId, $programId) {
    $departmentId = (int)$deptId;
    $assignedProgramId = (int)$programId;
    if ($departmentId <= 0 || $assignedProgramId <= 0) return [];

    // assigned_program_head_id is the current multi-head program mapping.
    // tbl_programs.head_id remains a fallback only for a legacy Program Head
    // who does not yet have the current assignment field populated.
    $stmt = $mysqli->prepare("SELECT DISTINCT ph.user_id
        FROM tbl_programs p
        JOIN tbl_users ph
          ON ph.role_id = 3
         AND ph.dept_id = p.dept_id
         AND ph.status = 'active'
         AND (
              ph.assigned_program_head_id = p.program_id
              OR (ph.assigned_program_head_id IS NULL AND p.head_id = ph.user_id)
         )
        WHERE p.program_id = ?
          AND p.dept_id = ?
          AND p.status = 'active'");
    if (!$stmt) return [];
    $stmt->bind_param('ii', $assignedProgramId, $departmentId);
    if (!$stmt->execute()) {
        $stmt->close();
        return [];
    }
    $result = $stmt->get_result();
    $ids = [];
    while ($row = $result->fetch_assoc()) $ids[] = (int)$row['user_id'];
    $stmt->close();
    return $ids;
}

function tardiness_send_policy_notification($mysqli, $user, $semesterLabel, $lateCount, $action) {
    $userId = (int)$user['user_id'];
    $deptId = isset($user['dept_id']) ? (int)$user['dept_id'] : 0;
    $programId = isset($user['assigned_program_head_id']) ? (int)$user['assigned_program_head_id'] : 0;
    $name = trim((string)$user['full_name']) ?: ('User #' . $userId);
    // Email is reserved for the affected user and the responsible Dean(s).
    // Secretaries and Program Heads still receive the in-system notification
    // and Web Push, but not another policy email.
    $emailRecipients = [$userId];
    $webPushOnlyRecipients = [];
    if ($deptId > 0) {
        $emailRecipients = array_merge($emailRecipients, notif_get_user_ids_by_role_dept($mysqli, 2, $deptId));
        $webPushOnlyRecipients = array_merge($webPushOnlyRecipients, notif_get_user_ids_by_role_dept($mysqli, 4, $deptId));
        if ($programId > 0) {
            $webPushOnlyRecipients = array_merge(
                $webPushOnlyRecipients,
                tardiness_program_head_recipient_ids($mysqli, $deptId, $programId)
            );
        }
    }

    if ($action === 'created') {
        $title = 'Tardiness RED FLAG';
        $message = "{$name} reached {$lateCount} late attendance checkpoints for {$semesterLabel}. A tardiness RED FLAG was issued.";
    } elseif ($action === 'reactivated') {
        $title = 'Tardiness RED FLAG Reactivated';
        $message = "{$name} again has {$lateCount} late attendance checkpoints for {$semesterLabel}. The tardiness RED FLAG was reactivated.";
    } else {
        $title = 'Tardiness RED FLAG Voided';
        $message = "{$name}'s late attendance count for {$semesterLabel} was corrected to {$lateCount}. The automatic tardiness RED FLAG was voided.";
    }
    $emailRecipients = array_values(array_unique(array_filter(array_map('intval', $emailRecipients))));
    $emailRecipientLookup = array_fill_keys($emailRecipients, true);
    $webPushOnlyRecipients = array_values(array_unique(array_filter(array_map('intval', $webPushOnlyRecipients))));

    notif_insert_many($mysqli, $emailRecipients, $title, $message, '/report', null);
    foreach ($webPushOnlyRecipients as $recipientId) {
        if (isset($emailRecipientLookup[$recipientId])) continue;
        notif_insert_web_push($mysqli, $recipientId, $title, $message, '/report', null);
    }
}

function tardiness_reconcile_user_semester($mysqli, $userId, $semesterId) {
    $userId = (int)$userId;
    $semesterId = (int)$semesterId;
    if ($userId <= 0 || $semesterId <= 0 || !tardiness_penalty_schema_ready($mysqli)) {
        return ['late_count' => 0, 'status' => 'unavailable', 'changed' => false];
    }

    $action = null;
    $user = null;
    $semesterLabel = 'the selected semester';
    $lateCount = 0;
    $status = 'none';
    $mysqli->begin_transaction();
    try {
        $userStmt = $mysqli->prepare("SELECT u.user_id, u.dept_id, u.assigned_program_head_id, u.role_id, u.status,
                CONCAT_WS(' ', u.first_name, u.last_name) AS full_name
            FROM tbl_users u WHERE u.user_id = ? FOR UPDATE");
        if (!$userStmt) throw new RuntimeException($mysqli->error);
        $userStmt->bind_param('i', $userId);
        if (!$userStmt->execute()) throw new RuntimeException($userStmt->error);
        $user = $userStmt->get_result()->fetch_assoc();
        $userStmt->close();
        if (!$user) {
            $mysqli->commit();
            return ['late_count' => 0, 'status' => 'excluded', 'changed' => false];
        }
        $accountStatus = strtolower(trim((string)($user['status'] ?? 'active')));
        if (!in_array((int)$user['role_id'], [2, 3, 4, 5], true)
            || !in_array($accountStatus, ['active', '1', 'true'], true)) {
            $mysqli->commit();
            return ['late_count' => 0, 'status' => 'excluded', 'changed' => false];
        }

        $semStmt = $mysqli->prepare("SELECT CONCAT(COALESCE(sy.session_name, ''),
                CASE WHEN sy.session_name IS NULL OR sy.session_name = '' THEN '' ELSE ' - ' END,
                sem.term) AS semester_label
            FROM tbl_semesters sem
            LEFT JOIN tbl_school_year sy ON sy.school_year_id = sem.school_year_id
            WHERE sem.semester_id = ? LIMIT 1");
        if (!$semStmt) throw new RuntimeException($mysqli->error);
        $semStmt->bind_param('i', $semesterId);
        if (!$semStmt->execute()) throw new RuntimeException($semStmt->error);
        $semRow = $semStmt->get_result()->fetch_assoc();
        $semStmt->close();
        if ($semRow && trim((string)$semRow['semester_label']) !== '') $semesterLabel = trim((string)$semRow['semester_label']);

        $checkpoints = tardiness_late_checkpoints($mysqli, $userId, $semesterId);
        $lateCount = count($checkpoints);
        $trigger = $lateCount > 0 ? $checkpoints[$lateCount - 1] : null;

        $policy = TARDINESS_POLICY_CODE;
        $existingStmt = $mysqli->prepare("SELECT sanction_id, status FROM tbl_penalties
            WHERE user_id = ? AND semester_id = ? AND policy_code = ? LIMIT 1 FOR UPDATE");
        if (!$existingStmt) throw new RuntimeException($mysqli->error);
        $existingStmt->bind_param('iis', $userId, $semesterId, $policy);
        if (!$existingStmt->execute()) throw new RuntimeException($existingStmt->error);
        $existing = $existingStmt->get_result()->fetch_assoc();
        $existingStmt->close();

        if ($lateCount >= TARDINESS_RED_FLAG_THRESHOLD) {
            $penaltyDate = (string)($trigger['late_date'] ?? date('Y-m-d'));
            $triggerAttendanceId = (int)($trigger['attendance_id'] ?? 0);
            $triggerStage = (string)($trigger['stage'] ?? '');
            $reason = "Automatic tardiness RED FLAG: {$lateCount} distinct late check-in/middle-check warnings in {$semesterLabel}. Parallel schedules count once per checkpoint.";
            if (!$existing) {
                $typeStmt = $mysqli->prepare("SELECT penal_type_id FROM tbl_penalties_type WHERE LOWER(type_name) = 'tardiness' LIMIT 1");
                if (!$typeStmt || !$typeStmt->execute()) throw new RuntimeException('Tardiness penalty type is unavailable.');
                $typeRow = $typeStmt->get_result()->fetch_assoc();
                $typeStmt->close();
                if (!$typeRow) throw new RuntimeException('Tardiness penalty type is unavailable.');
                $penaltyTypeId = (int)$typeRow['penal_type_id'];
                $source = 'automatic';
                $active = 'active';
                $insert = $mysqli->prepare("INSERT INTO tbl_penalties
                    (issued_by, user_id, penal_type_id, semester_id, date, reason, source, policy_code,
                     trigger_attendance_id, trigger_stage, status, voided_at)
                    VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)");
                if (!$insert) throw new RuntimeException($mysqli->error);
                $insert->bind_param('iiissssiss', $userId, $penaltyTypeId, $semesterId, $penaltyDate,
                    $reason, $source, $policy, $triggerAttendanceId, $triggerStage, $active);
                if (!$insert->execute()) throw new RuntimeException($insert->error);
                $insert->close();
                $action = 'created';
            } elseif (strtolower((string)$existing['status']) === 'voided') {
                $active = 'active';
                $update = $mysqli->prepare("UPDATE tbl_penalties SET date = ?, reason = ?, trigger_attendance_id = ?,
                    trigger_stage = ?, status = ?, voided_at = NULL WHERE sanction_id = ?");
                if (!$update) throw new RuntimeException($mysqli->error);
                $sanctionId = (int)$existing['sanction_id'];
                $update->bind_param('ssissi', $penaltyDate, $reason, $triggerAttendanceId, $triggerStage, $active, $sanctionId);
                if (!$update->execute()) throw new RuntimeException($update->error);
                $update->close();
                $action = 'reactivated';
            }
            $status = 'red_flag';
        } elseif ($existing && strtolower((string)$existing['status']) !== 'voided') {
            $voided = 'voided';
            $reasonSuffix = " Auto-voided after an approved/manual attendance correction reduced the semester count to {$lateCount}.";
            $update = $mysqli->prepare("UPDATE tbl_penalties SET status = ?, voided_at = NOW(), reason = CONCAT(reason, ?) WHERE sanction_id = ?");
            if (!$update) throw new RuntimeException($mysqli->error);
            $sanctionId = (int)$existing['sanction_id'];
            $update->bind_param('ssi', $voided, $reasonSuffix, $sanctionId);
            if (!$update->execute()) throw new RuntimeException($update->error);
            $update->close();
            $action = 'voided';
            $status = 'voided';
        } else {
            $status = $lateCount > 0 ? 'warning' : 'none';
        }
        $mysqli->commit();
    } catch (Throwable $e) {
        $mysqli->rollback();
        error_log('tardiness reconciliation failed: ' . $e->getMessage());
        return ['late_count' => $lateCount, 'status' => 'error', 'changed' => false];
    }

    if ($action !== null && $user) {
        tardiness_send_policy_notification($mysqli, $user, $semesterLabel, $lateCount, $action);
    }
    return ['late_count' => $lateCount, 'status' => $status, 'changed' => $action !== null, 'action' => $action];
}

function tardiness_reconcile_for_attendance($mysqli, $attendanceId) {
    $attendanceId = (int)$attendanceId;
    if ($attendanceId <= 0) return ['late_count' => 0, 'status' => 'unavailable', 'changed' => false];
    $stmt = $mysqli->prepare("SELECT ar.user_id, cs.semester_id
        FROM tbl_attendance_records ar
        JOIN tbl_class_schedules cs ON cs.schedule_id = ar.schedule_id
        WHERE ar.attendance_id = ? LIMIT 1");
    if (!$stmt) return ['late_count' => 0, 'status' => 'error', 'changed' => false];
    $stmt->bind_param('i', $attendanceId);
    if (!$stmt->execute()) return ['late_count' => 0, 'status' => 'error', 'changed' => false];
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!$row) return ['late_count' => 0, 'status' => 'unavailable', 'changed' => false];
    return tardiness_reconcile_user_semester($mysqli, (int)$row['user_id'], (int)$row['semester_id']);
}
