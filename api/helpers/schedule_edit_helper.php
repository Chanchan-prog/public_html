<?php

declare(strict_types=1);

if (!function_exists('schedule_edit_normalize_time')) {
    function schedule_edit_normalize_time($value): string
    {
        $raw = trim((string)$value);
        if ($raw === '') return '';
        if (preg_match('/^\d{1,2}:\d{2}$/', $raw)) return $raw . ':00';
        if (preg_match('/^\d{1,2}:\d{2}:\d{2}$/', $raw)) return $raw;
        $timestamp = strtotime($raw);
        return $timestamp === false ? $raw : date('H:i:s', $timestamp);
    }
}

if (!function_exists('schedule_edit_normalize_state')) {
    function schedule_edit_normalize_state(array $row): array
    {
        return [
            'user_id' => isset($row['user_id']) ? (int)$row['user_id'] : (isset($row['teacher_id']) ? (int)$row['teacher_id'] : 0),
            'semester_id' => isset($row['semester_id']) ? (int)$row['semester_id'] : 0,
            'subject_id' => isset($row['subject_id']) ? (int)$row['subject_id'] : 0,
            'section_id' => isset($row['section_id']) ? (int)$row['section_id'] : 0,
            'room_id' => isset($row['room_id']) ? (int)$row['room_id'] : 0,
            'day_of_week' => strtolower(trim((string)($row['day_of_week'] ?? ''))),
            'start_time' => schedule_edit_normalize_time($row['start_time'] ?? ''),
            'end_time' => schedule_edit_normalize_time($row['end_time'] ?? ''),
        ];
    }
}

if (!function_exists('schedule_edit_state_hash')) {
    function schedule_edit_state_hash(array $row): string
    {
        return hash('sha256', json_encode(schedule_edit_normalize_state($row), JSON_UNESCAPED_SLASHES));
    }
}

