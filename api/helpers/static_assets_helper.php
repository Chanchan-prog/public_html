<?php
declare(strict_types=1);

// Versioned URLs change automatically after edits without a manual release step.
// Text assets use content hashes. Large bundled 3D models use a modification
// time + size fingerprint so rendering index.php never has to re-read 100+ MB.
function app_static_versions(string $root, string $base): array {
    $versions = [];
    $groups = [
        ['folder' => 'src', 'extensions' => ['js', 'jsx', 'css'], 'content_hash' => true],
        ['folder' => 'public/vendor', 'extensions' => ['js', 'jsx', 'css'], 'content_hash' => true],
        ['folder' => 'public/building/models', 'extensions' => ['glb', 'gltf', 'bin'], 'content_hash' => false],
    ];

    foreach ($groups as $group) {
        $folder = $group['folder'];
        $directory = $root . '/' . $folder;
        if (!is_dir($directory)) continue;
        $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS));
        foreach ($iterator as $file) {
            if (!$file->isFile() || !in_array(strtolower($file->getExtension()), $group['extensions'], true)) continue;
            $relative = str_replace('\\', '/', substr($file->getPathname(), strlen($root) + 1));
            $fingerprint = $group['content_hash']
                ? hash_file('sha256', $file->getPathname())
                : hash('sha256', $file->getMTime() . ':' . $file->getSize());
            $versions[$base . '/' . $relative] = substr($fingerprint, 0, 20);
        }
    }
    return $versions;
}

function app_version_html_assets(string $html, array $versions, string $base): string {
    require_once __DIR__ . '/generated_styles_helper.php';
    $html = app_apply_generated_styles($html, dirname(__DIR__, 2));
    $html = preg_replace_callback('~\b(src|href)="([^"?#]+)"~', static function ($match) use ($versions, $base) {
        $path = $match[2];
        if (str_starts_with($path, '../src/')) $key = $base . '/' . substr($path, 3);
        elseif (str_starts_with($path, 'vendor/')) $key = $base . '/public/' . $path;
        else return $match[0];
        return isset($versions[$key]) ? $match[1] . '="' . $path . '?v=' . $versions[$key] . '"' : $match[0];
    }, $html);
    $bootstrap = '<script>window.APP_ASSET_VERSIONS=' . json_encode($versions, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) . ';</script>';
    return preg_replace('~<head(\s[^>]*)?>~i', '$0' . "\n" . $bootstrap, $html, 1);
}
