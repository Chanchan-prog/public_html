<?php
// api/scripts/cron_worker_lib.php
// Shared logic for cron/worker jobs that replace MySQL EVENTS:
// - DailyAcademicUpdate
// - RealTimeAttendanceManager

declare(strict_types=1);

require_once __DIR__ . '/../helpers/notification_helper.php';
require_once __DIR__ . '/../helpers/leave_attendance_helper.php';
require_once __DIR__ . '/../helpers/calendar_event_helper.php';

if (!function_exists('cw_log')) {
    function cw_log(string $message): void
    {
        $ts = date('Y-m-d H:i:s');
        $line = "[{$ts}] {$message}\n";
        echo $line;

        $logFile = getenv('CW_LOG_FILE');
        if (!is_string($logFile) || trim($logFile) === '') {
            $logFile = __DIR__ . '/../logs/academic-attendance-worker.log';
        }

        @file_put_contents($logFile, $line, FILE_APPEND);
    }
}

if (!function_exists('cw_bind_params')) {
    function cw_bind_params(mysqli_stmt $stmt, string $types, array &$params): bool
    {
        $refs = [];
        $refs[] = &$types;
        foreach ($params as $k => $v) {
            $refs[] = &$params[$k];
        }
        return (bool)call_user_func_array([$stmt, 'bind_param'], $refs);
    }
}

