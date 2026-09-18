<?php
// api/api/dashboard.php
require_once __DIR__ . '/../helpers/socket_helper.php';
require_once __DIR__ . '/../helpers/tardiness_penalty_helper.php';

if (!isset($GLOBALS['mysqli']) || $GLOBALS['mysqli'] === null) {
    if (file_exists(__DIR__ . '/../config/database.php')) {
        require_once __DIR__ . '/../config/database.php';
    }
}

if (!function_exists('json_response')) {
    require_once __DIR__ . '/../helpers/functions.php';
}

global $mysqli, $authPayload;

$request_method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
$parts = explode('/', (string)$path);
$api_prefix_key = array_search('api', $parts, true);
$param1 = ($api_prefix_key !== false) ? ($parts[$api_prefix_key + 2] ?? null) : null;

function dashboard_get_auth_context(): array {
    global $authPayload;
    $auth = is_array($authPayload) ? $authPayload : app_get_authenticated_session(true);
    return [
        'user_id' => isset($auth['user_id']) ? (int)$auth['user_id'] : null,
        'role_id' => isset($auth['role_id']) ? (int)$auth['role_id'] : null,
        'dept_id' => isset($auth['dept_id']) && $auth['dept_id'] !== null ? (int)$auth['dept_id'] : null,
        'assigned_program_head_id' => isset($auth['assigned_program_head_id']) && $auth['assigned_program_head_id'] !== null
            ? (int)$auth['assigned_program_head_id']
            : null,
    ];
}

function dashboard_table_exists($mysqli, $table) {
    $table = preg_replace('/[^a-zA-Z0-9_]/', '', (string)$table);
    if ($table === '') return false;
    $safe = $mysqli->real_escape_string($table);
    $res = $mysqli->query("SHOW TABLES LIKE '{$safe}'");
    return $res && (int)$res->num_rows > 0;
}

function dashboard_column_exists($mysqli, $table, $column) {
    $table = preg_replace('/[^a-zA-Z0-9_]/', '', (string)$table);
    $column = preg_replace('/[^a-zA-Z0-9_]/', '', (string)$column);
    if ($table === '' || $column === '') return false;
    $safeColumn = $mysqli->real_escape_string($column);
    $res = $mysqli->query("SHOW COLUMNS FROM `$table` LIKE '{$safeColumn}'");
    return $res && (int)$res->num_rows > 0;
}

function dashboard_db_fetch_one($mysqli, $sql) {
    $result = $mysqli->query($sql);
    if (!$result) {
        error_log('[dashboard] query failed: ' . $mysqli->error . ' SQL=' . $sql);
        return [];
    }
    $row = $result->fetch_assoc();
    return is_array($row) ? $row : [];
}

function dashboard_db_fetch_all($mysqli, $sql) {
    $result = $mysqli->query($sql);
    if (!$result) {
        error_log('[dashboard] query failed: ' . $mysqli->error . ' SQL=' . $sql);
        return [];
    }
    return $result->fetch_all(MYSQLI_ASSOC);
}

function dashboard_to_int($value) {
    return is_numeric($value) ? (int)$value : 0;
}

function dashboard_cast_int_fields(array $rows, array $fields): array {
    foreach ($rows as &$row) {
        foreach ($fields as $field) {
            if (array_key_exists($field, $row)) {
                $row[$field] = dashboard_to_int($row[$field]);
            }
        }
    }
    unset($row);
    return $rows;
}

function dashboard_overall_flag_id($flagIn, $flagMid, $flagOut) {
    $values = [(int)$flagIn, (int)$flagMid, (int)$flagOut];
    $counts = array_count_values($values);
    arsort($counts);
    $winner = array_key_first($counts);
    return ($winner !== null && (int)$counts[$winner] >= 2) ? (int)$winner : 0;
}

function dashboard_status_key_from_flag($flagId, $treatUpcomingFlagAsUpcoming = false) {
    $flagId = (int)$flagId;
    if ($flagId === 2) return 'present';
    if ($flagId === 3) return 'absent';
    if ($flagId === 4) return 'substituted';
    if ($flagId === 5) return 'late';
    if ($flagId === 7) return 'on_leave';
    if ($flagId === 8) return 'pending';
    if ($flagId === 1) return $treatUpcomingFlagAsUpcoming ? 'upcoming' : 'pending';
    return 'incomplete';
}

function dashboard_user_active_condition(string $alias = 'u'): string {
    $prefix = trim($alias) !== '' ? trim($alias) . '.' : '';
    // Supports enum('active', ...) and legacy numeric status fields.
    return "({$prefix}status = 'active' OR {$prefix}status = 1 OR {$prefix}status = '1')";
}

function dashboard_teacher_condition(bool $hasRolesTable, string $userAlias = 'u', string $roleAlias = 'ro'): string {
    return "{$userAlias}.role_id IN (2, 3, 4, 5)";
}

function dashboard_sql_int_list(array $values): string {
    $ints = [];
    foreach ($values as $v) {
        if ($v === null || $v === '') continue;
        $ints[] = (int)$v;
    }
    if (empty($ints)) return '0';
    return implode(',', array_values(array_unique($ints)));
}

function dashboard_apply_user_scope(string $template, string $alias): string {
    $alias = preg_replace('/[^a-zA-Z0-9_]/', '', $alias);
    if ($alias === '') $alias = 'u';
    $tpl = trim($template);
    if ($tpl === '') return '1=1';
    return str_replace('{u}', $alias, $tpl);
}

function dashboard_build_summary($mysqli, array $expr, $finalFlagExpr, string $scopeUserTemplate, bool $restrictAttendanceByUser, array $meta = []) {
    $summary_query = "SELECT
        {$expr['departments']} AS total_departments,
        {$expr['programs']} AS total_programs,
        {$expr['sections']} AS total_sections,
        {$expr['semesters']} AS total_semesters,
        {$expr['subjects']} AS total_subjects,
        {$expr['offerings']} AS total_offerings,
        {$expr['rooms']} AS total_rooms,
        {$expr['teachers']} AS total_teachers";
    $summary_counts = dashboard_db_fetch_one($mysqli, $summary_query);

    $attendanceJoin = '';
    $attendanceWhereScope = '';
    if ($restrictAttendanceByUser) {
        $attendanceJoin = " JOIN tbl_users us ON ar.user_id = us.user_id ";
        $attendanceWhereScope = " AND (" . dashboard_apply_user_scope($scopeUserTemplate, 'us') . ")";
    }

    $attendanceDate = date('Y-m-d');
    $attendanceIsFallback = false;

    $attendance_today_row = dashboard_db_fetch_one(
        $mysqli,
        "SELECT
            COUNT(*) AS total_records,
            SUM(ar.checked_in_at IS NOT NULL) AS checked_in,
            SUM(ar.checked_mid_at IS NOT NULL) AS checked_mid,
            SUM(ar.checked_out_at IS NOT NULL) AS checked_out,
            SUM(({$finalFlagExpr}) = 2) AS present,
            SUM(({$finalFlagExpr}) = 3) AS absent,
            SUM(({$finalFlagExpr}) = 5) AS late,
            SUM(({$finalFlagExpr}) = 4) AS substituted,
            SUM(({$finalFlagExpr}) = 7) AS on_leave,
            SUM(({$finalFlagExpr}) = 1) AS na
         FROM tbl_attendance_records ar
         {$attendanceJoin}
         WHERE ar.date = CURDATE()
         {$attendanceWhereScope}"
    );

    $todayTotalRecords = dashboard_to_int($attendance_today_row['total_records'] ?? 0);
    if ($todayTotalRecords === 0) {
        $latestDateRow = dashboard_db_fetch_one(
            $mysqli,
            "SELECT DATE_FORMAT(MAX(ar.date), '%Y-%m-%d') AS latest_date
             FROM tbl_attendance_records ar
             {$attendanceJoin}
             WHERE 1=1
             AND ar.date <= CURDATE()
             {$attendanceWhereScope}"
        );

        $latestDate = trim((string)($latestDateRow['latest_date'] ?? ''));
        if ($latestDate !== '' && preg_match('/^\d{4}-\d{2}-\d{2}$/', $latestDate)) {
            $safeLatestDate = $mysqli->real_escape_string($latestDate);
            $latestRow = dashboard_db_fetch_one(
                $mysqli,
                "SELECT
                    COUNT(*) AS total_records,
                    SUM(ar.checked_in_at IS NOT NULL) AS checked_in,
                    SUM(ar.checked_mid_at IS NOT NULL) AS checked_mid,
                    SUM(ar.checked_out_at IS NOT NULL) AS checked_out,
                    SUM(({$finalFlagExpr}) = 2) AS present,
                    SUM(({$finalFlagExpr}) = 3) AS absent,
                    SUM(({$finalFlagExpr}) = 5) AS late,
                    SUM(({$finalFlagExpr}) = 4) AS substituted,
                    SUM(({$finalFlagExpr}) = 7) AS on_leave,
                    SUM(({$finalFlagExpr}) = 1) AS na
                 FROM tbl_attendance_records ar
                 {$attendanceJoin}
                 WHERE ar.date = '{$safeLatestDate}'
                 {$attendanceWhereScope}"
            );
            if (!empty($latestRow)) {
                $attendance_today_row = $latestRow;
                $attendanceDate = $latestDate;
                $attendanceIsFallback = true;
            }
        }
    }

    $response = [
        'total_departments' => dashboard_to_int($summary_counts['total_departments'] ?? 0),
        'total_programs' => dashboard_to_int($summary_counts['total_programs'] ?? 0),
        'total_sections' => dashboard_to_int($summary_counts['total_sections'] ?? 0),
        'total_semesters' => dashboard_to_int($summary_counts['total_semesters'] ?? 0),
        'total_subjects' => dashboard_to_int($summary_counts['total_subjects'] ?? 0),
        'total_offerings' => dashboard_to_int($summary_counts['total_offerings'] ?? 0),
        'total_rooms' => dashboard_to_int($summary_counts['total_rooms'] ?? 0),
        'total_teachers' => dashboard_to_int($summary_counts['total_teachers'] ?? 0),
        'attendance_today' => [
            'date' => $attendanceDate,
            'is_fallback' => $attendanceIsFallback,
            'total_records' => dashboard_to_int($attendance_today_row['total_records'] ?? 0),
            'checked_in' => dashboard_to_int($attendance_today_row['checked_in'] ?? 0),
            'checked_mid' => dashboard_to_int($attendance_today_row['checked_mid'] ?? 0),
            'checked_out' => dashboard_to_int($attendance_today_row['checked_out'] ?? 0),
            'present' => dashboard_to_int($attendance_today_row['present'] ?? 0),
            'absent' => dashboard_to_int($attendance_today_row['absent'] ?? 0),
            'late' => dashboard_to_int($attendance_today_row['late'] ?? 0),
            'substituted' => dashboard_to_int($attendance_today_row['substituted'] ?? 0),
            'on_leave' => dashboard_to_int($attendance_today_row['on_leave'] ?? 0),
            'na' => dashboard_to_int($attendance_today_row['na'] ?? 0),
        ],
    ];

    if (!empty($meta)) {
        $response['meta'] = $meta;
    }

    return $response;
}

