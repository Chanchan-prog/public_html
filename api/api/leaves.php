<?php
// api/api/leaves.php
require_once __DIR__ . '/../helpers/socket_helper.php';
require_once __DIR__ . '/../helpers/log_helper.php'; 
require_once __DIR__ . '/../helpers/notification_helper.php';
require_once __DIR__ . '/../helpers/leave_attendance_helper.php';
global $mysqli, $authPayload;

$request_method = $_SERVER['REQUEST_METHOD'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$parts = explode('/', $path);
$api_prefix_key = array_search('api', $parts);
$endpoint = $parts[$api_prefix_key + 1] ?? null;
$param1 = $parts[$api_prefix_key + 2] ?? null; // id

$input = get_input() ?? [];

$auth = is_array($authPayload) ? $authPayload : app_get_authenticated_session(true);
$authRole = (int)($auth['role_id'] ?? 0);
$authUserId = (int)($auth['user_id'] ?? 0);

// --- HELPERS ---

function resolve_auth_dept($mysqli, $authUserId) {
    if (!$authUserId) return null;
    $s = $mysqli->prepare("SELECT dept_id FROM tbl_users WHERE user_id = ? LIMIT 1");
    if (!$s) return null;
    $s->bind_param('i', $authUserId);
    $s->execute();
    $r = $s->get_result()->fetch_assoc();
    return isset($r['dept_id']) ? (int)$r['dept_id'] : null;
}

function leave_actor_can_manage_target_role($actorRole, $targetRole) {
    $actorRole = (int)$actorRole;
    $targetRole = (int)$targetRole;
    if ($actorRole === 6) return in_array($targetRole, [2, 3, 4, 5], true);
    if ($actorRole === 2) return in_array($targetRole, [3, 4, 5], true);
    return false;
}

function leave_reject_unmanageable_target($authRole, $targetRole) {
    if (leave_actor_can_manage_target_role($authRole, $targetRole)) return;
    if ((int)$authRole === 2 && (int)$targetRole === 2) {
        json_response(['error'=>'dean_leave_requires_department_admin','message'=>'Only the Department Admin can manage a Dean\'s leave.'],403);
    }
    json_response(['error'=>'forbidden_leave_target','message'=>'You are not allowed to manage leave for this role.'],403);
}

function safe_bind_params($stmt, $types, $params) {
    $refs = [$types];
    foreach ($params as $k => $v) $refs[] = &$params[$k];
    return call_user_func_array([$stmt, 'bind_param'], $refs);
}

function leave_valid_date($value) {
    if (!is_string($value) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $value, $matches)) return false;
    return checkdate((int)$matches[2], (int)$matches[3], (int)$matches[1]);
}

// --- ROUTING ---

