<?php

ini_set('zlib.output_compression', 'Off');
ini_set('output_buffering', 'Off');
ini_set('output_handler', '');

ob_start();

error_reporting(E_ALL & ~E_DEPRECATED & ~E_STRICT & ~E_NOTICE & ~E_WARNING);
ini_set('display_errors', 0);

$security = [];
if (file_exists(__DIR__ . '/config/security.php')) {
    $security = require __DIR__ . '/config/security.php';
}

require_once __DIR__ . '/helpers/http_security_helper.php';
app_apply_http_security(is_array($security) ? $security : []);

if (!empty($security['error_log'])) {
    ini_set('log_errors', '1');
    ini_set('error_log', $security['error_log']);
}

$normalize = $security['normalize_origin'] ?? function ($origin) {
    if (empty($origin)) return '';
    $parts = parse_url(trim($origin));
    if (!$parts || empty($parts['scheme']) || empty($parts['host'])) return '';
    $base = $parts['scheme'] . '://' . $parts['host'];
    if (!empty($parts['port'])) $base .= ':' . $parts['port'];
    return $base;
};

$originHeader = $_SERVER['HTTP_ORIGIN'] ?? '';
$origin = $normalize($originHeader);
$requestHost = app_http_public_request_host();
$requestScheme = app_http_is_https_request() ? 'https' : 'http';
$requestOrigin = $requestHost !== '' ? $normalize($requestScheme . '://' . $requestHost) : '';
$originMatchesRequest = $origin !== '' && $requestOrigin !== '' && hash_equals($requestOrigin, $origin);

// A tunnel frontend may use a separately hosted API during testing. Keep this
// opt-in and exact: APP_CORS_ORIGINS is a comma-separated list of full origins
// (for example https://your-tunnel.devtunnels.ms), never a wildcard.
$configuredCorsOrigins = [];
$corsConfig = trim((string)(getenv('APP_CORS_ORIGINS') ?: ''));
if ($corsConfig !== '') {
    foreach (explode(',', $corsConfig) as $candidate) {
        $candidate = $normalize(trim($candidate));
        if ($candidate !== '') $configuredCorsOrigins[$candidate] = true;
    }
}
$originMatchesConfiguredCors = $origin !== '' && isset($configuredCorsOrigins[$origin]);

// Dev Tunnels forwards the public hostname separately and rewrites the
// browser's same-origin Origin header to its local HTTP target. Accept that
// rewritten value only for a verified localhost -> *.devtunnels.ms request.
$originMatchesTunnelTarget = false;
if ($origin !== '' && app_http_is_trusted_dev_tunnel_request()) {
    $localHost = app_http_request_host();
    $localHttpOrigin = $localHost !== '' ? $normalize('http://' . $localHost) : '';
    $localHttpsOrigin = $localHost !== '' ? $normalize('https://' . $localHost) : '';
    $originMatchesTunnelTarget = ($localHttpOrigin !== '' && hash_equals($localHttpOrigin, $origin))
        || ($localHttpsOrigin !== '' && hash_equals($localHttpsOrigin, $origin));
}

// The frontend and API are deployed on the same origin. Reject browser
// cross-origin requests instead of maintaining a CORS allowlist or falling
// back to a wildcard. Requests without Origin (CLI, cron, direct navigation)
// remain available and are still protected by authentication where required.
if ($origin !== '' && !$originMatchesRequest && !$originMatchesTunnelTarget && !$originMatchesConfiguredCors) {
    http_response_code(403);
    header('Content-Type: application/json; charset=UTF-8');
    echo json_encode(['error' => 'cross_origin_request_denied']);
    exit;
}

// Same-origin requests do not require CORS headers. An explicitly allowlisted
// tunnel origin does, and credentials are intentionally limited to that exact
// value rather than reflected for arbitrary callers.
if ($originMatchesConfiguredCors) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Credentials: true');
    header('Vary: Origin');
}

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    if ($originMatchesConfiguredCors) {
        header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type, X-CSRF-Token, X-User-Activity-At');
        header('Access-Control-Max-Age: 600');
    }
    http_response_code(200);
    exit;
}