if ($request_method !== 'GET') {
    json_response(['error' => 'Invalid request method for dashboard.'], 405);
}

$dashboardScope = strtolower(trim((string)($_GET['scope'] ?? '')));
$isPersonalDashboardRoute = strtolower(trim((string)$param1)) === 'personal';
app_require_module_access(
    $mysqli,
    ($dashboardScope === 'self' || $isPersonalDashboardRoute) ? 'faculty_dashboard' : 'dashboard'
);

$hasRolesTable = dashboard_table_exists($mysqli, 'tbl_roles');
$hasSubjectOfferings = dashboard_table_exists($mysqli, 'tbl_subject_offerings');
$csHasOffering = dashboard_column_exists($mysqli, 'tbl_class_schedules', 'offering_id');
$csHasSubject = dashboard_column_exists($mysqli, 'tbl_class_schedules', 'subject_id');
$csHasSection = dashboard_column_exists($mysqli, 'tbl_class_schedules', 'section_id');
$soHasSubject = $hasSubjectOfferings ? dashboard_column_exists($mysqli, 'tbl_subject_offerings', 'subject_id') : false;

$joinOffering = ($hasSubjectOfferings && $csHasOffering)
    ? "LEFT JOIN tbl_subject_offerings so ON cs.offering_id = so.offering_id"
    : "";
$subjectExpr = $csHasSubject
    ? 'cs.subject_id'
    : (($hasSubjectOfferings && $csHasOffering && $soHasSubject) ? 'so.subject_id' : 'NULL');
$sectionJoin = $csHasSection ? "LEFT JOIN tbl_sections sec ON cs.section_id = sec.section_id" : "";
$sectionSelect = $csHasSection ? "sec.section_name" : "NULL AS section_name";

$offeringsCountExpr = $hasSubjectOfferings ? "(SELECT COUNT(*) FROM tbl_subject_offerings)" : "0";
$teacherJoin = $hasRolesTable ? "LEFT JOIN tbl_roles ro ON u.role_id = ro.role_id" : "";
$teacherCondition = dashboard_teacher_condition($hasRolesTable, 'u', 'ro');
$activeUserCondition = dashboard_user_active_condition('u');
$teacherCountExpr = "(SELECT COUNT(*) FROM tbl_users u {$teacherJoin} WHERE {$teacherCondition} AND {$activeUserCondition})";

// Prioritize out -> check -> in; ignore NA(1) whenever a non-NA flag exists.
$finalFlagExpr = "COALESCE(NULLIF(ar.flag_out_id, 1), NULLIF(ar.flag_check_id, 1), NULLIF(ar.flag_in_id, 1), 1)";

$auth = dashboard_get_auth_context();
$authUserId = isset($auth['user_id']) ? (int)$auth['user_id'] : null;
$authRole = isset($auth['role_id']) ? (int)$auth['role_id'] : null;
if (!$authUserId) {
    json_response(['error' => 'unauthorized', 'message' => 'Authentication required'], 401);
}

$authUser = dashboard_db_fetch_one(
    $mysqli,
    "SELECT u.user_id, u.role_id, u.dept_id, u.assigned_program_head_id, d.dept_name
     FROM tbl_users u
     LEFT JOIN tbl_departments d ON u.dept_id = d.dept_id
     WHERE u.user_id = " . (int)$authUserId . "
     LIMIT 1"
);
if (empty($authUser)) {
    json_response(['error' => 'unauthorized', 'message' => 'Authenticated user not found'], 401);
}
if (!$authRole) {
    $authRole = (int)($authUser['role_id'] ?? 0);
}

$authDeptId = isset($authUser['dept_id']) && $authUser['dept_id'] !== null ? (int)$authUser['dept_id'] : null;
$authDeptName = (string)($authUser['dept_name'] ?? '');
$authAssignedProgramId = isset($authUser['assigned_program_head_id']) && $authUser['assigned_program_head_id'] !== null
    ? (int)$authUser['assigned_program_head_id']
    : null;
$requestedScope = strtolower(trim((string)($_GET['scope'] ?? 'managed')));
$forceSelfScope = in_array($requestedScope, ['self', 'my', 'personal'], true) || $param1 === 'personal';

$programRowsForHead = [];
if ($authRole === 3) {
    $programRowsForHead = dashboard_db_fetch_all(
        $mysqli,
        "SELECT p.program_id, p.program_name, p.dept_id
         FROM tbl_programs p
         WHERE p.head_id = " . (int)$authUserId . "
           AND p.status = 'active'
         ORDER BY p.program_id ASC"
    );
}

$scopeProgramIds = [];
$scopeProgramNames = [];
$scopeProgramDeptId = null;
foreach ($programRowsForHead as $pr) {
    $pid = isset($pr['program_id']) ? (int)$pr['program_id'] : 0;
    if ($pid <= 0) continue;
    $scopeProgramIds[] = $pid;
    $scopeProgramNames[] = (string)($pr['program_name'] ?? ('Program ' . $pid));
    if ($scopeProgramDeptId === null && isset($pr['dept_id']) && $pr['dept_id'] !== null) {
        $scopeProgramDeptId = (int)$pr['dept_id'];
    }
}

if (empty($scopeProgramIds) && $authAssignedProgramId) {
    $fallbackProgram = dashboard_db_fetch_one(
        $mysqli,
        "SELECT p.program_id, p.program_name, p.dept_id
         FROM tbl_programs p
         WHERE p.program_id = " . (int)$authAssignedProgramId . "
         LIMIT 1"
    );
    if (!empty($fallbackProgram)) {
        $scopeProgramIds[] = (int)$fallbackProgram['program_id'];
        $scopeProgramNames[] = (string)($fallbackProgram['program_name'] ?? ('Program ' . (int)$fallbackProgram['program_id']));
        if ($scopeProgramDeptId === null && isset($fallbackProgram['dept_id']) && $fallbackProgram['dept_id'] !== null) {
            $scopeProgramDeptId = (int)$fallbackProgram['dept_id'];
        }
    }
}

$programIdsSql = dashboard_sql_int_list($scopeProgramIds);
$primaryProgramName = !empty($scopeProgramNames) ? $scopeProgramNames[0] : '';
$scopedDeptId = $authDeptId ?: $scopeProgramDeptId;
if ($scopedDeptId && $authDeptName === '') {
    $deptRow = dashboard_db_fetch_one($mysqli, "SELECT dept_name FROM tbl_departments WHERE dept_id = " . (int)$scopedDeptId . " LIMIT 1");
    $authDeptName = (string)($deptRow['dept_name'] ?? '');
}

$scopeUserTemplate = '1=1';
$restrictAttendanceByUser = false;
$summaryMeta = [
    'teacher_label' => 'Teaching Staff',
    'department_display' => null,
    'program_display' => null,
    'scope' => 'managed',
];

$departmentsCountExpr = "(SELECT COUNT(*) FROM tbl_departments)";
$programsCountExpr = "(SELECT COUNT(*) FROM tbl_programs)";
$sectionsCountExpr = "(SELECT COUNT(*) FROM tbl_sections)";
$semestersCountExpr = "(SELECT COUNT(*) FROM tbl_semesters)";
$subjectsCountExpr = "(SELECT COUNT(*) FROM tbl_subject)";
$roomsCountExpr = "(SELECT COUNT(*) FROM tbl_rooms)";

$departmentWhereSql = '';
$programWhereSql = '';
$sectionsWhereSql = '';
$subjectsWhereSql = '';
$teachersWhereSql = "{$teacherCondition} AND {$activeUserCondition}";
$offeringsWhereSql = '';

