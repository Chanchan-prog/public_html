<?php
declare(strict_types=1);

function reset_secret(): string {
    $config = require __DIR__ . '/../config/security.php';
    $secret = (string)($config['reset_secret'] ?? '');
    if (strlen($secret) < 32) throw new RuntimeException('Private reset settings are missing.');
    return $secret;
}

function reset_verifier(string $email, string $otp): string {
    return hash_hmac('sha256', strtolower(trim($email)) . "\0" . $otp, reset_secret());
}

function reset_schema(mysqli $db): void {
    $db->query("CREATE TABLE IF NOT EXISTS tbl_password_reset_secure (
        email VARCHAR(255) PRIMARY KEY, verifier CHAR(64) NOT NULL,
        expires_at BIGINT NOT NULL, attempts INT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $db->query("CREATE TABLE IF NOT EXISTS tbl_password_reset_limits (
        bucket CHAR(64) PRIMARY KEY, hits INT NOT NULL, started BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $db->query('DELETE FROM tbl_password_reset_limits WHERE started < UNIX_TIMESTAMP() - 86400 LIMIT 100');
    $db->query('DELETE FROM tbl_password_reset_secure WHERE expires_at < UNIX_TIMESTAMP() LIMIT 100');
    // Old plaintext codes are deliberately not accepted after this migration.
    $legacy = $db->query("SHOW TABLES LIKE 'tbl_password_reset_otps'");
    if ($legacy->num_rows) $db->query('DELETE FROM tbl_password_reset_otps');
}

// Database row locks make concurrent requests share the same allowance.
function reset_rate_limit(mysqli $db, string $scope, string $identity, int $limit, int $seconds): int {
    $key = hash_hmac('sha256', $scope . "\0" . strtolower(trim($identity)), reset_secret());
    $now = time();
    $db->begin_transaction();
    try {
        $s = $db->prepare('INSERT IGNORE INTO tbl_password_reset_limits (bucket,hits,started) VALUES (?,0,?)');
        $s->bind_param('si', $key, $now); $s->execute(); $s->close();
        $s = $db->prepare('SELECT hits,started FROM tbl_password_reset_limits WHERE bucket=? FOR UPDATE');
        $s->bind_param('s', $key); $s->execute(); $row=$s->get_result()->fetch_assoc(); $s->close();
        $start=(int)$row['started']; $hits=(int)$row['hits'];
        if ($now >= $start+$seconds) { $start=$now; $hits=0; }
        $wait = $hits >= $limit ? max(1, $start+$seconds-$now) : 0;
        if (!$wait) {
            $hits++;
            $s=$db->prepare('UPDATE tbl_password_reset_limits SET hits=?,started=? WHERE bucket=?');
            $s->bind_param('iis',$hits,$start,$key); $s->execute(); $s->close();
        }
        $db->commit(); return $wait;
    } catch (Throwable $e) { $db->rollback(); throw $e; }
}

function reset_enforce_limit(mysqli $db, string $scope, string $identity, int $limit, int $seconds): void {
    $wait=reset_rate_limit($db,$scope,$identity,$limit,$seconds);
    if ($wait) {
        header('Retry-After: ' . $wait);
        json_response(['error'=>'reset_rate_limited','message'=>"Too many reset requests. Please wait {$wait} seconds and try again.", 'retry_after'=>$wait],429);
    }
}

function reset_store_code(mysqli $db, string $email, string $otp): void {
    $verifier=reset_verifier($email,$otp); $expires=time()+120;
    $s=$db->prepare('INSERT INTO tbl_password_reset_secure (email,verifier,expires_at,attempts) VALUES (?,?,?,0) ON DUPLICATE KEY UPDATE verifier=VALUES(verifier), expires_at=VALUES(expires_at), attempts=0');
    $s->bind_param('ssi',$email,$verifier,$expires); $s->execute(); $s->close();
}

// Successful password update and consuming the code happen in one transaction.
function reset_consume_code(mysqli $db, string $email, string $otp, callable $updatePassword): array {
    $db->begin_transaction();
    try {
        $s=$db->prepare('SELECT verifier,expires_at,attempts FROM tbl_password_reset_secure WHERE email=? FOR UPDATE');
        $s->bind_param('s',$email); $s->execute(); $row=$s->get_result()->fetch_assoc(); $s->close();
        if (!$row || (int)$row['expires_at'] <= time() || (int)$row['attempts'] >= 5) {
            $db->commit(); return ['ok'=>false,'message'=>'Invalid or expired code. Please request a new code.'];
        }
        if (!hash_equals($row['verifier'],reset_verifier($email,$otp))) {
            $attempts=(int)$row['attempts']+1;
            $s=$db->prepare('UPDATE tbl_password_reset_secure SET attempts=? WHERE email=?');
            $s->bind_param('is',$attempts,$email); $s->execute(); $s->close();
            $db->commit();
            return ['ok'=>false,'remaining_attempts'=>5-$attempts,'message'=>$attempts>=5 ? 'Too many incorrect codes. Please request a new code.' : 'Incorrect code. Please try again.'];
        }
        $updatePassword();
        $s=$db->prepare('DELETE FROM tbl_password_reset_secure WHERE email=?');
        $s->bind_param('s',$email); $s->execute(); $s->close();
        $db->commit(); return ['ok'=>true];
    } catch (Throwable $e) { $db->rollback(); throw $e; }
}
