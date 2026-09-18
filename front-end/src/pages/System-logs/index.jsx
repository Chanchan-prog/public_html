import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Table from '../../components/Table.jsx';
import { apiGet } from '../../services/api.js';
import { AuthContext } from '../../context/AuthContext.jsx';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';
import './index.css';

const CATEGORY_STYLES = {
  Security: 'security',
  Settings: 'settings',
  Attendance: 'attendance',
  'User Management': 'users',
  Academic: 'academic',
  Facility: 'facility',
  Other: 'other',
};

const pad = (value) => String(value).padStart(2, '0');
const toDateInput = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const todayInput = () => toDateInput(new Date());
const daysAgoInput = (days) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return toDateInput(date);
};

const titleWords = (value) => String(value || '')
  .replace(/[_-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

const actionCategory = (action) => {
  const value = String(action || '').toLowerCase().replace(/\s+/g, '_');
  if (/(login|logout|password|unlock|lock|auth|session|security|policy|token)/.test(value)) return 'Security';
  if (/(setting|module_access|permission)/.test(value)) return 'Settings';
  if (/(attendance|check_in|check_out|mid_check|schedule_edit|request_edit)/.test(value)) return 'Attendance';
  if (/(user|account|role|profile)/.test(value)) return 'User Management';
  if (/(department|program|section|subject|semester|school_year|offering)/.test(value)) return 'Academic';
  if (/(building|floor|room|school|location|qr)/.test(value)) return 'Facility';
  return 'Other';
};

const parseLogDate = (value) => {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const displayDate = (value) => {
  const date = parseLogDate(value);
  if (!date) return String(value || '-');
  return date.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const relativeDate = (value) => {
  const date = parseLogDate(value);
  if (!date) return '-';
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return displayDate(value);
};

const initials = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'S';
  return `${parts[0][0] || ''}${parts.length > 1 ? parts[parts.length - 1][0] : ''}`.toUpperCase();
};

const detailsText = (value) => {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch (error) { return String(value); }
  }
  const raw = String(value).trim();
  if (!raw) return '-';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.entries(parsed).map(([key, item]) => `${titleWords(key)}: ${Array.isArray(item) ? item.join(', ') : String(item ?? '-')}`).join(', ');
    }
  } catch (error) {
    // Plain-text audit details are expected.
  }
  return raw;
};

