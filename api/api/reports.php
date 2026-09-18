<?php
require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../helpers/log_helper.php';
global $mysqli, $authPayload;
$authUserId = isset($authPayload['user_id']) ? (int)$authPayload['user_id'] : null;

// Simple helper to send JSON responses
if (!function_exists('json_response')) {
    function json_response($data, $status = 200) {
        http_response_code($status);
        header('Content-Type: application/json');
        echo json_encode($data);
        exit;
    }
}

if (!function_exists('output_csv')) {
    function output_csv($rows, $columns, $filename = 'report.csv') {
        header('Content-Type: text/csv');
        header('Content-Disposition: attachment; filename="' . $filename . '"');
        $out = fopen('php://output', 'w');
        fputcsv($out, $columns);
        foreach ($rows as $r) {
            $line = [];
            foreach ($columns as $c) $line[] = $r[$c] ?? '';
            fputcsv($out, $line);
        }
        fclose($out);
        exit;
    }
}

if (!function_exists('output_html_printable')) {
    function output_html_printable($rows, $columns, $title = 'Report') {
        header('Content-Type: text/html');
        echo "<html><head><meta charset=\"utf-8\"><title>" . htmlspecialchars($title) . "</title>";
        echo "<style>table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:8px;text-align:left}</style>";
        echo "</head><body><h2>" . htmlspecialchars($title) . "</h2><table><thead><tr>";
        foreach ($columns as $c) echo "<th>" . htmlspecialchars($c) . "</th>";
        echo "</tr></thead><tbody>";
        foreach ($rows as $r) {
            echo "<tr>";
            foreach ($columns as $c) echo "<td>" . htmlspecialchars((string)($r[$c] ?? '')) . "</td>";
            echo "</tr>";
        }
        echo "</tbody></table></body></html>";
        exit;
    }
}

// Helper: find an existing column from a list of candidates for a given table
function find_column($table, $candidates) {
    global $mysqli;
    foreach ($candidates as $c) {
        $c_esc = $mysqli->real_escape_string($c);
        $res = $mysqli->query("SHOW COLUMNS FROM `{$table}` LIKE '{$c_esc}'");
        if ($res && $res->num_rows) return $c;
    }
    return null;
}

// Helper: choose a timestamp column for a table (common names)
function choose_timestamp_column($table, $preferred = null) {
    $cands = [];
    if ($preferred) $cands[] = $preferred;
    $cands = array_merge($cands, ['edited_at','created_at','created','logged_at','timestamp','time','date_time']);
    return find_column($table, $cands);
}

function normalize_attendance_status_key($value) {
    $key = strtolower(trim((string)$value));
    $key = str_replace('_', ' ', $key);
    if ($key === 'n/a' || $key === 'na') return 'upcoming';
    if ($key === 'on leave') return 'on_leave';
    if ($key === 'partial attendance') return 'incomplete';
    return str_replace(' ', '_', $key);
}

function attendance_overall_status($statuses) {
    $keys = array_map('normalize_attendance_status_key', array_values($statuses));
    $counts = array_count_values($keys);
    arsort($counts);
    $winningKey = array_key_first($counts);
    $winningCount = $winningKey === null ? 0 : (int)$counts[$winningKey];

    if ($winningCount < 2) return 'Partial Attendance';

    $labels = [
        'present' => 'Present',
        'late' => 'Late',
        'absent' => 'Absent',
        'pending' => 'Pending',
        'upcoming' => 'Upcoming',
        'substituted' => 'Substituted',
        'on_leave' => 'On Leave',
        '' => 'Pending',
    ];
    return $labels[$winningKey] ?? ucwords(str_replace('_', ' ', $winningKey));
}

$report = $_GET['report'] ?? null;
$export = $_GET['export'] ?? null; // 'csv' or 'html'
$paginate = !$export && isset($_GET['paginate']) && (string)$_GET['paginate'] === '1';
$page = isset($_GET['page']) && is_numeric($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
$pageSize = isset($_GET['page_size']) && is_numeric($_GET['page_size']) ? (int)$_GET['page_size'] : 15;
$pageSize = max(1, min(100, $pageSize));
$start_date = $_GET['start_date'] ?? null;
$end_date = $_GET['end_date'] ?? null;
$room_id = isset($_GET['room_id']) && is_numeric($_GET['room_id']) ? (int)$_GET['room_id'] : null;
$building_id = isset($_GET['building_id']) && is_numeric($_GET['building_id']) ? (int)$_GET['building_id'] : null;
$floor_id = isset($_GET['floor_id']) && is_numeric($_GET['floor_id']) ? (int)$_GET['floor_id'] : null;
$teacher_id = isset($_GET['teacher_id']) && is_numeric($_GET['teacher_id']) ? (int)$_GET['teacher_id'] : null;
$dept_id = isset($_GET['dept_id']) && is_numeric($_GET['dept_id']) ? (int)$_GET['dept_id'] : null;
$program_id = isset($_GET['program_id']) && is_numeric($_GET['program_id']) ? (int)$_GET['program_id'] : null;
$semester_id = isset($_GET['semester_id']) && is_numeric($_GET['semester_id']) ? (int)$_GET['semester_id'] : null;
$attendance_status = strtolower(trim((string)($_GET['attendance_status'] ?? '')));
$warning_progress_filter = strtolower(trim((string)($_GET['warning_progress'] ?? '')));
$penalty_status_filter = strtolower(trim((string)($_GET['penalty_status'] ?? '')));
$report_view = strtolower(trim((string)($_GET['view'] ?? 'summary')));
$substitute_teacher_id = isset($_GET['substitute_teacher_id']) && is_numeric($_GET['substitute_teacher_id']) ? (int)$_GET['substitute_teacher_id'] : null;
$leave_type_id = isset($_GET['leave_type_id']) && is_numeric($_GET['leave_type_id']) ? (int)$_GET['leave_type_id'] : null;
$coverage_status_filter = strtolower(trim((string)($_GET['coverage_status'] ?? '')));
$leave_status_filter = strtolower(trim((string)($_GET['leave_status'] ?? '')));
$validReportViews = ['summary', 'detailed'];
$validCoverageStatusFilters = ['', 'covered', 'uncovered', 'no_classes'];
$validLeaveStatusFilters = ['', 'recorded', 'voided', 'pending'];
if (!in_array($report_view, $validReportViews, true)) {
    json_response(['error' => 'invalid_report_view', 'message' => 'The selected report view is invalid.'], 400);
}
if (!in_array($coverage_status_filter, $validCoverageStatusFilters, true)) {
    json_response(['error' => 'invalid_coverage_status', 'message' => 'The selected coverage status filter is invalid.'], 400);
}
if (!in_array($leave_status_filter, $validLeaveStatusFilters, true)) {
    json_response(['error' => 'invalid_leave_status', 'message' => 'The selected leave status filter is invalid.'], 400);
}
$validWarningProgressFilters = ['', 'ok', 'warning_1', 'warning_2', 'red_flag'];
$validPenaltyStatusFilters = ['', 'active', 'voided', 'none'];
if (!in_array($warning_progress_filter, $validWarningProgressFilters, true)) {
    json_response(['error' => 'invalid_warning_progress', 'message' => 'The selected warning progress filter is invalid.'], 400);
}
if (!in_array($penalty_status_filter, $validPenaltyStatusFilters, true)) {
    json_response(['error' => 'invalid_penalty_status', 'message' => 'The selected penalty status filter is invalid.'], 400);
}
$time_from_raw = trim((string)($_GET['time_from'] ?? ''));
$time_to_raw = trim((string)($_GET['time_to'] ?? ''));
$validTimePattern = '/^(?:[01]\d|2[0-3]):[0-5]\d$/';
if ($time_from_raw !== '' && !preg_match($validTimePattern, $time_from_raw)) {
    json_response(['error' => 'invalid_time_from', 'message' => 'Time From must use HH:MM format.'], 400);
}
if ($time_to_raw !== '' && !preg_match($validTimePattern, $time_to_raw)) {
    json_response(['error' => 'invalid_time_to', 'message' => 'Time To must use HH:MM format.'], 400);
}
if ($time_from_raw !== '' && $time_to_raw !== '' && $time_from_raw > $time_to_raw) {
    json_response(['error' => 'invalid_time_range', 'message' => 'Time From cannot be later than Time To.'], 400);
}
$time_from = $time_from_raw !== '' ? $time_from_raw . ':00' : null;
$time_to = $time_to_raw !== '' ? $time_to_raw . ':59' : null;

// Only the system Admin may choose a department. Every other authenticated role
// is forcibly scoped to the department stored on their account.
$authRoleId = isset($authPayload['role_id']) ? (int)$authPayload['role_id'] : null;
$authDeptId = isset($authPayload['dept_id']) && $authPayload['dept_id'] !== null
    ? (int)$authPayload['dept_id']
    : null;
if ($authUserId) {
    $scopeStmt = $mysqli->prepare('SELECT role_id, dept_id FROM tbl_users WHERE user_id = ? LIMIT 1');
    if (!$scopeStmt) json_response(['error' => 'db_prepare_failed', 'message' => $mysqli->error], 500);
    $scopeStmt->bind_param('i', $authUserId);
    $scopeStmt->execute();
    $scopeRow = $scopeStmt->get_result()->fetch_assoc();
    $scopeStmt->close();
    if (!$scopeRow) json_response(['error' => 'unauthorized', 'message' => 'The authenticated account no longer exists.'], 401);
    $authRoleId = (int)$scopeRow['role_id'];
    $authDeptId = $scopeRow['dept_id'] !== null ? (int)$scopeRow['dept_id'] : null;
}
if ($authUserId && $authRoleId !== 1) {
    $dept_id = $authDeptId;
}
if ($report !== 'my_attendance_records' && in_array($authRoleId, [2, 3, 4, 6], true) && (!$authDeptId || $authDeptId <= 0)) {
    json_response(['error' => 'scope_not_configured', 'message' => 'Your account does not have an assigned department.'], 403);
}

if (!$report) {
    json_response(['error' => 'missing_report'], 400);
}
if (!$authUserId || !$authRoleId) {
    json_response(['error' => 'unauthorized', 'message' => 'Authentication is required to view reports.'], 401);
}

$allReportTypes = ['attendance_records', 'teacher_attendance_summary', 'attendance_logs', 'classroom_utilization', 'leave_substitution', 'system_logs'];
$myAttendanceReport = 'my_attendance_records';
$reportRoleCeilings = [
    1 => $allReportTypes,
    2 => array_merge($allReportTypes, [$myAttendanceReport]),
    6 => $allReportTypes,
    3 => ['attendance_records', $myAttendanceReport, 'teacher_attendance_summary', 'attendance_logs', 'classroom_utilization', 'leave_substitution'],
    4 => ['attendance_records', $myAttendanceReport, 'teacher_attendance_summary', 'classroom_utilization', 'leave_substitution'],
    5 => [$myAttendanceReport, 'teacher_attendance_summary'],
];
$allowedReports = $reportRoleCeilings[$authRoleId] ?? [];
if (!in_array($report, $allowedReports, true)) {
    json_response(['error' => 'forbidden_report', 'message' => 'Your role is not allowed to view this report.'], 403);
}

// Personal attendance always belongs to the authenticated user, even if a
// forged teacher_id, department, or program parameter is supplied.
$isMyAttendanceReport = $report === $myAttendanceReport;
if ($isMyAttendanceReport || $authRoleId === 5) {
    $teacher_id = $authUserId;
}
if ($isMyAttendanceReport) {
    $dept_id = null;
    $program_id = null;
}

// Resolve and validate the Program Head's owned-program scope. Integer IDs come
// only from the database before they are embedded into the scope expressions.
$ownedProgramIds = [];
if ($authRoleId === 3) {
    $ownedStmt = $mysqli->prepare('SELECT program_id FROM tbl_programs WHERE head_id = ? AND LOWER(COALESCE(status, \'active\')) <> \'archive\' ORDER BY program_id');
    if (!$ownedStmt) json_response(['error' => 'db_prepare_failed', 'message' => $mysqli->error], 500);
    $ownedStmt->bind_param('i', $authUserId);
    $ownedStmt->execute();
    $ownedRes = $ownedStmt->get_result();
    while ($ownedRow = $ownedRes->fetch_assoc()) $ownedProgramIds[] = (int)$ownedRow['program_id'];
    $ownedStmt->close();

    if ($program_id !== null) {
        if (!in_array($program_id, $ownedProgramIds, true)) {
            json_response(['error' => 'forbidden_program', 'message' => 'The selected program is outside your assigned scope.'], 403);
        }
        $ownedProgramIds = [$program_id];
    }
} else {
    // program_id is meaningful only for Program Heads; never trust it for other roles.
    $program_id = null;
}

$programIdSql = !empty($ownedProgramIds) ? implode(',', array_map('intval', $ownedProgramIds)) : '0';
$programRecordScope = function($userAlias, $subjectAlias, $sectionAlias) use ($programIdSql) {
    return "({$userAlias}.assigned_program_head_id IN ({$programIdSql}) OR {$subjectAlias}.program_id IN ({$programIdSql}) OR {$sectionAlias}.program_id IN ({$programIdSql}))";
};
$programUserScope = function($userAlias) use ($programIdSql) {
    return "({$userAlias}.assigned_program_head_id IN ({$programIdSql}) OR EXISTS (
        SELECT 1 FROM tbl_class_schedules scope_cs
        LEFT JOIN tbl_subject scope_subject ON scope_cs.subject_id = scope_subject.subject_id
        LEFT JOIN tbl_sections scope_section ON scope_cs.section_id = scope_section.section_id
        WHERE scope_cs.user_id = {$userAlias}.user_id
          AND (scope_subject.program_id IN ({$programIdSql}) OR scope_section.program_id IN ({$programIdSql}))
    ))";
};

