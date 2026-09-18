<?php
// api/api/notification.php
require_once __DIR__ . '/../helpers/notification_helper.php';

global $mysqli, $authPayload;

$request_method = $_SERVER['REQUEST_METHOD'];
$input = get_input();
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$parts = explode('/', $path);
$api_prefix_key = array_search('api', $parts);
$endpoint = $parts[$api_prefix_key + 1] ?? null;
$param1 = $parts[$api_prefix_key + 2] ?? null;

if (!in_array($endpoint, ['notification', 'notifications'], true)) {
    json_response(['error' => 'endpoint_not_found'], 404);
}

if (!notif_table_exists($mysqli)) {
    json_response(['error' => 'notifications_table_missing'], 500);
}

function notif_api_auth_user_id() {
    global $authPayload;
    $auth = is_array($authPayload) ? $authPayload : app_get_authenticated_session(true);
    $authUserId = isset($auth['user_id']) ? (int)$auth['user_id'] : null;
    if (!$authUserId) json_response(['error' => 'invalid_token_payload'], 401);
    return $authUserId;
}

function notif_api_extract_actor_user_id($link) {
    $raw = trim((string)$link);
    if ($raw === '') return null;
    $query = parse_url($raw, PHP_URL_QUERY);
    if (!$query) return null;
    parse_str($query, $q);
    if (!isset($q['actor'])) return null;
    $id = (int)$q['actor'];
    return $id > 0 ? $id : null;
}

function notif_api_strip_actor_from_link($link) {
    $raw = trim((string)$link);
    if ($raw === '') return $raw;
    $parts = parse_url($raw);
    if ($parts === false) return $raw;
    $path = $parts['path'] ?? '';
    $query = [];
    if (!empty($parts['query'])) parse_str($parts['query'], $query);
    unset($query['actor']);
    $new = $path;
    $newQuery = http_build_query($query);
    if ($newQuery !== '') $new .= '?' . $newQuery;
    if (!empty($parts['fragment'])) $new .= '#' . $parts['fragment'];
    return $new !== '' ? $new : $raw;
}

function notif_api_avatar_url($userId, $hasAvatar) {
    if (!$hasAvatar || (int)$userId <= 0) return null;
    $scriptName = str_replace('\\', '/', (string)($_SERVER['SCRIPT_NAME'] ?? '/api/index.php'));
    $apiBasePath = rtrim(str_replace('\\', '/', dirname($scriptName)), '/.');
    if ($apiBasePath === '') $apiBasePath = '/api';
    return $apiBasePath . '/avatar-thumbnail.php?' . http_build_query([
        'user_id' => (int)$userId,
        'size' => 64,
    ], '', '&', PHP_QUERY_RFC3986);
}

function notif_api_bind_dynamic($stmt, $types, &$params) {
    $refs = [];
    $refs[] = &$types;
    foreach ($params as $k => $v) $refs[] = &$params[$k];
    return call_user_func_array([$stmt, 'bind_param'], $refs);
}

function notif_api_enrich_rows($mysqli, array $rows): array {
    $actorIds = [];
    foreach ($rows as $idx => $row) {
        $actorId = notif_api_extract_actor_user_id($row['link'] ?? '');
        $rows[$idx]['actor_user_id'] = $actorId;
        $rows[$idx]['link'] = notif_api_strip_actor_from_link($row['link'] ?? '');
        if ($actorId !== null) $actorIds[$actorId] = true;
    }

    $actorMap = [];
    if (!empty($actorIds)) {
        $ids = array_keys($actorIds);
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $aSql = "SELECT user_id, first_name, last_name,
                    CASE WHEN image IS NULL OR OCTET_LENGTH(image) = 0 THEN 0 ELSE 1 END AS has_avatar
                 FROM tbl_users WHERE user_id IN ($placeholders)";
        $aStmt = $mysqli->prepare($aSql);
        if ($aStmt) {
            $aTypes = str_repeat('i', count($ids));
            $aParams = $ids;
            notif_api_bind_dynamic($aStmt, $aTypes, $aParams);
            if ($aStmt->execute()) {
                $aRes = $aStmt->get_result();
                while ($aRow = $aRes->fetch_assoc()) {
                    $uid = (int)$aRow['user_id'];
                    $fullName = trim((string)($aRow['first_name'] ?? '') . ' ' . (string)($aRow['last_name'] ?? ''));
                    $actorMap[$uid] = [
                        'name' => $fullName !== '' ? $fullName : 'System',
                        'avatar' => notif_api_avatar_url($uid, !empty($aRow['has_avatar'])),
                    ];
                }
            }
            $aStmt->close();
        }
    }

    foreach ($rows as $idx => $row) {
        $actorId = isset($row['actor_user_id']) ? (int)$row['actor_user_id'] : 0;
        if ($actorId > 0 && isset($actorMap[$actorId])) {
            $rows[$idx]['actor_name'] = $actorMap[$actorId]['name'];
            $rows[$idx]['actor_avatar'] = $actorMap[$actorId]['avatar'];
        } else {
            $rows[$idx]['actor_name'] = null;
            $rows[$idx]['actor_avatar'] = null;
        }
    }
    return $rows;
}

