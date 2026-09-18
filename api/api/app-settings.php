<?php
// api/api/app-settings.php
require_once __DIR__ . '/../helpers/log_helper.php';
global $mysqli, $authPayload;

$request_method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$input = get_input();
if (!is_array($input)) $input = [];

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$parts = explode('/', $path);
$api_prefix_key = array_search('api', $parts);
$endpoint = $parts[$api_prefix_key + 1] ?? null;
$param1 = $parts[$api_prefix_key + 2] ?? null;

// Extract dept_id from query string or request input
$requestedGlobal = strtolower((string)($_GET['scope'] ?? ($input['scope'] ?? ''))) === 'global';
$dept_id = isset($_GET['dept_id']) ? (int)$_GET['dept_id'] : (isset($input['dept_id']) ? (int)$input['dept_id'] : null);

// Get the authenticated user's dept_id for validation
$authUserDeptId = isset($authPayload['dept_id']) ? (int)$authPayload['dept_id'] : null;
$authRoleId = isset($authPayload['role_id']) ? (int)$authPayload['role_id'] : null;
$authUserId = isset($authPayload['user_id']) ? (int)$authPayload['user_id'] : null;
$isSuperAdmin = ($authRoleId === 1);

// If no dept_id provided, try to use the authenticated user's department
if ($requestedGlobal && $isSuperAdmin) {
    $dept_id = null;
} elseif ($dept_id === null || $dept_id <= 0) {
    $dept_id = $authUserDeptId;
}

if (!$isSuperAdmin && ($authUserDeptId === null || $authUserDeptId <= 0)) json_response(['error'=>'forbidden','message'=>'Your account is not assigned to a department.'],403);

// For non-super-admin, validate they can only access their own department
if (!$isSuperAdmin && $dept_id !== null && $authUserDeptId !== null && $dept_id !== $authUserDeptId) {
    json_response(['error' => 'forbidden', 'message' => 'You can only manage settings for your own department.'], 403);
}

