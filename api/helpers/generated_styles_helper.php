<?php
declare(strict_types=1);

// A fresh source fingerprint makes edits safe without a watcher/build command.
function app_style_source_fingerprint(string $root): string {
    $paths = ['public/index.html'];
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root . '/src', FilesystemIterator::SKIP_DOTS));
    foreach ($iterator as $file) {
        if ($file->isFile() && in_array(strtolower($file->getExtension()), ['js','jsx','css'], true)) {
            $paths[] = str_replace('\\', '/', substr($file->getPathname(), strlen($root) + 1));
        }
    }
    sort($paths, SORT_STRING);
    $context = hash_init('sha256');
    foreach ($paths as $path) hash_update($context, $path . "\0" . hash_file('sha256', $root . '/' . $path) . "\n");
    return hash_final($context);
}

function app_apply_generated_styles(string $html, string $root): string {
    $directory = $root . '/public/vendor/tailwind';
    $manifest = is_file($directory . '/generated-manifest.json') ? json_decode(file_get_contents($directory . '/generated-manifest.json'), true) : null;
    $valid = is_array($manifest) && is_file($directory . '/generated.min.css')
        && hash_equals((string)($manifest['source_hash'] ?? ''), app_style_source_fingerprint($root))
        && hash_equals((string)($manifest['css_hash'] ?? ''), hash_file('sha256', $directory . '/generated.min.css'));
    $tag = $valid
        ? '<link rel="stylesheet" href="vendor/tailwind/generated.min.css" data-tailwind-mode="generated">'
        : '<script src="vendor/tailwind/tailwindcss.js" data-tailwind-mode="automatic-fallback"></script>';
    return str_replace('<!-- APP_TAILWIND_STYLES -->', $tag, $html);
}
