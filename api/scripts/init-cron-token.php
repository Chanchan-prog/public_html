<?php
// api/scripts/init-cron-token.php
//
// Creates (or rotates) the secret token used by the HTTP scheduler trigger.
// Run once per deployment:
//
//     php api/scripts/init-cron-token.php
//     php api/scripts/init-cron-token.php --rotate
//
// Then register the printed URL with Vercel Cron, an external cron service, or
// a cPanel "wget/curl" cron job. The token is stored in
// api/config/cron-token.php, which api/.htaccess blocks from HTTP access.

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    echo "CLI only. Run this from the command line.\n";
    exit(1);
}

require_once __DIR__ . '/../helpers/cron_token_helper.php';

$rotate = in_array('--rotate', array_slice($argv, 1), true);
$path = cron_token_config_path();

if (is_file($path) && !$rotate) {
    echo "A scheduler token already exists and was left unchanged.\n";
    echo "Use --rotate to replace it; existing cron URLs must then be updated.\n";
    exit(0);
}

$token = bin2hex(random_bytes(32));
$content = "<?php\n// Private scheduler token. Never commit or share.\nreturn "
    . var_export(['token' => $token], true) . ";\n";
if (@file_put_contents($path, $content, LOCK_EX) === false) {
    fwrite(STDERR, "Unable to write {$path}. Create that file manually with the same array shape.\n");
    exit(1);
}
@chmod($path, 0600);

$host = trim((string)(getenv('APP_PUBLIC_HOST') ?: ''));
$basePath = rtrim(trim((string)(getenv('APP_BASE_PATH') ?: '')), '/');
$pathPart = $basePath . '/api/cron?token=' . $token;
$url = $host !== '' ? 'https://' . $host . $pathPart : $pathPart;

echo "Scheduler token written to {$path}.\n";
echo "Register this URL with the scheduler and keep it private:\n{$url}\n";
echo "Manual test: curl -s \"{$url}\"\n";