<?php
// api/config/database.php

// Use Philippine time for this application regardless of the computer or
// hosting provider's default PHP timezone.
date_default_timezone_set('Asia/Manila');

/*
 * Production credentials must never be committed in this file. Railway
 * provides MYSQLHOST, MYSQLPORT, MYSQLUSER, MYSQLPASSWORD and MYSQLDATABASE
 * automatically to services in the same project. DB_* variables remain
 * supported for other hosting and local development.
 */

$databaseValue = static function (string $environmentName, $default = '') {
    $environmentValue = getenv($environmentName);
    if ($environmentValue !== false) return $environmentValue;
    return $default;
};

$databaseValueAlias = static function (string $privateKey, $default = '') use ($databaseValue) {
    // Railway MySQL exports MYSQLHOST / MYSQLPORT / MYSQLUSER /
    // MYSQLPASSWORD / MYSQLDATABASE. The underscore variants are accepted
    // too for compatibility with other MySQL providers.
    $aliasMap = [
        'host' => ['MYSQLHOST', 'MYSQL_HOST'],
        'port' => ['MYSQLPORT', 'MYSQL_PORT'],
        'user' => ['MYSQLUSER', 'MYSQL_USER'],
        'pass' => ['MYSQLPASSWORD', 'MYSQL_PASSWORD'],
        'name' => ['MYSQLDATABASE', 'MYSQL_DATABASE'],
    ];
    $envName = 'DB_' . strtoupper($privateKey === 'pass' ? 'PASS' : $privateKey);
    $primary = $databaseValue($envName, null);
    if ($primary !== null) return $primary;
    foreach ($aliasMap[$privateKey] ?? [] as $alias) {
        $value = getenv($alias);
        if ($value !== false && trim((string)$value) !== '') return trim((string)$value);
    }
    return $default;
};
$db_host = trim((string)$databaseValueAlias('host'));
$db_port = (int)$databaseValueAlias('port', 3306);
$db_user = trim((string)$databaseValueAlias('user'));
$db_pass = (string)$databaseValueAlias('pass');
$db_name = trim((string)$databaseValueAlias('name'));

try {
  if (!extension_loaded('mysqli')) {
    throw new RuntimeException('The mysqli PHP extension is not installed. Add ext-mysqli to composer.json or set RAILPACK_PHP_EXTENSIONS=mysqli.');
  }
  if ($db_host === '' || $db_user === '' || $db_name === '') {
    throw new RuntimeException('Database configuration is missing. In Railway, link the MySQL service so MYSQLHOST, MYSQLPORT, MYSQLUSER, MYSQLPASSWORD and MYSQLDATABASE are injected. Otherwise set DB_HOST, DB_PORT, DB_NAME, DB_USER and DB_PASS.');
  }
  if ($db_port < 1 || $db_port > 65535) {
    throw new RuntimeException('Database port must be between 1 and 65535.');
  }

  $mysqli = new mysqli($db_host, $db_user, $db_pass, $db_name, $db_port);
  if ($mysqli->connect_error) {
    throw new RuntimeException($mysqli->connect_error);
  }
  if (!$mysqli->set_charset('utf8mb4')) {
    throw new RuntimeException('Unable to configure the database character set: ' . $mysqli->error);
  }

  // Apply the same timezone to this MySQL session. This keeps NOW(),
  // CURDATE(), CURRENT_TIMESTAMP, session expiry, cron work, and stored
  // application timestamps consistent on XAMPP and hosted servers.
  if (!$mysqli->query("SET time_zone = '+08:00'")) {
    throw new RuntimeException('Unable to configure the database timezone: ' . $mysqli->error);
  }
} catch (Throwable $error) {
  error_log('[database connection] ' . $error->getMessage());
  http_response_code(500);
  header('Content-Type: application/json');
  echo json_encode(['error' => 'database_unavailable', 'message' => 'Unable to connect to the database. Please try again later.']);
  exit;
}
