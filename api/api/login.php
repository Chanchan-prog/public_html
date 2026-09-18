<?php
// api/api/login.php
require_once __DIR__ . '/../helpers/socket_helper.php';
require_once __DIR__ . '/../helpers/security_policy_helper.php';
require_once __DIR__ . '/../helpers/log_helper.php';
require_once __DIR__ . '/../helpers/validation_helper.php';
global $mysqli;

security_schema_ensure($mysqli);
$permissionModeColCheck = $mysqli->query("SHOW COLUMNS FROM tbl_users LIKE 'permission_mode'");
$modulePermissionsColCheck = $mysqli->query("SHOW COLUMNS FROM tbl_users LIKE 'module_permissions'");
$firstLoginColCheck = $mysqli->query("SHOW COLUMNS FROM tbl_users LIKE 'is_first_login'");
$hasPermissionModeCol = $permissionModeColCheck && $permissionModeColCheck->num_rows > 0;
$hasModulePermissionsCol = $modulePermissionsColCheck && $modulePermissionsColCheck->num_rows > 0;
$hasUserModulePermissions = $hasPermissionModeCol && $hasModulePermissionsCol;
$hasFirstLoginCol = $firstLoginColCheck && $firstLoginColCheck->num_rows > 0;
$policy = security_policy_get($mysqli);
$tokenVersionCheck = $mysqli->query("SHOW COLUMNS FROM tbl_users LIKE 'token_version'");
$tempExpiryCheck = $mysqli->query("SHOW COLUMNS FROM tbl_users LIKE 'temporary_password_expires_at'");
$passwordChangedCheck = $mysqli->query("SHOW COLUMNS FROM tbl_users LIKE 'password_changed_at'");
$hasTokenVersion = $tokenVersionCheck && $tokenVersionCheck->num_rows > 0;
$hasTempExpiry = $tempExpiryCheck && $tempExpiryCheck->num_rows > 0;
$hasPasswordChanged = $passwordChangedCheck && $passwordChangedCheck->num_rows > 0;

$decode_module_permissions = function($raw) {
    if ($raw === null || $raw === '') return ['allow' => [], 'deny' => []];
    $parsed = is_array($raw) ? $raw : json_decode((string)$raw, true);
    if (!is_array($parsed)) return ['allow' => [], 'deny' => []];
    $allow = isset($parsed['allow']) && is_array($parsed['allow']) ? array_values($parsed['allow']) : [];
    $deny = isset($parsed['deny']) && is_array($parsed['deny']) ? array_values($parsed['deny']) : [];
    return ['allow' => $allow, 'deny' => $deny];
};

$request_method = $_SERVER['REQUEST_METHOD'];
$input = get_input();

