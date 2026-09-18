<?php
// api/api/first-login-password.php
global $mysqli;
require_once __DIR__ . '/../helpers/security_policy_helper.php';
security_schema_ensure($mysqli);

$request_method = $_SERVER['REQUEST_METHOD'];
$input = get_input();

if ($request_method !== 'POST') {
    json_response(['ok' => false, 'error' => 'method_not_allowed'], 405);
}

$auth = app_get_authenticated_session(true);
$userId = isset($auth['user_id']) ? (int)$auth['user_id'] : 0;
if ($userId <= 0) {
    json_response(['ok' => false, 'error' => 'missing_authorization'], 401);
}

$newPassword = $input['new_password'] ?? '';
$confirmPassword = $input['confirm_password'] ?? '';

if (containsUnsafeHtmlInput($newPassword) || containsUnsafeHtmlInput($confirmPassword)) {
    json_response(['ok' => false, 'error' => 'unsafe_html_input', 'message' => 'HTML or script content is not allowed in password fields.'], 400);
}

if (!is_string($newPassword) || !is_string($confirmPassword)) {
    json_response(['ok' => false, 'error' => 'invalid_password'], 400);
}

if ($newPassword !== $confirmPassword) {
    json_response(['ok' => false, 'error' => 'password_mismatch', 'message' => 'Passwords do not match.'], 400);
}

$firstLoginColCheck = $mysqli->query("SHOW COLUMNS FROM tbl_users LIKE 'is_first_login'");
$hasFirstLoginCol = $firstLoginColCheck && $firstLoginColCheck->num_rows > 0;

$stmt = $mysqli->prepare("SELECT user_id, role_id, dept_id, first_name, last_name, email, id_number, password_hash, token_version FROM tbl_users WHERE user_id = ? LIMIT 1");
if (!$stmt) {
    json_response(['ok' => false, 'error' => 'db_prepare_failed', 'details' => $mysqli->error], 500);
}
$stmt->bind_param('i', $userId);
$stmt->execute();
$user = $stmt->get_result()->fetch_assoc();
$stmt->close();

if (!$user) {
    json_response(['ok' => false, 'error' => 'user_not_found'], 404);
}

$passwordError = security_policy_validate_password($newPassword, security_policy_get($mysqli));
if ($passwordError) json_response(['ok'=>false,'error'=>'weak_password','message'=>$passwordError],400);

if (security_password_was_used($mysqli, $userId, $newPassword, $user['password_hash'] ?? null)) {
    json_response([
        'ok' => false,
        'error' => 'password_reused',
        'message' => 'Choose a password you have not used previously.'
    ], 400);
}

$passwordHash = password_hash($newPassword, PASSWORD_BCRYPT);
$newVersion=(int)($user['token_version']??0)+1;
$mysqli->begin_transaction();
try {
    if (!security_password_remember_hash($mysqli, $userId, $user['password_hash'] ?? '')) {
        throw new RuntimeException('Unable to preserve password history.');
    }
    if ($hasFirstLoginCol) {
        $up = $mysqli->prepare("UPDATE tbl_users SET password_hash = ?, is_first_login = 0, password_changed_at = NOW(), temporary_password_expires_at = NULL, token_version = token_version + 1 WHERE user_id = ?");
    } else {
        $up = $mysqli->prepare("UPDATE tbl_users SET password_hash = ?, password_changed_at = NOW() WHERE user_id = ?");
    }
    if (!$up) throw new RuntimeException('Unable to prepare the password update.');
    $up->bind_param('si', $passwordHash, $userId);
    if (!$up->execute()) throw new RuntimeException('Unable to update the password.');
    $up->close();

    $revoke = $mysqli->prepare('UPDATE tbl_user_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL');
    if (!$revoke) throw new RuntimeException('Unable to revoke prior sessions.');
    $revoke->bind_param('i', $userId);
    if (!$revoke->execute()) throw new RuntimeException('Unable to revoke prior sessions.');
    $revoke->close();
    $mysqli->commit();
} catch (Throwable $error) {
    $mysqli->rollback();
    json_response(['ok' => false, 'error' => 'password_update_failed', 'message' => 'The password could not be changed safely. Please try again.'], 500);
}
$sessionMeta = app_create_database_session($mysqli, $userId, $newVersion, security_policy_get($mysqli));

json_response([
    'ok' => true,
    'message' => 'password_changed',
    'is_first_login' => 0,
    'password_change_reason' => null,
    'password_expires_at' => security_password_expires_at(date('Y-m-d H:i:s'), security_policy_get($mysqli)),
    'session' => [
        'idle_timeout_seconds' => $sessionMeta['idle_timeout_seconds'],
        'absolute_expires_at' => $sessionMeta['absolute_expires_at'],
        'absolute_expires_at_unix' => $sessionMeta['absolute_expires_at_unix'],
    ],
], 200);
