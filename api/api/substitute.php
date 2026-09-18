<?php
// api/api/substitute.php
require_once __DIR__ . '/../helpers/socket_helper.php';
require_once __DIR__ . '/../helpers/log_helper.php';
require_once __DIR__ . '/../helpers/notification_helper.php';

global $mysqli, $authPayload;

$request_method = $_SERVER['REQUEST_METHOD'];
$input = get_input();

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$parts = explode('/', $path);
$api_prefix_key = array_search('api', $parts);
$endpoint = $parts[$api_prefix_key + 1] ?? null;
$param1 = $parts[$api_prefix_key + 2] ?? null;

$auth = is_array($authPayload) ? $authPayload : app_get_authenticated_session(true);
$authUserId = (int)($auth['user_id'] ?? 0);
$authUserRole = (int)($auth['role_id'] ?? 0);
$authUserDept = isset($auth['dept_id']) && $auth['dept_id'] !== null ? (int)$auth['dept_id'] : null;

function substitute_table_exists($mysqli, $table) {
    $table = preg_replace('/[^a-zA-Z0-9_]/', '', (string)$table);
    if ($table === '') return false;
    $safe = $mysqli->real_escape_string($table);
    $res = $mysqli->query("SHOW TABLES LIKE '{$safe}'");
    return $res && (int)$res->num_rows > 0;
}

function substitute_column_exists($mysqli, $table, $column) {
    $table = preg_replace('/[^a-zA-Z0-9_]/', '', (string)$table);
    $column = preg_replace('/[^a-zA-Z0-9_]/', '', (string)$column);
    if ($table === '' || $column === '') return false;
    $safeColumn = $mysqli->real_escape_string($column);
    $res = $mysqli->query("SHOW COLUMNS FROM `$table` LIKE '{$safeColumn}'");
    return $res && (int)$res->num_rows > 0;
}

function substitute_schedule_schema($mysqli) {
    $hasSo = substitute_table_exists($mysqli, 'tbl_subject_offerings');
    $csHasOffering = substitute_column_exists($mysqli, 'tbl_class_schedules', 'offering_id');
    return [
        'has_so' => $hasSo && $csHasOffering,
        'cs_has_user' => substitute_column_exists($mysqli, 'tbl_class_schedules', 'user_id'),
        'cs_has_subject' => substitute_column_exists($mysqli, 'tbl_class_schedules', 'subject_id'),
        'cs_has_section' => substitute_column_exists($mysqli, 'tbl_class_schedules', 'section_id'),
        'so_has_user' => $hasSo ? substitute_column_exists($mysqli, 'tbl_subject_offerings', 'user_id') : false,
        'so_has_subject' => $hasSo ? substitute_column_exists($mysqli, 'tbl_subject_offerings', 'subject_id') : false,
        'so_has_section' => $hasSo ? substitute_column_exists($mysqli, 'tbl_subject_offerings', 'section_id') : false,
    ];
}

function substitute_schedule_exprs($schema) {
    $joinOffering = $schema['has_so'] ? " LEFT JOIN tbl_subject_offerings so ON cs.offering_id = so.offering_id " : "";
    $teacherExpr = $schema['cs_has_user'] ? 'cs.user_id' : (($schema['has_so'] && $schema['so_has_user']) ? 'so.user_id' : 'NULL');
    $subjectExpr = $schema['cs_has_subject'] ? 'cs.subject_id' : (($schema['has_so'] && $schema['so_has_subject']) ? 'so.subject_id' : 'NULL');
    $sectionExpr = $schema['cs_has_section'] ? 'cs.section_id' : (($schema['has_so'] && $schema['so_has_section']) ? 'so.section_id' : 'NULL');
    return [$joinOffering, $teacherExpr, $subjectExpr, $sectionExpr];
}

$subSchema = substitute_schedule_schema($mysqli);
list($subJoinOffering, $subTeacherExpr, $subSubjectExpr, $subSectionExpr) = substitute_schedule_exprs($subSchema);
$subConflictJoinOffering = $subSchema['has_so'] ? " LEFT JOIN tbl_subject_offerings so2 ON cs2.offering_id = so2.offering_id " : "";
$subConflictSubjectExpr = $subSchema['cs_has_subject'] ? 'cs2.subject_id' : (($subSchema['has_so'] && $subSchema['so_has_subject']) ? 'so2.subject_id' : 'NULL');
$subConflictSectionExpr = $subSchema['cs_has_section'] ? 'cs2.section_id' : (($subSchema['has_so'] && $subSchema['so_has_section']) ? 'so2.section_id' : 'NULL');

function substitute_actor_can_manage_original_role($actorRole, $originalRole) {
    $actorRole = (int)$actorRole;
    $originalRole = (int)$originalRole;
    if ($actorRole === 6) return in_array($originalRole, [2, 3, 4, 5], true);
    if ($actorRole === 2) return in_array($originalRole, [3, 4, 5], true);
    return false;
}

function substitute_assert_manageable_original($mysqli, $actorRole, $actorDept, $originalTeacherId) {
    $stmt = $mysqli->prepare("SELECT dept_id, role_id, status FROM tbl_users WHERE user_id = ? LIMIT 1");
    if (!$stmt) json_response(['ok'=>false,'error'=>'prepare_failed','message'=>$mysqli->error],500);
    $stmt->bind_param('i', $originalTeacherId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!$row || !in_array((int)($row['role_id'] ?? 0), [2, 3, 4, 5], true)) {
        json_response(['ok'=>false,'error'=>'invalid_original_teacher','message'=>'The original teacher must be eligible teaching staff.'],409);
    }
    if (!app_user_status_is_active($row['status'] ?? null)) {
        json_response([
            'ok' => false,
            'error' => 'inactive_original_teacher',
            'message' => 'The original teacher is inactive or archived and cannot be assigned to a new substitution.'
        ], 409);
    }
    if ($actorDept === null || !isset($row['dept_id']) || (int)$row['dept_id'] !== (int)$actorDept) {
        json_response(['ok'=>false,'error'=>'forbidden','message'=>'You can only manage substitutions inside your department.'],403);
    }
    if (!substitute_actor_can_manage_original_role($actorRole, (int)$row['role_id'])) {
        if ((int)$actorRole === 2 && (int)$row['role_id'] === 2) {
            json_response(['ok'=>false,'error'=>'dean_substitution_requires_department_admin','message'=>'Only the Department Admin can manage a substitution for a Dean.'],403);
        }
        json_response(['ok'=>false,'error'=>'forbidden_original_teacher','message'=>'You are not allowed to manage substitutions for this role.'],403);
    }
    return $row;
}

// =================================================================================
// ENDPOINTS
// =================================================================================

