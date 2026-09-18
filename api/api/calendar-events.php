<?php

declare(strict_types=1);

require_once __DIR__ . '/../helpers/calendar_event_helper.php';
require_once __DIR__ . '/../helpers/log_helper.php';
require_once __DIR__ . '/../helpers/socket_helper.php';
require_once __DIR__ . '/../scripts/cron_worker_lib.php';

global $mysqli, $authPayload;

calendar_event_schema_ensure($mysqli);
$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$input = get_input();
$path = parse_url((string)($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);
$parts = array_values(array_filter(explode('/', (string)$path), 'strlen'));
$apiIndex = array_search('api', $parts, true);
$param1 = $apiIndex === false ? null : ($parts[$apiIndex + 2] ?? null);
$auth = is_array($authPayload) ? $authPayload : app_get_authenticated_session(true);
$userId = (int)($auth['user_id'] ?? 0);
$roleId = (int)($auth['role_id'] ?? 0);
$authDeptId = isset($auth['dept_id']) && $auth['dept_id'] !== null ? (int)$auth['dept_id'] : 0;

$bind = static function(mysqli_stmt $stmt, string $types, array &$values): void {
    if ($types === '') return;
    $refs = [&$types];
    foreach ($values as $key => $_) $refs[] = &$values[$key];
    call_user_func_array([$stmt, 'bind_param'], $refs);
};

$requireManager = static function() use ($roleId, $authDeptId): void {
    if (!in_array($roleId, [1, 6], true)) {
        json_response(['error' => 'forbidden', 'message' => 'Only Admin and Department Admin can manage holidays and events.'], 403);
    }
    if ($roleId === 6 && $authDeptId <= 0) {
        json_response(['error' => 'department_required', 'message' => 'This Department Admin account has no assigned department.'], 403);
    }
};

$validateScope = static function(array $payload) use ($mysqli, $roleId, $authDeptId): array {
    $deptId = isset($payload['dept_id']) && $payload['dept_id'] !== '' ? (int)$payload['dept_id'] : null;
    $programId = isset($payload['program_id']) && $payload['program_id'] !== '' ? (int)$payload['program_id'] : null;
    if ($roleId === 6) $deptId = $authDeptId;
    if ($programId !== null && $programId <= 0) $programId = null;
    if ($deptId !== null && $deptId <= 0) $deptId = null;
    if ($programId !== null && $deptId === null) {
        json_response(['error' => 'department_required', 'message' => 'Select a department before selecting a program.'], 422);
    }
    if ($deptId !== null) {
        $stmt = $mysqli->prepare("SELECT dept_id FROM tbl_departments WHERE dept_id = ? AND LOWER(TRIM(status)) = 'active' LIMIT 1");
        $stmt->bind_param('i', $deptId); $stmt->execute();
        if (!$stmt->get_result()->fetch_row()) json_response(['error' => 'invalid_department', 'message' => 'The selected department is unavailable.'], 422);
        $stmt->close();
    }
    if ($programId !== null) {
        $stmt = $mysqli->prepare("SELECT program_id FROM tbl_programs WHERE program_id = ? AND dept_id = ? AND LOWER(TRIM(status)) = 'active' LIMIT 1");
        $stmt->bind_param('ii', $programId, $deptId); $stmt->execute();
        if (!$stmt->get_result()->fetch_row()) json_response(['error' => 'invalid_program', 'message' => 'The selected program is unavailable or outside the department.'], 422);
        $stmt->close();
    }
    return [$deptId, $programId];
};

$validateEvent = static function(array $payload, ?int $ignoreId = null) use ($mysqli, $validateScope): array {
    $title = trim((string)($payload['title'] ?? ''));
    $description = trim((string)($payload['description'] ?? ''));
    $type = strtolower(trim((string)($payload['event_type'] ?? 'event')));
    $from = trim((string)($payload['date_from'] ?? ''));
    $to = trim((string)($payload['date_to'] ?? ''));
    if ($title === '' || mb_strlen($title) > 180) json_response(['error' => 'validation', 'message' => 'Enter a title of up to 180 characters.'], 422);
    if (!in_array($type, ['holiday', 'event'], true)) json_response(['error' => 'validation', 'message' => 'Type must be Holiday or Event.'], 422);
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $from) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $to) || $to < $from) {
        json_response(['error' => 'validation', 'message' => 'Choose a valid start and end date.'], 422);
    }
    if ($from < date('Y-m-d')) json_response(['error' => 'past_date', 'message' => 'Past holidays or events cannot be created or edited.'], 422);
    [$deptId, $programId] = $validateScope($payload);
    $sql = "SELECT event_id FROM tbl_calendar_events WHERE status = 'active' AND LOWER(title) = LOWER(?) AND event_type = ? AND date_from = ? AND date_to = ? AND dept_id <=> ? AND program_id <=> ?";
    if ($ignoreId) $sql .= ' AND event_id <> ?';
    $sql .= ' LIMIT 1';
    $stmt = $mysqli->prepare($sql);
    if ($ignoreId) $stmt->bind_param('ssssiii', $title, $type, $from, $to, $deptId, $programId, $ignoreId);
    else $stmt->bind_param('ssssii', $title, $type, $from, $to, $deptId, $programId);
    $stmt->execute();
    if ($stmt->get_result()->fetch_row()) json_response(['error' => 'duplicate', 'message' => 'This active holiday or event already exists.'], 409);
    $stmt->close();
    return compact('title', 'description', 'type', 'from', 'to', 'deptId', 'programId');
};

