<?php
// api/api/reset-password.php — verify OTP and set new password
require_once __DIR__ . '/../helpers/log_helper.php';
require_once __DIR__ . '/../helpers/security_policy_helper.php';
require_once __DIR__ . '/../helpers/password_reset_helper.php';
global $mysqli;
security_schema_ensure($mysqli);

$request_method = $_SERVER['REQUEST_METHOD'];
$input = get_input();

if ($request_method !== 'POST') {
    json_response(['error' => 'method_not_allowed'], 405);
}

$email = isset($input['email']) ? trim((string) $input['email']) : '';
$otp = isset($input['otp']) ? trim((string) $input['otp']) : '';
$newPassword = $input['new_password'] ?? '';

if ($email === '' || $otp === '') {
    json_response(['error' => 'Missing email or OTP'], 400);
}

reset_schema($mysqli);
reset_enforce_limit($mysqli, 'verify_ip', (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown'), 60, 900);

// Strong password policy (matches UI):
// - At least 8 characters
// - At least 1 letter (A–Z or a–z)
// - At least 1 digit (0–9)
// - At least 1 special character (non-alphanumeric)
$passwordError = security_policy_validate_password($newPassword, security_policy_get($mysqli));
if ($passwordError) json_response(['error'=>$passwordError],400);

// A valid OTP must always belong to an actual system account. The normal
// forgot-password flow never creates OTPs for unknown emails, and this check
// also protects against manually inserted, stale, or corrupted OTP rows.
$userStmt = $mysqli->prepare("SELECT user_id, first_name, last_name, email, status, password_hash FROM tbl_users WHERE email = ? LIMIT 1");
if (!$userStmt) {
    json_response(['error' => 'Unable to validate reset account'], 500);
}
if (containsUnsafeHtmlInput($newPassword)) {
    json_response(['error' => 'HTML or script content is not allowed in the password.'], 400);
}
$userStmt->bind_param("s", $email);
$userStmt->execute();
$uRow = $userStmt->get_result()->fetch_assoc();
$userStmt->close();
if (!$uRow || !app_user_status_is_active($uRow['status'] ?? null)) {
    json_response(['error' => 'Invalid or expired OTP'], 400);
}
$email = (string)$uRow['email'];
reset_enforce_limit($mysqli, 'verify_account', $email, 30, 900);

// User info for audit logging was validated before OTP verification.
$userIdForLog = (int)$uRow['user_id'];
$userNameForLog = trim(($uRow['first_name'] ?? '') . ' ' . ($uRow['last_name'] ?? ''));

$passwordHash = password_hash($newPassword, PASSWORD_BCRYPT);
$firstLoginColCheck = $mysqli->query("SHOW COLUMNS FROM tbl_users LIKE 'is_first_login'");
$hasFirstLoginCol = $firstLoginColCheck && $firstLoginColCheck->num_rows > 0;
$passwordReuseError = false;
try {
    $result = reset_consume_code($mysqli, $email, $otp, function () use ($mysqli, $hasFirstLoginCol, $passwordHash, $email, $newPassword, $uRow) {
        $userId = (int)$uRow['user_id'];
        $currentHash = (string)($uRow['password_hash'] ?? '');
        if (security_password_was_used($mysqli, $userId, $newPassword, $currentHash)) {
            throw new RuntimeException('password_reused');
        }
        if (!security_password_remember_hash($mysqli, $userId, $currentHash)) {
            throw new RuntimeException('password_history_failed');
        }
        $firstLoginSql = $hasFirstLoginCol ? ', is_first_login = 0' : '';
        $up = $mysqli->prepare("UPDATE tbl_users SET password_hash = ?, password_changed_at = NOW(), token_version = token_version + 1, temporary_password_expires_at = NULL{$firstLoginSql} WHERE email = ?");
        if (!$up) throw new RuntimeException('password_update_failed');
        $up->bind_param('ss', $passwordHash, $email);
        $up->execute();
        if ($up->affected_rows !== 1) throw new RuntimeException('password_update_failed');
        $up->close();
    });
} catch (RuntimeException $error) {
    if ($error->getMessage() === 'password_reused') {
        $passwordReuseError = true;
    } else {
        throw $error;
    }
}
if ($passwordReuseError) {
    json_response(['error'=>'password_reused','message'=>'Choose a password you have not used previously.'], 400);
}
if (!$result['ok']) json_response(['error'=>'invalid_reset_code'] + $result, 400);

// Log the password reset completion
$logName = $userNameForLog ?: $email;
log_system_action($mysqli, $userIdForLog ?: 0, 'complete_password_reset', "Password successfully reset for {$logName}");

json_response(['message' => 'Password has been reset. You can sign in with your new password.'], 200);