const csvValue = (value) => {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

const normalizeSystemLogRows = (rawRows) => (Array.isArray(rawRows) ? rawRows : []).map((row, index) => {
  const norm = {};
  Object.keys(row || {}).forEach((key) => {
    const normalizedKey = String(key).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    norm[normalizedKey] = row[key];
  });
  const userName = String(norm.user || '').trim() || (norm.user_id ? `User #${norm.user_id}` : 'System');
  const action = titleWords(norm.action || 'System activity');
  const ip = String(norm.ip_address || '').trim();
  const publicIpv4 = String(norm.public_ipv4 || '').trim();
  return {
    id: norm.log_id || `${norm.user_id || 'system'}-${norm.occurred_at || norm.created_at || index}-${index}`,
    log_id: norm.log_id || null,
    user_id: norm.user_id || null,
    user_display: userName,
    action,
    category: actionCategory(action),
    details: detailsText(norm.details),
    ip_address: ip === '::1' ? '127.0.0.1' : (ip || '-'),
    public_ipv4: publicIpv4,
    approximate_location: String(norm.approximate_location || 'Location unavailable'),
    network_provider: String(norm.network_provider || ''),
    network_status: String(norm.network_status || 'unavailable'),
    network_information: String(norm.network_information || 'Location unavailable'),
    occurred_at: norm.occurred_at || norm.created_at || '',
    created_at: norm.created_at || norm.occurred_at || '',
  };
});

export default function SystemLogsPage() {
  const { user } = useContext(AuthContext) || {};
  const requestIdRef = useRef(0);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [selectedLogId, setSelectedLogId] = useState(null);
  const [copiedIp, setCopiedIp] = useState('');

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [startDate, setStartDate] = useState(() => daysAgoInput(30));
  const [endDate, setEndDate] = useState(todayInput);
  const [userFilter, setUserFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [ipFilter, setIpFilter] = useState('');
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, page_size: 10, total: 0, total_pages: 1 });
  const [filterOptions, setFilterOptions] = useState({ users: [], categories: [], ips: [] });
  const [summary, setSummary] = useState({ events: 0, users: 0, ips: 0, latest: null });

  const loadSystemLogs = useCallback(async ({ silent = false } = {}) => {
    const requestId = ++requestIdRef.current;
    if (!silent) setLoading(true);
    else setRefreshing(true);
    if (!silent) setError('');
    try {
      const params = new URLSearchParams({
        report: 'system_logs',
        system_logs_page: '1',
        page: String(page),
        page_size: String(pageSize),
      });
      if (startDate) params.set('start_date', startDate);
      if (endDate) params.set('end_date', endDate);
      if (debouncedQuery) params.set('search', debouncedQuery);
      if (userFilter) params.set('user', userFilter);
      if (categoryFilter) params.set('category', categoryFilter);
      if (ipFilter) params.set('public_ipv4', ipFilter);
      const response = await apiGet(`reports?${params.toString()}`);
      if (requestId !== requestIdRef.current) return;
      const nextPagination = response?.pagination || { page: 1, page_size: pageSize, total: 0, total_pages: 1 };
      setRows(normalizeSystemLogRows(response?.rows));
      setPagination(nextPagination);
      setSummary(response?.summary || { events: 0, users: 0, ips: 0, latest: null });
      if (Number(nextPagination.page || 1) !== Number(page)) setPage(Number(nextPagination.page || 1));
      setLastUpdated(new Date());
      setError('');
    } catch (requestError) {
      if (requestId === requestIdRef.current && !silent) setError(requestError?.body?.message || requestError?.message || 'Failed to load audit records.');
    } finally {
      if (requestId === requestIdRef.current) {
        if (!silent) setLoading(false);
        setRefreshing(false);
      }
    }
  }, [startDate, endDate, debouncedQuery, userFilter, categoryFilter, ipFilter, page, pageSize]);

  const loadFilterOptions = useCallback(async () => {
    try {
      const params = new URLSearchParams({ report: 'system_logs', system_logs_page: '1', options_only: '1' });
      if (startDate) params.set('start_date', startDate);
      if (endDate) params.set('end_date', endDate);
      const response = await apiGet(`reports?${params.toString()}`);
      setFilterOptions({
        users: Array.isArray(response?.filter_options?.users) ? response.filter_options.users : [],
        categories: Array.isArray(response?.filter_options?.categories) ? response.filter_options.categories : [],
        ips: Array.isArray(response?.filter_options?.ips) ? response.filter_options.ips : [],
      });
    } catch (optionError) {
      console.error(optionError);
    }
  }, [startDate, endDate]);

  useEffect(() => {
    if (!user) return;
    loadSystemLogs();
  }, [user, loadSystemLogs]);

  useEffect(() => {
    if (!user) return;
    loadFilterOptions();
  }, [user, loadFilterOptions]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setDebouncedQuery(query.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let resetPage = false;
    if (userFilter && !filterOptions.users.includes(userFilter)) { setUserFilter(''); resetPage = true; }
    if (categoryFilter && !filterOptions.categories.includes(categoryFilter)) { setCategoryFilter(''); resetPage = true; }
    if (ipFilter && !filterOptions.ips.includes(ipFilter)) { setIpFilter(''); resetPage = true; }
    if (resetPage) setPage(1);
  }, [filterOptions, userFilter, categoryFilter, ipFilter]);

  useAutoRefresh({
    refresh: () => loadSystemLogs({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.HEAVY,
    enabled: Boolean(user),
  });

  useEffect(() => {
    if (selectedLogId === null) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setSelectedLogId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedLogId]);

  const selectedLog = useMemo(() => rows.find((row) => String(row.id) === String(selectedLogId)) || null, [rows, selectedLogId]);

  const applyPreset = (days) => {
    setPage(1);
    setStartDate(days === 0 ? todayInput() : daysAgoInput(days));
    setEndDate(todayInput());
  };

  const clearFilters = () => {
    setPage(1);
    setQuery('');
    setUserFilter('');
    setCategoryFilter('');
    setIpFilter('');
    setStartDate(daysAgoInput(30));
    setEndDate(todayInput());
  };

  const copyIp = async (ip) => {
    if (!ip || ip === '-') return;
    try {
      await navigator.clipboard.writeText(ip);
      setCopiedIp(ip);
      window.setTimeout(() => setCopiedIp(''), 1500);
    } catch (copyError) {
      window.prompt('Copy IP address:', ip);
    }
  };

  const exportCsv = async () => {
    if (!Number(pagination.total || 0) || exporting) return;
    setExporting(true);
    try {
      const params = new URLSearchParams({ report: 'system_logs', system_logs_page: '1', export_rows: '1' });
      if (startDate) params.set('start_date', startDate);
      if (endDate) params.set('end_date', endDate);
      if (query.trim()) params.set('search', query.trim());
      if (userFilter) params.set('user', userFilter);
      if (categoryFilter) params.set('category', categoryFilter);
      if (ipFilter) params.set('public_ipv4', ipFilter);
      const response = await apiGet(`reports?${params.toString()}`);
      const exportRows = normalizeSystemLogRows(response?.rows);
      if (!exportRows.length) return;
      const headers = ['User', 'Category', 'Action', 'Details', 'Public IPv4', 'Approximate Location', 'Network Provider', 'Recorded Source IP', 'Timestamp'];
      const body = exportRows.map((row) => [row.user_display, row.category, row.action, row.details, row.public_ipv4, row.approximate_location, row.network_provider, row.ip_address, row.occurred_at].map(csvValue).join(','));
      const csv = `\uFEFF${headers.map(csvValue).join(',')}\r\n${body.join('\r\n')}`;
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `audit_trail_${todayInput()}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(exportError?.body?.message || exportError?.message || 'Failed to export audit records.');
    } finally {
      setExporting(false);
    }
  };

  const columns = useMemo(() => [
    {
      key: 'user_display',
      label: 'User',
      render: (row) => <div className="at-user"><span>{initials(row.user_display)}</span><strong>{row.user_display}</strong></div>,
    },
    {
      key: 'action',
      label: 'Action',
      render: (row) => <div className="at-action-cell"><span className={`at-category is-${CATEGORY_STYLES[row.category] || 'other'}`}>{row.category}</span><strong>{row.action}</strong></div>,
    },
    {
      key: 'details',
      label: 'Details',
      render: (row) => <div className="at-details-preview" title={row.details}>{row.details}</div>,
    },
    {
      key: 'network_information',
      label: 'Network Information',
      render: (row) => row.public_ipv4 ? (
        <button type="button" className="at-network-info" onClick={(event) => { event.stopPropagation(); copyIp(row.public_ipv4); }} title="Copy public IPv4 address">
          <span><code>{row.public_ipv4}</code><i className={`bi ${copiedIp === row.public_ipv4 ? 'bi-check2' : 'bi-copy'}`}></i></span>
          <small>{row.approximate_location}</small>
          {row.network_provider && <em>{row.network_provider}</em>}
        </button>
      ) : <span className="at-network-unavailable"><i className="bi bi-geo-alt"></i>Location unavailable</span>,
    },
    {
      key: 'occurred_at',
      label: 'Time',
      render: (row) => <div className="at-time" title={displayDate(row.occurred_at)}><strong>{relativeDate(row.occurred_at)}</strong><small>{displayDate(row.occurred_at)}</small></div>,
    },
  ], [copiedIp]);

  return (
    <div className="audit-trail-page">
      <div className="at-page-head">
        <div>
          <h2>Audit Trail</h2>
          <p>Review authenticated system activity and security-relevant changes.</p>
        </div>
        <div className="at-head-actions">
          <button type="button" className="btn btn-sm btn-outline-success" onClick={() => Promise.all([loadSystemLogs(), loadFilterOptions()])} disabled={loading || refreshing}><i className="bi bi-arrow-repeat me-1"></i>Refresh</button>
          <button type="button" className="btn btn-sm btn-success" onClick={exportCsv} disabled={!Number(pagination.total || 0) || exporting}><i className="bi bi-download me-1"></i>{exporting ? 'Exporting...' : 'Export CSV'}</button>
        </div>
      </div>

      <div className="at-summary-grid">
        <div className="at-summary-card"><span className="is-events"><i className="bi bi-journal-text"></i></span><div><small>Visible Events</small><strong>{summary.events}</strong><em>Matches current filters</em></div></div>
        <div className="at-summary-card"><span className="is-users"><i className="bi bi-people"></i></span><div><small>Unique Users</small><strong>{summary.users}</strong><em>Active in this view</em></div></div>
        <div className="at-summary-card"><span className="is-ips"><i className="bi bi-globe2"></i></span><div><small>Public IPv4 Addresses</small><strong>{summary.ips}</strong><em>Resolved public sources</em></div></div>
        <div className="at-summary-card"><span className="is-latest"><i className="bi bi-clock-history"></i></span><div><small>Latest Activity</small><strong className="is-time-value">{summary.latest ? relativeDate(summary.latest) : '-'}</strong><em>{summary.latest ? displayDate(summary.latest) : 'No activity'}</em></div></div>
      </div>

      <div className="at-filter-card">
        <div className="at-filter-top">
          <div><h5>Filter Activity</h5><p>Narrow the audit records without changing stored data.</p></div>
          <div className="at-presets"><button type="button" onClick={() => applyPreset(0)}>Today</button><button type="button" onClick={() => applyPreset(7)}>7 Days</button><button type="button" onClick={() => applyPreset(30)}>30 Days</button></div>
        </div>
        <div className="at-filter-grid">
          <label className="at-search-field"><span>Search</span><div><i className="bi bi-search"></i><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="User, action, location, or public IP…" /></div></label>
          <label><span>From</span><input type="date" value={startDate} max={endDate || undefined} onChange={(event) => { setPage(1); setStartDate(event.target.value); }} /></label>
          <label><span>To</span><input type="date" value={endDate} min={startDate || undefined} onChange={(event) => { setPage(1); setEndDate(event.target.value); }} /></label>
          <label><span>User</span><select value={userFilter} onChange={(event) => { setPage(1); setUserFilter(event.target.value); }}><option value="">All users</option>{filterOptions.users.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label><span>Category</span><select value={categoryFilter} onChange={(event) => { setPage(1); setCategoryFilter(event.target.value); }}><option value="">All categories</option>{filterOptions.categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label><span>Public IPv4</span><select value={ipFilter} onChange={(event) => { setPage(1); setIpFilter(event.target.value); }}><option value="">All public addresses</option>{filterOptions.ips.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label><span>Rows</span><select value={pageSize} onChange={(event) => { setPage(1); setPageSize(Number(event.target.value)); }}>{[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
          <button type="button" className="at-clear-button" onClick={clearFilters}><i className="bi bi-x-circle"></i>Clear filters</button>
        </div>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}

      <div className="at-table-card">
        <div className="at-table-head"><div><h5>Activity Records</h5><p>Select a row to inspect its complete audit details.</p></div><span>{Number(pagination.total || 0)} record{Number(pagination.total || 0) === 1 ? '' : 's'}</span></div>
        <Table columns={columns} data={rows} pageSize={pageSize} loading={loading} rowKey="id" onRowClick={(row) => setSelectedLogId(row.id)} emptyText={loading ? 'Loading audit records…' : 'No audit records match these filters.'} serverPagination totalItems={Number(pagination.total || 0)} page={page} onPageChange={setPage} />
      </div>

      {selectedLog && (
        <div className="at-drawer-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedLogId(null); }}>
          <div className="at-drawer" role="dialog" aria-modal="true" aria-labelledby="audit-detail-title">
            <div className="at-drawer-head"><div><small>Read-only audit record</small><h3 id="audit-detail-title">Activity Details</h3></div><button type="button" onClick={() => setSelectedLogId(null)} aria-label="Close details"><i className="bi bi-x-lg"></i></button></div>
            <div className="at-drawer-user"><span>{initials(selectedLog.user_display)}</span><div><strong>{selectedLog.user_display}</strong><small>{selectedLog.user_id ? `User ID ${selectedLog.user_id}` : 'System activity'}</small></div></div>
            <div className="at-drawer-fields">
              <div><small>Category</small><span className={`at-category is-${CATEGORY_STYLES[selectedLog.category] || 'other'}`}>{selectedLog.category}</span></div>
              <div><small>Action</small><strong>{selectedLog.action}</strong></div>
              <div className="is-full"><small>Public Network Information</small>{selectedLog.public_ipv4 ? <div className="at-drawer-network"><button type="button" className="at-drawer-ip" onClick={() => copyIp(selectedLog.public_ipv4)}><code>{selectedLog.public_ipv4}</code><i className={`bi ${copiedIp === selectedLog.public_ipv4 ? 'bi-check2' : 'bi-copy'}`}></i></button><strong>{selectedLog.approximate_location}</strong>{selectedLog.network_provider && <span>{selectedLog.network_provider}</span>}</div> : <span className="at-network-unavailable"><i className="bi bi-geo-alt"></i>Location unavailable</span>}</div>
              <div><small>Recorded Source IP</small><code>{selectedLog.ip_address}</code></div>
              <div><small>Exact Timestamp</small><strong>{displayDate(selectedLog.occurred_at)}</strong></div>
              <div className="is-full"><small>Details</small><p>{selectedLog.details}</p></div>
              {selectedLog.log_id && <div><small>Log ID</small><code>#{selectedLog.log_id}</code></div>}
            </div>
            <div className="at-drawer-note"><i className="bi bi-shield-check"></i><span>This record is read-only and cannot be changed from the Audit Trail.</span></div>
          </div>
        </div>
      )}
    </div>
  );
}
