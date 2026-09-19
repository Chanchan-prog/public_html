<?php

use Minishlink\WebPush\Subscription;
use Minishlink\WebPush\WebPush;

function push_config() {
    static $config = null;
    if ($config !== null) return $config;
    $security = file_exists(__DIR__ . '/../config/security.php')
        ? require __DIR__ . '/../config/security.php'
        : [];
    $config = is_array($security['web_push'] ?? null) ? $security['web_push'] : [];
    return $config;
}

function push_is_configured() {
    $config = push_config();
    return trim((string)($config['subject'] ?? '')) !== ''
        && trim((string)($config['public_key'] ?? '')) !== ''
        && trim((string)($config['private_key'] ?? '')) !== '';
}

function push_prepare_openssl_config() {
    $configured = trim((string)getenv('OPENSSL_CONF'));
    if ($configured !== '' && is_file($configured)) return true;

    $phpIni = php_ini_loaded_file();
    $phpDir = $phpIni ? dirname($phpIni) : dirname(PHP_BINARY);
    $candidates = [
        $phpDir . '/extras/ssl/openssl.cnf',
        $phpDir . '/openssl.cnf',
        $phpDir . '/../apache/conf/openssl.cnf',
        'C:/xampp/apache/conf/openssl.cnf',
    ];
    foreach ($candidates as $candidate) {
        $resolved = realpath($candidate);
        if ($resolved && is_file($resolved)) {
            putenv('OPENSSL_CONF=' . $resolved);
            putenv('WEB_PUSH_OPENSSL_CONFIG=' . $resolved);
            $_ENV['OPENSSL_CONF'] = $resolved;
            $_ENV['WEB_PUSH_OPENSSL_CONFIG'] = $resolved;
            return true;
        }
    }
    return false;
}

function push_schema_ensure($mysqli) {
    static $ready = null;
    if ($ready !== null) return $ready;
    $sql = "CREATE TABLE IF NOT EXISTS tbl_push_subscriptions (
        subscription_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        endpoint_hash CHAR(64) NOT NULL,
        endpoint TEXT NOT NULL,
        p256dh VARCHAR(255) NOT NULL,
        auth_token VARCHAR(255) NOT NULL,
        content_encoding VARCHAR(20) NOT NULL DEFAULT 'aes128gcm',
        user_agent VARCHAR(500) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (subscription_id),
        UNIQUE KEY uq_push_endpoint_hash (endpoint_hash),
        KEY idx_push_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
    $ready = (bool)$mysqli->query($sql);
    if (!$ready) error_log('[web_push] subscription schema failed: ' . $mysqli->error);
    return $ready;
}

function push_schema_exists($mysqli) {
    static $exists = null;
    if ($exists !== null) return $exists;
    $result = $mysqli->query("SHOW TABLES LIKE 'tbl_push_subscriptions'");
    $exists = (bool)($result && $result->num_rows > 0);
    return $exists;
}

function push_save_subscription($mysqli, $userId, $subscription, $userAgent = '') {
    $uid = (int)$userId;
    $endpoint = trim((string)($subscription['endpoint'] ?? ''));
    $keys = is_array($subscription['keys'] ?? null) ? $subscription['keys'] : [];
    $p256dh = trim((string)($keys['p256dh'] ?? ''));
    $authToken = trim((string)($keys['auth'] ?? ''));
    $contentEncoding = trim((string)($subscription['contentEncoding'] ?? 'aes128gcm'));
    if ($uid <= 0 || $endpoint === '' || $p256dh === '' || $authToken === '') return false;
    if (!in_array($contentEncoding, ['aes128gcm', 'aesgcm'], true)) $contentEncoding = 'aes128gcm';
    if (!push_schema_ensure($mysqli)) return false;

    $hash = hash('sha256', $endpoint);
    $agent = substr(trim((string)$userAgent), 0, 500);
    $sql = "INSERT INTO tbl_push_subscriptions
                (user_id, endpoint_hash, endpoint, p256dh, auth_token, content_encoding, user_agent)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                user_id = VALUES(user_id), endpoint = VALUES(endpoint),
                p256dh = VALUES(p256dh), auth_token = VALUES(auth_token),
                content_encoding = VALUES(content_encoding), user_agent = VALUES(user_agent),
                updated_at = CURRENT_TIMESTAMP";
    $stmt = $mysqli->prepare($sql);
    if (!$stmt) return false;
    $stmt->bind_param('issssss', $uid, $hash, $endpoint, $p256dh, $authToken, $contentEncoding, $agent);
    $ok = $stmt->execute();
    $stmt->close();
    return (bool)$ok;
}

function push_subscription_is_registered($mysqli, $userId, $endpoint) {
    $uid = (int)$userId;
    $cleanEndpoint = trim((string)$endpoint);
    if ($uid <= 0 || $cleanEndpoint === '' || strlen($cleanEndpoint) > 8192 || !push_schema_ensure($mysqli)) return false;

    $hash = hash('sha256', $cleanEndpoint);
    $stmt = $mysqli->prepare('SELECT subscription_id FROM tbl_push_subscriptions WHERE user_id = ? AND endpoint_hash = ? LIMIT 1');
    if (!$stmt) return false;
    $stmt->bind_param('is', $uid, $hash);
    $stmt->execute();
    $registered = (bool)$stmt->get_result()->fetch_assoc();
    $stmt->close();
    return $registered;
}

