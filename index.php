<?php
declare(strict_types=1);
// Railway's PHP runtime (Railpack/FrankenPHP) serves every request through this
// file: its generated Caddyfile uses `php_server`, which rewrites requests such
// as /api/login to the frontend /index.php instead of api/index.php. Caddy does
// not honor the Apache .htaccess rules that normally route /api/* to the API
// controller, so without this dispatch API calls received the SPA's HTML (no
// JSON), which is what shows up in Caddy logs as "rewrote request ... /index.php".
// Detect any path that contains an `api` path segment and hand it to the API
// front controller, which parses the original REQUEST_URI itself.
$requestPath = (string)parse_url((string)($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
$requestPath = '/' . ltrim(str_replace('\\', '/', $requestPath), '/');
if (preg_match('#(?:^|/)api(?:/|$)#i', $requestPath)) {
    $apiIndex = __DIR__ . '/api/index.php';
    if (!is_file($apiIndex)) {
        $apiIndex = __DIR__ . '/../api/index.php';
    }
    if (is_file($apiIndex)) {
        require $apiIndex;
    } else {
        http_response_code(500);
        header('Content-Type: application/json; charset=UTF-8');
        echo json_encode(['error' => 'API entry point is missing.']);
    }
    exit;
}

// The frontend is developed beside the API, but some deployments place the
// API inside the frontend document root. Support both layouts so the PHP entry
// point does not fatal-error before the application can load.
$httpSecurityHelper = __DIR__ . '/api/helpers/http_security_helper.php';
if (!is_file($httpSecurityHelper)) {
    $httpSecurityHelper = __DIR__ . '/../api/helpers/http_security_helper.php';
}
if (!is_file($httpSecurityHelper)) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=UTF-8');
    echo 'Frontend security helper is missing. Deploy the API directory beside or inside the frontend directory.';
    exit;
}
require_once $httpSecurityHelper;
app_apply_http_security();


// Serve the public app directly from the project root. This avoids dev-tunnel
// issues where the bare "/" URL does not reliably follow the /public/ redirect.
$publicIndex = __DIR__ . '/public/index.html';
if (!is_file($publicIndex)) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=UTF-8');
    echo 'public/index.html not found';
    exit;
}

$basePath = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '')), '/');
$publicBase = ($basePath === '' ? '' : $basePath) . '/public/';
$baseTag = '<base href="' . htmlspecialchars($publicBase, ENT_QUOTES, 'UTF-8') . '">';

$html = file_get_contents($publicIndex);
if ($html === false) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=UTF-8');
    echo 'Unable to read public/index.html';
    exit;
}

if (stripos($html, '<base ') === false) {
    $withBase = preg_replace('/<head(\s[^>]*)?>/i', '$0' . "\n    " . $baseTag, $html, 1);
    if (is_string($withBase)) {
        $html = $withBase;
    }
}

require_once __DIR__ . '/api/helpers/static_assets_helper.php';
$html = app_version_html_assets($html, app_static_versions(__DIR__, $basePath), $basePath);
header('Cache-Control: no-cache, must-revalidate');
header('Content-Type: text/html; charset=UTF-8');
echo $html;
