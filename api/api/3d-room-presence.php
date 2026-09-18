<?php
// Compact, authenticated live marker feed for the 3D building viewer.

if (!isset($GLOBALS['mysqli']) || $GLOBALS['mysqli'] === null) {
    require_once __DIR__ . '/../config/database.php';
}
if (!function_exists('json_response')) {
    require_once __DIR__ . '/../helpers/functions.php';
}

global $mysqli, $authPayload;

if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'GET') {
    json_response(['error' => 'method_not_allowed'], 405);
}

$buildingCode = strtoupper(trim((string)($_GET['building_code'] ?? '')));
$buildingId = isset($_GET['building_id']) && is_numeric($_GET['building_id']) ? (int)$_GET['building_id'] : 0;
$allBuildings = isset($_GET['all_buildings']) && in_array(strtolower(trim((string)$_GET['all_buildings'])), ['1', 'true', 'yes'], true);
$tableView = isset($_GET['table_view']) && in_array(strtolower(trim((string)$_GET['table_view'])), ['1', 'true', 'yes'], true);
$exportAll = isset($_GET['export']) && in_array(strtolower(trim((string)$_GET['export'])), ['1', 'true', 'yes'], true);
$tablePage = isset($_GET['page']) && is_numeric($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
$tablePageSize = isset($_GET['page_size']) && is_numeric($_GET['page_size'])
    ? max(1, min(100, (int)$_GET['page_size']))
    : 10;
$floorFilter = trim((string)($_GET['floor_name'] ?? ''));
$buildingNameFilter = trim((string)($_GET['building_name'] ?? ''));
$searchFilter = trim((string)($_GET['search'] ?? ''));
$statusFilter = strtoupper(str_replace([' ', '-'], '_', trim((string)($_GET['status'] ?? ''))));
$buildingAliases = [
    'MW' => ['mainwest', 'mw'],
    'MN' => ['mainnorth', 'mn'],
    'MS' => ['mainsouth', 'ms'],
    'PH' => ['phinmahall', 'ph'],
    'SHS' => ['seniorhighbuilding', 'seniorhighschool', 'seniorhigh', 'shs'],
    'BED' => ['bed', 'basiceducationdepartment', 'basiceducation'],
];
if (!$allBuildings && $buildingId <= 0 && !isset($buildingAliases[$buildingCode])) {
    json_response(['error' => 'validation', 'message' => 'building_code must be MW, MN, MS, PH, SHS, or BED.'], 400);
}
if ($allBuildings) {
    $buildingCode = 'ALL';
} elseif ($buildingId > 0) {
    $buildingScopeStmt = $mysqli->prepare("SELECT building_id, building_name, status FROM tbl_buildings WHERE building_id = ? LIMIT 1");
    if (!$buildingScopeStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $buildingScopeStmt->bind_param('i', $buildingId);
    $buildingScopeStmt->execute();
    $buildingScope = $buildingScopeStmt->get_result()->fetch_assoc();
    $buildingScopeStmt->close();
    if (!$buildingScope) json_response(['error' => 'building_not_found', 'message' => 'Building not found.'], 404);
    if (!in_array(strtolower(trim((string)($buildingScope['status'] ?? ''))), ['active', '1', 'true'], true)) {
        json_response(['error' => 'inactive_building', 'message' => 'The selected building is not active.'], 409);
    }
    $buildingCode = 'B' . $buildingId;
}

$authUserId = isset($authPayload['user_id']) ? (int)$authPayload['user_id'] : 0;
$authRoleId = isset($authPayload['role_id']) ? (int)$authPayload['role_id'] : 0;
if ($authUserId <= 0) {
    json_response(['error' => 'unauthorized'], 401);
}

function tdb_presence_table_exists(mysqli $mysqli, string $table): bool {
    $safe = $mysqli->real_escape_string(preg_replace('/[^a-zA-Z0-9_]/', '', $table));
    $result = $mysqli->query("SHOW TABLES LIKE '{$safe}'");
    return $result && $result->num_rows > 0;
}

function tdb_presence_column_exists(mysqli $mysqli, string $table, string $column): bool {
    $safeTable = preg_replace('/[^a-zA-Z0-9_]/', '', $table);
    $safeColumn = $mysqli->real_escape_string(preg_replace('/[^a-zA-Z0-9_]/', '', $column));
    $result = $mysqli->query("SHOW COLUMNS FROM `{$safeTable}` LIKE '{$safeColumn}'");
    return $result && $result->num_rows > 0;
}

function tdb_presence_status(int $flagId): string {
    if ($flagId === 1) return 'UPCOMING';
    if ($flagId === 2) return 'PRESENT';
    if ($flagId === 5) return 'LATE';
    if ($flagId === 3) return 'ABSENT';
    return 'PENDING';
}

function tdb_presence_thumbnail_url(int $userId): ?string {
    if ($userId <= 0) return null;
    return 'avatar-thumbnail.php?user_id=' . $userId;
}

$hasOfferings = tdb_presence_table_exists($mysqli, 'tbl_subject_offerings')
    && tdb_presence_column_exists($mysqli, 'tbl_class_schedules', 'offering_id');
$csHasUser = tdb_presence_column_exists($mysqli, 'tbl_class_schedules', 'user_id');
$csHasSubject = tdb_presence_column_exists($mysqli, 'tbl_class_schedules', 'subject_id');
$csHasSection = tdb_presence_column_exists($mysqli, 'tbl_class_schedules', 'section_id');
$soHasUser = $hasOfferings && tdb_presence_column_exists($mysqli, 'tbl_subject_offerings', 'user_id');
$soHasSubject = $hasOfferings && tdb_presence_column_exists($mysqli, 'tbl_subject_offerings', 'subject_id');
$soHasSection = $hasOfferings && tdb_presence_column_exists($mysqli, 'tbl_subject_offerings', 'section_id');
$hasSubstitutions = tdb_presence_table_exists($mysqli, 'tbl_substitutions');
$hasLeaves = tdb_presence_table_exists($mysqli, 'tbl_leaves');
$hasLeaveTypes = tdb_presence_table_exists($mysqli, 'tbl_leave_type');

$joinOffering = $hasOfferings ? 'LEFT JOIN tbl_subject_offerings so ON cs.offering_id = so.offering_id' : '';
$teacherExpr = $csHasUser ? 'cs.user_id' : (($hasOfferings && $soHasUser) ? 'so.user_id' : 'NULL');
$subjectExpr = $csHasSubject ? 'cs.subject_id' : (($hasOfferings && $soHasSubject) ? 'so.subject_id' : 'NULL');
$sectionExpr = $csHasSection ? 'cs.section_id' : (($hasOfferings && $soHasSection) ? 'so.section_id' : 'NULL');

$joinSubstitution = $hasSubstitutions ? "
    LEFT JOIN tbl_substitutions ss ON ss.substitution_id = (
        SELECT MAX(ss2.substitution_id)
        FROM tbl_substitutions ss2
        WHERE ss2.schedule_id = cs.schedule_id
          AND ss2.date = CURDATE()
          AND LOWER(COALESCE(ss2.req_status, 'approve')) NOT IN ('canceled', 'rejected')
    )
    LEFT JOIN tbl_users su ON su.user_id = ss.substitute_user_id
    LEFT JOIN tbl_attendance_records sar ON sar.schedule_id = cs.schedule_id
        AND sar.date = CURDATE() AND sar.user_id = ss.substitute_user_id" : "
    LEFT JOIN (SELECT NULL AS substitution_id, NULL AS substitute_user_id) ss ON 1 = 0
    LEFT JOIN tbl_users su ON 1 = 0
    LEFT JOIN tbl_attendance_records sar ON 1 = 0";

$substitutionSelect = $hasSubstitutions
    ? 'ss.substitution_id, ss.substitute_user_id, ss.req_status AS substitution_status,'
    : 'NULL AS substitution_id, NULL AS substitute_user_id, NULL AS substitution_status,';

$joinLeave = $hasLeaves ? "
    LEFT JOIN tbl_leaves l ON l.leave_id = (
        SELECT MAX(l2.leave_id)
        FROM tbl_leaves l2
        WHERE l2.teacher_id = {$teacherExpr}
          AND l2.req_status = 'approve'
          AND CURDATE() BETWEEN l2.date_from AND l2.date_to
    )" : 'LEFT JOIN (SELECT NULL AS leave_id, NULL AS leave_type_id, NULL AS reason) l ON 1 = 0';
$joinLeaveType = $hasLeaves && $hasLeaveTypes
    ? 'LEFT JOIN tbl_leave_type lt ON lt.leave_type_id = l.leave_type_id'
    : 'LEFT JOIN (SELECT NULL AS name_type) lt ON 1 = 0';

$normalizedAliases = ($allBuildings || $buildingId > 0) ? [] : array_map(function ($value) use ($mysqli) {
    return "'" . $mysqli->real_escape_string($value) . "'";
}, $buildingAliases[$buildingCode]);
$buildingWhere = $allBuildings
    ? '1 = 1'
    : ($buildingId > 0
        ? 'b.building_id = ' . $buildingId
        : "LOWER(REPLACE(REPLACE(TRIM(b.building_name), ' ', ''), '-', '')) IN (" . implode(',', $normalizedAliases) . ")");

$scopeSql = '';
$authDeptId = app_get_user_department_id($mysqli, $authUserId);
if ($authDeptId === null && in_array($authRoleId, [2, 4, 6], true)
    && tdb_presence_column_exists($mysqli, 'tbl_departments', 'dean_id')) {
    $deptStmt = $mysqli->prepare('SELECT dept_id FROM tbl_departments WHERE dean_id = ? LIMIT 1');
    if ($deptStmt) {
        $deptStmt->bind_param('i', $authUserId);
        $deptStmt->execute();
        $deptRow = $deptStmt->get_result()->fetch_assoc();
        $deptStmt->close();
        if ($deptRow && isset($deptRow['dept_id'])) $authDeptId = (int)$deptRow['dept_id'];
    }
}
if (in_array($authRoleId, [2, 4, 6], true)) {
    if ($authDeptId === null) {
        header('Cache-Control: no-store');
        json_response(['building_code' => $buildingCode, 'generated_at' => date(DATE_ATOM), 'version' => sha1('[]'), 'markers' => []]);
    }
    $scopeSql = ' AND u.dept_id = ' . (int)$authDeptId;
} elseif ($authRoleId === 3) {
    $scopeSql = ' AND p.head_id = ' . $authUserId;
} elseif ($authRoleId === 5) {
    $scopeSql = ' AND u.user_id = ' . $authUserId;
}

$effectiveFlagExpr = 'CASE
    WHEN ss.substitution_id IS NOT NULL THEN COALESCE(sar.flag_in_id, 1)
    WHEN l.leave_id IS NOT NULL THEN 1
    ELSE COALESCE(ar.flag_in_id, 1)
END';
$sql = "SELECT
    cs.schedule_id,
    cs.semester_id,
    r.room_id,
    r.room_name,
    b.building_name,
    f.floor_name,
    cs.start_time,
    cs.end_time,
    {$teacherExpr} AS original_teacher_id,
    {$subjectExpr} AS subject_id,
    {$sectionExpr} AS section_id,
    CONCAT_WS(' ', u.first_name, u.last_name) AS original_teacher_name,
    u.dept_id,
    d.dept_name,
    {$substitutionSelect}
    CONCAT_WS(' ', su.first_name, su.last_name) AS substitute_teacher_name,
    l.leave_id,
    lt.name_type AS leave_type,
    l.reason AS leave_reason,
    s.subject_code,
    s.subject_name,
    sec.section_name,
    ar.attendance_id,
    ar.flag_in_id,
    ar.flag_check_id,
    ar.flag_out_id,
    ar.checked_in_at,
    ar.checked_mid_at,
    ar.checked_out_at,
    sar.attendance_id AS substitute_attendance_id,
    sar.flag_in_id AS substitute_flag_in_id,
    sar.flag_check_id AS substitute_flag_check_id,
    sar.flag_out_id AS substitute_flag_out_id,
    sar.checked_in_at AS substitute_checked_in_at,
    sar.checked_mid_at AS substitute_checked_mid_at,
    sar.checked_out_at AS substitute_checked_out_at,
    CASE WHEN NOW() BETWEEN TIMESTAMP(CURDATE(), cs.start_time) AND TIMESTAMP(CURDATE(), cs.end_time) THEN 1 ELSE 0 END AS is_active,
    CASE
        WHEN {$effectiveFlagExpr} = 3
         AND NOW() > TIMESTAMP(CURDATE(), cs.end_time)
         AND NOW() <= DATE_ADD(TIMESTAMP(CURDATE(), cs.end_time), INTERVAL 5 MINUTE)
        THEN 1 ELSE 0
    END AS is_recently_ended,
    CASE
        WHEN {$effectiveFlagExpr} = 3
         AND NOW() > TIMESTAMP(CURDATE(), cs.end_time)
         AND NOW() <= DATE_ADD(TIMESTAMP(CURDATE(), cs.end_time), INTERVAL 5 MINUTE)
        THEN GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), DATE_ADD(TIMESTAMP(CURDATE(), cs.end_time), INTERVAL 5 MINUTE)))
        ELSE 0
    END AS grace_seconds_remaining,
    DATE_FORMAT(DATE_ADD(TIMESTAMP(CURDATE(), cs.end_time), INTERVAL 5 MINUTE), '%Y-%m-%dT%H:%i:%s') AS grace_expires_at,
    CASE
        WHEN NOW() BETWEEN TIMESTAMP(CURDATE(), cs.start_time) AND TIMESTAMP(CURDATE(), cs.end_time)
         AND ({$effectiveFlagExpr} IN (2, 3, 5) OR l.leave_id IS NOT NULL)
        THEN 3
        WHEN {$effectiveFlagExpr} = 3
         AND NOW() > TIMESTAMP(CURDATE(), cs.end_time)
         AND NOW() <= DATE_ADD(TIMESTAMP(CURDATE(), cs.end_time), INTERVAL 5 MINUTE)
        THEN 2
        WHEN NOW() BETWEEN TIMESTAMP(CURDATE(), cs.start_time) AND TIMESTAMP(CURDATE(), cs.end_time)
        THEN 1
        ELSE 0
    END AS room_priority
