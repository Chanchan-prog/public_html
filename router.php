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
    return false;
}

require __DIR__ . '/front-end/index.php';
return true;
