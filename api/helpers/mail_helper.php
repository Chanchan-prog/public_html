<?php
// api/helpers/mail_helper.php
// Sends OTP email via SMTP (pure PHP, no Composer/PHPMailer needed).

/**
 * Validate that an email string is exactly one deliverable recipient.
 */
function mail_helper_is_single_recipient($email) {
    $recipient = trim((string)$email);
    if ($recipient === '') return false;
    if (preg_match('/[\r\n,;]/', $recipient)) return false;
    return (bool)filter_var($recipient, FILTER_VALIDATE_EMAIL);
}

function mail_helper_log_once($key, $message) {
    static $logged = [];
    if (isset($logged[$key])) return;
    $logged[$key] = true;
    error_log($message);
}

/** Load api/config/mail.php once per request. */
function mail_helper_config() {
    static $config = null;
    if ($config !== null) return $config;
    $path = __DIR__ . '/../config/mail.php';
    $loaded = is_file($path) ? require $path : [];
    $config = is_array($loaded) ? $loaded : [];
    return $config;
}

function mail_helper_smtp_ready($mailConfig) {
    if (!is_array($mailConfig)) return false;
    return !empty($mailConfig['smtp_host'])
        && !empty($mailConfig['smtp_user'])
        && (string)($mailConfig['smtp_pass'] ?? '') !== '';
}

/**
 * Resolve the delivery transport: "smtp", "mail" (local server transport) or
 * "auto". Shared hosting that blocks outbound SMTP still delivers through the
 * local transport while the value is "auto", which is the default.
 */
function mail_helper_transport($mailConfig) {
    $configured = function_exists('getenv') ? (string)getenv('MAIL_TRANSPORT') : '';
    if (trim($configured) === '' && is_array($mailConfig)) {
        $configured = (string)($mailConfig['transport'] ?? '');
    }
    $transport = strtolower(trim($configured));
    return in_array($transport, ['smtp', 'mail'], true) ? $transport : 'auto';
}

function mail_helper_from_address($fromFallback, $mailConfig) {
    if (is_array($mailConfig)) {
        if (!empty($mailConfig['from_email'])) return (string)$mailConfig['from_email'];
        if (!empty($mailConfig['smtp_user'])) return (string)$mailConfig['smtp_user'];
    }
    $fallback = trim((string)$fromFallback);
    return $fallback !== '' ? $fallback : 'noreply@localhost';
}

/**
 * Deliver HTML through the web server's own mail transport (cPanel Exim or the
 * configured sendmail binary) instead of an outbound SMTP connection.
 */
function mail_helper_send_via_php_mail($to, $from, $subject, $htmlBody) {
    $headers = [
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        'From: ' . $from,
        'X-Mailer: PHP/' . PHP_VERSION,
    ];
    return @mail($to, $subject, $htmlBody, implode("\r\n", $headers));
}

/**
 * Whether this message should use SMTP. "mail" is an explicit instruction to
 * use the hosting provider's local MTA directly; it must not first wait for an
 * outbound SMTP connection that shared hosting often blocks.
 */
function mail_helper_should_use_smtp($mailConfig) {
    return mail_helper_transport($mailConfig) !== 'mail'
        && mail_helper_smtp_ready($mailConfig);
}

function mail_helper_deliver($to, $from, $subject, $htmlBody, $mailConfig = null) {
    if (mail_helper_should_use_smtp($mailConfig)) {
        return send_via_smtp_socket($to, $from, $subject, $htmlBody, $mailConfig);
    }

    $localFrom = mail_helper_from_address($from, $mailConfig);
    $sent = mail_helper_send_via_php_mail($to, $localFrom, $subject, $htmlBody);
    if (!$sent) error_log('[mail_helper] local mail transport rejected a message for ' . trim((string)$to));
    return $sent;
}

/**
 * Send forgot-password OTP email.
 * Uses SMTP when configured in config/mail.php (smtp_user + smtp_pass), else PHP mail().
 *
 * @param string $to Recipient email
 * @param string $firstName User first name
 * @param string $lastName User last name
 * @param string $otp 6-digit OTP
 * @return bool True if mail was accepted for delivery
 */
