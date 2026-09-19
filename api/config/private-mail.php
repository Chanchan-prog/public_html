<?php
// Server-only SMTP credentials (local test copy "d"). Keeps the Gmail App
// Password out of any tracked file. mail.php reads this file first.
return [
    'smtp_host'   => 'smtp.gmail.com',
    'smtp_port'   => 587,
    'smtp_secure' => 'tls',             // tls (STARTTLS 587), ssl (implicit 465), or none
    'smtp_user'   => 'jessarose123321@gmail.com',
    'smtp_pass'   => 'hsrhvjwbkbfsbtnl', // 16-char Gmail App Password
    'from_email'  => 'jessarose123321@gmail.com',
    'from_name'   => 'Teacher Attendance',
    'timeout'     => 15,
];