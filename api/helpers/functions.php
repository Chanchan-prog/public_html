<?php
// api/helpers/functions.php

require_once __DIR__ . '/validation_helper.php';
require_once __DIR__ . '/http_security_helper.php';

// Keep internal diagnostics out of server-error responses. Successful results
// and validation errors retain their existing response contracts.
function app_public_response($data, $status_code) {
    if ((int)$status_code < 500 || !is_array($data)) return $data;

    foreach (['error', 'message', 'details', 'sql_error'] as $key) {
        if (isset($data[$key])) {
            error_log('[api server error] ' . $key . ': ' . json_encode($data[$key], JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR));
        }
    }
    $code = $data['error'] ?? 'internal_server_error';
    // Preserve stable machine-readable codes, never free-form SQL errors.
    if (!is_string($code) || !preg_match('/^[a-z][a-z0-9_]{0,79}$/D', $code)) {
        $code = 'internal_server_error';
    }
    $safe = ['error' => $code, 'message' => 'Unable to complete the request. Please try again later.'];
    if (array_key_exists('ok', $data)) $safe['ok'] = false;
    if (isset($data['retry_after']) && is_numeric($data['retry_after'])) {
        $safe['retry_after'] = (int)$data['retry_after'];
    }
    return $safe;
}

function json_response($data, $status_code = 200) {
    $data = app_public_response($data, $status_code);
    // Clean any buffered output to ensure clean JSON
    if (ob_get_length() !== false) {
        @ob_end_clean();
    }
    http_response_code($status_code);
    header('Content-Type: application/json');
    $json = json_encode($data);

    // Authenticated GET responses are always revalidated, never treated as
    // public data. Unchanged polling responses can therefore return 304 with
    // no JSON body while changes made on another device remain visible.
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET' && (int)$status_code === 200) {
        $existingCacheControl = '';
        foreach (headers_list() as $responseHeader) {
            if (stripos($responseHeader, 'Cache-Control:') === 0) {
                $existingCacheControl = strtolower($responseHeader);
                break;
            }
        }
        if ($existingCacheControl === '' || strpos($existingCacheControl, 'no-store') === false) {
            $etag = '"' . hash('sha256', (string)$json) . '"';
            header('Cache-Control: private, no-cache, must-revalidate');
            header('ETag: ' . $etag);
            $requestEtag = trim((string)($_SERVER['HTTP_IF_NONE_MATCH'] ?? ''));
            if ($requestEtag !== '' && hash_equals($etag, $requestEtag)) {
                http_response_code(304);
                header_remove('Content-Type');
                header_remove('Content-Length');
                exit;
            }
        }
    }

    // Ensure accurate content length (helps HTTP/2 framing).
    header('Content-Length: ' . strlen($json));
    echo $json;
    exit;
}


function app_session_cookie_name() { return 'cdo_session'; }
function app_csrf_cookie_name() { return 'cdo_csrf'; }

function app_is_https_request() {
    return app_http_is_https_request();
}

function app_set_cookie_value($name, $value, $expires, $httpOnly) {
    $options = [
        'expires' => (int)$expires,
        'path' => '/',
        'secure' => app_is_https_request(),
        'httponly' => (bool)$httpOnly,
        'samesite' => 'Lax',
    ];
    setcookie($name, $value, $options);
}

function app_set_session_cookies($sessionToken, $csrfToken, $expiresAt) {
    app_set_cookie_value(app_session_cookie_name(), $sessionToken, $expiresAt, true);
    app_set_cookie_value(app_csrf_cookie_name(), $csrfToken, $expiresAt, false);
}

function app_clear_session_cookies() {
    app_set_cookie_value(app_session_cookie_name(), '', time() - 3600, true);
    app_set_cookie_value(app_csrf_cookie_name(), '', time() - 3600, false);
}

