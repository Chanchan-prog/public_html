<?php
require_once __DIR__ . '/../helpers/push_notification_helper.php';

global $mysqli, $authPayload;

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    json_response(['error' => 'method_not_allowed'], 405);
}

$auth = is_array($authPayload) ? $authPayload : app_get_authenticated_session(true);
$userId = (int)($auth['user_id'] ?? 0);
$sessionId = trim((string)($auth['sid'] ?? ''));
$input = get_input();
$pushEndpoint = is_array($input) ? trim((string)($input['push_endpoint'] ?? '')) : '';

// Detach only this browser's endpoint. The browser subscription itself is
// preserved so a later login can rebind it without asking for permission again.
if ($userId > 0 && $pushEndpoint !== '') {
    push_remove_subscription($mysqli, $userId, $pushEndpoint);
}

if ($userId > 0 && $sessionId !== '') {
    $stmt = $mysqli->prepare('UPDATE tbl_user_sessions SET revoked_at = NOW() WHERE session_id = ? AND user_id = ? AND revoked_at IS NULL');
    if ($stmt) {
        $stmt->bind_param('si', $sessionId, $userId);
        $stmt->execute();
        $stmt->close();
    }
}

app_clear_session_cookies();

json_response(['ok' => true]);
