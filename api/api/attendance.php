<?php
// api/api/attendance.php
require_once __DIR__ . '/../helpers/socket_helper.php';
require_once __DIR__ . '/../helpers/attendance-logs.php';
require_once __DIR__ . '/../helpers/log_helper.php';
require_once __DIR__ . '/../helpers/personal_notification_helper.php';
require_once __DIR__ . '/../helpers/tardiness_penalty_helper.php';
require_once __DIR__ . '/../helpers/manual_floor_code_helper.php';
require_once __DIR__ . '/../helpers/calendar_event_helper.php';
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
$authRole = (int)($auth['role_id'] ?? 0);
$authDeptId = isset($auth['dept_id']) && $auth['dept_id'] !== null ? (int)$auth['dept_id'] : null;








// function generateAttendanceWeek($start_date_str, $end_date_str) {
//     global $mysqli;
//     $today = new DateTime();
//     $today->setTime(0, 0, 0);

//     $defaultStart = clone $today;
//     $defaultEnd = clone $today;
//     $defaultEnd->modify('+6 days');

//     $rangeStart = $start_date_str ? new DateTime($start_date_str) : $defaultStart;
//     $rangeEnd = $end_date_str ? new DateTime($end_date_str) : $defaultEnd;

//     if ($rangeEnd < $rangeStart) {
//         throw new Exception("end_date must be >= start_date");
//     }

//     $sql = "SELECT cs.schedule_id, cs.room_id, r.floor_id AS room_floor_id, cs.day_of_week, so.user_id AS teacher_id, sem.start_date, sem.end_date FROM tbl_class_schedules cs JOIN tbl_subject_offerings so ON cs.offering_id = so.offering_id JOIN tbl_semesters sem ON so.semester_id = sem.semester_id JOIN tbl_rooms r ON cs.room_id = r.room_id";
//     $schedules_result = $mysqli->query($sql);
//     $schedules = $schedules_result->fetch_all(MYSQLI_ASSOC);

//     $dayMap = ['sunday' => 0, 'monday' => 1, 'tuesday' => 2, 'wednesday' => 3, 'thursday' => 4, 'friday' => 5, 'saturday' => 6];
//     $totalInserted = 0;

//     foreach ($schedules as $row) {
//         $targetDow = $dayMap[strtolower($row['day_of_week'])] ?? -1;
//         if ($targetDow === -1) continue;

//         $semStart = new DateTime($row['start_date']);
//         $semEnd = new DateTime($row['end_date']);
        
//         $effStart = max($rangeStart, $semStart);
//         $effEnd = min($rangeEnd, $semEnd);
        
//         if ($effEnd < $effStart) continue;
        
//         $currentDate = clone $effStart;
//         while ($currentDate <= $effEnd) {
//             if ((int)$currentDate->format('w') === $targetDow) {
//                 $dateStr = $currentDate->format('Y-m-d');
//                 $stmt = $mysqli->prepare("INSERT INTO tbl_attendance_records (user_id, schedule_id, room_id, floor_id, date, flag_in_id, flag_check_id, flag_out_id) SELECT ?, ?, ?, ?, ?, 1, 1, 1 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM tbl_attendance_records WHERE user_id = ? AND schedule_id = ? AND date = ?)");
//                 $stmt->bind_param("iiiisiss", $row['teacher_id'], $row['schedule_id'], $row['room_id'], $row['room_floor_id'], $dateStr, $row['teacher_id'], $row['schedule_id'], $dateStr);
//                 $stmt->execute();
//                 $totalInserted += $stmt->affected_rows;
//             }
//             $currentDate->modify('+1 day');
//         }
//     }
//     return [
//         'inserted' => $totalInserted,
//         'rangeStart' => $rangeStart->format('Y-m-d'),
//         'rangeEnd' => $rangeEnd->format('Y-m-d'),
//     ];
// }










// Add a small helper to bind params safely using references (call_user_func_array)
function safe_bind_params($stmt, $types, $params) {
    // prepare array of references: first element is types string
    $refs = [];
    $refs[] = &$types;
    // bind_param requires variables passed by reference
    foreach ($params as $k => $v) {
        // ensure we have variables (not literals) to reference
        $refs[] = &$params[$k];
    }
    return call_user_func_array([$stmt, 'bind_param'], $refs);
}

