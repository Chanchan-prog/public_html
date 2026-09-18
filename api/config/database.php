<?php
// api/config/database.php

// Use Philippine time for this application regardless of the computer or
// hosting provider's default PHP timezone.
date_default_timezone_set('Asia/Manila');

$db_host = getenv('DB_HOST') ?: 'db.fr-roub1.bengt.wasmernet.com';
$db_port = (int)(getenv('DB_PORT') ?: 20184);
$db_user = getenv('DB_USER') ?: 'user_720eaff7';
$db_pass_env = getenv('DB_PASS') ?: 'pw_e4JfJFghNxOeTMWSaSikaj9P6gziTZtm';
$db_pass = $db_pass_env === false ? '' : (string)$db_pass_env;
$db_name = getenv('DB_NAME') ?: 'bk_teacher_gps3';
try {
  $mysqli = new mysqli($db_host, $db_user, $db_pass, $db_name, $db_port);
  if ($mysqli->connect_error) {
    throw new RuntimeException($mysqli->connect_error);
  }

  // Apply the same timezone to this MySQL session. This keeps NOW(),
  // CURDATE(), CURRENT_TIMESTAMP, session expiry, cron work, and stored
  // application timestamps consistent on XAMPP and hosted servers.
  if (!$mysqli->query("SET time_zone = '+08:00'")) {
    throw new RuntimeException('Unable to configure the database timezone: ' . $mysqli->error);
  }
} catch (Throwable $error) {
  error_log('[database connection] ' . $error->getMessage());
  if (PHP_SAPI === 'cli') {
    // Cron jobs and CLI diagnostics must fail loudly instead of printing an
    // HTTP response and reporting success, and the message must name the
    // configured account so the hosting fix is obvious.
    fwrite(STDERR, 'Database connection failed for ' . $db_user . '@' . $db_host . ':' . $db_port
      . ' database ' . $db_name . ' - ' . $error->getMessage() . PHP_EOL);
    exit(1);
  }
  http_response_code(500);
  header('Content-Type: application/json');
  echo json_encode(['error' => 'database_unavailable', 'message' => 'Unable to connect to the database. Please try again later.']);
  exit;
}
