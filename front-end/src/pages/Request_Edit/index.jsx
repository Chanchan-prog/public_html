import React from 'react';
import Modal from '../../components/Modal.jsx';
import { apiGet } from '../../services/api.js';
import { attendanceFlagKey, attendanceFlagLabel } from '../../utils/attendanceFlags.js';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';

export default function RequestEditIndex() {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [attendanceRequests, setAttendanceRequests] = React.useState([]);
  const [viewAttendanceRow, setViewAttendanceRow] = React.useState(null);
  const [hasLoadedRequests, setHasLoadedRequests] = React.useState(false);
  const [statusFilter, setStatusFilter] = React.useState('');
  const [searchFilter, setSearchFilter] = React.useState('');
  const [dateFrom, setDateFrom] = React.useState('');
  const [dateTo, setDateTo] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pagination, setPagination] = React.useState({ page: 1, per_page: 10, total: 0, total_pages: 1 });
  const [stats, setStats] = React.useState({ total: 0, pending: 0, approved: 0, rejected: 0 });
  const handledDeepLinkRef = React.useRef('');
  const loadSequenceRef = React.useRef(0);

  const load = React.useCallback(async ({ silent = false } = {}) => {
    const sequence = ++loadSequenceRef.current;
    if (!silent) setLoading(true);
    if (!silent) setError('');
    try {
      const query = new URLSearchParams({
        scope: 'my',
        paginate: '1',
        page: String(page),
        per_page: '10',
      });
      if (statusFilter) query.set('status', statusFilter);
      if (searchFilter.trim()) query.set('search', searchFilter.trim());
      if (dateFrom) query.set('date_from', dateFrom);
      if (dateTo) query.set('date_to', dateTo);
      const attendanceData = await apiGet(`request-edit/attendance?${query.toString()}`);
      if (sequence !== loadSequenceRef.current) return;
      setAttendanceRequests(Array.isArray(attendanceData?.data) ? attendanceData.data : []);
      setPagination(attendanceData?.pagination || { page: 1, per_page: 10, total: 0, total_pages: 1 });
      setStats(attendanceData?.stats || { total: 0, pending: 0, approved: 0, rejected: 0 });
    } catch (e) {
      if (sequence !== loadSequenceRef.current) return;
      const msg = e?.body?.message || e?.body?.error || e?.message || 'Failed to load requested edits';
      if (!silent) setError(String(msg));
    } finally {
      if (sequence === loadSequenceRef.current) {
        setHasLoadedRequests(true);
        if (!silent) setLoading(false);
      }
    }
  }, [page, statusFilter, searchFilter, dateFrom, dateTo]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => load(), searchFilter.trim() ? 300 : 0);
    return () => window.clearTimeout(timer);
  }, [load, searchFilter]);

  React.useEffect(() => {
    if (!hasLoadedRequests) return;
    const hash = String(window.location.hash || '');
    const queryIndex = hash.indexOf('?');
    if (queryIndex < 0) return;
    const params = new URLSearchParams(hash.slice(queryIndex + 1));
    const requestId = Number(params.get('request_id') || params.get('requestId') || 0);
    if (!requestId) return;

    const deepLinkKey = `attendance:${requestId}`;
    if (handledDeepLinkRef.current === deepLinkKey) return;
    handledDeepLinkRef.current = deepLinkKey;

    const openDeepLinkedRequest = async () => {
      const attendanceRow = attendanceRequests.find((row) => Number(row?.request_id) === requestId);
      if (attendanceRow) {
        setViewAttendanceRow(attendanceRow);
        return;
      }
      try {
        const detail = await apiGet(`request-edit/attendance?scope=my&paginate=1&page=1&per_page=1&request_id=${requestId}`);
        const detailRow = Array.isArray(detail?.data) ? detail.data[0] : null;
        if (detailRow) setViewAttendanceRow(detailRow);
        else setError('The notification opened this page, but the related request could not be found.');
      } catch (deepLinkError) {
        setError(deepLinkError?.body?.message || 'The related request could not be loaded.');
      }
    };
    openDeepLinkedRequest();
  }, [hasLoadedRequests, attendanceRequests]);

  useAutoRefresh({
    refresh: () => load({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.WORKFLOW,
    enabled: !viewAttendanceRow,
  });

  const changeStatusFilter = (status) => {
    setStatusFilter(status);
    setPage(1);
  };

  const clearFilters = () => {
    setStatusFilter('');
    setSearchFilter('');
    setDateFrom('');
    setDateTo('');
    setPage(1);
  };

  const fmt = (dt) => {
    if (!dt) return '-';
    const d = new Date(dt);
    if (Number.isNaN(d.getTime())) return String(dt);
    return d.toLocaleString();
  };

  const statusClass = (status) => {
    const s = String(status || '').toLowerCase();
    if (s === 'approved') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    if (s === 'rejected') return 'bg-red-50 text-red-700 border-red-200';
    return 'bg-amber-50 text-amber-700 border-amber-200';
  };

  const deanMessage = (row) => {
    const status = String(row?.status || '').toLowerCase();
    const explicitNote = String(
      row?.dean_message ||
      row?.decision_note ||
      row?.reviewer_note ||
      row?.approval_note ||
      row?.rejection_note ||
      ''
    ).trim();
    if (explicitNote) return explicitNote;
    if (status !== 'approved') return '-';
    const message = String(row?.attendance_remarks || '').trim();
    return message || '-';
  };

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

  const getFlagLabel = (flagId, flagName) => {
    return attendanceFlagLabel(flagId, flagName);
  };

  const flagBubbleClass = (flagId, flagName) => {
    const key = attendanceFlagKey(flagId, flagName);
    if (key === 'present') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    if (key === 'absent') return 'bg-rose-50 text-rose-700 border-rose-200';
    if (key === 'late') return 'bg-amber-50 text-amber-700 border-amber-200';
    if (key === 'substituted') return 'bg-blue-50 text-blue-700 border-blue-200';
    if (key === 'on_leave') return 'bg-sky-50 text-sky-700 border-sky-200';
    if (key === 'pending') return 'bg-orange-50 text-orange-700 border-orange-200';
    if (key === 'upcoming') return 'bg-slate-50 text-slate-700 border-slate-200';
    return 'bg-slate-50 text-slate-700 border-slate-200';
  };

  const FlagBubble = ({ flagId, flagName, prefix = '' }) => (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-bold ${flagBubbleClass(flagId, flagName)}`}>
      {prefix ? <span className="opacity-80">{prefix}</span> : null}
      <span>{getFlagLabel(flagId, flagName)}</span>
    </span>
  );

  const DetailRow = ({ label, value }) => (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-gray-900 text-right">{value || '-'}</span>
    </div>
  );

  const closeAttendanceView = () => setViewAttendanceRow(null);

  const renderAttendanceTable = () => (
    <React.Fragment>
      <div className="overflow-x-auto">
        <table className="min-w-[980px] w-full text-sm">
        <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left">Requested On</th>
            <th className="px-3 py-2 text-left">Date</th>
            <th className="px-3 py-2 text-left">Subject</th>
            <th className="px-3 py-2 text-left">Section</th>
            <th className="px-3 py-2 text-left">Room</th>
            <th className="px-3 py-2 text-left">My Reason</th>
            <th className="px-3 py-2 text-left">Status</th>
            <th className="px-3 py-2 text-left">Decided By</th>
            <th className="px-3 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {attendanceRequests.length === 0 ? (
            <tr>
              <td className="px-3 py-10 text-center text-gray-500" colSpan={9}>No requests match the selected filters.</td>
            </tr>
          ) : attendanceRequests.map((row) => (
            <tr key={`attendance-${row.request_id}`} className="transition-colors hover:bg-emerald-50/60">
              <td className="px-3 py-2 text-gray-700">{fmt(row.created_at)}</td>
              <td className="px-3 py-2 text-gray-700">{row.attendance_date || '-'}</td>
              <td className="px-3 py-2 text-gray-700 font-semibold">{row.subject_code || '-'}</td>
              <td className="px-3 py-2 text-gray-700">{row.section_name || '-'}</td>
              <td className="px-3 py-2 text-gray-700">{row.room_name || '-'}</td>
              <td className="px-3 py-2 text-gray-700">
                <div className="max-w-xs whitespace-pre-wrap leading-snug">{row.reason || '-'}</div>
              </td>
              <td className="px-3 py-2">
                <span className={`px-2 py-1 rounded-full border text-xs font-bold ${statusClass(row.status)}`}>
                  {row.status || 'pending'}
                </span>
              </td>
              <td className="px-3 py-2 text-gray-700">{row.decided_by_name || '-'}</td>
              <td className="px-3 py-2 text-right">
                <button
                  type="button"
                  onClick={() => setViewAttendanceRow(row)}
                  className="px-3 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 text-xs font-bold hover:bg-emerald-100"
                >
                  View
                </button>
              </td>
            </tr>
          ))}
        </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-3 border-t border-slate-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-center text-xs font-semibold text-slate-500 sm:text-left">
          Page {pagination.page} of {pagination.total_pages} · {pagination.total} matching record{pagination.total === 1 ? '' : 's'}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <button
            type="button"
            disabled={pagination.page <= 1 || loading}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={pagination.page >= pagination.total_pages || loading}
            onClick={() => setPage((current) => Math.min(pagination.total_pages, current + 1))}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </React.Fragment>
  );

  const renderAttendanceModal = () => {
    const message = deanMessage(viewAttendanceRow);
    return (
      <Modal
        show={!!viewAttendanceRow}
        title="Attendance Request Details"
        onClose={closeAttendanceView}
        size="xl"
        footer={(
          <button
            type="button"
            onClick={closeAttendanceView}
            className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 text-sm font-semibold hover:bg-gray-100"
          >
            Close
          </button>
        )}
      >
        {!viewAttendanceRow ? null : (
          <div className="space-y-5">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4">
              <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-wider text-emerald-700 font-bold">Attendance Edit Request</div>
                  <div className="text-xl font-bold text-gray-900 mt-1">{viewAttendanceRow.teacher_name || viewAttendanceRow.requested_by_name || '-'}</div>
                  <div className="text-sm text-gray-600 mt-1">
                    {viewAttendanceRow.subject_code || '-'}{viewAttendanceRow.subject_name ? ` - ${viewAttendanceRow.subject_name}` : ''} | {viewAttendanceRow.section_name || '-'} | {viewAttendanceRow.attendance_date || '-'}
                  </div>
                </div>
                <div className="md:text-right">
                  <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Status</div>
                  <span className={`inline-flex px-3 py-1 rounded-full border text-xs font-bold ${statusClass(viewAttendanceRow.status)}`}>
                    {String(viewAttendanceRow.status || 'pending').toUpperCase()}
                  </span>
                  <div className="text-xs text-gray-500 mt-2">Request #{viewAttendanceRow.request_id || '-'}</div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-gray-500 font-semibold mb-3">Request Context</div>
                <div className="space-y-2">
                  <DetailRow label="Requested On" value={fmt(viewAttendanceRow.created_at)} />
                  <DetailRow label="Requester" value={viewAttendanceRow.requested_by_name} />
                  <DetailRow label="Decided By" value={viewAttendanceRow.decided_by_name} />
                  <DetailRow label="Attendance ID" value={viewAttendanceRow.attendance_id} />
                </div>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-gray-500 font-semibold mb-3">Class Details</div>
                <div className="space-y-2">
                  <DetailRow label="Date" value={viewAttendanceRow.attendance_date} />
                  <DetailRow label="Schedule" value={`${formatTimeAmPm(viewAttendanceRow.schedule_start_time)} - ${formatTimeAmPm(viewAttendanceRow.schedule_end_time)}`} />
                  <DetailRow label="Room" value={viewAttendanceRow.room_name} />
                  <DetailRow label="Subject" value={viewAttendanceRow.subject_code || viewAttendanceRow.subject_name} />
                  <DetailRow label="Section" value={viewAttendanceRow.section_name} />
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="text-xs uppercase tracking-wide text-gray-500 font-semibold mb-3">Attendance Status</div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <div className="text-[11px] uppercase text-gray-500 font-bold">IN</div>
                  <div className="mt-2"><FlagBubble flagId={viewAttendanceRow.flag_in_id} flagName={viewAttendanceRow.flag_in_name} /></div>
                  <div className="text-xs text-gray-500 mt-2">{formatTimeAmPm(viewAttendanceRow.checked_in_at)}</div>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <div className="text-[11px] uppercase text-gray-500 font-bold">MID</div>
                  <div className="mt-2"><FlagBubble flagId={viewAttendanceRow.flag_check_id} flagName={viewAttendanceRow.flag_check_name} /></div>
                  <div className="text-xs text-gray-500 mt-2">{formatTimeAmPm(viewAttendanceRow.checked_mid_at)}</div>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <div className="text-[11px] uppercase text-gray-500 font-bold">OUT</div>
                  <div className="mt-2"><FlagBubble flagId={viewAttendanceRow.flag_out_id} flagName={viewAttendanceRow.flag_out_name} /></div>
                  <div className="text-xs text-gray-500 mt-2">{formatTimeAmPm(viewAttendanceRow.checked_out_at)}</div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4">
              <div className="text-xs uppercase tracking-wide text-amber-700 font-semibold mb-2">My Reason</div>
              <div className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{viewAttendanceRow.reason || '-'}</div>
            </div>

            {message !== '-' ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                <div className="text-xs uppercase tracking-wide text-slate-700 font-semibold mb-2">Reviewer Message</div>
                <div className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{message}</div>
              </div>
            ) : null}
          </div>
        )}
      </Modal>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4 font-sans selection:bg-green-100 md:p-8">
      <div className="relative mb-6 overflow-hidden rounded-2xl bg-[#1D8551] text-white shadow-xl">
        <div className="absolute right-0 top-0 h-64 w-64 translate-x-1/4 -translate-y-1/2 rounded-full bg-white opacity-5 blur-3xl"></div>
        <div className="absolute bottom-0 left-0 h-40 w-40 -translate-x-1/4 translate-y-1/3 rounded-full bg-white opacity-10 blur-2xl"></div>
        <div className="relative z-10 p-5 md:p-7">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-white/90">
              <span className="h-2 w-2 rounded-full bg-white"></span>
              Faculty Portal
            </div>
            <h2 className="mt-1 text-3xl font-extrabold tracking-tight text-white md:text-4xl">My Requested Edits</h2>
            <p className="mt-2 max-w-xl text-sm text-white/85">Track attendance corrections through every review stage.</p>
          </div>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { label: 'Pending', status: 'pending', value: stats.pending, icon: 'bi bi-hourglass-split', tone: 'amber' },
          { label: 'Approved', status: 'approved', value: stats.approved, icon: 'bi bi-check2-circle', tone: 'emerald' },
          { label: 'Rejected', status: 'rejected', value: stats.rejected, icon: 'bi bi-x-circle', tone: 'rose' },
        ].map((item) => {
          const active = statusFilter === item.status;
          const toneClass = item.tone === 'emerald'
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
            : item.tone === 'rose'
              ? 'bg-rose-50 text-rose-700 border-rose-200'
              : 'bg-amber-50 text-amber-700 border-amber-200';
          return (
            <button
              key={item.status}
              type="button"
              onClick={() => changeStatusFilter(active ? '' : item.status)}
              aria-pressed={active}
              className={`flex min-h-[92px] w-full items-center justify-between gap-4 rounded-2xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 ${active ? 'border-emerald-500 ring-2 ring-emerald-200' : 'border-slate-200'}`}
            >
              <div className="min-w-0">
                <div className="text-xs font-extrabold uppercase tracking-wider text-slate-500">{item.label}</div>
                <div className="mt-1 text-2xl font-extrabold text-slate-900">{loading ? '—' : item.value}</div>
                <div className="mt-1 text-xs font-semibold text-slate-500">Tap to {active ? 'clear' : 'filter'} table</div>
              </div>
              <span className={`inline-flex h-11 w-11 flex-none items-center justify-center rounded-xl border text-lg ${toneClass}`}>
                <i className={item.icon}></i>
              </span>
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>
      ) : null}

      <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <label className="sm:col-span-2 xl:col-span-1">
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500">Search</span>
            <div className="relative">
              <i className="bi bi-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"></i>
              <input
                type="search"
                value={searchFilter}
                onChange={(event) => { setSearchFilter(event.target.value); setPage(1); }}
                placeholder="Subject, section, room, reason"
                className="h-11 w-full rounded-xl border border-slate-300 bg-white pl-10 pr-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
              />
            </div>
          </label>
          <label>
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500">Status</span>
            <select
              value={statusFilter}
              onChange={(event) => changeStatusFilter(event.target.value)}
              className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
            >
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </label>
          <label>
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500">Attendance From</span>
            <input
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(event) => { setDateFrom(event.target.value); setPage(1); }}
              className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
            />
          </label>
          <label>
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500">Attendance To</span>
            <input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(event) => { setDateTo(event.target.value); setPage(1); }}
              className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
            />
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={clearFilters}
              disabled={!statusFilter && !searchFilter && !dateFrom && !dateTo}
              className="h-11 w-full rounded-xl border border-slate-300 bg-slate-50 px-4 text-sm font-bold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <i className="bi bi-x-circle mr-2"></i>Clear Filters
            </button>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap gap-2">
            <div className="inline-flex items-center gap-2 rounded-xl border border-emerald-600 bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm">
              <i className="bi bi-calendar2-check"></i>
              Attendance Requests
              <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] text-white">{pagination.total}</span>
            </div>
          </div>
          <div className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600">
            {pagination.total} matching record{pagination.total === 1 ? '' : 's'} · {stats.total} total
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-3 py-16 text-sm font-semibold text-slate-500">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-emerald-600 border-t-transparent"></span>
            Loading requested edits...
          </div>
        ) : (
          renderAttendanceTable()
        )}
      </div>
      {renderAttendanceModal()}
    </div>
  );
}