// 5. LOAD APP
require_once __DIR__ . '/config/database.php';
// Load application helpers, including database-backed cookie sessions.
require_once __DIR__ . '/helpers/functions.php';

set_exception_handler(function (Throwable $error) {
    error_log('[unhandled API exception] ' . get_class($error) . ': ' . $error->getMessage());
    json_response(['error' => 'internal_server_error'], 500);
});

$request_uri = $_SERVER['REQUEST_URI'];
$path = parse_url($request_uri, PHP_URL_PATH);
$parts = explode('/', $path);

$api_prefix_key = array_search('api', $parts);
$endpoint_root = null;
$param1 = null;
$param2 = null;
if ($api_prefix_key !== false && isset($parts[$api_prefix_key + 1])) {
    $endpoint_root = $parts[$api_prefix_key + 1];
    $param1 = $parts[$api_prefix_key + 2] ?? null;
    $param2 = $parts[$api_prefix_key + 3] ?? null;
}

$request_method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$query = $_GET ?? [];
$authPayload = null;

function resolve_module_requirement($endpointRoot, $requestMethod, $param1, $param2, array $query, array $authPayload = null) {
    $endpoint = strtolower(trim((string)$endpointRoot));
    $subroute = strtolower(trim((string)$param1));
    $scope = strtolower(trim((string)($query['scope'] ?? '')));
    $report = strtolower(trim((string)($query['report'] ?? '')));
    $teacherId = isset($query['teacher_id']) && is_numeric($query['teacher_id']) ? (int)$query['teacher_id'] : 0;
    $authUserId = isset($authPayload['user_id']) ? (int)$authPayload['user_id'] : 0;

    switch ($endpoint) {
        case 'cron':
            // The scheduler endpoint authenticates with its own secret token so
            // hosts without PHP CLI cron (Vercel Cron, external cron services)
            // can still trigger attendance and notification work.
            return null;

        case 'login':
        case 'forgot-password':
        case 'reset-password':
        case 'first-login-password':
        case 'qrcode':
            return $endpoint === 'first-login-password' ? '__authenticated' : null;

        case 'user-profile':
        case 'avatar-thumbnail.php':
        case 'logout':
        case 'session-activity':
        case 'check-contact':
        case 'archive':
        case 'file-upload':
            return '__authenticated';

        case 'dashboard':
            if ($scope === 'self' || $subroute === 'personal') {
                return 'faculty_dashboard';
            }
            return 'dashboard';

        case 'attendance':
            if (in_array($subroute, ['check-in', 'mid-check', 'check-out'], true)) {
                return 'attendance';
            }
            if ($requestMethod === 'POST' && $subroute === '') {
                return 'attendancemgmt';
            }
            if ($requestMethod === 'PUT' && is_numeric($param1)) {
                return 'attendancemgmt';
            }
            if ($requestMethod === 'GET' && $teacherId > 0 && $authUserId > 0 && $teacherId === $authUserId) {
                return 'attendance';
            }
            return ['any_of' => ['attendancemgmt', 'attendance', '3d_building']];

        case 'reports':
            if ($report === 'attendance_logs') {
                return 'attendance_logs';
            }
            if ($report === 'system_logs') {
                return 'logs';
            }
            return 'reports';

        case 'buildings':
        case 'rooms':
        case 'floors':
            if ($requestMethod === 'GET') {
                return ['any_of' => ['locations', 'floor_qr', 'attendance', 'class_schedules', '3d_building', 'settings', 'reports']];
            }
            return 'locations';

        case 'camera-positions.php':
        case 'room-status.php':
        case '3d-room-presence.php':
            return '3d_building';

        case 'school':
            if ($requestMethod === 'GET') {
                return ['any_of' => ['settings', 'attendance', 'class_schedules', '3d_building']];
            }
            return 'settings';

        case 'roles':
            return 'users';

        case 'users':
            if (is_numeric($param1) && strtolower(trim((string)$param2)) === 'module-access') {
                return 'settings';
            }
            if (is_numeric($param1) && strtolower(trim((string)$param2)) === 'reset-default-password') {
                return 'settings';
            }
            if ($requestMethod === 'GET') {
                return ['any_of' => ['users', 'settings', 'reports', 'logs', 'leaves_file', 'leaves_approvals', 'substitutions', 'academic_manage', 'academic_program', 'class_schedules', 'attendancemgmt', 'attendance_logs']];
            }
            return 'users';

        case 'teachers':
        case 'deans':
            return ['any_of' => ['users', 'leaves_file', 'leaves_approvals', 'substitutions', 'academic_manage', 'reports', 'class_schedules', 'settings']];

        case 'class-schedules':
            if ($requestMethod === 'GET') {
                return ['any_of' => ['class_schedules', 'attendance', 'attendancemgmt', 'substitutions', '3d_building']];
            }
            return 'class_schedules';

        case 'calendar-events':
            if ($requestMethod === 'GET' && strtolower(trim((string)$param1)) === 'occurrences') {
                return 'attendance';
            }
            return 'calendar_events';

        case 'departments':
            if ($requestMethod === 'GET') {
                return ['any_of' => ['academic_admin', 'academic_program', 'calendar_events', 'users', 'class_schedules', 'attendancemgmt', 'attendance', 'dashboard', 'faculty_dashboard']];
            }
            return 'academic_admin';

        case 'programs':
            if ($requestMethod === 'GET') {
                return ['any_of' => ['academic_program', 'academic_manage', 'calendar_events', 'users', 'class_schedules', 'attendancemgmt']];
            }
            return 'academic_program';

        case 'sections':
        case 'subjects':
        case 'subject-offerings':
        case 'year-levels':
            if ($requestMethod === 'GET') {
                return ['any_of' => ['academic_manage', 'class_schedules', 'attendancemgmt']];
            }
            return 'academic_manage';

        case 'school-years':
        case 'semesters':
        case 'sessions':
            if ($requestMethod === 'GET') {
                return ['any_of' => ['academic_admin', 'class_schedules', 'attendancemgmt']];
            }
            return 'academic_admin';

        case 'leaves':
            if ($requestMethod === 'GET') {
                return ['any_of' => ['leaves_file', 'leaves_approvals', 'attendance']];
            }
            return ['any_of' => ['leaves_file', 'leaves_approvals']];

        case 'my-schedule':
            return 'attendance';

        case 'substitute':
        case 'substitutions':
            if ($requestMethod === 'GET') {
                return ['any_of' => ['substitutions', 'attendance']];
            }
            return 'substitutions';

        case 'request-edit':
            if ($subroute === 'attendance') {
                $isSelfScope = in_array($scope, ['my', 'mine', 'self'], true);
                if (($requestMethod === 'POST' && !is_numeric($param2)) || $isSelfScope) {
                    return 'attendance';
                }
                return 'attendance_edits';
            }
            return ['any_of' => ['attendance', 'attendance_edits']];

        case 'notification':
        case 'notifications':
        case 'penalties':
        case 'penalty-types':
            return '__authenticated';

        case 'app-settings':
        case 'admin-settings':
            if ($requestMethod === 'GET') {
                return '__authenticated';
            }
            return 'settings';

        default:
            return '__authenticated';
    }
}

