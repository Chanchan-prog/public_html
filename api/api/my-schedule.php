<?php
// api/api/my-schedule.php
global $mysqli, $authPayload;
require_once __DIR__ . '/../helpers/socket_helper.php';
$request_method = $_SERVER['REQUEST_METHOD'];
$input = get_input();

$auth = is_array($authPayload) ? $authPayload : app_get_authenticated_session(true);
$authUserId = (int)($auth['user_id'] ?? 0);

if ($request_method !== 'GET') { json_response(['error' => 'method_not_allowed'], 405); }

function my_schedule_table_exists($mysqli, $table) {
    $table = preg_replace('/[^a-zA-Z0-9_]/', '', (string)$table);
    if ($table === '') return false;
    $safe = $mysqli->real_escape_string($table);
    $res = $mysqli->query("SHOW TABLES LIKE '{$safe}'");
    return $res && (int)$res->num_rows > 0;
}

function my_schedule_column_exists($mysqli, $table, $column) {
    $table = preg_replace('/[^a-zA-Z0-9_]/', '', (string)$table);
    $column = preg_replace('/[^a-zA-Z0-9_]/', '', (string)$column);
    if ($table === '' || $column === '') return false;
    $safeColumn = $mysqli->real_escape_string($column);
    $res = $mysqli->query("SHOW COLUMNS FROM `$table` LIKE '{$safeColumn}'");
    return $res && (int)$res->num_rows > 0;
}

// 2. FETCH SCHEDULES (Fixed SQL)
// Supports both schemas:
// - Legacy: tbl_class_schedules has user_id/subject_id/section_id directly.
// - Offering-based: tbl_subject_offerings provides those fields via offering_id.
$hasSubjectOfferings = my_schedule_table_exists($mysqli, 'tbl_subject_offerings');
$csHasOffering = my_schedule_column_exists($mysqli, 'tbl_class_schedules', 'offering_id');
$csHasUser = my_schedule_column_exists($mysqli, 'tbl_class_schedules', 'user_id');
$csHasSubject = my_schedule_column_exists($mysqli, 'tbl_class_schedules', 'subject_id');
$csHasSection = my_schedule_column_exists($mysqli, 'tbl_class_schedules', 'section_id');
$soHasUser = $hasSubjectOfferings ? my_schedule_column_exists($mysqli, 'tbl_subject_offerings', 'user_id') : false;
$soHasSubject = $hasSubjectOfferings ? my_schedule_column_exists($mysqli, 'tbl_subject_offerings', 'subject_id') : false;
$soHasSection = $hasSubjectOfferings ? my_schedule_column_exists($mysqli, 'tbl_subject_offerings', 'section_id') : false;

$joinOffering = ($hasSubjectOfferings && $csHasOffering) ? "LEFT JOIN tbl_subject_offerings so ON cs.offering_id = so.offering_id" : "";
$teacherExpr = $csHasUser ? 'cs.user_id' : (($hasSubjectOfferings && $csHasOffering && $soHasUser) ? 'so.user_id' : 'NULL');
$subjectExpr = $csHasSubject ? 'cs.subject_id' : (($hasSubjectOfferings && $csHasOffering && $soHasSubject) ? 'so.subject_id' : 'NULL');
$sectionExpr = $csHasSection ? 'cs.section_id' : (($hasSubjectOfferings && $csHasOffering && $soHasSection) ? 'so.section_id' : 'NULL');
$offeringExpr = $csHasOffering ? 'cs.offering_id' : 'NULL';

if ($teacherExpr === 'NULL') {
    json_response([]);
}

$sql = "SELECT 
            cs.schedule_id, 
            cs.room_id, 
            {$offeringExpr} AS offering_id, 
            cs.day_of_week, 
            cs.start_time, 
            cs.end_time,
            cs.semester_id,
            {$teacherExpr} AS offering_user_id,
            {$teacherExpr} AS teacher_id,
            s.subject_code, 
            s.subject_name, 
            sec.section_name,
            r.room_name, 
            r.building_id, 
            r.floor_id
        FROM tbl_class_schedules cs
        {$joinOffering}
        LEFT JOIN tbl_subject s ON {$subjectExpr} = s.subject_id
        LEFT JOIN tbl_sections sec ON {$sectionExpr} = sec.section_id
        LEFT JOIN tbl_programs sp ON s.program_id = sp.program_id
        LEFT JOIN tbl_departments sd ON sp.dept_id = sd.dept_id
        LEFT JOIN tbl_programs secp ON sec.program_id = secp.program_id
        LEFT JOIN tbl_departments secd ON secp.dept_id = secd.dept_id
        LEFT JOIN tbl_rooms r ON cs.room_id = r.room_id
        LEFT JOIN tbl_floors f ON r.floor_id = f.floor_id
        LEFT JOIN tbl_buildings b ON b.building_id = COALESCE(r.building_id, f.building_id)
        LEFT JOIN tbl_school campus ON campus.school_id = b.school_id
        JOIN tbl_semesters sem ON cs.semester_id = sem.semester_id
        JOIN tbl_school_year sy ON sy.school_year_id = sem.school_year_id
        WHERE {$teacherExpr} = ? AND cs.day_of_week IS NOT NULL
          AND LOWER(TRIM(sem.status)) = 'active'
          AND LOWER(TRIM(COALESCE(sy.status, ''))) IN ('active', '1', 'true')
          AND LOWER(TRIM(COALESCE(s.status, ''))) IN ('active', '1', 'true')
          AND LOWER(TRIM(COALESCE(sp.status, ''))) IN ('active', '1', 'true')
          AND LOWER(TRIM(COALESCE(sd.status, ''))) IN ('active', '1', 'true')
          AND LOWER(TRIM(COALESCE(sec.status, ''))) IN ('active', '1', 'true')
          AND LOWER(TRIM(COALESCE(secp.status, ''))) IN ('active', '1', 'true')
          AND LOWER(TRIM(COALESCE(secd.status, ''))) IN ('active', '1', 'true')
          AND LOWER(TRIM(COALESCE(r.status, ''))) IN ('active', '1', 'true')
          AND LOWER(TRIM(COALESCE(f.status, ''))) IN ('active', '1', 'true')
          AND LOWER(TRIM(COALESCE(b.status, ''))) IN ('active', '1', 'true')
          AND (b.school_id IS NULL OR LOWER(TRIM(COALESCE(campus.status, ''))) IN ('active', '1', 'true'))
          AND CURDATE() BETWEEN sem.start_date AND sem.end_date
        ORDER BY FIELD(LOWER(cs.day_of_week), 'monday','tuesday','wednesday','thursday','friday','saturday','sunday'), cs.start_time";

$stmt = $mysqli->prepare($sql);
if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);

// Bind only once
$stmt->bind_param('i', $authUserId);

if (!$stmt->execute()) json_response(['error' => 'execute_failed', 'message' => $stmt->error], 500);
$res = $stmt->get_result();
$rows = $res ? $res->fetch_all(MYSQLI_ASSOC) : [];

// Normalize data
foreach ($rows as &$r) {
    $r['day_of_week'] = isset($r['day_of_week']) ? strtolower($r['day_of_week']) : null;
    if (!empty($r['start_time']) && strlen($r['start_time']) === 5) $r['start_time'] = $r['start_time'] . ':00';
    if (!empty($r['end_time']) && strlen($r['end_time']) === 5) $r['end_time'] = $r['end_time'] . ':00';
}

json_response($rows);
?>
