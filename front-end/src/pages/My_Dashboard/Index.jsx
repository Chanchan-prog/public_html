import React from 'react';
import { MyDashboardLoadingSkeleton } from '../../components/PageLoadingSkeletons.jsx';
import { AuthContext } from '../../context/AuthContext.jsx';
import { apiGet } from '../../services/api.js';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';

const STATUS_META = {
  present: ['Present', 'bg-green-50 text-green-700 border-green-200'],
  late: ['Late', 'bg-amber-50 text-amber-700 border-amber-200'],
  absent: ['Absent', 'bg-red-50 text-red-700 border-red-200'],
  incomplete: ['Partial Attendance', 'bg-violet-50 text-violet-700 border-violet-200'],
  pending: ['Pending', 'bg-orange-50 text-orange-700 border-orange-200'],
  upcoming: ['Upcoming', 'bg-slate-100 text-slate-700 border-slate-200'],
  substituted: ['Substituted', 'bg-indigo-50 text-indigo-700 border-indigo-200'],
  on_leave: ['On Leave', 'bg-cyan-50 text-cyan-700 border-cyan-200'],
};

const CALENDAR_STATUS_META = [
  ['pending', 'Pending', 'bg-orange-50 text-orange-700 border-orange-200', 'bg-orange-500'],
  ['late', 'Late', 'bg-amber-50 text-amber-700 border-amber-200', 'bg-amber-500'],
  ['absent', 'Absent', 'bg-red-50 text-red-700 border-red-200', 'bg-red-600'],
  ['incomplete', 'Partial Attendance', 'bg-violet-50 text-violet-700 border-violet-200', 'bg-violet-500'],
  ['present', 'Present', 'bg-green-50 text-green-700 border-green-200', 'bg-green-600'],
  ['substituted', 'Substituted', 'bg-indigo-50 text-indigo-700 border-indigo-200', 'bg-indigo-600'],
  ['on_leave', 'On Leave', 'bg-cyan-50 text-cyan-700 border-cyan-200', 'bg-cyan-600'],
  ['upcoming', 'Upcoming', 'bg-slate-100 text-slate-700 border-slate-200', 'bg-slate-500'],
];

const ROLE_NAMES = { 2: 'Dean', 3: 'Program Head', 4: 'Secretary', 5: 'Teacher' };
const formatTime = (value) => {
  const match = String(value || '').match(/(\d{2}):(\d{2})/);
  if (!match) return '—';
  return new Date(2000, 0, 1, Number(match[1]), Number(match[2])).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};
