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

$state = [];
if (is_file($statePath)) {
    $decoded = json_decode((string)@file_get_contents($statePath), true);
    if (is_array($decoded)) {
        $state = $decoded;
    }
}

$now = time();
$today = date('Y-m-d', $now);
$currentTime = date('H:i', $now);
$fiveMinuteSeconds = 300;

$lastAcademicAt = (int)($state['last_academic_sync_at'] ?? 0);
$lastGenerationAt = (int)($state['last_attendance_generation_at'] ?? 0);
$lastDailyDate = (string)($state['last_daily_safety_date'] ?? '');

$academicDue = $forceFiveMinute || $lastAcademicAt <= 0 || ($now - $lastAcademicAt) >= $fiveMinuteSeconds;
$generationDue = $forceFiveMinute || $lastGenerationAt <= 0 || ($now - $lastGenerationAt) >= $fiveMinuteSeconds;
$dailyDue = $lastDailyDate !== $today && $currentTime >= '00:05';

if ($checkOnly) {
    echo json_encode([
        'ok' => true,
        'mode' => 'check',
        'timezone' => date_default_timezone_get(),
        'status_due' => true,
        'academic_sync_due' => $academicDue || $dailyDue,
        'attendance_generation_due' => $generationDue,
        'daily_safety_due' => $dailyDue,
        'lock_file' => $lockPath,
        'state_file' => $statePath,
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
    @$mysqli->close();
    exit(0);
}

$exitCode = 0;
$stateChanged = false;
cw_log('[cPanelCron] start');

try {
    // Run this before attendance generation so the correct semester and school
    // year are active. The daily safety pass shares the same idempotent call.
    if ($academicDue || $dailyDue) {
        $academic = cw_daily_academic_update($mysqli);
        if (!$academic['ok']) {
            $exitCode = 1;
            cw_log('[cPanelCron][AcademicStatusSync] failed: ' . implode(' | ', $academic['errors']));
        } else {
            $state['last_academic_sync_at'] = $now;
            if ($dailyDue) {
                $state['last_daily_safety_date'] = $today;
            }
            $stateChanged = true;
            cw_log(
                '[cPanelCron][AcademicStatusSync] success'
                . ' school_year_rows=' . (int)$academic['school_year_rows']
                . ' semester_rows=' . (int)$academic['semester_rows']
                . ' daily_safety=' . ($dailyDue ? 'yes' : 'no')
            );
        }
    }

    if ($generationDue) {
        $generation = cw_generate_attendance_records($mysqli);
        if (!$generation['ok']) {
            $exitCode = 1;
            cw_log('[cPanelCron][AttendanceGeneration] failed: ' . implode(' | ', $generation['errors']));
        } else {
            $state['last_attendance_generation_at'] = $now;
            $stateChanged = true;
            cw_log(
                '[cPanelCron][AttendanceGeneration] success generated_rows=' . (int)$generation['generated_rows']
                . ' on_leave_rows=' . (int)($generation['on_leave_rows'] ?? 0)
            );
        }
    }

    // cPanel invokes this script every minute. Standard shared-hosting cron
    // cannot guarantee the former Windows worker's ten-second interval.
    $statuses = cw_process_attendance_statuses($mysqli);
    if (!$statuses['ok']) {
        $exitCode = 1;
        cw_log('[cPanelCron][AttendanceStatuses] failed: ' . implode(' | ', $statuses['errors']));
    } else {
        $notifications = $statuses['absent_notifications'] ?? ['sent' => 0, 'failed' => 0, 'skipped' => 0];
        $pendingNotifications = $statuses['pending_notifications'] ?? ['sent' => 0, 'failed' => 0, 'skipped' => 0];
        $pendingReminders = $statuses['pending_reminders'] ?? ['sent' => 0, 'failed' => 0, 'skipped' => 0];
        $state['last_attendance_status_at'] = $now;
        $stateChanged = true;
        cw_log(
            '[cPanelCron][AttendanceStatuses] success'
            . ' pending_rows=' . (int)($statuses['pending_rows'] ?? 0)
            . ' pending_alert_sent=' . (int)($pendingNotifications['sent'] ?? 0)
            . ' pending_reminder_sent=' . (int)($pendingReminders['sent'] ?? 0)
            . ' auto_absent_rows=' . (int)($statuses['auto_absent_rows'] ?? 0)
            . ' absent_email_sent=' . (int)($notifications['sent'] ?? 0)
            . ' absent_email_failed=' . (int)($notifications['failed'] ?? 0)
            . ' absent_email_skipped=' . (int)($notifications['skipped'] ?? 0)
        );
    }
} catch (Throwable $e) {
    $exitCode = 1;
    cw_log('[cPanelCron] exception: ' . $e->getMessage());
}

if ($stateChanged) {
    $encodedState = json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if ($encodedState === false || @file_put_contents($statePath, $encodedState . PHP_EOL, LOCK_EX) === false) {
        $exitCode = 1;
        cw_log('[cPanelCron] failed to save scheduler state: ' . $statePath);
    }
}

@$mysqli->close();
cw_log('[cPanelCron] stopped exit_code=' . $exitCode);
exit($exitCode);