function notif_api_ensure_navbar_hidden_column($mysqli) {
    static $hasColumn = null;
    if ($hasColumn !== null) return $hasColumn;

    $check = $mysqli->query("SHOW COLUMNS FROM tbl_notifications LIKE 'navbar_hidden_at'");
    if ($check && $check->num_rows > 0) {
        $hasColumn = true;
        return true;
    }

    try {
        $altered = $mysqli->query("ALTER TABLE tbl_notifications ADD COLUMN navbar_hidden_at DATETIME NULL DEFAULT NULL AFTER is_read");
        $hasColumn = (bool)$altered;
    } catch (Throwable $e) {
        $hasColumn = false;
    }
    return $hasColumn;
}

$authUserId = notif_api_auth_user_id();
$hasNavbarHiddenColumn = notif_api_ensure_navbar_hidden_column($mysqli);

if ($request_method === 'GET' && $param1 === 'push-config') {
    push_schema_ensure($mysqli);
    $config = push_config();
    json_response([
        'enabled' => push_is_configured(),
        'public_key' => push_is_configured() ? (string)($config['public_key'] ?? '') : '',
    ]);
}

if ($request_method === 'POST' && $param1 === 'push-subscription') {
    $subscription = is_array($input['subscription'] ?? null) ? $input['subscription'] : [];
    $userAgent = trim((string)($input['user_agent'] ?? ($_SERVER['HTTP_USER_AGENT'] ?? '')));
    if (!push_is_configured()) {
        json_response(['error' => 'push_not_configured', 'message' => 'Background notifications are not configured.'], 503);
    }
    if (!push_save_subscription($mysqli, $authUserId, $subscription, $userAgent)) {
        json_response(['error' => 'invalid_push_subscription', 'message' => 'The browser push subscription could not be saved.'], 400);
    }
    json_response(['ok' => true, 'message' => 'Background notifications are enabled on this device.']);
}

if ($request_method === 'POST' && $param1 === 'push-subscription-status') {
    $endpointToVerify = trim((string)($input['endpoint'] ?? ''));
    json_response([
        'ok' => true,
        'registered' => push_subscription_is_registered($mysqli, $authUserId, $endpointToVerify),
    ]);
}

if ($request_method === 'POST' && $param1 === 'push-test') {
    $sent = push_send_notification(
        $mysqli,
        $authUserId,
        0,
        'Background notifications are working',
        'This test alert was delivered while your account was subscribed.',
        '/notifications'
    );
    if ($sent <= 0) {
        json_response([
            'ok' => false,
            'error' => 'push_test_failed',
            'message' => 'No subscribed device accepted the test notification.'
        ], 502);
    }
    json_response(['ok' => true, 'delivered' => $sent]);
}

if ($request_method === 'DELETE' && $param1 === 'push-subscription') {
    $endpointToRemove = trim((string)($input['endpoint'] ?? ''));
    $removed = push_remove_subscription($mysqli, $authUserId, $endpointToRemove);
    json_response(['ok' => true, 'removed' => $removed]);
}

