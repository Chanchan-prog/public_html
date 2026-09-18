<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../helpers/log_helper.php';

$backupSql = "CREATE TABLE IF NOT EXISTS tbl_log_text_migration_backup (
    backup_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    source_table VARCHAR(64) NOT NULL,
    source_id BIGINT NOT NULL,
    source_column VARCHAR(64) NOT NULL,
    original_text LONGTEXT NULL,
    migrated_text LONGTEXT NULL,
    migrated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_log_text_source (source_table, source_id, source_column)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

if (!$mysqli->query($backupSql)) {
    fwrite(STDERR, "Unable to create migration backup table: {$mysqli->error}\n");
    exit(1);
}

$technicalPattern = '/attendance_id\s*=|schedule_id\s*=|class_schedule_edit|(?:attendance|schedule) edit request\s*#\d+|room\s+\d+|Archived school year ID|Updated dates for Semester ID|\(ID\s*\d+\)|Deleted offering ID|user ID|Department Admin scope for department\s+\d+|Deleted schedule ID/i';
$systemUpdated = 0;
$attendanceUpdated = 0;

$backup = $mysqli->prepare("INSERT IGNORE INTO tbl_log_text_migration_backup
    (source_table, source_id, source_column, original_text, migrated_text)
    VALUES (?, ?, ?, ?, ?)");
$updateSystem = $mysqli->prepare('UPDATE tbl_system_logs SET details = ? WHERE log_id = ?');
$updateAttendance = $mysqli->prepare('UPDATE tbl_attendance_logs SET reason = ? WHERE log_id = ?');

if (!$backup || !$updateSystem || !$updateAttendance) {
    fwrite(STDERR, "Unable to prepare migration statements: {$mysqli->error}\n");
    exit(1);
}

$mysqli->begin_transaction();
try {
    $result = $mysqli->query('SELECT log_id, action, details FROM tbl_system_logs ORDER BY log_id');
    if (!$result) throw new RuntimeException($mysqli->error);
    while ($row = $result->fetch_assoc()) {
        $original = (string)($row['details'] ?? '');
        if ($original === '' || !preg_match($technicalPattern, $original)) continue;
        $migrated = log_professionalize_details($mysqli, $row['action'] ?? '', $original);
        if ($migrated === $original) continue;

        $sourceTable = 'tbl_system_logs';
        $sourceId = (int)$row['log_id'];
        $sourceColumn = 'details';
        $backup->bind_param('sisss', $sourceTable, $sourceId, $sourceColumn, $original, $migrated);
        if (!$backup->execute()) throw new RuntimeException($backup->error);
        $updateSystem->bind_param('si', $migrated, $sourceId);
        if (!$updateSystem->execute()) throw new RuntimeException($updateSystem->error);
        $systemUpdated += $updateSystem->affected_rows;
    }

    $result = $mysqli->query("SELECT log_id, reason FROM tbl_attendance_logs
        WHERE reason REGEXP 'attendance edit request #[0-9]+'
        ORDER BY log_id");
    if (!$result) throw new RuntimeException($mysqli->error);
    while ($row = $result->fetch_assoc()) {
        $original = trim((string)($row['reason'] ?? ''));
        if ($original === '') continue;
        if (preg_match('/^Approved via attendance edit request\s*#\d+\s*:\s*(.+)$/i', $original, $match)) {
            $migrated = 'Approved attendance correction. Request reason: ' . trim($match[1]);
        } else {
            $migrated = preg_replace(
                '/Approved via attendance edit request\s*#\d+/i',
                'Approved attendance correction',
                $original
            );
        }
        $migrated = rtrim(trim((string)$migrated), '.') . '.';
        if ($migrated === $original) continue;

        $sourceTable = 'tbl_attendance_logs';
        $sourceId = (int)$row['log_id'];
        $sourceColumn = 'reason';
        $backup->bind_param('sisss', $sourceTable, $sourceId, $sourceColumn, $original, $migrated);
        if (!$backup->execute()) throw new RuntimeException($backup->error);
        $updateAttendance->bind_param('si', $migrated, $sourceId);
        if (!$updateAttendance->execute()) throw new RuntimeException($updateAttendance->error);
        $attendanceUpdated += $updateAttendance->affected_rows;
    }

    $mysqli->commit();
} catch (Throwable $error) {
    $mysqli->rollback();
    fwrite(STDERR, "Log migration rolled back: {$error->getMessage()}\n");
    exit(1);
} finally {
    $backup->close();
    $updateSystem->close();
    $updateAttendance->close();
}

echo "System log details updated: {$systemUpdated}\n";
echo "Attendance log reasons updated: {$attendanceUpdated}\n";
echo "Original values backed up in tbl_log_text_migration_backup.\n";
