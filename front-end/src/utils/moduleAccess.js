export const ROLE_ID_TO_NAME = {
  1: 'admin',
  2: 'dean',
  3: 'program_head',
  4: 'secretary',
  5: 'teacher',
  6: 'department_admin',
};

export const PERMISSION_MATRIX = {
  dashboard: ['admin', 'dean', 'department_admin', 'program_head', 'secretary'],
  faculty_dashboard: ['dean', 'program_head', 'secretary', 'teacher'],
  users: ['admin', 'dean', 'department_admin', 'program_head', 'secretary'],
  attendance: ['dean', 'program_head', 'secretary', 'teacher'],
  attendancemgmt: ['admin', 'secretary', 'dean', 'department_admin', 'program_head'],
  class_schedules: ['admin', 'dean', 'department_admin', 'program_head', 'secretary'],
  '3d_building': ['admin', 'dean', 'department_admin', 'program_head', 'secretary'],
  attendance_edits: ['dean'],
  academic_admin: ['admin'],
  academic_manage: ['admin', 'department_admin'],
  academic_program: ['admin', 'department_admin'],
  locations: ['admin'],
  floor_qr: ['admin', 'dean', 'department_admin', 'program_head', 'secretary'],
  reports: ['admin', 'dean', 'department_admin', 'program_head', 'secretary', 'teacher'],
  leaves_file: ['dean', 'department_admin'],
  leaves_approvals: ['dean', 'department_admin'],
  substitutions: ['dean', 'department_admin'],
  penalties: ['dean', 'department_admin', 'program_head', 'secretary'],
  logs: ['admin', 'dean', 'department_admin'],
  settings: ['admin', 'dean', 'department_admin'],
  attendance_logs: ['admin', 'dean', 'department_admin'],
  calendar_events: ['admin', 'department_admin'],
};

export const MODULE_LABELS = {
  dashboard: 'Dashboard',
  faculty_dashboard: 'My Dashboard',
  users: 'User Management',
  attendance: 'Faculty Portal / Attendance',
  attendancemgmt: 'Attendance Records',
  class_schedules: 'Class Schedules',
  '3d_building': '3D Campus Map',
  attendance_edits: 'Attendance Edit Requests',
  academic_admin: 'Academic Admin (Dept/School Year)',
  academic_manage: 'Academic Manage (Sections/Subjects)',
  academic_program: 'Program Management',
  locations: 'Facility Management',
  floor_qr: 'Floor QR Downloads',
  reports: 'Reports',
  leaves_file: 'File Leave',
  leaves_approvals: 'Leave Approvals',
  substitutions: 'Substitutions',
  penalties: 'Penalties & Sanctions',
  logs: 'System Logs',
  settings: 'General Settings',
  attendance_logs: 'Attendance Logs',
  calendar_events: 'Holidays & Events',
};

export const ALL_MODULES = Object.keys(PERMISSION_MATRIX);
const ALL_MODULE_LOOKUP = ALL_MODULES.reduce((acc, key) => {
  acc[key] = true;
  return acc;
}, {});

export function normalizeModuleToken(value) {
  const token = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!token) return '';
  return ALL_MODULE_LOOKUP[token] ? token : '';
}

export function resolveRoleName(userLike) {
  if (!userLike || typeof userLike !== 'object') return null;
  const possibleIds = [userLike.role_id, userLike.roleId, userLike.roleid, userLike.roleID];
  for (const id of possibleIds) {
    const num = Number(id);
    if (!Number.isNaN(num) && ROLE_ID_TO_NAME[num]) return ROLE_ID_TO_NAME[num];
  }
  const names = [userLike.role, userLike.role_name, userLike.roleName];
  for (const name of names) {
    const clean = String(name || '').trim().toLowerCase();
    if (clean) return clean;
  }
  return null;
}

export function getRoleDefaultModules(roleName) {
  const role = String(roleName || '').trim().toLowerCase();
  if (!role) return [];
  const out = [];
  for (const [moduleKey, roles] of Object.entries(PERMISSION_MATRIX)) {
    if (Array.isArray(roles) && roles.includes(role)) out.push(moduleKey);
  }
  out.sort();
  return out;
}

export function parseModulePermissions(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = null;
    }
  }
  const allowRaw = Array.isArray(parsed?.allow) ? parsed.allow : [];
  const denyRaw = Array.isArray(parsed?.deny) ? parsed.deny : [];
  const normalizeList = (list) => {
    const seen = {};
    const out = [];
    for (const entry of list) {
      const token = normalizeModuleToken(entry);
      if (!token || seen[token]) continue;
      seen[token] = true;
      out.push(token);
    }
    out.sort();
    return out;
  };
  return {
    allow: normalizeList(allowRaw),
    deny: normalizeList(denyRaw),
  };
}