const formatDateTime = (value) => {
  if (!value) return 'Not updated yet';
  const date = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const semesterLabel = (semester) => semester ? [semester.school_year, semester.term].filter(Boolean).join(' · ') : 'No active semester';
const formatCountdown = (target, nowMs) => {
  if (!target) return '';
  const targetMs = new Date(target).getTime();
  if (!Number.isFinite(targetMs)) return '';
  const remaining = targetMs - nowMs;
  if (remaining <= 0) return 'Due now';
  const totalMinutes = Math.ceil(remaining / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m remaining` : `${minutes}m remaining`;
};
const StatusBadge = ({ status }) => {
  const [label, tone] = STATUS_META[status] || STATUS_META.pending;
  return <span className={`inline-flex shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold ${tone}`}>{label}</span>;
};
const Card = ({ children, className = '' }) => <div className={`min-w-0 rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>{children}</div>;
const CardHeader = ({ title, subtitle, action }) => <div className="flex flex-col items-start gap-2 border-b border-slate-100 px-4 py-3.5 sm:flex-row sm:justify-between sm:gap-3 md:px-5"><div className="min-w-0"><h2 className="break-words text-sm font-bold text-slate-900 md:text-base">{title}</h2>{subtitle ? <p className="mt-0.5 break-words text-xs text-slate-500">{subtitle}</p> : null}</div>{action ? <div className="w-full shrink-0 sm:w-auto">{action}</div> : null}</div>;

function MyDashboardPage() {
  const { user } = React.useContext(AuthContext) || {};
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState('');
  const [clock, setClock] = React.useState(Date.now());
  const [calendarExpanded, setCalendarExpanded] = React.useState(() => {
    try { return window.sessionStorage.getItem('my-dashboard-calendar') !== 'collapsed'; } catch { return true; }
  });

  const loadData = React.useCallback(async ({ silent = false } = {}) => {
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const response = await apiGet('dashboard/personal');
      setData(response || null);
      setError('');
    } catch (requestError) {
      setError(requestError?.body?.message || requestError?.message || 'Unable to load your dashboard.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => { loadData(); }, [loadData]);
  React.useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 30000); return () => window.clearInterval(timer); }, []);
  React.useEffect(() => {
    try { window.sessionStorage.setItem('my-dashboard-calendar', calendarExpanded ? 'expanded' : 'collapsed'); } catch { /* Session storage may be unavailable. */ }
  }, [calendarExpanded]);
  useAutoRefresh({ refresh: () => loadData({ silent: true }), intervalMs: AUTO_REFRESH_INTERVALS.HEAVY, enabled: Boolean(user) });
  const navigate = (path) => { window.location.hash = `#${path}`; };

  if (loading && !data) return <MyDashboardLoadingSkeleton />;
  if (!data) return <div className="mx-auto max-w-xl px-4 py-16 text-center"><Card className="p-6"><i className="bi bi-exclamation-circle text-2xl text-red-600" /><h1 className="mt-2 text-lg font-bold">My Dashboard is unavailable</h1><p className="mt-1 text-sm text-red-700">{error}</p><button onClick={() => loadData()} className="mt-4 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white">Try again</button></Card></div>;

  const personal = data.personal || {};
  const semesterSummary = personal.semester_summary || {};
  const requests = personal.pending_requests || {};
  const schedule = Array.isArray(data.schedule_today) ? data.schedule_today : [];
  const trend = Array.isArray(data.trend) ? data.trend : [];
  const recent = Array.isArray(data.recent_activity) ? data.recent_activity : [];
  const now = new Date();
  const currentOrNextClass = schedule.find((item) => item.is_active) || schedule.find((item) => {
    const match = String(item.start_time || '').match(/(\d{2}):(\d{2})/);
    if (!match) return false;
    const classStart = new Date(); classStart.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return classStart >= now;
  }) || null;
  const nextCheckpoint = currentOrNextClass?.next_checkpoint || null;
  const checkpointCountdown = nextCheckpoint?.is_due ? 'Due now' : formatCountdown(nextCheckpoint?.opens_at, clock);
  const calendar = personal.calendar || {};
  const calendarDays = Array.isArray(calendar.days) ? calendar.days : [];
  const calendarByDate = Object.fromEntries(calendarDays.map((item) => [item.date, item]));
  const calendarMonth = /^\d{4}-\d{2}$/.test(String(calendar.month || '')) ? String(calendar.month) : new Date().toISOString().slice(0, 7);
  const [calendarYear, calendarMonthNumber] = calendarMonth.split('-').map(Number);
  const firstCalendarDay = new Date(calendarYear, calendarMonthNumber - 1, 1);
  const daysInCalendarMonth = new Date(calendarYear, calendarMonthNumber, 0).getDate();
  const calendarCells = [...Array(firstCalendarDay.getDay()).fill(null), ...Array.from({ length: daysInCalendarMonth }, (_, index) => index + 1)];
  const calendarTitle = firstCalendarDay.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const localToday = new Date();
  const localTodayKey = `${localToday.getFullYear()}-${String(localToday.getMonth() + 1).padStart(2, '0')}-${String(localToday.getDate()).padStart(2, '0')}`;
  const warningCount = Number(personal.late_warnings || 0);
  const fullName = `${user?.first_name || ''} ${user?.last_name || ''}`.trim() || 'Teaching Staff';
  const maxTrend = Math.max(1, ...trend.map((row) => Number(row.total || 0)));
  const semesterVisual = [
    ['present', 'Present', '#16a34a'], ['late', 'Late', '#f59e0b'],
    ['absent', 'Absent', '#dc2626'], ['incomplete', 'Partial Attendance', '#8b5cf6'],
    ['pending', 'Pending', '#f97316'], ['upcoming', 'Upcoming', '#64748b'],
    ['substituted', 'Substituted', '#4f46e5'], ['on_leave', 'On Leave', '#0891b2'],
  ].map(([key, label, color]) => ({ key, label, color, value: Number(semesterSummary[key] || 0) }));
  const semesterVisualTotal = semesterVisual.reduce((sum, item) => sum + item.value, 0);
  let semesterVisualCursor = 0;
  const semesterGradient = semesterVisualTotal > 0
    ? `conic-gradient(${semesterVisual.filter((item) => item.value > 0).map((item) => { const start = semesterVisualCursor; semesterVisualCursor += item.value / semesterVisualTotal * 100; return `${item.color} ${start}% ${semesterVisualCursor}%`; }).join(', ')})`
    : '#e2e8f0';

  const metrics = [
    { label: 'Classes today', value: schedule.length, note: currentOrNextClass?.is_active ? 'Class currently in progress' : 'Your teaching schedule', icon: 'bi-calendar2-week', color: 'text-slate-700 bg-slate-100', path: '/my-attendance' },
    { label: 'Late warnings', value: warningCount, note: warningCount >= 3 ? 'Red flag threshold reached' : `${Math.max(0, 3 - warningCount)} before red flag`, icon: 'bi-clock-history', color: 'text-amber-700 bg-amber-50', path: '/attendance-history' },
    { label: 'Pending requests', value: Number(requests.pending ?? requests.attendance ?? 0), note: `${requests.total || 0} total requests`, icon: 'bi-hourglass-split', color: 'text-blue-700 bg-blue-50', path: '/my-requested-edits' },
  ];

  return (
    <div className="min-h-full overflow-x-hidden bg-white px-3 py-4 sm:px-4 sm:py-5 md:px-6">
      <div className="mx-auto max-w-[1350px] space-y-4">
        <Card className="px-4 py-4 sm:px-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div><div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-bold text-slate-900 md:text-2xl">My Dashboard</h1><span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">{semesterLabel(data.context?.semester)}</span></div><p className="mt-1 text-sm text-slate-500">{fullName} · {ROLE_NAMES[Number(user?.role_id)] || 'Teaching Staff'}</p><p className="mt-1 text-xs text-slate-400">Last updated {formatDateTime(data.generated_at)}{refreshing ? ' · Updating…' : ''}</p></div>
            <button disabled={refreshing} onClick={() => loadData({ silent: true })} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:border-emerald-300 hover:text-emerald-700 disabled:opacity-60 sm:w-auto"><i className={`bi bi-arrow-clockwise ${refreshing ? 'animate-spin' : ''}`} /> Refresh</button>
          </div>
          {error ? <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">Refresh failed: {error}. Showing the last successful data.</div> : null}
        </Card>

        {!data.context?.semester ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">No active semester is configured.</div> : null}

        <div className="grid gap-3 sm:grid-cols-3">{metrics.map((metric) => <button key={metric.label} type="button" onClick={() => navigate(metric.path)} className="rounded-xl text-left transition hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"><Card className="flex min-h-[96px] items-center gap-3 px-4 py-3 transition hover:border-emerald-300"><div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${metric.color}`}><i className={`bi ${metric.icon}`} /></div><div className="min-w-0 flex-1"><p className="break-words text-xl font-bold leading-none text-slate-900">{metric.value}</p><p className="mt-1 break-words text-xs font-semibold uppercase tracking-wide text-slate-500">{metric.label}</p><p className="mt-0.5 truncate text-[10px] text-slate-400">{metric.note}</p></div><i className="bi bi-arrow-up-right shrink-0 text-xs text-slate-400" /></Card></button>)}</div>

        <div className="grid gap-4 xl:grid-cols-12">
          <Card className="xl:col-span-7">
            <CardHeader title={currentOrNextClass?.is_active ? 'Class in progress' : 'Next class'} subtitle="Your next attendance action for today" />
            {currentOrNextClass ? <div className="p-4 sm:p-5"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"><div className="min-w-0"><p className="break-words text-lg font-bold text-slate-900 sm:text-xl">{currentOrNextClass.subject_code || currentOrNextClass.subject_name || 'Class'}{currentOrNextClass.section_name ? ` · ${currentOrNextClass.section_name}` : ''}</p><p className="mt-1 break-words text-sm text-slate-500">{formatTime(currentOrNextClass.start_time)}–{formatTime(currentOrNextClass.end_time)} · {currentOrNextClass.room_name || 'Room not assigned'}</p></div><StatusBadge status={currentOrNextClass.overall_status} /></div><div className={`mt-4 rounded-lg border px-3 py-3 sm:mt-5 sm:px-4 ${nextCheckpoint?.is_due ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-slate-50'}`}><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Next checkpoint</p><div className="mt-1 flex flex-col items-start gap-1 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:gap-2"><p className={`break-words text-sm font-bold ${nextCheckpoint?.is_due ? 'text-red-700' : 'text-slate-800'}`}>{nextCheckpoint?.label || 'All required checkpoints completed'}</p>{checkpointCountdown ? <p className={`whitespace-nowrap text-base font-bold sm:text-lg ${nextCheckpoint?.is_due ? 'animate-pulse text-red-700' : 'text-emerald-700'}`}>{checkpointCountdown}</p> : null}</div></div><button type="button" disabled={!nextCheckpoint} onClick={() => navigate('/attendance')} className={`mt-4 w-full rounded-lg px-4 py-2 text-sm font-semibold text-white sm:w-auto ${nextCheckpoint ? 'bg-emerald-700 hover:bg-emerald-800' : 'cursor-not-allowed bg-slate-400'}`}>{!nextCheckpoint ? 'Attendance completed' : nextCheckpoint.is_due ? `Scan ${nextCheckpoint.label}` : `Prepare attendance · ${checkpointCountdown || 'Upcoming'}`}</button></div> : <div className="p-6 text-center text-sm text-slate-500 sm:p-10">No more classes are scheduled today.</div>}
          </Card>

          <Card className="xl:col-span-5">
            <CardHeader title="Semester attendance" subtitle={`${semesterVisualTotal} attendance records`} action={<button type="button" onClick={() => navigate('/attendance-history')} className="text-xs font-semibold text-emerald-700 hover:underline">View history</button>} />
            <div className="grid gap-4 p-4 sm:grid-cols-[150px_minmax(0,1fr)] sm:items-center md:p-5 xl:grid-cols-1 2xl:grid-cols-[150px_minmax(0,1fr)]">
              <div className="relative mx-auto h-36 w-36 rounded-full" style={{ background: semesterGradient }} role="img" title="Present records divided by completed/applicable attendance records" aria-label={`Present rate ${Number(semesterSummary.attendance_rate || 0).toFixed(0)} percent. Semester attendance: ${semesterVisual.map((item) => `${item.label} ${item.value}`).join(', ')}`}><div className="absolute inset-6 flex flex-col items-center justify-center rounded-full bg-white"><span className="text-2xl font-bold text-slate-900">{Number(semesterSummary.attendance_rate || 0).toFixed(0)}%</span><span className="text-center text-[9px] font-bold uppercase leading-tight text-slate-500">Present Rate</span></div></div>
              <div className="grid grid-cols-2 gap-x-4">{semesterVisual.map((item) => <div key={item.key} className="flex min-w-0 items-center justify-between gap-2 border-b border-slate-100 py-1.5"><span className="inline-flex min-w-0 items-center gap-2 text-xs text-slate-600"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} /><span className="truncate" title={item.label}>{item.label}</span></span><span className="shrink-0 text-sm font-bold text-slate-900">{item.value}</span></div>)}</div>
            </div>
          </Card>
        </div>

        <Card className="p-3 sm:p-4"><div className="grid grid-cols-2 gap-2 md:grid-cols-4">{[['Attendance', '/attendance', 'bi-qr-code-scan'], ['Teaching Schedule', '/my-attendance', 'bi-calendar3'], ['Attendance History', '/attendance-history', 'bi-clock-history'], ['Requested Edits', '/my-requested-edits', 'bi-pencil-square']].map(([label, path, icon]) => <button key={path} onClick={() => navigate(path)} className="flex min-w-0 items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 py-2.5 text-center text-sm font-semibold text-slate-700 hover:border-emerald-300 hover:text-emerald-700 md:justify-start md:text-left"><i className={`bi ${icon} shrink-0`} /><span className="break-words">{label}</span></button>)}</div></Card>

        <Card>
          <CardHeader title="Today's teaching schedule" subtitle={`${schedule.length} class${schedule.length === 1 ? '' : 'es'} scheduled`} action={<button onClick={() => navigate('/my-attendance')} className="text-xs font-semibold text-emerald-700 hover:underline">Teaching Schedule</button>} />
          <div className="divide-y divide-slate-100">{schedule.length ? schedule.map((item) => <div key={item.schedule_id} className={`grid min-w-0 gap-3 px-4 py-3.5 sm:grid-cols-[110px_minmax(0,1fr)] sm:items-center lg:grid-cols-[120px_minmax(0,1fr)_180px_auto] md:px-5 ${item.is_active ? 'bg-emerald-50/50' : ''}`}><div className="min-w-0"><p className="whitespace-nowrap text-sm font-bold text-slate-800">{formatTime(item.start_time)}–{formatTime(item.end_time)}</p>{item.is_active ? <p className="text-xs font-semibold text-emerald-700">In progress</p> : null}</div><div className="min-w-0"><p className="break-words text-sm font-semibold text-slate-900">{item.subject_code || item.subject_name}{item.section_name ? ` · ${item.section_name}` : ''}</p><p className="break-words text-xs text-slate-500">{item.room_name || 'No room assigned'}</p></div><div className="grid grid-cols-3 gap-1.5 sm:col-span-2 lg:col-span-1">{[['IN', item.check_in], ['MID', item.mid_check], ['OUT', item.check_out]].map(([label, stage]) => <div key={label} className={`rounded-md px-2 py-1.5 text-center text-[10px] font-bold ${Number(stage?.flag_id) === 5 ? 'bg-amber-100 text-amber-700' : stage?.recorded_at ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{label}</div>)}</div><div className="sm:col-span-2 lg:col-span-1 lg:text-right"><StatusBadge status={item.overall_status} /></div></div>) : <div className="p-6 text-center text-sm text-slate-500 sm:p-10">No classes scheduled today.</div>}</div>
        </Card>

        <Card>
          <CardHeader title="Monthly attendance calendar" subtitle={`${calendarTitle} · Overall results for each teaching day`} action={<div className="flex items-center gap-2"><button type="button" onClick={() => navigate('/attendance-history')} className="text-xs font-semibold text-emerald-700 hover:underline">Open history</button><button type="button" onClick={() => setCalendarExpanded((value) => !value)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700" title={calendarExpanded ? 'Minimize calendar' : 'Show calendar'} aria-expanded={calendarExpanded}><i className={`bi ${calendarExpanded ? 'bi-chevron-up' : 'bi-chevron-down'}`} /></button></div>} />
          {calendarExpanded ? <div className="overflow-x-auto p-3 sm:p-5">
            <div className="min-w-[520px] sm:min-w-0">
            <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold uppercase tracking-wide text-slate-400">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => <div key={day} className="py-1">{day}</div>)}</div>
            <div className="mt-1 grid grid-cols-7 gap-1">{calendarCells.map((day, index) => {
              if (!day) return <div key={`blank-${index}`} className="min-h-16 rounded-lg bg-slate-50/50 sm:min-h-20" />;
              const dateKey = `${calendarMonth}-${String(day).padStart(2, '0')}`;
              const record = calendarByDate[dateKey] || {};
              const isToday = dateKey === localTodayKey;
              return <div key={dateKey} className={`min-h-20 rounded-lg border p-1.5 sm:min-h-24 sm:p-2 ${isToday ? 'border-emerald-400 bg-emerald-50/50' : 'border-slate-100 bg-white'}`}><div className="flex items-center justify-between"><span className={`text-xs font-bold ${isToday ? 'text-emerald-700' : 'text-slate-600'}`}>{day}</span>{Number(record.total || 0) > 0 ? <span className="text-[9px] font-semibold text-slate-400">{record.total} class{Number(record.total) === 1 ? '' : 'es'}</span> : null}</div><div className="mt-1.5 flex max-h-16 flex-col gap-1 overflow-y-auto pr-0.5">{CALENDAR_STATUS_META.map(([key, label, tone, dot]) => { const count = Number(record[key] || 0); return count > 0 ? <span key={key} title={`${count} ${label}`} className={`inline-flex w-fit max-w-full items-center gap-1 rounded border px-1 py-0.5 text-[8px] font-semibold leading-none sm:text-[9px] ${tone}`}><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} /><span className="truncate">{count} {label}</span></span> : null; })}</div></div>;
            })}</div>
            <div className="mt-3 flex flex-wrap gap-3 text-[10px] font-semibold text-slate-500">{CALENDAR_STATUS_META.map(([, label, , color]) => <span key={label} className="inline-flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${color}`} />{label}</span>)}</div>
            </div>
          </div> : null}
        </Card>

        <div className="grid gap-4 xl:grid-cols-12">
          <Card className="xl:col-span-5"><CardHeader title="14-day attendance" subtitle="Your current-semester overall results" /><div className="flex h-52 items-end gap-2 overflow-x-auto p-4 md:p-5">{trend.length ? trend.map((row) => { const total = Math.max(1, Number(row.total || 0)); const height = Math.max(8, Math.round((Number(row.total || 0) / maxTrend) * 150)); const chartLabel = `${row.date}: ${row.total} records, ${row.present || 0} present, ${row.late || 0} late, ${row.absent || 0} absent, ${row.incomplete || 0} partial attendance`; return <div key={row.date} className="flex min-w-7 flex-1 flex-col items-center"><div className="flex w-full flex-col-reverse overflow-hidden rounded-t" style={{ height }} title={chartLabel} role="img" aria-label={chartLabel}><div className="bg-green-600" style={{ height: `${Number(row.present || 0) / total * 100}%` }} /><div className="bg-amber-500" style={{ height: `${Number(row.late || 0) / total * 100}%` }} /><div className="bg-red-600" style={{ height: `${Number(row.absent || 0) / total * 100}%` }} /><div className="bg-violet-500" style={{ height: `${Number(row.incomplete || 0) / total * 100}%` }} /></div><span className="mt-2 text-[10px] text-slate-400">{String(row.date).slice(5)}</span></div>; }) : <div className="m-auto text-sm text-slate-500">No trend data available.</div>}</div><div className="flex flex-wrap gap-3 border-t border-slate-100 px-4 py-3 text-[10px] font-semibold text-slate-500">{[['Present', 'bg-green-600'], ['Late', 'bg-amber-500'], ['Absent', 'bg-red-600'], ['Partial Attendance', 'bg-violet-500']].map(([label, color]) => <span key={label} className="inline-flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-full ${color}`} />{label}</span>)}</div></Card>
          <Card className="w-full overflow-hidden xl:col-span-7">
            <CardHeader
              title="Recent attendance activity"
              subtitle="Latest final results from the active semester"
              action={<button onClick={() => navigate('/attendance-history')} className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 hover:underline">Attendance History <i className="bi bi-arrow-up-right" /></button>}
            />
            <div className="hidden w-full overflow-x-auto sm:block">
              <table className="w-full min-w-[680px] table-fixed text-sm">
                <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <tr><th className="w-[18%] px-4 py-3">Date</th><th className="w-[40%] px-4 py-3">Class</th><th className="w-[20%] px-4 py-3">Room</th><th className="w-[22%] px-4 py-3">Result</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {recent.slice(0, 8).map((row) => (
                    <tr key={row.attendance_id} className="align-middle transition-colors hover:bg-slate-50/80">
                      <td className="whitespace-nowrap px-4 py-4 text-slate-500">{row.date}</td>
                      <td className="break-words px-4 py-4 font-semibold text-slate-800">{[row.subject_code, row.section_name].filter(Boolean).join(' · ') || '—'}</td>
                      <td className="break-words px-4 py-4 text-slate-500">{row.room_name || '—'}</td>
                      <td className="px-4 py-4"><StatusBadge status={row.overall_status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="divide-y divide-slate-100 sm:hidden">
              {recent.slice(0, 8).map((row) => (
                <div key={row.attendance_id} className="space-y-2.5 px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-bold leading-snug text-slate-900">{[row.subject_code, row.section_name].filter(Boolean).join(' · ') || 'Class'}</p>
                      <p className="mt-1 text-xs text-slate-500">{row.date}</p>
                    </div>
                    <div className="shrink-0"><StatusBadge status={row.overall_status} /></div>
                  </div>
                  <p className="break-words text-xs text-slate-500"><i className="bi bi-door-open mr-1" />{row.room_name || 'No room assigned'}</p>
                </div>
              ))}
            </div>
            {!recent.length ? <div className="p-6 text-center text-sm text-slate-500 sm:p-10">No attendance records in the active semester.</div> : null}
          </Card>
        </div>

      </div>
    </div>
  );
}

export default MyDashboardPage;
