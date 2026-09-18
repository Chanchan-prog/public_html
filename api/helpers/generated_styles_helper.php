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
    // Support both the flattened web-root upload and the sibling
    // front-end/api layout used by this repository.
    $appRoot = $root;
    if (!is_dir($appRoot . '/src') && is_dir($root . '/front-end/src')) {
        $appRoot = $root . '/front-end';
    }
    $directory = $appRoot . '/public/vendor/tailwind';
    // The generated stylesheet is served as a normal versioned static asset.
    // Re-hashing every JSX/CSS source file here does not regenerate it and was
    // needlessly blocking each initial HTML response.
    $tag = '<link rel="stylesheet" href="vendor/tailwind/generated.min.css" data-tailwind-mode="generated">';
    return str_replace('<!-- APP_TAILWIND_STYLES -->', $tag, $html);
}
