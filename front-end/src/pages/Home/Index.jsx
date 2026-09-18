import React from 'react';
import { AuthContext } from '../../context/AuthContext.jsx';
import { apiGet } from '../../services/api.js';
import { canAccessModule, resolveRoleName } from '../../utils/moduleAccess.js';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';

const DEFAULT_HOME_TITLE = 'Welcome to COC Attendance WEB';
const DEFAULT_HOME_TITLE_COLOR = '#c69500';

const moduleShortcuts = [
  {
    label: 'Dashboard',
    path: '/dashboard',
    permission: 'dashboard',
    icon: 'bi bi-speedometer2',
    accent: 'emerald',
    eyebrow: 'Operations',
    description: 'See campus-wide attendance movement, room activity, and the daily operational pulse in one executive view.'
  },
  {
    label: 'My Dashboard',
    path: '/faculty-dashboard',
    permission: 'faculty_dashboard',
    icon: 'bi bi-person-badge',
    accent: 'sky',
    eyebrow: 'Faculty',
    description: 'A personal command center for teaching load, attendance status, substitutions, and recent account activity.'
  },
  {
    label: 'Attendance',
    path: '/attendance',
    permission: 'attendance',
    icon: 'bi bi-geo-alt',
    accent: 'emerald',
    eyebrow: 'Live Check',
    description: 'Record class attendance with GPS, room radius checks, altitude signals, and floor QR confirmation.'
  },
  {
    label: 'Attendance History',
    path: '/attendance-history',
    permission: 'attendance',
    icon: 'bi bi-calendar-week',
    accent: 'amber',
    eyebrow: 'Calendar',
    description: 'Review past class sessions by date, scan status patterns, and request corrections when records need attention.'
  },
  {
    label: 'Teaching Schedule',
    path: '/my-attendance',
    permission: 'attendance',
    icon: 'bi bi-journal-bookmark',
    accent: 'indigo',
    eyebrow: 'Load',
    description: 'Check assigned rooms, subjects, sections, and schedule details before the next class starts.'
  },
  {
    label: 'Attendance Records',
    path: '/attendancemgmt',
    permission: 'attendancemgmt',
    icon: 'bi bi-clipboard-data',
    accent: 'rose',
    eyebrow: 'Review',
    description: 'Manage generated attendance rows, verify exceptions, and keep official records clean for reporting.'
  },
  {
    label: 'Class Schedules',
    path: '/class-schedules',
    permission: 'class_schedules',
    icon: 'bi bi-calendar3',
    accent: 'cyan',
    eyebrow: 'Planning',
    description: 'Maintain room assignments, class timing, teacher loads, and conflict-aware schedule details.'
  },
  {
    label: '3D Campus Map',
    path: '/3d-building',
    permission: '3d_building',
    icon: 'bi bi-box',
    accent: 'violet',
    eyebrow: 'Campus',
    description: 'Inspect building models and locate rooms, classes, and facility context with a visual campus view.'
  },
  {
    label: 'Facility',
    path: '/building',
    permission: 'locations',
    icon: 'bi bi-building',
    accent: 'slate',
    eyebrow: 'Location',
    description: 'Maintain buildings, floors, rooms, GPS points, altitude baselines, and room radius settings.'
  },
  {
    label: 'Reports',
    path: '/reports',
    permission: 'reports',
    icon: 'bi bi-file-earmark-bar-graph',
    accent: 'teal',
    eyebrow: 'Insights',
    description: 'Turn attendance activity into summaries for faculty, rooms, schedules, and administrative review.'
  },
  {
    label: 'Settings',
    path: '/settings/system',
    permission: 'settings',
    icon: 'bi bi-gear',
    accent: 'gray',
    eyebrow: 'Control',
    description: 'Tune module access, system behavior, and account-level permissions with admin oversight.'
  }
];

