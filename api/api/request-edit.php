<?php
// api/api/request-edit.php
require_once __DIR__ . '/../helpers/log_helper.php';
require_once __DIR__ . '/../helpers/attendance-logs.php';
require_once __DIR__ . '/../helpers/notification_helper.php';
require_once __DIR__ . '/../helpers/tardiness_penalty_helper.php';

global $mysqli, $authPayload;

$request_method = $_SERVER['REQUEST_METHOD'];
$input = get_input();
if (!is_array($input)) $input = [];

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$parts = explode('/', $path);
$api_prefix_key = array_search('api', $parts);
$endpoint = $parts[$api_prefix_key + 1] ?? null;
$param1 = $parts[$api_prefix_key + 2] ?? null; // attendance | schedule
$param2 = $parts[$api_prefix_key + 3] ?? null; // request id

if ($endpoint !== 'request-edit') {
    json_response(['error' => 'endpoint_not_found'], 404);
}

function safe_bind_params($stmt, $types, $params) {
    $refs = [];
    $refs[] = &$types;
    foreach ($params as $k => $v) $refs[] = &$params[$k];
    return call_user_func_array([$stmt, 'bind_param'], $refs);
}

function table_exists($mysqli, $table) {
    $table = preg_replace('/[^a-zA-Z0-9_]/', '', (string)$table);
    if ($table === '') return false;
    $safe = $mysqli->real_escape_string($table);
    $res = $mysqli->query("SHOW TABLES LIKE '{$safe}'");
    return $res && (int)$res->num_rows > 0;
}

function column_exists($mysqli, $table, $column) {
    $table = preg_replace('/[^a-zA-Z0-9_]/', '', (string)$table);
    $column = preg_replace('/[^a-zA-Z0-9_]/', '', (string)$column);
    if ($table === '' || $column === '') return false;
    $safeColumn = $mysqli->real_escape_string($column);
    $res = $mysqli->query("SHOW COLUMNS FROM `$table` LIKE '{$safeColumn}'");
    return $res && (int)$res->num_rows > 0;
}

function parse_auth_user($mysqli) {
    global $authPayload;
    $auth = is_array($authPayload) ? $authPayload : app_get_authenticated_session(true);
    $authUserId = isset($auth['user_id']) ? (int)$auth['user_id'] : null;
    $authRole = isset($auth['role_id']) ? (int)$auth['role_id'] : null;
    if (!$authUserId) json_response(['error' => 'invalid_token_payload'], 401);

    return [
        'user_id' => $authUserId,
        'role_id' => $authRole,
        'dept_id' => isset($auth['dept_id']) && $auth['dept_id'] !== null ? (int)$auth['dept_id'] : null,
    ];
}

function request_edit_is_self_scope($scope) {
    return in_array(strtolower(trim((string)$scope)), ['my', 'mine', 'self'], true);
}

function request_edit_apply_scope_filter($scope, $authRole, $authUserId, $authDeptId, $manageRoleId, $requestedByColumn, $teacherDeptColumn, &$sql, &$types, &$params) {
    $authRole = (int)$authRole;
    $authUserId = (int)$authUserId;
    $manageRoleIds = is_array($manageRoleId)
        ? array_values(array_filter(array_map('intval', $manageRoleId)))
        : [(int)$manageRoleId];
    $isSelfScope = request_edit_is_self_scope($scope);

    if ($authRole === 1) {
        if ($isSelfScope) {
            $sql .= " AND {$requestedByColumn} = ?";
            $types .= 'i';
            $params[] = $authUserId;
        }
        return;
    }

    if (in_array($authRole, $manageRoleIds, true) && !$isSelfScope) {
        if ($authDeptId === null) {
            json_response([], 200);
        }
        $sql .= " AND {$teacherDeptColumn} = ?";
        $types .= 'i';
        $params[] = (int)$authDeptId;
        return;
    }

    if (in_array($authRole, [2, 3, 4, 5, 6], true)) {
        $sql .= " AND {$requestedByColumn} = ?";
        $types .= 'i';
        $params[] = $authUserId;
        return;
    }

    json_response(['error' => 'forbidden'], 403);
}

