<?php
// api/api/qrcode.php
// Generate a QR PNG on the server.

use Endroid\QrCode\Builder\Builder;
use Endroid\QrCode\ErrorCorrectionLevel;

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

if (empty($_GET['data'])) {
    header('Content-Type: application/json');
    http_response_code(400);
    echo json_encode(['error' => 'missing_data']);
    exit;
}

$data = (string) $_GET['data'];
$size = isset($_GET['size']) ? (int)$_GET['size'] : 240;
$margin = isset($_GET['margin']) ? (int)$_GET['margin'] : 0;
$size = max(64, min(1024, $size));
$margin = max(0, min(20, $margin));

// endroid/qr-code v6 requires PHP 8.2+.
// On older PHP, try a lightweight remote fallback to avoid hard 500 errors.
if (PHP_VERSION_ID < 80200) {
    $remoteUrl = 'https://api.qrserver.com/v1/create-qr-code/?size='
        . rawurlencode($size . 'x' . $size)
        . '&margin=' . rawurlencode((string) $margin)
        . '&data=' . rawurlencode($data);
    $remotePng = @file_get_contents($remoteUrl);
    if ($remotePng !== false) {
        header('Content-Type: image/png');
        header('Cache-Control: private, max-age=3600');
        echo $remotePng;
        exit;
    }

    header('Content-Type: application/json');
    http_response_code(501);
    echo json_encode([
        'error' => 'qr_generation_unavailable',
        'message' => 'QR generation requires PHP 8.2+ on this server.',
    ]);
    exit;
}

if (!file_exists(__DIR__ . '/../vendor/autoload.php')) {
    header('Content-Type: application/json');
    http_response_code(500);
    echo json_encode([
        'error' => 'qr_generation_unavailable',
        'message' => 'QR dependencies are missing. Run composer install in api.',
    ]);
    exit;
}
require_once __DIR__ . '/../vendor/autoload.php';

try {
    // Instantiate Builder (installed endroid version uses instance builder)
    $builder = new Builder();

    // Call build() providing overrides: data, error correction, size, margin
    $result = $builder->build(
        null, // writer (use default)
        null, // writerOptions
        null, // validateResult
        $data, // data
        null, // encoding
        ErrorCorrectionLevel::High, // error correction
        $size, // size
        $margin // margin
    );

    // Output PNG
    header('Content-Type: image/png');
    header('Cache-Control: private, max-age=86400');
    echo $result->getString();
    exit;
} catch (Throwable $e) {
    error_log('[qrcode] Generation failed: ' . $e->getMessage());
    header('Content-Type: application/json');
    http_response_code(500);
    echo json_encode(['error' => 'qr_generation_failed', 'message' => $e->getMessage()]);
    exit;
}
