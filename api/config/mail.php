<?php
// api/config/mail.php
// Email delivery settings.
//
// XAMPP/Windows has no local mail transport, so OTP and notification emails are
// sent over SMTP when smtp_user + smtp_pass are filled in.
//
// Hosting that blocks outbound SMTP ports (25/465/587) still works with
// transport "mail", and with "auto" the application tries SMTP first and then
// the server's own mail transport (cPanel Exim), which sends from your domain.
//
// Every value below can also come from the environment, which keeps real
// credentials out of source control: MAIL_TRANSPORT, MAIL_SMTP_HOST,
// MAIL_SMTP_PORT, MAIL_SMTP_SECURE, MAIL_SMTP_USER, MAIL_SMTP_PASS,
// MAIL_FROM_EMAIL, MAIL_FROM_NAME and MAIL_FROM.
//
// Credentials must be supplied through environment variables on the deployed
// host. Do not put a mailbox password in this file: a source deployment or
// backup can expose it and Gmail will reject or revoke the app password.
//
// Gmail App Password: Google Account -> Security -> 2-Step Verification -> App passwords.
//
// No Composer or PHPMailer is required.
return [
    // smtp = SMTP only, mail = local server transport, auto = SMTP then local.
    'transport'   => getenv('MAIL_TRANSPORT') ?: 'auto',
    'smtp_host'   => getenv('MAIL_SMTP_HOST')   ?: 'smtp.gmail.com',
    'smtp_port'   => (int) (getenv('MAIL_SMTP_PORT')   ?: 587),
    'smtp_secure' => getenv('MAIL_SMTP_SECURE') ?: 'tls',
    'smtp_user'   => getenv('MAIL_SMTP_USER')   ?: '',
    'smtp_pass'   => getenv('MAIL_SMTP_PASS')   ?: '',
    'from_email'  => getenv('MAIL_FROM_EMAIL')  ?: '',
    'from_name'   => getenv('MAIL_FROM_NAME')  ?: 'Teacher Attendance',
];