if ($authRole === 1) {
    $teacherCountExpr = "(SELECT COUNT(*) FROM tbl_users u WHERE {$activeUserCondition} AND u.role_id IN (2,3,4,5))";
    $summaryMeta['teacher_label'] = 'Teaching Staff';
    $scopeUserTemplate = '({u}.role_id IN (2,3,4,5))';
    $restrictAttendanceByUser = true;
} elseif ($forceSelfScope && in_array($authRole, [2, 3, 4, 5, 6], true)) {
    $summaryMeta['teacher_label'] = 'My Records';
    $summaryMeta['scope'] = 'self';
    $summaryMeta['department_display'] = $authDeptName !== '' ? $authDeptName : null;
    if ($primaryProgramName !== '') {
        $summaryMeta['program_display'] = $primaryProgramName;
    }
    $teacherCountExpr = "(SELECT COUNT(*) FROM tbl_users u WHERE {$activeUserCondition} AND u.user_id = " . (int)$authUserId . ")";
    $scopeUserTemplate = "({u}.user_id = " . (int)$authUserId . ")";
    $restrictAttendanceByUser = true;
    if ($scopedDeptId) {
        $departmentsCountExpr = "(SELECT COUNT(*) FROM tbl_departments d WHERE d.dept_id = " . (int)$scopedDeptId . ")";
        $departmentWhereSql = " WHERE d.dept_id = " . (int)$scopedDeptId . " ";
    } else {
        $departmentsCountExpr = "0";
    }
    if (!empty($scopeProgramIds)) {
        $programsCountExpr = "(SELECT COUNT(*) FROM tbl_programs p WHERE p.program_id IN ({$programIdsSql}))";
        $sectionsCountExpr = "(SELECT COUNT(*) FROM tbl_sections sec WHERE sec.program_id IN ({$programIdsSql}))";
        $subjectsCountExpr = "(SELECT COUNT(*) FROM tbl_subject s WHERE s.program_id IN ({$programIdsSql}))";
        $programWhereSql = " WHERE p.program_id IN ({$programIdsSql}) ";
        $sectionsWhereSql = " WHERE sec.program_id IN ({$programIdsSql}) ";
        $subjectsWhereSql = " WHERE s.program_id IN ({$programIdsSql}) ";
        $offeringsWhereSql = " WHERE p.program_id IN ({$programIdsSql}) ";
    } else {
        $programsCountExpr = "0";
        $sectionsCountExpr = "0";
        $subjectsCountExpr = "0";
    }
    $teachersWhereSql = "{$activeUserCondition} AND u.user_id = " . (int)$authUserId;
} elseif (in_array($authRole, [2, 6], true) && $scopedDeptId) {
    $summaryMeta['teacher_label'] = 'People';
    $summaryMeta['department_display'] = $authDeptName !== '' ? $authDeptName : ('Department #' . (int)$scopedDeptId);
    $departmentsCountExpr = "(SELECT COUNT(*) FROM tbl_departments d WHERE d.dept_id = " . (int)$scopedDeptId . ")";
    $programsCountExpr = "(SELECT COUNT(*) FROM tbl_programs p WHERE p.dept_id = " . (int)$scopedDeptId . ")";
    $sectionsCountExpr = "(SELECT COUNT(*) FROM tbl_sections sec JOIN tbl_programs p ON sec.program_id = p.program_id WHERE p.dept_id = " . (int)$scopedDeptId . ")";
    $subjectsCountExpr = "(SELECT COUNT(*) FROM tbl_subject s JOIN tbl_programs p ON s.program_id = p.program_id WHERE p.dept_id = " . (int)$scopedDeptId . ")";
    $teacherCountExpr = "(SELECT COUNT(*) FROM tbl_users u WHERE {$activeUserCondition} AND u.dept_id = " . (int)$scopedDeptId . " AND u.role_id IN (2,3,4,5))";
    $scopeUserTemplate = "({u}.dept_id = " . (int)$scopedDeptId . " AND {u}.role_id IN (2,3,4,5))";
    $restrictAttendanceByUser = true;
    $departmentWhereSql = " WHERE d.dept_id = " . (int)$scopedDeptId . " ";
    $programWhereSql = " WHERE p.dept_id = " . (int)$scopedDeptId . " ";
    $sectionsWhereSql = " WHERE p.dept_id = " . (int)$scopedDeptId . " ";
    $subjectsWhereSql = " WHERE p.dept_id = " . (int)$scopedDeptId . " ";
    $teachersWhereSql = "{$activeUserCondition} AND u.dept_id = " . (int)$scopedDeptId . " AND u.role_id IN (2,3,4,5)";
    $offeringsWhereSql = " WHERE p.dept_id = " . (int)$scopedDeptId . " ";
} elseif ($authRole === 4 && $scopedDeptId) {
    $summaryMeta['teacher_label'] = 'Teaching Staff';
    $summaryMeta['department_display'] = $authDeptName !== '' ? $authDeptName : ('Department #' . (int)$scopedDeptId);
    $departmentsCountExpr = "(SELECT COUNT(*) FROM tbl_departments d WHERE d.dept_id = " . (int)$scopedDeptId . ")";
    $programsCountExpr = "(SELECT COUNT(*) FROM tbl_programs p WHERE p.dept_id = " . (int)$scopedDeptId . ")";
    $sectionsCountExpr = "(SELECT COUNT(*) FROM tbl_sections sec JOIN tbl_programs p ON sec.program_id = p.program_id WHERE p.dept_id = " . (int)$scopedDeptId . ")";
    $subjectsCountExpr = "(SELECT COUNT(*) FROM tbl_subject s JOIN tbl_programs p ON s.program_id = p.program_id WHERE p.dept_id = " . (int)$scopedDeptId . ")";
    $teacherCountExpr = "(SELECT COUNT(*) FROM tbl_users u WHERE {$activeUserCondition} AND u.dept_id = " . (int)$scopedDeptId . " AND u.role_id IN (2,3,4,5))";
    $scopeUserTemplate = "({u}.dept_id = " . (int)$scopedDeptId . " AND {u}.role_id IN (2,3,4,5))";
    $restrictAttendanceByUser = true;
    $departmentWhereSql = " WHERE d.dept_id = " . (int)$scopedDeptId . " ";
    $programWhereSql = " WHERE p.dept_id = " . (int)$scopedDeptId . " ";
    $sectionsWhereSql = " WHERE p.dept_id = " . (int)$scopedDeptId . " ";
    $subjectsWhereSql = " WHERE p.dept_id = " . (int)$scopedDeptId . " ";
    $teachersWhereSql = "{$activeUserCondition} AND u.dept_id = " . (int)$scopedDeptId . " AND u.role_id IN (2,3,4,5)";
    $offeringsWhereSql = " WHERE p.dept_id = " . (int)$scopedDeptId . " ";
} elseif ($authRole === 3 && !empty($scopeProgramIds)) {
    $summaryMeta['teacher_label'] = 'People';
    $summaryMeta['department_display'] = $authDeptName !== '' ? $authDeptName : ($scopedDeptId ? ('Department #' . (int)$scopedDeptId) : null);
    $summaryMeta['program_display'] = implode(', ', $scopeProgramNames);
    $departmentsCountExpr = $scopedDeptId ? "(SELECT COUNT(*) FROM tbl_departments d WHERE d.dept_id = " . (int)$scopedDeptId . ")" : "0";
    $programsCountExpr = "(SELECT COUNT(*) FROM tbl_programs p WHERE p.program_id IN ({$programIdsSql}))";
    $sectionsCountExpr = "(SELECT COUNT(*) FROM tbl_sections sec WHERE sec.program_id IN ({$programIdsSql}))";
    $subjectsCountExpr = "(SELECT COUNT(*) FROM tbl_subject s WHERE s.program_id IN ({$programIdsSql}))";
    $programTeachingCondTpl = "(
        {u}.role_id IN (2,3,4,5)
        AND (
            {u}.user_id = " . (int)$authUserId . "
            OR {u}.assigned_program_head_id IN ({$programIdsSql})
            OR {u}.user_id IN (
                SELECT DISTINCT scoped_cs.user_id
                FROM tbl_class_schedules scoped_cs
                LEFT JOIN tbl_subject scoped_subject ON scoped_cs.subject_id = scoped_subject.subject_id
                LEFT JOIN tbl_sections scoped_section ON scoped_cs.section_id = scoped_section.section_id
                WHERE scoped_subject.program_id IN ({$programIdsSql})
                   OR scoped_section.program_id IN ({$programIdsSql})
            )
        )
    )";
    $scopeUserTemplate = $programTeachingCondTpl;
    $programPeopleCondSql = dashboard_apply_user_scope($scopeUserTemplate, 'u');
    $teacherCountExpr = "(SELECT COUNT(*) FROM tbl_users u WHERE {$activeUserCondition} AND {$programPeopleCondSql})";
    $restrictAttendanceByUser = true;
    $departmentWhereSql = $scopedDeptId ? " WHERE d.dept_id = " . (int)$scopedDeptId . " " : '';
    $programWhereSql = " WHERE p.program_id IN ({$programIdsSql}) ";
    $sectionsWhereSql = " WHERE sec.program_id IN ({$programIdsSql}) ";
    $subjectsWhereSql = " WHERE s.program_id IN ({$programIdsSql}) ";
    $teachersWhereSql = "{$activeUserCondition} AND {$programPeopleCondSql}";
    $offeringsWhereSql = " WHERE p.program_id IN ({$programIdsSql}) ";
} else {
    $summaryMeta['teacher_label'] = 'My Records';
    $summaryMeta['department_display'] = $authDeptName !== '' ? $authDeptName : null;
    if ($primaryProgramName !== '') {
        $summaryMeta['program_display'] = $primaryProgramName;
    }
    $teacherCountExpr = "(SELECT COUNT(*) FROM tbl_users u WHERE {$activeUserCondition} AND u.user_id = " . (int)$authUserId . ")";
    $scopeUserTemplate = "({u}.user_id = " . (int)$authUserId . ")";
    $restrictAttendanceByUser = true;
    if ($scopedDeptId) {
        $departmentsCountExpr = "(SELECT COUNT(*) FROM tbl_departments d WHERE d.dept_id = " . (int)$scopedDeptId . ")";
        $departmentWhereSql = " WHERE d.dept_id = " . (int)$scopedDeptId . " ";
    } else {
        $departmentsCountExpr = "0";
    }
    if (!empty($scopeProgramIds)) {
        $programsCountExpr = "(SELECT COUNT(*) FROM tbl_programs p WHERE p.program_id IN ({$programIdsSql}))";
        $sectionsCountExpr = "(SELECT COUNT(*) FROM tbl_sections sec WHERE sec.program_id IN ({$programIdsSql}))";
        $subjectsCountExpr = "(SELECT COUNT(*) FROM tbl_subject s WHERE s.program_id IN ({$programIdsSql}))";
        $programWhereSql = " WHERE p.program_id IN ({$programIdsSql}) ";
        $sectionsWhereSql = " WHERE sec.program_id IN ({$programIdsSql}) ";
        $subjectsWhereSql = " WHERE s.program_id IN ({$programIdsSql}) ";
        $offeringsWhereSql = " WHERE p.program_id IN ({$programIdsSql}) ";
    } else {
        $programsCountExpr = "0";
        $sectionsCountExpr = "0";
        $subjectsCountExpr = "0";
    }
    $teachersWhereSql = "{$activeUserCondition} AND u.user_id = " . (int)$authUserId;
}

if ($hasSubjectOfferings && trim($offeringsWhereSql) !== '') {
    $offeringsCountExpr = "(SELECT COUNT(*) FROM tbl_subject_offerings so LEFT JOIN tbl_subject s ON so.subject_id = s.subject_id LEFT JOIN tbl_programs p ON s.program_id = p.program_id {$offeringsWhereSql})";
} elseif (!$hasSubjectOfferings && trim($offeringsWhereSql) !== '') {
    $offeringsCountExpr = "(SELECT COUNT(DISTINCT cs.schedule_id) FROM tbl_class_schedules cs LEFT JOIN tbl_subject s ON cs.subject_id = s.subject_id LEFT JOIN tbl_programs p ON s.program_id = p.program_id {$offeringsWhereSql})";
}

$summaryExpr = [
    'departments' => $departmentsCountExpr,
    'programs' => $programsCountExpr,
    'sections' => $sectionsCountExpr,
    'semesters' => $semestersCountExpr,
    'subjects' => $subjectsCountExpr,
    'offerings' => $offeringsCountExpr,
    'rooms' => $roomsCountExpr,
    'teachers' => $teacherCountExpr,
];