if ($request_method === 'GET' && in_array($endpoint, ['substitute', 'substitutions'], true) && $param1 === 'eligible-teachers') {
    if (!in_array((int)$authUserRole, [2, 6], true)) {
        json_response(['ok' => false, 'error' => 'forbidden', 'message' => 'Only dean and department admin can view teachers eligible for substitution.'], 403);
    }
    if ($authUserDept === null) {
        json_response(['ok' => false, 'error' => 'forbidden', 'message' => 'Your account is not assigned to a department.'], 403);
    }
    if ($subTeacherExpr === 'NULL') {
        json_response([]);
    }

    $manageableOriginalRoles = (int)$authUserRole === 2 ? '3, 4, 5' : '2, 3, 4, 5';
    $sql = "
        SELECT
            u.user_id,
            u.first_name,
            u.last_name,
            u.dept_id,
            GROUP_CONCAT(
                DISTINCT CONCAT(
                    DATE_FORMAT(lv.date_from, '%Y-%m-%d'),
                    ' to ',
                    DATE_FORMAT(lv.date_to, '%Y-%m-%d'),
                    CASE WHEN lt.name_type IS NULL OR lt.name_type = '' THEN '' ELSE CONCAT(' (', lt.name_type, ')') END
                )
                ORDER BY lv.date_from, lv.date_to
                SEPARATOR '; '
            ) AS leave_periods
        FROM tbl_users u
        JOIN tbl_leaves lv
          ON lv.teacher_id = u.user_id
         AND lv.req_status = 'approve'
        LEFT JOIN tbl_leave_type lt ON lt.leave_type_id = lv.leave_type_id
        JOIN tbl_attendance_records ar
          ON ar.user_id = u.user_id
         AND ar.date BETWEEN lv.date_from AND lv.date_to
        JOIN tbl_class_schedules cs ON cs.schedule_id = ar.schedule_id
        {$subJoinOffering}
        JOIN tbl_semesters sem ON sem.semester_id = cs.semester_id
        WHERE u.dept_id = ?
          AND u.status = 'active'
          AND u.role_id IN ({$manageableOriginalRoles})
          AND ar.user_id = {$subTeacherExpr}
          AND ar.date >= CURDATE()
          AND ar.date < DATE_ADD(CURDATE(), INTERVAL 7 DAY)
          AND COALESCE(ar.flag_in_id, 1) = 7
          AND COALESCE(ar.flag_check_id, 1) = 7
          AND COALESCE(ar.flag_out_id, 1) = 7
          AND sem.status = 'active'
          AND CURDATE() BETWEEN sem.start_date AND sem.end_date
          AND ar.date BETWEEN sem.start_date AND sem.end_date
        GROUP BY u.user_id, u.first_name, u.last_name, u.dept_id
        ORDER BY u.last_name, u.first_name
    ";
    $stmt = $mysqli->prepare($sql);
    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $deptId = (int)$authUserDept;
    $stmt->bind_param('i', $deptId);
    if (!$stmt->execute()) json_response(['error' => 'execute_failed', 'message' => $stmt->error], 500);
    $res = $stmt->get_result();
    json_response($res ? $res->fetch_all(MYSQLI_ASSOC) : []);
}

if ($request_method === 'GET' && in_array($endpoint, ['substitute', 'substitutions'], true) && $param1 === 'available') {
    if (!in_array((int)$authUserRole, [2, 6], true)) {
        json_response(['ok' => false, 'error' => 'forbidden', 'message' => 'Only dean and department admin can view available substitution schedules.'], 403);
    }
    if (in_array((int)$authUserRole, [2, 6], true) && $authUserDept === null) {
        json_response(['ok' => false, 'error' => 'forbidden', 'message' => 'Your account is not assigned to a department.'], 403);
    }
    if ($subTeacherExpr === 'NULL') {
        json_response([]);
    }

    $teacherId = isset($_GET['teacher_id']) ? (int)$_GET['teacher_id'] : (isset($_GET['original_teacher_id']) ? (int)$_GET['original_teacher_id'] : 0);
    if ($teacherId <= 0) {
        json_response(['ok' => false, 'error' => 'missing_teacher_id', 'message' => 'teacher_id is required.'], 400);
    }
    substitute_assert_manageable_original($mysqli, $authUserRole, $authUserDept, $teacherId);

    $sql = "
        SELECT
            ar.attendance_id,
            ar.user_id AS teacher_id,
            ar.schedule_id,
            DATE_FORMAT(ar.date, '%Y-%m-%d') AS date,
            cs.day_of_week,
            cs.start_time,
            cs.end_time,
            cs.room_id,
            r.floor_id,
            r.room_name,
            {$subSubjectExpr} AS subject_id,
            {$subSectionExpr} AS section_id,
            s.subject_code,
            s.subject_name,
            sec.section_name,
            sem.semester_id,
            sem.term AS semester_term,
            DATE_FORMAT(sem.start_date, '%Y-%m-%d') AS semester_start,
            DATE_FORMAT(sem.end_date, '%Y-%m-%d') AS semester_end,
            ar.flag_in_id,
            ar.flag_check_id,
            ar.flag_out_id,
            lv.leave_id,
            lv.req_status AS leave_status,
            DATE_FORMAT(lv.date_from, '%Y-%m-%d') AS leave_date_from,
            DATE_FORMAT(lv.date_to, '%Y-%m-%d') AS leave_date_to,
            lt.name_type AS leave_type,
            existing_sub.substitution_id,
            existing_sub.substitute_user_id,
            assigned_sub.first_name AS substitute_first_name,
            assigned_sub.last_name AS substitute_last_name,
            CASE WHEN existing_sub.substitution_id IS NULL THEN 0 ELSE 1 END AS is_assigned
        FROM tbl_attendance_records ar
        JOIN tbl_class_schedules cs ON ar.schedule_id = cs.schedule_id
        {$subJoinOffering}
        JOIN tbl_semesters sem ON cs.semester_id = sem.semester_id
        JOIN tbl_rooms r ON cs.room_id = r.room_id
        JOIN tbl_floors location_floor ON location_floor.floor_id = r.floor_id
        JOIN tbl_buildings location_building ON location_building.building_id = COALESCE(r.building_id, location_floor.building_id)
        LEFT JOIN tbl_school location_school ON location_school.school_id = location_building.school_id
        LEFT JOIN tbl_subject s ON {$subSubjectExpr} = s.subject_id
        LEFT JOIN tbl_sections sec ON {$subSectionExpr} = sec.section_id
        LEFT JOIN tbl_programs subject_program ON subject_program.program_id = s.program_id
        LEFT JOIN tbl_departments subject_department ON subject_department.dept_id = subject_program.dept_id
        LEFT JOIN tbl_programs section_program ON section_program.program_id = sec.program_id
        LEFT JOIN tbl_departments section_department ON section_department.dept_id = section_program.dept_id
        LEFT JOIN tbl_users orig_teacher ON {$subTeacherExpr} = orig_teacher.user_id
        JOIN tbl_leaves lv
          ON lv.teacher_id = ar.user_id
         AND lv.req_status = 'approve'
         AND ar.date BETWEEN lv.date_from AND lv.date_to
        LEFT JOIN tbl_leave_type lt ON lt.leave_type_id = lv.leave_type_id
        LEFT JOIN tbl_substitutions existing_sub ON existing_sub.schedule_id = ar.schedule_id AND existing_sub.date = ar.date
        LEFT JOIN tbl_users assigned_sub ON existing_sub.substitute_user_id = assigned_sub.user_id
        WHERE ar.user_id = ?
          AND ar.user_id = {$subTeacherExpr}
          AND ar.date >= CURDATE()
          AND ar.date < DATE_ADD(CURDATE(), INTERVAL 7 DAY)
          AND sem.status = 'active'
          AND LOWER(TRIM(COALESCE(r.status, ''))) IN ('active', '1', 'true')
          AND LOWER(TRIM(COALESCE(location_floor.status, ''))) IN ('active', '1', 'true')
          AND LOWER(TRIM(COALESCE(location_building.status, ''))) IN ('active', '1', 'true')
          AND (location_building.school_id IS NULL OR LOWER(TRIM(COALESCE(location_school.status, ''))) IN ('active', '1', 'true'))
          AND LOWER(TRIM(COALESCE(s.status, ''))) IN ('active', '1', 'true')
          AND LOWER(TRIM(COALESCE(sec.status, ''))) IN ('active', '1', 'true')
          AND LOWER(TRIM(COALESCE(subject_program.status, ''))) IN ('active', '1', 'true')
          AND LOWER(TRIM(COALESCE(subject_department.status, ''))) IN ('active', '1', 'true')
          AND LOWER(TRIM(COALESCE(section_program.status, ''))) IN ('active', '1', 'true')
          AND LOWER(TRIM(COALESCE(section_department.status, ''))) IN ('active', '1', 'true')
          AND CURDATE() BETWEEN sem.start_date AND sem.end_date
          AND ar.date BETWEEN sem.start_date AND sem.end_date
          AND (
              (
                  existing_sub.substitution_id IS NULL
                  AND COALESCE(ar.flag_in_id, 1) = 7
                  AND COALESCE(ar.flag_check_id, 1) = 7
                  AND COALESCE(ar.flag_out_id, 1) = 7
              )
              OR
              (
                  existing_sub.substitution_id IS NOT NULL
                  AND COALESCE(ar.flag_in_id, 1) = 4
                  AND COALESCE(ar.flag_check_id, 1) = 4
                  AND COALESCE(ar.flag_out_id, 1) = 4
              )
          )
    ";

    $types = 'i';
    $params = [$teacherId];
    if (in_array((int)$authUserRole, [2, 6], true)) {
        $sql .= " AND orig_teacher.dept_id = ?";
        $types .= 'i';
        $params[] = (int)$authUserDept;
    }
    $sql .= " ORDER BY ar.date ASC, cs.start_time ASC, cs.end_time ASC";

    $stmt = $mysqli->prepare($sql);
    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $stmt->bind_param($types, ...$params);
    if (!$stmt->execute()) {
        json_response(['error' => 'execute_failed', 'message' => $stmt->error], 500);
    }
    $res = $stmt->get_result();
    json_response($res ? $res->fetch_all(MYSQLI_ASSOC) : []);
}

