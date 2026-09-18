import React from 'react';
import Table from '../../components/Table.jsx';
import Modal from '../../components/Modal.jsx';
import UserStatusBadge from '../../components/UserStatusBadge.jsx';
import { AuthContext } from '../../context/AuthContext.jsx';
import { apiGet, apiPut } from '../../services/api.js';
import { attendanceFlagKey, attendanceFlagLabel } from '../../utils/attendanceFlags.js';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';

export default function AttendanceEditRequestPage() {
  const { user } = React.useContext(AuthContext) || {};
  const canDecide = Number(user?.role_id || 0) === 2;
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('pending');
  const [search, setSearch] = React.useState('');
  const [startDate, setStartDate] = React.useState('');
  const [endDate, setEndDate] = React.useState('');
  const [sortBy, setSortBy] = React.useState('newest');
  const [mobilePage, setMobilePage] = React.useState(1);
  const [actioningId, setActioningId] = React.useState(null);
  const [viewRow, setViewRow] = React.useState(null);
  const [showViewModal, setShowViewModal] = React.useState(false);
  const [targetRequestId, setTargetRequestId] = React.useState(null);
  const triedAllForTargetRef = React.useRef(false);

  const notifyDecisionSuccess = async (decision) => {
    const title = decision === 'approved'
      ? 'Attendance request approved'
      : 'Attendance request rejected';
    if (typeof window !== 'undefined' && window.Swal && typeof window.Swal.fire === 'function') {
      await window.Swal.fire({ icon: 'success', title, timer: 1400, showConfirmButton: false });
      return;
    }
    alert(title);
  };

  const getTargetRequestIdFromHash = () => {
    if (typeof window === 'undefined') return null;
    const hash = String(window.location.hash || '');
    const qPos = hash.indexOf('?');
    if (qPos < 0) return null;
    const params = new URLSearchParams(hash.slice(qPos + 1));
    const idRaw = params.get('request_id') || params.get('requestId');
    const id = Number(idRaw);
    return Number.isInteger(id) && id > 0 ? id : null;
  };

  const clearTargetRequestIdFromHash = () => {
    if (typeof window === 'undefined') return;
    const rawHash = String(window.location.hash || '');
    const hash = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
    const qPos = hash.indexOf('?');
    if (qPos < 0) return;
    const path = hash.slice(0, qPos);
    const params = new URLSearchParams(hash.slice(qPos + 1));
    const hadRequest = params.has('request_id') || params.has('requestId');
    if (!hadRequest) return;
    params.delete('request_id');
    params.delete('requestId');
    const nextQuery = params.toString();
    const nextHash = '#' + path + (nextQuery ? `?${nextQuery}` : '');
    window.history.replaceState(null, '', nextHash);
  };

  const load = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    if (!silent) setError('');
    try {
      const data = await apiGet('request-edit/attendance');
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      const msg = e?.body?.message || e?.body?.error || e?.message || 'Failed to load attendance edit requests';
      if (!silent) setError(String(msg));
    } finally {
      if (!silent) setLoading(false);
    }
  };

  React.useEffect(() => {
    load();
  }, []);

  useAutoRefresh({
    refresh: () => load({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.WORKFLOW,
    enabled: !showViewModal && actioningId === null,
  });

  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const syncTargetFromHash = () => {
      setTargetRequestId(getTargetRequestIdFromHash());
      triedAllForTargetRef.current = false;
    };
    syncTargetFromHash();
    window.addEventListener('hashchange', syncTargetFromHash);
    return () => window.removeEventListener('hashchange', syncTargetFromHash);
  }, []);

  const decide = async (requestId, decision) => {
    const approving = decision === 'approved';
    const confirmation = typeof window !== 'undefined' && window.Swal
      ? await window.Swal.fire({
          title: approving ? 'Approve Attendance Request?' : 'Reject Attendance Request?',
          text: approving ? 'All requested attendance checkpoints will be marked Present.' : 'The request will be rejected and attendance will remain unchanged.',
          icon: approving ? 'warning' : 'question',
          showCancelButton: true,
          confirmButtonText: approving ? 'Approve & Mark All Present' : 'Reject',
          confirmButtonColor: approving ? '#1D8551' : '#dc2626'
        })
      : { isConfirmed: window.confirm(approving ? 'Approve and mark all checkpoints Present?' : 'Reject this attendance request?') };
    if (!confirmation.isConfirmed) return;
    setActioningId(requestId);
    setError('');
    try {
      const payload = { decision };
      await apiPut(`request-edit/attendance/${requestId}`, payload);
      await load();
      await notifyDecisionSuccess(decision);
      closeView();
    } catch (e) {
      const msg = e?.body?.message || e?.body?.error || e?.message || `Failed to ${decision} request`;
      setError(String(msg));
    } finally {
      setActioningId(null);
    }
  };

  const statusClass = (status) => {
    const s = String(status || '').toLowerCase();
    if (s === 'approved') return 'bg-[#e8f5ee] text-[#1D8551] border-[#b7e0c9]';
    if (s === 'rejected') return 'bg-red-50 text-red-700 border-red-200';
    return 'bg-amber-50 text-amber-700 border-amber-200';
  };

  const openView = (row) => {
    setViewRow(row);
    setShowViewModal(true);
  };

  const closeView = () => {
    setShowViewModal(false);
    setViewRow(null);
  };

  React.useEffect(() => {
    if (!targetRequestId || loading) return;
    const matchedRow = rows.find((row) => Number(row?.request_id) === Number(targetRequestId));
    if (matchedRow) {
      openView(matchedRow);
      clearTargetRequestIdFromHash();
      setTargetRequestId(null);
      triedAllForTargetRef.current = false;
      return;
    }
    if (statusFilter !== 'all' && !triedAllForTargetRef.current) {
      triedAllForTargetRef.current = true;
      setStatusFilter('all');
      return;
    }
    if (statusFilter === 'all') {
      setTargetRequestId(null);
      triedAllForTargetRef.current = false;
    }
  }, [targetRequestId, loading, rows, statusFilter]);

  const formatTimeAmPm = (value) => {
    if (value === null || value === undefined || value === '') return '--:--';
    const raw = String(value).trim();
    const m = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (m) {
      let hour = Number(m[1]);
      const minute = m[2];
      if (!Number.isFinite(hour) || hour < 0 || hour > 23) return raw;
      const suffix = hour >= 12 ? 'PM' : 'AM';
      hour = hour % 12 || 12;
      return `${hour}:${minute} ${suffix}`;
    }
    const dt = new Date(raw.includes('T') ? raw : `1970-01-01T${raw}`);
    if (Number.isNaN(dt.getTime())) return raw;
    return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  };

  const parseRequestDate = (value) => {
    if (!value) return null;
    const date = new Date(String(value).replace(' ', 'T'));
    return Number.isNaN(date.getTime()) ? null : date;
  };

  const formatRequestDateTime = (value) => {
    const date = parseRequestDate(value);
    if (!date) return '-';
    return date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  const getWaitingInfo = (row) => {
    if (String(row?.status || '').toLowerCase() !== 'pending') return { label: 'Decision completed', tone: 'normal', hours: 0 };
    const created = parseRequestDate(row?.created_at);
    if (!created) return { label: 'Waiting', tone: 'normal', hours: 0 };
    const hours = Math.max(0, (Date.now() - created.getTime()) / 3600000);
    const days = Math.floor(hours / 24);
    const label = days > 0 ? `Waiting ${days} day${days === 1 ? '' : 's'}` : `Waiting ${Math.max(1, Math.floor(hours))} hour${Math.floor(hours) === 1 ? '' : 's'}`;
    return { label, tone: hours >= 72 ? 'urgent' : (hours >= 24 ? 'warning' : 'normal'), hours };
  };

  const getInitials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();

  const getFlagLabel = (flagId, flagName) => {
    return attendanceFlagLabel(flagId, flagName);
  };

  const flagBubbleClass = (flagId, flagName) => {
    const key = attendanceFlagKey(flagId, flagName);
    if (key === 'present') return 'bg-[#e8f5ee] text-[#1D8551] border-[#b7e0c9]';
    if (key === 'absent') return 'bg-rose-100 text-rose-800 border-rose-300';
    if (key === 'late') return 'bg-amber-100 text-amber-800 border-amber-300';
    if (key === 'substituted') return 'bg-blue-100 text-blue-800 border-blue-300';
    if (key === 'on_leave') return 'bg-sky-100 text-sky-800 border-sky-300';
    if (key === 'pending') return 'bg-orange-100 text-orange-800 border-orange-300';
    if (key === 'upcoming') return 'bg-slate-100 text-slate-700 border-slate-300';
    return 'bg-slate-100 text-slate-700 border-slate-300';
  };

  const FlagBubble = ({ flagId, flagName, prefix = '' }) => (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-bold ${flagBubbleClass(flagId, flagName)}`}>
      {prefix ? <span className="opacity-80">{prefix}</span> : null}
      <span>{getFlagLabel(flagId, flagName)}</span>
    </span>
  );

  const pendingInView = String(viewRow?.status || '').toLowerCase() === 'pending';
  const remarksLabel = pendingInView ? 'Current Attendance Remarks' : 'Reviewer Message';

  const requestCounts = React.useMemo(() => ({
    pending: rows.filter((row) => String(row.status || '').toLowerCase() === 'pending').length,
    approved: rows.filter((row) => String(row.status || '').toLowerCase() === 'approved').length,
    rejected: rows.filter((row) => String(row.status || '').toLowerCase() === 'rejected').length,
    all: rows.length,
  }), [rows]);

  const filteredRows = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      const status = String(row.status || 'pending').toLowerCase();
      if (statusFilter !== 'all' && status !== statusFilter) return false;
      if (startDate && String(row.attendance_date || '') < startDate) return false;
      if (endDate && String(row.attendance_date || '') > endDate) return false;
      if (query) {
        const haystack = [row.teacher_name, row.subject_code, row.subject_name, row.section_name, row.room_name, row.reason, row.requested_by_name]
          .filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
    return filtered.sort((a, b) => {
      const aTime = parseRequestDate(a.created_at)?.getTime() || 0;
      const bTime = parseRequestDate(b.created_at)?.getTime() || 0;
      if (sortBy === 'oldest') return aTime - bTime;
      if (sortBy === 'waiting') {
        const aPending = String(a.status || '').toLowerCase() === 'pending';
        const bPending = String(b.status || '').toLowerCase() === 'pending';
        if (aPending !== bPending) return aPending ? -1 : 1;
        return aTime - bTime;
      }
      return bTime - aTime;
    });
  }, [rows, statusFilter, search, startDate, endDate, sortBy]);

  React.useEffect(() => { setMobilePage(1); }, [statusFilter, search, startDate, endDate, sortBy]);
  const mobilePageSize = 8;
  const mobileTotalPages = Math.max(1, Math.ceil(filteredRows.length / mobilePageSize));
  const mobileRows = filteredRows.slice((mobilePage - 1) * mobilePageSize, mobilePage * mobilePageSize);

  const columns = [
    { key: 'teacher', label: 'Teacher', render: (row) => (
      <div className="flex min-w-[170px] items-center gap-3">
        <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-emerald-100 text-xs font-black text-emerald-700">{getInitials(row.teacher_name)}</div>
        <div className="min-w-0"><div className="font-bold text-slate-800">{row.teacher_name || '-'}</div><UserStatusBadge status={row.teacher_user_status} className="mt-1" /><div className="truncate text-xs text-slate-500">Requested by {row.requested_by_name || '-'}</div></div>
      </div>
    ) },
    { key: 'class', label: 'Class and Schedule', render: (row) => (
      <div className="min-w-[190px]">
        <div className="font-bold text-slate-800">{row.subject_code || '-'}{row.section_name ? ` / ${row.section_name}` : ''}</div>
        <div className="mt-1 text-xs text-slate-500">{row.room_name || 'No room'} · {formatTimeAmPm(row.schedule_start_time)}–{formatTimeAmPm(row.schedule_end_time)}</div>
      </div>
    ) },
    { key: 'date', label: 'Attendance Date', render: (row) => <span className="whitespace-nowrap font-semibold text-slate-700">{row.attendance_date || '-'}</span> },
    {
      key: 'current_status',
      label: 'Current Status',
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          <FlagBubble flagId={row.flag_in_id} flagName={row.flag_in_name} prefix="IN" />
          <FlagBubble flagId={row.flag_check_id} flagName={row.flag_check_name} prefix="MID" />
          <FlagBubble flagId={row.flag_out_id} flagName={row.flag_out_name} prefix="OUT" />
        </div>
      )
    },
    {
      key: 'reason',
      label: 'Reason',
      render: (row) => (
        <div className="max-w-xs whitespace-normal break-words leading-snug">
          {row.reason || '-'}
        </div>
      )
    },
    { key: 'submitted', label: 'Submitted', render: (row) => {
      const waiting = getWaitingInfo(row);
      return <div className="min-w-[145px]"><div className="text-xs font-semibold text-slate-700">{formatRequestDateTime(row.created_at)}</div><div className={`mt-1 text-[11px] font-bold ${waiting.tone === 'urgent' ? 'text-red-600' : waiting.tone === 'warning' ? 'text-amber-600' : 'text-slate-500'}`}>{waiting.label}</div></div>;
    } },
    {
      key: 'status',
      label: 'Status',
      render: (row) => (
        <span className={`px-2 py-1 rounded-full border text-xs font-bold ${statusClass(row.status)}`}>
          {row.status || 'pending'}
        </span>
      )
    },
    {
      key: 'actions',
      label: 'Actions',
      actions: (row) => [{ label: 'View Request', onClick: () => openView(row) }]
    }
  ];

  return (
    <div className="min-h-screen bg-slate-50 p-3 sm:p-4 md:p-8">
      <div className="mb-5 rounded-2xl bg-[#1D8551] px-5 py-5 text-white shadow-md md:px-7 md:py-6">
        <div className="flex items-center">
          <div className="flex min-w-0 items-start gap-4">
            <div className="flex h-12 w-12 flex-none items-center justify-center rounded-2xl border border-white/20 bg-white/15">
              <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l5 5v11a2 2 0 0 1-2 2Z" /></svg>
            </div>
            <div className="min-w-0">
              <div className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-100">Attendance Governance</div>
              <h2 className="mt-1 text-2xl font-black tracking-tight sm:text-3xl">Attendance Review Center</h2>
              <p className="mt-2 max-w-2xl text-sm text-emerald-50/90">Review attendance correction requests from teachers in your department and keep every decision traceable.</p>
            </div>
          </div>
        </div>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[['pending', 'Pending Review', 'Requires a decision'], ['approved', 'Approved', 'Requests accepted'], ['rejected', 'Rejected', 'Requests declined'], ['all', 'Total Requests', 'All review activity']].map(([key, label, help]) => {
          const selected = statusFilter === key;
          const tone = key === 'pending' ? 'border-amber-200 bg-amber-50 text-amber-700' : key === 'approved' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : key === 'rejected' ? 'border-red-200 bg-red-50 text-red-700' : 'border-blue-200 bg-blue-50 text-blue-700';
          return (
            <button key={key} type="button" onClick={() => setStatusFilter(key)} aria-pressed={selected} className={`rounded-2xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${selected ? 'border-emerald-500 ring-2 ring-emerald-100' : 'border-slate-200'}`}>
              <div className={`mb-3 inline-flex h-9 min-w-9 items-center justify-center rounded-xl border px-2 text-xs font-black ${tone}`}>{key === 'pending' ? '!' : key === 'approved' ? '✓' : key === 'rejected' ? '×' : 'ALL'}</div>
              <div className="text-2xl font-black text-slate-900">{requestCounts[key]}</div>
              <div className="mt-1 text-xs font-extrabold uppercase tracking-wide text-slate-600">{label}</div>
              <div className="mt-1 hidden text-xs text-slate-400 sm:block">{help}</div>
            </button>
          );
        })}
      </div>

      <div className="mb-5 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-[minmax(240px,1fr)_170px_170px_190px_auto]">
          <label className="relative col-span-2 lg:col-span-1">
            <span className="sr-only">Search requests</span>
            <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" strokeWidth="2"/><path strokeLinecap="round" strokeWidth="2" d="m20 20-3.5-3.5"/></svg>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search teacher, subject, section, room, or reason" className="h-11 w-full rounded-xl border border-slate-300 pl-10 pr-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" />
          </label>
          <label className="min-w-0 text-[10px] font-extrabold uppercase tracking-wide text-slate-500">From
            <input type="date" value={startDate} max={endDate || undefined} onChange={(event) => setStartDate(event.target.value)} className="mt-1 h-11 w-full min-w-0 rounded-xl border border-slate-300 px-2 text-xs font-semibold normal-case text-slate-700 outline-none focus:border-emerald-500" />
          </label>
          <label className="min-w-0 text-[10px] font-extrabold uppercase tracking-wide text-slate-500">To
            <input type="date" value={endDate} min={startDate || undefined} onChange={(event) => setEndDate(event.target.value)} className="mt-1 h-11 w-full min-w-0 rounded-xl border border-slate-300 px-2 text-xs font-semibold normal-case text-slate-700 outline-none focus:border-emerald-500" />
          </label>
          <label className="col-span-2 min-w-0 text-[10px] font-extrabold uppercase tracking-wide text-slate-500 lg:col-span-1">Sort
            <select value={sortBy} onChange={(event) => setSortBy(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold normal-case text-slate-700 outline-none focus:border-emerald-500">
              <option value="newest">Newest requests</option><option value="oldest">Oldest requests</option><option value="waiting">Waiting longest</option>
            </select>
          </label>
          <button type="button" onClick={() => { setSearch(''); setStartDate(''); setEndDate(''); setSortBy('newest'); }} className="col-span-2 h-11 self-end rounded-xl border border-slate-300 px-4 text-sm font-bold text-slate-600 hover:bg-slate-50 lg:col-span-1">Clear</button>
        </div>
      </div>

      {error ? (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
      ) : null}

      <div className="hidden md:block">
        <Table columns={columns} data={filteredRows} rowKey="request_id" loading={loading} emptyText={loading ? 'Loading...' : 'No requests match the selected review filters.'} pageSize={10} wrapCells rowClassName={(row) => { const waiting = getWaitingInfo(row); return waiting.tone === 'urgent' ? 'bg-red-50/30' : waiting.tone === 'warning' ? 'bg-amber-50/30' : ''; }} />
      </div>

      <div className="space-y-3 md:hidden">
        {!loading && mobileRows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-5 py-12 text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-xl text-emerald-600">✓</div><div className="mt-3 font-bold text-slate-800">Review queue is clear</div><p className="mt-1 text-sm text-slate-500">No requests match the selected filters.</p></div>
        ) : mobileRows.map((row) => {
          const waiting = getWaitingInfo(row);
          return (
            <article key={row.request_id} className={`overflow-hidden rounded-2xl border bg-white shadow-sm ${waiting.tone === 'urgent' ? 'border-red-300' : waiting.tone === 'warning' ? 'border-amber-300' : 'border-slate-200'}`}>
              <div className={`h-1 ${waiting.tone === 'urgent' ? 'bg-red-500' : waiting.tone === 'warning' ? 'bg-amber-400' : 'bg-emerald-500'}`} />
              <div className="p-4">
                <div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-emerald-100 text-xs font-black text-emerald-700">{getInitials(row.teacher_name)}</div><div className="min-w-0"><div className="truncate font-bold text-slate-900">{row.teacher_name || '-'}</div><UserStatusBadge status={row.teacher_user_status} className="mt-1" /><div className="text-xs text-slate-500">{row.attendance_date || '-'}</div></div></div><span className={`flex-none rounded-full border px-2 py-1 text-[10px] font-black uppercase ${statusClass(row.status)}`}>{row.status || 'pending'}</span></div>
                <div className="mt-4 rounded-xl bg-slate-50 p-3"><div className="font-bold text-slate-800">{row.subject_code || '-'}{row.section_name ? ` / ${row.section_name}` : ''}</div><div className="mt-1 text-xs text-slate-500">{row.room_name || 'No room'} · {formatTimeAmPm(row.schedule_start_time)}–{formatTimeAmPm(row.schedule_end_time)}</div></div>
                <div className="mt-3 flex flex-wrap gap-1"><FlagBubble flagId={row.flag_in_id} flagName={row.flag_in_name} prefix="IN" /><FlagBubble flagId={row.flag_check_id} flagName={row.flag_check_name} prefix="MID" /><FlagBubble flagId={row.flag_out_id} flagName={row.flag_out_name} prefix="OUT" /></div>
                <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-slate-600">{row.reason || 'No reason provided.'}</p>
                <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3"><div><div className="text-[10px] font-semibold text-slate-500">{formatRequestDateTime(row.created_at)}</div><div className={`text-[11px] font-bold ${waiting.tone === 'urgent' ? 'text-red-600' : waiting.tone === 'warning' ? 'text-amber-600' : 'text-slate-500'}`}>{waiting.label}</div></div><button type="button" onClick={() => openView(row)} className="rounded-lg bg-[#1D8551] px-3 py-2 text-xs font-bold text-white">View Request</button></div>
              </div>
            </article>
          );
        })}
        {filteredRows.length > mobilePageSize ? <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-2"><button type="button" disabled={mobilePage <= 1} onClick={() => setMobilePage((page) => Math.max(1, page - 1))} className="rounded-lg border px-3 py-2 text-xs font-bold disabled:opacity-40">Previous</button><span className="text-xs font-semibold text-slate-500">Page {mobilePage} of {mobileTotalPages}</span><button type="button" disabled={mobilePage >= mobileTotalPages} onClick={() => setMobilePage((page) => Math.min(mobileTotalPages, page + 1))} className="rounded-lg border px-3 py-2 text-xs font-bold disabled:opacity-40">Next</button></div> : null}
      </div>

      <Modal
        show={showViewModal}
        title="Attendance Edit Request Details"
        onClose={closeView}
        size="xl"
        footer={!viewRow ? null : (
          <>
            <button
              type="button"
              onClick={closeView}
              className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 text-sm font-semibold hover:bg-gray-100"
              disabled={actioningId === viewRow.request_id}
            >
              Close
            </button>
            {canDecide && pendingInView ? (
              <>
                <button
                  type="button"
                  onClick={() => decide(viewRow.request_id, 'rejected')}
                  className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-60"
                  disabled={actioningId === viewRow.request_id}
                >
                  {actioningId === viewRow.request_id ? 'Rejecting...' : 'Reject'}
                </button>
                <button
                  type="button"
                  onClick={() => decide(viewRow.request_id, 'approved')}
                  className="px-4 py-2 rounded-lg bg-[#1D8551] text-white text-sm font-semibold hover:bg-[#176b41] disabled:opacity-60"
                  disabled={actioningId === viewRow.request_id}
                >
                  {actioningId === viewRow.request_id ? 'Approving...' : 'Approve & Mark All Present'}
                </button>
              </>
            ) : null}
          </>
        )}
      >
        {!viewRow ? (
          <div className="text-sm text-gray-600">No request selected.</div>
        ) : (
          <div className="space-y-5">
            <div className="rounded-2xl border border-[#b7e0c9] bg-gradient-to-r from-[#e8f5ee] to-teal-50 px-5 py-4">
              <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-wider text-[#1D8551] font-bold">Attendance Edit Request</div>
                  <div className="text-xl font-bold text-gray-900 mt-1">{viewRow.teacher_name || '-'}</div>
                  <UserStatusBadge status={viewRow.teacher_user_status} className="mt-2" />
                  <div className="text-sm text-gray-600 mt-1">
                    {viewRow.subject_code || '-'}{viewRow.subject_name ? ` - ${viewRow.subject_name}` : ''} | {viewRow.section_name || '-'} | {viewRow.attendance_date || '-'}
                  </div>
                </div>
                <div className="md:text-right">
                  <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Request Status</div>
                  <span className={`inline-flex px-3 py-1 rounded-full border text-xs font-bold ${statusClass(viewRow.status)}`}>
                    {String(viewRow.status || 'pending').toUpperCase()}
                  </span>
                  <div className="text-xs text-gray-500 mt-2">Request #{viewRow.request_id || '-'}</div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
              {[['Requested', true], ['Under Review', true], [String(viewRow.status || 'pending').toLowerCase() === 'pending' ? 'Decision' : String(viewRow.status || '').replace(/^./, (letter) => letter.toUpperCase()), !pendingInView]].map(([label, active], index) => (
                <div key={`${label}-${index}`} className="relative text-center">
                  {index < 2 ? <div className={`absolute left-1/2 top-3 h-0.5 w-full ${active || !pendingInView ? 'bg-emerald-300' : 'bg-slate-200'}`} aria-hidden="true" /> : null}
                  <div className={`relative mx-auto flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-black ${active ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-300 bg-white text-slate-400'}`}>{active ? '✓' : index + 1}</div>
                  <div className={`mt-2 text-[10px] font-extrabold uppercase tracking-wide ${active ? 'text-emerald-700' : 'text-slate-400'}`}>{label}</div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-gray-500 font-semibold mb-3">Request Context</div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between gap-3"><span className="text-gray-500">Requester</span><span className="font-medium text-gray-900 text-right">{viewRow.requested_by_name || '-'}</span></div>
                  <div className="flex justify-between gap-3"><span className="text-gray-500">Decided By</span><span className="font-medium text-gray-900 text-right">{viewRow.decided_by_name || '-'}</span></div>
                  <div className="flex justify-between gap-3"><span className="text-gray-500">Room</span><span className="font-medium text-gray-900 text-right">{viewRow.room_name || '-'}</span></div>
                  <div className="flex justify-between gap-3"><span className="text-gray-500">Schedule</span><span className="font-medium text-gray-900 text-right">{formatTimeAmPm(viewRow.schedule_start_time)} - {formatTimeAmPm(viewRow.schedule_end_time)}</span></div>
                </div>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-gray-500 font-semibold mb-3">Current Flags</div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-center">
                    <div className="text-[11px] uppercase text-gray-500 font-bold">IN</div>
                    <div className="mt-1">
                      <FlagBubble flagId={viewRow.flag_in_id} flagName={viewRow.flag_in_name} />
                    </div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-center">
                    <div className="text-[11px] uppercase text-gray-500 font-bold">MID</div>
                    <div className="mt-1">
                      <FlagBubble flagId={viewRow.flag_check_id} flagName={viewRow.flag_check_name} />
                    </div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-center">
                    <div className="text-[11px] uppercase text-gray-500 font-bold">OUT</div>
                    <div className="mt-1">
                      <FlagBubble flagId={viewRow.flag_out_id} flagName={viewRow.flag_out_name} />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-4">
              <div className="text-xs uppercase tracking-wide text-amber-700 font-semibold mb-2">Teacher Request Reason</div>
              <div className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{viewRow.reason || '-'}</div>
            </div>

            {canDecide && pendingInView ? (
              <div className="rounded-xl border border-[#b7e0c9] bg-[#e8f5ee]/60 p-4">
                <div className="text-xs uppercase tracking-wide text-[#1D8551] font-semibold mb-2">Approval Result</div>
                <div className="flex flex-wrap items-center gap-2">
                  <FlagBubble flagId={2} prefix="IN" />
                  <FlagBubble flagId={2} prefix="MID" />
                  <FlagBubble flagId={2} prefix="OUT" />
                </div>
                <p className="mt-3 text-sm text-gray-700">
                  Approving this request automatically marks all three attendance checkpoints as Present. Statuses cannot be changed manually.
                </p>
              </div>
            ) : null}

            {viewRow.attendance_remarks ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                <div className="text-xs uppercase tracking-wide text-slate-700 font-semibold mb-2">{remarksLabel}</div>
                <div className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{viewRow.attendance_remarks}</div>
              </div>
            ) : null}
          </div>
        )}
      </Modal>
    </div>
  );
}
