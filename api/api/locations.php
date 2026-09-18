<?php
// api/api/locations.php
require_once __DIR__ . '/../helpers/socket_helper.php';
require_once __DIR__ . '/../helpers/log_helper.php'; // add system log helper
require_once __DIR__ . '/../helpers/manual_floor_code_helper.php';
require_once __DIR__ . '/../helpers/building_model_helper.php';
global $mysqli, $authPayload;

$auth = is_array($authPayload) ? $authPayload : app_get_authenticated_session(true);
$authUserId = (int)($auth['user_id'] ?? 0);

manual_floor_code_ensure_schema($mysqli);
building_model_ensure_schema($mysqli);

// Helper: find the first existing column name from candidates for a table
function find_existing_column($table, $candidates) {
    global $mysqli;
    foreach ($candidates as $c) {
        $c_esc = $mysqli->real_escape_string($c);
        $res = $mysqli->query("SHOW COLUMNS FROM `$table` LIKE '{$c_esc}'");
        if ($res && $res->num_rows) return $c;
    }
    return null;
}

function location_floor_level_number($floorName) {
    $name = trim((string)$floorName);
    if ($name === '') return null;
    if (preg_match('/(?:^|[-\s])(\d+)\s*(?:st|nd|rd|th)?\s*floor\b/i', $name, $matches)) {
        return (int)$matches[1];
    }
    return null;
}

function location_is_basement_floor($floorName) {
    return preg_match('/(?:^|[-\s])basement\s*$/i', trim((string)$floorName)) === 1;
}

function location_floor_level_label($level) {
    $number = (int)$level;
    $mod100 = $number % 100;
    if ($mod100 >= 11 && $mod100 <= 13) $suffix = 'th';
    else {
        $suffixes = [1 => 'st', 2 => 'nd', 3 => 'rd'];
        $suffix = $suffixes[$number % 10] ?? 'th';
    }
    return $number . $suffix . ' Floor';
}

function location_assert_floor_identity_preserved($mysqli, $floorId, $buildingId, $floorName) {
    if ($buildingId === null && $floorName === null) return;
    $stmt = $mysqli->prepare("SELECT building_id, floor_name FROM tbl_floors WHERE floor_id = ? LIMIT 1");
    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $stmt->bind_param('i', $floorId);
    $stmt->execute();
    $existing = $stmt->get_result()->fetch_assoc();
    if (!$existing) json_response(['error' => 'not_found', 'message' => 'Floor not found'], 404);
    if ($buildingId !== null && (int)$buildingId !== (int)$existing['building_id']) {
        json_response(['error' => 'floor_building_locked', 'message' => 'An existing floor cannot be moved to another building.'], 409);
    }
    if ($floorName !== null) {
        $oldLevel = location_floor_level_number($existing['floor_name'] ?? '');
        $newLevel = location_floor_level_number($floorName);
        $oldIsBasement = location_is_basement_floor($existing['floor_name'] ?? '');
        $newIsBasement = location_is_basement_floor($floorName);
        if ($oldLevel !== $newLevel || $oldIsBasement !== $newIsBasement) {
            json_response(['error' => 'floor_level_locked', 'message' => 'Editing a floor must preserve its existing floor number.'], 409);
        }
    }
}

function location_status_is_active($value) {
    return in_array(strtolower(trim((string)$value)), ['active', '1', 'true'], true);
}

function location_normalize_status($value) {
    $status = strtolower(trim((string)$value));
    if ($status === 'archived') $status = 'archive';
    return in_array($status, ['active', 'inactive', 'archive'], true) ? $status : null;
}

/**
 * Find every real table that references a location identifier. This keeps the
 * archive guard complete when new schedule, attendance, or 3D tables are added.
 */
