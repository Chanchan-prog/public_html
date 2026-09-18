<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(403); exit; }
require_once __DIR__ . '/../helpers/push_notification_helper.php';
require_once __DIR__ . '/../vendor/autoload.php';
push_prepare_openssl_config();
$path = __DIR__ . '/../config/private-security.php';
if (is_file($path)) { echo "Private security settings already exist; left unchanged.\n"; exit; }
$options = ['private_key_type'=>OPENSSL_KEYTYPE_EC, 'curve_name'=>'prime256v1'];
if (getenv('OPENSSL_CONF')) $options['config'] = getenv('OPENSSL_CONF');
$key = openssl_pkey_new($options);
if (!$key) throw new RuntimeException('Unable to generate the deployment push key.');
$ec = openssl_pkey_get_details($key)['ec'];
$encode = static fn($bytes) => rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
$vapid = [
    'publicKey'=>$encode("\x04" . str_pad($ec['x'],32,"\0",STR_PAD_LEFT) . str_pad($ec['y'],32,"\0",STR_PAD_LEFT)),
    'privateKey'=>$encode(str_pad($ec['d'],32,"\0",STR_PAD_LEFT)),
];
$settings = ['reset_secret'=>bin2hex(random_bytes(32)), 'vapid_public_key'=>$vapid['publicKey'], 'vapid_private_key'=>$vapid['privateKey']];
$handle = fopen($path, 'x');
if (!$handle) throw new RuntimeException('Cannot create private settings.');
try {
    $content = "<?php\n// Private deployment secrets. Never commit or share.\nreturn " . var_export($settings, true) . ";\n";
    if (fwrite($handle, $content) !== strlen($content)) throw new RuntimeException('Could not save private settings.');
} finally { fclose($handle); }
@chmod($path, 0600);
echo "Created private reset secret and new VAPID keys. Secret values were not printed.\n";
