<?php
declare(strict_types=1);

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
