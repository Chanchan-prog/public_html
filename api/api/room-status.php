<?php
// api/api/room-status.php

if (!isset($GLOBALS['mysqli']) || $GLOBALS['mysqli'] === null) {
    if (file_exists(__DIR__ . '/../config/database.php')) {
        require_once __DIR__ . '/../config/database.php';
    }
}

if (!function_exists('json_response')) {
    require_once __DIR__ . '/../helpers/functions.php';
}

global $mysqli;

$request_method = $_SERVER['REQUEST_METHOD'];

if ($request_method !== 'GET') {
    json_response(['error' => 'method_not_allowed', 'message' => 'Only GET is allowed'], 405);
}

$roomName = trim((string)($_GET['room'] ?? $_GET['room_name'] ?? ''));
$date = trim((string)($_GET['date'] ?? date('Y-m-d')));
if ($roomName === '') {
    json_response(['error' => 'missing_room', 'message' => 'Room name is required'], 400);
}

$dayOfWeek = strtolower(date('l', strtotime($date)));

function room_status_column_exists($mysqli, $table, $column) {
    $table = preg_replace('/[^a-zA-Z0-9_]/', '', (string)$table);
    $column = preg_replace('/[^a-zA-Z0-9_]/', '', (string)$column);
    if ($table === '' || $column === '') return false;
    $safe = $mysqli->real_escape_string($column);
    $res = $mysqli->query("SHOW COLUMNS FROM `$table` LIKE '{$safe}'");
    return $res && $res->num_rows > 0;
}

function room_status_table_exists($mysqli, $table) {
    $table = preg_replace('/[^a-zA-Z0-9_]/', '', (string)$table);
    if ($table === '') return false;
    $safe = $mysqli->real_escape_string($table);
    $res = $mysqli->query("SHOW TABLES LIKE '{$safe}'");
    return $res && $res->num_rows > 0;
}

$hasSubjectOfferings = room_status_table_exists($mysqli, 'tbl_subject_offerings');
$csHasOffering = room_status_column_exists($mysqli, 'tbl_class_schedules', 'offering_id');
$csHasUser = room_status_column_exists($mysqli, 'tbl_class_schedules', 'user_id');
$csHasSubject = room_status_column_exists($mysqli, 'tbl_class_schedules', 'subject_id');
$csHasSection = room_status_column_exists($mysqli, 'tbl_class_schedules', 'section_id');
$soHasUser = $hasSubjectOfferings ? room_status_column_exists($mysqli, 'tbl_subject_offerings', 'user_id') : false;
$soHasSubject = $hasSubjectOfferings ? room_status_column_exists($mysqli, 'tbl_subject_offerings', 'subject_id') : false;
$soHasSection = $hasSubjectOfferings ? room_status_column_exists($mysqli, 'tbl_subject_offerings', 'section_id') : false;

$joinOffering = ($hasSubjectOfferings && $csHasOffering) ? "LEFT JOIN tbl_subject_offerings so ON cs.offering_id = so.offering_id" : '';
$teacherExpr = $csHasUser ? 'cs.user_id' : (($hasSubjectOfferings && $csHasOffering && $soHasUser) ? 'so.user_id' : 'NULL');
$subjectExpr = $csHasSubject ? 'cs.subject_id' : (($hasSubjectOfferings && $csHasOffering && $soHasSubject) ? 'so.subject_id' : 'NULL');
$sectionExpr = $csHasSection ? 'cs.section_id' : (($hasSubjectOfferings && $csHasOffering && $soHasSection) ? 'so.section_id' : 'NULL');

$sql = "SELECT
    r.room_id,
    r.room_name,
    b.building_name,
    f.floor_name,
    cs.schedule_id,
    cs.start_time,
    cs.end_time,
    cs.day_of_week,
    {$teacherExpr} AS teacher_id,
    CONCAT_WS(' ', u.first_name, u.last_name) AS teacher_name,
    NULLIF(CAST(u.image AS CHAR), '') AS photo,
    s.subject_code,
    s.subject_name,
    sec.section_name
