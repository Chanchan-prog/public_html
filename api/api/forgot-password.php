<?php
// api/api/forgot-password.php — request OTP and send email
require_once __DIR__ . '/../helpers/mail_helper.php';
require_once __DIR__ . '/../helpers/log_helper.php';
require_once __DIR__ . '/../helpers/password_reset_helper.php';
global $mysqli;

$request_method = $_SERVER['REQUEST_METHOD'];
$input = get_input();

if ($request_method !== 'POST') {
    json_response(['error' => 'method_not_allowed'], 405);
}

$email = isset($input['email']) ? trim((string) $input['email']) : '';
if ($email === '') {
    json_response(['error' => 'Missing email'], 400);
}

reset_schema($mysqli);
// REMOTE_ADDR is server-provided. Do not trust client-supplied forwarded headers.
$clientIp = (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown');
reset_enforce_limit($mysqli, 'send_ip', $clientIp, 10, 900);

$stmt = $mysqli->prepare("SELECT user_id, first_name, last_name, email, status FROM tbl_users WHERE email = ? LIMIT 1");
$stmt->bind_param("s", $email);
$stmt->execute();
$user = $stmt->get_result()->fetch_assoc();
$stmt->close();
$email = $user ? (string)$user['email'] : strtolower($email);
reset_enforce_limit($mysqli, 'send_account', $email, 1, 30);

// Always return the same message so the reset flow does not reveal whether
// an email address is registered in the system.
$genericSuccess = ['retry_after' => 30, 'message' => 'If this email is registered, you will receive a one-time password shortly. The code expires in 2 minutes.'];

if (!$user || !app_user_status_is_active($user['status'] ?? null)) {
    json_response($genericSuccess, 200);
}

$otp = (string) random_int(100000, 999999);
reset_store_code($mysqli, $email, $otp);

$sent = send_forgot_password_email(
    $user['email'],
    $user['first_name'] ?? '',
    $user['last_name'] ?? '',
    $otp
);

// Log the password reset request
log_system_action($mysqli, (int)$user['user_id'], 'request_password_reset', "Password reset OTP requested for account {$user['email']}");

// Return the same public response in every environment; OTPs go by email only.
$response = $genericSuccess;

// If sending failed, log a clear message for debugging.
if (!$sent && function_exists('error_log')) {
    error_log('[forgot-password] Failed to send OTP email to ' . $email);
}

json_response($response, 200);
