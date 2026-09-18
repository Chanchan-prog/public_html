<?php
// api/api/penalties.php
require_once __DIR__ . '/../helpers/socket_helper.php';
require_once __DIR__ . '/../helpers/log_helper.php';
global $mysqli, $authPayload;

$request_method = $_SERVER['REQUEST_METHOD'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$parts = explode('/', $path);
$api_prefix_key = array_search('api', $parts);
$endpoint = $parts[$api_prefix_key + 1] ?? null;
$param1 = $parts[$api_prefix_key + 2] ?? null; 
$input = get_input() ?? [];

$auth = is_array($authPayload) ? $authPayload : app_get_authenticated_session(true);
$authUserId = (int)($auth['user_id'] ?? 0);
$authUserRole = (int)($auth['role_id'] ?? 0);
$authUserDept = isset($auth['dept_id']) && $auth['dept_id'] !== null ? (int)$auth['dept_id'] : null;

function penalty_reject_unmanageable_target($actorRole, $actorUserId, $targetRole, $targetUserId) {
    $actorRole = (int)$actorRole;
    $actorUserId = (int)$actorUserId;
    $targetRole = (int)$targetRole;
    $targetUserId = (int)$targetUserId;
    if ($actorUserId > 0 && $actorUserId === $targetUserId) {
        json_response(['error'=>'self_penalty_forbidden','message'=>'You cannot issue or manage a penalty for yourself.'],403);
    }
    $allowed = $actorRole === 6
        ? in_array($targetRole, [2, 3, 4, 5], true)
        : ($actorRole === 2 && in_array($targetRole, [3, 4, 5], true));
    if ($allowed) return;
    if ($actorRole === 2 && $targetRole === 2) {
        json_response(['error'=>'dean_penalty_requires_department_admin','message'=>'Only the Department Admin can manage a penalty for a Dean.'],403);
    }
    json_response(['error'=>'forbidden_penalty_target','message'=>'You are not allowed to manage penalties for this role.'],403);
}

// --------------------------------------------------------------------------------
// ENDPOINT: GET /api/penalty-types (Fixed: Removed 'description')
// --------------------------------------------------------------------------------
if ($request_method === 'GET' && $endpoint === 'penalty-types') {
    // FIXED: Removed 'description' from column list
    $res = $mysqli->query("SELECT penal_type_id, type_name FROM tbl_penalties_type ORDER BY type_name");
    json_response($res ? $res->fetch_all(MYSQLI_ASSOC) : []);
    exit;
}

// --------------------------------------------------------------------------------
// MAIN ENDPOINT: /api/penalties
// --------------------------------------------------------------------------------
switch ($request_method){
    case 'GET':
        // View Single Penalty
        if (is_numeric($param1)){
            $id = (int)$param1;
            $stmt = $mysqli->prepare("SELECT p.*, pt.type_name, u.first_name, u.last_name, u.dept_id, u.role_id, u.status AS user_status, r.role_name
                FROM tbl_penalties p
                LEFT JOIN tbl_penalties_type pt ON p.penal_type_id = pt.penal_type_id
                LEFT JOIN tbl_users u ON p.user_id = u.user_id
                LEFT JOIN tbl_roles r ON u.role_id = r.role_id
                WHERE p.sanction_id = ? LIMIT 1");
            $stmt->bind_param('i',$id);
            $stmt->execute();
            $row = $stmt->get_result()->fetch_assoc();
            
            // Authorization
            if ((int)$authUserRole === 5) {
                if (!$row || (int)($row['user_id'] ?? 0) !== (int)$authUserId) {
                    json_response(['error'=>'forbidden'], 403);
                }
            } elseif ($authUserRole !== 1 && $authUserDept !== null) {
                if ($row && isset($row['dept_id']) && (int)$row['dept_id'] !== $authUserDept) {
                    json_response(['error'=>'forbidden'], 403);
                }
            } elseif ($authUserRole !== 1 && $authUserDept === null) {
                json_response(['error'=>'forbidden'], 403);
            }
            json_response($row);
        }
        
        // List All Penalties
        $selectSql = "SELECT p.sanction_id, p.user_id, p.penal_type_id, p.semester_id, p.date, p.reason,
                       p.source, p.policy_code, p.trigger_attendance_id, p.trigger_stage, p.status, p.voided_at,
                       pt.type_name, 
                       u.first_name, u.last_name, u.dept_id, u.role_id, u.status AS user_status,
                       r.role_name,
                       d.dept_name";
        $fromSql = " FROM tbl_penalties p 
                LEFT JOIN tbl_penalties_type pt ON p.penal_type_id = pt.penal_type_id 
                LEFT JOIN tbl_users u ON p.user_id = u.user_id 
                LEFT JOIN tbl_roles r ON u.role_id = r.role_id
                LEFT JOIN tbl_departments d ON u.dept_id = d.dept_id";
        $where = ['u.role_id IN (2, 3, 4, 5)'];
        
        $types = "";
        $params = [];

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

        if ($dateFrom !== '') {
            $where[] = 'p.date >= ?';
            $types .= 's';
            $params[] = $dateFrom;
        }
        if ($dateTo !== '') {
            $where[] = 'p.date <= ?';
            $types .= 's';
            $params[] = $dateTo;
        }

        // Role Filter
        if ((int)$authUserRole === 5) {
            $where[] = 'p.user_id = ?';
            $types .= "i";
            $params[] = (int)$authUserId;
        } elseif ($authUserRole !== 1 && $authUserDept !== null) {
            $where[] = 'u.dept_id = ?';
            $types .= "i";
            $params[] = $authUserDept;
        } elseif ($authUserRole !== 1 && $authUserDept === null) {
            $where[] = '1 = 0';
        }

        $summaryWhere = $where;
        $summaryTypes = $types;
        $summaryParams = $params;

        $roleId = isset($_GET['role_id']) && is_numeric($_GET['role_id']) ? (int)$_GET['role_id'] : 0;
        $source = strtolower(trim((string)($_GET['source'] ?? '')));
        $status = strtolower(trim((string)($_GET['status'] ?? '')));
        $search = substr(trim((string)($_GET['search'] ?? '')), 0, 200);
        if (in_array($roleId, [2, 3, 4, 5], true)) {
            $where[] = 'u.role_id = ?'; $types .= 'i'; $params[] = $roleId;
        }
        if (in_array($source, ['automatic', 'manual'], true)) {
            $where[] = 'LOWER(COALESCE(p.source, \'manual\')) = ?'; $types .= 's'; $params[] = $source;
        }
        if (in_array($status, ['active', 'voided'], true)) {
            $where[] = 'LOWER(COALESCE(p.status, \'active\')) = ?'; $types .= 's'; $params[] = $status;
        }
        if ($search !== '') {
            $where[] = "LOWER(CONCAT_WS(' ', u.first_name, u.last_name, pt.type_name, p.reason, d.dept_name, r.role_name)) LIKE ?";
            $types .= 's'; $params[] = '%' . strtolower($search) . '%';
        }

        $whereSql = ' WHERE ' . implode(' AND ', $where);
        $paginate = isset($_GET['paginate']) && in_array(strtolower((string)$_GET['paginate']), ['1', 'true', 'yes'], true);
        $page = isset($_GET['page']) && is_numeric($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        $pageSize = isset($_GET['page_size']) && is_numeric($_GET['page_size']) ? max(1, min(100, (int)$_GET['page_size'])) : 10;

        if ($paginate) {
            $countStmt = $mysqli->prepare('SELECT COUNT(*) AS total' . $fromSql . $whereSql);
            if (!$countStmt) json_response(['error'=>'prepare_failed','message'=>$mysqli->error], 500);
            if ($params) $countStmt->bind_param($types, ...$params);
            $countStmt->execute();
            $total = (int)($countStmt->get_result()->fetch_assoc()['total'] ?? 0);
            $countStmt->close();
            $totalPages = max(1, (int)ceil($total / $pageSize));
            $page = min($page, $totalPages);
            $offset = ($page - 1) * $pageSize;

            $summarySql = "SELECT COUNT(*) AS total,
                SUM(CASE WHEN LOWER(COALESCE(p.status, 'active')) = 'active' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN LOWER(COALESCE(p.source, 'manual')) = 'automatic' THEN 1 ELSE 0 END) AS automatic,
                SUM(CASE WHEN LOWER(COALESCE(p.source, 'manual')) <> 'automatic' THEN 1 ELSE 0 END) AS manual" .
                $fromSql . ' WHERE ' . implode(' AND ', $summaryWhere);
            $summaryStmt = $mysqli->prepare($summarySql);
            if (!$summaryStmt) json_response(['error'=>'prepare_failed','message'=>$mysqli->error], 500);
            if ($summaryParams) $summaryStmt->bind_param($summaryTypes, ...$summaryParams);
            $summaryStmt->execute();
            $summary = $summaryStmt->get_result()->fetch_assoc() ?: [];
            $summaryStmt->close();
        }

        $sql = $selectSql . $fromSql . $whereSql . " ORDER BY p.date DESC, p.sanction_id DESC";
        $dataTypes = $types;
        $dataParams = $params;
        if ($paginate) {
            $sql .= ' LIMIT ? OFFSET ?';
            $dataTypes .= 'ii'; $dataParams[] = $pageSize; $dataParams[] = $offset;
        }
        
        $stmt = $mysqli->prepare($sql);
        if (!$stmt) json_response(['error'=>'prepare_failed','message'=>$mysqli->error], 500);
        if(!empty($dataParams)) $stmt->bind_param($dataTypes, ...$dataParams);
        $stmt->execute();
        $res = $stmt->get_result();
        $rows = $res ? $res->fetch_all(MYSQLI_ASSOC) : [];
        if ($paginate) {
            json_response([
                'rows'=>$rows,
                'pagination'=>['page'=>$page,'page_size'=>$pageSize,'total'=>$total,'total_pages'=>$totalPages],
                'summary'=>[
                    'total'=>(int)($summary['total'] ?? 0),
                    'active'=>(int)($summary['active'] ?? 0),
                    'automatic'=>(int)($summary['automatic'] ?? 0),
                    'manual'=>(int)($summary['manual'] ?? 0),
                ]
            ]);
        }
        json_response($rows);
        break;

    case 'POST':
        if (!in_array((int)$authUserRole, [2, 6], true)) {
            json_response(['error' => 'forbidden', 'message' => 'Only the Dean or Department Admin can add penalties.'], 403);
        }
        $issued_by = $authUserId; 
        $user_id = $input['user_id'] ?? null;
        $penal_type_id = $input['penal_type_id'] ?? null;
        $date = $input['date'] ?? null;
        $reason = $input['reason'] ?? '';
        
        if (!$issued_by || !$user_id || !$penal_type_id || !$date) json_response(['error'=>'missing_fields'], 400);
        
        // Penalty subjects must be active teaching staff: roles 2-5.
        $s = $mysqli->prepare("SELECT dept_id, role_id, status FROM tbl_users WHERE user_id = ? LIMIT 1");
        if (!$s) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        $s->bind_param('i', $user_id);
        $s->execute();
        $ur = $s->get_result()->fetch_assoc();
        $s->close();
        $targetDept = isset($ur['dept_id']) ? (int)$ur['dept_id'] : null;
        $targetRole = isset($ur['role_id']) ? (int)$ur['role_id'] : 0;
        $targetStatus = strtolower(trim((string)($ur['status'] ?? '')));
        if (!$ur || !in_array($targetRole, [2, 3, 4, 5], true) || !in_array($targetStatus, ['active', '1', 'true'], true)) {
            json_response(['error' => 'invalid_penalty_subject', 'message' => 'Penalties can only be assigned to an active Dean, Program Head, Secretary, or Teacher.'], 409);
        }
        penalty_reject_unmanageable_target($authUserRole, $authUserId, $targetRole, (int)$user_id);
        if ((int)$authUserRole !== 1 && ($authUserDept === null || $targetDept !== (int)$authUserDept)) {
            json_response(['error'=>'forbidden_different_dept', 'message'=>'You can only penalize teaching staff in your department.'], 403);
        }
        
        $stmt = $mysqli->prepare("INSERT INTO tbl_penalties (issued_by, user_id, penal_type_id, date, reason) VALUES (?, ?, ?, ?, ?)");
        $stmt->bind_param('iiiss', $issued_by, $user_id, $penal_type_id, $date, $reason);
        if (!$stmt->execute()) json_response(['error'=>'insert_failed','message'=>$stmt->error], 500);
        
        // Get penalty type name for logging
        $penaltyTypeName = '';
        $ptStmt = $mysqli->prepare("SELECT type_name FROM tbl_penalties_type WHERE penal_type_id = ? LIMIT 1");
        if ($ptStmt) { $ptStmt->bind_param('i', $penal_type_id); $ptStmt->execute(); $ptRow = $ptStmt->get_result()->fetch_assoc(); $penaltyTypeName = $ptRow['type_name'] ?? ''; $ptStmt->close(); }
        // Get teacher name for logging
        $teacherName = '';
        $tnStmt = $mysqli->prepare("SELECT CONCAT_WS(' ', first_name, last_name) AS full_name FROM tbl_users WHERE user_id = ? LIMIT 1");
        if ($tnStmt) { $tnStmt->bind_param('i', $user_id); $tnStmt->execute(); $tnRow = $tnStmt->get_result()->fetch_assoc(); $teacherName = $tnRow['full_name'] ?? ''; $tnStmt->close(); }
        $logMsg = $penaltyTypeName ? "Issued {$penaltyTypeName} sanction to {$teacherName}" : "Issued sanction to {$teacherName}";
        log_system_action($mysqli, $authUserId, 'create_penalty', $logMsg);

        $id = $stmt->insert_id;
        try { trigger_socket_update(['entity'=>'penalties','action'=>'create','sanction_id'=>$id]); } catch(Throwable $_){}
        json_response(['sanction_id'=>$id], 201);
        break;

    case 'PUT':
        if (!is_numeric($param1)) json_response(['error'=>'missing_id'], 400);
        if (!in_array((int)$authUserRole, [2, 6], true)) {
            json_response(['error' => 'forbidden', 'message' => 'Only the Dean or Department Admin can edit penalties.'], 403);
        }
        $id = (int)$param1;

        $accessStmt = $mysqli->prepare("SELECT p.user_id, u.dept_id, u.role_id, u.status AS user_status FROM tbl_penalties p JOIN tbl_users u ON u.user_id = p.user_id WHERE p.sanction_id = ? LIMIT 1");
        if (!$accessStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        $accessStmt->bind_param('i', $id);
        $accessStmt->execute();
        $accessRow = $accessStmt->get_result()->fetch_assoc();
        $accessStmt->close();
        if (!$accessRow) json_response(['error' => 'not_found', 'message' => 'Penalty record not found.'], 404);
        if (!app_user_status_is_active($accessRow['user_status'] ?? null)) {
            json_response(['error' => 'inactive_penalty_user', 'message' => 'Penalty records for inactive or archived users are read-only. Activate the user before editing this record.'], 409);
        }
        penalty_reject_unmanageable_target($authUserRole, $authUserId, (int)$accessRow['role_id'], (int)$accessRow['user_id']);
        if ((int)$authUserRole !== 1 && ($authUserDept === null || (int)$accessRow['dept_id'] !== (int)$authUserDept)) {
            json_response(['error' => 'forbidden_different_dept', 'message' => 'You can only edit penalties in your department.'], 403);
        }

        if (isset($input['user_id'])) {
            $nextUserId = (int)$input['user_id'];
            $subjectStmt = $mysqli->prepare("SELECT dept_id, role_id, status FROM tbl_users WHERE user_id = ? LIMIT 1");
            if (!$subjectStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $subjectStmt->bind_param('i', $nextUserId);
            $subjectStmt->execute();
            $subject = $subjectStmt->get_result()->fetch_assoc();
            $subjectStmt->close();
            $subjectStatus = strtolower(trim((string)($subject['status'] ?? '')));
            if (!$subject || !in_array((int)($subject['role_id'] ?? 0), [2, 3, 4, 5], true) || !in_array($subjectStatus, ['active', '1', 'true'], true)) {
                json_response(['error' => 'invalid_penalty_subject', 'message' => 'Penalties can only be assigned to an active Dean, Program Head, Secretary, or Teacher.'], 409);
            }
            penalty_reject_unmanageable_target($authUserRole, $authUserId, (int)$subject['role_id'], $nextUserId);
            if ((int)$authUserRole !== 1 && ($authUserDept === null || (int)$subject['dept_id'] !== (int)$authUserDept)) {
                json_response(['error' => 'forbidden_different_dept', 'message' => 'You can only penalize teaching staff in your department.'], 403);
            }
        }
        
        $fields = []; $types = ''; $vals = [];
        if (isset($input['user_id'])){ $fields[]='user_id = ?'; $types.='i'; $vals[]=(int)$input['user_id']; }
        if (isset($input['penal_type_id'])){ $fields[]='penal_type_id = ?'; $types.='i'; $vals[]=(int)$input['penal_type_id']; }
        if (isset($input['date'])){ $fields[]='date = ?'; $types.='s'; $vals[]=$input['date']; }
        if (isset($input['reason'])){ $fields[]='reason = ?'; $types.='s'; $vals[]=$input['reason']; }
        
        if (empty($fields)) { json_response(['message'=>'nothing_to_update'], 200); exit; }

        // Get existing penalty info for logging before updating
        $oldPenalty = null;
        $olStmt = $mysqli->prepare("SELECT p.reason, pt.type_name, CONCAT_WS(' ', u.first_name, u.last_name) AS teacher_name FROM tbl_penalties p LEFT JOIN tbl_penalties_type pt ON p.penal_type_id = pt.penal_type_id LEFT JOIN tbl_users u ON p.user_id = u.user_id WHERE p.sanction_id = ? LIMIT 1");
        if ($olStmt) { $olStmt->bind_param('i', $id); $olStmt->execute(); $oldPenalty = $olStmt->get_result()->fetch_assoc(); $olStmt->close(); }
        
        $sql = "UPDATE tbl_penalties SET " . implode(', ', $fields) . " WHERE sanction_id = ?";
        $stmt = $mysqli->prepare($sql);
        $types .= 'i'; $vals[] = $id;
        $stmt->bind_param($types, ...$vals);
        if (!$stmt->execute()) json_response(['error'=>'update_failed','message'=>$stmt->error], 500);
        
        // Log penalty update
        $logTeacher = $oldPenalty['teacher_name'] ?? 'Unknown';
        $logType = $oldPenalty['type_name'] ?? 'Sanction';
        log_system_action($mysqli, $authUserId, 'update_penalty', "Updated {$logType} details for {$logTeacher}");
        
        try { trigger_socket_update(['entity'=>'penalties','action'=>'update','sanction_id'=>$id]); } catch(Throwable $e){}
        json_response(['ok'=>true]);
        break;
}
?>