// Optional operations filters are validated against the caller's existing
// scope before they are added. They can only narrow access, never expand it.
$dashboardFilterOptions = ['departments' => [], 'programs' => []];
$dashboardSelectedDeptId = 0;
$dashboardSelectedProgramId = 0;
$dashboardScheduleFilter = '1=1';
$dashboardAttendanceClassFilter = '1=1';
if ($param1 === 'operations') {
    if ($authRole === 1) {
        $dashboardFilterOptions['departments'] = dashboard_db_fetch_all($mysqli, "SELECT dept_id, dept_name FROM tbl_departments WHERE status = 'active' ORDER BY dept_name");
        $dashboardFilterOptions['programs'] = dashboard_db_fetch_all($mysqli, "SELECT program_id, program_name, dept_id FROM tbl_programs WHERE status = 'active' ORDER BY program_name");
    } elseif ($scopedDeptId && in_array((int)$authRole, [2, 4, 6], true)) {
        $dashboardFilterOptions['departments'] = dashboard_db_fetch_all($mysqli, "SELECT dept_id, dept_name FROM tbl_departments WHERE dept_id = " . (int)$scopedDeptId . " AND status = 'active'");
        $dashboardFilterOptions['programs'] = dashboard_db_fetch_all($mysqli, "SELECT program_id, program_name, dept_id FROM tbl_programs WHERE dept_id = " . (int)$scopedDeptId . " AND status = 'active' ORDER BY program_name");
    } elseif ($authRole === 3) {
        $dashboardFilterOptions['departments'] = $scopedDeptId ? dashboard_db_fetch_all($mysqli, "SELECT dept_id, dept_name FROM tbl_departments WHERE dept_id = " . (int)$scopedDeptId . " AND status = 'active'") : [];
        $dashboardFilterOptions['programs'] = $programRowsForHead;
    }

    $allowedDeptIds = array_map(fn($row) => (int)($row['dept_id'] ?? 0), $dashboardFilterOptions['departments']);
    $allowedProgramIds = array_map(fn($row) => (int)($row['program_id'] ?? 0), $dashboardFilterOptions['programs']);
    $requestedDeptId = isset($_GET['dept_id']) ? (int)$_GET['dept_id'] : 0;
    $requestedProgramId = isset($_GET['program_id']) ? (int)$_GET['program_id'] : 0;
    if ($requestedDeptId > 0 && in_array($requestedDeptId, $allowedDeptIds, true)) {
        $dashboardSelectedDeptId = $requestedDeptId;
        $scopeUserTemplate = "({$scopeUserTemplate} AND {u}.dept_id = {$dashboardSelectedDeptId})";
        $dashboardScheduleFilter .= " AND schedule_user.dept_id = {$dashboardSelectedDeptId}";
    }
    if ($requestedProgramId > 0 && in_array($requestedProgramId, $allowedProgramIds, true)) {
        $selectedProgramRow = null;
        foreach ($dashboardFilterOptions['programs'] as $programOption) {
            if ((int)($programOption['program_id'] ?? 0) === $requestedProgramId) { $selectedProgramRow = $programOption; break; }
        }
        $programDeptId = (int)($selectedProgramRow['dept_id'] ?? 0);
        if ($dashboardSelectedDeptId === 0 || $programDeptId === 0 || $programDeptId === $dashboardSelectedDeptId) {
            $dashboardSelectedProgramId = $requestedProgramId;
            $programUserScope = "(
                {u}.user_id = (SELECT p.head_id FROM tbl_programs p WHERE p.program_id = {$dashboardSelectedProgramId} LIMIT 1)
                OR {u}.assigned_program_head_id = {$dashboardSelectedProgramId}
                OR {u}.user_id IN (
                    SELECT DISTINCT filtered_cs.user_id FROM tbl_class_schedules filtered_cs
                    LEFT JOIN tbl_subject filtered_subject ON filtered_subject.subject_id = filtered_cs.subject_id
                    LEFT JOIN tbl_sections filtered_section ON filtered_section.section_id = filtered_cs.section_id
                    WHERE filtered_subject.program_id = {$dashboardSelectedProgramId} OR filtered_section.program_id = {$dashboardSelectedProgramId}
                )
            )";
            $scopeUserTemplate = "({$scopeUserTemplate} AND {$programUserScope})";
            $dashboardScheduleFilter .= " AND (s.program_id = {$dashboardSelectedProgramId} OR sec.program_id = {$dashboardSelectedProgramId})";
            $dashboardAttendanceClassFilter .= " AND (s.program_id = {$dashboardSelectedProgramId} OR sec.program_id = {$dashboardSelectedProgramId})";
        }
    }
}