if ($method === 'GET' && $param1 === 'occurrences') {
    $teacherId = (int)($_GET['teacher_id'] ?? $userId);
    if ($teacherId !== $userId) json_response(['error' => 'forbidden', 'message' => 'You can only view your own calendar.'], 403);
    $from = (string)($_GET['date_from'] ?? date('Y-m-01'));
    $to = (string)($_GET['date_to'] ?? date('Y-m-t'));
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $from) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $to) || $to < $from || (strtotime($to) - strtotime($from)) > 70 * 86400) {
        json_response(['error' => 'invalid_range', 'message' => 'Calendar range must be valid and no longer than 70 days.'], 422);
    }
    $semesterId = (int)($_GET['semester_id'] ?? 0);
    $sql = "SELECT cs.schedule_id, cs.semester_id, cs.day_of_week, cs.start_time, cs.end_time,
                   s.subject_id, s.subject_code, s.subject_name, sec.section_id, sec.section_name,
                   r.room_id, r.room_name, ce.event_id, ce.title AS event_title, ce.event_type,
                   GREATEST(ce.date_from, ?, sem.start_date) AS effective_from,
                   LEAST(ce.date_to, ?, sem.end_date) AS effective_to
            FROM tbl_class_schedules cs
            JOIN tbl_semesters sem ON sem.semester_id = cs.semester_id
            JOIN tbl_subject s ON s.subject_id = cs.subject_id
            JOIN tbl_programs sp ON sp.program_id = s.program_id
            JOIN tbl_sections sec ON sec.section_id = cs.section_id
            JOIN tbl_programs secp ON secp.program_id = sec.program_id
            JOIN tbl_rooms r ON r.room_id = cs.room_id
            JOIN tbl_calendar_events ce ON ce.status = 'active'
              AND ce.date_to >= ? AND ce.date_from <= ?
              AND (ce.dept_id IS NULL OR (ce.dept_id = sp.dept_id AND ce.dept_id = secp.dept_id))
              AND (ce.program_id IS NULL OR (ce.program_id = sp.program_id AND ce.program_id = secp.program_id))
            WHERE cs.user_id = ?";
    if ($semesterId > 0) $sql .= ' AND cs.semester_id = ?';
    $stmt = $mysqli->prepare($sql);
    if ($semesterId > 0) $stmt->bind_param('ssssii', $from, $to, $from, $to, $teacherId, $semesterId);
    else $stmt->bind_param('ssssi', $from, $to, $from, $to, $teacherId);
    $stmt->execute();
    $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $stmt->close();

    $attendance = [];
    $stmt = $mysqli->prepare("SELECT schedule_id, DATE_FORMAT(date, '%Y-%m-%d') AS record_date,
            checked_in_at, checked_mid_at, checked_out_at, flag_in_id, flag_check_id, flag_out_id
        FROM tbl_attendance_records WHERE user_id = ? AND date BETWEEN ? AND ?");
    $stmt->bind_param('iss', $teacherId, $from, $to); $stmt->execute();
    foreach ($stmt->get_result()->fetch_all(MYSQLI_ASSOC) as $record) $attendance[$record['schedule_id'] . ':' . $record['record_date']] = $record;
    $stmt->close();

    $occurrences = [];
    $today = date('Y-m-d'); $nowTime = date('H:i:s');
    foreach ($rows as $row) {
        $start = max($from, (string)$row['effective_from']);
        $end = min($to, (string)$row['effective_to']);
        if ($end < $start) continue;
        $cursor = new DateTimeImmutable($start); $last = new DateTimeImmutable($end);
        for (; $cursor <= $last; $cursor = $cursor->modify('+1 day')) {
            $date = $cursor->format('Y-m-d');
            if (strtolower($cursor->format('l')) !== strtolower((string)$row['day_of_week'])) continue;
            if ($date === $today && (string)$row['start_time'] <= $nowTime) continue;
            $key = $row['schedule_id'] . ':' . $date;
            $record = $attendance[$key] ?? null;
            if ($record) {
                $pristine = !$record['checked_in_at'] && !$record['checked_mid_at'] && !$record['checked_out_at']
                    && (int)($record['flag_in_id'] ?? 1) === 1
                    && (int)($record['flag_check_id'] ?? 1) === 1
                    && (int)($record['flag_out_id'] ?? 1) === 1;
                if (!$pristine) continue;
            }
            if (!isset($occurrences[$key])) {
                $occurrences[$key] = [
                    'id' => 'no-class-' . $row['schedule_id'] . '-' . $date,
                    'schedule_id' => (int)$row['schedule_id'], 'semester_id' => (int)$row['semester_id'], 'date' => $date,
                    'subject_id' => (int)$row['subject_id'], 'subject_code' => $row['subject_code'], 'subject_name' => $row['subject_name'],
                    'section_id' => (int)$row['section_id'], 'section_name' => $row['section_name'],
                    'room_id' => (int)$row['room_id'], 'room_name' => $row['room_name'],
                    'start_time' => $row['start_time'], 'end_time' => $row['end_time'],
                    'is_no_class' => true, 'event_titles' => [], 'event_types' => [],
                ];
            }
            $occurrences[$key]['event_titles'][] = $row['event_title'];
            $occurrences[$key]['event_types'][] = $row['event_type'];
        }
    }
    foreach ($occurrences as &$entry) {
        $entry['event_titles'] = array_values(array_unique($entry['event_titles']));
        $entry['event_types'] = array_values(array_unique($entry['event_types']));
        $entry['event_title'] = implode(' / ', $entry['event_titles']);
    }
    unset($entry);
    json_response(['items' => array_values($occurrences), 'total' => count($occurrences)]);
}