$ensure_settings_table = function() use ($mysqli) {
    $sql = "CREATE TABLE IF NOT EXISTS `tbl_app_settings` (
        `setting_id` INT(11) NOT NULL AUTO_INCREMENT,
        `setting_group` VARCHAR(100) NOT NULL,
        `dept_id` INT(11) NULL DEFAULT NULL,
        `setting_key` VARCHAR(100) NOT NULL,
        `setting_value` TEXT NULL,
        `value_type` VARCHAR(50) NOT NULL DEFAULT 'text',
        `updated_by` INT(11) NULL,
        `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (`setting_id`),
        UNIQUE KEY `unique_setting` (`setting_group`, `setting_key`, `dept_id`),
        KEY `updated_by` (`updated_by`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4";
    if (!$mysqli->query($sql)) {
        json_response(['error' => 'settings_table_failed', 'message' => $mysqli->error], 500);
    }
};

$normalize_color = function($value, $fallback = '#c69500') {
    $color = trim((string)$value);
    if (preg_match('/^#[0-9a-fA-F]{6}$/', $color)) return strtolower($color);
    return $fallback;
};

$get_home_settings = function() use ($mysqli, $ensure_settings_table, $normalize_color, $dept_id) {
    $ensure_settings_table();

    $defaults = [
        'home_title' => 'Welcome to COC Attendance WEB',
        'home_title_color' => '#c69500',
    ];

    // Try department-specific settings first
    $settings = $defaults;
    $foundAny = false;

    if ($dept_id !== null && $dept_id > 0) {
        $stmt = $mysqli->prepare("SELECT setting_key, setting_value FROM tbl_app_settings WHERE setting_group = 'home' AND dept_id = ? AND setting_key IN ('home_title', 'home_title_color')");
        if ($stmt) {
            $stmt->bind_param('i', $dept_id);
            $stmt->execute();
            $res = $stmt->get_result();
            while ($row = $res->fetch_assoc()) {
                $key = (string)($row['setting_key'] ?? '');
                if (!array_key_exists($key, $settings)) continue;
                $settings[$key] = (string)($row['setting_value'] ?? '');
                $foundAny = true;
            }
            $stmt->close();
        }
    }

    // If no department-specific settings found, fall back to global (dept_id IS NULL)
    if (!$foundAny) {
        $stmt = $mysqli->prepare("SELECT setting_key, setting_value FROM tbl_app_settings WHERE setting_group = 'home' AND dept_id IS NULL AND setting_key IN ('home_title', 'home_title_color')");
        if ($stmt) {
            $stmt->execute();
            $res = $stmt->get_result();
            while ($row = $res->fetch_assoc()) {
                $key = (string)($row['setting_key'] ?? '');
                if (!array_key_exists($key, $settings)) continue;
                $settings[$key] = (string)($row['setting_value'] ?? '');
            }
            $stmt->close();
        }
    }

    $settings['home_title'] = trim((string)$settings['home_title']) !== '' ? trim((string)$settings['home_title']) : $defaults['home_title'];
    $settings['home_title_color'] = $normalize_color($settings['home_title_color'], $defaults['home_title_color']);
    $settings['dept_id'] = $dept_id;

    return $settings;
};

$save_setting = function($group, $key, $value, $type, $updatedBy, $deptId) use ($mysqli) {
    if ($deptId !== null && $deptId > 0) {
        $stmt = $mysqli->prepare("INSERT INTO tbl_app_settings (setting_group, dept_id, setting_key, setting_value, value_type, updated_by)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), value_type = VALUES(value_type), updated_by = VALUES(updated_by)");
        if (!$stmt) {
            json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        }
        $stmt->bind_param('sisssi', $group, $deptId, $key, $value, $type, $updatedBy);
    } else {
        $existing = $mysqli->prepare("SELECT setting_id FROM tbl_app_settings WHERE setting_group=? AND setting_key=? AND dept_id IS NULL ORDER BY setting_id DESC LIMIT 1");
        $existing->bind_param('ss',$group,$key); $existing->execute(); $row=$existing->get_result()->fetch_assoc(); $existing->close();
        if ($row) {
            $stmt=$mysqli->prepare("UPDATE tbl_app_settings SET setting_value=?,value_type=?,updated_by=? WHERE setting_id=?");
            $settingId=(int)$row['setting_id']; $stmt->bind_param('ssii',$value,$type,$updatedBy,$settingId);
            if (!$stmt->execute()) json_response(['error'=>'save_failed','message'=>$stmt->error],500); $stmt->close(); return;
        }
        $stmt = $mysqli->prepare("INSERT INTO tbl_app_settings (setting_group, dept_id, setting_key, setting_value, value_type, updated_by) VALUES (?, NULL, ?, ?, ?, ?)");
        if (!$stmt) {
            json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        }
        $stmt->bind_param('ssssi', $group, $key, $value, $type, $updatedBy);
    }
    if (!$stmt->execute()) {
        json_response(['error' => 'save_failed', 'message' => $stmt->error], 500);
    }
    $stmt->close();
};

if ($endpoint !== 'app-settings') {
    json_response(['error' => 'not_found'], 404);
}

if ($param1 !== 'home') {
    json_response(['error' => 'not_found', 'message' => 'Settings group not found'], 404);
}

if ($request_method === 'GET') {
    json_response($get_home_settings());
}

if ($request_method === 'PUT' || $request_method === 'POST') {
    if (!in_array((int)$authRoleId, [1, 6], true)) {
        json_response(['error' => 'forbidden', 'message' => 'Only Admin and Department Admin can update Home Content settings.'], 403);
    }
    $ensure_settings_table();

    $title = trim(strip_tags((string)($input['home_title'] ?? '')));
    $color = $normalize_color($input['home_title_color'] ?? '#c69500');

    if ($title === '') {
        json_response(['error' => 'validation', 'message' => 'Home title is required.'], 400);
    }
    if (strlen($title) > 80) {
        json_response(['error' => 'validation', 'message' => 'Home title must be 80 characters or fewer.'], 400);
    }

    $save_dept_id = $dept_id;
    $updatedBy = $authUserId;
    $save_setting('home', 'home_title', $title, 'text', $updatedBy, $save_dept_id);
    $save_setting('home', 'home_title_color', $color, 'color', $updatedBy, $save_dept_id);

    // Log the settings update
    $deptSuffix = $save_dept_id ? ' for the department' : ' globally';
    log_system_action($mysqli, $authUserId, 'update_app_settings', "Updated home page settings (title and color){$deptSuffix}");

    json_response($get_home_settings());
}

json_response(['error' => 'method_not_allowed'], 405);
