import React from 'react';
import { DashboardLoadingSkeleton } from '../../components/PageLoadingSkeletons.jsx';
import { AuthContext } from '../../context/AuthContext.jsx';
import { apiGet } from '../../services/api.js';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';

const STATUS_META = {
  present: { label: 'Present', tone: 'bg-green-50 text-green-700 border-green-200', dot: 'bg-green-600' },
  late: { label: 'Late', tone: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-500' },
  absent: { label: 'Absent', tone: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-600' },
  incomplete: { label: 'Partial Attendance', tone: 'bg-violet-50 text-violet-700 border-violet-200', dot: 'bg-violet-500' },
  pending: { label: 'Pending', tone: 'bg-orange-50 text-orange-700 border-orange-200', dot: 'bg-orange-500' },
  upcoming: { label: 'Upcoming', tone: 'bg-slate-100 text-slate-700 border-slate-200', dot: 'bg-slate-500' },
  substituted: { label: 'Substituted', tone: 'bg-indigo-50 text-indigo-700 border-indigo-200', dot: 'bg-indigo-600' },
  on_leave: { label: 'On Leave', tone: 'bg-cyan-50 text-cyan-700 border-cyan-200', dot: 'bg-cyan-600' },
};

const CHECKPOINT_META = {
  1: { label: 'Upcoming', tone: 'border-slate-500 bg-slate-500 text-white', dot: 'bg-slate-500' },
  2: { label: 'Present', tone: 'border-green-600 bg-green-600 text-white', dot: 'bg-green-600' },
  3: { label: 'Absent', tone: 'border-red-600 bg-red-600 text-white', dot: 'bg-red-600' },
  4: { label: 'Substituted', tone: 'border-indigo-600 bg-indigo-600 text-white', dot: 'bg-indigo-600' },
  5: { label: 'Late', tone: 'border-amber-500 bg-amber-500 text-slate-950', dot: 'bg-amber-500' },
  7: { label: 'On Leave', tone: 'border-cyan-600 bg-cyan-600 text-white', dot: 'bg-cyan-600' },
  8: { label: 'Pending', tone: 'border-orange-500 bg-orange-500 text-slate-950', dot: 'bg-orange-500' },
};

const checkpointMeta = (stage) => {
  const flagId = Number(stage?.flag_id || 0);
  if (CHECKPOINT_META[flagId]) return CHECKPOINT_META[flagId];
  return stage?.recorded_at ? CHECKPOINT_META[2] : CHECKPOINT_META[1];
};

const formatTime = (value) => {
  if (!value) return '—';
  const match = String(value).match(/(\d{2}):(\d{2})/);
  if (!match) return String(value);
  const date = new Date(2000, 0, 1, Number(match[1]), Number(match[2]));
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

const formatDateTime = (value) => {
  if (!value) return 'Not updated yet';
  const date = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const semesterLabel = (semester) => {
  if (!semester) return 'No active semester';
  return [semester.school_year, semester.term].filter(Boolean).join(' · ') || 'Active semester';
};

const StatusBadge = ({ status }) => {
  const meta = STATUS_META[status] || STATUS_META.pending;
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${meta.tone}`}>{meta.label}</span>;
};

const Card = ({ children, className = '' }) => (
  <div className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>{children}</div>
);

const CardHeader = ({ title, subtitle, action }) => (
  <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3.5 md:px-5">
    <div>
      <h2 className="text-sm font-bold text-slate-900 md:text-base">{title}</h2>
      {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
    </div>
    {action ? <div className="shrink-0">{action}</div> : null}
  </div>
);

const Pagination = ({ page, totalPages, onChange, label }) => {
  if (totalPages <= 1) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-slate-100 px-4 py-3 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between md:px-5">
      <span>{label} · Page {page} of {totalPages}</span>
      <div className="flex gap-2">
        <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)} className="rounded-md border border-slate-200 px-3 py-1.5 font-semibold text-slate-600 disabled:opacity-40">Previous</button>
        <button type="button" disabled={page >= totalPages} onClick={() => onChange(page + 1)} className="rounded-md border border-slate-200 px-3 py-1.5 font-semibold text-slate-600 disabled:opacity-40">Next</button>
      </div>
    </div>
  );
};

const dashboardFocusFromHash = () => {
  const query = String(window.location.hash || '').split('?')[1] || '';
  const focus = new URLSearchParams(query).get('focus') || '';
  return ['missing-checkpoints', 'blocked-schedules'].includes(focus) ? focus : '';
};

function DashboardPage() {
  const { user } = React.useContext(AuthContext) || {};
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState('');
  const [scheduleSearch, setScheduleSearch] = React.useState('');
  const [debouncedScheduleSearch, setDebouncedScheduleSearch] = React.useState('');
  const [scheduleStatus, setScheduleStatus] = React.useState('all');
  const [schedulePage, setSchedulePage] = React.useState(1);
  const [recentSearch, setRecentSearch] = React.useState('');
  const [recentPage, setRecentPage] = React.useState(1);
  const [departmentFilter, setDepartmentFilter] = React.useState('');
  const [programFilter, setProgramFilter] = React.useState('');
  const [scopeFiltersExpanded, setScopeFiltersExpanded] = React.useState(true);
  const [issueFocus, setIssueFocus] = React.useState(dashboardFocusFromHash);
  const dashboardRequestRef = React.useRef(0);

  const loadData = React.useCallback(async ({ silent = false } = {}) => {
    const requestId = ++dashboardRequestRef.current;
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const query = new URLSearchParams({
        timeline_paginate: '1',
        timeline_page: String(schedulePage),
        timeline_page_size: '10',
        timeline_status: scheduleStatus,
      });
      if (debouncedScheduleSearch) query.set('timeline_search', debouncedScheduleSearch);
      if (departmentFilter) query.set('dept_id', departmentFilter);
      if (programFilter) query.set('program_id', programFilter);
      const response = await apiGet(`dashboard/operations${query.toString() ? `?${query.toString()}` : ''}`);
      if (requestId !== dashboardRequestRef.current) return;
      setData(response || null);
      const responseTimelinePage = Number(response?.schedule_pagination?.page || schedulePage);
      if (responseTimelinePage !== Number(schedulePage)) setSchedulePage(responseTimelinePage);
      setError('');
    } catch (requestError) {
      if (requestId !== dashboardRequestRef.current) return;
      setError(requestError?.body?.message || requestError?.message || 'Unable to load dashboard data.');
    } finally {
      if (requestId === dashboardRequestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [departmentFilter, programFilter, schedulePage, scheduleStatus, debouncedScheduleSearch]);

  React.useEffect(() => { loadData(); }, [loadData]);
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setSchedulePage(1);
      setDebouncedScheduleSearch(scheduleSearch.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [scheduleSearch]);
  useAutoRefresh({
    refresh: () => loadData({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.HEAVY,
    enabled: Boolean(user),
  });

  const navigate = (path) => { window.location.hash = `#${path}`; };
  const openIssueFocus = React.useCallback((focus) => {
    setIssueFocus(focus);
    const nextHash = `#/dashboard?focus=${encodeURIComponent(focus)}`;
    if (window.location.hash !== nextHash) window.location.hash = nextHash;
  }, []);
  const closeIssueFocus = React.useCallback(() => {
    setIssueFocus('');
    if (window.location.hash.includes('focus=')) window.location.hash = '#/dashboard';
  }, []);

  React.useEffect(() => {
    if (!issueFocus || !data) return undefined;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event) => { if (event.key === 'Escape') closeIssueFocus(); };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [issueFocus, data, closeIssueFocus]);

  if (loading && !data) {
    return <DashboardLoadingSkeleton />;
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <div className="rounded-xl border border-red-200 bg-white p-6 shadow-sm">
          <i className="bi bi-exclamation-circle text-2xl text-red-600" />
          <h1 className="mt-2 text-lg font-bold text-slate-900">Dashboard unavailable</h1>
          <p className="mt-1 text-sm text-red-700">{error}</p>
          <button type="button" onClick={() => loadData()} className="mt-4 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white">Try again</button>
        </div>
      </div>
    );
  }

  const overview = data.overview || {};
  const attendance = data.attendance_today || {};
  const status = attendance.status || {};
  const checkpoints = attendance.checkpoints || {};
  const checkpointBreakdown = attendance.checkpoint_breakdown || {};
  const actions = (Array.isArray(data.actions) ? data.actions : []).slice().sort((left, right) => Number(right.count || 0) - Number(left.count || 0));
  const schedule = Array.isArray(data.schedule_today) ? data.schedule_today : [];
  const schedulePagination = data.schedule_pagination || {
    page: 1,
    page_size: 10,
    total: schedule.length,
    total_pages: Math.max(1, Math.ceil(schedule.length / 10)),
    available: schedule.length,
  };
  const suspendedSchedules = Array.isArray(data.suspended_schedules) ? data.suspended_schedules : [];
  const blockedSchedules = Array.isArray(data.blocked_schedules) ? data.blocked_schedules : suspendedSchedules;
  const coverage = data.coverage || {};
  const missingCheckpoints = Array.isArray(data.missing_checkpoints) ? data.missing_checkpoints : [];
  const missingCheckpointTotal = Number(data.missing_checkpoints_total || missingCheckpoints.length);
  const blockedScheduleTotal = Number(coverage.blocked ?? data.blocked_schedules_total ?? data.suspended_schedules_total ?? blockedSchedules.length);
  const affectedClassCount = Number(overview.affected_classes_today || 0);
  const effectiveIssueFocus = issueFocus || (missingCheckpointTotal > 0 ? 'missing-checkpoints' : 'blocked-schedules');
  const filterContext = data.context?.filters || {};
  const departmentOptions = Array.isArray(filterContext.departments) ? filterContext.departments : [];
  const allProgramOptions = Array.isArray(filterContext.programs) ? filterContext.programs : [];
  const programOptions = departmentFilter ? allProgramOptions.filter((item) => Number(item.dept_id) === Number(departmentFilter)) : allProgramOptions;
  const trend = Array.isArray(data.trend) ? data.trend : [];
  const recent = Array.isArray(data.recent_activity) ? data.recent_activity : [];
  const maxTrend = Math.max(1, ...trend.map((row) => Number(row.total || 0)));
  const scheduleMatchingTotal = Number(schedulePagination.total ?? schedule.length);
  const scheduleAvailableTotal = Number(schedulePagination.available ?? scheduleMatchingTotal);
  const schedulePages = Math.max(1, Number(schedulePagination.total_pages || 1));
  const safeSchedulePage = Math.min(Math.max(1, Number(schedulePagination.page || schedulePage)), schedulePages);
  const scheduleVisible = schedule;
  const recentFiltered = recent.filter((item) => {
    const needle = recentSearch.trim().toLowerCase();
    const statusLabel = STATUS_META[item.overall_status]?.label || item.overall_status;
    return !needle || [item.staff_name, item.subject_code, item.section_name, item.room_name, item.date, item.overall_status, statusLabel].some((value) => String(value || '').toLowerCase().includes(needle));
  });
  const recentPageSize = 10;
  const recentPages = Math.max(1, Math.ceil(recentFiltered.length / recentPageSize));
  const safeRecentPage = Math.min(recentPage, recentPages);
  const recentVisible = recentFiltered.slice((safeRecentPage - 1) * recentPageSize, safeRecentPage * recentPageSize);

  const metricCards = [
    { label: 'Scheduled today', value: overview.scheduled_today || 0, note: `${coverage.ready ?? coverage.operational ?? 0} ready · ${blockedScheduleTotal} blocked`, icon: 'bi-calendar2-week', color: 'text-emerald-700 bg-emerald-50', path: '/class-schedules' },
    { label: 'Active classes now', value: overview.active_classes || 0, note: `${overview.rooms_in_use || 0} rooms in use`, icon: 'bi-broadcast', color: 'text-blue-700 bg-blue-50', path: '/3d-building' },
    { label: 'Teaching staff', value: overview.teaching_staff || 0, note: data.context?.scope_label || 'Authorized scope', icon: 'bi-people', color: 'text-violet-700 bg-violet-50', path: '/users' },
  ];
  const navigateAction = (action) => {
    if (action?.key === 'missing_checkpoints') {
      openIssueFocus('missing-checkpoints');
      return;
    }
    if (action?.key === 'suspended_schedules') {
      openIssueFocus('blocked-schedules');
      return;
    }
    navigate(action?.path || '/dashboard');
  };
  const attendanceVisual = [
    ['present', '#16a34a'], ['late', '#f59e0b'], ['absent', '#dc2626'], ['incomplete', '#8b5cf6'],
    ['pending', '#f97316'], ['upcoming', '#64748b'], ['substituted', '#4f46e5'], ['on_leave', '#0891b2'],
  ].map(([key, color]) => ({ key, color, value: Number(status[key] || 0), label: STATUS_META[key].label }));
  const attendanceVisualTotal = attendanceVisual.reduce((sum, item) => sum + item.value, 0);
  let attendanceVisualCursor = 0;
  const attendanceGradient = attendanceVisualTotal > 0
    ? `conic-gradient(${attendanceVisual.filter((item) => item.value > 0).map((item) => { const start = attendanceVisualCursor; attendanceVisualCursor += (item.value / attendanceVisualTotal) * 100; return `${item.color} ${start}% ${attendanceVisualCursor}%`; }).join(', ')})`
    : '#e2e8f0';

  return (
    <div className="min-h-full bg-white px-4 py-5 md:px-6">
      <div className="mx-auto max-w-[1450px] space-y-4">
        <Card className="px-5 py-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-bold text-slate-900 md:text-2xl">Operations Dashboard</h1>
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">{semesterLabel(data.context?.semester)}</span>
              </div>
              <p className="mt-1 text-sm text-slate-500">{data.context?.scope_label || 'Authorized scope'} · Attendance operations and items requiring action</p>
              <p className="mt-1 text-xs text-slate-400">Last updated {formatDateTime(data.generated_at)}{refreshing ? ' · Updating…' : ''}</p>
            </div>
            <button type="button" disabled={refreshing} onClick={() => loadData({ silent: true })} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:border-emerald-300 hover:text-emerald-700 disabled:opacity-60">
              <i className={`bi bi-arrow-clockwise ${refreshing ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>
          {error ? <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">Refresh failed: {error}. Showing the last successful data.</div> : null}
          {(departmentOptions.length > 1 || allProgramOptions.length > 1) ? <div className="mt-4 border-t border-slate-100 pt-3"><button type="button" onClick={() => setScopeFiltersExpanded((value) => !value)} className="mb-2 inline-flex items-center gap-2 text-xs font-semibold text-emerald-700 lg:hidden" aria-expanded={scopeFiltersExpanded}><i className={`bi ${scopeFiltersExpanded ? 'bi-chevron-up' : 'bi-sliders'}`} />{scopeFiltersExpanded ? 'Hide scope filters' : 'Show scope filters'}</button><div className={`${scopeFiltersExpanded ? 'grid' : 'hidden'} gap-2 sm:grid-cols-2 lg:grid lg:max-w-2xl`}>
            <label><span className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-slate-500">Department scope</span><select value={departmentFilter} onChange={(event) => { setSchedulePage(1); setDepartmentFilter(event.target.value); setProgramFilter(''); }} className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-emerald-500"><option value="">All authorized departments</option>{departmentOptions.map((item) => <option key={item.dept_id} value={item.dept_id}>{item.dept_name}</option>)}</select></label>
            <label><span className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-slate-500">Program scope</span><select value={programFilter} onChange={(event) => { setSchedulePage(1); setProgramFilter(event.target.value); }} className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-emerald-500"><option value="">All authorized programs</option>{programOptions.map((item) => <option key={item.program_id} value={item.program_id}>{item.program_name}</option>)}</select></label>
          </div></div> : null}
        </Card>

        {!data.context?.semester ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"><i className="bi bi-calendar-x mr-2" />No active semester is configured. Operational attendance data is empty until a semester is activated.</div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-3">
          {metricCards.map((metric) => (
            <button key={metric.label} type="button" onClick={() => navigate(metric.path)} className="rounded-xl text-left transition hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-emerald-500/40">
              <Card className="flex min-h-[94px] items-center gap-3 px-4 py-3 transition hover:border-emerald-300">
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${metric.color}`}><i className={`bi ${metric.icon}`} /></div>
                <div className="min-w-0 flex-1"><p className="text-xl font-bold leading-none text-slate-900">{metric.value}</p><p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{metric.label}</p><p className="mt-0.5 truncate text-xs text-slate-400">{metric.note}</p></div><i className="bi bi-arrow-up-right text-xs text-slate-400" />
              </Card>
            </button>
          ))}
        </div>

        <div className="grid gap-4 xl:grid-cols-12">
          <Card className="xl:col-span-7">
            <CardHeader title="Attendance distribution" subtitle={`${attendanceVisualTotal} classes represented today`} />
            <div className="grid gap-5 p-4 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center md:p-5">
              <div className="relative mx-auto h-40 w-40 rounded-full" style={{ background: attendanceGradient }} role="img" aria-label={`Attendance distribution: ${attendanceVisual.map((item) => `${item.label} ${item.value}`).join(', ')}`}><div className="absolute inset-7 flex flex-col items-center justify-center rounded-full bg-white"><span className="text-2xl font-bold text-slate-900">{attendanceVisualTotal}</span><span className="text-[10px] font-bold uppercase text-slate-500">Classes</span></div></div>
              <div className="grid grid-cols-2 gap-x-5 gap-y-2">{attendanceVisual.map((item) => <div key={item.key} className="flex items-center justify-between gap-2 border-b border-slate-100 py-1.5"><span className="inline-flex min-w-0 items-center gap-2 text-xs text-slate-600"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />{item.label}</span><span className="text-sm font-bold text-slate-900">{item.value}</span></div>)}</div>
            </div>
          </Card>
          <Card className="xl:col-span-5">
            <CardHeader title="Schedule health" subtitle={`${coverage.scheduled || 0} classes scheduled today`} action={<button type="button" onClick={() => navigate('/class-schedules')} className="text-xs font-semibold text-emerald-700 hover:underline">View all schedules</button>} />
            <div className="space-y-4 p-4 md:p-5">{[
              ['Ready today', coverage.ready ?? coverage.operational ?? 0, 'bg-emerald-500'],
              ['Blocked schedules', blockedScheduleTotal, 'bg-red-500'],
            ].map(([label, value, color]) => <div key={label}><div className="mb-1 flex items-center justify-between text-xs"><span className="font-semibold text-slate-600">{label}</span><span className="font-bold text-slate-900">{value}</span></div><div className="h-2.5 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, Number(value || 0) / Math.max(1, Number(coverage.scheduled || 0)) * 100)}%` }} /></div></div>)}</div>
            <div className="grid grid-cols-3 gap-2 border-t border-slate-100 px-4 py-3 text-center md:px-5"><div><div className="text-sm font-bold text-violet-700">{coverage.suspended || 0}</div><div className="text-[10px] text-slate-500">Inactive/archive</div></div><div><div className="text-sm font-bold text-amber-700">{coverage.missing_room || 0}</div><div className="text-[10px] text-slate-500">Missing room</div></div><div><div className="text-sm font-bold text-red-700">{coverage.room_conflicts || 0}</div><div className="text-[10px] text-slate-500">Conflict pairs</div></div></div>
            {blockedScheduleTotal > 0 ? <button type="button" onClick={() => openIssueFocus('blocked-schedules')} className="flex w-full items-center justify-between border-t border-slate-100 px-4 py-3 text-left text-xs font-semibold text-red-700 md:px-5"><span>Show the exact blocked schedules and reasons</span><i className="bi bi-arrow-right" /></button> : <div className="border-t border-slate-100 px-4 py-3 text-xs text-emerald-700"><i className="bi bi-check-circle mr-2" />No schedule health issues.</div>}
          </Card>
        </div>

        {issueFocus ? ReactDOM.createPortal(<div id="dashboard-issue-details" className="fixed inset-0 z-[80] flex items-center justify-center p-3 sm:p-6" role="dialog" aria-modal="true" aria-label="Dashboard issue details">
          <button type="button" aria-label="Close issue details" onClick={closeIssueFocus} className="absolute inset-0 bg-slate-950/50" />
          <div className="relative z-10 w-full max-w-5xl">
          <Card className="overflow-hidden shadow-2xl">
            <CardHeader
              title="Issue details"
              subtitle={`${affectedClassCount} unique affected class${affectedClassCount === 1 ? '' : 'es'} today`}
              action={<div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => openIssueFocus('missing-checkpoints')} className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${effectiveIssueFocus === 'missing-checkpoints' ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-slate-200 bg-white text-slate-600 hover:border-amber-200'}`}>Overdue checkpoints {missingCheckpointTotal}</button>
                <button type="button" onClick={() => openIssueFocus('blocked-schedules')} className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${effectiveIssueFocus === 'blocked-schedules' ? 'border-red-300 bg-red-50 text-red-700' : 'border-slate-200 bg-white text-slate-600 hover:border-red-200'}`}>Blocked schedules {blockedScheduleTotal}</button>
                <button type="button" onClick={closeIssueFocus} aria-label="Close issue details" className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 hover:bg-slate-100 hover:text-slate-800"><i className="bi bi-x-lg" /></button>
              </div>}
            />

            {effectiveIssueFocus === 'missing-checkpoints' ? (
              <div>
                <div className="max-h-[58vh] divide-y divide-slate-100 overflow-y-auto">
                  {missingCheckpoints.length ? missingCheckpoints.map((item, index) => (
                    <div key={`${item.schedule_id}-${item.checkpoint || index}`} className="grid gap-2 px-4 py-3.5 md:grid-cols-[minmax(0,1fr)_170px_150px] md:items-center md:px-5">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-800">{item.checkpoint_label || 'Checkpoint'} overdue</span><span className="text-xs text-slate-400">Schedule #{item.schedule_id}</span></div>
                        <p className="mt-1 truncate text-sm font-semibold text-slate-900">{item.subject_code || item.subject_name || 'Class'}{item.section_name ? ` · ${item.section_name}` : ''}</p>
                        <p className="mt-0.5 truncate text-xs text-slate-500">{item.staff_name || 'Unassigned teacher'} · {item.room_name || 'No room assigned'}</p>
                      </div>
                      <div><p className="text-xs font-semibold text-slate-700">{formatTime(item.start_time)}–{formatTime(item.end_time)}</p><p className="mt-0.5 text-[10px] text-slate-400">Class time</p></div>
                      <div><p className="text-xs font-semibold text-amber-800">Due {formatDateTime(item.due_at)}</p><p className="mt-0.5 text-[10px] text-slate-400">Missing attendance action</p></div>
                    </div>
                  )) : <div className="px-4 py-10 text-center text-sm text-emerald-700"><i className="bi bi-check-circle mr-2" />No overdue checkpoints.</div>}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/70 px-4 py-3 md:px-5">
                  <p className="text-xs text-slate-500">{missingCheckpointTotal > missingCheckpoints.length ? `Showing the first ${missingCheckpoints.length} of ${missingCheckpointTotal} checkpoint events.` : `${missingCheckpointTotal} checkpoint event${missingCheckpointTotal === 1 ? '' : 's'} shown.`}</p>
                  <button type="button" onClick={() => navigate('/attendancemgmt')} className="text-xs font-semibold text-emerald-700 hover:underline">Open attendance records <i className="bi bi-arrow-right ml-1" /></button>
                </div>
              </div>
            ) : (
              <div>
                <div className="max-h-[58vh] divide-y divide-slate-100 overflow-y-auto">
                  {blockedSchedules.length ? blockedSchedules.map((item) => (
                    <div key={item.schedule_id} className="grid gap-2 px-4 py-3.5 md:grid-cols-[minmax(0,1fr)_170px] md:items-center md:px-5">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase text-red-700">Blocked</span><span className="text-xs text-slate-400">Schedule #{item.schedule_id}</span></div>
                        <p className="mt-1 truncate text-sm font-semibold text-slate-900">{item.subject_code || item.subject_name || 'Class'}{item.section_name ? ` · ${item.section_name}` : ''}</p>
                        <p className="mt-0.5 truncate text-xs text-slate-500">{item.staff_name || 'Unassigned teacher'} · {item.room_name || 'No room assigned'} · {formatTime(item.start_time)}–{formatTime(item.end_time)}</p>
                      </div>
                      <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-red-700">Why it is blocked</p>
                        <p className="mt-1 text-xs leading-5 text-red-800">{Array.isArray(item.reasons) && item.reasons.length ? item.reasons.join(' · ') : 'This schedule has an unresolved setup issue.'}</p>
                      </div>
                    </div>
                  )) : <div className="px-4 py-10 text-center text-sm text-emerald-700"><i className="bi bi-check-circle mr-2" />No blocked schedules.</div>}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/70 px-4 py-3 md:px-5">
                  <p className="text-xs text-slate-500">{blockedScheduleTotal > blockedSchedules.length ? `Showing the first ${blockedSchedules.length} of ${blockedScheduleTotal} blocked schedules.` : `${blockedScheduleTotal} blocked schedule${blockedScheduleTotal === 1 ? '' : 's'} shown.`}</p>
                  <button type="button" onClick={() => navigate('/class-schedules')} className="text-xs font-semibold text-emerald-700 hover:underline">Open all schedules <i className="bi bi-arrow-right ml-1" /></button>
                </div>
              </div>
            )}
          </Card>
          </div>
        </div>, document.body) : null}

        <div className="grid gap-4 xl:grid-cols-12">
          <Card className="xl:col-span-7">
            <CardHeader title="Checkpoint progress" subtitle={`${checkpoints.missing || 0} overdue checkpoint event${Number(checkpoints.missing || 0) === 1 ? '' : 's'}`} action={missingCheckpointTotal > 0 ? <button type="button" onClick={() => openIssueFocus('missing-checkpoints')} className="text-xs font-semibold text-amber-700 hover:underline">See affected classes</button> : null} />
            <div className="p-4 md:p-5">
              <div className="space-y-5">{[['check_in', 'Check-in'], ['mid_check', 'Mid-check'], ['check_out', 'Check-out']].map(([key, label]) => { const item = checkpointBreakdown[key] || {}; const percent = Number(item.due || 0) > 0 ? Number(item.completed || 0) / Number(item.due) * 100 : 0; return <div key={key}><div className="mb-1.5 flex items-end justify-between"><div><p className="text-sm font-bold text-slate-800">{label}</p><p className="text-[10px] text-slate-500">{item.missing || 0} missing</p></div><p className="text-sm font-bold text-slate-900">{item.completed || 0}/{item.due || 0}</p></div><div className="h-3 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${Number(item.missing || 0) > 0 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(100, percent)}%` }} /></div></div>; })}</div>
            </div>
          </Card>

          <Card className="xl:col-span-5">
            <CardHeader title="Action required" subtitle="Only modules available to your role are shown." />
            <div className="grid gap-2 p-4 md:grid-cols-2 md:p-5">
              {actions.length ? actions.map((action) => (
                <button key={action.key} type="button" onClick={() => navigateAction(action)} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-3 text-left transition hover:border-emerald-300 hover:bg-emerald-50/40">
                  <span className="text-sm font-semibold text-slate-700">{action.label}</span>
                  <span className={`min-w-8 rounded-full px-2 py-1 text-center text-xs font-bold ${Number(action.count) > 0 ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-500'}`}>{action.count || 0}</span>
                </button>
              )) : <p className="col-span-full py-6 text-center text-sm text-slate-500">No approval or management actions are available.</p>}
            </div>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-12">
          <Card className="xl:col-span-12">
            <CardHeader title="Today's class timeline" subtitle={`${scheduleMatchingTotal} of ${scheduleAvailableTotal} scheduled classes`} action={<button type="button" onClick={() => navigate('/class-schedules')} className="text-xs font-semibold text-emerald-700 hover:underline">Open schedules</button>} />
            <div className="grid gap-2 border-b border-slate-100 p-4 sm:grid-cols-[minmax(0,1fr)_180px] md:px-5">
              <label className="relative"><i className="bi bi-search absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400" /><input value={scheduleSearch} onChange={(event) => { setScheduleSearch(event.target.value); setSchedulePage(1); }} placeholder="Search staff, subject, section, or room" className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" /></label>
              <select value={scheduleStatus} onChange={(event) => { setScheduleStatus(event.target.value); setSchedulePage(1); }} className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-emerald-500">
                <option value="all">All attendance results</option>
                {Object.entries(STATUS_META).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-100 bg-slate-50/70 px-4 py-2.5 text-[11px] font-semibold text-slate-600 md:px-5">
              <span className="mr-1 font-bold text-slate-700">Checkpoint legend:</span>
              {[8, 5, 3, 2, 4, 7, 1].map((flagId) => {
                const meta = CHECKPOINT_META[flagId];
                return <span key={flagId} className="inline-flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-full ${meta.dot}`} />{meta.label}</span>;
              })}
            </div>
            <div className="divide-y divide-slate-100">
              {scheduleVisible.length ? scheduleVisible.map((item) => (
                <div key={item.schedule_id} className={`grid gap-3 px-4 py-3.5 md:grid-cols-[120px_minmax(0,1fr)_140px_110px] md:items-center md:px-5 ${item.is_active ? 'bg-emerald-50/50' : ''}`}>
                  <div><p className="text-sm font-bold text-slate-800">{formatTime(item.start_time)}–{formatTime(item.end_time)}</p>{item.is_active ? <p className="mt-1 text-xs font-semibold text-emerald-700">In progress</p> : null}</div>
                  <div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-900">{item.subject_code || item.subject_name || 'Class'}{item.section_name ? ` · ${item.section_name}` : ''}</p><p className="mt-0.5 truncate text-xs text-slate-500">{item.staff_name || 'Unassigned'} · {item.room_name || 'No room'}</p></div>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      ['IN', 'Check-in', item.check_in],
                      ['MID', 'Middle check', item.mid_check],
                      ['OUT', 'Check-out', item.check_out],
                    ].map(([shortLabel, fullLabel, stage]) => {
                      const meta = checkpointMeta(stage);
                      return (
                        <span
                          key={shortLabel}
                          className={`inline-flex h-6 min-w-10 items-center justify-center rounded-full border px-2 text-[9px] font-extrabold tracking-wide ${meta.tone}`}
                          title={`${fullLabel}: ${meta.label}`}
                          aria-label={`${fullLabel}: ${meta.label}`}
                        >
                          {shortLabel}
                        </span>
                      );
                    })}
                  </div>
                  <div className="md:text-right"><StatusBadge status={item.overall_status} /></div>
                </div>
              )) : <div className="px-4 py-10 text-center text-sm text-slate-500">No schedules match the selected filters.</div>}
            </div>
            <Pagination page={safeSchedulePage} totalPages={schedulePages} onChange={setSchedulePage} label={`${scheduleMatchingTotal} matching schedules`} />
          </Card>

        </div>

        <div className="grid gap-4 xl:grid-cols-12">
          <Card className="xl:col-span-5">
            <CardHeader title="14-day trend" subtitle="Present, Late, Absent, and Partial Attendance overall results" />
            <div className="flex h-52 items-end gap-2 overflow-x-auto p-4 md:p-5">
              {trend.length ? trend.map((row) => {
                const total = Math.max(1, Number(row.total || 0));
                const height = Math.max(8, Math.round((Number(row.total || 0) / maxTrend) * 150));
                const chartLabel = `${row.date}: ${row.total} records, ${row.present || 0} present, ${row.late || 0} late, ${row.absent || 0} absent, ${row.incomplete || 0} partial attendance`;
                return <div key={row.date} className="flex min-w-7 flex-1 flex-col items-center"><div className="flex w-full flex-col-reverse overflow-hidden rounded-t" style={{ height }} title={chartLabel} role="img" aria-label={chartLabel}><div className="bg-green-600" style={{ height: `${(Number(row.present || 0) / total) * 100}%` }} /><div className="bg-amber-500" style={{ height: `${(Number(row.late || 0) / total) * 100}%` }} /><div className="bg-red-600" style={{ height: `${(Number(row.absent || 0) / total) * 100}%` }} /><div className="bg-violet-500" style={{ height: `${(Number(row.incomplete || 0) / total) * 100}%` }} /></div><span className="mt-2 text-[10px] text-slate-400">{String(row.date).slice(5)}</span></div>;
              }) : <div className="m-auto text-sm text-slate-500">No attendance trend available for this semester.</div>}
            </div>
            <div className="flex flex-wrap gap-4 border-t border-slate-100 px-4 py-3 text-[10px] font-semibold text-slate-500 md:px-5">{[['Present', 'bg-green-600'], ['Late', 'bg-amber-500'], ['Absent', 'bg-red-600'], ['Partial Attendance', 'bg-violet-500']].map(([label, color]) => <span key={label} className="inline-flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-full ${color}`} />{label}</span>)}</div>
          </Card>

          <Card className="xl:col-span-7">
            <CardHeader title="Recent attendance activity" subtitle={`${recentFiltered.length} matching recent records`} action={<button type="button" onClick={() => navigate('/attendancemgmt')} className="text-xs font-semibold text-emerald-700 hover:underline">View all</button>} />
            <div className="border-b border-slate-100 p-4 md:px-5"><label className="relative block"><i className="bi bi-search absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400" /><input value={recentSearch} onChange={(event) => { setRecentSearch(event.target.value); setRecentPage(1); }} placeholder="Search recent teacher, class, room, date, or result" className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" /></label></div>
            <div className="hidden overflow-x-auto md:block">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2.5">Teacher</th><th className="px-4 py-2.5">Class</th><th className="px-4 py-2.5">Date &amp; class time</th><th className="px-4 py-2.5">Result</th></tr></thead>
                <tbody className="divide-y divide-slate-100">{recentVisible.map((row) => { const classTime = `${formatTime(row.start_time)}–${formatTime(row.end_time)}`; return <tr key={row.attendance_id}><td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-800">{row.staff_name}</td><td className="px-4 py-3 text-slate-600">{[row.subject_code, row.section_name, row.room_name].filter(Boolean).join(' · ') || '—'}</td><td className="whitespace-nowrap px-4 py-3 text-slate-500"><div>{row.date}</div><div className="mt-0.5 text-xs text-slate-400">{classTime}</div></td><td className="px-4 py-3"><StatusBadge status={row.overall_status} /></td></tr>; })}</tbody>
              </table>
            </div>
            <div className="divide-y divide-slate-100 md:hidden">{recentVisible.map((row) => { const classTime = `${formatTime(row.start_time)}–${formatTime(row.end_time)}`; return <div key={row.attendance_id} className="space-y-2 px-4 py-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-bold text-slate-900">{row.staff_name}</p><p className="mt-0.5 text-xs text-slate-500">{row.date} · {classTime}</p></div><StatusBadge status={row.overall_status} /></div><p className="break-words text-xs text-slate-600">{[row.subject_code, row.section_name, row.room_name].filter(Boolean).join(' · ') || 'No class details'}</p></div>; })}</div>
            {!recentVisible.length ? <div className="px-4 py-10 text-center text-sm text-slate-500">No recent attendance matches your search.</div> : null}
            <Pagination page={safeRecentPage} totalPages={recentPages} onChange={setRecentPage} label={`${recentFiltered.length} recent records`} />
          </Card>
        </div>
      </div>
    </div>
  );
}

export default DashboardPage;
