<?php
// api/api/main.php
require_once __DIR__ . '/../helpers/socket_helper.php';
require_once __DIR__ . '/../helpers/log_helper.php'; // enable system logging
require_once __DIR__ . '/../helpers/mail_helper.php';
require_once __DIR__ . '/../helpers/notification_helper.php';
require_once __DIR__ . '/../helpers/security_policy_helper.php';
require_once __DIR__ . '/../helpers/schedule_edit_helper.php';
require_once __DIR__ . '/../helpers/validation_helper.php';
require_once __DIR__ . '/../helpers/user_import_helper.php';
require_once __DIR__ . '/../helpers/class_schedule_import_helper.php';
require_once __DIR__ . '/../scripts/cron_worker_lib.php';

// No need to include db/helpers again, index.php does it.
global $mysqli, $authPayload;

// The router validates the token and replaces role/department/program claims
// with the current authoritative values from tbl_users.
$auth = is_array($authPayload) ? $authPayload : app_get_authenticated_session(true);
$authUserId = (int)($auth['user_id'] ?? 0);
$authRoleId = (int)($auth['role_id'] ?? 0);
$authUserDeptId = isset($auth['dept_id']) && $auth['dept_id'] !== null ? (int)$auth['dept_id'] : null;
$request_method = $_SERVER['REQUEST_METHOD'];
$input = get_input();

// The router in index.php has already identified the endpoint root.
// We can use the full path to distinguish between similar endpoints if needed.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$parts = explode('/', $path);
$api_prefix_key = array_search('api', $parts);
$endpoint = $parts[$api_prefix_key + 1] ?? null;
$param1 = $parts[$api_prefix_key + 2] ?? null;
$param2 = $parts[$api_prefix_key + 3] ?? null;

$permissionModeColCheck = $mysqli->query("SHOW COLUMNS FROM tbl_users LIKE 'permission_mode'");
$modulePermissionsColCheck = $mysqli->query("SHOW COLUMNS FROM tbl_users LIKE 'module_permissions'");
$hasPermissionModeCol = $permissionModeColCheck && $permissionModeColCheck->num_rows > 0;
$hasModulePermissionsCol = $modulePermissionsColCheck && $modulePermissionsColCheck->num_rows > 0;
$hasUserModulePermissions = $hasPermissionModeCol && $hasModulePermissionsCol;

$roleIdToName = [
    1 => 'admin',
    2 => 'dean',
    3 => 'program_head',
    4 => 'secretary',
    5 => 'teacher',
    6 => 'department_admin',
];

