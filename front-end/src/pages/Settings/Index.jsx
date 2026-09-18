import React from 'react';
import { AuthContext } from '../../context/AuthContext.jsx';
import { apiGet, apiPut } from '../../services/api.js';
import { MODULE_LABELS } from '../../utils/moduleAccess.js';
import './Index.css';
import LoginAttemptMonitor from './LoginAttemptMonitoring.jsx';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';
import { SecurityPolicyPanel, SettingsActivityPanel } from './AdminSettingsPanels.jsx';
import LoadingState from '../../components/LoadingState.jsx';
import UserStatusBadge, { normalizeUserStatus } from '../../components/UserStatusBadge.jsx';

const MODULE_CATEGORY_ORDER = ['Attendance', 'Academic', 'Facility', 'Faculty Portal', 'Reports', 'Administration', 'Other'];
const SETTINGS_LANDING_CARDS = [
  {
    id: 'module_access',
    title: 'Module Access Settings',
    description: 'Manage module permissions per user and override role defaults when needed.',
    tag: 'Access Control',
    state: 'ready',
    icon: 'bi-person-gear',
    group: 'Security & Access',
    cta: 'Open Module Access',
  },
  {
    id: 'home_content',
    title: 'Home Content Settings',
    description: 'Customize the home page headline and preview its color before publishing.',
    tag: 'Home Page',
    state: 'ready',
    icon: 'bi-palette',
    group: 'Appearance',
    cta: 'Customize Text',
  },
  {
    id: 'locked_account',
    title: 'Locked Account',
    description: 'View and manage temporarily locked user accounts after failed login attempts.',
    tag: 'Security',
    state: 'ready',
    icon: 'bi-lock',
    group: 'Security & Access',
    cta: 'Manage Locked Accounts',
  },
  {
    id: 'change_password',
    title: 'Password Reset Settings',
    description: 'Handle account password resets and forced password update policies.',
    tag: 'Security',
    state: 'ready',
    icon: 'bi-key',
    group: 'Security & Access',
    cta: 'Open Password Reset',
  },
  {
    id: 'login_monitor',
    title: 'Login Attempt Monitor',
    description: 'Track suspicious login spikes and failed authentication trends.',
    tag: 'Monitoring',
    state: 'ready',
    icon: 'bi-activity',
    group: 'Monitoring & Audit',
    cta: 'Open Monitor',
  },
  { id:'settings_activity', title:'Settings Activity', description:'Review security-sensitive configuration and account actions.', tag:'Audit', state:'ready', icon:'bi-clock-history', group:'Monitoring & Audit', cta:'View Activity' },
  {
    id: 'security_policy',
    title: 'Security Policy Rules',
    description: 'Set password standards, lockout thresholds, and session controls.',
    tag: 'Policy',
    state: 'ready',
    icon: 'bi-shield-lock',
    group: 'Security & Access',
    cta: 'Configure Policy',
  },
];

const SETTINGS_GROUPS = [
  { name: 'Security & Access', description: 'Accounts, permissions, passwords, and server-enforced protection.', icon: 'bi-shield-check' },
  { name: 'Monitoring & Audit', description: 'Review sign-in activity and administrator actions.', icon: 'bi-graph-up-arrow' },
  { name: 'Appearance', description: 'Control the content users see on the application home page.', icon: 'bi-brush' },
];

const DEFAULT_HOME_TITLE = 'Welcome to COC Attendance WEB';
const DEFAULT_HOME_TITLE_COLOR = '#c69500';
const HOME_TITLE_COLOR_PRESETS = ['#c69500', '#0f5132', '#166534', '#0d6efd', '#7c3aed', '#dc2626'];

function getHomeHeadlineStyle(title, color = DEFAULT_HOME_TITLE_COLOR) {
  const text = String(title || '').trim();
  const length = text.length;
  const longestWord = text.split(/\s+/).reduce((max, word) => Math.max(max, word.length), 0);
  const weight = Math.max(length, longestWord * 1.4);

  let fontSize = 'clamp(1.45rem, 2.4vw, 2.2rem)';
  if (weight <= 14) {
    fontSize = 'clamp(2.35rem, 5vw, 4.25rem)';
  } else if (weight <= 24) {
    fontSize = 'clamp(2.1rem, 4.4vw, 3.75rem)';
  } else if (weight <= 38) {
    fontSize = 'clamp(1.85rem, 3.6vw, 3rem)';
  } else if (weight <= 56) {
    fontSize = 'clamp(1.6rem, 2.9vw, 2.45rem)';
  }

  return {
    color,
    display: 'block',
    maxWidth: '100%',
    margin: 0,
    fontSize,
    fontWeight: 900,
    lineHeight: 0.96,
    letterSpacing: 0,
    overflowWrap: 'anywhere',
  };
}

function formatRoleName(roleName) {
  const raw = String(roleName || '').trim();
  if (!raw) return 'Unknown';
  return raw
    .replace(/_/g, ' ')
    .split(/\s+/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : ''))
    .join(' ');
}

function sortUnique(list) {
  return Array.from(new Set((Array.isArray(list) ? list : []).map((x) => String(x || '').trim()).filter(Boolean))).sort();
}

function formatModuleLabel(moduleKey) {
  const label = MODULE_LABELS[moduleKey];
  if (label) return label;
  return String(moduleKey || '')
    .replace(/_/g, ' ')
    .trim()
    .split(/\s+/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : ''))
    .join(' ');
}

function detectModuleCategory(moduleKey) {
  const key = String(moduleKey || '').toLowerCase();
  if (!key) return 'Other';

  if (/(attendance|edit_request|schedule_edit|audit|logs)/.test(key)) return 'Attendance';
  if (/(subject|program|department|section|semester|school_year|class_schedule|offering)/.test(key)) return 'Academic';
  if (/(building|room|floor|3d|school)/.test(key)) return 'Facility';
  if (/(faculty|my_|leave|substitute)/.test(key)) return 'Faculty Portal';
  if (/(report)/.test(key)) return 'Reports';
  if (/(user|dashboard|settings|penalt|system_log)/.test(key)) return 'Administration';
  return 'Other';
}

function getInitials(firstName, lastName) {
  const a = String(firstName || '').trim().charAt(0).toUpperCase();
  const b = String(lastName || '').trim().charAt(0).toUpperCase();
  return `${a}${b}`.trim() || 'U';
}

function getDepartmentLabel(user) {
  const deptName = String(user?.dept_name || user?.department || '').trim();
  if (deptName) return deptName;
  const deptId = user?.dept_id;
  return deptId !== null && deptId !== undefined && String(deptId) !== '' ? `Department #${deptId}` : 'No Department';
}

