<?php
declare(strict_types=1);

/**
 * Secret token for the HTTP scheduler trigger (api/cron).
 *
 * Hosting that cannot run a PHP CLI cron job - for example Vercel Cron or an
 * external cron/ping service - triggers the same attendance work by calling
 *
 *     https://your-site/api/cron?token=THE_TOKEN
 *
 * The token is read from the CRON_TOKEN environment variable or from
 * api/config/cron-token.php, which scripts/init-cron-token.php creates. The
 * config directory is blocked from HTTP access by api/.htaccess.
 */

function cron_token_config_path(): string {
    return __DIR__ . '/../config/cron-token.php';
}

function cron_token_get(): string {
    $fromEnv = function_exists('getenv') ? trim((string)getenv('CRON_TOKEN')) : '';
    if ($fromEnv !== '') return $fromEnv;

    $path = cron_token_config_path();
    if (!is_file($path)) return '';
    $loaded = require $path;
    if (!is_array($loaded)) return '';
    return trim((string)($loaded['token'] ?? ''));
}

function cron_token_is_configured(): bool {
    return strlen(cron_token_get()) >= 32;
}

function cron_token_is_valid($candidate): bool {
    $expected = cron_token_get();
    $provided = trim((string)$candidate);
    if (strlen($expected) < 32) return false;
    if ($provided === '' || strlen($provided) > 200) return false;
    return hash_equals($expected, $provided);
}