// default date range: last 30 days
if (!$end_date) $end_date = date('Y-m-d');
if (!$start_date) $start_date = date('Y-m-d', strtotime($end_date . ' -30 days'));

$currentSemester = null;
$currentSemesterId = 0;
$semesterOptions = [];
if (in_array($report, ['attendance_records', $myAttendanceReport, 'teacher_attendance_summary', 'classroom_utilization', 'leave_substitution'], true)) {
    $semesterRes = $mysqli->query("SELECT sem.semester_id, sem.term, sem.status,
            sy.session_name,
            DATE_FORMAT(sem.start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(sem.end_date, '%Y-%m-%d') AS end_date
        FROM tbl_semesters sem
        LEFT JOIN tbl_school_year sy ON sy.school_year_id = sem.school_year_id
        ORDER BY sem.start_date DESC, sem.semester_id DESC");
    if (!$semesterRes) json_response(['error' => 'db_query_failed', 'message' => $mysqli->error], 500);
    while ($semesterRow = $semesterRes->fetch_assoc()) {
        $option = [
            'semester_id' => (int)$semesterRow['semester_id'],
            'session_name' => $semesterRow['session_name'] ?? '',
            'term' => $semesterRow['term'] ?? '',
            'start_date' => $semesterRow['start_date'] ?? '',
            'end_date' => $semesterRow['end_date'] ?? '',
            'status' => $semesterRow['status'] ?? '',
        ];
        $semesterOptions[] = $option;
        if ($semester_id !== null && (int)$option['semester_id'] === $semester_id) {
            $currentSemester = $option;
            $currentSemesterId = $semester_id;
        }
    }

    if ($semester_id !== null && !$currentSemester) {
        json_response(['error' => 'invalid_semester', 'message' => 'The selected semester is not available.'], 400);
    }

    if ($semester_id === null) {
        $activeSemesterRes = $mysqli->query("SELECT semester_id
        FROM tbl_semesters
        WHERE LOWER(TRIM(status)) = 'active'
          AND CURDATE() BETWEEN start_date AND end_date
        ORDER BY semester_id DESC
        LIMIT 1");
        if (!$activeSemesterRes) json_response(['error' => 'db_query_failed', 'message' => $mysqli->error], 500);
        $activeSemesterRow = $activeSemesterRes->fetch_assoc();
        if ($activeSemesterRow) {
            $currentSemesterId = (int)$activeSemesterRow['semester_id'];
            foreach ($semesterOptions as $option) {
                if ((int)$option['semester_id'] === $currentSemesterId) {
                    $currentSemester = $option;
                    break;
                }
            }
        }
    }

    if ($currentSemester) {
        if (!empty($currentSemester['start_date']) && $start_date < $currentSemester['start_date']) {
            $start_date = $currentSemester['start_date'];
        }
        if (!empty($currentSemester['end_date']) && $end_date > $currentSemester['end_date']) {
            $end_date = $currentSemester['end_date'];
        }
    }
}

$rows = [];
$columns = [];
$title = '';
$leaveTypeOptions = [];

if ($report === 'classroom_utilization') {
    $title = 'Classroom Utilization Report';
    $columns = ['Room Name','Total Classes Held','Total Hours Used (hrs)','Most Frequent Teacher'];

    $utilizationScopeCondition = 'u_scope.role_id IN (2, 3, 4, 5)';
    if ($authRoleId === 3) {
        $utilizationScopeCondition .= ' AND ' . $programRecordScope('u_scope', 'subj', 'sec');
    }

    // Conditional aggregation keeps rooms with zero qualifying activity visible.
    $sql = "SELECT r.room_id, r.room_name,
        COUNT(CASE WHEN {$utilizationScopeCondition} THEN ar.attendance_id END) AS total_classes,
        COALESCE(SUM(CASE WHEN {$utilizationScopeCondition} THEN TIME_TO_SEC(TIMEDIFF(cs.end_time, cs.start_time)) ELSE 0 END),0) AS total_seconds
        FROM tbl_rooms r
        LEFT JOIN tbl_attendance_records ar ON ar.room_id = r.room_id
          AND ar.date BETWEEN ? AND ?
          AND ar.schedule_id IN (
              SELECT schedule_id
              FROM tbl_class_schedules
              WHERE semester_id = ?
          )";
    
    if ($dept_id) {
        $sql .= " AND ar.user_id IN (SELECT user_id FROM tbl_users WHERE dept_id = ?)";
    }
    
    $sql .= " LEFT JOIN tbl_users u_scope ON ar.user_id = u_scope.user_id
              LEFT JOIN tbl_class_schedules cs ON ar.schedule_id = cs.schedule_id
              LEFT JOIN tbl_subject subj ON cs.subject_id = subj.subject_id
              LEFT JOIN tbl_sections sec ON cs.section_id = sec.section_id
              WHERE 1=1";

    $params = [$start_date, $end_date, $currentSemesterId];
    $types = 'ssi';
    if ($dept_id) { $types .= 'i'; $params[] = $dept_id; }
    if ($building_id) { $sql .= ' AND r.building_id = ?'; $types .= 'i'; $params[] = $building_id; }
    if ($floor_id) { $sql .= ' AND r.floor_id = ?'; $types .= 'i'; $params[] = $floor_id; }
    if ($room_id) { $sql .= ' AND r.room_id = ?'; $types .= 'i'; $params[] = $room_id; }
    $sql .= ' GROUP BY r.room_id ORDER BY total_classes DESC';
    
    $stmt = $mysqli->prepare($sql);
    if (!$stmt) json_response(['error' => 'db_prepare_failed', 'message' => $mysqli->error], 500);
    
    $refs = [];
    $refs[] = &$types;
    foreach ($params as $k => $v) { $refs[] = &$params[$k]; }
    call_user_func_array([$stmt, 'bind_param'], $refs);
    $stmt->execute();
    $res = $stmt->get_result();
    
    while ($r = $res->fetch_assoc()) {
        $topTeacherSql = "SELECT CONCAT_WS(' ',u.first_name,u.last_name) AS teacher, COUNT(*) AS cnt
            FROM tbl_attendance_records ar
            JOIN tbl_users u ON ar.user_id = u.user_id
            LEFT JOIN tbl_class_schedules cs_top ON ar.schedule_id = cs_top.schedule_id
            LEFT JOIN tbl_subject subj_top ON cs_top.subject_id = subj_top.subject_id
            LEFT JOIN tbl_sections sec_top ON cs_top.section_id = sec_top.section_id
            WHERE ar.room_id = ? AND ar.date BETWEEN ? AND ?
              AND cs_top.semester_id = ?
              AND u.role_id IN (2, 3, 4, 5)";
        $topTypes = 'issi';
        $topParams = [(int)$r['room_id'], $start_date, $end_date, $currentSemesterId];
        if ($dept_id) { $topTeacherSql .= ' AND u.dept_id = ?'; $topTypes .= 'i'; $topParams[] = $dept_id; }
        if ($authRoleId === 3) { $topTeacherSql .= ' AND ' . $programRecordScope('u', 'subj_top', 'sec_top'); }
        $topTeacherSql .= ' GROUP BY ar.user_id ORDER BY cnt DESC LIMIT 1';
        $q = $mysqli->prepare($topTeacherSql);
        $teacher = '';
        if ($q) {
            $topRefs = []; $topRefs[] = &$topTypes; foreach ($topParams as $tk => &$tv) $topRefs[] = &$tv;
            call_user_func_array([$q, 'bind_param'], $topRefs);
            $q->execute();
            $tr = $q->get_result()->fetch_assoc();
            if ($tr && !empty($tr['teacher'])) $teacher = $tr['teacher'];
            $q->close();
        }
        $total_hours = round(((int)$r['total_seconds'])/3600,2);
        $rows[] = ['Room Name' => $r['room_name'] ?? '','Total Classes Held' => (int)$r['total_classes'],'Total Hours Used (hrs)' => $total_hours,'Most Frequent Teacher' => $teacher];
    }
    $stmt->close();

} elseif ($report === 'leave_substitution') {
    $title = 'Leave & Substitution Coverage - ' . ($report_view === 'detailed' ? 'Detailed' : 'Summary');
    $leaveStatusExpr = "CASE LOWER(COALESCE(l.req_status,'')) WHEN 'approve' THEN 'Recorded' WHEN 'void' THEN 'Voided' WHEN 'pending' THEN 'Pending' ELSE 'Unknown' END";
    $coveredExpr = "(sub.substitution_id IS NOT NULL AND LOWER(COALESCE(sub.req_status,'pending')) NOT IN ('canceled','rejected'))";
    $baseWhere = [
        'l.date_to >= ?',
        'l.date_from <= ?',
        'u.role_id IN (2, 3, 4, 5)',
    ];
    $params = [$start_date, $end_date];
    $types = 'ss';
    if ($currentSemesterId > 0) { $baseWhere[] = '(cs.semester_id = ? OR cs.semester_id IS NULL)'; $types .= 'i'; $params[] = $currentSemesterId; }
    if ($teacher_id) { $baseWhere[] = 'l.teacher_id = ?'; $types .= 'i'; $params[] = $teacher_id; }
    if ($substitute_teacher_id) { $baseWhere[] = 'sub.substitute_user_id = ?'; $types .= 'i'; $params[] = $substitute_teacher_id; }
    if ($leave_type_id) { $baseWhere[] = 'l.leave_type_id = ?'; $types .= 'i'; $params[] = $leave_type_id; }
    if ($dept_id) { $baseWhere[] = 'u.dept_id = ?'; $types .= 'i'; $params[] = $dept_id; }
    if ($authRoleId === 3) { $baseWhere[] = $programUserScope('u'); }
    if ($leave_status_filter !== '') {
        $statusMap = ['recorded' => 'approve', 'voided' => 'void', 'pending' => 'pending'];
        $baseWhere[] = 'LOWER(COALESCE(l.req_status,\'\')) = ?';
        $types .= 's';
        $params[] = $statusMap[$leave_status_filter];
    }

    $fromSql = "
        FROM tbl_leaves l
        JOIN tbl_users u ON u.user_id = l.teacher_id
        LEFT JOIN tbl_leave_type lt ON lt.leave_type_id = l.leave_type_id
        LEFT JOIN tbl_users recorder ON recorder.user_id = l.requested_by
        LEFT JOIN tbl_attendance_records ar
          ON ar.user_id = l.teacher_id
         AND ar.date BETWEEN l.date_from AND l.date_to
         AND ar.date BETWEEN ? AND ?
        LEFT JOIN tbl_class_schedules cs ON cs.schedule_id = ar.schedule_id
        LEFT JOIN tbl_subject subj ON subj.subject_id = cs.subject_id
        LEFT JOIN tbl_sections sec ON sec.section_id = cs.section_id
        LEFT JOIN tbl_rooms room ON room.room_id = COALESCE(ar.room_id, cs.room_id)
        LEFT JOIN tbl_substitutions sub
          ON sub.leave_id = l.leave_id
         AND sub.schedule_id = ar.schedule_id
         AND sub.date = ar.date
        LEFT JOIN tbl_users substitute ON substitute.user_id = sub.substitute_user_id
    ";
    // The attendance-date placeholders occur before the WHERE placeholders.
    $queryParams = array_merge([$start_date, $end_date], $params);
    $queryTypes = 'ss' . $types;

    if ($report_view === 'detailed') {
        $columns = ['Date','Original Teacher','Leave Type','Subject & Section','Scheduled Time','Room','Substitute Teacher','Substitution Status','Coverage Status','Leave Status','Recorded By','Remarks'];
        $sql = "SELECT
                l.leave_id AS _leave_id,
                ar.attendance_id AS _attendance_id,
                DATE_FORMAT(ar.date, '%Y-%m-%d') AS `Date`,
                CONCAT_WS(' ', u.first_name, u.last_name) AS `Original Teacher`,
                COALESCE(lt.name_type, 'Unspecified') AS `Leave Type`,
                TRIM(CONCAT(COALESCE(subj.subject_code, subj.subject_name, 'Unspecified subject'),
                    CASE WHEN sec.section_name IS NULL OR sec.section_name = '' THEN '' ELSE CONCAT(' / ', sec.section_name) END)) AS `Subject & Section`,
                CASE WHEN cs.start_time IS NULL THEN '—' ELSE CONCAT(DATE_FORMAT(cs.start_time, '%l:%i %p'), ' - ', DATE_FORMAT(cs.end_time, '%l:%i %p')) END AS `Scheduled Time`,
                COALESCE(room.room_name, 'Unassigned') AS `Room`,
                CASE WHEN substitute.user_id IS NULL THEN 'Not assigned' ELSE CONCAT_WS(' ', substitute.first_name, substitute.last_name) END AS `Substitute Teacher`,
                CASE
                    WHEN sub.substitution_id IS NULL THEN 'Not Assigned'
                    WHEN LOWER(COALESCE(sub.req_status,'pending')) IN ('canceled','rejected') THEN CONCAT(UCASE(LEFT(sub.req_status,1)), SUBSTRING(sub.req_status,2))
                    WHEN LOWER(COALESCE(sub.req_status,'pending')) = 'approve' THEN 'Confirmed'
                    ELSE 'Assigned'
                END AS `Substitution Status`,
                CASE WHEN ar.attendance_id IS NULL THEN 'No Classes' WHEN {$coveredExpr} THEN 'Covered' ELSE 'Uncovered' END AS `Coverage Status`,
                {$leaveStatusExpr} AS `Leave Status`,
                COALESCE(NULLIF(CONCAT_WS(' ', recorder.first_name, recorder.last_name), ''), 'System') AS `Recorded By`,
                COALESCE(NULLIF(l.reason,''), 'No remarks provided') AS `Remarks`
            {$fromSql}
            WHERE " . implode(' AND ', $baseWhere);
        if ($coverage_status_filter === 'covered') $sql .= " AND {$coveredExpr}";
        elseif ($coverage_status_filter === 'uncovered') $sql .= " AND ar.attendance_id IS NOT NULL AND NOT {$coveredExpr}";
        elseif ($coverage_status_filter === 'no_classes') $sql .= ' AND ar.attendance_id IS NULL';
        $sql .= ' ORDER BY ar.date DESC, cs.start_time ASC, u.last_name ASC, u.first_name ASC';
    } else {
        $columns = ['Original Teacher','Leave Type','Leave Period','Total Leave Days','Affected Classes','Covered Classes','Uncovered Classes','Coverage Rate','Leave Status','Coverage Status','Reason'];
        $sql = "SELECT
                l.leave_id AS _leave_id,
                CONCAT_WS(' ', u.first_name, u.last_name) AS `Original Teacher`,
                COALESCE(lt.name_type, 'Unspecified') AS `Leave Type`,
                CONCAT(DATE_FORMAT(l.date_from, '%Y-%m-%d'), ' to ', DATE_FORMAT(l.date_to, '%Y-%m-%d')) AS `Leave Period`,
                DATEDIFF(l.date_to, l.date_from) + 1 AS `Total Leave Days`,
                COUNT(DISTINCT ar.attendance_id) AS `Affected Classes`,
                COUNT(DISTINCT CASE WHEN {$coveredExpr} THEN ar.attendance_id END) AS `Covered Classes`,
                COUNT(DISTINCT CASE WHEN ar.attendance_id IS NOT NULL AND NOT {$coveredExpr} THEN ar.attendance_id END) AS `Uncovered Classes`,
                CASE WHEN COUNT(DISTINCT ar.attendance_id) = 0 THEN 'N/A'
                     ELSE CONCAT(ROUND(100 * COUNT(DISTINCT CASE WHEN {$coveredExpr} THEN ar.attendance_id END) / COUNT(DISTINCT ar.attendance_id), 1), '%') END AS `Coverage Rate`,
                {$leaveStatusExpr} AS `Leave Status`,
                CASE
                    WHEN COUNT(DISTINCT ar.attendance_id) = 0 THEN 'No Classes'
                    WHEN COUNT(DISTINCT CASE WHEN {$coveredExpr} THEN ar.attendance_id END) = COUNT(DISTINCT ar.attendance_id) THEN 'Fully Covered'
                    WHEN COUNT(DISTINCT CASE WHEN {$coveredExpr} THEN ar.attendance_id END) = 0 THEN 'Uncovered'
                    ELSE 'Partially Covered'
                END AS `Coverage Status`,
                COALESCE(NULLIF(l.reason,''), 'No reason provided') AS `Reason`
            {$fromSql}
            WHERE " . implode(' AND ', $baseWhere) . "
            GROUP BY l.leave_id, u.first_name, u.last_name, lt.name_type, l.date_from, l.date_to, l.req_status, l.reason";
        if ($coverage_status_filter === 'covered') $sql .= " HAVING `Affected Classes` > 0 AND `Uncovered Classes` = 0";
        elseif ($coverage_status_filter === 'uncovered') $sql .= " HAVING `Affected Classes` > 0 AND `Uncovered Classes` > 0";
        elseif ($coverage_status_filter === 'no_classes') $sql .= " HAVING `Affected Classes` = 0";
        $sql .= ' ORDER BY l.date_from DESC, u.last_name ASC, u.first_name ASC';
    }

    $stmt = $mysqli->prepare($sql);
    if (!$stmt) json_response(['error'=>'db_prepare_failed','message'=>$mysqli->error],500);
    $refs = [&$queryTypes];
    foreach ($queryParams as $k => $v) $refs[] = &$queryParams[$k];
    call_user_func_array([$stmt, 'bind_param'], $refs);
    if (!$stmt->execute()) json_response(['error'=>'db_execute_failed','message'=>$stmt->error],500);
    $res = $stmt->get_result();
    while ($r = $res->fetch_assoc()) $rows[] = $r;
    $stmt->close();

    $leaveTypeRes = $mysqli->query('SELECT leave_type_id, name_type FROM tbl_leave_type ORDER BY name_type');
    if ($leaveTypeRes) {
        while ($typeRow = $leaveTypeRes->fetch_assoc()) {
            $leaveTypeOptions[] = [
                'leave_type_id' => (int)$typeRow['leave_type_id'],
                'name_type' => $typeRow['name_type'] ?? '',
            ];
        }
    }

} elseif (in_array($report, ['attendance_records', $myAttendanceReport], true)) {
    $title = $isMyAttendanceReport ? 'My Attendance Records' : 'Attendance Records';
    $columns = ['#','Teacher','Schedule','Room','Date','Scheduled Time','Check In Status','Check In Timestamp','Mid Check Status','Mid Check Timestamp','Check Out Status','Check Out Timestamp','Overall Status'];

    // Support both schemas:
    // 1) Legacy: class_schedules.offering_id -> subject_offerings
    // 2) Current: class_schedules.subject_id/section_id direct links
    $hasSubjectOfferings = false;
    $csHasOfferingCol = false;
    $tRes = $mysqli->query("SHOW TABLES LIKE 'tbl_subject_offerings'");
    if ($tRes && $tRes->num_rows > 0) $hasSubjectOfferings = true;
    $cRes = $mysqli->query("SHOW COLUMNS FROM tbl_class_schedules LIKE 'offering_id'");
    if ($cRes && $cRes->num_rows > 0) $csHasOfferingCol = true;

    $subjectJoinSql = '';
    if ($hasSubjectOfferings && $csHasOfferingCol) {
        $subjectJoinSql = "LEFT JOIN tbl_subject_offerings so ON cs.offering_id = so.offering_id
        LEFT JOIN tbl_subject s ON so.subject_id = s.subject_id
        LEFT JOIN tbl_sections sec ON so.section_id = sec.section_id";
    } else {
        $subjectJoinSql = "LEFT JOIN tbl_subject s ON cs.subject_id = s.subject_id
        LEFT JOIN tbl_sections sec ON cs.section_id = sec.section_id";
    }

    $sql = "SELECT ar.attendance_id, ar.user_id, CONCAT_WS(' ', tu.first_name, tu.last_name) AS teacher_name,
               cs.schedule_id, cs.start_time, cs.end_time,
               s.subject_code, s.subject_name, sec.section_name,
               r.room_name AS room_name, ar.date,
               ft_in.flag_name AS flag_in, ar.checked_in_at,
               ft_check.flag_name AS flag_check, ar.checked_mid_at,
               ft_out.flag_name AS flag_out, ar.checked_out_at
        FROM tbl_attendance_records ar
        LEFT JOIN tbl_users tu ON ar.user_id = tu.user_id
        LEFT JOIN tbl_rooms r ON ar.room_id = r.room_id
        JOIN tbl_class_schedules cs ON ar.schedule_id = cs.schedule_id
        {$subjectJoinSql}
        LEFT JOIN tbl_flag_types ft_in ON ar.flag_in_id = ft_in.flag_id
        LEFT JOIN tbl_flag_types ft_check ON ar.flag_check_id = ft_check.flag_id
        LEFT JOIN tbl_flag_types ft_out ON ar.flag_out_id = ft_out.flag_id
        WHERE ar.date BETWEEN ? AND ?
          AND cs.semester_id = ?
          AND tu.role_id IN (2, 3, 4, 5)";

    $params = [$start_date, $end_date, $currentSemesterId]; $types = 'ssi';
    if ($teacher_id) { $sql .= ' AND ar.user_id = ?'; $types .= 'i'; $params[] = $teacher_id; }
    if ($room_id) { $sql .= ' AND ar.room_id = ?'; $types .= 'i'; $params[] = $room_id; }
    if (!$isMyAttendanceReport && $dept_id) { $sql .= ' AND tu.dept_id = ?'; $types .= 'i'; $params[] = $dept_id; } // ADDED DEPT FILTER
    if (!$isMyAttendanceReport && $authRoleId === 3) { $sql .= ' AND ' . $programRecordScope('tu', 's', 'sec'); }
    if ($time_from !== null) { $sql .= ' AND cs.start_time >= ?'; $types .= 's'; $params[] = $time_from; }
    if ($time_to !== null) { $sql .= ' AND cs.start_time <= ?'; $types .= 's'; $params[] = $time_to; }
    
    $sql .= ' ORDER BY ar.date DESC, cs.start_time, tu.last_name, tu.first_name';

    $stmt = $mysqli->prepare($sql);
    if (!$stmt) json_response(['error'=>'db_prepare_failed','message'=>$mysqli->error,'sql'=>$sql],500);
    $refs = []; $refs[] = &$types; foreach ($params as $k=>&$v) $refs[] = &$v; call_user_func_array([$stmt,'bind_param'],$refs);
    $stmt->execute();
    $res = $stmt->get_result();
    if ($res) {
        $i = 1;
        $out = [];
        $formatScheduledTime = static function ($value) {
            $raw = trim((string)$value);
            if ($raw === '') return '';
            $timestamp = strtotime($raw);
            return $timestamp === false ? $raw : date('g:i A', $timestamp);
        };
        while ($r = $res->fetch_assoc()) {
            $scheduleLabel = '';
            if (!empty($r['subject_code']) || !empty($r['subject_name'])) {
                $code = $r['subject_code'] ?: $r['subject_name'];
                $section = $r['section_name'] ? (' / ' . $r['section_name']) : '';
                $scheduleLabel = $code . $section;
            }
            $overallStatus = attendance_overall_status([
                $r['flag_in'] ?? '',
                $r['flag_check'] ?? '',
                $r['flag_out'] ?? '',
            ]);
            $overallKey = normalize_attendance_status_key($overallStatus);
            $allowedAttendanceStatuses = ['present', 'late', 'absent', 'incomplete', 'pending', 'upcoming', 'substituted', 'on_leave', 'other'];
            if (in_array($attendance_status, $allowedAttendanceStatuses, true)) {
                $matchesOverall = $attendance_status === 'other'
                    ? !in_array($overallKey, ['present', 'late', 'absent', 'incomplete', 'pending', 'upcoming', 'substituted', 'on_leave'], true)
                    : $overallKey === $attendance_status;
                if (!$matchesOverall) continue;
            }

            $scheduledStart = $formatScheduledTime($r['start_time'] ?? '');
            $scheduledEnd = $formatScheduledTime($r['end_time'] ?? '');
            $scheduledTime = $scheduledStart && $scheduledEnd
                ? $scheduledStart . ' - ' . $scheduledEnd
                : ($scheduledStart ?: $scheduledEnd);

            $out[] = [
                '#' => $i++,
                '_user_id' => (int)($r['user_id'] ?? 0),
                '_subject_code' => $r['subject_code'] ?? '',
                '_subject_name' => $r['subject_name'] ?? '',
                '_section_name' => $r['section_name'] ?? '',
                'Teacher' => $r['teacher_name'] ?? '',
                'Schedule' => $scheduleLabel,
                'Room' => $r['room_name'] ?? '',
                'Date' => $r['date'] ?? '',
                'Scheduled Time' => $scheduledTime,
                'Check In Status' => $r['flag_in'] ?? '',
                'Check In Timestamp' => $r['checked_in_at'] ?? '',
                'Mid Check Status' => $r['flag_check'] ?? '',
                'Mid Check Timestamp' => $r['checked_mid_at'] ?? '',
                'Check Out Status' => $r['flag_out'] ?? '',
                'Check Out Timestamp' => $r['checked_out_at'] ?? '',
                'Overall Status' => $overallStatus,
                // Legacy aliases remain available for existing integrations.
                'Flag In' => $r['flag_in'] ?? '',
                'Checked In' => $r['checked_in_at'] ?? '',
                'Flag Check' => $r['flag_check'] ?? '',
                'Checked Mid' => $r['checked_mid_at'] ?? '',
                'Flag Out' => $r['flag_out'] ?? '',
                'Checked Out' => $r['checked_out_at'] ?? '',
            ];
        }
        $rows = $out;
        $stmt->close();
    } else {
        json_response(['error'=>'db_query_failed','message'=>$mysqli->error],500);
    }

} elseif ($report === 'teacher_attendance_summary') {
    $title = 'Teacher Attendance Summary';
    $columns = [
        '#',
        'Teacher',
        'Department',
        'Total Classes',
        'Present',
        'Late',
        'Absent',
        'Unresolved',
        'Total Late Minutes',
        'Late Minutes by Day',
        'Late Warnings',
        'Warning Progress',
        'Tardiness Penalty',
        'Penalty Date',
        'Penalty Status',
    ];

    $sql = "SELECT
                ar.user_id,
                CONCAT_WS(' ', u.first_name, u.last_name) AS teacher_name,
                COALESCE(d.dept_name, '') AS dept_name,
                ar.date,
                ar.checked_in_at,
                ar.flag_in_id,
                cs.start_time
            FROM tbl_attendance_records ar
            JOIN tbl_users u ON ar.user_id = u.user_id
            LEFT JOIN tbl_departments d ON u.dept_id = d.dept_id
            JOIN tbl_class_schedules cs ON ar.schedule_id = cs.schedule_id
            LEFT JOIN tbl_subject s_summary ON cs.subject_id = s_summary.subject_id
            LEFT JOIN tbl_sections sec_summary ON cs.section_id = sec_summary.section_id
            WHERE ar.date BETWEEN ? AND ?
              AND cs.semester_id = ?
              AND u.role_id IN (2, 3, 4, 5)";

    $params = [$start_date, $end_date, $currentSemesterId];
    $types = 'ssi';
    if ($teacher_id) { $sql .= ' AND ar.user_id = ?'; $types .= 'i'; $params[] = $teacher_id; }
    if ($dept_id) { $sql .= ' AND u.dept_id = ?'; $types .= 'i'; $params[] = $dept_id; }
    if ($authRoleId === 3) { $sql .= ' AND ' . $programRecordScope('u', 's_summary', 'sec_summary'); }
    $sql .= ' ORDER BY u.last_name, u.first_name, ar.date ASC, cs.start_time ASC';

    $stmt = $mysqli->prepare($sql);
    if (!$stmt) json_response(['error' => 'db_prepare_failed', 'message' => $mysqli->error], 500);

    $refs = [];
    $refs[] = &$types;
    foreach ($params as $k => &$v) $refs[] = &$v;
    call_user_func_array([$stmt, 'bind_param'], $refs);

    $stmt->execute();
    $res = $stmt->get_result();
    if (!$res) json_response(['error' => 'db_query_failed', 'message' => $mysqli->error], 500);

    $summary = [];
    while ($r = $res->fetch_assoc()) {
        $uid = (int)($r['user_id'] ?? 0);
        if ($uid <= 0) continue;

        if (!isset($summary[$uid])) {
            $summary[$uid] = [
                'Teacher' => trim((string)($r['teacher_name'] ?? '')) ?: ('User #' . $uid),
                'Department' => trim((string)($r['dept_name'] ?? '')),
                'Total Classes' => 0,
                'Present' => 0,
                'Late' => 0,
                'Absent' => 0,
                'Unresolved' => 0,
                'Total Late Minutes' => 0,
                '_late_by_day' => [],
                '_late_warnings' => 0,
                '_penalty_date' => '',
                '_penalty_status' => '',
            ];
        }

        $summary[$uid]['Total Classes']++;
        $recordDate = (string)($r['date'] ?? '');
        $checkedInAt = $r['checked_in_at'] ?? null;
        $flagIn = isset($r['flag_in_id']) ? (int)$r['flag_in_id'] : 0;
        $startTime = trim((string)($r['start_time'] ?? ''));
        $graceMinutes = 15;

        $scheduledTs = null;
        $checkedTs = null;
        if ($recordDate !== '' && $startTime !== '') {
            $scheduledTs = strtotime($recordDate . ' ' . $startTime);
        }
        if (!empty($checkedInAt)) {
            $checkedTs = strtotime((string)$checkedInAt);
        }

        $isPolicyLate = false;
        $lateMinutes = 0;
        if ($scheduledTs !== false && $scheduledTs !== null && $checkedTs !== false && $checkedTs !== null) {
            $lateThresholdTs = $scheduledTs + ($graceMinutes * 60);
            if ($checkedTs > $lateThresholdTs) {
                $isPolicyLate = true;
                $lateMinutes = (int) floor(($checkedTs - $lateThresholdTs) / 60);
                if ($lateMinutes < 0) $lateMinutes = 0;
            }

        }

        if ($flagIn === 3) {
            $summary[$uid]['Absent']++;
        } elseif ($isPolicyLate || $flagIn === 5) {
            $summary[$uid]['Late']++;
        } elseif ($flagIn === 2 || (!empty($checkedInAt) && $flagIn !== 4 && $flagIn !== 7)) {
            $summary[$uid]['Present']++;
        } else {
            $summary[$uid]['Unresolved']++;
        }

        if ($lateMinutes > 0) {
            $summary[$uid]['Total Late Minutes'] += $lateMinutes;
            if (!isset($summary[$uid]['_late_by_day'][$recordDate])) $summary[$uid]['_late_by_day'][$recordDate] = 0;
            $summary[$uid]['_late_by_day'][$recordDate] += $lateMinutes;
        }
    }
    $stmt->close();

    // Warning totals always cover the whole selected semester. A parallel group
    // (same user/date/start/end) contributes only one warning for each late stage.
    $warningSql = "SELECT warning.user_id, COUNT(*) AS late_warnings
        FROM (
            SELECT ar.user_id, ar.date, cs.start_time, cs.end_time, 'check_in' AS stage
            FROM tbl_attendance_records ar
            JOIN tbl_class_schedules cs ON cs.schedule_id = ar.schedule_id
            JOIN tbl_users u ON u.user_id = ar.user_id
            LEFT JOIN tbl_subject s_warning ON cs.subject_id = s_warning.subject_id
            LEFT JOIN tbl_sections sec_warning ON cs.section_id = sec_warning.section_id
            WHERE cs.semester_id = ? AND ar.flag_in_id = 5 AND u.role_id IN (2, 3, 4, 5)";
    $warningParams = [$currentSemesterId];
    $warningTypes = 'i';
    if ($teacher_id) { $warningSql .= ' AND ar.user_id = ?'; $warningTypes .= 'i'; $warningParams[] = $teacher_id; }
    if ($dept_id) { $warningSql .= ' AND u.dept_id = ?'; $warningTypes .= 'i'; $warningParams[] = $dept_id; }
    if ($authRoleId === 3) $warningSql .= ' AND ' . $programRecordScope('u', 's_warning', 'sec_warning');
    $warningSql .= " GROUP BY ar.user_id, ar.date, cs.start_time, cs.end_time
            UNION ALL
            SELECT ar.user_id, ar.date, cs.start_time, cs.end_time, 'mid_check' AS stage
            FROM tbl_attendance_records ar
            JOIN tbl_class_schedules cs ON cs.schedule_id = ar.schedule_id
            JOIN tbl_users u ON u.user_id = ar.user_id
            LEFT JOIN tbl_subject s_warning ON cs.subject_id = s_warning.subject_id
            LEFT JOIN tbl_sections sec_warning ON cs.section_id = sec_warning.section_id
            WHERE cs.semester_id = ? AND ar.flag_check_id = 5 AND u.role_id IN (2, 3, 4, 5)";
    $warningTypes .= 'i';
    $warningParams[] = $currentSemesterId;
    if ($teacher_id) { $warningSql .= ' AND ar.user_id = ?'; $warningTypes .= 'i'; $warningParams[] = $teacher_id; }
    if ($dept_id) { $warningSql .= ' AND u.dept_id = ?'; $warningTypes .= 'i'; $warningParams[] = $dept_id; }
    if ($authRoleId === 3) $warningSql .= ' AND ' . $programRecordScope('u', 's_warning', 'sec_warning');
    $warningSql .= ' GROUP BY ar.user_id, ar.date, cs.start_time, cs.end_time) warning GROUP BY warning.user_id';

    $warningStmt = $mysqli->prepare($warningSql);
    if (!$warningStmt) json_response(['error' => 'db_prepare_failed', 'message' => $mysqli->error], 500);
    $warningRefs = [&$warningTypes];
    foreach ($warningParams as $k => &$warningValue) $warningRefs[] = &$warningValue;
    call_user_func_array([$warningStmt, 'bind_param'], $warningRefs);
    $warningStmt->execute();
    $warningRes = $warningStmt->get_result();
    while ($warningRow = $warningRes->fetch_assoc()) {
        $warningUserId = (int)$warningRow['user_id'];
        if (isset($summary[$warningUserId])) $summary[$warningUserId]['_late_warnings'] = (int)$warningRow['late_warnings'];
    }
    $warningStmt->close();

    // Automatic policy rows are unique by user/semester. Manual penalties do not
    // change the warning progress displayed here.
    $penaltySql = "SELECT p.user_id, p.date, p.status
        FROM tbl_penalties p
        JOIN tbl_users u ON u.user_id = p.user_id
        WHERE p.semester_id = ? AND p.policy_code = 'SEMESTER_LATE_3'";
    $penaltyParams = [$currentSemesterId];
    $penaltyTypes = 'i';
    if ($teacher_id) { $penaltySql .= ' AND p.user_id = ?'; $penaltyTypes .= 'i'; $penaltyParams[] = $teacher_id; }
    if ($dept_id) { $penaltySql .= ' AND u.dept_id = ?'; $penaltyTypes .= 'i'; $penaltyParams[] = $dept_id; }
    if ($authRoleId === 3) $penaltySql .= ' AND ' . $programUserScope('u');
    $penaltyStmt = $mysqli->prepare($penaltySql);
    if (!$penaltyStmt) json_response(['error' => 'db_prepare_failed', 'message' => $mysqli->error], 500);
    $penaltyRefs = [&$penaltyTypes];
    foreach ($penaltyParams as $k => &$penaltyValue) $penaltyRefs[] = &$penaltyValue;
    call_user_func_array([$penaltyStmt, 'bind_param'], $penaltyRefs);
    $penaltyStmt->execute();
    $penaltyRes = $penaltyStmt->get_result();
    while ($penaltyRow = $penaltyRes->fetch_assoc()) {
        $penaltyUserId = (int)$penaltyRow['user_id'];
        if (!isset($summary[$penaltyUserId])) continue;
        $summary[$penaltyUserId]['_penalty_date'] = (string)($penaltyRow['date'] ?? '');
        $summary[$penaltyUserId]['_penalty_status'] = strtolower((string)($penaltyRow['status'] ?? ''));
    }
    $penaltyStmt->close();

    $out = [];
    foreach ($summary as $uid => $item) {
        $lateByDay = $item['_late_by_day'];
        ksort($lateByDay);
        $dailyParts = [];
        foreach ($lateByDay as $dateKey => $mins) {
            $dailyParts[] = $dateKey . ': ' . (int)$mins . ' min';
        }
        $dailyLateText = !empty($dailyParts) ? implode('; ', $dailyParts) : '-';

        $lateWarnings = (int)$item['_late_warnings'];
        $penaltyStatus = (string)$item['_penalty_status'];
        $hasActivePenalty = $penaltyStatus === 'active';
        $warningProgress = $hasActivePenalty || $lateWarnings >= 3
            ? 'RED FLAG'
            : ($lateWarnings > 0 ? 'WARNING (' . $lateWarnings . '/3)' : 'OK');

        $out[] = [
            '#' => 0,
            'Teacher' => $item['Teacher'],
            'Department' => $item['Department'],
            'Total Classes' => (int)$item['Total Classes'],
            'Present' => (int)$item['Present'],
            'Late' => (int)$item['Late'],
            'Absent' => (int)$item['Absent'],
            'Unresolved' => (int)$item['Unresolved'],
            'Total Late Minutes' => (int)$item['Total Late Minutes'],
            'Late Minutes by Day' => $dailyLateText,
            'Late Warnings' => $lateWarnings,
            'Warning Progress' => $warningProgress,
            'Tardiness Penalty' => $hasActivePenalty ? 'RED FLAG' : ($penaltyStatus === 'voided' ? 'Voided' : 'None'),
            'Penalty Date' => $item['_penalty_date'] ?: '-',
            'Penalty Status' => $penaltyStatus !== '' ? ucfirst($penaltyStatus) : '-',
        ];
    }

    if ($warning_progress_filter !== '') {
        $warningProgressLabels = [
            'ok' => 'OK',
            'warning_1' => 'WARNING (1/3)',
            'warning_2' => 'WARNING (2/3)',
            'red_flag' => 'RED FLAG',
        ];
        $expectedWarningProgress = $warningProgressLabels[$warning_progress_filter];
        $out = array_values(array_filter($out, static function ($row) use ($expectedWarningProgress) {
            return strtoupper(trim((string)($row['Warning Progress'] ?? ''))) === $expectedWarningProgress;
        }));
    }

    if ($penalty_status_filter !== '') {
        $out = array_values(array_filter($out, static function ($row) use ($penalty_status_filter) {
            $status = strtolower(trim((string)($row['Penalty Status'] ?? '')));
            if ($penalty_status_filter === 'none') return $status === '' || $status === '-';
            return $status === $penalty_status_filter;
        }));
    }

    usort($out, function($a, $b) {
        $flagCmp = (int)$b['Late Warnings'] <=> (int)$a['Late Warnings'];
        if ($flagCmp !== 0) return $flagCmp;
        $lateCmp = (int)$b['Total Late Minutes'] <=> (int)$a['Total Late Minutes'];
        if ($lateCmp !== 0) return $lateCmp;
        return strcasecmp((string)$a['Teacher'], (string)$b['Teacher']);
    });

    foreach ($out as $i => &$row) {
        $row['#'] = $i + 1;
    }
    unset($row);
    $rows = $out;

} elseif ($report === 'attendance_logs') {
    $title = 'Attendance Logs';
    $columns = ['Edit Session', 'Teacher', 'Action', 'Field', 'Old Value', 'New Value', 'Reason', 'Edited By', 'Network Information', 'Date'];

    // The dedicated Attendance Adjustment Logs page uses database filtering
    // and session-level pagination. Report previews and exports intentionally
    // continue through the legacy query below so their output is unchanged.
    $optimizedAttendanceLogsPage = !$export
        && isset($_GET['attendance_logs_page'])
        && (string)$_GET['attendance_logs_page'] === '1';
    if ($optimizedAttendanceLogsPage) {
        $logSearch = substr(trim((string)($_GET['search'] ?? '')), 0, 200);
        $logAction = substr(trim((string)($_GET['action'] ?? '')), 0, 100);
        ensure_ip_geolocation_cache_table($mysqli);

        $logSessionExpression = "CASE
            WHEN NULLIF(TRIM(COALESCE(l.edit_session_id, '')), '') IS NOT NULL
                THEN CONCAT('session:', TRIM(l.edit_session_id))
            ELSE CONCAT('log:', l.log_id)
        END";
        $logTeacherExpression = "TRIM(CONCAT(COALESCE(target.first_name,''), ' ', COALESCE(target.last_name,'')))";
        $logEditorExpression = "TRIM(CONCAT(COALESCE(editor.first_name,''), ' ', COALESCE(editor.last_name,'')))";
        $logFieldExpression = "CASE LOWER(TRIM(COALESCE(l.field_name, '')))
            WHEN 'flag_in' THEN 'Check In'
            WHEN 'flag_mid' THEN 'Mid Check'
            WHEN 'flag_check' THEN 'Mid Check'
            WHEN 'flag_out' THEN 'Check Out'
            ELSE COALESCE(l.field_name, '')
        END";
        $logOldValueExpression = "CASE
            WHEN LOWER(TRIM(COALESCE(l.field_name, ''))) IN ('flag_in','flag_mid','flag_check','flag_out') THEN
                CASE TRIM(COALESCE(l.old_value, ''))
                    WHEN '1' THEN 'Upcoming' WHEN '2' THEN 'Present' WHEN '3' THEN 'Absent'
                    WHEN '4' THEN 'Substituted' WHEN '5' THEN 'Late' WHEN '7' THEN 'On Leave'
                    WHEN '8' THEN 'Pending' ELSE COALESCE(l.old_value, '') END
            ELSE COALESCE(l.old_value, '') END";
        $logNewValueExpression = "CASE
            WHEN LOWER(TRIM(COALESCE(l.field_name, ''))) IN ('flag_in','flag_mid','flag_check','flag_out') THEN
                CASE TRIM(COALESCE(l.new_value, ''))
                    WHEN '1' THEN 'Upcoming' WHEN '2' THEN 'Present' WHEN '3' THEN 'Absent'
                    WHEN '4' THEN 'Substituted' WHEN '5' THEN 'Late' WHEN '7' THEN 'On Leave'
                    WHEN '8' THEN 'Pending' ELSE COALESCE(l.new_value, '') END
            ELSE COALESCE(l.new_value, '') END";
        $logFromSql = " FROM tbl_attendance_logs l
            LEFT JOIN tbl_attendance_records ar ON l.attendance_id = ar.attendance_id
            LEFT JOIN tbl_users target ON ar.user_id = target.user_id
            LEFT JOIN tbl_users editor ON l.edited_by = editor.user_id
            LEFT JOIN tbl_class_schedules cs_log ON ar.schedule_id = cs_log.schedule_id
            LEFT JOIN tbl_subject subj_log ON cs_log.subject_id = subj_log.subject_id
            LEFT JOIN tbl_sections sec_log ON cs_log.section_id = sec_log.section_id
            LEFT JOIN tbl_ip_geolocation_cache geo ON geo.ip_address = l.ip_address";
        $logBaseConditions = [
            'l.edited_at BETWEEN ? AND ?',
            'target.role_id IN (2, 3, 4, 5)',
        ];
        $logBaseTypes = 'ss';
        $logBaseParams = [$start_date . ' 00:00:00', $end_date . ' 23:59:59'];

        if ($teacher_id) {
            $logBaseConditions[] = 'ar.user_id = ?';
            $logBaseTypes .= 'i';
            $logBaseParams[] = $teacher_id;
        }
        if ($dept_id) {
            $logBaseConditions[] = 'target.dept_id = ?';
            $logBaseTypes .= 'i';
            $logBaseParams[] = $dept_id;
        }
        if ($authRoleId === 3) {
            $logBaseConditions[] = $programRecordScope('target', 'subj_log', 'sec_log');
        }

        $logConditions = $logBaseConditions;
        $logTypes = $logBaseTypes;
        $logParams = $logBaseParams;
        if ($logAction !== '') {
            $logConditions[] = 'l.action_type = ?';
            $logTypes .= 's';
            $logParams[] = $logAction;
        }
        if ($logSearch !== '') {
            $logNeedle = '%' . $logSearch . '%';
            $logConditions[] = "(
                l.edit_session_id LIKE ? OR {$logTeacherExpression} LIKE ? OR l.action_type LIKE ?
                OR {$logFieldExpression} LIKE ? OR {$logOldValueExpression} LIKE ?
                OR {$logNewValueExpression} LIKE ? OR l.reason LIKE ? OR {$logEditorExpression} LIKE ?
                OR l.ip_address LIKE ? OR geo.city LIKE ? OR geo.region_name LIKE ?
                OR geo.country_name LIKE ? OR geo.provider LIKE ?
                OR DATE_FORMAT(l.edited_at, '%b %e, %Y, %h:%i %p') LIKE ?
            )";
            $logTypes .= str_repeat('s', 14);
            for ($index = 0; $index < 14; $index++) $logParams[] = $logNeedle;
        }

        $logBaseWhereSql = ' WHERE ' . implode(' AND ', $logBaseConditions);
        $logWhereSql = ' WHERE ' . implode(' AND ', $logConditions);
        $runAttendanceLogQuery = function ($sql, $types, $params) use ($mysqli) {
            $statement = $mysqli->prepare($sql);
            if (!$statement) json_response(['error' => 'db_prepare_failed', 'message' => $mysqli->error], 500);
            if ($types !== '') $statement->bind_param($types, ...$params);
            if (!$statement->execute()) json_response(['error' => 'db_query_failed', 'message' => $statement->error], 500);
            return $statement;
        };

        $logSummaryStmt = $runAttendanceLogQuery(
            "SELECT COUNT(DISTINCT {$logSessionExpression}) AS total_sessions,
                    COUNT(*) AS total_changes,
                    COUNT(DISTINCT CASE WHEN DATE(l.edited_at) = CURDATE() THEN {$logSessionExpression} END) AS today_sessions,
                    COUNT(DISTINCT NULLIF({$logTeacherExpression}, '')) AS unique_teachers,
                    COUNT(DISTINCT NULLIF({$logEditorExpression}, '')) AS unique_editors"
                . $logFromSql . $logWhereSql,
            $logTypes,
            $logParams
        );
        $logSummary = $logSummaryStmt->get_result()->fetch_assoc() ?: [];
        $logSummaryStmt->close();
        $logTotalSessions = (int)($logSummary['total_sessions'] ?? 0);
        $logTotalPages = max(1, (int)ceil($logTotalSessions / $pageSize));
        $page = min($page, $logTotalPages);
        $logOffset = ($page - 1) * $pageSize;

        $logSessionStmt = $runAttendanceLogQuery(
            "SELECT {$logSessionExpression} AS session_key, MAX(l.log_id) AS latest_log_id"
                . $logFromSql . $logWhereSql
                . " GROUP BY session_key ORDER BY latest_log_id DESC LIMIT ? OFFSET ?",
            $logTypes . 'ii',
            array_merge($logParams, [$pageSize, $logOffset])
        );
        $logSessionKeys = [];
        $logSessionResult = $logSessionStmt->get_result();
        while ($sessionRow = $logSessionResult->fetch_assoc()) {
            $logSessionKeys[] = (string)$sessionRow['session_key'];
        }
        $logSessionStmt->close();

        $logRows = [];
        if ($logSessionKeys) {
            $sessionPlaceholders = implode(',', array_fill(0, count($logSessionKeys), '?'));
            $logDataSql = "SELECT
                    l.log_id AS 'Log ID',
                    l.edit_session_id AS 'Edit Session',
                    {$logTeacherExpression} AS 'Teacher',
                    l.action_type AS 'Action', l.field_name AS 'Field',
                    l.old_value AS 'Old Value', l.new_value AS 'New Value',
                    l.reason AS 'Reason', {$logEditorExpression} AS 'Edited By',
                    l.ip_address AS 'IP Address', l.edited_at AS 'Date'"
                . $logFromSql . $logWhereSql
                . " AND {$logSessionExpression} IN ({$sessionPlaceholders})"
                . ' ORDER BY l.log_id DESC';
            $logDataStmt = $runAttendanceLogQuery(
                $logDataSql,
                $logTypes . str_repeat('s', count($logSessionKeys)),
                array_merge($logParams, $logSessionKeys)
            );
            $logDataResult = $logDataStmt->get_result();
            while ($row = $logDataResult->fetch_assoc()) {
                $row['IP Address'] = format_ip_address_for_display($row['IP Address'] ?? '');
                $fieldKey = strtolower(trim((string)($row['Field'] ?? '')));
                $fieldLabels = [
                    'flag_in' => 'Check In', 'flag_mid' => 'Mid Check',
                    'flag_check' => 'Mid Check', 'flag_out' => 'Check Out',
                ];
                if (isset($fieldLabels[$fieldKey])) $row['Field'] = $fieldLabels[$fieldKey];
                $network = get_public_ipv4_network_information($mysqli, $row['IP Address']);
                $row['Public IPv4'] = $network['public_ipv4'];
                $row['Approximate Location'] = $network['approximate_location'];
                $row['Network Provider'] = $network['network_provider'];
                $row['Network Status'] = $network['network_status'];
                $row['Network Information'] = $network['network_information'];
                $row['Reason'] = preg_replace(
                    '/Approved via attendance edit request\s*#\d+/i',
                    'Approved attendance correction',
                    (string)($row['Reason'] ?? '')
                );
                $logRows[] = $row;
            }
            $logDataStmt->close();
        }

        $logActionStmt = $runAttendanceLogQuery(
            'SELECT DISTINCT l.action_type AS action' . $logFromSql . $logBaseWhereSql . ' ORDER BY l.action_type',
            $logBaseTypes,
            $logBaseParams
        );
        $logActionOptions = [];
        $logActionResult = $logActionStmt->get_result();
        while ($optionRow = $logActionResult->fetch_assoc()) {
            $candidate = trim((string)($optionRow['action'] ?? ''));
            if ($candidate !== '') $logActionOptions[] = $candidate;
        }
        $logActionStmt->close();

        json_response([
            'title' => $title,
            'columns' => $columns,
            'rows' => $logRows,
            'pagination' => [
                'page' => $page,
                'page_size' => $pageSize,
                'total' => $logTotalSessions,
                'total_pages' => $logTotalPages,
            ],
            'summary' => [
                'total' => $logTotalSessions,
                'changes' => (int)($logSummary['total_changes'] ?? 0),
                'today' => (int)($logSummary['today_sessions'] ?? 0),
                'teachers' => (int)($logSummary['unique_teachers'] ?? 0),
                'editors' => (int)($logSummary['unique_editors'] ?? 0),
            ],
            'action_options' => $logActionOptions,
        ]);
    }

    // ADDED: Converted to Prepared Statement to safely insert the Dept Filter
    $sql = "SELECT 
                l.edit_session_id AS 'Edit Session',
                CONCAT(COALESCE(target.first_name,''), ' ', COALESCE(target.last_name,'')) AS 'Teacher',
                l.action_type AS 'Action',
                l.field_name AS 'Field',
                l.old_value AS 'Old Value',
                l.new_value AS 'New Value',
                l.reason AS 'Reason',
                CONCAT(COALESCE(editor.first_name,''), ' ', COALESCE(editor.last_name,'')) AS 'Edited By',
                l.ip_address AS 'IP Address',
                l.edited_at AS 'Date'
            FROM tbl_attendance_logs l
            LEFT JOIN tbl_attendance_records ar ON l.attendance_id = ar.attendance_id
            LEFT JOIN tbl_users target ON ar.user_id = target.user_id
            LEFT JOIN tbl_users editor ON l.edited_by = editor.user_id
            LEFT JOIN tbl_class_schedules cs_log ON ar.schedule_id = cs_log.schedule_id
            LEFT JOIN tbl_subject subj_log ON cs_log.subject_id = subj_log.subject_id
            LEFT JOIN tbl_sections sec_log ON cs_log.section_id = sec_log.section_id
            WHERE l.edited_at BETWEEN ? AND ?
              AND target.role_id IN (2, 3, 4, 5)";

    $params = [$start_date . ' 00:00:00', $end_date . ' 23:59:59'];
    $types = 'ss';

    if ($teacher_id) {
        $sql .= ' AND ar.user_id = ?';
        $types .= 'i';
        $params[] = $teacher_id;
    }

    if ($dept_id) { 
        $sql .= " AND target.dept_id = ?"; 
        $types .= 'i'; 
        $params[] = $dept_id; 
    }
    if ($authRoleId === 3) { $sql .= ' AND ' . $programRecordScope('target', 'subj_log', 'sec_log'); }

    $sql .= " ORDER BY l.log_id DESC LIMIT 100";

    $stmt = $mysqli->prepare($sql);
    if (!$stmt) json_response(['error' => 'db_error', 'message' => $mysqli->error], 500);

    if (!empty($params)) {
        $refs = [];
        $refs[] = &$types;
        foreach ($params as $k => &$v) $refs[] = &$v;
        call_user_func_array([$stmt, 'bind_param'], $refs);
    }
    
    $stmt->execute();
    $result = $stmt->get_result();

    while ($r = $result->fetch_assoc()) {
        $r['IP Address'] = format_ip_address_for_display($r['IP Address'] ?? '');
        $fieldKey = strtolower(trim((string)($r['Field'] ?? '')));
        $fieldLabels = [
            'flag_in' => 'Check In',
            'flag_mid' => 'Mid Check',
            'flag_check' => 'Mid Check',
            'flag_out' => 'Check Out',
        ];
        if (isset($fieldLabels[$fieldKey])) $r['Field'] = $fieldLabels[$fieldKey];
        $network = get_public_ipv4_network_information($mysqli, $r['IP Address']);
        $r['Public IPv4'] = $network['public_ipv4'];
        $r['Approximate Location'] = $network['approximate_location'];
        $r['Network Provider'] = $network['network_provider'];
        $r['Network Status'] = $network['network_status'];
        $r['Network Information'] = $network['network_information'];
        $r['Reason'] = preg_replace(
            '/Approved via attendance edit request\s*#\d+/i',
            'Approved attendance correction',
            (string)($r['Reason'] ?? '')
        );
        $rows[] = $r;
    }
    $stmt->close();

} elseif ($report === 'system_logs') {
    if (!$authUserId) {
        json_response(['error' => 'unauthorized', 'message' => 'Authentication is required to view audit records.'], 401);
    }
    $title = 'System Logs';
    $columns = ['User','action','details','network_information','created_at'];
    
    $sysTime = choose_timestamp_column('tbl_system_logs', 'created_at') ?: 'created_at';
    $detailCol = find_column('tbl_system_logs', ['details','info','message']) ?: 'details';

    // The dedicated Audit Trail page uses database-level filtering and
    // pagination. Other report/PDF callers keep the legacy response below.
    $optimizedAuditPage = isset($_GET['system_logs_page']) && (string)$_GET['system_logs_page'] === '1';
    if ($optimizedAuditPage) {
        $auditSearch = substr(trim((string)($_GET['search'] ?? '')), 0, 200);
        $auditUser = substr(trim((string)($_GET['user'] ?? '')), 0, 200);
        $auditCategory = trim((string)($_GET['category'] ?? ''));
        $auditIp = trim((string)($_GET['public_ipv4'] ?? ''));
        $auditOptionsOnly = isset($_GET['options_only']) && (string)$_GET['options_only'] === '1';
        $auditExportRows = isset($_GET['export_rows']) && (string)$_GET['export_rows'] === '1';
        $validAuditCategories = ['Security', 'Settings', 'Attendance', 'User Management', 'Academic', 'Facility', 'Other'];
        if ($auditCategory !== '' && !in_array($auditCategory, $validAuditCategories, true)) {
            json_response(['error' => 'invalid_category', 'message' => 'The selected audit category is invalid.'], 422);
        }
        if ($auditIp !== '' && !is_public_ipv4_address($auditIp)) {
            json_response(['error' => 'invalid_public_ipv4', 'message' => 'The selected public IPv4 address is invalid.'], 422);
        }

        ensure_ip_geolocation_cache_table($mysqli);
        $auditUserExpression = "COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), IF(l.user_id IS NULL, 'System', CONCAT('User #', l.user_id)))";
        $auditActionExpression = "LOWER(REPLACE(REPLACE(COALESCE(l.action, ''), ' ', '_'), '-', '_'))";
        $auditCategoryPatterns = [
            'Security' => '(login|logout|password|unlock|lock|auth|session|security|policy|token)',
            'Settings' => '(setting|module_access|permission)',
            'Attendance' => '(attendance|check_in|check_out|mid_check|schedule_edit|request_edit)',
            'User Management' => '(user|account|role|profile)',
            'Academic' => '(department|program|section|subject|semester|school_year|offering)',
            'Facility' => '(building|floor|room|school|location|qr)',
        ];
        $auditFromSql = " FROM tbl_system_logs l
            LEFT JOIN tbl_users u ON l.user_id = u.user_id
            LEFT JOIN tbl_ip_geolocation_cache geo ON geo.ip_address = l.ip_address";
        $auditBaseConditions = ["l.`{$sysTime}` BETWEEN ? AND ?"];
        $auditBaseTypes = 'ss';
        $auditBaseParams = [$start_date . ' 00:00:00', $end_date . ' 23:59:59'];

        if ($teacher_id) {
            $auditBaseConditions[] = 'l.user_id = ?';
            $auditBaseTypes .= 'i';
            $auditBaseParams[] = $teacher_id;
        }
        if ($dept_id && $authRoleId === 1) {
            $auditBaseConditions[] = 'u.dept_id = ?';
            $auditBaseTypes .= 'i';
            $auditBaseParams[] = $dept_id;
        }
        if (in_array($authRoleId, [2, 6], true)) {
            $auditBaseConditions[] = '(l.user_id = ? OR (u.dept_id = ? AND u.role_id IN (3, 4, 5)))';
            $auditBaseTypes .= 'ii';
            $auditBaseParams[] = $authUserId;
            $auditBaseParams[] = $authDeptId;
        } elseif ($authRoleId === 3) {
            $auditBaseConditions[] = '(l.user_id = ? OR (u.dept_id = ? AND u.role_id IN (4, 5)))';
            $auditBaseTypes .= 'ii';
            $auditBaseParams[] = $authUserId;
            $auditBaseParams[] = $authDeptId;
        } elseif ($authRoleId === 4) {
            $auditBaseConditions[] = '(l.user_id = ? OR (u.dept_id = ? AND u.role_id = 5))';
            $auditBaseTypes .= 'ii';
            $auditBaseParams[] = $authUserId;
            $auditBaseParams[] = $authDeptId;
        } elseif ($authRoleId !== 1) {
            $auditBaseConditions[] = 'l.user_id = ?';
            $auditBaseTypes .= 'i';
            $auditBaseParams[] = $authUserId;
        }
        $auditBaseWhereSql = ' WHERE ' . implode(' AND ', $auditBaseConditions);

        $auditCategoryCondition = function ($category, &$types, &$params) use ($auditCategoryPatterns, $auditActionExpression) {
            $orderedCategories = array_keys($auditCategoryPatterns);
            if ($category === 'Other') {
                foreach ($orderedCategories as $earlierCategory) {
                    $types .= 's';
                    $params[] = $auditCategoryPatterns[$earlierCategory];
                }
                return '(' . implode(' AND ', array_fill(0, count($orderedCategories), "{$auditActionExpression} NOT REGEXP ?")) . ')';
            }
            $position = array_search($category, $orderedCategories, true);
            if ($position === false) return '1 = 1';
            $parts = [];
            for ($index = 0; $index < $position; $index++) {
                $parts[] = "{$auditActionExpression} NOT REGEXP ?";
                $types .= 's';
                $params[] = $auditCategoryPatterns[$orderedCategories[$index]];
            }
            $parts[] = "{$auditActionExpression} REGEXP ?";
            $types .= 's';
            $params[] = $auditCategoryPatterns[$category];
            return '(' . implode(' AND ', $parts) . ')';
        };

        $runAuditQuery = function ($sql, $types, $params) use ($mysqli) {
            $statement = $mysqli->prepare($sql);
            if (!$statement) json_response(['error' => 'db_prepare_failed', 'message' => $mysqli->error], 500);
            if ($types !== '') $statement->bind_param($types, ...$params);
            if (!$statement->execute()) json_response(['error' => 'db_query_failed', 'message' => $statement->error], 500);
            return $statement;
        };

        $loadAuditFilterOptions = function () use ($runAuditQuery, $auditUserExpression, $auditActionExpression, $auditFromSql, $auditBaseWhereSql, $auditBaseTypes, $auditBaseParams, $auditCategoryPatterns) {
            $userStmt = $runAuditQuery("SELECT DISTINCT {$auditUserExpression} AS user_display" . $auditFromSql . $auditBaseWhereSql . ' ORDER BY user_display', $auditBaseTypes, $auditBaseParams);
            $users = [];
            $userResult = $userStmt->get_result();
            while ($optionRow = $userResult->fetch_assoc()) {
                if (trim((string)$optionRow['user_display']) !== '') $users[] = (string)$optionRow['user_display'];
            }
            $userStmt->close();

            $actionStmt = $runAuditQuery('SELECT DISTINCT l.action AS action' . $auditFromSql . $auditBaseWhereSql, $auditBaseTypes, $auditBaseParams);
            $categories = [];
            $actionResult = $actionStmt->get_result();
            while ($optionRow = $actionResult->fetch_assoc()) {
                $normalizedAction = strtolower(str_replace([' ', '-'], '_', (string)($optionRow['action'] ?? '')));
                $category = 'Other';
                foreach ($auditCategoryPatterns as $label => $pattern) {
                    if (preg_match('/' . $pattern . '/i', $normalizedAction)) { $category = $label; break; }
                }
                $categories[$category] = true;
            }
            $actionStmt->close();
            $categoryOptions = array_keys($categories);
            sort($categoryOptions, SORT_NATURAL | SORT_FLAG_CASE);

            $ipStmt = $runAuditQuery('SELECT DISTINCT l.ip_address AS ip_address' . $auditFromSql . $auditBaseWhereSql . ' ORDER BY l.ip_address', $auditBaseTypes, $auditBaseParams);
            $ips = [];
            $ipResult = $ipStmt->get_result();
            while ($optionRow = $ipResult->fetch_assoc()) {
                $candidate = trim((string)($optionRow['ip_address'] ?? ''));
                if (is_public_ipv4_address($candidate)) $ips[] = $candidate;
            }
            $ipStmt->close();
            return ['users' => $users, 'categories' => $categoryOptions, 'ips' => array_values(array_unique($ips))];
        };

        if ($auditOptionsOnly) {
            json_response(['filter_options' => $loadAuditFilterOptions()]);
        }

        $auditConditions = $auditBaseConditions;
        $auditTypes = $auditBaseTypes;
        $auditParams = $auditBaseParams;
        if ($auditUser !== '') {
            $auditConditions[] = "{$auditUserExpression} = ?";
            $auditTypes .= 's';
            $auditParams[] = $auditUser;
        }
        if ($auditCategory !== '') {
            $auditConditions[] = $auditCategoryCondition($auditCategory, $auditTypes, $auditParams);
        }
        if ($auditIp !== '') {
            $auditConditions[] = 'l.ip_address = ?';
            $auditTypes .= 's';
            $auditParams[] = $auditIp;
        }
        if ($auditSearch !== '') {
            $auditNeedle = '%' . $auditSearch . '%';
            $auditSearchParts = ["{$auditUserExpression} LIKE ? OR l.action LIKE ? OR l.`{$detailCol}` LIKE ? OR l.ip_address LIKE ? OR DATE_FORMAT(l.`{$sysTime}`, '%M %d, %Y - %h:%i %p') LIKE ? OR geo.city LIKE ? OR geo.region_name LIKE ? OR geo.country_name LIKE ? OR geo.provider LIKE ?"];
            $auditTypes .= 'sssssssss';
            for ($index = 0; $index < 9; $index++) $auditParams[] = $auditNeedle;
            foreach ($validAuditCategories as $categoryLabel) {
                if (stripos($categoryLabel, $auditSearch) !== false) {
                    $auditSearchParts[] = $auditCategoryCondition($categoryLabel, $auditTypes, $auditParams);
                }
            }
            $auditConditions[] = '(' . implode(' OR ', $auditSearchParts) . ')';
        }
        $auditWhereSql = ' WHERE ' . implode(' AND ', $auditConditions);

        $auditSummaryStmt = $runAuditQuery("SELECT COUNT(*) AS total, COUNT(DISTINCT {$auditUserExpression}) AS unique_users, MAX(l.`{$sysTime}`) AS latest" . $auditFromSql . $auditWhereSql, $auditTypes, $auditParams);
        $auditSummaryRow = $auditSummaryStmt->get_result()->fetch_assoc() ?: [];
        $auditSummaryStmt->close();
        $auditTotal = (int)($auditSummaryRow['total'] ?? 0);

        $auditIpStmt = $runAuditQuery('SELECT DISTINCT l.ip_address AS ip_address' . $auditFromSql . $auditWhereSql, $auditTypes, $auditParams);
        $auditUniqueIps = 0;
        $auditIpResult = $auditIpStmt->get_result();
        while ($ipRow = $auditIpResult->fetch_assoc()) {
            if (is_public_ipv4_address($ipRow['ip_address'] ?? '')) $auditUniqueIps++;
        }
        $auditIpStmt->close();

        $auditTotalPages = max(1, (int)ceil($auditTotal / $pageSize));
        $page = min($page, $auditTotalPages);
        $auditOffset = ($page - 1) * $pageSize;
        $auditSelectSql = "SELECT l.log_id AS log_id, l.user_id AS user_id, {$auditUserExpression} AS `User`, l.action AS action, l.`{$detailCol}` AS details, l.ip_address AS ip_address, DATE_FORMAT(l.`{$sysTime}`, '%Y-%m-%dT%H:%i:%s') AS occurred_at, DATE_FORMAT(l.`{$sysTime}`, '%M %d, %Y - %h:%i %p') AS created_at" . $auditFromSql . $auditWhereSql . " ORDER BY l.`{$sysTime}` DESC, l.log_id DESC";
        if ($auditExportRows) {
            $auditSelectSql .= ' LIMIT 500';
            $auditDataStmt = $runAuditQuery($auditSelectSql, $auditTypes, $auditParams);
        } else {
            $auditSelectSql .= ' LIMIT ? OFFSET ?';
            $auditDataTypes = $auditTypes . 'ii';
            $auditDataParams = array_merge($auditParams, [$pageSize, $auditOffset]);
            $auditDataStmt = $runAuditQuery($auditSelectSql, $auditDataTypes, $auditDataParams);
        }

        $auditRows = [];
        $formatAuditAction = function ($action) { return $action ? ucwords(str_replace('_', ' ', $action)) : ''; };
        $auditDataResult = $auditDataStmt->get_result();
        while ($auditRow = $auditDataResult->fetch_assoc()) {
            $rawAction = (string)($auditRow['action'] ?? '');
            $auditRow['details'] = log_professionalize_details($mysqli, $rawAction, $auditRow['details'] ?? '');
            $auditRow['action'] = $formatAuditAction($rawAction);
            $auditRow['ip_address'] = format_ip_address_for_display($auditRow['ip_address'] ?? '');
            $network = get_public_ipv4_network_information($mysqli, $auditRow['ip_address']);
            $auditRow['public_ipv4'] = $network['public_ipv4'];
            $auditRow['approximate_location'] = $network['approximate_location'];
            $auditRow['network_provider'] = $network['network_provider'];
            $auditRow['network_status'] = $network['network_status'];
            $auditRow['network_information'] = $network['network_information'];
            $auditRows[] = $auditRow;
        }
        $auditDataStmt->close();

        json_response([
            'title' => $title,
            'columns' => $columns,
            'rows' => $auditRows,
            'pagination' => ['page' => $page, 'page_size' => $pageSize, 'total' => $auditTotal, 'total_pages' => $auditTotalPages],
            'summary' => [
                'events' => $auditTotal,
                'users' => (int)($auditSummaryRow['unique_users'] ?? 0),
                'ips' => $auditUniqueIps,
                'latest' => $auditSummaryRow['latest'] ? date('Y-m-d\TH:i:s', strtotime((string)$auditSummaryRow['latest'])) : null,
            ],
        ]);
    }
    
    // Helper to format action names: replace underscores with spaces, capitalize each word
    $formatAction = function($action) {
        if (!$action) return '';
        return ucwords(str_replace('_', ' ', $action));
    };
    
    $sql = "SELECT l.log_id AS log_id, l.user_id AS user_id, CONCAT_WS(' ', u.first_name, u.last_name) AS `User`, l.action AS action, l.`{$detailCol}` AS details, l.ip_address AS ip_address, DATE_FORMAT(l.`{$sysTime}`, '%Y-%m-%dT%H:%i:%s') AS occurred_at, DATE_FORMAT(l.`{$sysTime}`, '%M %d, %Y - %h:%i %p') AS created_at
            FROM tbl_system_logs l 
            LEFT JOIN tbl_users u ON l.user_id = u.user_id 
            WHERE l.`{$sysTime}` BETWEEN ? AND ?";
    
    $params = [$start_date . ' 00:00:00', $end_date . ' 23:59:59']; 
    $types = 'ss';
    
    if ($teacher_id) { $sql .= ' AND l.user_id = ?'; $types .= 'i'; $params[] = $teacher_id; }
    if ($dept_id) { $sql .= ' AND u.dept_id = ?'; $types .= 'i'; $params[] = $dept_id; }

    // --- Role-Based & Department Filtering ---
    // Authorization scope must always come from the authenticated session.
    // Never trust a query-string user ID to determine audit visibility.
    $current_user_id = $authUserId;

    if ($current_user_id) {
        $reqStmt = $mysqli->prepare("SELECT role_id, dept_id FROM tbl_users WHERE user_id = ?");
        if ($reqStmt) {
            $reqStmt->bind_param('i', $current_user_id);
            $reqStmt->execute();
            $reqRes = $reqStmt->get_result()->fetch_assoc();
            
            if ($reqRes) {
                $reqRole = (int)$reqRes['role_id'];
                $reqDept = $reqRes['dept_id'];
                
                if ($reqRole === 1) {
                    // Admin: Can see everything, no extra filter needed.
                } else if (in_array($reqRole, [2, 6], true)) {
                    // Dean / department admin: See own logs OR (same dept AND roles 3 [Program Head], 4 [Secretary], 5 [Teacher])
                    $sql .= " AND (l.user_id = ? OR (u.dept_id = ? AND u.role_id IN (3, 4, 5)))";
                    $types .= 'ii';
                    $params[] = $current_user_id;
                    $params[] = $reqDept;
                } else if ($reqRole === 3) {
                    // Program Head: See own logs OR (same dept AND roles 4 [Secretary], 5 [Teacher])
                    $sql .= " AND (l.user_id = ? OR (u.dept_id = ? AND u.role_id IN (4, 5)))";
                    $types .= 'ii';
                    $params[] = $current_user_id;
                    $params[] = $reqDept;
                } else if ($reqRole === 4) {
                    // Secretary: See own logs OR (same dept AND role 5 [Teacher])
                    $sql .= " AND (l.user_id = ? OR (u.dept_id = ? AND u.role_id = 5))";
                    $types .= 'ii';
                    $params[] = $current_user_id;
                    $params[] = $reqDept;
                } else {
                    // Teacher/Others: Only see their own logs
                    $sql .= " AND l.user_id = ?";
                    $types .= 'i';
                    $params[] = $current_user_id;
                }
            }
            $reqStmt->close();
        }
    }

    $sql .= " ORDER BY l.`{$sysTime}` DESC LIMIT 500"; // Optional limit for performance

    $stmt = $mysqli->prepare($sql);
    if (!$stmt) {
        json_response(['error'=>'db_prepare_failed','message'=>$mysqli->error], 500);
    } else {
        $refs = []; 
        $refs[] = &$types; 
        foreach ($params as $k => &$v) { $refs[] = &$v; } 
        call_user_func_array([$stmt, 'bind_param'], $refs);
        
        $stmt->execute(); 
        $res = $stmt->get_result(); 
        while ($r = $res->fetch_assoc()) {
            $rawAction = (string)($r['action'] ?? '');
            $r['details'] = log_professionalize_details($mysqli, $rawAction, $r['details'] ?? '');
            $r['action'] = $formatAction($rawAction);
            // Convert IPv6 loopback ::1 to 127.0.0.1 for readability
            if (isset($r['ip_address']) && strtolower(trim($r['ip_address'])) === '::1') {
                $r['ip_address'] = '127.0.0.1';
            }
            $network = get_public_ipv4_network_information($mysqli, $r['ip_address'] ?? '');
            $r['public_ipv4'] = $network['public_ipv4'];
            $r['approximate_location'] = $network['approximate_location'];
            $r['network_provider'] = $network['network_provider'];
            $r['network_status'] = $network['network_status'];
            $r['network_information'] = $network['network_information'];
            $rows[] = $r; 
        }
        $stmt->close();
    }

} else {
    json_response(['error' => 'unknown_report'], 400);
}

$analyticsRows = $rows;
if (in_array($report, ['attendance_records', $myAttendanceReport], true)) {
    $analyticsRows = array_map(static function ($row) {
        return [
            'Overall Status' => $row['Overall Status'] ?? '',
            'Room' => $row['Room'] ?? '',
        ];
    }, $rows);

    if ($report_view === 'summary') {
        $grouped = [];
        foreach ($rows as $row) {
            $teacher = trim((string)($row['Teacher'] ?? 'Unknown teacher'));
            $teacherId = (int)($row['_user_id'] ?? 0);
            $groupKey = $teacherId > 0 ? 'id:' . $teacherId : 'name:' . strtolower($teacher);
            if (!isset($grouped[$groupKey])) {
                $grouped[$groupKey] = [
                    '_teacherId' => $teacherId,
                    'Teacher' => $teacher,
                    'Total Records' => 0,
                    'Present' => 0,
                    'Late' => 0,
                    'Absent' => 0,
                    '_sections' => [],
                    '_subjects' => [],
                ];
            }
            $grouped[$groupKey]['Total Records']++;
            $statusKey = normalize_attendance_status_key($row['Overall Status'] ?? '');
            if ($statusKey === 'present') $grouped[$groupKey]['Present']++;
            elseif ($statusKey === 'late') $grouped[$groupKey]['Late']++;
            elseif ($statusKey === 'absent') $grouped[$groupKey]['Absent']++;

            $subject = trim((string)($row['_subject_code'] ?? ''));
            if ($subject === '') $subject = trim((string)($row['_subject_name'] ?? ''));
            $section = trim((string)($row['_section_name'] ?? ''));
            if ($subject !== '') $grouped[$groupKey]['_subjects'][strtolower($subject)] = true;
            if ($section !== '') $grouped[$groupKey]['_sections'][strtolower($section)] = true;
        }
        uasort($grouped, static function ($left, $right) {
            return strcasecmp((string)($left['Teacher'] ?? ''), (string)($right['Teacher'] ?? ''));
        });
        $summaryRows = [];
        $summaryIndex = 1;
        foreach ($grouped as $item) {
            $summaryRows[] = [
                '#' => $summaryIndex++,
                '_teacherId' => (int)$item['_teacherId'],
                'Teacher' => $item['Teacher'],
                'Total Records' => (int)$item['Total Records'],
                'Present' => (int)$item['Present'],
                'Late' => (int)$item['Late'],
                'Absent' => (int)$item['Absent'],
                'Sections' => count($item['_sections']),
                'Subjects' => count($item['_subjects']),
            ];
        }
        $rows = $summaryRows;
        $columns = ['#', 'Teacher', 'Total Records', 'Present', 'Late', 'Absent', 'Sections', 'Subjects'];
    }
} elseif ($report === 'attendance_logs') {
    $analyticsRows = array_map(static function ($row) {
        return [
            'Action' => $row['Action'] ?? $row['action'] ?? '',
            'Date' => $row['Date'] ?? $row['date'] ?? $row['edited_at'] ?? '',
            'Edited By' => $row['Edited By'] ?? '',
            'Edit Session' => $row['Edit Session'] ?? '',
            'IP Address' => $row['IP Address'] ?? $row['ip_address'] ?? '',
        ];
    }, $rows);
} elseif ($report === 'system_logs') {
    $analyticsRows = array_map(static function ($row) {
        return [
            'action' => $row['action'] ?? $row['Action'] ?? '',
            'occurred_at' => $row['occurred_at'] ?? $row['created_at'] ?? $row['Date'] ?? '',
            'User' => $row['User'] ?? $row['user'] ?? '',
            'ip_address' => $row['ip_address'] ?? $row['IP Address'] ?? '',
        ];
    }, $rows);
} elseif ($report === 'leave_substitution') {
    $analyticsRows = array_map(static function ($row) {
        return [
            '_leave_id' => $row['_leave_id'] ?? null,
            '_attendance_id' => $row['_attendance_id'] ?? null,
            'Date' => $row['Date'] ?? '',
            'Leave Period' => $row['Leave Period'] ?? '',
            'Leave Status' => $row['Leave Status'] ?? '',
            'Coverage Status' => $row['Coverage Status'] ?? '',
            'Affected Classes' => $row['Affected Classes'] ?? 0,
            'Covered Classes' => $row['Covered Classes'] ?? 0,
            'Uncovered Classes' => $row['Uncovered Classes'] ?? 0,
        ];
    }, $rows);
}

$pagination = null;
if ($paginate) {
    $totalRows = count($rows);
    $totalPages = max(1, (int)ceil($totalRows / $pageSize));
    $page = min($page, $totalPages);
    $offset = ($page - 1) * $pageSize;
    $rows = array_slice($rows, $offset, $pageSize);
    $pagination = [
        'page' => $page,
        'page_size' => $pageSize,
        'total' => $totalRows,
        'total_pages' => $totalPages,
    ];
}

// export handling
if ($export === 'csv') {
    output_csv($rows, $columns, preg_replace('/[^A-Za-z0-9_\-]/','_', $title) . '.csv');
} elseif ($export === 'html') {
    output_html_printable($rows, $columns, $title);
} else {
    $response = ['title' => $title, 'columns' => $columns, 'rows' => $rows, 'semester' => $currentSemester, 'semester_options' => $semesterOptions, 'leave_type_options' => $leaveTypeOptions];
    if ($paginate) {
        $response['pagination'] = $pagination;
        $response['analytics_rows'] = $analyticsRows;
        $response['report_view'] = $report_view;
    }
    json_response($response);
}
