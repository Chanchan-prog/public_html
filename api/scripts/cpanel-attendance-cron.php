<?php
// Single cPanel Cron Jobs entry point for attendance automation.
// Schedule this script once per minute. It runs status transitions on every
// invocation and internally gates five-minute and daily maintenance work.

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    echo "CLI only. Configure this file in cPanel Cron Jobs.\n";
    exit(1);
}

$args = array_slice($argv, 1);
$checkOnly = in_array('--check', $args, true);
$forceFiveMinute = in_array('--force-five-minute', $args, true);

$logDir = __DIR__ . '/../logs';
if (!is_dir($logDir) && !@mkdir($logDir, 0755, true) && !is_dir($logDir)) {
    fwrite(STDERR, "Unable to create cron log directory: {$logDir}\n");
    exit(1);
}

// Keep database, SMTP and Web Push errors in the same file the web entry point
// uses, so a hosting problem can be diagnosed from one place.
@ini_set('log_errors', '1');
@ini_set('error_log', $logDir . '/php-errors.log');
if (PHP_VERSION_ID < 80200) {
    fwrite(STDERR, 'Warning: this cron job is running PHP ' . PHP_VERSION
        . '. PHP 8.2 or newer is required for Web Push and QR features.' . PHP_EOL);
}

$lockPath = $logDir . '/cpanel-attendance-cron.lock';
$statePath = $logDir . '/cpanel-attendance-cron-state.json';
$lockHandle = @fopen($lockPath, 'c+');
if ($lockHandle === false) {
    fwrite(STDERR, "Unable to open cron lock file: {$lockPath}\n");
    exit(1);
}

if (!@flock($lockHandle, LOCK_EX | LOCK_NB)) {
    // A previous invocation is still active. This is expected protection, not
    // a cron failure, so return success without starting another copy.
    echo "Another cPanel attendance cron invocation is still running; skipped.\n";
    fclose($lockHandle);
    exit(0);
}

register_shutdown_function(static function () use (&$lockHandle): void {
    if (is_resource($lockHandle)) {
        @flock($lockHandle, LOCK_UN);
        @fclose($lockHandle);
    }
});

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/cron_worker_lib.php';

$state = cw_cron_state_read($statePath);
$due = cw_cron_due_flags($state, $forceFiveMinute);

if ($checkOnly) {
    echo json_encode([
        'ok' => true,
        'mode' => 'check',
        'php_version' => PHP_VERSION,
        'timezone' => date_default_timezone_get(),
        'database' => 'connected',
        'status_due' => $due['status_due'],
        'academic_sync_due' => $due['academic_sync_due'] || $due['daily_safety_due'],
        'attendance_generation_due' => $due['attendance_generation_due'],
        'daily_safety_due' => $due['daily_safety_due'],
        'lock_file' => $lockPath,
        'state_file' => $statePath,
        'log_file' => cw_log_file(),
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
    @$mysqli->close();
    exit(0);
}

// All scheduling decisions and work live in cron_worker_lib.php so the CLI
// entry point and the token-protected HTTP trigger (api/cron) stay identical.
$result = cw_run_scheduled_tasks($mysqli, $forceFiveMinute);
@$mysqli->close();
exit((int)$result['exit_code']);