if (!function_exists('schedule_edit_get_state')) {
    function schedule_edit_get_state(mysqli $mysqli, int $scheduleId): ?array
    {
        $stmt = $mysqli->prepare("SELECT schedule_id, user_id, semester_id, subject_id, section_id, room_id, LOWER(TRIM(day_of_week)) AS day_of_week, TIME_FORMAT(start_time, '%H:%i:%s') AS start_time, TIME_FORMAT(end_time, '%H:%i:%s') AS end_time FROM tbl_class_schedules WHERE schedule_id = ? LIMIT 1");
        if (!$stmt) return null;
        $stmt->bind_param('i', $scheduleId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        return $row ? schedule_edit_normalize_state($row) : null;
    }
}

if (!function_exists('schedule_edit_next_occurrence')) {
    function schedule_edit_next_occurrence(array $state): ?string
    {
        $day = strtolower(trim((string)($state['day_of_week'] ?? '')));
        $start = schedule_edit_normalize_time($state['start_time'] ?? '');
        if ($day === '' || $start === '') return null;
        $now = new DateTimeImmutable('now');
        for ($offset = 0; $offset <= 7; $offset++) {
            $date = $now->setTime(0, 0)->modify('+' . $offset . ' days');
            if (strtolower($date->format('l')) !== $day) continue;
            $candidate = new DateTimeImmutable($date->format('Y-m-d') . ' ' . $start);
            if ($candidate > $now) return $date->format('Y-m-d');
        }
        return null;
    }
}

if (!function_exists('schedule_edit_get_impact')) {
    function schedule_edit_get_impact(mysqli $mysqli, int $scheduleId, ?array $resultingState = null): array
    {
        $impact = [
            'total_records' => 0,
            'historical_records' => 0,
            'scanned_records' => 0,
            'protected_current_future_records' => 0,
            'rebuildable_placeholders' => 0,
            'next_effective_date' => null,
            'active_session_now' => false,
        ];
        $stmt = $mysqli->prepare("SELECT
                COUNT(*) AS total_records,
                SUM(CASE WHEN date < CURDATE() THEN 1 ELSE 0 END) AS historical_records,
                SUM(CASE WHEN checked_in_at IS NOT NULL OR checked_mid_at IS NOT NULL OR checked_out_at IS NOT NULL THEN 1 ELSE 0 END) AS scanned_records,
                SUM(CASE WHEN date >= CURDATE() AND (
                    checked_in_at IS NOT NULL OR checked_mid_at IS NOT NULL OR checked_out_at IS NOT NULL
                    OR COALESCE(flag_in_id, 1) NOT IN (1, 8)
                    OR COALESCE(flag_check_id, 1) NOT IN (1, 8)
                    OR COALESCE(flag_out_id, 1) NOT IN (1, 8)
                ) THEN 1 ELSE 0 END) AS protected_current_future_records,
                SUM(CASE WHEN date >= CURDATE()
                    AND checked_in_at IS NULL AND checked_mid_at IS NULL AND checked_out_at IS NULL
                    AND COALESCE(flag_in_id, 1) IN (1, 8)
                    AND COALESCE(flag_check_id, 1) IN (1, 8)
                    AND COALESCE(flag_out_id, 1) IN (1, 8)
                THEN 1 ELSE 0 END) AS rebuildable_placeholders
            FROM tbl_attendance_records WHERE schedule_id = ?");
        if ($stmt) {
            $stmt->bind_param('i', $scheduleId);
            $stmt->execute();
            $row = $stmt->get_result()->fetch_assoc() ?: [];
            $stmt->close();
            foreach (array_keys($impact) as $key) {
                if (!in_array($key, ['next_effective_date', 'active_session_now'], true) && isset($row[$key])) $impact[$key] = (int)$row[$key];
            }
        }
        $state = $resultingState ?: schedule_edit_get_state($mysqli, $scheduleId);
        $impact['next_effective_date'] = $state ? schedule_edit_next_occurrence($state) : null;
        $currentState = schedule_edit_get_state($mysqli, $scheduleId);
        $impact['active_session_now'] = $currentState ? schedule_edit_is_active_now($currentState) : false;
        return $impact;
    }
}

if (!function_exists('schedule_edit_is_active_now')) {
    function schedule_edit_is_active_now(array $state): bool
    {
        $day = strtolower(trim((string)($state['day_of_week'] ?? '')));
        if ($day === '' || $day !== strtolower(date('l'))) return false;
        $start = schedule_edit_normalize_time($state['start_time'] ?? '');
        $end = schedule_edit_normalize_time($state['end_time'] ?? '');
        if ($start === '' || $end === '') return false;
        $now = date('H:i:s');
        return $now >= $start && $now <= $end;
    }
}

if (!function_exists('schedule_edit_identity_changes')) {
    function schedule_edit_identity_changes(array $before, array $after): array
    {
        $changes = [];
        foreach (['user_id', 'semester_id', 'subject_id', 'section_id'] as $field) {
            if ((int)($before[$field] ?? 0) !== (int)($after[$field] ?? 0)) $changes[] = $field;
        }
        return $changes;
    }
}

if (!function_exists('schedule_edit_has_protected_history')) {
    function schedule_edit_has_protected_history(array $impact): bool
    {
        return (int)($impact['historical_records'] ?? 0) > 0
            || (int)($impact['scanned_records'] ?? 0) > 0
            || (int)($impact['protected_current_future_records'] ?? 0) > 0;
    }
}

if (!function_exists('schedule_edit_audit_details')) {
    function schedule_edit_audit_details(string $source, int $scheduleId, array $before, array $after, array $impact, array $sync = [], ?int $requestId = null): string
    {
        return json_encode([
            'event' => 'class_schedule_edit',
            'source' => $source,
            'schedule_id' => $scheduleId,
            'request_id' => $requestId,
            'before' => schedule_edit_normalize_state($before),
            'after' => schedule_edit_normalize_state($after),
            'impact' => $impact,
            'attendance_sync' => $sync,
        ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }
}