FROM tbl_class_schedules cs
JOIN tbl_rooms r ON r.room_id = cs.room_id
JOIN tbl_buildings b ON b.building_id = r.building_id
LEFT JOIN tbl_floors f ON f.floor_id = r.floor_id
LEFT JOIN tbl_school campus ON campus.school_id = b.school_id
{$joinOffering}
LEFT JOIN tbl_users u ON u.user_id = {$teacherExpr}
LEFT JOIN tbl_departments d ON d.dept_id = u.dept_id
LEFT JOIN tbl_subject s ON s.subject_id = {$subjectExpr}
LEFT JOIN tbl_sections sec ON sec.section_id = {$sectionExpr}
LEFT JOIN tbl_programs p ON p.program_id = s.program_id
LEFT JOIN tbl_departments subject_department ON subject_department.dept_id = p.dept_id
LEFT JOIN tbl_programs section_program ON section_program.program_id = sec.program_id
LEFT JOIN tbl_departments section_department ON section_department.dept_id = section_program.dept_id
LEFT JOIN tbl_semesters sem ON sem.semester_id = cs.semester_id
LEFT JOIN tbl_school_year sy ON sy.school_year_id = sem.school_year_id
LEFT JOIN tbl_attendance_records ar ON ar.schedule_id = cs.schedule_id
    AND ar.date = CURDATE() AND ar.user_id = {$teacherExpr}
{$joinSubstitution}
{$joinLeave}
{$joinLeaveType}
WHERE {$buildingWhere}
  AND LOWER(cs.day_of_week) = LOWER(DAYNAME(CURDATE()))
  AND LOWER(TRIM(COALESCE(r.status, ''))) IN ('active', '1', 'true')
  AND LOWER(TRIM(COALESCE(f.status, ''))) IN ('active', '1', 'true')
  AND LOWER(TRIM(COALESCE(b.status, ''))) IN ('active', '1', 'true')
  AND (b.school_id IS NULL OR LOWER(TRIM(COALESCE(campus.status, ''))) IN ('active', '1', 'true'))
  AND LOWER(TRIM(COALESCE(s.status, ''))) IN ('active', '1', 'true')
  AND LOWER(TRIM(COALESCE(sec.status, ''))) IN ('active', '1', 'true')
  AND LOWER(TRIM(COALESCE(p.status, ''))) IN ('active', '1', 'true')
  AND LOWER(TRIM(COALESCE(subject_department.status, ''))) IN ('active', '1', 'true')
  AND LOWER(TRIM(COALESCE(section_program.status, ''))) IN ('active', '1', 'true')
  AND LOWER(TRIM(COALESCE(section_department.status, ''))) IN ('active', '1', 'true')
  AND LOWER(TRIM(COALESCE(d.status, ''))) IN ('active', '1', 'true')
  AND u.role_id IN (2, 3, 4, 5)
  AND LOWER(TRIM(COALESCE(sem.status, ''))) IN ('active', '1', 'true')
  AND LOWER(TRIM(COALESCE(sy.status, ''))) IN ('active', '1', 'true')
  AND CURDATE() BETWEEN sem.start_date AND sem.end_date
  AND (
      (ss.substitution_id IS NOT NULL AND su.role_id IN (2, 3, 4, 5) AND LOWER(TRIM(COALESCE(su.status, ''))) IN ('active', '1', 'true'))
      OR (ss.substitution_id IS NULL AND LOWER(TRIM(COALESCE(u.status, ''))) IN ('active', '1', 'true'))
  )
  AND (
      NOW() BETWEEN TIMESTAMP(CURDATE(), cs.start_time) AND TIMESTAMP(CURDATE(), cs.end_time)
      OR (
          {$effectiveFlagExpr} = 3
          AND NOW() > TIMESTAMP(CURDATE(), cs.end_time)
          AND NOW() <= DATE_ADD(TIMESTAMP(CURDATE(), cs.end_time), INTERVAL 5 MINUTE)
      )
  )
  {$scopeSql}
