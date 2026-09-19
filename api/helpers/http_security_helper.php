<?php
declare(strict_types=1);

/**
 * Shared transport and browser security controls.
 *
 * The enforced compatibility CSP supports the existing runtime JSX loader.
 * A stricter script policy reports violations in the browser without blocking.
 */

function app_content_security_policy(): string {
    return "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://cdn.jsdelivr.net https://unpkg.com https://rawcdn.githack.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; img-src 'self' data: blob: https:; font-src 'self' data: https://cdn.jsdelivr.net https://fonts.gstatic.com; connect-src 'self' blob: data: https://www.gstatic.com https://cdn.jsdelivr.net; worker-src 'self' blob:; media-src 'self' data: blob:; frame-src 'self' blob:; manifest-src 'self'";
}

function app_http_request_host(): string {
    $host = trim((string)($_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_NAME'] ?? ''));
    if ($host === '' || preg_match('/[\r\n]/', $host)) return '';

    // Only permit a normal DNS name, IPv4 address, or bracketed IPv6 address,
    // with an optional numeric port, before using the host in a redirect.
    if (!preg_match('/^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/', $host)) {
        return '';
    }
    return $host;
}

function app_http_public_request_host(): string {
    $requestHost = app_http_request_host();
    $requestHostName = app_http_host_without_port($requestHost);
    if (!in_array($requestHostName, ['localhost', '127.0.0.1', '::1'], true)) {
        return $requestHost;
    }

    // Microsoft Dev Tunnels terminates public HTTPS and forwards the request
    // to localhost. Trust its forwarded host only for a local upstream and
    // only when the forwarded hostname belongs to devtunnels.ms.
    $forwarded = trim(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_HOST'] ?? ''))[0]);
    if ($forwarded === '' || preg_match('/[\r\n]/', $forwarded)) {
        return $requestHost;
    }
    if (!preg_match('/^(?:[A-Za-z0-9.-]+)(?::\d{1,5})?$/', $forwarded)) {
        return $requestHost;
    }

    $forwardedName = app_http_host_without_port($forwarded);
    if ($forwardedName !== 'devtunnels.ms' && !str_ends_with($forwardedName, '.devtunnels.ms')) {
        return $requestHost;
    }

    return $forwarded;
}

function app_http_is_trusted_dev_tunnel_request(): bool {
    $requestHost = app_http_request_host();
    $publicHost = app_http_public_request_host();
    if ($requestHost === '' || $publicHost === '' || hash_equals($requestHost, $publicHost)) {
        return false;
    }

    $publicName = app_http_host_without_port($publicHost);
    return $publicName === 'devtunnels.ms' || str_ends_with($publicName, '.devtunnels.ms');
}

function app_http_host_without_port(string $host): string {
    $host = strtolower(trim($host));
    if (str_starts_with($host, '[')) {
        $closingBracket = strpos($host, ']');
        return $closingBracket === false ? $host : trim(substr($host, 1, $closingBracket - 1), '[]');
    }
    return preg_replace('/:\d+$/', '', $host) ?: $host;
}

function app_http_is_local_request(): bool {
    $host = app_http_host_without_port(app_http_request_host());
    return $host === 'localhost'
        || $host === '127.0.0.1'
        || $host === '::1'
        || str_ends_with($host, '.localhost');
}

function app_http_is_https_request(): bool {
    $https = strtolower(trim((string)($_SERVER['HTTPS'] ?? '')));
    if ($https !== '' && $https !== 'off' && $https !== '0') return true;

    $forwardedProto = strtolower(trim(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0]));
    if ($forwardedProto === 'https') return true;

    return (int)($_SERVER['SERVER_PORT'] ?? 0) === 443;
}

function app_http_security_options(array $security = []): array {
    $forceHttps = array_key_exists('force_https', $security)
        ? (bool)$security['force_https']
        : getenv('APP_FORCE_HTTPS') !== '0';
    $hstsMaxAge = isset($security['hsts_max_age_seconds'])
        ? max(0, (int)$security['hsts_max_age_seconds'])
        : 31536000;

    return [
        'force_https' => $forceHttps,
        'hsts_max_age_seconds' => $hstsMaxAge,
        'permissions_policy' => (string)($security['permissions_policy'] ?? 'geolocation=(self), camera=(), microphone=()'),
    ];
}

function app_apply_http_security(array $security = []): void {
    $options = app_http_security_options($security);

    // These headers are deliberately low risk and do not restrict the app's
    // JavaScript, styles, API connections, imports, push, or 3D resources.
    $csp = app_content_security_policy();
    header('Content-Security-Policy: ' . $csp);
    header('Content-Security-Policy-Report-Only: ' . str_replace(" 'unsafe-inline' 'unsafe-eval'", '', $csp));
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header('X-Frame-Options: SAMEORIGIN');
    header('Permissions-Policy: ' . $options['permissions_policy']);
    header('X-Permitted-Cross-Domain-Policies: none');

    if (app_http_is_https_request() && $options['hsts_max_age_seconds'] > 0) {
        // Do not include subdomains until every subdomain is confirmed to use HTTPS.
        header('Strict-Transport-Security: max-age=' . $options['hsts_max_age_seconds']);
    }

    if (!$options['force_https'] || app_http_is_https_request() || app_http_is_local_request()) {
        return;
    }

    $host = app_http_request_host();
    if ($host === '') {
        // Never build a Location header from an invalid Host value.
        http_response_code(400);
        header('Content-Type: text/plain; charset=UTF-8');
        echo 'Invalid request host.';
        exit;
    }

    $requestUri = (string)($_SERVER['REQUEST_URI'] ?? '/');
    $requestUri = preg_replace('/[\r\n]/', '', $requestUri) ?: '/';
    header('Location: https://' . $host . $requestUri, true, 308);
    exit;
}