switch ($request_method) {
    case 'GET':
        if ($param1 === 'types') {
            $res = $mysqli->query("SELECT leave_type_id, name_type FROM tbl_leave_type ORDER BY leave_type_id");            
            json_response($res ? $res->fetch_all(MYSQLI_ASSOC) : []);
        }
        
        if (is_numeric($param1)){
            $id = (int)$param1;
            $stmt = $mysqli->prepare("SELECT l.*, lt.name_type, u.first_name, u.last_name, u.dept_id, u.role_id, u.status AS user_status, ap.first_name AS approver_first, ap.last_name AS approver_last FROM tbl_leaves l LEFT JOIN tbl_leave_type lt ON l.leave_type_id = lt.leave_type_id LEFT JOIN tbl_users u ON l.teacher_id = u.user_id LEFT JOIN tbl_users ap ON l.approved_by = ap.user_id WHERE l.leave_id = ? LIMIT 1");
            $stmt->bind_param('i', $id);
            $stmt->execute();
            $res = $stmt->get_result()->fetch_assoc();
            
            if ($authRole && (int)$authRole === 5) {
                if (!$res || (int)($res['teacher_id'] ?? 0) !== (int)$authUserId) {
                    json_response(['error'=>'forbidden'],403);
                }
            } elseif ($authRole && in_array($authRole, [2,3,4,6], true)) {
                $authDept = resolve_auth_dept($mysqli, $authUserId);
                if ($authDept === null || ($res && isset($res['dept_id']) && (int)$res['dept_id'] !== $authDept)) {
                    json_response(['error'=>'forbidden'],403);
                }
            }
            json_response($res ?: null);
        }

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

        $selectSql = "SELECT l.*, lt.name_type, u.first_name, u.last_name, u.dept_id, u.role_id, u.status AS user_status, ap.first_name AS approver_first, ap.last_name AS approver_last";
        $fromSql = " FROM tbl_leaves l LEFT JOIN tbl_leave_type lt ON l.leave_type_id = lt.leave_type_id LEFT JOIN tbl_users u ON l.teacher_id = u.user_id LEFT JOIN tbl_users ap ON l.approved_by = ap.user_id";
        $where = ['u.role_id IN (2, 3, 4, 5)'];
        $types = '';
        $params = [];

        if ($authRole && (int)$authRole === 5) {
            $where[] = 'l.teacher_id = ?';
            $types .= 'i';
            $params[] = (int)$authUserId;
        } elseif ($authRole && in_array($authRole, [2,3,4,6], true)) {
            $authDept = resolve_auth_dept($mysqli, $authUserId);
            if ($authDept === null) json_response([], 200);
            $where[] = 'u.dept_id = ?';
            $types .= 'i';
            $params[] = (int)$authDept;
        }

        // Include any leave that overlaps the requested calendar window.
        if ($dateFrom !== '') {
            $where[] = 'l.date_to >= ?';
            $types .= 's';
            $params[] = $dateFrom;
        }
        if ($dateTo !== '') {
            $where[] = 'l.date_from <= ?';
            $types .= 's';
            $params[] = $dateTo;
        }

        // Preserve the page-level totals before applying interactive table filters.
        $summaryWhere = $where;
        $summaryTypes = $types;
        $summaryParams = $params;

        $teacherId = isset($_GET['teacher_id']) && is_numeric($_GET['teacher_id']) ? (int)$_GET['teacher_id'] : 0;
        $status = strtolower(trim((string)($_GET['status'] ?? '')));
        $search = substr(trim((string)($_GET['search'] ?? '')), 0, 200);
        if ($teacherId > 0) {
            $where[] = 'l.teacher_id = ?';
            $types .= 'i';
            $params[] = $teacherId;
        }
        if (in_array($status, ['approve', 'void'], true)) {
            $where[] = 'LOWER(l.req_status) = ?';
            $types .= 's';
            $params[] = $status;
        }
        if ($search !== '') {
            $where[] = "LOWER(CONCAT_WS(' ', u.first_name, u.last_name, lt.name_type, l.reason)) LIKE ?";
            $types .= 's';
            $params[] = '%' . strtolower($search) . '%';
        }

        $whereSql = $where ? ' WHERE ' . implode(' AND ', $where) : '';
        $paginate = isset($_GET['paginate']) && in_array(strtolower((string)$_GET['paginate']), ['1', 'true', 'yes'], true);
        $page = isset($_GET['page']) && is_numeric($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        $pageSize = isset($_GET['page_size']) && is_numeric($_GET['page_size']) ? max(1, min(100, (int)$_GET['page_size'])) : 10;

        if ($paginate) {
            $countStmt = $mysqli->prepare('SELECT COUNT(*) AS total' . $fromSql . $whereSql);
            if (!$countStmt) json_response(['error'=>'prepare_failed','message'=>$mysqli->error], 500);
            if ($params) safe_bind_params($countStmt, $types, $params);
            $countStmt->execute();
            $total = (int)($countStmt->get_result()->fetch_assoc()['total'] ?? 0);
            $countStmt->close();
            $totalPages = max(1, (int)ceil($total / $pageSize));
            $page = min($page, $totalPages);
            $offset = ($page - 1) * $pageSize;

            $summarySql = "SELECT COUNT(*) AS total,
                SUM(CASE WHEN LOWER(l.req_status) = 'approve' AND l.date_from <= CURDATE() AND l.date_to >= CURDATE() THEN 1 ELSE 0 END) AS active_today,
                SUM(CASE WHEN LOWER(l.req_status) = 'approve' AND l.date_from > CURDATE() THEN 1 ELSE 0 END) AS upcoming" .
                $fromSql . ($summaryWhere ? ' WHERE ' . implode(' AND ', $summaryWhere) : '');
            $summaryStmt = $mysqli->prepare($summarySql);
            if (!$summaryStmt) json_response(['error'=>'prepare_failed','message'=>$mysqli->error], 500);
            if ($summaryParams) safe_bind_params($summaryStmt, $summaryTypes, $summaryParams);
            $summaryStmt->execute();
            $summary = $summaryStmt->get_result()->fetch_assoc() ?: [];
            $summaryStmt->close();
        }

        $sql = $selectSql . $fromSql . $whereSql . ' ORDER BY l.leave_id DESC';
        $dataTypes = $types;
        $dataParams = $params;
        if ($paginate) {
            $sql .= ' LIMIT ? OFFSET ?';
            $dataTypes .= 'ii';
            $dataParams[] = $pageSize;
            $dataParams[] = $offset;
        }
        $stmt = $mysqli->prepare($sql);
        if (!$stmt) json_response(['error'=>'prepare_failed','message'=>$mysqli->error], 500);
        if ($dataParams) safe_bind_params($stmt, $dataTypes, $dataParams);
        $stmt->execute();
        $res = $stmt->get_result();
        $rows = $res ? $res->fetch_all(MYSQLI_ASSOC) : [];
        if ($paginate) {
            json_response([
                'rows' => $rows,
                'pagination' => ['page'=>$page, 'page_size'=>$pageSize, 'total'=>$total, 'total_pages'=>$totalPages],
                'summary' => [
                    'total' => (int)($summary['total'] ?? 0),
                    'active_today' => (int)($summary['active_today'] ?? 0),
                    'upcoming' => (int)($summary['upcoming'] ?? 0),
                ]
            ]);
        }
        json_response($rows);
        break;

    case 'POST':
        if (!$authUserId) json_response(['error'=>'unauthorized','message'=>'Authentication required'], 401);
        $teacher_id = $input['teacher_id'] ?? null;
        $leave_type_id = $input['leave_type_id'] ?? 1;
        $date_from = $input['date_from'] ?? null;
        $date_to = $input['date_to'] ?? null;
        $reason = $input['reason'] ?? '';

        if (!$teacher_id || !$date_from || !$date_to){ json_response(['error'=>'missing_fields'], 400); }
        if (!leave_valid_date($date_from) || !leave_valid_date($date_to) || $date_from > $date_to) {
            json_response(['error'=>'invalid_leave_dates','message'=>'Enter a valid leave start and end date. The end date cannot be before the start date.'], 400);
        }

        if ($authRole) {
            if (!in_array((int)$authRole, [2, 6], true)) {
                json_response(['error'=>'forbidden','message'=>'Only the Dean or Department Admin can record approved leave.'], 403);
            } else {
                $tstmt = $mysqli->prepare("SELECT dept_id, role_id, status FROM tbl_users WHERE user_id = ? LIMIT 1");
                $tstmt->bind_param('i', $teacher_id); $tstmt->execute();
                $trow = $tstmt->get_result()->fetch_assoc();
                $authDept = resolve_auth_dept($mysqli, $authUserId);
                if ($authDept === null || !$trow || $authDept !== (int)$trow['dept_id']) json_response(['error'=>'forbidden_dept', 'message'=>'You can only file leaves for users inside your department.'],403);
                $targetStatus = strtolower(trim((string)($trow['status'] ?? 'active')));
                if (!in_array((int)($trow['role_id'] ?? 0), [2, 3, 4, 5], true) || !in_array($targetStatus, ['active', '1', 'true'], true)) {
                    json_response(['error'=>'invalid_leave_user', 'message'=>'Leave can only be filed for active teaching staff.'],409);
                }
                leave_reject_unmanageable_target($authRole, (int)$trow['role_id']);
            }
        }

        // Prevent Overlapping Dates Validation (Ignores 'void' leaves)
        $dupCheck = $mysqli->prepare("
            SELECT leave_id, date_from, date_to 
            FROM tbl_leaves 
            WHERE teacher_id = ? 
            AND req_status != 'void' 
            AND date_from <= ? 
            AND date_to >= ? 
            LIMIT 1
        ");
        
        $dupCheck->bind_param('iss', $teacher_id, $date_to, $date_from);
        $dupCheck->execute();
        
        if ($dupCheck->get_result()->num_rows > 0) {
            json_response(['error'=>'duplicate_leave', 'message'=>'Leave dates overlap with an existing active leave for this teacher.'], 409);
        }
        $dupCheck->close();

        $requested_by = $authUserId ?? null;
        $auto_status = 'approve';

        $mysqli->begin_transaction();
        try {
            $stmt = $mysqli->prepare("INSERT INTO tbl_leaves (approved_by, teacher_id, leave_type_id, req_status, date_from, date_to, reason, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
            if (!$stmt) throw new mysqli_sql_exception($mysqli->error);
            $stmt->bind_param('iiissssi', $authUserId, $teacher_id, $leave_type_id, $auto_status, $date_from, $date_to, $reason, $requested_by);
            if (!$stmt->execute()) throw new mysqli_sql_exception($stmt->error);
            $new_id = $stmt->insert_id;
            $attendanceSync = leave_attendance_apply_approved($mysqli, (int)$new_id);
            if (!$attendanceSync['ok']) throw new mysqli_sql_exception((string)$attendanceSync['error']);
            $mysqli->commit();
        } catch (Throwable $error) {
            $mysqli->rollback();
            json_response(['error'=>'insert_failed','message'=>'The leave could not be recorded or synchronized with attendance.'],500);
        }

        $log_teacher_name = "Unknown";
        $log_leave_name = "Leave";

        $nameQ = $mysqli->prepare("SELECT u.last_name, u.first_name, lt.name_type FROM tbl_users u, tbl_leave_type lt WHERE u.user_id = ? AND lt.leave_type_id = ?");
        $nameQ->bind_param('ii', $teacher_id, $leave_type_id);
        $nameQ->execute();
        $nameRes = $nameQ->get_result()->fetch_assoc();
        
        if ($nameRes) {
            $log_teacher_name = $nameRes['first_name'] . " " . $nameRes['last_name'];
            $log_leave_name = $nameRes['name_type'];
        }

        $log_message = "Recorded approved $log_leave_name for $log_teacher_name ($date_from to $date_to)";
        log_system_action($mysqli, $authUserId, 'record_approved_leave', $log_message);
        if ((int)$teacher_id > 0) {
            $notifTitle = 'Leave Approved';
            $notifMessage = "Your approved {$log_leave_name} leave ({$date_from} to {$date_to}) has been recorded.";
            notif_insert($mysqli, (int)$teacher_id, $notifTitle, $notifMessage, '/attendance-history', $authUserId);
        }

        try { trigger_socket_update(['entity'=>'leaves','action'=>'create','leave_id'=>$new_id]); } catch(Throwable $_){}
        json_response(['leave_id'=>$new_id, 'attendance_rows_updated'=>(int)($attendanceSync['affected_rows'] ?? 0)],201);
        break;

    case 'PUT':
        if (!$authUserId) json_response(['error'=>'unauthorized','message'=>'Authentication required'], 401);
        if (!is_numeric($param1)) json_response(['error'=>'missing_id'],400);
        $id = (int)$param1;

        $check = $mysqli->prepare("
            SELECT l.*, u.dept_id, u.role_id, u.status AS user_status, u.first_name, u.last_name, lt.name_type
            FROM tbl_leaves l 
            JOIN tbl_users u ON l.teacher_id = u.user_id 
            JOIN tbl_leave_type lt ON l.leave_type_id = lt.leave_type_id
            WHERE l.leave_id = ? LIMIT 1
        ");
        $check->bind_param('i',$id);
        $check->execute();
        $row = $check->get_result()->fetch_assoc();

        if (!$row) json_response(['error'=>'not_found'],404);
        if (!app_user_status_is_active($row['user_status'] ?? null)) {
            json_response([
                'error'=>'inactive_leave_user',
                'message'=>'Leave records for inactive or archived users are read-only. Activate the user before changing this record.'
            ],409);
        }

        if ($authRole) { 
            $authDept = resolve_auth_dept($mysqli, $authUserId);
            if (!in_array((int)$authRole, [2, 6], true)) {
                 json_response(['error'=>'forbidden', 'message'=>'Only the Dean or Department Admin can edit leave records.'],403);
            } else {
                 if ($authDept === null || (int)$row['dept_id'] !== $authDept) json_response(['error'=>'forbidden', 'message'=>'You cannot edit records outside your specific department.'],403);
                 leave_reject_unmanageable_target($authRole, (int)$row['role_id']);
            }
        }

        $nextTeacherId = isset($input['teacher_id']) ? (int)$input['teacher_id'] : (int)$row['teacher_id'];
        $nextDateFrom = isset($input['date_from']) ? trim((string)$input['date_from']) : (string)$row['date_from'];
        $nextDateTo = isset($input['date_to']) ? trim((string)$input['date_to']) : (string)$row['date_to'];
        $nextStatus = isset($input['req_status']) && strtolower((string)$input['req_status']) === 'void' ? 'void' : (isset($input['req_status']) ? 'approve' : strtolower((string)$row['req_status']));
        if (!leave_valid_date($nextDateFrom) || !leave_valid_date($nextDateTo) || $nextDateFrom > $nextDateTo) {
            json_response(['error'=>'invalid_leave_dates','message'=>'Enter a valid leave start and end date. The end date cannot be before the start date.'], 400);
        }
        $coverageChanged = $nextTeacherId !== (int)$row['teacher_id']
            || $nextDateFrom !== (string)$row['date_from']
            || $nextDateTo !== (string)$row['date_to'];
        $currentlyApproved = strtolower((string)$row['req_status']) === 'approve';
        if ($currentlyApproved && ($coverageChanged || $nextStatus === 'void') && leave_attendance_has_substitutions($mysqli, $id)) {
            json_response([
                'error'=>'leave_has_substitutions',
                'message'=>'This leave cannot be cancelled or moved because at least one affected class already has a substitute.'
            ], 409);
        }

        $fields = []; $types = ''; $vals = [];
        $log_action_type = 'update_leave'; 
        $log_status_note = '';

        if (isset($input['req_status'])){
            // Force status to be either 'approve' or 'void'
            $status = (strtolower($input['req_status']) === 'void') ? 'void' : 'approve';
            
            $fields[] = 'req_status = ?'; $types .= 's'; $vals[] = $status;
            
            if ($status === 'approve'){
                $fields[] = 'approved_by = ?'; $types .= 'i'; $vals[] = $authUserId;
                $log_action_type = 'approve_leave';
                $log_status_note = "Approved";
            } elseif ($status === 'void') {
                $log_action_type = 'void_leave';
                $log_status_note = "Cancelled";
            }
        }
        
        if (isset($input['date_from'])){ $fields[] = 'date_from = ?'; $types .= 's'; $vals[] = $input['date_from']; }
        if (isset($input['date_to'])){ $fields[] = 'date_to = ?'; $types .= 's'; $vals[] = $input['date_to']; }
        if (isset($input['reason'])){ $fields[] = 'reason = ?'; $types .= 's'; $vals[] = $input['reason']; }
        if (isset($input['leave_type_id'])){ $fields[] = 'leave_type_id = ?'; $types .= 'i'; $vals[] = $input['leave_type_id']; }
        if (isset($input['teacher_id'])){
            $targetStmt = $mysqli->prepare("SELECT dept_id, role_id, status FROM tbl_users WHERE user_id = ? LIMIT 1");
            if (!$targetStmt) json_response(['error'=>'prepare_failed','message'=>$mysqli->error],500);
            $targetStmt->bind_param('i', $nextTeacherId);
            $targetStmt->execute();
            $targetUser = $targetStmt->get_result()->fetch_assoc();
            $targetStmt->close();
            $targetStatus = strtolower(trim((string)($targetUser['status'] ?? '')));
            if (!$targetUser || !in_array((int)($targetUser['role_id'] ?? 0), [2, 3, 4, 5], true) || !in_array($targetStatus, ['active', '1', 'true'], true)) {
                json_response(['error'=>'invalid_leave_user','message'=>'Leave can only be assigned to active teaching staff.'],409);
            }
            if ($authDept === null || (int)$targetUser['dept_id'] !== (int)$authDept) {
                json_response(['error'=>'forbidden_dept','message'=>'You can only assign leave inside your department.'],403);
            }
            leave_reject_unmanageable_target($authRole, (int)$targetUser['role_id']);
            $fields[] = 'teacher_id = ?'; $types .= 'i'; $vals[] = $nextTeacherId;
        }

        if (empty($fields)) json_response(['message'=>'nothing_to_update'],200);

        if ($nextStatus === 'approve') {
            $overlapStmt = $mysqli->prepare("
                SELECT leave_id
                FROM tbl_leaves
                WHERE teacher_id = ?
                  AND leave_id <> ?
                  AND req_status <> 'void'
                  AND date_from <= ?
                  AND date_to >= ?
                LIMIT 1
            ");
            if (!$overlapStmt) json_response(['error'=>'prepare_failed','message'=>$mysqli->error],500);
            $overlapStmt->bind_param('iiss', $nextTeacherId, $id, $nextDateTo, $nextDateFrom);
            $overlapStmt->execute();
            $hasOverlap = (bool)$overlapStmt->get_result()->fetch_row();
            $overlapStmt->close();
            if ($hasOverlap) {
                json_response(['error'=>'duplicate_leave','message'=>'Leave dates overlap with an existing active leave for this teacher.'],409);
            }
        }

        $sql = "UPDATE tbl_leaves SET " . implode(', ', $fields) . " WHERE leave_id = ?";
        $stmt = $mysqli->prepare($sql);
        if (!$stmt) json_response(['error'=>'prepare_failed','message'=>$mysqli->error],500);
        $types .= 'i'; $vals[] = $id;
        safe_bind_params($stmt, $types, $vals);

        $mysqli->begin_transaction();
        try {
            if ($currentlyApproved && ($coverageChanged || $nextStatus === 'void')) {
                $restored = leave_attendance_restore_cancelled(
                    $mysqli,
                    (int)$row['teacher_id'],
                    (string)$row['date_from'],
                    (string)$row['date_to']
                );
                if (!$restored['ok']) throw new mysqli_sql_exception((string)$restored['error']);
            }
            if (!$stmt->execute()) throw new mysqli_sql_exception($stmt->error);
            $attendanceSync = ['affected_rows' => 0];
            if ($nextStatus === 'approve') {
                $attendanceSync = leave_attendance_apply_approved($mysqli, $id);
                if (!$attendanceSync['ok']) throw new mysqli_sql_exception((string)$attendanceSync['error']);
            }
            $mysqli->commit();
        } catch (Throwable $error) {
            $mysqli->rollback();
            json_response(['error'=>'update_failed','message'=>'The leave or its attendance statuses could not be updated.'],500);
        }

        $teacher_name = $row['first_name'] . " " . $row['last_name'];
        $leave_name = $row['name_type'];

        if ($log_status_note) {
            $log_details = "$log_status_note $leave_name for $teacher_name";
        } else {
            $log_details = "Updated details of $leave_name for $teacher_name";
        }

        log_system_action($mysqli, $authUserId, $log_action_type, $log_details);

        try { trigger_socket_update(['entity'=>'leaves','action'=>'update','leave_id'=>$id]); } catch(Throwable $_){}
        json_response(['ok'=>true, 'attendance_rows_updated'=>(int)($attendanceSync['affected_rows'] ?? 0)]);
        break;

    case 'DELETE':
        json_response(['error'=>'not_allowed'],405);
        break;
}
?>
