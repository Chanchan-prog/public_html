<?php

declare(strict_types=1);

if (!function_exists('calendar_event_schema_ensure')) {
    function calendar_event_schema_ensure(mysqli $mysqli): void
    {
        static $ready = false;
        if ($ready) return;
        $exists = $mysqli->query("SHOW TABLES LIKE 'tbl_calendar_events'");
        if ($exists && $exists->num_rows > 0) {
            $ready = true;
            return;
        }
        $sql = "CREATE TABLE IF NOT EXISTS tbl_calendar_events (
            event_id INT NOT NULL AUTO_INCREMENT,
            title VARCHAR(180) NOT NULL,
            event_type ENUM('holiday','event') NOT NULL DEFAULT 'event',
            date_from DATE NOT NULL,
            date_to DATE NOT NULL,
            dept_id INT NULL,
            program_id INT NULL,
            description TEXT NULL,
            status ENUM('active','cancelled') NOT NULL DEFAULT 'active',
            created_by INT NOT NULL,
            updated_by INT NULL,
            cancelled_by INT NULL,
            cancelled_at DATETIME NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (event_id),
            KEY idx_calendar_events_dates (status, date_from, date_to),
            KEY idx_calendar_events_scope (dept_id, program_id, status),
            KEY idx_calendar_events_created_by (created_by)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
        if (!$mysqli->query($sql)) {
            throw new RuntimeException('Unable to initialize calendar events: ' . $mysqli->error);
        }
        $ready = true;
    }
}

if (!function_exists('calendar_event_not_exists_sql')) {
    function calendar_event_not_exists_sql(
        string $dateExpression,
        string $subjectDepartmentExpression,
        string $sectionDepartmentExpression,
        string $subjectProgramExpression,
        string $sectionProgramExpression
    ): string {
        return "NOT EXISTS (
            SELECT 1
            FROM tbl_calendar_events ce
            WHERE ce.status = 'active'
              AND {$dateExpression} BETWEEN ce.date_from AND ce.date_to
              AND (ce.dept_id IS NULL OR (ce.dept_id = {$subjectDepartmentExpression} AND ce.dept_id = {$sectionDepartmentExpression}))
              AND (ce.program_id IS NULL OR (ce.program_id = {$subjectProgramExpression} AND ce.program_id = {$sectionProgramExpression}))
        )";
    }
}

if (!function_exists('calendar_event_delete_blocked_upcoming_attendance')) {
    function calendar_event_delete_blocked_upcoming_attendance(mysqli $mysqli): array
    {
        calendar_event_schema_ensure($mysqli);
        $sql = "DELETE ar
            FROM tbl_attendance_records ar
            JOIN tbl_class_schedules cs ON cs.schedule_id = ar.schedule_id
            JOIN tbl_subject subj ON subj.subject_id = cs.subject_id
            JOIN tbl_programs sp ON sp.program_id = subj.program_id
            JOIN tbl_sections sec ON sec.section_id = cs.section_id
            JOIN tbl_programs secp ON secp.program_id = sec.program_id
            WHERE ar.checked_in_at IS NULL
              AND ar.checked_mid_at IS NULL
              AND ar.checked_out_at IS NULL
              AND COALESCE(ar.flag_in_id, 1) = 1
              AND COALESCE(ar.flag_check_id, 1) = 1
              AND COALESCE(ar.flag_out_id, 1) = 1
              AND (ar.date > CURDATE() OR (ar.date = CURDATE() AND cs.start_time > CURTIME()))
              AND EXISTS (
                  SELECT 1 FROM tbl_calendar_events ce
                  WHERE ce.status = 'active'
                    AND ar.date BETWEEN ce.date_from AND ce.date_to
                    AND (ce.dept_id IS NULL OR (ce.dept_id = sp.dept_id AND ce.dept_id = secp.dept_id))
                    AND (ce.program_id IS NULL OR (ce.program_id = sp.program_id AND ce.program_id = secp.program_id))
              )";
        if (!$mysqli->query($sql)) {
            return ['ok' => false, 'deleted_rows' => 0, 'error' => $mysqli->error];
        }
        return ['ok' => true, 'deleted_rows' => (int)$mysqli->affected_rows, 'error' => null];
    }
}

if (!function_exists('calendar_event_attendance_is_blocked')) {
    function calendar_event_attendance_is_blocked(mysqli $mysqli, int $attendanceId): bool
    {
        if ($attendanceId <= 0) return false;
        calendar_event_schema_ensure($mysqli);
        $stmt = $mysqli->prepare("SELECT 1
            FROM tbl_attendance_records ar
            JOIN tbl_class_schedules cs ON cs.schedule_id = ar.schedule_id
            JOIN tbl_subject subj ON subj.subject_id = cs.subject_id
            JOIN tbl_programs sp ON sp.program_id = subj.program_id
            JOIN tbl_sections sec ON sec.section_id = cs.section_id
            JOIN tbl_programs secp ON secp.program_id = sec.program_id
            JOIN tbl_calendar_events ce
              ON ce.status = 'active'
             AND ar.date BETWEEN ce.date_from AND ce.date_to
             AND (ce.dept_id IS NULL OR (ce.dept_id = sp.dept_id AND ce.dept_id = secp.dept_id))
             AND (ce.program_id IS NULL OR (ce.program_id = sp.program_id AND ce.program_id = secp.program_id))
            WHERE ar.attendance_id = ?
              AND ar.checked_in_at IS NULL AND ar.checked_mid_at IS NULL AND ar.checked_out_at IS NULL
              AND COALESCE(ar.flag_in_id, 1) = 1
              AND COALESCE(ar.flag_check_id, 1) = 1
              AND COALESCE(ar.flag_out_id, 1) = 1
              AND (ar.date > CURDATE() OR (ar.date = CURDATE() AND cs.start_time > CURTIME()))
            LIMIT 1");
        if (!$stmt) throw new RuntimeException($mysqli->error);
        $stmt->bind_param('i', $attendanceId);
        $stmt->execute();
        $blocked = (bool)$stmt->get_result()->fetch_row();
        $stmt->close();
        return $blocked;
    }
}