function send_forgot_password_email($to, $firstName, $lastName, $otp) {
    if (!mail_helper_is_single_recipient($to)) {
        error_log('[mail_helper] Refusing forgot-password email: invalid single recipient');
        return false;
    }

    $templatePath = __DIR__ . '/../templates/forgot_password_email.php';
    if (!is_file($templatePath)) {
        error_log('[mail_helper] Template not found: ' . $templatePath);
        return false;
    }
    ob_start();
    include $templatePath;
    $htmlBody = ob_get_clean();
    if ($htmlBody === false || $htmlBody === '') {
        return false;
    }

    $subject = 'Forget Password !!!';
    $from = 'noreply@' . ($_SERVER['SERVER_NAME'] ?? 'localhost');
    if (is_file(__DIR__ . '/../config/security.php')) {
        $sec = require __DIR__ . '/../config/security.php';
        if (!empty($sec['mail_from'])) $from = $sec['mail_from'];
    }
    if (function_exists('getenv') && getenv('MAIL_FROM')) {
        $from = getenv('MAIL_FROM');
    }

    $mailConfigPath = __DIR__ . '/../config/mail.php';
    if (is_file($mailConfigPath)) {
        $mailConfig = require $mailConfigPath;
        return mail_helper_deliver($to, $from, $subject, $htmlBody, $mailConfig);
    }

    $headers = [
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        'From: ' . $from,
        'X-Mailer: PHP/' . PHP_VERSION,
    ];
    return @mail($to, $subject, $htmlBody, implode("\r\n", $headers));
}

/**
 * Send account-created email to newly created users.
 *
 * @param string $to Recipient email
 * @param string $firstName User first name
 * @param string $lastName User last name
 * @param string $username Login username display (e.g., "ID or email")
 * @return bool True if mail was accepted for delivery
 */
function send_new_account_email($to, $firstName, $lastName, $username) {
    if (!mail_helper_is_single_recipient($to)) {
        error_log('[mail_helper] Refusing new-account email: invalid single recipient');
        return false;
    }

    $templatePath = __DIR__ . '/../templates/new_account_email.php';
    if (!is_file($templatePath)) {
        error_log('[mail_helper] Template not found: ' . $templatePath);
        return false;
    }
    ob_start();
    include $templatePath;
    $htmlBody = ob_get_clean();
    if ($htmlBody === false || $htmlBody === '') {
        return false;
    }

    $subject = 'Account Successfully Created';
    $from = 'noreply@' . ($_SERVER['SERVER_NAME'] ?? 'localhost');
    if (is_file(__DIR__ . '/../config/security.php')) {
        $sec = require __DIR__ . '/../config/security.php';
        if (!empty($sec['mail_from'])) $from = $sec['mail_from'];
    }
    if (function_exists('getenv') && getenv('MAIL_FROM')) {
        $from = getenv('MAIL_FROM');
    }

    $mailConfigPath = __DIR__ . '/../config/mail.php';
    if (is_file($mailConfigPath)) {
        $mailConfig = require $mailConfigPath;
        return mail_helper_deliver($to, $from, $subject, $htmlBody, $mailConfig);
    }

    $headers = [
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        'From: ' . $from,
        'X-Mailer: PHP/' . PHP_VERSION,
    ];
    return @mail($to, $subject, $htmlBody, implode("\r\n", $headers));
}