export default function GeneralSettingsIndex() {
  const { user } = React.useContext(AuthContext) || {};
  const roleId = Number(user?.role_id || 0);
  const isAdmin = roleId === 1;
  const isDean = roleId === 2;
  const isDepartmentAdmin = roleId === 6;
  const canManage = isAdmin || isDean || isDepartmentAdmin;
  const canManageModuleAccess = isAdmin || isDepartmentAdmin;
  const [routePath, setRoutePath] = React.useState(window.location.hash.slice(1) || '/settings/system');

  const [managedUsers, setManagedUsers] = React.useState([]);
  const [loadingUsers, setLoadingUsers] = React.useState(false);
  const [selectedUserId, setSelectedUserId] = React.useState('');
  const [passwordResetUserId, setPasswordResetUserId] = React.useState('');
  const [passwordResetDepartmentFilter, setPasswordResetDepartmentFilter] = React.useState('');
  const [resettingPassword, setResettingPassword] = React.useState(false);
  const [loadingAccess, setLoadingAccess] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const [success, setSuccess] = React.useState('');
  const [moduleSearch, setModuleSearch] = React.useState('');
  const [schemaReady, setSchemaReady] = React.useState(true);
  const [landingOverview, setLandingOverview] = React.useState({
    loading: true,
    login: null,
    policy: null,
    activity: [],
    updatedAt: null,
    error: '',
  });

  const [targetInfo, setTargetInfo] = React.useState(null);
  const [roleDefaultModules, setRoleDefaultModules] = React.useState([]);
  const [manageableModules, setManageableModules] = React.useState([]);
  const [checkedModules, setCheckedModules] = React.useState([]);
  const loadedModulesRef = React.useRef([]);
  const [copyAccessUserId, setCopyAccessUserId] = React.useState('');
  const [homeSettingsLoading, setHomeSettingsLoading] = React.useState(true);
  const [homeSettingsSaving, setHomeSettingsSaving] = React.useState(false);
  const [homeTitleDraft, setHomeTitleDraft] = React.useState(DEFAULT_HOME_TITLE);
  const [homeTitleColorDraft, setHomeTitleColorDraft] = React.useState(DEFAULT_HOME_TITLE_COLOR);
  const [homeScope, setHomeScope] = React.useState('global');
  const [homeDepartments, setHomeDepartments] = React.useState([]);
  const [loadedHomeScopeQuery, setLoadedHomeScopeQuery] = React.useState('');
  const homeSettingsRequestRef = React.useRef(0);
  const savedHomeSettingsRef = React.useRef({ title: DEFAULT_HOME_TITLE, color: DEFAULT_HOME_TITLE_COLOR });
  const homePreviewTitleStyle = React.useMemo(() => getHomeHeadlineStyle(
    homeTitleDraft || DEFAULT_HOME_TITLE,
    /^#[0-9a-fA-F]{6}$/.test(homeTitleColorDraft) ? homeTitleColorDraft : DEFAULT_HOME_TITLE_COLOR
  ), [homeTitleDraft, homeTitleColorDraft]);

  React.useEffect(() => {
    const onHashChange = () => setRoutePath(window.location.hash.slice(1) || '/settings/system');
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const normalizedRoute = React.useMemo(() => {
    const raw = String(routePath || '').trim().split('?')[0].split('#')[0].toLowerCase();
    if (!raw) return '/settings/system';
    return raw.startsWith('/') ? raw : `/${raw}`;
  }, [routePath]);

  const isHomeContentView = normalizedRoute.startsWith('/settings/home-content') && (isAdmin || isDepartmentAdmin);
  const isModuleAccessView = normalizedRoute.startsWith('/settings/module-access') && canManageModuleAccess;
  const isPasswordResetView = normalizedRoute.startsWith('/settings/change-password') && (isAdmin || isDepartmentAdmin);
  const isLoginMonitorView = normalizedRoute.startsWith('/settings/login-monitor') && isAdmin;
  const isLockedAccountView = normalizedRoute.startsWith('/settings/locked-account') && isAdmin;
  const isSecurityPolicyView = normalizedRoute.startsWith('/settings/security-policy') && isAdmin;
  const isSettingsActivityView = normalizedRoute.startsWith('/settings/activity') && isAdmin;
  const isSettingsLandingView = !isModuleAccessView && !isHomeContentView && !isPasswordResetView
    && !isLoginMonitorView && !isLockedAccountView && !isSecurityPolicyView
    && !isSettingsActivityView;
  const homeScopeQuery = isAdmin
    ? (homeScope === 'global' ? '?scope=global' : `?dept_id=${encodeURIComponent(homeScope)}`)
    : (user?.dept_id ? `?dept_id=${user.dept_id}` : '');
  const homeSettingsPending = homeSettingsLoading || loadedHomeScopeQuery !== homeScopeQuery;

  React.useEffect(() => {
    if (!isAdmin || !isHomeContentView) return;
    apiGet('departments').then((data) => setHomeDepartments(Array.isArray(data) ? data : [])).catch(() => setHomeDepartments([]));
  }, [isAdmin, isHomeContentView]);

  const openModuleAccessView = React.useCallback(() => {
    window.location.hash = '#/settings/module-access';
  }, []);

  const openHomeContentView = React.useCallback(() => {
    window.location.hash = '#/settings/home-content';
  }, []);

  const openPasswordResetView = React.useCallback(() => {
    window.location.hash = '#/settings/change-password';
  }, []);

  // Department Admin has exactly three scoped settings tools. Dean no longer
  // manages Home Content and is returned to the application Home page.
  React.useEffect(() => {
    if (isDean && !isAdmin) {
      window.location.hash = '#/home';
      return;
    }
    const isDepartmentAdminRoute = isHomeContentView || isModuleAccessView || isPasswordResetView || normalizedRoute.startsWith('/settings/system');
    if (isDepartmentAdmin && !isAdmin && !isDepartmentAdminRoute) {
      window.location.hash = '#/settings/system';
    }
  }, [isDean, isDepartmentAdmin, isAdmin, isHomeContentView, isModuleAccessView, isPasswordResetView, normalizedRoute]);

  const openSettingsHome = React.useCallback(() => {
    window.location.hash = '#/settings/system';
  }, []);

  const handleSettingsCardClick = React.useCallback(async (card) => {
    if (!card) return;
    if (card.id === 'module_access') {
      openModuleAccessView();
      return;
    }
    if (card.id === 'home_content') {
      openHomeContentView();
      return;
    }
    if (card.id === 'login_monitor') {
      window.location.hash = '#/settings/login-monitor';
      return;
    }
    if (card.id === 'locked_account') { window.location.hash = '#/settings/locked-account'; return; }
    if (card.id === 'security_policy') { window.location.hash = '#/settings/security-policy'; return; }
    if (card.id === 'settings_activity') { window.location.hash = '#/settings/activity'; return; }
    if (card.id === 'change_password') {
      if (!isAdmin && !isDepartmentAdmin) {
        const message = 'Only Admin and Department Admin can reset account passwords.';
        try {
          if (window?.Swal) {
            await window.Swal.fire({ icon: 'warning', title: 'Admin Only', text: message });
            return;
          }
        } catch (swErr) {
          console.warn('Settings admin-only popup failed', swErr);
        }
        if (typeof window !== 'undefined') window.alert(message);
        return;
      }
      openPasswordResetView();
      return;
    }

    const message = `${card.title} is not connected yet. I already added the card layout and ready-state placeholder.`;
    try {
      if (window?.Swal) {
        await window.Swal.fire({
          icon: 'info',
          title: 'Coming Soon',
          text: message,
        });
        return;
      }
    } catch (swErr) {
      console.warn('Settings card info popup failed', swErr);
    }

    if (typeof window !== 'undefined') {
      window.alert(message);
    }
  }, [openModuleAccessView, openHomeContentView, openPasswordResetView, isAdmin, isDepartmentAdmin]);

  const loadLandingOverview = React.useCallback(async ({ silent = false } = {}) => {
    if (!isAdmin || !isSettingsLandingView) return;
    if (!silent) setLandingOverview((prev) => ({ ...prev, loading: true, error: '' }));

    const [loginResult, policyResult, activityResult] = await Promise.allSettled([
      apiGet('login-monitor?summary_only=1'),
      apiGet('admin-settings/security-policy'),
      apiGet('admin-settings/activity?page=1&page_size=3'),
    ]);
    const results = [loginResult, policyResult, activityResult];
    const allFailed = results.every((result) => result.status === 'rejected');

    setLandingOverview((prev) => ({
      loading: false,
      login: loginResult.status === 'fulfilled' ? loginResult.value : prev.login,
      policy: policyResult.status === 'fulfilled' ? policyResult.value?.policy : prev.policy,
      activity: activityResult.status === 'fulfilled' ? (activityResult.value?.rows || []).slice(0, 3) : prev.activity,
      updatedAt: results.some((result) => result.status === 'fulfilled') ? new Date() : prev.updatedAt,
      error: allFailed && !silent ? 'Live settings status is temporarily unavailable. All settings tools are still accessible.' : '',
    }));
  }, [isAdmin, isSettingsLandingView]);

  React.useEffect(() => {
    if (!isSettingsLandingView || !isAdmin) return;
    loadLandingOverview().catch(() => {
      setLandingOverview((prev) => ({ ...prev, loading: false, error: 'Live settings status is temporarily unavailable. All settings tools are still accessible.' }));
    });
  }, [isSettingsLandingView, isAdmin, loadLandingOverview]);

  useAutoRefresh({
    refresh: () => loadLandingOverview({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.ADMIN,
    enabled: Boolean(user) && isAdmin && isSettingsLandingView,
  });

  const filteredManagedUsers = React.useMemo(() => {
    let list = Array.isArray(managedUsers) ? managedUsers.slice() : [];
    if (isAdmin || isDepartmentAdmin) {
      list = list.filter((u) => Number(u?.role_id || 0) !== 1);
    }
    if (isDepartmentAdmin) {
      list = list.filter((u) => String(u?.dept_id ?? '') === String(user?.dept_id ?? ''));
    }
    list.sort((a, b) => {
      const aName = `${a?.last_name || ''} ${a?.first_name || ''}`.trim().toLowerCase();
      const bName = `${b?.last_name || ''} ${b?.first_name || ''}`.trim().toLowerCase();
      if (aName < bName) return -1;
      if (aName > bName) return 1;
      return Number(a?.user_id || 0) - Number(b?.user_id || 0);
    });
    return list;
  }, [managedUsers, isAdmin, isDepartmentAdmin, user?.dept_id]);

  React.useEffect(() => {
    const canLoadModuleTargets = canManageModuleAccess && isModuleAccessView;
    const canLoadPasswordTargets = (isAdmin || isDepartmentAdmin) && isPasswordResetView;
    if (!canLoadModuleTargets && !canLoadPasswordTargets) return;
    let mounted = true;
    (async () => {
      setLoadingUsers(true);
      setError('');
      try {
        const data = await apiGet(canLoadModuleTargets ? 'users?module_access_targets=1' : 'users?password_reset_targets=1');
        if (!mounted) return;
        setManagedUsers(Array.isArray(data) ? data : []);
      } catch (err) {
        if (!mounted) return;
        const message = err?.body?.message || err?.message || 'Failed to load users.';
        setError(message);
      } finally {
        if (mounted) setLoadingUsers(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [canManageModuleAccess, isAdmin, isModuleAccessView, isPasswordResetView]);

  React.useEffect(() => {
    if (!isModuleAccessView || !selectedUserId) return;
    let mounted = true;
    (async () => {
      setLoadingAccess(true);
      setError('');
      setSuccess('');
      try {
        const data = await apiGet(`users/${selectedUserId}/module-access`);
        if (!mounted) return;
        const manageable = sortUnique(data?.manageable_modules);
        const effective = sortUnique(data?.effective_modules).filter((key) => manageable.includes(key));
        const defaults = sortUnique(data?.role_default_modules).filter((key) => manageable.includes(key));
        setTargetInfo({
          user_id: Number(data?.user_id || selectedUserId),
          first_name: String(data?.first_name || ''),
          last_name: String(data?.last_name || ''),
          role_name: String(data?.role_name || ''),
          role_id: Number(data?.role_id || 0),
        });
        setSchemaReady(Boolean(data?.schema_ready ?? true));
        setRoleDefaultModules(defaults);
        setManageableModules(manageable);
        setCheckedModules(effective);
        loadedModulesRef.current = effective;
      } catch (err) {
        if (!mounted) return;
        const message = err?.body?.message || err?.message || 'Failed to load module access.';
        setError(message);
      } finally {
        if (mounted) setLoadingAccess(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [selectedUserId, isModuleAccessView]);

  React.useEffect(() => {
    if (!canManage || !isHomeContentView) return;
    let mounted = true;
    const requestId = ++homeSettingsRequestRef.current;
    (async () => {
      setHomeSettingsLoading(true);
      setError('');
      setSuccess('');
      try {
        const data = await apiGet(`app-settings/home${homeScopeQuery}`);
        if (!mounted || requestId !== homeSettingsRequestRef.current) return;
        const title = String(data?.home_title || '').trim();
        const color = String(data?.home_title_color || '').trim();
        const nextTitle = title || DEFAULT_HOME_TITLE;
        const nextColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_HOME_TITLE_COLOR;
        savedHomeSettingsRef.current = { title: nextTitle, color: nextColor };
        setHomeTitleDraft(nextTitle);
        setHomeTitleColorDraft(nextColor);
        setLoadedHomeScopeQuery(homeScopeQuery);
      } catch (err) {
        if (!mounted || requestId !== homeSettingsRequestRef.current) return;
        const message = err?.body?.message || err?.body?.error || err?.message || 'Failed to load home page settings.';
        setError(message);
      } finally {
        if (mounted && requestId === homeSettingsRequestRef.current) setHomeSettingsLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [canManage, isHomeContentView, user?.dept_id, homeScope]);

  useAutoRefresh({
    refresh: async () => {
      if (((canManageModuleAccess && isModuleAccessView) || ((isAdmin || isDepartmentAdmin) && isPasswordResetView)) && !selectedUserId && !passwordResetUserId) {
        const data = await apiGet(isModuleAccessView ? 'users?module_access_targets=1' : 'users?password_reset_targets=1');
        setManagedUsers(Array.isArray(data) ? data : []);
        return;
      }
      if (canManage && isHomeContentView) {
        const saved = savedHomeSettingsRef.current;
        const isDirty = homeTitleDraft !== saved.title || homeTitleColorDraft !== saved.color;
        if (isDirty) return;
        const requestId = ++homeSettingsRequestRef.current;
        const data = await apiGet(`app-settings/home${homeScopeQuery}`);
        if (requestId !== homeSettingsRequestRef.current) return;
        const nextTitle = String(data?.home_title || '').trim() || DEFAULT_HOME_TITLE;
        const rawColor = String(data?.home_title_color || '').trim();
        const nextColor = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor : DEFAULT_HOME_TITLE_COLOR;
        savedHomeSettingsRef.current = { title: nextTitle, color: nextColor };
        setHomeTitleDraft(nextTitle);
        setHomeTitleColorDraft(nextColor);
        setLoadedHomeScopeQuery(homeScopeQuery);
      }
    },
    intervalMs: AUTO_REFRESH_INTERVALS.ADMIN,
    enabled: Boolean(user) && !saving && !homeSettingsSaving && !resettingPassword,
  });

  React.useEffect(() => {
    setModuleSearch('');
  }, [selectedUserId]);

  const roleDefaultSet = React.useMemo(() => new Set(roleDefaultModules), [roleDefaultModules]);
  const checkedSet = React.useMemo(() => new Set(checkedModules), [checkedModules]);
  const accessDirty = React.useMemo(() => JSON.stringify(sortUnique(checkedModules)) !== JSON.stringify(sortUnique(loadedModulesRef.current)), [checkedModules]);
  React.useEffect(() => {
    const warn=(event)=>{if(!accessDirty)return;event.preventDefault();event.returnValue='';};
    window.addEventListener('beforeunload',warn); return()=>window.removeEventListener('beforeunload',warn);
  },[accessDirty]);
  const draftMode = React.useMemo(() => {
    if (checkedModules.length !== roleDefaultModules.length) return 'custom';
    for (const key of checkedModules) {
      if (!roleDefaultSet.has(key)) return 'custom';
    }
    return 'default';
  }, [checkedModules, roleDefaultModules, roleDefaultSet]);

  const moduleStats = React.useMemo(() => {
    const totalManageable = manageableModules.length;
    const enabledModules = checkedModules.length;
    const inheritedEnabled = checkedModules.filter((key) => roleDefaultSet.has(key)).length;
    const customEnabled = Math.max(0, enabledModules - inheritedEnabled);
    return { totalManageable, enabledModules, inheritedEnabled, customEnabled };
  }, [manageableModules, checkedModules, roleDefaultSet]);

  const moduleCards = React.useMemo(() => {
    const search = String(moduleSearch || '').trim().toLowerCase();
    const list = manageableModules.map((moduleKey) => {
      const label = formatModuleLabel(moduleKey);
      const category = detectModuleCategory(moduleKey);
      return {
        key: moduleKey,
        label,
        category,
        isChecked: checkedSet.has(moduleKey),
        isInherited: roleDefaultSet.has(moduleKey),
      };
    });

    const filtered = search
      ? list.filter((item) =>
        item.label.toLowerCase().includes(search)
        || item.key.toLowerCase().includes(search)
        || item.category.toLowerCase().includes(search)
      )
      : list;

    const orderIndex = (category) => {
      const idx = MODULE_CATEGORY_ORDER.indexOf(category);
      return idx === -1 ? MODULE_CATEGORY_ORDER.length : idx;
    };

    return filtered.sort((a, b) => {
      const categoryOrder = orderIndex(a.category) - orderIndex(b.category);
      if (categoryOrder !== 0) return categoryOrder;
      return a.label.localeCompare(b.label);
    });
  }, [manageableModules, checkedSet, roleDefaultSet, moduleSearch]);

  const groupedModuleCards = React.useMemo(() => {
    const groups = {};
    moduleCards.forEach((item) => {
      if (!groups[item.category]) groups[item.category] = [];
      groups[item.category].push(item);
    });

    return Object.keys(groups)
      .sort((a, b) => {
        const aIdx = MODULE_CATEGORY_ORDER.indexOf(a);
        const bIdx = MODULE_CATEGORY_ORDER.indexOf(b);
        const aOrder = aIdx === -1 ? MODULE_CATEGORY_ORDER.length : aIdx;
        const bOrder = bIdx === -1 ? MODULE_CATEGORY_ORDER.length : bIdx;
        return aOrder - bOrder;
      })
      .map((category) => ({ category, items: groups[category] }));
  }, [moduleCards]);

  const selectedUserLabel = React.useMemo(() => {
    if (targetInfo) {
      return `${targetInfo.first_name || ''} ${targetInfo.last_name || ''}`.trim() || `User #${targetInfo.user_id || selectedUserId}`;
    }
    const matched = filteredManagedUsers.find((item) => String(item?.user_id) === String(selectedUserId));
    if (!matched) return 'Selected User';
    const fullName = `${matched?.first_name || ''} ${matched?.last_name || ''}`.trim();
    return fullName || matched?.email || `User #${matched?.user_id}`;
  }, [targetInfo, selectedUserId, filteredManagedUsers]);

  const passwordResetTarget = React.useMemo(() => {
    return filteredManagedUsers.find((item) => String(item?.user_id) === String(passwordResetUserId)) || null;
  }, [filteredManagedUsers, passwordResetUserId]);

  const passwordResetDepartmentOptions = React.useMemo(() => {
    const map = new Map();
    filteredManagedUsers.forEach((item) => {
      const label = getDepartmentLabel(item);
      const key = String(item?.dept_id ?? label).trim() || label;
      if (!map.has(key)) map.set(key, label);
    });
    return Array.from(map.entries())
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [filteredManagedUsers]);

  const filteredPasswordResetUsers = React.useMemo(() => {
    const deptKey = String(passwordResetDepartmentFilter || '').trim();
    if (!deptKey) return filteredManagedUsers;
    return filteredManagedUsers.filter((item) => {
      const key = String(item?.dept_id ?? getDepartmentLabel(item)).trim() || getDepartmentLabel(item);
      return key === deptKey;
    });
  }, [filteredManagedUsers, passwordResetDepartmentFilter]);

  React.useEffect(() => {
    if (!passwordResetUserId) return;
    const stillVisible = filteredPasswordResetUsers.some((item) => String(item?.user_id) === String(passwordResetUserId));
    if (!stillVisible) setPasswordResetUserId('');
  }, [filteredPasswordResetUsers, passwordResetUserId]);

  const passwordResetStats = React.useMemo(() => {
    return {
      totalUsers: filteredManagedUsers.length,
      visibleUsers: filteredPasswordResetUsers.length,
      departments: passwordResetDepartmentOptions.length,
    };
  }, [filteredManagedUsers.length, filteredPasswordResetUsers.length, passwordResetDepartmentOptions.length]);

  const passwordResetTargetLabel = React.useMemo(() => {
    if (!passwordResetTarget) return 'Selected User';
    const fullName = `${passwordResetTarget?.first_name || ''} ${passwordResetTarget?.last_name || ''}`.trim();
    return fullName || passwordResetTarget?.email || `User #${passwordResetTarget?.user_id}`;
  }, [passwordResetTarget]);

  const handleToggleModule = (moduleKey) => {
    setCheckedModules((prev) => {
      const next = new Set(prev);
      if (next.has(moduleKey)) next.delete(moduleKey);
      else next.add(moduleKey);
      return Array.from(next).sort();
    });
  };

  const resetToDefault = () => {
    setCheckedModules(sortUnique(roleDefaultModules));
    setSuccess('');
  };

  const selectAllManageable = () => {
    setCheckedModules(sortUnique(manageableModules));
    setSuccess('');
  };

  const saveAccess = async () => {
    if (!selectedUserId) return;
    const before=new Set(loadedModulesRef.current); const after=new Set(checkedModules);
    const added=checkedModules.filter(key=>!before.has(key)); const removed=loadedModulesRef.current.filter(key=>!after.has(key));
    if (window?.Swal) { const confirm=await window.Swal.fire({icon:'question',title:'Confirm Module Access',html:`<div class="text-start"><p><strong>${added.length}</strong> module(s) added</p><p><strong>${removed.length}</strong> module(s) removed</p><p class="mb-0">Server access changes immediately. The user menu refreshes on the next sign-in.</p></div>`,showCancelButton:true,confirmButtonText:'Save Changes'}); if(!confirm.isConfirmed)return; }
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const payload = { selected_modules: checkedModules };
      const data = await apiPut(`users/${selectedUserId}/module-access`, payload);
      const manageable = sortUnique(data?.manageable_modules);
      const effective = sortUnique(data?.effective_modules).filter((key) => manageable.includes(key));
      const defaults = sortUnique(data?.role_default_modules).filter((key) => manageable.includes(key));
      setRoleDefaultModules(defaults);
      setManageableModules(manageable);
      setCheckedModules(effective);
      loadedModulesRef.current = effective;
      setSuccess('Module access updated successfully.');
      try {
        if (window?.Swal) {
          await window.Swal.fire({ icon: 'success', title: 'Saved', text: 'User module access was updated.' });
        }
      } catch (swErr) {
        console.warn('Swal success notification failed', swErr);
      }
    } catch (err) {
      const message = err?.body?.message || err?.message || 'Failed to save module access.';
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const copyModuleAccess = async () => {
    if (!copyAccessUserId) return;
    try { const data=await apiGet(`users/${copyAccessUserId}/module-access`); const source=sortUnique(data?.effective_modules); setCheckedModules(source.filter(key=>manageableModules.includes(key))); setSuccess('Permissions copied into the draft. Review and save to apply.'); } catch(err){setError(err?.body?.message||err.message);}
  };

  const resetHomeDraft = () => {
    setHomeTitleDraft(DEFAULT_HOME_TITLE);
    setHomeTitleColorDraft(DEFAULT_HOME_TITLE_COLOR);
    setSuccess('');
    setError('');
  };

  const saveHomeContent = async () => {
    const title = String(homeTitleDraft || '').trim();
    const color = /^#[0-9a-fA-F]{6}$/.test(String(homeTitleColorDraft || '').trim())
      ? String(homeTitleColorDraft).trim()
      : DEFAULT_HOME_TITLE_COLOR;

    if (!title) {
      const message = 'Home title is required.';
      setError(message);
      try {
        if (window?.Swal) await window.Swal.fire({ icon: 'warning', title: 'Missing Title', text: message });
      } catch (swErr) {
        console.warn('Swal warning failed', swErr);
      }
      return;
    }

    try {
      if (window?.Swal) {
        const confirm = await window.Swal.fire({
          icon: 'question',
          title: 'Confirm Home Text',
          text: 'Publish this headline to the Home page?',
          showCancelButton: true,
          confirmButtonText: 'Confirm',
          cancelButtonText: 'Cancel',
          confirmButtonColor: '#198754',
        });
        if (!confirm.isConfirmed) return;
      }
    } catch (swErr) {
      console.warn('Swal confirmation failed', swErr);
    }

    setHomeSettingsSaving(true);
    setError('');
    setSuccess('');
    try {
      const payload = {
        home_title: title,
        home_title_color: color,
      };
      if (isAdmin && homeScope === 'global') payload.scope = 'global';
      else payload.dept_id = isAdmin ? Number(homeScope) : user?.dept_id;
      const data = await apiPut('app-settings/home', payload);
      const savedTitle = String(data?.home_title || title).trim() || DEFAULT_HOME_TITLE;
      const savedColor = /^#[0-9a-fA-F]{6}$/.test(String(data?.home_title_color || '').trim())
        ? String(data.home_title_color).trim()
        : color;
      savedHomeSettingsRef.current = { title: savedTitle, color: savedColor };
      setHomeTitleDraft(savedTitle);
      setHomeTitleColorDraft(savedColor);
      setLoadedHomeScopeQuery(homeScopeQuery);
      setSuccess('Home page text updated successfully.');
      try {
        window.dispatchEvent(new CustomEvent('app-settings-updated', { detail: { group: 'home' } }));
      } catch (eventErr) {
        console.warn('Settings update event failed', eventErr);
      }
      try {
        if (window?.Swal) {
          await window.Swal.fire({ icon: 'success', title: 'Saved', text: 'Home page text was updated.' });
        }
      } catch (swErr) {
        console.warn('Swal success notification failed', swErr);
      }
    } catch (err) {
      const message = err?.body?.message || err?.body?.error || err?.message || 'Failed to save home page text.';
      setError(message);
      try {
        if (window?.Swal) {
          await window.Swal.fire({ icon: 'error', title: 'Save Failed', text: message });
        }
      } catch (swErr) {
        console.warn('Swal error notification failed', swErr);
      }
    } finally {
      setHomeSettingsSaving(false);
    }
  };

  const resetPasswordToDefault = async () => {
    if (!passwordResetUserId || !passwordResetTarget) return;
    const confirmText = `Email ${passwordResetTargetLabel}, reset their temporary password to their School ID, revoke existing sessions, and require a password change?`;
    try {
      if (window?.Swal) {
        const confirm = await window.Swal.fire({
          icon: 'warning',
          title: 'Reset Password To School ID?',
          text: confirmText,
          showCancelButton: true,
          confirmButtonText: 'Reset Password',
          cancelButtonText: 'Cancel',
          confirmButtonColor: '#dc3545',
        });
        if (!confirm.isConfirmed) return;
      } else if (!window.confirm(confirmText)) {
        return;
      }
    } catch (swErr) {
      console.warn('Password reset confirmation failed', swErr);
      if (!window.confirm(confirmText)) return;
    }

    setResettingPassword(true);
    setError('');
    setSuccess('');
    try {
      const result = await apiPut(`users/${passwordResetUserId}/reset-default-password`, {});
      const message = result?.message || 'Reset instructions were emailed. The password is now the School ID, and the user must change it after signing in.';
      setSuccess(message);
      try {
        if (window?.Swal) {
          await window.Swal.fire({
            icon: 'success',
            title: 'Password Reset',
            text: message,
          });
        }
      } catch (swErr) {
        console.warn('Password reset success popup failed', swErr);
      }
    } catch (err) {
      const message = err?.body?.message || err?.message || 'Failed to reset password.';
      setError(message);
      try {
        if (window?.Swal) await window.Swal.fire({ icon: 'error', title: 'Reset Failed', text: message });
      } catch (swErr) {
        console.warn('Password reset error popup failed', swErr);
      }
    } finally {
      setResettingPassword(false);
    }
  };

  const lockedAccountCount = Number(landingOverview.login?.total_locked || 0);
  const failedAttemptCount = Number(landingOverview.login?.total_failed_attempts || 0);
  const maxLoginAttempts = Number(landingOverview.policy?.max_login_attempts || 10);
  const idleTimeoutMinutes = Number(landingOverview.policy?.idle_timeout_minutes || 15);
  const departmentAdminCardIds = new Set(['module_access', 'home_content', 'change_password']);
  const visibleSettingsCards = isDepartmentAdmin && !isAdmin
    ? SETTINGS_LANDING_CARDS.filter((card) => departmentAdminCardIds.has(card.id))
    : SETTINGS_LANDING_CARDS;
  const groupedSettingsCards = SETTINGS_GROUPS.map((group) => ({
    ...group,
    cards: visibleSettingsCards.filter((card) => card.group === group.name),
  })).filter((group) => group.cards.length > 0);

  const getLandingCardStatus = (card) => {
    if (card.state !== 'ready') return { label: 'Coming Soon', tone: 'soon' };
    if (card.id === 'locked_account') return { label: lockedAccountCount ? `${lockedAccountCount} Locked` : 'No Locks', tone: lockedAccountCount ? 'danger' : 'healthy' };
    if (card.id === 'login_monitor') return { label: failedAttemptCount ? `${failedAttemptCount} Failed` : 'Quiet', tone: failedAttemptCount ? 'warning' : 'healthy' };
    if (card.id === 'security_policy') return { label: `${maxLoginAttempts} Attempt Limit`, tone: 'info' };
    if (card.id === 'settings_activity') return { label: landingOverview.activity.length ? `${landingOverview.activity.length} Recent` : 'No Recent Activity', tone: 'info' };
    if (card.id === 'change_password') return { label: 'Admin Reset', tone: 'healthy' };
    if (card.id === 'home_content') return { label: 'Global + Department', tone: 'info' };
    return { label: 'Available', tone: 'healthy' };
  };

  const openLandingCard = (cardId) => {
    const card = SETTINGS_LANDING_CARDS.find((item) => item.id === cardId);
    if (card) handleSettingsCardClick(card);
  };

  if (!canManage) {
    return (
      <div className="container-fluid py-3 general-settings-page">
      <div className="alert alert-danger mb-0">You do not have permission to access General Settings.</div>
      </div>
    );
  }

  return (
    <div className="container-fluid py-3 general-settings-page">
      <div className={`card border-0 shadow-sm gs-hero-card mb-3 ${isSettingsLandingView ? 'is-control-center' : ''}`}>
        <div className="card-body d-flex flex-wrap justify-content-between align-items-center gap-3">
          <div className="d-flex align-items-center gap-3">
            {isSettingsLandingView && <span className="gs-hero-visual" aria-hidden="true"><i className="bi bi-sliders2"></i></span>}
            <div>
              {isSettingsLandingView && <div className="gs-hero-eyebrow">Administration Workspace</div>}
              <h4 className="mb-1 fw-bold">{isSettingsLandingView ? (isDepartmentAdmin && !isAdmin ? 'Department Settings' : 'Admin Control Center') : 'General Settings'}</h4>
              <p className="mb-0 text-muted">
                {isSettingsLandingView
                  ? (isDepartmentAdmin && !isAdmin
                    ? `Welcome back, ${user?.first_name || 'Department Administrator'}. Manage department access, password resets, and Home content.`
                    : `Welcome back, ${user?.first_name || 'Administrator'}. Manage access, security, monitoring, and appearance from one place.`)
                  : isHomeContentView
                    ? 'Customize the Home page headline and preview it before publishing.'
                    : isPasswordResetView
                      ? 'Email reset instructions, set the temporary password to the user’s School ID, revoke old sessions, and require a secure replacement.'
                      : isLoginMonitorView || isLockedAccountView
                        ? 'Review sign-in failures and safely manage locked accounts.'
                        : isSecurityPolicyView
                          ? 'Configure the security rules enforced by the PHP server.'
                          : isSettingsActivityView
                            ? 'Review security-sensitive administrator actions.'
                            : 'Configure module visibility per user while keeping role defaults intact.'}
              </p>
              {isSettingsLandingView && (
                <div className="gs-hero-meta">
                  <span><i className="bi bi-calendar3"></i>{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span>
                  <span><i className="bi bi-arrow-repeat"></i>{landingOverview.updatedAt ? `Updated ${landingOverview.updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Checking live status'}</span>
                </div>
              )}
            </div>
          </div>
          <div className="d-flex align-items-center gap-2">
            {isDepartmentAdmin && isModuleAccessView ? (
              <button type="button" className="btn btn-sm btn-outline-danger" onClick={openPasswordResetView}>
                Password Reset
              </button>
            ) : null}
            {isDepartmentAdmin && isPasswordResetView ? (
              <button type="button" className="btn btn-sm btn-outline-success" onClick={openModuleAccessView}>
                Module Access
              </button>
            ) : null}
            {!isSettingsLandingView && (
              <button type="button" className="btn btn-sm btn-outline-secondary" onClick={openSettingsHome}>
                Back To Settings
              </button>
            )}
            <span className={`gs-hero-badge ${isAdmin ? 'is-admin' : 'is-dean'}`}>
              {isAdmin ? 'Admin Control' : (isDepartmentAdmin ? 'Department Admin Control' : 'Dean Control')}
            </span>
          </div>
        </div>
      </div>

      {isLoginMonitorView ? (
        <LoginAttemptMonitor />
      ) : isLockedAccountView ? (
        <LoginAttemptMonitor lockedOnly />
      ) : isSecurityPolicyView ? (
        <SecurityPolicyPanel />
      ) : isSettingsActivityView ? (
        <SettingsActivityPanel />
      ) : isSettingsLandingView ? (
        <div className="gs-control-center">
          {isAdmin && landingOverview.error && <div className="alert alert-warning py-2">{landingOverview.error}</div>}

          {isAdmin && <div className="gs-overview-grid" role="region" aria-label="Settings overview">
            <button type="button" className={`gs-overview-card ${lockedAccountCount ? 'is-danger' : 'is-success'}`} onClick={() => openLandingCard('locked_account')}>
              <span className="gs-overview-icon"><i className={`bi ${lockedAccountCount ? 'bi-lock-fill' : 'bi-unlock'}`}></i></span>
              <span><small>Locked Accounts</small><strong>{landingOverview.loading ? '—' : lockedAccountCount}</strong><em>{lockedAccountCount ? 'Needs review' : 'All accounts accessible'}</em></span>
              <i className="bi bi-arrow-right gs-overview-arrow"></i>
            </button>
            <button type="button" className={`gs-overview-card ${failedAttemptCount ? 'is-warning' : 'is-success'}`} onClick={() => openLandingCard('login_monitor')}>
              <span className="gs-overview-icon"><i className="bi bi-shield-exclamation"></i></span>
              <span><small>Failed Logins · 24h</small><strong>{landingOverview.loading ? '—' : failedAttemptCount}</strong><em>{failedAttemptCount ? 'Open monitoring' : 'No failed attempts'}</em></span>
              <i className="bi bi-arrow-right gs-overview-arrow"></i>
            </button>
            <button type="button" className="gs-overview-card is-info" onClick={() => openLandingCard('security_policy')}>
              <span className="gs-overview-icon"><i className="bi bi-shield-check"></i></span>
              <span><small>Security Policy</small><strong>{landingOverview.loading ? '—' : 'Enforced'}</strong><em>{maxLoginAttempts} attempts · {idleTimeoutMinutes} min idle</em></span>
              <i className="bi bi-arrow-right gs-overview-arrow"></i>
            </button>
          </div>}

          <div className="gs-landing-layout" style={!isAdmin ? { gridTemplateColumns: 'minmax(0, 1fr)' } : undefined}>
            <main className="gs-settings-groups">
              {groupedSettingsCards.map((group) => (
                <div className="gs-settings-group" key={group.name}>
                  <div className="gs-group-heading">
                    <span className="gs-group-icon"><i className={`bi ${group.icon}`}></i></span>
                    <div><h5>{group.name}</h5><p>{group.description}</p></div>
                  </div>
                  <div className="gs-group-cards">
                    {group.cards.map((card) => {
                      const status = getLandingCardStatus(card);
                      return (
                        <button type="button" key={card.id} className={`gs-entry-card ${card.state === 'ready' ? 'is-live' : 'is-soon'}`} onClick={() => handleSettingsCardClick(card)}>
                          <span className="gs-entry-icon" aria-hidden="true"><i className={`bi ${card.icon}`}></i></span>
                          <span className="gs-entry-copy">
                            <span className="gs-entry-title">{card.title}</span>
                            <span className="gs-entry-desc">{card.description}</span>
                            <span className="gs-entry-footer">
                              <span className={`gs-entry-status is-${status.tone}`}>{status.label}</span>
                              <span className="gs-entry-cta">{card.cta}<i className="bi bi-arrow-right"></i></span>
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </main>

            {isAdmin && <aside className="gs-landing-sidebar">
              <div className="gs-side-panel">
                <div className="gs-side-panel-head"><div><small>Shortcuts</small><h5>Quick Actions</h5></div><i className="bi bi-lightning-charge-fill"></i></div>
                <div className="gs-quick-actions">
                  <button type="button" onClick={() => openLandingCard('locked_account')}><span><i className="bi bi-unlock"></i>Unlock an account</span><i className="bi bi-chevron-right"></i></button>
                  <button type="button" onClick={() => openLandingCard('change_password')}><span><i className="bi bi-key"></i>Reset account password</span><i className="bi bi-chevron-right"></i></button>
                  <button type="button" onClick={() => openLandingCard('security_policy')}><span><i className="bi bi-shield-lock"></i>Edit security policy</span><i className="bi bi-chevron-right"></i></button>
                  <button type="button" onClick={() => openLandingCard('home_content')}><span><i className="bi bi-house-gear"></i>Customize home page</span><i className="bi bi-chevron-right"></i></button>
                </div>
              </div>

              <div className="gs-side-panel">
                <div className="gs-side-panel-head"><div><small>Audit Trail</small><h5>Recent Activity</h5></div><button type="button" onClick={() => openLandingCard('settings_activity')}>View all</button></div>
                <div className="gs-activity-preview">
                  {landingOverview.loading ? <LoadingState label="Loading recent activity..." compact /> : landingOverview.activity.length ? landingOverview.activity.map((row) => (
                    <button type="button" key={row.log_id} onClick={() => openLandingCard('settings_activity')}>
                      <span className="gs-activity-dot"></span>
                      <span><strong>{String(row.action || 'Settings update').replace(/_/g, ' ')}</strong><small>{row.actor_name?.trim() || 'Administrator'} · {new Date(row.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></span>
                    </button>
                  )) : <div className="gs-side-empty"><i className="bi bi-check-circle"></i>No recent settings activity.</div>}
                </div>
              </div>
            </aside>}
          </div>
        </div>
      ) : isHomeContentView ? (
        <>
          {error ? <div className="alert alert-danger">{error}</div> : null}
          {success ? <div className="alert alert-success">{success}</div> : null}

          <div className="row g-3">
            <div className="col-12 col-xl-5">
              <div className="card border-0 shadow-sm gs-control-card h-100">
                <div className="card-body">
                  <div className="d-flex justify-content-between align-items-start gap-3 mb-3">
                    <div>
                      <h5 className="mb-1 fw-bold">Home Headline</h5>
                      <p className="mb-0 text-muted small">Update the main Home page title and title color.</p>
                    </div>
                    <span className="gs-mini-chip">Live Preview</span>
                  </div>

                  {homeSettingsPending ? (
                    <LoadingState label="Loading home page settings..." />
                  ) : (
                    <div className="d-grid gap-3">
                      {isAdmin ? <div><label className="form-label fw-semibold">Settings Scope</label><select className="form-select" value={homeScope} disabled={homeSettingsSaving} onChange={(e)=>setHomeScope(e.target.value)}><option value="global">Global default</option>{homeDepartments.map((dept)=><option key={dept.dept_id} value={dept.dept_id}>{dept.dept_name || `Department #${dept.dept_id}`}</option>)}</select><div className="form-text">Department values override the global default.</div></div> : null}
                      <div>
                        <label className="form-label fw-semibold">Title Text</label>
                        <input
                          type="text"
                          className="form-control"
                          value={homeTitleDraft}
                          maxLength={80}
                          disabled={homeSettingsSaving}
                          onChange={(e) => setHomeTitleDraft(e.target.value)}
                          placeholder={DEFAULT_HOME_TITLE}
                        />
                        <div className="form-text">{String(homeTitleDraft || '').length}/80 characters</div>
                      </div>

                      <div>
                        <label className="form-label fw-semibold">Title Color</label>
                        <div className="d-flex flex-wrap align-items-center gap-2">
                          <input
                            type="color"
                            className="form-control form-control-color gs-home-color-input"
                            value={/^#[0-9a-fA-F]{6}$/.test(homeTitleColorDraft) ? homeTitleColorDraft : DEFAULT_HOME_TITLE_COLOR}
                            disabled={homeSettingsSaving}
                            onChange={(e) => setHomeTitleColorDraft(e.target.value)}
                            title="Choose title color"
                          />
                          <input
                            type="text"
                            className="form-control gs-home-color-text"
                            value={homeTitleColorDraft}
                            disabled={homeSettingsSaving}
                            onChange={(e) => setHomeTitleColorDraft(e.target.value)}
                            placeholder={DEFAULT_HOME_TITLE_COLOR}
                          />
                        </div>
                        <div className="gs-home-swatches mt-2">
                          {HOME_TITLE_COLOR_PRESETS.map((color) => (
                            <button
                              key={color}
                              type="button"
                              className={`gs-home-swatch ${String(homeTitleColorDraft).toLowerCase() === color ? 'is-active' : ''}`}
                              style={{ backgroundColor: color }}
                              disabled={homeSettingsSaving}
                              onClick={() => setHomeTitleColorDraft(color)}
                              aria-label={`Use ${color}`}
                              title={color}
                            />
                          ))}
                        </div>
                      </div>

                      <div className="d-flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="btn btn-success"
                          disabled={homeSettingsSaving || homeSettingsPending}
                          onClick={saveHomeContent}
                        >
                          {homeSettingsSaving ? 'Saving...' : 'Confirm Changes'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-outline-secondary"
                          disabled={homeSettingsSaving || homeSettingsPending}
                          onClick={resetHomeDraft}
                        >
                          Reset Preview
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="col-12 col-xl-7">
              <div className="gs-home-preview-card">
                <div className="gs-home-preview-top">
                  <span className="gs-home-preview-pill">
                    <i className="bi bi-hourglass-split" aria-hidden="true"></i>
                    CDOC Attendance Home
                  </span>
                </div>
                {homeSettingsPending ? (
                  <div className="placeholder-glow mt-3" role="status" aria-label="Loading home title preview">
                    <span className="placeholder col-9 rounded" style={{ height: '3.5rem' }}></span>
                  </div>
                ) : (
                  <h1 className="gs-home-preview-title" style={homePreviewTitleStyle} title={String(homeTitleDraft || '').trim() || DEFAULT_HOME_TITLE}>
                    {String(homeTitleDraft || '').trim() || DEFAULT_HOME_TITLE}
                  </h1>
                )}
                <p className="gs-home-preview-copy">
                  Every minute in class matters. This preview updates as you type or choose a color.
                </p>
              </div>
            </div>
          </div>
        </>
      ) : isPasswordResetView ? (
        <>
          {error ? <div className="alert alert-danger">{error}</div> : null}
          {success ? <div className="alert alert-success">{success}</div> : null}

          {!isAdmin && !isDepartmentAdmin ? (
            <div className="alert alert-danger mb-0">Only Admin and Department Admin can reset account passwords.</div>
          ) : (
            <div className="gs-password-workspace">
              <div className="gs-password-summary-grid mb-3">
                <div className="gs-password-summary-card">
                  <span className="gs-password-summary-icon is-users"><i className="bi bi-people-fill" aria-hidden="true"></i></span>
                  <div>
                    <div className="gs-stat-label">Available Accounts</div>
                    <div className="gs-stat-value">{passwordResetStats.totalUsers}</div>
                  </div>
                </div>
                <div className="gs-password-summary-card">
                  <span className="gs-password-summary-icon is-dept"><i className="bi bi-building" aria-hidden="true"></i></span>
                  <div>
                    <div className="gs-stat-label">Departments</div>
                    <div className="gs-stat-value">{passwordResetStats.departments}</div>
                  </div>
                </div>
                <div className="gs-password-summary-card">
                  <span className="gs-password-summary-icon is-filter"><i className="bi bi-funnel-fill" aria-hidden="true"></i></span>
                  <div>
                    <div className="gs-stat-label">Filtered Users</div>
                    <div className="gs-stat-value">{passwordResetStats.visibleUsers}</div>
                  </div>
                </div>
              </div>

              <div className="row g-3 align-items-stretch">
                <div className="col-12 col-xl-5">
                  <div className="gs-reset-command-panel h-100">
                    <div className="gs-reset-command-head">
                      <div className="gs-reset-command-icon">
                        <i className="bi bi-shield-lock-fill" aria-hidden="true"></i>
                      </div>
                      <div>
                        <div className="gs-reset-eyebrow">Emergency Tool</div>
                        <h5 className="mb-1 fw-bold">Reset Account Password</h5>
                        <p className="mb-0 text-muted small">
                          Filter by department, choose a user, then force the first-login password change flow.
                        </p>
                      </div>
                    </div>

                    <div className="gs-reset-warning">
                      <i className="bi bi-exclamation-triangle-fill" aria-hidden="true"></i>
                      <span>Email instructions are sent first. The password changes to the user’s School ID only after the email is accepted.</span>
                    </div>

                    {isDepartmentAdmin ? (
                      <div className="alert alert-info py-2">
                        You may reset any non-Admin account in your own department. Admin accounts and users from other departments are blocked by the server.
                      </div>
                    ) : null}

                    <div className="gs-reset-form-grid">
                      <div>
                        <label className="form-label fw-semibold">Department</label>
                        <select
                          className="form-select gs-user-select"
                          value={passwordResetDepartmentFilter}
                          disabled={loadingUsers || resettingPassword}
                          onChange={(e) => {
                            setPasswordResetDepartmentFilter(String(e.target.value || ''));
                            setSuccess('');
                            setError('');
                          }}
                        >
                          <option value="">All departments</option>
                          {passwordResetDepartmentOptions.map((dept) => (
                            <option key={dept.key} value={dept.key}>{dept.label}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="form-label fw-semibold">User Account</label>
                        <select
                          className="form-select gs-user-select"
                          value={passwordResetUserId}
                          disabled={loadingUsers || resettingPassword}
                          onChange={(e) => {
                            setPasswordResetUserId(String(e.target.value || ''));
                            setSuccess('');
                            setError('');
                          }}
                        >
                          <option value="">Select user</option>
                          {filteredPasswordResetUsers.map((item) => {
                            const fullName = `${item?.last_name || ''}, ${item?.first_name || ''}`.replace(/^,\s*/, '').trim();
                            const labelName = fullName || item?.email || `User #${item?.user_id}`;
                            const roleName = formatRoleName(item?.role_name || '');
                            return (
                              <option key={item.user_id} value={item.user_id}>
                                {labelName} {roleName ? `(${roleName})` : ''}
                              </option>
                            );
                          })}
                        </select>
                        {loadingUsers ? (
                          <LoadingState label="Loading users..." inline />
                        ) : (
                          <div className="form-text">Admin accounts are excluded from this emergency tool.</div>
                        )}
                      </div>
                    </div>

                    {passwordResetTarget ? (
                      <div className="gs-reset-selected">
                        <div className="gs-user-avatar" aria-hidden="true">
                          {getInitials(passwordResetTarget?.first_name, passwordResetTarget?.last_name)}
                        </div>
                        <div className="gs-user-meta">
                          <div className="fw-semibold">{passwordResetTargetLabel}</div>
                          <div className="small text-muted">{passwordResetTarget?.email || 'No email'}</div>
                          <div className="gs-reset-selected-tags">
                            <span>{formatRoleName(passwordResetTarget?.role_name || '')}</span>
                            <span>{getDepartmentLabel(passwordResetTarget)}</span>
                          </div>
                        </div>
                      </div>
                    ) : null}

                    <button
                      type="button"
                      className="btn btn-danger w-100 gs-reset-danger-btn"
                      disabled={!passwordResetUserId || resettingPassword || loadingUsers}
                      onClick={resetPasswordToDefault}
                    >
                      {resettingPassword ? 'Resetting...' : 'Reset Password To School ID'}
                    </button>
                  </div>
                </div>

                <div className="col-12 col-xl-7">
                  <div className="gs-password-reset-info h-100">
                    <div className="gs-password-info-head">
                      <div>
                        <div className="gs-reset-eyebrow">Reset Flow</div>
                        <h5 className="mb-1 fw-bold">What Happens After Reset</h5>
                        <p className="mb-0 text-muted small">The account is restored without exposing the temporary password.</p>
                      </div>
                      <span className="gs-mini-chip">First-login required</span>
                    </div>

                    <div className="gs-reset-steps">
                      <div className="gs-reset-step">
                        <span className="gs-reset-step-num">1</span>
                        <div>
                          <div className="fw-semibold">Reset instructions are emailed</div>
                          <div className="text-muted small">The email tells the user to sign in with their registered School ID.</div>
                        </div>
                      </div>
                      <div className="gs-reset-step">
                        <span className="gs-reset-step-num">2</span>
                        <div>
                          <div className="fw-semibold">First-login reset is required again</div>
                          <div className="text-muted small">The system sets the account back to the forced password-change flow.</div>
                        </div>
                      </div>
                      <div className="gs-reset-step">
                        <span className="gs-reset-step-num">3</span>
                        <div>
                          <div className="fw-semibold">Password becomes the School ID</div>
                          <div className="text-muted small">This happens only after the reset email is accepted for delivery.</div>
                        </div>
                      </div>
                      <div className="gs-reset-step">
                        <span className="gs-reset-step-num">4</span>
                        <div>
                          <div className="fw-semibold">Audit log stays clean</div>
                          <div className="text-muted small">The log records who was reset, not the password value.</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {error ? <div className="alert alert-danger">{error}</div> : null}
          {success ? <div className="alert alert-success">{success}</div> : null}

          <div className="card border-0 shadow-sm mb-3 gs-control-card">
            <div className="card-body">
              <div className="row g-3 align-items-end">
                <div className="col-12 col-md-8">
                  <label className="form-label fw-semibold mb-1">Select User</label>
                  <select
                    className="form-select gs-user-select"
                    value={selectedUserId}
                    disabled={loadingUsers || loadingAccess || saving}
                    onChange={(e) => setSelectedUserId(String(e.target.value || ''))}
                  >
                    <option value="">Select user</option>
                    {filteredManagedUsers.map((item) => {
                      const fullName = `${item?.last_name || ''}, ${item?.first_name || ''}`.replace(/^,\s*/, '').trim();
                      const labelName = fullName || item?.email || `User #${item?.user_id}`;
                      const roleName = formatRoleName(item?.role_name || '');
                      const accountStatus = normalizeUserStatus(item?.status);
                      const statusLabel = accountStatus && accountStatus !== 'active'
                        ? ` — ${accountStatus === 'archive' ? 'Archived' : 'Inactive'}`
                        : '';
                      return (
                        <option key={item.user_id} value={item.user_id}>
                          {labelName} {roleName ? `(${roleName})` : ''}{statusLabel}
                        </option>
                      );
                    })}
                  </select>
                  {loadingUsers ? <LoadingState label="Loading users..." inline /> : <div className="form-text">Pick a user to manage module access.</div>}
                </div>
                <div className="col-12 col-md-4 text-md-end">
                  <button
                    type="button"
                    className="btn btn-outline-secondary"
                    disabled={!selectedUserId || loadingAccess || saving}
                    onClick={resetToDefault}
                  >
                    Reset To Role Default
                  </button>
                </div>
              </div>

              {selectedUserId ? (
                <><div className="gs-user-strip mt-3">
                  <div className="gs-user-avatar" aria-hidden="true">
                    {getInitials(targetInfo?.first_name, targetInfo?.last_name)}
                  </div>
                  <div className="gs-user-meta">
                    <div className="fw-semibold">{selectedUserLabel}</div>
                    <UserStatusBadge status={filteredManagedUsers.find((item) => String(item.user_id) === String(selectedUserId))?.status} />
                    <div className="small text-muted">
                      Role: {formatRoleName(targetInfo?.role_name || '')}
                      {' | '}
                      Mode: {draftMode === 'custom' ? 'Custom Override' : 'Role Default'}
                    </div>
                  </div>
                  <div className="gs-user-stats">
                    <span className="gs-mini-chip">Manageable: {moduleStats.totalManageable}</span>
                    <span className="gs-mini-chip">Enabled: {moduleStats.enabledModules}</span>
                  </div>
                </div><div className="row g-2 mt-2 align-items-end"><div className="col-12 col-md-8"><label className="form-label small fw-semibold">Copy permissions from another user</label><select className="form-select" value={copyAccessUserId} onChange={e=>setCopyAccessUserId(e.target.value)}><option value="">Select source user</option>{filteredManagedUsers.filter(item=>String(item.user_id)!==String(selectedUserId)).map(item=>{ const status=normalizeUserStatus(item.status); const suffix=status&&status!=='active'?` — ${status==='archive'?'Archived':'Inactive'}`:''; return <option key={item.user_id} value={item.user_id}>{`${item.last_name||''}, ${item.first_name||''}${suffix}`}</option>; })}</select></div><div className="col-12 col-md-4"><button className="btn btn-outline-success w-100" disabled={!copyAccessUserId||saving} onClick={copyModuleAccess}>Copy To Draft</button></div></div>{accessDirty?<div className="alert alert-warning mt-3 mb-0">You have unsaved module-access changes.</div>:null}</>
              ) : null}
            </div>
          </div>

          {selectedUserId ? (
            <div className="card border-0 shadow-sm gs-modules-card">
              <div className="card-body">
                {loadingAccess ? (
                  <LoadingState label="Loading module access..." />
                ) : (
                  <>
                    <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
                      <div>
                        <h6 className="mb-1 fw-bold">Module Access Matrix</h6>
                        <div className="text-muted small">Toggle modules that this user can open in the sidebar and routes.</div>
                      </div>
                      <div className="d-flex flex-wrap gap-2">
                        {isAdmin ? (
                          <button
                            type="button"
                            className="btn btn-sm btn-outline-success"
                            disabled={saving || manageableModules.length === 0}
                            onClick={selectAllManageable}
                          >
                            Select All
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-secondary"
                          disabled={saving || !selectedUserId}
                          onClick={resetToDefault}
                        >
                          Reset Defaults
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-success"
                          disabled={saving || !schemaReady || !selectedUserId}
                          onClick={saveAccess}
                        >
                          {saving ? 'Saving...' : 'Save Access'}
                        </button>
                      </div>
                    </div>

                    <div className="gs-stats-grid mb-3">
                      <div className="gs-stat-card">
                        <div className="gs-stat-label">Manageable Modules</div>
                        <div className="gs-stat-value">{moduleStats.totalManageable}</div>
                      </div>
                      <div className="gs-stat-card">
                        <div className="gs-stat-label">Enabled Modules</div>
                        <div className="gs-stat-value">{moduleStats.enabledModules}</div>
                      </div>
                      <div className="gs-stat-card">
                        <div className="gs-stat-label">Role Default Enabled</div>
                        <div className="gs-stat-value">{moduleStats.inheritedEnabled}</div>
                      </div>
                      <div className="gs-stat-card">
                        <div className="gs-stat-label">Custom Enabled</div>
                        <div className="gs-stat-value">{moduleStats.customEnabled}</div>
                      </div>
                    </div>
                    {isDepartmentAdmin ? (
                      <div className="alert alert-info py-2">
                        You can change only safe operational modules for non-Admin users in your own department. Protected Admin, security, facility, academic-control, user-management, and approval modules cannot be granted here.
                      </div>
                    ) : null}

                    <div className="gs-search-row mb-3">
                      <div className="input-group">
                        <span className="input-group-text">Search</span>
                        <input
                          type="search"
                          className="form-control"
                          placeholder="Filter by module name or key..."
                          value={moduleSearch}
                          onChange={(e) => setModuleSearch(String(e.target.value || ''))}
                          disabled={saving || manageableModules.length === 0}
                        />
                        <button
                          type="button"
                          className="btn btn-outline-secondary"
                          disabled={!moduleSearch}
                          onClick={() => setModuleSearch('')}
                        >
                          Clear
                        </button>
                      </div>
                    </div>

                    {!schemaReady ? (
                      <div className="alert alert-warning mb-0">
                        Missing database columns for module access. Please run migration:
                        <code className="ms-1">api/migrations/2026-04-16-add-user-module-permissions.sql</code>
                      </div>
                    ) : manageableModules.length === 0 ? (
                      <div className="text-muted">No manageable modules available for this user.</div>
                    ) : moduleCards.length === 0 ? (
                      <div className="text-muted">No modules match your search filter.</div>
                    ) : (
                      groupedModuleCards.map((group) => (
                        <div key={group.category} className="gs-module-group">
                          <div className="gs-module-group-head">
                            <h6 className="mb-0">{group.category}</h6>
                            <span className="badge text-bg-light">{group.items.length}</span>
                          </div>

                          <div className="row g-2">
                            {group.items.map((item) => (
                              <div key={item.key} className="col-12 col-md-6 col-xl-4">
                                <label className={`gs-module-tile ${item.isChecked ? 'is-checked' : ''}`}>
                                  <span className="gs-module-main">
                                    <input
                                      type="checkbox"
                                      className="form-check-input mt-1"
                                      checked={item.isChecked}
                                      onChange={() => handleToggleModule(item.key)}
                                      disabled={saving}
                                    />
                                    <span className="gs-module-copy">
                                      <span className="gs-module-label">{item.label}</span>
                                      <span className="gs-module-key">{item.key}</span>
                                    </span>
                                  </span>
                                  <span className={`gs-module-badge ${item.isInherited ? 'is-role-default' : 'is-override'}`}>
                                    {item.isInherited ? 'Role Default' : 'Override'}
                                  </span>
                                </label>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))
                    )}
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="card border-0 shadow-sm">
              <div className="card-body text-center py-4 text-muted">
                Select a user first to view and update module permissions.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