// --- ROUTING within attendance.php ---
// When included from another PHP script (e.g. to call generateAttendanceWeek),
// callers can set $GLOBALS['SKIP_ATTENDANCE_ROUTING'] = true to prevent the
// routing logic below from running (which would call json_response() and exit).
if (empty($GLOBALS['SKIP_ATTENDANCE_ROUTING'])) {

// Auto-reset temporary floor overrides for attendance records whose class end time already passed
// This ensures the 'temporary floor' set during checks is cleared after class end.
$mysqli->query("UPDATE tbl_attendance_records ar JOIN tbl_class_schedules cs ON ar.schedule_id = cs.schedule_id JOIN tbl_rooms r ON ar.room_id = r.room_id SET ar.floor_id = r.floor_id WHERE TIMESTAMP(ar.date, cs.end_time) < NOW() AND ar.floor_id != r.floor_id");

// --- DISABLED: automatic generation function removed per request ---
// The generateAttendanceWeek function remains available if included directly, but its
// automatic invocation and any exposed endpoints that create attendance rows have been
// intentionally disabled to prevent automatic insertion of attendance records.

// To re-enable generation, set $GLOBALS['ENABLE_AUTOGEN'] = true before including this file
// or call generateAttendanceWeek(...) manually from a controlled script.

if ($request_method === 'POST' && $endpoint === 'attendance' && $param1 === 'verify-floor-code') {
    manual_floor_code_ensure_schema($mysqli);
    $manualCode = manual_floor_code_normalize($input['manual_code'] ?? '');
    $floor = null;
    if (preg_match('/^[A-Z0-9]{6,16}$/', $manualCode)) {
        $stmt = $mysqli->prepare("SELECT f.floor_id, f.floor_name, f.qr_token, f.manual_code, f.status,
                b.building_id, b.building_name, b.status AS building_status,
                b.school_id, s.status AS school_status
            FROM tbl_floors f
            JOIN tbl_buildings b ON b.building_id = f.building_id
            LEFT JOIN tbl_school s ON s.school_id = b.school_id
            WHERE f.manual_code = ? LIMIT 1");
        if (!$stmt) json_response(['ok' => false, 'error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        $stmt->bind_param('s', $manualCode);
        $stmt->execute();
        $floor = $stmt->get_result()->fetch_assoc();
        $stmt->close();
    }

    $active = $floor
        && strtolower(trim((string)($floor['status'] ?? ''))) === 'active'
        && strtolower(trim((string)($floor['building_status'] ?? ''))) === 'active'
        && (empty($floor['school_id']) || strtolower(trim((string)($floor['school_status'] ?? ''))) === 'active');

    if (!$active) {
        json_response([
            'ok' => false,
            'error' => 'manual_code_invalid',
            'message' => 'Manual floor code is not recognized.',
        ], 422);
    }

    json_response([
        'ok' => true,
        'floor_id' => (int)$floor['floor_id'],
        'floor_name' => $floor['floor_name'],
        'building_id' => (int)$floor['building_id'],
        'building_name' => $floor['building_name'],
        'qr_token' => $floor['qr_token'],
        'manual_code' => $floor['manual_code'],
        'status' => $floor['status'],
    ]);

} elseif ($request_method === 'GET' && $endpoint === 'attendance') {
    $includeAvatar = !isset($_GET['include_avatar']) || (string)$_GET['include_avatar'] !== '0';
    $avatarSelect = $includeAvatar
        ? "NULLIF(CAST(u.image AS CHAR), '') AS avatar,"
        : '';
    // Required attendance schema is validated by the additive migration. Avoid
    // repeating SHOW TABLES/SHOW COLUMNS discovery on every five-second refresh.
    $subjectExpr = 'cs.subject_id';
    $sectionExpr = 'cs.section_id';

    // This GET endpoint is confirmed to be correct.
    $selectSql = "
      SELECT
        ar.attendance_id,
        ar.user_id,
        ar.schedule_id,
        ar.room_id,
        ar.floor_id,
        DATE_FORMAT(ar.date, '%Y-%m-%d') AS date,
        cs.semester_id,
        cs.day_of_week,
        {$subjectExpr} AS subject_id,
        {$sectionExpr} AS section_id,
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
        u.first_name,
        u.last_name,
        u.status AS user_status,
        {$avatarSelect}
        u.dept_id,
        d.dept_name,
        d.sub_name AS department_sub_name,
        cs.start_time,
        cs.end_time,
        r.room_name,
        sc.school_name AS campus_name,
        sc.school_name AS school_name,
        b.building_name,
        COALESCE(f.floor_name, rf.floor_name) AS floor_name,
        s.subject_code,
        s.subject_name,
        sec.section_name,
        COALESCE(s.program_id, sec.program_id) AS program_id,
        p.program_name,
        p.sub_name AS program_sub_name,
        ft_in.flag_name AS flag_in_name,
        ft_check.flag_name AS flag_check_name,
        ft_out.flag_name AS flag_out_name,
        f.floor_name AS attendance_floor_name
    ";
    $fromSql = "
      FROM tbl_attendance_records ar
      JOIN tbl_users u              ON ar.user_id = u.user_id
      LEFT JOIN tbl_departments d   ON u.dept_id = d.dept_id
      JOIN tbl_class_schedules cs   ON ar.schedule_id = cs.schedule_id
      JOIN tbl_rooms r              ON ar.room_id = r.room_id
      LEFT JOIN tbl_floors f        ON ar.floor_id = f.floor_id
      LEFT JOIN tbl_floors rf       ON r.floor_id = rf.floor_id
      LEFT JOIN tbl_buildings b     ON r.building_id = b.building_id
      LEFT JOIN tbl_school sc       ON b.school_id = sc.school_id
      LEFT JOIN tbl_subject s       ON {$subjectExpr} = s.subject_id
      LEFT JOIN tbl_sections sec    ON {$sectionExpr} = sec.section_id
      LEFT JOIN tbl_programs p      ON p.program_id = COALESCE(s.program_id, sec.program_id)
      LEFT JOIN tbl_departments pd  ON pd.dept_id = p.dept_id
      LEFT JOIN tbl_programs section_program ON section_program.program_id = sec.program_id
      LEFT JOIN tbl_departments section_department ON section_department.dept_id = section_program.dept_id
      LEFT JOIN tbl_semesters sem   ON sem.semester_id = cs.semester_id
      LEFT JOIN tbl_school_year sy  ON sy.school_year_id = sem.school_year_id
      LEFT JOIN tbl_flag_types ft_in    ON ar.flag_in_id = ft_in.flag_id
      LEFT JOIN tbl_flag_types ft_check ON ar.flag_check_id = ft_check.flag_id
      LEFT JOIN tbl_flag_types ft_out   ON ar.flag_out_id = ft_out.flag_id
    ";
    $sql = $selectSql . $fromSql;
    $where = ['u.role_id IN (2, 3, 4, 5)']; $params = []; $types = '';
    $operationalOnly = isset($_GET['operational_only'])
        && in_array(strtolower(trim((string)$_GET['operational_only'])), ['1', 'true', 'yes'], true);
    if ($operationalOnly) {
        $where[] = "LOWER(TRIM(COALESCE(u.status, ''))) IN ('active', '1', 'true')";
        $where[] = "LOWER(TRIM(COALESCE(d.status, ''))) IN ('active', '1', 'true')";
        $where[] = "LOWER(TRIM(COALESCE(sem.status, ''))) IN ('active', '1', 'true')";
        $where[] = "LOWER(TRIM(COALESCE(sy.status, ''))) IN ('active', '1', 'true')";
        $where[] = 'ar.date BETWEEN sem.start_date AND sem.end_date';
        $where[] = "LOWER(TRIM(COALESCE(r.status, ''))) IN ('active', '1', 'true')";
        $where[] = "LOWER(TRIM(COALESCE(rf.status, ''))) IN ('active', '1', 'true')";
        $where[] = "LOWER(TRIM(COALESCE(b.status, ''))) IN ('active', '1', 'true')";
        $where[] = "(b.school_id IS NULL OR LOWER(TRIM(COALESCE(sc.status, ''))) IN ('active', '1', 'true'))";
        $where[] = "LOWER(TRIM(COALESCE(s.status, ''))) IN ('active', '1', 'true')";
        $where[] = "LOWER(TRIM(COALESCE(sec.status, ''))) IN ('active', '1', 'true')";
        $where[] = "LOWER(TRIM(COALESCE(p.status, ''))) IN ('active', '1', 'true')";
        $where[] = "LOWER(TRIM(COALESCE(pd.status, ''))) IN ('active', '1', 'true')";
        $where[] = "LOWER(TRIM(COALESCE(section_program.status, ''))) IN ('active', '1', 'true')";
        $where[] = "LOWER(TRIM(COALESCE(section_department.status, ''))) IN ('active', '1', 'true')";
    }
    $validateDateFilter = function($value) {
        if (!is_string($value) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)) return false;
        [$year, $month, $day] = array_map('intval', explode('-', $value));
        return checkdate($month, $day, $year);
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

    $resolveUserDeptId = function($userId) use ($mysqli) {
        $uid = (int)$userId;
        if ($uid <= 0) return null;
        $deptId = null;

        $uStmt = $mysqli->prepare("SELECT dept_id FROM tbl_users WHERE user_id = ? LIMIT 1");
        if ($uStmt) {
            $uStmt->bind_param('i', $uid);
            $uStmt->execute();
            $uRow = $uStmt->get_result()->fetch_assoc();
            if ($uRow && isset($uRow['dept_id']) && $uRow['dept_id'] !== null) {
                $deptId = (int)$uRow['dept_id'];
            }
        }

        if ($deptId !== null) return $deptId;

        $dStmt = $mysqli->prepare("SELECT dept_id FROM tbl_departments WHERE dean_id = ? LIMIT 1");
        if ($dStmt) {
            $dStmt->bind_param('i', $uid);
            $dStmt->execute();
            $dRow = $dStmt->get_result()->fetch_assoc();
            if ($dRow && isset($dRow['dept_id']) && $dRow['dept_id'] !== null) {
                return (int)$dRow['dept_id'];
            }
        }

        return null;
    };

    $resolveProgramHeadProgramIds = function($userId) use ($mysqli) {
        $uid = (int)$userId;
        if ($uid <= 0) return [];
        $programIds = [];

        $pStmt = $mysqli->prepare("SELECT assigned_program_head_id AS program_id FROM tbl_users WHERE user_id = ? AND role_id = 3 AND assigned_program_head_id IS NOT NULL UNION SELECT program_id FROM tbl_programs WHERE head_id = ?");
        if ($pStmt) {
            $pStmt->bind_param('ii', $uid, $uid);
            $pStmt->execute();
            $res = $pStmt->get_result();
            if ($res) {
                while ($row = $res->fetch_assoc()) {
                    $pid = isset($row['program_id']) ? (int)$row['program_id'] : 0;
                    if ($pid > 0) $programIds[] = $pid;
                }
            }
        }

        $programIds = array_values(array_unique(array_filter($programIds, function($v){ return (int)$v > 0; })));
        return $programIds;
    };

    // Teachers: allow only access to their own attendance rows (GET requests)
    if ($authRole === 5) {
        // If caller didn't specify teacher_id, default it to the authenticated user
        if (empty($_GET['teacher_id'])) {
            $_GET['teacher_id'] = $authUserId;
        }
        // If a teacher tries to request other teacher's data, forbid
        if (!empty($_GET['teacher_id']) && (int)$_GET['teacher_id'] !== (int)$authUserId) {
            json_response(['error' => 'forbidden', 'message' => 'Teachers can only access their own attendance'], 403);
        }
        // otherwise allow to continue and the later WHERE clause will filter by ar.user_id
    }

    // Dean, department admin, and secretary: restrict to their department
    if (in_array($authRole, [2,4,6], true)) {
        $deptId = $resolveUserDeptId($authUserId);
        if ($deptId !== null) {
            $where[] = 'u.dept_id = ?';
            $params[] = $deptId;
            $types .= 'i';
        } else {
            json_response([], 200);
        }
    }

    // Program head: restrict to assigned program(s)
    if ((int)$authRole === 3) {
        $programIds = $resolveProgramHeadProgramIds($authUserId);
        if (empty($programIds)) {
            json_response([], 200);
        }

        $programExpr = 'COALESCE(s.program_id, sec.program_id)';

        $placeholders = implode(',', array_fill(0, count($programIds), '?'));
        $where[] = "{$programExpr} IN ({$placeholders})";
        foreach ($programIds as $pid) {
            $params[] = (int)$pid;
            $types .= 'i';
        }
    }

    $filterDepartmentId = null;
    if (isset($_GET['department_id']) && $_GET['department_id'] !== '') {
        if (!is_numeric($_GET['department_id']) || (int)$_GET['department_id'] <= 0) {
            json_response(['error' => 'validation', 'message' => 'department_id must be a positive number.'], 400);
        }
        $filterDepartmentId = (int)$_GET['department_id'];
    }
    $filterProgramId = null;
    if (isset($_GET['program_id']) && $_GET['program_id'] !== '') {
        if (!is_numeric($_GET['program_id']) || (int)$_GET['program_id'] <= 0) {
            json_response(['error' => 'validation', 'message' => 'program_id must be a positive number.'], 400);
        }
        $filterProgramId = (int)$_GET['program_id'];
    }

    if ($filterDepartmentId !== null) {
        if (in_array($authRole, [2, 3, 4, 6], true)) {
            $scopedDeptId = $resolveUserDeptId($authUserId);
            if ($scopedDeptId === null || $filterDepartmentId !== (int)$scopedDeptId) {
                json_response(['error' => 'forbidden_department', 'message' => 'The selected department is outside your assigned scope.'], 403);
            }
        }
        $where[] = 'u.dept_id = ?';
        $params[] = $filterDepartmentId;
        $types .= 'i';
    }

    if ($filterProgramId !== null) {
        if ($authRole === 3) {
            $ownedProgramIds = $resolveProgramHeadProgramIds($authUserId);
            if (!in_array($filterProgramId, $ownedProgramIds, true)) {
                json_response(['error' => 'forbidden_program', 'message' => 'The selected program is outside your assigned scope.'], 403);
            }
        } elseif (in_array($authRole, [2, 4, 6], true)) {
            $scopedDeptId = $resolveUserDeptId($authUserId);
            $programScopeStmt = $mysqli->prepare('SELECT program_id FROM tbl_programs WHERE program_id = ? AND dept_id = ? LIMIT 1');
            if (!$programScopeStmt) json_response(['error' => 'db_prepare_failed', 'message' => $mysqli->error], 500);
            $programScopeStmt->bind_param('ii', $filterProgramId, $scopedDeptId);
            $programScopeStmt->execute();
            $programInScope = $programScopeStmt->get_result()->fetch_assoc();
            $programScopeStmt->close();
            if (!$programInScope) {
                json_response(['error' => 'forbidden_program', 'message' => 'The selected program is outside your department.'], 403);
            }
        }
        $where[] = 'COALESCE(s.program_id, sec.program_id) = ?';
        $params[] = $filterProgramId;
        $types .= 'i';
    }

    if (!empty($_GET['date'])) { $where[] = 'ar.date = ?'; $params[] = $_GET['date']; $types .= 's'; }
    if ($dateFrom !== '') { $where[] = 'ar.date >= ?'; $params[] = $dateFrom; $types .= 's'; }
    if ($dateTo !== '') { $where[] = 'ar.date <= ?'; $params[] = $dateTo; $types .= 's'; }
    if ($filterSemesterId !== null) { $where[] = 'cs.semester_id = ?'; $params[] = $filterSemesterId; $types .= 'i'; }
    foreach ([
        'campus_name' => 'sc.school_name',
        'building_name' => 'b.building_name',
        'floor_name' => 'COALESCE(f.floor_name, rf.floor_name)',
        'room_name' => 'r.room_name',
    ] as $queryKey => $columnExpression) {
        $filterValue = trim((string)($_GET[$queryKey] ?? ''));
        if ($filterValue === '') continue;
        $where[] = "LOWER(TRIM({$columnExpression})) = LOWER(TRIM(?))";
        $params[] = $filterValue;
        $types .= 's';
    }
    $searchValue = trim((string)($_GET['search'] ?? ''));
    if ($searchValue !== '') {
        $likeValue = '%' . $searchValue . '%';
        $where[] = "(CONCAT_WS(' ', u.first_name, u.last_name) LIKE ?
            OR CAST(ar.user_id AS CHAR) LIKE ?
            OR s.subject_code LIKE ?
            OR s.subject_name LIKE ?
            OR sec.section_name LIKE ?
            OR r.room_name LIKE ?
            OR b.building_name LIKE ?
            OR d.dept_name LIKE ?)";
        for ($searchIndex = 0; $searchIndex < 8; $searchIndex++) {
            $params[] = $likeValue;
            $types .= 's';
        }
    }
    $recordStatusCase = "CASE
        WHEN ar.flag_in_id = 3 OR ar.flag_check_id = 3 OR ar.flag_out_id = 3 THEN 'absent'
        WHEN ar.flag_in_id = 7 OR ar.flag_check_id = 7 OR ar.flag_out_id = 7 THEN 'on_leave'
        WHEN ar.flag_in_id = 4 OR ar.flag_check_id = 4 OR ar.flag_out_id = 4 THEN 'substituted'
        WHEN ar.flag_in_id = 5 OR ar.flag_check_id = 5 OR ar.flag_out_id = 5 THEN 'late'
        WHEN ar.flag_in_id = 2 AND ar.flag_check_id = 2 AND ar.flag_out_id = 2 THEN 'present'
        WHEN ar.flag_in_id = 8 OR ar.flag_check_id = 8 OR ar.flag_out_id = 8 THEN 'pending'
        ELSE 'upcoming'
    END";
    $overallStatusCase = "CASE
        WHEN ((ar.flag_in_id = 2) + (ar.flag_check_id = 2) + (ar.flag_out_id = 2)) >= 2 THEN 'present'
        WHEN ((ar.flag_in_id = 5) + (ar.flag_check_id = 5) + (ar.flag_out_id = 5)) >= 2 THEN 'late'
        WHEN ((ar.flag_in_id = 3) + (ar.flag_check_id = 3) + (ar.flag_out_id = 3)) >= 2 THEN 'absent'
        WHEN ((ar.flag_in_id = 7) + (ar.flag_check_id = 7) + (ar.flag_out_id = 7)) >= 2 THEN 'on_leave'
        WHEN ((ar.flag_in_id = 4) + (ar.flag_check_id = 4) + (ar.flag_out_id = 4)) >= 2 THEN 'substituted'
        WHEN ((ar.flag_in_id = 8) + (ar.flag_check_id = 8) + (ar.flag_out_id = 8)) >= 2 THEN 'pending'
        WHEN ((ar.flag_in_id = 1) + (ar.flag_check_id = 1) + (ar.flag_out_id = 1)) >= 2 THEN 'upcoming'
        ELSE 'incomplete'
    END";
    $useOverallStatus = strtolower(trim((string)($_GET['status_mode'] ?? ''))) === 'overall';
    $selectedStatusCase = $useOverallStatus ? $overallStatusCase : $recordStatusCase;
    if (!empty($_GET['teacher_id'])) { $where[] = 'ar.user_id = ?'; $params[] = (int)$_GET['teacher_id']; $types .= 'i'; }
    $summaryWhere = $where;
    $summaryParams = $params;
    $summaryTypes = $types;
    if (!empty($_GET['status'])) {
        // Use the same record-level status priority as the React page. This
        // prevents a paginated response from containing rows the browser then
        // has to discard because only one checkpoint happened to match.
        $normalizedStatus = strtolower(str_replace(' ', '_', trim((string)$_GET['status'])));
        $allowedStatuses = ['absent', 'on_leave', 'substituted', 'late', 'present', 'pending', 'upcoming'];
        if ($useOverallStatus) $allowedStatuses[] = 'incomplete';
        if (!in_array($normalizedStatus, $allowedStatuses, true)) {
            json_response(['error' => 'validation', 'message' => 'Unknown attendance status.'], 400);
        }
        $where[] = "({$selectedStatusCase}) = ?";
        $params[] = $normalizedStatus;
        $types .= 's';
    }
    $whereSql = !empty($where) ? ' WHERE ' . implode(' AND ', $where) : '';
    $summaryWhereSql = !empty($summaryWhere) ? ' WHERE ' . implode(' AND ', $summaryWhere) : '';
    $sql .= $whereSql;

    $logView = isset($_GET['log_view'])
        && in_array(strtolower(trim((string)$_GET['log_view'])), ['1', 'true', 'yes'], true);
    $paginate = !$logView && isset($_GET['paginate'])
        && in_array(strtolower(trim((string)$_GET['paginate'])), ['1', 'true', 'yes'], true);
    $page = 1;
    $pageSize = 25;
    $summary = null;
    $totalRows = null;

    if ($paginate) {
        $page = isset($_GET['page']) && is_numeric($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        $pageSize = isset($_GET['page_size']) && is_numeric($_GET['page_size'])
            ? max(1, min(100, (int)$_GET['page_size']))
            : 25;

        // Calculate compact totals from SQL instead of sending every row to
        // the browser just so the dashboard cards can count them in JavaScript.
        $summarySql = "SELECT
                COUNT(*) AS total_records,
                COUNT(DISTINCT summary_rows.user_id) AS teacher_count,
                SUM(summary_rows.record_status = 'present') AS status_present,
                SUM(summary_rows.record_status = 'late') AS status_late,
                SUM(summary_rows.record_status = 'absent') AS status_absent,
                SUM(summary_rows.record_status = 'on_leave') AS status_on_leave,
                SUM(summary_rows.record_status = 'substituted') AS status_substituted,
                SUM(summary_rows.record_status = 'pending') AS status_pending,
                SUM(summary_rows.record_status = 'upcoming') AS status_upcoming,
                SUM(summary_rows.record_status = 'incomplete') AS status_incomplete,
                SUM(summary_rows.flag_in_id = 2) AS in_present,
                SUM(summary_rows.flag_in_id = 5) AS in_late,
                SUM(summary_rows.flag_in_id = 3) AS in_absent,
                SUM(summary_rows.flag_in_id = 7) AS in_on_leave,
                SUM(summary_rows.flag_in_id = 4) AS in_substituted,
                SUM(summary_rows.flag_in_id = 8) AS in_pending,
                SUM(summary_rows.flag_in_id NOT IN (2,3,4,5,7,8) OR summary_rows.flag_in_id IS NULL) AS in_upcoming,
                SUM(summary_rows.flag_check_id = 2) AS mid_present,
                SUM(summary_rows.flag_check_id = 5) AS mid_late,
                SUM(summary_rows.flag_check_id = 3) AS mid_absent,
                SUM(summary_rows.flag_check_id = 7) AS mid_on_leave,
                SUM(summary_rows.flag_check_id = 4) AS mid_substituted,
                SUM(summary_rows.flag_check_id = 8) AS mid_pending,
                SUM(summary_rows.flag_check_id NOT IN (2,3,4,5,7,8) OR summary_rows.flag_check_id IS NULL) AS mid_upcoming,
                SUM(summary_rows.flag_out_id = 2) AS out_present,
                SUM(summary_rows.flag_out_id = 5) AS out_late,
                SUM(summary_rows.flag_out_id = 3) AS out_absent,
                SUM(summary_rows.flag_out_id = 7) AS out_on_leave,
                SUM(summary_rows.flag_out_id = 4) AS out_substituted,
                SUM(summary_rows.flag_out_id = 8) AS out_pending,
                SUM(summary_rows.flag_out_id NOT IN (2,3,4,5,7,8) OR summary_rows.flag_out_id IS NULL) AS out_upcoming
            FROM (
                SELECT ar.user_id, ar.flag_in_id, ar.flag_check_id, ar.flag_out_id,
                       {$selectedStatusCase} AS record_status
                {$fromSql}
                {$summaryWhereSql}
            ) summary_rows";
        $summaryStmt = $mysqli->prepare($summarySql);
        if ($summaryStmt === false) {
            json_response(['error' => 'Failed to prepare attendance summary', 'sql_error' => $mysqli->error], 500);
        }
        if (!empty($summaryParams)) safe_bind_params($summaryStmt, $summaryTypes, $summaryParams);
        if (!$summaryStmt->execute()) {
            json_response(['error' => 'Failed to execute attendance summary', 'stmt_error' => $summaryStmt->error], 500);
        }
        $summaryRow = $summaryStmt->get_result()->fetch_assoc() ?: [];
        $summaryStmt->close();

        $scopedTotalRows = (int)($summaryRow['total_records'] ?? 0);
        $totalRows = $scopedTotalRows;
        if (!empty($_GET['status'])) {
            $countStmt = $mysqli->prepare("SELECT COUNT(*) AS total_records {$fromSql} {$whereSql}");
            if ($countStmt === false) {
                json_response(['error' => 'Failed to prepare attendance count', 'sql_error' => $mysqli->error], 500);
            }
            if (!empty($params)) safe_bind_params($countStmt, $types, $params);
            if (!$countStmt->execute()) {
                json_response(['error' => 'Failed to execute attendance count', 'stmt_error' => $countStmt->error], 500);
            }
            $countRow = $countStmt->get_result()->fetch_assoc() ?: [];
            $countStmt->close();
            $totalRows = (int)($countRow['total_records'] ?? 0);
        }
        $totalPages = max(1, (int)ceil($totalRows / $pageSize));
        $page = min($page, $totalPages);
        $offset = ($page - 1) * $pageSize;

        $statusKeys = ['present', 'late', 'absent', 'on_leave', 'substituted', 'pending', 'upcoming'];
        if ($useOverallStatus) $statusKeys[] = 'incomplete';
        $statusCounts = [];
        foreach ($statusKeys as $statusKey) {
            $statusCounts[$statusKey] = (int)($summaryRow['status_' . $statusKey] ?? 0);
        }
        $checkpointCounts = [];
        foreach (['in', 'mid', 'out'] as $checkpointKey) {
            $counts = [];
            foreach ($statusKeys as $statusKey) {
                $counts[$statusKey] = (int)($summaryRow[$checkpointKey . '_' . $statusKey] ?? 0);
            }
            $checkpointCounts[$checkpointKey] = ['total' => $scopedTotalRows, 'counts' => $counts];
        }
        $completedCheckpoints = 0;
        foreach ($checkpointCounts as $checkpoint) {
            $completedCheckpoints += max(0, $checkpoint['total'] - $checkpoint['counts']['upcoming'] - $checkpoint['counts']['pending']);
        }
        $totalCheckpoints = $scopedTotalRows * 3;
        $summary = [
            'total_records' => $scopedTotalRows,
            'teacher_count' => (int)($summaryRow['teacher_count'] ?? 0),
            'completion_rate' => $totalCheckpoints > 0 ? (int)round(($completedCheckpoints / $totalCheckpoints) * 100) : 0,
            'status_counts' => $statusCounts,
            'checkpoints' => $checkpointCounts,
        ];
    }

    // The live management view prioritizes today, followed by the nearest
    // upcoming dates and then the most recent past dates. Historical callers
    // retain the conventional newest-first order.
    $currentFirst = isset($_GET['current_first'])
        && in_array(strtolower(trim((string)$_GET['current_first'])), ['1', 'true', 'yes'], true);
    if ($currentFirst) {
        $sql .= " ORDER BY
            CASE WHEN ar.date = CURDATE() THEN 0 WHEN ar.date > CURDATE() THEN 1 ELSE 2 END,
            CASE WHEN ar.date >= CURDATE() THEN ar.date END ASC,
            CASE WHEN ar.date < CURDATE() THEN ar.date END DESC,
            cs.start_time, u.last_name, u.first_name, ar.attendance_id";
    } else {
        // Keep tied parallel-class rows deterministic so their ETag and React
        // list order do not change between otherwise identical refreshes.
        $sql .= ' ORDER BY ar.date DESC, cs.start_time, u.last_name, u.first_name, ar.attendance_id';
    }
    if ($paginate) $sql .= ' LIMIT ? OFFSET ?';

    $stmt = $mysqli->prepare($sql);
    if ($stmt === false) {
        json_response(['error' => 'Failed to prepare attendance query', 'sql_error' => $mysqli->error, 'sql' => $sql], 500);
    }

    // If we only have a single integer dept param (common RBAC case), bind it explicitly to avoid variadic/reference issues
    if ($paginate) {
        $params[] = $pageSize;
        $params[] = $offset;
        $types .= 'ii';
    }
    if (!empty($params)) {
        // fallback to safe helper (already defined in file)
        safe_bind_params($stmt, $types, $params);
    }
    if (!$stmt->execute()) {
        json_response(['error' => 'Failed to execute attendance query', 'stmt_error' => $stmt->error], 500);
    }
    $res = $stmt->get_result();
    if ($res === false) {
        error_log('attendance: get_result returned false, stmt_error=' . $stmt->error);
        json_response(['error' => 'Failed to fetch attendance result', 'stmt_error' => $stmt->error], 500);
    }
    $rows = $res->fetch_all(MYSQLI_ASSOC);
    if ($logView) {
        $logPage = isset($_GET['page']) && is_numeric($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        $logPageSize = isset($_GET['page_size']) && is_numeric($_GET['page_size'])
            ? max(1, min(50, (int)$_GET['page_size']))
            : 15;
        $logStatusFilter = strtoupper(trim((string)($_GET['log_status'] ?? 'RECENT')));
        $checkpointStatus = function($flagId, $flagName) {
            $id = (int)$flagId;
            $name = strtoupper(str_replace([' ', '-'], '_', trim((string)$flagName)));
            if (in_array($name, ['PRESENT', 'LATE', 'ABSENT', 'SUBSTITUTED', 'ON_LEAVE', 'UPCOMING', 'PENDING'], true)) return $name;
            $byId = [1 => 'UPCOMING', 2 => 'PRESENT', 3 => 'ABSENT', 4 => 'SUBSTITUTED', 5 => 'LATE', 7 => 'ON_LEAVE', 8 => 'PENDING'];
            return $byId[$id] ?? 'PENDING';
        };
        $overallStatus = function(array $row) use ($checkpointStatus) {
            $statuses = [
                $checkpointStatus($row['flag_in_id'] ?? null, $row['flag_in_name'] ?? ''),
                $checkpointStatus($row['flag_check_id'] ?? null, $row['flag_check_name'] ?? ''),
                $checkpointStatus($row['flag_out_id'] ?? null, $row['flag_out_name'] ?? ''),
            ];
            $counts = array_count_values($statuses);
            foreach ($statuses as $status) {
                if (($counts[$status] ?? 0) >= 2) return $status;
            }
            return 'INCOMPLETE';
        };
        $clockValue = function($value) {
            $raw = trim((string)$value);
            if ($raw === '') return '';
            if (preg_match('/(?:T|\\s|^)(\\d{1,2}):(\\d{2})/', $raw, $match)) {
                $hour = (int)$match[1];
                $suffix = $hour >= 12 ? 'PM' : 'AM';
                $hour %= 12;
                if ($hour === 0) $hour = 12;
                return $hour . ':' . $match[2] . ' ' . $suffix;
            }
            return $raw;
        };
        usort($rows, function($left, $right) {
            $leftTime = $left['time_out'] ?: ($left['time_check'] ?: ($left['time_in'] ?: ($left['end_time'] ?: $left['start_time'])));
            $rightTime = $right['time_out'] ?: ($right['time_check'] ?: ($right['time_in'] ?: ($right['end_time'] ?: $right['start_time'])));
            $leftKey = (string)($left['date'] ?? '') . ' ' . (string)$leftTime;
            $rightKey = (string)($right['date'] ?? '') . ' ' . (string)$rightTime;
            return strcmp($rightKey, $leftKey);
        });
        $parallelCounts = [];
        foreach ($rows as $row) {
            $parallelKey = implode('|', [
                (string)($row['user_id'] ?? ''),
                (string)($row['semester_id'] ?? ''),
                (string)($row['subject_id'] ?? ''),
                (string)($row['date'] ?? ''),
                substr((string)($row['start_time'] ?? ''), 0, 5),
                substr((string)($row['end_time'] ?? ''), 0, 5),
            ]);
            $parallelCounts[$parallelKey] = ($parallelCounts[$parallelKey] ?? 0) + 1;
        }
        $logs = [];
        foreach ($rows as $rowIndex => $row) {
            $teacherName = trim((string)($row['first_name'] ?? '') . ' ' . (string)($row['last_name'] ?? ''));
            if ($teacherName === '') $teacherName = 'Teacher';
            $parallelKey = implode('|', [
                (string)($row['user_id'] ?? ''),
                (string)($row['semester_id'] ?? ''),
                (string)($row['subject_id'] ?? ''),
                (string)($row['date'] ?? ''),
                substr((string)($row['start_time'] ?? ''), 0, 5),
                substr((string)($row['end_time'] ?? ''), 0, 5),
            ]);
            $isParallel = ($parallelCounts[$parallelKey] ?? 0) > 1;
            $attendanceKey = (string)($row['attendance_id'] ?? ($row['schedule_id'] ?? $rowIndex));
            $common = [
                'teacherName' => $teacherName,
                'roomName' => (string)($row['room_name'] ?? '-'),
                'campusName' => (string)($row['campus_name'] ?? ''),
                'buildingName' => (string)($row['building_name'] ?? ''),
                'floorName' => (string)($row['floor_name'] ?? ''),
                'avatar' => 'avatar-thumbnail.php?user_id=' . (int)($row['user_id'] ?? 0),
                'subjectLabel' => trim((string)($row['subject_code'] ?? '') . ' ' . (string)($row['subject_name'] ?? '')) ?: 'Subject not specified',
                'sectionName' => (string)($row['section_name'] ?? 'Section not specified'),
                'isParallel' => $isParallel,
                'parallelGroupKey' => $isParallel ? $parallelKey : '',
                'highlightGroupKey' => $isParallel ? 'parallel:' . $parallelKey : 'attendance:' . $attendanceKey,
                'record' => $row,
            ];
            if (strpos($logStatusFilter, 'OVERALL') === 0) {
                $status = $overallStatus($row);
                if ($logStatusFilter !== 'OVERALL' && $status !== substr($logStatusFilter, 8)) continue;
                $latest = $row['time_out'] ?: ($row['time_check'] ?: ($row['time_in'] ?? ''));
                $timeLabel = $latest ? $clockValue($latest) : (($row['start_time'] ?? '') && ($row['end_time'] ?? '') ? $clockValue($row['start_time']) . ' - ' . $clockValue($row['end_time']) : '');
                $logs[] = array_merge($common, [
                    'id' => 'overall-' . $attendanceKey,
                    'type' => 'OVERALL',
                    'status' => $status,
                    'timeLabel' => $timeLabel,
                    'timeKind' => $latest ? 'single' : ($timeLabel !== '' ? 'range' : 'none'),
                ]);
                continue;
            }
            foreach ([
                ['key' => 'in', 'label' => 'CHECK IN', 'flag_id' => 'flag_in_id', 'flag_name' => 'flag_in_name', 'time' => 'time_in'],
                ['key' => 'mid', 'label' => 'CHECK MID', 'flag_id' => 'flag_check_id', 'flag_name' => 'flag_check_name', 'time' => 'time_check'],
                ['key' => 'out', 'label' => 'CHECK OUT', 'flag_id' => 'flag_out_id', 'flag_name' => 'flag_out_name', 'time' => 'time_out'],
            ] as $checkpoint) {
                $status = $checkpointStatus($row[$checkpoint['flag_id']] ?? null, $row[$checkpoint['flag_name']] ?? '');
                $matches = $logStatusFilter === 'RECENT'
                    ? in_array($status, ['PRESENT', 'LATE', 'ABSENT'], true)
                    : ($logStatusFilter === 'OTHER'
                        ? !in_array($status, ['PRESENT', 'LATE', 'ABSENT'], true)
                        : $status === $logStatusFilter);
                if (!$matches) continue;
                $actualTime = $row[$checkpoint['time']] ?? '';
                if ($status === 'ABSENT') {
                    $timeLabel = !empty($row['end_time']) ? $clockValue($row['end_time']) : '';
                    $timeKind = $timeLabel !== '' ? 'single' : 'none';
                } elseif (in_array($status, ['UPCOMING', 'PENDING'], true)) {
                    $timeLabel = !empty($row['start_time']) && !empty($row['end_time']) ? $clockValue($row['start_time']) . ' - ' . $clockValue($row['end_time']) : '';
                    $timeKind = $timeLabel !== '' ? 'range' : 'none';
                } elseif (in_array($status, ['PRESENT', 'LATE'], true)) {
                    $timeLabel = $actualTime ? $clockValue($actualTime) : '';
                    $timeKind = $timeLabel !== '' ? 'single' : 'none';
                } else {
                    $timeLabel = '';
                    $timeKind = 'none';
                }
                $logs[] = array_merge($common, [
                    'id' => $attendanceKey . '-' . $checkpoint['key'],
                    'type' => $checkpoint['label'],
                    'status' => $status,
                    'timeLabel' => $timeLabel,
                    'timeKind' => $timeKind,
                ]);
            }
        }
        $totalLogs = count($logs);
        $totalLogPages = max(1, (int)ceil($totalLogs / $logPageSize));
        $logPage = min($logPage, $totalLogPages);
        $logs = array_slice($logs, ($logPage - 1) * $logPageSize, $logPageSize);
        $responseData = [
            'rows' => $logs,
            'pagination' => [
                'page' => $logPage,
                'page_size' => $logPageSize,
                'total' => $totalLogs,
                'total_pages' => $totalLogPages,
            ],
        ];
    } else {
        $responseData = $paginate
        ? [
            'rows' => $rows,
            'pagination' => [
                'page' => $page,
                'page_size' => $pageSize,
                'total' => $totalRows,
                'total_pages' => max(1, (int)ceil($totalRows / $pageSize)),
            ],
            'summary' => $summary,
        ]
        : $rows;
    }

    // Conditional refresh support. The representation varies by authenticated scope,
    // filters, and include_avatar, so the ETag is computed from the final authorized JSON.
    $representation = json_encode($responseData);
    if ($representation === false) {
        json_response(['error' => 'Failed to encode attendance result'], 500);
    }
    $etag = '"' . hash('sha256', $representation) . '"';
    header('ETag: ' . $etag);
    header('Cache-Control: private, no-cache, must-revalidate');
    header('Access-Control-Expose-Headers: ETag');
    $ifNoneMatch = trim((string)($_SERVER['HTTP_IF_NONE_MATCH'] ?? ''));
    if ($ifNoneMatch !== '' && ($ifNoneMatch === $etag || $ifNoneMatch === 'W/' . $etag)) {
        if (ob_get_length() !== false) @ob_end_clean();
        http_response_code(304);
        exit;
    }
    json_response($responseData);

} elseif ($request_method === 'POST' && $endpoint === 'attendance' && empty($param1)) {
    json_response([
        'error' => 'manual_attendance_creation_disabled',
        'message' => 'Attendance records are generated from class schedules and cannot be added manually.'
    ], 405);

    // Create a new attendance record (used by admin/secretary UI when adding a placeholder record)
    
    // Force integer conversion immediately
    $userId     = isset($input['user_id']) ? (int)$input['user_id'] : 0;
    $scheduleId = isset($input['schedule_id']) ? (int)$input['schedule_id'] : 0;
    $roomId     = isset($input['room_id']) ? (int)$input['room_id'] : 0;
    $date       = isset($input['date']) ? $input['date'] : null;
    $remarks    = isset($input['remarks']) ? $input['remarks'] : null;

    // --- SECURITY FIX: STRICT VALIDATION ---
    if ($userId <= 0 || $scheduleId <= 0 || !$date) {
        json_response(['ok' => false, 'error' => 'missing_fields', 'message' => 'User ID, Schedule ID, and Date are required'], 400);
    }
    $eligibleUserStmt = $mysqli->prepare("SELECT role_id FROM tbl_users WHERE user_id = ? AND LOWER(TRIM(COALESCE(status, 'active'))) IN ('active', '1', 'true') LIMIT 1");
    if (!$eligibleUserStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $eligibleUserStmt->bind_param('i', $userId);
    $eligibleUserStmt->execute();
    $eligibleUser = $eligibleUserStmt->get_result()->fetch_assoc();
    $eligibleUserStmt->close();
    if (!$eligibleUser || !in_array((int)($eligibleUser['role_id'] ?? 0), [2, 3, 4, 5], true)) {
        json_response(['ok' => false, 'error' => 'invalid_attendance_user', 'message' => 'Attendance can only be recorded for an active Dean, Program Head, Secretary, or Teacher.'], 409);
    }
    // ---------------------------------------

    // Block future dates
    if ($date > date('Y-m-d')) json_response(['ok' => false, 'error' => 'future_date_not_allowed'], 400);

    // ... (The rest of your logic stays exactly the same) ...
    // Server-side duplicate check: same teacher, same schedule, same date
    $dup = $mysqli->prepare("SELECT 1 FROM tbl_attendance_records WHERE user_id = ? AND schedule_id = ? AND date = ? LIMIT 1");
    if ($dup) {
        $dup->bind_param('iis', $userId, $scheduleId, $date);
        $dup->execute();
        $exists = $dup->get_result()->fetch_assoc();
        if ($exists) json_response(['ok' => false, 'error' => 'duplicate_record'], 409);
    }

    // Clone/overlap check: ensure teacher does not have another attendance at overlapping schedule time on same date
    $sStmt = $mysqli->prepare("SELECT start_time, end_time FROM tbl_class_schedules WHERE schedule_id = ? LIMIT 1");
    if ($sStmt) {
        $sStmt->bind_param('i', $scheduleId);
        $sStmt->execute();
        $sRow = $sStmt->get_result()->fetch_assoc();
        if ($sRow) {
            $newStart = $sRow['start_time'];
            $newEnd = $sRow['end_time'];
            $overlapSql = "SELECT 1 FROM tbl_attendance_records ar JOIN tbl_class_schedules cs2 ON ar.schedule_id = cs2.schedule_id WHERE ar.user_id = ? AND ar.date = ? AND NOT (cs2.end_time <= ? OR cs2.start_time >= ?) LIMIT 1";
            $ov = $mysqli->prepare($overlapSql);
            if ($ov) {
                $ov->bind_param('isss', $userId, $date, $newStart, $newEnd);
                $ov->execute();
                $found = $ov->get_result()->fetch_assoc();
                if ($found) json_response(['ok' => false, 'error' => 'time_conflict_with_existing_attendance'], 409);
            }
        }
    }

    // Map optional fields and flags
    $flag_in = isset($input['flag_in_id']) ? (int)$input['flag_in_id'] : 1;
    $flag_check = isset($input['flag_check_id']) ? (int)$input['flag_check_id'] : $flag_in;
    $flag_out = isset($input['flag_out_id']) ? (int)$input['flag_out_id'] : $flag_in;
    $checked_in = isset($input['checked_in_at']) ? $input['checked_in_at'] : null;
    $checked_out = isset($input['checked_out_at']) ? $input['checked_out_at'] : null;

    // Resolve floor_id from room to satisfy foreign key constraint
    $floorId = null;
    if (!empty($roomId)) {
        $rf = $mysqli->prepare("SELECT floor_id FROM tbl_rooms WHERE room_id = ? LIMIT 1");
        if ($rf) {
            $rf->bind_param('i', $roomId);
            $rf->execute();
            $rrow = $rf->get_result()->fetch_assoc();
            if ($rrow && isset($rrow['floor_id'])) {
                $floorId = (int)$rrow['floor_id'];
            } else {
                // room exists but no floor mapping -> cannot insert due to FK
                json_response(['ok' => false, 'error' => 'room_floor_missing', 'message' => 'Selected room does not have a floor_id mapping'], 400);
            }
        }
    }

    // If status is absent (flag 3) enforce no times
    if ($flag_in === 3) { $checked_in = null; $checked_out = null; }

    // Build dynamic insert to accept optional checked_in/out and remarks
    $fields = ['user_id','schedule_id','room_id','floor_id','date','flag_in_id','flag_check_id','flag_out_id'];
    $placeholders = ['?','?','?','?','?','?','?','?'];
    $types = 'iiiisiii';
    $values = [$userId, $scheduleId, $roomId ?: null, $floorId, $date, $flag_in, $flag_check, $flag_out];

    if ($checked_in !== null) { $fields[] = 'checked_in_at'; $placeholders[] = '?'; $types .= 's'; $values[] = $checked_in; }
    if ($checked_out !== null) { $fields[] = 'checked_out_at'; $placeholders[] = '?'; $types .= 's'; $values[] = $checked_out; }
    if ($remarks !== null) { $fields[] = 'remarks'; $placeholders[] = '?'; $types .= 's'; $values[] = $remarks; }

    $sql = "INSERT INTO tbl_attendance_records (" . implode(',', $fields) . ") VALUES (" . implode(',', $placeholders) . ")";
    $stmt = $mysqli->prepare($sql);
    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error, 'sql' => $sql], 500);

    // bind params
    if (!empty($values)) safe_bind_params($stmt, $types, $values);
    if (!$stmt->execute()) json_response(['error' => 'insert_failed', 'message' => $stmt->error], 500);
    $newId = $stmt->insert_id;

    // Get the dept_id of the user whose attendance record was created
    $dept_id = null;
    $uStmt = $mysqli->prepare("SELECT dept_id FROM tbl_users WHERE user_id = ? LIMIT 1");
    if ($uStmt) {
        $uStmt->bind_param('i', $userId);
        $uStmt->execute();
        $uRow = $uStmt->get_result()->fetch_assoc();
        if ($uRow && isset($uRow['dept_id'])) { $dept_id = (int)$uRow['dept_id']; }
    }

    // Notify websocket listeners
    try {
        $payload = ['entity' => 'attendance', 'action' => 'create', 'attendance_id' => $newId, 'user_id' => $userId, 'schedule_id' => $scheduleId, 'date' => $date];
        if ($dept_id) { $payload['dept_id'] = $dept_id; }
        trigger_socket_update($payload);
    } catch (Throwable $_) {}
    tardiness_reconcile_for_attendance($mysqli, $newId);
    json_response(['ok' => true, 'attendance_id' => $newId], 201);

} elseif ($request_method === 'PUT' && $endpoint === 'attendance' && is_numeric($param1)) {
    // Only Admin, Dean, and Department Admin may correct generated records.
    if (!in_array((int)$authRole, [1, 2, 6], true)) {
        json_response(['error' => 'forbidden', 'message' => 'Only Admin, Dean, and Department Admin can edit attendance records.'], 403);
    }

    $attendanceId = (int)$param1;
    // ensure exists and fetch current values for logging
    $check = $mysqli->prepare("SELECT * FROM tbl_attendance_records WHERE attendance_id = ? LIMIT 1");
    if (!$check) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $check->bind_param('i', $attendanceId);
    $check->execute();
    $existing = $check->get_result()->fetch_assoc();
    if (!$existing) json_response(['error' => 'not_found', 'message' => 'Attendance record not found'], 404);

    $actorDeptId = null;
    if (in_array((int)$authRole, [2, 6], true)) {
        $scopeStmt = $mysqli->prepare("SELECT actor.dept_id AS actor_dept_id, target.dept_id AS target_dept_id FROM tbl_users actor JOIN tbl_users target ON target.user_id = ? WHERE actor.user_id = ? LIMIT 1");
        if (!$scopeStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        $targetUserId = (int)($existing['user_id'] ?? 0);
        $scopeStmt->bind_param('ii', $targetUserId, $authUserId);
        $scopeStmt->execute();
        $scope = $scopeStmt->get_result()->fetch_assoc();
        $scopeStmt->close();
        $actorDeptId = isset($scope['actor_dept_id']) ? (int)$scope['actor_dept_id'] : null;
        $targetDeptId = isset($scope['target_dept_id']) ? (int)$scope['target_dept_id'] : null;
        if (!$actorDeptId || !$targetDeptId || $actorDeptId !== $targetDeptId) {
            json_response(['error' => 'forbidden_department', 'message' => 'You can edit attendance records only within your department.'], 403);
        }
    }

    // Build dynamic update - allow changing room_id, date, checked_in_at, checked_out_at, flag_in_id, flag_check_id, flag_out_id, schedule_id, user_id, remarks
    $fields = [];
    $types = '';
    $values = [];
    if (isset($input['user_id'])) {
        $nextUserId = (int)$input['user_id'];
        $eligibleUserStmt = $mysqli->prepare("SELECT role_id, dept_id FROM tbl_users WHERE user_id = ? AND LOWER(TRIM(COALESCE(status, 'active'))) IN ('active', '1', 'true') LIMIT 1");
        if (!$eligibleUserStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        $eligibleUserStmt->bind_param('i', $nextUserId);
        $eligibleUserStmt->execute();
        $eligibleUser = $eligibleUserStmt->get_result()->fetch_assoc();
        $eligibleUserStmt->close();
        if (!$eligibleUser || !in_array((int)($eligibleUser['role_id'] ?? 0), [2, 3, 4, 5], true)) {
            json_response(['error' => 'invalid_attendance_user', 'message' => 'Attendance can only be assigned to an active Dean, Program Head, Secretary, or Teacher.'], 409);
        }
        if (in_array((int)$authRole, [2, 6], true) && (int)($eligibleUser['dept_id'] ?? 0) !== (int)$actorDeptId) {
            json_response(['error' => 'forbidden_department', 'message' => 'The selected teacher must belong to your department.'], 403);
        }
        $fields[] = 'user_id = ?'; $types .= 'i'; $values[] = $nextUserId;
    }
    if (isset($input['schedule_id'])) { $fields[] = 'schedule_id = ?'; $types .= 'i'; $values[] = (int)$input['schedule_id']; }
    if (isset($input['room_id'])) { $fields[] = 'room_id = ?'; $types .= 'i'; $values[] = (int)$input['room_id']; }
    if (isset($input['date'])) { $fields[] = 'date = ?'; $types .= 's'; $values[] = $input['date']; }
    if (isset($input['checked_in_at'])) { $fields[] = 'checked_in_at = ?'; $types .= 's'; $values[] = $input['checked_in_at']; }
    if (isset($input['checked_mid_at'])) { $fields[] = 'checked_mid_at = ?'; $types .= 's'; $values[] = $input['checked_mid_at']; }
    if (isset($input['checked_out_at'])) { $fields[] = 'checked_out_at = ?'; $types .= 's'; $values[] = $input['checked_out_at']; }
    if (isset($input['flag_in_id'])) { $fields[] = 'flag_in_id = ?'; $types .= 'i'; $values[] = (int)$input['flag_in_id']; }
    if (isset($input['flag_check_id'])) { $fields[] = 'flag_check_id = ?'; $types .= 'i'; $values[] = (int)$input['flag_check_id']; }
    if (isset($input['flag_out_id'])) { $fields[] = 'flag_out_id = ?'; $types .= 'i'; $values[] = (int)$input['flag_out_id']; }
    if (isset($input['remarks'])) { $fields[] = 'remarks = ?'; $types .= 's'; $values[] = $input['remarks']; }

    // If status is being set to absent (flag 3) ensure times are nulled
    if (isset($input['flag_in_id']) && (int)$input['flag_in_id'] === 3) {
        // ensure times are set to NULL
        $fields[] = 'checked_in_at = NULL';
        $fields[] = 'checked_out_at = NULL';
    }

    if (empty($fields)) json_response(['message' => 'Nothing to update'], 200);

    $sql = "UPDATE tbl_attendance_records SET " . implode(', ', $fields) . " WHERE attendance_id = ?";
    $stmt = $mysqli->prepare($sql);
    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $types .= 'i';
    $values[] = $attendanceId;
    // bind params safely
    safe_bind_params($stmt, $types, $values);
    if (!$stmt->execute()) json_response(['error' => 'update_failed', 'message' => $stmt->error], 500);

    // Reload the updated record from DB to determine actual changes
    $updated = null;
    $uReload = $mysqli->prepare("SELECT checked_in_at, checked_mid_at, checked_out_at, flag_in_id, flag_check_id, flag_out_id FROM tbl_attendance_records WHERE attendance_id = ? LIMIT 1");
    if ($uReload) {
        $uReload->bind_param('i', $attendanceId);
        $uReload->execute();
        $updated = $uReload->get_result()->fetch_assoc();
        $uReload->close();
    }

    // After update: log changes for the specific fields the user requested (only flags and times)
    $ipAddr = get_client_ip_address();
    $reason = $input['reason'] ?? ($input['edit_reason'] ?? null);
    $action_type = isset($input['action_type']) ? $input['action_type'] : 'update';

    // Determine actor name (use for reason text). If authUserId present, fetch full name
    $actor_name = null;
    if (!empty($authUserId)) {
        $nameStmt = $mysqli->prepare("SELECT CONCAT_WS(' ', first_name, last_name) AS full_name FROM tbl_users WHERE user_id = ? LIMIT 1");
        if ($nameStmt) {
            $nameStmt->bind_param('i', $authUserId);
            $nameStmt->execute();
            $nr = $nameStmt->get_result()->fetch_assoc();
            if ($nr && !empty($nr['full_name'])) $actor_name = $nr['full_name'];
            $nameStmt->close();
        }
    }

    // Generate edit_session_id for this batch: format EDIT_YYYYMMDD_XXX
    $todayPrefix = 'EDIT_' . date('Ymd') . '_';
    $sessNumber = 1;
    $sessStmt = $mysqli->prepare("SELECT edit_session_id FROM tbl_attendance_logs WHERE edit_session_id LIKE CONCAT(?, '%') ORDER BY edit_session_id DESC LIMIT 1");
    if ($sessStmt) {
        $sessStmt->bind_param('s', $todayPrefix);
        if ($sessStmt->execute()) {
            $last = $sessStmt->get_result()->fetch_assoc();
            if ($last && !empty($last['edit_session_id'])) {
                if (preg_match('/_(\d{3})$/', $last['edit_session_id'], $m)) {
                    $sessNumber = (int)$m[1] + 1;
                }
            }
        }
        $sessStmt->close();
    }
    $edit_session_id = $todayPrefix . sprintf('%03d', $sessNumber);

    // Map DB columns -> user-visible field names requested by the user
    $logMap = [
        'flag_in_id' => 'flag_in',
        'flag_check_id' => 'flag_mid',
        'flag_out_id' => 'flag_out',
        'checked_in_at' => 'time_in',
        'checked_mid_at' => 'time_mid',
        'checked_out_at' => 'time_out'
    ];

    foreach ($logMap as $dbField => $logName) {
        // fetch old from pre-update and new from reloaded DB
        $old = array_key_exists($dbField, $existing) ? $existing[$dbField] : null;
        $new = is_array($updated) && array_key_exists($dbField, $updated) ? $updated[$dbField] : null;

        // If neither old nor new exist, skip
        if ($old === null && $new === null) continue;

        // If values are identical, skip
        if ($old === $new) continue;

        // Only log if the user explicitly provided the field in the request OR the DB value actually changed
        if (!array_key_exists($dbField, $input) && $old === $new) continue; // defensive

        // debug trace to inspect what's passed to logger (remove when verified)

        // insert log row — helper will convert flags to text and store old/new for time and flag fields
        log_attendance_change($mysqli, $authUserId, $attendanceId, $logName, $old, $new, $reason, $ipAddr, $action_type, $edit_session_id, $actor_name);
    }

    // Get the user_id from the updated record
    $uStmt = $mysqli->prepare("SELECT user_id FROM tbl_attendance_records WHERE attendance_id = ? LIMIT 1");
    $user_id = null;
    if ($uStmt) {
        $uStmt->bind_param('i', $attendanceId);
        $uStmt->execute();
        $uRow = $uStmt->get_result()->fetch_assoc();
        if ($uRow) { $user_id = (int)$uRow['user_id']; }
    }

    // Get the dept_id of the user whose attendance record was updated
    $dept_id = null;
    if ($user_id) {
        $dStmt = $mysqli->prepare("SELECT dept_id FROM tbl_users WHERE user_id = ? LIMIT 1");
        if ($dStmt) {
            $dStmt->bind_param('i', $user_id);
            $dStmt->execute();
            $dRow = $dStmt->get_result()->fetch_assoc();
            if ($dRow && isset($dRow['dept_id'])) { $dept_id = (int)$dRow['dept_id']; }
        }
    }

    try {
        $payload = ['entity' => 'attendance', 'action' => 'update', 'attendance_id' => $attendanceId];
        if ($dept_id) { $payload['dept_id'] = $dept_id; }
        trigger_socket_update($payload);
    } catch (Throwable $_) {}
    tardiness_reconcile_for_attendance($mysqli, $attendanceId);
    $oldUserId = (int)($existing['user_id'] ?? 0);
    $oldScheduleId = (int)($existing['schedule_id'] ?? 0);
    $newUserId = (int)($user_id ?? 0);
    $newScheduleId = isset($input['schedule_id']) ? (int)$input['schedule_id'] : $oldScheduleId;
    if ($oldUserId > 0 && ($oldUserId !== $newUserId || $oldScheduleId !== $newScheduleId)) {
        $oldSemesterStmt = $mysqli->prepare('SELECT semester_id FROM tbl_class_schedules WHERE schedule_id = ? LIMIT 1');
        if ($oldSemesterStmt) {
            $oldSemesterStmt->bind_param('i', $oldScheduleId);
            if ($oldSemesterStmt->execute() && ($oldSemesterRow = $oldSemesterStmt->get_result()->fetch_assoc())) {
                tardiness_reconcile_user_semester($mysqli, $oldUserId, (int)$oldSemesterRow['semester_id']);
            }
            $oldSemesterStmt->close();
        }
    }
    json_response(['ok' => true, 'attendance_id' => $attendanceId]);

} elseif ($request_method === 'POST' && ($param1 === 'check-in' || $param1 === 'mid-check' || $param1 === 'check-out')) {
    // Shared logic for all check types
    $schedule_id = isset($input['schedule_id']) ? (int)$input['schedule_id'] : 0;
    // Scan endpoints are personal actions. Use the already verified session identity
    // supplied by index.php instead of trusting a caller-provided user_id.
    $user_id = isset($authPayload['user_id']) ? (int)$authPayload['user_id'] : 0;
    $submittedUserId = isset($input['user_id']) ? (int)$input['user_id'] : 0;
    if ($submittedUserId > 0 && $submittedUserId !== $user_id) {
        json_response(['ok' => false, 'error' => 'forbidden_user', 'message' => 'Attendance can only be recorded for the signed-in user'], 403);
    }
    $date        = $input['date'] ?? null;
    $latitude    = $input['latitude'] ?? null;
    $longitude   = $input['longitude'] ?? null;
    $accuracy    = $input['accuracy'] ?? null;
    $altitude    = $input['altitude'] ?? null;
    $altitudeAccuracy = $input['altitudeAccuracy'] ?? null;
    $qr_token    = $input['qr_token'] ?? null;
    $devicePlatform = strtolower(trim((string)($input['device_platform'] ?? $input['devicePlatform'] ?? 'unknown')));
    if (!in_array($devicePlatform, ['android', 'ios', 'desktop', 'unknown'], true)) $devicePlatform = 'unknown';
    $rawAltitude = $input['raw_altitude'] ?? $input['rawAltitude'] ?? $altitude;
    $normalizedAltitude = $input['normalized_altitude'] ?? $input['normalizedAltitude'] ?? null;
    $altitudeOffset = $input['altitude_offset'] ?? $input['altitudeOffset'] ?? null;
    $altitudeSource = $input['altitude_source'] ?? $input['altitudeSource'] ?? null;
    if (is_numeric($normalizedAltitude)) {
        $altitude = $normalizedAltitude;
    }

    // --- SECURITY FIX: STRICT VALIDATION ---
    if ($user_id <= 0) {
        // This stops "undefined" or "0" from passing
        json_response(['ok' => false, 'error' => 'invalid_user_id', 'message' => 'User ID is missing or invalid'], 400);
    }
    if ($schedule_id <= 0) {
        json_response(['ok' => false, 'error' => 'invalid_schedule_id'], 400);
    }
    // ---------------------------------------

    $ACCURACY_THRESHOLD_METERS = 30;
    $ALTITUDE_ACCURACY_THRESHOLD_METERS = 15;
    $DEFAULT_VERTICAL_TOLERANCE_METERS = 1.5;

    if (!$date) json_response(['ok' => false, 'error' => 'missing_fields'], 400);
    if (!is_numeric($latitude) || !is_numeric($longitude)) json_response(['ok' => false, 'error' => 'missing_coordinates'], 400);

    $groupSelectSql = "
        SELECT
            ar.attendance_id,
            ar.user_id,
            ar.schedule_id,
            ar.room_id,
            ar.floor_id,
            ar.date,
            ar.flag_in_id,
            ar.flag_check_id,
            ar.flag_out_id,
            cs.semester_id,
            sem.status AS semester_status,
            sy.status AS school_year_status,
            DATE_FORMAT(sem.start_date, '%Y-%m-%d') AS semester_start_date,
            DATE_FORMAT(sem.end_date, '%Y-%m-%d') AS semester_end_date,
            cs.subject_id,
            cs.section_id,
            attendance_user.status AS attendance_user_status,
            subj.status AS subject_status,
            subject_program.status AS subject_program_status,
            subject_department.status AS subject_department_status,
            section_row.status AS section_status,
            section_program.status AS section_program_status,
            section_department.status AS section_department_status,
            cs.day_of_week,
            cs.start_time,
            cs.end_time,
            r.latitude AS room_lat,
            r.longitude AS room_lon,
            r.radius AS room_radius,
            r.floor_id AS room_floor_id,
            r.building_id AS room_building_id,
            r.status AS room_status,
            f.qr_token AS qr_token,
            f.status AS floor_status,
            f.baseline_altitude AS room_baseline_altitude,
            b.status AS building_status,
            b.building_name AS room_building_name,
            b.latitude AS building_lat,
            b.longitude AS building_lon,
            b.radius AS building_radius,
            b.school_id AS room_school_id,
            sc.status AS school_status
        FROM tbl_attendance_records ar
        JOIN tbl_class_schedules cs ON ar.schedule_id = cs.schedule_id
        JOIN tbl_users attendance_user ON attendance_user.user_id = ar.user_id
        JOIN tbl_semesters sem ON cs.semester_id = sem.semester_id
        JOIN tbl_school_year sy ON sy.school_year_id = sem.school_year_id
        JOIN tbl_subject subj ON subj.subject_id = cs.subject_id
        JOIN tbl_programs subject_program ON subject_program.program_id = subj.program_id
        JOIN tbl_departments subject_department ON subject_department.dept_id = subject_program.dept_id
        JOIN tbl_sections section_row ON section_row.section_id = cs.section_id
        JOIN tbl_programs section_program ON section_program.program_id = section_row.program_id
        JOIN tbl_departments section_department ON section_department.dept_id = section_program.dept_id
        JOIN tbl_rooms r ON ar.room_id = r.room_id
        LEFT JOIN tbl_floors f ON r.floor_id = f.floor_id
        LEFT JOIN tbl_buildings b ON b.building_id = COALESCE(r.building_id, f.building_id)
        LEFT JOIN tbl_school sc ON sc.school_id = b.school_id
    ";

    $locationStatusIsActive = function($value) {
        return in_array(strtolower(trim((string)$value)), ['active', '1', 'true'], true);
    };
    $attendanceLocationIsActive = function($candidate) use ($locationStatusIsActive) {
        if (!$locationStatusIsActive($candidate['room_status'] ?? null)) return false;
        if (!$locationStatusIsActive($candidate['floor_status'] ?? null)) return false;
        if (!$locationStatusIsActive($candidate['building_status'] ?? null)) return false;
        if (!empty($candidate['room_school_id']) && !$locationStatusIsActive($candidate['school_status'] ?? null)) return false;
        return true;
    };
    $attendanceAcademicDependenciesAreActive = function($candidate) use ($locationStatusIsActive) {
        foreach ([
            'attendance_user_status',
            'semester_status',
            'school_year_status',
            'subject_status',
            'subject_program_status',
            'subject_department_status',
            'section_status',
            'section_program_status',
            'section_department_status',
        ] as $statusKey) {
            if (!$locationStatusIsActive($candidate[$statusKey] ?? null)) return false;
        }
        return true;
    };

    $stmt = $mysqli->prepare($groupSelectSql . " WHERE ar.schedule_id = ? AND ar.user_id = ? AND ar.date = ? LIMIT 1");
    $stmt->bind_param("iis", $schedule_id, $user_id, $date);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();

    if (!$row) json_response(['ok' => false, 'error' => 'attendance_record_not_found'], 404);

    if (calendar_event_attendance_is_blocked($mysqli, (int)$row['attendance_id'])) {
        json_response([
            'ok' => false,
            'error' => 'no_class',
            'message' => 'Attendance is disabled because this class is covered by a holiday or event.'
        ], 409);
    }

    if (!$attendanceAcademicDependenciesAreActive($row)) {
        json_response([
            'ok' => false,
            'error' => 'inactive_attendance_dependency',
            'message' => 'Attendance cannot be recorded because the teacher, school year, subject, section, program, or department is inactive or archived.'
        ], 409);
    }

    // The original teacher keeps this row in Current/Next Schedule for
    // visibility, but only the separate row owned by the substitute may scan.
    if (
        (int)($row['flag_in_id'] ?? 0) === 4
        || (int)($row['flag_check_id'] ?? 0) === 4
        || (int)($row['flag_out_id'] ?? 0) === 4
    ) {
        json_response([
            'ok' => false,
            'error' => 'attendance_transferred_to_substitute',
            'message' => 'Attendance for this class belongs to the assigned substitute teacher.'
        ], 409);
    }
    if (
        (int)($row['flag_in_id'] ?? 0) === 7
        || (int)($row['flag_check_id'] ?? 0) === 7
        || (int)($row['flag_out_id'] ?? 0) === 7
    ) {
        json_response([
            'ok' => false,
            'error' => 'attendance_on_leave',
            'message' => 'Attendance actions are not required while this class is marked On Leave.'
        ], 409);
    }

    if (strtolower(trim((string)($row['semester_status'] ?? ''))) !== 'active') {
        json_response([
            'ok' => false,
            'error' => 'inactive_semester',
            'message' => 'Attendance cannot be recorded because this class belongs to an inactive semester.'
        ], 409);
    }
    $today = date('Y-m-d');
    $semesterStart = (string)($row['semester_start_date'] ?? '');
    $semesterEnd = (string)($row['semester_end_date'] ?? '');
    if ($semesterStart === '' || $semesterEnd === '' || $today < $semesterStart || $today > $semesterEnd || $date < $semesterStart || $date > $semesterEnd) {
        json_response([
            'ok' => false,
            'error' => 'semester_out_of_range',
            'message' => 'Attendance cannot be recorded because this class is outside the active semester date range.'
        ], 409);
    }
    if (!$attendanceLocationIsActive($row)) {
        json_response([
            'ok' => false,
            'error' => 'inactive_attendance_location',
            'message' => 'Attendance cannot be recorded because the assigned room, floor, building, or campus is inactive or archived.'
        ], 409);
    }

    $groupRows = [$row];
    if (isset($row['subject_id']) && $row['subject_id'] !== null && isset($row['semester_id']) && $row['semester_id'] !== null) {
        $groupStmt = $mysqli->prepare($groupSelectSql . "
            WHERE ar.user_id = ?
              AND ar.date = ?
              AND cs.semester_id = ?
              AND cs.subject_id = ?
              AND cs.start_time = ?
              AND cs.end_time = ?
        ");
        if ($groupStmt) {
            $selectedSemesterId = (int)$row['semester_id'];
            $selectedSubjectId = (int)$row['subject_id'];
            $selectedStartTime = $row['start_time'];
            $selectedEndTime = $row['end_time'];
            $groupStmt->bind_param(
                "isiiss",
                $user_id,
                $date,
                $selectedSemesterId,
                $selectedSubjectId,
                $selectedStartTime,
                $selectedEndTime
            );
            $groupStmt->execute();
            $result = $groupStmt->get_result();
            $fetchedRows = $result ? $result->fetch_all(MYSQLI_ASSOC) : [];
            $fetchedRows = array_values(array_filter($fetchedRows, function($item) use ($attendanceLocationIsActive, $attendanceAcademicDependenciesAreActive) {
                return !in_array((int)($item['flag_in_id'] ?? 0), [4, 7], true)
                    && !in_array((int)($item['flag_check_id'] ?? 0), [4, 7], true)
                    && !in_array((int)($item['flag_out_id'] ?? 0), [4, 7], true)
                    && $attendanceLocationIsActive($item)
                    && $attendanceAcademicDependenciesAreActive($item);
            }));
            if (!empty($fetchedRows)) $groupRows = $fetchedRows;
        }
    }

    $validationRow = $row;
    $matchedQrRow = false;
    if ($qr_token) {
        $qrFallback = null;
        $qrNearest = null;
        foreach ($groupRows as $candidate) {
            if (!empty($candidate['qr_token']) && $candidate['qr_token'] === $qr_token && isset($candidate['floor_status']) && $candidate['floor_status'] === 'active') {
                if ($qrFallback === null) $qrFallback = $candidate;
                if (isInsideBox($latitude, $longitude, $candidate['room_lat'], $candidate['room_lon'], (float)$candidate['room_radius'])) {
                    $candidateDistance = getDistanceMeters($latitude, $longitude, $candidate['room_lat'], $candidate['room_lon']);
                    if ($qrNearest === null || $candidateDistance < $qrNearest['distance']) {
                        $qrNearest = ['row' => $candidate, 'distance' => $candidateDistance];
                    }
                }
            }
        }
        if ($qrNearest !== null) {
            $validationRow = $qrNearest['row'];
            $matchedQrRow = true;
        } elseif ($qrFallback !== null) {
            $validationRow = $qrFallback;
            $matchedQrRow = true;
        }
    }
    if (!$matchedQrRow) {
        $nearest = null;
        foreach ($groupRows as $candidate) {
            if (!isInsideBox($latitude, $longitude, $candidate['room_lat'], $candidate['room_lon'], (float)$candidate['room_radius'])) continue;
            $candidateDistance = getDistanceMeters($latitude, $longitude, $candidate['room_lat'], $candidate['room_lon']);
            if ($nearest === null || $candidateDistance < $nearest['distance']) {
                $nearest = ['row' => $candidate, 'distance' => $candidateDistance];
            }
        }
        if ($nearest !== null) $validationRow = $nearest['row'];
    }

    // A solo class permits only its assigned building. A parallel group permits
    // any building represented by its active scheduled rooms. Other known
    // buildings may be detected by the UI, but never authorize attendance.
    $allowedBuildings = [];
    foreach ($groupRows as $candidate) {
        $buildingId = (int)($candidate['room_building_id'] ?? 0);
        if ($buildingId <= 0 || isset($allowedBuildings[$buildingId])) continue;
        if (!is_numeric($candidate['building_lat'] ?? null)
            || !is_numeric($candidate['building_lon'] ?? null)
            || !is_numeric($candidate['building_radius'] ?? null)
            || (float)$candidate['building_radius'] <= 0) continue;
        $allowedBuildings[$buildingId] = [
            'building_id' => $buildingId,
            'building_name' => (string)($candidate['room_building_name'] ?? ''),
            'latitude' => (float)$candidate['building_lat'],
            'longitude' => (float)$candidate['building_lon'],
            'radius' => (float)$candidate['building_radius'],
        ];
    }
    if (!empty($allowedBuildings)) {
        $insideAllowedBuilding = false;
        $nearestAllowedBuilding = null;
        foreach ($allowedBuildings as $allowedBuilding) {
            $distance = getDistanceMeters($latitude, $longitude, $allowedBuilding['latitude'], $allowedBuilding['longitude']);
            $outsideBy = max(0, $distance - $allowedBuilding['radius']);
            if ($distance <= $allowedBuilding['radius']) $insideAllowedBuilding = true;
            if ($nearestAllowedBuilding === null || $outsideBy < $nearestAllowedBuilding['outside_by']) {
                $nearestAllowedBuilding = $allowedBuilding + ['distance' => $distance, 'outside_by' => $outsideBy];
            }
        }
        if (!$insideAllowedBuilding && $nearestAllowedBuilding !== null) {
            json_response([
                'ok' => false,
                'error' => 'outside_building',
                'message' => 'You are outside the building assigned to the current class.',
                'distanceMeters' => $nearestAllowedBuilding['distance'],
                'outside_by_meters' => $nearestAllowedBuilding['outside_by'],
                'building_radius' => $nearestAllowedBuilding['radius'],
                'building_id' => $nearestAllowedBuilding['building_id'],
                'building_name' => $nearestAllowedBuilding['building_name'],
                'allowed_building_ids' => array_values(array_map('intval', array_keys($allowedBuildings))),
            ], 400);
        }
    }
    $row = $validationRow;
    $groupAttendanceIds = array_values(array_unique(array_map(function($item) {
        return (int)$item['attendance_id'];
    }, $groupRows)));
    if (empty($groupAttendanceIds)) $groupAttendanceIds = [(int)$row['attendance_id']];
    $groupPlaceholders = implode(',', array_fill(0, count($groupAttendanceIds), '?'));
    $groupIdTypes = str_repeat('i', count($groupAttendanceIds));
    $groupCount = count($groupAttendanceIds);

    $classStart = new DateTime(toDateYMD($row['date']) . ' ' . $row['start_time']);
    $classEnd = new DateTime(toDateYMD($row['date']) . ' ' . $row['end_time']);
    $now = new DateTime();

    // 1. Check QR Validity: qr_token must match and the floor's status should be 'active'
    $isQrValid = ($qr_token && !empty($row['qr_token']) && $qr_token === $row['qr_token'] && isset($row['floor_status']) && $row['floor_status'] === 'active');

    // 2. Horizontal GPS Check
    $distanceMeters = getDistanceMeters($latitude, $longitude, $row['room_lat'], $row['room_lon']);
    $inBox = isInsideBox($latitude, $longitude, $row['room_lat'], $row['room_lon'], (float)$row['room_radius']);
    if (!$inBox) {
        json_response([
            'ok' => false, 
            'error' => 'out_of_range', 
            'in_box' => false, 
            'distanceMeters' => $distanceMeters, 
            'room_radius' => (float)$row['room_radius']
        ], 400);
    }
    if (is_numeric($accuracy) && $accuracy > $ACCURACY_THRESHOLD_METERS) json_response(['ok' => false, 'error' => 'low_accuracy'], 400);

    // 3. Vertical / Altitude Check (CORRECTED LOGIC)
    $finalAltitude = $altitude;
    $detectedFloorId = null;
    if ($isQrValid) {
        // For QR path: validate user's reported altitude falls within the floor's baseline +/- floor_meter_vertical.
        // This replaces trusting a static baseline value and enforces the floor range for the scanned floor.
        try {
            $roomFloorId = $row['room_floor_id'] ? (int)$row['room_floor_id'] : null;
            $floorInfo = null;
            if ($roomFloorId) {
                $fstmt = $mysqli->prepare("SELECT baseline_altitude, floor_meter_vertical FROM tbl_floors WHERE floor_id = ? LIMIT 1");
                if ($fstmt) {
                    $fstmt->bind_param('i', $roomFloorId);
                    $fstmt->execute();
                    $floorInfo = $fstmt->get_result()->fetch_assoc();
                }
            }

            // Require both baseline_altitude and floor_meter_vertical to be present and numeric.
            if ($floorInfo && is_numeric($floorInfo['baseline_altitude']) && is_numeric($floorInfo['floor_meter_vertical'])) {
                $baseline = (float)$floorInfo['baseline_altitude'];
                $vertical = (float)$floorInfo['floor_meter_vertical'];
                // Use full vertical value as limit (baseline +/- vertical)
                $minAlt = $baseline - $vertical;
                $maxAlt = $baseline + $vertical;

                if (!is_numeric($altitude)) {
                    json_response(['ok' => false, 'error' => 'missing_altitude'], 400);
                }

                $userAlt = (float)$altitude;
                if ($userAlt < $minAlt || $userAlt > $maxAlt) {
                    json_response([
                        'ok' => false,
                        'error' => 'wrong_floor',
                        'expected_floor_id' => $roomFloorId,
                        'expected_baseline' => $baseline,
                        'floor_meter_vertical' => $vertical,
                        'min_altitude' => $minAlt,
                        'max_altitude' => $maxAlt,
                        'detected_altitude' => $userAlt
                    ], 400);
                }

                // Passed range check — use user's altitude as stored value and mark detected floor
                $finalAltitude = $userAlt;
                $detectedFloorId = $roomFloorId;

            } else {
                // Floor data incomplete: do not fall back to static baseline. Require floor vertical info.
                json_response(['ok' => false, 'error' => 'no_floor_match', 'reason' => 'floor_baseline_or_vertical_missing'], 400);
            }
        } catch (Exception $e) {
            // On unexpected failure, return no_floor_match instead of silently falling back
            json_response(['ok' => false, 'error' => 'no_floor_match', 'reason' => 'exception_occurred'], 400);
        }

    } else {
        if (!is_numeric($altitude)) json_response(['ok' => false, 'error' => 'missing_altitude'], 400);
        if (!is_numeric($altitudeAccuracy) || $altitudeAccuracy > $ALTITUDE_ACCURACY_THRESHOLD_METERS) json_response(['ok' => false, 'error' => 'altitude_too_poor'], 400);
        
        $floor_stmt = $mysqli->prepare("SELECT floor_id, baseline_altitude, floor_meter_vertical FROM tbl_floors WHERE building_id = ?");
        $floor_stmt->bind_param("i", $row['room_building_id']);
        $floor_stmt->execute();
        $floors_result = $floor_stmt->get_result();
        $floors = $floors_result->fetch_all(MYSQLI_ASSOC);
        
        $detectedFloorId = null;
        $detectedFloorBaseline = null;
        $detectedFloorVertical = null;
        
        if (!empty($floors)) {
            $best_match = null;
            foreach ($floors as $f) {
                if ($f['baseline_altitude'] === null) continue;
                $diff = abs((float)$f['baseline_altitude'] - (float)$altitude);
                if ($best_match === null || $diff < $best_match['diff']) {
                    $best_match = ['diff' => $diff, 'floor' => $f];
                }
            }
            if ($best_match) {
                $detectedFloorId = (int)$best_match['floor']['floor_id'];
                $detectedFloorBaseline = (float)$best_match['floor']['baseline_altitude'];
                $detectedFloorVertical = $best_match['floor']['floor_meter_vertical'] !== null ? (float)$best_match['floor']['floor_meter_vertical'] : null;
            }
        }

        if ($detectedFloorId === null) json_response(['ok' => false, 'error' => 'no_floor_match'], 400);

        // Require floor_meter_vertical to be present. Do not fallback to static baseline.
        if ($detectedFloorVertical === null) json_response(['ok' => false, 'error' => 'no_floor_match', 'reason' => 'floor_vertical_missing'], 400);

        // Use full +/- floor_meter_vertical range for validation
        $minAlt = $detectedFloorBaseline - $detectedFloorVertical;
        $maxAlt = $detectedFloorBaseline + $detectedFloorVertical;
        $userAlt = (float)$altitude;

        if ($userAlt < $minAlt || $userAlt > $maxAlt || $detectedFloorId !== (int)$row['room_floor_id']) {
            json_response([
                'ok' => false,
                'error' => 'wrong_floor',
                'detected_floor_id' => $detectedFloorId,
                'expected_floor_id' => (int)$row['room_floor_id'],
                'detected_baseline' => $detectedFloorBaseline,
                'floor_meter_vertical' => $detectedFloorVertical,
                'min_altitude' => $minAlt,
                'max_altitude' => $maxAlt,
                'detected_altitude' => $userAlt
            ], 400);
        }
    }
    
    $personalEmailEvents = [];
    $attendanceAlertEvents = [];
    $queuePersonalAttendanceEmail = function($notificationType, $briefDescription, $leadDetails, $dateTimeField = null, $eventDateTime = null) use (&$personalEmailEvents) {
        $personalEmailEvents[] = [
            'type' => $notificationType,
            'brief' => $briefDescription,
            'lead' => $leadDetails,
            'datetime_field' => $dateTimeField,
            'datetime' => $eventDateTime,
        ];
    };
    $queueAttendanceAlert = function($title, $leadDetails) use (&$attendanceAlertEvents) {
        $attendanceAlertEvents[] = [
            'title' => trim((string)$title),
            'lead' => trim((string)$leadDetails),
        ];
    };

    // Validate the requested stage and calculate its result before opening a
    // transaction. Rejected scans must never alter the temporary floor.
    $message = '';
    $targetTimestampField = '';
    $flagIn = null;
    $flagCheck = null;
    $shouldCatchUpIn = false;
    $shouldCatchUpMid = false;
    if ($param1 === 'check-in') {
        $inPresentWindowEnd = (clone $classStart)->modify('+15 minutes');
        if ($now < $classStart) json_response(['ok' => false, 'error' => 'too_early', 'allow_at' => $classStart->format(DateTime::ISO8601)]);
        if ($now > $classEnd) json_response(['ok' => false, 'error' => 'class_ended']);
        $flagIn = ($now <= $inPresentWindowEnd) ? 2 : 5;
        $targetTimestampField = 'checked_in_at';
        $message = $flagIn === 2 ? 'checked_in_present' : 'checked_in_late';
    } elseif ($param1 === 'mid-check') {
        $duration = $classEnd->getTimestamp() - $classStart->getTimestamp();
        $midPoint = (clone $classStart)->modify('+' . ($duration / 2) . ' seconds');
        $midStart = (clone $midPoint)->modify('-10 minutes');
        $midEnd = (clone $midPoint)->modify('+10 minutes');
        if ($now < $midStart) json_response(['ok' => false, 'error' => 'too_early', 'allow_at' => $midStart->format(DateTime::ISO8601)]);
        if ($now > $classEnd) json_response(['ok' => false, 'error' => 'class_ended']);
        
        $inPresentWindowEnd = (clone $classStart)->modify('+15 minutes');
        $shouldCatchUpIn = $now > $inPresentWindowEnd;
        $flagCheck = ($now >= $midStart && $now <= $midEnd) ? 2 : 5;
        $targetTimestampField = 'checked_mid_at';
        $message = $flagCheck === 2 ? 'mid_check_present' : 'mid_check_late';
    } elseif ($param1 === 'check-out') {
        $outStart = (clone $classEnd)->modify('-15 minutes');
        if ($now < $outStart) json_response(['ok' => false, 'error' => 'too_early', 'allow_at' => $outStart->format(DateTime::ISO8601)]);
        if ($now > $classEnd) json_response(['ok' => false, 'error' => 'class_ended']);

        $inPresentWindowEnd = (clone $classStart)->modify('+15 minutes');
        $shouldCatchUpIn = $now > $inPresentWindowEnd;
        $duration = $classEnd->getTimestamp() - $classStart->getTimestamp();
        $midPoint = (clone $classStart)->modify('+' . ($duration / 2) . ' seconds');
        $midWindowEnd = (clone $midPoint)->modify('+10 minutes');
        $shouldCatchUpMid = $now > $midWindowEnd;
        $targetTimestampField = 'checked_out_at';
        $message = 'checked_out';
    }

    $scanAffected = 0;
    $catchUpInAffected = 0;
    $catchUpMidAffected = 0;
    $alreadyRecorded = false;

    try {
        if (!$mysqli->begin_transaction()) {
            throw new RuntimeException('Unable to start attendance transaction');
        }

        // Serialize competing GPS/QR/manual submissions for the same parallel group.
        $lockStmt = $mysqli->prepare("SELECT attendance_id, checked_in_at, checked_mid_at, checked_out_at, flag_in_id, flag_check_id, flag_out_id FROM tbl_attendance_records WHERE attendance_id IN ({$groupPlaceholders}) FOR UPDATE");
        if (!$lockStmt) throw new RuntimeException('Unable to prepare attendance lock');
        safe_bind_params($lockStmt, $groupIdTypes, $groupAttendanceIds);
        if (!$lockStmt->execute()) throw new RuntimeException('Unable to lock attendance records');
        $lockedRows = $lockStmt->get_result()->fetch_all(MYSQLI_ASSOC);
        if (count($lockedRows) !== $groupCount) throw new RuntimeException('Attendance group changed during submission');

        $pendingCount = 0;
        foreach ($lockedRows as $lockedRow) {
            if (
                (int)($lockedRow['flag_in_id'] ?? 0) === 4
                || (int)($lockedRow['flag_check_id'] ?? 0) === 4
                || (int)($lockedRow['flag_out_id'] ?? 0) === 4
            ) {
                throw new RuntimeException('attendance_transferred_to_substitute');
            }
            if (
                (int)($lockedRow['flag_in_id'] ?? 0) === 7
                || (int)($lockedRow['flag_check_id'] ?? 0) === 7
                || (int)($lockedRow['flag_out_id'] ?? 0) === 7
            ) {
                throw new RuntimeException('attendance_on_leave');
            }
            if (empty($lockedRow[$targetTimestampField])) $pendingCount++;
        }
        $alreadyRecorded = $pendingCount === 0;

        if (!$alreadyRecorded) {
            // Persist the detected floor only for an accepted, pending attendance stage.
            if ($detectedFloorId !== null) {
                $floorStmt = $mysqli->prepare("UPDATE tbl_attendance_records SET floor_id = ? WHERE attendance_id IN ({$groupPlaceholders})");
                if (!$floorStmt) throw new RuntimeException('Unable to prepare floor update');
                $floorParams = array_merge([$detectedFloorId], $groupAttendanceIds);
                safe_bind_params($floorStmt, 'i' . $groupIdTypes, $floorParams);
                if (!$floorStmt->execute()) throw new RuntimeException('Unable to update attendance floor');
            }

            if ($shouldCatchUpIn) {
                $catchInStmt = $mysqli->prepare("UPDATE tbl_attendance_records SET flag_in_id = 5 WHERE attendance_id IN ({$groupPlaceholders}) AND flag_in_id IN (1, 8)");
                if (!$catchInStmt) throw new RuntimeException('Unable to prepare check-in catch-up');
                safe_bind_params($catchInStmt, $groupIdTypes, $groupAttendanceIds);
                if (!$catchInStmt->execute()) throw new RuntimeException('Unable to update check-in catch-up');
                $catchUpInAffected = (int)$catchInStmt->affected_rows;
            }
            if ($shouldCatchUpMid) {
                $catchMidStmt = $mysqli->prepare("UPDATE tbl_attendance_records SET flag_check_id = 5 WHERE attendance_id IN ({$groupPlaceholders}) AND flag_check_id IN (1, 8)");
                if (!$catchMidStmt) throw new RuntimeException('Unable to prepare middle-check catch-up');
                safe_bind_params($catchMidStmt, $groupIdTypes, $groupAttendanceIds);
                if (!$catchMidStmt->execute()) throw new RuntimeException('Unable to update middle-check catch-up');
                $catchUpMidAffected = (int)$catchMidStmt->affected_rows;
            }

            if ($param1 === 'check-in') {
                $stageStmt = $mysqli->prepare("UPDATE tbl_attendance_records SET checked_in_at = NOW(), altitude_in = ?, latitude_in = ?, longitude_in = ?, flag_in_id = ? WHERE attendance_id IN ({$groupPlaceholders}) AND checked_in_at IS NULL AND COALESCE(flag_in_id, 1) NOT IN (4, 7)");
                $stageParams = array_merge([$finalAltitude, $latitude, $longitude, $flagIn], $groupAttendanceIds);
                $stageTypes = 'dddi' . $groupIdTypes;
            } elseif ($param1 === 'mid-check') {
                $stageStmt = $mysqli->prepare("UPDATE tbl_attendance_records SET checked_mid_at = NOW(), altitude_check = ?, latitude_check = ?, longitude_check = ?, flag_check_id = ? WHERE attendance_id IN ({$groupPlaceholders}) AND checked_mid_at IS NULL AND COALESCE(flag_check_id, 1) NOT IN (4, 7)");
                $stageParams = array_merge([$finalAltitude, $latitude, $longitude, $flagCheck], $groupAttendanceIds);
                $stageTypes = 'dddi' . $groupIdTypes;
            } else {
                $stageStmt = $mysqli->prepare("UPDATE tbl_attendance_records SET checked_out_at = NOW(), altitude_out = ?, latitude_out = ?, longitude_out = ?, flag_out_id = 2 WHERE attendance_id IN ({$groupPlaceholders}) AND checked_out_at IS NULL AND COALESCE(flag_out_id, 1) NOT IN (4, 7)");
                $stageParams = array_merge([$finalAltitude, $latitude, $longitude], $groupAttendanceIds);
                $stageTypes = 'ddd' . $groupIdTypes;
            }
            if (!$stageStmt) throw new RuntimeException('Unable to prepare attendance stage');
            safe_bind_params($stageStmt, $stageTypes, $stageParams);
            if (!$stageStmt->execute()) throw new RuntimeException('Unable to update attendance stage');
            $scanAffected = (int)$stageStmt->affected_rows;
            if ($scanAffected !== $pendingCount) throw new RuntimeException('Attendance group update was incomplete');
        }

        if (!$mysqli->commit()) throw new RuntimeException('Unable to commit attendance transaction');
    } catch (Throwable $e) {
        $mysqli->rollback();
        if ($e->getMessage() === 'attendance_transferred_to_substitute') {
            json_response([
                'ok' => false,
                'error' => 'attendance_transferred_to_substitute',
                'message' => 'Attendance for this class belongs to the assigned substitute teacher.'
            ], 409);
        }
        if ($e->getMessage() === 'attendance_on_leave') {
            json_response([
                'ok' => false,
                'error' => 'attendance_on_leave',
                'message' => 'Attendance actions are not required while this class is marked On Leave.'
            ], 409);
        }
        error_log('attendance scan transaction failed: ' . $e->getMessage());
        json_response(['ok' => false, 'error' => 'attendance_update_failed'], 500);
    }

    // Only exceptional attendance results notify the user. Successful scans are
    // already confirmed in the attendance UI, so emailing or pushing a second
    // "Present" confirmation would be redundant.
    if ($scanAffected > 0) {
        if ($param1 === 'check-in') {
            if ($flagIn === 5) {
                $queuePersonalAttendanceEmail('LATE ALERT', 'Check-in marked late', 'Your check-in status was set to Late.', 'time_in');
                $queueAttendanceAlert('Check-in Marked Late', 'Your check-in status was set to Late.');
            }
        } elseif ($param1 === 'mid-check') {
            if ($flagCheck === 5) {
                $queuePersonalAttendanceEmail('LATE ALERT', 'Middle check marked late', 'Your middle check status was set to Late.', 'time_check');
                $queueAttendanceAlert('Middle Check Marked Late', 'Your middle check status was set to Late.');
            }
        }
    }
    if ($catchUpInAffected > 0) {
        $queuePersonalAttendanceEmail('LATE ALERT', 'Check-in marked late', 'Your check-in status was set to Late after the check-in window passed.', null, new DateTime());
        $queueAttendanceAlert('Check-in Marked Late', 'Your check-in status was set to Late after the check-in window passed.');
    }
    if ($catchUpMidAffected > 0) {
        $queuePersonalAttendanceEmail('LATE ALERT', 'Middle check marked late', 'Your middle check status was set to Late after the middle check window passed.', null, new DateTime());
        $queueAttendanceAlert('Middle Check Marked Late', 'Your middle check status was set to Late after the middle check window passed.');
    }

    if (($scanAffected + $catchUpInAffected + $catchUpMidAffected) > 0 && !empty($groupAttendanceIds)) {
        tardiness_reconcile_for_attendance($mysqli, (int)$groupAttendanceIds[0]);
    }

    // Return the final updated records with joined fields (same projection as GET /api/attendance)
    $sql = "
      SELECT
        ar.attendance_id,
        ar.user_id,
        ar.schedule_id,
        ar.room_id,
        ar.floor_id,
        DATE_FORMAT(ar.date, '%Y-%m-%d') AS date,
        cs.semester_id,
        cs.subject_id,
        cs.section_id,
        cs.day_of_week,
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
        u.first_name, u.last_name,
        NULLIF(CAST(u.image AS CHAR), '') AS avatar,
        cs.start_time, cs.end_time,
        r.room_name,
        sc.school_name AS campus_name,
        sc.school_name AS school_name,
        b.building_name,
        COALESCE(f.floor_name, rf.floor_name) AS floor_name,
        s.subject_code,
        s.subject_name,
        sec.section_name,
        f.floor_name AS attendance_floor_name,
        ft_in.flag_name AS flag_in_name,
        ft_check.flag_name AS flag_check_name,
        ft_out.flag_name AS flag_out_name
      FROM tbl_attendance_records ar
      JOIN tbl_users u              ON ar.user_id = u.user_id
      JOIN tbl_class_schedules cs   ON ar.schedule_id = cs.schedule_id
      JOIN tbl_rooms r              ON ar.room_id = r.room_id
      LEFT JOIN tbl_floors f        ON ar.floor_id = f.floor_id
      LEFT JOIN tbl_floors rf       ON r.floor_id = rf.floor_id
      LEFT JOIN tbl_buildings b     ON r.building_id = b.building_id
      LEFT JOIN tbl_school sc       ON b.school_id = sc.school_id
      LEFT JOIN tbl_subject s       ON cs.subject_id = s.subject_id
      LEFT JOIN tbl_sections sec    ON cs.section_id = sec.section_id
      LEFT JOIN tbl_flag_types ft_in   ON ar.flag_in_id = ft_in.flag_id
      LEFT JOIN tbl_flag_types ft_check ON ar.flag_check_id = ft_check.flag_id
      LEFT JOIN tbl_flag_types ft_out  ON ar.flag_out_id = ft_out.flag_id
      WHERE ar.attendance_id IN ({$groupPlaceholders})
      ORDER BY cs.start_time, r.room_name, sec.section_name
    ";
    $stmt = $mysqli->prepare($sql);
    if ($stmt === false) { json_response(['error' => 'db_prepare_failed', 'details' => $mysqli->error], 500); }
    safe_bind_params($stmt, $groupIdTypes, $groupAttendanceIds);
    if (!$stmt->execute()) { json_response(['error' => 'db_execute_failed', 'details' => $stmt->error], 500); }
     
    $finalRows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $final = $finalRows[0] ?? null;
    $personalEmailResults = [];
    if ($final && !empty($personalEmailEvents)) {
        foreach ($personalEmailEvents as $emailEvent) {
            $eventDateTime = $emailEvent['datetime'] ?? null;
            $field = $emailEvent['datetime_field'] ?? null;
            if ($field && !empty($final[$field])) {
                $eventDateTime = $final[$field];
            }
            $personalEmailResults[] = personal_notif_send_attendance_event(
                $mysqli,
                $final,
                $emailEvent['type'],
                $emailEvent['brief'],
                $emailEvent['lead'],
                $eventDateTime
            );
        }
    }
    $attendanceAlertResults = [];
    if ($final && !empty($attendanceAlertEvents)) {
        foreach ($attendanceAlertEvents as $alertEvent) {
            $alertMessage = personal_notif_attendance_details($final, $alertEvent['lead']);
            $attendanceAlertResults[] = notif_insert_web_push(
                $mysqli,
                (int)$final['user_id'],
                $alertEvent['title'],
                $alertMessage,
                '/attendance-history'
            );
        }
    }
    json_response([
        'ok' => true,
        'message' => $message,
        'record' => $final,
        'attendance' => $final,
        'records' => $finalRows,
        'group_count' => $groupCount,
        'grouped' => $groupCount > 1,
        'already_recorded' => $alreadyRecorded,
        'device_platform' => $devicePlatform,
        'altitude_used' => is_numeric($finalAltitude) ? (float)$finalAltitude : null,
        'raw_altitude' => is_numeric($rawAltitude) ? (float)$rawAltitude : null,
        'normalized_altitude' => is_numeric($altitude) ? (float)$altitude : null,
        'altitude_offset' => is_numeric($altitudeOffset) ? (float)$altitudeOffset : null,
        'altitude_source' => $altitudeSource,
        'email_notifications' => [
            'queued' => count($personalEmailEvents),
            'sent' => count(array_filter($personalEmailResults, function($r) { return !empty($r['sent']); })),
            'failed' => count(array_filter($personalEmailResults, function($r) { return empty($r['sent']); })),
        ],
        'attendance_alerts' => [
            'queued' => count($attendanceAlertEvents),
            'created' => count(array_filter($attendanceAlertResults)),
        ],
    ]);

} else {
    json_response(['error' => 'Endpoint not found in attendance API file.'], 404);
}

} // end skip-routing guard