function send_temporary_password_email($to, $firstName, $lastName, $temporaryPassword, $expiresMinutes = 15) {
    if (!mail_helper_is_single_recipient($to)) return false;
    $name = trim((string)$firstName . ' ' . (string)$lastName) ?: 'User';
    $safeName = htmlspecialchars($name, ENT_QUOTES, 'UTF-8');
    $safePassword = htmlspecialchars((string)$temporaryPassword, ENT_QUOTES, 'UTF-8');
    $minutes = max(1, (int)$expiresMinutes);
    $htmlBody = "<div style=\"font-family:Arial,sans-serif;line-height:1.6;color:#172033\"><h2>Temporary password</h2><p>Hello {$safeName},</p><p>An administrator requested a password reset for your account.</p><div style=\"padding:14px;background:#eef8f2;border:1px solid #b7e0c9;border-radius:8px;font-size:20px;font-weight:700;letter-spacing:1px\">{$safePassword}</div><p>This password expires in {$minutes} minutes and must be replaced immediately after sign-in.</p><p>If you did not expect this reset, contact your administrator.</p></div>";
    $subject = 'Your temporary account password';
    $from = 'noreply@' . ($_SERVER['SERVER_NAME'] ?? 'localhost');
    $mailConfigPath = __DIR__ . '/../config/mail.php';
    if (is_file($mailConfigPath)) {
        $mailConfig = require $mailConfigPath;
        return mail_helper_deliver($to, $from, $subject, $htmlBody, $mailConfig);
    }
    return @mail($to, $subject, $htmlBody, "MIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\nFrom: {$from}");
}

function send_school_id_password_reset_email($to, $firstName, $lastName) {
    if (!mail_helper_is_single_recipient($to)) return false;
    $name = trim((string)$firstName . ' ' . (string)$lastName) ?: 'User';
    $safeName = htmlspecialchars($name, ENT_QUOTES, 'UTF-8');
    $htmlBody = "<div style=\"font-family:Arial,sans-serif;line-height:1.6;color:#172033\"><h2>Account password reset</h2><p>Hello {$safeName},</p><p>An administrator reset your account password.</p><div style=\"padding:14px;background:#eef8f2;border:1px solid #b7e0c9;border-radius:8px;font-weight:700\">Use your registered School ID as your temporary password.</div><p>You will be required to create a new secure password immediately after signing in.</p><p>If you did not expect this reset, contact your administrator.</p></div>";
    $subject = 'Your account password was reset';
    $from = 'noreply@' . ($_SERVER['SERVER_NAME'] ?? 'localhost');
    $mailConfigPath = __DIR__ . '/../config/mail.php';
    if (is_file($mailConfigPath)) {
        $mailConfig = require $mailConfigPath;
        return mail_helper_deliver($to, $from, $subject, $htmlBody, $mailConfig);
    }
    return @mail($to, $subject, $htmlBody, "MIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\nFrom: {$from}");
}

/**
 * Send a personal system notification email.
 *
 * The recipient must already be resolved from the triggering user's own profile.
 */