function request_edit_optional_note_selects($mysqli, $table, $alias) {
    $fields = ['decision_note', 'dean_message', 'reviewer_note', 'approval_note', 'rejection_note'];
    $select = '';
    foreach ($fields as $field) {
        if (column_exists($mysqli, $table, $field)) {
            $select .= ", {$alias}.{$field} AS {$field}";
        } else {
            $select .= ", NULL AS {$field}";
        }
    }
    return $select;
}

function build_schedule_schema($mysqli) {
    $hasSubjectOfferings = table_exists($mysqli, 'tbl_subject_offerings');
    $csHasOffering = column_exists($mysqli, 'tbl_class_schedules', 'offering_id');
    return [
        'cs_has_offering' => $csHasOffering,
        'cs_has_user' => column_exists($mysqli, 'tbl_class_schedules', 'user_id'),
        'cs_has_section' => column_exists($mysqli, 'tbl_class_schedules', 'section_id'),
        'cs_has_subject' => column_exists($mysqli, 'tbl_class_schedules', 'subject_id'),
        'cs_has_semester' => column_exists($mysqli, 'tbl_class_schedules', 'semester_id'),
        'has_so' => $hasSubjectOfferings && $csHasOffering,
        'so_has_user' => $hasSubjectOfferings ? column_exists($mysqli, 'tbl_subject_offerings', 'user_id') : false,
        'so_has_section' => $hasSubjectOfferings ? column_exists($mysqli, 'tbl_subject_offerings', 'section_id') : false,
        'so_has_subject' => $hasSubjectOfferings ? column_exists($mysqli, 'tbl_subject_offerings', 'subject_id') : false,
        'so_has_semester' => $hasSubjectOfferings ? column_exists($mysqli, 'tbl_subject_offerings', 'semester_id') : false,
    ];
}

function schedule_exprs($schema) {
    $joinOffering = $schema['has_so'] ? " LEFT JOIN tbl_subject_offerings so ON cs.offering_id = so.offering_id " : "";
    $teacherExpr = $schema['cs_has_user'] ? 'cs.user_id' : (($schema['has_so'] && $schema['so_has_user']) ? 'so.user_id' : 'NULL');
    $sectionExpr = $schema['cs_has_section'] ? 'cs.section_id' : (($schema['has_so'] && $schema['so_has_section']) ? 'so.section_id' : 'NULL');
    $subjectExpr = $schema['cs_has_subject'] ? 'cs.subject_id' : (($schema['has_so'] && $schema['so_has_subject']) ? 'so.subject_id' : 'NULL');
    $semesterExpr = $schema['cs_has_semester'] ? 'cs.semester_id' : (($schema['has_so'] && $schema['so_has_semester']) ? 'so.semester_id' : 'NULL');
    return [$joinOffering, $teacherExpr, $sectionExpr, $subjectExpr, $semesterExpr];
}

$auth = parse_auth_user($mysqli);
$authUserId = (int)$auth['user_id'];
$authRole = (int)$auth['role_id'];
$authDeptId = $auth['dept_id'];

$scheduleSchema = build_schedule_schema($mysqli);
list($joinOffering, $teacherExpr, $sectionExpr, $subjectExpr, $semesterExpr) = schedule_exprs($scheduleSchema);