const roleProfiles = {
  admin: {
    title: 'System command center',
    intro: 'Keep the entire attendance ecosystem coordinated: users, facilities, schedules, module access, records, and reports all start from here.',
    primaryLabel: 'Open Dashboard',
    primaryPath: '/dashboard',
    secondaryLabel: 'Manage Facilities',
    secondaryPath: '/building',
    focus: [
      ['Access governance', 'Review who can enter each module and keep sensitive workflows limited to the right roles.'],
      ['Location accuracy', 'Maintain campus buildings, room coordinates, floor altitude, and QR-ready spaces.'],
      ['Operational confidence', 'Use reports and logs to keep attendance records auditable and ready for review.']
    ]
  },
  dean: {
    title: 'Department oversight hub',
    intro: 'Track department attendance, review faculty activity, monitor schedule changes, and keep academic operations moving without losing the details.',
    primaryLabel: 'Review Records',
    primaryPath: '/attendancemgmt',
    secondaryLabel: 'Open Reports',
    secondaryPath: '/reports',
    focus: [
      ['Department visibility', 'Watch attendance activity across faculty under your scope.'],
      ['Request decisions', 'Review attendance edit requests and leave-related activity with context.'],
      ['Quality control', 'Spot late, absent, substituted, and leave records before they become reporting problems.']
    ]
  },
  department_admin: {
    title: 'Department admin hub',
    intro: 'Manage department users, track attendance, review faculty activity, monitor schedule changes, and keep department operations moving clearly.',
    primaryLabel: 'Manage Users',
    primaryPath: '/users',
    secondaryLabel: 'Review Records',
    secondaryPath: '/attendancemgmt',
    focus: [
      ['Department users', 'Add and maintain users only inside your assigned department.'],
      ['Department visibility', 'Watch attendance activity across faculty under your scope.'],
      ['Quality control', 'Review requests, schedules, substitutions, reports, and logs with department context.']
    ]
  },
  program_head: {
    title: 'Program coordination desk',
    intro: 'Stay close to faculty schedules, class assignments, attendance patterns, and the program-level records that need quick decisions.',
    primaryLabel: 'View Schedules',
    primaryPath: '/class-schedules',
    secondaryLabel: 'Open Reports',
    secondaryPath: '/reports',
    focus: [
      ['Schedule awareness', 'Check assigned subjects, sections, and rooms connected to your program.'],
      ['Faculty support', 'Find records that need attention before they affect program reporting.'],
      ['Daily rhythm', 'Move between dashboards, attendance, and requests without digging through the sidebar.']
    ]
  },
  secretary: {
    title: 'Frontline operations board',
    intro: 'Handle schedules, records, leaves, substitutions, and day-to-day attendance cleanups from a single practical starting point.',
    primaryLabel: 'Attendance Records',
    primaryPath: '/attendancemgmt',
    secondaryLabel: 'Class Schedules',
    secondaryPath: '/class-schedules',
    focus: [
      ['Record upkeep', 'Keep attendance entries aligned with real class activity and approved changes.'],
      ['Schedule support', 'Move quickly between class schedules, substitutions, and request queues.'],
      ['Faculty service', 'Help teachers resolve attendance gaps with clear supporting context.']
    ]
  },
  teacher: {
    title: 'Faculty home base',
    intro: 'Your teaching day begins here: see the attendance tools, schedule views, and history you need before, during, and after class.',
    primaryLabel: 'Start Attendance',
    primaryPath: '/attendance',
    secondaryLabel: 'View History',
    secondaryPath: '/attendance-history',
    focus: [
      ['Before class', 'Check your assigned room, subject, section, and schedule timing before the session starts.'],
      ['During class', 'Use GPS, QR, and floor signals to confirm attendance from the right location.'],
      ['After class', 'Review your calendar history and request edits for records that need correction.']
    ]
  },
  default: {
    title: 'Attendance workspace',
    intro: 'A focused starting point for attendance, schedules, campus locations, reports, and the work connected to your account.',
    primaryLabel: 'Open First Module',
    primaryPath: '',
    secondaryLabel: 'View Reports',
    secondaryPath: '/reports',
    focus: [
      ['Daily context', 'Start with the tools available to your role.'],
      ['Accurate records', 'Keep attendance and schedule information connected.'],
      ['Campus awareness', 'Use location-aware tools when your role includes them.']
    ]
  }
};

const accentClasses = {
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  sky: 'bg-sky-50 text-sky-700 border-sky-100',
  amber: 'bg-amber-50 text-amber-700 border-amber-100',
  indigo: 'bg-indigo-50 text-indigo-700 border-indigo-100',
  rose: 'bg-rose-50 text-rose-700 border-rose-100',
  cyan: 'bg-cyan-50 text-cyan-700 border-cyan-100',
  violet: 'bg-violet-50 text-violet-700 border-violet-100',
  slate: 'bg-slate-50 text-slate-700 border-slate-100',
  teal: 'bg-teal-50 text-teal-700 border-teal-100',
  gray: 'bg-gray-50 text-gray-700 border-gray-100'
};