export function getEffectiveModules(userLike) {
  const roleName = resolveRoleName(userLike);
  const base = getRoleDefaultModules(roleName);
  const bag = parseModulePermissions(userLike?.module_permissions);
  const effective = {};
  for (const m of base) effective[m] = true;
  for (const m of bag.allow) {
    // Explicit grants are validated by the server-side module-access endpoint.
    // They may intentionally add a safe module outside the role defaults.
    if (ALL_MODULE_LOOKUP[m]) effective[m] = true;
  }
  for (const m of bag.deny) delete effective[m];
  if (roleName === 'department_admin') {
    delete effective.faculty_dashboard;
    delete effective.attendance;
  }
  if (!['admin', 'department_admin'].includes(roleName)) {
    delete effective.academic_manage;
    delete effective.academic_program;
  }
  if (roleName !== 'admin') delete effective.academic_admin;
  if (roleName !== 'dean') delete effective.attendance_edits;
  if (!['dean', 'department_admin'].includes(roleName)) delete effective.leaves_file;
  const fixedRoleModules = {
    attendance_logs: ['admin', 'dean', 'department_admin'],
    leaves_approvals: ['dean', 'department_admin'],
    leaves_file: ['dean', 'department_admin'],
    substitutions: ['dean', 'department_admin'],
    penalties: ['dean', 'department_admin', 'program_head', 'secretary'],
    calendar_events: ['admin', 'department_admin'],
  };
  for (const [moduleKey, allowedRoles] of Object.entries(fixedRoleModules)) {
    if (!allowedRoles.includes(roleName)) delete effective[moduleKey];
  }
  return Object.keys(effective).sort();
}

export function canAccessModule(userLike, moduleKey) {
  if (!moduleKey) return true;
  const token = normalizeModuleToken(moduleKey);
  if (!token) return false;
  const effective = getEffectiveModules(userLike);
  return effective.includes(token);
}

export function getDeanManageableModules() {
  const roleNames = ['program_head', 'secretary', 'teacher'];
  const bag = {};
  for (const roleName of roleNames) {
    const defaults = getRoleDefaultModules(roleName);
    for (const moduleKey of defaults) bag[moduleKey] = true;
  }
  return Object.keys(bag).sort();
}

export function getPermissionFromRoute(routePath) {
  const p = String(routePath || '').toLowerCase();
  if (p.startsWith('/login')) return null;
  if (p.startsWith('/faculty-dashboard')) return 'faculty_dashboard';
  if (p.startsWith('/attendancemgmt')) return 'attendancemgmt';
  if (p.startsWith('/attendance-logs') || p.startsWith('/logs') || p.startsWith('/attedance_audit')) return 'attendance_logs';
  if (p.startsWith('/system-logs') || p.startsWith('/systemlogs')) return 'logs';
  if (p.startsWith('/attendance-edit-requests')) return 'attendance_edits';
  if (p.startsWith('/attendance-history') || p.startsWith('/my-attendance') || p.startsWith('/my-requested-edits') || p.startsWith('/attendance')) return 'attendance';
  if (p.startsWith('/dashboard')) return 'dashboard';
  if (p.startsWith('/users')) return 'users';
  if (p.startsWith('/3d-building')) return '3d_building';
  if (p.startsWith('/class-schedules')) return 'class_schedules';
  if (p.startsWith('/calendar-events')) return 'calendar_events';
  if (p.startsWith('/departments') || p.startsWith('/school_year')) return 'academic_admin';
  if (p.startsWith('/programs')) return 'academic_program';
  if (p.startsWith('/semesters')) return 'academic_admin';
  if (p.startsWith('/sections') || p.startsWith('/subjects') || p.startsWith('/subject-offerings')) return 'academic_manage';
  if (p.startsWith('/floors')) return 'floor_qr';
  if (p.startsWith('/building') || p.startsWith('/rooms')) return 'locations';
  if (p.startsWith('/school')) return 'settings';
  if (p.startsWith('/file_leave')) return 'leaves_file';
  if (p.startsWith('/leave_approval')) return 'leaves_approvals';
  if (p.startsWith('/substitute') || p.startsWith('/substitutions')) return 'substitutions';
  if (p.startsWith('/penalties')) return 'penalties';
  if (p.startsWith('/reports')) return 'reports';
  if (p.startsWith('/settings')) return 'settings';
  return null;
}