$requireManager();

if ($method === 'POST' && $param1 === 'preview') {
    $ignoreId = isset($input['event_id']) && (int)$input['event_id'] > 0 ? (int)$input['event_id'] : null;
    if ($ignoreId !== null) {
        $scopeStmt = $mysqli->prepare('SELECT dept_id, date_from FROM tbl_calendar_events WHERE event_id = ? LIMIT 1');
        $scopeStmt->bind_param('i', $ignoreId); $scopeStmt->execute(); $scopeRow = $scopeStmt->get_result()->fetch_assoc(); $scopeStmt->close();
        if (!$scopeRow) json_response(['error' => 'not_found', 'message' => 'Calendar event not found.'], 404);
        if ($roleId === 6 && (int)$scopeRow['dept_id'] !== $authDeptId) json_response(['error' => 'forbidden', 'message' => 'You can only preview changes inside your department.'], 403);
        if ((string)$scopeRow['date_from'] < date('Y-m-d')) json_response(['error' => 'locked', 'message' => 'This event has already started and is read-only.'], 409);
    }
    $event = $validateEvent($input, $ignoreId);

    $scheduleSql = "SELECT cs.schedule_id, cs.day_of_week, cs.start_time,
            GREATEST(sem.start_date, ?) AS effective_from,
            LEAST(sem.end_date, ?) AS effective_to
        FROM tbl_class_schedules cs
        JOIN tbl_semesters sem ON sem.semester_id = cs.semester_id
        JOIN tbl_subject subj ON subj.subject_id = cs.subject_id
        JOIN tbl_programs sp ON sp.program_id = subj.program_id
        JOIN tbl_sections sec ON sec.section_id = cs.section_id
        JOIN tbl_programs secp ON secp.program_id = sec.program_id
        WHERE sem.end_date >= ? AND sem.start_date <= ?";
    $scheduleTypes = 'ssss';
    $scheduleValues = [$event['from'], $event['to'], $event['from'], $event['to']];
    if ($event['deptId'] !== null) {
        $scheduleSql .= ' AND sp.dept_id = ? AND secp.dept_id = ?';
        $scheduleTypes .= 'ii'; $scheduleValues[] = $event['deptId']; $scheduleValues[] = $event['deptId'];
    }
    if ($event['programId'] !== null) {
        $scheduleSql .= ' AND sp.program_id = ? AND secp.program_id = ?';
        $scheduleTypes .= 'ii'; $scheduleValues[] = $event['programId']; $scheduleValues[] = $event['programId'];
    }
    $scheduleStmt = $mysqli->prepare($scheduleSql);
    $bind($scheduleStmt, $scheduleTypes, $scheduleValues); $scheduleStmt->execute();
    $scheduleRows = $scheduleStmt->get_result()->fetch_all(MYSQLI_ASSOC); $scheduleStmt->close();
    $affected = [];
    $today = date('Y-m-d'); $nowTime = date('H:i:s');
    foreach ($scheduleRows as $schedule) {
        $start = max($event['from'], (string)$schedule['effective_from']);
        $end = min($event['to'], (string)$schedule['effective_to']);
        if ($end < $start) continue;
        $cursor = new DateTimeImmutable($start); $last = new DateTimeImmutable($end);
        for (; $cursor <= $last; $cursor = $cursor->modify('+1 day')) {
            $date = $cursor->format('Y-m-d');
            if (strtolower($cursor->format('l')) !== strtolower((string)$schedule['day_of_week'])) continue;
            if ($date === $today && (string)$schedule['start_time'] <= $nowTime) continue;
            $affected[$schedule['schedule_id'] . ':' . $date] = true;
        }
    }

    // A class that already contains attendance activity is intentionally not
    // converted to No Class, so exclude it from the preview count as well.
    $attendanceSql = "SELECT ar.schedule_id, DATE_FORMAT(ar.date, '%Y-%m-%d') AS record_date,
            ar.checked_in_at, ar.checked_mid_at, ar.checked_out_at,
            ar.flag_in_id, ar.flag_check_id, ar.flag_out_id
        FROM tbl_attendance_records ar
        JOIN tbl_class_schedules cs ON cs.schedule_id = ar.schedule_id
        JOIN tbl_subject subj ON subj.subject_id = cs.subject_id
        JOIN tbl_programs sp ON sp.program_id = subj.program_id
        JOIN tbl_sections sec ON sec.section_id = cs.section_id
        JOIN tbl_programs secp ON secp.program_id = sec.program_id
        WHERE ar.date BETWEEN ? AND ?";
    $attendanceTypes = 'ss'; $attendanceValues = [$event['from'], $event['to']];
    if ($event['deptId'] !== null) {
        $attendanceSql .= ' AND sp.dept_id = ? AND secp.dept_id = ?';
        $attendanceTypes .= 'ii'; $attendanceValues[] = $event['deptId']; $attendanceValues[] = $event['deptId'];
    }
    if ($event['programId'] !== null) {
        $attendanceSql .= ' AND sp.program_id = ? AND secp.program_id = ?';
        $attendanceTypes .= 'ii'; $attendanceValues[] = $event['programId']; $attendanceValues[] = $event['programId'];
    }
    $attendanceStmt = $mysqli->prepare($attendanceSql);
    $bind($attendanceStmt, $attendanceTypes, $attendanceValues); $attendanceStmt->execute();
    foreach ($attendanceStmt->get_result()->fetch_all(MYSQLI_ASSOC) as $record) {
        $pristine = !$record['checked_in_at'] && !$record['checked_mid_at'] && !$record['checked_out_at']
            && (int)($record['flag_in_id'] ?? 1) === 1
            && (int)($record['flag_check_id'] ?? 1) === 1
            && (int)($record['flag_out_id'] ?? 1) === 1;
        if (!$pristine) unset($affected[$record['schedule_id'] . ':' . $record['record_date']]);
    }
    $attendanceStmt->close();

    $overlapSql = "SELECT ce.event_id, ce.title, ce.event_type, ce.date_from, ce.date_to,
            COALESCE(d.dept_name, 'All departments') AS department_name,
            COALESCE(p.program_name, 'All programs') AS program_name
        FROM tbl_calendar_events ce
        LEFT JOIN tbl_departments d ON d.dept_id = ce.dept_id
        LEFT JOIN tbl_programs p ON p.program_id = ce.program_id
        WHERE ce.status = 'active' AND ce.date_from <= ? AND ce.date_to >= ?
          AND (ce.dept_id IS NULL OR ? IS NULL OR ce.dept_id = ?)
          AND (ce.program_id IS NULL OR ? IS NULL OR ce.program_id = ?)";
    $overlapValues = [$event['to'], $event['from'], $event['deptId'], $event['deptId'], $event['programId'], $event['programId']];
    $overlapTypes = 'ssiiii';
    if ($ignoreId !== null) { $overlapSql .= ' AND ce.event_id <> ?'; $overlapTypes .= 'i'; $overlapValues[] = $ignoreId; }
    $overlapSql .= ' ORDER BY ce.date_from, ce.title';
    $overlapStmt = $mysqli->prepare($overlapSql);
    $bind($overlapStmt, $overlapTypes, $overlapValues); $overlapStmt->execute();
    $overlaps = $overlapStmt->get_result()->fetch_all(MYSQLI_ASSOC); $overlapStmt->close();
    json_response(['affected_class_count' => count($affected), 'overlaps' => $overlaps]);
}

