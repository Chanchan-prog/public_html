<?php

function security_policy_defaults() {
    return [
        'max_login_attempts' => 10,
        'lock_duration_seconds' => 30,
        'idle_timeout_minutes' => 60,
        'absolute_session_minutes' => 480,
        'password_expiry_days' => 30,
        'password_min_length' => 8,
        'password_require_letter' => 1,
        'password_require_number' => 1,
        'password_require_special' => 1,
    ];
}

function security_schema_ensure($mysqli) {
    static $ready = false;
    if ($ready) return;

    $definitions = [
        'token_version' => 'INT UNSIGNED NOT NULL DEFAULT 0',
        'temporary_password_expires_at' => 'DATETIME NULL DEFAULT NULL',
        'temporary_password_sent_at' => 'DATETIME NULL DEFAULT NULL',
        'password_changed_at' => 'DATETIME NULL DEFAULT NULL',
    ];
    foreach ($definitions as $column=>$definition) {
        $res=$mysqli->query("SHOW COLUMNS FROM tbl_users LIKE '{$column}'");
        if (!$res || $res->num_rows===0) $mysqli->query("ALTER TABLE tbl_users ADD COLUMN {$column} {$definition}");
    }
    $mysqli->query("CREATE TABLE IF NOT EXISTS tbl_user_sessions (session_id CHAR(64) PRIMARY KEY,user_id INT NOT NULL,token_version INT UNSIGNED NOT NULL DEFAULT 0,csrf_token_hash CHAR(64) NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,last_activity_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,absolute_expires_at DATETIME NOT NULL,revoked_at DATETIME NULL,KEY idx_user_sessions_user(user_id),KEY idx_user_sessions_expiry(absolute_expires_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $csrfColumn = $mysqli->query("SHOW COLUMNS FROM tbl_user_sessions LIKE 'csrf_token_hash'");
    if (!$csrfColumn || $csrfColumn->num_rows === 0) {
        $mysqli->query("ALTER TABLE tbl_user_sessions ADD COLUMN csrf_token_hash CHAR(64) NULL AFTER token_version");
    }
    $mysqli->query("CREATE TABLE IF NOT EXISTS tbl_password_history (
        history_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (history_id),
        KEY idx_password_history_user (user_id, history_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    // Existing accounts begin their first 30-day cycle when this feature is
    // installed. New first-login accounts receive the authoritative timestamp
    // when they replace their temporary password.
    $mysqli->query("UPDATE tbl_users SET password_changed_at = NOW() WHERE password_changed_at IS NULL");
    $ready = true;
}

/**
 * Remove only session records that have been unusable for longer than the
 * retention period. Active sessions and recently expired/revoked sessions are
 * deliberately preserved.
 */
function security_cleanup_old_sessions($mysqli, $retentionDays = 7) {
    if (!($mysqli instanceof mysqli)) return 0;

    $days = max(1, min(3650, (int)$retentionDays));
    $sql = "DELETE FROM tbl_user_sessions
            WHERE absolute_expires_at < DATE_SUB(NOW(), INTERVAL {$days} DAY)
               OR (revoked_at IS NOT NULL AND revoked_at < DATE_SUB(NOW(), INTERVAL {$days} DAY))";
    $stmt = $mysqli->prepare($sql);
    if (!$stmt) {
        error_log('Session cleanup could not be prepared.');
        return 0;
    }

    if (!$stmt->execute()) {
        error_log('Session cleanup could not be completed.');
        $stmt->close();
        return 0;
    }

    $deletedRows = max(0, (int)$stmt->affected_rows);
    $stmt->close();
    if ($deletedRows > 0) {
        error_log("Session maintenance removed {$deletedRows} expired or revoked record(s) older than {$days} days.");
    }
    return $deletedRows;
}

/**
 * Run lightweight cleanup occasionally after a successful login. At the
 * default 1% chance, roughly 250 daily logins trigger about 2-3 cleanups.
 */
function security_maybe_cleanup_old_sessions($mysqli, $retentionDays = 7, $chancePercent = 1) {
    $chance = max(0, min(100, (int)$chancePercent));
    if ($chance === 0 || random_int(1, 100) > $chance) return 0;
    return security_cleanup_old_sessions($mysqli, $retentionDays);
}

function security_policy_limits() {
    return [
        'max_login_attempts' => [3, 20],
        'lock_duration_seconds' => [30, 3600],
        'idle_timeout_minutes' => [5, 120],
        'absolute_session_minutes' => [15, 1440],
        'password_expiry_days' => [1, 365],
        'password_min_length' => [8, 64],
    ];
}

function security_policy_ensure_table($mysqli) {
    return $mysqli->query("CREATE TABLE IF NOT EXISTS `tbl_app_settings` (
        `setting_id` INT NOT NULL AUTO_INCREMENT,
        `setting_group` VARCHAR(100) NOT NULL,
        `dept_id` INT NULL DEFAULT NULL,
        `setting_key` VARCHAR(100) NOT NULL,
        `setting_value` TEXT NULL,
        `value_type` VARCHAR(50) NOT NULL DEFAULT 'text',
        `updated_by` INT NULL,
        `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (`setting_id`),
        UNIQUE KEY `unique_setting` (`setting_group`, `setting_key`, `dept_id`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
}

function security_policy_get($mysqli) {
    $policy = security_policy_defaults();
    if (!security_policy_ensure_table($mysqli)) return $policy;
    $res = $mysqli->query("SELECT setting_key, setting_value FROM tbl_app_settings WHERE setting_group='security' AND dept_id IS NULL");
    if ($res) while ($row = $res->fetch_assoc()) {
        $key = (string)$row['setting_key'];
        if (array_key_exists($key, $policy)) $policy[$key] = (int)$row['setting_value'];
    }
    return security_policy_normalize($policy);
}

function security_policy_normalize($input) {
    $out = security_policy_defaults();
    foreach (security_policy_limits() as $key => $range) {
        $value = isset($input[$key]) ? (int)$input[$key] : $out[$key];
        $out[$key] = max($range[0], min($range[1], $value));
    }
    foreach (['password_require_letter','password_require_number','password_require_special'] as $key) {
        $out[$key] = !empty($input[$key]) ? 1 : 0;
    }
    return $out;
}

function security_policy_validate_password($password, $policy = null) {
    $policy = is_array($policy) ? security_policy_normalize($policy) : security_policy_defaults();
    if (!is_string($password) || strlen($password) < $policy['password_min_length']) return "Password must be at least {$policy['password_min_length']} characters long.";
    if ($policy['password_require_letter'] && !preg_match('/[A-Za-z]/', $password)) return 'Password must include a letter.';
    if ($policy['password_require_number'] && !preg_match('/[0-9]/', $password)) return 'Password must include a number.';
    if ($policy['password_require_special'] && !preg_match('/[^A-Za-z0-9]/', $password)) return 'Password must include a special character.';
    return null;
}

function security_password_is_expired($passwordChangedAt, $policy = null, $nowTimestamp = null) {
    $policy = is_array($policy) ? security_policy_normalize($policy) : security_policy_defaults();
    $changedTimestamp = strtotime((string)$passwordChangedAt);
    if ($changedTimestamp === false || $changedTimestamp <= 0) return false;
    $now = $nowTimestamp === null ? time() : (int)$nowTimestamp;
    return $changedTimestamp + ((int)$policy['password_expiry_days'] * 86400) <= $now;
}

function security_password_expires_at($passwordChangedAt, $policy = null) {
    $policy = is_array($policy) ? security_policy_normalize($policy) : security_policy_defaults();
    $changedTimestamp = strtotime((string)$passwordChangedAt);
    if ($changedTimestamp === false || $changedTimestamp <= 0) return null;
    return date('Y-m-d H:i:s', $changedTimestamp + ((int)$policy['password_expiry_days'] * 86400));
}

function security_password_was_used($mysqli, $userId, $candidatePassword, $currentHash = null) {
    $uid = (int)$userId;
    if ($uid <= 0 || !is_string($candidatePassword)) return false;
    if (is_string($currentHash) && $currentHash !== '' && password_verify($candidatePassword, $currentHash)) {
        return true;
    }

    security_schema_ensure($mysqli);
    $stmt = $mysqli->prepare('SELECT password_hash FROM tbl_password_history WHERE user_id = ? ORDER BY history_id DESC');
    if (!$stmt) throw new RuntimeException('Unable to check password history.');
    $stmt->bind_param('i', $uid);
    if (!$stmt->execute()) {
        $stmt->close();
        throw new RuntimeException('Unable to check password history.');
    }
    $result = $stmt->get_result();
    while ($row = $result->fetch_assoc()) {
        $historicalHash = (string)($row['password_hash'] ?? '');
        if ($historicalHash !== '' && password_verify($candidatePassword, $historicalHash)) {
            $stmt->close();
            return true;
        }
    }
    $stmt->close();
    return false;
}

function security_password_remember_hash($mysqli, $userId, $passwordHash) {
    $uid = (int)$userId;
    $hash = trim((string)$passwordHash);
    if ($uid <= 0 || $hash === '') return false;
    security_schema_ensure($mysqli);
    $stmt = $mysqli->prepare('INSERT INTO tbl_password_history (user_id, password_hash, created_at) VALUES (?, ?, NOW())');
    if (!$stmt) return false;
    $stmt->bind_param('is', $uid, $hash);
    $ok = $stmt->execute();
    $stmt->close();
    return (bool)$ok;
}

function security_policy_generate_temporary_password($length = 16) {
    $upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; $lower = 'abcdefghijkmnopqrstuvwxyz';
    $digits = '23456789'; $special = '!@#$%*-_';
    $all = $upper . $lower . $digits . $special;
    $chars = [$upper[random_int(0, strlen($upper)-1)], $lower[random_int(0, strlen($lower)-1)], $digits[random_int(0, strlen($digits)-1)], $special[random_int(0, strlen($special)-1)]];
    while (count($chars) < $length) $chars[] = $all[random_int(0, strlen($all)-1)];
    for ($i=count($chars)-1; $i>0; $i--) { $j=random_int(0,$i); [$chars[$i],$chars[$j]]=[$chars[$j],$chars[$i]]; }
    return implode('', $chars);
}