function displayName(user) {
  const parts = [user?.first_name, user?.last_name].map((p) => String(p || '').trim()).filter(Boolean);
  if (parts.length) return parts.join(' ');
  return user?.email || 'User';
}

function titleCase(value) {
  return String(value || 'signed in')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function canOpen(user, item) {
  return !item.permission || canAccessModule(user, item.permission);
}

function firstAccessiblePath(user, preferredPath, visibleShortcuts) {
  if (preferredPath) {
    const preferred = moduleShortcuts.find((item) => item.path === preferredPath);
    if (!preferred || canOpen(user, preferred)) return preferredPath;
  }
  return visibleShortcuts[0]?.path || '';
}

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

function formatTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return String(value || '');
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function semesterLabel(semester) {
  if (!semester) return 'No active semester';
  return [semester.school_year, semester.term].filter(Boolean).join(' · ');
}

function HomeIndex() {
  const { user } = React.useContext(AuthContext) || {};
  const [homeTitle, setHomeTitle] = React.useState('');
  const [homeTitleColor, setHomeTitleColor] = React.useState(DEFAULT_HOME_TITLE_COLOR);
  const [homeSettingsReady, setHomeSettingsReady] = React.useState(false);
  const [homeSnapshot, setHomeSnapshot] = React.useState(null);
  const [snapshotLoading, setSnapshotLoading] = React.useState(true);
  const [snapshotError, setSnapshotError] = React.useState('');
  const [showAllModules, setShowAllModules] = React.useState(false);
  const homeSettingsRequestRef = React.useRef(0);
  const roleName = resolveRoleName(user) || 'default';
  const profile = roleProfiles[roleName] || roleProfiles.default;
  const visibleShortcuts = moduleShortcuts.filter((item) => canOpen(user, item));
  const primaryPath = firstAccessiblePath(user, profile.primaryPath, visibleShortcuts);
  const snapshotEndpoint = canAccessModule(user, 'faculty_dashboard')
    ? 'dashboard/personal'
    : (canAccessModule(user, 'dashboard') ? 'dashboard/operations' : '');
  const homeTitleStyle = React.useMemo(() => getHomeHeadlineStyle(homeTitle, homeTitleColor), [homeTitle, homeTitleColor]);
  const todayLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  });

  const goTo = (path) => {
    if (!path) return;
    window.location.hash = `#${path}`;
  };

  const loadHomeSettings = React.useCallback(async () => {
    const requestId = ++homeSettingsRequestRef.current;
    try {
      const deptId = user?.dept_id;
      const query = deptId ? `?dept_id=${deptId}` : '';
      const data = await apiGet(`app-settings/home${query}`);
      if (requestId !== homeSettingsRequestRef.current) return;
      const title = String(data?.home_title || '').trim();
      const color = String(data?.home_title_color || '').trim();
      setHomeTitle(title || DEFAULT_HOME_TITLE);
      setHomeTitleColor(/^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_HOME_TITLE_COLOR);
      setHomeSettingsReady(true);
    } catch (err) {
      if (requestId !== homeSettingsRequestRef.current) return;
      console.warn('Failed to load home settings', err);
      setHomeTitle(DEFAULT_HOME_TITLE);
      setHomeTitleColor(DEFAULT_HOME_TITLE_COLOR);
      setHomeSettingsReady(true);
    }
  }, [user?.dept_id]);

  const loadHomeSnapshot = React.useCallback(async ({ silent = false } = {}) => {
    if (!snapshotEndpoint) {
      setHomeSnapshot(null);
      setSnapshotLoading(false);
      setSnapshotError('');
      return;
    }
    if (!silent) setSnapshotLoading(true);
    try {
      const data = await apiGet(snapshotEndpoint);
      setHomeSnapshot(data || null);
      setSnapshotError('');
    } catch (err) {
      console.warn('Failed to load the home live summary', err);
      setSnapshotError('Live summary is temporarily unavailable.');
    } finally {
      setSnapshotLoading(false);
    }
  }, [snapshotEndpoint]);

  React.useEffect(() => {
    setHomeSettingsReady(false);
    loadHomeSettings();
    const onSettingsUpdated = (event) => {
      if (event?.detail?.group === 'home') loadHomeSettings();
    };
    window.addEventListener('app-settings-updated', onSettingsUpdated);
    return () => window.removeEventListener('app-settings-updated', onSettingsUpdated);
  }, [loadHomeSettings]);

  React.useEffect(() => {
    loadHomeSnapshot();
  }, [loadHomeSnapshot]);

  useAutoRefresh({
    refresh: loadHomeSettings,
    intervalMs: AUTO_REFRESH_INTERVALS.REPORT,
    enabled: Boolean(user),
  });

  useAutoRefresh({
    refresh: () => loadHomeSnapshot({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.HEAVY,
    enabled: Boolean(user && snapshotEndpoint),
  });

  const semester = homeSnapshot?.context?.semester || null;
  const scheduleToday = Array.isArray(homeSnapshot?.schedule_today) ? homeSnapshot.schedule_today : [];
  const personalSnapshot = homeSnapshot?.mode === 'personal';
  const personal = homeSnapshot?.personal || {};
  const requests = personal.pending_requests || {};
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
  const currentOrNextClass = personalSnapshot
    ? (scheduleToday.find((item) => item.is_active) || scheduleToday.find((item) => {
        const match = String(item.start_time || '').match(/^(\d{1,2}):(\d{2})/);
        return match ? Number(match[1]) * 60 + Number(match[2]) >= nowMinutes : false;
      }) || null)
    : null;
  const operationsActions = (Array.isArray(homeSnapshot?.actions) ? homeSnapshot.actions : [])
    .slice()
    .sort((left, right) => Number(right.count || 0) - Number(left.count || 0));
  const firstOperationsAction = operationsActions.find((item) => Number(item.count || 0) > 0) || null;
  const overview = homeSnapshot?.overview || {};
  const affectedClassCount = Number(overview.affected_classes_today || 0);
  const nextAction = !homeSnapshot
    ? {
        eyebrow: 'Role workspace',
        title: profile.title,
        detail: profile.intro,
        label: profile.primaryLabel,
        path: primaryPath,
        urgent: false
      }
    : personalSnapshot
      ? (currentOrNextClass
        ? {
            eyebrow: currentOrNextClass.is_active ? 'Class in progress' : 'Next class today',
            title: [currentOrNextClass.subject_code || currentOrNextClass.subject_name || 'Class', currentOrNextClass.section_name].filter(Boolean).join(' · '),
            detail: `${formatTime(currentOrNextClass.start_time)}–${formatTime(currentOrNextClass.end_time)} · ${currentOrNextClass.room_name || 'Room not assigned'}`,
            label: currentOrNextClass.next_checkpoint ? 'Open Attendance' : 'View Teaching Schedule',
            path: currentOrNextClass.next_checkpoint ? '/attendance' : '/my-attendance',
            urgent: Boolean(currentOrNextClass.next_checkpoint?.is_due)
          }
        : {
            eyebrow: 'Today’s schedule',
            title: 'No more classes scheduled today',
            detail: 'You can review your teaching schedule or attendance history.',
            label: 'View Teaching Schedule',
            path: '/my-attendance',
            urgent: false
          })
      : (firstOperationsAction
        ? {
            eyebrow: 'Needs attention',
            title: firstOperationsAction.key === 'missing_checkpoints'
              ? `${firstOperationsAction.count} overdue checkpoint${Number(firstOperationsAction.count) === 1 ? '' : 's'}`
              : `${firstOperationsAction.count} ${firstOperationsAction.label}`,
            detail: firstOperationsAction.key === 'missing_checkpoints'
              ? `These checkpoint events affect ${Number(firstOperationsAction.affected_classes || 0)} class${Number(firstOperationsAction.affected_classes || 0) === 1 ? '' : 'es'}. Open the exact issue list on the Dashboard.`
              : firstOperationsAction.key === 'suspended_schedules'
                ? 'Open the exact schedules and see the reason blocking each one.'
                : 'Open the related review queue for the affected records.',
            label: 'Review Now',
            path: firstOperationsAction.path || '/dashboard',
            urgent: true
          }
        : {
            eyebrow: 'Operations status',
            title: affectedClassCount > 0 ? `${affectedClassCount} affected class${affectedClassCount === 1 ? '' : 'es'} to review` : 'No urgent operational items',
            detail: affectedClassCount > 0 ? 'Open the dashboard for the exact schedule and attendance details.' : 'Your authorized scope has no urgent queue items right now.',
            label: 'Open Dashboard',
            path: primaryPath || '/dashboard',
            urgent: affectedClassCount > 0
          });
  const summaryCards = personalSnapshot
    ? [
        { label: 'Classes today', value: scheduleToday.length, icon: 'bi-calendar2-week', tone: 'emerald' },
        { label: 'Pending requests', value: Number(requests.pending ?? requests.attendance ?? 0), icon: 'bi-hourglass-split', tone: 'amber' },
        { label: 'Late warnings', value: Number(personal.late_warnings || 0), icon: 'bi-clock-history', tone: 'rose' }
      ]
    : [
        { label: 'Scheduled today', value: Number(overview.scheduled_today || 0), icon: 'bi-calendar2-week', tone: 'emerald' },
        { label: 'Active classes now', value: Number(overview.active_classes || 0), icon: 'bi-broadcast', tone: 'sky' },
        { label: 'Affected classes', value: affectedClassCount, icon: 'bi-exclamation-triangle', tone: 'amber' }
      ];
  const visibleModuleCards = showAllModules ? visibleShortcuts : visibleShortcuts.slice(0, 8);
  const currentHour = new Date().getHours();
  const greeting = currentHour < 12 ? 'Good morning' : (currentHour < 18 ? 'Good afternoon' : 'Good evening');

  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto max-w-[1600px] px-4 py-5 md:px-6 md:py-6">
        <section className="relative mb-4 block min-h-0 overflow-hidden rounded-3xl border border-emerald-200 bg-gradient-to-br from-[#f8fcf9] via-white to-[#fff9e8] shadow-lg">
          <div className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-emerald-700/10" />
          <div className="pointer-events-none absolute -bottom-32 right-36 h-64 w-64 rounded-full bg-amber-300/20" />
          <div className="grid min-h-[330px] lg:grid-cols-[minmax(0,1fr)_390px]">
            <div className="relative z-10 flex flex-col justify-center p-6 md:p-9 lg:p-12">
              <div className="mb-3 inline-flex w-fit items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-black uppercase tracking-wide text-amber-800"><i className="bi bi-house-heart" />CDOC Attendance Home</div>
              {homeSettingsReady ? <h1 style={{ ...homeTitleStyle, marginTop: '0.25rem' }} title={homeTitle}>{homeTitle}</h1> : <div className="mt-2 h-14 w-full max-w-3xl animate-pulse rounded-lg bg-gray-200" role="status" aria-label="Loading home title" />}
              <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600 md:text-lg"><strong className="text-slate-900">{greeting}, {user?.first_name || displayName(user)}.</strong> Your attendance workspace is ready for today.</p>
              {primaryPath ? <div className="mt-5"><button type="button" onClick={() => goTo(primaryPath)} className="inline-flex items-center gap-2 rounded-xl bg-emerald-700 px-5 py-3 text-sm font-bold text-white shadow-md transition hover:-translate-y-0.5 hover:bg-emerald-800"><span>{profile.primaryLabel}</span><i className="bi bi-arrow-right" /></button></div> : null}
            </div>
            <div className="relative z-10 m-4 flex flex-col justify-between overflow-hidden rounded-2xl bg-[#0f5132] p-5 text-white shadow-xl md:m-6 md:p-6 lg:ml-0 lg:m-7">
              <img src="cdoc-logo.webp?v=lossless-20260911" alt="" aria-hidden="true" className="pointer-events-none absolute -bottom-8 -right-8 h-48 w-48 object-contain opacity-10" />
              <div className="relative"><div className="flex items-center gap-3"><span className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/10"><img src="cdoc-logo.webp?v=lossless-20260911" alt="CDOC logo" className="h-10 w-10 object-contain" /></span><div><div className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-200">Signed-in workspace</div><div className="mt-0.5 text-lg font-black">{titleCase(roleName)}</div></div></div></div>
              <div className="relative mt-8 space-y-3">
                <div className="rounded-xl border border-white/15 bg-white/10 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-emerald-200">Today</div><div className="mt-1 font-semibold">{todayLabel}</div></div>
                <div className="rounded-xl border border-white/15 bg-white/10 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-emerald-200">Active semester</div><div className="mt-1 font-semibold">{snapshotLoading ? 'Loading…' : semesterLabel(semester)}</div></div>
              </div>
            </div>
          </div>
        </section>

        {snapshotError ? (
          <div className="mb-4 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-950 shadow-sm sm:flex-row sm:items-center" role="status" aria-live="polite">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700" aria-hidden="true"><i className="bi bi-cloud-slash" /></span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold">Live summary unavailable</div>
              <div className="mt-0.5 text-sm text-amber-800">Your navigation is still available. Try refreshing the dashboard summary.</div>
            </div>
            <button type="button" onClick={() => loadHomeSnapshot()} disabled={snapshotLoading} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-bold text-amber-900 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60">
              <i className="bi bi-arrow-clockwise" aria-hidden="true" />
              {snapshotLoading ? 'Refreshing...' : 'Try Again'}
            </button>
          </div>
        ) : null}

        {!snapshotLoading && nextAction?.urgent ? <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"><i className="bi bi-exclamation-circle me-2" /><strong>Attention:</strong> Work requires review today. The recommended action opens the exact issue list.</div> : null}

        <section className="block min-h-0">
          <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between"><div><div className="text-xs font-bold uppercase tracking-wide text-emerald-700">Continue your day</div><h2 className="text-xl font-black text-gray-900">What’s happening now</h2></div><span className="text-xs text-gray-500">{snapshotLoading ? 'Loading live summary…' : semesterLabel(semester)}</span></div>
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <div className="rounded-2xl border border-emerald-200 bg-white p-5 shadow-sm md:p-6"><div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between"><div className="flex min-w-0 gap-4"><span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-xl text-emerald-700"><i className="bi bi-compass" /></span><div className="min-w-0"><div className="text-xs font-bold uppercase tracking-wide text-emerald-700">Recommended next step</div><h3 className="mt-1 text-xl font-black text-gray-900 md:text-2xl">{snapshotLoading ? profile.title : nextAction?.title}</h3><p className="mt-1 max-w-3xl text-sm leading-6 text-gray-600">{snapshotLoading ? profile.intro : nextAction?.detail}</p></div></div>{!snapshotLoading && nextAction?.path ? <button type="button" onClick={() => goTo(nextAction.path)} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-bold text-emerald-800 hover:bg-emerald-100"><span>{nextAction.label}</span><i className="bi bi-arrow-right" /></button> : null}</div></div>
            <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
              {summaryCards.map((item) => <div key={item.label} className="flex min-h-[96px] items-center gap-3 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"><span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border text-lg ${accentClasses[item.tone] || accentClasses.gray}`}><i className={`bi ${item.icon}`} /></span><div className="min-w-0"><div className="text-2xl font-black text-gray-900">{snapshotLoading || !homeSnapshot ? '—' : item.value}</div><div className="text-[10px] font-bold uppercase tracking-wide text-gray-500">{item.label}</div></div></div>)}
            </div>
          </div>
        </section>

        <section className="mt-5 block min-h-0">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div><div className="text-xs font-bold uppercase tracking-wide text-emerald-700">Quick access</div><h2 className="text-xl font-black text-gray-900">Where would you like to go?</h2></div>
            <span className="text-xs text-gray-500">{visibleShortcuts.length} available</span>
          </div>
          {visibleShortcuts.length > 0 ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{visibleModuleCards.map((item) => <button key={item.path} type="button" onClick={() => goTo(item.path)} className="group relative flex min-h-[112px] items-center gap-4 overflow-hidden rounded-2xl border border-gray-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-1 hover:border-emerald-300 hover:shadow-lg"><span className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border text-xl ${accentClasses[item.accent] || accentClasses.gray}`}><i className={item.icon} /></span><span className="min-w-0 flex-1"><span className="block text-base font-black text-gray-900 group-hover:text-emerald-700">{item.label}</span><span className="mt-1 block truncate text-xs text-gray-500">{item.description}</span></span><i className="bi bi-arrow-up-right shrink-0 text-gray-300 transition group-hover:text-emerald-600" /></button>)}</div> : <div className="rounded-xl border border-gray-200 bg-white p-5 text-gray-600 shadow-sm">No modules are available for this account.</div>}
          {visibleShortcuts.length > 8 ? <div className="mt-3 text-center"><button type="button" onClick={() => setShowAllModules((value) => !value)} className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:border-emerald-300 hover:text-emerald-700">{showAllModules ? 'Show fewer modules' : `Show all ${visibleShortcuts.length} modules`}</button></div> : null}
        </section>

      </div>
    </div>
  );
}

export default HomeIndex;
