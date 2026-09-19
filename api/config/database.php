<?php
// api/config/database.php

// Use Philippine time for this application regardless of the computer or
// hosting provider's default PHP timezone.
date_default_timezone_set('Asia/Manila');

/*
 * Production credentials must never be committed in this file. cPanel PHP
 * processes do not always inherit website environment variables, so a private
 * PHP file is supported as well as DB_* environment variables. Copy
 * database.private.php.example to database.private.php and fill it only on
 * the server (or configure the environment variables in the host panel).
 */
$databasePrivateFile = __DIR__ . '/database.private.php';
$databasePrivate = is_file($databasePrivateFile) ? require $databasePrivateFile : [];
if (!is_array($databasePrivate)) $databasePrivate = [];

$databaseValue = static function (string $environmentName, string $privateKey, $default = '') use ($databasePrivate) {
    $environmentValue = getenv($environmentName);
    if ($environmentValue !== false) return $environmentValue;
    if (array_key_exists($privateKey, $databasePrivate)) return $databasePrivate[$privateKey];
    return $default;
};

// Keep the checked-out project convenient in Windows/XAMPP, but never attempt
// to use the XAMPP root account on a Unix production host without an explicit
// configuration. That was the cause of the hosted API/cron connection errors.
$isWindowsDevelopment = DIRECTORY_SEPARATOR === '\\';
$developmentEnvironment = in_array(strtolower((string)getenv('APP_ENV')), ['local', 'development', 'dev'], true);
$allowDevelopmentDefaults = $isWindowsDevelopment || $developmentEnvironment;

$db_host = trim((string)$databaseValue('DB_HOST', 'host', 'localhost'));
$db_port = (int)$databaseValue('DB_PORT', 'port', 3306);
$db_user = trim((string)$databaseValue('DB_USER', 'user', $allowDevelopmentDefaults ? 'root' : ''));
$db_pass = (string)$databaseValue('DB_PASS', 'pass', '');
$db_name = trim((string)$databaseValue('DB_NAME', 'name', $allowDevelopmentDefaults ? 'bk_teacher_gps3' : ''));

try {
  if ($db_host === '' || $db_user === '' || $db_name === '') {
    throw new RuntimeException('Database configuration is missing. Set DB_HOST, DB_PORT, DB_NAME, DB_USER and DB_PASS, or create config/database.private.php.');
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