if ($param1 === 'attendance') {
    if ($request_method === 'GET') {
        $scope = strtolower(trim((string)($_GET['scope'] ?? '')));
        $status = strtolower(trim((string)($_GET['status'] ?? '')));
        $validStatuses = ['pending', 'approved', 'rejected'];
        if (!in_array($status, $validStatuses, true)) $status = null;
        $paginate = filter_var($_GET['paginate'] ?? false, FILTER_VALIDATE_BOOLEAN);
        $page = max(1, (int)($_GET['page'] ?? 1));
        $perPage = max(1, min(100, (int)($_GET['per_page'] ?? 10)));
        $search = trim((string)($_GET['search'] ?? ''));
        if (strlen($search) > 100) $search = substr($search, 0, 100);
        $dateFrom = trim((string)($_GET['date_from'] ?? ''));
        $dateTo = trim((string)($_GET['date_to'] ?? ''));
        $requestIdFilter = max(0, (int)($_GET['request_id'] ?? 0));
        $validDate = static function ($value) {
            if ($value === '') return true;
            if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $value, $matches)) return false;
            return checkdate((int)$matches[2], (int)$matches[3], (int)$matches[1]);
        };
        if (!$validDate($dateFrom) || !$validDate($dateTo) || ($dateFrom !== '' && $dateTo !== '' && $dateFrom > $dateTo)) {
            json_response(['error' => 'invalid_date_filter', 'message' => 'Enter a valid attendance date range.'], 400);
        }
        $noteSelects = request_edit_optional_note_selects($mysqli, 'tbl_attendance_edit_requests', 'aer');

        $selectSql = "SELECT
                    aer.request_id,
                    aer.attendance_id,
                    aer.requested_by,
                    aer.reason,
                    aer.status,
                    aer.created_at,
                    aer.decided_by
                    {$noteSelects},
                    DATE_FORMAT(ar.date, '%Y-%m-%d') AS attendance_date,
                    TIME_FORMAT(ar.checked_in_at, '%H:%i:%s') AS checked_in_at,
                    TIME_FORMAT(ar.checked_mid_at, '%H:%i:%s') AS checked_mid_at,
                    TIME_FORMAT(ar.checked_out_at, '%H:%i:%s') AS checked_out_at,
                    ar.flag_in_id,
                    ar.flag_check_id,
                    ar.flag_out_id,
                    fti.flag_name AS flag_in_name,
                    ftc.flag_name AS flag_check_name,
                    fto.flag_name AS flag_out_name,
                    ar.remarks AS attendance_remarks,
                    ar.user_id AS teacher_id,
                    CONCAT(t.first_name, ' ', t.last_name) AS teacher_name,
                    t.dept_id AS teacher_dept_id,
                    t.status AS teacher_user_status,
                    CONCAT(req.first_name, ' ', req.last_name) AS requested_by_name,
                    req.status AS requested_by_user_status,
                    CONCAT(decider.first_name, ' ', decider.last_name) AS decided_by_name,
                    cs.schedule_id,
                    TIME_FORMAT(cs.start_time, '%H:%i:%s') AS schedule_start_time,
                    TIME_FORMAT(cs.end_time, '%H:%i:%s') AS schedule_end_time,
                    r.room_name,
                    s.subject_code,
                    s.subject_name,
                    sec.section_name";
        $fromSql = "
                FROM tbl_attendance_edit_requests aer
                JOIN tbl_attendance_records ar ON aer.attendance_id = ar.attendance_id
                LEFT JOIN tbl_class_schedules cs ON ar.schedule_id = cs.schedule_id
                $joinOffering
                LEFT JOIN tbl_subject s ON $subjectExpr = s.subject_id
                LEFT JOIN tbl_sections sec ON $sectionExpr = sec.section_id
                LEFT JOIN tbl_rooms r ON ar.room_id = r.room_id
                LEFT JOIN tbl_flag_types fti ON ar.flag_in_id = fti.flag_id
                LEFT JOIN tbl_flag_types ftc ON ar.flag_check_id = ftc.flag_id
                LEFT JOIN tbl_flag_types fto ON ar.flag_out_id = fto.flag_id
                LEFT JOIN tbl_users t ON ar.user_id = t.user_id
                LEFT JOIN tbl_users req ON aer.requested_by = req.user_id
                LEFT JOIN tbl_users decider ON aer.decided_by = decider.user_id
                WHERE 1=1";
        $types = '';
        $params = [];
        request_edit_apply_scope_filter(
            $scope,
            $authRole,
            $authUserId,
            $authDeptId,
            [2],
            'aer.requested_by',
            't.dept_id',
            $fromSql,
            $types,
            $params
        );

        if ($dateFrom !== '') {
            $fromSql .= " AND ar.date >= ?";
            $types .= 's';
            $params[] = $dateFrom;
        }
        if ($dateTo !== '') {
            $fromSql .= " AND ar.date <= ?";
            $types .= 's';
            $params[] = $dateTo;
        }
        if ($requestIdFilter > 0) {
            $fromSql .= " AND aer.request_id = ?";
            $types .= 'i';
            $params[] = $requestIdFilter;
        }
        if ($search !== '') {
            $like = '%' . $search . '%';
            $fromSql .= " AND (
                s.subject_code LIKE ?
                OR s.subject_name LIKE ?
                OR sec.section_name LIKE ?
                OR r.room_name LIKE ?
                OR aer.reason LIKE ?
            )";
            $types .= 'sssss';
            array_push($params, $like, $like, $like, $like, $like);
        }

        // Status cards reflect the current search/date range but remain useful
        // while one status is selected, so this aggregate intentionally runs
        // before the status condition is appended.
        $stats = null;
        if ($paginate) {
            $statsSql = "SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN aer.status = 'pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN aer.status = 'approved' THEN 1 ELSE 0 END) AS approved,
                SUM(CASE WHEN aer.status = 'rejected' THEN 1 ELSE 0 END) AS rejected
                {$fromSql}";
            $statsStmt = $mysqli->prepare($statsSql);
            if (!$statsStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            if (!empty($params)) safe_bind_params($statsStmt, $types, $params);
            if (!$statsStmt->execute()) json_response(['error' => 'execute_failed', 'message' => $statsStmt->error], 500);
            $statsRow = $statsStmt->get_result()->fetch_assoc() ?: [];
            $stats = [
                'total' => (int)($statsRow['total'] ?? 0),
                'pending' => (int)($statsRow['pending'] ?? 0),
                'approved' => (int)($statsRow['approved'] ?? 0),
                'rejected' => (int)($statsRow['rejected'] ?? 0),
            ];
            $statsStmt->close();
        }

        if ($status !== null) {
            $fromSql .= " AND aer.status = ?";
            $types .= 's';
            $params[] = $status;
        }

        $total = null;
        if ($paginate) {
            $countStmt = $mysqli->prepare("SELECT COUNT(*) AS total {$fromSql}");
            if (!$countStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            if (!empty($params)) safe_bind_params($countStmt, $types, $params);
            if (!$countStmt->execute()) json_response(['error' => 'execute_failed', 'message' => $countStmt->error], 500);
            $total = (int)(($countStmt->get_result()->fetch_assoc()['total'] ?? 0));
            $countStmt->close();
            $totalPages = max(1, (int)ceil($total / $perPage));
            if ($page > $totalPages) $page = $totalPages;
        }

        $sql = $selectSql . $fromSql . " ORDER BY aer.created_at DESC, aer.request_id DESC";
        if ($paginate) {
            $offset = ($page - 1) * $perPage;
            $sql .= " LIMIT ? OFFSET ?";
            $types .= 'ii';
            $params[] = $perPage;
            $params[] = $offset;
        }
        $stmt = $mysqli->prepare($sql);
        if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        if (!empty($params)) safe_bind_params($stmt, $types, $params);
        if (!$stmt->execute()) json_response(['error' => 'execute_failed', 'message' => $stmt->error], 500);
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        if (!$paginate) json_response($rows);
        json_response([
            'data' => $rows,
            'pagination' => [
                'page' => $page,
                'per_page' => $perPage,
                'total' => $total,
                'total_pages' => max(1, (int)ceil($total / $perPage)),
            ],
            'stats' => $stats,
        ]);
    }

    if ($request_method === 'POST' && empty($param2)) {
        if (!in_array((int)$authRole, [2, 3, 4, 5], true)) {
            json_response(['error' => 'forbidden', 'message' => 'Only dean, department admin, program head, secretary, and teacher can submit attendance edit requests'], 403);
        }

        $attendanceId = isset($input['attendance_id']) ? (int)$input['attendance_id'] : 0;
        $reason = trim((string)($input['reason'] ?? ''));
        if ($attendanceId <= 0 || $reason === '') {
            json_response(['error' => 'missing_fields', 'message' => 'attendance_id and reason are required'], 400);
        }

        $check = $mysqli->prepare("SELECT attendance_id, user_id, date, flag_in_id, flag_check_id, flag_out_id FROM tbl_attendance_records WHERE attendance_id = ? LIMIT 1");
        if (!$check) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        $check->bind_param('i', $attendanceId);
        $check->execute();
        $attendance = $check->get_result()->fetch_assoc();
        if (!$attendance) json_response(['error' => 'not_found', 'message' => 'Attendance record not found'], 404);
        if ((int)$attendance['user_id'] !== $authUserId) {
            json_response(['error' => 'forbidden', 'message' => 'You can only request edits for your own attendance records'], 403);
        }
        if (
            (int)$attendance['flag_in_id'] === 2
            && (int)$attendance['flag_check_id'] === 2
            && (int)$attendance['flag_out_id'] === 2
        ) {
            json_response([
                'error' => 'attendance_already_complete',
                'message' => 'This attendance is already complete. All three checkpoints are Present.'
            ], 409);
        }

        $dup = $mysqli->prepare("SELECT request_id FROM tbl_attendance_edit_requests WHERE attendance_id = ? AND requested_by = ? AND status = 'pending' LIMIT 1");
        if ($dup) {
            $dup->bind_param('ii', $attendanceId, $authUserId);
            $dup->execute();
            if ($dup->get_result()->fetch_assoc()) {
                json_response(['error' => 'duplicate_pending', 'message' => 'A pending request for this attendance record already exists'], 409);
            }
        }

        $stmt = $mysqli->prepare("INSERT INTO tbl_attendance_edit_requests (attendance_id, requested_by, reason, status) VALUES (?, ?, ?, 'pending')");
        if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        $stmt->bind_param('iis', $attendanceId, $authUserId, $reason);
        if (!$stmt->execute()) json_response(['error' => 'insert_failed', 'message' => $stmt->error], 500);

        $requestId = (int)$stmt->insert_id;
        log_system_action(
            $mysqli,
            $authUserId,
            'create_attendance_edit_request',
            "Submitted attendance edit request #{$requestId} for attendance_id={$attendanceId}"
        );
        // Dean, program head, secretary, and teacher accounts may all teach
        // and submit their own attendance edit requests. Notify every other
        // active Dean assigned to the requester's department, regardless of
        // the requester's teaching-capable role.
        if ($authDeptId !== null) {
            $requesterName = notif_get_user_full_name($mysqli, $authUserId);
            $notifTitle = 'Attendance Edit Request';
            $notifMessage = "{$requesterName} submitted an attendance edit request.";
            $notifLink = '/attendance-edit-requests?request_id=' . $requestId;
            notif_notify_role_dept($mysqli, 2, (int)$authDeptId, $notifTitle, $notifMessage, $notifLink, $authUserId, $authUserId);
        }
        json_response(['ok' => true, 'request_id' => $requestId], 201);
    }

    if (($request_method === 'PUT' || $request_method === 'POST') && is_numeric($param2)) {
        if ((int)$authRole !== 2) {
            json_response(['error' => 'forbidden', 'message' => 'Only dean can decide attendance edit requests'], 403);
        }
        $requestId = (int)$param2;
        $decision = strtolower(trim((string)($input['decision'] ?? $input['status'] ?? '')));
        if (!in_array($decision, ['approved', 'rejected'], true)) {
            json_response(['error' => 'invalid_decision', 'message' => 'decision must be approved or rejected'], 400);
        }

        $sql = "SELECT
                    aer.request_id,
                    aer.status,
                    aer.attendance_id,
                    aer.requested_by,
                    aer.reason,
                    ar.user_id AS teacher_id,
                    ar.date,
                    t.dept_id AS teacher_dept_id
                FROM tbl_attendance_edit_requests aer
                JOIN tbl_attendance_records ar ON aer.attendance_id = ar.attendance_id
                JOIN tbl_users t ON ar.user_id = t.user_id
                WHERE aer.request_id = ?
                LIMIT 1";
        $check = $mysqli->prepare($sql);
        if (!$check) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        $check->bind_param('i', $requestId);
        $check->execute();
        $row = $check->get_result()->fetch_assoc();
        if (!$row) json_response(['error' => 'not_found', 'message' => 'Attendance edit request not found'], 404);
        if ($authDeptId === null || (int)$row['teacher_dept_id'] !== (int)$authDeptId) {
            json_response(['error' => 'forbidden', 'message' => 'Request belongs to another department'], 403);
        }
        if (strtolower((string)$row['status']) !== 'pending') {
            json_response(['error' => 'already_decided', 'message' => 'Request is already decided'], 409);
        }

        // Attendance approval has one deterministic result: every checkpoint
        // becomes Present. Never trust client-provided flag changes here.
        // Rejection leaves the original attendance record untouched.
        $changes = $decision === 'approved'
            ? ['flag_in_id' => 2, 'flag_check_id' => 2, 'flag_out_id' => 2]
            : [];
        $mysqli->begin_transaction();
        try {
            if ($decision === 'approved' && !empty($changes)) {
                $existingStmt = $mysqli->prepare("SELECT checked_in_at, checked_mid_at, checked_out_at, flag_in_id, flag_check_id, flag_out_id FROM tbl_attendance_records WHERE attendance_id = ? LIMIT 1");
                if (!$existingStmt) {
                    throw new Exception($mysqli->error);
                }
                $attendanceId = (int)$row['attendance_id'];
                $existingStmt->bind_param('i', $attendanceId);
                if (!$existingStmt->execute()) {
                    throw new Exception($existingStmt->error);
                }
                $existing = $existingStmt->get_result()->fetch_assoc();
                $existingStmt->close();

                $allowed = [
                    'checked_in_at' => 's',
                    'checked_mid_at' => 's',
                    'checked_out_at' => 's',
                    'flag_in_id' => 'i',
                    'flag_check_id' => 'i',
                    'flag_out_id' => 'i',
                    'remarks' => 's',
                ];
                $fields = [];
                $types = '';
                $vals = [];
                foreach ($allowed as $field => $type) {
                    if (array_key_exists($field, $changes)) {
                        $value = $changes[$field];
                        if ($type === 'i') $value = ($value === null || $value === '') ? null : (int)$value;
                        if ($type === 's') $value = ($value === null || $value === '') ? null : trim((string)$value);
                        $fields[] = $field . " = ?";
                        $types .= $type;
                        $vals[] = $value;
                    }
                }
                if (!empty($fields)) {
                    $sql = "UPDATE tbl_attendance_records SET " . implode(', ', $fields) . " WHERE attendance_id = ?";
                    $types .= 'i';
                    $vals[] = (int)$row['attendance_id'];
                    $u = $mysqli->prepare($sql);
                    if (!$u) {
                        throw new Exception($mysqli->error);
                    }
                    safe_bind_params($u, $types, $vals);
                    if (!$u->execute()) {
                        throw new Exception($u->error);
                    }
                    $u->close();

                    $updatedStmt = $mysqli->prepare("SELECT checked_in_at, checked_mid_at, checked_out_at, flag_in_id, flag_check_id, flag_out_id FROM tbl_attendance_records WHERE attendance_id = ? LIMIT 1");
                    if (!$updatedStmt) {
                        throw new Exception($mysqli->error);
                    }
                    $updatedStmt->bind_param('i', $attendanceId);
                    if (!$updatedStmt->execute()) {
                        throw new Exception($updatedStmt->error);
                    }
                    $updated = $updatedStmt->get_result()->fetch_assoc();
                    $updatedStmt->close();

                    if (is_array($existing) && is_array($updated)) {
                        $ipAddr = get_client_ip_address();
                        $actorName = null;
                        $nameStmt = $mysqli->prepare("SELECT CONCAT_WS(' ', first_name, last_name) AS full_name FROM tbl_users WHERE user_id = ? LIMIT 1");
                        if ($nameStmt) {
                            $nameStmt->bind_param('i', $authUserId);
                            if (!$nameStmt->execute()) {
                                throw new Exception($nameStmt->error);
                            }
                            $nameRow = $nameStmt->get_result()->fetch_assoc();
                            if ($nameRow && !empty($nameRow['full_name'])) $actorName = $nameRow['full_name'];
                            $nameStmt->close();
                        }

                        $todayPrefix = 'EDIT_' . date('Ymd') . '_';
                        $sessNumber = 1;
                        $sessStmt = $mysqli->prepare("SELECT edit_session_id FROM tbl_attendance_logs WHERE edit_session_id LIKE CONCAT(?, '%') ORDER BY edit_session_id DESC LIMIT 1");
                        if ($sessStmt) {
                            $sessStmt->bind_param('s', $todayPrefix);
                            if (!$sessStmt->execute()) {
                                throw new Exception($sessStmt->error);
                            }
                            $last = $sessStmt->get_result()->fetch_assoc();
                            if ($last && !empty($last['edit_session_id']) && preg_match('/_(\d{3})$/', $last['edit_session_id'], $m)) {
                                $sessNumber = (int)$m[1] + 1;
                            }
                            $sessStmt->close();
                        }
                        $editSessionId = $todayPrefix . sprintf('%03d', $sessNumber);

                        $approvalReason = 'Approved attendance correction';
                        $requestReason = trim((string)($row['reason'] ?? ''));
                        if ($requestReason !== '') $approvalReason .= '. Request reason: ' . $requestReason;

                        $logMap = [
                            'flag_in_id' => 'flag_in',
                            'flag_check_id' => 'flag_mid',
                            'flag_out_id' => 'flag_out',
                            'checked_in_at' => 'time_in',
                            'checked_mid_at' => 'time_mid',
                            'checked_out_at' => 'time_out'
                        ];
                        foreach ($logMap as $dbField => $logName) {
                            $old = array_key_exists($dbField, $existing) ? $existing[$dbField] : null;
                            $new = array_key_exists($dbField, $updated) ? $updated[$dbField] : null;
                            if ($old === $new) continue;
                            log_attendance_change($mysqli, $authUserId, (int)$row['attendance_id'], $logName, $old, $new, $approvalReason, $ipAddr, 'approval', $editSessionId, $actorName);
                        }
                    }
                }
            }

            $upd = $mysqli->prepare("UPDATE tbl_attendance_edit_requests SET status = ?, decided_by = ? WHERE request_id = ?");
            if (!$upd) {
                throw new Exception($mysqli->error);
            }
            $upd->bind_param('sii', $decision, $authUserId, $requestId);
            if (!$upd->execute()) {
                throw new Exception($upd->error);
            }
            $upd->close();

            $mysqli->commit();
        } catch (Throwable $e) {
            $mysqli->rollback();
            json_response(['error' => 'update_failed', 'message' => $e->getMessage()], 500);
        }

        if ($decision === 'approved') {
            tardiness_reconcile_for_attendance($mysqli, (int)$row['attendance_id']);
        }

        $logAction = $decision === 'approved' ? 'approve_attendance_edit_request' : 'reject_attendance_edit_request';
        log_system_action(
            $mysqli,
            $authUserId,
            $logAction,
            ucfirst($decision) . " attendance edit request #{$requestId} for attendance_id=" . (int)$row['attendance_id']
        );
        $targetUserId = isset($row['requested_by']) ? (int)$row['requested_by'] : 0;
        if ($targetUserId > 0) {
            $notifTitle = $decision === 'approved' ? 'Attendance Edit Approved' : 'Attendance Edit Rejected';
            $notifMessage = "Your attendance edit request was {$decision}.";
            $notifLink = '/my-requested-edits?tab=attendance&request_id=' . $requestId;
            notif_insert($mysqli, $targetUserId, $notifTitle, $notifMessage, $notifLink, $authUserId);
        }
        json_response(['ok' => true, 'request_id' => $requestId, 'status' => $decision]);
    }

    json_response(['error' => 'method_not_allowed'], 405);
}

json_response(['error' => 'endpoint_not_found'], 404);
