<?php
// api/config/security.php
$privateSettings = is_file(__DIR__ . '/private-security.php') ? require __DIR__ . '/private-security.php' : [];
$security = [
    'reset_secret' => getenv('APP_RESET_SECRET') ?: ($privateSettings['reset_secret'] ?? ''),
    // Production hosts are redirected to HTTPS automatically. Localhost stays
    // available over HTTP for XAMPP development. Set APP_FORCE_HTTPS=0 only for
    // a temporary non-production environment that cannot provide HTTPS.
    'force_https' => getenv('APP_FORCE_HTTPS') !== '0',
    'hsts_max_age_seconds' => 31536000,

    // Keep the location-based attendance workflow available while denying
    // camera and microphone access, which this application does not require.
    'permissions_policy' => 'geolocation=(self), camera=(), microphone=()',

    'error_log' => __DIR__ . '/../logs/php-errors.log',

    // Forgot-password email "From" address (optional). Set for better deliverability to Gmail.
    'mail_from' => getenv('MAIL_FROM') ?: null,

    // Private values are generated per deployment, never bundled in source.
    'web_push' => [
        'subject' => getenv('VAPID_SUBJECT') ?: 'mailto:admin@school.local',
        'public_key' => getenv('VAPID_PUBLIC_KEY') ?: ($privateSettings['vapid_public_key'] ?? ''),
        'private_key' => getenv('VAPID_PRIVATE_KEY') ?: ($privateSettings['vapid_private_key'] ?? ''),
    ],

    // Helper: normalize an Origin header to scheme://host[:port] for reliable comparisons
    'normalize_origin' => function ($origin) {
        if (empty($origin)) return '';
        $parts = parse_url(trim($origin));
        if (!$parts || empty($parts['scheme']) || empty($parts['host'])) return '';
        $base = $parts['scheme'] . '://' . $parts['host'];
        if (!empty($parts['port'])) $base .= ':' . $parts['port'];
        return $base;
    },
];

$logDir = __DIR__ . '/../logs';
if (!is_dir($logDir)) @mkdir($logDir, 0755, true);

return $security;