if ($endpoint_root !== null) {
    $moduleRequirement = resolve_module_requirement($endpoint_root, $request_method, $param1, $param2, $query, $authPayload ?? []);
    if ($moduleRequirement !== null) {
        $authPayload = app_require_module_access($mysqli, $moduleRequirement, $authPayload);
    }
    if (!empty($authPayload['is_first_login']) && !in_array($endpoint_root, ['first-login-password', 'user-profile', 'logout'], true)) {
        json_response(['error'=>'password_change_required','message'=>'You must replace the temporary password before using the system.'],403);
    }
}

switch ($endpoint_root) {
    case 'dashboard':
        require_once __DIR__ . '/api/dashboard.php';
        break;
    case 'attendance':
        require_once __DIR__ . '/api/attendance.php';
        break;
    case 'qrcode':
        require_once __DIR__ . '/api/qrcode.php';
        break;
    case 'reports':
        require_once __DIR__ . '/api/reports.php';
        break;
    case 'buildings':
    case 'rooms':
    case 'floors':
    case 'school':
        require_once __DIR__ . '/api/locations.php';
        break;
    case 'camera-positions.php':
        require_once __DIR__ . '/api/camera-positions.php';
        break;
    case 'room-status.php':
        require_once __DIR__ . '/api/room-status.php';
        break;
    case '3d-room-presence.php':
        require_once __DIR__ . '/api/3d-room-presence.php';
        break;
    case 'avatar-thumbnail.php':
        require_once __DIR__ . '/api/avatar-thumbnail.php';
        break;
    case 'user-profile':
        require_once __DIR__ . '/api/user_profile.php';
        break;
    case 'session-activity':
        require_once __DIR__ . '/api/session-activity.php';
        break;
    case 'logout':
        require_once __DIR__ . '/api/logout.php';
        break;
    case 'check-contact':
        require_once __DIR__ . '/api/main.php';
        break;
    case 'cron':
        require_once __DIR__ . '/api/cron.php';
        break;
    case 'login':
        require_once __DIR__ . '/api/login.php';
        break;
    case 'forgot-password':
        require_once __DIR__ . '/api/forgot-password.php';
        break;
    case 'reset-password':
        require_once __DIR__ . '/api/reset-password.php';
        break;
    case 'first-login-password':
        require_once __DIR__ . '/api/first-login-password.php';
        break;
    case 'roles':
    case 'users':
    case 'teachers':
    case 'deans':
    case 'class-schedules':
        require_once __DIR__ . '/api/main.php';
        break;
    case 'calendar-events':
        require_once __DIR__ . '/api/calendar-events.php';
        break;
    // Academic related endpoints moved to academic.php
    case 'departments':
    case 'programs':
    case 'sections':
    case 'school-years':
    case 'semesters':
    case 'sessions':
    case 'subjects':
    case 'subject-offerings':
    case 'year-levels':
        require_once __DIR__ . '/api/academic.php';
        break;
    case 'leaves':
        require_once __DIR__ . '/api/leaves.php';
        break;
    case 'my-schedule':
        require_once __DIR__ . '/api/my-schedule.php';
        break;
    case 'penalty-types':
        require_once __DIR__ . '/api/penalties.php';
        break;
    case 'substitute':
    case 'substitutions':
        require_once __DIR__ . '/api/substitute.php';
        break;
    case 'penalties':
        require_once __DIR__ . '/api/penalties.php';
        break;
    case 'request-edit':
        require_once __DIR__ . '/api/request-edit.php';
        break;
    case 'notification':
    case 'notifications':
        require_once __DIR__ . '/api/notification.php';
        break;
    case 'app-settings':
        require_once __DIR__ . '/api/app-settings.php';
        break;
    case 'admin-settings':
        require_once __DIR__ . '/api/admin-settings.php';
        break;
    case 'login-monitor':
        require_once __DIR__ . '/api/login-monitor.php';
        break;
    case 'archive':
        require_once __DIR__ . '/api/archive.php';
        break;
    case 'file-upload':
        require_once __DIR__ . '/api/file-upload.php';
        break;
    default:
        http_response_code(404);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'API endpoint not found']);
        break;
}