if (!function_exists('cw_absent_candidate_select_sql')) {
    function cw_absent_candidate_select_sql(string $whereClause): string
    {
        return "
            SELECT
                a.attendance_id,
                a.user_id,
                DATE_FORMAT(a.date, '%Y-%m-%d') AS date,
                a.flag_in_id,
                a.flag_check_id,
                a.flag_out_id,
                cs.start_time,
                cs.end_time,
                r.room_name,
                s.subject_code,
                s.subject_name,
                sec.section_name
            FROM tbl_attendance_records a
            JOIN tbl_class_schedules cs ON a.schedule_id = cs.schedule_id
            JOIN tbl_users au ON au.user_id = a.user_id
            JOIN tbl_semesters sem ON sem.semester_id = cs.semester_id
            JOIN tbl_school_year sy ON sy.school_year_id = sem.school_year_id
            JOIN tbl_rooms r ON a.room_id = r.room_id
            JOIN tbl_floors f ON f.floor_id = r.floor_id
            JOIN tbl_buildings b ON b.building_id = COALESCE(r.building_id, f.building_id)
            LEFT JOIN tbl_school campus ON campus.school_id = b.school_id
            LEFT JOIN tbl_subject s ON cs.subject_id = s.subject_id
            LEFT JOIN tbl_sections sec ON cs.section_id = sec.section_id
            LEFT JOIN tbl_programs sp ON sp.program_id = s.program_id
            LEFT JOIN tbl_departments sd ON sd.dept_id = sp.dept_id
            LEFT JOIN tbl_programs secp ON secp.program_id = sec.program_id
            LEFT JOIN tbl_departments secd ON secd.dept_id = secp.dept_id
            WHERE LOWER(TRIM(COALESCE(au.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(sem.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(sy.status, ''))) IN ('active', '1', 'true')
              AND a.date BETWEEN sem.start_date AND sem.end_date
              AND LOWER(TRIM(COALESCE(r.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(f.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(b.status, ''))) IN ('active', '1', 'true')
              AND (b.school_id IS NULL OR LOWER(TRIM(COALESCE(campus.status, ''))) IN ('active', '1', 'true'))
              AND LOWER(TRIM(COALESCE(s.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(sp.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(sd.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(sec.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(secp.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(secd.status, ''))) IN ('active', '1', 'true')
            {$whereClause}
        ";
    }
}

if (!function_exists('cw_get_absent_notification_candidates')) {
    function cw_get_absent_notification_candidates(mysqli $mysqli): array
    {
        $sql = cw_absent_candidate_select_sql("
            AND TIMESTAMP(a.date, cs.end_time) < NOW()
                AND (a.flag_in_id IN (1, 8) OR a.flag_check_id IN (1, 8) OR a.flag_out_id IN (1, 8))
        ");

        try {
            $res = $mysqli->query($sql);
        } catch (Throwable $e) {
            cw_log('[Worker][AbsentEmail] candidate select failed: ' . $e->getMessage());
            return [];
        }
        if (!$res) {
            cw_log('[Worker][AbsentEmail] candidate select failed: ' . $mysqli->error);
            return [];
        }

        $rows = [];
        while ($row = $res->fetch_assoc()) {
            $rows[(int)$row['attendance_id']] = $row;
        }
        return $rows;
    }
}

if (!function_exists('cw_get_attendance_rows_by_ids')) {
    function cw_get_attendance_rows_by_ids(mysqli $mysqli, array $ids): array
    {
        $cleanIds = [];
        foreach ($ids as $id) {
            $id = (int)$id;
            if ($id > 0) $cleanIds[$id] = true;
        }
        $cleanIds = array_keys($cleanIds);
        if (empty($cleanIds)) return [];

        $placeholders = implode(',', array_fill(0, count($cleanIds), '?'));
        $sql = cw_absent_candidate_select_sql("AND a.attendance_id IN ({$placeholders})");
        $stmt = $mysqli->prepare($sql);
        if (!$stmt) {
            cw_log('[Worker][AbsentEmail] post-update select prepare failed: ' . $mysqli->error);
            return [];
        }

        $types = str_repeat('i', count($cleanIds));
        $params = $cleanIds;
        cw_bind_params($stmt, $types, $params);
        if (!$stmt->execute()) {
            cw_log('[Worker][AbsentEmail] post-update select failed: ' . $stmt->error);
            $stmt->close();
            return [];
        }

        $rows = [];
        $res = $stmt->get_result();
        while ($row = $res->fetch_assoc()) {
            $rows[(int)$row['attendance_id']] = $row;
        }
        $stmt->close();
        return $rows;
    }
}

if (!function_exists('cw_send_absent_notifications')) {
    function cw_send_absent_notifications(mysqli $mysqli, array $beforeRows): array
    {
        if (empty($beforeRows)) {
            return ['sent' => 0, 'failed' => 0, 'skipped' => 0];
        }

        $afterRows = cw_get_attendance_rows_by_ids($mysqli, array_keys($beforeRows));
        $sent = 0;
        $failed = 0;
        $skipped = 0;

        foreach ($beforeRows as $attendanceId => $before) {
            $after = $afterRows[(int)$attendanceId] ?? null;
            if (!$after) {
                $skipped++;
                continue;
            }

            $missed = [];
            if (in_array((int)($before['flag_in_id'] ?? 0), [1, 8], true) && (int)($after['flag_in_id'] ?? 0) === 3) {
                $missed[] = 'check-in';
            }
            if (in_array((int)($before['flag_check_id'] ?? 0), [1, 8], true) && (int)($after['flag_check_id'] ?? 0) === 3) {
                $missed[] = 'middle check';
            }
            if (in_array((int)($before['flag_out_id'] ?? 0), [1, 8], true) && (int)($after['flag_out_id'] ?? 0) === 3) {
                $missed[] = 'check-out';
            }

            if (empty($missed)) {
                $skipped++;
                continue;
            }

            $lead = 'You missed scheduled attendance scan(s): ' . implode(', ', $missed) . '.';
            $result = personal_notif_send_attendance_event(
                $mysqli,
                $after,
                'ABSENT ALERT',
                'Missed attendance scan',
                $lead,
                new DateTime()
            );

            $alertMessage = personal_notif_attendance_details($after, $lead);
            $alertCreated = notif_insert_web_push(
                $mysqli,
                (int)($after['user_id'] ?? 0),
                'Attendance Marked Absent',
                $alertMessage,
                '/attendance-history'
            );
            if (!$alertCreated) {
                cw_log('[Worker][AbsentNotification] website/push notification could not be created for attendance_id=' . (int)$attendanceId);
            }

            if (!empty($result['sent'])) {
                $sent++;
            } else {
                $failed++;
            }
        }

        return ['sent' => $sent, 'failed' => $failed, 'skipped' => $skipped];
    }
}

if (!function_exists('cw_notification_exists')) {
    function cw_notification_exists(mysqli $mysqli, int $userId, string $title, string $link): bool
    {
        if ($userId <= 0 || !notif_table_exists($mysqli)) return false;
        $stmt = $mysqli->prepare('SELECT notif_id FROM tbl_notifications WHERE user_id = ? AND title = ? AND link = ? LIMIT 1');
        if (!$stmt) return false;
        $stmt->bind_param('iss', $userId, $title, $link);
        $stmt->execute();
        $exists = (bool)$stmt->get_result()->fetch_assoc();
        $stmt->close();
        return $exists;
    }
}

if (!function_exists('cw_get_pending_checkin_candidates')) {
    function cw_get_pending_checkin_candidates(mysqli $mysqli, bool $reminder = false): array
    {
        $delayClause = $reminder
            ? "AND EXISTS (
                    SELECT 1
                    FROM tbl_notifications initial_notice
                    WHERE initial_notice.user_id = a.user_id
                      AND initial_notice.title = 'Attendance Check-In Pending'
                      AND initial_notice.link = CONCAT('/attendance?attendance_id=', a.attendance_id, '&notice=pending-start')
                      AND initial_notice.created_at <= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
                )"
            : '';
        $sql = "
            SELECT
                a.attendance_id,
                a.user_id,
                DATE_FORMAT(a.date, '%Y-%m-%d') AS date,
                cs.start_time,
                cs.end_time,
                r.room_name,
                s.subject_code,
                s.subject_name,
                sec.section_name
            FROM tbl_attendance_records a
            JOIN tbl_class_schedules cs ON a.schedule_id = cs.schedule_id
            JOIN tbl_users au ON au.user_id = a.user_id
            JOIN tbl_semesters sem ON sem.semester_id = cs.semester_id
            JOIN tbl_school_year sy ON sy.school_year_id = sem.school_year_id
            JOIN tbl_rooms r ON a.room_id = r.room_id
            JOIN tbl_floors f ON f.floor_id = r.floor_id
            JOIN tbl_buildings b ON b.building_id = COALESCE(r.building_id, f.building_id)
            LEFT JOIN tbl_school campus ON campus.school_id = b.school_id
            LEFT JOIN tbl_subject s ON cs.subject_id = s.subject_id
            LEFT JOIN tbl_sections sec ON cs.section_id = sec.section_id
            LEFT JOIN tbl_programs sp ON sp.program_id = s.program_id
            LEFT JOIN tbl_departments sd ON sd.dept_id = sp.dept_id
            LEFT JOIN tbl_programs secp ON secp.program_id = sec.program_id
            LEFT JOIN tbl_departments secd ON secd.dept_id = secp.dept_id
            WHERE TIMESTAMP(a.date, cs.start_time) <= NOW()
              AND TIMESTAMP(a.date, cs.end_time) >= NOW()
              AND a.flag_in_id = 8
              AND a.checked_in_at IS NULL
              AND LOWER(TRIM(COALESCE(au.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(sem.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(sy.status, ''))) IN ('active', '1', 'true')
              AND a.date BETWEEN sem.start_date AND sem.end_date
              AND LOWER(TRIM(COALESCE(r.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(f.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(b.status, ''))) IN ('active', '1', 'true')
              AND (b.school_id IS NULL OR LOWER(TRIM(COALESCE(campus.status, ''))) IN ('active', '1', 'true'))
              AND LOWER(TRIM(COALESCE(s.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(sp.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(sd.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(sec.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(secp.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(secd.status, ''))) IN ('active', '1', 'true')
              {$delayClause}
        ";
        try {
            $res = $mysqli->query($sql);
        } catch (Throwable $e) {
            cw_log('[Worker][PendingAttendance] candidate select failed: ' . $e->getMessage());
            return [];
        }
        if (!$res) {
            cw_log('[Worker][PendingAttendance] candidate select failed: ' . $mysqli->error);
            return [];
        }
        $rows = [];
        while ($row = $res->fetch_assoc()) $rows[] = $row;
        return $rows;
    }
}

if (!function_exists('cw_send_pending_checkin_notifications')) {
    function cw_send_pending_checkin_notifications(mysqli $mysqli, array $rows, bool $reminder = false): array
    {
        $sent = 0;
        $failed = 0;
        $skipped = 0;
        $title = $reminder ? 'Attendance Check-In Reminder' : 'Attendance Check-In Pending';

        foreach ($rows as $row) {
            $attendanceId = (int)($row['attendance_id'] ?? 0);
            $userId = (int)($row['user_id'] ?? 0);
            if ($attendanceId <= 0 || $userId <= 0) {
                $skipped++;
                continue;
            }

            $subject = trim((string)($row['subject_code'] ?? ''));
            if ($subject === '') $subject = trim((string)($row['subject_name'] ?? ''));
            if ($subject === '') $subject = 'your scheduled class';
            $section = trim((string)($row['section_name'] ?? ''));
            $classLabel = $section !== '' ? $subject . ' / ' . $section : $subject;
            $room = trim((string)($row['room_name'] ?? ''));
            $location = $room !== '' ? ' in ' . $room : '';
            $lead = $reminder
                ? 'Your check-in is still pending. Please complete it before the class ends.'
                : 'Your class has started and your check-in is pending.';
            $message = $lead . ' Class: ' . $classLabel . $location . '.';
            $noticeType = $reminder ? 'pending-reminder' : 'pending-start';
            $link = '/attendance?attendance_id=' . $attendanceId . '&notice=' . $noticeType;

            if (cw_notification_exists($mysqli, $userId, $title, $link)) {
                $skipped++;
                continue;
            }
            // Pending and reminder alerts are time-sensitive but routine. Keep
            // them in the notification center and Web Push without email noise.
            if (notif_insert_web_push($mysqli, $userId, $title, $message, $link)) $sent++;
            else $failed++;
        }

        return ['sent' => $sent, 'failed' => $failed, 'skipped' => $skipped];
    }
}

if (!function_exists('cw_run_sql')) {
    function cw_run_sql(mysqli $mysqli, string $sql): array
    {
        try {
            $ok = $mysqli->query($sql);
        } catch (Throwable $e) {
            return [
                'ok' => false,
                'affected_rows' => 0,
                'error' => $e->getMessage(),
            ];
        }
        if ($ok === false) {
            return [
                'ok' => false,
                'affected_rows' => 0,
                'error' => $mysqli->error,
            ];
        }

        return [
            'ok' => true,
            'affected_rows' => (int)$mysqli->affected_rows,
            'error' => null,
        ];
    }
}

if (!function_exists('cw_get_db_curdate')) {
    function cw_get_db_curdate(mysqli $mysqli): string
    {
        $res = $mysqli->query("SELECT CURDATE() AS d");
        if (!$res) {
            return date('Y-m-d');
        }
        $row = $res->fetch_assoc();
        return (string)($row['d'] ?? date('Y-m-d'));
    }
}

if (!function_exists('cw_daily_academic_update')) {
    function cw_daily_academic_update(mysqli $mysqli): array
    {
        // Mirrors MySQL EVENT DailyAcademicUpdate
        $sqlSchoolYear = "
            UPDATE tbl_school_year
            SET status = CASE
                WHEN CURDATE() BETWEEN start_date AND end_date THEN 'active'
                ELSE 'inactive'
            END
            WHERE status != 'archive'
        ";

        $sqlSemester = "
            UPDATE tbl_semesters
            SET status = CASE
                WHEN CURDATE() BETWEEN start_date AND end_date THEN 'active'
                ELSE 'inactive'
            END
            WHERE status != 'archive'
        ";

        $r1 = cw_run_sql($mysqli, $sqlSchoolYear);
        $r2 = cw_run_sql($mysqli, $sqlSemester);

        return [
            'ok' => ($r1['ok'] && $r2['ok']),
            'school_year_rows' => $r1['affected_rows'],
            'semester_rows' => $r2['affected_rows'],
            'errors' => array_values(array_filter([$r1['error'], $r2['error']])),
        ];
    }
}

if (!function_exists('cw_generate_attendance_records')) {
    function cw_generate_attendance_records(mysqli $mysqli, array $scheduleIds = [], int $pastDays = 0, int $futureDays = 6, bool $skipStartedToday = false): array
    {
        calendar_event_schema_ensure($mysqli);
        $pastDays = max(0, min(31, $pastDays));
        $futureDays = max(0, min(31, $futureDays));
        $sequence = [];
        for ($dayOffset = -$pastDays; $dayOffset <= $futureDays; $dayOffset++) {
            $sequence[] = 'SELECT ' . (int)$dayOffset . ' AS n';
        }
        $scheduleFilter = '';
        $cleanScheduleIds = array_values(array_unique(array_filter(array_map('intval', $scheduleIds), fn($id) => $id > 0)));
        if (!empty($cleanScheduleIds)) {
            $scheduleFilter = ' AND cs.schedule_id IN (' . implode(',', $cleanScheduleIds) . ')';
        }
        $todayTimeFilter = $skipStartedToday
            ? ' AND (seq.n <> 0 OR cs.start_time > CURTIME())'
            : '';
        $insertSql = "
            INSERT INTO tbl_attendance_records (user_id, schedule_id, room_id, floor_id, date)
            SELECT cs.user_id, cs.schedule_id, cs.room_id, r.floor_id, DATE_ADD(CURDATE(), INTERVAL seq.n DAY)
            FROM (
                " . implode(' UNION ALL ', $sequence) . "
            ) seq
            JOIN tbl_class_schedules cs
            JOIN tbl_rooms r ON cs.room_id = r.room_id
            JOIN tbl_semesters sem ON cs.semester_id = sem.semester_id
            JOIN tbl_school_year sy ON sy.school_year_id = sem.school_year_id
            JOIN tbl_users au ON au.user_id = cs.user_id
            JOIN tbl_floors f ON f.floor_id = r.floor_id
            JOIN tbl_buildings b ON b.building_id = COALESCE(r.building_id, f.building_id)
            LEFT JOIN tbl_school campus ON campus.school_id = b.school_id
            JOIN tbl_subject s ON s.subject_id = cs.subject_id
            JOIN tbl_programs sp ON sp.program_id = s.program_id
            JOIN tbl_departments sd ON sd.dept_id = sp.dept_id
            JOIN tbl_sections sec ON sec.section_id = cs.section_id
            JOIN tbl_programs secp ON secp.program_id = sec.program_id
            JOIN tbl_departments secd ON secd.dept_id = secp.dept_id
            WHERE LOWER(TRIM(COALESCE(sem.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(sy.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(au.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(r.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(f.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(b.status, ''))) IN ('active', '1', 'true')
              AND (b.school_id IS NULL OR LOWER(TRIM(COALESCE(campus.status, ''))) IN ('active', '1', 'true'))
              AND LOWER(TRIM(COALESCE(s.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(sp.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(sd.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(sec.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(secp.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(secd.status, ''))) IN ('active', '1', 'true')
              {$scheduleFilter}
              {$todayTimeFilter}
              AND DATE_ADD(CURDATE(), INTERVAL seq.n DAY) BETWEEN sem.start_date AND sem.end_date
              AND cs.day_of_week = LOWER(DAYNAME(DATE_ADD(CURDATE(), INTERVAL seq.n DAY)))
              AND " . calendar_event_not_exists_sql(
                  'DATE_ADD(CURDATE(), INTERVAL seq.n DAY)',
                  'sp.dept_id',
                  'secp.dept_id',
                  'sp.program_id',
                  'secp.program_id'
              ) . "
              AND NOT EXISTS (
                  SELECT 1 FROM tbl_attendance_records ar
                  WHERE ar.schedule_id = cs.schedule_id
                  AND ar.date = DATE_ADD(CURDATE(), INTERVAL seq.n DAY)
              )
        ";
        $result = cw_run_sql($mysqli, $insertSql);
        $leaveSync = $result['ok']
            ? leave_attendance_apply_approved($mysqli)
            : ['ok' => false, 'affected_rows' => 0, 'error' => 'Attendance generation failed before leave synchronization.'];
        return [
            'ok' => ($result['ok'] && $leaveSync['ok']),
            'generated_rows' => $result['affected_rows'],
            'on_leave_rows' => (int)($leaveSync['affected_rows'] ?? 0),
            'errors' => array_values(array_filter([$result['error'], $leaveSync['error'] ?? null])),
        ];
    }
}

if (!function_exists('cw_sync_future_attendance_for_schedule')) {
    function cw_sync_future_attendance_for_schedule(mysqli $mysqli, int $scheduleId): array
    {
        if ($scheduleId <= 0) return ['ok' => false, 'deleted_rows' => 0, 'generated_rows' => 0, 'errors' => ['Invalid schedule ID.']];
        $deleteSql = "DELETE FROM tbl_attendance_records
            WHERE schedule_id = {$scheduleId}
              AND date >= CURDATE()
              AND checked_in_at IS NULL AND checked_mid_at IS NULL AND checked_out_at IS NULL
              AND COALESCE(flag_in_id, 1) IN (1, 7, 8)
              AND COALESCE(flag_check_id, 1) IN (1, 7, 8)
              AND COALESCE(flag_out_id, 1) IN (1, 7, 8)";
        $deleted = cw_run_sql($mysqli, $deleteSql);
        if (!$deleted['ok']) {
            return ['ok' => false, 'deleted_rows' => 0, 'generated_rows' => 0, 'errors' => [$deleted['error']]];
        }
        $generated = cw_generate_attendance_records($mysqli, [$scheduleId], 0, 6);
        return [
            'ok' => $generated['ok'],
            'deleted_rows' => $deleted['affected_rows'],
            'generated_rows' => $generated['generated_rows'],
            'errors' => $generated['errors'],
        ];
    }
}

if (!function_exists('cw_process_attendance_statuses')) {
    function cw_process_attendance_statuses(mysqli $mysqli): array
    {
        $markPendingSql = "
            UPDATE tbl_attendance_records a
            JOIN tbl_class_schedules s ON a.schedule_id = s.schedule_id
            JOIN tbl_users au ON au.user_id = a.user_id
            JOIN tbl_semesters sem ON sem.semester_id = s.semester_id
            JOIN tbl_school_year sy ON sy.school_year_id = sem.school_year_id
            JOIN tbl_rooms r ON r.room_id = a.room_id
            JOIN tbl_floors f ON f.floor_id = r.floor_id
            JOIN tbl_buildings b ON b.building_id = COALESCE(r.building_id, f.building_id)
            LEFT JOIN tbl_school campus ON campus.school_id = b.school_id
            JOIN tbl_subject subj ON subj.subject_id = s.subject_id
            JOIN tbl_programs sp ON sp.program_id = subj.program_id
            JOIN tbl_departments sd ON sd.dept_id = sp.dept_id
            JOIN tbl_sections sec ON sec.section_id = s.section_id
            JOIN tbl_programs secp ON secp.program_id = sec.program_id
            JOIN tbl_departments secd ON secd.dept_id = secp.dept_id
            SET
                a.flag_in_id = IF(a.flag_in_id = 1, 8, a.flag_in_id),
                a.flag_check_id = IF(a.flag_check_id = 1, 8, a.flag_check_id),
                a.flag_out_id = IF(a.flag_out_id = 1, 8, a.flag_out_id)
            WHERE
                TIMESTAMP(a.date, s.start_time) <= NOW()
                AND TIMESTAMP(a.date, s.end_time) >= NOW()
                AND (a.flag_in_id = 1 OR a.flag_check_id = 1 OR a.flag_out_id = 1)
                AND LOWER(TRIM(COALESCE(au.status, ''))) IN ('active', '1', 'true')
                AND LOWER(TRIM(COALESCE(sem.status, ''))) IN ('active', '1', 'true')
                AND LOWER(TRIM(COALESCE(sy.status, ''))) IN ('active', '1', 'true')
                AND a.date BETWEEN sem.start_date AND sem.end_date
                AND LOWER(TRIM(COALESCE(r.status, ''))) IN ('active', '1', 'true')
                AND LOWER(TRIM(COALESCE(f.status, ''))) IN ('active', '1', 'true')
                AND LOWER(TRIM(COALESCE(b.status, ''))) IN ('active', '1', 'true')
                AND (b.school_id IS NULL OR LOWER(TRIM(COALESCE(campus.status, ''))) IN ('active', '1', 'true'))
                AND LOWER(TRIM(COALESCE(subj.status, ''))) IN ('active', '1', 'true')
                AND LOWER(TRIM(COALESCE(sp.status, ''))) IN ('active', '1', 'true')
                AND LOWER(TRIM(COALESCE(sd.status, ''))) IN ('active', '1', 'true')
                AND LOWER(TRIM(COALESCE(sec.status, ''))) IN ('active', '1', 'true')
                AND LOWER(TRIM(COALESCE(secp.status, ''))) IN ('active', '1', 'true')
                AND LOWER(TRIM(COALESCE(secd.status, ''))) IN ('active', '1', 'true')
        ";

        $autoAbsentSql = "
            UPDATE tbl_attendance_records a
            JOIN tbl_class_schedules s ON a.schedule_id = s.schedule_id
            JOIN tbl_users au ON au.user_id = a.user_id
            JOIN tbl_semesters sem ON sem.semester_id = s.semester_id
            JOIN tbl_school_year sy ON sy.school_year_id = sem.school_year_id
            JOIN tbl_rooms r ON r.room_id = a.room_id
            JOIN tbl_floors f ON f.floor_id = r.floor_id
            JOIN tbl_buildings b ON b.building_id = COALESCE(r.building_id, f.building_id)
            LEFT JOIN tbl_school campus ON campus.school_id = b.school_id
            JOIN tbl_subject subj ON subj.subject_id = s.subject_id
            JOIN tbl_programs sp ON sp.program_id = subj.program_id
            JOIN tbl_departments sd ON sd.dept_id = sp.dept_id
            JOIN tbl_sections sec ON sec.section_id = s.section_id
            JOIN tbl_programs secp ON secp.program_id = sec.program_id
            JOIN tbl_departments secd ON secd.dept_id = secp.dept_id
            SET
                a.flag_in_id = IF(a.flag_in_id IN (1, 8), 3, a.flag_in_id),
                a.flag_check_id = IF(a.flag_check_id IN (1, 8), 3, a.flag_check_id),
                a.flag_out_id = IF(a.flag_out_id IN (1, 8), 3, a.flag_out_id)
            WHERE
                TIMESTAMP(a.date, s.end_time) < NOW()
                AND (a.flag_in_id IN (1, 8) OR a.flag_check_id IN (1, 8) OR a.flag_out_id IN (1, 8))
                AND LOWER(TRIM(COALESCE(au.status, ''))) IN ('active', '1', 'true')
                AND LOWER(TRIM(COALESCE(sem.status, ''))) IN ('active', '1', 'true')
                AND LOWER(TRIM(COALESCE(sy.status, ''))) IN ('active', '1', 'true')
                AND a.date BETWEEN sem.start_date AND sem.end_date
                AND LOWER(TRIM(COALESCE(r.status, ''))) IN ('active', '1', 'true')
                AND LOWER(TRIM(COALESCE(f.status, ''))) IN ('active', '1', 'true')
                AND LOWER(TRIM(COALESCE(b.status, ''))) IN ('active', '1', 'true')
                AND (b.school_id IS NULL OR LOWER(TRIM(COALESCE(campus.status, ''))) IN ('active', '1', 'true'))
                AND LOWER(TRIM(COALESCE(subj.status, ''))) IN ('active', '1', 'true')
                AND LOWER(TRIM(COALESCE(sp.status, ''))) IN ('active', '1', 'true')
                AND LOWER(TRIM(COALESCE(sd.status, ''))) IN ('active', '1', 'true')
                AND LOWER(TRIM(COALESCE(sec.status, ''))) IN ('active', '1', 'true')
                AND LOWER(TRIM(COALESCE(secp.status, ''))) IN ('active', '1', 'true')
                AND LOWER(TRIM(COALESCE(secd.status, ''))) IN ('active', '1', 'true')
        ";

        $absentCandidates = cw_get_absent_notification_candidates($mysqli);
        $rPending = cw_run_sql($mysqli, $markPendingSql);
        $pendingNotifications = ['sent' => 0, 'failed' => 0, 'skipped' => 0];
        $pendingReminders = ['sent' => 0, 'failed' => 0, 'skipped' => 0];
        if ($rPending['ok']) {
            $pendingNotifications = cw_send_pending_checkin_notifications(
                $mysqli,
                cw_get_pending_checkin_candidates($mysqli, false),
                false
            );
            $pendingReminders = cw_send_pending_checkin_notifications(
                $mysqli,
                cw_get_pending_checkin_candidates($mysqli, true),
                true
            );
        }
        $r2 = cw_run_sql($mysqli, $autoAbsentSql);
        $absentNotifications = ['sent' => 0, 'failed' => 0, 'skipped' => 0];
        if ($r2['ok'] && (int)$r2['affected_rows'] > 0 && !empty($absentCandidates)) {
            $absentNotifications = cw_send_absent_notifications($mysqli, $absentCandidates);
        }
        return [
            'ok' => ($rPending['ok'] && $r2['ok']),
            'pending_rows' => $rPending['affected_rows'],
            'pending_notifications' => $pendingNotifications,
            'pending_reminders' => $pendingReminders,
            'auto_absent_rows' => $r2['affected_rows'],
            'absent_notifications' => $absentNotifications,
            'errors' => array_values(array_filter([$rPending['error'], $r2['error']])),
        ];
    }
}

if (!function_exists('cw_realtime_attendance_manager')) {
    function cw_realtime_attendance_manager(mysqli $mysqli): array
    {
        // Backward-compatible one-shot wrapper for diagnostics and older callers.
        $generation = cw_generate_attendance_records($mysqli);
        $statuses = cw_process_attendance_statuses($mysqli);
        return [
            'ok' => ($generation['ok'] && $statuses['ok']),
            'generated_rows' => $generation['generated_rows'],
            'on_leave_rows' => $generation['on_leave_rows'] ?? 0,
            'pending_rows' => $statuses['pending_rows'],
            'pending_notifications' => $statuses['pending_notifications'],
            'pending_reminders' => $statuses['pending_reminders'],
            'auto_absent_rows' => $statuses['auto_absent_rows'],
            'absent_notifications' => $statuses['absent_notifications'],
            'errors' => array_values(array_merge($generation['errors'], $statuses['errors'])),
        ];
    }
}