// Lightweight v2 dashboards. The legacy summary/full responses below remain
// available for older callers while the two dashboard pages use these shapes.
if (in_array($param1, ['operations', 'personal'], true)) {
    $isPersonalDashboard = $param1 === 'personal';
    if ($isPersonalDashboard && !in_array((int)$authRole, [2, 3, 4, 5], true)) {
        json_response(['error' => 'forbidden', 'message' => 'A personal teaching dashboard is not available for this role.'], 403);
    }
    if (!$isPersonalDashboard && !in_array((int)$authRole, [1, 2, 3, 4, 6], true)) {
        json_response(['error' => 'forbidden', 'message' => 'A managed dashboard is not available for this role.'], 403);
    }

    $activeSemester = dashboard_db_fetch_one($mysqli, "SELECT sem.semester_id, sem.term,
            DATE_FORMAT(sem.start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(sem.end_date, '%Y-%m-%d') AS end_date,
            COALESCE(sy.session_name, '') AS school_year
        FROM tbl_semesters sem
        LEFT JOIN tbl_school_year sy ON sy.school_year_id = sem.school_year_id
        WHERE LOWER(TRIM(sem.status)) = 'active'
          AND LOWER(TRIM(COALESCE(sy.status, ''))) IN ('active', '1', 'true')
          AND CURDATE() BETWEEN sem.start_date AND sem.end_date
        ORDER BY sem.start_date DESC, sem.semester_id DESC LIMIT 1");
    $semesterId = (int)($activeSemester['semester_id'] ?? 0);
    $scopeConditionUser = dashboard_apply_user_scope($scopeUserTemplate, 'scope_user');
    $scopeConditionScheduleUser = dashboard_apply_user_scope($scopeUserTemplate, 'schedule_user');
    $scopeConditionAttendanceUser = dashboard_apply_user_scope($scopeUserTemplate, 'attendance_user');
    $filteredTeachingStaff = dashboard_db_fetch_one($mysqli, "SELECT COUNT(*) AS cnt FROM tbl_users scope_user
        WHERE scope_user.role_id IN (2,3,4,5) AND " . dashboard_user_active_condition('scope_user') . "
          AND ({$scopeConditionUser})");
    $semesterScheduleFilter = $semesterId > 0 ? "cs.semester_id = {$semesterId}" : '1=0';
    $semesterAttendanceFilter = $semesterId > 0 ? "cs.semester_id = {$semesterId}" : '1=0';

    $scheduleRows = dashboard_db_fetch_all($mysqli, "SELECT
            cs.schedule_id, cs.user_id, cs.day_of_week, cs.start_time, cs.end_time,
            CONCAT_WS(' ', schedule_user.first_name, schedule_user.last_name) AS staff_name,
            schedule_user.role_id, schedule_user.status AS user_status,
            COALESCE(s.subject_code, '') AS subject_code, s.status AS subject_status,
            COALESCE(s.subject_name, '') AS subject_name,
            COALESCE(sec.section_name, '') AS section_name, sec.status AS section_status,
            subject_program.status AS subject_program_status,
            subject_department.status AS subject_department_status,
            section_program.status AS section_program_status,
            section_department.status AS section_department_status,
            COALESCE(r.room_name, '') AS room_name, r.status AS room_status,
            floor.status AS floor_status, building.status AS building_status,
            campus.status AS campus_status,
            ar.attendance_id, ar.checked_in_at, ar.checked_mid_at, ar.checked_out_at,
            COALESCE(ar.flag_in_id, 1) AS flag_in_id,
            COALESCE(ar.flag_check_id, 1) AS flag_check_id,
            COALESCE(ar.flag_out_id, 1) AS flag_out_id
        FROM tbl_class_schedules cs
        JOIN tbl_users schedule_user ON schedule_user.user_id = cs.user_id
        LEFT JOIN tbl_subject s ON s.subject_id = cs.subject_id
        LEFT JOIN tbl_sections sec ON sec.section_id = cs.section_id
        LEFT JOIN tbl_programs subject_program ON subject_program.program_id = s.program_id
        LEFT JOIN tbl_departments subject_department ON subject_department.dept_id = subject_program.dept_id
        LEFT JOIN tbl_programs section_program ON section_program.program_id = sec.program_id
        LEFT JOIN tbl_departments section_department ON section_department.dept_id = section_program.dept_id
        LEFT JOIN tbl_rooms r ON r.room_id = cs.room_id
        LEFT JOIN tbl_floors floor ON floor.floor_id = r.floor_id
        LEFT JOIN tbl_buildings building ON building.building_id = COALESCE(r.building_id, floor.building_id)
        LEFT JOIN tbl_school campus ON campus.school_id = building.school_id
        LEFT JOIN tbl_attendance_records ar ON ar.schedule_id = cs.schedule_id
            AND ar.user_id = cs.user_id AND ar.date = CURDATE()
        WHERE {$semesterScheduleFilter}
          AND LOWER(cs.day_of_week) = LOWER(DAYNAME(CURDATE()))
          AND ({$scopeConditionScheduleUser})
          AND {$dashboardScheduleFilter}
        ORDER BY cs.start_time, cs.end_time, s.subject_code, sec.section_name");

    $nowTs = time();
    $statusCounts = [
        'present' => 0, 'late' => 0, 'absent' => 0, 'incomplete' => 0,
        'pending' => 0, 'upcoming' => 0, 'substituted' => 0, 'on_leave' => 0,
    ];
    $timeline = [];
    $missingCheckpoints = [];
    $completedDue = 0;
    $totalDue = 0;
    $checkpointBreakdown = [
        'check_in' => ['due' => 0, 'completed' => 0, 'missing' => 0],
        'mid_check' => ['due' => 0, 'completed' => 0, 'missing' => 0],
        'check_out' => ['due' => 0, 'completed' => 0, 'missing' => 0],
    ];
    $activeClasses = 0;
    $activeRooms = [];
    $suspendedSchedules = [];
    $dashboardStatusIsActive = static function ($value) {
        return in_array(strtolower(trim((string)$value)), ['active', '1', 'true'], true);
    };

    foreach ($scheduleRows as $scheduleRow) {
        $suspensionReasons = [];
        $dependencyStatuses = [
            'Teacher' => $scheduleRow['user_status'] ?? null,
            'Subject' => $scheduleRow['subject_status'] ?? null,
            'Section' => $scheduleRow['section_status'] ?? null,
            'Subject program' => $scheduleRow['subject_program_status'] ?? null,
            'Subject department' => $scheduleRow['subject_department_status'] ?? null,
            'Section program' => $scheduleRow['section_program_status'] ?? null,
            'Section department' => $scheduleRow['section_department_status'] ?? null,
        ];
        if (trim((string)$scheduleRow['room_name']) !== '') {
            $dependencyStatuses['Room'] = $scheduleRow['room_status'] ?? null;
            $dependencyStatuses['Floor'] = $scheduleRow['floor_status'] ?? null;
            $dependencyStatuses['Building'] = $scheduleRow['building_status'] ?? null;
            if (!empty($scheduleRow['campus_status'])) $dependencyStatuses['Campus'] = $scheduleRow['campus_status'];
        }
        foreach ($dependencyStatuses as $label => $dependencyStatus) {
            if (!$dashboardStatusIsActive($dependencyStatus)) $suspensionReasons[] = $label . ' is inactive or archived';
        }
        if ($suspensionReasons) {
            $suspendedSchedules[] = [
                'schedule_id' => (int)$scheduleRow['schedule_id'],
                'staff_name' => trim((string)$scheduleRow['staff_name']),
                'subject_code' => (string)$scheduleRow['subject_code'],
                'subject_name' => (string)$scheduleRow['subject_name'],
                'section_name' => (string)$scheduleRow['section_name'],
                'room_name' => (string)$scheduleRow['room_name'],
                'start_time' => (string)$scheduleRow['start_time'],
                'end_time' => (string)$scheduleRow['end_time'],
                'reasons' => $suspensionReasons,
            ];
            continue;
        }
        $startTs = strtotime(date('Y-m-d') . ' ' . (string)$scheduleRow['start_time']);
        $endTs = strtotime(date('Y-m-d') . ' ' . (string)$scheduleRow['end_time']);
        $midTs = ($startTs && $endTs) ? (int)floor(($startTs + $endTs) / 2) : 0;
        $isUpcoming = $startTs ? $nowTs < $startTs : false;
        $isActive = $startTs && $endTs && $nowTs >= $startTs && $nowTs <= $endTs;
        if ($isActive) {
            $activeClasses++;
            if (!empty($scheduleRow['room_name'])) $activeRooms[(string)$scheduleRow['room_name']] = true;
        }

        $flagIn = (int)$scheduleRow['flag_in_id'];
        $flagMid = (int)$scheduleRow['flag_check_id'];
        $flagOut = (int)$scheduleRow['flag_out_id'];
        $overallFlag = dashboard_overall_flag_id($flagIn, $flagMid, $flagOut);
        $hasAttendanceRecord = !empty($scheduleRow['attendance_id']);
        // An existing attendance record is authoritative: flag 1 remains Upcoming.
        // Only schedules without a record use the clock to distinguish Upcoming from Pending.
        $overallStatus = dashboard_status_key_from_flag($overallFlag, $isUpcoming || $hasAttendanceRecord);
        if (isset($statusCounts[$overallStatus])) $statusCounts[$overallStatus]++;

        $stageDefinitions = [
            ['key' => 'check_in', 'label' => 'Check-in', 'due_at' => $startTs, 'value' => $scheduleRow['checked_in_at'], 'flag' => $flagIn],
            ['key' => 'mid_check', 'label' => 'Middle check', 'due_at' => $midTs ? $midTs - 600 : 0, 'value' => $scheduleRow['checked_mid_at'], 'flag' => $flagMid],
            ['key' => 'check_out', 'label' => 'Check-out', 'due_at' => $endTs ? $endTs - 900 : 0, 'value' => $scheduleRow['checked_out_at'], 'flag' => $flagOut],
        ];
        $nextCheckpoint = null;
        foreach ($stageDefinitions as $stage) {
            $excludedStage = in_array((int)$stage['flag'], [4, 7], true);
            $hasValue = trim((string)($stage['value'] ?? '')) !== '';
            $isDue = !$excludedStage && (int)$stage['due_at'] > 0 && $nowTs >= (int)$stage['due_at'];
            if ($isDue) {
                $totalDue++;
                $checkpointBreakdown[$stage['key']]['due']++;
                if ($hasValue) {
                    $completedDue++;
                    $checkpointBreakdown[$stage['key']]['completed']++;
                } else {
                    $checkpointBreakdown[$stage['key']]['missing']++;
                    $missingCheckpoints[] = [
                        'type' => 'missing_checkpoint', 'severity' => 'high',
                        'title' => $stage['label'] . ' missing',
                        'detail' => trim((string)$scheduleRow['staff_name']) . ' · ' . ((string)$scheduleRow['subject_code'] ?: (string)$scheduleRow['subject_name']),
                        'schedule_id' => (int)$scheduleRow['schedule_id'],
                        'staff_name' => trim((string)$scheduleRow['staff_name']),
                        'subject_code' => (string)$scheduleRow['subject_code'],
                        'subject_name' => (string)$scheduleRow['subject_name'],
                        'section_name' => (string)$scheduleRow['section_name'],
                        'room_name' => (string)$scheduleRow['room_name'],
                        'checkpoint' => (string)$stage['key'],
                        'checkpoint_label' => (string)$stage['label'],
                        'due_at' => (int)$stage['due_at'] > 0 ? date('c', (int)$stage['due_at']) : null,
                        'start_time' => (string)$scheduleRow['start_time'],
                        'end_time' => (string)$scheduleRow['end_time'],
                    ];
                }
            }
            if ($nextCheckpoint === null && !$excludedStage && !$hasValue) {
                $nextCheckpoint = [
                    'stage' => $stage['key'], 'label' => $stage['label'],
                    'opens_at' => (int)$stage['due_at'] > 0 ? date('c', (int)$stage['due_at']) : null,
                    'is_due' => $isDue,
                ];
            }
        }

        $timeline[] = [
            'schedule_id' => (int)$scheduleRow['schedule_id'],
            'attendance_id' => isset($scheduleRow['attendance_id']) ? (int)$scheduleRow['attendance_id'] : null,
            'staff_name' => trim((string)$scheduleRow['staff_name']),
            'role_id' => (int)$scheduleRow['role_id'],
            'subject_code' => (string)$scheduleRow['subject_code'],
            'subject_name' => (string)$scheduleRow['subject_name'],
            'section_name' => (string)$scheduleRow['section_name'],
            'room_name' => (string)$scheduleRow['room_name'],
            'start_time' => (string)$scheduleRow['start_time'],
            'end_time' => (string)$scheduleRow['end_time'],
            'is_active' => (bool)$isActive,
            'overall_status' => $overallStatus,
            'check_in' => ['flag_id' => $flagIn, 'recorded_at' => $scheduleRow['checked_in_at']],
            'mid_check' => ['flag_id' => $flagMid, 'recorded_at' => $scheduleRow['checked_mid_at']],
            'check_out' => ['flag_id' => $flagOut, 'recorded_at' => $scheduleRow['checked_out_at']],
            'next_checkpoint' => $nextCheckpoint,
        ];
    }

    $operationalAlerts = [];
    $coverageSummary = ['scheduled' => count($scheduleRows), 'operational' => count($timeline), 'suspended' => count($suspendedSchedules), 'staffed' => count($timeline), 'missing_room' => 0, 'room_conflicts' => 0, 'substituted' => 0, 'on_leave' => 0];
    foreach ($timeline as $classItem) {
        if (trim((string)$classItem['room_name']) === '') {
            $coverageSummary['missing_room']++;
            $operationalAlerts[] = [
                'type' => 'missing_room', 'severity' => 'medium', 'title' => 'Room not assigned',
                'detail' => trim($classItem['staff_name'] . ' · ' . ($classItem['subject_code'] ?: $classItem['subject_name'])),
                'schedule_id' => $classItem['schedule_id'],
            ];
        }
        if ($classItem['overall_status'] === 'substituted') $coverageSummary['substituted']++;
        if ($classItem['overall_status'] === 'on_leave') $coverageSummary['on_leave']++;
    }
    $seenRoomConflicts = [];
    $timelineCount = count($timeline);
    for ($left = 0; $left < $timelineCount; $left++) {
        for ($right = $left + 1; $right < $timelineCount; $right++) {
            $first = $timeline[$left];
            $second = $timeline[$right];
            if ($first['room_name'] === '' || strcasecmp($first['room_name'], $second['room_name']) !== 0) continue;
            if (!((string)$first['start_time'] < (string)$second['end_time'] && (string)$second['start_time'] < (string)$first['end_time'])) continue;
            $conflictKey = $first['room_name'] . ':' . min($first['schedule_id'], $second['schedule_id']) . ':' . max($first['schedule_id'], $second['schedule_id']);
            if (isset($seenRoomConflicts[$conflictKey])) continue;
            $seenRoomConflicts[$conflictKey] = true;
            $coverageSummary['room_conflicts']++;
            $operationalAlerts[] = [
                'type' => 'room_conflict', 'severity' => 'high', 'title' => 'Room schedule conflict',
                'detail' => $first['room_name'] . ' · ' . ($first['subject_code'] ?: $first['subject_name']) . ' and ' . ($second['subject_code'] ?: $second['subject_name']),
                'schedule_id' => $first['schedule_id'],
                'schedule_ids' => [$first['schedule_id'], $second['schedule_id']],
            ];
        }
    }

    // Count unique affected classes so one schedule is not counted again for
    // every checkpoint or every health reason attached to it.
    $healthIssueScheduleIds = [];
    foreach ($suspendedSchedules as $item) {
        $scheduleId = (int)($item['schedule_id'] ?? 0);
        if ($scheduleId > 0) $healthIssueScheduleIds[$scheduleId] = true;
    }
    foreach ($operationalAlerts as $item) {
        $scheduleIds = isset($item['schedule_ids']) && is_array($item['schedule_ids'])
            ? $item['schedule_ids']
            : [$item['schedule_id'] ?? 0];
        foreach ($scheduleIds as $scheduleId) {
            $scheduleId = (int)$scheduleId;
            if ($scheduleId > 0) $healthIssueScheduleIds[$scheduleId] = true;
        }
    }
    $attendanceIssueScheduleIds = [];
    foreach ($missingCheckpoints as $item) {
        $scheduleId = (int)($item['schedule_id'] ?? 0);
        if ($scheduleId > 0) $attendanceIssueScheduleIds[$scheduleId] = true;
    }
    $affectedScheduleIds = $healthIssueScheduleIds + $attendanceIssueScheduleIds;
    $coverageSummary['ready'] = max(0, count($scheduleRows) - count($healthIssueScheduleIds));
    $coverageSummary['blocked'] = count($healthIssueScheduleIds);

    // Present one row per blocked schedule and collect every reason on that row.
    // This keeps a room conflict from appearing as a vague single alert while
    // still counting each affected schedule only once.
    $blockedScheduleDetails = [];
    foreach ($suspendedSchedules as $item) {
        $scheduleId = (int)($item['schedule_id'] ?? 0);
        if ($scheduleId <= 0) continue;
        $blockedScheduleDetails[$scheduleId] = $item;
        $blockedScheduleDetails[$scheduleId]['reasons'] = array_values(array_unique(array_filter($item['reasons'] ?? [])));
    }
    $timelineByScheduleId = [];
    foreach ($timeline as $item) {
        $scheduleId = (int)($item['schedule_id'] ?? 0);
        if ($scheduleId > 0) $timelineByScheduleId[$scheduleId] = $item;
    }
    foreach ($operationalAlerts as $alert) {
        $scheduleIds = isset($alert['schedule_ids']) && is_array($alert['schedule_ids'])
            ? $alert['schedule_ids']
            : [$alert['schedule_id'] ?? 0];
        foreach ($scheduleIds as $scheduleId) {
            $scheduleId = (int)$scheduleId;
            if ($scheduleId <= 0) continue;
            if (!isset($blockedScheduleDetails[$scheduleId])) {
                $classItem = $timelineByScheduleId[$scheduleId] ?? [];
                $blockedScheduleDetails[$scheduleId] = [
                    'schedule_id' => $scheduleId,
                    'staff_name' => (string)($classItem['staff_name'] ?? ''),
                    'subject_code' => (string)($classItem['subject_code'] ?? ''),
                    'subject_name' => (string)($classItem['subject_name'] ?? ''),
                    'section_name' => (string)($classItem['section_name'] ?? ''),
                    'room_name' => (string)($classItem['room_name'] ?? ''),
                    'start_time' => (string)($classItem['start_time'] ?? ''),
                    'end_time' => (string)($classItem['end_time'] ?? ''),
                    'reasons' => [],
                ];
            }
            $reason = trim((string)($alert['title'] ?? 'Schedule issue'));
            $detail = trim((string)($alert['detail'] ?? ''));
            if ($detail !== '') $reason .= ': ' . $detail;
            if (!in_array($reason, $blockedScheduleDetails[$scheduleId]['reasons'], true)) {
                $blockedScheduleDetails[$scheduleId]['reasons'][] = $reason;
            }
        }
    }
    $blockedScheduleDetails = array_values($blockedScheduleDetails);

    $summaryV2 = dashboard_build_summary($mysqli, $summaryExpr, $finalFlagExpr, $scopeUserTemplate, $restrictAttendanceByUser, $summaryMeta);
    $completionRate = $totalDue > 0 ? round(($completedDue / $totalDue) * 100, 1) : 0;

    $actions = [];
    if (!$isPersonalDashboard && $authRole === 2) {
        $row = dashboard_db_fetch_one($mysqli, "SELECT COUNT(*) AS cnt
            FROM tbl_attendance_edit_requests aer
            JOIN tbl_attendance_records ar ON ar.attendance_id = aer.attendance_id
            JOIN tbl_users scope_user ON scope_user.user_id = ar.user_id
            WHERE aer.status = 'pending' AND ({$scopeConditionUser})");
        $actions[] = ['key' => 'attendance_edits', 'label' => 'Attendance edits', 'count' => dashboard_to_int($row['cnt'] ?? 0), 'path' => '/attendance-edit-requests'];
    }
    if (!$isPersonalDashboard && in_array((int)$authRole, [2, 4, 6], true)) {
        $row = dashboard_db_fetch_one($mysqli, "SELECT COUNT(*) AS cnt
            FROM tbl_substitutions sub
            JOIN tbl_class_schedules cs ON cs.schedule_id = sub.schedule_id
            JOIN tbl_users scope_user ON scope_user.user_id = cs.user_id
            WHERE sub.req_status = 'pending' AND sub.date >= CURDATE() AND ({$scopeConditionUser})");
        $actions[] = ['key' => 'substitutions', 'label' => 'Substitutions', 'count' => dashboard_to_int($row['cnt'] ?? 0), 'path' => '/substitutions'];
    }
    if (!$isPersonalDashboard && in_array((int)$authRole, [1, 2, 3], true) && $semesterId > 0 && tardiness_penalty_schema_ready($mysqli)) {
        $row = dashboard_db_fetch_one($mysqli, "SELECT COUNT(*) AS cnt
            FROM tbl_penalties p
            JOIN tbl_users scope_user ON scope_user.user_id = p.user_id
            WHERE p.semester_id = {$semesterId} AND p.policy_code = 'SEMESTER_LATE_3'
              AND p.status = 'active' AND ({$scopeConditionUser})");
        $actions[] = ['key' => 'red_flags', 'label' => 'Tardiness red flags', 'count' => dashboard_to_int($row['cnt'] ?? 0), 'path' => '/penalties'];
    }
    if (!$isPersonalDashboard) {
        array_unshift($actions, ['key' => 'missing_checkpoints', 'label' => 'Overdue checkpoints', 'count' => count($missingCheckpoints), 'affected_classes' => count($attendanceIssueScheduleIds), 'path' => '/dashboard?focus=missing-checkpoints']);
        if ($healthIssueScheduleIds) {
            array_unshift($actions, ['key' => 'suspended_schedules', 'label' => 'Blocked schedules', 'count' => count($healthIssueScheduleIds), 'affected_classes' => count($healthIssueScheduleIds), 'path' => '/dashboard?focus=blocked-schedules']);
        }
    }

    $overallSqlExpr = "CASE
        WHEN ar.flag_in_id = ar.flag_check_id OR ar.flag_in_id = ar.flag_out_id THEN ar.flag_in_id
        WHEN ar.flag_check_id = ar.flag_out_id THEN ar.flag_check_id ELSE 0 END";
    $meaningfulAttendanceCondition = "(
        ar.checked_in_at IS NOT NULL OR ar.checked_mid_at IS NOT NULL OR ar.checked_out_at IS NOT NULL
        OR COALESCE(ar.flag_in_id, 1) <> 1 OR COALESCE(ar.flag_check_id, 1) <> 1 OR COALESCE(ar.flag_out_id, 1) <> 1
    )";
    $trendRows = dashboard_db_fetch_all($mysqli, "SELECT DATE_FORMAT(ar.date, '%Y-%m-%d') AS date,
            SUM(({$overallSqlExpr}) = 2) AS present,
            SUM(({$overallSqlExpr}) = 5) AS late,
            SUM(({$overallSqlExpr}) = 3) AS absent,
            SUM(({$overallSqlExpr}) = 0) AS incomplete,
            COUNT(*) AS total
        FROM tbl_attendance_records ar
        JOIN tbl_class_schedules cs ON cs.schedule_id = ar.schedule_id
        JOIN tbl_users attendance_user ON attendance_user.user_id = ar.user_id
        LEFT JOIN tbl_subject s ON s.subject_id = cs.subject_id
        LEFT JOIN tbl_sections sec ON sec.section_id = cs.section_id
        WHERE ar.date BETWEEN DATE_SUB(CURDATE(), INTERVAL 13 DAY) AND CURDATE()
          AND {$semesterAttendanceFilter} AND ({$scopeConditionAttendanceUser})
          AND {$dashboardAttendanceClassFilter}
          AND {$meaningfulAttendanceCondition}
        GROUP BY ar.date ORDER BY ar.date");
    $trendRows = dashboard_cast_int_fields($trendRows, ['present', 'late', 'absent', 'incomplete', 'total']);

    $recentResultCondition = " AND ({$overallSqlExpr}) IN (0, 2, 3, 5)";
    $recentRows = dashboard_db_fetch_all($mysqli, "SELECT ar.attendance_id, DATE_FORMAT(ar.date, '%Y-%m-%d') AS date,
            CONCAT_WS(' ', attendance_user.first_name, attendance_user.last_name) AS staff_name,
            COALESCE(s.subject_code, '') AS subject_code, COALESCE(sec.section_name, '') AS section_name,
            COALESCE(r.room_name, '') AS room_name, cs.start_time, cs.end_time,
            ar.flag_in_id, ar.flag_check_id, ar.flag_out_id,
            ar.checked_in_at, ar.checked_mid_at, ar.checked_out_at
        FROM tbl_attendance_records ar
        JOIN tbl_class_schedules cs ON cs.schedule_id = ar.schedule_id
        JOIN tbl_users attendance_user ON attendance_user.user_id = ar.user_id
        LEFT JOIN tbl_subject s ON s.subject_id = cs.subject_id
        LEFT JOIN tbl_sections sec ON sec.section_id = cs.section_id
        LEFT JOIN tbl_rooms r ON r.room_id = ar.room_id
        WHERE {$semesterAttendanceFilter} AND ({$scopeConditionAttendanceUser})
          AND {$dashboardAttendanceClassFilter}
          AND ar.date <= CURDATE()
          AND {$meaningfulAttendanceCondition}
          {$recentResultCondition}
        ORDER BY ar.date DESC, COALESCE(ar.checked_out_at, ar.checked_mid_at, ar.checked_in_at) DESC, ar.attendance_id DESC
        LIMIT 20");
    foreach ($recentRows as &$recentRow) {
        $recentRow['attendance_id'] = (int)$recentRow['attendance_id'];
        $recentRow['overall_status'] = dashboard_status_key_from_flag(
            dashboard_overall_flag_id($recentRow['flag_in_id'], $recentRow['flag_check_id'], $recentRow['flag_out_id']),
            true
        );
    }
    unset($recentRow);

    $exceptions = array_slice($missingCheckpoints, 0, 8);
    if (!$isPersonalDashboard) {
        foreach ($timeline as $classItem) {
            if (!in_array($classItem['overall_status'], ['late', 'absent', 'incomplete'], true)) continue;
            $exceptions[] = [
                'type' => $classItem['overall_status'],
                'severity' => $classItem['overall_status'] === 'absent' ? 'high' : 'medium',
                'title' => ucfirst($classItem['overall_status']) . ' attendance',
                'detail' => trim($classItem['staff_name'] . ' · ' . ($classItem['subject_code'] ?: $classItem['subject_name'])),
                'schedule_id' => $classItem['schedule_id'],
            ];
            if (count($exceptions) >= 12) break;
        }
    }

    $personal = null;
    if ($isPersonalDashboard) {
        $semesterAggregate = dashboard_db_fetch_one($mysqli, "SELECT COUNT(*) AS total,
                SUM(({$overallSqlExpr}) = 2) AS present,
                SUM(({$overallSqlExpr}) = 5) AS late,
                SUM(({$overallSqlExpr}) = 3) AS absent,
                SUM(({$overallSqlExpr}) = 0) AS incomplete,
                SUM(({$overallSqlExpr}) = 8) AS pending,
                SUM(({$overallSqlExpr}) = 1) AS upcoming,
                SUM(({$overallSqlExpr}) = 4) AS substituted,
                SUM(({$overallSqlExpr}) = 7) AS on_leave,
                SUM(ar.date <= CURDATE() AND {$meaningfulAttendanceCondition}) AS attendance_rate_total
            FROM tbl_attendance_records ar
            JOIN tbl_class_schedules cs ON cs.schedule_id = ar.schedule_id
            WHERE ar.user_id = " . (int)$authUserId . " AND {$semesterAttendanceFilter}");
        $lateWarningRows = $semesterId > 0 ? tardiness_late_checkpoints($mysqli, (int)$authUserId, $semesterId) : [];
        $lateWarnings = count($lateWarningRows);
        $penalty = [];
        if ($semesterId > 0 && tardiness_penalty_schema_ready($mysqli)) {
            $penalty = dashboard_db_fetch_one($mysqli, "SELECT sanction_id, date, status
                FROM tbl_penalties WHERE user_id = " . (int)$authUserId . " AND semester_id = {$semesterId}
                  AND policy_code = 'SEMESTER_LATE_3' LIMIT 1");
        }
        $attendanceRequest = dashboard_db_fetch_one($mysqli, "SELECT COUNT(*) AS total,
                SUM(LOWER(TRIM(status)) = 'pending') AS pending,
                SUM(LOWER(TRIM(status)) = 'approved') AS approved,
                SUM(LOWER(TRIM(status)) = 'rejected') AS rejected
            FROM tbl_attendance_edit_requests WHERE requested_by = " . (int)$authUserId);
        $totalSemester = dashboard_to_int($semesterAggregate['total'] ?? 0);
        $presentSemester = dashboard_to_int($semesterAggregate['present'] ?? 0);
        $attendanceRateTotal = dashboard_to_int($semesterAggregate['attendance_rate_total'] ?? 0);
        $calendarRows = dashboard_db_fetch_all($mysqli, "SELECT DATE_FORMAT(ar.date, '%Y-%m-%d') AS date,
                SUM(({$overallSqlExpr}) = 2) AS present, SUM(({$overallSqlExpr}) = 5) AS late,
                SUM(({$overallSqlExpr}) = 3) AS absent, SUM(({$overallSqlExpr}) = 0) AS incomplete,
                SUM(({$overallSqlExpr}) = 8) AS pending, SUM(({$overallSqlExpr}) = 1) AS upcoming,
                SUM(({$overallSqlExpr}) = 4) AS substituted, SUM(({$overallSqlExpr}) = 7) AS on_leave,
                COUNT(*) AS total
            FROM tbl_attendance_records ar
            JOIN tbl_class_schedules cs ON cs.schedule_id = ar.schedule_id
            WHERE ar.user_id = " . (int)$authUserId . " AND {$semesterAttendanceFilter}
              AND ar.date BETWEEN DATE_FORMAT(CURDATE(), '%Y-%m-01') AND LAST_DAY(CURDATE())
            GROUP BY ar.date ORDER BY ar.date");
        $calendarRows = dashboard_cast_int_fields($calendarRows, ['present', 'late', 'absent', 'incomplete', 'pending', 'upcoming', 'substituted', 'on_leave', 'total']);
        $personal = [
            'semester_summary' => [
                'total' => $totalSemester,
                'present' => $presentSemester,
                'late' => dashboard_to_int($semesterAggregate['late'] ?? 0),
                'absent' => dashboard_to_int($semesterAggregate['absent'] ?? 0),
                'incomplete' => dashboard_to_int($semesterAggregate['incomplete'] ?? 0),
                'pending' => dashboard_to_int($semesterAggregate['pending'] ?? 0),
                'upcoming' => dashboard_to_int($semesterAggregate['upcoming'] ?? 0),
                'substituted' => dashboard_to_int($semesterAggregate['substituted'] ?? 0),
                'on_leave' => dashboard_to_int($semesterAggregate['on_leave'] ?? 0),
                'attendance_rate' => $attendanceRateTotal > 0 ? round(($presentSemester / $attendanceRateTotal) * 100, 1) : 0,
            ],
            'late_warnings' => $lateWarnings,
            'late_warning_details' => array_map(static function ($warning) {
                return [
                    'attendance_id' => (int)($warning['attendance_id'] ?? 0),
                    'date' => (string)($warning['late_date'] ?? ''),
                    'stage' => (string)($warning['stage'] ?? ''),
                ];
            }, array_slice(array_reverse($lateWarningRows), 0, 5)),
            'warning_progress' => min(3, $lateWarnings),
            'penalty' => !empty($penalty) ? [
                'sanction_id' => (int)$penalty['sanction_id'],
                'date' => (string)$penalty['date'],
                'status' => (string)$penalty['status'],
            ] : null,
            'pending_requests' => [
                'attendance' => dashboard_to_int($attendanceRequest['pending'] ?? 0),
                'pending' => dashboard_to_int($attendanceRequest['pending'] ?? 0),
                'approved' => dashboard_to_int($attendanceRequest['approved'] ?? 0),
                'rejected' => dashboard_to_int($attendanceRequest['rejected'] ?? 0),
                'total' => dashboard_to_int($attendanceRequest['total'] ?? 0),
            ],
            'calendar' => [
                'month' => date('Y-m'),
                'days' => $calendarRows,
            ],
        ];
    }

    $scopeLabel = (string)($summaryMeta['department_display'] ?? '');
    if (!empty($summaryMeta['program_display'])) $scopeLabel = (string)$summaryMeta['program_display'];
    if ($authRole === 1 && !$isPersonalDashboard) $scopeLabel = 'All departments';
    if ($isPersonalDashboard) $scopeLabel = 'My attendance';

    // The Operations Dashboard can request only the visible timeline page.
    // All calculations above still use the complete authorized timeline, so
    // status totals, checkpoint counts, conflicts, and alerts remain exact.
    $timelineResponse = $timeline;
    $timelinePagination = null;
    $paginateTimeline = !$isPersonalDashboard
        && isset($_GET['timeline_paginate'])
        && (string)$_GET['timeline_paginate'] === '1';
    if ($paginateTimeline) {
        $timelinePage = isset($_GET['timeline_page']) && is_numeric($_GET['timeline_page'])
            ? max(1, (int)$_GET['timeline_page'])
            : 1;
        $timelinePageSize = isset($_GET['timeline_page_size']) && is_numeric($_GET['timeline_page_size'])
            ? max(1, min(50, (int)$_GET['timeline_page_size']))
            : 10;
        $timelineStatus = strtolower(trim((string)($_GET['timeline_status'] ?? 'all')));
        $allowedTimelineStatuses = ['all', 'present', 'late', 'absent', 'incomplete', 'pending', 'upcoming', 'substituted', 'on_leave'];
        if (!in_array($timelineStatus, $allowedTimelineStatuses, true)) $timelineStatus = 'all';
        $timelineSearch = strtolower(trim((string)($_GET['timeline_search'] ?? '')));
        $timelineAvailable = count($timeline);

        $timelineResponse = array_values(array_filter($timeline, static function ($item) use ($timelineStatus, $timelineSearch) {
            if ($timelineStatus !== 'all' && strtolower((string)($item['overall_status'] ?? '')) !== $timelineStatus) return false;
            if ($timelineSearch === '') return true;
            $haystack = strtolower(implode(' ', [
                (string)($item['staff_name'] ?? ''),
                (string)($item['subject_code'] ?? ''),
                (string)($item['subject_name'] ?? ''),
                (string)($item['section_name'] ?? ''),
                (string)($item['room_name'] ?? ''),
            ]));
            return strpos($haystack, $timelineSearch) !== false;
        }));

        $timelinePriority = [
            'pending' => 0, 'late' => 1, 'absent' => 2, 'incomplete' => 3,
            'present' => 4, 'substituted' => 5, 'on_leave' => 6, 'upcoming' => 7,
        ];
        foreach ($timelineResponse as $timelineIndex => &$timelineItem) {
            $timelineItem['_timeline_order'] = $timelineIndex;
        }
        unset($timelineItem);
        usort($timelineResponse, static function ($left, $right) use ($timelinePriority) {
            $leftPriority = $timelinePriority[(string)($left['overall_status'] ?? '')] ?? 99;
            $rightPriority = $timelinePriority[(string)($right['overall_status'] ?? '')] ?? 99;
            if ($leftPriority !== $rightPriority) return $leftPriority <=> $rightPriority;
            $timeComparison = strcmp((string)($left['start_time'] ?? ''), (string)($right['start_time'] ?? ''));
            if ($timeComparison !== 0) return $timeComparison;
            return ((int)($left['_timeline_order'] ?? 0)) <=> ((int)($right['_timeline_order'] ?? 0));
        });

        $timelineTotal = count($timelineResponse);
        $timelineTotalPages = max(1, (int)ceil($timelineTotal / $timelinePageSize));
        $timelinePage = min($timelinePage, $timelineTotalPages);
        $timelineOffset = ($timelinePage - 1) * $timelinePageSize;
        $timelineResponse = array_slice($timelineResponse, $timelineOffset, $timelinePageSize);
        foreach ($timelineResponse as &$timelineItem) unset($timelineItem['_timeline_order']);
        unset($timelineItem);
        $timelinePagination = [
            'page' => $timelinePage,
            'page_size' => $timelinePageSize,
            'total' => $timelineTotal,
            'total_pages' => $timelineTotalPages,
            'available' => $timelineAvailable,
        ];
    }

    json_response([
        'mode' => $isPersonalDashboard ? 'personal' : 'operations',
        'generated_at' => date('c'),
        'context' => [
            'scope_label' => $scopeLabel,
            'role_id' => (int)$authRole,
            'semester' => !empty($activeSemester) ? [
                'semester_id' => $semesterId,
                'term' => (string)$activeSemester['term'],
                'school_year' => (string)$activeSemester['school_year'],
                'start_date' => (string)$activeSemester['start_date'],
                'end_date' => (string)$activeSemester['end_date'],
            ] : null,
            'filters' => [
                'selected_dept_id' => $dashboardSelectedDeptId ?: null,
                'selected_program_id' => $dashboardSelectedProgramId ?: null,
                'departments' => $dashboardFilterOptions['departments'],
                'programs' => $dashboardFilterOptions['programs'],
            ],
        ],
        'overview' => [
            'scheduled_today' => count($scheduleRows),
            'operational_today' => count($timeline),
            'suspended_today' => count($suspendedSchedules),
            'active_classes' => $activeClasses,
            'rooms_in_use' => count($activeRooms),
            'teaching_staff' => dashboard_to_int($filteredTeachingStaff['cnt'] ?? 0),
            'affected_classes_today' => count($affectedScheduleIds),
            'schedule_health_issues_today' => count($healthIssueScheduleIds),
        ],
        'attendance_today' => [
            'date' => date('Y-m-d'),
            'status' => $statusCounts,
            'checkpoints' => ['due' => $totalDue, 'completed' => $completedDue, 'missing' => max(0, $totalDue - $completedDue)],
            'checkpoint_breakdown' => $checkpointBreakdown,
            'completion_rate' => $completionRate,
        ],
        'actions' => $actions,
        'coverage' => $coverageSummary,
        'operational_alerts' => array_slice($operationalAlerts, 0, 20),
        'schedule_today' => $timelineResponse,
        'schedule_pagination' => $timelinePagination,
        'suspended_schedules' => array_slice($suspendedSchedules, 0, 20),
        'suspended_schedules_total' => count($suspendedSchedules),
        'blocked_schedules' => array_slice($blockedScheduleDetails, 0, 20),
        'blocked_schedules_total' => count($blockedScheduleDetails),
        'missing_checkpoints' => array_slice($missingCheckpoints, 0, 20),
        'missing_checkpoints_total' => count($missingCheckpoints),
        'exceptions' => array_slice($exceptions, 0, 12),
        'trend' => $trendRows,
        'recent_activity' => $recentRows,
        'personal' => $personal,
    ]);
}

if ($param1 === 'summary') {
    json_response(dashboard_build_summary($mysqli, $summaryExpr, $finalFlagExpr, $scopeUserTemplate, $restrictAttendanceByUser, $summaryMeta));
}

if ($param1 === null || $param1 === '' || $param1 === 'full') {
    $summary_response = dashboard_build_summary($mysqli, $summaryExpr, $finalFlagExpr, $scopeUserTemplate, $restrictAttendanceByUser, $summaryMeta);
    $snapshotDate = trim((string)($summary_response['attendance_today']['date'] ?? date('Y-m-d')));
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $snapshotDate)) {
        $snapshotDate = date('Y-m-d');
    }
    $snapshotDateSql = $mysqli->real_escape_string($snapshotDate);

    $departments = dashboard_db_fetch_all($mysqli, "SELECT d.dept_id, d.dept_name FROM tbl_departments d {$departmentWhereSql} ORDER BY d.dept_name");
    $programs = dashboard_db_fetch_all($mysqli, "SELECT p.program_id, p.program_name, p.dept_id FROM tbl_programs p {$programWhereSql} ORDER BY p.program_name");
    $sections = dashboard_db_fetch_all(
        $mysqli,
        "SELECT sec.section_id, sec.section_name, sec.program_id
         FROM tbl_sections sec
         LEFT JOIN tbl_programs p ON sec.program_id = p.program_id
         {$sectionsWhereSql}
         ORDER BY sec.section_name"
    );
    $semesters = dashboard_db_fetch_all($mysqli, "SELECT semester_id, term, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date FROM tbl_semesters ORDER BY start_date DESC");
    $subjects = dashboard_db_fetch_all(
        $mysqli,
        "SELECT s.subject_id, s.subject_code, s.subject_name, s.program_id
         FROM tbl_subject s
         LEFT JOIN tbl_programs p ON s.program_id = p.program_id
         {$subjectsWhereSql}
         ORDER BY s.subject_code"
    );

    if ($hasSubjectOfferings) {
        $offerings = dashboard_db_fetch_all(
            $mysqli,
            'SELECT so.offering_id, so.semester_id, so.section_id, so.subject_id, so.user_id, s.subject_code, s.subject_name, sec.section_name
             FROM tbl_subject_offerings so
             LEFT JOIN tbl_subject s ON so.subject_id = s.subject_id
             LEFT JOIN tbl_sections sec ON so.section_id = sec.section_id
             LEFT JOIN tbl_programs p ON s.program_id = p.program_id
             ' . $offeringsWhereSql . '
             ORDER BY s.subject_code, sec.section_name'
        );
    } else {
        $offeringsSubjectSelect = $csHasSubject ? 'cs.subject_id' : 'NULL AS subject_id';
        $offeringsSectionSelect = $csHasSection ? 'cs.section_id' : 'NULL AS section_id';
        $offeringsSubjectJoin = $csHasSubject ? 'LEFT JOIN tbl_subject s ON cs.subject_id = s.subject_id' : 'LEFT JOIN tbl_subject s ON 1=0';
        $offeringsSectionJoin = $csHasSection ? 'LEFT JOIN tbl_sections sec ON cs.section_id = sec.section_id' : 'LEFT JOIN tbl_sections sec ON 1=0';

        $offerings = dashboard_db_fetch_all(
            $mysqli,
            "SELECT DISTINCT
                NULL AS offering_id,
                cs.semester_id,
                {$offeringsSectionSelect},
                {$offeringsSubjectSelect},
                cs.user_id,
                s.subject_code,
                s.subject_name,
                sec.section_name
             FROM tbl_class_schedules cs
             {$offeringsSubjectJoin}
             {$offeringsSectionJoin}
             LEFT JOIN tbl_programs p ON s.program_id = p.program_id
             {$offeringsWhereSql}
             ORDER BY s.subject_code, sec.section_name"
        );
    }

    $rooms = dashboard_db_fetch_all($mysqli, 'SELECT room_id, room_name, latitude, longitude, radius FROM tbl_rooms ORDER BY room_name');
    $teachers = dashboard_db_fetch_all(
        $mysqli,
        "SELECT u.user_id, u.first_name, u.last_name, u.role_id, u.dept_id, u.assigned_program_head_id
         FROM tbl_users u
         {$teacherJoin}
         WHERE {$teachersWhereSql}
         ORDER BY u.last_name, u.first_name"
    );

    $attendanceScopeSql = '';
    if ($restrictAttendanceByUser) {
        $attendanceScopeSql = " AND (" . dashboard_apply_user_scope($scopeUserTemplate, 'u') . ")";
    }

    $recent_attendance_sql = "SELECT
            ar.attendance_id,
            ar.user_id,
            ar.schedule_id,
            ar.room_id,
            ar.floor_id,
            DATE_FORMAT(ar.date, '%Y-%m-%d') AS date,
            ar.checked_in_at AS time_in,
            ar.altitude_in,
            ar.latitude_in,
            ar.longitude_in,
            ar.flag_in_id,
            ar.checked_mid_at AS time_check,
            ar.altitude_check,
            ar.latitude_check,
            ar.longitude_check,
            ar.flag_check_id,
            ar.checked_out_at AS time_out,
            ar.altitude_out,
            ar.latitude_out,
            ar.longitude_out,
            ar.flag_out_id,
            ar.remarks,
            u.first_name,
            u.last_name,
            cs.day_of_week,
            cs.start_time,
            cs.end_time,
            r.room_name,
            {$sectionSelect},
            s.subject_code,
            s.subject_name,
            ({$finalFlagExpr}) AS final_flag_id,
            COALESCE(ft_final.flag_name, 'NA') AS final_flag_name,
            COALESCE(ft_in.flag_name, 'NA') AS flag_in_name,
            COALESCE(ft_check.flag_name, 'NA') AS flag_check_name,
            COALESCE(ft_out.flag_name, 'NA') AS flag_out_name
         FROM tbl_attendance_records ar
         LEFT JOIN tbl_users u ON ar.user_id = u.user_id
         LEFT JOIN tbl_class_schedules cs ON ar.schedule_id = cs.schedule_id
         LEFT JOIN tbl_rooms r ON ar.room_id = r.room_id
         {$joinOffering}
         LEFT JOIN tbl_subject s ON {$subjectExpr} = s.subject_id
         {$sectionJoin}
         LEFT JOIN tbl_flag_types ft_in ON ar.flag_in_id = ft_in.flag_id
         LEFT JOIN tbl_flag_types ft_check ON ar.flag_check_id = ft_check.flag_id
         LEFT JOIN tbl_flag_types ft_out ON ar.flag_out_id = ft_out.flag_id
         LEFT JOIN tbl_flag_types ft_final ON ft_final.flag_id = {$finalFlagExpr}
         WHERE 1=1
         AND ({$finalFlagExpr}) <> 1
         {$attendanceScopeSql}
         ORDER BY ar.date DESC, ar.attendance_id DESC
         LIMIT 200";
    $recent_attendance = dashboard_db_fetch_all($mysqli, $recent_attendance_sql);
    $recent_attendance = dashboard_cast_int_fields($recent_attendance, [
        'attendance_id', 'user_id', 'schedule_id', 'room_id', 'floor_id', 'flag_in_id', 'flag_check_id', 'flag_out_id'
    ]);

    $trend_sql = "SELECT
            DATE_FORMAT(ar.date, '%Y-%m-%d') AS d,
            SUM(({$finalFlagExpr}) = 2) AS present,
            SUM(({$finalFlagExpr}) = 3) AS absent,
            SUM(({$finalFlagExpr}) = 5) AS late,
            SUM(({$finalFlagExpr}) = 1) AS na,
            COUNT(*) AS total
         FROM tbl_attendance_records ar
         LEFT JOIN tbl_users u ON ar.user_id = u.user_id
         WHERE ar.date >= CURDATE() - INTERVAL 13 DAY
         AND ar.date <= CURDATE()
         {$attendanceScopeSql}
         GROUP BY ar.date
         ORDER BY ar.date ASC";
    $trend = dashboard_db_fetch_all($mysqli, $trend_sql);
    $trend = dashboard_cast_int_fields($trend, ['present', 'absent', 'late', 'na', 'total']);

    $hour_sql = "SELECT HOUR(ar.checked_in_at) AS hr, COUNT(*) AS cnt
         FROM tbl_attendance_records ar
         LEFT JOIN tbl_users u ON ar.user_id = u.user_id
         WHERE ar.date = '{$snapshotDateSql}' AND ar.checked_in_at IS NOT NULL
         {$attendanceScopeSql}
         GROUP BY hr
         ORDER BY hr ASC";
    $hourly = dashboard_db_fetch_all($mysqli, $hour_sql);
    $hourly = dashboard_cast_int_fields($hourly, ['hr', 'cnt']);

    $top_rooms_sql = "SELECT r.room_id, r.room_name, COUNT(*) AS checks
         FROM tbl_attendance_records ar
         JOIN tbl_rooms r ON ar.room_id = r.room_id
         LEFT JOIN tbl_users u ON ar.user_id = u.user_id
         WHERE ar.date >= CURDATE() - INTERVAL 29 DAY
         AND ar.date <= CURDATE()
         {$attendanceScopeSql}
         GROUP BY r.room_id, r.room_name
         ORDER BY checks DESC, r.room_name ASC
         LIMIT 10";
    $top_rooms = dashboard_db_fetch_all($mysqli, $top_rooms_sql);
    $top_rooms = dashboard_cast_int_fields($top_rooms, ['room_id', 'checks']);

    $floor_sql = "SELECT f.floor_id, f.floor_name, COUNT(*) AS checks
         FROM tbl_attendance_records ar
         JOIN tbl_floors f ON ar.floor_id = f.floor_id
         LEFT JOIN tbl_users u ON ar.user_id = u.user_id
         WHERE ar.date >= CURDATE() - INTERVAL 29 DAY
         AND ar.date <= CURDATE()
         {$attendanceScopeSql}
         GROUP BY f.floor_id, f.floor_name
         ORDER BY checks DESC, f.floor_name ASC";
    $floor_dist = dashboard_db_fetch_all($mysqli, $floor_sql);
    $floor_dist = dashboard_cast_int_fields($floor_dist, ['floor_id', 'checks']);

    $role_sql = "SELECT ro.role_id, ro.role_name, COUNT(*) AS checks
         FROM tbl_attendance_records ar
         JOIN tbl_users u ON ar.user_id = u.user_id
         JOIN tbl_roles ro ON u.role_id = ro.role_id
         WHERE ar.date >= CURDATE() - INTERVAL 29 DAY
         AND ar.date <= CURDATE()
         {$attendanceScopeSql}
         GROUP BY ro.role_id, ro.role_name
         ORDER BY checks DESC, ro.role_id ASC";
    $by_role = $hasRolesTable ? dashboard_db_fetch_all($mysqli, $role_sql) : [];
    $by_role = dashboard_cast_int_fields($by_role, ['role_id', 'checks']);
    // Format role names to proper nouns for display
    $by_role = array_map(function($item) {
        if (isset($item['role_name'])) {
            $item['role_name'] = app_format_role_name($item['role_name']);
        }
        return $item;
    }, $by_role);

    $weekly_sql = "SELECT
            DATE_FORMAT(ar.date, '%Y-%m-%d') AS d,
            COUNT(*) AS total,
            SUM(({$finalFlagExpr}) = 2) AS present,
            SUM(({$finalFlagExpr}) = 3) AS absent,
            SUM(({$finalFlagExpr}) = 5) AS late
         FROM tbl_attendance_records ar
         LEFT JOIN tbl_users u ON ar.user_id = u.user_id
         WHERE ar.date >= CURDATE() - INTERVAL 6 DAY
         AND ar.date <= CURDATE()
         {$attendanceScopeSql}
         GROUP BY ar.date
         ORDER BY ar.date ASC";
    $weekly = dashboard_db_fetch_all($mysqli, $weekly_sql);
    $weekly = dashboard_cast_int_fields($weekly, ['total', 'present', 'absent', 'late']);

    json_response([
        'generated_at' => date('c'),
        'snapshot_date' => $snapshotDate,
        'summary' => $summary_response,
        'departments' => $departments,
        'programs' => $programs,
        'sections' => $sections,
        'semesters' => $semesters,
        'subjects' => $subjects,
        'offerings' => $offerings,
        'rooms' => $rooms,
        'teachers' => $teachers,
        'recent_attendance' => $recent_attendance,
        'viz' => [
            'trend_14d' => $trend,
            'hourly_today' => $hourly,
            'top_rooms_30d' => $top_rooms,
            'floor_distribution_30d' => $floor_dist,
            'attendance_by_role_30d' => $by_role,
            'weekly_7d' => $weekly
        ]
    ]);
}

json_response(['error' => 'Dashboard endpoint not found.'], 404);