FROM tbl_rooms r
JOIN tbl_class_schedules cs ON cs.room_id = r.room_id
LEFT JOIN tbl_buildings b ON r.building_id = b.building_id
LEFT JOIN tbl_floors f ON r.floor_id = f.floor_id
{$joinOffering}
LEFT JOIN tbl_users u ON {$teacherExpr} = u.user_id
LEFT JOIN tbl_subject s ON {$subjectExpr} = s.subject_id
LEFT JOIN tbl_sections sec ON {$sectionExpr} = sec.section_id
WHERE LOWER(r.room_name) = LOWER(?)
  AND LOWER(cs.day_of_week) = ?
  AND LOWER(TRIM(COALESCE(r.status, ''))) IN ('active', '1', 'true')
  AND LOWER(TRIM(COALESCE(f.status, ''))) IN ('active', '1', 'true')
  AND LOWER(TRIM(COALESCE(b.status, ''))) IN ('active', '1', 'true')
  AND LOWER(TRIM(COALESCE(u.status, ''))) = 'active'
ORDER BY cs.start_time ASC";

$stmt = $mysqli->prepare($sql);
if (!$stmt) {
    json_response(['error' => 'db_prepare_failed', 'message' => $mysqli->error], 500);
}
$stmt->bind_param('ss', $roomName, $dayOfWeek);
$stmt->execute();
$result = $stmt->get_result();
$schedules = $result ? $result->fetch_all(MYSQLI_ASSOC) : [];
$stmt->close();

if (empty($schedules)) {
    json_response([
        'room_name' => $roomName,
        'status' => 'NO_CLASS',
        'status_text' => 'No class scheduled for today',
        'teacher_name' => null,
        'photo' => null,
        'subject' => null,
        'section_name' => null,
        'scheduled_time' => null
    ]);
}

$now = new DateTime("{$date}T" . date('H:i:s'));
$activeSchedule = null;
$upcomingSchedule = null;
$pastSchedule = null;

foreach ($schedules as $schedule) {
    $startTime = trim($schedule['start_time'] ?? '');
    $endTime = trim($schedule['end_time'] ?? '');
    if (!$startTime || !$endTime) {
        continue;
    }

    $start = DateTime::createFromFormat('Y-m-d H:i:s', "{$date} {$startTime}");
    $end = DateTime::createFromFormat('Y-m-d H:i:s', "{$date} {$endTime}");
    if (!$start || !$end) continue;

    if ($now >= $start && $now <= $end) {
        $activeSchedule = $schedule;
        break;
    }

    if ($now < $start && ($upcomingSchedule === null || $start < DateTime::createFromFormat('Y-m-d H:i:s', "{$date} {$upcomingSchedule['start_time']}"))) {
        $upcomingSchedule = $schedule;
    }

    if ($now > $end) {
        $pastSchedule = $schedule;
    }
}

if ($activeSchedule === null) {
    if ($upcomingSchedule !== null) {
        $activeSchedule = $upcomingSchedule;
    } else {
        $activeSchedule = $pastSchedule ?? $schedules[0];
    }
}

function normalize_status_by_flags($flags, $statusName) {
    if (!$flags) return null;
    $name = strtolower(trim((string)$flags));
    if ($name === 'late') return 'LATE';
    if ($name === 'absent') return 'ABSENT';
    if ($name === 'present' || $name === 'on time') return 'PRESENT';
    if ($name === 'substituted' || $name === 'substitute') return 'PRESENT';
    return $statusName;
}

$response = [
    'room_name' => $activeSchedule['room_name'],
    'room_id' => (int)$activeSchedule['room_id'],
    'building_name' => $activeSchedule['building_name'] ?? null,
    'floor_name' => $activeSchedule['floor_name'] ?? null,
    'teacher_id' => $activeSchedule['teacher_id'] ? (int)$activeSchedule['teacher_id'] : null,
    'teacher_name' => $activeSchedule['teacher_name'] ?: null,
    'photo' => $activeSchedule['photo'] ?: null,
    'subject' => trim(($activeSchedule['subject_code'] ?: '') . ' ' . ($activeSchedule['subject_name'] ?: '')) ?: null,
    'section_name' => $activeSchedule['section_name'] ?? null,
    'scheduled_time' => ($activeSchedule['start_time'] && $activeSchedule['end_time']) ? trim($activeSchedule['start_time'] . ' - ' . $activeSchedule['end_time']) : null,
    'start_time' => $activeSchedule['start_time'] ?? null,
    'end_time' => $activeSchedule['end_time'] ?? null,
    'schedule_id' => $activeSchedule['schedule_id'] ? (int)$activeSchedule['schedule_id'] : null
];

