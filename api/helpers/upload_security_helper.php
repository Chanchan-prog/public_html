<?php
declare(strict_types=1);

// Inspect ZIP directory records without extracting/decompressing any content.
// This also works on shared PHP hosts without the optional ZipArchive extension.
function app_upload_zip_entries(string $path): array {
    $bytes = file_get_contents($path);
    $end = strrpos($bytes, "PK\x05\x06");
    if ($end === false || strlen($bytes) - $end < 22) throw new InvalidArgumentException('Invalid ZIP archive.');
    $e = unpack('vdisk/vstart/vlocal/vcount/Vsize/Voffset/vcomment', substr($bytes, $end + 4, 18));
    if ($e['disk'] || $e['start'] || $e['local'] !== $e['count'] || $e['count'] > 10000 || $e['offset'] + $e['size'] !== $end || $end + 22 + $e['comment'] !== strlen($bytes)) {
        throw new InvalidArgumentException('Unsupported or invalid ZIP archive.');
    }
    $offset = $e['offset'];
    $names = [];
    for ($i = 0; $i < $e['count']; $i++) {
        if ($offset + 46 > $end || substr($bytes, $offset, 4) !== "PK\x01\x02") throw new InvalidArgumentException('Invalid ZIP directory.');
        $h = unpack('vname/vextra/vcomment/vdisk', substr($bytes, $offset + 28, 8));
        $local = unpack('Voffset', substr($bytes, $offset + 42, 4))['offset'];
        $next = $offset + 46 + $h['name'] + $h['extra'] + $h['comment'];
        if ($next > $end || $h['disk'] || $local + 30 > $e['offset'] || substr($bytes, $local, 4) !== "PK\x03\x04") throw new InvalidArgumentException('Invalid ZIP entry.');
        $names[] = substr($bytes, $offset + 46, $h['name']);
        $offset = $next;
    }
    if ($offset !== $end) throw new InvalidArgumentException('Invalid ZIP directory length.');
    return $names;
}

// Content and extension must agree. Never derive an executable extension from
// the original name, and never extract uploaded archives on the server.
function app_validate_upload(string $path, string $name): array {
    $extension = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    $types = [
        'jpg'=>['image/jpeg'], 'jpeg'=>['image/jpeg'], 'png'=>['image/png'],
        'gif'=>['image/gif'], 'webp'=>['image/webp'], 'pdf'=>['application/pdf'],
        'doc'=>['application/msword','application/x-ole-storage','application/CDFV2'],
        'xls'=>['application/vnd.ms-excel','application/x-ole-storage','application/CDFV2'],
        'docx'=>['application/zip','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        'xlsx'=>['application/zip','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
        'csv'=>['text/plain','text/csv','application/csv'], 'txt'=>['text/plain'],
        'json'=>['application/json','text/plain'], 'zip'=>['application/zip','application/x-zip'],
    ];
    $size = is_file($path) ? filesize($path) : false;
    if ($size === false || $size <= 0 || $size > 10 * 1024 * 1024) {
        throw new InvalidArgumentException('Choose a non-empty file no larger than 10 MB.');
    }
    $mime = (new finfo(FILEINFO_MIME_TYPE))->file($path);
    if (!isset($types[$extension]) || !in_array($mime, $types[$extension], true)) {
        throw new InvalidArgumentException('The file contents do not match an allowed file type.');
    }
    if (str_starts_with($mime, 'image/')) {
        $info = @getimagesize($path);
        if (!$info || ($info['mime'] ?? '') !== $mime || $info[0] * $info[1] > 25000000) {
            throw new InvalidArgumentException('Choose a valid image no larger than 25 megapixels.');
        }
    }
    if ($extension === 'json') {
        json_decode(file_get_contents($path));
        if (json_last_error() !== JSON_ERROR_NONE) throw new InvalidArgumentException('Invalid JSON file.');
    }
    if (in_array($extension, ['docx','xlsx','zip'], true)) {
        $entries = app_upload_zip_entries($path);
        if ($extension !== 'zip') {
            $entry = $extension === 'docx' ? 'word/document.xml' : 'xl/workbook.xml';
            if (!in_array('[Content_Types].xml', $entries, true) || !in_array($entry, $entries, true)) {
                throw new InvalidArgumentException('Invalid Office document.');
            }
        }
    }
    return ['extension'=>$extension === 'jpeg' ? 'jpg' : $extension, 'mime'=>$mime, 'size'=>$size];
}

function app_upload_can_access(array $file, int $userId, int $roleId): bool {
    return $userId > 0 && ($roleId === 1 || (int)$file['user_id'] === $userId);
}

function app_upload_real_path(string $root, string $relative): ?string {
    $root = realpath($root);
    $relative = str_replace('\\', '/', $relative);
    if (!$root || !str_starts_with($relative, 'uploads/')) return null;
    $path = realpath($root . DIRECTORY_SEPARATOR . substr($relative, 8));
    if (!$path || !is_file($path) || !str_starts_with($path, $root . DIRECTORY_SEPARATOR)) return null;
    return $path;
}

function app_upload_download_url(int $id): string {
    $script = str_replace('\\', '/', (string)($_SERVER['SCRIPT_NAME'] ?? '/api/index.php'));
    return $script . '/api/file-upload?action=download&file_id=' . $id;
}