if ($request_method === 'GET' && in_array($endpoint, ['substitute', 'substitutions'], true)) {
    
    $sql = "
        SELECT 
            ss.substitution_id,
            ss.leave_id,
            ss.date,
            ss.schedule_id,
            ss.req_status,
            cs.semester_id,
            sem.term AS semester_term,
            sem.status AS semester_status,
            DATE_FORMAT(sem.start_date, '%Y-%m-%d') AS semester_start,
            DATE_FORMAT(sem.end_date, '%Y-%m-%d') AS semester_end,
            sy.school_year_id,
            sy.session_name AS school_year_name,
            
            orig_teacher.user_id AS teacher_id,
            orig_teacher.first_name AS teacher_first,
            orig_teacher.last_name AS teacher_last,
            orig_teacher.dept_id AS teacher_dept_id,
            orig_teacher.status AS teacher_user_status,
            d.dept_name,

            sub.user_id AS substitute_id,
            sub.first_name AS sub_first,
            sub.last_name AS sub_last,
            sub.status AS substitute_user_status,

            {$subSubjectExpr} AS subject_id,
            {$subSectionExpr} AS section_id,
            s.subject_code,
            s.subject_name,
            sec.section_name,
            cs.room_id,
            r.room_name,
            cs.start_time,
            cs.end_time,
            orig_ar.attendance_id AS original_attendance_id,
            sub_ar.attendance_id AS substitute_attendance_id
            ,lv.req_status AS leave_status
            ,DATE_FORMAT(lv.date_from, '%Y-%m-%d') AS leave_date_from
            ,DATE_FORMAT(lv.date_to, '%Y-%m-%d') AS leave_date_to
            ,lt.name_type AS leave_type

        FROM tbl_substitutions ss
        LEFT JOIN tbl_class_schedules cs ON ss.schedule_id = cs.schedule_id
        {$subJoinOffering}
        LEFT JOIN tbl_semesters sem ON cs.semester_id = sem.semester_id
        LEFT JOIN tbl_school_year sy ON sem.school_year_id = sy.school_year_id
        LEFT JOIN tbl_attendance_records orig_ar ON orig_ar.schedule_id = ss.schedule_id AND orig_ar.date = ss.date AND orig_ar.user_id = {$subTeacherExpr}
        LEFT JOIN tbl_attendance_records sub_ar ON sub_ar.schedule_id = ss.schedule_id AND sub_ar.date = ss.date AND sub_ar.user_id = ss.substitute_user_id
        LEFT JOIN tbl_subject s ON {$subSubjectExpr} = s.subject_id
        LEFT JOIN tbl_sections sec ON {$subSectionExpr} = sec.section_id
        LEFT JOIN tbl_rooms r ON cs.room_id = r.room_id
        LEFT JOIN tbl_users orig_teacher ON {$subTeacherExpr} = orig_teacher.user_id
        LEFT JOIN tbl_departments d ON orig_teacher.dept_id = d.dept_id
        LEFT JOIN tbl_users sub ON ss.substitute_user_id = sub.user_id
        LEFT JOIN tbl_leaves lv ON ss.leave_id = lv.leave_id
        LEFT JOIN tbl_leave_type lt ON lv.leave_type_id = lt.leave_type_id
    ";

    $where = [];
    $params = [];
    $types = '';

    $validateDateFilter = static function ($value) {
        if (!is_string($value) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $value, $matches)) return false;
        return checkdate((int)$matches[2], (int)$matches[3], (int)$matches[1]);
    };
    $dateFrom = isset($_GET['date_from']) ? trim((string)$_GET['date_from']) : '';
    $dateTo = isset($_GET['date_to']) ? trim((string)$_GET['date_to']) : '';
    if (($dateFrom !== '' && !$validateDateFilter($dateFrom)) || ($dateTo !== '' && !$validateDateFilter($dateTo))) {
        json_response(['error' => 'validation', 'message' => 'date_from and date_to must use YYYY-MM-DD format.'], 400);
    }
    if ($dateFrom !== '' && $dateTo !== '' && $dateFrom > $dateTo) {
        json_response(['error' => 'validation', 'message' => 'date_from cannot be later than date_to.'], 400);
    }
    $filterSemesterId = null;
    if (isset($_GET['semester_id']) && $_GET['semester_id'] !== '') {
        if (!is_numeric($_GET['semester_id']) || (int)$_GET['semester_id'] <= 0) {
            json_response(['error' => 'validation', 'message' => 'semester_id must be a positive number.'], 400);
        }
        $filterSemesterId = (int)$_GET['semester_id'];
    }
    $filterSchoolYearId = null;
    if (isset($_GET['school_year_id']) && $_GET['school_year_id'] !== '') {
        if (!is_numeric($_GET['school_year_id']) || (int)$_GET['school_year_id'] <= 0) {
            json_response(['error' => 'validation', 'message' => 'school_year_id must be a positive number.'], 400);
        }
        $filterSchoolYearId = (int)$_GET['school_year_id'];
    }

    if (is_numeric($param1)) {
        $where[] = "ss.substitution_id = ?";
        $params[] = (int)$param1;
        $types .= 'i';
    }

    if ($dateFrom !== '') {
        $where[] = 'ss.date >= ?';
        $params[] = $dateFrom;
        $types .= 's';
    }
    if ($dateTo !== '') {
        $where[] = 'ss.date <= ?';
        $params[] = $dateTo;
        $types .= 's';
    }
    if ($filterSemesterId !== null) {
        $where[] = 'cs.semester_id = ?';
        $params[] = $filterSemesterId;
        $types .= 'i';
    }
    if ($filterSchoolYearId !== null) {
        $where[] = 'sem.school_year_id = ?';
        $params[] = $filterSchoolYearId;
        $types .= 'i';
    }

    $filterDate = isset($_GET['date']) ? trim((string)$_GET['date']) : '';
    if ($filterDate !== '' && !$validateDateFilter($filterDate)) {
        json_response(['error' => 'validation', 'message' => 'date must use YYYY-MM-DD format.'], 400);
    }
    $filterTeacherId = isset($_GET['teacher_id']) && is_numeric($_GET['teacher_id']) ? (int)$_GET['teacher_id'] : 0;
    $filterScheduleId = isset($_GET['schedule_id']) && is_numeric($_GET['schedule_id']) ? (int)$_GET['schedule_id'] : 0;
    $historyView = strtolower(trim((string)($_GET['history_view'] ?? '')));
    if ($filterDate !== '') {
        $where[] = 'ss.date = ?'; $params[] = $filterDate; $types .= 's';
    }
    if ($filterTeacherId > 0) {
        $where[] = "{$subTeacherExpr} = ?"; $params[] = $filterTeacherId; $types .= 'i';
    }
    if ($filterScheduleId > 0) {
        $where[] = 'ss.schedule_id = ?'; $params[] = $filterScheduleId; $types .= 'i';
    }
    if ($historyView === 'current') {
        $where[] = "LOWER(COALESCE(sem.status, '')) = 'active' AND CURDATE() BETWEEN sem.start_date AND sem.end_date";
    } elseif ($historyView === 'upcoming') {
        $where[] = 'ss.date >= CURDATE()';
    } elseif ($historyView === 'completed') {
        $where[] = 'ss.date < CURDATE()';
    }

    // --- ROLE FILTERING ---
    if ((int)$authUserRole === 5) {
        $where[] = "(({$subTeacherExpr} = ? OR ss.substitute_user_id = ?) AND orig_ar.attendance_id IS NOT NULL)";
        $params[] = (int)$authUserId;
        $params[] = (int)$authUserId;
        $types .= 'ii';
    } else {
        $where[] = "orig_ar.attendance_id IS NOT NULL";
    }

    if ((int)$authUserRole !== 5 && $authUserRole !== 1 && $authUserDept !== null) {
        $where[] = "orig_teacher.dept_id = ?";
        $params[] = $authUserDept;
        $types .= 'i';
    } elseif ((int)$authUserRole !== 5 && $authUserRole !== 1 && $authUserDept === null) {
        $where[] = "1 = 0";
    }

    if (!empty($where)) {
        $sql .= " WHERE " . implode(' AND ', $where);
    }

    $sql .= " ORDER BY ss.date DESC";

    $stmt = $mysqli->prepare($sql);
    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);

    if (!empty($params)) {
        $stmt->bind_param($types, ...$params);
    }

    $stmt->execute();
    $res = $stmt->get_result();
    
    if (is_numeric($param1)) {
        $row = $res ? $res->fetch_assoc() : null;
        if (!$row) json_response([], 200); 
        json_response($row);
    } else {
        $rows = $res ? $res->fetch_all(MYSQLI_ASSOC) : [];
        $paginate = isset($_GET['paginate']) && in_array(strtolower((string)$_GET['paginate']), ['1', 'true', 'yes'], true);
        if (!$paginate) json_response($rows);

        // A single substitution can contain parallel sections. Paginate complete
        // groups so a group is never split across two browser pages.
        $groups = [];
        $groupOrder = [];
        foreach ($rows as $row) {
            $key = implode('|', [
                $row['leave_id'] ?: ('legacy-' . ($row['substitution_id'] ?? '')),
                $row['teacher_id'] ?? '', $row['substitute_id'] ?? '', $row['date'] ?? '',
                $row['semester_id'] ?? '', $row['subject_id'] ?: ($row['subject_code'] ?? ''),
                $row['start_time'] ?? '', $row['end_time'] ?? ''
            ]);
            if (!isset($groups[$key])) { $groups[$key] = []; $groupOrder[] = $key; }
            $groups[$key][] = $row;
        }
        $page = isset($_GET['page']) && is_numeric($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        $pageSize = isset($_GET['page_size']) && is_numeric($_GET['page_size']) ? max(1, min(100, (int)$_GET['page_size'])) : 10;
        $total = count($groupOrder);
        $totalPages = max(1, (int)ceil($total / $pageSize));
        $page = min($page, $totalPages);
        $pageKeys = array_slice($groupOrder, ($page - 1) * $pageSize, $pageSize);
        $pageRows = [];
        $coveredClasses = 0;
        $upcoming = 0;
        $today = date('Y-m-d');
        foreach ($groupOrder as $key) {
            $coveredClasses += count($groups[$key]);
            $groupDate = (string)($groups[$key][0]['date'] ?? '');
            if ($groupDate >= $today) $upcoming++;
        }
        foreach ($pageKeys as $key) foreach ($groups[$key] as $row) $pageRows[] = $row;
        json_response([
            'rows' => $pageRows,
            'pagination' => ['page'=>$page, 'page_size'=>$pageSize, 'total'=>$total, 'total_pages'=>$totalPages],
            'summary' => ['assignments'=>$total, 'covered_classes'=>$coveredClasses, 'upcoming'=>$upcoming]
        ]);
    }
}