ORDER BY r.room_id ASC, room_priority DESC, cs.start_time DESC";

$result = $mysqli->query($sql);
if (!$result) {
    error_log('3d-room-presence query failed: ' . $mysqli->error);
    json_response(['error' => 'presence_query_failed', 'message' => 'Unable to load live room presence.'], 500);
}

$byRoom = [];
while ($row = $result->fetch_assoc()) {
    $roomId = (int)$row['room_id'];
    if (isset($byRoom[$roomId])) continue;

    $hasSubstitute = !empty($row['substitution_id']) && !empty($row['substitute_user_id']);
    $hasLeave = !$hasSubstitute && !empty($row['leave_id']);
    $teacherId = $hasSubstitute ? (int)$row['substitute_user_id'] : (int)$row['original_teacher_id'];
    $teacherName = trim((string)($hasSubstitute ? $row['substitute_teacher_name'] : $row['original_teacher_name']));
    $flagIn = (int)($hasSubstitute ? ($row['substitute_flag_in_id'] ?? 1) : ($row['flag_in_id'] ?? 1));
    $attendanceStatus = tdb_presence_status($flagIn);
    $displayStatus = $hasSubstitute ? 'SUBSTITUTED' : ($hasLeave ? 'ON_LEAVE' : $attendanceStatus);

    $byRoom[$roomId] = [
        'room_id' => $roomId,
        'date' => date('Y-m-d'),
        'room_name' => (string)$row['room_name'],
        'building_name' => (string)$row['building_name'],
        'floor_name' => (string)($row['floor_name'] ?? ''),
        'schedule_id' => (int)$row['schedule_id'],
        'semester_id' => isset($row['semester_id']) ? (int)$row['semester_id'] : null,
        'subject_id' => isset($row['subject_id']) ? (int)$row['subject_id'] : null,
        'section_id' => isset($row['section_id']) ? (int)$row['section_id'] : null,
        'teacher_id' => $teacherId,
        'teacher_name' => $teacherName !== '' ? $teacherName : 'Teacher',
        'avatar_url' => tdb_presence_thumbnail_url($teacherId),
        'status' => $displayStatus,
        'attendance_status' => $attendanceStatus,
        'flag_in_id' => $flagIn,
        'flag_check_id' => isset($row[$hasSubstitute ? 'substitute_flag_check_id' : 'flag_check_id']) ? (int)$row[$hasSubstitute ? 'substitute_flag_check_id' : 'flag_check_id'] : null,
        'flag_out_id' => isset($row[$hasSubstitute ? 'substitute_flag_out_id' : 'flag_out_id']) ? (int)$row[$hasSubstitute ? 'substitute_flag_out_id' : 'flag_out_id'] : null,
        'time_in' => $row[$hasSubstitute ? 'substitute_checked_in_at' : 'checked_in_at'] ?: null,
        'time_check' => $row[$hasSubstitute ? 'substitute_checked_mid_at' : 'checked_mid_at'] ?: null,
        'time_out' => $row[$hasSubstitute ? 'substitute_checked_out_at' : 'checked_out_at'] ?: null,
        'subject' => trim((string)($row['subject_code'] ?? '') . ' ' . (string)($row['subject_name'] ?? '')),
        'section_name' => (string)($row['section_name'] ?? ''),
        'start_time' => (string)$row['start_time'],
        'end_time' => (string)$row['end_time'],
        'is_active' => (bool)$row['is_active'],
        'is_recently_ended' => (bool)$row['is_recently_ended'],
        'grace_seconds_remaining' => max(0, (int)$row['grace_seconds_remaining']),
        'grace_expires_at' => $row['grace_expires_at'] ?: null,
        'is_substitute' => $hasSubstitute,
        'original_teacher_id' => (int)$row['original_teacher_id'],
        'original_teacher_name' => trim((string)$row['original_teacher_name']),
        'department_id' => isset($row['dept_id']) ? (int)$row['dept_id'] : null,
        'department_name' => (string)($row['dept_name'] ?? ''),
        'leave_type' => $hasLeave ? (string)($row['leave_type'] ?? 'Approved Leave') : null,
        'leave_reason' => $hasLeave ? (string)($row['leave_reason'] ?? '') : null,
        '_parallel_key' => implode('|', [
            (string)$row['original_teacher_id'],
            (string)($row['semester_id'] ?? ''),
            (string)($row['subject_id'] ?? ''),
            substr((string)$row['start_time'], 0, 5),
            substr((string)$row['end_time'], 0, 5),
        ]),
    ];
}
$result->free();