function location_archive_dependencies($mysqli, $entityType, $entityId) {
    $definitions = [
        'building' => ['column' => 'building_id', 'table' => 'tbl_buildings'],
        'floor' => ['column' => 'floor_id', 'table' => 'tbl_floors'],
        'room' => ['column' => 'room_id', 'table' => 'tbl_rooms'],
    ];
    if (!isset($definitions[$entityType])) return [];

    $column = $definitions[$entityType]['column'];
    $ownTable = $definitions[$entityType]['table'];
    $schemaStmt = $mysqli->prepare("SELECT DISTINCT c.TABLE_NAME
        FROM INFORMATION_SCHEMA.COLUMNS c
        JOIN INFORMATION_SCHEMA.TABLES t
          ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        WHERE c.TABLE_SCHEMA = DATABASE()
          AND c.COLUMN_NAME = ?
          AND c.TABLE_NAME <> ?
          AND t.TABLE_TYPE = 'BASE TABLE'
        ORDER BY c.TABLE_NAME");
    if (!$schemaStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $schemaStmt->bind_param('ss', $column, $ownTable);
    $schemaStmt->execute();
    $tables = $schemaStmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $schemaStmt->close();

    $dependencies = [];
    foreach ($tables as $tableRow) {
        $table = (string)($tableRow['TABLE_NAME'] ?? '');
        if (!preg_match('/^[A-Za-z0-9_]+$/', $table)) continue;
        $countStmt = $mysqli->prepare("SELECT COUNT(*) AS total FROM `{$table}` WHERE `{$column}` = ?");
        if (!$countStmt) continue;
        $countStmt->bind_param('i', $entityId);
        $countStmt->execute();
        $countRow = $countStmt->get_result()->fetch_assoc();
        $countStmt->close();
        $count = (int)($countRow['total'] ?? 0);
        if ($count <= 0) continue;
        $label = ucwords(str_replace('_', ' ', preg_replace('/^tbl_/', '', $table)));
        $dependencies[] = ['table' => $table, 'label' => $label, 'count' => $count];
    }

    // Camera presets use a stable building code instead of a building_id.
    if ($entityType === 'building') {
        $presetTable = $mysqli->query("SHOW TABLES LIKE 'tbl_3d_camera_presets'");
        if ($presetTable && $presetTable->num_rows > 0) {
            $buildingStmt = $mysqli->prepare('SELECT building_name FROM tbl_buildings WHERE building_id = ? LIMIT 1');
            if ($buildingStmt) {
                $buildingStmt->bind_param('i', $entityId);
                $buildingStmt->execute();
                $buildingName = strtolower(trim((string)(($buildingStmt->get_result()->fetch_assoc()['building_name'] ?? ''))));
                $buildingStmt->close();
                $knownCodes = [
                    'main west' => 'MW', 'main north' => 'MN', 'main south' => 'MS',
                    'phinma hall' => 'PH', 'senior high building' => 'SHS', 'bed' => 'BED',
                ];
                $codes = ['B' . (int)$entityId];
                if (isset($knownCodes[$buildingName])) $codes[] = $knownCodes[$buildingName];
                $codes = array_values(array_unique($codes));
                $placeholders = implode(',', array_fill(0, count($codes), '?'));
                $types = str_repeat('s', count($codes));
                $presetStmt = $mysqli->prepare("SELECT COUNT(*) AS total FROM tbl_3d_camera_presets WHERE building_code IN ({$placeholders})");
                if ($presetStmt) {
                    $presetStmt->bind_param($types, ...$codes);
                    $presetStmt->execute();
                    $presetCount = (int)(($presetStmt->get_result()->fetch_assoc()['total'] ?? 0));
                    $presetStmt->close();
                    if ($presetCount > 0) {
                        $dependencies[] = ['table' => 'tbl_3d_camera_presets', 'label' => '3D Camera Presets', 'count' => $presetCount];
                    }
                }
            }
        }
    }
    return $dependencies;
}

function location_assert_can_archive($mysqli, $entityType, $entityId) {
    $dependencies = location_archive_dependencies($mysqli, $entityType, (int)$entityId);
    if (!$dependencies) return;
    $summary = implode(', ', array_map(static function ($item) {
        return $item['count'] . ' ' . $item['label'];
    }, $dependencies));
    json_response([
        'error' => 'archive_blocked',
        'message' => ucfirst($entityType) . " cannot be archived because it has related records: {$summary}. Set it to Inactive instead.",
        'dependencies' => $dependencies,
    ], 409);
}

function location_prepare_status_transition($mysqli, $entityType, $entityId, $currentStatus, $requestedStatus) {
    if ($requestedStatus === null) return null;
    $next = location_normalize_status($requestedStatus);
    if ($next === null) {
        json_response(['error' => 'invalid_status', 'message' => 'Status must be Active, Inactive, or Archive.'], 400);
    }
    $current = location_normalize_status($currentStatus) ?? 'inactive';
    // A restored record must be reviewed before it can become operational.
    if ($current === 'archive' && $next === 'active') $next = 'inactive';
    if ($next === 'archive' && $current !== 'archive') {
        location_assert_can_archive($mysqli, $entityType, (int)$entityId);
    }
    return $next;
}

function location_assert_archived_update_is_restore_only($currentStatus, $input) {
    if (location_normalize_status($currentStatus) !== 'archive') return;
    $extraFields = array_diff(array_keys((array)$input), ['status']);
    $requested = location_normalize_status($input['status'] ?? null);
    if ($extraFields || $requested === null || $requested === 'archive') {
        json_response([
            'error' => 'archived_location',
            'message' => 'Archived locations cannot be edited. Restore this record to Inactive first.',
        ], 409);
    }
}

function location_assert_active_school($mysqli, $schoolId) {
    $id = (int)$schoolId;
    if ($id <= 0) return;
    $stmt = $mysqli->prepare("SELECT school_id, status FROM tbl_school WHERE school_id = ? LIMIT 1");
    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $stmt->bind_param('i', $id); $stmt->execute(); $row = $stmt->get_result()->fetch_assoc(); $stmt->close();
    if (!$row) json_response(['error' => 'invalid_school', 'message' => 'Selected school does not exist.'], 400);
    if (!location_status_is_active($row['status'] ?? null)) {
        json_response(['error' => 'inactive_school', 'message' => 'Selected school is inactive or archived. Choose an active school.'], 409);
    }
}

function location_assert_active_building($mysqli, $buildingId) {
    $id = (int)$buildingId;
    $stmt = $mysqli->prepare("SELECT b.building_id, b.status AS building_status, b.school_id, s.status AS school_status FROM tbl_buildings b LEFT JOIN tbl_school s ON s.school_id = b.school_id WHERE b.building_id = ? LIMIT 1");
    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $stmt->bind_param('i', $id); $stmt->execute(); $row = $stmt->get_result()->fetch_assoc(); $stmt->close();
    if (!$row) json_response(['error' => 'invalid_building', 'message' => 'Selected building does not exist.'], 400);
    if (!location_status_is_active($row['building_status'] ?? null)) {
        json_response(['error' => 'inactive_building', 'message' => 'Selected building is inactive or archived. Choose an active building.'], 409);
    }
    if (!empty($row['school_id']) && !location_status_is_active($row['school_status'] ?? null)) {
        json_response(['error' => 'inactive_building_school', 'message' => 'The selected building belongs to an inactive or archived school.'], 409);
    }
}

function location_assert_active_room_hierarchy($mysqli, $buildingId, $floorId) {
    $building = (int)$buildingId;
    $floor = (int)$floorId;
    $stmt = $mysqli->prepare("SELECT f.floor_id, f.building_id, f.status AS floor_status, b.status AS building_status, b.school_id, s.status AS school_status FROM tbl_floors f JOIN tbl_buildings b ON b.building_id = f.building_id LEFT JOIN tbl_school s ON s.school_id = b.school_id WHERE f.floor_id = ? LIMIT 1");
    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $stmt->bind_param('i', $floor); $stmt->execute(); $row = $stmt->get_result()->fetch_assoc(); $stmt->close();
    if (!$row || (int)$row['building_id'] !== $building) {
        json_response(['error' => 'invalid_floor_building', 'message' => 'Selected floor does not belong to the selected building.'], 400);
    }
    if (!location_status_is_active($row['floor_status'] ?? null) || !location_status_is_active($row['building_status'] ?? null)) {
        json_response(['error' => 'inactive_room_location', 'message' => 'Selected floor or building is inactive or archived.'], 409);
    }
    if (!empty($row['school_id']) && !location_status_is_active($row['school_status'] ?? null)) {
        json_response(['error' => 'inactive_room_school', 'message' => 'The selected building belongs to an inactive or archived school.'], 409);
    }
}

$request_method = $_SERVER['REQUEST_METHOD'];
$input = get_input();

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$parts = explode('/', $path);
$api_prefix_key = array_search('api', $parts);

$endpoint = $parts[$api_prefix_key + 1] ?? null;
$param1 = $parts[$api_prefix_key + 2] ?? null;
$param2 = $parts[$api_prefix_key + 3] ?? null;
$param3 = $parts[$api_prefix_key + 4] ?? null;

switch ($endpoint) {
    case 'buildings':
        if ($request_method === 'GET') {
            // Detect which columns exist and build a safe SELECT
            $latCol = find_existing_column('tbl_buildings', ['latitude','alt','altitude','lat']);
            $lonCol = find_existing_column('tbl_buildings', ['longitude','lon','lng','long']);
            $radCol = find_existing_column('tbl_buildings', ['radius','building_radius']);
            $descCol = find_existing_column('tbl_buildings', ['location_description','description','building_description']);

            $select = [ 'b.building_id', 'b.building_name', 'b.status AS status' ];
            // include school association if present
            $select[] = 'b.school_id';
            $select[] = 's.school_name AS school_name';
            $select[] = 's.status AS school_status';
            $select[] = $descCol ? "b.`{$descCol}` AS location_description" : "NULL AS location_description";
            $select[] = $latCol ? "b.`{$latCol}` AS latitude" : "NULL AS latitude";
            $select[] = $lonCol ? "b.`{$lonCol}` AS longitude" : "NULL AS longitude";
            $select[] = $radCol ? "b.`{$radCol}` AS radius" : "NULL AS radius";
            $select[] = 'b.model_path';
            $select[] = 'b.model_filename';
            $select[] = 'b.model_size';
            $select[] = 'b.model_updated_at';
            $select[] = 'b.model_updated_by';

            // Single building
            if (is_numeric($param1)) {
                $sql = 'SELECT ' . implode(', ', $select) . ' FROM tbl_buildings b LEFT JOIN tbl_school s ON b.school_id = s.school_id WHERE b.building_id = ? LIMIT 1';
                $stmt = $mysqli->prepare($sql);
                if (!$stmt) json_response(['error' => 'Failed to prepare query', 'details' => $mysqli->error], 500);
                $stmt->bind_param('i', $param1);
                $stmt->execute();
                $row = $stmt->get_result()->fetch_assoc();
                if (!$row) json_response(['error' => 'building_not_found'], 404);
                json_response($row);
            }

            // join with tbl_school to expose school_name (if exists)
            $sql = 'SELECT ' . implode(', ', $select) . ' FROM tbl_buildings b LEFT JOIN tbl_school s ON b.school_id = s.school_id ORDER BY b.building_name';
            $result = $mysqli->query($sql);
            if (!$result) {
                json_response(['error' => 'Failed to fetch buildings: ' . $mysqli->error], 500);
            }
            json_response($result->fetch_all(MYSQLI_ASSOC));

        } elseif ($request_method === 'POST' && is_numeric($param1) && $param2 === 'model') {
            if ((int)($auth['role_id'] ?? 0) !== 1) {
                json_response(['error' => 'forbidden', 'message' => 'Only Admin can add or change a building GLB.'], 403);
            }

            $id = (int)$param1;
            $buildingStmt = $mysqli->prepare("SELECT building_id, building_name, model_path, status FROM tbl_buildings WHERE building_id = ? LIMIT 1");
            if (!$buildingStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $buildingStmt->bind_param('i', $id);
            $buildingStmt->execute();
            $building = $buildingStmt->get_result()->fetch_assoc();
            $buildingStmt->close();
            if (!$building) json_response(['error' => 'building_not_found', 'message' => 'Building not found.'], 404);
            if (location_normalize_status($building['status'] ?? null) === 'archive') {
                json_response(['error' => 'archived_location', 'message' => 'Archived buildings cannot be edited. Restore this building to Inactive first.'], 409);
            }

            if (!isset($_FILES['model']) || !is_array($_FILES['model'])) {
                json_response(['error' => 'missing_model', 'message' => 'Choose a GLB building model to upload. Check the server upload-size limit if a file was selected.'], 400);
            }
            $upload = $_FILES['model'];
            $uploadError = (int)($upload['error'] ?? UPLOAD_ERR_NO_FILE);
            if ($uploadError !== UPLOAD_ERR_OK) {
                $messages = [
                    UPLOAD_ERR_INI_SIZE => 'The GLB exceeds the server upload_max_filesize limit.',
                    UPLOAD_ERR_FORM_SIZE => 'The GLB exceeds the allowed form size.',
                    UPLOAD_ERR_PARTIAL => 'The GLB upload was interrupted. Try again.',
                    UPLOAD_ERR_NO_FILE => 'Choose a GLB building model to upload.',
                ];
                json_response(['error' => 'upload_failed', 'message' => $messages[$uploadError] ?? 'The GLB upload failed.'], 400);
            }

            $originalName = basename((string)($upload['name'] ?? 'building.glb'));
            $extension = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
            $size = (int)($upload['size'] ?? 0);
            $tmpPath = (string)($upload['tmp_name'] ?? '');
            if ($extension !== 'glb') json_response(['error' => 'invalid_model_type', 'message' => 'Only binary .glb building models are allowed.'], 415);
            if ($size <= 0 || $size > 40 * 1024 * 1024) json_response(['error' => 'invalid_model_size', 'message' => 'The GLB must be larger than 0 bytes and no more than 40 MB.'], 413);
            if ($tmpPath === '' || !is_uploaded_file($tmpPath)) json_response(['error' => 'invalid_upload', 'message' => 'The uploaded GLB could not be verified.'], 400);

            $handle = @fopen($tmpPath, 'rb');
            $header = $handle ? fread($handle, 12) : false;
            if ($handle) fclose($handle);
            if (!is_string($header) || strlen($header) !== 12 || substr($header, 0, 4) !== 'glTF') {
                json_response(['error' => 'invalid_glb', 'message' => 'The selected file is not a valid binary GLB model.'], 415);
            }
            $headerValues = unpack('Vversion/Vlength', substr($header, 4, 8));
            if ((int)($headerValues['version'] ?? 0) !== 2 || (int)($headerValues['length'] ?? 0) !== $size) {
                json_response(['error' => 'invalid_glb', 'message' => 'The GLB header or file length is invalid. Export the model as GLB version 2 and try again.'], 415);
            }

            $relativeDirectory = 'uploads/buildings/' . $id;
            $absoluteDirectory = building_model_public_absolute_path($relativeDirectory);
            if (!$absoluteDirectory || (!is_dir($absoluteDirectory) && !mkdir($absoluteDirectory, 0755, true) && !is_dir($absoluteDirectory))) {
                json_response(['error' => 'storage_unavailable', 'message' => 'The building model upload directory is not writable.'], 500);
            }
            $storedFilename = 'building-' . $id . '-' . date('YmdHis') . '-' . bin2hex(random_bytes(4)) . '.glb';
            $relativePath = $relativeDirectory . '/' . $storedFilename;
            $absolutePath = $absoluteDirectory . DIRECTORY_SEPARATOR . $storedFilename;
            if (!move_uploaded_file($tmpPath, $absolutePath)) {
                json_response(['error' => 'upload_move_failed', 'message' => 'Unable to store the uploaded GLB on the server.'], 500);
            }

            $updateStmt = $mysqli->prepare("UPDATE tbl_buildings SET model_path = ?, model_filename = ?, model_size = ?, model_updated_at = NOW(), model_updated_by = ? WHERE building_id = ?");
            if (!$updateStmt) {
                @unlink($absolutePath);
                json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            }
            $updateStmt->bind_param('ssiii', $relativePath, $originalName, $size, $authUserId, $id);
            if (!$updateStmt->execute()) {
                $message = $updateStmt->error;
                $updateStmt->close();
                @unlink($absolutePath);
                json_response(['error' => 'model_update_failed', 'message' => $message], 500);
            }
            $updateStmt->close();

            $oldPath = trim((string)($building['model_path'] ?? ''));
            if (str_starts_with(str_replace('\\', '/', $oldPath), 'uploads/buildings/')) {
                $oldAbsolutePath = building_model_public_absolute_path($oldPath);
                $uploadRoot = realpath(dirname(__DIR__, 2) . DIRECTORY_SEPARATOR . 'public' . DIRECTORY_SEPARATOR . 'uploads' . DIRECTORY_SEPARATOR . 'buildings');
                $oldRealPath = $oldAbsolutePath && is_file($oldAbsolutePath) ? realpath($oldAbsolutePath) : false;
                if ($uploadRoot && $oldRealPath && str_starts_with($oldRealPath, $uploadRoot . DIRECTORY_SEPARATOR)) @unlink($oldRealPath);
            }

            $cameraCodes = ['B' . $id];
            $knownCodes = [
                'main west' => 'MW', 'main north' => 'MN', 'main south' => 'MS',
                'phinma hall' => 'PH', 'senior high building' => 'SHS', 'bed' => 'BED',
            ];
            $knownCode = $knownCodes[strtolower(trim((string)$building['building_name']))] ?? null;
            if ($knownCode) $cameraCodes[] = $knownCode;
            $presetTable = $mysqli->query("SHOW TABLES LIKE 'tbl_3d_camera_presets'");
            if ($presetTable && $presetTable->num_rows > 0) {
                $deletePreset = $mysqli->prepare('DELETE FROM tbl_3d_camera_presets WHERE building_code = ?');
                if ($deletePreset) {
                    foreach ($cameraCodes as $cameraCode) {
                        $deletePreset->bind_param('s', $cameraCode);
                        $deletePreset->execute();
                    }
                    $deletePreset->close();
                }
            }

            log_system_action($mysqli, $authUserId, 'upload_building_model', "Updated GLB model for building '{$building['building_name']}'");
            json_response([
                'ok' => true,
                'building_id' => $id,
                'model_path' => $relativePath,
                'model_filename' => $originalName,
                'model_size' => $size,
                'model_updated_at' => date('Y-m-d H:i:s'),
            ]);

        } elseif ($request_method === 'POST' && is_numeric($param1) && ($param2 === 'update' || $param2 === null)) {
            // Backward-compatible update endpoint: POST /buildings/{id}/update
            $id = (int)$param1;
            // Validate input
            $name = isset($input['building_name']) ? trim($input['building_name']) : null;
            $latitude = array_key_exists('latitude', $input) ? ($input['latitude'] === '' ? null : (float)$input['latitude']) : null;
            $longitude = array_key_exists('longitude', $input) ? ($input['longitude'] === '' ? null : (float)$input['longitude']) : null;
            $radius = isset($input['radius']) ? (int)$input['radius'] : null;
            $status = isset($input['status']) ? $input['status'] : null;

            // Detect description and lat/lon column names
            $descCol = find_existing_column('tbl_buildings', ['location_description','description','building_description']);
            $school_id = array_key_exists('school_id', $input) ? (int)$input['school_id'] : null;
            $latCol = find_existing_column('tbl_buildings', ['latitude','alt','altitude','lat']);
            $lonCol = find_existing_column('tbl_buildings', ['longitude','lon','lng','long']);

            $currentStmt = $mysqli->prepare("SELECT school_id, status FROM tbl_buildings WHERE building_id = ? LIMIT 1");
            if (!$currentStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $currentStmt->bind_param('i', $id); $currentStmt->execute(); $currentBuilding = $currentStmt->get_result()->fetch_assoc(); $currentStmt->close();
            if (!$currentBuilding) json_response(['error' => 'building_not_found', 'message' => 'Building not found.'], 404);
            location_assert_archived_update_is_restore_only($currentBuilding['status'] ?? null, $input);
            $status = location_prepare_status_transition($mysqli, 'building', $id, $currentBuilding['status'] ?? null, $status);
            $candidateSchoolId = array_key_exists('school_id', $input) ? (int)$input['school_id'] : (int)($currentBuilding['school_id'] ?? 0);
            $candidateStatus = $status ?? (location_normalize_status($currentBuilding['status'] ?? null) ?? 'inactive');
            if ($candidateStatus === 'active') location_assert_active_school($mysqli, $candidateSchoolId);

            // name uniqueness check
            if ($name) {
                $nstmt = $mysqli->prepare("SELECT building_id FROM tbl_buildings WHERE LOWER(building_name) = LOWER(?) AND building_id != ? LIMIT 1");
                $nstmt->bind_param('si', $name, $id);
                $nstmt->execute();
                if ($nstmt->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_name', 'message' => 'A building with the same name already exists'], 409);
            }
            // lat/lon unique pair check when both provided
            if ($latitude !== null && $longitude !== null && $latCol && $lonCol) {
                $lstmt = $mysqli->prepare("SELECT building_id FROM tbl_buildings WHERE ABS(COALESCE(`{$latCol}`,0) - ?) < 0.0000001 AND ABS(COALESCE(`{$lonCol}`,0) - ?) < 0.0000001 AND building_id != ? LIMIT 1");
                if ($lstmt) {
                    $lstmt->bind_param('ddi', $latitude, $longitude, $id);
                    $lstmt->execute();
                    if ($lstmt->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_latlon', 'message' => 'Another building with same latitude/longitude exists'], 409);
                }
            }

            // Build update dynamically
            $sets = [];
            $types = '';
            $vals = [];
            if ($name !== null) { $sets[] = 'building_name = ?'; $types .= 's'; $vals[] = $name; }
            if ($school_id !== null) { $sets[] = 'school_id = ?'; $types .= 'i'; $vals[] = $school_id; }
            if ($descCol && array_key_exists('location_description', $input)) { $sets[] = "`{$descCol}` = ?"; $types .= 's'; $vals[] = $input['location_description']; }
            if ($radius !== null) { $sets[] = 'radius = ?'; $types .= 'i'; $vals[] = $radius; }
            if ($status !== null) { $sets[] = 'status = ?'; $types .= 's'; $vals[] = $status; }

            if ($latCol && array_key_exists('latitude', $input)) { $sets[] = "`{$latCol}` = ?"; $types .= 'd'; $vals[] = $latitude; }
            if ($lonCol && array_key_exists('longitude', $input)) { $sets[] = "`{$lonCol}` = ?"; $types .= 'd'; $vals[] = $longitude; }

            if (empty($sets)) json_response(['ok' => true, 'message' => 'no_changes']);

            $types .= 'i'; $vals[] = $id;
            $sql = 'UPDATE tbl_buildings SET ' . implode(', ', $sets) . ' WHERE building_id = ?';
            $ustmt = $mysqli->prepare($sql);
            if (!$ustmt) json_response(['error' => 'db_prepare_failed', 'details' => $mysqli->error], 500);
            $ustmt->bind_param($types, ...$vals);
            $ustmt->execute();
            // Log the update (use building name for a professional text-only message)
            $logName = $name ?? null;
            if (!$logName) {
                $q = $mysqli->prepare("SELECT building_name FROM tbl_buildings WHERE building_id = ? LIMIT 1");
                if ($q) { $q->bind_param('i', $id); $q->execute(); $r = $q->get_result()->fetch_assoc(); $logName = $r['building_name'] ?? null; }
            }
            $logMsg = $logName ? "Updated building details for '{$logName}'" : 'Updated building details';
            log_system_action($mysqli, $authUserId, 'update_building', $logMsg);
            json_response(['ok' => true, 'building_id' => $id, 'message' => 'updated']);

        } elseif ($request_method === 'PUT' && is_numeric($param1)) {
            // Accept PUT /buildings/{id} as update (same validations as POST /buildings/{id}/update)
            $id = (int)$param1;
            // Validate input
            $name = isset($input['building_name']) ? trim($input['building_name']) : null;
            $latitude = array_key_exists('latitude', $input) ? ($input['latitude'] === '' ? null : (float)$input['latitude']) : null;
            $longitude = array_key_exists('longitude', $input) ? ($input['longitude'] === '' ? null : (float)$input['longitude']) : null;
            $radius = isset($input['radius']) ? (int)$input['radius'] : null;
            $status = isset($input['status']) ? $input['status'] : null;
            $school_id = array_key_exists('school_id', $input) ? (int)$input['school_id'] : null;

            // Detect description and lat/lon column names
            $descCol = find_existing_column('tbl_buildings', ['location_description','description','building_description']);
            $latCol = find_existing_column('tbl_buildings', ['latitude','alt','altitude','lat']);
            $lonCol = find_existing_column('tbl_buildings', ['longitude','lon','lng','long']);

            $currentStmt = $mysqli->prepare("SELECT school_id, status FROM tbl_buildings WHERE building_id = ? LIMIT 1");
            if (!$currentStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $currentStmt->bind_param('i', $id); $currentStmt->execute(); $currentBuilding = $currentStmt->get_result()->fetch_assoc(); $currentStmt->close();
            if (!$currentBuilding) json_response(['error' => 'building_not_found', 'message' => 'Building not found.'], 404);
            location_assert_archived_update_is_restore_only($currentBuilding['status'] ?? null, $input);
            $status = location_prepare_status_transition($mysqli, 'building', $id, $currentBuilding['status'] ?? null, $status);
            $candidateSchoolId = array_key_exists('school_id', $input) ? (int)$input['school_id'] : (int)($currentBuilding['school_id'] ?? 0);
            $candidateStatus = $status ?? (location_normalize_status($currentBuilding['status'] ?? null) ?? 'inactive');
            if ($candidateStatus === 'active') location_assert_active_school($mysqli, $candidateSchoolId);

            // name uniqueness check
            if ($name) {
                $nstmt = $mysqli->prepare("SELECT building_id FROM tbl_buildings WHERE LOWER(building_name) = LOWER(?) AND building_id != ? LIMIT 1");
                if ($nstmt) {
                    $nstmt->bind_param('si', $name, $id);
                    $nstmt->execute();
                    if ($nstmt->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_name', 'message' => 'A building with the same name already exists'], 409);
                }
            }
            // lat/lon unique pair check when both provided
            if ($latitude !== null && $longitude !== null && $latCol && $lonCol) {
                $lstmt = $mysqli->prepare("SELECT building_id FROM tbl_buildings WHERE ABS(COALESCE(`{$latCol}`,0) - ?) < 0.0000001 AND ABS(COALESCE(`{$lonCol}`,0) - ?) < 0.0000001 AND building_id != ? LIMIT 1");
                if ($lstmt) {
                    $lstmt->bind_param('ddi', $latitude, $longitude, $id);
                    $lstmt->execute();
                    if ($lstmt->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_latlon', 'message' => 'Another building with same latitude/longitude exists'], 409);
                }
            }

            // Build update dynamically
            $sets = [];
            $types = '';
            $vals = [];
            if ($name !== null) { $sets[] = 'building_name = ?'; $types .= 's'; $vals[] = $name; }
            if ($school_id !== null) { $sets[] = 'school_id = ?'; $types .= 'i'; $vals[] = $school_id; }
            if ($descCol && array_key_exists('location_description', $input)) { $sets[] = "`{$descCol}` = ?"; $types .= 's'; $vals[] = $input['location_description']; }
            if ($radius !== null) { $sets[] = 'radius = ?'; $types .= 'i'; $vals[] = $radius; }
            if ($status !== null) { $sets[] = 'status = ?'; $types .= 's'; $vals[] = $status; }

            if ($latCol && array_key_exists('latitude', $input)) { $sets[] = "`{$latCol}` = ?"; $types .= 'd'; $vals[] = $latitude; }
            if ($lonCol && array_key_exists('longitude', $input)) { $sets[] = "`{$lonCol}` = ?"; $types .= 'd'; $vals[] = $longitude; }

            if (empty($sets)) json_response(['ok' => true, 'message' => 'no_changes']);

            $types .= 'i'; $vals[] = $id;
            $sql = 'UPDATE tbl_buildings SET ' . implode(', ', $sets) . ' WHERE building_id = ?';
            $ustmt = $mysqli->prepare($sql);
            if (!$ustmt) json_response(['error' => 'db_prepare_failed', 'details' => $mysqli->error], 500);
            $ustmt->bind_param($types, ...$vals);
            $ustmt->execute();
            // Log the update (PUT) with professional message
            $logName = $name ?? null;
            if (!$logName) {
                $q = $mysqli->prepare("SELECT building_name FROM tbl_buildings WHERE building_id = ? LIMIT 1");
                if ($q) { $q->bind_param('i', $id); $q->execute(); $r = $q->get_result()->fetch_assoc(); $logName = $r['building_name'] ?? null; }
            }
            $logMsg = $logName ? "Updated building details for '{$logName}'" : 'Updated building details';
            log_system_action($mysqli, $authUserId, 'update_building', $logMsg);
            json_response(['ok' => true, 'building_id' => $id, 'message' => 'updated']);

        } elseif ($request_method === 'POST') {
            // Insert into buildings table. Keep insert minimal to avoid errors when latitude/longitude columns are missing.
            $name = isset($input['building_name']) ? trim($input['building_name']) : '';
            if ($name === '') json_response(['error' => 'missing_name', 'message' => 'Building name is required'], 400);
            if (!empty($input['school_id'])) location_assert_active_school($mysqli, (int)$input['school_id']);

            // duplicate name check (case-insensitive)
            $nstmt = $mysqli->prepare("SELECT building_id FROM tbl_buildings WHERE LOWER(building_name) = LOWER(?) LIMIT 1");
            $nstmt->bind_param('s', $name);
            $nstmt->execute();
            if ($nstmt->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_name', 'message' => 'A building with the same name already exists'], 409);

            $latitude = array_key_exists('latitude', $input) && $input['latitude'] !== '' ? (float)$input['latitude'] : null;
            $longitude = array_key_exists('longitude', $input) && $input['longitude'] !== '' ? (float)$input['longitude'] : null;
            $latCol = find_existing_column('tbl_buildings', ['latitude','alt','altitude','lat']);
            $lonCol = find_existing_column('tbl_buildings', ['longitude','lon','lng','long']);
            if ($latitude !== null && $longitude !== null && $latCol && $lonCol) {
                $lstmt = $mysqli->prepare("SELECT building_id FROM tbl_buildings WHERE ABS(COALESCE(`{$latCol}`,0) - ?) < 0.0000001 AND ABS(COALESCE(`{$lonCol}`,0) - ?) < 0.0000001 LIMIT 1");
                if ($lstmt) {
                    $lstmt->bind_param('dd', $latitude, $longitude);
                    $lstmt->execute();
                    if ($lstmt->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_latlon', 'message' => 'Another building with same latitude/longitude exists'], 409);
                }
            }

            // Build insert dynamically depending on available columns
            $descCol = find_existing_column('tbl_buildings', ['location_description','description','building_description']);
            $insertCols = ['building_name', 'radius', 'status'];
            $placeholders = ['?', '?', '?'];
            $types = 'sis';
            $vals = [$name, isset($input['radius']) ? (int)$input['radius'] : 0, 'active'];

            if ($descCol && isset($input['location_description'])) {
                array_unshift($insertCols, $descCol);
                array_unshift($placeholders, '?');
                $types = 's' . $types;
                array_unshift($vals, $input['location_description']);
            }

            // accept optional school_id on insert
            if (isset($input['school_id'])) {
                array_unshift($insertCols, 'school_id');
                array_unshift($placeholders, '?');
                $types = 'i' . $types;
                array_unshift($vals, (int)$input['school_id']);
            }

            $sql = 'INSERT INTO tbl_buildings (' . implode(', ', $insertCols) . ') VALUES (' . implode(', ', $placeholders) . ')';
            $stmt = $mysqli->prepare($sql);
            if (!$stmt) json_response(['error' => 'db_prepare_failed', 'details' => $mysqli->error], 500);
            $stmt->bind_param($types, ...$vals);
            $stmt->execute();
            $newId = $stmt->insert_id;
            // Log create building (text-only message)
            $logMsg = $name ? "Created building: {$name}" : 'Created a new building';
            log_system_action($mysqli, $authUserId, 'create_building', $logMsg);

            // If any latitude/longitude-like column exists, update it with provided payload values
            $latCol = find_existing_column('tbl_buildings', ['latitude','alt','altitude','lat']);
            $lonCol = find_existing_column('tbl_buildings', ['longitude','lon','lng','long']);
            if ($latCol || $lonCol) {
                $parts = [];
                $types2 = '';
                $vals2 = [];
                if ($latCol && isset($input['latitude'])) { $parts[] = "`{$latCol}` = ?"; $types2 .= 'd'; $vals2[] = (float)$input['latitude']; }
                if ($lonCol && isset($input['longitude'])) { $parts[] = "`{$lonCol}` = ?"; $types2 .= 'd'; $vals2[] = (float)$input['longitude']; }
                if (!empty($parts)) {
                    $types2 .= 'i'; $vals2[] = $newId;
                    $ustmt = $mysqli->prepare("UPDATE tbl_buildings SET " . implode(', ', $parts) . " WHERE building_id = ?");
                    if ($ustmt) {
                        $ustmt->bind_param($types2, ...$vals2);
                        $ustmt->execute();
                    }
                }
            }

            json_response(['building_id' => $newId] + $input, 201);
        }
        break;

    case 'floors':
         if ($request_method === 'GET') {
            // Support optional building_id filter
            if (isset($_GET['building_id']) && is_numeric($_GET['building_id'])) {
                $bId = (int)$_GET['building_id'];
                $fstmt = $mysqli->prepare("SELECT f.floor_id, f.building_id, b.building_name, f.floor_name, f.baseline_altitude, f.floor_meter_vertical, f.qr_token, f.manual_code, f.status FROM tbl_floors f JOIN tbl_buildings b ON f.building_id = b.building_id WHERE f.building_id = ? ORDER BY f.floor_name");
                if ($fstmt === false) json_response(['error' => 'Failed to prepare floors query', 'sql_error' => $mysqli->error], 500);
                $fstmt->bind_param('i', $bId);
                $fstmt->execute();
                $floors_res = $fstmt->get_result();
                json_response($floors_res->fetch_all(MYSQLI_ASSOC));
            } else {
                $result = $mysqli->query("SELECT f.floor_id, f.building_id, b.building_name, f.floor_name, f.baseline_altitude, f.floor_meter_vertical, f.qr_token, f.manual_code, f.status FROM tbl_floors f JOIN tbl_buildings b ON f.building_id = b.building_id ORDER BY f.building_id, f.floor_name");
                if (!$result) json_response(['error' => 'Failed to fetch floors: ' . $mysqli->error], 500);
                json_response($result->fetch_all(MYSQLI_ASSOC));
            }
        } elseif ($request_method === 'POST' && is_numeric($param1) && ($param2 === 'update' || $param2 === null)) {
            // Update floor: POST /floors/{id}/update
            $id = (int)$param1;
            $building_id = isset($input['building_id']) ? (int)$input['building_id'] : null;
            $floor_name = isset($input['floor_name']) ? trim($input['floor_name']) : null;
            $baseline_altitude = array_key_exists('baseline_altitude', $input) && $input['baseline_altitude'] !== '' ? (float)$input['baseline_altitude'] : null;
            $floor_meter_vertical = array_key_exists('floor_meter_vertical', $input) && $input['floor_meter_vertical'] !== '' ? (float)$input['floor_meter_vertical'] : null;
            $status = isset($input['status']) ? $input['status'] : null;
            location_assert_floor_identity_preserved($mysqli, $id, $building_id, $floor_name);
            $currentFloorStmt = $mysqli->prepare("SELECT building_id, status FROM tbl_floors WHERE floor_id = ? LIMIT 1");
            if (!$currentFloorStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $currentFloorStmt->bind_param('i', $id); $currentFloorStmt->execute(); $currentFloor = $currentFloorStmt->get_result()->fetch_assoc(); $currentFloorStmt->close();
            if (!$currentFloor) json_response(['error' => 'floor_not_found', 'message' => 'Floor not found.'], 404);
            location_assert_archived_update_is_restore_only($currentFloor['status'] ?? null, $input);
            $status = location_prepare_status_transition($mysqli, 'floor', $id, $currentFloor['status'] ?? null, $status);
            $candidateBuildingId = $building_id ?? (int)($currentFloor['building_id'] ?? 0);
            $candidateFloorStatus = $status ?? (location_normalize_status($currentFloor['status'] ?? null) ?? 'inactive');
            if ($candidateFloorStatus === 'active') location_assert_active_building($mysqli, $candidateBuildingId);

            // basic validation
            if ($floor_name) {
                $nstmt = $mysqli->prepare("SELECT floor_id FROM tbl_floors WHERE LOWER(floor_name) = LOWER(?) AND building_id = ? AND floor_id != ? LIMIT 1");
                $nstmt->bind_param('sii', $floor_name, $building_id, $id);
                $nstmt->execute();
                if ($nstmt->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_name', 'message' => 'A floor with the same name already exists in this building'], 409);
            }
            if ($baseline_altitude !== null && $building_id !== null) {
                $lstmt = $mysqli->prepare("SELECT floor_id FROM tbl_floors WHERE ABS(COALESCE(baseline_altitude,0) - ?) < 0.0000001 AND building_id = ? AND floor_id != ? LIMIT 1");
                if ($lstmt) {
                    $lstmt->bind_param('dii', $baseline_altitude, $building_id, $id);
                    $lstmt->execute();
                    if ($lstmt->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_altitude', 'message' => 'Another floor with same baseline altitude exists in this building'], 409);
                }
            }

            // Build update
            $sets = [];
            $types = '';
            $vals = [];
            if ($building_id !== null) { $sets[] = 'building_id = ?'; $types .= 'i'; $vals[] = $building_id; }
            if ($floor_name !== null) { $sets[] = 'floor_name = ?'; $types .= 's'; $vals[] = $floor_name; }
            if ($baseline_altitude !== null) { $sets[] = 'baseline_altitude = ?'; $types .= 'd'; $vals[] = $baseline_altitude; }
            if ($floor_meter_vertical !== null) { $sets[] = 'floor_meter_vertical = ?'; $types .= 'd'; $vals[] = $floor_meter_vertical; }
            if ($status !== null) { $sets[] = 'status = ?'; $types .= 's'; $vals[] = $status; }

            if (empty($sets)) json_response(['ok' => true, 'message' => 'no_changes']);
            $types .= 'i'; $vals[] = $id;
            $sql = 'UPDATE tbl_floors SET ' . implode(', ', $sets) . ' WHERE floor_id = ?';
            $ustmt = $mysqli->prepare($sql);
            if (!$ustmt) json_response(['error' => 'db_prepare_failed', 'details' => $mysqli->error], 500);
            $ustmt->bind_param($types, ...$vals);
            $ustmt->execute();
            // Log floor update
            $logFloor = $floor_name ?? null;
            if (!$logFloor) {
                $q = $mysqli->prepare("SELECT floor_name FROM tbl_floors WHERE floor_id = ? LIMIT 1");
                if ($q) { $q->bind_param('i', $id); $q->execute(); $r = $q->get_result()->fetch_assoc(); $logFloor = $r['floor_name'] ?? null; }
            }
            $logMsg = $logFloor ? "Updated floor details for '{$logFloor}'" : 'Updated floor details';
            log_system_action($mysqli, $authUserId, 'update_floor', $logMsg);
            json_response(['ok' => true, 'floor_id' => $id, 'message' => 'updated']);

        } elseif ($request_method === 'PUT' && is_numeric($param1)) {
            // Accept PUT /floors/{id} as an update (same validations as POST update)
            $id = (int)$param1;
            $building_id = isset($input['building_id']) ? (int)$input['building_id'] : null;
            $floor_name = isset($input['floor_name']) ? trim($input['floor_name']) : null;
            $baseline_altitude = array_key_exists('baseline_altitude', $input) && $input['baseline_altitude'] !== '' ? (float)$input['baseline_altitude'] : null;
            $floor_meter_vertical = array_key_exists('floor_meter_vertical', $input) && $input['floor_meter_vertical'] !== '' ? (float)$input['floor_meter_vertical'] : null;
            $status = isset($input['status']) ? $input['status'] : null;
            location_assert_floor_identity_preserved($mysqli, $id, $building_id, $floor_name);
            $currentFloorStmt = $mysqli->prepare("SELECT building_id, status FROM tbl_floors WHERE floor_id = ? LIMIT 1");
            if (!$currentFloorStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $currentFloorStmt->bind_param('i', $id); $currentFloorStmt->execute(); $currentFloor = $currentFloorStmt->get_result()->fetch_assoc(); $currentFloorStmt->close();
            if (!$currentFloor) json_response(['error' => 'floor_not_found', 'message' => 'Floor not found.'], 404);
            location_assert_archived_update_is_restore_only($currentFloor['status'] ?? null, $input);
            $status = location_prepare_status_transition($mysqli, 'floor', $id, $currentFloor['status'] ?? null, $status);
            $candidateBuildingId = $building_id ?? (int)($currentFloor['building_id'] ?? 0);
            $candidateFloorStatus = $status ?? (location_normalize_status($currentFloor['status'] ?? null) ?? 'inactive');
            if ($candidateFloorStatus === 'active') location_assert_active_building($mysqli, $candidateBuildingId);

            // basic validation (duplicate name / altitude)
            if ($floor_name) {
                $nstmt = $mysqli->prepare("SELECT floor_id FROM tbl_floors WHERE LOWER(floor_name) = LOWER(?) AND building_id = ? AND floor_id != ? LIMIT 1");
                $nstmt->bind_param('sii', $floor_name, $building_id, $id);
                $nstmt->execute();
                if ($nstmt->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_name', 'message' => 'A floor with the same name already exists in this building'], 409);
            }
            if ($baseline_altitude !== null && $building_id !== null) {
                $lstmt = $mysqli->prepare("SELECT floor_id FROM tbl_floors WHERE ABS(COALESCE(baseline_altitude,0) - ?) < 0.0000001 AND building_id = ? AND floor_id != ? LIMIT 1");
                if ($lstmt) {
                    $lstmt->bind_param('dii', $baseline_altitude, $building_id, $id);
                    $lstmt->execute();
                    if ($lstmt->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_altitude', 'message' => 'Another floor with same baseline altitude exists in this building'], 409);
                }
            }

            // Build update
            $sets = [];
            $types = '';
            $vals = [];
            if ($building_id !== null) { $sets[] = 'building_id = ?'; $types .= 'i'; $vals[] = $building_id; }
            if ($floor_name !== null) { $sets[] = 'floor_name = ?'; $types .= 's'; $vals[] = $floor_name; }
            if ($baseline_altitude !== null) { $sets[] = 'baseline_altitude = ?'; $types .= 'd'; $vals[] = $baseline_altitude; }
            if ($floor_meter_vertical !== null) { $sets[] = 'floor_meter_vertical = ?'; $types .= 'd'; $vals[] = $floor_meter_vertical; }
            if ($status !== null) { $sets[] = 'status = ?'; $types .= 's'; $vals[] = $status; }

            if (empty($sets)) json_response(['ok' => true, 'message' => 'no_changes']);
            $types .= 'i'; $vals[] = $id;
            $sql = 'UPDATE tbl_floors SET ' . implode(', ', $sets) . ' WHERE floor_id = ?';
            $ustmt = $mysqli->prepare($sql);
            if (!$ustmt) json_response(['error' => 'db_prepare_failed', 'details' => $mysqli->error], 500);
            $ustmt->bind_param($types, ...$vals);
            $ustmt->execute();
            // Log floor update (PUT)
            $logFloor = $floor_name ?? null;
            if (!$logFloor) {
                $q = $mysqli->prepare("SELECT floor_name FROM tbl_floors WHERE floor_id = ? LIMIT 1");
                if ($q) { $q->bind_param('i', $id); $q->execute(); $r = $q->get_result()->fetch_assoc(); $logFloor = $r['floor_name'] ?? null; }
            }
            $logMsg = $logFloor ? "Updated floor details for '{$logFloor}'" : 'Updated floor details';
            log_system_action($mysqli, $authUserId, 'update_floor', $logMsg);
            json_response(['ok' => true, 'floor_id' => $id, 'message' => 'updated']);

        } elseif ($request_method === 'POST' && !$param1) {
            // Serialize floor creation per building so two operators cannot
            // create the same next floor at the same time.
            $building_id = isset($input['building_id']) ? (int)$input['building_id'] : null;
            $floor_name = isset($input['floor_name']) ? trim($input['floor_name']) : '';
            $baseline_altitude = isset($input['baseline_altitude']) ? (float)$input['baseline_altitude'] : null;
            $floor_meter_vertical = isset($input['floor_meter_vertical']) ? (float)$input['floor_meter_vertical'] : null;
            if (!$building_id || $floor_name === '') json_response(['error' => 'missing_fields', 'message' => 'Building and floor name are required'], 400);

            $submittedIsBasement = location_is_basement_floor($floor_name);
            $submittedLevel = $submittedIsBasement ? null : location_floor_level_number($floor_name);
            if (!$submittedIsBasement && $submittedLevel === null) {
                json_response(['error' => 'invalid_floor_level', 'message' => 'Choose Basement or the next numbered floor.'], 400);
            }

            $mysqli->begin_transaction();
            try {
                $buildingStmt = $mysqli->prepare("SELECT building_name, status FROM tbl_buildings WHERE building_id = ? LIMIT 1 FOR UPDATE");
                if (!$buildingStmt) throw new Exception($mysqli->error);
                $buildingStmt->bind_param('i', $building_id);
                if (!$buildingStmt->execute()) throw new Exception($buildingStmt->error);
                $buildingRow = $buildingStmt->get_result()->fetch_assoc();
                $buildingStmt->close();
                if (!$buildingRow) {
                    $mysqli->rollback();
                    json_response(['error' => 'building_not_found', 'message' => 'Selected building does not exist.'], 404);
                }
                if (!location_status_is_active($buildingRow['status'] ?? null)) {
                    $mysqli->rollback();
                    json_response(['error' => 'building_inactive', 'message' => 'Floors can only be added to an active building.'], 409);
                }
                location_assert_active_building($mysqli, $building_id);

                $floorStmt = $mysqli->prepare("SELECT floor_name FROM tbl_floors WHERE building_id = ?");
                if (!$floorStmt) throw new Exception($mysqli->error);
                $floorStmt->bind_param('i', $building_id);
                if (!$floorStmt->execute()) throw new Exception($floorStmt->error);
                $floorRows = $floorStmt->get_result();
                $highestLevel = 0;
                $basementAlreadyExists = false;
                while ($floorRow = $floorRows->fetch_assoc()) {
                    if (location_is_basement_floor($floorRow['floor_name'] ?? '')) {
                        $basementAlreadyExists = true;
                    }
                    $existingLevel = location_floor_level_number($floorRow['floor_name'] ?? '');
                    if ($existingLevel !== null) $highestLevel = max($highestLevel, $existingLevel);
                }
                $floorStmt->close();
                $nextLevel = $highestLevel + 1;
                if ($submittedIsBasement) {
                    if ($basementAlreadyExists) {
                        $mysqli->rollback();
                        json_response(['error' => 'basement_exists', 'message' => 'This building already has a Basement.'], 409);
                    }
                    $floor_name = trim((string)$buildingRow['building_name']) . '-Basement';
                } else {
                    if ($nextLevel > 15) {
                        $mysqli->rollback();
                        json_response(['error' => 'floor_limit_reached', 'message' => 'This building has reached the configured maximum of 15 numbered floors.'], 409);
                    }
                    if ($submittedLevel !== $nextLevel) {
                        $mysqli->rollback();
                        json_response([
                            'error' => 'stale_floor_level',
                            'message' => 'The next available floor is ' . location_floor_level_label($nextLevel) . '. Refresh and try again.',
                            'expected_floor_level' => $nextLevel,
                        ], 409);
                    }
                    $floor_name = trim((string)$buildingRow['building_name']) . '-' . location_floor_level_label($nextLevel);
                }
                if ($baseline_altitude !== null) {
                    $lstmt = $mysqli->prepare("SELECT floor_id FROM tbl_floors WHERE ABS(COALESCE(baseline_altitude,0) - ?) < 0.0000001 AND building_id = ? LIMIT 1");
                    if (!$lstmt) throw new Exception($mysqli->error);
                    $lstmt->bind_param('di', $baseline_altitude, $building_id);
                    if (!$lstmt->execute()) throw new Exception($lstmt->error);
                    if ($lstmt->get_result()->fetch_assoc()) {
                        $mysqli->rollback();
                        json_response(['error' => 'duplicate_altitude', 'message' => 'Another floor with same baseline altitude exists in this building'], 409);
                    }
                    $lstmt->close();
                }

                $token = generate_random_token();
                $manualCode = manual_floor_code_generate($mysqli, $buildingRow['building_name'] ?? '', $floor_name);
                $stmt = $mysqli->prepare("INSERT INTO tbl_floors (building_id, floor_name, baseline_altitude, floor_meter_vertical, qr_token, manual_code, status) VALUES (?, ?, ?, ?, ?, ?, 'active')");
                if (!$stmt) throw new Exception($mysqli->error);
                $stmt->bind_param("isddss", $building_id, $floor_name, $baseline_altitude, $floor_meter_vertical, $token, $manualCode);
                if (!$stmt->execute()) throw new Exception($stmt->error);
                $newFloorId = (int)$stmt->insert_id;
                $mysqli->commit();
            } catch (Throwable $e) {
                $mysqli->rollback();
                json_response(['error' => 'create_floor_failed', 'message' => $e->getMessage()], 500);
            }

            $bName = $buildingRow['building_name'] ?? null;
            $logFloorName = $floor_name ? "{$floor_name}" : 'a new floor';
            $logMsg = $bName ? "Created floor '{$logFloorName}' for building '{$bName}'" : "Created floor '{$logFloorName}'";
            log_system_action($mysqli, $authUserId, 'create_floor', $logMsg);
            json_response(['floor_id' => $newFloorId, 'floor_name' => $floor_name, 'floor_level' => $submittedIsBasement ? null : $nextLevel, 'floor_type' => $submittedIsBasement ? 'basement' : 'numbered', 'qr_token' => $token, 'manual_code' => $manualCode, 'status' => 'active'] + $input, 201);

        } elseif ($request_method === 'POST' && is_numeric($param1) && $param2 === 'qr' && $param3 === 'regenerate') {
            // Regenerate QR token for a specific floor; also ensure status=active
            $parentStmt = $mysqli->prepare("SELECT building_id, status FROM tbl_floors WHERE floor_id = ? LIMIT 1");
            if (!$parentStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $floorId = (int)$param1;
            $parentStmt->bind_param('i', $floorId); $parentStmt->execute(); $parent = $parentStmt->get_result()->fetch_assoc(); $parentStmt->close();
            if (!$parent) json_response(['error' => 'not_found', 'message' => 'Floor not found.'], 404);
            if (location_normalize_status($parent['status'] ?? null) !== 'active') {
                json_response(['error' => 'inactive_floor', 'message' => 'Activate the floor before regenerating its QR code.'], 409);
            }
            location_assert_active_building($mysqli, (int)$parent['building_id']);
            $newToken = generate_random_token();
            $stmt = $mysqli->prepare("UPDATE tbl_floors SET qr_token = ?, status = 'active' WHERE floor_id = ?");
            $stmt->bind_param("si", $newToken, $param1);
            $stmt->execute();
            // Log QR regeneration
            $qrFloorName = null;
            $qrf = $mysqli->prepare("SELECT floor_name FROM tbl_floors WHERE floor_id = ? LIMIT 1");
            if ($qrf) { $qrf->bind_param('i', $param1); $qrf->execute(); $qrfRow = $qrf->get_result()->fetch_assoc(); $qrFloorName = $qrfRow['floor_name'] ?? null; $qrf->close(); }
            log_system_action($mysqli, $authUserId, 'regenerate_floor_qr', "Regenerated QR code for floor '{$qrFloorName}'");
            $manualStmt = $mysqli->prepare('SELECT manual_code FROM tbl_floors WHERE floor_id = ? LIMIT 1');
            $manualCode = null;
            if ($manualStmt) {
                $manualStmt->bind_param('i', $floorId);
                $manualStmt->execute();
                $manualCode = $manualStmt->get_result()->fetch_assoc()['manual_code'] ?? null;
                $manualStmt->close();
            }
            json_response(['ok' => true, 'floor_id' => (int)$param1, 'qr_token' => $newToken, 'manual_code' => $manualCode, 'status' => 'active']);
        } elseif ($request_method === 'POST' && is_numeric($param1) && $param2 === 'manual-code' && $param3 === 'regenerate') {
            $floorId = (int)$param1;
            $stmt = $mysqli->prepare("SELECT f.floor_name, f.status, b.building_name, b.status AS building_status
                FROM tbl_floors f JOIN tbl_buildings b ON b.building_id = f.building_id
                WHERE f.floor_id = ? LIMIT 1");
            if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $stmt->bind_param('i', $floorId);
            $stmt->execute();
            $floor = $stmt->get_result()->fetch_assoc();
            $stmt->close();
            if (!$floor) json_response(['error' => 'not_found', 'message' => 'Floor not found.'], 404);
            if (!location_status_is_active($floor['status'] ?? null) || !location_status_is_active($floor['building_status'] ?? null)) {
                json_response(['error' => 'inactive_floor', 'message' => 'Activate the floor and building before regenerating its manual code.'], 409);
            }

            $manualCode = manual_floor_code_generate($mysqli, $floor['building_name'] ?? '', $floor['floor_name'] ?? '');
            $update = $mysqli->prepare('UPDATE tbl_floors SET manual_code = ? WHERE floor_id = ?');
            if (!$update) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $update->bind_param('si', $manualCode, $floorId);
            $update->execute();
            $update->close();
            log_system_action($mysqli, $authUserId, 'regenerate_floor_manual_code', "Regenerated manual code for floor '{$floor['floor_name']}'");
            json_response(['ok' => true, 'floor_id' => $floorId, 'manual_code' => $manualCode, 'status' => $floor['status']]);
        } elseif ($request_method === 'POST' && is_numeric($param1) && $param2 === 'qr' && $param3 === 'toggle-active') {
            // Toggle floor status between active/inactive (use 'status' column)
            $active = isset($input['active']) && $input['active'] ? 'active' : 'inactive';
            $statusStmt = $mysqli->prepare("SELECT building_id, status FROM tbl_floors WHERE floor_id = ? LIMIT 1");
            if (!$statusStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $floorId = (int)$param1;
            $statusStmt->bind_param('i', $floorId); $statusStmt->execute(); $floorRow = $statusStmt->get_result()->fetch_assoc(); $statusStmt->close();
            if (!$floorRow) json_response(['error' => 'not_found', 'message' => 'Floor not found.'], 404);
            if (location_normalize_status($floorRow['status'] ?? null) === 'archive') {
                json_response(['error' => 'archived_location', 'message' => 'Archived floors cannot use QR attendance. Restore the floor first.'], 409);
            }
            if ($active === 'active') {
                location_assert_active_building($mysqli, (int)$floorRow['building_id']);
            }
            $stmt = $mysqli->prepare("UPDATE tbl_floors SET status = ? WHERE floor_id = ?");
            $stmt->bind_param("si", $active, $param1);
            $stmt->execute();
            // Log QR toggle
            $qrToggleFloorName = null;
            $qtf = $mysqli->prepare("SELECT floor_name FROM tbl_floors WHERE floor_id = ? LIMIT 1");
            if ($qtf) { $qtf->bind_param('i', $param1); $qtf->execute(); $qtfRow = $qtf->get_result()->fetch_assoc(); $qrToggleFloorName = $qtfRow['floor_name'] ?? null; $qtf->close(); }
            log_system_action($mysqli, $authUserId, 'toggle_floor_qr', "Set QR status to {$active} for floor '{$qrToggleFloorName}'");
            json_response(['ok' => true, 'floor_id' => (int)$param1, 'status' => $active]);
        } elseif ($request_method === 'POST' && is_numeric($param1) && $param2 === 'toggle') {
            // POST /floors/{id}/toggle - toggle active/inactive
            $id = (int)$param1;
            // fetch current status and floor name
            $cstmt = $mysqli->prepare("SELECT status, floor_name FROM tbl_floors WHERE floor_id = ? LIMIT 1");
            if ($cstmt) {
                $cstmt->bind_param('i', $id);
                $cstmt->execute();
                $cur = $cstmt->get_result()->fetch_assoc();
                $curStatus = $cur['status'] ?? null;
                $toggleFloorName = $cur['floor_name'] ?? null;
            } else {
                $curStatus = null;
                $toggleFloorName = null;
            }
            $newStatus = ($curStatus && strtolower($curStatus) === 'active') ? 'inactive' : 'active';
            // allow explicit status in payload
            if (isset($input['status']) && in_array(strtolower($input['status']), ['active','inactive','archive'])) {
                $newStatus = $input['status'];
            }
            $newStatus = location_prepare_status_transition($mysqli, 'floor', $id, $curStatus, $newStatus);
            if (strtolower((string)$newStatus) === 'active') {
                $parentStmt = $mysqli->prepare("SELECT building_id FROM tbl_floors WHERE floor_id = ? LIMIT 1");
                if (!$parentStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $parentStmt->bind_param('i', $id); $parentStmt->execute(); $parent = $parentStmt->get_result()->fetch_assoc(); $parentStmt->close();
                location_assert_active_building($mysqli, (int)($parent['building_id'] ?? 0));
            }
            $ust = $mysqli->prepare("UPDATE tbl_floors SET status = ? WHERE floor_id = ?");
            if (!$ust) json_response(['error' => 'db_prepare_failed', 'details' => $mysqli->error], 500);
            $ust->bind_param('si', $newStatus, $id);
            $ust->execute();
            // Log floor toggle
            log_system_action($mysqli, $authUserId, 'toggle_floor', "Changed status of floor '{$toggleFloorName}' to {$newStatus}");
            json_response(['ok' => true, 'floor_id' => $id, 'status' => $newStatus]);

        } elseif ($request_method === 'POST' && is_numeric($param1) && $param2 === 'archive') {
            // POST /floors/{id}/archive - mark as archived and deactivate QR
            $id = (int)$param1;
            // Get floor name for logging
            $archFloorName = null;
            $af = $mysqli->prepare("SELECT floor_name FROM tbl_floors WHERE floor_id = ? LIMIT 1");
            if ($af) { $af->bind_param('i', $id); $af->execute(); $afRow = $af->get_result()->fetch_assoc(); $archFloorName = $afRow['floor_name'] ?? null; $af->close(); }
            location_assert_can_archive($mysqli, 'floor', $id);
            $ust = $mysqli->prepare("UPDATE tbl_floors SET status = 'archive' WHERE floor_id = ?");
            if (!$ust) json_response(['error' => 'db_prepare_failed', 'details' => $mysqli->error], 500);
            $ust->bind_param('i', $id);
            $ust->execute();
            // Log floor archive
            log_system_action($mysqli, $authUserId, 'archive_floor', "Archived floor '{$archFloorName}'");
            // ensure qr considered inactive by status field
            json_response(['ok' => true, 'floor_id' => $id, 'status' => 'archive']);
        }
        break;

    case 'rooms':
        if ($request_method === 'GET' && !$param1) {
            // Return a lightweight list used by dropdowns when ?list=1 is provided
            if (!empty($_GET['list'])) {
                $sql = "SELECT r.room_id, r.room_name, r.floor_id, r.status
                    FROM tbl_rooms r
                    JOIN tbl_floors f ON f.floor_id = r.floor_id
                    JOIN tbl_buildings b ON b.building_id = COALESCE(r.building_id, f.building_id)
                    LEFT JOIN tbl_school s ON s.school_id = b.school_id
                    WHERE LOWER(TRIM(COALESCE(r.status, ''))) IN ('active', '1', 'true')
                      AND LOWER(TRIM(COALESCE(f.status, ''))) IN ('active', '1', 'true')
                      AND LOWER(TRIM(COALESCE(b.status, ''))) IN ('active', '1', 'true')
                      AND (b.school_id IS NULL OR LOWER(TRIM(COALESCE(s.status, ''))) IN ('active', '1', 'true'))
                    ORDER BY r.room_name";
                $result = $mysqli->query($sql);
                if (!$result) json_response(['error' => 'query_failed', 'message' => $mysqli->error], 500);
                $out = [];
                while ($r = $result->fetch_assoc()) {
                    $out[] = [
                        'room_id' => isset($r['room_id']) ? (int)$r['room_id'] : null,
                        'room_name' => $r['room_name'] ?? null,
                        'floor_id' => isset($r['floor_id']) ? (int)$r['floor_id'] : null,
                        'status' => $r['status'] ?? null,
                    ];
                }
                json_response($out);
            }

            // Lightweight list mode for dropdowns
            if (isset($_GET['list'])) {
                $bId = isset($_GET['building_id']) && is_numeric($_GET['building_id']) ? (int)$_GET['building_id'] : null;
                if ($bId) {
                    $stmt = $mysqli->prepare("SELECT room_id, room_name FROM tbl_rooms WHERE building_id = ? ORDER BY room_name");
                    if ($stmt) { $stmt->bind_param('i', $bId); $stmt->execute(); $res = $stmt->get_result(); $out=[]; while($r=$res->fetch_assoc()){ $out[]=['id'=>$r['room_id'],'label'=>$r['room_name']]; } $stmt->close(); echo json_encode($out); exit; }
                } else {
                    $res = $mysqli->query("SELECT room_id, room_name FROM tbl_rooms ORDER BY room_name");
                    $out = [];
                    if ($res) { while($r = $res->fetch_assoc()) $out[] = ['id' => $r['room_id'], 'label' => $r['room_name']]; }
                    echo json_encode($out); exit;
                }
            }
            // Rooms list: bring QR info from their floor (floors now own the QR)
            // Detect room lat/lon column names to avoid Unknown column errors
            $roomLatCol = find_existing_column('tbl_rooms', ['latitude','lat','alt','altitude']);
            $roomLonCol = find_existing_column('tbl_rooms', ['longitude','lon','lng','long']);
            $roomRadiusCol = find_existing_column('tbl_rooms', ['radius']);
            $paginateRooms = isset($_GET['paginate']) && (string)$_GET['paginate'] === '1';
            $roomIdentityList = isset($_GET['identities']) && (string)$_GET['identities'] === '1';

            if ($roomIdentityList) {
                $identitySelect = ['r.room_id', 'r.room_name', 'r.building_id', 'r.floor_id'];
                $identitySelect[] = $roomLatCol ? "r.`{$roomLatCol}` AS latitude" : 'NULL AS latitude';
                $identitySelect[] = $roomLonCol ? "r.`{$roomLonCol}` AS longitude" : 'NULL AS longitude';
                $identityResult = $mysqli->query('SELECT ' . implode(', ', $identitySelect) . ' FROM tbl_rooms r ORDER BY r.room_id');
                if (!$identityResult) json_response(['error' => 'query_failed', 'message' => $mysqli->error], 500);
                json_response($identityResult->fetch_all(MYSQLI_ASSOC));
            }

            if ($paginateRooms) {
                $roomPage = isset($_GET['page']) && is_numeric($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
                $roomPageSize = isset($_GET['page_size']) && is_numeric($_GET['page_size']) ? max(1, min(100, (int)$_GET['page_size'])) : 10;
                $roomBuildingId = isset($_GET['building_id']) && is_numeric($_GET['building_id']) ? (int)$_GET['building_id'] : null;
                $roomStatus = strtolower(trim((string)($_GET['status'] ?? '')));
                $roomSearch = substr(trim((string)($_GET['search'] ?? '')), 0, 200);
                if ($roomStatus !== '' && !in_array($roomStatus, ['active', 'inactive', 'archive'], true)) {
                    json_response(['error' => 'invalid_status', 'message' => 'Invalid room status filter.'], 422);
                }

                $roomFloorIds = [];
                foreach (explode(',', (string)($_GET['floor_ids'] ?? '')) as $floorIdValue) {
                    $floorIdValue = trim($floorIdValue);
                    if ($floorIdValue !== '' && ctype_digit($floorIdValue) && (int)$floorIdValue > 0) $roomFloorIds[] = (int)$floorIdValue;
                }
                $roomFloorIds = array_values(array_unique($roomFloorIds));

                $roomConditions = [];
                $roomTypes = '';
                $roomParams = [];
                if ($roomBuildingId !== null) { $roomConditions[] = 'r.building_id = ?'; $roomTypes .= 'i'; $roomParams[] = $roomBuildingId; }
                if ($roomFloorIds) $roomConditions[] = 'r.floor_id IN (' . implode(',', array_map('intval', $roomFloorIds)) . ')';
                if ($roomStatus !== '') { $roomConditions[] = 'LOWER(TRIM(r.status)) = ?'; $roomTypes .= 's'; $roomParams[] = $roomStatus; }
                if ($roomSearch !== '') {
                    $roomConditions[] = '(r.room_name LIKE ? OR b.building_name LIKE ? OR f.floor_name LIKE ?)';
                    $roomNeedle = '%' . $roomSearch . '%';
                    $roomTypes .= 'sss';
                    array_push($roomParams, $roomNeedle, $roomNeedle, $roomNeedle);
                }
                $roomWhereSql = $roomConditions ? ' WHERE ' . implode(' AND ', $roomConditions) : '';
                $roomFromSql = ' FROM tbl_rooms r LEFT JOIN tbl_floors f ON r.floor_id = f.floor_id LEFT JOIN tbl_buildings b ON r.building_id = b.building_id';

                $roomCountStmt = $mysqli->prepare('SELECT COUNT(*) AS total' . $roomFromSql . $roomWhereSql);
                if (!$roomCountStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                if ($roomTypes !== '') $roomCountStmt->bind_param($roomTypes, ...$roomParams);
                $roomCountStmt->execute();
                $roomTotal = (int)($roomCountStmt->get_result()->fetch_assoc()['total'] ?? 0);
                $roomCountStmt->close();
                $roomTotalPages = max(1, (int)ceil($roomTotal / $roomPageSize));
                $roomPage = min($roomPage, $roomTotalPages);
                $roomOffset = ($roomPage - 1) * $roomPageSize;

                $roomSelect = ['r.room_id', 'r.room_name'];
                $roomSelect[] = $roomLatCol ? "r.`{$roomLatCol}` AS latitude" : 'NULL AS latitude';
                $roomSelect[] = $roomLonCol ? "r.`{$roomLonCol}` AS longitude" : 'NULL AS longitude';
                $roomSelect[] = $roomRadiusCol ? "r.`{$roomRadiusCol}` AS radius" : 'NULL AS radius';
                array_push($roomSelect, 'r.status AS status', 'f.qr_token', 'f.status AS qr_status', 'r.building_id', 'r.floor_id', 'b.building_name', 'f.floor_name');
                $roomDataStmt = $mysqli->prepare('SELECT ' . implode(', ', $roomSelect) . $roomFromSql . $roomWhereSql . ' ORDER BY r.room_name LIMIT ? OFFSET ?');
                if (!$roomDataStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $roomDataTypes = $roomTypes . 'ii';
                $roomDataParams = array_merge($roomParams, [$roomPageSize, $roomOffset]);
                $roomDataStmt->bind_param($roomDataTypes, ...$roomDataParams);
                $roomDataStmt->execute();
                $roomRows = $roomDataStmt->get_result()->fetch_all(MYSQLI_ASSOC);
                $roomDataStmt->close();

                $roomStatusCounts = ['active' => 0, 'inactive' => 0, 'archive' => 0];
                $roomStatusResult = $mysqli->query('SELECT LOWER(TRIM(status)) AS room_status, COUNT(*) AS total FROM tbl_rooms GROUP BY LOWER(TRIM(status))');
                if (!$roomStatusResult) json_response(['error' => 'query_failed', 'message' => $mysqli->error], 500);
                while ($statusRow = $roomStatusResult->fetch_assoc()) {
                    $statusKey = (string)($statusRow['room_status'] ?? '');
                    if (array_key_exists($statusKey, $roomStatusCounts)) $roomStatusCounts[$statusKey] = (int)$statusRow['total'];
                }

                json_response([
                    'rows' => $roomRows,
                    'pagination' => ['page' => $roomPage, 'page_size' => $roomPageSize, 'total' => $roomTotal, 'total_pages' => $roomTotalPages],
                    'status_counts' => $roomStatusCounts,
                ]);
            }
            if (isset($_GET['building_id']) && is_numeric($_GET['building_id'])) {
                $bId = (int)$_GET['building_id'];
                $select = [ 'r.room_id', 'r.room_name' ];
                $select[] = $roomLatCol ? "r.`{$roomLatCol}` AS latitude" : "NULL AS latitude";
                $select[] = $roomLonCol ? "r.`{$roomLonCol}` AS longitude" : "NULL AS longitude";
                $select[] = $roomRadiusCol ? "r.`{$roomRadiusCol}` AS radius" : "NULL AS radius";
                $select[] = 'r.status AS status';
                $select[] = 'f.qr_token';
                $select[] = 'f.status AS qr_status';
                $select[] = 'r.building_id';
                $select[] = 'r.floor_id';
                $select[] = 'b.building_name';
                $select[] = 'f.floor_name';
                $sql = 'SELECT ' . implode(', ', $select) . ' FROM tbl_rooms r LEFT JOIN tbl_floors f ON r.floor_id = f.floor_id LEFT JOIN tbl_buildings b ON r.building_id = b.building_id WHERE r.building_id = ? ORDER BY r.room_name';
                $rstmt = $mysqli->prepare($sql);
                if ($rstmt === false) json_response(['error' => 'Failed to prepare rooms query', 'sql_error' => $mysqli->error], 500);
                $rstmt->bind_param('i', $bId);
                $rstmt->execute();
                $res = $rstmt->get_result();
                json_response($res->fetch_all(MYSQLI_ASSOC));
            } else {
                $select = [ 'r.room_id', 'r.room_name' ];
                $select[] = $roomLatCol ? "r.`{$roomLatCol}` AS latitude" : "NULL AS latitude";
                $select[] = $roomLonCol ? "r.`{$roomLonCol}` AS longitude" : "NULL AS longitude";
                $select[] = $roomRadiusCol ? "r.`{$roomRadiusCol}` AS radius" : "NULL AS radius";
                $select[] = 'r.status AS status';
                $select[] = 'f.qr_token';
                $select[] = 'f.status AS qr_status';
                $select[] = 'r.building_id';
                $select[] = 'r.floor_id';
                $select[] = 'b.building_name';
                $select[] = 'f.floor_name';
                $sql = 'SELECT ' . implode(', ', $select) . ' FROM tbl_rooms r LEFT JOIN tbl_floors f ON r.floor_id = f.floor_id LEFT JOIN tbl_buildings b ON r.building_id = b.building_id ORDER BY r.room_name';
                $result = $mysqli->query($sql);
                if (!$result) json_response(['error' => 'Failed to fetch rooms: ' . $mysqli->error], 500);
                json_response($result->fetch_all(MYSQLI_ASSOC));
            }
        } elseif ($request_method === 'POST' && !$param1) {
            // Rooms no longer store QR fields; floors own the QR token
            location_assert_active_room_hierarchy($mysqli, (int)($input['building_id'] ?? 0), (int)($input['floor_id'] ?? 0));
            $stmt = $mysqli->prepare("INSERT INTO tbl_rooms (building_id, floor_id, latitude, longitude, radius, room_name) VALUES (?, ?, ?, ?, ?, ?)");
            // types: building_id (i), floor_id (i), latitude (d), longitude (d), radius (d), room_name (s)
            $stmt->bind_param("iiddds", $input['building_id'], $input['floor_id'], $input['latitude'], $input['longitude'], $input['radius'], $input['room_name']);
            $stmt->execute();
            // Log room creation using names (no numeric ids)
            $roomName = $input['room_name'] ?? null;
            $floorName = null; $buildingName = null;
            $qf = $mysqli->prepare("SELECT f.floor_name, b.building_name FROM tbl_floors f JOIN tbl_buildings b ON f.building_id = b.building_id WHERE f.floor_id = ? LIMIT 1");
            if ($qf) { $qf->bind_param('i', $input['floor_id']); $qf->execute(); $rf = $qf->get_result()->fetch_assoc(); $floorName = $rf['floor_name'] ?? null; $buildingName = $rf['building_name'] ?? null; }
            $parts = [];
            if ($roomName) $parts[] = "room '{$roomName}'";
            if ($floorName) $parts[] = "on floor '{$floorName}'";
            if ($buildingName) $parts[] = "in building '{$buildingName}'";
            $logMsg = !empty($parts) ? 'Created ' . implode(' ', $parts) : 'Created a new room';
            log_system_action($mysqli, $authUserId, 'create_room', $logMsg);
            json_response(['room_id' => $stmt->insert_id] + $input, 201);
        } elseif ($request_method === 'POST' && is_numeric($param1) && ($param2 === 'update' || $param2 === null)) {
            // Update room: POST /rooms/{id}/update
            $id = (int)$param1;
            $building_id = isset($input['building_id']) ? (int)$input['building_id'] : null;
            $floor_id = isset($input['floor_id']) ? (int)$input['floor_id'] : null;
            $room_name = isset($input['room_name']) ? trim($input['room_name']) : null;
            $latitude = array_key_exists('latitude', $input) && $input['latitude'] !== '' ? (float)$input['latitude'] : null;
            $longitude = array_key_exists('longitude', $input) && $input['longitude'] !== '' ? (float)$input['longitude'] : null;
            $radius = array_key_exists('radius', $input) && $input['radius'] !== '' ? (float)$input['radius'] : null;
            $status = isset($input['status']) ? $input['status'] : null;
            $currentRoomStmt = $mysqli->prepare("SELECT building_id, floor_id, status FROM tbl_rooms WHERE room_id = ? LIMIT 1");
            if (!$currentRoomStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $currentRoomStmt->bind_param('i', $id); $currentRoomStmt->execute(); $currentRoom = $currentRoomStmt->get_result()->fetch_assoc(); $currentRoomStmt->close();
            if (!$currentRoom) json_response(['error' => 'room_not_found', 'message' => 'Room not found.'], 404);
            location_assert_archived_update_is_restore_only($currentRoom['status'] ?? null, $input);
            $status = location_prepare_status_transition($mysqli, 'room', $id, $currentRoom['status'] ?? null, $status);
            $candidateBuildingId = $building_id ?? (int)$currentRoom['building_id'];
            $candidateFloorId = $floor_id ?? (int)$currentRoom['floor_id'];
            $candidateRoomStatus = $status ?? (location_normalize_status($currentRoom['status'] ?? null) ?? 'inactive');
            if ($candidateRoomStatus === 'active') location_assert_active_room_hierarchy($mysqli, $candidateBuildingId, $candidateFloorId);

            // validation: duplicate room name within same building+floor
            if ($room_name && $building_id !== null && $floor_id !== null) {
                $nstmt = $mysqli->prepare("SELECT room_id FROM tbl_rooms WHERE LOWER(room_name) = LOWER(?) AND building_id = ? AND floor_id = ? AND room_id != ? LIMIT 1");
                $nstmt->bind_param('siii', $room_name, $building_id, $floor_id, $id);
                $nstmt->execute();
                if ($nstmt->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_name', 'message' => 'A room with the same name already exists in this floor'], 409);
            }

            $sets = [];
            $types = '';
            $vals = [];
            if ($building_id !== null) { $sets[] = 'building_id = ?'; $types .= 'i'; $vals[] = $building_id; }
            if ($floor_id !== null) { $sets[] = 'floor_id = ?'; $types .= 'i'; $vals[] = $floor_id; }
            if ($room_name !== null) { $sets[] = 'room_name = ?'; $types .= 's'; $vals[] = $room_name; }
            if ($latitude !== null) { $sets[] = 'latitude = ?'; $types .= 'd'; $vals[] = $latitude; }
            if ($longitude !== null) { $sets[] = 'longitude = ?'; $types .= 'd'; $vals[] = $longitude; }
            if ($radius !== null) { $sets[] = 'radius = ?'; $types .= 'd'; $vals[] = $radius; }
            if ($status !== null) { $sets[] = 'status = ?'; $types .= 's'; $vals[] = $status; }

            if (empty($sets)) json_response(['ok' => true, 'message' => 'no_changes']);
            $types .= 'i'; $vals[] = $id;
            $sql = 'UPDATE tbl_rooms SET ' . implode(', ', $sets) . ' WHERE room_id = ?';
            $ustmt = $mysqli->prepare($sql);
            if (!$ustmt) json_response(['error' => 'db_prepare_failed', 'details' => $mysqli->error], 500);
            $ustmt->bind_param($types, ...$vals);
            $ustmt->execute();
            // Log room update
            $logRoom = $room_name ?? null;
            if (!$logRoom) {
                $q = $mysqli->prepare("SELECT room_name FROM tbl_rooms WHERE room_id = ? LIMIT 1");
                if ($q) { $q->bind_param('i', $id); $q->execute(); $r = $q->get_result()->fetch_assoc(); $logRoom = $r['room_name'] ?? null; }
            }
            $logMsg = $logRoom ? "Updated room details for '{$logRoom}'" : 'Updated room details';
            log_system_action($mysqli, $authUserId, 'update_room', $logMsg);
            json_response(['ok' => true, 'room_id' => $id, 'message' => 'updated']);

        } elseif ($request_method === 'PUT' && is_numeric($param1)) {
            // Accept PUT /rooms/{id} as update
            $id = (int)$param1;
            $building_id = isset($input['building_id']) ? (int)$input['building_id'] : null;
            $floor_id = isset($input['floor_id']) ? (int)$input['floor_id'] : null;
            $room_name = isset($input['room_name']) ? trim($input['room_name']) : null;
            $latitude = array_key_exists('latitude', $input) && $input['latitude'] !== '' ? (float)$input['latitude'] : null;
            $longitude = array_key_exists('longitude', $input) && $input['longitude'] !== '' ? (float)$input['longitude'] : null;
            $radius = array_key_exists('radius', $input) && $input['radius'] !== '' ? (float)$input['radius'] : null;
            $status = isset($input['status']) ? $input['status'] : null;
            $currentRoomStmt = $mysqli->prepare("SELECT building_id, floor_id, status FROM tbl_rooms WHERE room_id = ? LIMIT 1");
            if (!$currentRoomStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $currentRoomStmt->bind_param('i', $id); $currentRoomStmt->execute(); $currentRoom = $currentRoomStmt->get_result()->fetch_assoc(); $currentRoomStmt->close();
            if (!$currentRoom) json_response(['error' => 'room_not_found', 'message' => 'Room not found.'], 404);
            location_assert_archived_update_is_restore_only($currentRoom['status'] ?? null, $input);
            $status = location_prepare_status_transition($mysqli, 'room', $id, $currentRoom['status'] ?? null, $status);
            $candidateBuildingId = $building_id ?? (int)$currentRoom['building_id'];
            $candidateFloorId = $floor_id ?? (int)$currentRoom['floor_id'];
            $candidateRoomStatus = $status ?? (location_normalize_status($currentRoom['status'] ?? null) ?? 'inactive');
            if ($candidateRoomStatus === 'active') location_assert_active_room_hierarchy($mysqli, $candidateBuildingId, $candidateFloorId);

            if ($room_name && $building_id !== null && $floor_id !== null) {
                $nstmt = $mysqli->prepare("SELECT room_id FROM tbl_rooms WHERE LOWER(room_name) = LOWER(?) AND building_id = ? AND floor_id = ? AND room_id != ? LIMIT 1");
                $nstmt->bind_param('siii', $room_name, $building_id, $floor_id, $id);
                $nstmt->execute();
                if ($nstmt->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_name', 'message' => 'A room with the same name already exists in this floor'], 409);
            }

            $sets = [];
            $types = '';
            $vals = [];
            if ($building_id !== null) { $sets[] = 'building_id = ?'; $types .= 'i'; $vals[] = $building_id; }
            if ($floor_id !== null) { $sets[] = 'floor_id = ?'; $types .= 'i'; $vals[] = $floor_id; }
            if ($room_name !== null) { $sets[] = 'room_name = ?'; $types .= 's'; $vals[] = $room_name; }
            if ($latitude !== null) { $sets[] = 'latitude = ?'; $types .= 'd'; $vals[] = $latitude; }
            if ($longitude !== null) { $sets[] = 'longitude = ?'; $types .= 'd'; $vals[] = $longitude; }
            if ($radius !== null) { $sets[] = 'radius = ?'; $types .= 'd'; $vals[] = $radius; }
            if ($status !== null) { $sets[] = 'status = ?'; $types .= 's'; $vals[] = $status; }

            if (empty($sets)) json_response(['ok' => true, 'message' => 'no_changes']);
            $types .= 'i'; $vals[] = $id;
            $sql = 'UPDATE tbl_rooms SET ' . implode(', ', $sets) . ' WHERE room_id = ?';
            $ustmt = $mysqli->prepare($sql);
            if (!$ustmt) json_response(['error' => 'db_prepare_failed', 'details' => $mysqli->error], 500);
            $ustmt->bind_param($types, ...$vals);
            $ustmt->execute();
            // Log room update (PUT)
            $logRoom = $room_name ?? null;
            if (!$logRoom) {
                $q = $mysqli->prepare("SELECT room_name FROM tbl_rooms WHERE room_id = ? LIMIT 1");
                if ($q) { $q->bind_param('i', $id); $q->execute(); $r = $q->get_result()->fetch_assoc(); $logRoom = $r['room_name'] ?? null; }
            }
            $logMsg = $logRoom ? "Updated room details for '{$logRoom}'" : 'Updated room details';
            log_system_action($mysqli, $authUserId, 'update_room', $logMsg);
            json_response(['ok' => true, 'room_id' => $id, 'message' => 'updated']);

        } elseif ($request_method === 'POST' && is_numeric($param1) && $param2 === 'toggle') {
            // POST /rooms/{id}/toggle - toggle active/inactive on room
            $id = (int)$param1;
            $cstmt = $mysqli->prepare("SELECT status, room_name FROM tbl_rooms WHERE room_id = ? LIMIT 1");
            if ($cstmt) {
                $cstmt->bind_param('i', $id);
                $cstmt->execute();
                $cur = $cstmt->get_result()->fetch_assoc();
                $curStatus = $cur['status'] ?? null;
                $toggleRoomName = $cur['room_name'] ?? null;
            } else {
                $curStatus = null;
                $toggleRoomName = null;
            }
            $newStatus = ($curStatus && strtolower($curStatus) === 'active') ? 'inactive' : 'active';
            if (isset($input['status']) && in_array(strtolower($input['status']), ['active','inactive','archive'])) {
                $newStatus = $input['status'];
            }
            $newStatus = location_prepare_status_transition($mysqli, 'room', $id, $curStatus, $newStatus);
            if (strtolower((string)$newStatus) === 'active') {
                $parentStmt = $mysqli->prepare("SELECT building_id, floor_id FROM tbl_rooms WHERE room_id = ? LIMIT 1");
                if (!$parentStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $parentStmt->bind_param('i', $id); $parentStmt->execute(); $parent = $parentStmt->get_result()->fetch_assoc(); $parentStmt->close();
                location_assert_active_room_hierarchy($mysqli, (int)($parent['building_id'] ?? 0), (int)($parent['floor_id'] ?? 0));
            }
            $ust = $mysqli->prepare("UPDATE tbl_rooms SET status = ? WHERE room_id = ?");
            if (!$ust) json_response(['error' => 'db_prepare_failed', 'details' => $mysqli->error], 500);
            $ust->bind_param('si', $newStatus, $id);
            $ust->execute();
            // Log room toggle
            log_system_action($mysqli, $authUserId, 'toggle_room', "Changed status of room '{$toggleRoomName}' to {$newStatus}");
            json_response(['ok' => true, 'room_id' => $id, 'status' => $newStatus]);

        } elseif ($request_method === 'POST' && is_numeric($param1) && $param2 === 'archive') {
            // POST /rooms/{id}/archive - mark room archived
            $id = (int)$param1;
            // Get room name for logging
            $archRoomName = null;
            $ar = $mysqli->prepare("SELECT room_name FROM tbl_rooms WHERE room_id = ? LIMIT 1");
            if ($ar) { $ar->bind_param('i', $id); $ar->execute(); $arRow = $ar->get_result()->fetch_assoc(); $archRoomName = $arRow['room_name'] ?? null; $ar->close(); }
            location_assert_can_archive($mysqli, 'room', $id);
            $ust = $mysqli->prepare("UPDATE tbl_rooms SET status = 'archive' WHERE room_id = ?");
            if (!$ust) json_response(['error' => 'db_prepare_failed', 'details' => $mysqli->error], 500);
            $ust->bind_param('i', $id);
            $ust->execute();
            // Log room archive
            log_system_action($mysqli, $authUserId, 'archive_room', "Archived room '{$archRoomName}'");
            json_response(['ok' => true, 'room_id' => $id, 'status' => 'archive']);
        } elseif ($request_method === 'GET' && $param1 === 'qr' && $param2) {
             // Lookup by QR token — now stored on floors; find the room that belongs to that floor (if any)
             $stmt = $mysqli->prepare("SELECT r.room_id, r.room_name, r.latitude, r.longitude, r.radius, r.status AS status, f.status AS qr_status, b.status AS building_status, b.building_id, b.building_name, f.floor_id, f.floor_name, f.baseline_altitude FROM tbl_rooms r JOIN tbl_buildings b ON r.building_id = b.building_id JOIN tbl_floors f ON r.floor_id = f.floor_id WHERE f.qr_token = ? LIMIT 1");
            $stmt->bind_param("s", $param2);
            $stmt->execute();
            $room = $stmt->get_result()->fetch_assoc();
            if (!$room) json_response(['error' => 'room_not_found'], 404);
            if (!location_status_is_active($room['status'] ?? null)
                || !location_status_is_active($room['qr_status'] ?? null)
                || !location_status_is_active($room['building_status'] ?? null)) {
                json_response(['error' => 'location_inactive', 'message' => 'This room, floor, or building is inactive or archived.'], 403);
            }
            json_response($room);
        } elseif ($request_method === 'GET' && is_numeric($param1)) {
            $stmt = $mysqli->prepare("SELECT r.room_id, r.room_name, r.latitude, r.longitude, r.radius, r.status AS status, f.qr_token, f.status AS qr_status, b.building_id, b.building_name, f.floor_id, f.floor_name, f.baseline_altitude FROM tbl_rooms r JOIN tbl_buildings b ON r.building_id = b.building_id JOIN tbl_floors f ON r.floor_id = f.floor_id WHERE r.room_id = ? LIMIT 1");
            $stmt->bind_param("i", $param1);
            $stmt->execute();
            $room = $stmt->get_result()->fetch_assoc();
            if (!$room) json_response(['error' => 'room_not_found'], 404);
            json_response($room);
        } elseif ($request_method === 'POST' && is_numeric($param1) && $param2 === 'qr' && $param3 === 'regenerate') {
            // Regenerate QR token for the floor that this room belongs to
            $parentStmt = $mysqli->prepare("SELECT r.status AS room_status, r.building_id, r.floor_id FROM tbl_rooms r WHERE r.room_id = ? LIMIT 1");
            if (!$parentStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $roomId = (int)$param1;
            $parentStmt->bind_param('i', $roomId); $parentStmt->execute(); $parent = $parentStmt->get_result()->fetch_assoc(); $parentStmt->close();
            if (!$parent) json_response(['error' => 'room_not_found'], 404);
            if (!location_status_is_active($parent['room_status'] ?? null)) json_response(['error' => 'inactive_room', 'message' => 'The room is inactive or archived. Activate the room before regenerating its QR code.'], 409);
            location_assert_active_room_hierarchy($mysqli, (int)$parent['building_id'], (int)$parent['floor_id']);
            $newToken = generate_random_token();
            $stmt = $mysqli->prepare("UPDATE tbl_floors f JOIN tbl_rooms r ON f.floor_id = r.floor_id SET f.qr_token = ?, f.status = 'active' WHERE r.room_id = ?");
            $stmt->bind_param("si", $newToken, $param1);
            $stmt->execute();
            json_response(['ok' => true, 'room_id' => (int)$param1, 'qr_token' => $newToken, 'status' => 'active']);
        }  elseif ($request_method === 'POST' && is_numeric($param1) && $param2 === 'qr' && $param3 === 'toggle-active') {
            $active = isset($input['active']) && $input['active'] ? 'active' : 'inactive';
            if ($active === 'active') {
                $parentStmt = $mysqli->prepare("SELECT r.status AS room_status, r.building_id, r.floor_id FROM tbl_rooms r WHERE r.room_id = ? LIMIT 1");
                if (!$parentStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $roomId = (int)$param1;
                $parentStmt->bind_param('i', $roomId); $parentStmt->execute(); $parent = $parentStmt->get_result()->fetch_assoc(); $parentStmt->close();
                if (!$parent) json_response(['error' => 'room_not_found'], 404);
                if (!location_status_is_active($parent['room_status'] ?? null)) json_response(['error' => 'inactive_room', 'message' => 'The room is inactive or archived. Activate the room before enabling its QR code.'], 409);
                location_assert_active_room_hierarchy($mysqli, (int)$parent['building_id'], (int)$parent['floor_id']);
            }
            $stmt = $mysqli->prepare("UPDATE tbl_floors f JOIN tbl_rooms r ON f.floor_id = r.floor_id SET f.status = ? WHERE r.room_id = ?");
            $stmt->bind_param("si", $active, $param1);
            $stmt->execute();
            json_response(['ok' => true, 'room_id' => (int)$param1, 'status' => $active]);
        }
        break;

    case 'school':
        if ($request_method === 'GET') {
            // Single school
            if (is_numeric($param1)) {
                $id = (int)$param1;
                $stmt = $mysqli->prepare("SELECT school_id, school_name, status FROM tbl_school WHERE school_id = ? LIMIT 1");
                if (!$stmt) json_response(['error' => 'db_prepare_failed', 'details' => $mysqli->error], 500);
                $stmt->bind_param('i', $id);
                $stmt->execute();
                $row = $stmt->get_result()->fetch_assoc();
                if (!$row) json_response(['error' => 'school_not_found'], 404);
                json_response($row);
            }

            $result = $mysqli->query("SELECT school_id, school_name, status FROM tbl_school ORDER BY school_name");
            if (!$result) json_response(['error' => 'Failed to fetch schools: ' . $mysqli->error], 500);
            json_response($result->fetch_all(MYSQLI_ASSOC));

        } elseif ($request_method === 'POST' && !$param1) {
            // Create school
            $name = isset($input['school_name']) ? trim($input['school_name']) : '';
            if ($name === '') json_response(['error' => 'missing_name', 'message' => 'School name is required'], 400);

            // duplicate name check (case-insensitive)
            $nstmt = $mysqli->prepare("SELECT school_id FROM tbl_school WHERE LOWER(school_name) = LOWER(?) LIMIT 1");
            if ($nstmt) {
                $nstmt->bind_param('s', $name);
                $nstmt->execute();
                if ($nstmt->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_name', 'message' => 'A school with the same name already exists'], 409);
            }

            $stmt = $mysqli->prepare("INSERT INTO tbl_school (school_name, status) VALUES (?, 'active')");
            if (!$stmt) json_response(['error' => 'db_prepare_failed', 'details' => $mysqli->error], 500);
            $stmt->bind_param('s', $name);
            $stmt->execute();
            // Log school creation (text only)
            $logMsg = $name ? "Created school: {$name}" : 'Created a new school';
            log_system_action($mysqli, $authUserId, 'create_school', $logMsg);
            json_response(['school_id' => $stmt->insert_id, 'school_name' => $name, 'status' => 'active'] + $input, 201);

        } elseif ($request_method === 'POST' && is_numeric($param1) && ($param2 === 'update' || $param2 === null)) {
            // Update school: POST /school/{id}/update
            $id = (int)$param1;
            $name = isset($input['school_name']) ? trim($input['school_name']) : null;
            $status = isset($input['status']) ? $input['status'] : null;

            // duplicate name check
            if ($name) {
                $nstmt = $mysqli->prepare("SELECT school_id FROM tbl_school WHERE LOWER(school_name) = LOWER(?) AND school_id != ? LIMIT 1");
                if ($nstmt) {
                    $nstmt->bind_param('si', $name, $id);
                    $nstmt->execute();
                    if ($nstmt->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_name', 'message' => 'A school with the same name already exists'], 409);
                }
            }

            $sets = [];
            $types = '';
            $vals = [];
            if ($name !== null) { $sets[] = 'school_name = ?'; $types .= 's'; $vals[] = $name; }
            if ($status !== null) { $sets[] = 'status = ?'; $types .= 's'; $vals[] = $status; }

            if (empty($sets)) json_response(['ok' => true, 'message' => 'no_changes']);
            $types .= 'i'; $vals[] = $id;
            $sql = 'UPDATE tbl_school SET ' . implode(', ', $sets) . ' WHERE school_id = ?';
            $ustmt = $mysqli->prepare($sql);
            if (!$ustmt) json_response(['error' => 'db_prepare_failed', 'details' => $mysqli->error], 500);
            $ustmt->bind_param($types, ...$vals);
            $ustmt->execute();
            // Log school update with friendly message (no raw ids)
            $logName = $name ?? null;
            if (!$logName) {
                $q = $mysqli->prepare("SELECT school_name FROM tbl_school WHERE school_id = ? LIMIT 1");
                if ($q) { $q->bind_param('i', $id); $q->execute(); $r = $q->get_result()->fetch_assoc(); $logName = $r['school_name'] ?? null; }
            }
            $logMsg = $logName ? "Updated school details for '{$logName}'" : 'Updated school details';
            log_system_action($mysqli, $authUserId, 'update_school', $logMsg);
            json_response(['ok' => true, 'school_id' => $id, 'message' => 'updated']);

        } elseif ($request_method === 'PUT' && is_numeric($param1)) {
            // Accept PUT /school/{id} as update
            $id = (int)$param1;
            $name = isset($input['school_name']) ? trim($input['school_name']) : null;
            $status = isset($input['status']) ? $input['status'] : null;

            if ($name) {
                $nstmt = $mysqli->prepare("SELECT school_id FROM tbl_school WHERE LOWER(school_name) = LOWER(?) AND school_id != ? LIMIT 1");
                if ($nstmt) {
                    $nstmt->bind_param('si', $name, $id);
                    $nstmt->execute();
                    if ($nstmt->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_name', 'message' => 'A school with the same name already exists'], 409);
                }
            }

            $sets = [];
            $types = '';
            $vals = [];
            if ($name !== null) { $sets[] = 'school_name = ?'; $types .= 's'; $vals[] = $name; }
            if ($status !== null) { $sets[] = 'status = ?'; $types .= 's'; $vals[] = $status; }

            if (empty($sets)) json_response(['ok' => true, 'message' => 'no_changes']);
            $types .= 'i'; $vals[] = $id;
            $sql = 'UPDATE tbl_school SET ' . implode(', ', $sets) . ' WHERE school_id = ?';
            $ustmt = $mysqli->prepare($sql);
            if (!$ustmt) json_response(['error' => 'db_prepare_failed', 'details' => $mysqli->error], 500);
            $ustmt->bind_param($types, ...$vals);
            $ustmt->execute();
            // Log school update with friendly message (no raw ids)
            $logName = $name ?? null;
            if (!$logName) {
                $q = $mysqli->prepare("SELECT school_name FROM tbl_school WHERE school_id = ? LIMIT 1");
                if ($q) { $q->bind_param('i', $id); $q->execute(); $r = $q->get_result()->fetch_assoc(); $logName = $r['school_name'] ?? null; }
            }
            $logMsg = $logName ? "Updated school details for '{$logName}'" : 'Updated school details';
            log_system_action($mysqli, $authUserId, 'update_school', $logMsg);
            json_response(['ok' => true, 'school_id' => $id, 'message' => 'updated']);

        } elseif ($request_method === 'POST' && is_numeric($param1) && $param2 === 'toggle') {
            // POST /school/{id}/toggle - toggle active/inactive
            $id = (int)$param1;
            $cstmt = $mysqli->prepare("SELECT status, school_name FROM tbl_school WHERE school_id = ? LIMIT 1");
            if ($cstmt) {
                $cstmt->bind_param('i', $id);
                $cstmt->execute();
                $cur = $cstmt->get_result()->fetch_assoc();
                $curStatus = $cur['status'] ?? null;
                $toggleSchoolName = $cur['school_name'] ?? null;
            } else {
                $curStatus = null;
                $toggleSchoolName = null;
            }
            $newStatus = ($curStatus && strtolower($curStatus) === 'active') ? 'inactive' : 'active';
            if (isset($input['status']) && in_array(strtolower($input['status']), ['active','inactive','archive'])) {
                $newStatus = $input['status'];
            }
            $ust = $mysqli->prepare("UPDATE tbl_school SET status = ? WHERE school_id = ?");
            if (!$ust) json_response(['error' => 'db_prepare_failed', 'details' => $mysqli->error], 500);
            $ust->bind_param('si', $newStatus, $id);
            $ust->execute();
            // Log school toggle
            log_system_action($mysqli, $authUserId, 'toggle_school', "Changed status of school '{$toggleSchoolName}' to {$newStatus}");
            json_response(['ok' => true, 'school_id' => $id, 'status' => $newStatus]);

        } elseif ($request_method === 'POST' && is_numeric($param1) && $param2 === 'archive') {
            // POST /school/{id}/archive - mark as archived
            $id = (int)$param1;
            // Get school name for logging
            $archSchoolName = null;
            $as = $mysqli->prepare("SELECT school_name FROM tbl_school WHERE school_id = ? LIMIT 1");
            if ($as) { $as->bind_param('i', $id); $as->execute(); $asRow = $as->get_result()->fetch_assoc(); $archSchoolName = $asRow['school_name'] ?? null; $as->close(); }
            $ust = $mysqli->prepare("UPDATE tbl_school SET status = 'archive' WHERE school_id = ?");
            if (!$ust) json_response(['error' => 'db_prepare_failed', 'details' => $mysqli->error], 500);
            $ust->bind_param('i', $id);
            $ust->execute();
            // Log school archive
            log_system_action($mysqli, $authUserId, 'archive_school', "Archived school '{$archSchoolName}'");
            json_response(['ok' => true, 'school_id' => $id, 'status' => 'archive']);
        }
        break;

    default:
        json_response(['error' => 'Endpoint not found in locations API file.'], 404);
        break;
}