function send_personal_notification_email($to, $firstName, $notificationType, $briefDescription, $eventDetails, $eventDateTime = null) {
    if (!mail_helper_is_single_recipient($to)) {
        error_log('[mail_helper] Refusing personal notification email: invalid single recipient');
        return false;
    }

    $recipient = trim((string)$to);
    $name = trim((string)$firstName);
    if ($name === '') $name = 'there';

    $type = strtoupper(trim((string)$notificationType));
    if ($type === '') $type = 'GENERAL';

    $brief = trim((string)$briefDescription);
    if ($brief === '') $brief = 'Account notification';

    $details = trim((string)$eventDetails);
    if ($details === '') $details = 'A system update was recorded for your account.';

    try {
        if ($eventDateTime instanceof DateTimeInterface) {
            $dt = DateTime::createFromFormat('U', (string)$eventDateTime->getTimestamp());
            if ($dt instanceof DateTime) $dt->setTimezone(new DateTimeZone(date_default_timezone_get()));
        } elseif (is_string($eventDateTime) && trim($eventDateTime) !== '') {
            $dt = new DateTime($eventDateTime);
        } else {
            $dt = new DateTime();
        }
    } catch (Throwable $_) {
        $dt = new DateTime();
    }
    if (!isset($dt) || !($dt instanceof DateTimeInterface)) {
        $dt = new DateTime();
    }

    $subject = '[' . $type . '] ' . $brief . ' · ' . $dt->format('Y-m-d');
    $plainBody =
        "Hi {$name},\n\n" .
        "This is a personal notification for your account.\n\n" .
        "Event     : {$type}\n" .
        "Details   : {$details}\n" .
        "Date/Time : " . $dt->format('Y-m-d  h:i A') . "\n\n" .
        "If you did not expect this message, please contact\n" .
        "your administrator.";

    $htmlBody = '<pre style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.55; white-space: pre-wrap;">'
        . htmlspecialchars($plainBody, ENT_QUOTES, 'UTF-8')
        . '</pre>';

    $from = 'noreply@' . ($_SERVER['SERVER_NAME'] ?? 'localhost');
    if (is_file(__DIR__ . '/../config/security.php')) {
        $sec = require __DIR__ . '/../config/security.php';
        if (!empty($sec['mail_from'])) $from = $sec['mail_from'];
    }
    if (function_exists('getenv') && getenv('MAIL_FROM')) {
        $from = getenv('MAIL_FROM');
    }

    $mailConfigPath = __DIR__ . '/../config/mail.php';
    if (is_file($mailConfigPath)) {
        $mailConfig = require $mailConfigPath;
        return mail_helper_deliver($recipient, $from, $subject, $htmlBody, $mailConfig);
    }

    $headers = [
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        'From: ' . $from,
        'X-Mailer: PHP/' . PHP_VERSION,
    ];
    return @mail($recipient, $subject, $htmlBody, implode("\r\n", $headers));
}

/**
 * Deliver one message over SMTP using only PHP sockets (no PHPMailer).
 *
 * Shared hosting commonly blocks outbound SMTP ports. When the SMTP attempt
 * fails, the message is retried through the server's local mail transport
 * unless MAIL_TRANSPORT is explicitly set to "smtp".
 * Gmail uses smtp.gmail.com:587 (STARTTLS); port 465 uses implicit TLS.
 */
/**
 * Deliver one message over SMTP, then fall back to the local mail transport.
 *
 * The fallback keeps daily notifications working on hosting that blocks
 * outbound SMTP. Set MAIL_TRANSPORT=smtp to disable it.
 */
function send_via_smtp_socket($to, $fromFallback, $subject, $htmlBody, $mailConfig) {
    if (mail_helper_smtp_deliver($to, $fromFallback, $subject, $htmlBody, $mailConfig)) return true;
    if (mail_helper_transport($mailConfig) === 'smtp') return false;

    error_log('[mail_helper] SMTP delivery failed; retrying through the local mail transport.');
    $localFrom = mail_helper_from_address($fromFallback, $mailConfig);
    $localSent = mail_helper_send_via_php_mail($to, $localFrom, $subject, $htmlBody);
    if (!$localSent) {
        error_log('[mail_helper] local mail transport also rejected a message for ' . $to);
    }
    return $localSent;
}

