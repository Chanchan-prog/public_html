<?php
// api/api/login-monitor.php
global $mysqli, $authPayload;
require_once __DIR__ . '/../helpers/log_helper.php';
require_once __DIR__ . '/../helpers/security_policy_helper.php';

$request_method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// Ensure the auth payload is loaded
if (!isset($authPayload) || !is_array($authPayload)) {
    json_response(['error' => 'unauthorized', 'message' => 'Authentication required.'], 401);
}

$authRoleId = isset($authPayload['role_id']) ? (int)$authPayload['role_id'] : 0;

// Only admin can view login monitoring
if ($authRoleId !== 1) {
    json_response(['error' => 'forbidden', 'message' => 'Only admin can access login monitoring.'], 403);
}

if ($request_method === 'GET') {
    $pageSize = 10;
    $detailsPage = max(1, (int)($_GET['details_page'] ?? 1));
    $historyPage = max(1, (int)($_GET['history_page'] ?? 1));
    $lockedOnly = !empty($_GET['locked_only']);
    $searchQuery = trim((string)($_GET['q'] ?? ''));
    if (strlen($searchQuery) > 120) $searchQuery = substr($searchQuery, 0, 120);

    // Ensure history table exists
    $mysqli->query("CREATE TABLE IF NOT EXISTS `tbl_login_attempts` (
        `attempt_id` INT(11) NOT NULL AUTO_INCREMENT,
        `email` VARCHAR(255) NOT NULL,
        `user_id` INT(11) NULL DEFAULT NULL,
        `attempt_time` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        `status` ENUM('success', 'failed') NOT NULL DEFAULT 'failed',
        `ip_address` VARCHAR(45) NULL DEFAULT NULL,
        `details` VARCHAR(255) NULL DEFAULT NULL,
        PRIMARY KEY (`attempt_id`),
        KEY `email` (`email`),
        KEY `user_id` (`user_id`),
        KEY `attempt_time` (`attempt_time`),
        KEY `status` (`status`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    // Get login lock stats
    $totalLocked = 0;
    $totalFailed = 0;

    $lockResult = $mysqli->query("SELECT COUNT(*) AS cnt FROM tbl_login_locks l LEFT JOIN tbl_users u ON l.email = u.email WHERE l.lock_until IS NOT NULL AND l.lock_until > NOW() AND (u.user_id IS NULL OR LOWER(TRIM(COALESCE(u.status, ''))) NOT IN ('archive', 'archived'))");
    if ($lockResult) {
        $totalLocked = (int)$lockResult->fetch_assoc()['cnt'];
    }

    $failedResult = $mysqli->query("SELECT COUNT(*) AS total FROM tbl_login_attempts a LEFT JOIN tbl_users u ON a.user_id = u.user_id WHERE a.status='failed' AND a.attempt_time >= DATE_SUB(NOW(), INTERVAL 24 HOUR) AND (u.user_id IS NULL OR LOWER(TRIM(COALESCE(u.status, ''))) NOT IN ('archive', 'archived'))");
    if ($failedResult) {
        $totalFailed = (int)$failedResult->fetch_assoc()['total'];
    }

    $accountResult = $mysqli->query("SELECT COUNT(DISTINCT a.email) AS total FROM tbl_login_attempts a LEFT JOIN tbl_users u ON a.user_id = u.user_id WHERE a.status='failed' AND a.attempt_time >= DATE_SUB(NOW(), INTERVAL 24 HOUR) AND (u.user_id IS NULL OR LOWER(TRIM(COALESCE(u.status, ''))) NOT IN ('archive', 'archived'))");
    $accounts24 = $accountResult ? (int)$accountResult->fetch_assoc()['total'] : 0;
    if (!empty($_GET['summary_only'])) {
        json_response([
            'total_locked' => $totalLocked,
            'total_failed_attempts' => $totalFailed,
            'total_accounts_with_attempts' => $accounts24,
            'policy' => security_policy_get($mysqli),
        ]);
    }

    // Paginate lock records on the server so the browser receives only the
    // ten rows visible in this table.
    $detailConditions = ["(u.user_id IS NULL OR LOWER(TRIM(COALESCE(u.status, ''))) NOT IN ('archive', 'archived'))"];
    if ($lockedOnly) {
        $detailConditions[] = 'l.lock_until IS NOT NULL AND l.lock_until > NOW()';
    }
    $searchLike = '%' . $searchQuery . '%';
    if ($searchQuery !== '') {
        $detailConditions[] = "(l.email LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ? OR r.role_name LIKE ?)";
    }
    $detailWhere = $detailConditions ? (' WHERE ' . implode(' AND ', $detailConditions)) : '';
    $detailCountSql = "SELECT COUNT(*) AS total FROM tbl_login_locks l LEFT JOIN tbl_users u ON l.email = u.email LEFT JOIN tbl_roles r ON u.role_id = r.role_id{$detailWhere}";
    $detailCountStmt = $mysqli->prepare($detailCountSql);
    if (!$detailCountStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    if ($searchQuery !== '') $detailCountStmt->bind_param('ssss', $searchLike, $searchLike, $searchLike, $searchLike);
    $detailCountStmt->execute();
    $detailsTotal = (int)($detailCountStmt->get_result()->fetch_assoc()['total'] ?? 0);
    $detailCountStmt->close();
    $detailsTotalPages = max(1, (int)ceil($detailsTotal / $pageSize));
    $detailsPage = min($detailsPage, $detailsTotalPages);
    $detailsOffset = ($detailsPage - 1) * $pageSize;

    $details = [];
    $detailStmt = $mysqli->prepare("
        SELECT 
            l.id,
            l.email,
            l.failed_attempts,
            l.lock_until,
            u.user_id,
            u.first_name,
            u.last_name,
            u.role_id,
            r.role_name
        FROM tbl_login_locks l
        LEFT JOIN tbl_users u ON l.email = u.email
        LEFT JOIN tbl_roles r ON u.role_id = r.role_id
        {$detailWhere}
        ORDER BY l.id DESC
        LIMIT {$pageSize} OFFSET {$detailsOffset}
    ");
    if (!$detailStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    if ($searchQuery !== '') $detailStmt->bind_param('ssss', $searchLike, $searchLike, $searchLike, $searchLike);
    $detailStmt->execute();
    $detailResult = $detailStmt->get_result();
    if ($detailResult) {
        while ($row = $detailResult->fetch_assoc()) {
            $row['is_locked'] = ($row['lock_until'] !== null && strtotime($row['lock_until']) > time());
            $details[] = $row;
        }
    }
    $detailStmt->close();

    // Login history has independent server-side pagination.
    $historyCountResult = $mysqli->query("SELECT COUNT(*) AS total FROM tbl_login_attempts a LEFT JOIN tbl_users u ON a.user_id = u.user_id WHERE u.user_id IS NULL OR LOWER(TRIM(COALESCE(u.status, ''))) NOT IN ('archive', 'archived')");
    $historyTotal = $historyCountResult ? (int)($historyCountResult->fetch_assoc()['total'] ?? 0) : 0;
    $historyTotalPages = max(1, (int)ceil($historyTotal / $pageSize));
    $historyPage = min($historyPage, $historyTotalPages);
    $historyOffset = ($historyPage - 1) * $pageSize;
    $history = [];
    $histResult = $mysqli->query("
        SELECT 
            a.attempt_id,
            a.email,
            a.attempt_time,
            a.status,
            a.ip_address,
            a.details,
            u.user_id,
            u.first_name,
            u.last_name,
            r.role_name
        FROM tbl_login_attempts a
        LEFT JOIN tbl_users u ON a.user_id = u.user_id
        LEFT JOIN tbl_roles r ON u.role_id = r.role_id
        WHERE u.user_id IS NULL OR LOWER(TRIM(COALESCE(u.status, ''))) NOT IN ('archive', 'archived')
        ORDER BY a.attempt_time DESC
        LIMIT {$pageSize} OFFSET {$historyOffset}
    ");
    if ($histResult) {
        $history = $histResult->fetch_all(MYSQLI_ASSOC);
        foreach ($history as &$historyRow) {
            $historyRow['ip_address'] = format_ip_address_for_display($historyRow['ip_address'] ?? '');
        }
        unset($historyRow);
    }

    json_response([
        'total_locked' => $totalLocked,
        'total_failed_attempts' => $totalFailed,
        'total_accounts_with_attempts' => $accounts24,
        'policy' => security_policy_get($mysqli),
        'details' => $details,
        'history' => $history,
        'details_pagination' => [
            'page' => $detailsPage,
            'page_size' => $pageSize,
            'total' => $detailsTotal,
            'total_pages' => $detailsTotalPages,
        ],
        'history_pagination' => [
            'page' => $historyPage,
            'page_size' => $pageSize,
            'total' => $historyTotal,
            'total_pages' => $historyTotalPages,
        ],
    ]);
}

if ($request_method === 'DELETE') {
    $input = get_input();
    $lockId = isset($input['id']) ? (int)$input['id'] : 0;
    $reason = trim(strip_tags((string)($input['reason'] ?? '')));

    if ($lockId <= 0) {
        json_response(['error' => 'validation', 'message' => 'Invalid lock ID.'], 400);
    }
    if ($reason === '') json_response(['error'=>'validation','message'=>'Unlock reason is required.'],400);
    if (strlen($reason)>255) json_response(['error'=>'validation','message'=>'Unlock reason must be 255 characters or fewer.'],400);

    $targetStmt=$mysqli->prepare('SELECT email FROM tbl_login_locks WHERE id=? LIMIT 1');
    $targetStmt->bind_param('i',$lockId);$targetStmt->execute();$target=$targetStmt->get_result()->fetch_assoc();$targetStmt->close();
    if (!$target) json_response(['error'=>'not_found','message'=>'Lock record not found.'],404);

    $stmt = $mysqli->prepare("DELETE FROM tbl_login_locks WHERE id = ?");
    if (!$stmt) {
        json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    }
    $stmt->bind_param('i', $lockId);
    if (!$stmt->execute()) {
        json_response(['error' => 'delete_failed', 'message' => $stmt->error], 500);
    }
    log_system_action($mysqli,(int)($authPayload['user_id']??0),'unlock_login_account',"Unlocked account {$target['email']}. Reason: {$reason}");

    json_response(['ok' => true, 'message' => 'Login lock record cleared.']);
}

json_response(['error' => 'method_not_allowed'], 405);