if ($method === 'GET') {
    $page = max(1, (int)($_GET['page'] ?? 1));
    $pageSize = min(200, max(1, (int)($_GET['page_size'] ?? 10)));
    $status = strtolower(trim((string)($_GET['status'] ?? 'all')));
    $type = strtolower(trim((string)($_GET['event_type'] ?? 'all')));
    $search = trim((string)($_GET['q'] ?? ''));
    $rangeFrom = trim((string)($_GET['date_from'] ?? ''));
    $rangeTo = trim((string)($_GET['date_to'] ?? ''));
    $where = []; $types = ''; $values = [];
    if ($roleId === 6) { $where[] = '(ce.dept_id IS NULL OR ce.dept_id = ?)'; $types .= 'i'; $values[] = $authDeptId; }
    if (in_array($status, ['active', 'cancelled'], true)) { $where[] = 'ce.status = ?'; $types .= 's'; $values[] = $status; }
    if (in_array($type, ['holiday', 'event'], true)) { $where[] = 'ce.event_type = ?'; $types .= 's'; $values[] = $type; }
    if ($search !== '') { $where[] = '(ce.title LIKE ? OR ce.description LIKE ?)'; $like = '%' . $search . '%'; $types .= 'ss'; $values[] = $like; $values[] = $like; }
    if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $rangeFrom)) { $where[] = 'ce.date_to >= ?'; $types .= 's'; $values[] = $rangeFrom; }
    if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $rangeTo)) { $where[] = 'ce.date_from <= ?'; $types .= 's'; $values[] = $rangeTo; }
    $whereSql = $where ? ' WHERE ' . implode(' AND ', $where) : '';
    $countStmt = $mysqli->prepare('SELECT COUNT(*) FROM tbl_calendar_events ce' . $whereSql);
    $countValues = $values; $bind($countStmt, $types, $countValues); $countStmt->execute();
    $total = (int)$countStmt->get_result()->fetch_row()[0]; $countStmt->close();
    $offset = ($page - 1) * $pageSize;
    $sql = "SELECT ce.*, d.dept_name, p.program_name,
              CONCAT(TRIM(COALESCE(u.first_name,'')), ' ', TRIM(COALESCE(u.last_name,''))) AS created_by_name,
              CONCAT(TRIM(COALESCE(cu.first_name,'')), ' ', TRIM(COALESCE(cu.last_name,''))) AS cancelled_by_name
            FROM tbl_calendar_events ce
            LEFT JOIN tbl_departments d ON d.dept_id = ce.dept_id
            LEFT JOIN tbl_programs p ON p.program_id = ce.program_id
            LEFT JOIN tbl_users u ON u.user_id = ce.created_by
            LEFT JOIN tbl_users cu ON cu.user_id = ce.cancelled_by
            {$whereSql} ORDER BY ce.date_from DESC, ce.event_id DESC LIMIT ? OFFSET ?";
    $stmt = $mysqli->prepare($sql); $dataValues = $values; $dataValues[] = $pageSize; $dataValues[] = $offset;
    $dataTypes = $types . 'ii'; $bind($stmt, $dataTypes, $dataValues); $stmt->execute();
    $items = $stmt->get_result()->fetch_all(MYSQLI_ASSOC); $stmt->close();
    $statsWhere = $roleId === 6 ? ' WHERE dept_id IS NULL OR dept_id = ' . $authDeptId : '';
    $statsResult = $mysqli->query("SELECT status, COUNT(*) total FROM tbl_calendar_events{$statsWhere} GROUP BY status");
    $stats = ['active' => 0, 'cancelled' => 0];
    while ($row = $statsResult->fetch_assoc()) $stats[$row['status']] = (int)$row['total'];
    json_response(['items' => $items, 'total' => $total, 'page' => $page, 'page_size' => $pageSize, 'stats' => $stats]);
}

