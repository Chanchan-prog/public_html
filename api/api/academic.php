<?php
require_once __DIR__ . '/../helpers/socket_helper.php';
require_once __DIR__ . '/../helpers/log_helper.php'; // Required for system logs

global $mysqli, $authPayload;

$request_method = $_SERVER['REQUEST_METHOD'];
$input = get_input();

$auth = is_array($authPayload) ? $authPayload : app_get_authenticated_session(true);
$authUserId = (int)($auth['user_id'] ?? 0);
$authRole = (int)($auth['role_id'] ?? 0);
$authDeptId = isset($auth['dept_id']) && $auth['dept_id'] !== null ? (int)$auth['dept_id'] : null;

$getProgramScopeRow = function(int $programId) use ($mysqli) {
    $stmt = $mysqli->prepare("SELECT program_id, dept_id, head_id FROM tbl_programs WHERE program_id = ? LIMIT 1");
    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $stmt->bind_param('i', $programId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    if (!$row) return null;
    return [
        'program_id' => isset($row['program_id']) ? (int)$row['program_id'] : null,
        'dept_id' => isset($row['dept_id']) && $row['dept_id'] !== null ? (int)$row['dept_id'] : null,
        'head_id' => isset($row['head_id']) && $row['head_id'] !== null ? (int)$row['head_id'] : null,
    ];
};

$requireAcademicManageAccess = function(string $resourceLabel) use ($authRole) {
    if (in_array((int)$authRole, [1, 6], true)) return;
    json_response(['error' => 'forbidden', 'message' => "Only Admin and Department Admin can manage {$resourceLabel}."], 403);
};

$requireAcademicCreateAccess = function(string $resourceLabel) use ($authRole) {
    if (in_array((int)$authRole, [1, 6], true)) return;
    json_response(['error' => 'forbidden', 'message' => "Only Admin and Department Admin can create {$resourceLabel}."], 403);
};

$assertProgramScopeAccess = function(int $programId, string $resourceLabel) use ($authRole, $authDeptId, $getProgramScopeRow) {
    $program = $getProgramScopeRow($programId);
    if (!$program) {
        json_response(['error' => 'invalid_program_id', 'message' => 'Selected program does not exist'], 400);
    }

    if ((int)$authRole === 1) return $program;

    if ((int)$authRole === 6) {
        if ($authDeptId === null) {
            json_response(['error' => 'forbidden', 'message' => 'This account is not assigned to a department.'], 403);
        }
        if ((int)($program['dept_id'] ?? 0) !== (int)$authDeptId) {
            json_response(['error' => 'forbidden', 'message' => "You can only manage {$resourceLabel} within programs in your assigned department."], 403);
        }
        return $program;
    }

    json_response(['error' => 'forbidden', 'message' => "Only Admin and Department Admin can manage {$resourceLabel}."], 403);
};

$assertSubjectScopeAccess = function(int $subjectId, string $resourceLabel) use ($mysqli, $assertProgramScopeAccess) {
    $stmt = $mysqli->prepare("SELECT program_id FROM tbl_subject WHERE subject_id = ? LIMIT 1");
    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $stmt->bind_param('i', $subjectId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    if (!$row) json_response(['error' => 'invalid_subject_id', 'message' => 'Selected subject does not exist'], 400);
    return $assertProgramScopeAccess((int)$row['program_id'], $resourceLabel);
};

$assertSectionScopeAccess = function(int $sectionId, string $resourceLabel) use ($mysqli, $assertProgramScopeAccess) {
    $stmt = $mysqli->prepare("SELECT program_id FROM tbl_sections WHERE section_id = ? LIMIT 1");
    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $stmt->bind_param('i', $sectionId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    if (!$row) json_response(['error' => 'invalid_section_id', 'message' => 'Selected section does not exist'], 400);
    return $assertProgramScopeAccess((int)$row['program_id'], $resourceLabel);
};

$assertAcademicTeacherScope = function(?int $teacherId) use ($mysqli, $authRole, $authDeptId) {
    if ($teacherId === null || $teacherId <= 0 || (int)$authRole === 1) return;
    $stmt = $mysqli->prepare("SELECT dept_id FROM tbl_users WHERE user_id = ? LIMIT 1");
    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $stmt->bind_param('i', $teacherId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    if (!$row || $authDeptId === null || !isset($row['dept_id']) || (int)$row['dept_id'] !== (int)$authDeptId) {
        json_response(['error' => 'forbidden', 'message' => 'The selected teacher is outside your department.'], 403);
    }
};

$academicColumnExists = function(string $table, string $column) use ($mysqli): bool {
    $tbl = $mysqli->real_escape_string($table);
    $col = $mysqli->real_escape_string($column);
    $res = $mysqli->query("SHOW COLUMNS FROM `{$tbl}` LIKE '{$col}'");
    return $res && $res->num_rows > 0;
};

$academicStatusIsActive = function($value): bool {
    return in_array(strtolower(trim((string)$value)), ['active', '1', 'true'], true);
};
$normalizeAcademicRecordStatus = function($value): string {
    $status = strtolower(trim((string)$value));
    if (!in_array($status, ['active', 'inactive', 'archive'], true)) {
        json_response([
            'error' => 'invalid_status',
            'message' => 'Status must be active, inactive, or archive.',
        ], 422);
    }
    return $status;
};

$academicArchiveDefinitions = [
    'department' => ['table' => 'tbl_departments', 'id_column' => 'dept_id', 'label' => 'department'],
    'program' => ['table' => 'tbl_programs', 'id_column' => 'program_id', 'label' => 'program'],
    'subject' => ['table' => 'tbl_subject', 'id_column' => 'subject_id', 'label' => 'subject'],
    'section' => ['table' => 'tbl_sections', 'id_column' => 'section_id', 'label' => 'section'],
];

$getAcademicArchiveDependencies = function(string $entity, int $recordId) use ($mysqli, $academicArchiveDefinitions, $academicColumnExists): array {
    if (!isset($academicArchiveDefinitions[$entity]) || $recordId <= 0) return [];

    $definition = $academicArchiveDefinitions[$entity];
    $idColumn = $definition['id_column'];
    $ownTable = $definition['table'];
    $dependencies = [];

    $columnStmt = $mysqli->prepare("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = ? AND TABLE_NAME <> ? ORDER BY TABLE_NAME");
    if (!$columnStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $columnStmt->bind_param('ss', $idColumn, $ownTable);
    $columnStmt->execute();
    $tables = $columnStmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $columnStmt->close();

    foreach ($tables as $tableRow) {
        $table = (string)($tableRow['TABLE_NAME'] ?? '');
        if ($table === '' || !preg_match('/^[A-Za-z0-9_]+$/', $table)) continue;
        $countStmt = $mysqli->prepare("SELECT COUNT(*) AS total FROM `{$table}` WHERE `{$idColumn}` = ?");
        if (!$countStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        $countStmt->bind_param('i', $recordId);
        $countStmt->execute();
        $count = (int)($countStmt->get_result()->fetch_assoc()['total'] ?? 0);
        $countStmt->close();
        if ($count > 0) $dependencies[$table] = $count;
    }

    // Program-head ownership uses a differently named foreign-key column.
    if ($entity === 'program' && $academicColumnExists('tbl_users', 'assigned_program_head_id')) {
        $headStmt = $mysqli->prepare("SELECT COUNT(*) AS total FROM tbl_users WHERE assigned_program_head_id = ?");
        if (!$headStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        $headStmt->bind_param('i', $recordId);
        $headStmt->execute();
        $headCount = (int)($headStmt->get_result()->fetch_assoc()['total'] ?? 0);
        $headStmt->close();
        if ($headCount > 0) $dependencies['tbl_users (program heads)'] = $headCount;
    }

    return $dependencies;
};

$assertAcademicArchiveAllowed = function(string $entity, int $recordId) use ($academicArchiveDefinitions, $getAcademicArchiveDependencies): void {
    $dependencies = $getAcademicArchiveDependencies($entity, $recordId);
    if (!$dependencies) return;

    $parts = [];
    foreach ($dependencies as $table => $count) $parts[] = "{$table}: {$count}";
    $label = $academicArchiveDefinitions[$entity]['label'] ?? 'record';
    json_response([
        'error' => 'record_in_use',
        'message' => "Cannot archive this {$label} because related records still exist. Set it to inactive instead.",
        'dependencies' => $dependencies,
        'dependency_summary' => implode(', ', $parts),
    ], 409);
};

$prepareAcademicStatusTransition = function(string $entity, int $recordId, $currentValue, $requestedValue) use ($normalizeAcademicRecordStatus, $assertAcademicArchiveAllowed): string {
    $current = strtolower(trim((string)$currentValue));
    $next = $normalizeAcademicRecordStatus($requestedValue);

    if ($current === 'archive') {
        if ($next !== 'inactive') {
            json_response([
                'error' => 'archived_record_locked',
                'message' => 'Archived records can only be restored to inactive before they are edited or activated.',
            ], 409);
        }
        return 'inactive';
    }

    if ($next === 'archive') $assertAcademicArchiveAllowed($entity, $recordId);
    return $next;
};

$assertAcademicArchivedUpdateAllowed = function($currentValue, array $payload) use ($normalizeAcademicRecordStatus): void {
    if (strtolower(trim((string)$currentValue)) !== 'archive') return;
    $keys = array_values(array_diff(array_keys($payload), ['status']));
    $next = array_key_exists('status', $payload) ? $normalizeAcademicRecordStatus($payload['status']) : '';
    if ($keys || $next !== 'inactive') {
        json_response([
            'error' => 'archived_record_locked',
            'message' => 'Archived records are read-only. Restore this record to inactive before editing it.',
        ], 409);
    }
};

$assertActiveDepartment = function(?int $deptId) use ($mysqli, $academicStatusIsActive): void {
    if ($deptId === null || $deptId <= 0) return;
    $stmt = $mysqli->prepare("SELECT dept_id, status FROM tbl_departments WHERE dept_id = ? LIMIT 1");
    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $stmt->bind_param('i', $deptId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!$row) json_response(['error' => 'invalid_dept_id', 'message' => 'Selected department does not exist.'], 400);
    if (!$academicStatusIsActive($row['status'] ?? null)) {
        json_response(['error' => 'inactive_department', 'message' => 'Selected department is inactive or archived. Choose an active department.'], 409);
    }
};

$assertActiveProgramHierarchy = function(int $programId) use ($mysqli, $academicStatusIsActive): void {
    $stmt = $mysqli->prepare("SELECT p.program_id, p.status AS program_status, d.dept_id, d.status AS department_status FROM tbl_programs p LEFT JOIN tbl_departments d ON d.dept_id = p.dept_id WHERE p.program_id = ? LIMIT 1");
    if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $stmt->bind_param('i', $programId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!$row) json_response(['error' => 'invalid_program_id', 'message' => 'Selected program does not exist.'], 400);
    if (!$academicStatusIsActive($row['program_status'] ?? null)) {
        json_response(['error' => 'inactive_program', 'message' => 'Selected program is inactive or archived. Choose an active program.'], 409);
    }
    if (empty($row['dept_id']) || !$academicStatusIsActive($row['department_status'] ?? null)) {
        json_response(['error' => 'inactive_program_department', 'message' => 'The selected program belongs to an inactive, archived, or missing department.'], 409);
    }
};

$assertActiveOfferingDependencies = function(int $semesterId, int $subjectId, int $sectionId, ?int $teacherId) use ($mysqli, $academicStatusIsActive): void {
    $semStmt = $mysqli->prepare("SELECT sem.semester_id, sem.status AS semester_status, sy.school_year_id, sy.status AS school_year_status FROM tbl_semesters sem LEFT JOIN tbl_school_year sy ON sy.school_year_id = sem.school_year_id WHERE sem.semester_id = ? LIMIT 1");
    if (!$semStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $semStmt->bind_param('i', $semesterId); $semStmt->execute(); $semester = $semStmt->get_result()->fetch_assoc(); $semStmt->close();
    if (!$semester || !$academicStatusIsActive($semester['semester_status'] ?? null) || empty($semester['school_year_id']) || !$academicStatusIsActive($semester['school_year_status'] ?? null)) {
        json_response(['error' => 'inactive_semester', 'message' => 'Selected semester or its school year is inactive or archived.'], 409);
    }

    $subjectStmt = $mysqli->prepare("SELECT s.status AS subject_status, s.program_id, p.status AS program_status, p.dept_id, d.status AS department_status FROM tbl_subject s LEFT JOIN tbl_programs p ON p.program_id = s.program_id LEFT JOIN tbl_departments d ON d.dept_id = p.dept_id WHERE s.subject_id = ? LIMIT 1");
    if (!$subjectStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $subjectStmt->bind_param('i', $subjectId); $subjectStmt->execute(); $subject = $subjectStmt->get_result()->fetch_assoc(); $subjectStmt->close();
    if (!$subject || !$academicStatusIsActive($subject['subject_status'] ?? null) || !$academicStatusIsActive($subject['program_status'] ?? null) || !$academicStatusIsActive($subject['department_status'] ?? null)) {
        json_response(['error' => 'inactive_subject', 'message' => 'Selected subject, program, or department is inactive or archived.'], 409);
    }

    $sectionStmt = $mysqli->prepare("SELECT sec.status AS section_status, sec.program_id, p.status AS program_status, p.dept_id, d.status AS department_status FROM tbl_sections sec LEFT JOIN tbl_programs p ON p.program_id = sec.program_id LEFT JOIN tbl_departments d ON d.dept_id = p.dept_id WHERE sec.section_id = ? LIMIT 1");
    if (!$sectionStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $sectionStmt->bind_param('i', $sectionId); $sectionStmt->execute(); $section = $sectionStmt->get_result()->fetch_assoc(); $sectionStmt->close();
    if (!$section || !$academicStatusIsActive($section['section_status'] ?? null) || !$academicStatusIsActive($section['program_status'] ?? null) || !$academicStatusIsActive($section['department_status'] ?? null)) {
        json_response(['error' => 'inactive_section', 'message' => 'Selected section, program, or department is inactive or archived.'], 409);
    }
    if ((int)($subject['program_id'] ?? 0) !== (int)($section['program_id'] ?? 0)) {
        json_response(['error' => 'program_mismatch', 'message' => 'Subject and section must belong to the same active program.'], 409);
    }

    if ($teacherId !== null && $teacherId > 0) {
        $teacherStmt = $mysqli->prepare("SELECT role_id, status FROM tbl_users WHERE user_id = ? LIMIT 1");
        if (!$teacherStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
        $teacherStmt->bind_param('i', $teacherId); $teacherStmt->execute(); $teacher = $teacherStmt->get_result()->fetch_assoc(); $teacherStmt->close();
        if (!$teacher || !$academicStatusIsActive($teacher['status'] ?? null) || !in_array((int)($teacher['role_id'] ?? 0), [2, 3, 4, 5], true)) {
            json_response(['error' => 'inactive_teacher', 'message' => 'Selected teacher is inactive, archived, missing, or cannot teach classes.'], 409);
        }
    }
};

$syncDepartmentDeanUser = function(int $deptId, ?int $newDeanId, ?int $oldDeanId = null) use ($mysqli) {
    if ($newDeanId !== null && $newDeanId > 0) {
        $setNew = $mysqli->prepare("UPDATE tbl_users SET dept_id = ? WHERE user_id = ? AND role_id = 2");
        if ($setNew) {
            $setNew->bind_param('ii', $deptId, $newDeanId);
            $setNew->execute();
        }
    }
    if ((int)$newDeanId !== (int)$oldDeanId) {
        foreach (array_unique(array_filter([(int)$newDeanId, (int)$oldDeanId])) as $affectedUserId) {
            app_revoke_user_sessions($mysqli, $affectedUserId);
        }
    }
};

$validateProgramHeadOwner = function(?int $headId, int $programId, ?int $deptId = null) use ($mysqli, $authRole, $authDeptId, $academicStatusIsActive) {
    if ($headId === null || $headId <= 0) return;

    $uq = $mysqli->prepare("SELECT user_id, role_id, dept_id, status FROM tbl_users WHERE user_id = ? LIMIT 1");
    if (!$uq) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
    $uq->bind_param('i', $headId);
    $uq->execute();
    $urow = $uq->get_result()->fetch_assoc();
    if (!$urow) json_response(['error' => 'invalid_program_head', 'message' => 'Selected program head user does not exist.'], 400);
    if ((int)($urow['role_id'] ?? 0) !== 3) json_response(['error' => 'invalid_program_head_role', 'message' => 'Selected user is not a program head.'], 400);
    if (!$academicStatusIsActive($urow['status'] ?? null)) json_response(['error' => 'inactive_program_head', 'message' => 'Selected program head is inactive or archived. Choose an active user.'], 409);
    if ((int)$authRole === 6) {
        $headDeptId = isset($urow['dept_id']) && $urow['dept_id'] !== null ? (int)$urow['dept_id'] : null;
        if ($authDeptId === null || $deptId === null || (int)$deptId !== (int)$authDeptId || $headDeptId === null || (int)$headDeptId !== (int)$authDeptId) {
            json_response(['error' => 'forbidden', 'message' => 'Department Admin can assign only Program Heads already inside their own department.'], 403);
        }
    }
};

$syncProgramHeadUser = function(int $programId, ?int $deptId, ?int $newHeadId, ?int $oldHeadId = null) use ($mysqli, $academicColumnExists) {
    if (!$academicColumnExists('tbl_users', 'assigned_program_head_id')) return;

    if ($newHeadId !== null && $newHeadId > 0) {
        $setUser = $mysqli->prepare("UPDATE tbl_users SET dept_id = ?, assigned_program_head_id = ? WHERE user_id = ? AND role_id = 3");
        if ($setUser) {
            $setUser->bind_param('iii', $deptId, $programId, $newHeadId);
            $setUser->execute();
        }
    }
    if ((int)$newHeadId !== (int)$oldHeadId) {
        foreach (array_unique(array_filter([(int)$newHeadId, (int)$oldHeadId])) as $affectedUserId) {
            app_revoke_user_sessions($mysqli, $affectedUserId);
        }
    }
};

$normalizeLeaderIds = function($value): array {
    if (!is_array($value)) return [];
    $ids = [];
    foreach ($value as $candidate) {
        $id = (int)$candidate;
        if ($id > 0) $ids[$id] = true;
    }
    return array_keys($ids);
};

$validateLeaderUsers = function(array $userIds, int $requiredRole, string $label) use ($mysqli, $academicStatusIsActive): void {
    if (empty($userIds)) return;
    $idSql = implode(',', array_map('intval', $userIds));
    $result = $mysqli->query("SELECT user_id, role_id, status FROM tbl_users WHERE user_id IN ({$idSql})");
    if (!$result) json_response(['error' => 'leader_validation_failed', 'message' => $mysqli->error], 500);
    $valid = [];
    while ($row = $result->fetch_assoc()) {
        if ((int)($row['role_id'] ?? 0) === $requiredRole && $academicStatusIsActive($row['status'] ?? null)) $valid[(int)$row['user_id']] = true;
    }
    foreach ($userIds as $userId) {
        if (!isset($valid[(int)$userId])) {
            json_response(['error' => 'invalid_leader_role', 'message' => "Selected {$label} user is inactive, archived, missing, or has the wrong role."], 400);
        }
    }
};

$assertDeanAssignmentsAvailable = function(array $userIds, ?int $targetDeptId) use ($mysqli): void {
    if (empty($userIds)) return;
    $idSql = implode(',', array_map('intval', $userIds));
    $result = $mysqli->query("SELECT u.user_id, u.first_name, u.last_name, u.dept_id, d.dept_name
        FROM tbl_users u
        LEFT JOIN tbl_departments d ON d.dept_id = u.dept_id
        WHERE u.user_id IN ({$idSql}) AND u.role_id = 2");
    if (!$result) json_response(['error' => 'leader_assignment_check_failed', 'message' => $mysqli->error], 500);
    while ($row = $result->fetch_assoc()) {
        $assignedDeptId = isset($row['dept_id']) && $row['dept_id'] !== null ? (int)$row['dept_id'] : null;
        if ($assignedDeptId !== null && ($targetDeptId === null || $assignedDeptId !== $targetDeptId)) {
            $name = trim((string)($row['first_name'] ?? '') . ' ' . (string)($row['last_name'] ?? '')) ?: 'Selected Dean';
            $department = trim((string)($row['dept_name'] ?? '')) ?: 'another department';
            json_response([
                'error' => 'dean_already_assigned',
                'message' => "{$name} is already assigned to {$department}. Transfer the Dean from the User page before assigning them here.",
            ], 409);
        }
    }
};

$assertProgramHeadAssignmentsAvailable = function(array $userIds, ?int $targetProgramId, ?int $targetDeptId) use ($mysqli, $academicColumnExists): void {
    if (empty($userIds)) return;
    if (!$academicColumnExists('tbl_users', 'assigned_program_head_id')) {
        json_response(['error' => 'schema_mismatch', 'message' => 'Database is missing assigned_program_head_id. Run the latest SQL migration first.'], 500);
    }
    $idSql = implode(',', array_map('intval', $userIds));
    $result = $mysqli->query("SELECT u.user_id, u.first_name, u.last_name, u.dept_id, u.assigned_program_head_id, p.program_name, d.dept_name
        FROM tbl_users u
        LEFT JOIN tbl_programs p ON p.program_id = u.assigned_program_head_id
        LEFT JOIN tbl_departments d ON d.dept_id = u.dept_id
        WHERE u.user_id IN ({$idSql}) AND u.role_id = 3");
    if (!$result) json_response(['error' => 'leader_assignment_check_failed', 'message' => $mysqli->error], 500);
    while ($row = $result->fetch_assoc()) {
        $name = trim((string)($row['first_name'] ?? '') . ' ' . (string)($row['last_name'] ?? '')) ?: 'Selected Program Head';
        $assignedProgramId = isset($row['assigned_program_head_id']) && $row['assigned_program_head_id'] !== null
            ? (int)$row['assigned_program_head_id']
            : null;
        if ($assignedProgramId !== null && ($targetProgramId === null || $assignedProgramId !== $targetProgramId)) {
            $program = trim((string)($row['program_name'] ?? '')) ?: 'another program';
            json_response([
                'error' => 'program_head_already_assigned',
                'message' => "{$name} is already assigned to {$program}. Transfer the Program Head from the User page before assigning them here.",
            ], 409);
        }
        $assignedDeptId = isset($row['dept_id']) && $row['dept_id'] !== null ? (int)$row['dept_id'] : null;
        if ($targetDeptId !== null && $assignedDeptId !== null && $assignedDeptId !== $targetDeptId) {
            $department = trim((string)($row['dept_name'] ?? '')) ?: 'another department';
            json_response([
                'error' => 'program_head_department_mismatch',
                'message' => "{$name} belongs to {$department}. Transfer the Program Head from the User page before assigning them to this program.",
            ], 409);
        }
    }
};

$syncDepartmentDeanUsers = function(int $deptId, array $deanIds) use ($mysqli): void {
    $requestedIds = array_values(array_unique(array_filter(array_map('intval', $deanIds))));
    $currentIds = [];
    $current = $mysqli->query("SELECT user_id FROM tbl_users WHERE role_id = 2 AND dept_id = {$deptId}");
    if ($current) while ($row = $current->fetch_assoc()) $currentIds[] = (int)$row['user_id'];
    $idSql = empty($deanIds) ? '' : implode(',', array_map('intval', $deanIds));
    $excludeSql = $idSql !== '' ? " AND user_id NOT IN ({$idSql})" : '';
    if (!$mysqli->query("UPDATE tbl_users SET dept_id = NULL WHERE role_id = 2 AND dept_id = {$deptId}{$excludeSql}")) {
        throw new RuntimeException($mysqli->error);
    }
    if ($idSql !== '') {
        if (!$mysqli->query("UPDATE tbl_users SET dept_id = {$deptId} WHERE role_id = 2 AND user_id IN ({$idSql})")) {
            throw new RuntimeException($mysqli->error);
        }
        $mysqli->query("UPDATE tbl_departments d SET d.dean_id = (SELECT MIN(u.user_id) FROM tbl_users u WHERE u.role_id = 2 AND u.dept_id = d.dept_id) WHERE d.dept_id <> {$deptId} AND d.dean_id IN ({$idSql})");
    }
    $affectedIds = array_values(array_unique(array_merge(
        array_diff($currentIds, $requestedIds),
        array_diff($requestedIds, $currentIds)
    )));
    foreach ($affectedIds as $affectedUserId) app_revoke_user_sessions($mysqli, $affectedUserId);
};

$syncProgramHeadUsers = function(int $programId, ?int $deptId, array $headIds) use ($mysqli, $academicColumnExists): void {
    if (!$academicColumnExists('tbl_users', 'assigned_program_head_id')) return;
    $requestedIds = array_values(array_unique(array_filter(array_map('intval', $headIds))));
    $currentIds = [];
    $current = $mysqli->query("SELECT user_id FROM tbl_users WHERE role_id = 3 AND assigned_program_head_id = {$programId}");
    if ($current) while ($row = $current->fetch_assoc()) $currentIds[] = (int)$row['user_id'];
    $idSql = empty($headIds) ? '' : implode(',', array_map('intval', $headIds));
    $excludeSql = $idSql !== '' ? " AND user_id NOT IN ({$idSql})" : '';
    if (!$mysqli->query("UPDATE tbl_users SET assigned_program_head_id = NULL WHERE role_id = 3 AND assigned_program_head_id = {$programId}{$excludeSql}")) {
        throw new RuntimeException($mysqli->error);
    }
    if ($idSql !== '') {
        $deptValue = $deptId === null ? 'NULL' : (string)(int)$deptId;
        if (!$mysqli->query("UPDATE tbl_users SET dept_id = {$deptValue}, assigned_program_head_id = {$programId} WHERE role_id = 3 AND user_id IN ({$idSql})")) {
            throw new RuntimeException($mysqli->error);
        }
        $mysqli->query("UPDATE tbl_programs p SET p.head_id = (SELECT MIN(u.user_id) FROM tbl_users u WHERE u.role_id = 3 AND u.assigned_program_head_id = p.program_id) WHERE p.program_id <> {$programId} AND p.head_id IN ({$idSql})");
    }
    $affectedIds = array_values(array_unique(array_merge(
        array_diff($currentIds, $requestedIds),
        array_diff($requestedIds, $currentIds)
    )));
    foreach ($affectedIds as $affectedUserId) app_revoke_user_sessions($mysqli, $affectedUserId);
};

$programHeadScopeCondition = function(string $programAlias = 'p') use ($authUserId): string {
    $alias = preg_replace('/[^a-zA-Z0-9_]/', '', $programAlias) ?: 'p';
    $userId = (int)$authUserId;
    return "EXISTS (
        SELECT 1 FROM tbl_users ph_scope
        WHERE ph_scope.user_id = {$userId}
          AND ph_scope.role_id = 3
          AND ph_scope.assigned_program_head_id = {$alias}.program_id
    )";
};
// =================================================================================

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$parts = explode('/', $path);
$api_prefix_key = array_search('api', $parts);
$endpoint = $parts[$api_prefix_key + 1] ?? null;
$param1 = $parts[$api_prefix_key + 2] ?? null;
$param2 = $parts[$api_prefix_key + 3] ?? null;

switch ($endpoint) {
    case 'departments':
        if ($request_method === 'GET') {
            $departmentWhere = ((int)$authRole === 6 && $authDeptId !== null)
                ? ' WHERE d.dept_id = ' . (int)$authDeptId
                : '';
            if ((int)$authRole === 6 && $authDeptId === null) json_response([]);
            $result = $mysqli->query("SELECT d.dept_id, d.sub_name, d.dept_name, d.dean_id, d.status, u.first_name AS dean_first, u.last_name AS dean_last,
                (SELECT GROUP_CONCAT(du.user_id ORDER BY du.user_id) FROM tbl_users du WHERE du.role_id = 2 AND du.dept_id = d.dept_id AND LOWER(COALESCE(du.status, 'active')) <> 'archive') AS dean_ids,
                (SELECT GROUP_CONCAT(CONCAT_WS(' ', du.first_name, du.last_name) ORDER BY du.user_id SEPARATOR '||') FROM tbl_users du WHERE du.role_id = 2 AND du.dept_id = d.dept_id AND LOWER(COALESCE(du.status, 'active')) <> 'archive') AS dean_names
                FROM tbl_departments d LEFT JOIN tbl_users u ON d.dean_id = u.user_id{$departmentWhere} ORDER BY d.dept_name");
            if (!$result) json_response(['error' => 'query_failed', 'message' => $mysqli->error], 500);
            json_response($result->fetch_all(MYSQLI_ASSOC));

        } elseif (($request_method === 'PUT' || $request_method === 'POST') && is_numeric($param1)) {
            if ((int)$authRole !== 1) {
                json_response(['error' => 'forbidden', 'message' => 'View-only access. Only admin can modify departments.'], 403);
            }
            $deptId = (int)$param1;

            // support toggle via /departments/{id}/toggle
            if ($param2 === 'toggle') {
                $q = $mysqli->prepare("SELECT status, dept_name FROM tbl_departments WHERE dept_id = ? LIMIT 1");
                if (!$q) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $q->bind_param("i", $deptId);
                $q->execute();
                $row = $q->get_result()->fetch_assoc();
                if (!$row) json_response(['error' => 'not_found', 'message' => 'Department not found'], 404);
                if (strtolower(trim((string)$row['status'])) === 'archive') {
                    json_response(['error' => 'archived_record_locked', 'message' => 'Restore this department to inactive before activating it.'], 409);
                }
                
                $deptName = $row['dept_name'];
                $new = ($row['status'] === 'active') ? 'inactive' : 'active';
                
                $up = $mysqli->prepare("UPDATE tbl_departments SET status = ? WHERE dept_id = ?");
                if (!$up) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $up->bind_param("si", $new, $deptId);
                if (!$up->execute()) json_response(['error' => 'update_failed', 'message' => $up->error], 500);
                
                log_system_action($mysqli, $authUserId, 'toggle_department', "Changed status of Department '$deptName' to $new");

                try { trigger_socket_update(['entity' => 'departments', 'action' => 'toggle', 'dept_id' => $deptId]); } catch (Throwable $_) {}
                json_response(['dept_id' => $deptId, 'status' => $new]);
            }

            // Normal update
            $chk = $mysqli->prepare("SELECT dept_id, dept_name, dean_id, status FROM tbl_departments WHERE dept_id = ? LIMIT 1");
            if (!$chk) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $chk->bind_param("i", $deptId);
            $chk->execute();
            $exists = $chk->get_result()->fetch_assoc();
            if (!$exists) json_response(['error' => 'not_found', 'message' => 'Department not found'], 404);
            $assertAcademicArchivedUpdateAllowed($exists['status'] ?? null, $input);
            $oldName = $exists['dept_name']; 
            $oldDeanId = isset($exists['dean_id']) && $exists['dean_id'] !== null ? (int)$exists['dean_id'] : null;
            $deanIdsProvided = array_key_exists('dean_ids', $input);
            $deanIds = $deanIdsProvided ? $normalizeLeaderIds($input['dean_ids']) : [];
            if ($deanIdsProvided) {
                $validateLeaderUsers($deanIds, 2, 'Dean');
                $input['dean_id'] = $deanIds[0] ?? null;
                $assertDeanAssignmentsAvailable($deanIds, $deptId);
            }

            $fields = [];
            $types = '';
            $values = [];
            if (array_key_exists('sub_name', $input)) {
                $subName = trim((string)($input['sub_name'] ?? ''));
                if (strlen($subName) > 30) json_response(['error' => 'validation', 'message' => 'Department sub name must not exceed 30 characters'], 400);
                $input['sub_name'] = $subName !== '' ? $subName : null;
                $fields[] = 'sub_name = ?';
                $types .= 's';
                $values[] = $input['sub_name'];
            }
            if (isset($input['dept_name'])) { $fields[] = 'dept_name = ?'; $types .= 's'; $values[] = trim((string)$input['dept_name']); }
            if (array_key_exists('dean_id', $input)) {
                if ($input['dean_id'] === '' || $input['dean_id'] === null) {
                    $fields[] = 'dean_id = NULL';
                } else {
                    $fields[] = 'dean_id = ?';
                    $types .= 'i';
                    $values[] = (int)$input['dean_id'];
                }
            }
            if (isset($input['status'])) {
                $input['status'] = $prepareAcademicStatusTransition('department', $deptId, $exists['status'] ?? null, $input['status']);
                $fields[] = 'status = ?'; $types .= 's'; $values[] = $input['status'];
            }

            if (empty($fields)) json_response(['message' => 'Nothing to update'], 200);

            if (isset($input['dept_name'])) {
                $name = trim((string)$input['dept_name']);
                $dup = $mysqli->prepare("SELECT dept_id FROM tbl_departments WHERE LOWER(dept_name) = LOWER(?) AND dept_id <> ? LIMIT 1");
                if (!$dup) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $dup->bind_param("si", $name, $deptId);
                $dup->execute();
                if ($dup->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_department', 'message' => 'A department with the same name already exists.'], 409);
            }
            if (array_key_exists('sub_name', $input) && $input['sub_name'] !== null) {
                $subNameDuplicate = $mysqli->prepare("SELECT dept_id FROM tbl_departments WHERE LOWER(TRIM(sub_name)) = LOWER(TRIM(?)) AND dept_id <> ? LIMIT 1");
                if (!$subNameDuplicate) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $subNameDuplicate->bind_param('si', $input['sub_name'], $deptId);
                $subNameDuplicate->execute();
                if ($subNameDuplicate->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_department_sub_name', 'message' => 'A department with the same sub name already exists.'], 409);
            }

            // If dean_id provided, validate the selected user exists and is a dean (role_id = 2)
            if (isset($input['dean_id']) && $input['dean_id'] !== '') {
                $newDeanId = (int)$input['dean_id'];
                $uq = $mysqli->prepare("SELECT user_id, role_id FROM tbl_users WHERE user_id = ? LIMIT 1");
                if (!$uq) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $uq->bind_param('i', $newDeanId);
                $uq->execute();
                $urow = $uq->get_result()->fetch_assoc();
                if (!$urow) json_response(['error' => 'invalid_dean', 'message' => 'Selected dean user does not exist'], 400);
                if ((int)($urow['role_id'] ?? 0) !== 2) json_response(['error' => 'invalid_dean_role', 'message' => 'Selected user is not a dean'], 400);

                if (!$deanIdsProvided) $assertDeanAssignmentsAvailable([$newDeanId], $deptId);

                // If requester is a dean, they may only assign themselves as dean
                if ($authRole === 2 && $newDeanId !== $authUserId) json_response(['error' => 'forbidden', 'message' => 'Dean users cannot assign another user as dean'], 403);
            }

            $sql = "UPDATE tbl_departments SET " . implode(', ', $fields) . " WHERE dept_id = ?";
            $stmt = $mysqli->prepare($sql);
            if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $types .= 'i'; $values[] = $deptId;
            $stmt->bind_param($types, ...$values);
            if (!$stmt->execute()) json_response(['error' => 'update_failed', 'message' => $stmt->error], 500);

            if (array_key_exists('dean_id', $input)) {
                $nextDeanId = ($input['dean_id'] === '' || $input['dean_id'] === null) ? null : (int)$input['dean_id'];
                $syncDepartmentDeanUser($deptId, $nextDeanId, $oldDeanId);
            }
            if ($deanIdsProvided) {
                $syncDepartmentDeanUsers($deptId, $deanIds);
            }
            
            $targetName = isset($input['dept_name']) ? $input['dept_name'] : $oldName;
            log_system_action($mysqli, $authUserId, 'update_department', "Updated Department details for '$targetName'");

            try { trigger_socket_update(['entity' => 'departments', 'action' => 'update', 'dept_id' => $deptId]); } catch (Throwable $_) {}
            json_response(['dept_id' => $deptId] + $input);

        } elseif ($request_method === 'POST') {
            if ((int)$authRole !== 1) {
                json_response(['error' => 'forbidden', 'message' => 'View-only access. Only admin can create departments.'], 403);
            }
            if (empty($input['dept_name'])) json_response(['error' => 'validation', 'message' => 'dept_name is required'], 400);
            $name = trim((string)$input['dept_name']);
            $subName = trim((string)($input['sub_name'] ?? ''));
            if (strlen($subName) > 30) json_response(['error' => 'validation', 'message' => 'Department sub name must not exceed 30 characters'], 400);
            $subName = $subName !== '' ? $subName : null;
            $deanIdsProvided = array_key_exists('dean_ids', $input);
            $deanIds = $deanIdsProvided ? $normalizeLeaderIds($input['dean_ids']) : [];
            if ($deanIdsProvided) $validateLeaderUsers($deanIds, 2, 'Dean');
            $hasDean = $deanIdsProvided
                ? !empty($deanIds)
                : (array_key_exists('dean_id', $input) && $input['dean_id'] !== '' && $input['dean_id'] !== null);
            $deanId = $deanIdsProvided ? ($deanIds[0] ?? null) : ($hasDean ? (int)$input['dean_id'] : null);

            $selectedDeanIds = $deanIdsProvided ? $deanIds : ($deanId ? [$deanId] : []);
            $assertDeanAssignmentsAvailable($selectedDeanIds, null);

            if ($hasDean) {
                // Validate selected dean exists and has role dean
                $uq = $mysqli->prepare("SELECT user_id, role_id FROM tbl_users WHERE user_id = ? LIMIT 1");
                if (!$uq) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $uq->bind_param('i', $deanId);
                $uq->execute();
                $urow = $uq->get_result()->fetch_assoc();
                if (!$urow) json_response(['error' => 'invalid_dean', 'message' => 'Selected dean user does not exist'], 400);
                if ((int)($urow['role_id'] ?? 0) !== 2) json_response(['error' => 'invalid_dean_role', 'message' => 'Selected user is not a dean'], 400);
            }

            $dup = $mysqli->prepare("SELECT dept_id FROM tbl_departments WHERE LOWER(dept_name) = LOWER(?) LIMIT 1");
            if (!$dup) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $dup->bind_param("s", $name);
            $dup->execute();
            if ($dup->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_department', 'message' => 'A department with the same name already exists.'], 409);
            if ($subName !== null) {
                $subNameDuplicate = $mysqli->prepare("SELECT dept_id FROM tbl_departments WHERE LOWER(TRIM(sub_name)) = LOWER(TRIM(?)) LIMIT 1");
                if (!$subNameDuplicate) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $subNameDuplicate->bind_param('s', $subName);
                $subNameDuplicate->execute();
                if ($subNameDuplicate->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_department_sub_name', 'message' => 'A department with the same sub name already exists.'], 409);
            }

            if ($hasDean) {
                $stmt = $mysqli->prepare("INSERT INTO tbl_departments (sub_name, dept_name, dean_id, status) VALUES (?, ?, ?, 'active')");
                if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $stmt->bind_param("ssi", $subName, $name, $deanId);
            } else {
                $stmt = $mysqli->prepare("INSERT INTO tbl_departments (sub_name, dept_name, dean_id, status) VALUES (?, ?, NULL, 'active')");
                if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $stmt->bind_param("ss", $subName, $name);
            }
            if (!$stmt->execute()) json_response(['error' => 'insert_failed', 'message' => $stmt->error], 500);
            $newDeptId = (int)$stmt->insert_id;
            if ($hasDean) {
                $syncDepartmentDeanUser($newDeptId, $deanId, null);
            }
            if ($deanIdsProvided) {
                $syncDepartmentDeanUsers($newDeptId, $deanIds);
            }
            
            log_system_action($mysqli, $authUserId, 'create_department', "Created new department: $name");

            try { trigger_socket_update(['entity' => 'departments', 'action' => 'create', 'dept_id' => $newDeptId]); } catch (Throwable $_) {}
            json_response(['dept_id' => $newDeptId, 'sub_name' => $subName, 'dept_name' => $name, 'dean_id' => $deanId, 'dean_ids' => $deanIdsProvided ? $deanIds : ($deanId ? [$deanId] : [])], 201);
        }
        break;

    case 'programs':
        if (!$authUserId) {
            json_response(['error' => 'unauthorized', 'message' => 'Authentication required'], 401);
        }

        if ($request_method === 'GET') {
            // Enforce server-side RBAC: Admin sees all; Dean/Secretary see programs in their dept; Program Head sees programs they head.
            $base = "SELECT p.program_id, p.sub_name, p.program_name, p.dept_id, p.head_id, p.status, d.dept_name, d.sub_name AS department_sub_name, d.status AS department_status, u.first_name AS head_first, u.last_name AS head_last,
                (SELECT GROUP_CONCAT(ph.user_id ORDER BY ph.user_id) FROM tbl_users ph WHERE ph.role_id = 3 AND ph.assigned_program_head_id = p.program_id AND LOWER(COALESCE(ph.status, 'active')) <> 'archive') AS head_ids,
                (SELECT GROUP_CONCAT(CONCAT_WS(' ', ph.first_name, ph.last_name) ORDER BY ph.user_id SEPARATOR '||') FROM tbl_users ph WHERE ph.role_id = 3 AND ph.assigned_program_head_id = p.program_id AND LOWER(COALESCE(ph.status, 'active')) <> 'archive') AS head_names
                FROM tbl_programs p LEFT JOIN tbl_departments d ON p.dept_id = d.dept_id LEFT JOIN tbl_users u ON p.head_id = u.user_id";

            // Default: return all (admin or unknown)
            if ($authRole && $authRole !== 1) {
                if ($authRole === 3) { // program_head
                    $sql = $base . " WHERE EXISTS (SELECT 1 FROM tbl_users ph_scope WHERE ph_scope.user_id = " . intval($authUserId) . " AND ph_scope.role_id = 3 AND ph_scope.assigned_program_head_id = p.program_id) ORDER BY d.dept_name, p.program_name";
                } elseif (in_array($authRole, [2,4,6], true)) { // dean, department admin, or secretary
                    // Resolve dept of auth user
                    $deptQ = $mysqli->prepare("SELECT dept_id FROM tbl_users WHERE user_id = ? LIMIT 1");
                    if ($deptQ) {
                        $deptQ->bind_param('i', $authUserId);
                        $deptQ->execute();
                        $drow = $deptQ->get_result()->fetch_assoc();
                        $authDept = isset($drow['dept_id']) ? (int)$drow['dept_id'] : null;
                    } else {
                        $authDept = null;
                    }

                    if ($authDept === null) {
                        json_response([]);
                    }

                    $sql = $base . " WHERE p.dept_id = " . intval($authDept) . " ORDER BY d.dept_name, p.program_name";
                } else {
                    json_response([]);
                }
            } else {
                $sql = $base . " ORDER BY d.dept_name, p.program_name";
            }

            $result = $mysqli->query($sql);
            if (!$result) json_response(['error' => 'query_failed', 'message' => $mysqli->error], 500);
            json_response($result->fetch_all(MYSQLI_ASSOC));

        } elseif (($request_method === 'PUT' || $request_method === 'POST') && is_numeric($param1)) {
            $requireAcademicManageAccess('programs');
            $programId = (int)$param1;
            $assertProgramScopeAccess($programId, 'programs');

            if ($param2 === 'toggle') {
                $q = $mysqli->prepare("SELECT status, program_name, dept_id FROM tbl_programs WHERE program_id = ? LIMIT 1");
                if (!$q) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $q->bind_param("i", $programId);
                $q->execute();
                $row = $q->get_result()->fetch_assoc();
                if (!$row) json_response(['error' => 'not_found', 'message' => 'Program not found'], 404);
                if (strtolower(trim((string)$row['status'])) === 'archive') {
                    json_response(['error' => 'archived_record_locked', 'message' => 'Restore this program to inactive before activating it.'], 409);
                }
                
                $progName = $row['program_name']; 
                $new = ($row['status'] === 'active') ? 'inactive' : 'active';
                if ($new === 'active') $assertActiveDepartment(isset($row['dept_id']) ? (int)$row['dept_id'] : null);
                
                $up = $mysqli->prepare("UPDATE tbl_programs SET status = ? WHERE program_id = ?");
                if (!$up) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $up->bind_param("si", $new, $programId);
                if (!$up->execute()) json_response(['error' => 'update_failed', 'message' => $up->error], 500);
                
                log_system_action($mysqli, $authUserId, 'toggle_program', "Changed status of Program '$progName' to $new");

                try { trigger_socket_update(['entity' => 'programs', 'action' => 'toggle', 'program_id' => $programId]); } catch (Throwable $_) {}
                json_response(['program_id' => $programId, 'status' => $new]);
            }

            // Normal update
            $chk = $mysqli->prepare("SELECT program_id, program_name, dept_id, head_id, status FROM tbl_programs WHERE program_id = ? LIMIT 1");
            if (!$chk) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $chk->bind_param("i", $programId);
            $chk->execute();
            $exists = $chk->get_result()->fetch_assoc();
            if (!$exists) json_response(['error' => 'not_found', 'message' => 'Program not found'], 404);
            $assertAcademicArchivedUpdateAllowed($exists['status'] ?? null, $input);
            $oldName = $exists['program_name'];
            $oldHeadId = isset($exists['head_id']) && $exists['head_id'] !== null ? (int)$exists['head_id'] : null;
            $oldDeptId = isset($exists['dept_id']) && $exists['dept_id'] !== null ? (int)$exists['dept_id'] : null;
            $headIdsProvided = array_key_exists('head_ids', $input);
            $headIds = $headIdsProvided ? $normalizeLeaderIds($input['head_ids']) : [];
            if ($headIdsProvided) {
                $validateLeaderUsers($headIds, 3, 'Program Head');
                $input['head_id'] = $headIds[0] ?? null;
            }

            $fields = [];
            $types = '';
            $values = [];
            if (array_key_exists('sub_name', $input)) {
                $subName = trim((string)($input['sub_name'] ?? ''));
                if (strlen($subName) > 30) json_response(['error' => 'validation', 'message' => 'Program sub name must not exceed 30 characters'], 400);
                $input['sub_name'] = $subName !== '' ? $subName : null;
                $fields[] = 'sub_name = ?';
                $types .= 's';
                $values[] = $input['sub_name'];
            }
            if (isset($input['program_name'])) { $fields[] = 'program_name = ?'; $types .= 's'; $values[] = trim((string)$input['program_name']); }
            
            // UPDATED: Handle NULL dept_id
            if (array_key_exists('dept_id', $input)) { 
                $fields[] = 'dept_id = ?'; 
                $types .= 'i'; 
                $values[] = (!empty($input['dept_id'])) ? (int)$input['dept_id'] : null; 
            }
            
            if (array_key_exists('head_id', $input)) {
                if ($input['head_id'] === '' || $input['head_id'] === null) {
                    $fields[] = 'head_id = NULL';
                } else {
                    $fields[] = 'head_id = ?';
                    $types .= 'i';
                    $values[] = (int)$input['head_id'];
                }
            }
            if (isset($input['status'])) {
                $input['status'] = $prepareAcademicStatusTransition('program', $programId, $exists['status'] ?? null, $input['status']);
                $fields[] = 'status = ?'; $types .= 's'; $values[] = $input['status'];
            }

            if (empty($fields)) json_response(['message' => 'Nothing to update'], 200);

            if (isset($input['program_name'])) {
                $name = trim((string)$input['program_name']);
                $dup = $mysqli->prepare("SELECT program_id FROM tbl_programs WHERE LOWER(program_name) = LOWER(?) AND program_id <> ? LIMIT 1");
                if (!$dup) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $dup->bind_param("si", $name, $programId);
                $dup->execute();
                if ($dup->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_program', 'message' => 'A program with the same name already exists.'], 409);
            }
            if (array_key_exists('sub_name', $input) && $input['sub_name'] !== null) {
                $subNameDuplicate = $mysqli->prepare("SELECT program_id FROM tbl_programs WHERE LOWER(TRIM(sub_name)) = LOWER(TRIM(?)) AND program_id <> ? LIMIT 1");
                if (!$subNameDuplicate) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $subNameDuplicate->bind_param('si', $input['sub_name'], $programId);
                $subNameDuplicate->execute();
                if ($subNameDuplicate->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_program_sub_name', 'message' => 'A program with the same sub name already exists.'], 409);
            }

            $candidateDeptId = array_key_exists('dept_id', $input)
                ? ((!empty($input['dept_id'])) ? (int)$input['dept_id'] : null)
                : $oldDeptId;
            $selectedHeadIds = $headIdsProvided
                ? $headIds
                : ((array_key_exists('head_id', $input) && $input['head_id'] !== '' && $input['head_id'] !== null) ? [(int)$input['head_id']] : []);
            $assertProgramHeadAssignmentsAvailable($selectedHeadIds, $programId, $candidateDeptId);
            $candidateStatus = strtolower(trim((string)($input['status'] ?? $exists['status'] ?? 'inactive')));
            if ($candidateStatus === 'active') $assertActiveDepartment($candidateDeptId);
            if ((int)$authRole === 6 && ($candidateDeptId === null || (int)$candidateDeptId !== (int)$authDeptId)) {
                json_response(['error' => 'forbidden', 'message' => 'Department Admin can only keep programs inside their own department.'], 403);
            }
            if (array_key_exists('head_id', $input) && $input['head_id'] !== '' && $input['head_id'] !== null) {
                $validateProgramHeadOwner((int)$input['head_id'], $programId, $candidateDeptId);
            }
            if ($headIdsProvided) {
                foreach ($headIds as $selectedHeadId) {
                    $validateProgramHeadOwner((int)$selectedHeadId, $programId, $candidateDeptId);
                }
            }

            $sql = "UPDATE tbl_programs SET " . implode(', ', $fields) . " WHERE program_id = ?";
            $stmt = $mysqli->prepare($sql);
            if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $types .= 'i'; $values[] = $programId;
            $stmt->bind_param($types, ...$values);
            if (!$stmt->execute()) json_response(['error' => 'update_failed', 'message' => $stmt->error], 500);

            if (array_key_exists('head_id', $input) || array_key_exists('dept_id', $input)) {
                $nextHeadId = array_key_exists('head_id', $input)
                    ? (($input['head_id'] === '' || $input['head_id'] === null) ? null : (int)$input['head_id'])
                    : $oldHeadId;
                $syncProgramHeadUser($programId, $candidateDeptId, $nextHeadId, $oldHeadId);
            }
            if ($headIdsProvided) {
                $syncProgramHeadUsers($programId, $candidateDeptId, $headIds);
            }
            
            // LOGGING
            $targetName = isset($input['program_name']) ? $input['program_name'] : $oldName;
            log_system_action($mysqli, $authUserId, 'update_program', "Updated Program '$targetName'");

            try { trigger_socket_update(['entity' => 'programs', 'action' => 'update', 'program_id' => $programId]); } catch (Throwable $_) {}
            json_response(['program_id' => $programId] + $input);

        } elseif ($request_method === 'POST') {
            $requireAcademicCreateAccess('programs');
            if (empty($input['program_name'])) json_response(['error' => 'validation', 'message' => 'program_name is required'], 400);
            $name = trim((string)$input['program_name']);
            $subName = trim((string)($input['sub_name'] ?? ''));
            if (strlen($subName) > 30) json_response(['error' => 'validation', 'message' => 'Program sub name must not exceed 30 characters'], 400);
            $subName = $subName !== '' ? $subName : null;
            
            if (empty($input['dept_id'])) {
                json_response(['error' => 'validation', 'message' => 'Department is required when adding a program'], 400);
            }
            $deptId = (int)$input['dept_id'];
            $assertActiveDepartment($deptId);
            if ((int)$authRole === 6 && ($authDeptId === null || $deptId === null || (int)$deptId !== (int)$authDeptId)) {
                json_response(['error' => 'forbidden', 'message' => 'Department Admin can only create programs inside their own department.'], 403);
            }
            
            $headIdsProvided = array_key_exists('head_ids', $input);
            $headIds = $headIdsProvided ? $normalizeLeaderIds($input['head_ids']) : [];
            if ($headIdsProvided) $validateLeaderUsers($headIds, 3, 'Program Head');
            $hasHead = $headIdsProvided
                ? !empty($headIds)
                : (array_key_exists('head_id', $input) && $input['head_id'] !== '' && $input['head_id'] !== null);
            $headId = $headIdsProvided ? ($headIds[0] ?? null) : ($hasHead ? (int)$input['head_id'] : null);

            $selectedHeadIds = $headIdsProvided ? $headIds : ($headId ? [$headId] : []);
            $assertProgramHeadAssignmentsAvailable($selectedHeadIds, null, $deptId);

            // Only check dept existence if not null
            if ($deptId !== null) {
                $dchk = $mysqli->prepare("SELECT dept_id FROM tbl_departments WHERE dept_id = ? LIMIT 1");
                if (!$dchk) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $dchk->bind_param("i", $deptId);
                $dchk->execute();
                if (!$dchk->get_result()->fetch_assoc()) json_response(['error' => 'invalid_dept_id', 'message' => 'Selected department does not exist'], 400);
            }

            $dup = $mysqli->prepare("SELECT program_id FROM tbl_programs WHERE LOWER(program_name) = LOWER(?) LIMIT 1");
            if (!$dup) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $dup->bind_param("s", $name);
            $dup->execute();
            if ($dup->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_program', 'message' => 'A program with the same name already exists.'], 409);
            if ($subName !== null) {
                $subNameDuplicate = $mysqli->prepare("SELECT program_id FROM tbl_programs WHERE LOWER(TRIM(sub_name)) = LOWER(TRIM(?)) LIMIT 1");
                if (!$subNameDuplicate) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $subNameDuplicate->bind_param('s', $subName);
                $subNameDuplicate->execute();
                if ($subNameDuplicate->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_program_sub_name', 'message' => 'A program with the same sub name already exists.'], 409);
            }

            if ($hasHead) {
                $validateProgramHeadOwner($headId, 0, $deptId);
            }
            if ($headIdsProvided) {
                foreach ($headIds as $selectedHeadId) {
                    $validateProgramHeadOwner((int)$selectedHeadId, 0, $deptId);
                }
            }

            if ($hasHead) {
                $stmt = $mysqli->prepare("INSERT INTO tbl_programs (sub_name, program_name, dept_id, head_id, status) VALUES (?, ?, ?, ?, 'active')");
                if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $stmt->bind_param("ssii", $subName, $name, $deptId, $headId);
            } else {
                $stmt = $mysqli->prepare("INSERT INTO tbl_programs (sub_name, program_name, dept_id, head_id, status) VALUES (?, ?, ?, NULL, 'active')");
                if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $stmt->bind_param("ssi", $subName, $name, $deptId);
            }
            if (!$stmt->execute()) json_response(['error' => 'insert_failed', 'message' => $stmt->error], 500);
            $newProgramId = (int)$stmt->insert_id;
            if ($hasHead) {
                $syncProgramHeadUser($newProgramId, $deptId, $headId, null);
            }
            if ($headIdsProvided) {
                $syncProgramHeadUsers($newProgramId, $deptId, $headIds);
            }
            
            // LOGGING
            log_system_action($mysqli, $authUserId, 'create_program', "Created new program: $name");

            try { trigger_socket_update(['entity' => 'programs', 'action' => 'create', 'program_id' => $newProgramId]); } catch (Throwable $_) {}
            json_response(['program_id' => $newProgramId, 'sub_name' => $subName, 'program_name' => $name, 'dept_id' => $deptId, 'head_id' => $headId, 'head_ids' => $headIdsProvided ? $headIds : ($headId ? [$headId] : [])], 201);
        }
        break;

    case 'sections':
        if ($request_method === 'GET') {
            $paginateSections = isset($_GET['paginate']) && (string)$_GET['paginate'] === '1';
            $identityList = isset($_GET['identities']) && (string)$_GET['identities'] === '1';
            $page = isset($_GET['page']) && is_numeric($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
            $pageSize = isset($_GET['page_size']) && is_numeric($_GET['page_size']) ? max(1, min(100, (int)$_GET['page_size'])) : 10;
            $filterDeptId = isset($_GET['dept_id']) && is_numeric($_GET['dept_id']) ? (int)$_GET['dept_id'] : null;
            $filterProgramId = isset($_GET['program_id']) && is_numeric($_GET['program_id']) ? (int)$_GET['program_id'] : null;
            $filterYearId = isset($_GET['year_id']) && is_numeric($_GET['year_id']) ? (int)$_GET['year_id'] : null;
            $filterStatus = strtolower(trim((string)($_GET['status'] ?? '')));
            $searchSections = trim((string)($_GET['search'] ?? ''));
            if ($filterStatus !== '' && !in_array($filterStatus, ['active', 'inactive', 'archive'], true)) {
                json_response(['error' => 'invalid_status', 'message' => 'Invalid section status filter.'], 422);
            }

            // RBAC is always applied on the server, including paginated and
            // lightweight identity requests.
            $scopeConditions = [];
            if ((int)$authRole === 3) {
                $scopeConditions[] = $programHeadScopeCondition('p');
            } elseif (in_array((int)$authRole, [2, 4, 6], true)) {
                if ($authDeptId === null) {
                    if ($paginateSections) json_response(['rows' => [], 'pagination' => ['page' => 1, 'page_size' => $pageSize, 'total' => 0, 'total_pages' => 1], 'status_counts' => ['active' => 0, 'inactive' => 0, 'archive' => 0]]);
                    json_response([]);
                }
                $scopeConditions[] = 'p.dept_id = ' . intval($authDeptId);
            } elseif ((int)$authRole !== 1 && $authRole !== null) {
                if ($paginateSections) json_response(['rows' => [], 'pagination' => ['page' => 1, 'page_size' => $pageSize, 'total' => 0, 'total_pages' => 1], 'status_counts' => ['active' => 0, 'inactive' => 0, 'archive' => 0]]);
                json_response([]);
            }

            $scopeFromSql = " FROM tbl_sections sec JOIN tbl_programs p ON sec.program_id = p.program_id";
            $fromSql = $scopeFromSql . " LEFT JOIN tbl_departments d ON d.dept_id = p.dept_id LEFT JOIN tbl_year_level y ON sec.year_id = y.year_id";
            $scopeWhereSql = $scopeConditions ? ' WHERE ' . implode(' AND ', $scopeConditions) : '';

            if ($identityList) {
                $identityConditions = $scopeConditions;
                if ($filterProgramId !== null) $identityConditions[] = 'sec.program_id = ' . intval($filterProgramId);
                $identityWhereSql = $identityConditions ? ' WHERE ' . implode(' AND ', $identityConditions) : '';
                $identityResult = $mysqli->query("SELECT sec.section_id, sec.program_id, sec.section_name" . $scopeFromSql . $identityWhereSql . " ORDER BY sec.program_id, sec.section_name");
                if (!$identityResult) json_response(['error' => 'query_failed', 'message' => $mysqli->error], 500);
                json_response($identityResult->fetch_all(MYSQLI_ASSOC));
            }

            // Preserve the original array response for other pages that use
            // Sections as a dropdown data source.
            $selectSql = "SELECT sec.section_id, sec.program_id, sec.year_id, sec.section_name, sec.status, p.program_name, p.sub_name AS program_sub_name, p.dept_id, p.head_id, d.dept_name, d.sub_name AS department_sub_name, y.level";
            if (!$paginateSections) {
                $result = $mysqli->query($selectSql . $fromSql . $scopeWhereSql . " ORDER BY p.program_name, sec.section_name");
                if (!$result) json_response(['error' => 'query_failed', 'message' => $mysqli->error], 500);
                json_response($result->fetch_all(MYSQLI_ASSOC));
            }

            $conditions = $scopeConditions;
            $types = '';
            $params = [];
            if ($filterDeptId !== null) { $conditions[] = 'p.dept_id = ?'; $types .= 'i'; $params[] = $filterDeptId; }
            if ($filterProgramId !== null) { $conditions[] = 'sec.program_id = ?'; $types .= 'i'; $params[] = $filterProgramId; }
            if ($filterYearId !== null) { $conditions[] = 'sec.year_id = ?'; $types .= 'i'; $params[] = $filterYearId; }
            if ($filterStatus !== '') { $conditions[] = 'LOWER(TRIM(sec.status)) = ?'; $types .= 's'; $params[] = $filterStatus; }
            if ($searchSections !== '') {
                $conditions[] = "(sec.section_name LIKE ? OR p.program_name LIKE ? OR p.sub_name LIKE ? OR d.dept_name LIKE ? OR d.sub_name LIKE ? OR y.level LIKE ?)";
                $needle = '%' . $searchSections . '%';
                $types .= 'ssssss';
                array_push($params, $needle, $needle, $needle, $needle, $needle, $needle);
            }
            $whereSql = $conditions ? ' WHERE ' . implode(' AND ', $conditions) : '';

            $countStmt = $mysqli->prepare('SELECT COUNT(*) AS total' . $fromSql . $whereSql);
            if (!$countStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            if ($types !== '') $countStmt->bind_param($types, ...$params);
            $countStmt->execute();
            $total = (int)($countStmt->get_result()->fetch_assoc()['total'] ?? 0);
            $countStmt->close();
            $totalPages = max(1, (int)ceil($total / $pageSize));
            $page = min($page, $totalPages);
            $offset = ($page - 1) * $pageSize;

            $dataSql = $selectSql . $fromSql . $whereSql . " ORDER BY p.program_name, sec.section_name LIMIT ? OFFSET ?";
            $dataStmt = $mysqli->prepare($dataSql);
            if (!$dataStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $dataTypes = $types . 'ii';
            $dataParams = array_merge($params, [$pageSize, $offset]);
            $dataStmt->bind_param($dataTypes, ...$dataParams);
            $dataStmt->execute();
            $rows = $dataStmt->get_result()->fetch_all(MYSQLI_ASSOC);
            $dataStmt->close();

            $statusCounts = ['active' => 0, 'inactive' => 0, 'archive' => 0];
            $statusResult = $mysqli->query("SELECT LOWER(TRIM(sec.status)) AS section_status, COUNT(*) AS total" . $scopeFromSql . $scopeWhereSql . " GROUP BY LOWER(TRIM(sec.status))");
            if (!$statusResult) json_response(['error' => 'query_failed', 'message' => $mysqli->error], 500);
            while ($statusRow = $statusResult->fetch_assoc()) {
                $statusKey = (string)($statusRow['section_status'] ?? '');
                if (array_key_exists($statusKey, $statusCounts)) $statusCounts[$statusKey] = (int)$statusRow['total'];
            }

            json_response([
                'rows' => $rows,
                'pagination' => ['page' => $page, 'page_size' => $pageSize, 'total' => $total, 'total_pages' => $totalPages],
                'status_counts' => $statusCounts,
            ]);

        } elseif (($request_method === 'PUT' || $request_method === 'POST') && is_numeric($param1)) {
            $requireAcademicManageAccess('sections');
            $sectionId = (int)$param1;

            if ($param2 === 'toggle') {
                $q = $mysqli->prepare("SELECT status, section_name, program_id FROM tbl_sections WHERE section_id = ? LIMIT 1");
                if (!$q) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $q->bind_param("i", $sectionId);
                $q->execute();
                $row = $q->get_result()->fetch_assoc();
                if (!$row) json_response(['error' => 'not_found', 'message' => 'Section not found'], 404);
                $assertProgramScopeAccess((int)$row['program_id'], 'sections');
                if (strtolower(trim((string)$row['status'])) === 'archive') {
                    json_response(['error' => 'archived_record_locked', 'message' => 'Restore this section to inactive before activating it.'], 409);
                }
                
                $secName = $row['section_name']; 
                $new = ($row['status'] === 'active') ? 'inactive' : 'active';
                if ($new === 'active') $assertActiveProgramHierarchy((int)$row['program_id']);
                
                $up = $mysqli->prepare("UPDATE tbl_sections SET status = ? WHERE section_id = ?");
                if (!$up) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $up->bind_param("si", $new, $sectionId);
                if (!$up->execute()) json_response(['error' => 'update_failed', 'message' => $up->error], 500);
                
                log_system_action($mysqli, $authUserId, 'toggle_section', "Changed status of Section '$secName' to $new");

                try { trigger_socket_update(['entity' => 'sections', 'action' => 'toggle', 'section_id' => $sectionId]); } catch (Throwable $_) {}
                json_response(['section_id' => $sectionId, 'status' => $new]);
            }

            $chk = $mysqli->prepare("SELECT section_id, program_id, year_id, section_name, status FROM tbl_sections WHERE section_id = ? LIMIT 1");
            if (!$chk) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $chk->bind_param("i", $sectionId);
            $chk->execute();
            $existing = $chk->get_result()->fetch_assoc();
            if (!$existing) json_response(['error' => 'not_found', 'message' => 'Section not found'], 404);
            $assertProgramScopeAccess((int)$existing['program_id'], 'sections');
            $assertAcademicArchivedUpdateAllowed($existing['status'] ?? null, $input);
            $oldName = $existing['section_name'];

            $fields = [];
            $types = '';
            $values = [];

            if (isset($input['section_name'])) { $fields[] = 'section_name = ?'; $types .= 's'; $values[] = trim((string)$input['section_name']); }
            if (isset($input['program_id'])) { $fields[] = 'program_id = ?'; $types .= 'i'; $values[] = (int)$input['program_id']; }
            if (isset($input['year_id'])) { $fields[] = 'year_id = ?'; $types .= 'i'; $values[] = (int)$input['year_id']; }
            if (isset($input['status'])) {
                $input['status'] = $prepareAcademicStatusTransition('section', $sectionId, $existing['status'] ?? null, $input['status']);
                $fields[] = 'status = ?'; $types .= 's'; $values[] = $input['status'];
            }

            if (empty($fields)) json_response(['message' => 'Nothing to update'], 200);

            $candidateName = isset($input['section_name']) ? trim((string)$input['section_name']) : $existing['section_name'];
            $candidateProgram = isset($input['program_id']) ? (int)$input['program_id'] : (int)$existing['program_id'];
            $candidateYear = isset($input['year_id']) ? (int)$input['year_id'] : (int)$existing['year_id'];

            $assertProgramScopeAccess($candidateProgram, 'sections');
            $candidateStatus = strtolower(trim((string)($input['status'] ?? $existing['status'] ?? 'inactive')));
            if ($candidateStatus === 'active') $assertActiveProgramHierarchy($candidateProgram);
            if (isset($input['year_id'])) {
                $ychk = $mysqli->prepare("SELECT year_id FROM tbl_year_level WHERE year_id = ? LIMIT 1");
                if (!$ychk) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $ychk->bind_param("i", $candidateYear);
                $ychk->execute();
                if (!$ychk->get_result()->fetch_assoc()) json_response(['error' => 'invalid_year_id', 'message' => 'Selected year level does not exist'], 400);
            }

            if ($candidateName !== '') {
                $dup = $mysqli->prepare("SELECT section_id FROM tbl_sections WHERE LOWER(section_name) = LOWER(?) AND program_id = ? AND section_id <> ? LIMIT 1");
                if (!$dup) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $dup->bind_param("sii", $candidateName, $candidateProgram, $sectionId);
                $dup->execute();
                if ($dup->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_section', 'message' => 'A section with the same name already exists for the selected program.'], 409);
            }

            $sql = "UPDATE tbl_sections SET " . implode(', ', $fields) . " WHERE section_id = ?";
            $stmt = $mysqli->prepare($sql);
            if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $types .= 'i'; $values[] = $sectionId;
            $stmt->bind_param($types, ...$values);
            if (!$stmt->execute()) json_response(['error' => 'update_failed', 'message' => $stmt->error], 500);
            
            $targetName = isset($input['section_name']) ? $input['section_name'] : $oldName;
            log_system_action($mysqli, $authUserId, 'update_section', "Updated Section '$targetName'");

            try { trigger_socket_update(['entity' => 'sections', 'action' => 'update', 'section_id' => $sectionId]); } catch (Throwable $_) {}
            json_response(['section_id' => $sectionId] + $input);

        } elseif ($request_method === 'POST') {
            $requireAcademicCreateAccess('sections');
            if (!isset($input['program_id']) || $input['program_id'] === '' || !is_numeric($input['program_id'])) json_response(['error' => 'missing_program_id', 'message' => 'program_id is required and must reference an existing program'], 400);
            if (!isset($input['year_id']) || $input['year_id'] === '' || !is_numeric($input['year_id'])) json_response(['error' => 'missing_year_id', 'message' => 'year_id is required and must reference an existing year level'], 400);
            $isBatchCreate = isset($input['section_names']) && is_array($input['section_names']);
            if (!$isBatchCreate && (!isset($input['section_name']) || trim((string)$input['section_name']) === '')) json_response(['error' => 'missing_section_name', 'message' => 'section_name is required'], 400);
            if ($isBatchCreate && (count($input['section_names']) < 1 || count($input['section_names']) > 50)) json_response(['error' => 'invalid_section_count', 'message' => 'section_names must contain between 1 and 50 sections'], 400);

            $programId = (int)$input['program_id'];
            $yearId = (int)$input['year_id'];
            $name = $isBatchCreate ? '' : trim((string)$input['section_name']);

            $assertProgramScopeAccess($programId, 'sections');
            $assertActiveProgramHierarchy($programId);

            $ystmt = $mysqli->prepare("SELECT year_id, level FROM tbl_year_level WHERE year_id = ? LIMIT 1");
            if (!$ystmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $ystmt->bind_param("i", $yearId);
            $ystmt->execute();
            $yearRow = $ystmt->get_result()->fetch_assoc();
            if (!$yearRow) json_response(['error' => 'invalid_year_id', 'message' => 'Selected year level does not exist'], 400);
            if (!preg_match('/\d+/', (string)($yearRow['level'] ?? ''), $yearMatch)) {
                json_response(['error' => 'invalid_year_level', 'message' => 'Selected year level does not contain a usable year number'], 400);
            }
            $yearNumber = $yearMatch[0];

            if ($isBatchCreate) {
                $allowedShiftPattern = '(?:FA|FB|FC|FAB|FAC|FBC|EA|EB|EC|FD|FE)';
                $normalizeSectionIdentity = function($value) {
                    $normalized = strtoupper(trim((string)$value));
                    $normalized = preg_replace('/\s*-\s*/', '-', $normalized);
                    return preg_replace('/\s+/', '', $normalized);
                };

                $requestedNames = [];
                $requestedIdentities = [];
                foreach ($input['section_names'] as $rawName) {
                    $sectionName = $normalizeSectionIdentity($rawName);
                    if (!preg_match('/^COC-' . $allowedShiftPattern . '-([A-Z0-9]+(?:-[A-Z0-9]+)*)-((?:0[1-9]|[1-9]\d)[A-Z]*)$/', $sectionName, $sectionParts)) {
                        json_response(['error' => 'invalid_section_name', 'message' => "Invalid generated section name '{$sectionName}'. Expected a name such as COC-FAB-BSIT2-01A."], 400);
                    }
                    $groupCode = $sectionParts[1];
                    if (!preg_match('/(\d+)$/', $groupCode, $groupYearMatch) || $groupYearMatch[1] !== $yearNumber) {
                        json_response(['error' => 'invalid_section_year', 'message' => "Program/year code '{$groupCode}' must end with the selected year number {$yearNumber}."], 400);
                    }
                    if (isset($requestedIdentities[$sectionName])) {
                        json_response(['error' => 'duplicate_section_request', 'message' => "The generated request contains duplicate section '{$sectionName}'."], 400);
                    }
                    $requestedIdentities[$sectionName] = true;
                    $requestedNames[] = $sectionName;
                }

                $existingIdentities = [];
                $existingNames = [];
                $existingStmt = $mysqli->prepare("SELECT section_name FROM tbl_sections WHERE program_id = ?");
                if (!$existingStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $existingStmt->bind_param('i', $programId);
                $existingStmt->execute();
                $existingResult = $existingStmt->get_result();
                while ($existingRow = $existingResult->fetch_assoc()) {
                    $identity = $normalizeSectionIdentity($existingRow['section_name'] ?? '');
                    if ($identity !== '') $existingIdentities[$identity] = true;
                }
                $existingStmt->close();

                $namesToCreate = [];
                foreach ($requestedNames as $sectionName) {
                    if (isset($existingIdentities[$sectionName])) {
                        $existingNames[] = $sectionName;
                    } else {
                        $namesToCreate[] = $sectionName;
                    }
                }
                if (!$namesToCreate) {
                    json_response([
                        'error' => 'duplicate_section',
                        'message' => 'All generated sections already exist for the selected program.',
                        'existing' => $existingNames,
                    ], 409);
                }

                $insertBatchStmt = $mysqli->prepare("INSERT INTO tbl_sections (program_id, year_id, section_name, status) VALUES (?, ?, ?, 'active')");
                if (!$insertBatchStmt) json_response(['error' => 'prepare_failed', 'sql_error' => $mysqli->error], 500);
                $created = [];
                $mysqli->begin_transaction();
                foreach ($namesToCreate as $sectionName) {
                    $insertBatchStmt->bind_param('iis', $programId, $yearId, $sectionName);
                    if (!$insertBatchStmt->execute()) {
                        $mysqli->rollback();
                        json_response(['error' => 'db_insert_failed', 'message' => $insertBatchStmt->error], 500);
                    }
                    $created[] = ['section_id' => (int)$insertBatchStmt->insert_id, 'section_name' => $sectionName];
                }
                $mysqli->commit();
                $insertBatchStmt->close();

                log_system_action($mysqli, $authUserId, 'create_sections_batch', 'Created sections: ' . implode(', ', array_column($created, 'section_name')));
                try { trigger_socket_update(['entity' => 'sections', 'action' => 'create_batch', 'section_ids' => array_column($created, 'section_id')]); } catch (Throwable $_) {}
                json_response([
                    'created_count' => count($created),
                    'skipped_count' => count($existingNames),
                    'created' => $created,
                    'existing' => $existingNames,
                    'program_id' => $programId,
                    'year_id' => $yearId,
                ], 201);
            }

            $dup = $mysqli->prepare("SELECT section_id FROM tbl_sections WHERE LOWER(section_name) = LOWER(?) AND program_id = ? LIMIT 1");
            if (!$dup) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $dup->bind_param("si", $name, $programId);
            $dup->execute();
            if ($dup->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_section', 'message' => 'A section with the same name already exists for the selected program.'], 409);

            $stmt = $mysqli->prepare("INSERT INTO tbl_sections (program_id, year_id, section_name, status) VALUES (?, ?, ?, 'active')");
            if (!$stmt) json_response(['error' => 'prepare_failed', 'sql_error' => $mysqli->error], 500);
            $stmt->bind_param("iis", $programId, $yearId, $name);
            if (!$stmt->execute()) json_response(['error' => 'db_insert_failed', 'message' => $stmt->error], 500);
            
            log_system_action($mysqli, $authUserId, 'create_section', "Created new section: $name");

            try { trigger_socket_update(['entity' => 'sections', 'action' => 'create', 'section_id' => $stmt->insert_id]); } catch (Throwable $_) {}
            json_response(['section_id' => $stmt->insert_id, 'program_id' => $programId, 'year_id' => $yearId, 'section_name' => $name], 201);
        }
        break;
    case 'school-years':
        $syColumns = [];
        $syColsResult = $mysqli->query("SHOW COLUMNS FROM tbl_school_year");
        if ($syColsResult) {
            while ($col = $syColsResult->fetch_assoc()) {
                $syColumns[strtolower((string)$col['Field'])] = true;
            }
        }
        $hasSyStart = isset($syColumns['start_date']);
        $hasSyEnd = isset($syColumns['end_date']);
        $hasSyStatus = isset($syColumns['status']);

        $is_valid_iso_date = function (?string $value): bool {
            if ($value === null || $value === '') return false;
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)) return false;
            $dt = DateTime::createFromFormat('Y-m-d', $value);
            return $dt && $dt->format('Y-m-d') === $value;
        };

        $ranges_overlap = function (string $aStart, string $aEnd, string $bStart, string $bEnd): bool {
            return (strtotime($aStart) <= strtotime($bEnd)) && (strtotime($aEnd) >= strtotime($bStart));
        };

        $assert_school_year_conflicts = function (string $candidateName, ?string $candidateStart, ?string $candidateEnd, int $excludeSessionId = 0) use ($mysqli, $hasSyStart, $hasSyEnd, $hasSyStatus) {
            $dup = $mysqli->prepare("SELECT school_year_id FROM tbl_school_year WHERE LOWER(TRIM(session_name)) = LOWER(TRIM(?)) AND school_year_id <> ? LIMIT 1");
            if (!$dup) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $dup->bind_param('si', $candidateName, $excludeSessionId);
            $dup->execute();
            if ($dup->get_result()->fetch_assoc()) {
                json_response(['error' => 'duplicate_school_year', 'message' => 'A school year with the same name already exists.'], 409);
            }

            if ($hasSyStart && $hasSyEnd && !empty($candidateStart) && !empty($candidateEnd)) {
                $sql = "SELECT school_year_id, session_name FROM tbl_school_year WHERE school_year_id <> ? AND start_date <= ? AND end_date >= ?";
                if ($hasSyStatus) $sql .= " AND status <> 'archive'";
                $sql .= " LIMIT 1";

                $conf = $mysqli->prepare($sql);
                if (!$conf) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $conf->bind_param('iss', $excludeSessionId, $candidateEnd, $candidateStart);
                $conf->execute();
                $hit = $conf->get_result()->fetch_assoc();
                if ($hit) {
                    json_response([
                        'error' => 'school_year_date_conflict',
                        'message' => "Date range overlaps with existing school year '" . ($hit['session_name'] ?? 'unknown') . "'.",
                    ], 409);
                }
            }
        };

        $schoolYearArchiveDb = 'bk_teacher_gps_archive';
        $schoolYearArchiveTableExists = function () use ($mysqli, $schoolYearArchiveDb): bool {
            $stmt = $mysqli->prepare("SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = 'tbl_school_year' LIMIT 1");
            if (!$stmt) return false;
            $stmt->bind_param('s', $schoolYearArchiveDb); $stmt->execute();
            $exists = (bool)$stmt->get_result()->fetch_assoc();
            $stmt->close();
            return $exists;
        };
        $ensureSchoolYearArchiveTable = function () use ($mysqli, $schoolYearArchiveDb): void {
            if (!$mysqli->query("CREATE DATABASE IF NOT EXISTS `{$schoolYearArchiveDb}`")) {
                throw new RuntimeException('Unable to create the school-year archive database: ' . $mysqli->error);
            }
            if (!$mysqli->query("CREATE TABLE IF NOT EXISTS `{$schoolYearArchiveDb}`.`tbl_school_year` LIKE `tbl_school_year`")) {
                throw new RuntimeException('Unable to create the school-year archive table: ' . $mysqli->error);
            }
        };

        if ($request_method === 'GET') {
            $archivedOnly = isset($_GET['archived']) && in_array(strtolower(trim((string)$_GET['archived'])), ['1', 'true', 'yes'], true);
            if ($archivedOnly) {
                if (!$schoolYearArchiveTableExists()) json_response([]);
                $result = $mysqli->query("SELECT school_year_id AS session_id, session_name, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date, 'archive' AS status, 0 AS semester_count, 0 AS schedule_count, 0 AS attendance_count FROM `{$schoolYearArchiveDb}`.`tbl_school_year` ORDER BY school_year_id DESC");
                if (!$result) json_response(['error' => 'archive_query_failed', 'message' => $mysqli->error], 500);
                json_response($result->fetch_all(MYSQLI_ASSOC));
            }
            $needsSemBounds = (!$hasSyStart || !$hasSyEnd || !$hasSyStatus);
            $from = "tbl_school_year sy";
            if ($needsSemBounds) {
                $from .= " LEFT JOIN (
                    SELECT school_year_id, MIN(start_date) AS min_start_date, MAX(end_date) AS max_end_date
                    FROM tbl_semesters
                    GROUP BY school_year_id
                ) sb ON sb.school_year_id = sy.school_year_id";
            }

            $startExpr = $hasSyStart ? "DATE_FORMAT(sy.start_date, '%Y-%m-%d')" : "DATE_FORMAT(sb.min_start_date, '%Y-%m-%d')";
            $endExpr = $hasSyEnd ? "DATE_FORMAT(sy.end_date, '%Y-%m-%d')" : "DATE_FORMAT(sb.max_end_date, '%Y-%m-%d')";
            $statusExpr = $hasSyStatus
                ? "sy.status"
                : "CASE
                    WHEN sb.min_start_date IS NOT NULL
                         AND CURDATE() BETWEEN sb.min_start_date AND COALESCE(sb.max_end_date, sb.min_start_date)
                    THEN 'active'
                    ELSE 'inactive'
                END";

            $select = [
                "sy.school_year_id AS session_id",
                "sy.session_name",
                $startExpr . " AS start_date",
                $endExpr . " AS end_date",
                $statusExpr . " AS status",
                "(SELECT COUNT(*) FROM tbl_semesters s0 WHERE s0.school_year_id = sy.school_year_id AND s0.status <> 'archive') AS semester_count",
                "(SELECT COUNT(*) FROM tbl_class_schedules cs0 JOIN tbl_semesters s1 ON cs0.semester_id = s1.semester_id WHERE s1.school_year_id = sy.school_year_id AND s1.status <> 'archive') AS schedule_count",
                "(SELECT COUNT(*) FROM tbl_attendance_records ar0 JOIN tbl_class_schedules cs1 ON ar0.schedule_id = cs1.schedule_id JOIN tbl_semesters s2 ON cs1.semester_id = s2.semester_id WHERE s2.school_year_id = sy.school_year_id AND s2.status <> 'archive') AS attendance_count",
            ];
            $result = $mysqli->query("SELECT " . implode(", ", $select) . " FROM " . $from . " ORDER BY sy.school_year_id DESC");

            if (!$result) json_response(['error' => 'query_failed', 'message' => $mysqli->error], 500);
            json_response($result->fetch_all(MYSQLI_ASSOC));

        } elseif ($request_method === 'POST' && is_numeric($param1) && $param2 === 'generate-semesters') {
            $sessionId = (int)$param1;

            $sySelect = ["school_year_id", "session_name"];
            if ($hasSyStart) $sySelect[] = "DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date";
            if ($hasSyEnd) $sySelect[] = "DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date";
            $syStmt = $mysqli->prepare("SELECT " . implode(', ', $sySelect) . " FROM tbl_school_year WHERE school_year_id = ? LIMIT 1");
            if (!$syStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $syStmt->bind_param('i', $sessionId);
            $syStmt->execute();
            $schoolYear = $syStmt->get_result()->fetch_assoc();
            if (!$schoolYear) json_response(['error' => 'not_found', 'message' => 'School year not found.'], 404);

            $exists = $mysqli->prepare("SELECT semester_id FROM tbl_semesters WHERE school_year_id = ? LIMIT 1");
            if (!$exists) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $exists->bind_param('i', $sessionId);
            $exists->execute();
            if ($exists->get_result()->fetch_assoc()) {
                json_response(['error' => 'semester_already_generated', 'message' => 'Semesters are already generated for this school year.'], 409);
            }

            if (!isset($input['semesters']) || !is_array($input['semesters']) || count($input['semesters']) !== 3) {
                json_response(['error' => 'validation', 'message' => 'Exactly 3 semesters are required.'], 400);
            }

            $termAliases = [
                '1st sem' => '1st sem',
                '1st semester' => '1st sem',
                'first sem' => '1st sem',
                'first semester' => '1st sem',
                '2nd sem' => '2nd sem',
                '2nd semester' => '2nd sem',
                'second sem' => '2nd sem',
                'second semester' => '2nd sem',
                'summer' => 'summer',
            ];
            $termOrder = ['1st sem', '2nd sem', 'summer'];
            $normalized = [];

            foreach ($input['semesters'] as $idx => $sem) {
                if (!is_array($sem)) {
                    json_response(['error' => 'validation', 'message' => 'Invalid semester payload at row ' . ($idx + 1) . '.'], 400);
                }

                $rawTerm = strtolower(trim((string)($sem['term'] ?? '')));
                $term = $termAliases[$rawTerm] ?? null;
                if ($term === null) {
                    json_response(['error' => 'validation', 'message' => 'Invalid semester term at row ' . ($idx + 1) . '.'], 400);
                }
                if (isset($normalized[$term])) {
                    json_response(['error' => 'duplicate_semester_term', 'message' => "Duplicate term '$term' in request."], 409);
                }

                $start = trim((string)($sem['start_date'] ?? ''));
                $end = trim((string)($sem['end_date'] ?? ''));
                if (!$is_valid_iso_date($start) || !$is_valid_iso_date($end)) {
                    json_response(['error' => 'validation', 'message' => "Invalid date format for term '$term'. Use YYYY-MM-DD."], 400);
                }
                if (strtotime($start) > strtotime($end)) {
                    json_response(['error' => 'validation', 'message' => "start_date must be before end_date for '$term'."], 400);
                }

                if ($hasSyStart && $hasSyEnd) {
                    $syStart = (string)($schoolYear['start_date'] ?? '');
                    $syEnd = (string)($schoolYear['end_date'] ?? '');
                    if ($syStart !== '' && $syEnd !== '' && (strtotime($start) < strtotime($syStart) || strtotime($end) > strtotime($syEnd))) {
                        json_response([
                            'error' => 'semester_outside_school_year',
                            'message' => "Term '$term' must be within school year dates ($syStart to $syEnd).",
                        ], 409);
                    }
                }

                $normalized[$term] = [
                    'term' => $term,
                    'start_date' => $start,
                    'end_date' => $end,
                ];
            }

            foreach ($termOrder as $requiredTerm) {
                if (!isset($normalized[$requiredTerm])) {
                    json_response(['error' => 'validation', 'message' => "Missing required term '$requiredTerm'."], 400);
                }
            }

            for ($i = 0; $i < count($termOrder); $i++) {
                for ($j = $i + 1; $j < count($termOrder); $j++) {
                    $a = $normalized[$termOrder[$i]];
                    $b = $normalized[$termOrder[$j]];
                    if ($ranges_overlap($a['start_date'], $a['end_date'], $b['start_date'], $b['end_date'])) {
                        json_response([
                            'error' => 'semester_date_conflict',
                            'message' => "Date range conflict between '{$a['term']}' and '{$b['term']}'.",
                        ], 409);
                    }
                }
            }

            $firstSem = $normalized['1st sem'];
            $secondSem = $normalized['2nd sem'];
            $summer = $normalized['summer'];

            if (
                strtotime($firstSem['start_date']) > strtotime($secondSem['start_date']) ||
                strtotime($secondSem['start_date']) > strtotime($summer['start_date'])
            ) {
                json_response([
                    'error' => 'semester_sequence_invalid',
                    'message' => 'Semester date sequence must follow: 1st sem, 2nd sem, summer.',
                ], 409);
            }

            $dupTerm = $mysqli->prepare("SELECT semester_id FROM tbl_semesters WHERE school_year_id = ? AND LOWER(term) IN (LOWER(?), LOWER(?), LOWER(?)) LIMIT 1");
            if (!$dupTerm) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $t1 = '1st sem';
            $t2 = '2nd sem';
            $t3 = 'summer';
            $dupTerm->bind_param('isss', $sessionId, $t1, $t2, $t3);
            $dupTerm->execute();
            if ($dupTerm->get_result()->fetch_assoc()) {
                json_response(['error' => 'duplicate_semester', 'message' => 'Semester terms already exist for this school year.'], 409);
            }

            $dateConflict = $mysqli->prepare("
                SELECT semester_id, term
                FROM tbl_semesters
                WHERE school_year_id = ?
                  AND (
                    (start_date <= ? AND end_date >= ?)
                    OR (start_date <= ? AND end_date >= ?)
                    OR (start_date <= ? AND end_date >= ?)
                  )
                LIMIT 1
            ");
            if (!$dateConflict) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $dateConflict->bind_param(
                'issssss',
                $sessionId,
                $firstSem['end_date'], $firstSem['start_date'],
                $secondSem['end_date'], $secondSem['start_date'],
                $summer['end_date'], $summer['start_date']
            );
            $dateConflict->execute();
            $existingConflict = $dateConflict->get_result()->fetch_assoc();
            if ($existingConflict) {
                json_response([
                    'error' => 'semester_date_conflict',
                    'message' => "Date conflict with existing semester '" . ($existingConflict['term'] ?? 'unknown') . "'.",
                ], 409);
            }

            $today = date('Y-m-d');
            $created = [];
            $insert = $mysqli->prepare("INSERT INTO tbl_semesters (school_year_id, term, start_date, end_date, status) VALUES (?, ?, ?, ?, ?)");
            if (!$insert) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);

            $mysqli->begin_transaction();
            try {
                foreach ($termOrder as $termName) {
                    $s = $normalized[$termName];
                    $status = (strtotime($today) >= strtotime($s['start_date']) && strtotime($today) <= strtotime($s['end_date'])) ? 'active' : 'inactive';
                    $term = $s['term'];
                    $startDate = $s['start_date'];
                    $endDate = $s['end_date'];
                    $insert->bind_param('issss', $sessionId, $term, $startDate, $endDate, $status);
                    if (!$insert->execute()) {
                        throw new RuntimeException($insert->error ?: 'Failed to insert semester.');
                    }
                    $created[] = [
                        'semester_id' => (int)$insert->insert_id,
                        'session_id' => $sessionId,
                        'term' => $term,
                        'start_date' => $startDate,
                        'end_date' => $endDate,
                        'status' => $status,
                    ];
                }
                $mysqli->commit();
            } catch (Throwable $e) {
                $mysqli->rollback();
                json_response(['error' => 'semester_generate_failed', 'message' => $e->getMessage()], 500);
            }

            log_system_action($mysqli, $authUserId, 'generate_semesters', "Generated 3 semesters for School Year: " . ($schoolYear['session_name'] ?? ('ID ' . $sessionId)));
            json_response([
                'session_id' => $sessionId,
                'session_name' => $schoolYear['session_name'] ?? null,
                'generated' => $created,
            ], 201);

        } elseif ($request_method === 'POST' && is_numeric($param1) && $param2 === 'update-semesters') {
            $sessionId = (int)$param1;

            $sySelect = ["school_year_id", "session_name"];
            if ($hasSyStart) $sySelect[] = "DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date";
            if ($hasSyEnd) $sySelect[] = "DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date";
            $syStmt = $mysqli->prepare("SELECT " . implode(', ', $sySelect) . " FROM tbl_school_year WHERE school_year_id = ? LIMIT 1");
            if (!$syStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $syStmt->bind_param('i', $sessionId);
            $syStmt->execute();
            $schoolYear = $syStmt->get_result()->fetch_assoc();
            if (!$schoolYear) json_response(['error' => 'not_found', 'message' => 'School year not found.'], 404);

            if (!isset($input['semesters']) || !is_array($input['semesters']) || count($input['semesters']) !== 3) {
                json_response(['error' => 'validation', 'message' => 'Exactly 3 semesters are required.'], 400);
            }

            $termAliases = [
                '1st sem' => '1st sem',
                '1st semester' => '1st sem',
                'first sem' => '1st sem',
                'first semester' => '1st sem',
                '2nd sem' => '2nd sem',
                '2nd semester' => '2nd sem',
                'second sem' => '2nd sem',
                'second semester' => '2nd sem',
                'summer' => 'summer',
            ];
            $termOrder = ['1st sem', '2nd sem', 'summer'];
            $normalized = [];

            foreach ($input['semesters'] as $idx => $sem) {
                if (!is_array($sem)) {
                    json_response(['error' => 'validation', 'message' => 'Invalid semester payload at row ' . ($idx + 1) . '.'], 400);
                }

                $rawTerm = strtolower(trim((string)($sem['term'] ?? '')));
                $term = $termAliases[$rawTerm] ?? null;
                if ($term === null) {
                    json_response(['error' => 'validation', 'message' => 'Invalid semester term at row ' . ($idx + 1) . '.'], 400);
                }
                if (isset($normalized[$term])) {
                    json_response(['error' => 'duplicate_semester_term', 'message' => "Duplicate term '$term' in request."], 409);
                }

                $start = trim((string)($sem['start_date'] ?? ''));
                $end = trim((string)($sem['end_date'] ?? ''));
                if (!$is_valid_iso_date($start) || !$is_valid_iso_date($end)) {
                    json_response(['error' => 'validation', 'message' => "Invalid date format for term '$term'. Use YYYY-MM-DD."], 400);
                }
                if (strtotime($start) > strtotime($end)) {
                    json_response(['error' => 'validation', 'message' => "start_date must be before end_date for '$term'."], 400);
                }

                if ($hasSyStart && $hasSyEnd) {
                    $syStart = (string)($schoolYear['start_date'] ?? '');
                    $syEnd = (string)($schoolYear['end_date'] ?? '');
                    if ($syStart !== '' && $syEnd !== '' && (strtotime($start) < strtotime($syStart) || strtotime($end) > strtotime($syEnd))) {
                        json_response([
                            'error' => 'semester_outside_school_year',
                            'message' => "Term '$term' must be within school year dates ($syStart to $syEnd).",
                        ], 409);
                    }
                }

                $normalized[$term] = [
                    'term' => $term,
                    'start_date' => $start,
                    'end_date' => $end,
                ];
            }

            foreach ($termOrder as $requiredTerm) {
                if (!isset($normalized[$requiredTerm])) {
                    json_response(['error' => 'validation', 'message' => "Missing required term '$requiredTerm'."], 400);
                }
            }

            for ($i = 0; $i < count($termOrder); $i++) {
                for ($j = $i + 1; $j < count($termOrder); $j++) {
                    $a = $normalized[$termOrder[$i]];
                    $b = $normalized[$termOrder[$j]];
                    if ($ranges_overlap($a['start_date'], $a['end_date'], $b['start_date'], $b['end_date'])) {
                        json_response([
                            'error' => 'semester_date_conflict',
                            'message' => "Date range conflict between '{$a['term']}' and '{$b['term']}'.",
                        ], 409);
                    }
                }
            }

            $firstSem = $normalized['1st sem'];
            $secondSem = $normalized['2nd sem'];
            $summer = $normalized['summer'];
            if (
                strtotime($firstSem['start_date']) > strtotime($secondSem['start_date']) ||
                strtotime($secondSem['start_date']) > strtotime($summer['start_date'])
            ) {
                json_response([
                    'error' => 'semester_sequence_invalid',
                    'message' => 'Semester date sequence must follow: 1st sem, 2nd sem, summer.',
                ], 409);
            }

            $existingStmt = $mysqli->prepare("
                SELECT semester_id, term, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date, status
                FROM tbl_semesters
                WHERE school_year_id = ?
                  AND status <> 'archive'
            ");
            if (!$existingStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $existingStmt->bind_param('i', $sessionId);
            $existingStmt->execute();
            $existingRows = $existingStmt->get_result()->fetch_all(MYSQLI_ASSOC);

            $existingByTerm = [];
            foreach ($existingRows as $row) {
                $normalizedExistingTerm = $termAliases[strtolower(trim((string)($row['term'] ?? '')))] ?? null;
                if ($normalizedExistingTerm === null) continue;
                if (isset($existingByTerm[$normalizedExistingTerm])) {
                    json_response([
                        'error' => 'duplicate_semester',
                        'message' => "Multiple semester rows found for term '$normalizedExistingTerm'. Please clean existing data first.",
                    ], 409);
                }
                $existingByTerm[$normalizedExistingTerm] = $row;
            }

            // Hard lock: if a semester already has schedules or attendance, date edits are not allowed.
            $hasSchedStmt = $mysqli->prepare("SELECT 1 FROM tbl_class_schedules WHERE semester_id = ? LIMIT 1");
            if (!$hasSchedStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $hasAttStmt = $mysqli->prepare("
                SELECT 1
                FROM tbl_attendance_records ar
                JOIN tbl_class_schedules cs ON ar.schedule_id = cs.schedule_id
                WHERE cs.semester_id = ?
                LIMIT 1
            ");
            if (!$hasAttStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);

            foreach ($termOrder as $termName) {
                if (!isset($existingByTerm[$termName])) continue;
                $existingSem = $existingByTerm[$termName];
                $semesterId = (int)($existingSem['semester_id'] ?? 0);
                if ($semesterId <= 0) continue;

                $hasSchedStmt->bind_param('i', $semesterId);
                $hasSchedStmt->execute();
                $hasSchedules = (bool)$hasSchedStmt->get_result()->fetch_assoc();

                $hasAttStmt->bind_param('i', $semesterId);
                $hasAttStmt->execute();
                $hasAttendance = (bool)$hasAttStmt->get_result()->fetch_assoc();

                if ($hasSchedules || $hasAttendance) {
                    json_response([
                        'error' => 'semester_restricted',
                        'message' => "Edit restricted for '$termName': this semester already has schedules or attendance records.",
                    ], 409);
                }
            }

            $targetIds = [];
            foreach ($termOrder as $termName) {
                if (isset($existingByTerm[$termName])) {
                    $targetIds[] = (int)($existingByTerm[$termName]['semester_id'] ?? 0);
                }
            }

            // Guard against overlap with any other semester rows not in the 3-term edit set.
            foreach ($existingRows as $row) {
                $rowId = (int)($row['semester_id'] ?? 0);
                if ($rowId > 0 && in_array($rowId, $targetIds, true)) continue;

                $otherStart = (string)($row['start_date'] ?? '');
                $otherEnd = (string)($row['end_date'] ?? '');
                if ($otherStart === '' || $otherEnd === '') continue;

                foreach ($termOrder as $termName) {
                    $candidate = $normalized[$termName];
                    if ($ranges_overlap($candidate['start_date'], $candidate['end_date'], $otherStart, $otherEnd)) {
                        json_response([
                            'error' => 'semester_date_conflict',
                            'message' => "Date conflict with existing semester '" . (string)($row['term'] ?? 'unknown') . "'.",
                        ], 409);
                    }
                }
            }

            $today = date('Y-m-d');
            $resultRows = [];
            $updateStmt = $mysqli->prepare("UPDATE tbl_semesters SET start_date = ?, end_date = ?, status = ? WHERE semester_id = ?");
            if (!$updateStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $insertStmt = $mysqli->prepare("INSERT INTO tbl_semesters (school_year_id, term, start_date, end_date, status) VALUES (?, ?, ?, ?, ?)");
            if (!$insertStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);

            $mysqli->begin_transaction();
            try {
                foreach ($termOrder as $termName) {
                    $target = $normalized[$termName];
                    $term = $target['term'];
                    $startDate = $target['start_date'];
                    $endDate = $target['end_date'];
                    $status = (strtotime($today) >= strtotime($startDate) && strtotime($today) <= strtotime($endDate)) ? 'active' : 'inactive';

                    if (isset($existingByTerm[$termName])) {
                        $semesterId = (int)$existingByTerm[$termName]['semester_id'];
                        $updateStmt->bind_param('sssi', $startDate, $endDate, $status, $semesterId);
                        if (!$updateStmt->execute()) {
                            throw new RuntimeException($updateStmt->error ?: 'Failed to update semester row.');
                        }
                    } else {
                        $insertStmt->bind_param('issss', $sessionId, $term, $startDate, $endDate, $status);
                        if (!$insertStmt->execute()) {
                            throw new RuntimeException($insertStmt->error ?: 'Failed to insert semester row.');
                        }
                        $semesterId = (int)$insertStmt->insert_id;
                    }

                    $resultRows[] = [
                        'semester_id' => $semesterId,
                        'session_id' => $sessionId,
                        'term' => $term,
                        'start_date' => $startDate,
                        'end_date' => $endDate,
                        'status' => $status,
                    ];
                }
                $mysqli->commit();
            } catch (Throwable $e) {
                $mysqli->rollback();
                json_response(['error' => 'semester_batch_update_failed', 'message' => $e->getMessage()], 500);
            }

            log_system_action($mysqli, $authUserId, 'update_semesters_batch', "Updated 3-semester plan for School Year: " . ($schoolYear['session_name'] ?? ('ID ' . $sessionId)));
            json_response([
                'session_id' => $sessionId,
                'session_name' => $schoolYear['session_name'] ?? null,
                'semesters' => $resultRows,
            ], 200);

        } elseif ($request_method === 'POST' && is_numeric($param1) && $param2 === 'restore') {
            $sessionId = (int)$param1;
            if (!$schoolYearArchiveTableExists()) json_response(['error' => 'not_found', 'message' => 'Archived school year not found.'], 404);

            $archivedStmt = $mysqli->prepare("SELECT school_year_id, session_name, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date FROM `{$schoolYearArchiveDb}`.`tbl_school_year` WHERE school_year_id = ? LIMIT 1");
            if (!$archivedStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $archivedStmt->bind_param('i', $sessionId); $archivedStmt->execute(); $archived = $archivedStmt->get_result()->fetch_assoc(); $archivedStmt->close();
            if (!$archived) json_response(['error' => 'not_found', 'message' => 'Archived school year not found.'], 404);

            $idCheck = $mysqli->prepare("SELECT school_year_id FROM tbl_school_year WHERE school_year_id = ? LIMIT 1");
            if (!$idCheck) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $idCheck->bind_param('i', $sessionId); $idCheck->execute(); $idExists = (bool)$idCheck->get_result()->fetch_assoc(); $idCheck->close();
            if ($idExists) json_response(['error' => 'restore_conflict', 'message' => 'A school year already uses this archived record ID.'], 409);

            $assert_school_year_conflicts((string)$archived['session_name'], (string)$archived['start_date'], (string)$archived['end_date'], 0);

            $mysqli->begin_transaction();
            try {
                $restoreStmt = $mysqli->prepare("INSERT INTO tbl_school_year (school_year_id, session_name, start_date, end_date, status) VALUES (?, ?, ?, ?, 'inactive')");
                if (!$restoreStmt) throw new RuntimeException($mysqli->error);
                $restoreStmt->bind_param('isss', $sessionId, $archived['session_name'], $archived['start_date'], $archived['end_date']);
                if (!$restoreStmt->execute()) throw new RuntimeException($restoreStmt->error);
                $restoreStmt->close();

                $deleteStmt = $mysqli->prepare("DELETE FROM `{$schoolYearArchiveDb}`.`tbl_school_year` WHERE school_year_id = ?");
                if (!$deleteStmt) throw new RuntimeException($mysqli->error);
                $deleteStmt->bind_param('i', $sessionId);
                if (!$deleteStmt->execute() || $deleteStmt->affected_rows !== 1) throw new RuntimeException('Unable to remove the restored school year from the archive.');
                $deleteStmt->close();
                $mysqli->commit();
            } catch (Throwable $e) {
                $mysqli->rollback();
                json_response(['error' => 'restore_failed', 'message' => $e->getMessage()], 500);
            }

            log_system_action($mysqli, $authUserId, 'restore_school_year', "Restored school year '{$archived['session_name']}' as inactive");
            json_response(['session_id' => $sessionId, 'status' => 'inactive', 'message' => 'School year restored as inactive.']);

        } elseif (($request_method === 'PUT' || $request_method === 'POST') && is_numeric($param1)) {
            $sessionId = (int)$param1;

            // CROSS-DATABASE ARCHIVING LOGIC
            if (isset($input['status']) && $input['status'] === 'archive') {
                $effectiveEnd = '';
                if ($hasSyEnd) {
                    $endChk = $mysqli->prepare("SELECT DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date FROM tbl_school_year WHERE school_year_id = ? LIMIT 1");
                    if (!$endChk) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                    $endChk->bind_param('i', $sessionId);
                    $endChk->execute();
                    $endRow = $endChk->get_result()->fetch_assoc() ?: [];
                    $effectiveEnd = trim((string)($endRow['end_date'] ?? ''));
                }
                if ($effectiveEnd === '') {
                    $semEndChk = $mysqli->prepare("SELECT DATE_FORMAT(MAX(end_date), '%Y-%m-%d') AS end_date FROM tbl_semesters WHERE school_year_id = ? AND status <> 'archive'");
                    if (!$semEndChk) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                    $semEndChk->bind_param('i', $sessionId);
                    $semEndChk->execute();
                    $semEndRow = $semEndChk->get_result()->fetch_assoc() ?: [];
                    $effectiveEnd = trim((string)($semEndRow['end_date'] ?? ''));
                }

                if ($effectiveEnd === '') {
                    json_response([
                        'error' => 'school_year_not_completed',
                        'message' => 'Cannot archive this school year yet because its completion date is unknown.',
                    ], 409);
                }

                $today = date('Y-m-d');
                if (strtotime($today) <= strtotime($effectiveEnd)) {
                    json_response([
                        'error' => 'school_year_not_completed',
                        'message' => "Cannot archive this school year yet. It is not completed until after $effectiveEnd.",
                    ], 409);
                }

                $chk = $mysqli->prepare("SELECT semester_id FROM tbl_semesters WHERE school_year_id = ? LIMIT 1");
                if (!$chk) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $chk->bind_param("i", $sessionId);
                $chk->execute();
                if ($chk->get_result()->fetch_assoc()) json_response(['error' => 'in_use', 'message' => 'Cannot archive: Please archive all semesters inside this school year first.'], 409);

                try {
                    $ensureSchoolYearArchiveTable();
                    $mysqli->begin_transaction();
                    $removeOld = $mysqli->prepare("DELETE FROM `{$schoolYearArchiveDb}`.`tbl_school_year` WHERE school_year_id = ?");
                    if (!$removeOld) throw new RuntimeException($mysqli->error);
                    $removeOld->bind_param('i', $sessionId); $removeOld->execute(); $removeOld->close();

                    $copy = $mysqli->prepare("INSERT INTO `{$schoolYearArchiveDb}`.`tbl_school_year` SELECT * FROM tbl_school_year WHERE school_year_id = ?");
                    if (!$copy) throw new RuntimeException($mysqli->error);
                    $copy->bind_param('i', $sessionId);
                    if (!$copy->execute() || $copy->affected_rows !== 1) throw new RuntimeException('Unable to copy the school year into the archive.');
                    $copy->close();

                    $delete = $mysqli->prepare("DELETE FROM tbl_school_year WHERE school_year_id = ?");
                    if (!$delete) throw new RuntimeException($mysqli->error);
                    $delete->bind_param('i', $sessionId);
                    if (!$delete->execute() || $delete->affected_rows !== 1) throw new RuntimeException('Unable to remove the archived school year from the active database.');
                    $delete->close();
                    $mysqli->commit();
                } catch (Throwable $e) {
                    $mysqli->rollback();
                    json_response(['error' => 'archive_failed', 'message' => $e->getMessage()], 500);
                }
                log_system_action($mysqli, $authUserId, 'archive_school_year', "Archived school year ID {$sessionId}");
                json_response(['session_id' => $sessionId, 'status' => 'archived']);
            }

            $existingCols = ['school_year_id', 'session_name'];
            if ($hasSyStart) $existingCols[] = "DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date";
            if ($hasSyEnd) $existingCols[] = "DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date";
            if ($hasSyStatus) $existingCols[] = "status";
            $existingStmt = $mysqli->prepare("SELECT " . implode(', ', $existingCols) . " FROM tbl_school_year WHERE school_year_id = ? LIMIT 1");
            if (!$existingStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $existingStmt->bind_param('i', $sessionId);
            $existingStmt->execute();
            $existing = $existingStmt->get_result()->fetch_assoc();
            if (!$existing) json_response(['error' => 'not_found', 'message' => 'School year not found'], 404);

            $name = trim((string)($input['session_name'] ?? $existing['session_name']));
            if ($name === '') json_response(['error' => 'validation', 'message' => 'session_name is required'], 400);

            $start = $hasSyStart ? (string)($input['start_date'] ?? $existing['start_date']) : null;
            $end = $hasSyEnd ? (string)($input['end_date'] ?? $existing['end_date']) : null;

            if (($hasSyStart || $hasSyEnd) && (empty($start) || empty($end))) {
                json_response(['error' => 'validation', 'message' => 'start_date and end_date are required'], 400);
            }
            if ($hasSyStart && !$is_valid_iso_date($start)) {
                json_response(['error' => 'validation', 'message' => 'Invalid start_date format. Use YYYY-MM-DD.'], 400);
            }
            if ($hasSyEnd && !$is_valid_iso_date($end)) {
                json_response(['error' => 'validation', 'message' => 'Invalid end_date format. Use YYYY-MM-DD.'], 400);
            }
            if ($hasSyStart && $hasSyEnd && strtotime($start) > strtotime($end)) {
                json_response(['error' => 'validation', 'message' => 'start_date must be before end_date'], 400);
            }

            // Policy:
            // - Editable while planning.
            // - Once schedules/attendance exist, date edits are allowed only if they still cover all real data.
            if ($hasSyStart && $hasSyEnd) {
                $oldStart = (string)($existing['start_date'] ?? '');
                $oldEnd = (string)($existing['end_date'] ?? '');
                $datesChanged = ($start !== $oldStart || $end !== $oldEnd);

                if ($datesChanged) {
                    $hasSchedules = false;
                    $hasAttendance = false;
                    $attMin = null;
                    $attMax = null;

                    $schedChk = $mysqli->prepare("
                        SELECT 1
                        FROM tbl_class_schedules cs
                        JOIN tbl_semesters s ON cs.semester_id = s.semester_id
                        WHERE s.school_year_id = ?
                          AND s.status <> 'archive'
                        LIMIT 1
                    ");
                    if (!$schedChk) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                    $schedChk->bind_param('i', $sessionId);
                    $schedChk->execute();
                    $hasSchedules = (bool)$schedChk->get_result()->fetch_assoc();

                    $attBounds = $mysqli->prepare("
                        SELECT
                            DATE_FORMAT(MIN(ar.date), '%Y-%m-%d') AS min_date,
                            DATE_FORMAT(MAX(ar.date), '%Y-%m-%d') AS max_date
                        FROM tbl_attendance_records ar
                        JOIN tbl_class_schedules cs ON ar.schedule_id = cs.schedule_id
                        JOIN tbl_semesters s ON cs.semester_id = s.semester_id
                        WHERE s.school_year_id = ?
                          AND s.status <> 'archive'
                    ");
                    if (!$attBounds) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                    $attBounds->bind_param('i', $sessionId);
                    $attBounds->execute();
                    $attRow = $attBounds->get_result()->fetch_assoc();
                    $attMin = isset($attRow['min_date']) ? (string)$attRow['min_date'] : null;
                    $attMax = isset($attRow['max_date']) ? (string)$attRow['max_date'] : null;
                    $hasAttendance = (!empty($attMin) && !empty($attMax));

                    if ($hasSchedules || $hasAttendance) {
                        $semBounds = $mysqli->prepare("
                            SELECT
                                DATE_FORMAT(MIN(start_date), '%Y-%m-%d') AS min_start,
                                DATE_FORMAT(MAX(end_date), '%Y-%m-%d') AS max_end
                            FROM tbl_semesters
                            WHERE school_year_id = ?
                              AND status <> 'archive'
                        ");
                        if (!$semBounds) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                        $semBounds->bind_param('i', $sessionId);
                        $semBounds->execute();
                        $semRange = $semBounds->get_result()->fetch_assoc() ?: [];
                        $semMin = (string)($semRange['min_start'] ?? '');
                        $semMax = (string)($semRange['max_end'] ?? '');

                        if ($semMin !== '' && strtotime($start) > strtotime($semMin)) {
                            json_response([
                                'error' => 'school_year_restricted',
                                'message' => "Date change restricted: start_date must be on or before $semMin because schedules already exist.",
                            ], 409);
                        }
                        if ($semMax !== '' && strtotime($end) < strtotime($semMax)) {
                            json_response([
                                'error' => 'school_year_restricted',
                                'message' => "Date change restricted: end_date must be on or after $semMax because schedules already exist.",
                            ], 409);
                        }

                        if ($hasAttendance) {
                            if (strtotime($start) > strtotime((string)$attMin)) {
                                json_response([
                                    'error' => 'school_year_restricted',
                                    'message' => "Date change restricted: start_date must be on or before $attMin because attendance already exists.",
                                ], 409);
                            }
                            if (strtotime($end) < strtotime((string)$attMax)) {
                                json_response([
                                    'error' => 'school_year_restricted',
                                    'message' => "Date change restricted: end_date must be on or after $attMax because attendance already exists.",
                                ], 409);
                            }
                        }
                    }
                }
            }

            $assert_school_year_conflicts($name, $start, $end, $sessionId);

            $status = $hasSyStatus ? (string)($existing['status'] ?? 'inactive') : 'inactive';
            if ($hasSyStatus) {
                if ($hasSyStart && $hasSyEnd) {
                    $today = date('Y-m-d');
                    $status = (strtotime($today) >= strtotime($start) && strtotime($today) <= strtotime($end)) ? 'active' : 'inactive';
                } else {
                    $candidate = strtolower(trim((string)($input['status'] ?? $status)));
                    $status = in_array($candidate, ['active', 'inactive', 'archive'], true) ? $candidate : 'inactive';
                }
            }

            $fields = ['session_name = ?'];
            $types = 's';
            $values = [$name];
            if ($hasSyStart) { $fields[] = 'start_date = ?'; $types .= 's'; $values[] = $start; }
            if ($hasSyEnd) { $fields[] = 'end_date = ?'; $types .= 's'; $values[] = $end; }
            if ($hasSyStatus) { $fields[] = 'status = ?'; $types .= 's'; $values[] = $status; }

            $sql = "UPDATE tbl_school_year SET " . implode(', ', $fields) . " WHERE school_year_id = ?";
            $stmt = $mysqli->prepare($sql);
            if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $types .= 'i';
            $values[] = $sessionId;
            $stmt->bind_param($types, ...$values);
            if (!$stmt->execute()) json_response(['error' => 'update_failed', 'message' => $stmt->error], 500);

            $payload = ['session_id' => $sessionId, 'session_name' => $name, 'status' => $status];
            if ($hasSyStart) $payload['start_date'] = $start;
            if ($hasSyEnd) $payload['end_date'] = $end;
            json_response($payload);

        } elseif ($request_method === 'POST') {
            if (empty($input['session_name'])) json_response(['error' => 'validation', 'message' => 'session_name is required'], 400);

            $name = trim((string)$input['session_name']);
            $start = isset($input['start_date']) ? trim((string)$input['start_date']) : null;
            $end = isset($input['end_date']) ? trim((string)$input['end_date']) : null;

            if (($hasSyStart || $hasSyEnd) && (empty($start) || empty($end))) {
                json_response(['error' => 'validation', 'message' => 'start_date and end_date are required'], 400);
            }
            if ($hasSyStart && !$is_valid_iso_date($start)) {
                json_response(['error' => 'validation', 'message' => 'Invalid start_date format. Use YYYY-MM-DD.'], 400);
            }
            if ($hasSyEnd && !$is_valid_iso_date($end)) {
                json_response(['error' => 'validation', 'message' => 'Invalid end_date format. Use YYYY-MM-DD.'], 400);
            }
            if ($hasSyStart && $hasSyEnd && strtotime($start) > strtotime($end)) {
                json_response(['error' => 'validation', 'message' => 'start_date must be before end_date'], 400);
            }

            $assert_school_year_conflicts($name, $start, $end, 0);

            $status = 'inactive';
            if ($hasSyStatus) {
                if ($hasSyStart && $hasSyEnd) {
                    $today = date('Y-m-d');
                    $status = (strtotime($today) >= strtotime($start) && strtotime($today) <= strtotime($end)) ? 'active' : 'inactive';
                }
            }

            $insertCols = ['session_name'];
            $placeholders = ['?'];
            $types = 's';
            $values = [$name];
            if ($hasSyStart) { $insertCols[] = 'start_date'; $placeholders[] = '?'; $types .= 's'; $values[] = $start; }
            if ($hasSyEnd) { $insertCols[] = 'end_date'; $placeholders[] = '?'; $types .= 's'; $values[] = $end; }
            if ($hasSyStatus) { $insertCols[] = 'status'; $placeholders[] = '?'; $types .= 's'; $values[] = $status; }

            $stmt = $mysqli->prepare("INSERT INTO tbl_school_year (" . implode(', ', $insertCols) . ") VALUES (" . implode(', ', $placeholders) . ")");
            if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $stmt->bind_param($types, ...$values);
            if (!$stmt->execute()) json_response(['error' => 'insert_failed', 'message' => $stmt->error], 500);

            $newSyId = (int)$stmt->insert_id;
            log_system_action($mysqli, $authUserId, 'create_school_year', "Created School Year: $name");

            $payload = ['session_id' => $newSyId, 'session_name' => $name, 'status' => $status];
            if ($hasSyStart) $payload['start_date'] = $start;
            if ($hasSyEnd) $payload['end_date'] = $end;
            json_response($payload, 201);
        }
        break;

    case 'semesters':
        if ($request_method === 'GET') {
            // FIX: ORDER BY sy.school_year_id to prevent database crash
            $result = $mysqli->query("SELECT s.semester_id, s.school_year_id AS session_id, sy.session_name, s.term, DATE_FORMAT(s.start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(s.end_date, '%Y-%m-%d') AS end_date, s.status, (SELECT COUNT(*) FROM tbl_class_schedules cs WHERE cs.semester_id = s.semester_id) AS schedule_count, (SELECT COUNT(*) FROM tbl_attendance_records ar JOIN tbl_class_schedules cs2 ON ar.schedule_id = cs2.schedule_id WHERE cs2.semester_id = s.semester_id) AS attendance_count FROM tbl_semesters s LEFT JOIN tbl_school_year sy ON s.school_year_id = sy.school_year_id ORDER BY sy.school_year_id DESC, s.semester_id ASC");
            if (!$result) json_response(['error' => 'query_failed', 'message' => $mysqli->error], 500);
            json_response($result->fetch_all(MYSQLI_ASSOC));

        } elseif (($request_method === 'PUT' || $request_method === 'POST') && is_numeric($param1)) {
            $semesterId = (int)$param1;

            // CROSS-DATABASE ARCHIVING LOGIC
            if (isset($input['status']) && $input['status'] === 'archive') {
                $archiveDB = 'bk_teacher_gps_archive';
                $schk = $mysqli->prepare("SELECT schedule_id FROM tbl_class_schedules WHERE semester_id = ? LIMIT 1");
                $schk->bind_param("i", $semesterId);
                $schk->execute();
                if ($schk->get_result()->fetch_assoc()) json_response(['error' => 'in_use', 'message' => 'Cannot archive: Semester has class schedules. Archive schedules first.'], 409);

                $mysqli->query("INSERT INTO $archiveDB.tbl_semesters SELECT * FROM tbl_semesters WHERE semester_id = $semesterId");
                $mysqli->query("DELETE FROM tbl_semesters WHERE semester_id = $semesterId");
                json_response(['semester_id' => $semesterId, 'status' => 'archived']);
            }

            // ONLY ALLOW UPDATING DATES NOW (Term name and Session ID are locked)
            $start = isset($input['start_date']) ? trim((string)$input['start_date']) : '';
            $end = isset($input['end_date']) ? trim((string)$input['end_date']) : '';
            if ($start === '' || $end === '') {
                json_response(['error' => 'validation', 'message' => 'start_date and end_date are required'], 400);
            }

            $isValidIsoDate = function (string $value): bool {
                if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)) return false;
                $dt = DateTime::createFromFormat('Y-m-d', $value);
                return $dt && $dt->format('Y-m-d') === $value;
            };
            if (!$isValidIsoDate($start) || !$isValidIsoDate($end)) {
                json_response(['error' => 'validation', 'message' => 'Invalid date format. Use YYYY-MM-DD.'], 400);
            }
            if (strtotime($start) > strtotime($end)) {
                json_response(['error' => 'validation', 'message' => 'start_date must be before end_date'], 400);
            }

            $semInfo = $mysqli->prepare("SELECT semester_id, school_year_id, term FROM tbl_semesters WHERE semester_id = ? LIMIT 1");
            if (!$semInfo) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $semInfo->bind_param('i', $semesterId);
            $semInfo->execute();
            $currentSem = $semInfo->get_result()->fetch_assoc();
            if (!$currentSem) json_response(['error' => 'not_found', 'message' => 'Semester not found'], 404);
            $schoolYearId = (int)$currentSem['school_year_id'];
            $termName = (string)($currentSem['term'] ?? '');

            // Hard lock: if this semester already has schedules or attendance, do not allow date edits.
            $schedExists = $mysqli->prepare("SELECT 1 FROM tbl_class_schedules WHERE semester_id = ? LIMIT 1");
            if (!$schedExists) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $schedExists->bind_param('i', $semesterId);
            $schedExists->execute();
            $hasSchedules = (bool)$schedExists->get_result()->fetch_assoc();

            $attExists = $mysqli->prepare("
                SELECT 1
                FROM tbl_attendance_records ar
                JOIN tbl_class_schedules cs ON ar.schedule_id = cs.schedule_id
                WHERE cs.semester_id = ?
                LIMIT 1
            ");
            if (!$attExists) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $attExists->bind_param('i', $semesterId);
            $attExists->execute();
            $hasAttendance = (bool)$attExists->get_result()->fetch_assoc();

            if ($hasSchedules || $hasAttendance) {
                json_response([
                    'error' => 'semester_restricted',
                    'message' => "Edit restricted: semester '$termName' already has schedules or attendance records.",
                ], 409);
            }

            // Optional guard: keep semester dates within parent school year bounds when columns exist.
            $syCols = [];
            $syColsRes = $mysqli->query("SHOW COLUMNS FROM tbl_school_year");
            if ($syColsRes) {
                while ($col = $syColsRes->fetch_assoc()) {
                    $syCols[strtolower((string)$col['Field'])] = true;
                }
            }
            if (isset($syCols['start_date']) && isset($syCols['end_date'])) {
                $syStmt = $mysqli->prepare("SELECT DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date FROM tbl_school_year WHERE school_year_id = ? LIMIT 1");
                if ($syStmt) {
                    $syStmt->bind_param('i', $schoolYearId);
                    $syStmt->execute();
                    $sy = $syStmt->get_result()->fetch_assoc();
                    if ($sy && !empty($sy['start_date']) && !empty($sy['end_date'])) {
                        if (strtotime($start) < strtotime((string)$sy['start_date']) || strtotime($end) > strtotime((string)$sy['end_date'])) {
                            json_response([
                                'error' => 'semester_outside_school_year',
                                'message' => "Semester dates must be within school year range {$sy['start_date']} to {$sy['end_date']}.",
                            ], 409);
                        }
                    }
                }
            }

            // Disallow overlap/conflict with other semesters in the same school year.
            $conflict = $mysqli->prepare("
                SELECT semester_id, term
                FROM tbl_semesters
                WHERE school_year_id = ?
                  AND semester_id <> ?
                  AND start_date <= ?
                  AND end_date >= ?
                LIMIT 1
            ");
            if (!$conflict) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $conflict->bind_param('iiss', $schoolYearId, $semesterId, $end, $start);
            $conflict->execute();
            $hit = $conflict->get_result()->fetch_assoc();
            if ($hit) {
                json_response([
                    'error' => 'semester_date_conflict',
                    'message' => "Date conflict with semester '" . ($hit['term'] ?? 'unknown') . "'. Overlapping semester dates are not allowed.",
                ], 409);
            }

            $today = date('Y-m-d');
            $status = (strtotime($today) >= strtotime($start) && strtotime($today) <= strtotime($end)) ? 'active' : 'inactive';

            $stmt = $mysqli->prepare("UPDATE tbl_semesters SET start_date=?, end_date=?, status=? WHERE semester_id=?");
            if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $stmt->bind_param("sssi", $start, $end, $status, $semesterId);
            if (!$stmt->execute()) json_response(['error' => 'update_failed', 'message' => $stmt->error], 500);

            log_system_action($mysqli, $authUserId, 'update_semester_dates', "Updated dates for Semester '$termName' (ID $semesterId)");
            json_response(['semester_id' => $semesterId, 'status' => $status]);
        }
        break;

    case 'year-levels':
        if ($request_method === 'GET') {
            $result = $mysqli->query("SELECT year_id, level FROM tbl_year_level ORDER BY year_id");
            if (!$result) json_response(['error' => 'query_failed', 'message' => $mysqli->error], 500);
            json_response($result->fetch_all(MYSQLI_ASSOC));
        }
        break;

    case 'sessions':
        if ($request_method === 'GET') {
            $result = $mysqli->query("SELECT school_year_id AS session_id, session_name FROM tbl_school_year ORDER BY session_name");
            if (!$result) json_response(['error' => 'query_failed', 'message' => $mysqli->error], 500);
            json_response($result->fetch_all(MYSQLI_ASSOC));
        }
        break;

    case 'subjects':
        if ($request_method === 'GET') {
            $paginateSubjects = isset($_GET['paginate']) && (string)$_GET['paginate'] === '1';
            $subjectIdentityList = isset($_GET['identities']) && (string)$_GET['identities'] === '1';
            $subjectPage = isset($_GET['page']) && is_numeric($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
            $subjectPageSize = isset($_GET['page_size']) && is_numeric($_GET['page_size']) ? max(1, min(100, (int)$_GET['page_size'])) : 10;
            $subjectDeptId = isset($_GET['dept_id']) && is_numeric($_GET['dept_id']) ? (int)$_GET['dept_id'] : null;
            $subjectProgramId = isset($_GET['program_id']) && is_numeric($_GET['program_id']) ? (int)$_GET['program_id'] : null;
            $subjectStatus = strtolower(trim((string)($_GET['status'] ?? '')));
            $subjectSearch = trim((string)($_GET['search'] ?? ''));
            if ($subjectStatus !== '' && !in_array($subjectStatus, ['active', 'inactive', 'archive'], true)) {
                json_response(['error' => 'invalid_status', 'message' => 'Invalid subject status filter.'], 422);
            }

            $subjectScopeConditions = [];
            if ((int)$authRole === 3) {
                $subjectScopeConditions[] = $programHeadScopeCondition('p');
            } elseif (in_array((int)$authRole, [2, 4, 6], true)) {
                if ($authDeptId === null) {
                    if ($paginateSubjects) json_response(['rows' => [], 'pagination' => ['page' => 1, 'page_size' => $subjectPageSize, 'total' => 0, 'total_pages' => 1], 'status_counts' => ['active' => 0, 'inactive' => 0, 'archive' => 0]]);
                    json_response([]);
                }
                $subjectScopeConditions[] = 'p.dept_id = ' . intval($authDeptId);
            } elseif ((int)$authRole !== 1 && $authRole !== null) {
                if ($paginateSubjects) json_response(['rows' => [], 'pagination' => ['page' => 1, 'page_size' => $subjectPageSize, 'total' => 0, 'total_pages' => 1], 'status_counts' => ['active' => 0, 'inactive' => 0, 'archive' => 0]]);
                json_response([]);
            }

            $subjectScopeFromSql = " FROM tbl_subject s LEFT JOIN tbl_programs p ON s.program_id = p.program_id";
            $subjectFromSql = $subjectScopeFromSql . " LEFT JOIN tbl_departments d ON p.dept_id = d.dept_id";
            $subjectScopeWhereSql = $subjectScopeConditions ? ' WHERE ' . implode(' AND ', $subjectScopeConditions) : '';

            if ($subjectIdentityList) {
                $identityConditions = $subjectScopeConditions;
                if ($subjectProgramId !== null) $identityConditions[] = 's.program_id = ' . intval($subjectProgramId);
                $identityWhereSql = $identityConditions ? ' WHERE ' . implode(' AND ', $identityConditions) : '';
                $identityResult = $mysqli->query("SELECT s.subject_id, s.program_id, s.subject_code, s.subject_name" . $subjectScopeFromSql . $identityWhereSql . " ORDER BY s.program_id, s.subject_code");
                if (!$identityResult) json_response(['error' => 'query_failed', 'message' => $mysqli->error], 500);
                json_response($identityResult->fetch_all(MYSQLI_ASSOC));
            }

            $subjectSelectSql = "SELECT s.subject_id, s.subject_code, s.subject_name, s.program_id, p.program_name, p.sub_name AS program_sub_name, s.status, p.head_id, p.dept_id, d.dept_name, d.sub_name AS department_sub_name";
            if (!$paginateSubjects) {
                $result = $mysqli->query($subjectSelectSql . $subjectFromSql . $subjectScopeWhereSql . " ORDER BY p.program_name, s.subject_code");
                if (!$result) json_response(['error' => 'query_failed', 'message' => $mysqli->error], 500);
                json_response($result->fetch_all(MYSQLI_ASSOC));
            }

            $subjectConditions = $subjectScopeConditions;
            $subjectTypes = '';
            $subjectParams = [];
            if ($subjectDeptId !== null) { $subjectConditions[] = 'p.dept_id = ?'; $subjectTypes .= 'i'; $subjectParams[] = $subjectDeptId; }
            if ($subjectProgramId !== null) { $subjectConditions[] = 's.program_id = ?'; $subjectTypes .= 'i'; $subjectParams[] = $subjectProgramId; }
            if ($subjectStatus !== '') { $subjectConditions[] = 'LOWER(TRIM(s.status)) = ?'; $subjectTypes .= 's'; $subjectParams[] = $subjectStatus; }
            if ($subjectSearch !== '') {
                $subjectConditions[] = "(s.subject_code LIKE ? OR s.subject_name LIKE ? OR p.program_name LIKE ? OR p.sub_name LIKE ? OR d.dept_name LIKE ? OR d.sub_name LIKE ?)";
                $subjectNeedle = '%' . $subjectSearch . '%';
                $subjectTypes .= 'ssssss';
                array_push($subjectParams, $subjectNeedle, $subjectNeedle, $subjectNeedle, $subjectNeedle, $subjectNeedle, $subjectNeedle);
            }
            $subjectWhereSql = $subjectConditions ? ' WHERE ' . implode(' AND ', $subjectConditions) : '';

            $subjectCountStmt = $mysqli->prepare('SELECT COUNT(*) AS total' . $subjectFromSql . $subjectWhereSql);
            if (!$subjectCountStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            if ($subjectTypes !== '') $subjectCountStmt->bind_param($subjectTypes, ...$subjectParams);
            $subjectCountStmt->execute();
            $subjectTotal = (int)($subjectCountStmt->get_result()->fetch_assoc()['total'] ?? 0);
            $subjectCountStmt->close();
            $subjectTotalPages = max(1, (int)ceil($subjectTotal / $subjectPageSize));
            $subjectPage = min($subjectPage, $subjectTotalPages);
            $subjectOffset = ($subjectPage - 1) * $subjectPageSize;

            $subjectDataStmt = $mysqli->prepare($subjectSelectSql . $subjectFromSql . $subjectWhereSql . " ORDER BY p.program_name, s.subject_code LIMIT ? OFFSET ?");
            if (!$subjectDataStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $subjectDataTypes = $subjectTypes . 'ii';
            $subjectDataParams = array_merge($subjectParams, [$subjectPageSize, $subjectOffset]);
            $subjectDataStmt->bind_param($subjectDataTypes, ...$subjectDataParams);
            $subjectDataStmt->execute();
            $subjectRows = $subjectDataStmt->get_result()->fetch_all(MYSQLI_ASSOC);
            $subjectDataStmt->close();

            $subjectStatusCounts = ['active' => 0, 'inactive' => 0, 'archive' => 0];
            $subjectStatusResult = $mysqli->query("SELECT LOWER(TRIM(s.status)) AS subject_status, COUNT(*) AS total" . $subjectScopeFromSql . $subjectScopeWhereSql . " GROUP BY LOWER(TRIM(s.status))");
            if (!$subjectStatusResult) json_response(['error' => 'query_failed', 'message' => $mysqli->error], 500);
            while ($statusRow = $subjectStatusResult->fetch_assoc()) {
                $statusKey = (string)($statusRow['subject_status'] ?? '');
                if (array_key_exists($statusKey, $subjectStatusCounts)) $subjectStatusCounts[$statusKey] = (int)$statusRow['total'];
            }

            json_response([
                'rows' => $subjectRows,
                'pagination' => ['page' => $subjectPage, 'page_size' => $subjectPageSize, 'total' => $subjectTotal, 'total_pages' => $subjectTotalPages],
                'status_counts' => $subjectStatusCounts,
            ]);

        } elseif (($request_method === 'PUT' || $request_method === 'POST') && is_numeric($param1)) {
            $requireAcademicManageAccess('subjects');
            $subjectId = (int)$param1;

            if ($param2 === 'toggle') {
                $q = $mysqli->prepare("SELECT status, subject_code, program_id FROM tbl_subject WHERE subject_id = ? LIMIT 1");
                if (!$q) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $q->bind_param("i", $subjectId);
                $q->execute();
                $row = $q->get_result()->fetch_assoc();
                if (!$row) json_response(['error' => 'not_found', 'message' => 'Subject not found'], 404);
                $assertProgramScopeAccess((int)$row['program_id'], 'subjects');
                if (strtolower(trim((string)$row['status'])) === 'archive') {
                    json_response(['error' => 'archived_record_locked', 'message' => 'Restore this subject to inactive before activating it.'], 409);
                }
                
                $subjCode = $row['subject_code']; 
                $new = ($row['status'] === 'active') ? 'inactive' : 'active';
                if ($new === 'active') $assertActiveProgramHierarchy((int)$row['program_id']);
                
                $up = $mysqli->prepare("UPDATE tbl_subject SET status = ? WHERE subject_id = ?");
                if (!$up) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
                $up->bind_param("si", $new, $subjectId);
                if (!$up->execute()) json_response(['error' => 'update_failed', 'message' => $up->error], 500);
                
                log_system_action($mysqli, $authUserId, 'toggle_subject', "Changed status of Subject '$subjCode' to $new");

                try { trigger_socket_update(['entity' => 'subjects', 'action' => 'toggle', 'subject_id' => $subjectId]); } catch (Throwable $_) {}
                json_response(['subject_id' => $subjectId, 'status' => $new]);
            }

            $chk = $mysqli->prepare("SELECT subject_id, program_id, subject_code, subject_name, status FROM tbl_subject WHERE subject_id = ? LIMIT 1");
            if (!$chk) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $chk->bind_param("i", $subjectId);
            $chk->execute();
            $existing = $chk->get_result()->fetch_assoc();
            if (!$existing) json_response(['error' => 'not_found', 'message' => 'Subject not found'], 404);
            $assertProgramScopeAccess((int)$existing['program_id'], 'subjects');
            $assertAcademicArchivedUpdateAllowed($existing['status'] ?? null, $input);
            $oldCode = $existing['subject_code'];

            $fields = [];
            $types = '';
            $values = [];
            if (isset($input['program_id'])) { $fields[] = 'program_id = ?'; $types .= 'i'; $values[] = (int)$input['program_id']; }
            if (isset($input['subject_code'])) { $fields[] = 'subject_code = ?'; $types .= 's'; $values[] = trim((string)$input['subject_code']); }
            if (isset($input['subject_name'])) { $fields[] = 'subject_name = ?'; $types .= 's'; $values[] = trim((string)$input['subject_name']); }
            if (isset($input['status'])) {
                $input['status'] = $prepareAcademicStatusTransition('subject', $subjectId, $existing['status'] ?? null, $input['status']);
                $fields[] = 'status = ?'; $types .= 's'; $values[] = $input['status'];
            }

            if (empty($fields)) json_response(['message' => 'Nothing to update'], 200);

            $candidateProgram = isset($input['program_id']) ? (int)$input['program_id'] : (int)$existing['program_id'];
            $candidateCode = isset($input['subject_code']) ? trim((string)$input['subject_code']) : $existing['subject_code'];
            $candidateName = isset($input['subject_name']) ? trim((string)$input['subject_name']) : $existing['subject_name'];

            if ($candidateCode === '') json_response(['error' => 'validation', 'message' => 'subject_code is required'], 400);
            if ($candidateName === '') json_response(['error' => 'validation', 'message' => 'subject_name is required'], 400);

            $assertProgramScopeAccess($candidateProgram, 'subjects');
            $candidateStatus = strtolower(trim((string)($input['status'] ?? $existing['status'] ?? 'inactive')));
            if ($candidateStatus === 'active') $assertActiveProgramHierarchy($candidateProgram);

            $dup = $mysqli->prepare("SELECT subject_id FROM tbl_subject WHERE (LOWER(subject_code) = LOWER(?) OR LOWER(subject_name) = LOWER(?)) AND program_id = ? AND subject_id <> ? LIMIT 1");
            if (!$dup) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $dup->bind_param("ssii", $candidateCode, $candidateName, $candidateProgram, $subjectId);
            $dup->execute();
            if ($dup->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_subject', 'message' => 'A subject with the same code or name already exists for the selected program.'], 409);

            $sql = "UPDATE tbl_subject SET " . implode(', ', $fields) . " WHERE subject_id = ?";
            $stmt = $mysqli->prepare($sql);
            if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $types .= 'i'; $values[] = $subjectId;
            $stmt->bind_param($types, ...$values);
            if (!$stmt->execute()) json_response(['error' => 'update_failed', 'message' => $stmt->error], 500);
            
            $targetCode = isset($input['subject_code']) ? $input['subject_code'] : $oldCode;
            log_system_action($mysqli, $authUserId, 'update_subject', "Updated Subject '$targetCode'");

            try { trigger_socket_update(['entity' => 'subjects', 'action' => 'update', 'subject_id' => $subjectId]); } catch (Throwable $_) {}
            json_response(['subject_id' => $subjectId] + $input);

        } elseif ($request_method === 'POST') {
            $requireAcademicCreateAccess('subjects');
            if (!isset($input['program_id']) || $input['program_id'] === '' || !is_numeric($input['program_id'])) json_response(['error' => 'missing_program_id', 'message' => 'program_id is required and must reference an existing program'], 400);
            if (!isset($input['subject_code']) || trim((string)$input['subject_code']) === '') json_response(['error' => 'missing_subject_code', 'message' => 'subject_code is required'], 400);
            if (!isset($input['subject_name']) || trim((string)$input['subject_name']) === '') json_response(['error' => 'missing_subject_name', 'message' => 'subject_name is required'], 400);

            $programId = (int)$input['program_id'];
            $code = trim((string)$input['subject_code']);
            $name = trim((string)$input['subject_name']);

            $assertProgramScopeAccess($programId, 'subjects');
            $assertActiveProgramHierarchy($programId);

            $dup = $mysqli->prepare("SELECT subject_id FROM tbl_subject WHERE (LOWER(subject_code) = LOWER(?) OR LOWER(subject_name) = LOWER(?)) AND program_id = ? LIMIT 1");
            if (!$dup) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $dup->bind_param("ssi", $code, $name, $programId);
            $dup->execute();
            if ($dup->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_subject', 'message' => 'A subject with the same code or name already exists for the selected program.'], 409);

            $stmt = $mysqli->prepare("INSERT INTO tbl_subject (program_id, subject_code, subject_name, status) VALUES (?, ?, ?, 'active')");
            if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $stmt->bind_param("iss", $programId, $code, $name);
            if (!$stmt->execute()) json_response(['error' => 'insert_failed', 'message' => $stmt->error], 500);
            
            log_system_action($mysqli, $authUserId, 'create_subject', "Created new subject: $code ($name)");

            try { trigger_socket_update(['entity' => 'subjects', 'action' => 'create', 'subject_id' => $stmt->insert_id]); } catch (Throwable $_) {}
            json_response(['subject_id' => $stmt->insert_id, 'program_id' => $programId, 'subject_code' => $code, 'subject_name' => $name], 201);
        }
        break;

    case 'subject-offerings':
        $offeringsTableCheck = $mysqli->query("SHOW TABLES LIKE 'tbl_subject_offerings'");
        $hasOfferingsTable = $offeringsTableCheck && $offeringsTableCheck->num_rows > 0;
        $offeringScopeWhere = '';
        if ((int)$authRole === 6) {
            if ($authDeptId === null) json_response([]);
            $offeringScopeWhere = ' WHERE p.dept_id = ' . (int)$authDeptId;
        } elseif ((int)$authRole === 3) {
            $offeringScopeWhere = ' WHERE ' . $programHeadScopeCondition('p');
        } elseif (in_array((int)$authRole, [2, 4], true)) {
            if ($authDeptId === null) json_response([]);
            $offeringScopeWhere = ' WHERE p.dept_id = ' . (int)$authDeptId;
        }
        $offeringScopeWhere .= ($offeringScopeWhere === '' ? ' WHERE ' : ' AND ') . 'u.role_id IN (2, 3, 4, 5)';

        if (!$hasOfferingsTable) {
            if ($request_method === 'GET') {
                $fallback = $mysqli->query("
                    SELECT DISTINCT
                        NULL AS offering_id,
                        cs.semester_id,
                        cs.subject_id,
                        cs.section_id,
                        cs.user_id,
                        s.subject_code,
                        s.subject_name,
                        sec.section_name,
                        sem.term,
                        CONCAT(u.first_name, ' ', u.last_name) AS teacher_name,
                        u.dept_id AS teacher_dept_id,
                        p.program_id,
                        p.head_id,
                        p.dept_id AS program_dept_id
                    FROM tbl_class_schedules cs
                    LEFT JOIN tbl_subject s ON cs.subject_id = s.subject_id
                    LEFT JOIN tbl_programs p ON s.program_id = p.program_id
                    LEFT JOIN tbl_sections sec ON cs.section_id = sec.section_id
                    LEFT JOIN tbl_semesters sem ON cs.semester_id = sem.semester_id
                    LEFT JOIN tbl_users u ON cs.user_id = u.user_id
                    {$offeringScopeWhere}
                    ORDER BY s.subject_code, sec.section_name
                ");
                if (!$fallback) json_response(['error' => 'query_failed', 'message' => $mysqli->error], 500);
                json_response($fallback->fetch_all(MYSQLI_ASSOC));
            }

            json_response([
                'error' => 'subject_offerings_unavailable',
                'message' => 'tbl_subject_offerings is not available in this database schema'
            ], 409);
        }

        if ($request_method === 'GET') {
            $result = $mysqli->query("
                SELECT so.offering_id, so.semester_id, so.subject_id, so.section_id, so.user_id, 
                       s.subject_code, s.subject_name, sec.section_name, sem.term, 
                       CONCAT(u.first_name, ' ', u.last_name) AS teacher_name, 
                       u.dept_id AS teacher_dept_id,
                       p.program_id, p.head_id, p.dept_id AS program_dept_id
                FROM tbl_subject_offerings so 
                LEFT JOIN tbl_subject s ON so.subject_id = s.subject_id 
                LEFT JOIN tbl_programs p ON s.program_id = p.program_id
                LEFT JOIN tbl_sections sec ON so.section_id = sec.section_id 
                LEFT JOIN tbl_semesters sem ON so.semester_id = sem.semester_id 
                LEFT JOIN tbl_users u ON so.user_id = u.user_id 
                {$offeringScopeWhere}
                ORDER BY s.subject_code, sec.section_name
            ");
            if (!$result) json_response(['error' => 'query_failed', 'message' => $mysqli->error], 500);
            json_response($result->fetch_all(MYSQLI_ASSOC));

        } elseif (($request_method === 'PUT' || $request_method === 'POST') && is_numeric($param1) && $param2 !== 'delete') {
            $requireAcademicManageAccess('subject offerings');
            $offeringId = (int)$param1;

            $chk = $mysqli->prepare("SELECT so.offering_id, so.semester_id, so.subject_id, so.section_id, so.user_id, s.subject_code, sec.section_name FROM tbl_subject_offerings so LEFT JOIN tbl_subject s ON so.subject_id = s.subject_id LEFT JOIN tbl_sections sec ON so.section_id = sec.section_id WHERE so.offering_id = ? LIMIT 1");
            if (!$chk) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $chk->bind_param("i", $offeringId);
            $chk->execute();
            $existing = $chk->get_result()->fetch_assoc();
            if (!$existing) json_response(['error' => 'not_found', 'message' => 'Offering not found'], 404);
            
            $logDetails = ($existing['subject_code'] ?? 'Unknown Subject') . ' - ' . ($existing['section_name'] ?? 'Unknown Section');

            $fields = [];
            $types = '';
            $values = [];
            if (isset($input['semester_id'])) { $fields[] = 'semester_id = ?'; $types .= 'i'; $values[] = (int)$input['semester_id']; }
            if (isset($input['subject_id'])) { $fields[] = 'subject_id = ?'; $types .= 'i'; $values[] = (int)$input['subject_id']; }
            if (isset($input['section_id'])) { $fields[] = 'section_id = ?'; $types .= 'i'; $values[] = (int)$input['section_id']; }
            if (array_key_exists('user_id', $input)) { $fields[] = 'user_id = ?'; $types .= 'i'; $values[] = $input['user_id'] === '' ? null : (int)$input['user_id']; }

            if (empty($fields)) json_response(['message' => 'Nothing to update'], 200);

            $candidateSemester = isset($input['semester_id']) ? (int)$input['semester_id'] : (int)$existing['semester_id'];
            $candidateSubject = isset($input['subject_id']) ? (int)$input['subject_id'] : (int)$existing['subject_id'];
            $candidateSection = isset($input['section_id']) ? (int)$input['section_id'] : (int)$existing['section_id'];
            $assertSubjectScopeAccess($candidateSubject, 'subject offerings');
            $assertSectionScopeAccess($candidateSection, 'subject offerings');
            $candidateTeacher = array_key_exists('user_id', $input)
                ? (($input['user_id'] === '' || $input['user_id'] === null) ? null : (int)$input['user_id'])
                : (isset($existing['user_id']) && $existing['user_id'] !== null ? (int)$existing['user_id'] : null);
            $assertAcademicTeacherScope($candidateTeacher);
            $assertActiveOfferingDependencies($candidateSemester, $candidateSubject, $candidateSection, $candidateTeacher);

            if (isset($input['semester_id'])) {
                $sechk = $mysqli->prepare("SELECT semester_id FROM tbl_semesters WHERE semester_id = ? LIMIT 1");
                $sechk->bind_param("i", $candidateSemester);
                $sechk->execute();
                if (!$sechk->get_result()->fetch_assoc()) json_response(['error' => 'invalid_semester_id', 'message' => 'Selected semester does not exist'], 400);
            }

            if (isset($input['subject_id'])) {
                $pchk = $mysqli->prepare("SELECT subject_id FROM tbl_subject WHERE subject_id = ? LIMIT 1");
                $pchk->bind_param("i", $candidateSubject);
                $pchk->execute();
                if (!$pchk->get_result()->fetch_assoc()) json_response(['error' => 'invalid_subject_id', 'message' => 'Selected subject does not exist'], 400);
            }
            if (isset($input['section_id'])) {
                $schk = $mysqli->prepare("SELECT section_id FROM tbl_sections WHERE section_id = ? LIMIT 1");
                $schk->bind_param("i", $candidateSection);
                $schk->execute();
                if (!$schk->get_result()->fetch_assoc()) json_response(['error' => 'invalid_section_id', 'message' => 'Selected section does not exist'], 400);
            }

            $dup = $mysqli->prepare("SELECT offering_id FROM tbl_subject_offerings WHERE subject_id = ? AND section_id = ? AND semester_id = ? AND offering_id <> ? LIMIT 1");
            $dup->bind_param("iiii", $candidateSubject, $candidateSection, $candidateSemester, $offeringId);
            $dup->execute();
            if ($dup->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_offering', 'message' => 'The same subject offering (subject + section + semester) already exists.'], 409);

            $sql = "UPDATE tbl_subject_offerings SET " . implode(', ', $fields) . " WHERE offering_id = ?";
            $stmt = $mysqli->prepare($sql);
            if (!$stmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $types .= 'i'; $values[] = $offeringId;
            $stmt->bind_param($types, ...$values);
            if (!$stmt->execute()) json_response(['error' => 'update_failed', 'message' => $stmt->error], 500);
            
            log_system_action($mysqli, $authUserId, 'update_offering', "Updated offering details for: $logDetails");

            try { trigger_socket_update(['entity' => 'subject-offerings', 'action' => 'update', 'offering_id' => $offeringId]); } catch (Throwable $_) {}
            json_response(['offering_id' => $offeringId] + $input);

        } elseif ($request_method === 'DELETE' && is_numeric($param1)) {
            $requireAcademicManageAccess('subject offerings');
            $offeringId = (int)$param1;
            $scopeStmt = $mysqli->prepare("SELECT subject_id, section_id FROM tbl_subject_offerings WHERE offering_id = ? LIMIT 1");
            if (!$scopeStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
            $scopeStmt->bind_param('i', $offeringId);
            $scopeStmt->execute();
            $scopeRow = $scopeStmt->get_result()->fetch_assoc();
            if (!$scopeRow) json_response(['error' => 'not_found', 'message' => 'Offering not found'], 404);
            $assertSubjectScopeAccess((int)$scopeRow['subject_id'], 'subject offerings');
            $assertSectionScopeAccess((int)$scopeRow['section_id'], 'subject offerings');
            
            // Check if offering is used in class schedules
            $schk = $mysqli->prepare("SELECT schedule_id FROM tbl_class_schedules WHERE offering_id = ? LIMIT 1");
            $schk->bind_param("i", $offeringId);
            $schk->execute();
            if ($schk->get_result()->fetch_assoc()) {
                json_response(['error' => 'offering_in_use', 'message' => 'Cannot delete: Offering is already assigned to a class schedule.'], 409);
            }

            $stmt = $mysqli->prepare("DELETE FROM tbl_subject_offerings WHERE offering_id = ?");
            $stmt->bind_param("i", $offeringId);
            $stmt->execute();
            
            if ($stmt->affected_rows === 0) json_response(['error' => 'not_found', 'message' => 'Offering not found'], 404);
            
            log_system_action($mysqli, $authUserId, 'delete_offering', "Deleted offering ID $offeringId");
            try { trigger_socket_update(['entity' => 'subject-offerings', 'action' => 'delete', 'offering_id' => $offeringId]); } catch (Throwable $_) {}
            json_response(['deleted' => true]);

        } elseif ($request_method === 'POST' && is_numeric($param1) && $param2 === 'delete') {
             $requireAcademicManageAccess('subject offerings');
             // Wrapper for standard fallback DELETE
             $offeringId = (int)$param1;
             $scopeStmt = $mysqli->prepare("SELECT subject_id, section_id FROM tbl_subject_offerings WHERE offering_id = ? LIMIT 1");
             if (!$scopeStmt) json_response(['error' => 'prepare_failed', 'message' => $mysqli->error], 500);
             $scopeStmt->bind_param('i', $offeringId);
             $scopeStmt->execute();
             $scopeRow = $scopeStmt->get_result()->fetch_assoc();
             if (!$scopeRow) json_response(['error' => 'not_found', 'message' => 'Offering not found'], 404);
             $assertSubjectScopeAccess((int)$scopeRow['subject_id'], 'subject offerings');
             $assertSectionScopeAccess((int)$scopeRow['section_id'], 'subject offerings');
             $schk = $mysqli->prepare("SELECT schedule_id FROM tbl_class_schedules WHERE offering_id = ? LIMIT 1");
             $schk->bind_param("i", $offeringId);
             $schk->execute();
             if ($schk->get_result()->fetch_assoc()) json_response(['error' => 'offering_in_use', 'message' => 'Cannot delete: Offering is already assigned to a class schedule.'], 409);
 
             $stmt = $mysqli->prepare("DELETE FROM tbl_subject_offerings WHERE offering_id = ?");
             $stmt->bind_param("i", $offeringId);
             $stmt->execute();
             if ($stmt->affected_rows === 0) json_response(['error' => 'not_found', 'message' => 'Offering not found'], 404);
             
             log_system_action($mysqli, $authUserId, 'delete_offering', "Deleted offering ID $offeringId");
             try { trigger_socket_update(['entity' => 'subject-offerings', 'action' => 'delete', 'offering_id' => $offeringId]); } catch (Throwable $_) {}
             json_response(['deleted' => true]);

        } elseif ($request_method === 'POST') {
            $requireAcademicCreateAccess('subject offerings');
            
            if (isset($input['rows']) && is_array($input['rows'])) {
                // (Optional feature enabled if you decide to upload excel for offerings)
                // We parse standard objects and try to map to IDs.
                $rows = $input['rows'];
                $errors = []; $inserted = 0; $skipped = 0;
                
                // Get lookup maps
                $subjRes = $mysqli->query("SELECT s.subject_id, s.subject_code FROM tbl_subject s JOIN tbl_programs p ON p.program_id = s.program_id JOIN tbl_departments d ON d.dept_id = p.dept_id WHERE LOWER(TRIM(COALESCE(s.status, 'active'))) IN ('active','1','true') AND LOWER(TRIM(COALESCE(p.status, 'active'))) IN ('active','1','true') AND LOWER(TRIM(COALESCE(d.status, 'active'))) IN ('active','1','true')");
                $subjMap = []; while($r = $subjRes->fetch_assoc()) $subjMap[strtolower(trim($r['subject_code']))] = $r['subject_id'];

                $secRes = $mysqli->query("SELECT sec.section_id, sec.section_name FROM tbl_sections sec JOIN tbl_programs p ON p.program_id = sec.program_id JOIN tbl_departments d ON d.dept_id = p.dept_id WHERE LOWER(TRIM(COALESCE(sec.status, 'active'))) IN ('active','1','true') AND LOWER(TRIM(COALESCE(p.status, 'active'))) IN ('active','1','true') AND LOWER(TRIM(COALESCE(d.status, 'active'))) IN ('active','1','true')");
                $secMap = []; while($r = $secRes->fetch_assoc()) $secMap[strtolower(trim($r['section_name']))] = $r['section_id'];

                $semRes = $mysqli->query("SELECT sem.semester_id, sem.term FROM tbl_semesters sem JOIN tbl_school_year sy ON sy.school_year_id = sem.school_year_id WHERE LOWER(TRIM(COALESCE(sem.status, 'active'))) IN ('active','1','true') AND LOWER(TRIM(COALESCE(sy.status, 'active'))) IN ('active','1','true')");
                $semMap = []; while($r = $semRes->fetch_assoc()) $semMap[strtolower(trim($r['term']))] = $r['semester_id'];

                $stmt = $mysqli->prepare("INSERT INTO tbl_subject_offerings (semester_id, subject_id, section_id) VALUES (?, ?, ?)");

                foreach ($rows as $idx => $row) {
                    $rowNum = $idx + 2;
                    if (!is_array($row)) continue;
                    
                    // normalizer
                    $normalized = [];
                    foreach ($row as $k => $v) { $normalized[preg_replace('/[^a-z0-9]+/', '_', strtolower(trim($k)))] = $v; }

                    $codeRaw = $normalized['subject_code'] ?? $normalized['code'] ?? null;
                    $secRaw = $normalized['section_name'] ?? $normalized['section'] ?? null;
                    $semRaw = $normalized['semester'] ?? $normalized['term'] ?? null;

                    $subId = $codeRaw ? ($subjMap[strtolower(trim($codeRaw))] ?? null) : null;
                    $secId = $secRaw ? ($secMap[strtolower(trim($secRaw))] ?? null) : null;
                    $semId = $semRaw ? ($semMap[strtolower(trim($semRaw))] ?? null) : null;

                    if (!$subId || !$secId || !$semId) {
                        $errors[] = ['row' => $rowNum, 'message' => "Missing/invalid map for Subj: $codeRaw, Sec: $secRaw, Sem: $semRaw"];
                        continue;
                    }
                    $assertSubjectScopeAccess((int)$subId, 'subject offerings');
                    $assertSectionScopeAccess((int)$secId, 'subject offerings');
                    $assertActiveOfferingDependencies((int)$semId, (int)$subId, (int)$secId, null);

                    // duplicate check
                    $dup = $mysqli->prepare("SELECT offering_id FROM tbl_subject_offerings WHERE subject_id=? AND section_id=? AND semester_id=?");
                    $dup->bind_param("iii", $subId, $secId, $semId);
                    $dup->execute();
                    if ($dup->get_result()->fetch_assoc()) { $skipped++; continue; }

                    $stmt->bind_param("iii", $semId, $subId, $secId);
                    if ($stmt->execute()) { $inserted++; } else { $errors[] = ['row' => $rowNum, 'message' => $stmt->error]; }
                }
                json_response(['inserted' => $inserted, 'skipped' => $skipped, 'total_rows' => count($rows), 'errors' => $errors]);
            }

            // Normal Create Form logic
            if (!isset($input['semester_id']) || $input['semester_id'] === '' || !is_numeric($input['semester_id'])) json_response(['error' => 'missing_semester_id', 'message' => 'semester_id is required and must reference an existing semester'], 400);
            if (!isset($input['subject_id']) || $input['subject_id'] === '' || !is_numeric($input['subject_id'])) json_response(['error' => 'missing_subject_id', 'message' => 'subject_id is required and must reference an existing subject'], 400);
            if (!isset($input['section_id']) || $input['section_id'] === '' || !is_numeric($input['section_id'])) json_response(['error' => 'missing_section_id', 'message' => 'section_id is required and must reference an existing section'], 400);

            $semesterId = (int)$input['semester_id'];
            $subjectId = (int)$input['subject_id'];
            $sectionId = (int)$input['section_id'];
            $userId = isset($input['user_id']) && $input['user_id'] !== '' ? (int)$input['user_id'] : null;
            $assertSubjectScopeAccess($subjectId, 'subject offerings');
            $assertSectionScopeAccess($sectionId, 'subject offerings');
            $assertAcademicTeacherScope($userId);
            $assertActiveOfferingDependencies($semesterId, $subjectId, $sectionId, $userId);

            $subj = $mysqli->query("SELECT subject_code FROM tbl_subject WHERE subject_id = $subjectId")->fetch_assoc();
            $sect = $mysqli->query("SELECT section_name FROM tbl_sections WHERE section_id = $sectionId")->fetch_assoc();
            $logInfo = ($subj['subject_code'] ?? 'Unknown Subject') . ' - ' . ($sect['section_name'] ?? 'Unknown Section');

            $sstmt = $mysqli->prepare("SELECT semester_id FROM tbl_semesters WHERE semester_id = ? LIMIT 1");
            $sstmt->bind_param("i", $semesterId);
            $sstmt->execute();
            if (!$sstmt->get_result()->fetch_assoc()) json_response(['error' => 'invalid_semester_id', 'message' => 'Selected semester does not exist'], 400);

            $pstmt = $mysqli->prepare("SELECT subject_id FROM tbl_subject WHERE subject_id = ? LIMIT 1");
            $pstmt->bind_param("i", $subjectId);
            $pstmt->execute();
            if (!$pstmt->get_result()->fetch_assoc()) json_response(['error' => 'invalid_subject_id', 'message' => 'Selected subject does not exist'], 400);

            $schk = $mysqli->prepare("SELECT section_id FROM tbl_sections WHERE section_id = ? LIMIT 1");
            $schk->bind_param("i", $sectionId);
            $schk->execute();
            if (!$schk->get_result()->fetch_assoc()) json_response(['error' => 'invalid_section_id', 'message' => 'Selected section does not exist'], 400);

            $dup = $mysqli->prepare("SELECT offering_id FROM tbl_subject_offerings WHERE subject_id = ? AND section_id = ? AND semester_id = ? LIMIT 1");
            $dup->bind_param("iii", $subjectId, $sectionId, $semesterId);
            $dup->execute();
            if ($dup->get_result()->fetch_assoc()) json_response(['error' => 'duplicate_offering', 'message' => 'The same subject offering (subject + section + semester) already exists.'], 409);

            $stmt = $mysqli->prepare("INSERT INTO tbl_subject_offerings (semester_id, subject_id, section_id, user_id) VALUES (?, ?, ?, ?)");
            $stmt->bind_param("iiii", $semesterId, $subjectId, $sectionId, $userId);
            if (!$stmt->execute()) json_response(['error' => 'db_insert_failed', 'message' => $stmt->error], 500);
            
            log_system_action($mysqli, $authUserId, 'create_offering', "Created offering: $logInfo");

            try { trigger_socket_update(['entity' => 'subject-offerings', 'action' => 'create', 'offering_id' => $stmt->insert_id]); } catch (Throwable $_) {}
            json_response(['offering_id' => $stmt->insert_id, 'semester_id' => $semesterId, 'subject_id' => $subjectId, 'section_id' => $sectionId, 'user_id' => $userId], 201);
        }
        break;
}
?>