$parallelGroups = [];
$parallelTeacherIds = array_values(array_unique(array_filter(array_map(function ($marker) {
    return (int)($marker['original_teacher_id'] ?? 0);
}, array_values($byRoom)))));
if (!empty($parallelTeacherIds)) {
    $parallelSql = "SELECT
        cs.schedule_id,
        {$teacherExpr} AS original_teacher_id,
        cs.semester_id,
        {$subjectExpr} AS subject_id,
        {$sectionExpr} AS section_id,
        r.room_id,
        cs.start_time,
        cs.end_time,
        r.room_name
      FROM tbl_class_schedules cs
      JOIN tbl_rooms r ON r.room_id = cs.room_id
      LEFT JOIN tbl_floors f ON f.floor_id = r.floor_id
      LEFT JOIN tbl_buildings b ON b.building_id = COALESCE(r.building_id, f.building_id)
      LEFT JOIN tbl_school campus ON campus.school_id = b.school_id
      {$joinOffering}
      LEFT JOIN tbl_users parallel_user ON parallel_user.user_id = {$teacherExpr}
      LEFT JOIN tbl_subject parallel_subject ON parallel_subject.subject_id = {$subjectExpr}
      LEFT JOIN tbl_programs parallel_subject_program ON parallel_subject_program.program_id = parallel_subject.program_id
      LEFT JOIN tbl_departments parallel_subject_department ON parallel_subject_department.dept_id = parallel_subject_program.dept_id
      LEFT JOIN tbl_sections parallel_section ON parallel_section.section_id = {$sectionExpr}
      LEFT JOIN tbl_programs parallel_section_program ON parallel_section_program.program_id = parallel_section.program_id
      LEFT JOIN tbl_departments parallel_section_department ON parallel_section_department.dept_id = parallel_section_program.dept_id
      JOIN tbl_semesters sem ON sem.semester_id = cs.semester_id
      JOIN tbl_school_year parallel_sy ON parallel_sy.school_year_id = sem.school_year_id
      WHERE {$teacherExpr} IN (" . implode(',', array_map('intval', $parallelTeacherIds)) . ")
        AND LOWER(cs.day_of_week) = LOWER(DAYNAME(CURDATE()))
        AND LOWER(TRIM(COALESCE(sem.status, ''))) IN ('active', '1', 'true')
        AND LOWER(TRIM(COALESCE(parallel_sy.status, ''))) IN ('active', '1', 'true')
        AND LOWER(TRIM(COALESCE(parallel_user.status, ''))) IN ('active', '1', 'true')
        AND LOWER(TRIM(COALESCE(parallel_subject.status, ''))) IN ('active', '1', 'true')
        AND LOWER(TRIM(COALESCE(parallel_subject_program.status, ''))) IN ('active', '1', 'true')
        AND LOWER(TRIM(COALESCE(parallel_subject_department.status, ''))) IN ('active', '1', 'true')
        AND LOWER(TRIM(COALESCE(parallel_section.status, ''))) IN ('active', '1', 'true')
        AND LOWER(TRIM(COALESCE(parallel_section_program.status, ''))) IN ('active', '1', 'true')
        AND LOWER(TRIM(COALESCE(parallel_section_department.status, ''))) IN ('active', '1', 'true')
        AND CURDATE() BETWEEN sem.start_date AND sem.end_date
        AND LOWER(TRIM(COALESCE(r.status, ''))) IN ('active', '1', 'true')
        AND LOWER(TRIM(COALESCE(f.status, ''))) IN ('active', '1', 'true')
        AND LOWER(TRIM(COALESCE(b.status, ''))) IN ('active', '1', 'true')
        AND (b.school_id IS NULL OR LOWER(TRIM(COALESCE(campus.status, ''))) IN ('active', '1', 'true'))";
    $parallelResult = $mysqli->query($parallelSql);
    if ($parallelResult) {
        while ($parallelRow = $parallelResult->fetch_assoc()) {
            $parallelKey = implode('|', [
                (string)$parallelRow['original_teacher_id'],
                (string)($parallelRow['semester_id'] ?? ''),
                (string)($parallelRow['subject_id'] ?? ''),
                substr((string)$parallelRow['start_time'], 0, 5),
                substr((string)$parallelRow['end_time'], 0, 5),
            ]);
            $parallelGroups[$parallelKey][] = [
                'schedule_id' => (int)$parallelRow['schedule_id'],
                'section_id' => isset($parallelRow['section_id']) ? (int)$parallelRow['section_id'] : null,
                'room_id' => (int)$parallelRow['room_id'],
                'room_name' => (string)$parallelRow['room_name'],
            ];
        }
        $parallelResult->free();
    }
}
foreach ($byRoom as $marker) {
    if (!isset($parallelGroups[$marker['_parallel_key']])) {
        $parallelGroups[$marker['_parallel_key']] = [];
    }
}
$markers = [];
foreach (array_values($byRoom) as $marker) {
    $parallelPeers = array_values(array_filter(
        $parallelGroups[$marker['_parallel_key']] ?? [],
        function ($candidate) use ($marker) {
            return (int)($candidate['schedule_id'] ?? 0) !== (int)$marker['schedule_id']
                && (int)($candidate['section_id'] ?? 0) !== (int)($marker['section_id'] ?? 0)
                && (int)($candidate['room_id'] ?? 0) !== (int)$marker['room_id'];
        }
    ));
    $parallelRooms = [(string)$marker['room_name']];
    foreach ($parallelPeers as $parallelPeer) {
        $parallelRooms[] = (string)($parallelPeer['room_name'] ?? '');
    }
    $parallelRooms = array_values(array_unique(array_filter($parallelRooms, function ($roomName) {
        return trim((string)$roomName) !== '';
    })));
    $marker['parallel_count'] = count($parallelRooms);
    $marker['parallel_rooms'] = $parallelRooms;
    $marker['is_parallel'] = count($parallelPeers) > 0;
    unset($marker['_parallel_key']);
    $markers[] = $marker;
}
$versionPayload = json_encode($markers, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
header('Cache-Control: no-store');
if ($tableView) {
    $normalizedSearch = function_exists('mb_strtolower') ? mb_strtolower($searchFilter) : strtolower($searchFilter);
    $scopedMarkers = array_values(array_filter($markers, function($marker) use ($buildingNameFilter, $floorFilter, $normalizedSearch) {
        if ($buildingNameFilter !== '' && strcasecmp(trim((string)($marker['building_name'] ?? '')), $buildingNameFilter) !== 0) return false;
        if ($floorFilter !== '' && strcasecmp(trim((string)($marker['floor_name'] ?? '')), $floorFilter) !== 0) return false;
        if ($normalizedSearch === '') return true;
        $haystack = implode(' ', [
            (string)($marker['teacher_name'] ?? ''),
            (string)($marker['teacher_id'] ?? ''),
            (string)($marker['subject'] ?? ''),
            (string)($marker['section_name'] ?? ''),
            (string)($marker['room_name'] ?? ''),
            (string)($marker['floor_name'] ?? ''),
            (string)($marker['building_name'] ?? ''),
            (string)($marker['department_name'] ?? ''),
        ]);
        $haystack = function_exists('mb_strtolower') ? mb_strtolower($haystack) : strtolower($haystack);
        return strpos($haystack, $normalizedSearch) !== false;
    }));
    usort($scopedMarkers, function($left, $right) {
        $leftOrder = !empty($left['is_active']) ? 0 : (!empty($left['is_recently_ended']) ? 4 : 2);
        $rightOrder = !empty($right['is_active']) ? 0 : (!empty($right['is_recently_ended']) ? 4 : 2);
        if ($leftOrder !== $rightOrder) return $leftOrder <=> $rightOrder;
        $timeOrder = strcmp((string)($left['start_time'] ?? ''), (string)($right['start_time'] ?? ''));
        if ($timeOrder !== 0) return $timeOrder;
        return strcmp((string)($left['teacher_name'] ?? ''), (string)($right['teacher_name'] ?? ''));
    });
    $statusCounts = [];
    foreach ($scopedMarkers as $marker) {
        $markerStatus = strtoupper(str_replace([' ', '-'], '_', trim((string)($marker['status'] ?? $marker['attendance_status'] ?? 'PENDING'))));
        $statusCounts[$markerStatus] = ($statusCounts[$markerStatus] ?? 0) + 1;
    }
    $filteredMarkers = $statusFilter === ''
        ? $scopedMarkers
        : array_values(array_filter($scopedMarkers, function($marker) use ($statusFilter) {
            $markerStatus = strtoupper(str_replace([' ', '-'], '_', trim((string)($marker['status'] ?? $marker['attendance_status'] ?? 'PENDING'))));
            return $markerStatus === $statusFilter;
        }));
    $totalRows = count($filteredMarkers);
    $totalPages = max(1, (int)ceil($totalRows / $tablePageSize));
    $tablePage = min($tablePage, $totalPages);
    $responseMarkers = $exportAll
        ? $filteredMarkers
        : array_slice($filteredMarkers, ($tablePage - 1) * $tablePageSize, $tablePageSize);
    json_response([
        'building_code' => $buildingCode,
        'generated_at' => date(DATE_ATOM),
        'version' => sha1(json_encode($responseMarkers, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?: '[]'),
        'markers' => $responseMarkers,
        'pagination' => [
            'page' => $exportAll ? 1 : $tablePage,
            'page_size' => $exportAll ? max(1, $totalRows) : $tablePageSize,
            'total' => $totalRows,
            'total_pages' => $exportAll ? 1 : $totalPages,
        ],
        'summary' => [
            'total_records' => count($scopedMarkers),
            'status_counts' => $statusCounts,
        ],
    ]);
}
json_response([
    'building_code' => $buildingCode,
    'generated_at' => date(DATE_ATOM),
    'version' => sha1($versionPayload ?: '[]'),
    'markers' => $markers,
]);