if ($method === 'POST') {
    $event = $validateEvent($input);
    $mysqli->begin_transaction();
    $stmt = $mysqli->prepare("INSERT INTO tbl_calendar_events (title,event_type,date_from,date_to,dept_id,program_id,description,status,created_by) VALUES (?,?,?,?,?,?,?,'active',?)");
    $stmt->bind_param('ssssiisi', $event['title'], $event['type'], $event['from'], $event['to'], $event['deptId'], $event['programId'], $event['description'], $userId);
    if (!$stmt->execute()) { $message = $stmt->error; $mysqli->rollback(); json_response(['error' => 'create_failed', 'message' => $message], 500); }
    $id = (int)$stmt->insert_id; $stmt->close();
    $sync = calendar_event_delete_blocked_upcoming_attendance($mysqli);
    if (!$sync['ok']) { $mysqli->rollback(); json_response(['error' => 'sync_failed', 'message' => 'The entry was not saved because future attendance could not be synchronized.'], 500); }
    $mysqli->commit();
    log_system_action($mysqli, $userId, 'Create Calendar Event', "Created {$event['type']} '{$event['title']}' ({$event['from']} to {$event['to']}).");
    try { trigger_socket_update(['entity' => 'calendar_events', 'action' => 'create', 'event_id' => $id]); } catch (Throwable $_) {}
    json_response(['event_id' => $id, 'message' => 'Holiday or event created.', 'removed_upcoming_records' => $sync['deleted_rows'] ?? 0], 201);
}

