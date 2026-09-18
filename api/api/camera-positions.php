<?php
// api/api/camera-positions.php

if (!isset($GLOBALS['mysqli']) || $GLOBALS['mysqli'] === null) {
    if (file_exists(__DIR__ . '/../config/database.php')) {
        require_once __DIR__ . '/../config/database.php';
    }
}

if (!function_exists('json_response')) {
    require_once __DIR__ . '/../helpers/functions.php';
}
require_once __DIR__ . '/../helpers/building_model_helper.php';

global $mysqli, $authPayload;

$requestMethod = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$input = get_input();
if (!is_array($input)) $input = [];

$presetDefinitions = [
    'MW' => [
        'canonical' => 'Building_MainWest',
        'alias' => 'MainWest',
        'position' => [22, 10, -16],
        'target' => [0, 3, 0],
    ],
    'MN' => [
        'canonical' => 'Building_MainNorth',
        'alias' => 'MainNorth',
        'position' => [-22, 10, -16],
        'target' => [0, 3, 0],
    ],
    'MS' => [
        'canonical' => 'Building_MainSouth',
        'alias' => 'MainSouth',
        'position' => [22, 10, 16],
        'target' => [0, 3, 0],
    ],
    'PH' => [
        'canonical' => 'Building_PhinmaHall',
        'alias' => 'PhinmaHall',
        'position' => [-22, 10, 22],
        'target' => [0, 3, 0],
    ],
    'SHS' => [
        'canonical' => 'Building_SeniorHigh',
        'alias' => 'SeniorHigh',
        'position' => [22, 10, -16],
        'target' => [0, 3, 0],
    ],
    'BED' => [
        'canonical' => 'Building_BED',
        'alias' => 'BED',
        'position' => [22, 10, -16],
        'target' => [0, 3, 0],
    ],
];

building_model_ensure_schema($mysqli);
$knownBuildingNames = ['main west', 'main north', 'main south', 'phinma hall', 'senior high building', 'bed'];
$buildingResult = $mysqli->query("SELECT building_id, building_name FROM tbl_buildings WHERE model_path IS NOT NULL AND TRIM(model_path) != ''");
if ($buildingResult) {
    while ($building = $buildingResult->fetch_assoc()) {
        if (in_array(strtolower(trim((string)$building['building_name'])), $knownBuildingNames, true)) continue;
        $buildingId = (int)$building['building_id'];
        if ($buildingId <= 0) continue;
        $presetDefinitions['B' . $buildingId] = [
            'canonical' => 'Building_ID_' . $buildingId,
            'alias' => (string)$building['building_name'],
            'position' => [22, 10, -16],
            'target' => [0, 3, 0],
            'dynamic' => true,
        ];
    }
    $buildingResult->free();
}