function mail_helper_smtp_deliver($to, $fromFallback, $subject, $htmlBody, $mailConfig) {
    if (!mail_helper_is_single_recipient($to)) {
        error_log('[mail_helper] SMTP send refused: invalid single recipient');
        return false;
    }
    $to = trim((string)$to);

    $host = $mailConfig['smtp_host'];
    $port = (int)($mailConfig['smtp_port'] ?? 587);
    $user = $mailConfig['smtp_user'];
    $pass = (string)$mailConfig['smtp_pass'];
    $secure = (isset($mailConfig['smtp_secure']) && strtolower((string)$mailConfig['smtp_secure']) === 'ssl') || $port === 465;
    $fromEmail = !empty($mailConfig['from_email']) ? $mailConfig['from_email'] : (!empty($mailConfig['smtp_user']) ? $mailConfig['smtp_user'] : $fromFallback);
    $fromName = $mailConfig['from_name'] ?? 'Teacher Attendance';

    $fromHeader = $fromName ? "=?UTF-8?B?" . base64_encode($fromName) . "?= <$fromEmail>" : "<$fromEmail>";
    $subjectEnc = "=?UTF-8?B?" . base64_encode($subject) . "?=";
    $message = "Date: " . date('r') . "\r\n"
        . "From: $fromHeader\r\n"
        . "To: <$to>\r\n"
        . "Subject: $subjectEnc\r\n"
        . "MIME-Version: 1.0\r\n"
        . "Content-Type: text/html; charset=UTF-8\r\n"
        . "Content-Transfer-Encoding: base64\r\n"
        . "\r\n"
        . chunk_split(base64_encode($htmlBody));

    $errNo = 0;
    $errStr = '';
    $context = stream_context_create();
    $sock = @stream_socket_client(
        ($secure ? 'ssl://' : 'tcp://') . $host . ':' . $port,
        $errNo,
        $errStr,
        15,
        STREAM_CLIENT_CONNECT,
        $context
    );
    if (!$sock) {
        if (function_exists('error_log')) {
            error_log("[mail_helper] SMTP connect failed: $errStr ($errNo)");
        }
        return false;
    }

    $getLine = function () use ($sock) {
        $line = @fgets($sock);
        return $line !== false ? trim($line) : false;
    };
    $send = function ($cmd) use ($sock) {
        return @fwrite($sock, $cmd . "\r\n") !== false;
    };
    // Read until a line starting with code (handles multi-line SMTP replies)
    $expect = function ($code) use ($getLine, $sock) {
        $code = (string)$code;
        do {
            $line = $getLine();
            if ($line === false) return false;
        } while (strlen($line) >= 4 && $line[3] === '-' && strpos($line, $code) === 0);
        return strpos($line, $code) === 0;
    };

    if (!$expect(220)) { @fclose($sock); return false; }
    if (!$send("EHLO " . ($_SERVER['SERVER_NAME'] ?? 'localhost'))) { @fclose($sock); return false; }
    if (!$expect(250)) { @fclose($sock); return false; }

    if ($port === 587 && !$secure) {
        if (!$send("STARTTLS")) { @fclose($sock); return false; }
        if (!$expect(220)) { @fclose($sock); return false; }
        $crypto = @stream_socket_enable_crypto($sock, true, STREAM_CRYPTO_METHOD_TLS_CLIENT);
        if (!$crypto) {
            if (function_exists('error_log')) error_log('[mail_helper] STARTTLS failed');
            @fclose($sock);
            return false;
        }
        if (!$send("EHLO " . ($_SERVER['SERVER_NAME'] ?? 'localhost'))) { @fclose($sock); return false; }
        if (!$expect(250)) { @fclose($sock); return false; }
    }

    if (!$send("AUTH LOGIN")) { @fclose($sock); return false; }
    if (!$expect(334)) { @fclose($sock); return false; }
    if (!$send(base64_encode($user))) { @fclose($sock); return false; }
    if (!$expect(334)) { @fclose($sock); return false; }
    if (!$send(base64_encode($pass))) { @fclose($sock); return false; }
    if (!$expect(235)) {
        if (function_exists('error_log')) error_log('[mail_helper] SMTP auth failed (check Gmail App Password)');
        @fclose($sock);
        return false;
    }

    if (!$send("MAIL FROM:<" . $fromEmail . ">")) { @fclose($sock); return false; }
    if (!$expect(250)) { @fclose($sock); return false; }
    if (!$send("RCPT TO:<" . $to . ">")) { @fclose($sock); return false; }
    if (!$expect(250)) { @fclose($sock); return false; }
    if (!$send("DATA")) { @fclose($sock); return false; }
    if (!$expect(354)) { @fclose($sock); return false; }
    if (!@fwrite($sock, $message . "\r\n.\r\n")) { @fclose($sock); return false; }
    if (!$expect(250)) {
        if (function_exists('error_log')) error_log('[mail_helper] SMTP DATA rejected');
        @fclose($sock);
        return false;
    }
    $send("QUIT");
    @fclose($sock);
    return true;
}
