<?php

// Windows/XAMPP may not load openssl.cnf globally. Web Push creates a fresh
// P-256 encryption key for every payload, so pass the project-discovered
// OPENSSL_CONF file directly to openssl_pkey_new().
$file = dirname(__DIR__) . '/vendor/minishlink/web-push/src/Encryption.php';
if (!is_file($file)) {
    fwrite(STDERR, "Web Push dependency is not installed; compatibility patch skipped.\n");
    exit(0);
}

$source = file_get_contents($file);
if ($source === false) {
    fwrite(STDERR, "Unable to read Web Push Encryption.php.\n");
    exit(1);
}
if (strpos($source, "getenv('WEB_PUSH_OPENSSL_CONFIG')") !== false) {
    exit(0);
}

$before = <<<'PHP'
        $keyResource = openssl_pkey_new([
            'curve_name'       => 'prime256v1',
            'private_key_type' => OPENSSL_KEYTYPE_EC,
        ]);
PHP;
$after = <<<'PHP'
        $keyOptions = [
            'curve_name'       => 'prime256v1',
            'private_key_type' => OPENSSL_KEYTYPE_EC,
        ];
        $opensslConfig = trim((string) (getenv('WEB_PUSH_OPENSSL_CONFIG') ?: getenv('OPENSSL_CONF')));
        if ($opensslConfig !== '' && is_file($opensslConfig)) {
            $keyOptions['config'] = $opensslConfig;
        }
        $keyResource = openssl_pkey_new($keyOptions);
PHP;

$patched = str_replace($before, $after, $source, $count);
if ($count !== 1 || file_put_contents($file, $patched) === false) {
    fwrite(STDERR, "Unable to apply the Web Push OpenSSL compatibility patch.\n");
    exit(1);
}

echo "Applied Web Push OpenSSL compatibility patch.\n";
