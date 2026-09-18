<?php
// api/api/archive.php
// Data Archiving API - Access, Export, and Manage Archived Records
require_once __DIR__ . '/../helpers/log_helper.php';
global $mysqli, $authPayload;

$authUserId = isset($authPayload['user_id']) ? (int)$authPayload['user_id'] : null;
$authRoleId = isset($authPayload['role_id']) ? (int)$authPayload['role_id'] : null;

if (!$authUserId) json_response(['error' => 'unauthorized'], 401);

// Only admin, dean, program_head, secretary can access archives (role_id 1,2,3,4,6)
if (!in_array($authRoleId, [1, 2, 3, 4, 6], true)) {
    json_response(['error' => 'forbidden', 'message' => 'Access denied.'], 403);
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = $_GET['action'] ?? 'list';

// Ensure archive tables exist
$mysqli->query("CREATE TABLE IF NOT EXISTS `tbl_attendance_archive` (
    `archive_id` INT(11) NOT NULL AUTO_INCREMENT,
    `original_attendance_id` INT(11) DEFAULT NULL,
    `user_id` INT(11) NOT NULL,
    `room_id` INT(11) DEFAULT NULL,
    `schedule_id` INT(11) DEFAULT NULL,
    `date` DATE DEFAULT NULL,
    `time_in` TIME DEFAULT NULL,
    `time_out` TIME DEFAULT NULL,
    `status` VARCHAR(50) DEFAULT NULL,
    `archived_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `archived_by` INT(11) DEFAULT NULL,
    `archive_reason` VARCHAR(255) DEFAULT NULL,
    `original_data` JSON DEFAULT NULL,
    PRIMARY KEY (`archive_id`),
    KEY `user_id` (`user_id`),
    KEY `archived_at` (`archived_at`),
    KEY `date` (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

$mysqli->query("CREATE TABLE IF NOT EXISTS `tbl_archive_exports` (
    `export_id` INT(11) NOT NULL AUTO_INCREMENT,
    `user_id` INT(11) NOT NULL,
    `export_type` VARCHAR(50) NOT NULL,
    `date_from` DATE DEFAULT NULL,
    `date_to` DATE DEFAULT NULL,
    `filter_criteria` JSON DEFAULT NULL,
    `file_name` VARCHAR(255) DEFAULT NULL,
    `file_size` BIGINT DEFAULT 0,
    `record_count` INT DEFAULT 0,
    `exported_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`export_id`),
    KEY `user_id` (`user_id`),
    KEY `exported_at` (`exported_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

if ($method === 'GET') {
    if ($action === 'list') {
        // List archived attendance records
        $page = max(1, (int)($_GET['page'] ?? 1));
        $limit = min(100, max(10, (int)($_GET['limit'] ?? 50)));
        $offset = ($page - 1) * $limit;
        $search = trim((string)($_GET['search'] ?? ''));
        $date_from = $_GET['date_from'] ?? '';
        $date_to = $_GET['date_to'] ?? '';

        $where = [];
        $params = [];
        $types = '';

        // Role-based scoping
        if ($authRoleId !== 1) {
            $where[] = 'a.user_id IN (SELECT user_id FROM tbl_users WHERE dept_id = (SELECT dept_id FROM tbl_users WHERE user_id = ?))';
            $params[] = $authUserId;
            $types .= 'i';
        }

        if ($search) {
            $where[] = '(a.archive_reason LIKE ? OR a.status LIKE ?)';
            $searchTerm = '%' . $search . '%';
            $params[] = $searchTerm;
            $params[] = $searchTerm;
            $types .= 'ss';
        }
        if ($date_from) {
            $where[] = 'a.archived_at >= ?';
            $params[] = $date_from . ' 00:00:00';
            $types .= 's';
        }
        if ($date_to) {
            $where[] = 'a.archived_at <= ?';
            $params[] = $date_to . ' 23:59:59';
            $types .= 's';
        }

        $whereClause = $where ? 'WHERE ' . implode(' AND ', $where) : '';

        // Count total
        $countSql = "SELECT COUNT(*) as total FROM tbl_attendance_archive a {$whereClause}";
        $countStmt = $mysqli->prepare($countSql);
        if ($countStmt) {
            if ($params) $countStmt->bind_param($types, ...$params);
            $countStmt->execute();
            $total = (int)$countStmt->get_result()->fetch_assoc()['total'];
            $countStmt->close();
        } else {
            $total = 0;
        }

        // Fetch records
        $sql = "SELECT a.*, 
                CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,'')) as user_name,
                r.room_name,
                (SELECT CONCAT(COALESCE(ab.first_name,''),' ',COALESCE(ab.last_name,'')) FROM tbl_users ab WHERE ab.user_id = a.archived_by) as archived_by_name
                FROM tbl_attendance_archive a
                LEFT JOIN tbl_users u ON a.user_id = u.user_id
                LEFT JOIN tbl_rooms r ON a.room_id = r.room_id
                {$whereClause}
                ORDER BY a.archived_at DESC
                LIMIT ? OFFSET ?";
        
        $stmt = $mysqli->prepare($sql);
        if (!$stmt) json_response(['error' => 'db_error', 'message' => $mysqli->error], 500);

        if ($params) {
            $types .= 'ii';
            $params[] = $limit;
            $params[] = $offset;
            $stmt->bind_param($types, ...$params);
        } else {
            $stmt->bind_param('ii', $limit, $offset);
        }
        $stmt->execute();
        $result = $stmt->get_result();
        $rows = [];
        while ($row = $result->fetch_assoc()) {
            $rows[] = $row;
        }
        $stmt->close();

        json_response([
            'rows' => $rows,
            'total' => $total,
            'page' => $page,
            'limit' => $limit,
            'total_pages' => ceil($total / $limit)
        ]);
    } elseif ($action === 'export') {
        // Export archived data as CSV
        $date_from = $_GET['date_from'] ?? date('Y-m-d', strtotime('-30 days'));
        $date_to = $_GET['date_to'] ?? date('Y-m-d');
        $format = $_GET['format'] ?? 'csv';

        $where = ['a.archived_at >= ?', 'a.archived_at <= ?'];
        $params = [$date_from . ' 00:00:00', $date_to . ' 23:59:59'];
        $types = 'ss';

        if ($authRoleId !== 1) {
            $where[] = 'a.user_id IN (SELECT user_id FROM tbl_users WHERE dept_id = (SELECT dept_id FROM tbl_users WHERE user_id = ?))';
            $params[] = $authUserId;
            $types .= 'i';
        }

        $whereClause = 'WHERE ' . implode(' AND ', $where);
        $sql = "SELECT a.*, 
                CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,'')) as user_name,
                r.room_name
                FROM tbl_attendance_archive a
                LEFT JOIN tbl_users u ON a.user_id = u.user_id
                LEFT JOIN tbl_rooms r ON a.room_id = r.room_id
                {$whereClause}
                ORDER BY a.archived_at DESC";

        $stmt = $mysqli->prepare($sql);
        if (!$stmt) json_response(['error' => 'db_error'], 500);
        $stmt->bind_param($types, ...$params);
        $stmt->execute();
        $result = $stmt->get_result();
        $rows = [];
        while ($row = $result->fetch_assoc()) {
            $rows[] = $row;
        }
        $stmt->close();

        $columns = ['archive_id', 'user_name', 'room_name', 'date', 'time_in', 'time_out', 'status', 'archived_at', 'archived_by_name', 'archive_reason'];
        $filename = 'attendance_archive_' . date('Ymd') . '.csv';

        // Log the export
        $logStmt = $mysqli->prepare("INSERT INTO tbl_archive_exports (user_id, export_type, date_from, date_to, filter_criteria, file_name, record_count) VALUES (?, 'csv', ?, ?, ?, ?, ?)");
        if ($logStmt) {
            $filterJson = json_encode(['date_from' => $date_from, 'date_to' => $date_to]);
            $logStmt->bind_param('issssi', $authUserId, $date_from, $date_to, $filterJson, $filename, count($rows));
            $logStmt->execute();
            $logStmt->close();
        }

        // Output CSV
        header('Content-Type: text/csv');
        header('Content-Disposition: attachment; filename="' . $filename . '"');
        $out = fopen('php://output', 'w');
        fputcsv($out, $columns);
        foreach ($rows as $r) {
            $line = [];
            foreach ($columns as $c) $line[] = $r[$c] ?? '';
            fputcsv($out, $line);
        }
        fclose($out);
        exit;
    } elseif ($action === 'export-logs') {
        // Show export history
        $sql = "SELECT e.*, CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,'')) as user_name 
                FROM tbl_archive_exports e 
                LEFT JOIN tbl_users u ON e.user_id = u.user_id 
                ORDER BY e.exported_at DESC LIMIT 50";
        $result = $mysqli->query($sql);
        $rows = [];
        while ($row = $result->fetch_assoc()) {
            $rows[] = $row;
        }
        json_response(['rows' => $rows]);
    } elseif ($action === 'stats') {
        // Get archive statistics
        $totalArchived = $mysqli->query("SELECT COUNT(*) as c FROM tbl_attendance_archive")->fetch_assoc()['c'];
        $totalExports = $mysqli->query("SELECT COUNT(*) as c FROM tbl_archive_exports")->fetch_assoc()['c'];
        $recentArchived = $mysqli->query("SELECT COUNT(*) as c FROM tbl_attendance_archive WHERE archived_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)")->fetch_assoc()['c'];
        $oldestDate = $mysqli->query("SELECT MIN(date) as d FROM tbl_attendance_archive")->fetch_assoc()['d'];
        
        json_response([
            'total_archived' => (int)$totalArchived,
            'total_exports' => (int)$totalExports,
            'recent_archived' => (int)$recentArchived,
            'oldest_archived_date' => $oldestDate
        ]);
    } else {
        json_response(['error' => 'unknown_action'], 400);
    }
} elseif ($method === 'POST') {
    if ($action === 'archive') {
        // Archive old attendance records
        $input = get_input();
        $date_cutoff = $input['date_cutoff'] ?? date('Y-m-d', strtotime('-1 year'));
        $reason = $input['reason'] ?? 'Scheduled archival of old records';
        $archive_ids = $input['attendance_ids'] ?? null; // Optional specific IDs

        $mysqli->begin_transaction();
        try {
            if ($archive_ids && is_array($archive_ids)) {
                // Archive specific records
                $ids = array_map('intval', $archive_ids);
                $idList = implode(',', $ids);
                $selectSql = "SELECT * FROM tbl_attendance_records WHERE attendance_id IN ({$idList})";
            } else {
                // Archive records older than cutoff date
                $selectSql = "SELECT * FROM tbl_attendance_records WHERE date < ?";
            }

            $selectStmt = $mysqli->prepare($selectSql);
            if (!$selectStmt) throw new Exception($mysqli->error);

            if (!$archive_ids) {
                $selectStmt->bind_param('s', $date_cutoff);
            }
            $selectStmt->execute();
            $result = $selectStmt->get_result();
            $archivedCount = 0;

            $insertStmt = $mysqli->prepare("INSERT INTO tbl_attendance_archive 
                (original_attendance_id, user_id, room_id, schedule_id, date, time_in, time_out, status, archived_by, archive_reason, original_data) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");

            if (!$insertStmt) throw new Exception($mysqli->error);

            while ($row = $result->fetch_assoc()) {
                $originalData = json_encode($row);
                $insertStmt->bind_param(
                    'iiiissssiss',
                    $row['attendance_id'],
                    $row['user_id'],
                    $row['room_id'],
                    $row['schedule_id'],
                    $row['date'],
                    $row['time_in'],
                    $row['time_out'],
                    $row['status'],
                    $authUserId,
                    $reason,
                    $originalData
                );
                $insertStmt->execute();
                $archivedCount++;
            }
            $selectStmt->close();
            $insertStmt->close();

            // Delete original records after archiving
            if ($archive_ids && is_array($archive_ids)) {
                $deleteSql = "DELETE FROM tbl_attendance_records WHERE attendance_id IN ({$idList})";
            } else {
                $deleteSql = "DELETE FROM tbl_attendance_records WHERE date < ?";
            }
            $deleteStmt = $mysqli->prepare($deleteSql);
            if (!$deleteStmt) throw new Exception($mysqli->error);
            if (!$archive_ids) {
                $deleteStmt->bind_param('s', $date_cutoff);
            }
            $deleteStmt->execute();
            $deleteStmt->close();

            $mysqli->commit();
            log_system_action($mysqli, $authUserId, 'data_archive', "Archived {$archivedCount} attendance records. Reason: {$reason}");
            json_response(['ok' => true, 'archived_count' => $archivedCount]);
        } catch (Exception $e) {
            $mysqli->rollback();
            json_response(['error' => 'archive_failed', 'message' => $e->getMessage()], 500);
        }
    } elseif ($action === 'restore') {
        // Restore archived records back to main table
        $input = get_input();
        $archive_ids = $input['archive_ids'] ?? [];
        if (!is_array($archive_ids) || empty($archive_ids)) {
            json_response(['error' => 'no_ids', 'message' => 'No archive IDs provided.'], 400);
        }

        $mysqli->begin_transaction();
        try {
            $ids = array_map('intval', $archive_ids);
            $idList = implode(',', $ids);
            
            $selectSql = "SELECT * FROM tbl_attendance_archive WHERE archive_id IN ({$idList})";
            $result = $mysqli->query($selectSql);
            $restoredCount = 0;

            $insertStmt = $mysqli->prepare("INSERT INTO tbl_attendance_records 
                (user_id, room_id, schedule_id, date, time_in, time_out, status) 
                VALUES (?, ?, ?, ?, ?, ?, ?)");

            if (!$insertStmt) throw new Exception($mysqli->error);

            while ($row = $result->fetch_assoc()) {
                $insertStmt->bind_param(
                    'iiissss',
                    $row['user_id'],
                    $row['room_id'],
                    $row['schedule_id'],
                    $row['date'],
                    $row['time_in'],
                    $row['time_out'],
                    $row['status']
                );
                $insertStmt->execute();
                $restoredCount++;
            }
            $insertStmt->close();

            // Delete from archive
            $deleteSql = "DELETE FROM tbl_attendance_archive WHERE archive_id IN ({$idList})";
            $mysqli->query($deleteSql);

            $mysqli->commit();
            log_system_action($mysqli, $authUserId, 'data_restore', "Restored {$restoredCount} archived attendance records.");
            json_response(['ok' => true, 'restored_count' => $restoredCount]);
        } catch (Exception $e) {
            $mysqli->rollback();
            json_response(['error' => 'restore_failed', 'message' => $e->getMessage()], 500);
        }
    } else {
        json_response(['error' => 'unknown_action'], 400);
    }
} else {
    json_response(['error' => 'method_not_allowed'], 405);
}
