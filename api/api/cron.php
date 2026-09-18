<?php
// api/api/cron.php
//
// Token-protected HTTP trigger for the attendance scheduler.
//
// Use this endpoint when the host cannot run a PHP CLI cron job: Vercel Cron,
// an external cron/ping service, or a cPanel job built with wget/curl. It runs
// exactly the same work as scripts/cpanel-attendance-cron.php.
//
//     https://your-site/api/cron?token=THE_TOKEN
//
// The token comes from CRON_TOKEN or api/config/cron-token.php. Create it with
// `php api/scripts/init-cron-token.php`. A single run cannot overlap itself:
// the CLI script's lock file protects both entry points.

require_once __DIR__ . '/../helpers/cron_token_helper.php';

global $mysqli;

$requestMethod = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
if (!in_array($requestMethod, ['GET', 'POST'], true)) {
    json_response(['ok' => false, 'error' => 'method_not_allowed'], 405);
}

if (!cron_token_is_configured()) {
    json_response([
        'ok' => false,
        'error' => 'cron_token_missing',
        'message' => 'Create the scheduler token first: php api/scripts/init-cron-token.php',
    ], 503);
}

$providedToken = (string)($_GET['token'] ?? ($_SERVER['HTTP_X_CRON_TOKEN'] ?? ''));
if (!cron_token_is_valid($providedToken)) {
    json_response(['ok' => false, 'error' => 'invalid_cron_token'], 403);
}

// The lock file keeps the CLI job and this endpoint from running together.
$lockHandle = @fopen(__DIR__ . '/../logs/cpanel-attendance-cron.lock', 'c+');
if ($lockHandle === false) {
    json_response(['ok' => false, 'error' => 'cron_lock_unavailable'], 500);
}
if (!@flock($lockHandle, LOCK_EX | LOCK_NB)) {
    fclose($lockHandle);
    json_response(['ok' => true, 'skipped' => 'already_running'], 200);
}
register_shutdown_function(static function () use (&$lockHandle): void {
    if (is_resource($lockHandle)) {
        @flock($lockHandle, LOCK_UN);
        @fclose($lockHandle);
    }
});

$forceFiveMinute = in_array(
    strtolower(trim((string)($_GET['force_five_minute'] ?? ''))),
    ['1', 'true', 'yes'],
    true
);

require_once __DIR__ . '/../scripts/cron_worker_lib.php';

$result = cw_run_scheduled_tasks($mysqli, $forceFiveMinute);
$statuses = is_array($result['statuses']) ? $result['statuses'] : [];
$generation = is_array($result['generation']) ? $result['generation'] : [];
$absent = is_array($statuses['absent_notifications'] ?? null) ? $statuses['absent_notifications'] : [];
$pending = is_array($statuses['pending_notifications'] ?? null) ? $statuses['pending_notifications'] : [];
$reminders = is_array($statuses['pending_reminders'] ?? null) ? $statuses['pending_reminders'] : [];

json_response([
    'ok' => (bool)$result['ok'],
    'exit_code' => (int)$result['exit_code'],
    'timezone' => date_default_timezone_get(),
    'due' => $result['due'],
    'generated_rows' => (int)($generation['generated_rows'] ?? 0),
    'on_leave_rows' => (int)($generation['on_leave_rows'] ?? 0),
    'pending_rows' => (int)($statuses['pending_rows'] ?? 0),
    'pending_alert_sent' => (int)($pending['sent'] ?? 0),
    'pending_reminder_sent' => (int)($reminders['sent'] ?? 0),
    'auto_absent_rows' => (int)($statuses['auto_absent_rows'] ?? 0),
    'absent_email_sent' => (int)($absent['sent'] ?? 0),
    'absent_email_failed' => (int)($absent['failed'] ?? 0),
    'state_saved' => (bool)$result['state_saved'],
    'errors' => $result['errors'],
]);