$eventId = is_numeric($param1) ? (int)$param1 : 0;
if ($eventId <= 0) json_response(['error' => 'not_found', 'message' => 'Calendar event not found.'], 404);
$stmt = $mysqli->prepare('SELECT * FROM tbl_calendar_events WHERE event_id = ? LIMIT 1');
$stmt->bind_param('i', $eventId); $stmt->execute(); $existing = $stmt->get_result()->fetch_assoc(); $stmt->close();
if (!$existing) json_response(['error' => 'not_found', 'message' => 'Calendar event not found.'], 404);
if ($roleId === 6 && (int)$existing['dept_id'] !== $authDeptId) json_response(['error' => 'forbidden', 'message' => 'You can only manage events in your department.'], 403);
if ((string)$existing['date_from'] < date('Y-m-d')) json_response(['error' => 'locked', 'message' => 'This event has already started and is read-only.'], 409);

if ($method === 'PUT') {
    if ($existing['status'] !== 'active') json_response(['error' => 'cancelled', 'message' => 'Cancelled events cannot be edited.'], 409);
    $event = $validateEvent($input, $eventId);
    $mysqli->begin_transaction();
    $stmt = $mysqli->prepare('UPDATE tbl_calendar_events SET title=?,event_type=?,date_from=?,date_to=?,dept_id=?,program_id=?,description=?,updated_by=? WHERE event_id=?');
    $stmt->bind_param('ssssiisii', $event['title'], $event['type'], $event['from'], $event['to'], $event['deptId'], $event['programId'], $event['description'], $userId, $eventId);
    if (!$stmt->execute()) { $message = $stmt->error; $stmt->close(); $mysqli->rollback(); json_response(['error' => 'update_failed', 'message' => $message], 500); }
    $stmt->close();
    $generated = cw_generate_attendance_records($mysqli, [], 0, 31, true);
    $sync = calendar_event_delete_blocked_upcoming_attendance($mysqli);
    if (!$generated['ok'] || !$sync['ok']) { $mysqli->rollback(); json_response(['error' => 'sync_failed', 'message' => 'The changes were not saved because future attendance could not be synchronized.'], 500); }
    $mysqli->commit();
    log_system_action($mysqli, $userId, 'Update Calendar Event', "Updated '{$event['title']}'.");
    try { trigger_socket_update(['entity' => 'calendar_events', 'action' => 'update', 'event_id' => $eventId]); } catch (Throwable $_) {}
    json_response(['message' => 'Holiday or event updated.', 'removed_upcoming_records' => $sync['deleted_rows'] ?? 0]);
}

