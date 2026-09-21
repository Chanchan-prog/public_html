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
    $candidateNames = [];
    $candidateNames[] = $environmentName;
    $candidateNames[] = strtoupper($environmentName);
    $candidateNames[] = strtolower($environmentName);

    $legacyName = str_replace('MAIL_', 'MAILER_', $environmentName);
    if ($legacyName !== $environmentName) {
        $candidateNames[] = $legacyName;
        $candidateNames[] = strtoupper($legacyName);
        $candidateNames[] = strtolower($legacyName);
    }

    $resendLegacyName = str_replace('RESEND_', 'MAILER_RESEND_', $environmentName);
    if ($resendLegacyName !== $environmentName) {
        $candidateNames[] = $resendLegacyName;
        $candidateNames[] = strtoupper($resendLegacyName);
        $candidateNames[] = strtolower($resendLegacyName);
    }

    $seenNames = [];
    foreach ($candidateNames as $candidate) {
        if ($candidate === '' || isset($seenNames[strtolower($candidate)])) continue;
        $seenNames[strtolower($candidate)] = true;

        $value = getenv($candidate);
        if ($value !== false) return $value;
        if (isset($_ENV[$candidate]) && $_ENV[$candidate] !== '') return $_ENV[$candidate];
        if (isset($_SERVER[$candidate]) && $_SERVER[$candidate] !== '') return $_SERVER[$candidate];
    }

    if (array_key_exists($privateKey, $mailPrivate)) return $mailPrivate[$privateKey];
    return $default;
};

$smtpSecure = strtolower(trim((string)$mailValue('MAIL_SMTP_SECURE', 'smtp_secure', 'tls')));
if (!in_array($smtpSecure, ['tls', 'ssl', 'none'], true)) $smtpSecure = 'tls';

// `auto` keeps the existing hosted-friendly preference for Resend. Set
// MAIL_TRANSPORT=smtp on Railway when this application should send through
// Gmail (or another SMTP relay) even if an old RESEND_API_KEY is still set.
$mailTransport = strtolower(trim((string)$mailValue('MAIL_TRANSPORT', 'transport', 'auto')));
if (!in_array($mailTransport, ['auto', 'resend', 'smtp'], true)) $mailTransport = 'auto';
$resendEnabled = $mailTransport !== 'smtp';

return [
    // HTTPS email delivery works on hosted environments where SMTP outbound is
    // blocked or unreliable. Prefer Resend when configured, then fall back to
    // SMTP and finally PHP mail().
    'transport' => $mailTransport,
    'resend_api_key' => $resendEnabled ? trim((string)$mailValue('RESEND_API_KEY', 'resend_api_key', '')) : '',
    'resend_from_email' => $resendEnabled ? trim((string)$mailValue('RESEND_FROM_EMAIL', 'resend_from_email', '')) : '',
    'resend_from_name' => trim((string)$mailValue('RESEND_FROM_NAME', 'resend_from_name', 'Teacher Attendance')),
    'smtp_host' => trim((string)$mailValue('MAIL_SMTP_HOST', 'smtp_host', '')),
    'smtp_port' => (int)$mailValue('MAIL_SMTP_PORT', 'smtp_port', 587),
    'smtp_secure' => $smtpSecure,
    'smtp_user' => trim((string)$mailValue('MAIL_SMTP_USER', 'smtp_user', '')),
    'smtp_pass' => (string)$mailValue('MAIL_SMTP_PASS', 'smtp_pass', ''),
    'from_email' => trim((string)$mailValue('MAIL_FROM_EMAIL', 'from_email', '')),
    'from_name' => trim((string)$mailValue('MAIL_FROM_NAME', 'from_name', 'Teacher Attendance')),
    'timeout' => max(1, min(60, (int)$mailValue('MAIL_SMTP_TIMEOUT', 'timeout', 15))),
];