$permissionMatrix = [
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
$allModuleKeys = array_values(array_keys($permissionMatrix));
$allModuleLookup = array_fill_keys($allModuleKeys, true);

// Department Admin may grant only operational, department-safe modules.
// Global administration, security, facilities, academic master data, user
// management, and approval workflows stay outside this boundary.
$departmentAdminGrantableModules = [
    'dashboard',
    'faculty_dashboard',
    'attendance',
    'attendancemgmt',
    '3d_building',
    'reports',
];

$normalize_module_key = function($value) {
    $token = strtolower(trim((string)$value));
    if ($token === '') return '';
    $token = preg_replace('/[^a-z0-9]+/', '_', $token);
    $token = trim((string)$token, '_');
    return $token;
};

$get_role_name_by_id = function($roleId) use ($roleIdToName) {
    $rid = (int)$roleId;
    return $roleIdToName[$rid] ?? null;
};

$get_default_modules_for_role = function($roleName) use ($permissionMatrix) {
    $role = strtolower(trim((string)$roleName));
    if ($role === '') return [];
    $modules = [];
    foreach ($permissionMatrix as $moduleKey => $allowedRoles) {
        if (in_array($role, $allowedRoles, true)) {
            $modules[] = $moduleKey;
        }
    }
    sort($modules, SORT_STRING);
    return $modules;
};

$normalize_module_list = function($list) use ($normalize_module_key, $allModuleLookup) {
    if (!is_array($list)) return [];
    $out = [];
    foreach ($list as $raw) {
        $token = $normalize_module_key($raw);
        if ($token === '' || !isset($allModuleLookup[$token])) continue;
        $out[$token] = true;
    }
    $keys = array_keys($out);
    sort($keys, SORT_STRING);
    return $keys;
};

$decode_module_permissions = function($raw) use ($normalize_module_list) {
    if ($raw === null || $raw === '') {
        return ['allow' => [], 'deny' => []];
    }
    $parsed = is_array($raw) ? $raw : json_decode((string)$raw, true);
    if (!is_array($parsed)) {
        return ['allow' => [], 'deny' => []];
    }

    $allow = $normalize_module_list($parsed['allow'] ?? []);
    $deny = $normalize_module_list($parsed['deny'] ?? []);
    return ['allow' => $allow, 'deny' => $deny];
};

$compute_effective_modules = function($roleName, $rawPermissions) use ($get_default_modules_for_role, $decode_module_permissions, $allModuleLookup) {
    $base = $get_default_modules_for_role($roleName);
    $permissionBag = $decode_module_permissions($rawPermissions);
    $effective = [];
    foreach ($base as $moduleKey) $effective[$moduleKey] = true;
    foreach ($permissionBag['allow'] as $moduleKey) {
        if (isset($allModuleLookup[$moduleKey])) $effective[$moduleKey] = true;
    }
    foreach ($permissionBag['deny'] as $moduleKey) unset($effective[$moduleKey]);
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
};

switch ($endpoint) {
    case 'check-contact':
        if ($request_method === 'GET') {
            $contactNo = isset($_GET['contact_no']) ? trim((string)$_GET['contact_no']) : '';
            $excludeUserId = isset($_GET['exclude_user_id']) ? (int)$_GET['exclude_user_id'] : 0;
            if ($contactNo === '') {
                json_response(['available' => true, 'checked' => false], 200);
            }
            $stmt = $mysqli->prepare("SELECT user_id FROM tbl_users WHERE contact_no = ? AND user_id <> ? LIMIT 1");
            if ($stmt) {
                $stmt->bind_param('si', $contactNo, $excludeUserId);
                $stmt->execute();
                $found = $stmt->get_result()->fetch_assoc();
                $stmt->close();
                json_response(['available' => !$found, 'checked' => true], 200);
            } else {
                json_response(['available' => true, 'checked' => false], 200);
            }
        }
        break;

    case 'users':
        if (!$authUserId) {
            json_response(['error' => 'unauthorized', 'message' => 'Authentication required'], 401);
        }
        $isAdminRole = ((int)$authRoleId === 1);
        $isDepartmentAdminRole = ((int)$authRoleId === 6);
        $isDeanLikeRole = in_array((int)$authRoleId, [2, 6], true);

        $normalize_user_email = function($value) {
            return strtolower(trim((string)$value));
        };
        $is_valid_user_email = function($value) {
            return validateEmailFormat($value);
        };
        $normalize_id_number = function($value) {
            return strtoupper(trim((string)$value));
        };
        $is_valid_id_number = function($value) {
            return (bool)preg_match('/^\d{2}-\d{3}-[A-Za-z]$/', trim((string)$value));
        };
        $normalize_person_name = function($value) {
            return trim(preg_replace('/\s+/u', ' ', (string)$value));
        };
        $is_valid_person_name = function($value) {
            return (bool)preg_match("/^[\\p{L}\\p{M}][\\p{L}\\p{M} .'-]*$/u", trim((string)$value));
        };
        $getActiveScheduleContext = function($userId) use ($mysqli) {
            $stmt = $mysqli->prepare("SELECT sem.term, sy.session_name
                FROM tbl_class_schedules cs
                JOIN tbl_semesters sem ON sem.semester_id = cs.semester_id
                JOIN tbl_school_year sy ON sy.school_year_id = sem.school_year_id
                WHERE cs.user_id = ?
                  AND LOWER(TRIM(COALESCE(sem.status, ''))) IN ('active', '1', 'true')
                  AND LOWER(TRIM(COALESCE(sy.status, ''))) IN ('active', '1', 'true')
                ORDER BY sem.semester_id DESC
                LIMIT 1");
            if (!$stmt) return null;
            $targetUserId = (int)$userId;
            $stmt->bind_param('i', $targetUserId);
            $stmt->execute();
            $row = $stmt->get_result()->fetch_assoc();
            $stmt->close();
            if (!$row) return null;
            $label = trim((string)($row['term'] ?? '') . ' ' . (string)($row['session_name'] ?? ''));
            return ['label' => $label !== '' ? $label : 'the current active semester'];
        };
        $assignedHeadColCheck = $mysqli->query("SHOW COLUMNS FROM tbl_users LIKE 'assigned_program_head_id'");
        $hasAssignedProgramHeadCol = $assignedHeadColCheck && $assignedHeadColCheck->num_rows > 0;

        $validateAssignedProgramHead = function($programId, $deptId, $requireOwner = false) use ($mysqli) {
            $pq = $mysqli->prepare("SELECT p.program_id, p.dept_id, p.head_id, p.status AS program_status, d.status AS department_status, u.role_id, u.status AS head_status FROM tbl_programs p LEFT JOIN tbl_departments d ON p.dept_id = d.dept_id LEFT JOIN tbl_users u ON p.head_id = u.user_id WHERE p.program_id = ? LIMIT 1");
            if (!$pq) return 'Failed to validate assigned program.';
            $pq->bind_param("i", $programId);
            $pq->execute();
            $programRow = $pq->get_result()->fetch_assoc();
            if (!$programRow) return 'Assigned program does not exist.';
            if (strtolower(trim((string)($programRow['program_status'] ?? ''))) !== 'active') return 'Assigned program is inactive or archived.';
            if (strtolower(trim((string)($programRow['department_status'] ?? ''))) !== 'active') return 'Assigned program belongs to an inactive or archived department.';
            if ($requireOwner) {
                if (empty($programRow['head_id'])) return 'Assigned program has no Program Head.';
                if ((int)($programRow['role_id'] ?? 0) !== 3) return 'Assigned program head user is invalid.';
                if (strtolower(trim((string)($programRow['head_status'] ?? ''))) !== 'active') return 'Assigned program head user is inactive or archived.';
            }
            $programDeptId = isset($programRow['dept_id']) && $programRow['dept_id'] !== null ? (int)$programRow['dept_id'] : null;
            if ($deptId !== null && $programDeptId !== null && (int)$programDeptId !== (int)$deptId) {
                return 'Assigned program must belong to the same department.';
            }
            return null;
        };

        $validateDeanDepartmentOwner = function($deptId, $userId = null) use ($mysqli) {
            if ($deptId === null || $deptId === '') return null;
            if ((int)$deptId <= 0) return 'Selected department does not exist.';
            $dq = $mysqli->prepare("SELECT dept_id, status FROM tbl_departments WHERE dept_id = ? LIMIT 1");
            if (!$dq) return 'Failed to validate department.';
            $deptId = (int)$deptId;
            $dq->bind_param('i', $deptId);
            $dq->execute();
            $dept = $dq->get_result()->fetch_assoc();
            if (!$dept) return 'Selected department does not exist.';
            if (strtolower(trim((string)($dept['status'] ?? ''))) !== 'active') return 'Selected department is inactive or archived.';
            return null;
        };

        $validateProgramHeadProgramOwner = function($programId, $deptId, $userId = null) use ($mysqli) {
            if ($programId === null || $programId === '') return null;
            if ((int)$programId <= 0) return 'Selected program does not exist.';
            $pq = $mysqli->prepare("SELECT p.program_id, p.dept_id, p.head_id, p.status AS program_status, d.status AS department_status FROM tbl_programs p LEFT JOIN tbl_departments d ON p.dept_id = d.dept_id WHERE p.program_id = ? LIMIT 1");
            if (!$pq) return 'Failed to validate program ownership.';
            $programId = (int)$programId;
            $pq->bind_param('i', $programId);
            $pq->execute();
            $program = $pq->get_result()->fetch_assoc();
            if (!$program) return 'Selected program does not exist.';
            if (strtolower(trim((string)($program['program_status'] ?? ''))) !== 'active') return 'Selected program is inactive or archived.';
            if (strtolower(trim((string)($program['department_status'] ?? ''))) !== 'active') return 'Selected program belongs to an inactive or archived department.';

            $programDeptId = isset($program['dept_id']) && $program['dept_id'] !== null ? (int)$program['dept_id'] : null;
            if ($deptId !== null && $programDeptId !== null && (int)$programDeptId !== (int)$deptId) {
                return 'Selected program must belong to the selected department.';
            }

            return null;
        };

        $syncUserOwnership = function($userId, $roleId, $deptId, $programId = null) use ($mysqli, $hasAssignedProgramHeadCol) {
            $userId = (int)$userId;
            $roleId = (int)$roleId;
            $deptId = ($deptId === null || $deptId === '') ? null : (int)$deptId;
            $programId = ($programId === null || $programId === '') ? null : (int)$programId;

            $deptTargetSql = ($roleId === 2 && $deptId !== null) ? " OR d.dept_id = {$deptId}" : '';
            $mysqli->query("UPDATE tbl_departments d
                SET d.dean_id = (
                    SELECT MIN(du.user_id)
                    FROM tbl_users du
                    WHERE du.role_id = 2
                      AND du.dept_id = d.dept_id
                      AND LOWER(TRIM(COALESCE(du.status, 'active'))) IN ('active', '1', 'true')
                )
                WHERE d.dean_id = {$userId}{$deptTargetSql}");

            if ($hasAssignedProgramHeadCol) {
                $programTargetSql = ($roleId === 3 && $programId !== null) ? " OR p.program_id = {$programId}" : '';
                $mysqli->query("UPDATE tbl_programs p
                    SET p.head_id = (
                        SELECT MIN(ph.user_id)
                        FROM tbl_users ph
                        WHERE ph.role_id = 3
                          AND ph.assigned_program_head_id = p.program_id
                          AND LOWER(TRIM(COALESCE(ph.status, 'active'))) IN ('active', '1', 'true')
                    )
                    WHERE p.head_id = {$userId}{$programTargetSql}");
            }
        };

        $sendAccountCreatedEmail = function($firstName, $lastName, $email, $idNumber) use ($mysqli, $authUserId) {
            $recipient = strtolower(trim((string)$email));
            if ($recipient === '') {
                return ['sent' => false, 'error' => 'Missing recipient email'];
            }

            $schoolId = trim((string)$idNumber);
            $username = $schoolId !== '' ? ($schoolId . ' or ' . $recipient) : $recipient;

            try {
                if (!function_exists('send_new_account_email')) {
                    return ['sent' => false, 'error' => 'Email helper is unavailable'];
                }
                $sent = send_new_account_email(
                    $recipient,
                    (string)$firstName,
                    (string)$lastName,
                    $username
                );
            } catch (Throwable $e) {
                error_log('[users] Failed to send account-created email to ' . $recipient . ': ' . $e->getMessage());
                return ['sent' => false, 'error' => 'Mail exception: ' . $e->getMessage()];
            }

            if (!$sent) {
                $msg = "Failed to send account-created email to {$recipient}";
                log_system_action($mysqli, $authUserId, 'send_account_email_failed', $msg);
                return ['sent' => false, 'error' => 'Mail delivery failed'];
            }

            return ['sent' => true, 'error' => null];
        };

        $programHeadDeptId = null;
        if ((int)$authRoleId === 3) {
            $phScopeStmt = $mysqli->prepare("SELECT dept_id FROM tbl_users WHERE user_id = ? AND role_id = 3 LIMIT 1");
            if ($phScopeStmt) {
                $phScopeStmt->bind_param("i", $authUserId);
                $phScopeStmt->execute();
                $phScopeRow = $phScopeStmt->get_result()->fetch_assoc();
                if ($phScopeRow && isset($phScopeRow['dept_id']) && $phScopeRow['dept_id'] !== null) {
                    $programHeadDeptId = (int)$phScopeRow['dept_id'];
                }
            }
        }

        $isModuleAccessEndpoint = (is_numeric($param1) && strtolower((string)$param2) === 'module-access');
        if ($isModuleAccessEndpoint) {
            if (!$isAdminRole && !$isDepartmentAdminRole) {
                json_response(['error' => 'forbidden', 'message' => 'Only Admin and Department Admin can manage module access overrides.'], 403);
            }

            $targetUserId = (int)$param1;
            $permSelect = $hasUserModulePermissions
                ? ", permission_mode, module_permissions"
                : ", NULL AS permission_mode, NULL AS module_permissions";
            $targetStmt = $mysqli->prepare("SELECT user_id, role_id, dept_id, first_name, last_name, status{$permSelect} FROM tbl_users WHERE user_id = ? LIMIT 1");
            if (!$targetStmt) {
                json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            }
            $targetStmt->bind_param("i", $targetUserId);
            $targetStmt->execute();
            $targetUser = $targetStmt->get_result()->fetch_assoc();
            if (!$targetUser) {
                json_response(['error' => 'not_found', 'message' => 'User not found.'], 404);
            }
            if (!app_user_status_is_active($targetUser['status'] ?? null)) {
                json_response(['error' => 'inactive_user', 'message' => 'Module access can only be changed for an active user. Activate the account first.'], 409);
            }

            $targetRoleId = isset($targetUser['role_id']) ? (int)$targetUser['role_id'] : 0;
            $targetDeptId = isset($targetUser['dept_id']) && $targetUser['dept_id'] !== null ? (int)$targetUser['dept_id'] : null;
            $targetRoleName = $get_role_name_by_id($targetRoleId);
            if (!$targetRoleName) {
                json_response(['error' => 'validation', 'message' => 'Target user role is invalid.'], 400);
            }

            if ($isDepartmentAdminRole) {
                if ($authUserDeptId === null) {
                    json_response(['error' => 'forbidden', 'message' => 'Department Admin is not assigned to a department.'], 403);
                }
                if ($targetRoleId === 1) {
                    json_response(['error' => 'forbidden', 'message' => 'Department Admin cannot change an Admin account.'], 403);
                }
                if ($targetDeptId === null || (int)$targetDeptId !== (int)$authUserDeptId) {
                    json_response(['error' => 'forbidden', 'message' => 'Department Admin can only manage users inside their own department.'], 403);
                }
            }

            $roleDefaultModules = $get_default_modules_for_role($targetRoleName);
            $effectiveModules = $compute_effective_modules($targetRoleName, $targetUser['module_permissions'] ?? null);
            $managedModules = $isAdminRole ? $allModuleKeys : $departmentAdminGrantableModules;
            if ($targetRoleId === 6) {
                $managedModules = array_values(array_diff($managedModules, ['faculty_dashboard', 'attendance']));
            }
            if (!in_array($targetRoleId, [1, 6], true)) {
                $managedModules = array_values(array_diff($managedModules, ['academic_manage', 'academic_program']));
            }
            if ($targetRoleId !== 1) {
                $managedModules = array_values(array_diff($managedModules, ['academic_admin']));
            }
            sort($managedModules, SORT_STRING);
            $managedLookup = array_fill_keys($managedModules, true);

            $storedMode = 'default';
            if ($hasUserModulePermissions && !empty($targetUser['permission_mode'])) {
                $candidate = strtolower(trim((string)$targetUser['permission_mode']));
                $storedMode = ($candidate === 'custom') ? 'custom' : 'default';
            }
            $storedPermissions = $hasUserModulePermissions
                ? $decode_module_permissions($targetUser['module_permissions'] ?? null)
                : ['allow' => [], 'deny' => []];

            if ($request_method === 'GET') {
                json_response([
                    'user_id' => $targetUserId,
                    'first_name' => $targetUser['first_name'] ?? '',
                    'last_name' => $targetUser['last_name'] ?? '',
                    'role_id' => $targetRoleId,
                    'role_name' => $targetRoleName,
                    'dept_id' => $targetDeptId,
                    'permission_mode' => $storedMode,
                    'module_permissions' => $storedPermissions,
                    'role_default_modules' => $roleDefaultModules,
                    'manageable_modules' => $managedModules,
                    'effective_modules' => $effectiveModules,
                    'schema_ready' => $hasUserModulePermissions,
                ]);
            }

            if ($request_method !== 'PUT' && $request_method !== 'POST') {
                json_response(['error' => 'method_not_allowed'], 405);
            }

            if (!$hasUserModulePermissions) {
                json_response([
                    'error' => 'schema_mismatch',
                    'message' => 'Database is missing permission_mode/module_permissions columns. Run the latest migration first.',
                ], 500);
            }

            $selectedModules = null;
            if (array_key_exists('selected_modules', $input)) {
                $selectedModules = $normalize_module_list($input['selected_modules']);
            }

            $nextMode = isset($input['permission_mode']) ? strtolower(trim((string)$input['permission_mode'])) : null;
            $nextPermissions = null;

            if ($selectedModules !== null) {
                foreach ($selectedModules as $moduleKey) {
                    if (!isset($managedLookup[$moduleKey])) {
                        json_response(['error' => 'forbidden_module', 'message' => "Module '{$moduleKey}' is outside your management scope."], 403);
                    }
                }

                $baseLookup = array_fill_keys($roleDefaultModules, true);
                $selectedLookup = array_fill_keys($selectedModules, true);
                $allow = [];
                $deny = [];

                // Preserve stored permissions outside the current operator's
                // manageable subset. A Department Admin save must never clear
                // or change protected modules.
                foreach ($storedPermissions['allow'] as $moduleKey) {
                    if (!isset($managedLookup[$moduleKey])) $allow[] = $moduleKey;
                }
                foreach ($storedPermissions['deny'] as $moduleKey) {
                    if (!isset($managedLookup[$moduleKey])) $deny[] = $moduleKey;
                }

                foreach ($selectedModules as $moduleKey) {
                    if (!isset($baseLookup[$moduleKey])) {
                        $allow[] = $moduleKey;
                    }
                }
                foreach ($roleDefaultModules as $moduleKey) {
                    if (isset($managedLookup[$moduleKey]) && !isset($selectedLookup[$moduleKey])) {
                        $deny[] = $moduleKey;
                    }
                }

                $allow = array_values(array_unique($allow));
                $deny = array_values(array_unique($deny));
                sort($allow, SORT_STRING);
                sort($deny, SORT_STRING);
                $nextPermissions = ['allow' => $allow, 'deny' => $deny];
                $nextMode = (empty($allow) && empty($deny)) ? 'default' : 'custom';
            } else {
                if ($nextMode !== 'custom') {
                    $nextMode = 'default';
                }
                $incomingBag = $decode_module_permissions($input['module_permissions'] ?? null);
                foreach (['allow', 'deny'] as $bucket) {
                    foreach ($incomingBag[$bucket] as $moduleKey) {
                        if (!isset($managedLookup[$moduleKey])) {
                            json_response(['error' => 'forbidden_module', 'message' => "Module '{$moduleKey}' is outside your management scope."], 403);
                        }
                    }
                }
                $denyLookup = array_fill_keys($incomingBag['deny'], true);
                $allow = [];
                $deny = [];
                foreach ($storedPermissions['allow'] as $moduleKey) {
                    if (!isset($managedLookup[$moduleKey])) $allow[] = $moduleKey;
                }
                foreach ($storedPermissions['deny'] as $moduleKey) {
                    if (!isset($managedLookup[$moduleKey])) $deny[] = $moduleKey;
                }
                foreach ($incomingBag['allow'] as $moduleKey) {
                    if (!isset($denyLookup[$moduleKey])) $allow[] = $moduleKey;
                }
                foreach ($incomingBag['deny'] as $moduleKey) $deny[] = $moduleKey;
                $allow = array_values(array_unique($allow));
                $deny = array_values(array_unique($deny));
                sort($allow, SORT_STRING);
                sort($deny, SORT_STRING);
                $nextPermissions = ['allow' => $allow, 'deny' => $deny];
                if ($nextMode === 'custom' && empty($allow) && empty($deny)) {
                    $nextMode = 'default';
                }
            }

            $modulePermissionsJson = null;
            if ($nextMode === 'custom') {
                $modulePermissionsJson = json_encode($nextPermissions, JSON_UNESCAPED_SLASHES);
                if ($modulePermissionsJson === false) {
                    json_response(['error' => 'encode_failed', 'message' => 'Failed to encode module permissions.'], 500);
                }
            }

            $permissionsChanged = strtolower(trim((string)($targetUser['permission_mode'] ?? 'default'))) !== $nextMode
                || (string)($targetUser['module_permissions'] ?? '') !== (string)($modulePermissionsJson ?? '');
            $saveStmt = $mysqli->prepare("UPDATE tbl_users SET permission_mode = ?, module_permissions = ? WHERE user_id = ?");
            if (!$saveStmt) {
                json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            }
            $saveStmt->bind_param("ssi", $nextMode, $modulePermissionsJson, $targetUserId);
            if (!$saveStmt->execute()) {
                json_response(['error' => 'update_failed', 'message' => $saveStmt->error], 500);
            }
            $saveStmt->close();
            if ($permissionsChanged) app_revoke_user_sessions($mysqli, $targetUserId);

            $updatedPermissions = ($nextMode === 'custom')
                ? $nextPermissions
                : ['allow' => [], 'deny' => []];
            $updatedEffective = $compute_effective_modules(
                $targetRoleName,
                $nextMode === 'custom' ? $modulePermissionsJson : null
            );

            $targetFullName = trim(((string)($targetUser['first_name'] ?? '')) . ' ' . ((string)($targetUser['last_name'] ?? '')));
            if ($targetFullName === '') $targetFullName = "User ID {$targetUserId}";
            $operatorScope = $isAdminRole ? 'global Admin scope' : 'Department Admin scope for department ' . (int)$authUserDeptId;
            $logMsg = "Updated module access for {$targetFullName} using {$operatorScope}";
            log_system_action($mysqli, $authUserId, 'update_user_module_access', $logMsg);

            json_response([
                'user_id' => $targetUserId,
                'permission_mode' => $nextMode,
                'module_permissions' => $updatedPermissions,
                'role_default_modules' => $roleDefaultModules,
                'manageable_modules' => $managedModules,
                'effective_modules' => $updatedEffective,
            ]);
        }

        if ($request_method === 'GET') {
            // Lightweight list mode for dropdowns
            if (isset($_GET['list'])) {
                $roleFilter = isset($_GET['role']) && is_numeric($_GET['role']) ? (int)$_GET['role'] : null;
                $deptFilter = isset($_GET['dept_id']) && is_numeric($_GET['dept_id']) ? (int)$_GET['dept_id'] : null;
                $programFilter = isset($_GET['program_id']) && is_numeric($_GET['program_id']) ? (int)$_GET['program_id'] : null;
                $teachingRolesOnly = isset($_GET['teaching_roles']) && (string)$_GET['teaching_roles'] === '1';
                // Operational selectors are active-only by default. Read-only
                // history/report filters may opt in to inactive accounts, but
                // archived accounts never leave User Management's archive view.
                $includeInactive = isset($_GET['include_inactive'])
                    && in_array(strtolower(trim((string)$_GET['include_inactive'])), ['1', 'true', 'yes'], true);
                $isProgramHeadRole = ((int)$authRoleId === 3);
                $isDeanRole = in_array((int)$authRoleId, [2, 6], true);
                $isSecretaryRole = ((int)$authRoleId === 4);

                $listAssignedProgramSelect = $hasAssignedProgramHeadCol
                    ? ", assigned_program_head_id, assigned_program_head_id AS assigned_program_id,
                        (SELECT p.program_name FROM tbl_programs p WHERE p.program_id = tbl_users.assigned_program_head_id LIMIT 1) AS assigned_program_name,
                        (SELECT p.sub_name FROM tbl_programs p WHERE p.program_id = tbl_users.assigned_program_head_id LIMIT 1) AS assigned_program_sub_name"
                    : ", NULL AS assigned_program_head_id, NULL AS assigned_program_id, NULL AS assigned_program_name, NULL AS assigned_program_sub_name";
                $sql = "SELECT user_id, first_name, last_name, id_number, dept_id, role_id, status
                        {$listAssignedProgramSelect},
                        (SELECT d.dept_name FROM tbl_departments d WHERE d.dept_id = tbl_users.dept_id LIMIT 1) AS dept_name,
                        (SELECT d.sub_name FROM tbl_departments d WHERE d.dept_id = tbl_users.dept_id LIMIT 1) AS department_sub_name
                        FROM tbl_users WHERE " . ($includeInactive
                            ? "LOWER(TRIM(COALESCE(status, ''))) NOT IN ('archive', 'archived')"
                            : "LOWER(TRIM(COALESCE(status, ''))) IN ('active', '1', 'true')");
                $params = [];
                $types = '';

                if ($isAdminRole) {
                    // Admin: can see all active users, including admins and self.
                    if ($roleFilter !== null) {
                        $sql .= " AND role_id = ?";
                        $params[] = $roleFilter;
                        $types .= 'i';
                    }
                    if ($deptFilter !== null) {
                        $sql .= " AND dept_id = ?";
                        $params[] = $deptFilter;
                        $types .= 'i';
                    }
                } elseif ($isDeanRole) {
                    // Dean: self + same-department users except admins.
                    if ($authUserDeptId === null) {
                        $sql .= " AND user_id = ?";
                        $params[] = (int)$authUserId;
                        $types .= 'i';
                    } else {
                        $sql .= " AND (user_id = ? OR (dept_id = ? AND role_id <> 1))";
                        $params[] = (int)$authUserId;
                        $params[] = (int)$authUserDeptId;
                        $types .= 'ii';
                    }

                    if ($roleFilter !== null) {
                        if ($roleFilter === 1) {
                            json_response([]);
                        }
                        $sql .= " AND role_id = ?";
                        $params[] = $roleFilter;
                        $types .= 'i';
                    }
                } elseif ($isSecretaryRole) {
                    // Secretary: teaching summaries may include every teaching role
                    // in the department; other dropdowns retain the narrower scope.
                    if ($authUserDeptId === null) {
                        $sql .= " AND user_id = ?";
                        $params[] = (int)$authUserId;
                        $types .= 'i';
                    } elseif ($teachingRolesOnly) {
                        $sql .= " AND dept_id = ? AND role_id IN (2, 3, 4, 5)";
                        $params[] = (int)$authUserDeptId;
                        $types .= 'i';
                    } else {
                        $sql .= " AND (user_id = ? OR (dept_id = ? AND role_id = 5))";
                        $params[] = (int)$authUserId;
                        $params[] = (int)$authUserDeptId;
                        $types .= 'ii';
                    }

                    if ($roleFilter !== null) {
                        $allowedSecretaryRoles = $teachingRolesOnly ? [2, 3, 4, 5] : [4, 5];
                        if (!in_array($roleFilter, $allowedSecretaryRoles, true)) {
                            json_response([]);
                        }
                        $sql .= " AND role_id = ?";
                        $params[] = $roleFilter;
                        $types .= 'i';
                    }
                } elseif ($isProgramHeadRole) {
                    // Program Head: scoped users with schedules/assignments in programs
                    // headed by this user. Teaching summaries also allow Dean records.
                    $allowedProgramRoles = $teachingRolesOnly ? [2, 3, 4, 5] : [3, 4, 5];
                    $programScopedRoleIds = $teachingRolesOnly ? '2, 4, 5' : '4, 5';
                    if ($roleFilter !== null && !in_array($roleFilter, $allowedProgramRoles, true)) {
                        json_response([]);
                    }

                    $programScopeIdSql = "(SELECT assigned_program_head_id FROM tbl_users WHERE user_id = " . (int)$authUserId . " AND role_id = 3 LIMIT 1)";

                    $sql .= " AND (
                        user_id = ?
                        OR (
                            role_id IN ({$programScopedRoleIds})
                            AND (
                                " . ($hasAssignedProgramHeadCol ? "assigned_program_head_id = {$programScopeIdSql}" : "0=1") . "
                                OR user_id IN (
                                    SELECT DISTINCT cs.user_id
                                    FROM tbl_class_schedules cs
                                    LEFT JOIN tbl_subject s ON cs.subject_id = s.subject_id
                                    LEFT JOIN tbl_sections sec ON cs.section_id = sec.section_id
                                    LEFT JOIN tbl_programs ps ON s.program_id = ps.program_id
                                    LEFT JOIN tbl_programs psec ON sec.program_id = psec.program_id
                                    WHERE cs.user_id IS NOT NULL
                                      AND (s.program_id = {$programScopeIdSql} OR sec.program_id = {$programScopeIdSql})
                                )
                            )
                        )
                    )";

                    $params[] = (int)$authUserId;
                    $types .= 'i';
                    if ($programFilter !== null) {
                        $ownedProgramStmt = $mysqli->prepare('SELECT assigned_program_head_id AS program_id FROM tbl_users WHERE user_id = ? AND role_id = 3 AND assigned_program_head_id = ? LIMIT 1');
                        if (!$ownedProgramStmt) json_response(['error' => 'db_prepare_failed', 'message' => $mysqli->error], 500);
                        $ownedProgramStmt->bind_param('ii', $authUserId, $programFilter);
                        $ownedProgramStmt->execute();
                        $ownedProgram = $ownedProgramStmt->get_result()->fetch_assoc();
                        $ownedProgramStmt->close();
                        if (!$ownedProgram) json_response(['error' => 'forbidden_program', 'message' => 'The selected program is outside your assigned scope.'], 403);

                        $sql .= " AND (
                            user_id = ?
                            OR " . ($hasAssignedProgramHeadCol ? 'assigned_program_head_id = ?' : '0=1') . "
                            OR user_id IN (
                                SELECT DISTINCT scoped_cs.user_id
                                FROM tbl_class_schedules scoped_cs
                                LEFT JOIN tbl_subject scoped_subject ON scoped_cs.subject_id = scoped_subject.subject_id
                                LEFT JOIN tbl_sections scoped_section ON scoped_cs.section_id = scoped_section.section_id
                                WHERE scoped_subject.program_id = ? OR scoped_section.program_id = ?
                            )
                        )";
                        $params[] = (int)$authUserId;
                        $types .= 'i';
                        if ($hasAssignedProgramHeadCol) { $params[] = $programFilter; $types .= 'i'; }
                        $params[] = $programFilter;
                        $params[] = $programFilter;
                        $types .= 'ii';
                    }

                    if ($roleFilter !== null) {
                        $sql .= " AND role_id = ?";
                        $params[] = $roleFilter;
                        $types .= 'i';
                    }
                } else {
                    json_response([]);
                }

                if ($teachingRolesOnly) {
                    // Accounts allowed to hold teaching schedules: Dean, Program Head,
                    // Secretary, and Teacher. Admin roles are intentionally excluded.
                    $sql .= " AND role_id IN (2, 3, 4, 5)";
                }

                $sql .= " ORDER BY last_name, first_name";
                
                $stmt = $mysqli->prepare($sql);
                if (!$stmt) json_response(['error' => 'db_prepare_failed', 'message' => $mysqli->error], 500);
                
                if (!empty($params)) {
                    $stmt->bind_param($types, ...$params);
                }
                
                $stmt->execute();
                $res = $stmt->get_result();
                $out = [];
                while ($r = $res->fetch_assoc()) {
                    $label = trim(($r['first_name'] ?? '') . ' ' . ($r['last_name'] ?? ''));
                    if ($label === '') $label = 'User #' . $r['user_id'];
                    $out[] = [
                        'id' => $r['user_id'],
                        'user_id' => $r['user_id'],
                        'first_name' => $r['first_name'] ?? '',
                        'last_name' => $r['last_name'] ?? '',
                        'label' => $label,
                        'id_number' => $r['id_number'] ?? '',
                        'school_id' => $r['id_number'] ?? '',
                        'role_id' => isset($r['role_id']) ? (int)$r['role_id'] : null,
                        'status' => $r['status'] ?? 'active',
                        'assigned_program_head_id' => isset($r['assigned_program_head_id']) && $r['assigned_program_head_id'] !== null ? (int)$r['assigned_program_head_id'] : null,
                        'assigned_program_id' => isset($r['assigned_program_id']) && $r['assigned_program_id'] !== null ? (int)$r['assigned_program_id'] : null,
                        'assigned_program_name' => $r['assigned_program_name'] ?? '',
                        'assigned_program_sub_name' => $r['assigned_program_sub_name'] ?? null,
                        'dept_id' => isset($r['dept_id']) && $r['dept_id'] !== null ? (int)$r['dept_id'] : null,
                        'department' => $r['dept_name'] ?? '',
                        'department_sub_name' => $r['department_sub_name'] ?? null,
                    ];
                }
                $stmt->close();
                json_response($out);
            }

            $selectAssignedHead = $hasAssignedProgramHeadCol
                ? ", u.assigned_program_head_id, CONCAT_WS(' ', aph.first_name, aph.last_name) AS assigned_program_head_name"
                : ", NULL AS assigned_program_head_id, NULL AS assigned_program_head_name";
            $selectAssignedProgram = $hasAssignedProgramHeadCol
                ? ", phead.program_id AS assigned_program_id, phead.program_name AS assigned_program_name, phead.sub_name AS assigned_program_sub_name"
                : ", NULL AS assigned_program_id, NULL AS assigned_program_name, NULL AS assigned_program_sub_name";
            $joinAssignedProgram = $hasAssignedProgramHeadCol
                ? " LEFT JOIN tbl_programs phead ON u.assigned_program_head_id = phead.program_id LEFT JOIN tbl_users aph ON phead.head_id = aph.user_id "
                : "";
            $selectActiveSchedule = ", EXISTS(
                    SELECT 1
                    FROM tbl_class_schedules active_cs
                    JOIN tbl_semesters active_sem ON active_sem.semester_id = active_cs.semester_id
                    JOIN tbl_school_year active_sy ON active_sy.school_year_id = active_sem.school_year_id
                    WHERE active_cs.user_id = u.user_id
                      AND LOWER(TRIM(COALESCE(active_sem.status, ''))) IN ('active', '1', 'true')
                      AND LOWER(TRIM(COALESCE(active_sy.status, ''))) IN ('active', '1', 'true')
                ) AS has_active_schedule,
                (SELECT CONCAT_WS(' ', NULLIF(TRIM(label_sem.term), ''), NULLIF(TRIM(label_sy.session_name), ''))
                    FROM tbl_class_schedules label_cs
                    JOIN tbl_semesters label_sem ON label_sem.semester_id = label_cs.semester_id
                    JOIN tbl_school_year label_sy ON label_sy.school_year_id = label_sem.school_year_id
                    WHERE label_cs.user_id = u.user_id
                      AND LOWER(TRIM(COALESCE(label_sem.status, ''))) IN ('active', '1', 'true')
                      AND LOWER(TRIM(COALESCE(label_sy.status, ''))) IN ('active', '1', 'true')
                    ORDER BY label_sem.semester_id DESC
                    LIMIT 1
                ) AS active_schedule_label";
            $sql = "SELECT u.user_id, u.role_id, u.first_name, u.last_name, u.email, u.contact_no, u.image AS avatar, u.id_number, u.dept_id, d.dept_name, d.sub_name AS department_sub_name, r.role_name, u.status, u.is_first_login{$selectAssignedHead}{$selectAssignedProgram}{$selectActiveSchedule} FROM tbl_users u LEFT JOIN tbl_departments d ON u.dept_id = d.dept_id JOIN tbl_roles r ON u.role_id = r.role_id{$joinAssignedProgram}";
            $types = '';
            $params = [];
            $moduleAccessTargetsOnly = isset($_GET['module_access_targets']) && (string)$_GET['module_access_targets'] === '1';
            $passwordResetTargetsOnly = isset($_GET['password_reset_targets']) && (string)$_GET['password_reset_targets'] === '1';
            $settingsTargetsOnly = $moduleAccessTargetsOnly || $passwordResetTargetsOnly;
            $paginateUsers = !$settingsTargetsOnly && isset($_GET['paginate']) && (string)$_GET['paginate'] === '1';

            // The User Management directory opts into this response. Keep the
            // legacy array response below untouched for settings and all other
            // existing consumers of GET /users.
            if ($paginateUsers) {
                $page = isset($_GET['page']) && is_numeric($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
                $pageSize = isset($_GET['page_size']) && is_numeric($_GET['page_size']) ? (int)$_GET['page_size'] : 10;
                $pageSize = max(1, min(50, $pageSize));
                $search = trim((string)($_GET['search'] ?? ''));
                $roleFilter = isset($_GET['role_id']) && is_numeric($_GET['role_id']) ? (int)$_GET['role_id'] : null;
                $deptFilter = isset($_GET['dept_id']) && is_numeric($_GET['dept_id']) ? (int)$_GET['dept_id'] : null;
                $statusFilter = strtolower(trim((string)($_GET['status'] ?? 'all')));
                if (!in_array($statusFilter, ['all', 'active', 'inactive', 'archive'], true)) $statusFilter = 'all';
                if (!$isAdminRole && !$isDepartmentAdminRole && $statusFilter === 'archive') $statusFilter = 'all';

                $fromSql = " FROM tbl_users u LEFT JOIN tbl_departments d ON u.dept_id = d.dept_id JOIN tbl_roles r ON u.role_id = r.role_id{$joinAssignedProgram}";
                $scopeConditions = ['u.role_id <> 1'];
                $scopeTypes = '';
                $scopeParams = [];

                if (!$isAdminRole) {
                    if ((int)$authRoleId === 3) {
                        $scopeConditions[] = 'u.role_id IN (4, 5)';
                        if ($programHeadDeptId === null) {
                            $scopeConditions[] = '1 = 0';
                        } else {
                            $scopeConditions[] = 'u.dept_id = ?';
                            $scopeTypes .= 'i';
                            $scopeParams[] = (int)$programHeadDeptId;
                            if ($hasAssignedProgramHeadCol) {
                                $scopeConditions[] = 'u.assigned_program_head_id = (SELECT ph_scope.assigned_program_head_id FROM tbl_users ph_scope WHERE ph_scope.user_id = ? AND ph_scope.role_id = 3 LIMIT 1)';
                                $scopeTypes .= 'i';
                                $scopeParams[] = (int)$authUserId;
                            } else {
                                $scopeConditions[] = "u.user_id IN (
                                    SELECT DISTINCT cs.user_id
                                    FROM tbl_class_schedules cs
                                    LEFT JOIN tbl_subject s ON cs.subject_id = s.subject_id
                                    LEFT JOIN tbl_sections sec ON cs.section_id = sec.section_id
                                    LEFT JOIN tbl_programs ps ON s.program_id = ps.program_id
                                    LEFT JOIN tbl_programs psec ON sec.program_id = psec.program_id
                                    WHERE cs.user_id IS NOT NULL
                                      AND (ps.head_id = ? OR psec.head_id = ?)
                                )";
                                $scopeTypes .= 'ii';
                                $scopeParams[] = (int)$authUserId;
                                $scopeParams[] = (int)$authUserId;
                            }
                        }
                    } elseif ((int)$authRoleId === 6) {
                        $scopeConditions[] = 'u.role_id IN (2, 3, 4, 5)';
                        if ($authUserDeptId === null) {
                            $scopeConditions[] = '1 = 0';
                        } else {
                            $scopeConditions[] = 'u.dept_id = ?';
                            $scopeTypes .= 'i';
                            $scopeParams[] = (int)$authUserDeptId;
                        }
                    } elseif ((int)$authRoleId === 2) {
                        $scopeConditions[] = 'u.role_id IN (3, 4, 5)';
                        if ($authUserDeptId === null) {
                            $scopeConditions[] = '1 = 0';
                        } else {
                            $scopeConditions[] = 'u.dept_id = ?';
                            $scopeTypes .= 'i';
                            $scopeParams[] = (int)$authUserDeptId;
                        }
                    } elseif ((int)$authRoleId === 4) {
                        $scopeConditions[] = 'u.role_id = 5';
                        if ($authUserDeptId === null) {
                            $scopeConditions[] = '1 = 0';
                        } else {
                            $scopeConditions[] = 'u.dept_id = ?';
                            $scopeTypes .= 'i';
                            $scopeParams[] = (int)$authUserDeptId;
                        }
                    } else {
                        $scopeConditions[] = '1 = 0';
                    }
                }

                $filteredConditions = $scopeConditions;
                $filteredTypes = $scopeTypes;
                $filteredParams = $scopeParams;
                $normalizedStatusSql = "LOWER(TRIM(COALESCE(u.status, '')))";
                if ($statusFilter === 'all') {
                    $filteredConditions[] = "{$normalizedStatusSql} NOT IN ('archive', 'archived')";
                } else {
                    $filteredConditions[] = "{$normalizedStatusSql} = ?";
                    $filteredTypes .= 's';
                    $filteredParams[] = $statusFilter;
                }
                if ($roleFilter !== null) {
                    $filteredConditions[] = 'u.role_id = ?';
                    $filteredTypes .= 'i';
                    $filteredParams[] = $roleFilter;
                }
                // Department selection is global only for Admin. Every other
                // role remains locked to its authenticated server-side scope.
                if ($isAdminRole && $deptFilter !== null) {
                    $filteredConditions[] = 'u.dept_id = ?';
                    $filteredTypes .= 'i';
                    $filteredParams[] = $deptFilter;
                }
                if ($search !== '') {
                    $searchProgramSql = $hasAssignedProgramHeadCol
                        ? ", COALESCE(phead.program_name, ''), COALESCE(phead.sub_name, '')"
                        : '';
                    $filteredConditions[] = "CONCAT_WS(' ', COALESCE(u.first_name, ''), COALESCE(u.last_name, ''), COALESCE(u.email, ''), COALESCE(u.id_number, ''), COALESCE(d.dept_name, ''), COALESCE(d.sub_name, ''){$searchProgramSql}) LIKE ?";
                    $filteredTypes .= 's';
                    $filteredParams[] = '%' . $search . '%';
                }

                $scopeWhere = ' WHERE ' . implode(' AND ', $scopeConditions);
                $filteredWhere = ' WHERE ' . implode(' AND ', $filteredConditions);

                $countStmt = $mysqli->prepare("SELECT COUNT(DISTINCT u.user_id) AS total{$fromSql}{$filteredWhere}");
                if (!$countStmt) json_response(['error' => 'db_prepare_failed', 'message' => $mysqli->error], 500);
                if ($filteredTypes !== '') $countStmt->bind_param($filteredTypes, ...$filteredParams);
                $countStmt->execute();
                $totalRows = (int)($countStmt->get_result()->fetch_assoc()['total'] ?? 0);
                $countStmt->close();
                $totalPages = max(1, (int)ceil($totalRows / $pageSize));
                $page = min($page, $totalPages);
                $offset = ($page - 1) * $pageSize;

                $statsStmt = $mysqli->prepare("SELECT
                    SUM(CASE WHEN {$normalizedStatusSql} NOT IN ('archive', 'archived') THEN 1 ELSE 0 END) AS total,
                    SUM(CASE WHEN {$normalizedStatusSql} = 'active' THEN 1 ELSE 0 END) AS active,
                    SUM(CASE WHEN {$normalizedStatusSql} = 'inactive' THEN 1 ELSE 0 END) AS inactive,
                    SUM(CASE WHEN {$normalizedStatusSql} = 'archive' THEN 1 ELSE 0 END) AS archived
                    {$fromSql}{$scopeWhere}");
                if (!$statsStmt) json_response(['error' => 'db_prepare_failed', 'message' => $mysqli->error], 500);
                if ($scopeTypes !== '') $statsStmt->bind_param($scopeTypes, ...$scopeParams);
                $statsStmt->execute();
                $statsRow = $statsStmt->get_result()->fetch_assoc() ?: [];
                $statsStmt->close();

                $roleConditions = $scopeConditions;
                $roleConditions[] = "{$normalizedStatusSql} NOT IN ('archive', 'archived')";
                $roleWhere = ' WHERE ' . implode(' AND ', $roleConditions);
                $roleStmt = $mysqli->prepare("SELECT u.role_id, COUNT(DISTINCT u.user_id) AS total{$fromSql}{$roleWhere} GROUP BY u.role_id ORDER BY u.role_id");
                if (!$roleStmt) json_response(['error' => 'db_prepare_failed', 'message' => $mysqli->error], 500);
                if ($scopeTypes !== '') $roleStmt->bind_param($scopeTypes, ...$scopeParams);
                $roleStmt->execute();
                $roleResult = $roleStmt->get_result();
                $roleCounts = [];
                while ($roleRow = $roleResult->fetch_assoc()) {
                    $roleCounts[(string)(int)$roleRow['role_id']] = (int)$roleRow['total'];
                }
                $roleStmt->close();

                $pagedAvatarSelect = ", CASE WHEN u.image IS NULL OR OCTET_LENGTH(u.image) = 0 THEN 0 ELSE 1 END AS has_avatar";
                $orderSql = $statusFilter === 'all'
                    ? " ORDER BY CASE {$normalizedStatusSql} WHEN 'active' THEN 0 WHEN 'inactive' THEN 1 ELSE 2 END, u.first_name, u.last_name, u.user_id"
                    : ' ORDER BY u.user_id DESC';
                $dataSql = "SELECT u.user_id, u.role_id, u.first_name, u.last_name, u.email, u.contact_no, u.id_number, u.dept_id, d.dept_name, d.sub_name AS department_sub_name, r.role_name, u.status, u.is_first_login{$pagedAvatarSelect}{$selectAssignedHead}{$selectAssignedProgram}{$selectActiveSchedule}{$fromSql}{$filteredWhere}{$orderSql} LIMIT ? OFFSET ?";
                $dataTypes = $filteredTypes . 'ii';
                $dataParams = array_merge($filteredParams, [$pageSize, $offset]);
                $dataStmt = $mysqli->prepare($dataSql);
                if (!$dataStmt) json_response(['error' => 'db_prepare_failed', 'message' => $mysqli->error], 500);
                $dataStmt->bind_param($dataTypes, ...$dataParams);
                $dataStmt->execute();
                $dataResult = $dataStmt->get_result();
                $users = $dataResult ? $dataResult->fetch_all(MYSQLI_ASSOC) : [];
                $dataStmt->close();

                $scriptName = str_replace('\\', '/', (string)($_SERVER['SCRIPT_NAME'] ?? '/api/index.php'));
                $apiBasePath = rtrim(str_replace('\\', '/', dirname($scriptName)), '/.');
                if ($apiBasePath === '') $apiBasePath = '/api';
                $users = array_map(function($user) use ($apiBasePath) {
                    if (isset($user['role_name'])) $user['role_name'] = app_format_role_name($user['role_name']);
                    $hasAvatar = !empty($user['has_avatar']);
                    $user['avatar'] = $hasAvatar
                        ? $apiBasePath . '/avatar-thumbnail.php?' . http_build_query(['user_id' => (int)$user['user_id'], 'size' => 64], '', '&', PHP_QUERY_RFC3986)
                        : null;
                    unset($user['has_avatar']);
                    return $user;
                }, $users);

                json_response([
                    'rows' => $users,
                    'pagination' => [
                        'page' => $page,
                        'page_size' => $pageSize,
                        'total' => $totalRows,
                        'total_pages' => $totalPages,
                    ],
                    'status_counts' => [
                        'total' => (int)($statsRow['total'] ?? 0),
                        'active' => (int)($statsRow['active'] ?? 0),
                        'inactive' => (int)($statsRow['inactive'] ?? 0),
                        'archived' => (int)($statsRow['archived'] ?? 0),
                    ],
                    'role_counts' => $roleCounts,
                ]);
            }
            if ($settingsTargetsOnly && $isAdminRole) {
                $sql .= " WHERE u.role_id <> 1";
            }
            if (!$isAdminRole) {
                // Role-based read scopes for non-admin accounts.
                if ((int)$authRoleId === 3) {
                    $sql .= " WHERE u.role_id IN (4, 5)";
                    if ($programHeadDeptId === null) {
                        json_response([]);
                    }
                    $sql .= " AND u.dept_id = ?";
                    $types .= 'i';
                    $params[] = (int)$programHeadDeptId;
                    if ($hasAssignedProgramHeadCol) {
                        $sql .= " AND u.assigned_program_head_id = (SELECT ph_scope.assigned_program_head_id FROM tbl_users ph_scope WHERE ph_scope.user_id = ? AND ph_scope.role_id = 3 LIMIT 1)";
                        $types .= 'i';
                        $params[] = (int)$authUserId;
                    } else {
                        // Backward-compatible fallback for schemas without assigned_program_head_id.
                        $sql .= " AND u.user_id IN (
                            SELECT DISTINCT cs.user_id
                            FROM tbl_class_schedules cs
                            LEFT JOIN tbl_subject s ON cs.subject_id = s.subject_id
                            LEFT JOIN tbl_sections sec ON cs.section_id = sec.section_id
                            LEFT JOIN tbl_programs ps ON s.program_id = ps.program_id
                            LEFT JOIN tbl_programs psec ON sec.program_id = psec.program_id
                            WHERE cs.user_id IS NOT NULL
                              AND (ps.head_id = ? OR psec.head_id = ?)
                        )";
                        $types .= 'ii';
                        $params[] = (int)$authUserId;
                        $params[] = (int)$authUserId;
                    }
                } elseif ((int)$authRoleId === 6 && $settingsTargetsOnly) {
                    if ($authUserDeptId === null) {
                        json_response([]);
                    }
                    $sql .= " WHERE u.role_id <> 1 AND u.dept_id = ?";
                    $types .= 'i';
                    $params[] = (int)$authUserDeptId;
                } elseif ((int)$authRoleId === 6) {
                    if ($authUserDeptId === null) {
                        json_response([]);
                    }
                    $sql .= " WHERE u.role_id IN (2, 3, 4, 5) AND u.dept_id = ?";
                    $types .= 'i';
                    $params[] = (int)$authUserDeptId;
                } elseif ((int)$authRoleId === 2) {
                    if ($authUserDeptId === null) {
                        json_response([]);
                    }
                    $sql .= " WHERE u.role_id IN (3, 4, 5) AND u.dept_id = ?";
                    $types .= 'i';
                    $params[] = (int)$authUserDeptId;
                } elseif ((int)$authRoleId === 4) {
                    if ($authUserDeptId === null) {
                        json_response([]);
                    }
                    $sql .= " WHERE u.role_id = 5 AND u.dept_id = ?";
                    $types .= 'i';
                    $params[] = (int)$authUserDeptId;
                } else {
                    json_response([]);
                }
            }
            // Legacy consumers receive active + inactive users for read-only
            // history, never archived users. Settings target pickers are
            // operational controls and therefore remain active-only.
            $legacyStatusWhere = $settingsTargetsOnly
                ? "LOWER(TRIM(COALESCE(status, ''))) IN ('active', '1', 'true')"
                : "LOWER(TRIM(COALESCE(status, ''))) NOT IN ('archive', 'archived')";
            $sql = "SELECT * FROM ({$sql}) scoped_users WHERE {$legacyStatusWhere} ORDER BY user_id DESC";

            $stmt = $mysqli->prepare($sql);
            if (!$stmt) json_response(['error' => 'db_prepare_failed', 'message' => $mysqli->error], 500);
            if (!empty($params)) {
                $stmt->bind_param($types, ...$params);
            }
            $stmt->execute();
            $res = $stmt->get_result();
            $users = $res ? $res->fetch_all(MYSQLI_ASSOC) : [];
            // Format role names to proper nouns for display
            $users = array_map(function($user) {
                if (isset($user['role_name'])) {
                    $user['role_name'] = app_format_role_name($user['role_name']);
                }
                return $user;
            }, $users);
            json_response($users);

        } elseif ($request_method === 'POST' && $param1 === 'import') {
            // Admin can import broadly. Department admin can import only allowed roles in their own department.
            if (!$isAdminRole && !$isDepartmentAdminRole) {
                json_response(['error' => 'forbidden', 'message' => 'Only admin and department admin can import users'], 403);
            }

            $rows = isset($input['rows']) && is_array($input['rows']) ? $input['rows'] : [];
            if (empty($rows)) {
                json_response(['error' => 'validation', 'message' => 'rows is required and must be a non-empty array'], 400);
            }
            $previewOnly = !empty($input['preview']);
            if ($isDepartmentAdminRole && $authUserDeptId === null) {
                json_response(['error' => 'forbidden', 'message' => 'Your account is not assigned to a department.'], 403);
            }

            $roleMap = [];
            $rolesRes = $mysqli->query("SELECT role_id, role_name FROM tbl_roles");
            if ($rolesRes) {
                while ($rr = $rolesRes->fetch_assoc()) {
                    $rid = (int)($rr['role_id'] ?? 0);
                    $rname = strtolower(trim((string)($rr['role_name'] ?? '')));
                    if ($rid > 0) {
                        if ($rname !== '') {
                            $key = preg_replace('/[^a-z0-9]+/', '_', $rname);
                            $roleMap[$key] = $rid;
                        }
                    }
                }
            }
            // Defensive aliases for common role strings
            $roleMap['admin'] = $roleMap['admin'] ?? 1;
            $roleMap['dean'] = $roleMap['dean'] ?? 2;
            $roleMap['program_head'] = $roleMap['program_head'] ?? 3;
            $roleMap['programhead'] = $roleMap['program_head'];
            $roleMap['secretary'] = $roleMap['secretary'] ?? 4;
            $roleMap['teacher'] = $roleMap['teacher'] ?? 5;
            $roleMap['department_admin'] = $roleMap['department_admin'] ?? 6;
            $roleMap['departmentadmin'] = $roleMap['department_admin'];
            $roleMap['dept_admin'] = $roleMap['department_admin'];
            $roleMap['deptadmin'] = $roleMap['department_admin'];

            $hasDeptSubNameCol = false;
            $deptSubNameCheck = $mysqli->query("SHOW COLUMNS FROM tbl_departments LIKE 'sub_name'");
            if ($deptSubNameCheck) {
                $hasDeptSubNameCol = $deptSubNameCheck->num_rows > 0;
                $deptSubNameCheck->free();
            }

            $hasProgramSubNameCol = false;
            $programSubNameCheck = $mysqli->query("SHOW COLUMNS FROM tbl_programs LIKE 'sub_name'");
            if ($programSubNameCheck) {
                $hasProgramSubNameCol = $programSubNameCheck->num_rows > 0;
                $programSubNameCheck->free();
            }

            $deptLookup = [];
            $activeDeptIds = [];
            $formatAcademicLabel = function($subName, $fullName) {
                $sub = trim((string)($subName ?? ''));
                $full = trim((string)($fullName ?? ''));
                if ($sub === '') return $full;
                if ($full === '' || strcasecmp($sub, $full) === 0) return $sub;
                return $sub . ' (' . $full . ')';
            };
            $deptQuery = "SELECT dept_id, " . ($hasDeptSubNameCol ? 'sub_name' : 'dept_name AS sub_name') . ", dept_name FROM tbl_departments WHERE LOWER(TRIM(COALESCE(status, ''))) = 'active'";
            $deptRes = $mysqli->query($deptQuery);
            if ($deptRes) {
                while ($dr = $deptRes->fetch_assoc()) {
                    $did = (int)($dr['dept_id'] ?? 0);
                    $dname = strtolower(trim((string)($dr['dept_name'] ?? '')));
                    $dsub = strtolower(trim((string)($dr['sub_name'] ?? '')));
                    $dlabel = strtolower($formatAcademicLabel($dr['sub_name'] ?? null, $dr['dept_name'] ?? ''));
                    if ($did > 0) {
                        user_import_add_lookup_candidate($deptLookup, $dname, $did);
                        user_import_add_lookup_candidate($deptLookup, $dsub, $did);
                        user_import_add_lookup_candidate($deptLookup, $dlabel, $did);
                        $activeDeptIds[$did] = true;
                    }
                }
            }

            $programLookupByDept = [];
            $programById = [];
            $generalProgramByDept = [];
            if ($hasAssignedProgramHeadCol) {
                $programQuery = "SELECT p.program_id, " . ($hasProgramSubNameCol ? 'p.sub_name' : 'p.program_name AS sub_name') . ", p.program_name, p.dept_id, p.head_id FROM tbl_programs p JOIN tbl_departments d ON d.dept_id = p.dept_id WHERE LOWER(TRIM(COALESCE(p.status, ''))) = 'active' AND LOWER(TRIM(COALESCE(d.status, ''))) = 'active'";
                $programRes = $mysqli->query($programQuery);
                if ($programRes) {
                    while ($pr = $programRes->fetch_assoc()) {
                        $programId = (int)($pr['program_id'] ?? 0);
                        $programDeptId = (int)($pr['dept_id'] ?? 0);
                        $programName = trim((string)($pr['program_name'] ?? ''));
                        if ($programId <= 0 || $programDeptId <= 0) continue;
                        $programById[$programId] = $pr;
                        if (!isset($programLookupByDept[$programDeptId])) $programLookupByDept[$programDeptId] = [];
                        user_import_add_lookup_candidate($programLookupByDept[$programDeptId], $programName, $programId);
                        user_import_add_lookup_candidate($programLookupByDept[$programDeptId], $pr['sub_name'] ?? '', $programId);
                        user_import_add_lookup_candidate($programLookupByDept[$programDeptId], $formatAcademicLabel($pr['sub_name'] ?? null, $programName), $programId);
                        if (strcasecmp($programName, 'General') === 0 && !empty($pr['dept_id'])) {
                            $generalProgramByDept[(int)$pr['dept_id']] = $programId;
                        }
                    }
                }
            }

            $lockSuffix = $previewOnly ? '' : ' FOR UPDATE';
            if (!$previewOnly && !$mysqli->begin_transaction()) {
                json_response(['error' => 'transaction_failed', 'message' => 'Unable to start the user import transaction.'], 500);
            }
            $checkEmailStmt = $mysqli->prepare("SELECT user_id FROM tbl_users WHERE email = ? LIMIT 1{$lockSuffix}");
            $checkIdStmt = $mysqli->prepare("SELECT user_id FROM tbl_users WHERE id_number = ? LIMIT 1{$lockSuffix}");
            $checkContactStmt = $mysqli->prepare("SELECT user_id FROM tbl_users WHERE contact_no = ? LIMIT 1{$lockSuffix}");
            if (!$checkEmailStmt || !$checkIdStmt || !$checkContactStmt) {
                if (!$previewOnly) $mysqli->rollback();
                json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            }

            $inserted = 0;
            $skipped = 0;
            $errors = [];
            $seenEmails = [];
            $seenSchoolIds = [];
            $seenContacts = [];
            $validatedRows = [];
            $mailSent = 0;
            $mailFailed = 0;
            $mailFailures = [];

            foreach ($rows as $idx => $row) {
                $rowNum = $idx + 2; // header is row 1 in spreadsheets
                if (!is_array($row)) {
                    $skipped++;
                    $errors[] = ['row' => $rowNum, 'message' => 'Invalid row format'];
                    continue;
                }

                $normalized = [];
                foreach ($row as $k => $v) {
                    $key = user_import_normalize_key($k);
                    if ($key === '') continue;
                    $normalized[$key] = is_string($v) ? trim($v) : $v;
                }

                $pick = function(array $keys) use ($normalized) { return user_import_pick($normalized, $keys); };

                $firstName = $normalize_person_name($pick(['first_name', 'firstname', 'first', 'given_name']));
                $lastName = $normalize_person_name($pick(['last_name', 'lastname', 'last', 'family_name']));
                $email = $normalize_user_email($pick(['email', 'email_address', 'mail']));
                $schoolId = $normalize_id_number($pick(['school_id', 'schoolid', 'school_id_number']));
                $contactNo = $pick(['contact_no', 'contact', 'contact_number', 'phone', 'mobile']);
                $roleRaw = $pick(['role', 'role_name']);
                $deptRaw = $pick(['department', 'dept', 'dept_name', 'department_sub_name', 'dept_sub_name']);
                $programRaw = $pick(['program', 'program_name', 'program_sub_name']);

                if ($firstName === '' || $lastName === '' || $email === '' || $schoolId === '' || $roleRaw === '') {
                    $skipped++;
                    $errors[] = ['row' => $rowNum, 'message' => 'Missing required fields (first_name, last_name, email, school_id, role)'];
                    continue;
                }
                if (!$is_valid_person_name($firstName)) {
                    $skipped++;
                    $errors[] = ['row' => $rowNum, 'message' => 'Invalid first_name. Use letters, spaces, apostrophes, periods, or hyphens only.'];
                    continue;
                }
                if (!$is_valid_person_name($lastName)) {
                    $skipped++;
                    $errors[] = ['row' => $rowNum, 'message' => 'Invalid last_name. Use letters, spaces, apostrophes, periods, or hyphens only.'];
                    continue;
                }
                if (!$is_valid_user_email($email)) {
                    $skipped++;
                    $errors[] = ['row' => $rowNum, 'message' => 'Invalid email. Use the format xxxx.name.coc@phinmaed.com'];
                    continue;
                }
                if (!$is_valid_id_number($schoolId)) {
                    $skipped++;
                    $errors[] = ['row' => $rowNum, 'message' => 'Invalid school_id format. Must match ##-###-letter (e.g. 24-018-F)'];
                    continue;
                }

                $roleId = null;
                $roleKey = user_import_normalize_key($roleRaw);
                if (isset($roleMap[$roleKey])) {
                    $roleId = (int)$roleMap[$roleKey];
                }
                if (!$roleId) {
                    $skipped++;
                    $errors[] = ['row' => $rowNum, 'message' => 'Invalid role value'];
                    continue;
                }
                if ($roleId === 1) {
                    $skipped++;
                    $errors[] = ['row' => $rowNum, 'message' => 'Admin role is not allowed.'];
                    continue;
                }
                if ($isDepartmentAdminRole && !in_array($roleId, [2, 3, 4, 5], true)) {
                    $skipped++;
                    $errors[] = ['row' => $rowNum, 'message' => 'Department admin can only import Dean, Program Head, Secretary, and Teacher users.'];
                    continue;
                }

                $deptId = null;
                if ($isDepartmentAdminRole) {
                    $deptId = (int)$authUserDeptId;
                    if ($deptRaw !== '') {
                        $deptResolution = user_import_resolve_lookup($deptLookup, $deptRaw);
                        $providedDeptId = $deptResolution['status'] === 'resolved' ? (int)$deptResolution['id'] : null;
                        if (!$providedDeptId || (int)$providedDeptId !== (int)$authUserDeptId) {
                            $skipped++;
                            $errors[] = ['row' => $rowNum, 'message' => 'Department admin can only import users in their assigned department.'];
                            continue;
                        }
                    }
                } elseif ($roleId !== 1) {
                    $departmentRequired = true;
                    if ($deptRaw === '') {
                        if ($departmentRequired) {
                            $skipped++;
                            $errors[] = ['row' => $rowNum, 'message' => 'Department is required for this role'];
                            continue;
                        }
                    } else {
                        $deptResolution = user_import_resolve_lookup($deptLookup, $deptRaw);
                        if ($deptResolution['status'] === 'ambiguous') {
                            $skipped++;
                            $errors[] = ['row' => $rowNum, 'message' => "Department '{$deptRaw}' is ambiguous. Use its unique Sub Name or combined label."];
                            continue;
                        }
                        $deptId = $deptResolution['status'] === 'resolved' ? (int)$deptResolution['id'] : null;
                        if (!$deptId) {
                            $skipped++;
                            $errors[] = ['row' => $rowNum, 'message' => 'Invalid department value'];
                            continue;
                        }
                    }
                }

                if ($roleId !== 1 && (!$deptId || !isset($activeDeptIds[(int)$deptId]))) {
                    $skipped++;
                    $errors[] = ['row' => $rowNum, 'message' => 'Selected department is inactive, archived, or does not exist.'];
                    continue;
                }

                $assignedProgramId = null;
                if (in_array($roleId, [2, 3, 4, 5], true)) {
                    if (!$hasAssignedProgramHeadCol) {
                        $skipped++;
                        $errors[] = ['row' => $rowNum, 'message' => 'Database is missing assigned_program_head_id. Run the latest SQL migration first.'];
                        continue;
                    }

                    if ($programRaw === '' && $deptId && isset($generalProgramByDept[(int)$deptId])) {
                        $assignedProgramId = (int)$generalProgramByDept[(int)$deptId];
                    }
                    if ($programRaw === '') {
                        if (!$assignedProgramId) {
                            $skipped++;
                            $programRequiredMsg = $roleId === 3
                                ? 'Owned Program is required for Program Head. Use its full name, Sub Name, or combined label.'
                                : 'Assigned Program is required for this role. Use its full name, Sub Name, or combined label.';
                            $errors[] = ['row' => $rowNum, 'message' => $programRequiredMsg];
                            continue;
                        }
                    }

                    if ($programRaw !== '') {
                        $programLookup = $programLookupByDept[(int)$deptId] ?? [];
                        $programResolution = user_import_resolve_lookup($programLookup, $programRaw);
                        if ($programResolution['status'] === 'ambiguous') {
                            $skipped++;
                            $errors[] = ['row' => $rowNum, 'message' => "Program '{$programRaw}' is ambiguous in the selected Department. Use its unique Sub Name or combined label."];
                            continue;
                        }
                        $assignedProgramId = $programResolution['status'] === 'resolved' ? (int)$programResolution['id'] : null;
                    }

                    if (!$assignedProgramId || !isset($programById[$assignedProgramId])) {
                        $skipped++;
                        $errors[] = ['row' => $rowNum, 'message' => "Program '{$programRaw}' was not found in the selected Department. Use its full name, Sub Name, or combined label."];
                        continue;
                    }

                    $programDeptId = isset($programById[$assignedProgramId]['dept_id']) && $programById[$assignedProgramId]['dept_id'] !== null
                        ? (int)$programById[$assignedProgramId]['dept_id']
                        : null;
                    if ($programDeptId !== null && $deptId !== null && (int)$programDeptId !== (int)$deptId) {
                        $skipped++;
                        $errors[] = ['row' => $rowNum, 'message' => 'Selected program must belong to the selected department.'];
                        continue;
                    }
                }

                if (!user_import_is_valid_contact($contactNo)) {
                    $skipped++;
                    $errors[] = ['row' => $rowNum, 'message' => 'Invalid Contact No. Use 11 digits beginning with 09 (for example, 09123456789).'];
                    continue;
                }
                $contactNo = preg_replace('/\D+/', '', (string)$contactNo);
                if ($contactNo === '') $contactNo = null;

                $emailKey = strtolower($email);
                $schoolIdKey = strtolower(trim((string)$schoolId));
                $contactKey = $contactNo !== null ? $contactNo : '';
                if (isset($seenEmails[$emailKey])) {
                    $skipped++;
                    $errors[] = ['row' => $rowNum, 'message' => 'Duplicate email in import file'];
                    continue;
                }
                if (isset($seenSchoolIds[$schoolIdKey])) {
                    $skipped++;
                    $errors[] = ['row' => $rowNum, 'message' => 'Duplicate school ID in import file'];
                    continue;
                }
                if ($contactKey !== '' && isset($seenContacts[$contactKey])) {
                    $skipped++;
                    $errors[] = ['row' => $rowNum, 'message' => 'Duplicate Contact No in import file'];
                    continue;
                }

                $checkEmailStmt->bind_param('s', $email);
                $checkEmailStmt->execute();
                if ($checkEmailStmt->get_result()->fetch_assoc()) {
                    $skipped++;
                    $errors[] = ['row' => $rowNum, 'message' => 'Email already exists'];
                    continue;
                }

                $checkIdStmt->bind_param('s', $schoolId);
                $checkIdStmt->execute();
                if ($checkIdStmt->get_result()->fetch_assoc()) {
                    $skipped++;
                    $errors[] = ['row' => $rowNum, 'message' => 'School ID already exists'];
                    continue;
                }
                if ($contactKey !== '') {
                    $checkContactStmt->bind_param('s', $contactNo);
                    $checkContactStmt->execute();
                    if ($checkContactStmt->get_result()->fetch_assoc()) {
                        $skipped++;
                        $errors[] = ['row' => $rowNum, 'message' => 'Contact No already exists'];
                        continue;
                    }
                }

                $seenEmails[$emailKey] = true;
                $seenSchoolIds[$schoolIdKey] = true;
                if ($contactKey !== '') $seenContacts[$contactKey] = true;
                $validatedRows[] = [
                    'row' => $rowNum,
                    'role_id' => $roleId,
                    'dept_id' => $deptId,
                    'first_name' => $firstName,
                    'last_name' => $lastName,
                    'school_id' => $schoolId,
                    'email' => $email,
                    'contact_no' => $contactNo,
                    'program_id' => $assignedProgramId
                ];
                $inserted++;

            }

            if (!$previewOnly && !empty($errors)) {
                $mysqli->rollback();
                log_system_action($mysqli, $authUserId, 'reject_import_users', 'Rejected user import: errors=' . count($errors) . ', total=' . count($rows));
                json_response([
                    'preview' => false,
                    'inserted' => 0,
                    'skipped' => count($rows),
                    'total' => count($rows),
                    'errors' => $errors,
                    'message' => 'No users were imported because every row must pass validation.',
                    'email_notifications' => ['sent' => 0, 'failed' => 0, 'failures' => []]
                ], 422);
            }

            if (!$previewOnly) {
                $insertStmtWithAssigned = null;
                if ($hasAssignedProgramHeadCol) {
                    $insertStmtWithAssigned = $mysqli->prepare("INSERT INTO tbl_users (role_id, dept_id, first_name, last_name, id_number, email, password_hash, contact_no, is_first_login, assigned_program_head_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)");
                    $insertStmtNoAssigned = $mysqli->prepare("INSERT INTO tbl_users (role_id, dept_id, first_name, last_name, id_number, email, password_hash, contact_no, is_first_login, assigned_program_head_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)");
                } else {
                    $insertStmtNoAssigned = $mysqli->prepare("INSERT INTO tbl_users (role_id, dept_id, first_name, last_name, id_number, email, password_hash, contact_no, is_first_login) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)");
                }
                if (!$insertStmtNoAssigned || ($hasAssignedProgramHeadCol && !$insertStmtWithAssigned)) {
                    $mysqli->rollback();
                    json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                }

                $inserted = 0;
                try {
                    foreach ($validatedRows as $validRow) {
                        $roleId = (int)$validRow['role_id'];
                        $deptId = (int)$validRow['dept_id'];
                        $firstName = $validRow['first_name'];
                        $lastName = $validRow['last_name'];
                        $schoolId = $validRow['school_id'];
                        $email = $validRow['email'];
                        $contactNo = $validRow['contact_no'];
                        $assignedProgramId = $validRow['program_id'];
                        $passwordHash = password_hash((string)$schoolId, PASSWORD_BCRYPT);
                        $usesAssignedProgram = $hasAssignedProgramHeadCol && $assignedProgramId !== null;
                        $stmtToUse = $usesAssignedProgram ? $insertStmtWithAssigned : $insertStmtNoAssigned;
                        if ($usesAssignedProgram) {
                            $stmtToUse->bind_param('iissssssi', $roleId, $deptId, $firstName, $lastName, $schoolId, $email, $passwordHash, $contactNo, $assignedProgramId);
                        } else {
                            $stmtToUse->bind_param('iissssss', $roleId, $deptId, $firstName, $lastName, $schoolId, $email, $passwordHash, $contactNo);
                        }
                        if (!$stmtToUse->execute()) throw new RuntimeException($stmtToUse->error ?: 'Unable to insert user');
                        $newImportUserId = (int)$mysqli->insert_id;
                        $syncUserOwnership($newImportUserId, $roleId, $deptId, $assignedProgramId);
                        $inserted++;
                    }
                    if (!$mysqli->commit()) throw new RuntimeException('Unable to commit the user import transaction');
                } catch (Throwable $e) {
                    $mysqli->rollback();
                    error_log('[users/import] Transaction rolled back: ' . $e->getMessage());
                    json_response(['error' => 'import_failed', 'message' => 'User import was rolled back. No users were created.'], 500);
                }

                // Account emails are sent only after all user records commit successfully.
                foreach ($validatedRows as $validRow) {
                    $mailResult = $sendAccountCreatedEmail($validRow['first_name'], $validRow['last_name'], $validRow['email'], $validRow['school_id']);
                    if (!empty($mailResult['sent'])) {
                        $mailSent++;
                    } else {
                        $mailFailed++;
                        if (count($mailFailures) < 20) {
                            $mailFailures[] = [
                                'row' => $validRow['row'],
                                'email' => $validRow['email'],
                                'message' => $mailResult['error'] ?? 'Mail delivery failed'
                            ];
                        }
                    }
                }
            }

            $logAction = $previewOnly ? 'preview_import_users' : 'import_users';
            $logPrefix = $previewOnly ? 'Previewed user import' : 'Imported users via spreadsheet';
            log_system_action(
                $mysqli,
                $authUserId,
                $logAction,
                "{$logPrefix}: inserted={$inserted}, skipped={$skipped}, total=" . count($rows)
                    . ($previewOnly ? '' : ", email_sent={$mailSent}, email_failed={$mailFailed}")
            );
            json_response([
                'preview' => $previewOnly,
                'inserted' => $inserted,
                'skipped' => $skipped,
                'total' => count($rows),
                'errors' => $errors,
                'email_notifications' => [
                    'sent' => $previewOnly ? 0 : $mailSent,
                    'failed' => $previewOnly ? 0 : $mailFailed,
                    'failures' => $previewOnly ? [] : $mailFailures
                ]
            ]);

        } elseif (($request_method === 'PUT' || $request_method === 'POST') && is_numeric($param1)) {
            if (!$isAdminRole && !$isDepartmentAdminRole) {
                json_response(['error' => 'forbidden', 'message' => 'View-only access. Only admin and department admin can modify users.'], 403);
            }
            $userId = (int)$param1;
            $ensureDepartmentAdminUserScope = function() use ($mysqli, $isDepartmentAdminRole, $authUserDeptId, $userId) {
                if (!$isDepartmentAdminRole) return null;
                if ($authUserDeptId === null) {
                    json_response(['error' => 'forbidden', 'message' => 'Department admin is not assigned to a department.'], 403);
                }
                $scopeStmt = $mysqli->prepare("SELECT user_id, role_id, dept_id FROM tbl_users WHERE user_id = ? LIMIT 1");
                if (!$scopeStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $scopeStmt->bind_param('i', $userId);
                $scopeStmt->execute();
                $target = $scopeStmt->get_result()->fetch_assoc();
                if (!$target) json_response(['error' => 'not_found', 'message' => 'User not found'], 404);
                $targetRoleId = isset($target['role_id']) ? (int)$target['role_id'] : 0;
                $targetDeptId = isset($target['dept_id']) && $target['dept_id'] !== null ? (int)$target['dept_id'] : null;
                if (!in_array($targetRoleId, [2, 3, 4, 5], true)) {
                    json_response(['error' => 'forbidden', 'message' => 'Department admin can only manage Dean, Program Head, Secretary, and Teacher users.'], 403);
                }
                if ($targetDeptId === null || (int)$targetDeptId !== (int)$authUserDeptId) {
                    json_response(['error' => 'forbidden', 'message' => 'Department admin can only manage users inside the same department.'], 403);
                }
                return $target;
            };

            if ($param2 === 'toggle') {
                $ensureDepartmentAdminUserScope();
                $u = $mysqli->prepare("SELECT status FROM tbl_users WHERE user_id = ? LIMIT 1");
                if (!$u) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $u->bind_param("i", $userId);
                if (!$u->execute()) json_response(['error' => 'execute_failed', 'message' => $u->error], 500);
                $row = null;
                if (method_exists($u, 'get_result')) {
                    $res = $u->get_result();
                    $row = $res ? $res->fetch_assoc() : null;
                } else {
                    $u->bind_result($status);
                    if ($u->fetch()) $row = ['status' => $status];
                }
                if (!$row) json_response(['error' => 'not_found', 'message' => 'User not found'], 404);
                $currentStatus = app_normalize_user_status($row['status'] ?? null);
                if ($currentStatus === 'archive' && !$isAdminRole && !$isDepartmentAdminRole) {
                    json_response(['error' => 'forbidden', 'message' => 'Only Admin and Department Admin can restore archived user accounts.'], 403);
                }
                // Restored accounts return as inactive so an administrator can
                // review them before explicitly enabling login and assignments.
                $new = $currentStatus === 'active' ? 'inactive' : ($currentStatus === 'archive' ? 'inactive' : 'active');

                if ($new !== 'active') security_schema_ensure($mysqli);
                $up = $new === 'active'
                    ? $mysqli->prepare("UPDATE tbl_users SET status = ? WHERE user_id = ?")
                    : $mysqli->prepare("UPDATE tbl_users SET status = ?, token_version = token_version + 1 WHERE user_id = ?");
                if (!$up) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $up->bind_param("si", $new, $userId);
                if (!$up->execute()) json_response(['error' => 'update_failed', 'message' => $up->error], 500);
                if ($up->affected_rows === 0) json_response(['error' => 'not_found', 'message' => 'User not found'], 404);
                if ($new !== 'active') {
                    $revoke = $mysqli->prepare("UPDATE tbl_user_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL");
                    if ($revoke) { $revoke->bind_param('i', $userId); $revoke->execute(); $revoke->close(); }
                }
                // Notify socket server about status toggle
                $dept_id = null;
                $dStmt = $mysqli->prepare("SELECT dept_id FROM tbl_users WHERE user_id = ? LIMIT 1");
                if ($dStmt) {
                    $dStmt->bind_param('i', $userId);
                    $dStmt->execute();
                    $dRow = $dStmt->get_result()->fetch_assoc();
                    if ($dRow && isset($dRow['dept_id'])) {
                        $dept_id = (int)$dRow['dept_id'];
                    }
                }

                try {
                    $payload = ['entity' => 'users', 'action' => 'toggle', 'user_id' => $userId, 'status' => $new];
                    if ($dept_id) {
                        $payload['dept_id'] = $dept_id;
                    }
                    trigger_socket_update($payload);
                } catch (Throwable $_) {}

                // Log user status toggle with friendly name
                $logName = null;
                $qn = $mysqli->prepare("SELECT first_name, last_name, email FROM tbl_users WHERE user_id = ? LIMIT 1");
                if ($qn) { $qn->bind_param('i', $userId); $qn->execute(); $rn = $qn->get_result()->fetch_assoc(); if ($rn) { $logName = trim(($rn['first_name'] ?? '') . ' ' . ($rn['last_name'] ?? '')); if ($logName === '') $logName = $rn['email'] ?? null; } }
                $logMsg = $logName ? "Changed status of user '{$logName}' to {$new}" : "Changed status of user ID {$userId} to {$new}";
                log_system_action($mysqli, $authUserId, 'toggle_user', $logMsg);
                json_response(['user_id' => $userId, 'status' => $new]);
            }

            if ($param2 === 'archive') {
                if (!$isAdminRole && !$isDepartmentAdminRole) {
                    json_response(['error' => 'forbidden', 'message' => 'Only Admin and Department Admin can archive user accounts.'], 403);
                }
                // For Department Admin, enforce the existing same-department
                // and allowed-role boundary before running archive checks.
                $ensureDepartmentAdminUserScope();
                if ($userId === (int)$authUserId) {
                    json_response(['error' => 'cannot_archive_self', 'message' => 'You cannot archive your own account.'], 409);
                }
                security_schema_ensure($mysqli);
                if (!$mysqli->begin_transaction()) {
                    json_response(['error' => 'transaction_failed', 'message' => 'Unable to start the archive safety check.'], 500);
                }
                try {
                    $targetStmt = $mysqli->prepare("SELECT user_id, status, first_name, last_name, email FROM tbl_users WHERE user_id = ? LIMIT 1 FOR UPDATE");
                    if (!$targetStmt) throw new RuntimeException($mysqli->error);
                    $targetStmt->bind_param('i', $userId);
                    $targetStmt->execute();
                    $archiveTarget = $targetStmt->get_result()->fetch_assoc();
                    $targetStmt->close();
                    if (!$archiveTarget) {
                        $mysqli->rollback();
                        json_response(['error' => 'not_found', 'message' => 'User not found'], 404);
                    }
                    if (app_normalize_user_status($archiveTarget['status'] ?? null) === 'archive') {
                        $mysqli->rollback();
                        json_response(['user_id' => $userId, 'status' => 'archive', 'message' => 'User is already archived.']);
                    }

                    $dependencies = app_user_archive_dependencies($mysqli, $userId);
                    if ($dependencies) {
                        $labels = array_map(function ($item) {
                            return $item['label'] . ' (' . $item['count'] . ')';
                        }, $dependencies);
                        $mysqli->rollback();
                        json_response([
                            'error' => 'user_in_use',
                            'message' => 'This user cannot be archived because related records exist: ' . implode(', ', $labels) . '. Set the account to inactive instead.',
                            'dependencies' => $dependencies,
                        ], 409);
                    }

                    $up = $mysqli->prepare("UPDATE tbl_users SET status = 'archive', token_version = token_version + 1 WHERE user_id = ?");
                    if (!$up) throw new RuntimeException($mysqli->error);
                    $up->bind_param('i', $userId);
                    if (!$up->execute()) throw new RuntimeException($up->error);
                    $up->close();
                    $revoke = $mysqli->prepare("UPDATE tbl_user_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL");
                    if ($revoke) { $revoke->bind_param('i', $userId); $revoke->execute(); $revoke->close(); }
                    $mysqli->commit();
                } catch (Throwable $archiveError) {
                    $mysqli->rollback();
                    json_response(['error' => 'archive_failed', 'message' => 'The account could not be archived safely.'], 500);
                }
                $dept_id = null;
                $dStmt = $mysqli->prepare("SELECT dept_id FROM tbl_users WHERE user_id = ? LIMIT 1");
                if ($dStmt) {
                    $dStmt->bind_param('i', $userId);
                    $dStmt->execute();
                    $dRow = $dStmt->get_result()->fetch_assoc();
                    if ($dRow && isset($dRow['dept_id'])) {
                        $dept_id = (int)$dRow['dept_id'];
                    }
                }

                try {
                    $payload = ['entity' => 'users', 'action' => 'archive', 'user_id' => $userId];
                    if ($dept_id) {
                        $payload['dept_id'] = $dept_id;
                    }
                    trigger_socket_update($payload);
                } catch (Throwable $_) {}

                // Log archive action
                $logName = null;
                $qn = $mysqli->prepare("SELECT first_name, last_name, email FROM tbl_users WHERE user_id = ? LIMIT 1");
                if ($qn) { $qn->bind_param('i', $userId); $qn->execute(); $rn = $qn->get_result()->fetch_assoc(); if ($rn) { $logName = trim(($rn['first_name'] ?? '') . ' ' . ($rn['last_name'] ?? '')); if ($logName === '') $logName = $rn['email'] ?? null; } }
                $logMsg = $logName ? "Archived user '{$logName}'" : "Archived user ID {$userId}";
                log_system_action($mysqli, $authUserId, 'archive_user', $logMsg);
                json_response(['user_id' => $userId, 'status' => 'archive']);
            }

            if ($param2 === 'reset-default-password') {
                security_schema_ensure($mysqli);
                if (!$isAdminRole && !$isDepartmentAdminRole) {
                    json_response(['error' => 'forbidden', 'message' => 'Only Admin and Department Admin can reset passwords.'], 403);
                }

                $requiredColumns = ['is_first_login','token_version','temporary_password_expires_at','temporary_password_sent_at'];
                foreach ($requiredColumns as $column) {
                    $check = $mysqli->query("SHOW COLUMNS FROM tbl_users LIKE '" . $mysqli->real_escape_string($column) . "'");
                    if (!$check || $check->num_rows === 0) json_response(['error'=>'schema_mismatch','message'=>'Run the latest admin security migration first.'], 500);
                }

                $targetStmt = $mysqli->prepare("SELECT user_id, role_id, dept_id, first_name, last_name, email, id_number, status, password_hash, temporary_password_sent_at FROM tbl_users WHERE user_id = ? LIMIT 1");
                if (!$targetStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $targetStmt->bind_param('i', $userId);
                if (!$targetStmt->execute()) json_response(['error' => 'execute_failed', 'message' => $targetStmt->error], 500);
                $targetUser = $targetStmt->get_result()->fetch_assoc();
                $targetStmt->close();

                if (!$targetUser) {
                    json_response(['error' => 'not_found', 'message' => 'User not found'], 404);
                }
                if (!app_user_status_is_active($targetUser['status'] ?? null)) {
                    json_response(['error' => 'inactive_user', 'message' => 'Password reset is unavailable for inactive or archived users. Activate the account first.'], 409);
                }
                if ((int)($targetUser['role_id'] ?? 0) === 1) {
                    json_response(['error' => 'forbidden', 'message' => 'Admin accounts cannot be reset from this emergency tool.'], 403);
                }
                if ($isDepartmentAdminRole) {
                    $targetDeptId = isset($targetUser['dept_id']) && $targetUser['dept_id'] !== null ? (int)$targetUser['dept_id'] : null;
                    if ($authUserDeptId === null) {
                        json_response(['error' => 'forbidden', 'message' => 'Department Admin is not assigned to a department.'], 403);
                    }
                    if ($targetDeptId === null || (int)$targetDeptId !== (int)$authUserDeptId) {
                        json_response(['error' => 'forbidden', 'message' => 'Department Admin can reset only non-Admin users in their own department.'], 403);
                    }
                }

                $defaultPassword = trim((string)($targetUser['id_number'] ?? ''));
                if ($defaultPassword === '') {
                    json_response(['error'=>'validation','message'=>'This user has no School ID to use as the temporary password.'], 400);
                }

                $email = trim((string)($targetUser['email'] ?? ''));
                if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
                    json_response(['error'=>'validation','message'=>'This account has no valid email address.'], 400);
                }
                $lastSent = !empty($targetUser['temporary_password_sent_at']) ? strtotime($targetUser['temporary_password_sent_at']) : 0;
                if ($lastSent && time() - $lastSent < 60) {
                    json_response(['error'=>'rate_limited','message'=>'Please wait before sending another password-reset email.','retry_after'=>60-(time()-$lastSent)], 429);
                }
                if (!send_school_id_password_reset_email($email, $targetUser['first_name'] ?? '', $targetUser['last_name'] ?? '')) {
                    log_system_action($mysqli, $authUserId, 'password_reset_email_failed', "School ID password-reset email failed for user ID {$userId}; password was not changed.");
                    json_response(['error'=>'mail_delivery_failed','message'=>'Email could not be submitted. The existing password remains unchanged.'], 502);
                }

                if (!security_password_remember_hash($mysqli, $userId, $targetUser['password_hash'] ?? '')) {
                    json_response(['error'=>'password_history_failed','message'=>'The existing password could not be preserved safely, so the reset was not applied.'], 500);
                }
                $passwordHash = password_hash($defaultPassword, PASSWORD_BCRYPT);
                $resetStmt = $mysqli->prepare("UPDATE tbl_users SET password_hash = ?, is_first_login = 1, password_changed_at = NOW(), temporary_password_expires_at = NULL, temporary_password_sent_at = NOW(), token_version = token_version + 1 WHERE user_id = ?");
                if (!$resetStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $resetStmt->bind_param('si', $passwordHash, $userId);
                if (!$resetStmt->execute()) json_response(['error' => 'update_failed', 'message' => $resetStmt->error], 500);
                $resetStmt->close();

                $revokeStmt = $mysqli->prepare("UPDATE tbl_user_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL");
                if ($revokeStmt) {
                    $revokeStmt->bind_param('i', $userId);
                    $revokeStmt->execute();
                    $revokeStmt->close();
                }

                $targetName = trim((string)($targetUser['first_name'] ?? '') . ' ' . (string)($targetUser['last_name'] ?? ''));
                if ($targetName === '') $targetName = (string)($targetUser['email'] ?? ('User ID ' . $userId));
                log_system_action($mysqli, $authUserId, 'reset_user_password_default', "Emailed reset instructions and reset the password to the School ID for '{$targetName}', required password change, and revoked existing sessions.");

                $notified = false;
                try {
                    // The dedicated reset-instructions email was already sent
                    // above. Add only the in-system record and Web Push here so
                    // one reset cannot generate a second generic email.
                    $notified = (bool)notif_insert_web_push(
                        $mysqli,
                        $userId,
                        'Password reset required',
                        'An administrator reset your temporary password to your School ID. You must change it after signing in.',
                        '',
                        $authUserId
                    );
                } catch (Throwable $_) {}

                try {
                    $payload = ['entity' => 'users', 'action' => 'password_reset_required', 'user_id' => $userId];
                    trigger_socket_update($payload);
                } catch (Throwable $_) {}

                json_response([
                    'ok' => true,
                    'user_id' => $userId,
                    'message' => 'Reset instructions were emailed. The password is now the School ID, existing sessions were revoked, and the user must change it after signing in.',
                    'is_first_login' => 1,
                    'notified' => $notified,
                    'email_masked' => preg_replace('/(^.).*(@.*$)/', '$1***$2', $email),
                ]);
            }

            // Normal update: validate and apply
            // Check user exists
            $existingSelectAssigned = $hasAssignedProgramHeadCol ? ", assigned_program_head_id" : "";
            $checkExisting = $mysqli->prepare("SELECT user_id, role_id, dept_id, status, is_first_login, password_hash{$existingSelectAssigned} FROM tbl_users WHERE user_id = ? LIMIT 1");
            if (!$checkExisting) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $checkExisting->bind_param("i", $userId);
            $checkExisting->execute();
            $existing = $checkExisting->get_result()->fetch_assoc();
            if (!$existing) json_response(['error' => 'not_found', 'message' => 'User not found'], 404);
            if (app_normalize_user_status($existing['status'] ?? null) === 'archive') {
                json_response([
                    'error' => 'archived_user',
                    'message' => 'Archived accounts cannot be edited. Restore the account to inactive first.'
                ], 409);
            }
            if ($isDepartmentAdminRole) {
                $existingRoleId = isset($existing['role_id']) ? (int)$existing['role_id'] : 0;
                $existingDeptId = isset($existing['dept_id']) && $existing['dept_id'] !== null ? (int)$existing['dept_id'] : null;
                $requestedRoleId = isset($input['role_id']) ? (int)$input['role_id'] : $existingRoleId;
                if ($authUserDeptId === null) {
                    json_response(['error' => 'forbidden', 'message' => 'Department admin is not assigned to a department.'], 403);
                }
                if (!in_array($existingRoleId, [2, 3, 4, 5], true) || !in_array($requestedRoleId, [2, 3, 4, 5], true)) {
                    json_response(['error' => 'forbidden', 'message' => 'Department admin can only manage Dean, Program Head, Secretary, and Teacher users.'], 403);
                }
                if ($existingDeptId === null || (int)$existingDeptId !== (int)$authUserDeptId) {
                    json_response(['error' => 'forbidden', 'message' => 'Department admin can only manage users inside the same department.'], 403);
                }
                $input['dept_id'] = (int)$authUserDeptId;
            }

            foreach (['first_name' => 'First name', 'last_name' => 'Last name'] as $nameField => $nameLabel) {
                if (!array_key_exists($nameField, $input)) continue;
                $input[$nameField] = $normalize_person_name($input[$nameField]);
                if ($input[$nameField] === '') {
                    json_response(['error' => 'validation', 'message' => "{$nameLabel} is required"], 400);
                }
                if (!$is_valid_person_name($input[$nameField])) {
                    json_response(['error' => 'validation', 'message' => "{$nameLabel} may contain letters, spaces, apostrophes, periods, and hyphens only"], 400);
                }
            }

            if (isset($input['email'])) {
                $input['email'] = $normalize_user_email($input['email']);
                if (!$is_valid_user_email($input['email'])) {
                    json_response(['error' => 'validation', 'message' => 'Email must follow xxxx.name.coc@phinmaed.com'], 400);
                }
                $dup = $mysqli->prepare("SELECT user_id FROM tbl_users WHERE email = ? AND user_id <> ? LIMIT 1");
                $dup->bind_param("si", $input['email'], $userId);
                $dup->execute();
                if ($dup->get_result()->fetch_assoc()) {
                    json_response(['error' => 'duplicate', 'message' => 'Email already exists'], 400);
                }
            }
            if (isset($input['id_number'])) {
                $input['id_number'] = $normalize_id_number($input['id_number']);
                if ($input['id_number'] === '') {
                    json_response(['error' => 'validation', 'message' => 'ID number is required'], 400);
                }
                if (!$is_valid_id_number($input['id_number'])) {
                json_response(['error' => 'validation', 'message' => 'ID number must match format ##-###-letter (e.g. 24-018-F)'], 400);
            }
            $dupId = $mysqli->prepare("SELECT user_id FROM tbl_users WHERE id_number = ? AND user_id <> ? LIMIT 1");
                if (!$dupId) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $dupId->bind_param("si", $input['id_number'], $userId);
                $dupId->execute();
                if ($dupId->get_result()->fetch_assoc()) {
                    json_response(['error' => 'duplicate', 'message' => 'ID number already exists'], 400);
                }
            }

            $targetRoleId = isset($input['role_id']) ? (int)$input['role_id'] : (int)($existing['role_id'] ?? 0);
            $targetDeptId = array_key_exists('dept_id', $input)
                ? (($input['dept_id'] === '' || $input['dept_id'] === null) ? null : (int)$input['dept_id'])
                : (isset($existing['dept_id']) && $existing['dept_id'] !== null ? (int)$existing['dept_id'] : null);
            if ($targetRoleId !== 1 && $targetDeptId === null) {
                json_response(['error' => 'validation', 'message' => 'Department is required for this role.'], 400);
            }
            if ($targetRoleId !== 1) {
                $departmentError = $validateDeanDepartmentOwner($targetDeptId, $userId);
                if ($departmentError !== null) json_response(['error' => 'validation', 'message' => $departmentError], 400);
            }

            $targetProgramId = null;
            if ($hasAssignedProgramHeadCol) {
                $targetProgramId = array_key_exists('assigned_program_head_id', $input)
                    ? (($input['assigned_program_head_id'] === '' || $input['assigned_program_head_id'] === null) ? null : (int)$input['assigned_program_head_id'])
                    : (isset($existing['assigned_program_head_id']) && $existing['assigned_program_head_id'] !== null ? (int)$existing['assigned_program_head_id'] : null);

                if (in_array($targetRoleId, [2, 3, 4, 5], true)) {
                    if ($targetProgramId === null) {
                        $programRequiredMessage = $targetRoleId === 3
                            ? 'Owned program is required for program heads.'
                            : 'Assigned program is required for this role.';
                        json_response(['error' => 'validation', 'message' => $programRequiredMessage], 400);
                    }

                    if ($targetRoleId === 3) {
                        $programOwnerError = $validateProgramHeadProgramOwner($targetProgramId, $targetDeptId, $userId);
                        if ($programOwnerError !== null) {
                            json_response(['error' => 'validation', 'message' => $programOwnerError], 400);
                        }
                    } else {
                        $assignedHeadError = $validateAssignedProgramHead($targetProgramId, $targetDeptId);
                        if ($assignedHeadError !== null) {
                            json_response(['error' => 'validation', 'message' => $assignedHeadError], 400);
                        }
                    }
                }
            } elseif (array_key_exists('assigned_program_head_id', $input) || in_array($targetRoleId, [2, 3, 4, 5], true)) {
                json_response(['error' => 'schema_mismatch', 'message' => 'Database is missing assigned_program_head_id. Run the latest SQL migration first.'], 500);
            }

            $existingDeptForLock = isset($existing['dept_id']) && $existing['dept_id'] !== null ? (int)$existing['dept_id'] : null;
            $existingProgramForLock = $hasAssignedProgramHeadCol && isset($existing['assigned_program_head_id']) && $existing['assigned_program_head_id'] !== null
                ? (int)$existing['assigned_program_head_id']
                : null;
            $departmentChanged = $targetDeptId !== $existingDeptForLock;
            $programChanged = $hasAssignedProgramHeadCol && $targetProgramId !== $existingProgramForLock;
            if ($departmentChanged || $programChanged) {
                $activeSchedule = $getActiveScheduleContext($userId);
                if ($activeSchedule !== null) {
                    $activeLabel = $activeSchedule['label'] ?? 'the current active semester';
                    json_response([
                        'error' => 'active_schedule_assignment_locked',
                        'message' => "Can't change department or program because this user already has an active schedule for {$activeLabel}.",
                        'has_active_schedule' => true,
                        'active_schedule_label' => $activeLabel,
                    ], 409);
                }
            }

            $existingRoleIdForSession = (int)($existing['role_id'] ?? 0);
            $existingDeptIdForSession = isset($existing['dept_id']) && $existing['dept_id'] !== null ? (int)$existing['dept_id'] : null;
            $existingProgramIdForSession = isset($existing['assigned_program_head_id']) && $existing['assigned_program_head_id'] !== null
                ? (int)$existing['assigned_program_head_id']
                : null;
            $securityAssignmentChanged = $targetRoleId !== $existingRoleIdForSession
                || $targetDeptId !== $existingDeptIdForSession
                || ($hasAssignedProgramHeadCol && $targetProgramId !== $existingProgramIdForSession)
                || !empty($input['password'])
                || (array_key_exists('is_first_login', $input)
                    && (int)$input['is_first_login'] !== (int)($existing['is_first_login'] ?? 0));

            // Build update dynamically - allow changing role_id, first_name, last_name, email, contact_no, id_number, dept_id, password_hash
            $fields = [];
            $types = '';
            $values = [];
            if (isset($input['role_id'])) { $fields[] = 'role_id = ?'; $types .= 'i'; $values[] = (int)$input['role_id']; }
            if (isset($input['first_name'])) { $fields[] = 'first_name = ?'; $types .= 's'; $values[] = $input['first_name']; }
            if (isset($input['last_name'])) { $fields[] = 'last_name = ?'; $types .= 's'; $values[] = $input['last_name']; }
            if (isset($input['email'])) { $fields[] = 'email = ?'; $types .= 's'; $values[] = $input['email']; }
            if (isset($input['contact_no'])) {
                // Check if contact number already exists for another user
                $dupContactStmt = $mysqli->prepare("SELECT user_id FROM tbl_users WHERE contact_no = ? AND user_id <> ? LIMIT 1");
                if ($dupContactStmt) {
                    $dupContactStmt->bind_param('si', $input['contact_no'], $userId);
                    $dupContactStmt->execute();
                    $dupContactResult = $dupContactStmt->get_result()->fetch_assoc();
                    $dupContactStmt->close();
                    if ($dupContactResult) {
                        json_response(['error' => 'contact_no_in_use', 'message' => 'Contact number already exists'], 409);
                    }
                }
                $fields[] = 'contact_no = ?'; $types .= 's'; $values[] = $input['contact_no'];
            }
            if (isset($input['id_number'])) { $fields[] = 'id_number = ?'; $types .= 's'; $values[] = $input['id_number']; }
            if (array_key_exists('dept_id', $input)) {
                if ($input['dept_id'] === '' || $input['dept_id'] === null) {
                    $fields[] = 'dept_id = NULL';
                } else {
                    $fields[] = 'dept_id = ?';
                    $types .= 'i';
                    $values[] = (int)$input['dept_id'];
                }
            }
            if ($hasAssignedProgramHeadCol) {
                $targetRoleId = isset($input['role_id']) ? (int)$input['role_id'] : (int)($existing['role_id'] ?? 0);
                if (!in_array($targetRoleId, [2, 3, 4, 5], true)) {
                    $fields[] = 'assigned_program_head_id = NULL';
                } elseif (array_key_exists('assigned_program_head_id', $input)) {
                    if ($input['assigned_program_head_id'] === '' || $input['assigned_program_head_id'] === null) {
                        $fields[] = 'assigned_program_head_id = NULL';
                    } else {
                        $fields[] = 'assigned_program_head_id = ?';
                        $types .= 'i';
                        $values[] = (int)$input['assigned_program_head_id'];
                    }
                }
            }
            if (isset($input['is_first_login'])) { $fields[] = 'is_first_login = ?'; $types .= 'i'; $values[] = (int)$input['is_first_login']; }
            if (!empty($input['password'])) {
                $passwordError=security_policy_validate_password($input['password'],security_policy_get($mysqli));
                if($passwordError)json_response(['error'=>'weak_password','message'=>$passwordError],400);
                if (security_password_was_used($mysqli, $userId, $input['password'], $existing['password_hash'] ?? null)) {
                    json_response(['error'=>'password_reused','message'=>'Choose a password this user has not used previously.'],400);
                }
                if (!security_password_remember_hash($mysqli, $userId, $existing['password_hash'] ?? '')) {
                    json_response(['error'=>'password_history_failed','message'=>'The existing password could not be preserved safely.'],500);
                }
                $fields[] = 'password_hash = ?';
                $types .= 's';
                $values[] = password_hash($input['password'], PASSWORD_BCRYPT);
                $fields[] = 'password_changed_at = NOW()';
            }

            if (empty($fields)) json_response(['message' => 'Nothing to update'], 200);

            $sql = "UPDATE tbl_users SET " . implode(', ', $fields) . " WHERE user_id = ?";
            $stmt = $mysqli->prepare($sql);
            if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            // bind params
            $types .= 'i';
            $values[] = $userId;
            $stmt->bind_param($types, ...$values);
            if (!$stmt->execute()) json_response(['error' => 'update_failed', 'message' => $stmt->error], 500);

            $finalRoleId = isset($input['role_id']) ? (int)$input['role_id'] : (int)($existing['role_id'] ?? 0);
            $finalDeptId = array_key_exists('dept_id', $input)
                ? (($input['dept_id'] === '' || $input['dept_id'] === null) ? null : (int)$input['dept_id'])
                : (isset($existing['dept_id']) && $existing['dept_id'] !== null ? (int)$existing['dept_id'] : null);
            $finalProgramId = null;
            if ($hasAssignedProgramHeadCol) {
                if (array_key_exists('assigned_program_head_id', $input)) {
                    $finalProgramId = ($input['assigned_program_head_id'] === '' || $input['assigned_program_head_id'] === null) ? null : (int)$input['assigned_program_head_id'];
                } elseif (isset($existing['assigned_program_head_id']) && $existing['assigned_program_head_id'] !== null) {
                    $finalProgramId = (int)$existing['assigned_program_head_id'];
                }
            }
            $syncUserOwnership($userId, $finalRoleId, $finalDeptId, $finalProgramId);
            if ($securityAssignmentChanged) app_revoke_user_sessions($mysqli, $userId);

            $dept_id = null;
            if (array_key_exists('dept_id', $input)) {
                $dept_id = ($input['dept_id'] === '' || $input['dept_id'] === null) ? null : (int)$input['dept_id'];
            } else {
                $dStmt = $mysqli->prepare("SELECT dept_id FROM tbl_users WHERE user_id = ? LIMIT 1");
                if ($dStmt) {
                    $dStmt->bind_param('i', $userId);
                    $dStmt->execute();
                    $dRow = $dStmt->get_result()->fetch_assoc();
                    if ($dRow && isset($dRow['dept_id'])) {
                        $dept_id = (int)$dRow['dept_id'];
                    }
                }
            }

            try {
                $payload = ['entity' => 'users', 'action' => 'update', 'user_id' => $userId];
                if ($dept_id) {
                    $payload['dept_id'] = $dept_id;
                }
                trigger_socket_update($payload);
            } catch (Throwable $_) {}

            // Log user update with friendly name
            $logName = null;
            if (!empty($input['first_name']) || !empty($input['last_name'])) {
                $logName = trim((string)($input['first_name'] ?? '') . ' ' . ($input['last_name'] ?? ''));
                if ($logName === '') $logName = null;
            }
            if (!$logName) {
                $qn = $mysqli->prepare("SELECT first_name, last_name, email FROM tbl_users WHERE user_id = ? LIMIT 1");
                if ($qn) { $qn->bind_param('i', $userId); $qn->execute(); $rn = $qn->get_result()->fetch_assoc(); if ($rn) { $logName = trim(($rn['first_name'] ?? '') . ' ' . ($rn['last_name'] ?? '')); if ($logName === '') $logName = $rn['email'] ?? null; } }
            }
            $logMsg = $logName ? "Updated user details for '{$logName}'" : "Updated user details for ID {$userId}";
            log_system_action($mysqli, $authUserId, 'update_user', $logMsg);
            json_response(['user_id' => $userId] + $input);

        } elseif ($request_method === 'POST') {
            if (!$isAdminRole && !$isDepartmentAdminRole) {
                json_response(['error' => 'forbidden', 'message' => 'View-only access. Only admin and department admin can create users.'], 403);
            }
            // Create new user - validate required fields
            if (empty($input['email']) || empty($input['first_name']) || empty($input['last_name']) || empty($input['id_number']) || !isset($input['role_id'])) {
                json_response(['error' => 'validation', 'message' => 'Missing required fields'], 400);
            }
            $input['first_name'] = $normalize_person_name($input['first_name']);
            $input['last_name'] = $normalize_person_name($input['last_name']);
            if (!$is_valid_person_name($input['first_name'])) {
                json_response(['error' => 'validation', 'message' => 'First name may contain letters, spaces, apostrophes, periods, and hyphens only'], 400);
            }
            if (!$is_valid_person_name($input['last_name'])) {
                json_response(['error' => 'validation', 'message' => 'Last name may contain letters, spaces, apostrophes, periods, and hyphens only'], 400);
            }
            $input['email'] = $normalize_user_email($input['email']);
            $input['id_number'] = $normalize_id_number($input['id_number']);
            if (!$is_valid_user_email($input['email'])) {
                json_response(['error' => 'validation', 'message' => 'Email must follow xxxx.name.coc@phinmaed.com'], 400);
            }
            if (!$is_valid_id_number($input['id_number'])) {
                json_response(['error' => 'validation', 'message' => 'ID number must match format ##-###-letter (e.g. 24-018-F)'], 400);
            }

            // Ensure email uniqueness
            $check = $mysqli->prepare("SELECT user_id FROM tbl_users WHERE email = ? LIMIT 1");
            if (!$check) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $check->bind_param("s", $input['email']);
            $check->execute();
            if ($check->get_result()->fetch_assoc()) {
                json_response(['error' => 'duplicate', 'message' => 'Email already exists'], 400);
            }
            $checkId = $mysqli->prepare("SELECT user_id FROM tbl_users WHERE id_number = ? LIMIT 1");
            if (!$checkId) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $checkId->bind_param("s", $input['id_number']);
            $checkId->execute();
            if ($checkId->get_result()->fetch_assoc()) {
                json_response(['error' => 'duplicate', 'message' => 'ID number already exists'], 400);
            }

            $passwordError=security_policy_validate_password($input['password']??'',security_policy_get($mysqli)); if($passwordError)json_response(['error'=>'weak_password','message'=>$passwordError],400);
            $password_hash = password_hash($input['password'] ?? '', PASSWORD_BCRYPT);
            // include optional id_number and dept_id when creating a user; set is_first_login default to 1 if not provided
            $roleVal = (int)$input['role_id'];
            if ($roleVal === 1) {
                json_response(['error' => 'validation', 'message' => 'Admin role is not allowed.'], 400);
            }
            $deptVal = isset($input['dept_id']) && $input['dept_id'] !== '' ? (int)$input['dept_id'] : null;
            if ($isDepartmentAdminRole) {
                if ($authUserDeptId === null) {
                    json_response(['error' => 'forbidden', 'message' => 'Department admin is not assigned to a department.'], 403);
                }
                if (!in_array($roleVal, [2, 3, 4, 5], true)) {
                    json_response(['error' => 'forbidden', 'message' => 'Department admin can only create Dean, Program Head, Secretary, and Teacher users.'], 403);
                }
                $deptVal = (int)$authUserDeptId;
                $input['dept_id'] = $deptVal;
            }
            if ($roleVal !== 1 && $deptVal === null) {
                json_response(['error' => 'validation', 'message' => 'Department is required for this role.'], 400);
            }
            if ($roleVal === 1) {
                $deptVal = null;
            }
            $hasAssignedProgramInput = array_key_exists('assigned_program_head_id', $input)
                && $input['assigned_program_head_id'] !== ''
                && $input['assigned_program_head_id'] !== null;
            if (in_array($roleVal, [2, 3, 4, 5], true) && !$hasAssignedProgramHeadCol) {
                json_response(['error' => 'schema_mismatch', 'message' => 'Database is missing assigned_program_head_id. Run the latest SQL migration first.'], 500);
            }
            // Check if contact number already exists
            if (!empty($input['contact_no'])) {
                $dupContactStmt = $mysqli->prepare("SELECT user_id FROM tbl_users WHERE contact_no = ? LIMIT 1");
                if ($dupContactStmt) {
                    $dupContactStmt->bind_param('s', $input['contact_no']);
                    $dupContactStmt->execute();
                    $dupContactResult = $dupContactStmt->get_result()->fetch_assoc();
                    $dupContactStmt->close();
                    if ($dupContactResult) {
                        json_response(['error' => 'contact_no_in_use', 'message' => 'Contact number already exists'], 409);
                    }
                }
            }

            $idNumberVal = $input['id_number'];
            $isFirst = isset($input['is_first_login']) ? (int)$input['is_first_login'] : 1;
            $contactNoVal = $input['contact_no'] ?? null;
            $assignedHeadVal = null;

            if ($roleVal !== 1) {
                $departmentError = $validateDeanDepartmentOwner($deptVal, null);
                if ($departmentError !== null) {
                    json_response(['error' => 'invalid_department', 'message' => $departmentError], 409);
                }
            }

            if ($hasAssignedProgramHeadCol && in_array($roleVal, [2, 3, 4, 5], true)) {
                if (!$hasAssignedProgramInput) {
                    $programRequiredMessage = $roleVal === 3
                        ? 'Owned program is required for program heads.'
                        : 'Assigned program is required for this role.';
                    json_response(['error' => 'validation', 'message' => $programRequiredMessage], 400);
                }
                $assignedHeadVal = (int)$input['assigned_program_head_id'];
                if ($roleVal === 3) {
                    $programOwnerError = $validateProgramHeadProgramOwner($assignedHeadVal, $deptVal, null);
                    if ($programOwnerError !== null) {
                        json_response(['error' => 'validation', 'message' => $programOwnerError], 400);
                    }
                } else {
                    $assignedHeadError = $validateAssignedProgramHead($assignedHeadVal, $deptVal);
                    if ($assignedHeadError !== null) {
                        json_response(['error' => 'validation', 'message' => $assignedHeadError], 400);
                    }
                }
            }

            if ($hasAssignedProgramHeadCol) {
                if ($assignedHeadVal !== null) {
                    $stmt = $mysqli->prepare("INSERT INTO tbl_users (role_id, dept_id, first_name, last_name, id_number, email, password_hash, contact_no, is_first_login, assigned_program_head_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
                    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                    $stmt->bind_param("iissssssii", $roleVal, $deptVal, $input['first_name'], $input['last_name'], $idNumberVal, $input['email'], $password_hash, $contactNoVal, $isFirst, $assignedHeadVal);
                } else {
                    $stmt = $mysqli->prepare("INSERT INTO tbl_users (role_id, dept_id, first_name, last_name, id_number, email, password_hash, contact_no, is_first_login, assigned_program_head_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)");
                    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                    $stmt->bind_param("iissssssi", $roleVal, $deptVal, $input['first_name'], $input['last_name'], $idNumberVal, $input['email'], $password_hash, $contactNoVal, $isFirst);
                }
            } else {
                $stmt = $mysqli->prepare("INSERT INTO tbl_users (role_id, dept_id, first_name, last_name, id_number, email, password_hash, contact_no, is_first_login) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
                if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $stmt->bind_param("iissssssi", $roleVal, $deptVal, $input['first_name'], $input['last_name'], $idNumberVal, $input['email'], $password_hash, $contactNoVal, $isFirst);
            }
            if (!$stmt->execute()) json_response(['error' => 'insert_failed', 'message' => $stmt->error], 500);
            $newId = $stmt->insert_id;
            $syncUserOwnership($newId, $roleVal, $deptVal, $assignedHeadVal);
            
            $dept_id = isset($input['dept_id']) ? (int)$input['dept_id'] : null;

            try {
                $payload = ['entity' => 'users', 'action' => 'create', 'user_id' => $newId];
                if ($dept_id) {
                    $payload['dept_id'] = $dept_id;
                }
                trigger_socket_update($payload);
            } catch (Throwable $_) {}

            // Log user creation
            $logName = trim((string)($input['first_name'] ?? '') . ' ' . ($input['last_name'] ?? ''));
            $logName = $logName === '' ? ($input['email'] ?? null) : $logName;
            $logMsg = $logName ? "Created new user: {$logName}" : "Created new user ID {$newId}";
            log_system_action($mysqli, $authUserId, 'create_user', $logMsg);
            $emailResult = $sendAccountCreatedEmail(
                $input['first_name'] ?? '',
                $input['last_name'] ?? '',
                $input['email'] ?? '',
                $idNumberVal
            );
            $responsePayload = ['user_id' => $newId] + $input;
            $responsePayload['email_notification'] = [
                'sent' => !empty($emailResult['sent'])
            ];
            if (empty($emailResult['sent']) && !empty($emailResult['error'])) {
                $responsePayload['email_notification']['error'] = $emailResult['error'];
            }
            json_response($responsePayload, 201);

        }
        break;

    case 'roles':
        if ($request_method === 'GET') {
            $result = $mysqli->query("SELECT role_id, role_name FROM tbl_roles ORDER BY role_id");
            $roles = $result->fetch_all(MYSQLI_ASSOC);
            // Format role names to proper nouns for display
            $roles = array_map(function($role) {
                return [
                    'role_id' => $role['role_id'],
                    'role_name' => app_format_role_name($role['role_name'])
                ];
            }, $roles);
            json_response($roles);
        } elseif ($request_method === 'POST') {
            // Only admin can create roles
            if ((int)$authRoleId !== 1) {
                json_response(['error' => 'forbidden', 'message' => 'Only admin can create roles'], 403);
            }

            $role_name = trim($input['role_name'] ?? '');

            if (!$role_name) {
                json_response(['error' => 'validation_error', 'message' => 'Role name is required'], 400);
            }

            // Check if role already exists (case-insensitive)
            $checkStmt = $mysqli->prepare("SELECT role_id FROM tbl_roles WHERE LOWER(role_name) = LOWER(?)");
            if (!$checkStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $checkStmt->bind_param("s", $role_name);
            $checkStmt->execute();
            $existingRole = $checkStmt->get_result()->fetch_assoc();
            if ($existingRole) {
                json_response(['error' => 'duplicate_error', 'message' => 'Role name already exists'], 409);
            }

            // Get the next role_id (max + 1)
            $maxResult = $mysqli->query("SELECT MAX(role_id) as max_id FROM tbl_roles");
            $maxRow = $maxResult->fetch_assoc();
            $nextRoleId = ($maxRow['max_id'] ?? 0) + 1;

            // Insert the new role
            $insertStmt = $mysqli->prepare("INSERT INTO tbl_roles (role_id, role_name) VALUES (?, ?)");
            if (!$insertStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $insertStmt->bind_param("is", $nextRoleId, $role_name);

            if (!$insertStmt->execute()) {
                json_response(['error' => 'insert_failed', 'message' => $mysqli->error], 500);
            }

            json_response(['role_id' => $nextRoleId, 'role_name' => $role_name], 201);
        }
        break;
    
    case 'teachers':
         if ($request_method === 'GET') {
            if (!$authUserId) {
                json_response(['error' => 'unauthorized', 'message' => 'Authentication required'], 401);
            }

            $isAdminRole = ((int)$authRoleId === 1);
            if ($isAdminRole) {
                $result = $mysqli->query("SELECT user_id, first_name, last_name, dept_id FROM tbl_users WHERE role_id = 5 AND status = 'active' ORDER BY last_name, first_name");
                if (!$result) json_response(['error' => 'query_failed', 'message' => $mysqli->error], 500);
                json_response($result->fetch_all(MYSQLI_ASSOC));
            }

            if ((int)$authRoleId === 3) {
                $phScopeStmt = $mysqli->prepare("SELECT assigned_program_head_id AS program_id, dept_id FROM tbl_users WHERE user_id = ? AND role_id = 3 LIMIT 1");
                if (!$phScopeStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $phScopeStmt->bind_param("i", $authUserId);
                $phScopeStmt->execute();
                $phScopeRow = $phScopeStmt->get_result()->fetch_assoc();
                $programHeadProgramId = ($phScopeRow && isset($phScopeRow['program_id']) && $phScopeRow['program_id'] !== null) ? (int)$phScopeRow['program_id'] : null;
                $programHeadDeptId = ($phScopeRow && isset($phScopeRow['dept_id']) && $phScopeRow['dept_id'] !== null) ? (int)$phScopeRow['dept_id'] : null;
                if ($programHeadDeptId === null || $programHeadProgramId === null) {
                    json_response([]);
                }

                $assignedHeadColCheck = $mysqli->query("SHOW COLUMNS FROM tbl_users LIKE 'assigned_program_head_id'");
                $hasAssignedProgramHeadCol = $assignedHeadColCheck && $assignedHeadColCheck->num_rows > 0;
                if ($hasAssignedProgramHeadCol) {
                    $stmt = $mysqli->prepare("SELECT user_id, first_name, last_name, dept_id FROM tbl_users WHERE role_id = 5 AND status = 'active' AND dept_id = ? AND assigned_program_head_id = ? ORDER BY last_name, first_name");
                    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                    $stmt->bind_param("ii", $programHeadDeptId, $programHeadProgramId);
                    $stmt->execute();
                    $res = $stmt->get_result();
                    json_response($res ? $res->fetch_all(MYSQLI_ASSOC) : []);
                }

                // Backward-compatible fallback for schemas without assigned_program_head_id.
                $stmt = $mysqli->prepare("SELECT DISTINCT u.user_id, u.first_name, u.last_name, u.dept_id
                                          FROM tbl_users u
                                          JOIN tbl_class_schedules cs ON cs.user_id = u.user_id
                                          LEFT JOIN tbl_subject s ON cs.subject_id = s.subject_id
                                          LEFT JOIN tbl_sections sec ON cs.section_id = sec.section_id
                                          LEFT JOIN tbl_programs ps ON s.program_id = ps.program_id
                                          LEFT JOIN tbl_programs psec ON sec.program_id = psec.program_id
                                          WHERE u.role_id = 5
                                            AND u.status = 'active'
                                            AND u.dept_id = ?
                                            AND (ps.head_id = ? OR psec.head_id = ?)
                                          ORDER BY u.last_name, u.first_name");
                if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $stmt->bind_param("iii", $programHeadDeptId, $authUserId, $authUserId);
                $stmt->execute();
                $res = $stmt->get_result();
                json_response($res ? $res->fetch_all(MYSQLI_ASSOC) : []);
            }

            if (in_array((int)$authRoleId, [2, 4, 6], true)) {
                if ($authUserDeptId === null) {
                    json_response([]);
                }
                $stmt = $mysqli->prepare("SELECT user_id, first_name, last_name, dept_id FROM tbl_users WHERE role_id = 5 AND status = 'active' AND dept_id = ? ORDER BY last_name, first_name");
                if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $stmt->bind_param("i", $authUserDeptId);
                $stmt->execute();
                $res = $stmt->get_result();
                json_response($res ? $res->fetch_all(MYSQLI_ASSOC) : []);
            }

            json_response([]);
        }
        break;

    case 'deans':
         if ($request_method === 'GET') {
             $result = $mysqli->query("SELECT u.user_id, u.first_name, u.last_name, u.dept_id, d.dept_name
                 FROM tbl_users u
                 LEFT JOIN tbl_departments d ON d.dept_id = u.dept_id
                 WHERE u.role_id = 2
                   AND LOWER(TRIM(COALESCE(u.status, 'active'))) IN ('active', '1', 'true')
                 ORDER BY u.last_name, u.first_name");
             json_response($result->fetch_all(MYSQLI_ASSOC));
         }
         break;

    case 'class-schedules':
        $normalize_time_simple = function($value) {
            if ($value === null) return null;
            $value = trim((string)$value);
            if ($value === '') return null;
            if (preg_match('/^\d{1,2}:\d{2}:\d{2}$/', $value)) return $value;
            if (preg_match('/^\d{1,2}:\d{2}$/', $value)) return $value . ':00';
            $ts = strtotime($value);
            if ($ts === false) return $value;
            return date('H:i:s', $ts);
        };

        // Helper: detect if a column exists in a table
        $column_exists = function($table, $col) use ($mysqli) {
            $tbl = $mysqli->real_escape_string($table);
            $c = $mysqli->real_escape_string($col);
            $res = $mysqli->query("SHOW COLUMNS FROM `{$tbl}` LIKE '{$c}'");
            return $res && $res->num_rows > 0;
        };

        // Determine if the legacy offerings table/column exists
        $offerings_table_check = $mysqli->query("SHOW TABLES LIKE 'tbl_subject_offerings'");
        $has_subject_offerings = $offerings_table_check && $offerings_table_check->num_rows > 0;
        $cs_has_offering_col = $column_exists('tbl_class_schedules', 'offering_id');
        $cs_has_subject_cols = $column_exists('tbl_class_schedules', 'subject_id') && $column_exists('tbl_class_schedules', 'section_id');
        $resolve_active_semester_id = function() use ($mysqli) {
            $res = $mysqli->query("SELECT semester_id FROM tbl_semesters WHERE LOWER(TRIM(status)) = 'active' AND CURDATE() BETWEEN start_date AND end_date ORDER BY semester_id DESC LIMIT 1");
            if ($res) {
                $row = $res->fetch_assoc();
                if ($row && isset($row['semester_id'])) return (int)$row['semester_id'];
            }
            return null;
        };
        $activeSemesterId = $resolve_active_semester_id();

        // Scheduling may target the semester active today or a future semester
        // that is still in planning. Past and archived semesters stay read-only.
        // Attendance generation below remains tied to $activeSemesterId only.
        $schedule_status_is_active = function($value) {
            return in_array(strtolower(trim((string)$value)), ['active', '1', 'true'], true);
        };
        $assert_schedule_semester_available = function($semesterId) use ($mysqli, $schedule_status_is_active) {
            $semesterStmt = $mysqli->prepare("SELECT sem.semester_id, sem.status AS semester_status, sem.start_date, sem.end_date, sy.school_year_id, sy.status AS school_year_status FROM tbl_semesters sem LEFT JOIN tbl_school_year sy ON sy.school_year_id = sem.school_year_id WHERE sem.semester_id = ? LIMIT 1");
            if (!$semesterStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $semesterStmt->bind_param('i', $semesterId);
            $semesterStmt->execute();
            $semester = $semesterStmt->get_result()->fetch_assoc();
            $semesterStmt->close();
            if (!$semester) {
                json_response(['error' => 'semester_not_plannable', 'message' => 'The selected semester does not exist.'], 409);
            }

            $semesterStatus = strtolower(trim((string)($semester['semester_status'] ?? '')));
            $schoolYearStatus = strtolower(trim((string)($semester['school_year_status'] ?? '')));
            $archivedStatuses = ['archive', 'archived'];
            $startDate = trim((string)($semester['start_date'] ?? ''));
            $endDate = trim((string)($semester['end_date'] ?? ''));
            $today = date('Y-m-d');
            if (empty($semester['school_year_id']) || $startDate === '' || $endDate === '') {
                json_response(['error' => 'semester_not_plannable', 'message' => 'The selected semester has an incomplete school-year or date configuration.'], 409);
            }
            if (in_array($semesterStatus, $archivedStatuses, true) || in_array($schoolYearStatus, $archivedStatuses, true)) {
                json_response(['error' => 'semester_not_plannable', 'message' => 'Archived semesters are read-only and cannot receive class schedules.'], 409);
            }
            if ($today > $endDate) {
                json_response(['error' => 'semester_not_plannable', 'message' => 'Past semesters are read-only. Select the current or an upcoming semester.'], 409);
            }
            if ($today >= $startDate && $today <= $endDate
                && (!$schedule_status_is_active($semesterStatus) || !$schedule_status_is_active($schoolYearStatus))) {
                json_response(['error' => 'semester_not_plannable', 'message' => 'The current semester and school year must be active before schedules can be changed.'], 409);
            }
            return $semester;
        };
        $assert_active_schedule_dependencies = function($semesterId, $roomId, $subjectId, $sectionId, $teacherId) use ($mysqli, $schedule_status_is_active, $assert_schedule_semester_available) {
            $assert_schedule_semester_available($semesterId);
            $inactive = [];

            $teacherStmt = $mysqli->prepare("SELECT user_id, status FROM tbl_users WHERE user_id = ? LIMIT 1");
            if (!$teacherStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $teacherStmt->bind_param('i', $teacherId);
            $teacherStmt->execute();
            $teacher = $teacherStmt->get_result()->fetch_assoc();
            $teacherStmt->close();
            if (!$teacher) {
                $inactive[] = 'teacher (not found)';
            } elseif (!$schedule_status_is_active($teacher['status'] ?? null)) {
                $inactive[] = 'teacher';
            }

            $roomStmt = $mysqli->prepare("SELECT r.room_id, r.status AS room_status, f.floor_id, f.status AS floor_status, b.building_id, b.status AS building_status, b.school_id, sc.status AS school_status FROM tbl_rooms r LEFT JOIN tbl_floors f ON f.floor_id = r.floor_id LEFT JOIN tbl_buildings b ON b.building_id = COALESCE(r.building_id, f.building_id) LEFT JOIN tbl_school sc ON sc.school_id = b.school_id WHERE r.room_id = ? LIMIT 1");
            if (!$roomStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $roomStmt->bind_param('i', $roomId);
            $roomStmt->execute();
            $room = $roomStmt->get_result()->fetch_assoc();
            $roomStmt->close();
            if (!$room) {
                $inactive[] = 'room (not found)';
            } else {
                if (!$schedule_status_is_active($room['room_status'] ?? null)) $inactive[] = 'room';
                if (empty($room['floor_id']) || !$schedule_status_is_active($room['floor_status'] ?? null)) $inactive[] = 'floor';
                if (empty($room['building_id']) || !$schedule_status_is_active($room['building_status'] ?? null)) $inactive[] = 'building';
                if (!empty($room['school_id']) && !$schedule_status_is_active($room['school_status'] ?? null)) $inactive[] = 'campus';
            }

            $subjectStmt = $mysqli->prepare("SELECT s.subject_id, s.status AS subject_status, p.program_id, p.status AS program_status, d.dept_id, d.status AS department_status FROM tbl_subject s LEFT JOIN tbl_programs p ON p.program_id = s.program_id LEFT JOIN tbl_departments d ON d.dept_id = p.dept_id WHERE s.subject_id = ? LIMIT 1");
            if (!$subjectStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $subjectStmt->bind_param('i', $subjectId);
            $subjectStmt->execute();
            $subject = $subjectStmt->get_result()->fetch_assoc();
            $subjectStmt->close();
            if (!$subject) {
                $inactive[] = 'subject (not found)';
            } else {
                if (!$schedule_status_is_active($subject['subject_status'] ?? null)) $inactive[] = 'subject';
                if (empty($subject['program_id']) || !$schedule_status_is_active($subject['program_status'] ?? null)) $inactive[] = 'subject program';
                if (empty($subject['dept_id']) || !$schedule_status_is_active($subject['department_status'] ?? null)) $inactive[] = 'subject department';
            }

            $sectionStmt = $mysqli->prepare("SELECT sec.section_id, sec.status AS section_status, p.program_id, p.status AS program_status, d.dept_id, d.status AS department_status FROM tbl_sections sec LEFT JOIN tbl_programs p ON p.program_id = sec.program_id LEFT JOIN tbl_departments d ON d.dept_id = p.dept_id WHERE sec.section_id = ? LIMIT 1");
            if (!$sectionStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $sectionStmt->bind_param('i', $sectionId);
            $sectionStmt->execute();
            $section = $sectionStmt->get_result()->fetch_assoc();
            $sectionStmt->close();
            if (!$section) {
                $inactive[] = 'section (not found)';
            } else {
                if (!$schedule_status_is_active($section['section_status'] ?? null)) $inactive[] = 'section';
                if (empty($section['program_id']) || !$schedule_status_is_active($section['program_status'] ?? null)) $inactive[] = 'section program';
                if (empty($section['dept_id']) || !$schedule_status_is_active($section['department_status'] ?? null)) $inactive[] = 'section department';
            }

            $inactive = array_values(array_unique($inactive));
            if ($inactive) {
                json_response([
                    'error' => 'inactive_schedule_dependency',
                    'message' => 'Schedule cannot be saved because these linked records are inactive, archived, or unavailable: ' . implode(', ', $inactive) . '.',
                    'inactive_dependencies' => $inactive,
                ], 409);
            }
        };

        $isAdminRole = ((int)$authRoleId === 1);
        $isDeanRole = in_array((int)$authRoleId, [2, 6], true);
        $isProgramHeadRole = ((int)$authRoleId === 3);
        $isSecretaryRole = ((int)$authRoleId === 4);
        $canManageClassSchedules = in_array((int)$authRoleId, [1, 3, 6], true);
        $canEditClassSchedules = in_array((int)$authRoleId, [1, 2, 3, 6], true);
        $programHeadProgramIds = [];
        if ($isProgramHeadRole && $authUserId) {
            $phStmt = $mysqli->prepare("SELECT assigned_program_head_id AS program_id
                FROM tbl_users
                WHERE user_id = ? AND role_id = 3 AND assigned_program_head_id IS NOT NULL
                LIMIT 1");
            if ($phStmt) {
                $phStmt->bind_param('i', $authUserId);
                $phStmt->execute();
                $phRes = $phStmt->get_result();
                if ($phRow = $phRes->fetch_assoc()) {
                    if (isset($phRow['program_id']) && $phRow['program_id'] !== null) $programHeadProgramIds[] = (int)$phRow['program_id'];
                }
            }
            $programHeadProgramIds = array_values(array_unique($programHeadProgramIds));
        }

        $require_program_head_scope = function() use ($isProgramHeadRole, $programHeadProgramIds) {
            if (!$isProgramHeadRole) return;
            if (!$programHeadProgramIds || count($programHeadProgramIds) === 0) {
                json_response(['error' => 'forbidden', 'message' => 'Program head has no assigned program.'], 403);
            }
        };

        $require_schedule_manage_access = function() use ($canManageClassSchedules) {
            if ($canManageClassSchedules) return;
            json_response(['error' => 'forbidden', 'message' => 'Only admin, department admin, and program head can manage class schedules.'], 403);
        };

        $require_schedule_edit_access = function() use ($canEditClassSchedules) {
            if ($canEditClassSchedules) return;
            json_response(['error' => 'forbidden', 'message' => 'Only admin, dean, department admin, and program head can directly edit class schedules.'], 403);
        };

        $assert_schedule_day_allowed = function($dayOfWeek): void {
            $day = strtolower(trim((string)$dayOfWeek));
            $allowedDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
            if (!in_array($day, $allowedDays, true)) {
                json_response([
                    'error' => $day === 'sunday' ? 'sunday_schedule_not_allowed' : 'invalid_schedule_day',
                    'message' => $day === 'sunday'
                        ? 'Sunday class schedules are not allowed. Choose Monday through Saturday.'
                        : 'Invalid class schedule day. Choose Monday through Saturday.',
                ], 422);
            }
        };

        $require_dean_scope = function() use ($isDeanRole, $authUserDeptId) {
            if (!$isDeanRole) return;
            if ($authUserDeptId === null) {
                json_response(['error' => 'forbidden', 'message' => 'Your account is not assigned to a department.'], 403);
            }
        };

        // Serialize writes that target the same semester/day. Without this
        // lock, two admins can both pass conflict checks before either request
        // inserts its schedule. Named locks are connection-scoped, so MySQL
        // also releases them if a request terminates unexpectedly.
        $release_schedule_locks = function(array $lockNames) use ($mysqli) {
            foreach (array_reverse($lockNames) as $lockName) {
                $stmt = $mysqli->prepare("SELECT RELEASE_LOCK(?)");
                if ($stmt) {
                    $stmt->bind_param('s', $lockName);
                    $stmt->execute();
                    $stmt->close();
                }
            }
        };

        $acquire_schedule_locks = function(array $scopes) use ($mysqli, $release_schedule_locks) {
            $lockNames = [];
            foreach ($scopes as $scope) {
                $semesterId = (int)($scope['semester_id'] ?? 0);
                $day = strtolower(trim((string)($scope['day_of_week'] ?? '')));
                if ($semesterId > 0 && $day !== '') {
                    $lockNames[] = 'class_schedule:' . $semesterId . ':' . $day;
                }
            }
            $lockNames = array_values(array_unique($lockNames));
            sort($lockNames, SORT_STRING);

            $acquired = [];
            foreach ($lockNames as $lockName) {
                $stmt = $mysqli->prepare("SELECT GET_LOCK(?, 5) AS acquired");
                if (!$stmt) {
                    $release_schedule_locks($acquired);
                    json_response(['error' => 'schedule_lock_failed', 'message' => 'Unable to prepare the schedule safety lock.'], 500);
                }
                $stmt->bind_param('s', $lockName);
                if (!$stmt->execute()) {
                    $stmt->close();
                    $release_schedule_locks($acquired);
                    json_response(['error' => 'schedule_lock_failed', 'message' => 'Unable to acquire the schedule safety lock.'], 500);
                }
                $row = $stmt->get_result()->fetch_assoc();
                $stmt->close();
                if (!$row || (int)($row['acquired'] ?? 0) !== 1) {
                    $release_schedule_locks($acquired);
                    json_response(['error' => 'schedule_busy', 'message' => 'Another schedule is being saved for this day. Please try again.'], 409);
                }
                $acquired[] = $lockName;
            }
            return $acquired;
        };

        $get_program_id_for_subject = function($subjectId) use ($mysqli) {
            if (!$subjectId) return null;
            $stmt = $mysqli->prepare("SELECT program_id FROM tbl_subject WHERE subject_id = ? LIMIT 1");
            if (!$stmt) return null;
            $stmt->bind_param('i', $subjectId);
            $stmt->execute();
            $row = $stmt->get_result()->fetch_assoc();
            return ($row && isset($row['program_id'])) ? (int)$row['program_id'] : null;
        };

        $get_program_id_for_section = function($sectionId) use ($mysqli) {
            if (!$sectionId) return null;
            $stmt = $mysqli->prepare("SELECT program_id FROM tbl_sections WHERE section_id = ? LIMIT 1");
            if (!$stmt) return null;
            $stmt->bind_param('i', $sectionId);
            $stmt->execute();
            $row = $stmt->get_result()->fetch_assoc();
            return ($row && isset($row['program_id'])) ? (int)$row['program_id'] : null;
        };

        $get_dept_id_for_program = function($programId) use ($mysqli) {
            if (!$programId) return null;
            $stmt = $mysqli->prepare("SELECT dept_id FROM tbl_programs WHERE program_id = ? LIMIT 1");
            if (!$stmt) return null;
            $stmt->bind_param('i', $programId);
            $stmt->execute();
            $row = $stmt->get_result()->fetch_assoc();
            return ($row && isset($row['dept_id']) && $row['dept_id'] !== null) ? (int)$row['dept_id'] : null;
        };

        $usersHasAssignedProgramCol = $column_exists('tbl_users', 'assigned_program_head_id');
        $usersHasProgramIdCol = $column_exists('tbl_users', 'program_id');
        $usersHasDeptIdCol = $column_exists('tbl_users', 'dept_id');
        $get_user_role_id = function($userId) use ($mysqli) {
            if (!$userId) return null;
            $stmt = $mysqli->prepare("SELECT role_id FROM tbl_users WHERE user_id = ? LIMIT 1");
            if (!$stmt) return null;
            $stmt->bind_param('i', $userId);
            $stmt->execute();
            $row = $stmt->get_result()->fetch_assoc();
            if (!$row || !isset($row['role_id'])) return null;
            return (int)$row['role_id'];
        };
        $get_teacher_program_id = function($teacherId) use ($mysqli, $usersHasAssignedProgramCol, $usersHasProgramIdCol, $usersHasDeptIdCol) {
            if (!$teacherId) return null;

            $teachingRoles = [2, 3, 4, 5]; // dean, program_head, secretary, teacher

            $select = "SELECT role_id";
            if ($usersHasAssignedProgramCol) $select .= ", assigned_program_head_id";
            if ($usersHasProgramIdCol) $select .= ", program_id";
            if ($usersHasDeptIdCol) $select .= ", dept_id";
            $sql = $select . " FROM tbl_users WHERE user_id = ? LIMIT 1";
            $stmt = $mysqli->prepare($sql);
            if (!$stmt) return null;
            $stmt->bind_param('i', $teacherId);
            $stmt->execute();
            $row = $stmt->get_result()->fetch_assoc();
            if (!$row) return null;

            $roleId = isset($row['role_id']) ? (int)$row['role_id'] : 0;
            if (!in_array($roleId, $teachingRoles, true)) return null;

            // Direct assignment on user row (preferred)
            if ($usersHasAssignedProgramCol && isset($row['assigned_program_head_id']) && $row['assigned_program_head_id'] !== null && (string)$row['assigned_program_head_id'] !== '') {
                return (int)$row['assigned_program_head_id'];
            }
            if ($usersHasProgramIdCol && isset($row['program_id']) && $row['program_id'] !== null && (string)$row['program_id'] !== '') {
                return (int)$row['program_id'];
            }

            // Program head fallback: program where this user is the head.
            if ($roleId === 3) {
                $phProgram = $mysqli->prepare("SELECT program_id FROM tbl_programs WHERE head_id = ? ORDER BY program_id ASC LIMIT 1");
                if ($phProgram) {
                    $phProgram->bind_param('i', $teacherId);
                    $phProgram->execute();
                    $phRow = $phProgram->get_result()->fetch_assoc();
                    if ($phRow && isset($phRow['program_id']) && $phRow['program_id'] !== null) {
                        return (int)$phRow['program_id'];
                    }
                }
            }

            // Dean/Secretary fallback: if department maps to exactly one active program, use it.
            if ($usersHasDeptIdCol && isset($row['dept_id']) && $row['dept_id'] !== null && (string)$row['dept_id'] !== '') {
                $deptId = (int)$row['dept_id'];
                if ($deptId > 0) {
                    $deptPrograms = $mysqli->prepare("
                        SELECT program_id
                        FROM tbl_programs
                        WHERE dept_id = ?
                          AND LOWER(TRIM(COALESCE(status, 'active'))) IN ('active', '1', 'true')
                        ORDER BY program_id ASC
                        LIMIT 2
                    ");
                    if ($deptPrograms) {
                        $deptPrograms->bind_param('i', $deptId);
                        $deptPrograms->execute();
                        $res = $deptPrograms->get_result();
                        $rows = $res ? $res->fetch_all(MYSQLI_ASSOC) : [];
                        if (count($rows) === 1 && isset($rows[0]['program_id'])) {
                            return (int)$rows[0]['program_id'];
                        }
                    }
                }
            }

            return null;
        };

        $parallelSubjectTimeMessage = 'This subject already has an overlapping schedule on the selected day. Parallel classes for the same subject must use the exact same start and end time.';

        $enforce_program_scope_for_subject_section = function($subjectId, $sectionId) use (
            $isProgramHeadRole,
            $programHeadProgramIds,
            $require_program_head_scope,
            $get_program_id_for_subject,
            $get_program_id_for_section
        ) {
            if (!$isProgramHeadRole) return;
            $require_program_head_scope();

            $programId = null;
            if ($subjectId) $programId = $get_program_id_for_subject($subjectId);
            if (!$programId && $sectionId) $programId = $get_program_id_for_section($sectionId);

            if (!$programId || !in_array((int)$programId, $programHeadProgramIds, true)) {
                json_response(['error' => 'forbidden', 'message' => 'Program head can only manage schedules within their assigned program.'], 403);
            }
        };

        $enforce_dean_scope_for_subject_section = function($subjectId, $sectionId) use (
            $isDeanRole,
            $authUserDeptId,
            $require_dean_scope,
            $get_program_id_for_subject,
            $get_program_id_for_section,
            $get_dept_id_for_program
        ) {
            if (!$isDeanRole) return;
            $require_dean_scope();

            $programId = null;
            if ($subjectId) $programId = $get_program_id_for_subject($subjectId);
            if (!$programId && $sectionId) $programId = $get_program_id_for_section($sectionId);
            $deptId = $programId ? $get_dept_id_for_program($programId) : null;

            if ($deptId === null || (int)$deptId !== (int)$authUserDeptId) {
                json_response(['error' => 'forbidden', 'message' => 'You can only manage schedules within your assigned department.'], 403);
            }
        };

        $get_program_id_for_schedule = function($scheduleId) use ($mysqli, $has_subject_offerings, $cs_has_offering_col) {
            if (!$scheduleId) return null;
            if ($has_subject_offerings && $cs_has_offering_col) {
                $stmt = $mysqli->prepare("SELECT COALESCE(s_so.program_id, s_cs.program_id) AS program_id
                    FROM tbl_class_schedules cs
                    LEFT JOIN tbl_subject_offerings so ON (cs.offering_id IS NOT NULL AND so.offering_id = cs.offering_id)
                    LEFT JOIN tbl_subject s_so ON (so.offering_id IS NOT NULL AND so.subject_id = s_so.subject_id)
                    LEFT JOIN tbl_subject s_cs ON (cs.subject_id IS NOT NULL AND cs.subject_id = s_cs.subject_id)
                    WHERE cs.schedule_id = ? LIMIT 1");
            } else {
                $stmt = $mysqli->prepare("SELECT s.program_id AS program_id
                    FROM tbl_class_schedules cs
                    LEFT JOIN tbl_subject s ON (cs.subject_id IS NOT NULL AND cs.subject_id = s.subject_id)
                    WHERE cs.schedule_id = ? LIMIT 1");
            }
            if (!$stmt) return null;
            $stmt->bind_param('i', $scheduleId);
            $stmt->execute();
            $row = $stmt->get_result()->fetch_assoc();
            return ($row && isset($row['program_id'])) ? (int)$row['program_id'] : null;
        };

        $get_dept_id_for_schedule = function($scheduleId) use ($get_program_id_for_schedule, $get_dept_id_for_program) {
            $programId = $get_program_id_for_schedule($scheduleId);
            return $programId ? $get_dept_id_for_program($programId) : null;
        };

        $delete_schedule = function($scheduleId) use ($mysqli, $authUserId, $isDeanRole, $authUserDeptId, $require_dean_scope, $get_dept_id_for_schedule, $isProgramHeadRole, $programHeadProgramIds, $require_program_head_scope, $get_program_id_for_schedule) {
            $checkExisting = $mysqli->prepare("SELECT schedule_id FROM tbl_class_schedules WHERE schedule_id = ? LIMIT 1");
            if (!$checkExisting) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $checkExisting->bind_param("i", $scheduleId);
            $checkExisting->execute();
            $existingRow = $checkExisting->get_result()->fetch_assoc();
            if (!$existingRow) {
                json_response(['error' => 'schedule_not_found', 'message' => 'Schedule not found.'], 404);
            }
            $expectedStateHash = trim((string)($input['expected_state_hash'] ?? ''));
            if ($expectedStateHash !== '' && !hash_equals($expectedStateHash, schedule_edit_state_hash($existingRow))) {
                json_response([
                    'error' => 'schedule_changed_while_editing',
                    'message' => 'This class schedule changed while your edit form was open. Close and reopen the schedule before saving so newer changes are not overwritten.',
                ], 409);
            }

            if ($isProgramHeadRole) {
                $require_program_head_scope();
                $scheduleProgramId = $get_program_id_for_schedule($scheduleId);
                if (!$scheduleProgramId || !in_array((int)$scheduleProgramId, $programHeadProgramIds, true)) {
                    json_response(['error' => 'forbidden', 'message' => 'Program head can only delete schedules within their assigned program.'], 403);
                }
            }
            if ($isDeanRole) {
                $require_dean_scope();
                $scheduleDeptId = $get_dept_id_for_schedule($scheduleId);
                if ($scheduleDeptId === null || (int)$scheduleDeptId !== (int)$authUserDeptId) {
                    json_response(['error' => 'forbidden', 'message' => 'You can only delete schedules within your assigned department.'], 403);
                }
            }

            // Fetch details for logging before delete (use merged fields)
            $details = null;
            $qd = $mysqli->prepare("SELECT cs.day_of_week, cs.start_time, cs.end_time, r.room_name, s.subject_code, s.subject_name, sec.section_name, CONCAT(u.first_name,' ',u.last_name) AS teacher_name FROM tbl_class_schedules cs JOIN tbl_rooms r ON cs.room_id = r.room_id LEFT JOIN tbl_subject s ON cs.subject_id = s.subject_id LEFT JOIN tbl_sections sec ON cs.section_id = sec.section_id LEFT JOIN tbl_users u ON cs.user_id = u.user_id WHERE cs.schedule_id = ? LIMIT 1");
            if ($qd) { $qd->bind_param('i', $scheduleId); $qd->execute(); $details = $qd->get_result()->fetch_assoc(); }

            $attCheck = $mysqli->prepare("SELECT attendance_id FROM tbl_attendance_records WHERE schedule_id = ? LIMIT 1");
            if ($attCheck) {
                $attCheck->bind_param("i", $scheduleId);
                $attCheck->execute();
                if ($attCheck->get_result()->fetch_assoc()) {
                    json_response(['error' => 'schedule_in_use', 'message' => 'Schedule has attendance records. Delete attendance records first.'], 409);
                }
            }

            $subCheck = $mysqli->prepare("SELECT substitution_id FROM tbl_substitutions WHERE schedule_id = ? LIMIT 1");
            if ($subCheck) {
                $subCheck->bind_param("i", $scheduleId);
                $subCheck->execute();
                if ($subCheck->get_result()->fetch_assoc()) {
                    json_response(['error' => 'schedule_in_use', 'message' => 'Schedule has substitutions. Delete substitutions first.'], 409);
                }
            }

            $stmt = $mysqli->prepare("DELETE FROM tbl_class_schedules WHERE schedule_id = ?");
            if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $stmt->bind_param("i", $scheduleId);
            if (!$stmt->execute()) {
                json_response(['error' => 'delete_failed', 'message' => $stmt->error], 500);
            }
            if ($stmt->affected_rows === 0) {
                json_response(['error' => 'schedule_not_found', 'message' => 'Schedule not found.'], 404);
            }

            // Log deletion
            $logMsg = 'Deleted schedule ID ' . $scheduleId;
            if ($details) {
                $subj = $details['subject_code'] ?? ($details['subject_name'] ?? '');
                $room = $details['room_name'] ?? '';
                $day = $details['day_of_week'] ?? '';
                $start = $details['start_time'] ?? '';
                $end = $details['end_time'] ?? '';
                $logMsg = "Deleted schedule for '{$subj}' in room '{$room}' on {$day} {$start}-{$end}";
            }
            log_system_action($mysqli, $authUserId, 'delete_schedule', $logMsg);
            json_response(['deleted' => true, 'schedule_id' => $scheduleId]);
        };

        $update_schedule = function($scheduleId) use ($mysqli, $input, $normalize_time_simple, $authUserId, $activeSemesterId, $isDeanRole, $authUserDeptId, $require_dean_scope, $enforce_dean_scope_for_subject_section, $get_dept_id_for_schedule, $enforce_program_scope_for_subject_section, $isProgramHeadRole, $programHeadProgramIds, $require_program_head_scope, $get_program_id_for_schedule, $get_program_id_for_subject, $get_program_id_for_section, $get_teacher_program_id, $get_user_role_id, $assert_active_schedule_dependencies, $assert_schedule_day_allowed, $acquire_schedule_locks, $release_schedule_locks) {
            $checkExisting = $mysqli->prepare("SELECT schedule_id, user_id, semester_id, subject_id, section_id, room_id, LOWER(TRIM(day_of_week)) AS day_of_week, TIME_FORMAT(start_time, '%H:%i:%s') AS start_time, TIME_FORMAT(end_time, '%H:%i:%s') AS end_time FROM tbl_class_schedules WHERE schedule_id = ? LIMIT 1");
            if (!$checkExisting) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $checkExisting->bind_param("i", $scheduleId);
            $checkExisting->execute();
            $existingRow = $checkExisting->get_result()->fetch_assoc();
            if (!$existingRow) {
                json_response(['error' => 'schedule_not_found', 'message' => 'Schedule not found.'], 404);
            }

            if ($isProgramHeadRole) {
                $require_program_head_scope();
                $scheduleProgramId = $get_program_id_for_schedule($scheduleId);
                if (!$scheduleProgramId || !in_array((int)$scheduleProgramId, $programHeadProgramIds, true)) {
                    json_response(['error' => 'forbidden', 'message' => 'Program head can only update schedules within their assigned program.'], 403);
                }
            }
            if ($isDeanRole) {
                $require_dean_scope();
                $scheduleDeptId = $get_dept_id_for_schedule($scheduleId);
                if ($scheduleDeptId === null || (int)$scheduleDeptId !== (int)$authUserDeptId) {
                    json_response(['error' => 'forbidden', 'message' => 'You can only update schedules within your assigned department.'], 403);
                }
            }

            $roomId = isset($input['room_id']) ? (int)$input['room_id'] : null;
            $subjectId = isset($input['subject_id']) ? (int)$input['subject_id'] : null;
            $sectionId = isset($input['section_id']) ? (int)$input['section_id'] : null;
            $teacherId = isset($input['user_id']) ? (int)$input['user_id'] : null;
            $semesterId = isset($input['semester_id']) ? (int)$input['semester_id'] : null;
            $dayOfWeek = isset($input['day_of_week']) ? strtolower(trim((string)$input['day_of_week'])) : null;
            $startTime = $normalize_time_simple($input['start_time'] ?? null);
            $endTime = $normalize_time_simple($input['end_time'] ?? null);
            if (!$roomId || !$subjectId || !$sectionId || !$teacherId || !$semesterId || !$dayOfWeek || !$startTime || !$endTime) {
                json_response(['error' => 'missing_fields', 'message' => 'room_id, subject_id, section_id, user_id, semester_id, day_of_week, start_time, end_time are required.'], 400);
            }
            $assert_schedule_day_allowed($dayOfWeek);

            $enforce_program_scope_for_subject_section($subjectId, $sectionId);
            $enforce_dean_scope_for_subject_section($subjectId, $sectionId);
            $subjectProgramId = $get_program_id_for_subject($subjectId);
            $sectionProgramId = $get_program_id_for_section($sectionId);
            if (!$subjectProgramId || !$sectionProgramId || (int)$subjectProgramId !== (int)$sectionProgramId) {
                json_response([
                    'error' => 'program_mismatch',
                    'message' => 'Program mismatch: subject and section must belong to the same program.'
                ], 409);
            }
            $rowProgramId = (int)$subjectProgramId;
            $assigneeRoleId = $get_user_role_id($teacherId);
            if (!$assigneeRoleId) {
                json_response(['error' => 'validation', 'message' => 'Selected instructor account was not found.'], 409);
            }
            if (!in_array((int)$assigneeRoleId, [2, 3, 4, 5], true)) {
                json_response(['error' => 'validation', 'message' => 'Only a Dean, Program Head, Secretary, or Teacher can be scheduled for classes.'], 409);
            }
            $teacherProgramId = $get_teacher_program_id($teacherId);
            $assigneeNeedsProgramMatch = in_array((int)$assigneeRoleId, [2, 3, 4, 5], true);
            if ($assigneeNeedsProgramMatch) {
                if ($rowProgramId && !$teacherProgramId) {
                    json_response(['error' => 'validation', 'message' => 'Program mismatch: selected instructor has no program assignment.'], 409);
                }
                if ($rowProgramId && $teacherProgramId && (int)$teacherProgramId !== (int)$rowProgramId) {
                    json_response(['error' => 'validation', 'message' => 'Program mismatch: instructor, subject, and section must belong to the same program.'], 409);
                }
            }
            if ($isProgramHeadRole && $assigneeNeedsProgramMatch) {
                if (!$teacherProgramId || !in_array((int)$teacherProgramId, $programHeadProgramIds, true)) {
                    json_response(['error' => 'forbidden', 'message' => 'Program head can only assign instructors within their own program.'], 403);
                }
            }

            // Reject 'localhost' in any string fields
            if (stripos($dayOfWeek, 'localhost') !== false || stripos($startTime, 'localhost') !== false || stripos($endTime, 'localhost') !== false) {
                json_response(['error' => 'validation', 'message' => 'Invalid input (localhost addresses are not allowed)'], 400);
            }
            if ($startTime >= $endTime) {
                json_response(['error' => 'validation', 'message' => 'start_time must be before end_time'], 400);
            }

            $assert_active_schedule_dependencies($semesterId, $roomId, $subjectId, $sectionId, $teacherId);

            $beforeState = schedule_edit_normalize_state($existingRow);
            $afterState = schedule_edit_normalize_state([
                'user_id' => $teacherId,
                'semester_id' => $semesterId,
                'subject_id' => $subjectId,
                'section_id' => $sectionId,
                'room_id' => $roomId,
                'day_of_week' => $dayOfWeek,
                'start_time' => $startTime,
                'end_time' => $endTime,
            ]);
            $editImpact = schedule_edit_get_impact($mysqli, (int)$scheduleId, $afterState);
            if (schedule_edit_state_hash($beforeState) !== schedule_edit_state_hash($afterState) && schedule_edit_is_active_now($beforeState)) {
                json_response([
                    'error' => 'schedule_session_active',
                    'message' => 'This class is currently in progress. To protect live attendance, apply the edit after the class ends; it will then affect the next occurrence.',
                    'edit_impact' => $editImpact,
                ], 409);
            }
            $identityChanges = schedule_edit_identity_changes($beforeState, $afterState);
            if (!empty($identityChanges) && schedule_edit_has_protected_history($editImpact)) {
                json_response([
                    'error' => 'schedule_version_required',
                    'message' => 'Instructor, semester, subject, or section cannot be replaced because this schedule already has protected attendance history. Create a new class schedule for the new assignment; existing records will remain linked to the original schedule.',
                    'changed_identity_fields' => $identityChanges,
                    'edit_impact' => $editImpact,
                ], 409);
            }

            $scheduleLockNames = $acquire_schedule_locks([
                [
                    'semester_id' => (int)($existingRow['semester_id'] ?? 0),
                    'day_of_week' => $existingRow['day_of_week'] ?? '',
                ],
                [
                    'semester_id' => $semesterId,
                    'day_of_week' => $dayOfWeek,
                ],
            ]);

            // Check exact duplicate (different schedule_id)
            $dup = $mysqli->prepare("SELECT schedule_id FROM tbl_class_schedules WHERE room_id = ? AND subject_id = ? AND section_id = ? AND user_id = ? AND semester_id = ? AND LOWER(TRIM(day_of_week)) = ? AND start_time = ? AND end_time = ? AND schedule_id <> ? LIMIT 1");
            if (!$dup) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $dup->bind_param("iiiiisssi", $roomId, $subjectId, $sectionId, $teacherId, $semesterId, $dayOfWeek, $startTime, $endTime, $scheduleId);
            $dup->execute();
            if ($dup->get_result()->fetch_assoc()) {
                json_response(['error' => 'duplicate_schedule', 'message' => 'Schedule already exists.'], 409);
            }

            // A section may take a subject only once per weekday in a semester,
            // even when the two sessions do not overlap.
            $sectionSubjectDuplicate = $mysqli->prepare("SELECT schedule_id FROM tbl_class_schedules WHERE semester_id = ? AND LOWER(TRIM(day_of_week)) = ? AND section_id = ? AND subject_id = ? AND schedule_id <> ? LIMIT 1");
            if (!$sectionSubjectDuplicate) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $sectionSubjectDuplicate->bind_param("isiii", $semesterId, $dayOfWeek, $sectionId, $subjectId, $scheduleId);
            $sectionSubjectDuplicate->execute();
            if ($sectionSubjectDuplicate->get_result()->fetch_assoc()) {
                json_response(['error' => 'duplicate_section_subject', 'message' => 'This section already has this subject on the selected day. Each section can only have one session per subject daily.'], 409);
            }

            // ===== CHECK 2: ROOM OVERLAP =====
            $roomOverlap = $mysqli->prepare("SELECT schedule_id FROM tbl_class_schedules WHERE semester_id = ? AND LOWER(TRIM(day_of_week)) = ? AND room_id = ? AND NOT (end_time <= ? OR start_time >= ?) AND schedule_id <> ? LIMIT 1");
            if (!$roomOverlap) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $roomOverlap->bind_param("isissi", $semesterId, $dayOfWeek, $roomId, $startTime, $endTime, $scheduleId);
            $roomOverlap->execute();
            if ($roomOverlap->get_result()->fetch_assoc()) {
                json_response(['error' => 'time_conflict', 'message' => 'Room Conflict: The selected room is already occupied during this timeframe.'], 409);
            }

            // ===== CHECK 3: SECTION OVERLAP (Fixes Bug 2) =====
            $sectionOverlap = $mysqli->prepare("SELECT schedule_id FROM tbl_class_schedules WHERE semester_id = ? AND LOWER(TRIM(day_of_week)) = ? AND section_id = ? AND NOT (end_time <= ? OR start_time >= ?) AND schedule_id <> ? LIMIT 1");
            if (!$sectionOverlap) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $sectionOverlap->bind_param("isissi", $semesterId, $dayOfWeek, $sectionId, $startTime, $endTime, $scheduleId);
            $sectionOverlap->execute();
            if ($sectionOverlap->get_result()->fetch_assoc()) {
                json_response(['error' => 'section_conflict', 'message' => 'Section Conflict: This student section is already scheduled for another class during this timeframe.'], 409);
            }

            // ===== CHECK 4: TEACHER OVERLAP WITH PARALLEL CLASS LOGIC (Fixes Bug 1) =====
            $teacherOverlap = $mysqli->prepare("SELECT schedule_id, subject_id, start_time, end_time FROM tbl_class_schedules WHERE semester_id = ? AND LOWER(TRIM(day_of_week)) = ? AND user_id = ? AND NOT (end_time <= ? OR start_time >= ?) AND schedule_id <> ?");
            if (!$teacherOverlap) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $teacherOverlap->bind_param("isissi", $semesterId, $dayOfWeek, $teacherId, $startTime, $endTime, $scheduleId);
            $teacherOverlap->execute();
            $teacherConflicts = $teacherOverlap->get_result()->fetch_all(MYSQLI_ASSOC);
            $hasDifferentSubjectConflict = false;
            $hasParallelTimeMismatch = false;
            foreach ($teacherConflicts as $teacherConflict) {
                if ((int)$teacherConflict['subject_id'] !== (int)$subjectId) {
                    $hasDifferentSubjectConflict = true;
                    continue;
                }
                if ($teacherConflict['start_time'] !== $startTime || $teacherConflict['end_time'] !== $endTime) {
                    $hasParallelTimeMismatch = true;
                }
            }
            if ($hasDifferentSubjectConflict) {
                json_response(['error' => 'teacher_conflict', 'message' => 'Teacher Conflict: The instructor is already teaching a DIFFERENT subject during this timeframe.'], 409);
            }
            if ($hasParallelTimeMismatch) {
                json_response(['error' => 'parallel_time_mismatch', 'message' => 'Parallel Class Error: To merge sections under this teacher, the start and end times must match the existing class exactly.'], 409);
            }

            // Update the schedule and its untouched future placeholders atomically.
            $attendanceSync = ['ok' => true, 'deleted_rows' => 0, 'generated_rows' => 0, 'errors' => []];
            $mysqli->begin_transaction();
            try {
                $stmt = $mysqli->prepare("UPDATE tbl_class_schedules SET user_id = ?, semester_id = ?, subject_id = ?, section_id = ?, room_id = ?, day_of_week = ?, start_time = ?, end_time = ? WHERE schedule_id = ?");
                if (!$stmt) throw new RuntimeException($mysqli->error);
                $uVal = $teacherId ? $teacherId : null;
                $semVal = $semesterId ? $semesterId : null;
                $sSubj = $subjectId ? $subjectId : null;
                $sSec = $sectionId ? $sectionId : null;
                $stmt->bind_param("iiiiisssi", $uVal, $semVal, $sSubj, $sSec, $roomId, $dayOfWeek, $startTime, $endTime, $scheduleId);
                if (!$stmt->execute()) throw new RuntimeException($stmt->error);
                if ($activeSemesterId && (int)$semesterId === (int)$activeSemesterId) {
                    $attendanceSync = cw_sync_future_attendance_for_schedule($mysqli, (int)$scheduleId);
                    if (empty($attendanceSync['ok'])) {
                        throw new RuntimeException('Unable to rebuild future attendance placeholders: ' . implode(' | ', $attendanceSync['errors'] ?? []));
                    }
                } else {
                    $attendanceSync['planning_only'] = true;
                }
                $mysqli->commit();
            } catch (Throwable $e) {
                $mysqli->rollback();
                $release_schedule_locks($scheduleLockNames);
                json_response(['error' => 'update_failed', 'message' => $e->getMessage()], 500);
            }
            $release_schedule_locks($scheduleLockNames);

            // Log schedule update - fetch friendly names from merged fields
            $roomName = null; $subjCode = null; $subjName = null;
            $qinfo = $mysqli->prepare("SELECT r.room_name, s.subject_code, s.subject_name FROM tbl_rooms r LEFT JOIN tbl_subject s ON s.subject_id = (SELECT subject_id FROM tbl_class_schedules WHERE schedule_id = ?) WHERE r.room_id = (SELECT room_id FROM tbl_class_schedules WHERE schedule_id = ?) LIMIT 1");
            if ($qinfo) { $qinfo->bind_param('ii', $scheduleId, $scheduleId); $qinfo->execute(); $inf = $qinfo->get_result()->fetch_assoc(); if ($inf) { $roomName = $inf['room_name'] ?? null; $subjCode = $inf['subject_code'] ?? null; $subjName = $inf['subject_name'] ?? null; } }
            $logMsg = schedule_edit_audit_details('direct_edit', (int)$scheduleId, $beforeState, $afterState, $editImpact, $attendanceSync);
            log_system_action($mysqli, $authUserId, 'update_schedule', $logMsg);
            json_response(['schedule_id' => $scheduleId, 'room_id' => $roomId, 'subject_id' => $subjectId, 'section_id' => $sectionId, 'user_id' => $teacherId, 'semester_id' => $semesterId, 'day_of_week' => $dayOfWeek, 'start_time' => $startTime, 'end_time' => $endTime, 'edit_impact' => $editImpact, 'attendance_sync' => $attendanceSync]);
        };

        $create_schedule = function() use ($mysqli, $input, $normalize_time_simple, $authUserId, $activeSemesterId, $enforce_dean_scope_for_subject_section, $enforce_program_scope_for_subject_section, $isProgramHeadRole, $programHeadProgramIds, $get_program_id_for_subject, $get_program_id_for_section, $get_teacher_program_id, $get_user_role_id, $assert_active_schedule_dependencies, $assert_schedule_day_allowed, $acquire_schedule_locks, $release_schedule_locks) {
            $roomId = isset($input['room_id']) ? (int)$input['room_id'] : null;
            $subjectId = isset($input['subject_id']) ? (int)$input['subject_id'] : null;
            $sectionId = isset($input['section_id']) ? (int)$input['section_id'] : null;
            $teacherId = isset($input['user_id']) ? (int)$input['user_id'] : null;
            $semesterId = isset($input['semester_id']) && is_numeric($input['semester_id'])
                ? (int)$input['semester_id']
                : ($activeSemesterId ? (int)$activeSemesterId : null);
            $dayOfWeek = isset($input['day_of_week']) ? strtolower(trim((string)$input['day_of_week'])) : null;
            $startTime = $normalize_time_simple($input['start_time'] ?? null);
            $endTime = $normalize_time_simple($input['end_time'] ?? null);

            if (!$semesterId) {
                json_response(['error' => 'no_schedule_semester', 'message' => 'Select a current or upcoming semester before adding a schedule.'], 409);
            }
            if (!$roomId || !$subjectId || !$sectionId || !$teacherId || !$dayOfWeek || !$startTime || !$endTime) {
                json_response(['error' => 'missing_fields', 'message' => 'room_id, subject_id, section_id, user_id, day_of_week, start_time, end_time are required.'], 400);
            }
            $assert_schedule_day_allowed($dayOfWeek);
            if ($startTime >= $endTime) {
                json_response(['error' => 'validation', 'message' => 'start_time must be before end_time'], 400);
            }

            $assert_active_schedule_dependencies($semesterId, $roomId, $subjectId, $sectionId, $teacherId);

            $enforce_program_scope_for_subject_section($subjectId, $sectionId);
            $enforce_dean_scope_for_subject_section($subjectId, $sectionId);
            $subjectProgramId = $get_program_id_for_subject($subjectId);
            $sectionProgramId = $get_program_id_for_section($sectionId);
            if (!$subjectProgramId || !$sectionProgramId || (int)$subjectProgramId !== (int)$sectionProgramId) {
                json_response([
                    'error' => 'program_mismatch',
                    'message' => 'Program mismatch: subject and section must belong to the same program.'
                ], 409);
            }
            $rowProgramId = (int)$subjectProgramId;
            $assigneeRoleId = $get_user_role_id($teacherId);
            if (!$assigneeRoleId) {
                json_response(['error' => 'validation', 'message' => 'Selected instructor account was not found.'], 409);
            }
            if (!in_array((int)$assigneeRoleId, [2, 3, 4, 5], true)) {
                json_response(['error' => 'validation', 'message' => 'Only a Dean, Program Head, Secretary, or Teacher can be scheduled for classes.'], 409);
            }
            $teacherProgramId = $get_teacher_program_id($teacherId);
            $assigneeNeedsProgramMatch = in_array((int)$assigneeRoleId, [2, 3, 4, 5], true);
            if ($assigneeNeedsProgramMatch) {
                if ($rowProgramId && !$teacherProgramId) {
                    json_response(['error' => 'validation', 'message' => 'Program mismatch: selected instructor has no program assignment.'], 409);
                }
                if ($rowProgramId && $teacherProgramId && (int)$teacherProgramId !== (int)$rowProgramId) {
                    json_response(['error' => 'validation', 'message' => 'Program mismatch: instructor, subject, and section must belong to the same program.'], 409);
                }
            }
            if ($isProgramHeadRole && $assigneeNeedsProgramMatch) {
                if (!$teacherProgramId || !in_array((int)$teacherProgramId, $programHeadProgramIds, true)) {
                    json_response(['error' => 'forbidden', 'message' => 'Program head can only assign instructors within their own program.'], 403);
                }
            }

            $scheduleLockNames = $acquire_schedule_locks([[
                'semester_id' => $semesterId,
                'day_of_week' => $dayOfWeek,
            ]]);

            // ===== CHECK 1: EXACT DUPLICATE =====
            $dup = $mysqli->prepare("SELECT schedule_id FROM tbl_class_schedules WHERE room_id = ? AND subject_id = ? AND section_id = ? AND user_id = ? AND semester_id = ? AND LOWER(TRIM(day_of_week)) = ? AND start_time = ? AND end_time = ? LIMIT 1");
            if (!$dup) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $dup->bind_param("iiiiisss", $roomId, $subjectId, $sectionId, $teacherId, $semesterId, $dayOfWeek, $startTime, $endTime);
            $dup->execute();
            if ($dup->get_result()->fetch_assoc()) {
                json_response(['error' => 'duplicate_schedule', 'message' => 'This exact schedule already exists.'], 409);
            }

            // A section may take a subject only once per weekday in a semester,
            // even when the two sessions do not overlap.
            $sectionSubjectDuplicate = $mysqli->prepare("SELECT schedule_id FROM tbl_class_schedules WHERE semester_id = ? AND LOWER(TRIM(day_of_week)) = ? AND section_id = ? AND subject_id = ? LIMIT 1");
            if (!$sectionSubjectDuplicate) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $sectionSubjectDuplicate->bind_param("isii", $semesterId, $dayOfWeek, $sectionId, $subjectId);
            $sectionSubjectDuplicate->execute();
            if ($sectionSubjectDuplicate->get_result()->fetch_assoc()) {
                json_response(['error' => 'duplicate_section_subject', 'message' => 'This section already has this subject on the selected day. Each section can only have one session per subject daily.'], 409);
            }

            // ===== CHECK 2: ROOM OVERLAP =====
            $roomOverlap = $mysqli->prepare("SELECT schedule_id FROM tbl_class_schedules WHERE semester_id = ? AND LOWER(TRIM(day_of_week)) = ? AND room_id = ? AND NOT (end_time <= ? OR start_time >= ?) LIMIT 1");
            if (!$roomOverlap) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $roomOverlap->bind_param("isiss", $semesterId, $dayOfWeek, $roomId, $startTime, $endTime);
            $roomOverlap->execute();
            if ($roomOverlap->get_result()->fetch_assoc()) {
                json_response(['error' => 'time_conflict', 'message' => 'Room Conflict: The selected room is already occupied during this timeframe.'], 409);
            }

            // ===== CHECK 3: SECTION OVERLAP (Fixes Bug 2) =====
            $sectionOverlap = $mysqli->prepare("SELECT schedule_id FROM tbl_class_schedules WHERE semester_id = ? AND LOWER(TRIM(day_of_week)) = ? AND section_id = ? AND NOT (end_time <= ? OR start_time >= ?) LIMIT 1");
            if (!$sectionOverlap) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $sectionOverlap->bind_param("isiss", $semesterId, $dayOfWeek, $sectionId, $startTime, $endTime);
            $sectionOverlap->execute();
            if ($sectionOverlap->get_result()->fetch_assoc()) {
                json_response(['error' => 'section_conflict', 'message' => 'Section Conflict: This student section is already scheduled for another class during this timeframe.'], 409);
            }

            // ===== CHECK 4: TEACHER OVERLAP WITH PARALLEL CLASS LOGIC (Fixes Bug 1) =====
            $teacherOverlap = $mysqli->prepare("SELECT schedule_id, subject_id, start_time, end_time FROM tbl_class_schedules WHERE semester_id = ? AND LOWER(TRIM(day_of_week)) = ? AND user_id = ? AND NOT (end_time <= ? OR start_time >= ?)");
            if (!$teacherOverlap) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $teacherOverlap->bind_param("isiss", $semesterId, $dayOfWeek, $teacherId, $startTime, $endTime);
            $teacherOverlap->execute();
            $teacherConflicts = $teacherOverlap->get_result()->fetch_all(MYSQLI_ASSOC);
            $hasDifferentSubjectConflict = false;
            $hasParallelTimeMismatch = false;
            foreach ($teacherConflicts as $teacherConflict) {
                if ((int)$teacherConflict['subject_id'] !== (int)$subjectId) {
                    $hasDifferentSubjectConflict = true;
                    continue;
                }
                if ($teacherConflict['start_time'] !== $startTime || $teacherConflict['end_time'] !== $endTime) {
                    $hasParallelTimeMismatch = true;
                }
            }
            if ($hasDifferentSubjectConflict) {
                json_response(['error' => 'teacher_conflict', 'message' => 'Teacher Conflict: The instructor is already teaching a DIFFERENT subject during this timeframe.'], 409);
            }
            if ($hasParallelTimeMismatch) {
                json_response(['error' => 'parallel_time_mismatch', 'message' => 'Parallel Class Error: To merge sections under this teacher, the start and end times must match the existing class exactly.'], 409);
            }

            $stmt = $mysqli->prepare("INSERT INTO tbl_class_schedules (user_id, semester_id, subject_id, section_id, room_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
            if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $stmt->bind_param("iiiiisss", $teacherId, $semesterId, $subjectId, $sectionId, $roomId, $dayOfWeek, $startTime, $endTime);
            if (!$stmt->execute()) json_response(['error' => 'insert_failed', 'message' => $stmt->error], 500);
            $newScheduleId = (int)$stmt->insert_id;
            $release_schedule_locks($scheduleLockNames);
            $attendanceSync = ['ok' => true, 'generated_rows' => 0, 'errors' => []];
            if ($activeSemesterId && (int)$semesterId === (int)$activeSemesterId) {
                $attendanceSync = cw_generate_attendance_records($mysqli, [$newScheduleId], 0, 6);
                if (!$attendanceSync['ok']) {
                    error_log('[class-schedules] Immediate attendance generation failed for schedule #' . $newScheduleId . ': ' . implode(' | ', $attendanceSync['errors']));
                }
            } else {
                $attendanceSync['planning_only'] = true;
            }

            log_system_action($mysqli, $authUserId, 'create_schedule', "Created class schedule in room {$roomId} on {$dayOfWeek} {$startTime}-{$endTime}");
            json_response([
                'schedule_id' => $newScheduleId,
                'room_id' => $roomId,
                'subject_id' => $subjectId,
                'section_id' => $sectionId,
                'user_id' => $teacherId,
                'semester_id' => $semesterId,
                'day_of_week' => $dayOfWeek,
                'start_time' => $startTime,
                'end_time' => $endTime,
                'attendance_sync' => $attendanceSync,
            ], 201);
        };

        if ($request_method === 'GET' && is_numeric($param1) && $param2 === 'edit-impact') {
            $require_schedule_edit_access();
            $impactScheduleId = (int)$param1;
            $impactState = schedule_edit_get_state($mysqli, $impactScheduleId);
            if (!$impactState) {
                json_response(['error' => 'schedule_not_found', 'message' => 'Schedule not found.'], 404);
            }
            if ($isProgramHeadRole) {
                $require_program_head_scope();
                $impactProgramId = $get_program_id_for_schedule($impactScheduleId);
                if (!$impactProgramId || !in_array((int)$impactProgramId, $programHeadProgramIds, true)) {
                    json_response(['error' => 'forbidden', 'message' => 'Program head can only inspect schedules within their assigned program.'], 403);
                }
            }
            if ($isDeanRole) {
                $require_dean_scope();
                $impactDeptId = $get_dept_id_for_schedule($impactScheduleId);
                if ($impactDeptId === null || (int)$impactDeptId !== (int)$authUserDeptId) {
                    json_response(['error' => 'forbidden', 'message' => 'You can only inspect schedules within your assigned department.'], 403);
                }
            }
            json_response([
                'schedule_id' => $impactScheduleId,
                'state_hash' => schedule_edit_state_hash($impactState),
                'edit_impact' => schedule_edit_get_impact($mysqli, $impactScheduleId, $impactState),
            ]);
        } elseif ($request_method === 'GET' && $param1 === 'offerings') {
            // Provide a list of subject+section+teacher combos. If tbl_subject_offerings exists use it; otherwise build from subjects + sections + users mapping
            $programFilterParts = [
                "LOWER(TRIM(COALESCE(s.status, ''))) = 'active'",
                "LOWER(TRIM(COALESCE(sec.status, ''))) = 'active'",
                "LOWER(TRIM(COALESCE(p.status, ''))) = 'active'",
                "LOWER(TRIM(COALESCE(d.status, ''))) = 'active'",
                'sec.program_id = s.program_id',
            ];
            if ($isProgramHeadRole) {
                $require_program_head_scope();
                $programFilterParts[] = "p.program_id IN (" . implode(',', array_map('intval', $programHeadProgramIds)) . ")";
            } elseif (!$isAdminRole && ($isDeanRole || $isSecretaryRole)) {
                if ($authUserDeptId === null) {
                    json_response([]);
                }
                $programFilterParts[] = "p.dept_id = " . intval($authUserDeptId);
            }
            $programFilterSql = ' WHERE ' . implode(' AND ', $programFilterParts);
            if ($has_subject_offerings) {
                $programFilterSql .= " AND LOWER(TRIM(COALESCE(u.status, ''))) = 'active'";
                $result = $mysqli->query("SELECT so.offering_id, so.user_id, s.subject_code, s.subject_name, sec.section_name, p.head_id, p.dept_id AS program_dept_id, u.dept_id AS teacher_dept_id FROM tbl_subject_offerings so JOIN tbl_subject s ON so.subject_id = s.subject_id JOIN tbl_sections sec ON so.section_id = sec.section_id LEFT JOIN tbl_programs p ON s.program_id = p.program_id LEFT JOIN tbl_departments d ON d.dept_id = p.dept_id LEFT JOIN tbl_users u ON so.user_id = u.user_id{$programFilterSql}");
                json_response($result->fetch_all(MYSQLI_ASSOC));
            } else {
                $result = $mysqli->query("SELECT s.subject_id, s.subject_code, s.subject_name, sec.section_id, sec.section_name, NULL AS offering_id, NULL AS user_id, p.program_id, p.dept_id AS program_dept_id FROM tbl_subject s JOIN tbl_sections sec ON sec.program_id = s.program_id LEFT JOIN tbl_programs p ON s.program_id = p.program_id LEFT JOIN tbl_departments d ON d.dept_id = p.dept_id{$programFilterSql}");
                json_response($result->fetch_all(MYSQLI_ASSOC));
            }
        } elseif ($request_method === 'GET') {
            // Rich GET for class schedules. Pagination/filtering is opt-in so
            // existing consumers that expect a plain array remain compatible.
            $paginateSchedules = isset($_GET['paginate']) && (string)$_GET['paginate'] === '1';
            $currentSemesterOnly = isset($_GET['current']) && (string)$_GET['current'] === '1';
            $compactSchedules = isset($_GET['compact']) && (string)$_GET['compact'] === '1';
            $includeAvatar = !$paginateSchedules && (!isset($_GET['include_avatar']) || (string)$_GET['include_avatar'] !== '0');
            $whereParts = [];
            if ($isProgramHeadRole) {
                $require_program_head_scope();
                $whereParts[] = "p.program_id IN (" . implode(',', array_map('intval', $programHeadProgramIds)) . ")";
            } elseif (!$isAdminRole && ($isDeanRole || $isSecretaryRole)) {
                if ($authUserDeptId === null) {
                    if ($paginateSchedules) {
                        json_response([
                            'rows' => [],
                            'pagination' => ['page' => 1, 'page_size' => 10, 'total' => 0, 'total_pages' => 1],
                            'summary' => ['total' => 0, 'teachers' => 0, 'rooms' => 0, 'sections' => 0, 'days' => [], 'top_rooms' => [], 'top_programs' => []],
                        ]);
                    }
                    json_response([]);
                }
                $whereParts[] = "p.dept_id = " . intval($authUserDeptId);
            }
            $whereParts[] = 'u.role_id IN (2, 3, 4, 5)';

            if ($currentSemesterOnly) {
                $whereParts[] = $activeSemesterId ? 'cs.semester_id = ' . (int)$activeSemesterId : '1 = 0';
            } elseif (isset($_GET['semester_id']) && is_numeric($_GET['semester_id'])) {
                $whereParts[] = 'cs.semester_id = ' . (int)$_GET['semester_id'];
            }

            $numericScheduleFilters = [
                'dept_id' => 'p.dept_id',
                'program_id' => 'p.program_id',
                'teacher_id' => 'cs.user_id',
                'subject_id' => 'cs.subject_id',
                'section_id' => 'cs.section_id',
                'campus_id' => 'sc.school_id',
                'building_id' => 'b.building_id',
                'floor_id' => 'f.floor_id',
                'room_id' => 'cs.room_id',
            ];
            foreach ($numericScheduleFilters as $queryKey => $sqlColumn) {
                if (isset($_GET[$queryKey]) && $_GET[$queryKey] !== '' && is_numeric($_GET[$queryKey])) {
                    $whereParts[] = $sqlColumn . ' = ' . (int)$_GET[$queryKey];
                }
            }
            if (isset($_GET['day']) && in_array(strtolower(trim((string)$_GET['day'])), ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'], true)) {
                $whereParts[] = "LOWER(cs.day_of_week) = '" . strtolower(trim((string)$_GET['day'])) . "'";
            }

            $programFilterSql = ' WHERE ' . implode(' AND ', $whereParts);
            $avatarSelect = $includeAvatar ? "NULLIF(CAST(u.image AS CHAR), '')" : 'NULL';
            if ($has_subject_offerings && $cs_has_offering_col) {
                $baseSql = "SELECT cs.schedule_id, cs.room_id, cs.offering_id, cs.subject_id, cs.section_id, cs.semester_id, cs.user_id AS teacher_id, cs.day_of_week, cs.start_time, cs.end_time, r.room_name,
                           COALESCE(s_so.subject_code, s_cs.subject_code) AS subject_code,
                           COALESCE(s_so.subject_name, s_cs.subject_name) AS subject_name,
                           COALESCE(sec_so.section_name, sec_cs.section_name) AS section_name,
                           CONCAT(u.first_name, ' ', u.last_name) AS teacher_name, {$avatarSelect} AS avatar, u.dept_id AS teacher_dept_id,
                           p.program_id, p.program_name, p.sub_name AS program_sub_name, p.dept_id, d.dept_name, d.sub_name AS department_sub_name, sc.school_id AS campus_id, sc.school_name AS campus_name, b.building_id, b.building_name, f.floor_id, f.floor_name, sem.start_date AS semester_start, sem.end_date AS semester_end
                        FROM tbl_class_schedules cs
                        JOIN tbl_rooms r ON cs.room_id = r.room_id
                        LEFT JOIN tbl_subject_offerings so ON (cs.offering_id IS NOT NULL AND so.offering_id = cs.offering_id)
                        LEFT JOIN tbl_subject s_so ON (so.offering_id IS NOT NULL AND so.subject_id = s_so.subject_id)
                        LEFT JOIN tbl_sections sec_so ON (so.offering_id IS NOT NULL AND so.section_id = sec_so.section_id)
                        LEFT JOIN tbl_subject s_cs ON (cs.subject_id IS NOT NULL AND cs.subject_id = s_cs.subject_id)
                        LEFT JOIN tbl_sections sec_cs ON (cs.section_id IS NOT NULL AND cs.section_id = sec_cs.section_id)
                        LEFT JOIN tbl_users u ON (cs.user_id IS NOT NULL AND cs.user_id = u.user_id)
                        LEFT JOIN tbl_programs p ON ( (so.offering_id IS NOT NULL AND s_so.program_id = p.program_id) OR (cs.subject_id IS NOT NULL AND s_cs.program_id = p.program_id) )
                        LEFT JOIN tbl_departments d ON p.dept_id = d.dept_id
                        LEFT JOIN tbl_buildings b ON r.building_id = b.building_id
                        LEFT JOIN tbl_school sc ON b.school_id = sc.school_id
                        LEFT JOIN tbl_floors f ON r.floor_id = f.floor_id
                        LEFT JOIN tbl_semesters sem ON (cs.semester_id IS NOT NULL AND cs.semester_id = sem.semester_id)
                        {$programFilterSql}";
            } else {
                $baseSql = "SELECT cs.schedule_id, cs.room_id, NULL AS offering_id, cs.subject_id, cs.section_id, cs.semester_id, cs.user_id AS teacher_id, cs.day_of_week, cs.start_time, cs.end_time, r.room_name,
                           s.subject_code, s.subject_name, sec.section_name,
                           CONCAT(u.first_name, ' ', u.last_name) AS teacher_name, {$avatarSelect} AS avatar, u.dept_id AS teacher_dept_id,
                           p.program_id, p.program_name, p.sub_name AS program_sub_name, p.dept_id, d.dept_name, d.sub_name AS department_sub_name, sc.school_id AS campus_id, sc.school_name AS campus_name, b.building_id, b.building_name, f.floor_id, f.floor_name, sem.start_date AS semester_start, sem.end_date AS semester_end
                        FROM tbl_class_schedules cs
                        JOIN tbl_rooms r ON cs.room_id = r.room_id
                        LEFT JOIN tbl_subject s ON (cs.subject_id IS NOT NULL AND cs.subject_id = s.subject_id)
                        LEFT JOIN tbl_sections sec ON (cs.section_id IS NOT NULL AND cs.section_id = sec.section_id)
                        LEFT JOIN tbl_users u ON (cs.user_id IS NOT NULL AND cs.user_id = u.user_id)
                        LEFT JOIN tbl_programs p ON (s.program_id = p.program_id)
                        LEFT JOIN tbl_departments d ON p.dept_id = d.dept_id
                        LEFT JOIN tbl_buildings b ON r.building_id = b.building_id
                        LEFT JOIN tbl_school sc ON b.school_id = sc.school_id
                        LEFT JOIN tbl_floors f ON r.floor_id = f.floor_id
                        LEFT JOIN tbl_semesters sem ON (cs.semester_id IS NOT NULL AND cs.semester_id = sem.semester_id)
                        {$programFilterSql}";
            }

            if ($compactSchedules) {
                $baseSql = "SELECT schedule_id, room_id, subject_id, section_id, semester_id, teacher_id,
                        day_of_week, start_time, end_time, room_name, subject_code, subject_name,
                        section_name, teacher_name, program_id, dept_id,
                        campus_id, campus_name, building_id, building_name, floor_id, floor_name,
                        semester_start, semester_end
                    FROM ({$baseSql}) rich_schedules";
            }

            $orderSql = " ORDER BY FIELD(day_of_week, 'monday','tuesday','wednesday','thursday','friday','saturday','sunday'), start_time, teacher_id, subject_id, section_id";
            if ($paginateSchedules) {
                $pageSize = isset($_GET['page_size']) && is_numeric($_GET['page_size']) ? (int)$_GET['page_size'] : 10;
                $pageSize = max(1, min(100, $pageSize));
                $page = isset($_GET['page']) && is_numeric($_GET['page']) ? max(1, (int)$_GET['page']) : 1;

                $summarySql = "SELECT COUNT(*) AS total,
                        COUNT(DISTINCT teacher_id) AS teachers,
                        COUNT(DISTINCT room_id) AS rooms,
                        COUNT(DISTINCT section_id) AS sections,
                        SUM(LOWER(day_of_week) = 'monday') AS monday,
                        SUM(LOWER(day_of_week) = 'tuesday') AS tuesday,
                        SUM(LOWER(day_of_week) = 'wednesday') AS wednesday,
                        SUM(LOWER(day_of_week) = 'thursday') AS thursday,
                        SUM(LOWER(day_of_week) = 'friday') AS friday,
                        SUM(LOWER(day_of_week) = 'saturday') AS saturday,
                        SUM(LOWER(day_of_week) = 'sunday') AS sunday
                    FROM ({$baseSql}) filtered_schedules";
                $summaryResult = $mysqli->query($summarySql);
                if ($summaryResult === false) {
                    error_log('class-schedules summary: SQL error: ' . $mysqli->error);
                    json_response(['error' => 'query_failed', 'message' => 'Failed to summarize class schedules'], 500);
                }
                $summaryRow = $summaryResult->fetch_assoc() ?: [];
                $totalRows = (int)($summaryRow['total'] ?? 0);
                $totalPages = max(1, (int)ceil($totalRows / $pageSize));
                $page = min($page, $totalPages);
                $offset = ($page - 1) * $pageSize;

                $topRooms = [];
                $topRoomsResult = $mysqli->query("SELECT room_name AS label, COUNT(*) AS count FROM ({$baseSql}) filtered_schedules WHERE room_id IS NOT NULL GROUP BY room_id, room_name ORDER BY count DESC, label ASC LIMIT 5");
                if ($topRoomsResult) {
                    while ($topRoom = $topRoomsResult->fetch_assoc()) {
                        $topRooms[] = ['label' => $topRoom['label'] ?? 'Unassigned Room', 'count' => (int)($topRoom['count'] ?? 0)];
                    }
                }

                $topPrograms = [];
                $topProgramsResult = $mysqli->query("SELECT program_name, program_sub_name, COUNT(*) AS count FROM ({$baseSql}) filtered_schedules GROUP BY program_id, program_name, program_sub_name ORDER BY count DESC, program_name ASC LIMIT 5");
                if ($topProgramsResult) {
                    while ($topProgram = $topProgramsResult->fetch_assoc()) {
                        $topPrograms[] = [
                            'program_name' => $topProgram['program_name'] ?? '',
                            'program_sub_name' => $topProgram['program_sub_name'] ?? null,
                            'count' => (int)($topProgram['count'] ?? 0),
                        ];
                    }
                }

                $sql = $baseSql . $orderSql . ' LIMIT ' . $pageSize . ' OFFSET ' . $offset;
                $result = $mysqli->query($sql);
                if ($result === false) {
                    error_log('class-schedules: SQL error: ' . $mysqli->error . ' -- SQL: ' . preg_replace('/\s+/', ' ', substr($sql, 0, 1000)));
                    json_response(['error' => 'query_failed', 'message' => 'Failed to fetch class schedules', 'details' => $mysqli->error], 500);
                }
                json_response([
                    'rows' => $result->fetch_all(MYSQLI_ASSOC),
                    'pagination' => ['page' => $page, 'page_size' => $pageSize, 'total' => $totalRows, 'total_pages' => $totalPages],
                    'summary' => [
                        'total' => $totalRows,
                        'teachers' => (int)($summaryRow['teachers'] ?? 0),
                        'rooms' => (int)($summaryRow['rooms'] ?? 0),
                        'sections' => (int)($summaryRow['sections'] ?? 0),
                        'days' => [
                            'monday' => (int)($summaryRow['monday'] ?? 0),
                            'tuesday' => (int)($summaryRow['tuesday'] ?? 0),
                            'wednesday' => (int)($summaryRow['wednesday'] ?? 0),
                            'thursday' => (int)($summaryRow['thursday'] ?? 0),
                            'friday' => (int)($summaryRow['friday'] ?? 0),
                            'saturday' => (int)($summaryRow['saturday'] ?? 0),
                            'sunday' => (int)($summaryRow['sunday'] ?? 0),
                        ],
                        'top_rooms' => $topRooms,
                        'top_programs' => $topPrograms,
                    ],
                ]);
            }

            $sql = $baseSql . $orderSql;
            $result = $mysqli->query($sql);
            if ($result === false) {
                error_log('class-schedules: SQL error: ' . $mysqli->error . ' -- SQL: ' . preg_replace('/\s+/', ' ', substr($sql, 0, 1000)));
                json_response(['error' => 'query_failed', 'message' => 'Failed to fetch class schedules', 'details' => $mysqli->error], 500);
            }
            json_response($result->fetch_all(MYSQLI_ASSOC));
        }

        if ($request_method === 'PUT' && is_numeric($param1)) {
            $require_schedule_edit_access();
            $update_schedule((int)$param1);
        } elseif ($request_method === 'POST' && is_numeric($param1) && $param2 === 'update') {
            $require_schedule_edit_access();
            $update_schedule((int)$param1);
        } elseif ($request_method === 'DELETE' && is_numeric($param1)) {
            $require_schedule_manage_access();
            $delete_schedule((int)$param1);
        } elseif ($request_method === 'POST' && is_numeric($param1) && $param2 === 'delete') {
            $require_schedule_manage_access();
            $delete_schedule((int)$param1);
        }

        // Batch import/create: supports ClassSchedule page payload ({ rows: [...] }) and spreadsheet rows.
        if ($request_method === 'POST' && isset($input['rows']) && is_array($input['rows'])) {
            $require_schedule_manage_access();
            $rows = $input['rows'];
            $errors = [];
            $inserted = 0;
            $skipped = 0;
            $createdScheduleIds = [];
            $previewOnly = !empty($input['preview']);
            $spreadsheetImport = !empty($input['spreadsheet_import']);
            $targetSemesterId = isset($input['semester_id']) && is_numeric($input['semester_id'])
                ? (int)$input['semester_id']
                : ($activeSemesterId ? (int)$activeSemesterId : null);
            if (!$targetSemesterId) {
                json_response(['error' => 'no_schedule_semester', 'message' => 'Select a current or upcoming semester before adding schedules.'], 409);
            }
            $assert_schedule_semester_available($targetSemesterId);

            $normalize_header = function($key) {
                $k = strtolower(trim((string)$key));
                return preg_replace('/[^a-z0-9]+/', '_', $k);
            };
            $normalize_lookup = function($v) {
                return strtolower(trim((string)$v));
            };
            $get_value = function($arr, $keys) {
                foreach ($keys as $k) {
                    if (array_key_exists($k, $arr) && $arr[$k] !== null && trim((string)$arr[$k]) !== '') return $arr[$k];
                }
                return null;
            };
            $normalize_day = function($value) {
                if ($value === null) return null;
                $v = strtolower(trim((string)$value));
                if ($v === '') return null;
                $map = [
                    'mon' => 'monday', 'monday' => 'monday',
                    'tue' => 'tuesday', 'tues' => 'tuesday', 'tuesday' => 'tuesday',
                    'wed' => 'wednesday', 'wednesday' => 'wednesday',
                    'thu' => 'thursday', 'thur' => 'thursday', 'thurs' => 'thursday', 'thursday' => 'thursday',
                    'fri' => 'friday', 'friday' => 'friday',
                    'sat' => 'saturday', 'saturday' => 'saturday',
                    'sun' => 'sunday', 'sunday' => 'sunday',
                ];
                return $map[$v] ?? null;
            };
            $normalize_time = function($value) use ($normalize_time_simple) {
                $t = $normalize_time_simple($value);
                if (!$t) return null;
                if (!preg_match('/^\d{2}:\d{2}:\d{2}$/', $t)) {
                    $ts = strtotime((string)$value);
                    if ($ts === false) return null;
                    $t = date('H:i:s', $ts);
                }
                return $t;
            };
            $time_overlaps = function($startA, $endA, $startB, $endB) {
                return !($endA <= $startB || $startA >= $endB);
            };

            $scheduleLockNames = [];
            if (!$previewOnly) {
                $batchLockScopes = [];
                foreach ($rows as $row) {
                    if (!is_array($row)) continue;
                    $normalizedForLock = [];
                    foreach ($row as $key => $value) {
                        $normalizedKey = $normalize_header($key);
                        if ($normalizedKey !== '') $normalizedForLock[$normalizedKey] = $value;
                    }
                    $lockDay = $normalize_day($get_value($normalizedForLock, ['day_of_week', 'day', 'weekday', 'dow']));
                    if ($lockDay) {
                        $batchLockScopes[] = [
                            'semester_id' => (int)$targetSemesterId,
                            'day_of_week' => $lockDay,
                        ];
                    }
                }
                $scheduleLockNames = $acquire_schedule_locks($batchLockScopes);
            }

            $rooms_result = $mysqli->query("
                SELECT r.room_id, r.room_name, b.building_name, f.floor_name
                FROM tbl_rooms r
                LEFT JOIN tbl_floors f ON r.floor_id = f.floor_id
                LEFT JOIN tbl_buildings b ON COALESCE(r.building_id, f.building_id) = b.building_id
                LEFT JOIN tbl_school sc ON b.school_id = sc.school_id
                WHERE LOWER(TRIM(COALESCE(r.status, 'active'))) IN ('active', '1', 'true')
                  AND (f.floor_id IS NULL OR LOWER(TRIM(COALESCE(f.status, 'active'))) IN ('active', '1', 'true'))
                  AND (b.building_id IS NULL OR LOWER(TRIM(COALESCE(b.status, 'active'))) IN ('active', '1', 'true'))
                  AND (b.school_id IS NULL OR LOWER(TRIM(COALESCE(sc.status, ''))) IN ('active', '1', 'true'))
            ");
            if (!$rooms_result) json_response(['error' => 'Failed to load rooms', 'details' => $mysqli->error], 500);
            $roomById = [];
            $roomRows = $rooms_result->fetch_all(MYSQLI_ASSOC);
            foreach ($roomRows as $room) {
                $roomById[(string)$room['room_id']] = $room;
            }
            $roomByName = class_schedule_import_build_room_lookup($roomRows);

            $subjects_result = $mysqli->query("
                SELECT s.subject_id, s.subject_code, s.subject_name, s.program_id
                FROM tbl_subject s
                LEFT JOIN tbl_programs p ON s.program_id = p.program_id
                LEFT JOIN tbl_departments d ON p.dept_id = d.dept_id
                WHERE LOWER(TRIM(COALESCE(s.status, 'active'))) IN ('active', '1', 'true')
                  AND (p.program_id IS NULL OR LOWER(TRIM(COALESCE(p.status, 'active'))) IN ('active', '1', 'true'))
                  AND (d.dept_id IS NULL OR LOWER(TRIM(COALESCE(d.status, 'active'))) IN ('active', '1', 'true'))
            ");
            $sections_result = $mysqli->query("
                SELECT sec.section_id, sec.section_name, sec.program_id
                FROM tbl_sections sec
                LEFT JOIN tbl_programs p ON sec.program_id = p.program_id
                LEFT JOIN tbl_departments d ON p.dept_id = d.dept_id
                WHERE LOWER(TRIM(COALESCE(sec.status, 'active'))) IN ('active', '1', 'true')
                  AND (p.program_id IS NULL OR LOWER(TRIM(COALESCE(p.status, 'active'))) IN ('active', '1', 'true'))
                  AND (d.dept_id IS NULL OR LOWER(TRIM(COALESCE(d.status, 'active'))) IN ('active', '1', 'true'))
            ");
            $users_select = "user_id, role_id, first_name, last_name, email, dept_id";
            if ($usersHasAssignedProgramCol) $users_select .= ", assigned_program_head_id";
            if ($usersHasProgramIdCol) $users_select .= ", program_id";
            $teacherScopeSql = '';
            if ($isProgramHeadRole) {
                $require_program_head_scope();
                $teacherScopeSql = $usersHasAssignedProgramCol
                    ? ' AND assigned_program_head_id IN (' . implode(',', array_map('intval', $programHeadProgramIds)) . ')'
                    : ' AND 0 = 1';
            } elseif ($isDeanRole) {
                $require_dean_scope();
                $teacherScopeSql = ' AND dept_id = ' . (int)$authUserDeptId;
            }
            $users_result = $mysqli->query("
                SELECT {$users_select}
                FROM tbl_users
                WHERE role_id IN (2, 3, 4, 5)
                  AND LOWER(TRIM(COALESCE(status, 'active'))) IN ('active', '1', 'true')
                  {$teacherScopeSql}
            ");

            $subjById = []; $subjByCode = []; $subjByName = [];
            if ($subjects_result) {
                foreach ($subjects_result->fetch_all(MYSQLI_ASSOC) as $s) {
                    $subjById[(string)$s['subject_id']] = $s;
                    $programKey = (string)(int)($s['program_id'] ?? 0);
                    if (!isset($subjByCode[$programKey])) $subjByCode[$programKey] = [];
                    if (!isset($subjByName[$programKey])) $subjByName[$programKey] = [];
                    $subjByCode[$programKey][$normalize_lookup($s['subject_code'])] = $s;
                    $subjByName[$programKey][$normalize_lookup($s['subject_name'])] = $s;
                }
            }

            $secById = []; $secByName = [];
            if ($sections_result) {
                foreach ($sections_result->fetch_all(MYSQLI_ASSOC) as $s) {
                    $secById[(string)$s['section_id']] = $s;
                    $programKey = (string)(int)($s['program_id'] ?? 0);
                    if (!isset($secByName[$programKey])) $secByName[$programKey] = [];
                    $secByName[$programKey][$normalize_lookup($s['section_name'])] = $s;
                }
            }

            $resolve_teacher_program_id = function($teacher) use ($usersHasAssignedProgramCol, $usersHasProgramIdCol, $get_teacher_program_id) {
                if (!$teacher || !is_array($teacher)) return null;
                $roleId = isset($teacher['role_id']) ? (int)$teacher['role_id'] : 0;
                if (!in_array($roleId, [2, 3, 4, 5], true)) return null;
                if ($usersHasAssignedProgramCol && isset($teacher['assigned_program_head_id']) && $teacher['assigned_program_head_id'] !== null && (string)$teacher['assigned_program_head_id'] !== '') {
                    return (int)$teacher['assigned_program_head_id'];
                }
                if ($usersHasProgramIdCol && isset($teacher['program_id']) && $teacher['program_id'] !== null && (string)$teacher['program_id'] !== '') {
                    return (int)$teacher['program_id'];
                }
                if (isset($teacher['user_id'])) {
                    return $get_teacher_program_id((int)$teacher['user_id']);
                }
                return null;
            };

            $teacherById = []; $teacherByName = []; $teacherByEmail = [];
            if ($users_result) {
                foreach ($users_result->fetch_all(MYSQLI_ASSOC) as $u) {
                    $teacherById[(string)$u['user_id']] = $u;
                    $teacherNameKey = $normalize_lookup(trim(($u['first_name'] ?? '') . ' ' . ($u['last_name'] ?? '')));
                    if ($teacherNameKey !== '') {
                        if (!isset($teacherByName[$teacherNameKey])) $teacherByName[$teacherNameKey] = [];
                        $teacherByName[$teacherNameKey][] = $u;
                    }
                    if (!empty($u['email'])) $teacherByEmail[$normalize_lookup($u['email'])] = $u;
                }
            }

            $existingExact = [];
            $existingSectionSubjects = [];
            $existingResult = $mysqli->query("SELECT semester_id, room_id, subject_id, section_id, user_id, LOWER(TRIM(day_of_week)) AS day_of_week, TIME_FORMAT(start_time, '%H:%i:%s') AS start_time, TIME_FORMAT(end_time, '%H:%i:%s') AS end_time FROM tbl_class_schedules WHERE semester_id = " . (int)$targetSemesterId);
            if ($existingResult) {
                foreach ($existingResult->fetch_all(MYSQLI_ASSOC) as $ex) {
                    $k = $ex['semester_id'] . '|' . $ex['room_id'] . '|' . $ex['subject_id'] . '|' . $ex['section_id'] . '|' . (int)($ex['user_id'] ?? 0) . '|' . $ex['day_of_week'] . '|' . $ex['start_time'] . '|' . $ex['end_time'];
                    $existingExact[$k] = true;
                    $sectionSubjectKey = $ex['semester_id'] . '|' . $ex['day_of_week'] . '|' . $ex['section_id'] . '|' . $ex['subject_id'];
                    $existingSectionSubjects[$sectionSubjectKey] = true;
                }
            }
            $acceptedRows = [];

            $roomOverlapStmt = $mysqli->prepare("SELECT schedule_id FROM tbl_class_schedules WHERE semester_id = ? AND LOWER(TRIM(day_of_week)) = ? AND room_id = ? AND NOT (end_time <= ? OR start_time >= ?) LIMIT 1");
            $sectionOverlapStmt = $mysqli->prepare("SELECT schedule_id FROM tbl_class_schedules WHERE semester_id = ? AND LOWER(TRIM(day_of_week)) = ? AND section_id = ? AND NOT (end_time <= ? OR start_time >= ?) LIMIT 1");
            $teacherOverlapStmt = $mysqli->prepare("SELECT schedule_id, subject_id, start_time, end_time FROM tbl_class_schedules WHERE semester_id = ? AND LOWER(TRIM(day_of_week)) = ? AND user_id = ? AND NOT (end_time <= ? OR start_time >= ?)");

            $stmt = $mysqli->prepare("INSERT INTO tbl_class_schedules (user_id, semester_id, subject_id, section_id, room_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
            if (!$stmt) json_response(['error' => 'Failed to prepare schedule insert', 'details' => $mysqli->error], 500);

            foreach ($rows as $idx => $row) {
                $rowNumber = class_schedule_import_row_number((int)$idx, $spreadsheetImport);
                if (!is_array($row)) {
                    $errors[] = ['row' => $rowNumber, 'message' => 'Row is not a valid object'];
                    continue;
                }

                $normalized = [];
                foreach ($row as $key => $value) {
                    $nk = $normalize_header($key);
                    if ($nk !== '') $normalized[$nk] = $value;
                }

                $roomIdVal = $spreadsheetImport ? null : $get_value($normalized, ['room_id', 'roomid']);
                $roomNameVal = $spreadsheetImport
                    ? $get_value($normalized, ['room'])
                    : $get_value($normalized, ['room_name', 'room', 'room_no', 'room_number']);
                $room = null;
                $ambiguousRoom = false;
                if ($roomIdVal !== null && is_numeric($roomIdVal)) {
                    $room = $roomById[(string)(int)$roomIdVal] ?? null;
                }
                if (!$room && $roomNameVal !== null) {
                    $roomResolution = class_schedule_import_resolve_room($roomByName, $roomNameVal);
                    $room = $roomResolution['room'];
                    $ambiguousRoom = $roomResolution['status'] === 'ambiguous';
                }
                if ($ambiguousRoom) {
                    $errors[] = ['row' => $rowNumber, 'message' => 'Room name is ambiguous. Copy the complete Building — Floor — Room value from the template Reference sheet into the single Room column.'];
                    continue;
                }
                if (!$room) {
                    $errors[] = ['row' => $rowNumber, 'message' => 'Room was not found or is inactive/archived. Copy the Room value from the template Reference sheet.'];
                    continue;
                }

                // Resolve the instructor first. Their required Program assignment is
                // the per-row scope used to resolve otherwise duplicated subjects/sections.
                $teacher = null;
                $teacherIdVal = $spreadsheetImport ? null : $get_value($normalized, ['user_id', 'teacher_id']);
                $teacherFirstNameVal = $spreadsheetImport ? $get_value($normalized, ['first_name']) : null;
                $teacherLastNameVal = $spreadsheetImport ? $get_value($normalized, ['last_name']) : null;
                $teacherGenericVal = $spreadsheetImport
                    ? $get_value($normalized, ['teacher', 'teacher_email'])
                    : $get_value($normalized, ['teacher', 'teacher_email']);
                $teacherNameVal = $spreadsheetImport ? null : $get_value($normalized, ['teacher_name', 'teachername', 'name']);
                $ambiguousTeacherName = false;
                if ($teacherIdVal !== null && is_numeric($teacherIdVal)) {
                    $teacher = $teacherById[(string)(int)$teacherIdVal] ?? null;
                }
                if (!$teacher && $teacherGenericVal !== null) {
                    $teacherKey = $normalize_lookup($teacherGenericVal);
                    if (!$spreadsheetImport && is_numeric($teacherGenericVal)) $teacher = $teacherById[(string)(int)$teacherGenericVal] ?? null;
                    if (!$teacher) $teacher = $teacherByEmail[$teacherKey] ?? null;
                    if (!$spreadsheetImport && !$teacher && isset($teacherByName[$teacherKey])) {
                        if (count($teacherByName[$teacherKey]) === 1) $teacher = $teacherByName[$teacherKey][0];
                        else $ambiguousTeacherName = true;
                    }
                }
                if (!$teacher && !$ambiguousTeacherName && $teacherNameVal !== null) {
                    $teacherNameKey = $normalize_lookup($teacherNameVal);
                    if (isset($teacherByName[$teacherNameKey])) {
                        if (count($teacherByName[$teacherNameKey]) === 1) $teacher = $teacherByName[$teacherNameKey][0];
                        else $ambiguousTeacherName = true;
                    }
                }
                if ($ambiguousTeacherName) {
                    $errors[] = ['row' => $rowNumber, 'message' => 'Instructor name is ambiguous. Use the instructor ID or email.'];
                    $skipped++;
                    continue;
                }
                if (!$teacher) {
                    $errors[] = ['row' => $rowNumber, 'message' => $spreadsheetImport
                        ? 'Teacher Email is required and must match an active instructor in your allowed scope.'
                        : 'Instructor is required and must be active (not archived)'];
                    $skipped++;
                    continue;
                }

                if ($spreadsheetImport) {
                    if ($teacherFirstNameVal === null) {
                        $errors[] = ['row' => $rowNumber, 'message' => 'First Name is required.'];
                        $skipped++;
                        continue;
                    }
                    if ($teacherLastNameVal === null) {
                        $errors[] = ['row' => $rowNumber, 'message' => 'Last Name is required.'];
                        $skipped++;
                        continue;
                    }
                    $teacherNameMatch = class_schedule_import_teacher_names_match($teacher, $teacherFirstNameVal, $teacherLastNameVal);
                    if (empty($teacherNameMatch['first_name'])) {
                        $errors[] = ['row' => $rowNumber, 'message' => 'First Name does not match the account found using this Teacher Email.'];
                        $skipped++;
                        continue;
                    }
                    if (empty($teacherNameMatch['last_name'])) {
                        $errors[] = ['row' => $rowNumber, 'message' => 'Last Name does not match the account found using this Teacher Email.'];
                        $skipped++;
                        continue;
                    }
                }

                $teacherId = (int)$teacher['user_id'];
                $assigneeRoleId = (int)($teacher['role_id'] ?? 0);
                $teacherProgramId = $resolve_teacher_program_id($teacher);
                $teacherDeptId = isset($teacher['dept_id']) && $teacher['dept_id'] !== null ? (int)$teacher['dept_id'] : null;
                if (!$teacherProgramId) {
                    $errors[] = ['row' => $rowNumber, 'message' => 'Program mismatch: selected instructor has no Program assignment.'];
                    $skipped++;
                    continue;
                }
                $teacherProgramDeptId = $get_dept_id_for_program((int)$teacherProgramId);
                if ($teacherProgramDeptId === null || ($teacherDeptId !== null && (int)$teacherProgramDeptId !== (int)$teacherDeptId)) {
                    $errors[] = ['row' => $rowNumber, 'message' => 'Department mismatch: instructor Program does not belong to the instructor Department.'];
                    $skipped++;
                    continue;
                }
                if ($isProgramHeadRole) {
                    $require_program_head_scope();
                    if (!in_array((int)$teacherProgramId, $programHeadProgramIds, true)) {
                        $errors[] = ['row' => $rowNumber, 'message' => 'Program mismatch: you can only import schedules for your assigned Program.'];
                        $skipped++;
                        continue;
                    }
                }
                if ($isDeanRole) {
                    $require_dean_scope();
                    if ((int)$teacherProgramDeptId !== (int)$authUserDeptId) {
                        $errors[] = ['row' => $rowNumber, 'message' => 'Department mismatch: you can only import schedules for your assigned Department.'];
                        $skipped++;
                        continue;
                    }
                }

                $programKey = (string)(int)$teacherProgramId;
                $subject = null;
                $subjectIdVal = $spreadsheetImport ? null : $get_value($normalized, ['subject_id', 'subjectid']);
                $subjectCode = $spreadsheetImport
                    ? $get_value($normalized, ['subject', 'subject_code'])
                    : $get_value($normalized, ['subject_code', 'subjectcode', 'subject']);
                $subjectName = $spreadsheetImport ? null : $get_value($normalized, ['subject_name', 'subjectname']);
                if ($subjectIdVal !== null && is_numeric($subjectIdVal)) $subject = $subjById[(string)(int)$subjectIdVal] ?? null;
                if (!$subject && $subjectCode !== null) $subject = $subjByCode[$programKey][$normalize_lookup($subjectCode)] ?? null;
                if (!$subject && $subjectName !== null) $subject = $subjByName[$programKey][$normalize_lookup($subjectName)] ?? null;
                if (!$subject) {
                    $errors[] = ['row' => $rowNumber, 'message' => 'Subject was not found inside the instructor assigned Program, or it is inactive/archived.'];
                    $skipped++;
                    continue;
                }

                $section = null;
                $sectionIdVal = $spreadsheetImport ? null : $get_value($normalized, ['section_id', 'sectionid']);
                $sectionName = $spreadsheetImport
                    ? $get_value($normalized, ['section'])
                    : $get_value($normalized, ['section_name', 'section', 'sectionname']);
                if ($sectionIdVal !== null && is_numeric($sectionIdVal)) $section = $secById[(string)(int)$sectionIdVal] ?? null;
                if (!$section && $sectionName !== null) $section = $secByName[$programKey][$normalize_lookup($sectionName)] ?? null;
                if (!$section) {
                    $errors[] = ['row' => $rowNumber, 'message' => 'Section was not found inside the instructor assigned Program, or it is inactive/archived.'];
                    $skipped++;
                    continue;
                }

                $subjectProgramId = isset($subject['program_id']) && $subject['program_id'] !== null ? (int)$subject['program_id'] : null;
                $sectionProgramId = isset($section['program_id']) && $section['program_id'] !== null ? (int)$section['program_id'] : null;
                $rowProgramId = (int)$teacherProgramId;
                if (!$subjectProgramId || !$sectionProgramId || $subjectProgramId !== $rowProgramId || $sectionProgramId !== $rowProgramId) {
                    $errors[] = ['row' => $rowNumber, 'message' => 'Program mismatch: instructor, subject, and section must belong to the same Program.'];
                    $skipped++;
                    continue;
                }

                $semesterId = (int)$targetSemesterId;

                $day = $normalize_day($get_value($normalized, ['day_of_week', 'day', 'weekday', 'dow']));
                $startTime = $normalize_time($get_value($normalized, ['start_time', 'start', 'time_start', 'from']));
                $endTime = $normalize_time($get_value($normalized, ['end_time', 'end', 'time_end', 'to']));
                if (!$day || !$startTime || !$endTime) {
                    $errors[] = ['row' => $rowNumber, 'message' => 'day_of_week, start_time, and end_time are required'];
                    continue;
                }
                if ($day === 'sunday') {
                    $errors[] = ['row' => $rowNumber, 'message' => 'Sunday class schedules are not allowed. Choose Monday through Saturday.'];
                    $skipped++;
                    continue;
                }
                if ($startTime >= $endTime) {
                    $errors[] = ['row' => $rowNumber, 'message' => 'start_time must be before end_time'];
                    continue;
                }

                $roomIdForCheck = (int)$room['room_id'];
                $subjectIdForCheck = (int)$subject['subject_id'];
                $sectionIdForCheck = (int)$section['section_id'];
                $exactKey = $semesterId . '|' . $roomIdForCheck . '|' . $subjectIdForCheck . '|' . $sectionIdForCheck . '|' . $teacherId . '|' . $day . '|' . $startTime . '|' . $endTime;
                if (isset($existingExact[$exactKey])) {
                    $errors[] = ['row' => $rowNumber, 'message' => 'Duplicate schedule already exists'];
                    $skipped++;
                    continue;
                }
                $sectionSubjectKey = $semesterId . '|' . $day . '|' . $sectionIdForCheck . '|' . $subjectIdForCheck;
                if (isset($existingSectionSubjects[$sectionSubjectKey])) {
                    $errors[] = ['row' => $rowNumber, 'message' => 'Duplicate not allowed: this section already has this subject on the selected day.'];
                    $skipped++;
                    continue;
                }

                $conflict = false;
                foreach ($acceptedRows as $accepted) {
                    if ((int)$accepted['semester_id'] !== $semesterId) continue;
                    if ($accepted['day_of_week'] !== $day) continue;

                    // Only check conflicts when time blocks overlap
                    if (!$time_overlaps($startTime, $endTime, $accepted['start_time'], $accepted['end_time'])) continue;

                    // 1. Room Conflict in batch
                    if ((int)$accepted['room_id'] === $roomIdForCheck) {
                        $errors[] = ['row' => $rowNumber, 'message' => 'Room Conflict: Room already assigned in this batch during this time'];
                        $skipped++; $conflict = true; break;
                    }

                    // 2. Section Conflict in batch (Fixes Bug 2 in batches)
                    if ((int)$accepted['section_id'] === $sectionIdForCheck) {
                        $errors[] = ['row' => $rowNumber, 'message' => 'Section Conflict: Section already assigned to another class in this batch during this time'];
                        $skipped++; $conflict = true; break;
                    }

                    // 3. Teacher Parallel Class Check in batch (Fixes Bug 3 in batches)
                    if ((int)$accepted['teacher_id'] === $teacherId) {
                        $sameSubject = ((int)$accepted['subject_id'] === $subjectIdForCheck);
                        $sameExactTime = (string)$accepted['start_time'] === (string)$startTime && (string)$accepted['end_time'] === (string)$endTime;

                        if (!$sameSubject) {
                            $errors[] = ['row' => $rowNumber, 'message' => 'Teacher Conflict: Instructor assigned to a different subject at this time in batch'];
                            $skipped++; $conflict = true; break;
                        }
                        if ($sameSubject && !$sameExactTime) {
                            $errors[] = ['row' => $rowNumber, 'message' => 'Parallel Class Error: Times must match exactly for parallel classes in batch'];
                            $skipped++; $conflict = true; break;
                        }
                        // Same teacher, same subject, exact matching time -> PARALLEL CLASS ALLOWED!
                    }
                }
                if ($conflict) continue;

                // 1. Layer 1 Database Room Check
                if ($roomOverlapStmt) {
                    $roomOverlapStmt->bind_param('isiss', $semesterId, $day, $roomIdForCheck, $startTime, $endTime);
                    $roomOverlapStmt->execute();
                    if ($roomOverlapStmt->get_result()->fetch_assoc()) {
                        $errors[] = ['row' => $rowNumber, 'message' => 'Conflict: Room already has a class during this time.'];
                        $skipped++; $conflict = true;
                    }
                }
                if ($conflict) continue;

                // 2. Layer 1 Database Section Check
                if ($sectionOverlapStmt) {
                    $sectionOverlapStmt->bind_param('isiss', $semesterId, $day, $sectionIdForCheck, $startTime, $endTime);
                    $sectionOverlapStmt->execute();
                    if ($sectionOverlapStmt->get_result()->fetch_assoc()) {
                        $errors[] = ['row' => $rowNumber, 'message' => 'Section Conflict: This section is already scheduled for another class during this time.'];
                        $skipped++; $conflict = true;
                    }
                }
                if ($conflict) continue;

                // 3. Layer 1 Database Teacher / Parallel Check
                if ($teacherOverlapStmt) {
                    $teacherOverlapStmt->bind_param('isiss', $semesterId, $day, $teacherId, $startTime, $endTime);
                    $teacherOverlapStmt->execute();
                    $teacherConflicts = $teacherOverlapStmt->get_result()->fetch_all(MYSQLI_ASSOC);
                    $hasDifferentSubjectConflict = false;
                    $hasParallelTimeMismatch = false;
                    foreach ($teacherConflicts as $teacherConflict) {
                        if ((int)$teacherConflict['subject_id'] !== (int)$subjectIdForCheck) {
                            $hasDifferentSubjectConflict = true;
                            continue;
                        }
                        if ($teacherConflict['start_time'] !== $startTime || $teacherConflict['end_time'] !== $endTime) {
                            $hasParallelTimeMismatch = true;
                        }
                    }
                    if ($hasDifferentSubjectConflict) {
                        $errors[] = ['row' => $rowNumber, 'message' => 'Teacher Conflict: Instructor is already teaching a DIFFERENT subject at this time.'];
                        $skipped++; $conflict = true;
                    } elseif ($hasParallelTimeMismatch) {
                        $errors[] = ['row' => $rowNumber, 'message' => 'Parallel Class Error: Times must match exactly for parallel classes.'];
                        $skipped++; $conflict = true;
                    }
                }
                if ($conflict) continue;

                $acceptedRow = [
                    'semester_id' => $semesterId,
                    'room_id' => $roomIdForCheck,
                    'subject_id' => $subjectIdForCheck,
                    'section_id' => $sectionIdForCheck,
                    'teacher_id' => $teacherId,
                    'day_of_week' => $day,
                    'start_time' => $startTime,
                    'end_time' => $endTime
                ];
                if ($previewOnly || $spreadsheetImport) {
                    $existingExact[$exactKey] = true;
                    $existingSectionSubjects[$sectionSubjectKey] = true;
                    $acceptedRows[] = $acceptedRow;
                    $inserted++;
                    continue;
                }
                $stmt->bind_param('iiiiisss', $teacherId, $semesterId, $subjectIdForCheck, $sectionIdForCheck, $roomIdForCheck, $day, $startTime, $endTime);
                if (!$stmt->execute()) {
                    $errors[] = ['row' => $rowNumber, 'message' => 'Insert failed: ' . $stmt->error];
                    $skipped++;
                    continue;
                }

                $existingExact[$exactKey] = true;
                $existingSectionSubjects[$sectionSubjectKey] = true;
                $acceptedRows[] = $acceptedRow;
                $createdScheduleIds[] = (int)$stmt->insert_id;
                $inserted++;
            }

            $attendanceSync = ['ok' => true, 'generated_rows' => 0, 'errors' => []];

            // Spreadsheet imports are atomic: validate every row first, then create
            // schedules and attendance in one transaction. Manual Batch Add keeps
            // its established partial-row behavior and ID-based payload support.
            if ($spreadsheetImport && !$previewOnly) {
                $skipped = class_schedule_import_skipped_count(count($rows), count($acceptedRows));
                if (!empty($errors)) {
                    if ($scheduleLockNames) $release_schedule_locks($scheduleLockNames);
                    json_response([
                        'preview' => false,
                        'inserted' => 0,
                        'skipped' => count($rows),
                        'total' => count($rows),
                        'errors' => $errors,
                        'message' => 'Import cancelled. Fix every invalid row; no schedules or attendance records were created.',
                        'attendance_sync' => $attendanceSync,
                    ], 422);
                }

                $inserted = 0;
                try {
                    if (!$mysqli->begin_transaction()) {
                        throw new RuntimeException('Could not start the schedule import transaction.');
                    }
                    foreach ($acceptedRows as $acceptedRow) {
                        $teacherId = (int)$acceptedRow['teacher_id'];
                        $semesterId = (int)$acceptedRow['semester_id'];
                        $subjectId = (int)$acceptedRow['subject_id'];
                        $sectionId = (int)$acceptedRow['section_id'];
                        $roomId = (int)$acceptedRow['room_id'];
                        $day = (string)$acceptedRow['day_of_week'];
                        $startTime = (string)$acceptedRow['start_time'];
                        $endTime = (string)$acceptedRow['end_time'];
                        $stmt->bind_param('iiiiisss', $teacherId, $semesterId, $subjectId, $sectionId, $roomId, $day, $startTime, $endTime);
                        if (!$stmt->execute()) {
                            throw new RuntimeException('Schedule insert failed: ' . $stmt->error);
                        }
                        $createdScheduleIds[] = (int)$stmt->insert_id;
                        $inserted++;
                    }

                    if (!empty($createdScheduleIds) && $activeSemesterId && (int)$targetSemesterId === (int)$activeSemesterId) {
                        $attendanceSync = cw_generate_attendance_records($mysqli, $createdScheduleIds, 0, 6);
                        if (empty($attendanceSync['ok'])) {
                            throw new RuntimeException('Attendance generation failed: ' . implode(' | ', $attendanceSync['errors'] ?? []));
                        }
                    } elseif (!empty($createdScheduleIds)) {
                        $attendanceSync['planning_only'] = true;
                    }
                    $mysqli->commit();
                } catch (Throwable $importFailure) {
                    $mysqli->rollback();
                    if ($scheduleLockNames) $release_schedule_locks($scheduleLockNames);
                    error_log('[class-schedules] Atomic spreadsheet import rolled back: ' . $importFailure->getMessage());
                    json_response([
                        'error' => 'schedule_import_rolled_back',
                        'message' => 'Class schedule import failed. No schedules or attendance records were created.',
                        'inserted' => 0,
                        'skipped' => count($rows),
                        'total' => count($rows),
                        'errors' => [],
                        'attendance_sync' => ['ok' => false, 'generated_rows' => 0, 'errors' => ['Import rolled back']],
                    ], 500);
                }
            } elseif (!$previewOnly && !empty($createdScheduleIds) && $activeSemesterId && (int)$targetSemesterId === (int)$activeSemesterId) {
                $attendanceSync = cw_generate_attendance_records($mysqli, $createdScheduleIds, 0, 6);
                if (!$attendanceSync['ok']) {
                    error_log('[class-schedules] Immediate attendance generation failed after batch import: ' . implode(' | ', $attendanceSync['errors']));
                }
            } elseif (!$previewOnly && !empty($createdScheduleIds)) {
                $attendanceSync['planning_only'] = true;
            }

            $skipped = class_schedule_import_skipped_count(count($rows), $inserted);

            if ($scheduleLockNames) {
                $release_schedule_locks($scheduleLockNames);
            }

            if (!$previewOnly && $inserted > 0) {
                $actionName = $spreadsheetImport ? 'import_class_schedules' : 'batch_create_schedules';
                $details = $spreadsheetImport
                    ? "Imported {$inserted} class schedule(s) with " . (int)($attendanceSync['generated_rows'] ?? 0) . ' attendance record(s)'
                    : "Batch added {$inserted} class schedule(s)";
                log_system_action($mysqli, $authUserId, $actionName, $details);
            }

            json_response([
                'preview' => $previewOnly,
                'inserted' => $inserted,
                'skipped' => $skipped,
                'total' => count($rows),
                'errors' => $errors,
                'semester_id' => (int)$targetSemesterId,
                'planning_only' => !($activeSemesterId && (int)$targetSemesterId === (int)$activeSemesterId),
                'attendance_sync' => $attendanceSync,
            ]);
        } elseif ($request_method === 'POST') {
            $require_schedule_manage_access();
            $create_schedule();
        }
        break;

    default:
        // This case should ideally not be reached if the main index.php router is correct
        json_response(['error' => 'Endpoint not found in main API file.'], 404);
        break;
}