elseif ($request_method === 'POST' && in_array($endpoint, ['substitute', 'substitutions'], true) && in_array($param1, ['check-conflicts', 'check-candidates'], true)) {
    if (!in_array((int)$authUserRole, [2, 6], true)) {
        json_response(['ok' => false, 'error' => 'forbidden', 'message' => 'Only dean and department admin can check substitution conflicts.'], 403);
    }
    if ($authUserDept === null) {
        json_response(['ok' => false, 'error' => 'forbidden', 'message' => 'Your account is not assigned to a department.'], 403);
    }

    $checkingCandidates = $param1 === 'check-candidates';
    $substituteId = isset($input['substitute_id']) ? (int)$input['substitute_id'] : 0;
    $originalTeacherId = isset($input['original_teacher_id']) ? (int)$input['original_teacher_id'] : 0;
    $requestedSchedules = isset($input['substitutions']) && is_array($input['substitutions']) ? $input['substitutions'] : [];
    if ((!$checkingCandidates && $substituteId <= 0) || $originalTeacherId <= 0 || empty($requestedSchedules)) {
        json_response(['ok' => false, 'error' => 'missing_fields', 'message' => 'Original teacher and selected schedules are required.'], 400);
    }
    substitute_assert_manageable_original($mysqli, $authUserRole, $authUserDept, $originalTeacherId);
    if (!$checkingCandidates && $substituteId === $originalTeacherId) {
        json_response(['ok' => false, 'error' => 'same_teacher', 'message' => 'The substitute teacher must be different from the original teacher.'], 400);
    }
    if ($subTeacherExpr === 'NULL') {
        json_response(['ok' => false, 'error' => 'schedule_mapping_unavailable'], 500);
    }

    if (!$checkingCandidates) {
        $substituteStmt = $mysqli->prepare("SELECT dept_id, role_id, status FROM tbl_users WHERE user_id = ? LIMIT 1");
        if (!$substituteStmt) json_response(['ok' => false, 'error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        $substituteStmt->bind_param('i', $substituteId);
        $substituteStmt->execute();
        $substituteRow = $substituteStmt->get_result()->fetch_assoc();
        if (!$substituteRow) json_response(['ok' => false, 'error' => 'not_found', 'message' => 'Selected substitute user was not found.'], 404);
        if (strtolower(trim((string)($substituteRow['status'] ?? ''))) !== 'active' || !in_array((int)($substituteRow['role_id'] ?? 0), [2, 3, 4, 5], true)) {
            json_response(['ok' => false, 'error' => 'inactive_substitute', 'message' => 'Selected substitute is inactive, archived, or not eligible to teach.'], 409);
        }
        if (!isset($substituteRow['dept_id']) || (int)$substituteRow['dept_id'] !== (int)$authUserDept) {
            json_response(['ok' => false, 'error' => 'forbidden', 'message' => 'You can only assign substitutes within your own department.'], 403);
        }
    }

    $selectedStmt = $mysqli->prepare("
        SELECT
            ar.schedule_id,
            DATE_FORMAT(ar.date, '%Y-%m-%d') AS date,
            cs.semester_id,
            {$subSubjectExpr} AS subject_id,
            cs.start_time,
            cs.end_time,
            s.subject_code,
            s.subject_name,
            sec.section_name,
            r.room_name,
            orig_teacher.dept_id
            ,ar.flag_in_id
            ,ar.flag_check_id
            ,ar.flag_out_id
        FROM tbl_attendance_records ar
        JOIN tbl_class_schedules cs ON ar.schedule_id = cs.schedule_id
        {$subJoinOffering}
        LEFT JOIN tbl_subject s ON {$subSubjectExpr} = s.subject_id
        LEFT JOIN tbl_sections sec ON {$subSectionExpr} = sec.section_id
        LEFT JOIN tbl_rooms r ON cs.room_id = r.room_id
        LEFT JOIN tbl_users orig_teacher ON {$subTeacherExpr} = orig_teacher.user_id
        WHERE ar.schedule_id = ? AND ar.date = ? AND ar.user_id = ? AND ar.user_id = {$subTeacherExpr}
        LIMIT 1
    ");
    $conflictStmt = $mysqli->prepare("
        SELECT
            ar.attendance_id,
            ar.schedule_id,
            ar.flag_in_id,
            ar.flag_check_id,
            ar.flag_out_id,
            cs2.semester_id,
            {$subConflictSubjectExpr} AS subject_id,
            cs2.start_time,
            cs2.end_time,
            conflict_subject.subject_code,
            conflict_subject.subject_name,
            conflict_section.section_name,
            conflict_room.room_name
        FROM tbl_attendance_records ar
        JOIN tbl_class_schedules cs2 ON ar.schedule_id = cs2.schedule_id
        {$subConflictJoinOffering}
        LEFT JOIN tbl_subject conflict_subject ON {$subConflictSubjectExpr} = conflict_subject.subject_id
        LEFT JOIN tbl_sections conflict_section ON {$subConflictSectionExpr} = conflict_section.section_id
        LEFT JOIN tbl_rooms conflict_room ON cs2.room_id = conflict_room.room_id
        WHERE ar.user_id = ?
          AND ar.date = ?
          AND NOT (cs2.end_time <= ? OR cs2.start_time >= ?)
    ");
    if (!$selectedStmt || !$conflictStmt) {
        json_response(['ok' => false, 'error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    }

    $selectedRows = [];
    $seenKeys = [];
    foreach ($requestedSchedules as $requested) {
        $scheduleId = isset($requested['schedule_id']) ? (int)$requested['schedule_id'] : 0;
        $date = isset($requested['date']) ? trim((string)$requested['date']) : '';
        $key = $scheduleId . '|' . $date;
        if ($scheduleId <= 0 || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date) || isset($seenKeys[$key])) {
            json_response(['ok' => false, 'error' => 'invalid_schedule_selection', 'message' => 'One or more selected schedules are invalid.'], 400);
        }
        $seenKeys[$key] = true;
        $selectedStmt->bind_param('isi', $scheduleId, $date, $originalTeacherId);
        $selectedStmt->execute();
        $selectedRow = $selectedStmt->get_result()->fetch_assoc();
        if (!$selectedRow || !isset($selectedRow['dept_id']) || (int)$selectedRow['dept_id'] !== (int)$authUserDept) {
            json_response(['ok' => false, 'error' => 'invalid_schedule_selection', 'message' => 'A selected schedule is unavailable or outside your department.'], 400);
        }
        if ((int)($selectedRow['flag_in_id'] ?? 0) !== 7
            || (int)($selectedRow['flag_check_id'] ?? 0) !== 7
            || (int)($selectedRow['flag_out_id'] ?? 0) !== 7) {
            json_response(['ok' => false, 'error' => 'attendance_not_on_leave', 'message' => 'Only attendance records marked On Leave can receive a substitute.'], 409);
        }
        $selectedRows[] = $selectedRow;
    }

    $collectConflicts = function($candidateId) use ($selectedRows, $conflictStmt) {
        $conflicts = [];
        foreach ($selectedRows as $selectedRow) {
            $scheduleId = (int)$selectedRow['schedule_id'];
            $date = (string)$selectedRow['date'];
            $startTime = (string)$selectedRow['start_time'];
            $endTime = (string)$selectedRow['end_time'];
            $conflictStmt->bind_param('isss', $candidateId, $date, $startTime, $endTime);
            $conflictStmt->execute();
            $result = $conflictStmt->get_result();
            while ($conflictRow = $result->fetch_assoc()) {
                $isTransferredAway = (int)($conflictRow['flag_in_id'] ?? 0) === 4
                    && (int)($conflictRow['flag_check_id'] ?? 0) === 4
                    && (int)($conflictRow['flag_out_id'] ?? 0) === 4;
                $isExactParallel = (int)($conflictRow['semester_id'] ?? 0) === (int)$selectedRow['semester_id']
                    && (int)($conflictRow['subject_id'] ?? 0) === (int)$selectedRow['subject_id']
                    && (string)$conflictRow['start_time'] === $startTime
                    && (string)$conflictRow['end_time'] === $endTime;
                if ($isTransferredAway || $isExactParallel) continue;
                $conflicts[] = [
                    'source' => 'teacher_schedule',
                    'selected_schedule_id' => $scheduleId,
                    'selected_date' => $date,
                    'selected_subject_code' => $selectedRow['subject_code'],
                    'selected_section_name' => $selectedRow['section_name'],
                    'selected_start_time' => $startTime,
                    'selected_end_time' => $endTime,
                    'conflict_schedule_id' => (int)$conflictRow['schedule_id'],
                    'conflict_subject_code' => $conflictRow['subject_code'],
                    'conflict_subject_name' => $conflictRow['subject_name'],
                    'conflict_section_name' => $conflictRow['section_name'],
                    'conflict_room_name' => $conflictRow['room_name'],
                    'conflict_start_time' => $conflictRow['start_time'],
                    'conflict_end_time' => $conflictRow['end_time'],
                ];
            }
        }

        $selectedCount = count($selectedRows);
        for ($leftIndex = 0; $leftIndex < $selectedCount; $leftIndex++) {
            for ($rightIndex = $leftIndex + 1; $rightIndex < $selectedCount; $rightIndex++) {
                $left = $selectedRows[$leftIndex];
                $right = $selectedRows[$rightIndex];
                if ((string)$left['date'] !== (string)$right['date']) continue;
                $overlaps = !((string)$left['end_time'] <= (string)$right['start_time'] || (string)$left['start_time'] >= (string)$right['end_time']);
                $isExactParallel = (int)$left['semester_id'] === (int)$right['semester_id']
                    && (int)$left['subject_id'] === (int)$right['subject_id']
                    && (string)$left['start_time'] === (string)$right['start_time']
                    && (string)$left['end_time'] === (string)$right['end_time'];
                if (!$overlaps || $isExactParallel) continue;
                foreach ([[$left, $right], [$right, $left]] as $pair) {
                    [$selectedItem, $conflictingItem] = $pair;
                    $conflicts[] = [
                        'source' => 'selected_batch',
                        'selected_schedule_id' => (int)$selectedItem['schedule_id'],
                        'selected_date' => (string)$selectedItem['date'],
                        'selected_subject_code' => $selectedItem['subject_code'],
                        'selected_section_name' => $selectedItem['section_name'],
                        'selected_start_time' => $selectedItem['start_time'],
                        'selected_end_time' => $selectedItem['end_time'],
                        'conflict_schedule_id' => (int)$conflictingItem['schedule_id'],
                        'conflict_subject_code' => $conflictingItem['subject_code'],
                        'conflict_subject_name' => $conflictingItem['subject_name'],
                        'conflict_section_name' => $conflictingItem['section_name'],
                        'conflict_room_name' => $conflictingItem['room_name'],
                        'conflict_start_time' => $conflictingItem['start_time'],
                        'conflict_end_time' => $conflictingItem['end_time'],
                    ];
                }
            }
        }
        return $conflicts;
    };

    if ($checkingCandidates) {
        $candidateStmt = $mysqli->prepare("
            SELECT u.user_id, u.first_name, u.last_name
            FROM tbl_users u
            WHERE u.status = 'active'
              AND u.dept_id = ?
              AND u.user_id <> ?
              AND u.role_id IN (2, 3, 4, 5)
            ORDER BY u.last_name, u.first_name
        ");
        if (!$candidateStmt) json_response(['ok' => false, 'error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        $candidateStmt->bind_param('ii', $authUserDept, $originalTeacherId);
        $candidateStmt->execute();
        $candidateRows = $candidateStmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $candidates = [];
        foreach ($candidateRows as $candidateRow) {
            $candidateId = (int)$candidateRow['user_id'];
            $candidateConflicts = $collectConflicts($candidateId);
            $candidates[] = [
                'user_id' => $candidateId,
                'first_name' => $candidateRow['first_name'],
                'last_name' => $candidateRow['last_name'],
                'available' => empty($candidateConflicts),
                'conflict_count' => count($candidateConflicts),
                'conflicts' => $candidateConflicts,
            ];
        }
        usort($candidates, function($left, $right) {
            if ((bool)$left['available'] !== (bool)$right['available']) return $left['available'] ? -1 : 1;
            return strcasecmp(trim($left['last_name'] . ' ' . $left['first_name']), trim($right['last_name'] . ' ' . $right['first_name']));
        });
        json_response(['ok' => true, 'candidates' => $candidates]);
    }

    $conflicts = $collectConflicts($substituteId);
    json_response(['ok' => true, 'has_conflicts' => !empty($conflicts), 'conflicts' => $conflicts]);
}

elseif ($request_method === 'POST' && in_array($endpoint, ['substitute', 'substitutions'], true) && empty($param1)) {
    if (!in_array((int)$authUserRole, [2, 6], true)) {
        json_response(['ok' => false, 'error' => 'forbidden', 'message' => 'Only dean and department admin can add substitutions.'], 403);
    }
    if (in_array((int)$authUserRole, [2, 6], true) && $authUserDept === null) {
        json_response(['ok' => false, 'error' => 'forbidden', 'message' => 'Your account is not assigned to a department.'], 403);
    }

    // Accept both the batch payload used by the Substitutions page and
    // the legacy single-entry payload used by leave approval flows.
    $sub_id = isset($input['substitute_id']) ? (int)$input['substitute_id'] : null;
    if (!$sub_id && isset($input['substitute_user_id'])) {
        $sub_id = (int)$input['substitute_user_id'];
    }
    $originalTeacherId = isset($input['original_teacher_id']) ? (int)$input['original_teacher_id'] : null;
    $substitutions = isset($input['substitutions']) && is_array($input['substitutions']) ? $input['substitutions'] : [];
    if (empty($substitutions) && !empty($input['schedule_id']) && !empty($input['date'])) {
        $substitutions = [[
            'schedule_id' => (int)$input['schedule_id'],
            'date' => (string)$input['date'],
        ]];
    }

    if (!$sub_id || empty($substitutions)) {
        json_response(['ok'=>false, 'error'=>'missing_fields', 'message'=>'Substitute ID and at least one schedule are required'], 400);
    }
    if ($originalTeacherId) {
        substitute_assert_manageable_original($mysqli, $authUserRole, $authUserDept, $originalTeacherId);
    }

    $subDeptStmt = $mysqli->prepare("SELECT dept_id, role_id, status FROM tbl_users WHERE user_id = ? LIMIT 1");
    if (!$subDeptStmt) json_response(['ok' => false, 'error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $subDeptStmt->bind_param('i', $sub_id);
    $subDeptStmt->execute();
    $subDeptRow = $subDeptStmt->get_result()->fetch_assoc();
    if (!$subDeptRow) {
        json_response(['ok' => false, 'error' => 'not_found', 'message' => 'Selected substitute user was not found.'], 404);
    }
    if (strtolower(trim((string)($subDeptRow['status'] ?? ''))) !== 'active' || !in_array((int)($subDeptRow['role_id'] ?? 0), [2, 3, 4, 5], true)) {
        json_response(['ok' => false, 'error' => 'inactive_substitute', 'message' => 'Selected substitute is inactive, archived, or not eligible to teach.'], 409);
    }
    $subDeptId = isset($subDeptRow['dept_id']) && $subDeptRow['dept_id'] !== null ? (int)$subDeptRow['dept_id'] : null;
    if (in_array((int)$authUserRole, [2, 6], true) && ($subDeptId === null || $subDeptId !== (int)$authUserDept)) {
        json_response(['ok' => false, 'error' => 'forbidden', 'message' => 'You can only assign substitutes within your own department.'], 403);
    }

    // Start Transaction for safe bulk insert
    $mysqli->begin_transaction();

    try {
        if ($subTeacherExpr === 'NULL') {
            throw new Exception('Schedule teacher mapping is not available.');
        }

        $attendanceStmt = $mysqli->prepare("
            SELECT
                ar.attendance_id,
                ar.user_id AS orig_user_id,
                ar.schedule_id,
                ar.room_id,
                ar.floor_id,
                DATE_FORMAT(ar.date, '%Y-%m-%d') AS date,
                ar.flag_in_id,
                ar.flag_check_id,
                ar.flag_out_id,
                cs.semester_id,
                {$subSubjectExpr} AS subject_id,
                cs.start_time,
                cs.end_time,
                orig_teacher.dept_id,
                orig_teacher.role_id AS original_teacher_role_id,
                s.subject_code,
                sec.section_name
            FROM tbl_attendance_records ar
            JOIN tbl_class_schedules cs ON ar.schedule_id = cs.schedule_id
            {$subJoinOffering}
            JOIN tbl_semesters sem ON cs.semester_id = sem.semester_id
            JOIN tbl_rooms location_room ON location_room.room_id = ar.room_id
            JOIN tbl_floors location_floor ON location_floor.floor_id = location_room.floor_id
            JOIN tbl_buildings location_building ON location_building.building_id = COALESCE(location_room.building_id, location_floor.building_id)
            LEFT JOIN tbl_school location_school ON location_school.school_id = location_building.school_id
            LEFT JOIN tbl_users orig_teacher ON {$subTeacherExpr} = orig_teacher.user_id
            LEFT JOIN tbl_subject s ON {$subSubjectExpr} = s.subject_id
            LEFT JOIN tbl_sections sec ON {$subSectionExpr} = sec.section_id
            LEFT JOIN tbl_programs subject_program ON subject_program.program_id = s.program_id
            LEFT JOIN tbl_departments subject_department ON subject_department.dept_id = subject_program.dept_id
            LEFT JOIN tbl_programs section_program ON section_program.program_id = sec.program_id
            LEFT JOIN tbl_departments section_department ON section_department.dept_id = section_program.dept_id
            WHERE ar.schedule_id = ?
              AND ar.date = ?
              AND ar.user_id = {$subTeacherExpr}
              AND sem.status = 'active'
              AND LOWER(TRIM(COALESCE(location_room.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(location_floor.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(location_building.status, ''))) IN ('active', '1', 'true')
              AND (location_building.school_id IS NULL OR LOWER(TRIM(COALESCE(location_school.status, ''))) IN ('active', '1', 'true'))
              AND LOWER(TRIM(COALESCE(s.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(sec.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(subject_program.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(subject_department.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(section_program.status, ''))) IN ('active', '1', 'true')
              AND LOWER(TRIM(COALESCE(section_department.status, ''))) IN ('active', '1', 'true')
              AND CURDATE() BETWEEN sem.start_date AND sem.end_date
              AND ar.date BETWEEN sem.start_date AND sem.end_date
            LIMIT 1
            FOR UPDATE
        ");
        $checkStmt = $mysqli->prepare("SELECT substitution_id FROM tbl_substitutions WHERE schedule_id = ? AND date = ? LIMIT 1");
        $conflictStmt = $mysqli->prepare("
            SELECT
                ar.attendance_id,
                ar.flag_in_id,
                ar.flag_check_id,
                ar.flag_out_id,
                cs2.semester_id,
                {$subConflictSubjectExpr} AS subject_id,
                cs2.start_time,
                cs2.end_time
            FROM tbl_attendance_records ar
            JOIN tbl_class_schedules cs2 ON ar.schedule_id = cs2.schedule_id
            {$subConflictJoinOffering}
            WHERE ar.user_id = ?
              AND ar.date = ?
              AND NOT (cs2.end_time <= ? OR cs2.start_time >= ?)
        ");
        $leaveStmt = $mysqli->prepare("
            SELECT lv.leave_id, lv.date_from, lv.date_to, lt.name_type
            FROM tbl_leaves lv
            LEFT JOIN tbl_leave_type lt ON lt.leave_type_id = lv.leave_type_id
            WHERE lv.teacher_id = ?
              AND lv.req_status = 'approve'
              AND ? BETWEEN lv.date_from AND lv.date_to
            ORDER BY lv.date_from DESC, lv.leave_id DESC
            LIMIT 1
            FOR UPDATE
        ");
        $insertStmt = $mysqli->prepare("INSERT INTO tbl_substitutions (leave_id, schedule_id, substitute_user_id, date) VALUES (?, ?, ?, ?)");
        $insertAttendanceStmt = $mysqli->prepare("
            INSERT INTO tbl_attendance_records
                (user_id, schedule_id, room_id, floor_id, date, flag_in_id, flag_check_id, flag_out_id, remarks)
            VALUES (?, ?, ?, ?, ?, 1, 1, 1, ?)
        ");
        $markOrigStmt = $mysqli->prepare("
            UPDATE tbl_attendance_records
            SET flag_in_id = 4, flag_check_id = 4, flag_out_id = 4
            WHERE attendance_id = ?
              AND COALESCE(flag_in_id, 1) = 7
              AND COALESCE(flag_check_id, 1) = 7
              AND COALESCE(flag_out_id, 1) = 7
        ");

        if (!$attendanceStmt || !$checkStmt || !$conflictStmt || !$leaveStmt || !$insertStmt || !$insertAttendanceStmt || !$markOrigStmt) {
            throw new mysqli_sql_exception('Failed to prepare substitution validation: ' . $mysqli->error);
        }

        $today = new DateTime('today');
        $weekEnd = (clone $today)->modify('+7 days');
        $selectedKeys = [];
        $batchSlots = [];
        $validatedSubs = [];
        $originalTeacherScheduleCounts = [];

        foreach ($substitutions as $sub) {
            $schedule_id = isset($sub['schedule_id']) ? (int)$sub['schedule_id'] : 0;
            $date = isset($sub['date']) ? trim((string)$sub['date']) : '';
            if ($schedule_id <= 0 || $date === '') {
                throw new Exception('Each selected substitution must include a schedule and date.');
            }

            $dateObj = DateTime::createFromFormat('Y-m-d', $date);
            if (!$dateObj || $dateObj->format('Y-m-d') !== $date) {
                throw new Exception('Invalid substitution date. Use YYYY-MM-DD.');
            }
            if ($dateObj < $today || $dateObj >= $weekEnd) {
                throw new Exception('Only attendance records within the current 7-day schedule window can be substituted.');
            }

            $payloadKey = $schedule_id . '|' . $date;
            if (isset($selectedKeys[$payloadKey])) {
                throw new Exception('The same class/date was selected more than once.');
            }
            $selectedKeys[$payloadKey] = true;

            $attendanceStmt->bind_param('is', $schedule_id, $date);
            $attendanceStmt->execute();
            $attRow = $attendanceStmt->get_result()->fetch_assoc();
            if (!$attRow) {
                throw new Exception("No active teacher attendance record exists for the selected class on {$date}.");
            }

            $origUserId = isset($attRow['orig_user_id']) ? (int)$attRow['orig_user_id'] : 0;
            if ($origUserId <= 0) {
                throw new Exception('Selected schedule has no original teacher attendance owner.');
            }
            if ($originalTeacherId && $origUserId !== (int)$originalTeacherId) {
                throw new Exception('Selected schedule does not belong to the selected original teacher.');
            }
            if ($origUserId === (int)$sub_id) {
                throw new Exception('The substitute teacher must be different from the original teacher.');
            }
            if (in_array((int)$authUserRole, [2, 6], true)) {
                $scheduleDeptId = isset($attRow['dept_id']) && $attRow['dept_id'] !== null ? (int)$attRow['dept_id'] : null;
                if ($scheduleDeptId === null || $scheduleDeptId !== (int)$authUserDept) {
                    throw new Exception('You can only manage substitutions for schedules inside your department.');
                }
            }
            if (!substitute_actor_can_manage_original_role($authUserRole, (int)($attRow['original_teacher_role_id'] ?? 0))) {
                throw new Exception((int)($attRow['original_teacher_role_id'] ?? 0) === 2
                    ? 'Only the Department Admin can manage a substitution for a Dean.'
                    : 'You are not allowed to manage substitutions for this role.');
            }
            if ((int)($attRow['flag_in_id'] ?? 0) !== 7 || (int)($attRow['flag_check_id'] ?? 0) !== 7 || (int)($attRow['flag_out_id'] ?? 0) !== 7) {
                throw new Exception("Only attendance records marked On Leave can be substituted. This class is not On Leave on {$date}.");
            }

            $leaveStmt->bind_param('is', $origUserId, $date);
            $leaveStmt->execute();
            $leaveRow = $leaveStmt->get_result()->fetch_assoc();
            if (!$leaveRow) {
                throw new Exception("No approved leave covers the original teacher's class on {$date}. Record the approved leave before assigning a substitute.");
            }

            $checkStmt->bind_param('is', $schedule_id, $date);
            $checkStmt->execute();
            if ($checkStmt->get_result()->num_rows > 0) {
                throw new Exception("A substitution for this class on $date already exists.");
            }

            $startTime = $attRow['start_time'];
            $endTime = $attRow['end_time'];
            $semesterId = (int)$attRow['semester_id'];
            $subjectId = isset($attRow['subject_id']) && $attRow['subject_id'] !== null ? (int)$attRow['subject_id'] : 0;

            $conflictStmt->bind_param('isss', $sub_id, $date, $startTime, $endTime);
            $conflictStmt->execute();
            $hasRealConflict = false;
            $conflictResult = $conflictStmt->get_result();
            while ($conflictRow = $conflictResult->fetch_assoc()) {
                $isTransferredAway = (int)($conflictRow['flag_in_id'] ?? 0) === 4
                    && (int)($conflictRow['flag_check_id'] ?? 0) === 4
                    && (int)($conflictRow['flag_out_id'] ?? 0) === 4;
                $isExactParallel = (int)($conflictRow['semester_id'] ?? 0) === $semesterId
                    && (int)($conflictRow['subject_id'] ?? 0) === $subjectId
                    && (string)$conflictRow['start_time'] === (string)$startTime
                    && (string)$conflictRow['end_time'] === (string)$endTime;
                if (!$isTransferredAway && !$isExactParallel) {
                    $hasRealConflict = true;
                    break;
                }
            }
            if ($hasRealConflict) {
                throw new Exception("The selected substitute already has an overlapping class on {$date} ({$startTime}-{$endTime}).");
            }

            foreach ($batchSlots as $slot) {
                $overlaps = $slot['date'] === $date && !($slot['end_time'] <= $startTime || $slot['start_time'] >= $endTime);
                $isExactParallel = $slot['semester_id'] === $semesterId
                    && $slot['subject_id'] === $subjectId
                    && (string)$slot['start_time'] === (string)$startTime
                    && (string)$slot['end_time'] === (string)$endTime;
                if ($overlaps && !$isExactParallel) {
                    throw new Exception("The selected substitute would have overlapping substitute classes on {$date}.");
                }
            }

            $batchSlots[] = [
                'date' => $date,
                'semester_id' => $semesterId,
                'subject_id' => $subjectId,
                'start_time' => $startTime,
                'end_time' => $endTime,
            ];
            $validatedSubs[] = [
                'attendance_id' => (int)$attRow['attendance_id'],
                'schedule_id' => $schedule_id,
                'room_id' => (int)$attRow['room_id'],
                'floor_id' => (int)$attRow['floor_id'],
                'date' => $date,
                'orig_user_id' => $origUserId,
                'leave_id' => (int)$leaveRow['leave_id'],
                'leave_type' => $leaveRow['name_type'] ?? 'Approved leave',
                'leave_date_from' => $leaveRow['date_from'],
                'leave_date_to' => $leaveRow['date_to'],
                'subject_code' => $attRow['subject_code'] ?? 'class',
                'section_name' => $attRow['section_name'] ?? '',
            ];
        }

        $inserted_count = 0;
        $createdAttendance = 0;

        foreach ($validatedSubs as $sub) {
            $schedule_id = (int)$sub['schedule_id'];
            $roomId = (int)$sub['room_id'];
            $floorId = (int)$sub['floor_id'];
            $date = (string)$sub['date'];
            $origAttendanceId = (int)$sub['attendance_id'];
            $origUserId = (int)$sub['orig_user_id'];
            $leaveId = (int)$sub['leave_id'];

            $insertStmt->bind_param('iiis', $leaveId, $schedule_id, $sub_id, $date);
            if (!$insertStmt->execute()) {
                throw new mysqli_sql_exception("Failed to insert schedule: " . $insertStmt->error);
            }
            $inserted_count++;

            $remark = 'Substitute attendance created for original attendance #' . $origAttendanceId . '.';
            $insertAttendanceStmt->bind_param('iiiiss', $sub_id, $schedule_id, $roomId, $floorId, $date, $remark);
            if (!$insertAttendanceStmt->execute()) {
                throw new mysqli_sql_exception("Failed to create attendance for the substitute teacher: " . $insertAttendanceStmt->error);
            }
            $createdAttendance++;

            $markOrigStmt->bind_param('i', $origAttendanceId);
            if (!$markOrigStmt->execute() || $markOrigStmt->affected_rows !== 1) {
                throw new mysqli_sql_exception("Failed to mark the original teacher attendance as substituted: " . $markOrigStmt->error);
            }

            if (!isset($originalTeacherScheduleCounts[$origUserId])) {
                $originalTeacherScheduleCounts[$origUserId] = 0;
            }
            $originalTeacherScheduleCounts[$origUserId]++;
        }

        $attendanceStmt->close();
        $checkStmt->close();
        $conflictStmt->close();
        $leaveStmt->close();
        $insertStmt->close();
        $insertAttendanceStmt->close();
        $markOrigStmt->close();

        // commit only after attendance creation
        $mysqli->commit();

        // =================================================================================
        // PROFESSIONAL LOGGING LOGIC
        // =================================================================================
        if ($authUserId) {
            // 1. Get Substitute's Name
            $subName = "Unknown Substitute";
            $subStmt = $mysqli->prepare("SELECT first_name, last_name FROM tbl_users WHERE user_id = ?");
            $subStmt->bind_param('i', $sub_id);
            $subStmt->execute();
            $subRes = $subStmt->get_result();
            if ($subRow = $subRes->fetch_assoc()) {
                $subName = $subRow['first_name'] . ' ' . $subRow['last_name'];
            }
            $subStmt->close();

            // 2. Get Original Teacher's Name (using the first schedule in the array)
            $origTeacherName = "Unknown Teacher";
            $first_schedule_id = (int)$substitutions[0]['schedule_id'];
            
            if ($subTeacherExpr !== 'NULL') {
                $origStmt = $mysqli->prepare("
                    SELECT u.first_name, u.last_name 
                    FROM tbl_class_schedules cs
                    {$subJoinOffering}
                    JOIN tbl_users u ON {$subTeacherExpr} = u.user_id
                    WHERE cs.schedule_id = ? LIMIT 1
                ");
                if ($origStmt) {
                    $origStmt->bind_param('i', $first_schedule_id);
                    $origStmt->execute();
                    $origRes = $origStmt->get_result();
                    if ($origRow = $origRes->fetch_assoc()) {
                        $origTeacherName = $origRow['first_name'] . ' ' . $origRow['last_name'];
                    }
                    $origStmt->close();
                }
            }

            // 3. Format the grammar based on how many classes were substituted
            if ($inserted_count === 1) {
                $logMessage = "Assigned {$subName} to substitute a class for {$origTeacherName}.";
                $logAction = 'create_substitution';
            } else {
                $logMessage = "Assigned {$subName} to substitute multiple classes for {$origTeacherName}.";
                $logAction = 'batch_substitution';
            }

            log_system_action($mysqli, $authUserId, $logAction, $logMessage);
        }
        if ($sub_id > 0) {
            $notifTitle = 'Substitution Assignment';
            $notifMessage = $inserted_count === 1
                ? 'You have been assigned as substitute teacher for 1 class.'
                : "You have been assigned as substitute teacher for {$inserted_count} classes.";
            notif_insert($mysqli, (int)$sub_id, $notifTitle, $notifMessage, '/attendance-history', $authUserId);
        }
        if (!empty($originalTeacherScheduleCounts)) {
            $origNotifTitle = 'Substitute Assigned';
            foreach ($originalTeacherScheduleCounts as $origUserIdRaw => $classCountRaw) {
                $origUserId = (int)$origUserIdRaw;
                $classCount = (int)$classCountRaw;
                if ($origUserId <= 0 || $classCount <= 0 || $origUserId === (int)$sub_id) {
                    continue;
                }
                $origNotifMessage = $classCount === 1
                    ? 'A substitute teacher has been assigned to 1 of your classes.'
                    : "A substitute teacher has been assigned to {$classCount} of your classes.";
                notif_insert($mysqli, $origUserId, $origNotifTitle, $origNotifMessage, '/attendance-history', $authUserId);
            }
        }
        // =================================================================================

        // Return a clean message to the frontend without numbers if it's just 1
        $successMsg = $inserted_count === 1 
            ? "Successfully added the substitution!" 
            : "Successfully added substitutions for multiple classes!";

        json_response(['ok'=>true, 'message'=>$successMsg], 201);   

    } catch (Exception $e) {
        $mysqli->rollback(); // Undo everything if a duplicate or error is found
        if ($e instanceof mysqli_sql_exception) {
            json_response(['ok'=>false, 'error'=>'batch_failed', 'message'=>$e->getMessage()], 500);
        }
        json_response(['ok'=>false, 'error'=>'batch_failed', 'message'=>$e->getMessage()], 409);
    }
}
json_response(['error' => 'Endpoint not found'], 404);
?>
