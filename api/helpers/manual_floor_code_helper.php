<?php

/**
 * Additive support for short, human-readable floor codes. QR tokens remain the
 * authoritative scan value and are never rewritten by these helpers.
 */

function manual_floor_code_normalize($value) {
    return strtoupper(preg_replace('/\s+/', '', trim((string)$value)));
}

function manual_floor_code_random_suffix($length = 4) {
    // Avoid characters that are commonly confused when copied from paper.
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $last = strlen($alphabet) - 1;
    $result = '';
    for ($i = 0; $i < $length; $i++) {
        $result .= $alphabet[random_int(0, $last)];
    }
    return $result;
}

function manual_floor_code_build_prefix($buildingName, $floorName) {
    $building = strtoupper(trim((string)$buildingName));
    $words = preg_split('/[^A-Z0-9]+/', $building, -1, PREG_SPLIT_NO_EMPTY);
    $buildingCode = '';

    if (count($words) > 1) {
        foreach ($words as $word) {
            if ($word !== '') $buildingCode .= $word[0];
            if (strlen($buildingCode) >= 3) break;
        }
    } elseif (!empty($words)) {
        $buildingCode = substr(preg_replace('/[^A-Z0-9]/', '', $words[0]), 0, 3);
    }

    if ($buildingCode === '') $buildingCode = 'FLR';

    $floorPart = '';
    if (preg_match('/(?:^|[-\s])(\d+)\s*(?:st|nd|rd|th)?\s*floor\b/i', (string)$floorName, $matches)) {
        $floorPart = $matches[1];
    } elseif (stripos((string)$floorName, 'basement') !== false) {
        $floorPart = 'B';
    }

    return substr($buildingCode . $floorPart, 0, 5);
}

function manual_floor_code_generate($mysqli, $buildingName, $floorName) {
    $prefix = manual_floor_code_build_prefix($buildingName, $floorName);
    for ($attempt = 0; $attempt < 30; $attempt++) {
        $suffixLength = max(4, 7 - strlen($prefix));
        $candidate = $prefix . manual_floor_code_random_suffix($suffixLength);
        $stmt = $mysqli->prepare('SELECT floor_id FROM tbl_floors WHERE manual_code = ? LIMIT 1');
        if (!$stmt) throw new RuntimeException('Unable to check manual floor-code uniqueness.');
        $stmt->bind_param('s', $candidate);
        $stmt->execute();
        $exists = (bool)$stmt->get_result()->fetch_assoc();
        $stmt->close();
        if (!$exists) return $candidate;
    }
    throw new RuntimeException('Unable to generate a unique manual floor code.');
}

function manual_floor_code_backfill($mysqli) {
    $result = $mysqli->query("SELECT f.floor_id, f.floor_name, b.building_name
        FROM tbl_floors f
        LEFT JOIN tbl_buildings b ON b.building_id = f.building_id
        WHERE f.manual_code IS NULL OR TRIM(f.manual_code) = ''");
    if (!$result) return;

    while ($row = $result->fetch_assoc()) {
        $floorId = (int)$row['floor_id'];
        for ($attempt = 0; $attempt < 5; $attempt++) {
            $code = manual_floor_code_generate($mysqli, $row['building_name'] ?? '', $row['floor_name'] ?? '');
            $stmt = $mysqli->prepare("UPDATE tbl_floors SET manual_code = ? WHERE floor_id = ? AND (manual_code IS NULL OR TRIM(manual_code) = '')");
            if (!$stmt) break;
            $stmt->bind_param('si', $code, $floorId);
            $ok = $stmt->execute();
            $changed = $stmt->affected_rows > 0;
            $stmt->close();
            if ($ok || $changed) break;
        }
    }
}

function manual_floor_code_ensure_schema($mysqli) {
    static $ensured = false;
    if ($ensured) return true;

    $table = $mysqli->query("SHOW TABLES LIKE 'tbl_floors'");
    if (!$table || $table->num_rows === 0) return false;

    $column = $mysqli->query("SHOW COLUMNS FROM tbl_floors LIKE 'manual_code'");
    if (!$column || $column->num_rows === 0) {
        if (!$mysqli->query("ALTER TABLE tbl_floors ADD COLUMN manual_code VARCHAR(16) NULL AFTER qr_token")) {
            throw new RuntimeException('Unable to add manual floor-code storage: ' . $mysqli->error);
        }
    }

    $index = $mysqli->query("SHOW INDEX FROM tbl_floors WHERE Key_name = 'uq_tbl_floors_manual_code'");
    if (!$index || $index->num_rows === 0) {
        if (!$mysqli->query("ALTER TABLE tbl_floors ADD UNIQUE KEY uq_tbl_floors_manual_code (manual_code)")) {
            throw new RuntimeException('Unable to add manual floor-code uniqueness: ' . $mysqli->error);
        }
    }

    manual_floor_code_backfill($mysqli);
    $ensured = true;
    return true;
}