if ($request_method === 'GET' && is_numeric($param1)) {
    $notificationId = (int)$param1;
    $selectHiddenColumn = $hasNavbarHiddenColumn ? ', navbar_hidden_at' : '';
    $detailStmt = $mysqli->prepare("SELECT notif_id, user_id, title, message, link, is_read, created_at{$selectHiddenColumn}
        FROM tbl_notifications WHERE notif_id = ? AND user_id = ? LIMIT 1");
    if (!$detailStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $detailStmt->bind_param('ii', $notificationId, $authUserId);
    if (!$detailStmt->execute()) json_response(['error' => 'execute_failed', 'message' => $detailStmt->error], 500);
    $detailRow = $detailStmt->get_result()->fetch_assoc();
    $detailStmt->close();
    if (!$detailRow) json_response(['error' => 'notification_not_found', 'message' => 'Notification not found.'], 404);
    $detailRows = notif_api_enrich_rows($mysqli, [$detailRow]);
    json_response(['notification' => $detailRows[0] ?? null]);
}

if ($request_method === 'GET') {
    $paginate = isset($_GET['paginate']) && (string)$_GET['paginate'] === '1';
    $limit = isset($_GET['limit']) ? (int)$_GET['limit'] : 20;
    if ($limit <= 0) $limit = 20;
    if ($limit > 100) $limit = 100;
    $page = isset($_GET['page']) && is_numeric($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
    $pageSize = isset($_GET['page_size']) && is_numeric($_GET['page_size']) ? (int)$_GET['page_size'] : 10;
    $pageSize = max(1, min(50, $pageSize));
    $onlyUnread = isset($_GET['unread']) && in_array(strtolower((string)$_GET['unread']), ['1', 'true', 'yes'], true);
    $includeHidden = isset($_GET['include_hidden']) && in_array(strtolower((string)$_GET['include_hidden']), ['1', 'true', 'yes'], true);
    $statusFilter = strtolower(trim((string)($_GET['status'] ?? 'all')));
    if (!in_array($statusFilter, ['all', 'unread', 'read'], true)) $statusFilter = 'all';
    $search = trim((string)($_GET['search'] ?? ''));

    $baseConditions = ['n.user_id = ?'];
    $baseTypes = 'i';
    $baseParams = [$authUserId];
    if (!$includeHidden && $hasNavbarHiddenColumn) $baseConditions[] = 'n.navbar_hidden_at IS NULL';

    $conditions = $baseConditions;
    $types = $baseTypes;
    $params = $baseParams;
    if ($paginate) {
        if ($statusFilter === 'unread') $conditions[] = 'n.is_read = 0';
        if ($statusFilter === 'read') $conditions[] = 'n.is_read = 1';
        if ($search !== '') {
            $searchLike = '%' . $search . '%';
            $searchConditions = ['n.title LIKE ?', 'n.message LIKE ?', 'CAST(n.created_at AS CHAR) LIKE ?'];
            $types .= 'sss';
            array_push($params, $searchLike, $searchLike, $searchLike);

            $actorSearchStmt = $mysqli->prepare("SELECT user_id FROM tbl_users WHERE CONCAT_WS(' ', first_name, last_name) LIKE ?");
            if ($actorSearchStmt) {
                $actorSearchStmt->bind_param('s', $searchLike);
                if ($actorSearchStmt->execute()) {
                    $actorSearchResult = $actorSearchStmt->get_result();
                    while ($actorSearchRow = $actorSearchResult->fetch_assoc()) {
                        $actorSearchId = (int)($actorSearchRow['user_id'] ?? 0);
                        if ($actorSearchId <= 0) continue;
                        $searchConditions[] = "(n.link LIKE '%?actor={$actorSearchId}' OR n.link LIKE '%?actor={$actorSearchId}&%' OR n.link LIKE '%&actor={$actorSearchId}' OR n.link LIKE '%&actor={$actorSearchId}&%')";
                    }
                }
                $actorSearchStmt->close();
            }
            $conditions[] = '(' . implode(' OR ', $searchConditions) . ')';
        }
    } elseif ($onlyUnread) {
        $conditions[] = 'n.is_read = 0';
    }

    $baseWhere = ' WHERE ' . implode(' AND ', $baseConditions);
    $where = ' WHERE ' . implode(' AND ', $conditions);
    $selectHiddenColumn = $hasNavbarHiddenColumn ? ', n.navbar_hidden_at' : '';

    $countStmt = $mysqli->prepare("SELECT COUNT(*) AS total,
            SUM(CASE WHEN n.is_read = 0 THEN 1 ELSE 0 END) AS unread,
            SUM(CASE WHEN n.is_read = 1 THEN 1 ELSE 0 END) AS `read`
        FROM tbl_notifications n{$baseWhere}");
    if (!$countStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $countParams = $baseParams;
    notif_api_bind_dynamic($countStmt, $baseTypes, $countParams);
    if (!$countStmt->execute()) json_response(['error' => 'execute_failed', 'message' => $countStmt->error], 500);
    $counts = $countStmt->get_result()->fetch_assoc() ?: [];
    $countStmt->close();

    $filteredTotal = null;
    if ($paginate) {
        $filteredCountStmt = $mysqli->prepare("SELECT COUNT(*) AS total FROM tbl_notifications n{$where}");
        if (!$filteredCountStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        $filteredCountParams = $params;
        notif_api_bind_dynamic($filteredCountStmt, $types, $filteredCountParams);
        if (!$filteredCountStmt->execute()) json_response(['error' => 'execute_failed', 'message' => $filteredCountStmt->error], 500);
        $filteredTotal = (int)($filteredCountStmt->get_result()->fetch_assoc()['total'] ?? 0);
        $filteredCountStmt->close();
        $totalPages = max(1, (int)ceil($filteredTotal / $pageSize));
        $page = min($page, $totalPages);
        $offset = ($page - 1) * $pageSize;
    }

    $sql = "SELECT n.notif_id, n.user_id, n.title, n.message, n.link, n.is_read, n.created_at{$selectHiddenColumn}
        FROM tbl_notifications n{$where} ORDER BY n.created_at DESC, n.notif_id DESC LIMIT ?";
    $queryTypes = $types . 'i';
    $queryParams = $params;
    $queryParams[] = $paginate ? $pageSize : $limit;
    if ($paginate) {
        $sql .= ' OFFSET ?';
        $queryTypes .= 'i';
        $queryParams[] = $offset;
    }
    $stmt = $mysqli->prepare($sql);
    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    notif_api_bind_dynamic($stmt, $queryTypes, $queryParams);
    if (!$stmt->execute()) json_response(['error' => 'execute_failed', 'message' => $stmt->error], 500);
    $rows = notif_api_enrich_rows($mysqli, $stmt->get_result()->fetch_all(MYSQLI_ASSOC));
    $stmt->close();

    $response = [
        'notifications' => $rows ?: [],
        'unread_count' => (int)($counts['unread'] ?? 0),
        'counts' => [
            'total' => (int)($counts['total'] ?? 0),
            'unread' => (int)($counts['unread'] ?? 0),
            'read' => (int)($counts['read'] ?? 0),
        ],
    ];
    if ($paginate) {
        $response['pagination'] = [
            'page' => $page,
            'page_size' => $pageSize,
            'total' => (int)$filteredTotal,
            'total_pages' => $totalPages,
        ];
    }
    json_response($response);
}

if ($request_method === 'PUT' || $request_method === 'POST') {
    if ($param1 === 'read-all') {
        $stmt = $mysqli->prepare("UPDATE tbl_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0");
        if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        $stmt->bind_param('i', $authUserId);
        if (!$stmt->execute()) json_response(['error' => 'update_failed', 'message' => $stmt->error], 500);
        json_response(['ok' => true, 'updated' => (int)$stmt->affected_rows]);
    }

    if (!is_numeric($param1)) {
        json_response(['error' => 'missing_notif_id'], 400);
    }
    $notifId = (int)$param1;
    if ($notifId <= 0) json_response(['error' => 'invalid_notif_id'], 400);

    $stmt = $mysqli->prepare("UPDATE tbl_notifications SET is_read = 1 WHERE notif_id = ? AND user_id = ?");
    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $stmt->bind_param('ii', $notifId, $authUserId);
    if (!$stmt->execute()) json_response(['error' => 'update_failed', 'message' => $stmt->error], 500);

    $sel = $mysqli->prepare("SELECT notif_id, user_id, title, message, link, is_read, created_at FROM tbl_notifications WHERE notif_id = ? AND user_id = ? LIMIT 1");
    $row = null;
    if ($sel) {
        $sel->bind_param('ii', $notifId, $authUserId);
        if ($sel->execute()) {
            $row = $sel->get_result()->fetch_assoc();
        }
        $sel->close();
    }

    json_response(['ok' => true, 'notification' => $row]);
}

if ($request_method === 'DELETE') {
    if ($param1 === 'clear-read') {
        if ($hasNavbarHiddenColumn) {
            $stmt = $mysqli->prepare("UPDATE tbl_notifications SET navbar_hidden_at = COALESCE(navbar_hidden_at, NOW()) WHERE user_id = ? AND is_read = 1");
        } else {
            $stmt = $mysqli->prepare("UPDATE tbl_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 1");
        }
        if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        $stmt->bind_param('i', $authUserId);
        if (!$stmt->execute()) json_response(['error' => 'hide_failed', 'message' => $stmt->error], 500);
        json_response(['ok' => true, 'hidden' => (int)$stmt->affected_rows, 'preserved' => true]);
    }

    if ($param1 === 'clear-all') {
        if ($hasNavbarHiddenColumn) {
            $stmt = $mysqli->prepare("UPDATE tbl_notifications SET is_read = 1, navbar_hidden_at = COALESCE(navbar_hidden_at, NOW()) WHERE user_id = ?");
        } else {
            $stmt = $mysqli->prepare("UPDATE tbl_notifications SET is_read = 1 WHERE user_id = ?");
        }
        if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        $stmt->bind_param('i', $authUserId);
        if (!$stmt->execute()) json_response(['error' => 'hide_failed', 'message' => $stmt->error], 500);
        json_response(['ok' => true, 'hidden' => (int)$stmt->affected_rows, 'preserved' => true]);
    }

    json_response(['error' => 'invalid_delete_action'], 400);
}

json_response(['error' => 'method_not_allowed'], 405);
