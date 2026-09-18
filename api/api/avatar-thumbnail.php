<?php
// Authenticated, cacheable WebP avatar thumbnails. Lightweight consumers use
// the 96px default; profile surfaces can request a supported larger size.

if (!isset($GLOBALS['mysqli']) || $GLOBALS['mysqli'] === null) {
    require_once __DIR__ . '/../config/database.php';
}
global $mysqli;

if (!function_exists('app_normalize_user_status')) {
    require_once __DIR__ . '/../helpers/functions.php';
}

$userId = isset($_GET['user_id']) ? (int)$_GET['user_id'] : 0;
$auth = $GLOBALS['authPayload'] ?? null;
if ($userId <= 0 || !is_array($auth) || empty($auth['user_id'])) {
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'forbidden']);
    exit;
}

$stmt = $mysqli->prepare('SELECT first_name, last_name, image, status, role_id, dept_id FROM tbl_users WHERE user_id = ? LIMIT 1');
if (!$stmt) {
    http_response_code(500);
    exit;
}
$stmt->bind_param('i', $userId);
$stmt->execute();
$row = $stmt->get_result()->fetch_assoc();
$stmt->close();
if (!$row) {
    http_response_code(404);
    exit;
}

$authRoleId = isset($auth['role_id']) ? (int)$auth['role_id'] : 0;
if (app_normalize_user_status($row['status'] ?? null) === 'archive' && $authRoleId !== 1) {
    $authDeptId = isset($auth['dept_id']) && $auth['dept_id'] !== null ? (int)$auth['dept_id'] : null;
    $targetDeptId = isset($row['dept_id']) && $row['dept_id'] !== null ? (int)$row['dept_id'] : null;
    $targetRoleId = isset($row['role_id']) ? (int)$row['role_id'] : 0;
    $departmentAdminCanView = $authRoleId === 6
        && $authDeptId !== null
        && $targetDeptId !== null
        && $authDeptId === $targetDeptId
        && in_array($targetRoleId, [2, 3, 4, 5], true);
    if (!$departmentAdminCanView) {
        // Archived identities stay private outside the authorized archive view.
        http_response_code(404);
        exit;
    }
}

$raw = (string)($row['image'] ?? '');
$binary = $raw;
if (preg_match('/^data:image\/[a-z0-9.+-]+;base64,(.*)$/is', $raw, $match)) {
    $decoded = base64_decode($match[1], true);
    $binary = $decoded === false ? '' : $decoded;
} elseif ($raw !== '') {
    // Support older rows that stored bare Base64 instead of a data URL.
    $decoded = base64_decode($raw, true);
    if ($decoded !== false && @getimagesizefromstring($decoded) !== false) $binary = $decoded;
}
$supportedSizes = [64, 96, 128, 192, 256];
$requestedSize = isset($_GET['size']) ? (int)$_GET['size'] : 96;
$size = in_array($requestedSize, $supportedSizes, true) ? $requestedSize : 96;
$sourceHash = sha1($binary !== '' ? $binary : ($userId . '|fallback|' . ($row['first_name'] ?? '') . '|' . ($row['last_name'] ?? '')));
$etag = '"avatar-' . $sourceHash . '-' . $size . '"';
header('ETag: ' . $etag);
$requestedVersion = strtolower(trim((string)($_GET['v'] ?? '')));
if (preg_match('/^[a-f0-9]{40}$/', $requestedVersion) && hash_equals($sourceHash, $requestedVersion)) {
    header('Cache-Control: private, max-age=31536000, immutable');
} else {
    header('Cache-Control: private, max-age=300, stale-while-revalidate=600');
}
if (trim((string)($_SERVER['HTTP_IF_NONE_MATCH'] ?? '')) === $etag) {
    http_response_code(304);
    exit;
}

$cacheDir = __DIR__ . '/../cache/avatar-thumbnails';
$cacheFile = $cacheDir . '/' . $userId . '-' . $sourceHash . '-' . $size . '.webp';
if (is_file($cacheFile)) {
    header('Content-Type: image/webp');
    header('Content-Length: ' . filesize($cacheFile));
    readfile($cacheFile);
    exit;
}

$source = $binary !== '' ? @imagecreatefromstring($binary) : false;
$thumb = imagecreatetruecolor($size, $size);
imagealphablending($thumb, true);
imagesavealpha($thumb, true);
$background = imagecolorallocate($thumb, 226, 232, 240);
imagefilledrectangle($thumb, 0, 0, $size, $size, $background);

if ($source !== false) {
    $width = imagesx($source);
    $height = imagesy($source);
    $side = max(1, min($width, $height));
    $srcX = (int)floor(($width - $side) / 2);
    $srcY = (int)floor(($height - $side) / 2);
    imagecopyresampled($thumb, $source, 0, 0, $srcX, $srcY, $size, $size, $side, $side);
    imagedestroy($source);
} else {
    $textColor = imagecolorallocate($thumb, 71, 85, 105);
    $initials = strtoupper(substr((string)($row['first_name'] ?? 'T'), 0, 1) . substr((string)($row['last_name'] ?? ''), 0, 1));
    $initials = $initials !== '' ? $initials : 'T';
    $font = 5;
    $textX = max(0, (int)floor(($size - imagefontwidth($font) * strlen($initials)) / 2));
    $textY = max(0, (int)floor(($size - imagefontheight($font)) / 2));
    imagestring($thumb, $font, $textX, $textY, $initials, $textColor);
}

if (!is_dir($cacheDir)) {
    @mkdir($cacheDir, 0775, true);
}
ob_start();
imagewebp($thumb, null, 78);
$output = ob_get_clean();
imagedestroy($thumb);
if (!is_string($output) || $output === '') {
    http_response_code(500);
    exit;
}
if (is_dir($cacheDir) && is_writable($cacheDir)) {
    @file_put_contents($cacheFile, $output, LOCK_EX);
}
header('Content-Type: image/webp');
header('Content-Length: ' . strlen($output));
echo $output;