function app_create_database_session($mysqli, $userId, $tokenVersion, array $policy = null) {
    require_once __DIR__ . '/security_policy_helper.php';
    security_schema_ensure($mysqli);
    $resolvedPolicy = is_array($policy) ? security_policy_normalize($policy) : security_policy_get($mysqli);
    $sessionToken = bin2hex(random_bytes(32));
    $csrfToken = bin2hex(random_bytes(32));
    $sessionHash = hash('sha256', $sessionToken);
    $csrfHash = hash('sha256', $csrfToken);
    $expiresTimestamp = time() + ((int)$resolvedPolicy['absolute_session_minutes'] * 60);
    $absoluteExpiresAt = date('Y-m-d H:i:s', $expiresTimestamp);
    $stmt = $mysqli->prepare('INSERT INTO tbl_user_sessions (session_id,user_id,token_version,csrf_token_hash,absolute_expires_at) VALUES (?,?,?,?,?)');
    if (!$stmt) throw new RuntimeException('Unable to create the login session.');
    $uid = (int)$userId;
    $version = (int)$tokenVersion;
    $stmt->bind_param('siiss', $sessionHash, $uid, $version, $csrfHash, $absoluteExpiresAt);
    $ok = $stmt->execute();
    $stmt->close();
    if (!$ok) throw new RuntimeException('Unable to save the login session.');
    app_set_session_cookies($sessionToken, $csrfToken, $expiresTimestamp);
    return [
        'session_id' => $sessionHash,
        'absolute_expires_at' => $absoluteExpiresAt,
        'absolute_expires_at_unix' => $expiresTimestamp,
        'idle_timeout_seconds' => (int)$resolvedPolicy['idle_timeout_minutes'] * 60,
    ];
}

