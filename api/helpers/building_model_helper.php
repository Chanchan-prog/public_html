<?php

function building_model_column_exists(mysqli $mysqli, string $column): bool {
    $safe = $mysqli->real_escape_string($column);
    $result = $mysqli->query("SHOW COLUMNS FROM `tbl_buildings` LIKE '{$safe}'");
    return $result && $result->num_rows > 0;
}

function building_model_ensure_schema(mysqli $mysqli): void {
    $columns = [
        'model_path' => "ALTER TABLE `tbl_buildings` ADD COLUMN `model_path` VARCHAR(255) NULL DEFAULT NULL AFTER `radius`",
        'model_filename' => "ALTER TABLE `tbl_buildings` ADD COLUMN `model_filename` VARCHAR(255) NULL DEFAULT NULL AFTER `model_path`",
        'model_size' => "ALTER TABLE `tbl_buildings` ADD COLUMN `model_size` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `model_filename`",
        'model_updated_at' => "ALTER TABLE `tbl_buildings` ADD COLUMN `model_updated_at` DATETIME NULL DEFAULT NULL AFTER `model_size`",
        'model_updated_by' => "ALTER TABLE `tbl_buildings` ADD COLUMN `model_updated_by` INT NULL DEFAULT NULL AFTER `model_updated_at`",
    ];
    foreach ($columns as $column => $sql) {
        if (!building_model_column_exists($mysqli, $column) && !$mysqli->query($sql)) {
            throw new RuntimeException("Unable to add tbl_buildings.{$column}: " . $mysqli->error);
        }
    }

    $bundledModels = [
        'Main West' => 'MW.glb',
        'Main North' => 'MN.glb',
        'Main South' => 'MS.glb',
        'Phinma Hall' => 'PH.glb',
        'Senior High Building' => 'SHS.glb',
        'BED' => 'BED.glb',
    ];
    $stmt = $mysqli->prepare("UPDATE tbl_buildings
        SET model_path = ?, model_filename = ?, model_size = ?
        WHERE LOWER(TRIM(building_name)) = LOWER(?)
          AND (model_path IS NULL OR TRIM(model_path) = '')");
    if (!$stmt) throw new RuntimeException('Unable to prepare bundled building model backfill: ' . $mysqli->error);
    $projectRoot = dirname(__DIR__, 2);
    foreach ($bundledModels as $buildingName => $filename) {
        $path = 'building/models/' . $filename;
        $absolutePath = $projectRoot . DIRECTORY_SEPARATOR . 'public' . DIRECTORY_SEPARATOR . 'building' . DIRECTORY_SEPARATOR . 'models' . DIRECTORY_SEPARATOR . $filename;
        $size = is_file($absolutePath) ? (int)filesize($absolutePath) : 0;
        $stmt->bind_param('ssis', $path, $filename, $size, $buildingName);
        if (!$stmt->execute()) {
            $message = $stmt->error;
            $stmt->close();
            throw new RuntimeException('Unable to backfill bundled building model: ' . $message);
        }
    }
    $stmt->close();
}

function building_model_public_absolute_path(string $relativePath): ?string {
    $clean = str_replace('\\', '/', trim($relativePath));
    if ($clean === '' || str_contains($clean, '..') || str_starts_with($clean, '/')) return null;
    return dirname(__DIR__, 2) . DIRECTORY_SEPARATOR . 'public' . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $clean);
}

