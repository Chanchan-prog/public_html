<?php

// Keeps attendance flags synchronized with approved leave coverage.
// Flag IDs: 1 upcoming, 3 absent, 7 on leave, 8 pending.

if (!function_exists('leave_attendance_apply_approved')) {
    function leave_attendance_apply_approved(mysqli $mysqli, ?int $leaveId = null): array
    {
        $leaveFilter = $leaveId !== null && $leaveId > 0
            ? ' AND lv.leave_id = ' . (int)$leaveId
            : '';
        $sql = "
            UPDATE tbl_attendance_records ar
            JOIN tbl_leaves lv
              ON lv.teacher_id = ar.user_id
             AND ar.date BETWEEN lv.date_from AND lv.date_to
             AND LOWER(TRIM(COALESCE(lv.req_status, ''))) = 'approve'
            SET ar.flag_in_id = 7,
                ar.flag_check_id = 7,
                ar.flag_out_id = 7
            WHERE COALESCE(ar.flag_in_id, 1) IN (1, 3, 8)
              AND COALESCE(ar.flag_check_id, 1) IN (1, 3, 8)
              AND COALESCE(ar.flag_out_id, 1) IN (1, 3, 8)
              AND ar.checked_in_at IS NULL
              AND ar.checked_mid_at IS NULL
              AND ar.checked_out_at IS NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM tbl_substitutions ss
                  WHERE ss.schedule_id = ar.schedule_id
                    AND ss.date = ar.date
              )
              {$leaveFilter}
        ";
        try {
            $ok = $mysqli->query($sql);
            return [
                'ok' => $ok !== false,
                'affected_rows' => $ok !== false ? (int)$mysqli->affected_rows : 0,
                'error' => $ok !== false ? null : $mysqli->error,
            ];
        } catch (Throwable $error) {
            return ['ok' => false, 'affected_rows' => 0, 'error' => $error->getMessage()];
        }
    }
}

if (!function_exists('leave_attendance_has_substitutions')) {
    function leave_attendance_has_substitutions(mysqli $mysqli, int $leaveId): bool
    {
        if ($leaveId <= 0) return false;
        $stmt = $mysqli->prepare("SELECT 1 FROM tbl_substitutions WHERE leave_id = ? LIMIT 1");
        if (!$stmt) throw new mysqli_sql_exception($mysqli->error);
        $stmt->bind_param('i', $leaveId);
        if (!$stmt->execute()) throw new mysqli_sql_exception($stmt->error);
        $exists = (bool)$stmt->get_result()->fetch_row();
        $stmt->close();
        return $exists;
    }
}

if (!function_exists('leave_attendance_restore_cancelled')) {
    function leave_attendance_restore_cancelled(mysqli $mysqli, int $teacherId, string $dateFrom, string $dateTo): array
    {
        $stmt = $mysqli->prepare("
            UPDATE tbl_attendance_records ar
            JOIN tbl_class_schedules cs ON cs.schedule_id = ar.schedule_id
            SET ar.flag_in_id = CASE WHEN TIMESTAMP(ar.date, cs.end_time) < NOW() THEN 3 ELSE 1 END,
                ar.flag_check_id = CASE WHEN TIMESTAMP(ar.date, cs.end_time) < NOW() THEN 3 ELSE 1 END,
                ar.flag_out_id = CASE WHEN TIMESTAMP(ar.date, cs.end_time) < NOW() THEN 3 ELSE 1 END
            WHERE ar.user_id = ?
              AND ar.date BETWEEN ? AND ?
              AND ar.flag_in_id = 7
              AND ar.flag_check_id = 7
              AND ar.flag_out_id = 7
              AND ar.checked_in_at IS NULL
              AND ar.checked_mid_at IS NULL
              AND ar.checked_out_at IS NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM tbl_substitutions ss
                  WHERE ss.schedule_id = ar.schedule_id
                    AND ss.date = ar.date
              )
        ");
        if (!$stmt) return ['ok' => false, 'affected_rows' => 0, 'error' => $mysqli->error];
        $stmt->bind_param('iss', $teacherId, $dateFrom, $dateTo);
        try {
            $ok = $stmt->execute();
            $result = [
                'ok' => $ok,
                'affected_rows' => $ok ? (int)$stmt->affected_rows : 0,
                'error' => $ok ? null : $stmt->error,
            ];
        } catch (Throwable $error) {
            $result = ['ok' => false, 'affected_rows' => 0, 'error' => $error->getMessage()];
        }
        $stmt->close();
        return $result;
    }
}

