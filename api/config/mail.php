<?php
// api/config/mail.php
// Configure SMTP so OTP emails are sent. On XAMPP/Windows, PHP mail() does not send real email.
//
// No Composer needed. Fill in smtp_user and smtp_pass (Gmail App Password) and OTP emails will send via SMTP.
// Gmail App Password: Google Account → Security → 2-Step Verification → App passwords.
// Never place a real SMTP password in this tracked file. cPanel PHP processes
// may not inherit website environment variables, so a server-only
// private-mail.php file is supported too. See private-mail.php.example.
$mailPrivateFile = __DIR__ . '/private-mail.php';
$mailPrivate = is_file($mailPrivateFile) ? require $mailPrivateFile : [];
if (!is_array($mailPrivate)) $mailPrivate = [];

$mailValue = static function (string $environmentName, string $privateKey, $default = '') use ($mailPrivate) {
    $environmentValue = getenv($environmentName);
    if ($environmentValue !== false) return $environmentValue;
    if (array_key_exists($privateKey, $mailPrivate)) return $mailPrivate[$privateKey];
    return $default;
};

$smtpSecure = strtolower(trim((string)$mailValue('MAIL_SMTP_SECURE', 'smtp_secure', 'tls')));
if (!in_array($smtpSecure, ['tls', 'ssl', 'none'], true)) $smtpSecure = 'tls';

return [
    // HTTPS email delivery works on all Railway plans. When configured, it is
    // preferred to SMTP because Railway disables outbound SMTP on Trial/Hobby.
    'resend_api_key' => trim((string)getenv('RESEND_API_KEY')),
    'resend_from_email' => trim((string)getenv('RESEND_FROM_EMAIL')),
    'resend_from_name' => trim((string)(getenv('RESEND_FROM_NAME') ?: 'Teacher Attendance')),
    'smtp_host' => trim((string)$mailValue('MAIL_SMTP_HOST', 'smtp_host', '')),
    'smtp_port' => (int)$mailValue('MAIL_SMTP_PORT', 'smtp_port', 587),
    'smtp_secure' => $smtpSecure,
    'smtp_user' => trim((string)$mailValue('MAIL_SMTP_USER', 'smtp_user', '')),
    'smtp_pass' => (string)$mailValue('MAIL_SMTP_PASS', 'smtp_pass', ''),
    'from_email' => trim((string)$mailValue('MAIL_FROM_EMAIL', 'from_email', '')),
    'from_name' => trim((string)$mailValue('MAIL_FROM_NAME', 'from_name', 'Teacher Attendance')),
    'timeout' => max(1, min(60, (int)$mailValue('MAIL_SMTP_TIMEOUT', 'timeout', 15))),
];