function app_request_requires_csrf() {
    return !in_array(strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')), ['GET', 'HEAD', 'OPTIONS'], true);
}

function app_validate_csrf_token(array $session) {
    if (!app_request_requires_csrf()) return true;
    $headerToken = trim((string)($_SERVER['HTTP_X_CSRF_TOKEN'] ?? ''));
    $cookieToken = trim((string)($_COOKIE[app_csrf_cookie_name()] ?? ''));
    $expectedHash = strtolower(trim((string)($session['csrf_token_hash'] ?? '')));
    if ($headerToken === '' || $cookieToken === '' || $expectedHash === '') return false;
    if (!hash_equals($cookieToken, $headerToken)) return false;
    return hash_equals($expectedHash, hash('sha256', $headerToken));
}

function app_get_authenticated_session($required = false) {
    global $mysqli;
    $rawSessionToken = trim((string)($_COOKIE[app_session_cookie_name()] ?? ''));
    if (!preg_match('/^[a-f0-9]{64}$/i', $rawSessionToken)) {
        if ($required) json_response(['ok'=>false,'error'=>'missing_session','message'=>'Please sign in.'],401);
        return null;
    }
    if (!isset($mysqli) || !($mysqli instanceof mysqli)) {
        if ($required) json_response(['ok'=>false,'error'=>'session_validation_failed'],500);
        return null;
    }

    require_once __DIR__ . '/security_policy_helper.php';
    security_schema_ensure($mysqli);
    $policy = security_policy_get($mysqli);
    $sessionHash = hash('sha256', $rawSessionToken);
    $assignedProgramColumn = $mysqli->query("SHOW COLUMNS FROM tbl_users LIKE 'assigned_program_head_id'");
    $hasAssignedProgram = $assignedProgramColumn && $assignedProgramColumn->num_rows > 0;
    $hasPermissionColumns = app_has_user_module_permission_columns($mysqli);
    $assignedProgramSelect = $hasAssignedProgram ? ', u.assigned_program_head_id' : ', NULL AS assigned_program_head_id';
    $permissionSelect = $hasPermissionColumns ? ', u.permission_mode, u.module_permissions' : ", 'default' AS permission_mode, NULL AS module_permissions";
    $stmt = $mysqli->prepare("SELECT s.session_id, s.user_id, s.token_version AS session_token_version,
            s.csrf_token_hash, s.last_activity_at, s.absolute_expires_at, s.revoked_at,
            u.role_id, u.dept_id, u.email, u.status, u.token_version, u.is_first_login, u.password_changed_at,
            r.role_name{$assignedProgramSelect}{$permissionSelect}
        FROM tbl_user_sessions s
        JOIN tbl_users u ON u.user_id = s.user_id
        LEFT JOIN tbl_roles r ON r.role_id = u.role_id
        WHERE s.session_id = ? LIMIT 1");
    if (!$stmt) {
        if ($required) json_response(['ok'=>false,'error'=>'session_validation_failed'],500);
        return null;
    }
    $stmt->bind_param('s', $sessionHash);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    $expired = !$row
        || !empty($row['revoked_at'])
        || strtotime((string)$row['absolute_expires_at']) <= time()
        || strtotime((string)$row['last_activity_at']) + ((int)$policy['idle_timeout_minutes'] * 60) <= time()
        || (int)$row['session_token_version'] !== (int)$row['token_version'];
    if ($expired) {
        app_clear_session_cookies();
        if ($required) json_response(['ok'=>false,'error'=>'session_expired','message'=>'Your session expired. Please sign in again.'],401);
        return null;
    }
    if (strtolower(trim((string)($row['status'] ?? ''))) !== 'active') {
        app_clear_session_cookies();
        if ($required) json_response(['ok'=>false,'error'=>'account_inactive','message'=>'Your account is inactive or archived. Contact an administrator.'],401);
        return null;
    }
    if (!app_validate_csrf_token($row)) {
        if ($required) json_response(['ok'=>false,'error'=>'invalid_csrf_token','message'=>'The security token is missing or invalid. Refresh the page and try again.'],403);
        return null;
    }

    $passwordChangeReason = !empty($row['is_first_login']) ? 'required' : null;
    if (empty($row['is_first_login']) && security_password_is_expired($row['password_changed_at'] ?? null, $policy)) {
        $forceChange = $mysqli->prepare('UPDATE tbl_users SET is_first_login = 1 WHERE user_id = ?');
        if (!$forceChange) {
            if ($required) json_response(['ok'=>false,'error'=>'password_expiration_check_failed'],500);
            return null;
        }
        $expiredUserId = (int)$row['user_id'];
        $forceChange->bind_param('i', $expiredUserId);
        $updated = $forceChange->execute();
        $forceChange->close();
        if (!$updated) {
            if ($required) json_response(['ok'=>false,'error'=>'password_expiration_check_failed'],500);
            return null;
        }
        $row['is_first_login'] = 1;
        $passwordChangeReason = 'expired';
    }

    $activityMs = isset($_SERVER['HTTP_X_USER_ACTIVITY_AT']) ? (int)$_SERVER['HTTP_X_USER_ACTIVITY_AT'] : 0;
    $activitySeconds = (int)floor($activityMs / 1000);
    if ($activitySeconds > 0 && $activitySeconds <= time() + 30) {
        $touch = $mysqli->prepare('UPDATE tbl_user_sessions SET last_activity_at=GREATEST(last_activity_at,FROM_UNIXTIME(?)) WHERE session_id=?');
        if ($touch) { $touch->bind_param('is', $activitySeconds, $sessionHash); $touch->execute(); $touch->close(); }
    }

    return [
        'user_id' => (int)$row['user_id'],
        'role_id' => (int)$row['role_id'],
        'dept_id' => $row['dept_id'] !== null ? (int)$row['dept_id'] : null,
        'assigned_program_head_id' => $row['assigned_program_head_id'] !== null ? (int)$row['assigned_program_head_id'] : null,
        'email' => (string)($row['email'] ?? ''),
        'role_name' => (string)($row['role_name'] ?? ''),
        'status' => (string)($row['status'] ?? ''),
        'token_version' => (int)$row['token_version'],
        'sid' => $sessionHash,
        'is_first_login' => (int)($row['is_first_login'] ?? 0),
        'password_change_reason' => $passwordChangeReason,
        'password_changed_at' => (string)($row['password_changed_at'] ?? ''),
        'password_expires_at' => security_password_expires_at($row['password_changed_at'] ?? null, $policy),
        'permission_mode' => (string)($row['permission_mode'] ?? 'default'),
        'module_permissions' => app_decode_module_permissions_value($row['module_permissions'] ?? null),
        'idle_timeout_seconds' => (int)$policy['idle_timeout_minutes'] * 60,
        'absolute_expires_at' => (string)$row['absolute_expires_at'],
        'absolute_expires_at_unix' => strtotime((string)$row['absolute_expires_at']),
    ];
}

function app_get_user_department_id($mysqli, $userId) {
    $uid = (int)$userId;
    if ($uid <= 0) {
        return null;
    }

    $stmt = $mysqli->prepare("SELECT dept_id FROM tbl_users WHERE user_id = ? LIMIT 1");
    if (!$stmt) {
        return null;
    }
    $stmt->bind_param('i', $uid);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$row || !array_key_exists('dept_id', $row) || $row['dept_id'] === null) {
        return null;
    }
    return (int)$row['dept_id'];
}

function app_permission_matrix() {
    static $matrix = null;
    if ($matrix !== null) {
        return $matrix;
    }

    $matrix = [
        'dashboard' => ['admin', 'dean', 'department_admin', 'program_head', 'secretary'],
        'faculty_dashboard' => ['dean', 'program_head', 'secretary', 'teacher'],
        'users' => ['admin', 'dean', 'department_admin', 'program_head', 'secretary'],
        'attendance' => ['dean', 'program_head', 'secretary', 'teacher'],
        'attendancemgmt' => ['admin', 'secretary', 'dean', 'department_admin', 'program_head'],
        'class_schedules' => ['admin', 'dean', 'department_admin', 'program_head', 'secretary'],
        '3d_building' => ['admin', 'dean', 'department_admin', 'program_head', 'secretary'],
        'attendance_edits' => ['dean'],
        'academic_admin' => ['admin'],
        'academic_manage' => ['admin', 'department_admin'],
        'academic_program' => ['admin', 'department_admin'],
        'locations' => ['admin'],
        'floor_qr' => ['admin', 'dean', 'department_admin', 'program_head', 'secretary'],
        'reports' => ['admin', 'dean', 'department_admin', 'program_head', 'secretary', 'teacher'],
        'leaves_file' => ['dean', 'department_admin'],
        'leaves_approvals' => ['dean', 'department_admin'],
        'substitutions' => ['dean', 'department_admin'],
        'penalties' => ['dean', 'department_admin', 'program_head', 'secretary'],
        'logs' => ['admin', 'dean', 'department_admin'],
        'settings' => ['admin', 'dean', 'department_admin'],
        'attendance_logs' => ['admin', 'dean', 'department_admin'],
        'calendar_events' => ['admin', 'department_admin'],
    ];

    return $matrix;
}

function app_role_id_to_name_map() {
    static $map = [
        1 => 'admin',
        2 => 'dean',
        3 => 'program_head',
        4 => 'secretary',
        5 => 'teacher',
        6 => 'department_admin',
    ];
    return $map;
}

function app_role_name_from_id($roleId) {
    $map = app_role_id_to_name_map();
    $rid = (int)$roleId;
    return $map[$rid] ?? null;
}

function app_format_role_name($roleName) {
    // Convert role names to proper nouns with correct capitalization
    // e.g., 'admin' => 'Admin', 'program_head' => 'Program Head'
    $name = strtolower(trim((string)$roleName));

    // Replace underscores with spaces
    $name = str_replace('_', ' ', $name);

    // Capitalize each word
    $name = ucwords($name);

    return $name;
}

function app_normalize_module_token($value) {
    $token = strtolower(trim((string)$value));
    if ($token === '') {
        return '';
    }
    $token = preg_replace('/[^a-z0-9]+/', '_', $token);
    $token = trim((string)$token, '_');
    if ($token === '') {
        return '';
    }

    $matrix = app_permission_matrix();
    return array_key_exists($token, $matrix) ? $token : '';
}

function app_get_default_modules_for_role($roleName) {
    $role = strtolower(trim((string)$roleName));
    if ($role === '') {
        return [];
    }

    $out = [];
    foreach (app_permission_matrix() as $moduleKey => $roles) {
        if (in_array($role, $roles, true)) {
            $out[] = $moduleKey;
        }
    }
    sort($out, SORT_STRING);
    return $out;
}

function app_has_user_module_permission_columns($mysqli) {
    static $cached = null;
    if ($cached !== null) {
        return $cached;
    }

    $permissionModeColCheck = $mysqli->query("SHOW COLUMNS FROM tbl_users LIKE 'permission_mode'");
    $modulePermissionsColCheck = $mysqli->query("SHOW COLUMNS FROM tbl_users LIKE 'module_permissions'");
    $cached = ($permissionModeColCheck && $permissionModeColCheck->num_rows > 0)
        && ($modulePermissionsColCheck && $modulePermissionsColCheck->num_rows > 0);
    return $cached;
}

function app_decode_module_permissions_value($raw) {
    if ($raw === null || $raw === '') {
        return ['allow' => [], 'deny' => []];
    }

    $parsed = is_array($raw) ? $raw : json_decode((string)$raw, true);
    if (!is_array($parsed)) {
        return ['allow' => [], 'deny' => []];
    }

    $normalize = function ($list) {
        if (!is_array($list)) {
            return [];
        }

        $out = [];
        foreach ($list as $entry) {
            $token = app_normalize_module_token($entry);
            if ($token !== '') {
                $out[$token] = true;
            }
        }

        $keys = array_keys($out);
        sort($keys, SORT_STRING);
        return $keys;
    };

    return [
        'allow' => $normalize($parsed['allow'] ?? []),
        'deny' => $normalize($parsed['deny'] ?? []),
    ];
}

function app_compute_effective_modules($roleName, $rawPermissions = null) {
    $effective = [];
    foreach (app_get_default_modules_for_role($roleName) as $moduleKey) {
        $effective[$moduleKey] = true;
    }

    $bag = app_decode_module_permissions_value($rawPermissions);
    foreach ($bag['allow'] as $moduleKey) {
        // The module-access API validates which explicit grants are safe.
        // Honor a stored valid grant even when it is outside role defaults.
        if (app_normalize_module_token($moduleKey) !== '') {
            $effective[$moduleKey] = true;
        }
    }
    foreach ($bag['deny'] as $moduleKey) {
        unset($effective[$moduleKey]);
    }
    if (strtolower(trim((string)$roleName)) === 'department_admin') {
        unset($effective['faculty_dashboard'], $effective['attendance']);
    }
    $normalizedRoleName = strtolower(trim((string)$roleName));
    if (!in_array($normalizedRoleName, ['admin', 'department_admin'], true)) {
        unset($effective['academic_manage'], $effective['academic_program']);
    }
    if ($normalizedRoleName !== 'admin') unset($effective['academic_admin']);
    if ($normalizedRoleName !== 'dean') unset($effective['attendance_edits']);
    if (!in_array($normalizedRoleName, ['dean', 'department_admin'], true)) unset($effective['leaves_file']);
    $fixedRoleModules = [
        'attendance_logs' => ['admin', 'dean', 'department_admin'],
        'leaves_approvals' => ['dean', 'department_admin'],
        'leaves_file' => ['dean', 'department_admin'],
        'substitutions' => ['dean', 'department_admin'],
        'penalties' => ['dean', 'department_admin', 'program_head', 'secretary'],
        'calendar_events' => ['admin', 'department_admin'],
    ];
    foreach ($fixedRoleModules as $moduleKey => $allowedRoles) {
        if (!in_array($normalizedRoleName, $allowedRoles, true)) unset($effective[$moduleKey]);
    }

    $keys = array_keys($effective);
    sort($keys, SORT_STRING);
    return $keys;
}

function app_get_user_effective_modules($mysqli, $userId, $roleId = null) {
    static $cache = [];

    $uid = (int)$userId;
    if ($uid <= 0) {
        return [];
    }
    if (array_key_exists($uid, $cache)) {
        return $cache[$uid];
    }

    $hasModuleColumns = app_has_user_module_permission_columns($mysqli);
    $selectPermissionCols = $hasModuleColumns
        ? ", permission_mode, module_permissions"
        : ", NULL AS permission_mode, NULL AS module_permissions";

    $stmt = $mysqli->prepare("SELECT role_id{$selectPermissionCols} FROM tbl_users WHERE user_id = ? LIMIT 1");
    if (!$stmt) {
        $resolvedRoleName = app_role_name_from_id($roleId);
        $cache[$uid] = app_get_default_modules_for_role($resolvedRoleName);
        return $cache[$uid];
    }

    $stmt->bind_param('i', $uid);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    $resolvedRoleId = $row && isset($row['role_id']) ? (int)$row['role_id'] : (int)$roleId;
    $resolvedRoleName = app_role_name_from_id($resolvedRoleId);
    if (!$resolvedRoleName) {
        $cache[$uid] = [];
        return $cache[$uid];
    }

    $permissionMode = isset($row['permission_mode']) ? strtolower(trim((string)$row['permission_mode'])) : 'default';
    $rawPermissions = ($permissionMode === 'custom') ? ($row['module_permissions'] ?? null) : null;
    $cache[$uid] = app_compute_effective_modules($resolvedRoleName, $rawPermissions);
    return $cache[$uid];
}

function app_user_has_module_access($mysqli, $userId, $roleId, $moduleKey) {
    $token = app_normalize_module_token($moduleKey);
    if ($token === '') {
        return false;
    }

    $effective = app_get_user_effective_modules($mysqli, $userId, $roleId);
    return in_array($token, $effective, true);
}

/**
 * Normalize the three supported account states in one place.  Historical
 * rows may contain legacy boolean values, so keep accepting those while all
 * new writes use active, inactive, or archive.
 */
function app_normalize_user_status($value) {
    $status = strtolower(trim((string)$value));
    if (in_array($status, ['active', '1', 'true'], true)) return 'active';
    if (in_array($status, ['archive', 'archived'], true)) return 'archive';
    return 'inactive';
}

function app_user_status_is_active($value) {
    return app_normalize_user_status($value) === 'active';
}

/**
 * Guard every operational assignment at the API boundary.  Read-only
 * history deliberately does not use this helper so inactive users remain
 * visible in reports, logs, and existing records.
 */
function app_require_active_user($mysqli, $userId, array $allowedRoleIds = [], $message = '') {
    $uid = (int)$userId;
    if ($uid <= 0) {
        json_response([
            'error' => 'invalid_user',
            'message' => $message !== '' ? $message : 'Select a valid active user.'
        ], 400);
    }

    $stmt = $mysqli->prepare('SELECT user_id, role_id, dept_id, status, first_name, last_name FROM tbl_users WHERE user_id = ? LIMIT 1');
    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $stmt->bind_param('i', $uid);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    $roleAllowed = empty($allowedRoleIds) || ($row && in_array((int)($row['role_id'] ?? 0), array_map('intval', $allowedRoleIds), true));
    if (!$row || !app_user_status_is_active($row['status'] ?? null) || !$roleAllowed) {
        json_response([
            'error' => 'inactive_user',
            'message' => $message !== '' ? $message : 'The selected user is inactive or archived. Choose an active user.'
        ], 409);
    }

    return $row;
}

/**
 * Return references which make an account ineligible for archiving.  These
 * are intentionally broader than the add/edit guards: archive is reserved
 * for accounts that have never acquired related system data.  Inactive is
 * the correct state for accounts whose history must be retained.
 */
function app_user_archive_dependencies($mysqli, $userId) {
    $uid = (int)$userId;
    if ($uid <= 0) return [];

    $relations = [
        'tbl_attendance_records' => ['label' => 'attendance records', 'columns' => ['user_id']],
        'tbl_class_schedules' => ['label' => 'class schedules', 'columns' => ['user_id']],
        'tbl_subject_offerings' => ['label' => 'subject offerings', 'columns' => ['user_id']],
        'tbl_leaves' => ['label' => 'leave records', 'columns' => ['teacher_id', 'requested_by', 'approved_by']],
        'tbl_substitutions' => ['label' => 'substitutions', 'columns' => ['substitute_user_id']],
        'tbl_penalties' => ['label' => 'penalties', 'columns' => ['user_id', 'issued_by']],
        'tbl_attendance_edit_requests' => ['label' => 'attendance edit requests', 'columns' => ['requested_by', 'decided_by']],
        'tbl_attendance_logs' => ['label' => 'attendance adjustment logs', 'columns' => ['edited_by']],
        'tbl_notifications' => ['label' => 'notifications', 'columns' => ['user_id']],
        'tbl_system_logs' => ['label' => 'system logs', 'columns' => ['user_id']],
        'tbl_departments' => ['label' => 'department leadership assignments', 'columns' => ['dean_id']],
        'tbl_programs' => ['label' => 'program leadership assignments', 'columns' => ['head_id']],
        'tbl_3d_camera_presets' => ['label' => '3D camera presets', 'columns' => ['updated_by']],
        'tbl_app_settings' => ['label' => 'settings history', 'columns' => ['updated_by']],
        'tbl_login_attempts' => ['label' => 'login history', 'columns' => ['user_id']],
        'tbl_push_subscriptions' => ['label' => 'push subscriptions', 'columns' => ['user_id']],
        'tbl_user_sessions' => ['label' => 'login sessions', 'columns' => ['user_id']],
    ];

    $dependencies = [];
    foreach ($relations as $table => $definition) {
        $existingColumns = [];
        foreach ($definition['columns'] as $column) {
            $check = $mysqli->prepare('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1');
            if (!$check) continue;
            $check->bind_param('ss', $table, $column);
            $check->execute();
            if ($check->get_result()->fetch_assoc()) $existingColumns[] = $column;
            $check->close();
        }
        if (!$existingColumns) continue;

        $where = implode(' OR ', array_map(function ($column) {
            return '`' . str_replace('`', '``', $column) . '` = ?';
        }, $existingColumns));
        $sql = 'SELECT COUNT(*) AS total FROM `' . str_replace('`', '``', $table) . '` WHERE ' . $where;
        $stmt = $mysqli->prepare($sql);
        if (!$stmt) continue;
        $types = str_repeat('i', count($existingColumns));
        $params = array_fill(0, count($existingColumns), $uid);
        $stmt->bind_param($types, ...$params);
        $stmt->execute();
        $total = (int)($stmt->get_result()->fetch_assoc()['total'] ?? 0);
        $stmt->close();
        if ($total > 0) {
            $dependencies[] = ['key' => $table, 'label' => $definition['label'], 'count' => $total];
        }
    }

    return $dependencies;
}

/**
 * Immediately invalidate every active login for an account after a
 * security-sensitive change (role, scope, permissions, password, or status).
 */
function app_revoke_user_sessions($mysqli, $userId) {
    $uid = (int)$userId;
    if ($uid <= 0 || !($mysqli instanceof mysqli)) return false;

    $versionStmt = $mysqli->prepare('UPDATE tbl_users SET token_version = COALESCE(token_version, 0) + 1 WHERE user_id = ?');
    if (!$versionStmt) return false;
    $versionStmt->bind_param('i', $uid);
    $versionOk = $versionStmt->execute();
    $versionStmt->close();
    if (!$versionOk) return false;

    $sessionStmt = $mysqli->prepare('UPDATE tbl_user_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL');
    if ($sessionStmt) {
        $sessionStmt->bind_param('i', $uid);
        $sessionStmt->execute();
        $sessionStmt->close();
    }
    return true;
}

function app_require_module_access($mysqli, $requirement, $auth = null) {
    if ($requirement === null) {
        return is_array($auth) ? $auth : app_get_authenticated_session(false);
    }

    $resolvedAuth = is_array($auth) ? $auth : app_get_authenticated_session(true);
    $userId = isset($resolvedAuth['user_id']) ? (int)$resolvedAuth['user_id'] : 0;
    $roleId = isset($resolvedAuth['role_id']) ? (int)$resolvedAuth['role_id'] : 0;

    if ($userId <= 0) {
        json_response(['ok' => false, 'error' => 'missing_authorization'], 401);
    }

    if ($requirement === '__authenticated') {
        return $resolvedAuth;
    }

    $mode = 'any';
    $modules = [];
    if (is_string($requirement)) {
        $modules = [$requirement];
    } elseif (is_array($requirement)) {
        if (isset($requirement['all_of']) && is_array($requirement['all_of'])) {
            $mode = 'all';
            $modules = $requirement['all_of'];
        } elseif (isset($requirement['any_of']) && is_array($requirement['any_of'])) {
            $modules = $requirement['any_of'];
        } else {
            $modules = $requirement;
        }
    }

    $normalizedModules = [];
    foreach ($modules as $moduleKey) {
        $token = app_normalize_module_token($moduleKey);
        if ($token !== '') {
            $normalizedModules[] = $token;
        }
    }
    $normalizedModules = array_values(array_unique($normalizedModules));

    if (empty($normalizedModules)) {
        return $resolvedAuth;
    }

    $hasAccess = ($mode === 'all');
    foreach ($normalizedModules as $moduleKey) {
        $allowed = app_user_has_module_access($mysqli, $userId, $roleId, $moduleKey);
        if ($mode === 'all' && !$allowed) {
            $hasAccess = false;
            break;
        }
        if ($mode !== 'all' && $allowed) {
            $hasAccess = true;
            break;
        }
        if ($mode !== 'all') {
            $hasAccess = false;
        }
    }

    if (!$hasAccess) {
        json_response([
            'ok' => false,
            'error' => 'forbidden',
            'message' => 'You do not have module access for this action.',
            'required_modules' => $normalizedModules,
        ], 403);
    }

    return $resolvedAuth;
}

function getDistanceMeters($lat1, $lon1, $lat2, $lon2) {
  $R = 6371000; // Earth radius in meters
  $dLat = deg2rad($lat2 - $lat1);
  $dLon = deg2rad($lon2 - $lon1);
  $a =
    sin($dLat / 2) * sin($dLat / 2) +
    cos(deg2rad($lat1)) *
      cos(deg2rad($lat2)) *
      sin($dLon / 2) *
      sin($dLon / 2);

  $c = 2 * atan2(sqrt($a), sqrt(1 - $a));
  return $R * $c;
}

function isInsideBox($coordsLat, $coordsLon, $roomLat, $roomLon, $roomRadiusMeters) {
  if (!is_numeric($coordsLat) || !is_numeric($coordsLon) || $roomLat == null || $roomLon == null || $roomRadiusMeters == null) return false;
  $metersPerDegLat = 111320; // ~ meters per degree latitude
  $deltaLat = $roomRadiusMeters / $metersPerDegLat;
  $latRad = deg2rad($roomLat);
  $metersPerDegLon = $metersPerDegLat * cos($latRad) ?: 1e-6;
  $deltaLon = $roomRadiusMeters / $metersPerDegLon;

  $minLat = $roomLat - $deltaLat;
  $maxLat = $roomLat + $deltaLat;
  $minLon = $roomLon - $deltaLon;
  $maxLon = $roomLon + $deltaLon;

  return $coordsLat >= $minLat && $coordsLat <= $maxLat && $coordsLon >= $minLon && $coordsLon <= $maxLon;
}

function toDateYMD($d) {
    if (!$d) return null;
    try {
        $dt = new DateTime($d);
        return $dt->format('Y-m-d');
    } catch (Exception $e) {
        return null;
    }
}

function generate_random_token($length = 32) {
    return bin2hex(random_bytes($length / 2));
}

function get_input() {
    $decoded = json_decode(file_get_contents('php://input'), true);
    return is_array($decoded) ? sanitizeRelevantTextInputs($decoded) : $decoded;
}