// Attempt to locate attendance record for the scheduled teacher, if available.
$attendanceRecord = null;
if (!empty($response['schedule_id']) && !empty($response['teacher_id'])) {
    $arSql = "SELECT ar.attendance_id, ar.flag_in_id, ar.checked_in_at, ar.flag_check_id, ar.checked_mid_at, ar.flag_out_id, ar.checked_out_at, ft_in.flag_name AS flag_in_name, ft_check.flag_name AS flag_check_name, ft_out.flag_name AS flag_out_name
        FROM tbl_attendance_records ar
        LEFT JOIN tbl_flag_types ft_in ON ar.flag_in_id = ft_in.flag_id
        LEFT JOIN tbl_flag_types ft_check ON ar.flag_check_id = ft_check.flag_id
        LEFT JOIN tbl_flag_types ft_out ON ar.flag_out_id = ft_out.flag_id
        WHERE ar.schedule_id = ? AND ar.date = ? AND ar.user_id = ?
        LIMIT 1";
    $arStmt = $mysqli->prepare($arSql);
    if ($arStmt) {
        $arStmt->bind_param('isi', $response['schedule_id'], $date, $response['teacher_id']);
        $arStmt->execute();
        $arResult = $arStmt->get_result();
        $attendanceRecord = $arResult ? $arResult->fetch_assoc() : null;
        $arStmt->close();
    }
}

$status = 'NO_CLASS';
$statusText = 'No class scheduled for today';

$start = DateTime::createFromFormat('Y-m-d H:i:s', "{$date} {$response['start_time']}");
$end = DateTime::createFromFormat('Y-m-d H:i:s', "{$date} {$response['end_time']}");

if ($start && $end) {
    if ($attendanceRecord && !empty($attendanceRecord['checked_in_at'])) {
        $checkedIn = DateTime::createFromFormat('Y-m-d H:i:s', $attendanceRecord['checked_in_at']);
        if ($checkedIn) {
            $lateThreshold = clone $start;
            $lateThreshold->modify('+5 minutes');
            if ($checkedIn > $lateThreshold) {
                $status = 'LATE';
                $statusText = 'Teacher is late';
            } else {
                $status = 'PRESENT';
                $statusText = 'Teacher is present';
            }
        }
    }

    if ($status === 'NO_CLASS') {
        if ($now < $start) {
            $status = 'UPCOMING';
            $statusText = 'Class is scheduled soon';
        } elseif ($now >= $start && $now <= $end) {
            $status = 'ABSENT';
            $statusText = 'Teacher has not checked in yet';
        } else {
            $status = 'ABSENT';
            $statusText = 'Teacher did not attend';
        }
    }

    if ($attendanceRecord && empty($attendanceRecord['checked_in_at']) && !empty($attendanceRecord['flag_in_name'])) {
        $normalized = normalize_status_by_flags($attendanceRecord['flag_in_name'], $status);
        if ($normalized) {
            $status = $normalized;
            $statusText = 'Teacher attendance status: ' . ucfirst(strtolower($normalized));
        }
    }
}

$response['status'] = $status;
$response['status_text'] = $statusText;
$response['attendance'] = $attendanceRecord ? [
    'attendance_id' => (int)$attendanceRecord['attendance_id'],
    'flag_in_id' => $attendanceRecord['flag_in_id'] !== null ? (int)$attendanceRecord['flag_in_id'] : null,
    'checked_in_at' => $attendanceRecord['checked_in_at'] ?: null,
    'flag_check_id' => $attendanceRecord['flag_check_id'] !== null ? (int)$attendanceRecord['flag_check_id'] : null,
    'checked_mid_at' => $attendanceRecord['checked_mid_at'] ?: null,
    'flag_out_id' => $attendanceRecord['flag_out_id'] !== null ? (int)$attendanceRecord['flag_out_id'] : null,
    'checked_out_at' => $attendanceRecord['checked_out_at'] ?: null,
    'flag_in_name' => $attendanceRecord['flag_in_name'] ?: null,
    'flag_check_name' => $attendanceRecord['flag_check_name'] ?: null,
    'flag_out_name' => $attendanceRecord['flag_out_name'] ?: null
] : null;

json_response($response);