function push_remove_subscription($mysqli, $userId, $endpoint = '') {
    $uid = (int)$userId;
    if ($uid <= 0 || !push_schema_ensure($mysqli)) return 0;
    $cleanEndpoint = trim((string)$endpoint);
    if ($cleanEndpoint !== '') {
        $hash = hash('sha256', $cleanEndpoint);
        $stmt = $mysqli->prepare('DELETE FROM tbl_push_subscriptions WHERE user_id = ? AND endpoint_hash = ?');
        if (!$stmt) return 0;
        $stmt->bind_param('is', $uid, $hash);
    } else {
        $stmt = $mysqli->prepare('DELETE FROM tbl_push_subscriptions WHERE user_id = ?');
        if (!$stmt) return 0;
        $stmt->bind_param('i', $uid);
    }
    $stmt->execute();
    $removed = (int)$stmt->affected_rows;
    $stmt->close();
    return $removed;
}

function push_remove_endpoint($mysqli, $endpoint) {
    if (!push_schema_exists($mysqli)) return;
    $hash = hash('sha256', (string)$endpoint);
    $stmt = $mysqli->prepare('DELETE FROM tbl_push_subscriptions WHERE endpoint_hash = ?');
    if (!$stmt) return;
    $stmt->bind_param('s', $hash);
    $stmt->execute();
    $stmt->close();
}

/**
 * A VAPID key rotation makes the affected browser subscription permanently
 * unusable. FCM returns 403 rather than an "expired" response, so remove it
 * and let the signed-in browser register again with the current server key.
 */
function push_delivery_requires_resubscribe($reason) {
    $text = strtolower((string)$reason);
    return strpos($text, 'vapid credentials') !== false
        || strpos($text, 'authorization header do not correspond') !== false
        || strpos($text, 'vapid key') !== false;
}

function push_safe_delivery_reason($reason) {
    $text = trim((string)$reason);
    // Push endpoints are device-specific identifiers and do not need to be
    // retained in application logs just to diagnose a provider response.
    $text = preg_replace('~https?://[^\\s`]+~i', '[push endpoint]', $text);
    $text = preg_replace('/\\s+/', ' ', (string)$text);
    return substr((string)$text, 0, 500);
}

/**
 * Convert a saved application route into a same-origin hash URL.
 * External URLs, protocol-relative URLs, backslashes, and control characters
 * are rejected so a notification cannot be used as an open redirect.
 */
function push_notification_target_url($link, $notificationId) {
    $fallback = './#/notifications?notif_id=' . (int)$notificationId;
    $route = trim((string)$link);
    if ($route === '') return $fallback;

    if (strpos($route, '#/') === 0) {
        $route = substr($route, 1);
    }
    if ($route === '' || $route[0] !== '/') return $fallback;
    if (strpos($route, '//') === 0 || strpos($route, '\\') !== false) return $fallback;
    if (preg_match('/[\x00-\x1F\x7F]/', $route)) return $fallback;

    return './#' . $route;
}

function push_send_notification($mysqli, $userId, $notificationId, $title, $message, $link = '') {
    $uid = (int)$userId;
    // Do not run schema DDL from notification creation because callers may be
    // inside a business transaction. Subscription endpoints create the table.
    if ($uid <= 0 || !push_is_configured() || !push_schema_exists($mysqli)) return 0;
    $autoload = __DIR__ . '/../vendor/autoload.php';
    if (!file_exists($autoload)) return 0;
    push_prepare_openssl_config();
    $encryptionFile = __DIR__ . '/../vendor/minishlink/web-push/src/Encryption.php';
    if (function_exists('opcache_invalidate') && is_file($encryptionFile)) {
        @opcache_invalidate($encryptionFile, true);
    }
    require_once $autoload;

    $stmt = $mysqli->prepare("SELECT endpoint, p256dh, auth_token, content_encoding
        FROM tbl_push_subscriptions WHERE user_id = ? ORDER BY updated_at DESC");
    if (!$stmt) return 0;
    $stmt->bind_param('i', $uid);
    $stmt->execute();
    $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $stmt->close();
    if (empty($rows)) return 0;

    $config = push_config();
    try {
        $webPush = new WebPush([
            'VAPID' => [
                'subject' => (string)$config['subject'],
                'publicKey' => (string)$config['public_key'],
                'privateKey' => (string)$config['private_key'],
            ],
        ], [
            'TTL' => 86400,
            'urgency' => 'normal',
            'batchSize' => 100,
        ], 8);
        $webPush->setReuseVAPIDHeaders(true);
        $cleanLink = trim((string)$link);
        $payload = json_encode([
            'title' => trim((string)$title) ?: 'New notification',
            'body' => trim((string)$message),
            'notif_id' => (int)$notificationId,
            'link' => $cleanLink,
            'url' => push_notification_target_url($cleanLink, $notificationId),
            'icon' => './cdoc-logo.png?v=lossless-20260911',
            'badge' => './cdoc-logo.png?v=lossless-20260911',
            'tag' => 'notification-' . (int)$notificationId,
        ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        foreach ($rows as $row) {
            $subscription = Subscription::create([
                'endpoint' => $row['endpoint'],
                'publicKey' => $row['p256dh'],
                'authToken' => $row['auth_token'],
                'contentEncoding' => $row['content_encoding'] ?: 'aes128gcm',
            ]);
            $webPush->queueNotification($subscription, $payload);
        }

        $sent = 0;
        foreach ($webPush->flush() as $report) {
            if ($report->isSuccess()) {
                $sent++;
            } elseif ($report->isSubscriptionExpired() || push_delivery_requires_resubscribe($report->getReason())) {
                push_remove_endpoint($mysqli, $report->getEndpoint());
            } else {
                error_log('[web_push] delivery failed: ' . push_safe_delivery_reason($report->getReason()));
            }
        }
        return $sent;
    } catch (Throwable $error) {
        error_log('[web_push] exception: ' . $error->getMessage());
        return 0;
    }
}
