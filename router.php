<?php
declare(strict_types=1);

// Router for PHP's built-in server, used by the Docker/Railway deployment.
// Its document root is front-end/, but the API is deliberately a sibling
// directory. Apache handles this through .htaccess locally; the built-in
// server needs this explicit bridge.
$requestPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

if ($requestPath === '/api' || str_starts_with($requestPath, '/api/')) {
    require __DIR__ . '/api/index.php';
    return true;
}

// Let the server deliver existing public assets (JS, CSS, images, etc.) with
// its normal static-file handling. Everything else is the SPA entry point.
$frontendFile = __DIR__ . '/front-end' . str_replace('/', DIRECTORY_SEPARATOR, $requestPath);
if ($requestPath !== '/' && is_file($frontendFile)) {
    // Asset URLs are fingerprinted by the frontend entry point. Cache them at
    // the edge/browser so navigating between pages does not re-download JSX,
    // vendor libraries, styles, or large 3D models.
    $extension = strtolower(pathinfo($frontendFile, PATHINFO_EXTENSION));
    $cacheableExtensions = ['js', 'jsx', 'css', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'glb', 'gltf', 'bin'];
    if (in_array($extension, $cacheableExtensions, true)) {
        header('Cache-Control: public, max-age=604800, stale-while-revalidate=86400');
        $contentTypes = [
            'js' => 'application/javascript; charset=UTF-8', 'jsx' => 'application/javascript; charset=UTF-8', 'css' => 'text/css; charset=UTF-8',
            'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif', 'webp' => 'image/webp', 'svg' => 'image/svg+xml', 'ico' => 'image/x-icon',
            'woff' => 'font/woff', 'woff2' => 'font/woff2', 'ttf' => 'font/ttf', 'otf' => 'font/otf',
            'glb' => 'model/gltf-binary', 'gltf' => 'model/gltf+json', 'bin' => 'application/octet-stream',
        ];
        header('Content-Type: ' . ($contentTypes[$extension] ?? 'application/octet-stream'));
        header('Content-Length: ' . (string)filesize($frontendFile));
        readfile($frontendFile);
        return true;
    }
    return false;
}

require __DIR__ . '/front-end/index.php';
return true;