if ($method === 'DELETE') {
    if ($existing['status'] !== 'active') json_response(['error' => 'cancelled', 'message' => 'This event is already cancelled.'], 409);
    $mysqli->begin_transaction();
    $stmt = $mysqli->prepare("UPDATE tbl_calendar_events SET status='cancelled',cancelled_by=?,cancelled_at=NOW(),updated_by=? WHERE event_id=?");
    $stmt->bind_param('iii', $userId, $userId, $eventId);
    if (!$stmt->execute()) { $message = $stmt->error; $stmt->close(); $mysqli->rollback(); json_response(['error' => 'cancel_failed', 'message' => $message], 500); }
    $stmt->close();
    $generated = cw_generate_attendance_records($mysqli, [], 0, 31, true);
    $sync = calendar_event_delete_blocked_upcoming_attendance($mysqli);
    if (!$generated['ok'] || !$sync['ok']) { $mysqli->rollback(); json_response(['error' => 'sync_failed', 'message' => 'The entry was not cancelled because future attendance could not be synchronized.'], 500); }
    $mysqli->commit();
    log_system_action($mysqli, $userId, 'Cancel Calendar Event', "Cancelled '{$existing['title']}'.");
    try { trigger_socket_update(['entity' => 'calendar_events', 'action' => 'cancel', 'event_id' => $eventId]); } catch (Throwable $_) {}
    json_response(['message' => 'Holiday or event cancelled.', 'restored_upcoming_records' => $generated['generated_rows'] ?? 0]);
}

json_response(['error' => 'method_not_allowed'], 405);
