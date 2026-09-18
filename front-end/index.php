<?php
declare(strict_types=1);

/*
 * The application can be uploaded in either supported layout:
 *
 *   public_html/
 *     index.php, public/, src/, api/          (flattened upload)
 *
 *   public_html/
 *     front-end/index.php, front-end/public/, front-end/src/, api/ (this repo)
 *
 * Resolve the API directory from the filesystem instead of assuming that it
 * is always nested below the front-end directory. This keeps PHP includes and
 * the browser API base URL correct after importing the two folders.
 */
$apiRoot = __DIR__ . '/api';
$apiIsSibling = false;
if (!is_dir($apiRoot)) {
    $siblingApiRoot = dirname(__DIR__) . '/api';
    if (is_dir($siblingApiRoot)) {
        $apiRoot = $siblingApiRoot;
        $apiIsSibling = true;
    }
}

if (!is_file($apiRoot . '/helpers/http_security_helper.php')) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=UTF-8');
    echo 'API folder not found. Upload the api folder beside front-end, or inside the web root.';
    exit;
}

require_once $apiRoot . '/helpers/http_security_helper.php';
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

// Keep frontend API calls pointed at the physical api directory in either
// upload layout. api.js uses this value before its pathname fallback.
$apiBasePath = $apiIsSibling
    ? rtrim(str_replace('\\', '/', dirname($basePath)), '/') . '/api'
    : ($basePath === '' ? '/api' : $basePath . '/api');
if ($apiBasePath === '//api') $apiBasePath = '/api';
// APP_API_BASE is useful when a dev-tunnel frontend calls a separately hosted
// API, e.g. https://coc-studentinfo.net/tams/api.
$apiBasePath = app_configured_api_base() ?: $apiBasePath;
$apiBaseBootstrap = '<script>window.API_BASE=' . json_encode(
    $apiBasePath,
    JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT
) . ';</script>';

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

require_once $apiRoot . '/helpers/static_assets_helper.php';
$html = app_version_html_assets($html, app_static_versions(__DIR__, $basePath), $basePath);
if (stripos($html, 'window.API_BASE=') === false) {
    $withApiBase = preg_replace('/<head(\s[^>]*)?>/i', '$0' . "\n    " . $apiBaseBootstrap, $html, 1);
    if (is_string($withApiBase)) {
        $html = $withApiBase;
    }
}
header('Cache-Control: no-cache, must-revalidate');
header('Content-Type: text/html; charset=UTF-8');
echo $html;
