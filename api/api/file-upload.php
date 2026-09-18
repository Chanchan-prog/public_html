<?php
// api/api/file-upload.php
// File Upload API - Handles document/image uploads with multipart/form-data
require_once __DIR__ . '/../helpers/log_helper.php';
require_once __DIR__ . '/../helpers/upload_security_helper.php';
global $mysqli, $authPayload;

$authUserId = isset($authPayload['user_id']) ? (int)$authPayload['user_id'] : null;
$authRoleId = isset($authPayload['role_id']) ? (int)$authPayload['role_id'] : null;

if (!$authUserId) json_response(['error' => 'unauthorized'], 401);

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = $_GET['action'] ?? 'upload';

// Ensure upload tracking table exists
$mysqli->query("CREATE TABLE IF NOT EXISTS `tbl_file_uploads` (
    `file_id` INT(11) NOT NULL AUTO_INCREMENT,
    `user_id` INT(11) NOT NULL,
    `original_name` VARCHAR(255) NOT NULL,
    `stored_name` VARCHAR(255) NOT NULL,
    `file_path` VARCHAR(500) NOT NULL,
    `file_type` VARCHAR(100) DEFAULT NULL,
    `file_size` BIGINT DEFAULT 0,
    `mime_type` VARCHAR(100) DEFAULT NULL,
    `category` VARCHAR(50) DEFAULT 'general',
    `description` TEXT DEFAULT NULL,
    `uploaded_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`file_id`),
    KEY `user_id` (`user_id`),
    KEY `category` (`category`),
    KEY `uploaded_at` (`uploaded_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

// Ensure upload directory exists
$uploadDir = __DIR__ . '/../uploads';
if (!is_dir($uploadDir)) {
    mkdir($uploadDir, 0755, true);
}

// Create subdirectories for different file types
foreach (['documents', 'images', 'avatars', 'reports', 'archives', 'general'] as $subDir) {
    $path = $uploadDir . '/' . $subDir;
    if (!is_dir($path)) {
        mkdir($path, 0755, true);
    }
}

if ($method === 'GET' && $action === 'download') {
    $fileId = (int)($_GET['file_id'] ?? 0);
    $stmt = $mysqli->prepare('SELECT * FROM tbl_file_uploads WHERE file_id = ?');
    $stmt->bind_param('i', $fileId);
    $stmt->execute();
    $file = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!$file || !app_upload_can_access($file, $authUserId, (int)$authRoleId)) {
        json_response(['error'=>'not_found'], 404);
    }
    $path = app_upload_real_path($uploadDir, (string)$file['file_path']);
    if (!$path) json_response(['error'=>'not_found'], 404);
    // Read bytes only: legacy files are never included/executed or rendered as HTML.
    $name = basename(str_replace('\\', '/', (string)$file['original_name']));
    $name = preg_replace('/[\x00-\x1f\x7f]/', '', $name) ?: 'download';
    if (ob_get_length() !== false) ob_end_clean();
    header('Content-Type: application/octet-stream');
    header("Content-Disposition: attachment; filename=\"download\"; filename*=UTF-8''" . rawurlencode($name));
    header('X-Content-Type-Options: nosniff');
    header("Content-Security-Policy: default-src 'none'; sandbox");
    header('Cache-Control: private, no-store');
    header('Content-Length: ' . filesize($path));
    readfile($path);
    exit;
} elseif ($method === 'POST' && $action === 'upload') {
    // Handle file upload
    if (empty($_FILES['file']) || !is_array($_FILES['file']) || !is_string($_FILES['file']['tmp_name'] ?? null) || !is_string($_FILES['file']['name'] ?? null)) {
        json_response(['error' => 'no_file', 'message' => 'No file was uploaded.'], 400);
    }

    $file = $_FILES['file'];
    $category = sanitizeHtmlInput($_POST['category'] ?? 'general');
    $description = sanitizeHtmlInput($_POST['description'] ?? '');

    // Validate category
    $allowedCategories = ['documents', 'images', 'avatars', 'reports', 'archives', 'general'];
    if (!in_array($category, $allowedCategories, true)) {
        $category = 'general';
    }

    // Validate file
    if ($file['error'] !== UPLOAD_ERR_OK) {
        $errorMessages = [
            UPLOAD_ERR_INI_SIZE => 'File exceeds server upload limit.',
            UPLOAD_ERR_FORM_SIZE => 'File exceeds form upload limit.',
            UPLOAD_ERR_PARTIAL => 'File was only partially uploaded.',
            UPLOAD_ERR_NO_FILE => 'No file was uploaded.',
            UPLOAD_ERR_NO_TMP_DIR => 'Server missing temporary directory.',
            UPLOAD_ERR_CANT_WRITE => 'Failed to write file to disk.',
        ];
        $msg = $errorMessages[$file['error']] ?? 'Unknown upload error.';
        json_response(['error' => 'upload_error', 'message' => $msg], 400);
    }

    // Validate file size (max 10MB)
    $maxSize = 10 * 1024 * 1024;
    if ($file['size'] > $maxSize) {
        json_response(['error' => 'file_too_large', 'message' => 'File exceeds maximum size of 10MB.'], 400);
    }

    if (!is_uploaded_file($file['tmp_name'])) json_response(['error'=>'invalid_upload'], 400);
    try {
        $validated = app_validate_upload($file['tmp_name'], $file['name']);
    } catch (InvalidArgumentException $error) {
        json_response(['error'=>'invalid_type', 'message'=>$error->getMessage()], 400);
    }
    $extension = $validated['extension'];
    $detectedMime = $validated['mime'];
    $file['size'] = $validated['size'];
    $safeName = $authUserId . '_' . time() . '_' . bin2hex(random_bytes(8)) . '.' . $extension;
    $targetPath = $uploadDir . '/' . $category . '/' . $safeName;

    // Move uploaded file
    if (!move_uploaded_file($file['tmp_name'], $targetPath)) {
        json_response(['error' => 'move_failed', 'message' => 'Failed to store uploaded file.'], 500);
    }

    // Store file metadata in database
    $relativePath = 'uploads/' . $category . '/' . $safeName;
    $stmt = $mysqli->prepare("INSERT INTO tbl_file_uploads 
        (user_id, original_name, stored_name, file_path, file_type, file_size, mime_type, category, description) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    
    if (!$stmt) json_response(['error' => 'db_error', 'message' => $mysqli->error], 500);

    $fileType = $detectedMime;
    $stmt->bind_param('issssisss', $authUserId, $file['name'], $safeName, $relativePath, $fileType, $file['size'], $detectedMime, $category, $description);
    $stmt->execute();
    $fileId = $stmt->insert_id;
    $stmt->close();

    log_system_action($mysqli, $authUserId, 'file_upload', "Uploaded file: {$file['name']} ({$category})");

    json_response([
        'ok' => true,
        'file_id' => $fileId,
        'file_name' => $file['name'],
        'file_path' => $relativePath,
        'file_size' => $file['size'],
        'file_type' => $detectedMime,
        'category' => $category,
        'url' => app_upload_download_url((int)$fileId)
    ]);

} elseif ($method === 'GET' && $action === 'list') {
    // List uploaded files
    $page = max(1, (int)($_GET['page'] ?? 1));
    $limit = min(100, max(10, (int)($_GET['limit'] ?? 50)));
    $offset = ($page - 1) * $limit;
    $category = $_GET['category'] ?? '';
    $search = trim((string)($_GET['search'] ?? ''));

    $where = [];
    $params = [];
    $types = '';

    // Role-based scoping
    if ($authRoleId !== 1) {
        $where[] = 'f.user_id = ?';
        $params[] = $authUserId;
        $types .= 'i';
    }

    if ($category) {
        $where[] = 'f.category = ?';
        $params[] = $category;
        $types .= 's';
    }

    if ($search) {
        $where[] = '(f.original_name LIKE ? OR f.description LIKE ?)';
        $searchTerm = '%' . $search . '%';
        $params[] = $searchTerm;
        $params[] = $searchTerm;
        $types .= 'ss';
    }

    $whereClause = $where ? 'WHERE ' . implode(' AND ', $where) : '';

    // Count
    $countSql = "SELECT COUNT(*) as total FROM tbl_file_uploads f {$whereClause}";
    $countStmt = $mysqli->prepare($countSql);
    if ($countStmt) {
        if ($params) $countStmt->bind_param($types, ...$params);
        $countStmt->execute();
        $total = (int)$countStmt->get_result()->fetch_assoc()['total'];
        $countStmt->close();
    } else {
        $total = 0;
    }

    // Fetch
    $sql = "SELECT f.*, CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,'')) as user_name 
            FROM tbl_file_uploads f 
            LEFT JOIN tbl_users u ON f.user_id = u.user_id 
            {$whereClause} 
            ORDER BY f.uploaded_at DESC 
            LIMIT ? OFFSET ?";

    $stmt = $mysqli->prepare($sql);
    if (!$stmt) json_response(['error' => 'db_error'], 500);

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
        $row['file_size_formatted'] = formatFileSize($row['file_size']);
        $row['url'] = app_upload_download_url((int)$row['file_id']);
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

} elseif ($method === 'GET' && $action === 'categories') {
    // Get upload statistics by category
    $sql = "SELECT category, COUNT(*) as count, SUM(file_size) as total_size 
            FROM tbl_file_uploads 
            WHERE user_id = ? OR ? = 1
            GROUP BY category ORDER BY category";
    $stmt = $mysqli->prepare($sql);
    $isAdmin = $authRoleId === 1 ? 1 : 0;
    $stmt->bind_param('ii', $authUserId, $isAdmin);
    $stmt->execute();
    $result = $stmt->get_result();
    $categories = [];
    while ($row = $result->fetch_assoc()) {
        $row['total_size_formatted'] = formatFileSize($row['total_size']);
        $categories[] = $row;
    }
    $stmt->close();
    json_response(['categories' => $categories]);

} elseif ($method === 'DELETE') {
    // Delete a file
    $input = get_input();
    $fileId = (int)($input['file_id'] ?? $_GET['file_id'] ?? 0);
    if (!$fileId) json_response(['error' => 'no_file_id'], 400);

    $stmt = $mysqli->prepare("SELECT * FROM tbl_file_uploads WHERE file_id = ?");
    $stmt->bind_param('i', $fileId);
    $stmt->execute();
    $file = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$file) json_response(['error' => 'not_found'], 404);
    if ($file['user_id'] != $authUserId && $authRoleId !== 1) {
        json_response(['error' => 'forbidden'], 403);
    }

    // Delete physical file
    $fullPath = app_upload_real_path($uploadDir, (string)$file['file_path']);
    if ($fullPath !== null) {
        unlink($fullPath);
    }

    // Delete database record
    $deleteStmt = $mysqli->prepare("DELETE FROM tbl_file_uploads WHERE file_id = ?");
    $deleteStmt->bind_param('i', $fileId);
    $deleteStmt->execute();
    $deleteStmt->close();

    log_system_action($mysqli, $authUserId, 'file_delete', "Deleted file: {$file['original_name']}");
    json_response(['ok' => true, 'message' => 'File deleted successfully.']);

} else {
    json_response(['error' => 'method_not_allowed'], 405);
}

// Helper function
function formatFileSize($bytes) {
    if ($bytes >= 1073741824) return number_format($bytes / 1073741824, 2) . ' GB';
    if ($bytes >= 1048576) return number_format($bytes / 1048576, 2) . ' MB';
    if ($bytes >= 1024) return number_format($bytes / 1024, 2) . ' KB';
    return $bytes . ' B';
}