$ensurePresetTable = function () use ($mysqli) {
    $sql = "CREATE TABLE IF NOT EXISTS `tbl_3d_camera_presets` (
        `building_code` VARCHAR(8) NOT NULL,
        `position_json` VARCHAR(255) NOT NULL,
        `target_json` VARCHAR(255) NOT NULL,
        `updated_by` INT(11) NULL,
        `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (`building_code`),
        KEY `updated_by` (`updated_by`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4";

    if (!$mysqli->query($sql)) {
        json_response(['error' => 'camera_preset_table_failed', 'message' => $mysqli->error], 500);
    }
    $codeColumn = $mysqli->query("SHOW COLUMNS FROM `tbl_3d_camera_presets` LIKE 'building_code'");
    $codeDefinition = $codeColumn ? $codeColumn->fetch_assoc() : null;
    if ($codeDefinition && !preg_match('/varchar\((?:3[2-9]|[4-9]\d|\d{3,})\)/i', (string)($codeDefinition['Type'] ?? ''))) {
        if (!$mysqli->query("ALTER TABLE `tbl_3d_camera_presets` MODIFY `building_code` VARCHAR(32) NOT NULL")) {
            json_response(['error' => 'camera_preset_schema_failed', 'message' => $mysqli->error], 500);
        }
    }
};

$normalizeVector = function ($value) {
    if (!is_array($value) || count($value) !== 3) return null;
    $normalized = [];
    foreach (array_values($value) as $component) {
        if (!is_numeric($component)) return null;
        $number = (float)$component;
        if (!is_finite($number) || abs($number) > 10000) return null;
        $normalized[] = round($number, 4);
    }
    return $normalized;
};

$getPresets = function () use ($mysqli, $presetDefinitions, $normalizeVector) {
    $presets = [];
    foreach ($presetDefinitions as $definition) {
        if (!empty($definition['dynamic'])) continue;
        $preset = [
            'position' => $definition['position'],
            'target' => $definition['target'],
        ];
        $presets[$definition['canonical']] = $preset;
        $presets[$definition['alias']] = $preset;
    }

    $result = $mysqli->query("SELECT building_code, position_json, target_json FROM tbl_3d_camera_presets");
    if (!$result) {
        json_response(['error' => 'camera_preset_read_failed', 'message' => $mysqli->error], 500);
    }

    while ($row = $result->fetch_assoc()) {
        $code = strtoupper(trim((string)($row['building_code'] ?? '')));
        if (!isset($presetDefinitions[$code])) continue;
        $position = $normalizeVector(json_decode((string)($row['position_json'] ?? ''), true));
        $target = $normalizeVector(json_decode((string)($row['target_json'] ?? ''), true));
        if ($position === null || $target === null) continue;

        $preset = ['position' => $position, 'target' => $target];
        $definition = $presetDefinitions[$code];
        $presets[$definition['canonical']] = $preset;
        $presets[$definition['alias']] = $preset;
    }
    $result->free();

    return $presets;
};

$ensurePresetTable();
header('Cache-Control: no-store');

if ($requestMethod === 'GET') {
    json_response($getPresets());
}

if ($requestMethod === 'POST') {
    $roleId = isset($authPayload['role_id']) ? (int)$authPayload['role_id'] : 0;
    if ($roleId !== 1) {
        json_response(['error' => 'forbidden', 'message' => 'Only Admin can save 3D camera presets.'], 403);
    }

    $buildingCode = strtoupper(trim((string)($input['building_code'] ?? '')));
    if (!isset($presetDefinitions[$buildingCode])) {
        json_response(['error' => 'validation', 'message' => 'The selected building does not have a supported 3D model.'], 400);
    }

    $position = $normalizeVector($input['position'] ?? null);
    $target = $normalizeVector($input['target'] ?? null);
    if ($position === null || $target === null) {
        json_response(['error' => 'validation', 'message' => 'Position and target must each contain three finite numbers between -10000 and 10000.'], 400);
    }

    $positionJson = json_encode($position);
    $targetJson = json_encode($target);
    $updatedBy = isset($authPayload['user_id']) ? (int)$authPayload['user_id'] : 0;
    $stmt = $mysqli->prepare("INSERT INTO tbl_3d_camera_presets (building_code, position_json, target_json, updated_by)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            position_json = VALUES(position_json),
            target_json = VALUES(target_json),
            updated_by = VALUES(updated_by)");
    if (!$stmt) {
        json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    }
    $stmt->bind_param('sssi', $buildingCode, $positionJson, $targetJson, $updatedBy);
    if (!$stmt->execute()) {
        $message = $stmt->error;
        $stmt->close();
        json_response(['error' => 'camera_preset_save_failed', 'message' => $message], 500);
    }
    $stmt->close();

    $definition = $presetDefinitions[$buildingCode];
    json_response([
        'success' => true,
        'building_code' => $buildingCode,
        'camera_key' => $definition['canonical'],
        'alias_key' => $definition['alias'],
        'preset' => ['position' => $position, 'target' => $target],
    ]);
}

json_response(['error' => 'method_not_allowed'], 405);