if ($request_method === 'POST') {
    try {
        // Single identifier field: can be email or ID number
        $identifier = isset($input['email']) ? trim((string)$input['email']) : null;
        $password = $input['password'] ?? null;
        if (!$identifier || !$password) {
            json_response(['error' => 'Missing email / ID or password'], 400);
        }
        if (sanitizeHtmlInput($identifier) !== $identifier) {
            json_response([
                'error' => 'unsafe_html_input',
                'message' => 'HTML or script content is not allowed in the login ID.'
            ], 400);
        }
        if (containsUnsafeHtmlInput($password)) {
            json_response([
                'error' => 'unsafe_html_input',
                'message' => 'HTML or script content is not allowed in the password.'
            ], 400);
        }

        // The login field also accepts a school ID. Only identifiers that look
        // like email addresses are required to follow the institutional format.
        // Reject malformed email input before password checks so it does not
        // consume a failed-login attempt.
        if (strpos($identifier, '@') !== false && preg_match('/^[^\s@]+@phinmaed\.com$/i', $identifier) !== 1) {
            json_response([
                'error' => 'invalid_email_format',
                'message' => 'Enter a valid @phinmaed.com email address or use your school ID number.'
            ], 400);
        }

        $clientIp = get_client_ip_address();

        // Create login lock table and login attempts history table
        $mysqli->query("CREATE TABLE IF NOT EXISTS `tbl_login_locks` (
            `id` INT(11) NOT NULL AUTO_INCREMENT,
            `email` VARCHAR(255) NOT NULL,
            `failed_attempts` INT(11) NOT NULL DEFAULT 0,
            `lock_until` DATETIME DEFAULT NULL,
            PRIMARY KEY (`id`),
            UNIQUE KEY `email_unique` (`email`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
        $mysqli->query("CREATE TABLE IF NOT EXISTS `tbl_login_attempts` (
            `attempt_id` INT(11) NOT NULL AUTO_INCREMENT,
            `email` VARCHAR(255) NOT NULL,
            `user_id` INT(11) NULL DEFAULT NULL,
            `attempt_time` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `status` ENUM('success', 'failed') NOT NULL DEFAULT 'failed',
            `ip_address` VARCHAR(45) NULL DEFAULT NULL,
            `details` VARCHAR(255) NULL DEFAULT NULL,
            PRIMARY KEY (`attempt_id`),
            KEY `email` (`email`),
            KEY `user_id` (`user_id`),
            KEY `attempt_time` (`attempt_time`),
            KEY `status` (`status`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        // Check if this email is currently locked
        $lockFailedAttempts = 0;
        $lockUntil = null;
        $lockStmt = $mysqli->prepare("SELECT failed_attempts, lock_until FROM tbl_login_locks WHERE email = ? LIMIT 1");
        if ($lockStmt) {
            $lockStmt->bind_param("s", $identifier);
            $lockStmt->execute();
            $lockRes = $lockStmt->get_result();
            if ($row = $lockRes->fetch_assoc()) {
                $lockFailedAttempts = (int)$row['failed_attempts'];
                $lockUntil = $row['lock_until'] ? strtotime($row['lock_until']) : null;
            }
            $lockStmt->close();
        }
        if ($lockUntil && $lockUntil > time()) {
            $remaining = max(1, $lockUntil - time());
            json_response([
                'error' => 'account_locked',
                'message' => 'Sign-in is temporarily unavailable due to repeated failed attempts. Please try again shortly.',
                'remaining_seconds' => $remaining
            ], 429);
        }

        // Allow login by email OR id_number using the same input
        // Include `status` so we can prevent inactive/archived accounts from logging in
        $permissionCols = $hasUserModulePermissions
            ? ", permission_mode, module_permissions"
            : ", NULL AS permission_mode, NULL AS module_permissions";
        $firstLoginCol = $hasFirstLoginCol ? ", is_first_login" : ", 0 AS is_first_login";
        $firstLoginCol .= $hasTokenVersion ? ", token_version" : ", 0 AS token_version";
        $firstLoginCol .= $hasTempExpiry ? ", temporary_password_expires_at" : ", NULL AS temporary_password_expires_at";
        $firstLoginCol .= $hasPasswordChanged ? ", password_changed_at" : ", NULL AS password_changed_at";
        $stmt = $mysqli->prepare("SELECT user_id, role_id, dept_id, first_name, last_name, id_number, email, password_hash, status{$permissionCols}{$firstLoginCol} FROM tbl_users WHERE email = ? OR id_number = ? LIMIT 1");
        $stmt->bind_param("ss", $identifier, $identifier);
        $stmt->execute();
        $result = $stmt->get_result();
        $user = $result->fetch_assoc();

        // If the account exists but is inactive/archived, deny login immediately
        if ($user) {
            if (!app_user_status_is_active($user['status'] ?? null)) {
                json_response([
                    'error' => 'account_inactive',
                    'message' => 'Account is inactive or archived. Please contact your administrator.'
                ], 403);
            }
        }

        if (!$user || !password_verify($password, $user['password_hash'])) {
            // Log failed attempt
            $failedUserId = $user ? (int)$user['user_id'] : null;
            $logStmt = $mysqli->prepare("INSERT INTO tbl_login_attempts (email, user_id, status, ip_address, details) VALUES (?, ?, 'failed', ?, 'Invalid password')");
            if ($logStmt) {
                $logStmt->bind_param("sis", $identifier, $failedUserId, $clientIp);
                $logStmt->execute();
                $logStmt->close();
            }

            // Handle failed attempt using the server-enforced security policy.
            $failed = $lockFailedAttempts + 1;
            $lockSeconds = 0;

            if ($failed >= $policy['max_login_attempts']) {
                $lockSeconds = $policy['lock_duration_seconds'];
                $lockUntilTime = date('Y-m-d H:i:s', time() + $lockSeconds);
                // reset failed_attempts back to 0 while locked
                $up = $mysqli->prepare("INSERT INTO tbl_login_locks (email, failed_attempts, lock_until)
                    VALUES (?, 0, ?)
                    ON DUPLICATE KEY UPDATE failed_attempts = VALUES(failed_attempts), lock_until = VALUES(lock_until)");
                if ($up) {
                    $up->bind_param("ss", $identifier, $lockUntilTime);
                    $up->execute();
                    $up->close();
                }
                json_response([
                    'error' => 'account_locked',
                    'message' => 'Sign-in is temporarily unavailable due to repeated failed attempts. Please try again shortly.',
                    'remaining_seconds' => $lockSeconds
                ], 429);
            } else {
                // just update failed_attempts and tell client how many tries are left before lock
                $up = $mysqli->prepare("INSERT INTO tbl_login_locks (email, failed_attempts, lock_until)
                    VALUES (?, ?, NULL)
                    ON DUPLICATE KEY UPDATE failed_attempts = VALUES(failed_attempts), lock_until = NULL");
                if ($up) {
                    $up->bind_param("si", $identifier, $failed);
                    $up->execute();
                    $up->close();
                }
                $remaining = max(0, $policy['max_login_attempts'] - $failed);
                json_response([
                    'error' => 'Invalid email or password',
                    'remaining_attempts' => $remaining
                ], 401);
            }
        }

        if (!empty($user['temporary_password_expires_at']) && strtotime($user['temporary_password_expires_at']) < time()) {
            json_response(['error'=>'temporary_password_expired','message'=>'The temporary password expired. Ask an administrator to send a new one.'], 401);
        }

        $passwordChangeReason = !empty($user['is_first_login']) ? 'required' : null;
        if (empty($user['is_first_login']) && security_password_is_expired($user['password_changed_at'] ?? null, $policy)) {
            $forceChange = $mysqli->prepare('UPDATE tbl_users SET is_first_login = 1 WHERE user_id = ?');
            if (!$forceChange) throw new RuntimeException('Unable to enforce password expiration.');
            $expiredUserId = (int)$user['user_id'];
            $forceChange->bind_param('i', $expiredUserId);
            if (!$forceChange->execute()) {
                $forceChange->close();
                throw new RuntimeException('Unable to enforce password expiration.');
            }
            $forceChange->close();
            $user['is_first_login'] = 1;
            $passwordChangeReason = 'expired';
        }

        // Log successful login
        $logSuccess = $mysqli->prepare("INSERT INTO tbl_login_attempts (email, user_id, status, ip_address, details) VALUES (?, ?, 'success', ?, 'Login successful')");
        if ($logSuccess) {
            $uid = (int)$user['user_id'];
            $logSuccess->bind_param("sis", $identifier, $uid, $clientIp);
            $logSuccess->execute();
            $logSuccess->close();
        }

        // Successful login: clear any lock state for this email
        $clear = $mysqli->prepare("DELETE FROM tbl_login_locks WHERE email = ?");
        if ($clear) {
            $clear->bind_param("s", $identifier);
            $clear->execute();
            $clear->close();
        }

        $sessionMeta = app_create_database_session(
            $mysqli,
            (int)$user['user_id'],
            (int)($user['token_version'] ?? 0),
            $policy
        );

        // Keep session storage small without requiring cron. Cleanup is
        // best-effort and never prevents an otherwise successful login.
        try {
            security_maybe_cleanup_old_sessions($mysqli, 7, 1);
        } catch (Throwable $cleanupError) {
            error_log('Session cleanup skipped after an internal maintenance error.');
        }
        header('Cache-Control: no-store');

        json_response([
            'session' => [
                'idle_timeout_seconds' => $sessionMeta['idle_timeout_seconds'],
                'absolute_expires_at' => $sessionMeta['absolute_expires_at'],
                'absolute_expires_at_unix' => $sessionMeta['absolute_expires_at_unix'],
            ],
            'user' => [
                'user_id' => $user['user_id'],
                'first_name' => $user['first_name'],
                'last_name' => $user['last_name'],
                'id_number' => isset($user['id_number']) ? (string)$user['id_number'] : '',
                'email' => $user['email'],
                'role_id' => $user['role_id'],
                'dept_id' => $user['dept_id'],
                'is_first_login' => isset($user['is_first_login']) ? (int)$user['is_first_login'] : 0,
                'password_change_reason' => $passwordChangeReason,
                'password_expires_at' => security_password_expires_at($user['password_changed_at'] ?? null, $policy),
                'permission_mode' => $hasUserModulePermissions ? ($user['permission_mode'] ?? 'default') : 'default',
                'module_permissions' => $hasUserModulePermissions ? $decode_module_permissions($user['module_permissions'] ?? null) : ['allow' => [], 'deny' => []],
            ]
        ]);
    } catch (Throwable $e) {
        json_response(['error' => 'An internal server error occurred during login.', 'details' => $e->getMessage()], 500);
    }
} else {
    json_response(['error' => 'method_not_allowed'], 405);
}
