import React, { useEffect, useMemo, useState } from 'react';
import Table from '../../components/Table.jsx';
import Modal from '../../components/Modal.jsx';
import { apiGet } from '../../services/api.js';
import { attendanceFlagLabel } from '../../utils/attendanceFlags.js';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';

export default function AttendanceAuditPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedLog, setSelectedLog] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [summary, setSummary] = useState({ total: 0, changes: 0, today: 0, teachers: 0, editors: 0 });
  const [actionOptions, setActionOptions] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, page_size: 10, total: 0, total_pages: 1 });
  const [currentPage, setCurrentPage] = useState(1);
  const requestSequence = React.useRef(0);

  // Filters
  const [q, setQ] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [pageSize, setPageSize] = useState(10);
  const [debouncedQ, setDebouncedQ] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setCurrentPage(1);
      setDebouncedQ(q.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [q]);

  const loadAuditRows = React.useCallback(async ({ silent = false } = {}) => {
    const requestId = ++requestSequence.current;
    if (!silent) setLoading(true);
    if (!silent) setError(null);
    try {
      const params = new URLSearchParams({
        report: 'attendance_logs',
        attendance_logs_page: '1',
        page: String(currentPage),
        page_size: String(pageSize),
      });
      if (debouncedQ) params.set('search', debouncedQ);
      if (actionFilter) params.set('action', actionFilter);
      if (startDate) params.set('start_date', startDate);
      if (endDate) params.set('end_date', endDate);
      const res = await apiGet(`reports?${params.toString()}`);
      if (requestId !== requestSequence.current) return;
        // res.rows should be an array of objects with keys like 'Log ID','Teacher','Action',...;
        const raw = res && Array.isArray(res.rows) ? res.rows : [];
        const normalized = raw.map((r) => {
          // build normalized keys to avoid spaces in keys
          const norm = {};
          for (const k in r) {
            const nk = String(k).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
            norm[nk] = r[k];
          }
          return {
            // map common names
            edit_session_id: norm['edit_session_id'] ?? norm['edit_sessionid'] ?? norm['editsessionid'] ?? norm['edit_session'] ?? norm['session_id'] ?? norm['sessionid'] ?? null,
            log_id: norm['log_id'] ?? norm['logid'] ?? null,
            teacher: norm['teacher'] ?? '',
            action: norm['action'] ?? '',
            field: norm['field'] ?? '',
            old_value: norm['old_value'] ?? norm['oldvalue'] ?? '',
            new_value: norm['new_value'] ?? norm['newvalue'] ?? '',
            reason: norm['reason'] ?? '',
            edited_by: norm['edited_by'] ?? norm['editedby'] ?? '',
            public_ipv4: norm['public_ipv4'] ?? '',
            approximate_location: norm['approximate_location'] ?? 'Location unavailable',
            network_provider: norm['network_provider'] ?? '',
            date: norm['date'] ?? norm['edited_at'] ?? norm['editedat'] ?? '',
            // keep original in case
            __raw: r,
          };
        });
      setRows(normalized);
      setSummary({
        total: Number(res?.summary?.total) || 0,
        changes: Number(res?.summary?.changes) || 0,
        today: Number(res?.summary?.today) || 0,
        teachers: Number(res?.summary?.teachers) || 0,
        editors: Number(res?.summary?.editors) || 0,
      });
      setActionOptions(Array.isArray(res?.action_options) ? res.action_options : []);
      const nextPagination = res?.pagination || {};
      setPagination({
        page: Number(nextPagination.page) || 1,
        page_size: Number(nextPagination.page_size) || pageSize,
        total: Number(nextPagination.total) || 0,
        total_pages: Number(nextPagination.total_pages) || 1,
      });
      if (Number(nextPagination.page) > 0 && Number(nextPagination.page) !== currentPage) {
        setCurrentPage(Number(nextPagination.page));
      }
      setLastUpdated(new Date());
    } catch (err) {
      if (requestId !== requestSequence.current) return;
      console.error(err);
      if (!silent) setError(err.message || 'Failed to load');
    } finally {
      if (!silent && requestId === requestSequence.current) setLoading(false);
    }
  }, [actionFilter, currentPage, debouncedQ, endDate, pageSize, startDate]);

  useEffect(() => { loadAuditRows(); }, [loadAuditRows]);

  useAutoRefresh({
    refresh: () => loadAuditRows({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.HEAVY,
  });

  const isFlagField = (field) => {
    const normalized = String(field || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_');

    return normalized.includes('flag') || [
      'check_in',
      'check_in_status',
      'mid_check',
      'mid_check_status',
      'check_out',
      'check_out_status',
    ].includes(normalized);
  };

  const displayField = (field) => {
    const key = String(field || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (key === 'flag_in') return 'Check In';
    if (key === 'flag_mid' || key === 'flag_check') return 'Mid Check';
    if (key === 'flag_out') return 'Check Out';
    return field;
  };

  const formatAuditFlagValue = (field, value) => {
    if (!isFlagField(field)) return value;
    if (value === null || value === undefined || value === '') return value;
    const raw = String(value).trim();
    if (/^\d+$/.test(raw)) return attendanceFlagLabel(Number(raw));
    return attendanceFlagLabel(null, raw);
  };

  const formatAuditReason = (row) => {
    const reason = row?.reason ?? '';
    if (!isFlagField(row?.field) || !reason) return reason;
    return String(reason).replace(/\bN\/A\b|\bNA\b/g, 'Upcoming');
  };

  const actionsList = actionOptions;

  const applyDatePreset = (days) => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - Math.max(0, Number(days || 1) - 1));
    const toKey = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    setCurrentPage(1);
    setStartDate(toKey(start));
    setEndDate(toKey(end));
  };

  const formatDateTime = (value) => {
    if (!value) return 'Not recorded';
    const parsed = new Date(String(value).replace(' ', 'T'));
    if (Number.isNaN(parsed.getTime())) return String(value);
    return parsed.toLocaleString([], {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  };

  const sessionCounts = useMemo(() => {
    const counts = {};
    rows.forEach((row) => {
      const key = String(row.edit_session_id || row.log_id || 'Unassigned');
      counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
  }, [rows]);

  const groupedFiltered = useMemo(() => {
    const groups = new Map();
    rows.forEach((row, index) => {
      const sessionValue = String(row.edit_session_id || '').trim();
      const key = sessionValue ? `session:${sessionValue}` : `log:${row.log_id || index}`;
      if (!groups.has(key)) {
        groups.set(key, { ...row, session_rows: [], group_key: key });
      }
      groups.get(key).session_rows.push(row);
    });
    return Array.from(groups.values());
  }, [rows]);

  const formatActionLabel = (action) => {
    const key = String(action || '').trim().toLowerCase();
    return key === 'approval' ? 'Approved edit' : (action || 'Updated');
  };

  const renderActionBadge = (action) => {
    const key = String(action || '').trim().toLowerCase();
    const style = key.includes('delete') || key.includes('remove')
      ? 'border-red-200 bg-red-50 text-red-700'
      : key.includes('create') || key.includes('add')
        ? 'border-blue-200 bg-blue-50 text-blue-700'
        : 'border-amber-200 bg-amber-50 text-amber-700';
    return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${style}`}>{formatActionLabel(action)}</span>;
  };

  const renderValue = (field, value, tone) => {
    const label = formatAuditFlagValue(field, value) || 'Empty';
    const style = tone === 'old'
      ? 'border-red-100 bg-red-50 text-red-700'
      : 'border-emerald-100 bg-emerald-50 text-emerald-700';
    return <span className={`inline-flex max-w-[150px] rounded-lg border px-2 py-1 text-xs font-semibold ${style}`} title={String(label)}>{label}</span>;
  };

  const renderSessionChanges = (row) => {
    const changes = row.session_rows || [row];
    const first = changes[0];
    const firstOld = formatAuditFlagValue(first?.field, first?.old_value);
    const firstNew = formatAuditFlagValue(first?.field, first?.new_value);
    const canSummarizeCheckpoints = changes.length > 1 && changes.every((change) => (
      isFlagField(change.field)
      && formatAuditFlagValue(change.field, change.old_value) === firstOld
      && formatAuditFlagValue(change.field, change.new_value) === firstNew
    ));

    if (canSummarizeCheckpoints) {
      return (
        <div className="attendance-audit-changes flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500 xl:w-[96px]">{changes.length} Checkpoints</span>
          {renderValue(first.field, first.old_value, 'old')}
          <i className="bi bi-arrow-right text-slate-400"></i>
          {renderValue(first.field, first.new_value, 'new')}
        </div>
      );
    }

    return (
      <div className="attendance-audit-changes grid min-w-0 gap-2">
        {changes.map((change, index) => (
          <div key={`${change.log_id || change.field || 'change'}-${index}`} className="flex flex-wrap items-center gap-2">
            <span className="w-[76px] text-[11px] font-bold uppercase tracking-wide text-slate-500">{displayField(change.field) || 'Field'}</span>
            {renderValue(change.field, change.old_value, 'old')}
            <i className="bi bi-arrow-right text-slate-400"></i>
            {renderValue(change.field, change.new_value, 'new')}
          </div>
        ))}
      </div>
    );
  };

  const columns = [
    { key: 'edit_session_id', label: 'Session', render: (r) => {
      const key = String(r.edit_session_id || r.log_id || 'Unassigned');
      return <div className="attendance-audit-session grid min-w-0 gap-1"><span className="font-bold text-slate-800">#{key}</span><span className="text-[11px] text-slate-500">{r.session_rows?.length || sessionCounts[key] || 1} change(s)</span></div>;
    } },
    { key: 'teacher', label: 'Teacher', render: (r) => <div className="min-w-0"><div className="font-semibold text-slate-800">{r.teacher || 'Unknown teacher'}</div><div className="mt-1 text-xs text-slate-500">Affected account</div></div> },
    { key: 'change', label: 'Changes', render: (r) => renderSessionChanges(r) },
    { key: 'action', label: 'Action', render: (r) => renderActionBadge(r.action) },
    { key: 'reason', label: 'Reason', render: (r) => <div className="whitespace-normal text-slate-600">{formatAuditReason(r) || 'No reason provided'}</div> },
    { key: 'edited_by', label: 'Changed By', render: (r) => <div className="min-w-0 font-semibold text-slate-700">{r.edited_by || 'System'}</div> },
    { key: 'date', label: 'Date and Time', render: (r) => <div className="min-w-0 text-slate-600">{formatDateTime(r.date)}</div> },
    { key: 'actions', label: 'Details', actions: (r) => [{ label: 'View Details', onClick: (row) => setSelectedLog(row) }] },
  ];

  return (
    <div className="p-6">
      <div className="mb-5 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-4 p-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-xl text-emerald-700">
              <i className="bi bi-shield-check"></i>
            </div>
            <div>
              <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">Attendance Adjustment Logs</h2>
              <p className="mt-1 text-sm text-slate-500">Track who changed an attendance record, what was changed, and the reason provided.</p>
            </div>
          </div>

        </div>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Total Adjustments', value: summary.total, note: 'Merged edit sessions', icon: 'bi-pencil-square', tone: 'text-emerald-700 bg-emerald-50' },
          { label: 'Adjustments Today', value: summary.today, note: 'Recorded today', icon: 'bi-calendar-check', tone: 'text-blue-700 bg-blue-50' },
          { label: 'Teachers Affected', value: summary.teachers, note: 'Unique teacher accounts', icon: 'bi-people', tone: 'text-violet-700 bg-violet-50' },
          { label: 'Authorized Editors', value: summary.editors, note: 'Unique users making changes', icon: 'bi-person-check', tone: 'text-amber-700 bg-amber-50' },
        ].map((card) => (
          <div key={card.label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{card.label}</div>
                <div className="mt-2 text-3xl font-bold tracking-tight text-slate-900">{card.value}</div>
                <div className="mt-1 text-xs text-slate-500">{card.note}</div>
              </div>
              <span className={`flex h-11 w-11 items-center justify-center rounded-xl text-lg ${card.tone}`}><i className={`bi ${card.icon}`}></i></span>
            </div>
          </div>
        ))}
      </div>

      <div className="mb-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-4 flex flex-col gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-800">Filter Adjustment Logs</h3>
            <p className="mt-1 text-xs text-slate-500">Search audit activity or limit the records to a specific period.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => applyDatePreset(1)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-emerald-300 hover:text-emerald-700">Today</button>
            <button type="button" onClick={() => applyDatePreset(7)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-emerald-300 hover:text-emerald-700">7 Days</button>
            <button type="button" onClick={() => applyDatePreset(30)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-emerald-300 hover:text-emerald-700">30 Days</button>
          </div>
        </div>

        <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-2 xl:grid-cols-[minmax(260px,1.7fr)_minmax(150px,1fr)_155px_155px_105px_auto]">
          <div className="min-w-0">
            <label className="mb-1 block text-xs font-semibold text-slate-600">Search</label>
            <div className="relative">
              <i className="bi bi-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"></i>
              <input type="search" className="form-control w-full pl-9" placeholder="Teacher, editor, field, value, or reason" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          <div className="min-w-0">
            <label className="mb-1 block text-xs font-semibold text-slate-600">Action</label>
            <select className="form-control w-full" value={actionFilter} onChange={(e) => { setCurrentPage(1); setActionFilter(e.target.value); }}>
              <option value="">All Actions</option>
              {actionsList.map(a => <option key={a} value={a}>{formatActionLabel(a)}</option>)}
            </select>
          </div>
          <div className="min-w-0">
            <label className="mb-1 block text-xs font-semibold text-slate-600">Start Date</label>
            <input type="date" className="form-control w-full" value={startDate} max={endDate || undefined} onChange={(e) => { setCurrentPage(1); setStartDate(e.target.value); }} />
          </div>
          <div className="min-w-0">
            <label className="mb-1 block text-xs font-semibold text-slate-600">End Date</label>
            <input type="date" className="form-control w-full" value={endDate} min={startDate || undefined} onChange={(e) => { setCurrentPage(1); setEndDate(e.target.value); }} />
          </div>
          <div className="min-w-0">
            <label className="mb-1 block text-xs font-semibold text-slate-600">Rows</label>
            <select className="form-control w-full" value={pageSize} onChange={(e) => { setCurrentPage(1); setPageSize(Number(e.target.value)); }}>
              {[10,25,50,100].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <button type="button" className="rounded-lg border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-600 hover:bg-slate-50" onClick={() => { setCurrentPage(1); setQ(''); setActionFilter(''); setStartDate(''); setEndDate(''); }}>
            Clear
          </button>
        </div>
      </div>

      {error && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>}

      <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
        <div className="mb-3 flex items-center justify-between gap-3 px-1">
          <div><h3 className="text-sm font-bold text-slate-800">Applied Adjustment History</h3><p className="mt-1 text-xs text-slate-500">Shows attendance changes that were applied. Rejected requests remain in Attendance Edit Requests. Open Details to see every checkpoint.</p></div>
          <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-bold text-slate-600">{summary.total} session(s) · {summary.changes} change(s)</span>
        </div>
        <Table
          columns={columns}
          data={groupedFiltered}
          pageSize={pageSize}
          serverPagination
          totalItems={pagination.total}
          page={pagination.page}
          onPageChange={setCurrentPage}
          loading={loading}
          emptyText={loading ? 'Loading adjustment logs...' : 'No attendance adjustments match the selected filters.'}
          rowKey={(row, index) => row.group_key || row.log_id || `${row.edit_session_id || 'session'}-${index}`}
          rowClassName="border-l-4 border-l-emerald-500"
          wrapCells
          className="attendance-adjustment-log-table"
        />
      </div>

      <Modal show={Boolean(selectedLog)} title="Attendance Adjustment Details" onClose={() => setSelectedLog(null)} size="lg">
        {selectedLog && (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Edit Session</div><div className="mt-1 text-xl font-bold text-slate-900">#{selectedLog.edit_session_id || selectedLog.log_id || 'Unassigned'}</div><div className="mt-1 text-xs text-slate-500">{selectedLog.session_rows?.length || sessionCounts[String(selectedLog.edit_session_id || selectedLog.log_id || 'Unassigned')] || 1} change(s) recorded in this session</div></div>
              {renderActionBadge(selectedLog.action)}
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-200 p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Teacher Affected</div><div className="mt-2 font-bold text-slate-900">{selectedLog.teacher || 'Unknown teacher'}</div></div>
              <div className="rounded-xl border border-slate-200 p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Changed By</div><div className="mt-2 font-bold text-slate-900">{selectedLog.edited_by || 'System'}</div><div className="mt-1 text-xs text-slate-500">{formatDateTime(selectedLog.date)}</div></div>
            </div>

            <div className="rounded-xl border border-slate-200 p-4">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Changes in This Session</div>
              <div className="mt-3 grid gap-3">{(selectedLog.session_rows || [selectedLog]).map((change, index) => <div key={`${change.log_id || change.field || 'change'}-${index}`} className="flex flex-wrap items-center gap-3 rounded-lg bg-slate-50 px-3 py-2"><span className="w-[90px] text-xs font-bold uppercase tracking-wide text-slate-600">{displayField(change.field) || 'Field'}</span>{renderValue(change.field, change.old_value, 'old')}<i className="bi bi-arrow-right text-lg text-slate-400"></i>{renderValue(change.field, change.new_value, 'new')}</div>)}</div>
            </div>

            <div className="rounded-xl border border-slate-200 p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Reason</div><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{formatAuditReason(selectedLog) || 'No reason was provided for this adjustment.'}</p></div>

            <div className="rounded-xl border border-slate-200 p-4">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Audit Source</div>
              <div className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                <div><div className="text-xs text-slate-500">IP Address</div><code className="mt-1 block font-bold text-emerald-700">{selectedLog.public_ipv4 || 'Unavailable'}</code></div>
                <div><div className="text-xs text-slate-500">Approximate Location</div><div className="mt-1 font-semibold text-slate-700">{selectedLog.approximate_location || 'Location unavailable'}</div></div>
                <div><div className="text-xs text-slate-500">Network Provider</div><div className="mt-1 font-semibold text-slate-700">{selectedLog.network_provider || 'Unavailable'}</div></div>
              </div>
            </div>

            <div className="flex justify-end"><button type="button" onClick={() => setSelectedLog(null)} className="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-700">Close</button></div>
          </div>
        )}
      </Modal>
    </div>
  );
}
