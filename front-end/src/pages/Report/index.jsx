import React, { useState, useEffect, useContext, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom';
import Table from '../../components/Table.jsx';
import { AuthContext } from '../../context/AuthContext.jsx';
import { attendanceFlagKey, attendanceFlagLabel } from '../../utils/attendanceFlags.js';
import { canAccessModule } from '../../utils/moduleAccess.js';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';
import { apiFetch } from '../../services/api.js';
import './index.css';

const isReportFlagColumn = (key) => {
  const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return ['flag_in', 'flag_check', 'flag_out', 'check_in_status', 'mid_check_status', 'check_out_status'].includes(normalized);
};

const reportValue = (row, ...keys) => {
  for (const key of keys) {
    if (row && Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  }
  return '';
};

const titleWords = (value) => String(value || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (letter) => letter.toUpperCase());
const reportColumnToken = (column) => String(column?.label || column?.key || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
const isTeacherIdentityColumn = (column) => /(^|_)(teacher|instructor|faculty)(_|$)/.test(reportColumnToken(column));
const isDateIdentityColumn = (column) => ['date', 'attendance_date', 'class_date'].includes(reportColumnToken(column));
const readReportCell = (row, key) => {
  if (row && Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  const normalizedKey = String(key || '').trim().toLowerCase();
  const foundKey = Object.keys(row || {}).find((candidate) => String(candidate || '').trim().toLowerCase() === normalizedKey);
  return foundKey ? row[foundKey] : '';
};

const reportColumnLabel = (value) => {
  const key = String(value || '').toLowerCase();
  if (key === 'ip_address') return 'IP Address';
  if (key === 'created_at') return 'Date & Time';
  return titleWords(value);
};

const ReportNetworkInformation = ({ row }) => {
  const publicIpv4 = String(reportValue(row, 'Public IPv4', 'public_ipv4') || '').trim();
  const location = String(reportValue(row, 'Approximate Location', 'approximate_location') || 'Location unavailable').trim();
  const provider = String(reportValue(row, 'Network Provider', 'network_provider') || '').trim();
  if (!publicIpv4) return <span className="rp-network-unavailable"><i className="bi bi-geo-alt"></i>Location unavailable</span>;
  return <div className="rp-network-information"><code>{publicIpv4}</code><span>{location}</span>{provider && <small>{provider}</small>}</div>;
};

const ATTENDANCE_STATUS_VISUALS = {
  present: { tone: 'success', color: '#16a34a' },
  late: { tone: 'warning', color: '#f59e0b' },
  absent: { tone: 'danger', color: '#dc2626' },
  incomplete: { tone: 'incomplete', color: '#8b5cf6' },
  pending: { tone: 'pending', color: '#f97316' },
  upcoming: { tone: 'upcoming', color: '#64748b' },
  substituted: { tone: 'substituted', color: '#4f46e5' },
  on_leave: { tone: 'leave', color: '#0891b2' },
};

const attendanceStatusVisual = (value) => {
  const key = attendanceFlagKey(null, String(value || '').toLowerCase());
  return { key, ...(ATTENDANCE_STATUS_VISUALS[key] || { tone: 'muted', color: '#64748b' }) };
};

const formatReportTimestamp = (value) => {
  if (!value) return '—';
  const raw = String(value).trim();
  const parsed = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const reportStatusTone = (value) => {
  const normalized = String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (['covered', 'fully covered', 'recorded', 'confirmed', 'assigned'].includes(normalized)) return 'success';
  if (['partially covered', 'pending', 'not assigned'].includes(normalized)) return 'warning';
  if (['uncovered', 'voided', 'canceled', 'rejected'].includes(normalized)) return 'danger';
  if (normalized === 'no classes') return 'muted';
  return attendanceStatusVisual(value).tone;
};

const isReportFlagField = (value) => {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return normalized.includes('flag') || [
    'check_in',
    'check_in_status',
    'mid_check',
    'mid_check_status',
    'check_out',
    'check_out_status',
  ].includes(normalized);
};

const normalizeReportFlagValue = (value) => {
  if (value === null || value === undefined || value === '') return value;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return attendanceFlagLabel(Number(raw));
  return attendanceFlagLabel(null, raw);
};

const normalizeReportFlagReason = (value, field) => {
  if (!isReportFlagField(field) || !value) return value;
  return String(value).replace(/\bN\/A\b|\bNA\b/g, 'Upcoming');
};

const overallAttendanceStatus = (row) => {
  const statuses = [
    reportValue(row, 'Check In Status', 'Flag In'),
    reportValue(row, 'Mid Check Status', 'Flag Check'),
    reportValue(row, 'Check Out Status', 'Flag Out'),
  ].map((value) => attendanceFlagKey(null, String(value || '').toLowerCase()));
  const counts = statuses.reduce((result, status) => ({ ...result, [status]: (result[status] || 0) + 1 }), {});
  const [winningStatus, winningCount] = Object.entries(counts).sort((left, right) => right[1] - left[1])[0] || ['', 0];
  if (winningCount < 2) return 'Partial Attendance';

  const labels = {
    present: 'Present', late: 'Late', absent: 'Absent', pending: 'Pending',
    upcoming: 'Upcoming', substituted: 'Substituted', on_leave: 'On Leave', unknown: 'Pending',
  };
  return labels[winningStatus] || titleWords(winningStatus);
};

const normalizeReportRow = (row, reportType) => {
  const next = { ...(row || {}) };

  Object.keys(next).forEach((key) => {
    const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (normalized === 'ip_address') {
      const value = String(next[key] ?? '').trim();
      next[key] = value === '::1' ? '127.0.0.1' : (value || '-');
    }
  });

  if (reportType === 'attendance_records' || reportType === 'my_attendance_records') {
    Object.keys(next).forEach((key) => {
      if (isReportFlagColumn(key)) next[key] = normalizeReportFlagValue(next[key]);
    });
    if (!next['Overall Status']) next['Overall Status'] = overallAttendanceStatus(next);
  }

  if (reportType === 'attendance_logs') {
    const field = next.Field ?? next.field ?? '';
    Object.keys(next).forEach((key) => {
      const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
      if (isReportFlagField(field) && (normalized === 'old_value' || normalized === 'new_value')) {
        next[key] = normalizeReportFlagValue(next[key]);
      }
      if (normalized === 'reason') {
        next[key] = normalizeReportFlagReason(next[key], field);
      }
    });
  }

  return next;
};

// --- D3 CHART COMPONENTS ---

// 1. Donut Chart Component (Uses D3.js)
const DonutChart = ({ data, colors, title, colorForLabel }) => {
  const svgRef = useRef(null);

  useEffect(() => {
    if (!window.d3 || !svgRef.current || !data) return;
    const d3 = window.d3;

    // Clear previous
    d3.select(svgRef.current).selectAll("*").remove();

    const width = 200, height = 200, margin = 20;
    const radius = Math.min(width, height) / 2 - margin;

    const svg = d3.select(svgRef.current)
      .attr("width", width)
      .attr("height", height)
      .append("g")
      .attr("transform", `translate(${width / 2},${height / 2})`);

    // Compute position of each group on the pie
    const pie = d3.pie().value(d => d.value).sort(null);
    const data_ready = pie(data);

    // Shape helper
    const arc = d3.arc().innerRadius(radius * 0.5).outerRadius(radius * 0.8);
    const arcHover = d3.arc().innerRadius(radius * 0.5).outerRadius(radius * 0.9);

    // Draw arcs
    svg.selectAll('allSlices')
      .data(data_ready)
      .enter()
      .append('path')
      .attr('d', arc)
      .attr('fill', (d, i) => colorForLabel ? colorForLabel(d.data.label) : colors[i % colors.length])
      .attr("stroke", "white")
      .style("stroke-width", "2px")
      .style("opacity", 0.9)
      .on("mouseover", function(event, d) {
         d3.select(this).transition().duration(200).attr('d', arcHover).style("opacity", 1);
         // Add center text
         svg.append("text")
            .attr("class", "center-text")
            .attr("text-anchor", "middle")
            .attr("dy", "-0.2em")
            .style("font-size", "12px")
            .style("font-weight", "bold")
            .style("fill", "#555")
            .text(d.data.label);
         svg.append("text")
            .attr("class", "center-text")
            .attr("text-anchor", "middle")
            .attr("dy", "1em")
            .style("font-size", "14px")
            .style("fill", "#888")
            .text(d.data.value);
      })
      .on("mouseout", function() {
         d3.select(this).transition().duration(200).attr('d', arc);
         svg.selectAll(".center-text").remove();
      });

  }, [data, colors, colorForLabel]);

  return (
    <div className="flex flex-col items-center justify-center h-full">
      <h4 className="text-xs font-bold text-gray-500 uppercase mb-2">{title}</h4>
      <svg ref={svgRef}></svg>
      {/* Legend */}
      <div className="flex flex-wrap justify-center gap-2 mt-2">
        {data.map((d, i) => (
          <div key={i} className="flex items-center text-xs text-gray-600">
            <span className="w-2 h-2 rounded-full mr-1" style={{backgroundColor: colorForLabel ? colorForLabel(d.label) : colors[i % colors.length]}}></span>
            {d.label} ({d.value})
          </div>
        ))}
      </div>
    </div>
  );
};

// 2. Bar Chart Component (Uses D3.js)
const BarChart = ({ data, color, title }) => {
  const svgRef = useRef(null);

  useEffect(() => {
    if (!window.d3 || !svgRef.current || !data) return;
    const d3 = window.d3;

    // Clear previous
    d3.select(svgRef.current).selectAll("*").remove();

    // Set dimensions
    const margin = { top: 10, right: 10, bottom: 40, left: 30 };
    const containerWidth = svgRef.current.parentElement.clientWidth || 300;
    const width = containerWidth - margin.left - margin.right;
    const height = 180 - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current)
      .attr("width", width + margin.left + margin.right)
      .attr("height", height + margin.top + margin.bottom)
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    // X axis
    const x = d3.scaleBand()
      .range([0, width])
      .domain(data.map(d => d.label))
      .padding(0.3);
    
    svg.append("g")
      .attr("transform", `translate(0,${height})`)
      .call(d3.axisBottom(x).tickSize(0))
      .selectAll("text")
        .attr("transform", "translate(-10,0)rotate(-45)")
        .style("text-anchor", "end")
        .style("font-size", "10px")
        .style("fill", "#888");

    // Y axis
    const y = d3.scaleLinear()
      .domain([0, d3.max(data, d => d.value) || 10])
      .range([height, 0]);
    
    svg.append("g")
      .call(d3.axisLeft(y).ticks(5).tickSize(-width)) // grid lines
      .call(g => g.select(".domain").remove()) // hide axis line
      .selectAll("line")
      .attr("stroke", "#eee"); // lighter grid

    // Bars
    svg.selectAll("mybar")
      .data(data)
      .enter()
      .append("rect")
        .attr("x", d => x(d.label))
        .attr("y", d => y(d.value))
        .attr("width", x.bandwidth())
        .attr("height", d => height - y(d.value))
        .attr("fill", color)
        .attr("rx", 3) // rounded corners
        .on("mouseover", function() { d3.select(this).attr("opacity", 0.7); })
        .on("mouseout", function() { d3.select(this).attr("opacity", 1); });

  }, [data, color]);

  return (
    <div className="flex flex-col items-center justify-center h-full w-full">
      <h4 className="text-xs font-bold text-gray-500 uppercase mb-2">{title}</h4>
      <svg ref={svgRef}></svg>
    </div>
  );
};

const AttendanceStatusBadge = ({ value }) => {
  const label = value ? normalizeReportFlagValue(value) : '—';
  const visual = attendanceStatusVisual(label);
  return <span className={`rp-status is-${visual.tone} is-status-${visual.key}`}>{label || '—'}</span>;
};

const GenericReportStatusBadge = ({ value }) => {
  const label = String(value || '—');
  const normalized = label.toLowerCase();
  const attendanceVisual = attendanceStatusVisual(label);
  const isAttendanceStatus = Object.prototype.hasOwnProperty.call(ATTENDANCE_STATUS_VISUALS, attendanceVisual.key);
  const tone = isAttendanceStatus
    ? attendanceVisual.tone
    : /(uncovered|voided|canceled|denied|rejected|absent|alert|failed|inactive)/.test(normalized)
      ? 'danger'
      : /(partially covered|partial attendance|pending|watch|late|waiting|incomplete|not assigned)/.test(normalized)
        ? 'warning'
        : /(fully covered|^covered$|recorded|confirmed|assigned|approved|present|success|ready|\bok\b|active)/.test(normalized)
      ? 'success'
          : /(leave|substitut)/.test(normalized) ? 'info' : 'muted';
  const semanticClass = isAttendanceStatus ? ` is-status-${attendanceVisual.key}` : '';
  return <span className={`rp-status is-${tone}${semanticClass}`}>{label}</span>;
};

function ReportMobilePagination({ page, pages, total, pageSize, onPageChange }) {
  if (pages <= 1) return null;
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total);
  return (
    <div className="rp-mobile-pagination" aria-label="Report pagination">
      <span>{start}–{end} of {total}</span>
      <div>
        <button type="button" disabled={page === 1} onClick={() => onPageChange(Math.max(1, page - 1))} aria-label="Previous page"><i className="bi bi-chevron-left" /></button>
        <strong>{page} / {pages}</strong>
        <button type="button" disabled={page === pages} onClick={() => onPageChange(Math.min(pages, page + 1))} aria-label="Next page"><i className="bi bi-chevron-right" /></button>
      </div>
    </div>
  );
}

function useReportMobileLayout() {
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767.98px)').matches);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const media = window.matchMedia('(max-width: 767.98px)');
    const update = () => setIsMobile(media.matches);
    update();
    if (media.addEventListener) media.addEventListener('change', update);
    else media.addListener(update);
    return () => {
      if (media.removeEventListener) media.removeEventListener('change', update);
      else media.removeListener(update);
    };
  }, []);
  return isMobile;
}

function MobileReportCards({ rows, columns, loading, onRowClick, emptyText, serverPagination = null, onPageChange = null }) {
  const [internalPage, setInternalPage] = useState(1);
  const pageSize = Number(serverPagination?.page_size || 5);
  const total = serverPagination ? Number(serverPagination.total || 0) : rows.length;
  const pages = serverPagination ? Math.max(1, Number(serverPagination.total_pages || 1)) : Math.max(1, Math.ceil(total / pageSize));
  const requestedPage = serverPagination ? Number(serverPagination.page || 1) : internalPage;
  const safePage = Math.min(requestedPage, pages);
  const visible = useMemo(() => serverPagination ? rows : rows.slice((safePage - 1) * pageSize, safePage * pageSize), [rows, safePage, pageSize, serverPagination]);
  const setPage = (nextPage) => {
    if (serverPagination) {
      if (onPageChange) onPageChange(nextPage);
    } else setInternalPage(nextPage);
  };
  const usableColumns = useMemo(() => columns.filter((column) => !['#', 'actions'].includes(String(column.key || '').toLowerCase())), [columns]);
  const primaryColumn = usableColumns.find((column) => /(teacher|instructor|faculty|user|name|room)/i.test(String(column.label || column.key)))
    || usableColumns.find((column) => !/status/i.test(String(column.label || column.key)))
    || usableColumns[0];
  const statusColumn = usableColumns.find((column) => /status/i.test(String(column.label || column.key)));
  const detailColumns = usableColumns.filter((column) => column !== primaryColumn && column !== statusColumn).slice(0, 4);

  useEffect(() => {
    if (!serverPagination && internalPage > pages) setInternalPage(pages);
  }, [internalPage, pages, serverPagination]);

  const renderColumnValue = (column, row, index) => {
    if (!column) return '—';
    if (column.render) return column.render.length === 1 ? column.render(row) : column.render(row, index, (safePage - 1) * pageSize + index);
    const value = readReportCell(row, column.key);
    return value === '' || value === null || value === undefined ? '—' : String(value);
  };

  return (
    <div className="rp-mobile-report-list">
      {loading ? (
        <div className="rp-mobile-list-state"><span className="spinner-border spinner-border-sm text-success" />Loading report…</div>
      ) : visible.length ? visible.map((row, index) => {
        const recordNumber = (safePage - 1) * pageSize + index + 1;
        const primaryValue = primaryColumn ? readReportCell(row, primaryColumn.key) : '';
        const primaryLabel = primaryValue === '' || primaryValue === null || primaryValue === undefined
          ? `Report record ${recordNumber}`
          : String(primaryValue);
        const statusValue = statusColumn ? readReportCell(row, statusColumn.key) : '';
        return (
          <article className="rp-mobile-report-card" key={row.log_id || row._teacherId || row._leave_id || row['#'] || recordNumber} role="button" tabIndex="0" onClick={() => onRowClick(row)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onRowClick(row); } }} aria-label={`Open report record ${recordNumber}`}>
            <span className="rp-mobile-report-card-head">
              <span><small>Record {recordNumber}</small><strong>{primaryLabel}</strong>{primaryColumn ? <em>{primaryColumn.label}</em> : null}</span>
              {statusColumn ? <GenericReportStatusBadge value={statusValue} /> : <i className="bi bi-chevron-right" aria-hidden="true" />}
            </span>
            {detailColumns.length ? <div className="rp-mobile-report-fields">{detailColumns.map((column) => <div key={column.key || column.label}><small>{column.label}</small><div className="rp-mobile-report-field-value">{renderColumnValue(column, row, index)}</div></div>)}</div> : null}
            <span className="rp-mobile-report-open"><i className="bi bi-eye" aria-hidden="true" />View all fields</span>
          </article>
        );
      }) : <div className="rp-mobile-list-state">{emptyText}</div>}
      <ReportMobilePagination page={safePage} pages={pages} total={total} pageSize={pageSize} onPageChange={setPage} />
    </div>
  );
}

function GroupedAttendanceTable({ rows, loading, onRowClick, serverPagination = null, onPageChange = null }) {
  const [internalPage, setInternalPage] = useState(1);
  const isMobile = useReportMobileLayout();
  const pageSize = Number(serverPagination?.page_size || (isMobile ? 5 : 15));
  const total = serverPagination ? Number(serverPagination.total || 0) : rows.length;
  const pages = serverPagination ? Math.max(1, Number(serverPagination.total_pages || 1)) : Math.max(1, Math.ceil(total / pageSize));
  const requestedPage = serverPagination ? Number(serverPagination.page || 1) : internalPage;
  const safePage = Math.min(requestedPage, pages);
  const visible = useMemo(() => serverPagination ? rows : rows.slice((safePage - 1) * pageSize, safePage * pageSize), [rows, safePage, pageSize, serverPagination]);
  const setPage = (nextPage) => {
    if (serverPagination) {
      if (onPageChange) onPageChange(nextPage);
    } else setInternalPage(nextPage);
  };

  useEffect(() => {
    if (!serverPagination && internalPage > pages) setInternalPage(pages);
  }, [internalPage, pages, serverPagination]);

  const status = (row, current, legacy) => reportValue(row, current, legacy);
  const timestamp = (row, current, legacy) => formatReportTimestamp(reportValue(row, current, legacy));

  return (
    <div className="rp-grouped-table-wrap">
      <table className="rp-grouped-table rp-desktop-attendance-table">
        <colgroup>
          <col className="rp-col-number" />
          <col className="rp-col-teacher" />
          <col className="rp-col-schedule" />
          <col className="rp-col-room" />
          <col className="rp-col-date" />
          <col className="rp-col-scheduled-time" />
          <col className="rp-col-status" /><col className="rp-col-time" />
          <col className="rp-col-status" /><col className="rp-col-time" />
          <col className="rp-col-status" /><col className="rp-col-time" />
          <col className="rp-col-overall" />
        </colgroup>
        <thead>
          <tr>
            {['#', 'Teacher', 'Schedule', 'Room', 'Date', 'Scheduled Time'].map((label) => <th key={label} rowSpan="2">{label}</th>)}
            <th colSpan="2" className="is-stage">Check In</th>
            <th colSpan="2" className="is-stage">Mid Check</th>
            <th colSpan="2" className="is-stage">Check Out</th>
            <th rowSpan="2" className="is-stage">Overall Status</th>
          </tr>
          <tr>
            <th>Status</th><th>Timestamp</th>
            <th>Status</th><th>Timestamp</th>
            <th>Status</th><th>Timestamp</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan="13" className="rp-table-empty"><span className="spinner-border spinner-border-sm text-success me-2"></span>Loading attendance records…</td></tr>
          ) : visible.length ? visible.map((row, index) => (
            <tr key={reportValue(row, 'attendance_id') || `${safePage}-${index}`} tabIndex="0" onClick={() => onRowClick(row)} onKeyDown={(event) => { if (event.key === 'Enter') onRowClick(row); }}>
              <td>{reportValue(row, '#') || (safePage - 1) * pageSize + index + 1}</td>
              <td className="rp-strong-cell">{reportValue(row, 'Teacher') || '—'}</td>
              <td>{reportValue(row, 'Schedule') || '—'}</td>
              <td>{reportValue(row, 'Room') || '—'}</td>
              <td>{reportValue(row, 'Date') || '—'}</td>
              <td className="rp-scheduled-time-cell">{reportValue(row, 'Scheduled Time') || '—'}</td>
              <td><AttendanceStatusBadge value={status(row, 'Check In Status', 'Flag In')} /></td>
              <td className="rp-time-cell">{timestamp(row, 'Check In Timestamp', 'Checked In')}</td>
              <td><AttendanceStatusBadge value={status(row, 'Mid Check Status', 'Flag Check')} /></td>
              <td className="rp-time-cell">{timestamp(row, 'Mid Check Timestamp', 'Checked Mid')}</td>
              <td><AttendanceStatusBadge value={status(row, 'Check Out Status', 'Flag Out')} /></td>
              <td className="rp-time-cell">{timestamp(row, 'Check Out Timestamp', 'Checked Out')}</td>
              <td><AttendanceStatusBadge value={reportValue(row, 'Overall Status') || overallAttendanceStatus(row)} /></td>
            </tr>
          )) : <tr><td colSpan="13" className="rp-table-empty">No attendance records match these filters.</td></tr>}
        </tbody>
      </table>
      <div className="rp-mobile-attendance-list">
        {loading ? (
          <div className="rp-mobile-list-state"><span className="spinner-border spinner-border-sm text-success" />Loading attendance records…</div>
        ) : visible.length ? visible.map((row, index) => {
          const recordNumber = reportValue(row, '#') || (safePage - 1) * pageSize + index + 1;
          const stages = [
            { label: 'Check In', status: status(row, 'Check In Status', 'Flag In'), timestamp: timestamp(row, 'Check In Timestamp', 'Checked In') },
            { label: 'Mid Check', status: status(row, 'Mid Check Status', 'Flag Check'), timestamp: timestamp(row, 'Mid Check Timestamp', 'Checked Mid') },
            { label: 'Check Out', status: status(row, 'Check Out Status', 'Flag Out'), timestamp: timestamp(row, 'Check Out Timestamp', 'Checked Out') },
          ];
          return (
            <article className="rp-mobile-attendance-card" key={reportValue(row, 'attendance_id') || `${safePage}-${index}`} role="button" tabIndex="0" onClick={() => onRowClick(row)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onRowClick(row); } }} aria-label={`Open attendance record ${recordNumber}`}>
              <span className="rp-mobile-attendance-head">
                <span><small>Record {recordNumber}</small><strong>{reportValue(row, 'Teacher') || 'Unknown teacher'}</strong></span>
                <AttendanceStatusBadge value={reportValue(row, 'Overall Status') || overallAttendanceStatus(row)} />
              </span>
              <span className="rp-mobile-attendance-meta">
                <span><i className="bi bi-calendar3" aria-hidden="true" />{reportValue(row, 'Date') || 'No date'}</span>
                <span><i className="bi bi-clock" aria-hidden="true" />{reportValue(row, 'Scheduled Time') || 'No scheduled time'}</span>
                <span><i className="bi bi-journal-text" aria-hidden="true" />{reportValue(row, 'Schedule') || 'No schedule'}</span>
                <span><i className="bi bi-door-open" aria-hidden="true" />{reportValue(row, 'Room') || 'No room'}</span>
              </span>
              <span className="rp-mobile-attendance-stages">
                {stages.map((stage) => <span key={stage.label}><small>{stage.label}</small><AttendanceStatusBadge value={stage.status} /><em>{stage.timestamp}</em></span>)}
              </span>
              <span className="rp-mobile-report-open"><i className="bi bi-eye" aria-hidden="true" />View complete record</span>
            </article>
          );
        }) : <div className="rp-mobile-list-state">No attendance records match these filters.</div>}
      </div>
      {pages > 1 && (
        <div className="rp-table-pagination rp-desktop-attendance-pagination">
          <span>Showing {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, total)} of {total}</span>
          <div><button type="button" disabled={safePage === 1} onClick={() => setPage(Math.max(1, safePage - 1))}>Previous</button><strong>{safePage} / {pages}</strong><button type="button" disabled={safePage === pages} onClick={() => setPage(Math.min(pages, safePage + 1))}>Next</button></div>
        </div>
      )}
      <ReportMobilePagination page={safePage} pages={pages} total={total} pageSize={pageSize} onPageChange={setPage} />
    </div>
  );
}

function ReportDetailsDrawer({ row, columns, onClose }) {
  useEffect(() => {
    if (!row) return undefined;
    const closeOnEscape = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [row, onClose]);

  if (!row) return null;
  return (
    <div className="rp-drawer-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="rp-drawer" role="dialog" aria-modal="true" aria-labelledby="rp-detail-title">
        <div className="rp-drawer-head"><div><small>Read-only report record</small><h3 id="rp-detail-title">Record Details</h3></div><button type="button" onClick={onClose} aria-label="Close details"><i className="bi bi-x-lg"></i></button></div>
        <div className="rp-drawer-grid">
          {columns.map((column) => {
            const value = reportValue(row, column.key);
            const isTimestamp = /timestamp|checked in|checked mid|checked out/i.test(String(column.label));
            const isStatus = /status/i.test(String(column.label));
            return <div key={column.key} className={String(column.label).toLowerCase() === 'details' ? 'is-wide' : ''}><small>{column.label}</small>{isStatus ? <GenericReportStatusBadge value={value} /> : <span>{isTimestamp ? formatReportTimestamp(value) : (value === '' || value === null || value === undefined ? '—' : String(value))}</span>}</div>;
          })}
        </div>
        <div className="rp-drawer-note"><i className="bi bi-shield-check"></i>This report record is read-only.</div>
      </div>
    </div>
  );
}


// --- MAIN PAGE COMPONENT ---

export default function ReportsPage() {
  // FIX: Properly get user from context
  const { user } = useContext(AuthContext) || {};
  const isMobileLayout = useReportMobileLayout();

  // FIX: Identify User Role and Department
  const roleId = Number(user?.role_id || 0);
  const isAdmin = roleId === 1;
  const isDean = roleId === 2;
  const isProgramHead = roleId === 3;
  const isSecretary = roleId === 4;
  const isTeacher = roleId === 5;
  const isDepartmentAdmin = roleId === 6;
  const currentUserId = user?.user_id || user?.id || user?.userId || null;
  const userDeptId = user?.dept_id;

  // --- State ---
  const [report, setReport] = useState(isTeacher ? 'my_attendance_records' : 'attendance_records');
  const [startDate, setStartDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0,10);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0,10));
  const [timeFrom, setTimeFrom] = useState('');
  const [timeTo, setTimeTo] = useState('');
  
  // Filter inputs
  const [teacherId, setTeacherId] = useState('');
  const [roomId, setRoomId] = useState('');
  const [buildingId, setBuildingId] = useState('');
  const [floorId, setFloorId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [programId, setProgramId] = useState('');
  const [attendanceStatus, setAttendanceStatus] = useState('');
  const [warningProgress, setWarningProgress] = useState('');
  const [penaltyStatus, setPenaltyStatus] = useState('');
  const [attendanceView, setAttendanceView] = useState('summary');
  const [leaveCoverageView, setLeaveCoverageView] = useState('summary');
  const [substituteTeacherId, setSubstituteTeacherId] = useState('');
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [coverageStatus, setCoverageStatus] = useState('');
  const [leaveStatus, setLeaveStatus] = useState('');

  // Dropdown Lists
  const [teachers, setTeachers] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [buildings, setBuildings] = useState([]);
  const [floors, setFloors] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [leaveTypes, setLeaveTypes] = useState([]);

  // Data & UI State
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [columns, setColumns] = useState([]);
  const [rows, setRows] = useState([]);
  const [analyticsRows, setAnalyticsRows] = useState([]);
  const [reportPage, setReportPage] = useState(1);
  const [reportPagination, setReportPagination] = useState({ page: 1, page_size: 15, total: 0, total_pages: 1 });
  const [serverReportView, setServerReportView] = useState('');
  const [semester, setSemester] = useState(null);
  const [semesterOptions, setSemesterOptions] = useState([]);
  const [selectedSemesterId, setSelectedSemesterId] = useState('');
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedRow, setSelectedRow] = useState(null);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [mobileAnalyticsOpen, setMobileAnalyticsOpen] = useState(false);
  const [exporting, setExporting] = useState('');
  const [pdfPreview, setPdfPreview] = useState(null);
  const [pdfPreviewFullscreen, setPdfPreviewFullscreen] = useState(false);
  const pdfPreviewUrlRef = useRef('');
  const reportRequestRef = useRef(0);
  const reportCriteriaRef = useRef('');
  const isAttendanceRecordsReport = report === 'attendance_records' || report === 'my_attendance_records';
  const isMyAttendanceReport = report === 'my_attendance_records';
  const isLeaveCoverageReport = report === 'leave_substitution';
  const isSemesterScopedReport = isAttendanceRecordsReport
    || report === 'teacher_attendance_summary'
    || report === 'classroom_utilization'
    || isLeaveCoverageReport;
  const semesterLabel = semester
    ? `${[semester.session_name, semester.term].filter(Boolean).join(' · ') || 'Selected semester'} (${semester.start_date || '—'} to ${semester.end_date || '—'})`
    : 'No active semester';

  const reportOptions = useMemo(() => {
    if (isTeacher) {
      return [
        { value: 'my_attendance_records', label: 'My Attendance Records' },
        { value: 'teacher_attendance_summary', label: 'Teacher Attendance Summary' },
      ];
    }
    const operational = [
      { value: 'attendance_records', label: 'Attendance Records' },
      { value: 'teacher_attendance_summary', label: 'Teacher Attendance Summary' },
      { value: 'classroom_utilization', label: 'Classroom Utilization' },
      { value: 'leave_substitution', label: 'Leave & Substitution Coverage' },
    ];
    if (isDean || isProgramHead || isSecretary) {
      operational.splice(1, 0, { value: 'my_attendance_records', label: 'My Attendance Records' });
    }
    if ((isAdmin || isDean || isDepartmentAdmin || isProgramHead) && canAccessModule(user, 'attendance_logs')) {
      operational.splice(2, 0, { value: 'attendance_logs', label: 'Attendance Audit Logs' });
    }
    if ((isAdmin || isDean || isDepartmentAdmin) && canAccessModule(user, 'logs')) {
      operational.push({ value: 'system_logs', label: 'System Security Logs' });
    }
    return operational;
  }, [user, isAdmin, isDean, isDepartmentAdmin, isProgramHead, isSecretary, isTeacher]);

  // --- Effects ---
  useEffect(() => { fetchLists(); }, [userDeptId, departmentId, programId, report]); // refresh users when scope or report changes
  useEffect(() => { setReportPage(1); }, [report, startDate, endDate, timeFrom, timeTo, selectedSemesterId, teacherId, substituteTeacherId, leaveTypeId, coverageStatus, leaveStatus, buildingId, floorId, roomId, departmentId, programId, attendanceStatus, warningProgress, penaltyStatus, attendanceView, leaveCoverageView, userDeptId, isMobileLayout]);
  useEffect(() => {
    const criteria = JSON.stringify([report, startDate, endDate, timeFrom, timeTo, selectedSemesterId, teacherId, substituteTeacherId, leaveTypeId, coverageStatus, leaveStatus, buildingId, floorId, roomId, departmentId, programId, attendanceStatus, warningProgress, penaltyStatus, attendanceView, leaveCoverageView, userDeptId, isMobileLayout]);
    const criteriaChanged = reportCriteriaRef.current !== criteria;
    reportCriteriaRef.current = criteria;
    if (criteriaChanged && reportPage !== 1) return;
    fetchReport();
  }, [report, startDate, endDate, timeFrom, timeTo, selectedSemesterId, teacherId, substituteTeacherId, leaveTypeId, coverageStatus, leaveStatus, buildingId, floorId, roomId, departmentId, programId, attendanceStatus, warningProgress, penaltyStatus, attendanceView, leaveCoverageView, userDeptId, isMobileLayout, reportPage]);
  useEffect(() => {
    if (reportOptions.some((option) => option.value === report)) return;
    setReport(reportOptions[0]?.value || 'attendance_records');
    setTeacherId('');
    setBuildingId('');
    setFloorId('');
    setRoomId('');
    setAttendanceStatus('');
    setWarningProgress('');
    setPenaltyStatus('');
    setSubstituteTeacherId('');
    setLeaveTypeId('');
    setCoverageStatus('');
    setLeaveStatus('');
  }, [report, reportOptions]);
  useEffect(() => { setSelectedRow(null); }, [report]);
  useEffect(() => {
    if (isAttendanceRecordsReport) setAttendanceView('summary');
    if (isLeaveCoverageReport) setLeaveCoverageView('summary');
  }, [report]);
  useEffect(() => {
    if (!pdfPreview) return undefined;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closePdfPreview();
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [pdfPreview]);
  useEffect(() => () => {
    if (pdfPreviewUrlRef.current) URL.revokeObjectURL(pdfPreviewUrlRef.current);
  }, []);

  // --- Helpers ---
  function buildQuery(params) {
    return Object.entries(params)
      .filter(([k,v]) => v !== null && v !== undefined && v !== '')
      .map(([k,v]) => encodeURIComponent(k)+'='+encodeURIComponent(v))
      .join('&');
  }

  // --- Logic: Which filters to show per report ---
  const showTeacherFilter = !isTeacher && !isMyAttendanceReport && ['attendance_records', 'attendance_logs', 'leave_substitution', 'system_logs', 'teacher_attendance_summary'].includes(report);
  const showRoomFilter = report === 'classroom_utilization' || isMyAttendanceReport;
  const showLocationHierarchyFilters = report === 'classroom_utilization';
  const showAttendanceStatusFilter = isAttendanceRecordsReport;
  const showTeacherSummaryFilters = report === 'teacher_attendance_summary';
  const showLeaveCoverageFilters = isLeaveCoverageReport;
  const showFixedDepartment = !isTeacher && (isDean || isDepartmentAdmin);
  const showProgramFilter = isProgramHead;
  const filterColumnCount = 4
    + Number(isAdmin || showFixedDepartment)
    + Number(showProgramFilter)
    + Number(showTeacherFilter)
    + Number(showRoomFilter)
    + (Number(showLocationHierarchyFilters) * 2)
    + Number(isSemesterScopedReport)
    + (Number(showTeacherSummaryFilters) * 2)
    + (Number(showLeaveCoverageFilters) * 4)
    + (Number(showAttendanceStatusFilter) * 3);
  const selectedTeacher = useMemo(
    () => teachers.find((teacher) => String(teacher.id) === String(isMyAttendanceReport ? currentUserId : teacherId)) || null,
    [teachers, teacherId, isMyAttendanceReport, currentUserId]
  );
  const availableFloors = useMemo(
    () => floors.filter((floor) => !buildingId || String(floor.buildingId) === String(buildingId)),
    [floors, buildingId],
  );
  const availableRooms = useMemo(
    () => rooms.filter((room) => {
      if (showLocationHierarchyFilters && buildingId && String(room.buildingId) !== String(buildingId)) return false;
      if (showLocationHierarchyFilters && floorId && String(room.floorId) !== String(floorId)) return false;
      return true;
    }),
    [rooms, showLocationHierarchyFilters, buildingId, floorId],
  );
  const selectedTeacherDepartment = selectedTeacher?.department
    || departments.find((department) => String(department.id) === String(selectedTeacher?.departmentId || departmentId))?.label
    || '';
  const selectedBuilding = buildings.find((building) => String(building.id) === String(buildingId)) || null;
  const selectedFloor = floors.find((floor) => String(floor.id) === String(floorId)) || null;
  const selectedRoom = rooms.find((room) => String(room.id) === String(roomId)) || null;
  const buildingScopeLabel = selectedBuilding?.label || 'All buildings';
  const floorScopeLabel = selectedFloor?.label || 'All floors';
  const roomScopeLabel = selectedRoom?.label || 'All rooms';
  const selectedProgram = programs.find((program) => String(program.id) === String(programId)) || null;
  const programScopeLabel = selectedProgram?.label || (programs.length === 1 ? programs[0].label : programs.length ? 'All owned programs' : 'No owned programs');
  const fixedDepartmentLabel = user?.dept_name || user?.department || (userDeptId ? `Department #${userDeptId}` : 'Not assigned');

  const attendanceSummaryColumns = useMemo(() => [
    { label: '#', key: '#' },
    { label: 'Teacher', key: 'Teacher' },
    { label: 'Total Records', key: 'Total Records' },
    { label: 'Present', key: 'Present' },
    { label: 'Late', key: 'Late' },
    { label: 'Absent', key: 'Absent' },
    { label: 'Sections', key: 'Sections' },
    { label: 'Subjects', key: 'Subjects' },
  ], []);

  const attendanceSummaryRows = useMemo(() => {
    if (!isAttendanceRecordsReport) return [];
    if (serverReportView === 'summary') return rows;
    const grouped = new Map();

    rows.forEach((row) => {
      const teacher = String(reportValue(row, 'Teacher') || 'Unknown teacher').trim();
      const teacherIdValue = Number(row._user_id || 0);
      const groupKey = teacherIdValue > 0 ? `id:${teacherIdValue}` : `name:${teacher.toLowerCase()}`;
      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, {
          _teacherId: teacherIdValue,
          Teacher: teacher,
          'Total Records': 0,
          Present: 0,
          Late: 0,
          Absent: 0,
          _sections: new Set(),
          _subjects: new Set(),
        });
      }

      const item = grouped.get(groupKey);
      item['Total Records'] += 1;
      const overall = reportValue(row, 'Overall Status') || overallAttendanceStatus(row);
      const statusKey = attendanceFlagKey(null, String(overall || '').toLowerCase());
      if (statusKey === 'present') item.Present += 1;
      else if (statusKey === 'late') item.Late += 1;
      else if (statusKey === 'absent') item.Absent += 1;

      const schedule = String(reportValue(row, 'Schedule') || '');
      const subject = String(row._subject_code || row._subject_name || schedule.split('/')[0] || '').trim();
      const section = String(row._section_name || schedule.split('/')[1] || '').trim();
      if (subject) item._subjects.add(subject);
      if (section) item._sections.add(section);
    });

    return Array.from(grouped.values())
      .sort((left, right) => left.Teacher.localeCompare(right.Teacher))
      .map((item, index) => ({
        '#': index + 1,
        _teacherId: item._teacherId,
        Teacher: item.Teacher,
        'Total Records': item['Total Records'],
        Present: item.Present,
        Late: item.Late,
        Absent: item.Absent,
        Sections: item._sections.size,
        Subjects: item._subjects.size,
      }));
  }, [rows, isAttendanceRecordsReport, serverReportView]);

  const attendanceDetailedColumns = useMemo(() => {
    if (!isAttendanceRecordsReport) return columns;
    const nextColumns = [...columns];
    const hasOverallStatus = nextColumns.some((column) => reportColumnToken(column) === 'overall_status');
    if (!hasOverallStatus) {
      nextColumns.push({
        label: 'Overall Status',
        key: 'Overall Status',
        render: (row) => <GenericReportStatusBadge value={row['Overall Status'] || overallAttendanceStatus(row)} />,
      });
    }
    return nextColumns;
  }, [columns, isAttendanceRecordsReport]);

  const activeReportRows = isAttendanceRecordsReport && attendanceView === 'summary' ? attendanceSummaryRows : rows;
  const activeReportColumns = isAttendanceRecordsReport
    ? (attendanceView === 'summary' ? attendanceSummaryColumns : attendanceDetailedColumns)
    : columns;
  const activeReportTitle = isAttendanceRecordsReport
    ? `${title || (isMyAttendanceReport ? 'My Attendance Records' : 'Attendance Records')} - ${attendanceView === 'summary' ? 'Summary' : 'Detailed'}`
    : (title || 'System Report');

  const openAttendanceSummary = (row) => {
    if (!isMyAttendanceReport && row?._teacherId) setTeacherId(String(row._teacherId));
    setSelectedRow(null);
    setAttendanceView('detailed');
  };

  // --- API: Fetch Dropdowns ---
  async function fetchLists() {
    try {
      // FIX: Add dept_id parameter to filter the dropdown list automatically from backend
      let usersPath = 'users?list=1';
      if (['attendance_records', 'teacher_attendance_summary', 'attendance_logs', 'leave_substitution'].includes(report)) {
        usersPath += '&teaching_roles=1';
      }
      // Report filters must be able to find preserved records belonging to
      // inactive users. Archived users never appear outside User Management.
      usersPath += '&include_inactive=1';
      const listDeptId = isAdmin ? departmentId : userDeptId;
      if (listDeptId) {
        usersPath += `&dept_id=${encodeURIComponent(listDeptId)}`;
      }
      if (isProgramHead && programId) {
        usersPath += `&program_id=${encodeURIComponent(programId)}`;
      }

      const udata = await apiFetch(usersPath);
      if (Array.isArray(udata)) {
        setTeachers(udata.map(u => ({
          id: u.id || u.user_id,
          label: u.label || u.full_name || (u.first_name + ' ' + u.last_name),
          schoolId: u.school_id || u.id_number || '',
          departmentId: u.dept_id || '',
          department: u.department || u.dept_name || '',
        })));
      }
    } catch (e) { console.warn('Teachers fetch error', e); }

    try {
      const rdata = await apiFetch(report === 'classroom_utilization' ? 'rooms' : 'rooms?list=1');
      if (Array.isArray(rdata)) {
        setRooms(rdata
          .filter((room) => !room.status || String(room.status).toLowerCase() === 'active')
          .map(r => ({
            id: r.id || r.room_id,
            label: r.label || r.room_name || r.name,
            buildingId: r.building_id || '',
            floorId: r.floor_id || '',
          })));
      }
    } catch (e) { console.warn('Rooms fetch error', e); }

    if (report === 'classroom_utilization') {
      try {
        const [buildingData, floorData] = await Promise.all([
          apiFetch('buildings'),
          apiFetch('floors'),
        ]);
        setBuildings((Array.isArray(buildingData) ? buildingData : [])
          .filter((building) => (
            (!building.status || String(building.status).toLowerCase() === 'active')
            && (!building.school_status || String(building.school_status).toLowerCase() === 'active')
          ))
          .map((building) => ({
            id: building.building_id || building.id,
            label: building.building_name || building.name || building.label,
          })));
        setFloors((Array.isArray(floorData) ? floorData : [])
          .filter((floor) => !floor.status || String(floor.status).toLowerCase() === 'active')
          .map((floor) => ({
            id: floor.floor_id || floor.id,
            buildingId: floor.building_id || '',
            label: floor.floor_name || floor.name || floor.label,
          })));
      } catch (e) {
        console.warn('Building and floor fetch error', e);
        setBuildings([]);
        setFloors([]);
      }
    } else {
      setBuildings([]);
      setFloors([]);
    }

    if (isProgramHead) {
      try {
        const pdata = await apiFetch('programs');
        if (Array.isArray(pdata)) {
          setPrograms(pdata.map((program) => ({
            id: program.program_id || program.id,
            label: program.program_name || program.name || program.label,
            department: program.dept_name || '',
          })));
        }
      } catch (e) { console.warn('Programs fetch error', e); }
    }

    if (isAdmin) {
      try {
        const ddata = await apiFetch('departments');
        if (Array.isArray(ddata)) {
          setDepartments(ddata.map((department) => ({
            id: department.dept_id || department.id,
            label: department.dept_name || department.name || department.label,
          })));
        }
      } catch (e) { console.warn('Departments fetch error', e); }
    }
  }

  // --- API: Fetch Report Data ---
  function buildReportRequestQuery({ paginate = true, page = reportPage } = {}) {
    const scopedTeacherId = (isTeacher || isMyAttendanceReport)
      ? (currentUserId || undefined)
      : (showTeacherFilter ? (teacherId || undefined) : undefined);
    return buildQuery({
      report,
      start_date: startDate,
      end_date: endDate,
      semester_id: isSemesterScopedReport ? (selectedSemesterId || undefined) : undefined,
      time_from: isAttendanceRecordsReport ? (timeFrom || undefined) : undefined,
      time_to: isAttendanceRecordsReport ? (timeTo || undefined) : undefined,
      teacher_id: scopedTeacherId,
      building_id: showLocationHierarchyFilters ? (buildingId || undefined) : undefined,
      floor_id: showLocationHierarchyFilters ? (floorId || undefined) : undefined,
      room_id: showRoomFilter ? (roomId || undefined) : undefined,
      dept_id: isAdmin ? (departmentId || undefined) : (userDeptId || undefined),
      program_id: isProgramHead ? (programId || undefined) : undefined,
      attendance_status: showAttendanceStatusFilter ? (attendanceStatus || undefined) : undefined,
      warning_progress: showTeacherSummaryFilters ? (warningProgress || undefined) : undefined,
      penalty_status: showTeacherSummaryFilters ? (penaltyStatus || undefined) : undefined,
      view: isAttendanceRecordsReport ? attendanceView : (isLeaveCoverageReport ? leaveCoverageView : undefined),
      substitute_teacher_id: isLeaveCoverageReport ? (substituteTeacherId || undefined) : undefined,
      leave_type_id: isLeaveCoverageReport ? (leaveTypeId || undefined) : undefined,
      coverage_status: isLeaveCoverageReport ? (coverageStatus || undefined) : undefined,
      leave_status: isLeaveCoverageReport ? (leaveStatus || undefined) : undefined,
      paginate: paginate ? 1 : undefined,
      page: paginate ? page : undefined,
      page_size: paginate ? (isMobileLayout ? 5 : 15) : undefined,
    });
  }

  async function fetchReport({ silent = false } = {}) {
    const requestId = ++reportRequestRef.current;
    if (!silent) {
      setLoading(true);
      setError(null);
      setColumns([]);
      setRows([]);
    } else setRefreshing(true);

    try {
      const qs = buildReportRequestQuery({ paginate: true, page: reportPage });
      
      const data = await apiFetch('reports?' + qs);
      if (requestId !== reportRequestRef.current) return;

      setTitle(data.title || report.replace(/_/g,' '));
      
      const apiCols = Array.isArray(data.columns) ? data.columns : [];
      setColumns(apiCols.map((c) => {
        const label = reportColumnLabel(c);
        const normalized = String(c || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
        const column = { label, key: c };
        if (/status/.test(normalized)) column.render = (row) => <GenericReportStatusBadge value={row[c]} />;
        if (/timestamp|created_at|edited_at/.test(normalized)) column.render = (row) => <span className="rp-generic-time">{formatReportTimestamp(row[c])}</span>;
        if (normalized === 'ip_address') column.render = (row) => <code className="rp-generic-ip">{row[c] || '—'}</code>;
        if (normalized === 'network_information') column.render = (row) => <ReportNetworkInformation row={row} />;
        return column;
      }));
      const reportRows = Array.isArray(data.rows) ? data.rows : [];
      setRows(reportRows.map((row) => normalizeReportRow(row, report)));
      const reportAnalyticsRows = Array.isArray(data.analytics_rows) ? data.analytics_rows : reportRows;
      setAnalyticsRows(reportAnalyticsRows.map((row) => normalizeReportRow(row, report)));
      const nextPagination = data.pagination || { page: 1, page_size: isMobileLayout ? 5 : 15, total: reportRows.length, total_pages: 1 };
      setReportPagination(nextPagination);
      setServerReportView(String(data.report_view || ''));
      if (Number(nextPagination.page || 1) !== Number(reportPage)) setReportPage(Number(nextPagination.page || 1));
      const nextSemester = data.semester || null;
      const nextSemesterOptions = Array.isArray(data.semester_options) ? data.semester_options : [];
      const reportLeaveTypes = Array.isArray(data.leave_type_options) ? data.leave_type_options : [];
      setSemester(nextSemester);
      setSemesterOptions(nextSemesterOptions);
      if (isLeaveCoverageReport && reportLeaveTypes.length) {
        setLeaveTypes(reportLeaveTypes.map((type) => ({
          id: type.leave_type_id || type.id,
          label: type.name_type || type.name || type.label,
        })));
      }
      if (isSemesterScopedReport && !selectedSemesterId && nextSemester?.semester_id) {
        setSelectedSemesterId(String(nextSemester.semester_id));
        if (nextSemester.start_date) setStartDate(nextSemester.start_date);
        if (nextSemester.end_date) setEndDate(nextSemester.end_date);
      }

    } catch (err) {
      if (requestId !== reportRequestRef.current) return;
      console.error(err);
      if (!silent) setError(err.message || 'Failed to load report');
    } finally {
      if (requestId === reportRequestRef.current) {
        if (!silent) setLoading(false);
        setRefreshing(false);
      }
    }
  }

  useAutoRefresh({
    refresh: () => fetchReport({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.REPORT,
    enabled: Boolean(report),
    refreshOnFocus: false,
  });

  // --- Export Functions ---
  async function fetchCompleteReportRows() {
    const query = buildReportRequestQuery({ paginate: false });
    const data = await apiFetch('reports?' + query);
    const completeRows = Array.isArray(data?.rows) ? data.rows : [];
    return completeRows.map((row) => normalizeReportRow(row, report));
  }

  async function exportToExcel() {
    if (typeof XLSX === 'undefined') { alert('SheetJS not loaded'); return; }
    if (!activeReportRows.length || !activeReportColumns.length || exporting) return;

    setExporting('excel');
    await new Promise((resolve) => setTimeout(resolve, 40));
    try {
      const exportReportRows = await fetchCompleteReportRows();
      if (!exportReportRows.length) throw new Error('No report data to export.');
      const safeTitle = String(activeReportTitle || reportMeta[0] || 'System Report').trim() || 'System Report';
      const safeFileTitle = safeTitle.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_');
      const exportColumns = activeReportColumns.filter((column) => String(column.key) !== '#');
      const spreadsheetSafe = (value) => {
        if (value === null || value === undefined) return '';
        const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return /^[=+\-@]/.test(text) ? `'${text}` : text;
      };
      const excelValue = (row, column) => {
        const value = row[column.key];
        const normalized = String(column.key || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
        if (/timestamp|created_at|edited_at/.test(normalized) && value) return formatReportTimestamp(value);
        return spreadsheetSafe(value);
      };
      const headings = ['#', ...exportColumns.map((column) => column.label || column.key)];
      const dataRows = exportReportRows.map((row, index) => [index + 1, ...exportColumns.map((column) => excelValue(row, column))]);
      const generatedAt = new Date().toLocaleString();
      const selectedUserRows = selectedTeacher ? [
        ['Selected user', spreadsheetSafe(selectedTeacher.label)],
        ['School ID', spreadsheetSafe(selectedTeacher.schoolId || 'Not assigned')],
        ['Department', spreadsheetSafe(selectedTeacherDepartment || 'Not assigned')],
      ] : [];
      if (isProgramHead) {
        selectedUserRows.push(['Program scope', spreadsheetSafe(programScopeLabel)]);
      }
      if (showLocationHierarchyFilters) {
        selectedUserRows.push(
          ['Building scope', spreadsheetSafe(buildingScopeLabel)],
          ['Floor scope', spreadsheetSafe(floorScopeLabel)],
          ['Room scope', spreadsheetSafe(roomScopeLabel)],
        );
      }
      const worksheetRows = [
        [safeTitle],
        ['Report period', `${startDate || 'Beginning'} to ${endDate || 'Today'}`],
        ...(isSemesterScopedReport ? [['Semester', spreadsheetSafe(semesterLabel)]] : []),
        ...(isAttendanceRecordsReport && (timeFrom || timeTo) ? [['Scheduled time', `${timeFrom || 'Start of day'} to ${timeTo || 'End of day'}`]] : []),
        ...selectedUserRows,
        ['Generated', generatedAt, '', 'Records', exportReportRows.length],
        [],
        headings,
        ...dataRows,
      ];
      const headerRowIndex = 4 + selectedUserRows.length
        + Number(isSemesterScopedReport)
        + Number(isAttendanceRecordsReport && Boolean(timeFrom || timeTo));
      const ws = XLSX.utils.aoa_to_sheet(worksheetRows);
      const lastColumn = Math.max(0, headings.length - 1);
      ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: lastColumn } }];
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: headerRowIndex, c: 0 }, e: { r: headerRowIndex, c: lastColumn } }) };
      ws['!freeze'] = { xSplit: 0, ySplit: headerRowIndex + 1, topLeftCell: `A${headerRowIndex + 2}`, activePane: 'bottomLeft', state: 'frozen' };
      ws['!rows'] = worksheetRows.map((_, index) => ({ hpt: index === 0 ? 26 : index === headerRowIndex ? 24 : index === headerRowIndex - 1 ? 8 : 19 }));
      ws['!cols'] = headings.map((heading, columnIndex) => {
        if (columnIndex === 0) return { wch: 7 };
        const values = dataRows.slice(0, 250).map((row) => String(row[columnIndex] ?? '').length);
        const normalized = String(heading || '').toLowerCase();
        const preferredMinimum = /timestamp|date|time/.test(normalized) ? 20 : /details|reason|minutes by day/.test(normalized) ? 28 : 12;
        return { wch: Math.min(42, Math.max(preferredMinimum, String(heading || '').length + 2, ...values.map((length) => Math.min(length + 2, 42)))) };
      });

      const wb = XLSX.utils.book_new();
      wb.Props = { Title: safeTitle, Subject: 'System report', Author: 'System Reports', CreatedDate: new Date() };
      XLSX.utils.book_append_sheet(wb, ws, String(safeTitle).slice(0, 31) || 'Report');
      XLSX.writeFile(wb, `${safeFileTitle}_${startDate || new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (error) {
      console.error('Excel export failed', error);
      alert('The Excel report could not be generated. Please try again.');
    } finally {
      setExporting('');
    }
  }

  function closePdfPreview() {
    if (pdfPreviewUrlRef.current) {
      URL.revokeObjectURL(pdfPreviewUrlRef.current);
      pdfPreviewUrlRef.current = '';
    }
    setPdfPreview(null);
    setPdfPreviewFullscreen(false);
  }

  async function exportToPDF() {
    if (typeof html2pdf === 'undefined') {
      alert('PDF preview is unavailable because the PDF library did not load. Please refresh and try again.');
      return;
    }
    if (!activeReportRows.length || !activeReportColumns.length) {
      alert('No report data to export.');
      return;
    }
    if (exporting) return;
    setExporting('pdf');

    let wrapper = null;
    try {
      const exportReportRows = await fetchCompleteReportRows();
      if (!exportReportRows.length) throw new Error('No report data to export.');

    const safeTitle = String(activeReportTitle || 'System Report').trim() || 'System Report';
    const safeFileTitle = safeTitle.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_');
    const today = new Date().toISOString().slice(0, 10);

    const formatCell = (value) => {
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') {
        try { return JSON.stringify(value); } catch (e) { return String(value); }
      }
      return String(value);
    };

    const escapeHtml = (value) =>
      String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

    const scopeDetails = [];
    if (selectedTeacher) {
      scopeDetails.push(
        `<div><span>Selected User</span><strong>${escapeHtml(selectedTeacher.label || 'Unknown user')}</strong></div>`,
        `<div><span>School ID</span><strong>${escapeHtml(selectedTeacher.schoolId || 'Not assigned')}</strong></div>`,
        `<div><span>Department</span><strong>${escapeHtml(selectedTeacherDepartment || 'Not assigned')}</strong></div>`
      );
    }
    if (isProgramHead) {
      scopeDetails.push(`<div><span>Program Scope</span><strong>${escapeHtml(programScopeLabel)}</strong></div>`);
    }
    if (showLocationHierarchyFilters) {
      scopeDetails.push(
        `<div><span>Building Scope</span><strong>${escapeHtml(buildingScopeLabel)}</strong></div>`,
        `<div><span>Floor Scope</span><strong>${escapeHtml(floorScopeLabel)}</strong></div>`,
        `<div><span>Room Scope</span><strong>${escapeHtml(roomScopeLabel)}</strong></div>`,
      );
    }
    const selectedUserHtml = scopeDetails.length ? `
      <div class="report-pdf-user">
        ${scopeDetails.join('')}
      </div>
    ` : '';

    const previewExportColumns = activeReportColumns.filter((column) => String(column.key) !== '#');
    const exportColumns = previewExportColumns;
    const isDetailedAttendanceExport = isAttendanceRecordsReport && attendanceView === 'detailed';
    const isSummaryAttendanceExport = isAttendanceRecordsReport && attendanceView === 'summary';
    const pdfRecordCount = isSummaryAttendanceExport
      ? exportReportRows.reduce((total, row) => total + (Number(row['Total Records']) || 0), 0)
      : exportReportRows.length;
    const pdfRecordLabel = isSummaryAttendanceExport
      ? `attendance record${pdfRecordCount === 1 ? '' : 's'}`
      : `record${pdfRecordCount === 1 ? '' : 's'}`;
    const previewRecordLabel = isSummaryAttendanceExport ? pdfRecordLabel : 'records';
    const isAttendanceAuditExport = report === 'attendance_logs';
    const isLeaveCoverageExport = isLeaveCoverageReport;
    const isLeaveCoverageSummaryExport = isLeaveCoverageExport && leaveCoverageView === 'summary';
    const isLeaveCoverageDetailedExport = isLeaveCoverageExport && leaveCoverageView === 'detailed';
    const isClassroomUtilizationExport = report === 'classroom_utilization';
    const isSystemSecurityLogsExport = report === 'system_logs';
    const maxColumnsPerSection = isDetailedAttendanceExport
      ? 12
      : isAttendanceAuditExport
        ? 12
      : isLeaveCoverageExport
        ? 12
      : report === 'teacher_attendance_summary'
        ? 20
        : 8;
    const repeatedIdentityColumns = [
      exportColumns.find(isTeacherIdentityColumn),
      exportColumns.find(isDateIdentityColumn),
    ].filter((column, index, list) => column && list.indexOf(column) === index);
    const detailColumns = exportColumns.filter((column) => !repeatedIdentityColumns.includes(column));
    const detailColumnsPerSection = Math.max(1, maxColumnsPerSection - repeatedIdentityColumns.length);
    const columnChunks = [];
    if (!detailColumns.length) {
      columnChunks.push(repeatedIdentityColumns);
    } else {
      for (let i = 0; i < detailColumns.length; i += detailColumnsPerSection) {
        columnChunks.push([...repeatedIdentityColumns, ...detailColumns.slice(i, i + detailColumnsPerSection)]);
      }
    }

    const pdfColumnWeight = (column) => {
      const token = reportColumnToken(column);
      if (isAttendanceAuditExport) {
        if (isTeacherIdentityColumn(column)) return 12;
        if (isDateIdentityColumn(column)) return 10;
        if (token === 'reason') return 16;
        if (token === 'network_information') return 16;
        if (token === 'edit_session') return 11;
        if (token === 'edited_by') return 9;
        if (['action', 'field'].includes(token)) return 8;
        if (['old_value', 'new_value'].includes(token)) return 7;
        return 8;
      }
      if (isLeaveCoverageExport) {
        if (isTeacherIdentityColumn(column)) return 15;
        if (token === 'remarks' || token === 'reason') return 16;
        if (['subject_section', 'substitute_teacher'].includes(token)) return 13;
        if (['leave_period', 'scheduled_time'].includes(token)) return 11;
        if (token.includes('status')) return 10;
        if (['total_leave_days', 'affected_classes', 'covered_classes', 'uncovered_classes', 'coverage_rate'].includes(token)) return 7;
        return 9;
      }
      if (report !== 'teacher_attendance_summary') return 12;
      if (isTeacherIdentityColumn(column)) return 16;
      if (token === 'department') return 14;
      if (token === 'late_minutes_by_day') return 13;
      if (['warning_progress', 'tardiness_penalty'].includes(token)) return 10;
      if (['penalty_date', 'penalty_status', 'total_late_minutes'].includes(token)) return 8;
      if (token === 'total_classes' || token === 'late_warnings') return 7;
      if (token === 'unresolved') return 6;
      return 5;
    };

    const sectionsHtml = columnChunks
      .map((chunk, chunkIndex) => {
        const columnWeights = [report === 'teacher_attendance_summary' ? 4 : 5, ...chunk.map(pdfColumnWeight)];
        const totalColumnWeight = columnWeights.reduce((sum, weight) => sum + weight, 0);
        const colgroupHtml = `<colgroup>${columnWeights
          .map((weight) => `<col style="width:${((weight / totalColumnWeight) * 100).toFixed(2)}%;">`)
          .join('')}</colgroup>`;
        const headerHtml = ['<th>#</th>']
          .concat(chunk.map((c) => `<th>${escapeHtml(c.label || c.key || '')}</th>`))
          .join('');

        const rowsHtml = exportReportRows
          .map((r, rowIndex) => {
            const cells = ['<td class="report-pdf-row-index">' + (rowIndex + 1) + '</td>']
              .concat(chunk.map((c) => {
                const value = formatCell(readReportCell(r, c.key));
                const normalized = String(c.key || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
                const cellClass = /status|flag/.test(normalized)
                  ? ` class="report-pdf-status is-${reportStatusTone(value)}"`
                  : /timestamp|created_at|edited_at|ip_address/.test(normalized)
                    ? ' class="report-pdf-mono"'
                    : '';
                const displayValue = /timestamp|created_at|edited_at/.test(normalized) ? formatReportTimestamp(value) : value;
                return `<td${cellClass}>${escapeHtml(displayValue)}</td>`;
              }))
              .join('');
            return `<tr>${cells}</tr>`;
          })
          .join('');

        const repeatedLabels = repeatedIdentityColumns.map((column) => column.label || column.key).join(' and ');
        const sectionLabel = columnChunks.length > 1
          ? `<div class="report-pdf-section-label">${isAttendanceRecordsReport ? 'Attendance' : 'Report'} details &mdash; section ${chunkIndex + 1} of ${columnChunks.length}${repeatedLabels ? ` &mdash; ${escapeHtml(repeatedLabels)} repeated for reference` : ''}</div>`
          : '';

        return `
          <div class="report-pdf-section${chunkIndex > 0 ? ' section-break' : ''}">
            ${sectionLabel}
            <table class="report-pdf-table">
              ${colgroupHtml}
              <thead><tr>${headerHtml}</tr></thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        `;
      })
      .join('');

    wrapper = document.createElement('div');
    // Each report variant owns its PDF geometry. Do not derive positioning from
    // another report because their column counts and readable widths differ.
    wrapper.style.position = 'fixed';
    wrapper.style.top = '0';
    const widestColumnChunk = Math.max(1, ...columnChunks.map((chunk) => chunk.length));
    const pdfLayout = isSummaryAttendanceExport
      ? {
          key: 'attendance-summary', format: 'a4',
          width: Math.max(1100, (widestColumnChunk + 1) * 130) + 230,
          captureLeft: '-100000px',
          rootPadding: '18px 18px 18px 230px',
          contentTransform: 'none',
          rootTransform: 'none', headerWidth: '100%', userWidth: '100%', sectionWidth: '100%',
          tableTransform: 'none', fontSize: '12.5px', monoSize: '11.5px', cellPadding: '6px 7px',
        }
      : isDetailedAttendanceExport
        ? {
            key: 'attendance-detailed', format: 'a3',
            width: Math.max(980, (widestColumnChunk + 1) * 140),
            captureLeft: '-100000px',
            rootPadding: '18px',
            contentTransform: 'none',
            rootTransform: 'translateX(-9.25%)', headerWidth: '90%', userWidth: '90%', sectionWidth: '100%',
            tableTransform: 'scale(0.9)', fontSize: '13.5px', monoSize: '12px', cellPadding: '6px 7px',
          }
          : isAttendanceAuditExport
            ? {
                key: 'attendance-audit', format: 'a3', width: 1572,
                captureLeft: '-100000px',
                rootPadding: '18px',
                contentTransform: 'none',
                rootTransform: 'none', headerWidth: '100%', userWidth: '100%', sectionWidth: '100%',
                tableTransform: 'none', fontSize: '12px', monoSize: '10.5px', cellPadding: '5px 5px',
              }
          : isLeaveCoverageSummaryExport
            ? {
                key: 'leave-summary', format: 'a3', width: 1400,
                captureLeft: '-100000px',
                rootPadding: '18px',
                contentTransform: 'translateX(4%)',
                rootTransform: 'none', headerWidth: '92%', userWidth: '92%', sectionWidth: '92%',
                tableTransform: 'none', fontSize: '10.5px', monoSize: '9.5px', cellPadding: '6px 7px',
              }
          : isLeaveCoverageDetailedExport
            ? {
                key: 'leave-detailed', format: 'a3', width: 1550,
                captureLeft: '-100000px',
                rootPadding: '18px',
                contentTransform: 'translateX(4%)',
                rootTransform: 'none', headerWidth: '92%', userWidth: '92%', sectionWidth: '92%',
                tableTransform: 'none', fontSize: '10.5px', monoSize: '9.5px', cellPadding: '5px 5px',
              }
            : isClassroomUtilizationExport
              ? {
                  key: 'classroom-utilization', format: 'a3', width: 1400,
                  captureLeft: '-100000px',
                  rootPadding: '18px',
                  contentTransform: 'translateX(4%)',
                  rootTransform: 'none', headerWidth: '92%', userWidth: '92%', sectionWidth: '92%',
                  tableTransform: 'none', fontSize: '10.5px', monoSize: '9.5px', cellPadding: '6px 7px',
                }
            : isSystemSecurityLogsExport
              ? {
                  key: 'system-security-logs', format: 'a3', width: 1400,
                  captureLeft: '-100000px',
                  rootPadding: '18px',
                  contentTransform: 'none',
                  rootTransform: 'none', headerWidth: '100%', userWidth: '100%', sectionWidth: '100%',
                  tableTransform: 'none', fontSize: '11.5px', monoSize: '10.5px', cellPadding: '6px 7px',
                }
            : report === 'teacher_attendance_summary'
              ? {
                  key: 'teacher-attendance-summary', format: 'a3',
                  width: Math.max(1400, Math.min(1900, (widestColumnChunk + 1) * 200)),
                  captureLeft: '-100000px',
                  rootPadding: '18px',
                  contentTransform: 'none',
                  rootTransform: 'translateX(-9.8%)', headerWidth: '90%', userWidth: '90%', sectionWidth: '90%',
                  tableTransform: 'none', fontSize: '8.5px', monoSize: '9.5px', cellPadding: '4px 4px',
                }
              : {
                  key: `report-${report}`, format: 'a3',
                  width: Math.max(1400, Math.min(1900, (widestColumnChunk + 1) * 200)),
                  captureLeft: '-100000px',
                  rootPadding: '18px',
                  contentTransform: 'none',
                  rootTransform: 'none', headerWidth: '100%', userWidth: '100%', sectionWidth: '100%',
                  tableTransform: 'none', fontSize: '10.5px', monoSize: '9.5px', cellPadding: '6px 7px',
                };
    const exportWidth = pdfLayout.width;
    wrapper.style.left = pdfLayout.captureLeft;
    wrapper.style.width = exportWidth + 'px';
    wrapper.style.maxWidth = 'none';
    wrapper.style.boxSizing = 'border-box';
    wrapper.style.overflow = 'visible';
    wrapper.style.background = '#fff';
    wrapper.style.zIndex = '-1';
    wrapper.style.pointerEvents = 'none';
    wrapper.setAttribute('aria-hidden', 'true');
    wrapper.setAttribute('data-report-pdf-layout', pdfLayout.key);
    wrapper.innerHTML = `
      <style>
        .report-pdf-root, .report-pdf-root * { box-sizing: border-box; }
        .report-pdf-root { width: 100%; max-width: none; margin: 0 auto; overflow: visible; font-family: Arial, sans-serif; color: #172033; padding: ${pdfLayout.rootPadding}; background: #fff; transform: ${pdfLayout.rootTransform}; transform-origin: top center; }
        .report-pdf-header { width: ${pdfLayout.headerWidth}; margin-left: auto; margin-right: auto; display: flex; justify-content: space-between; align-items: flex-end; gap: 18px; padding: 16px 18px; border-left: 7px solid #15803d; background: #f0fdf4; transform: ${pdfLayout.contentTransform}; }
        .report-pdf-header > div:first-child { min-width: 0; }
        .report-pdf-kicker { margin: 0 0 4px; color: #15803d; font-size: 10px; font-weight: 700; letter-spacing: 1.1px; text-transform: uppercase; }
        .report-pdf-title { font-size: 22px; font-weight: 700; margin: 0 0 5px 0; }
        .report-pdf-meta { font-size: 11px; color: #64748b; margin: 0; }
        .report-pdf-summary { min-width: 72px; flex: 0 0 auto; padding: 8px 11px; border: 1px solid #bbf7d0; border-radius: 6px; color: #166534; font-size: 11px; font-weight: 700; text-align: center; white-space: nowrap; background: #fff; }
        .report-pdf-user { width: ${pdfLayout.userWidth}; margin-left: auto; margin-right: auto; display: grid; grid-template-columns: 1.2fr .8fr 1fr; gap: 10px; padding: 11px 14px; border: 1px solid #dbe8df; border-top: 0; background: #fff; transform: ${pdfLayout.contentTransform}; }
        .report-pdf-user > div { min-width: 0; }
        .report-pdf-user span { display: block; margin-bottom: 3px; color: #64748b; font-size: 8px; font-weight: 700; letter-spacing: .7px; text-transform: uppercase; }
        .report-pdf-user strong { display: block; overflow-wrap: anywhere; color: #1e293b; font-size: 11px; }
        .report-pdf-section { width: ${pdfLayout.sectionWidth}; margin: 8px auto 0; overflow: hidden; transform: ${pdfLayout.contentTransform}; }
        .report-pdf-section.section-break { page-break-before: always; }
        .report-pdf-section-label { font-size: 12px; font-weight: 700; margin: 8px 0 6px 0; color: #1f2937; }
        .report-pdf-table { width: 100%; margin-left: auto; margin-right: auto; border-collapse: collapse; table-layout: fixed; font-size: ${pdfLayout.fontSize}; transform: ${pdfLayout.tableTransform}; transform-origin: top center; }
        .report-pdf-table thead { display: table-header-group; }
        .report-pdf-table tr { page-break-inside: avoid; }
        .report-pdf-table th,
        .report-pdf-table td {
          width: auto !important;
          min-width: 0 !important;
          max-width: none !important;
          overflow: hidden;
          border: 1px solid #dbe5de;
          padding: ${pdfLayout.cellPadding};
          text-align: left;
          vertical-align: top;
          word-break: break-word;
          white-space: normal;
        }
        .report-pdf-table th { color: #fff; background: #187a42; font-weight: 700; }
        .report-pdf-table tbody tr:nth-child(even) td { background: #f8faf9; }
        .report-pdf-row-index { background: #f9fafb; text-align: center; font-weight: 600; }
        .report-pdf-mono { font-family: Consolas, monospace; font-size: ${pdfLayout.monoSize}; }
        .report-pdf-status { font-weight: 700; }
        .report-pdf-status.is-success { color: #16a34a; }
        .report-pdf-status.is-warning { color: #f59e0b; }
        .report-pdf-status.is-danger { color: #dc2626; }
        .report-pdf-status.is-info { color: #0369a1; }
        .report-pdf-status.is-incomplete { color: #8b5cf6; }
        .report-pdf-status.is-pending { color: #f97316; }
        .report-pdf-status.is-upcoming { color: #64748b; }
        .report-pdf-status.is-substituted { color: #4f46e5; }
        .report-pdf-status.is-leave { color: #0891b2; }
        .report-pdf-status.is-muted { color: #475569; }
      </style>
      <div class="report-pdf-root">
        <div class="report-pdf-header">
          <div><p class="report-pdf-kicker">System Reports</p><h2 class="report-pdf-title">${escapeHtml(safeTitle)}</h2><p class="report-pdf-meta">${escapeHtml(startDate || 'Beginning')} to ${escapeHtml(endDate || 'Today')}${isSemesterScopedReport ? ` &nbsp;•&nbsp; ${escapeHtml(semesterLabel)}` : ''}${isAttendanceRecordsReport && (timeFrom || timeTo) ? ` &nbsp;•&nbsp; Scheduled time ${escapeHtml(timeFrom || 'Start of day')} to ${escapeHtml(timeTo || 'End of day')}` : ''} &nbsp;•&nbsp; Generated ${escapeHtml(new Date().toLocaleString())}</p></div>
          <div class="report-pdf-summary">${pdfRecordCount} ${pdfRecordLabel}</div>
        </div>
        ${selectedUserHtml}
        ${sectionsHtml}
      </div>
    `;

    document.body.appendChild(wrapper);
    const exportNode = wrapper.querySelector('.report-pdf-root') || wrapper;
    // Summary is supplied as isolated HTML rather than as a live page element.
    // This prevents the application's overflow/viewport offsets from clipping
    // its title and identity columns during html2canvas capture.
    const exportSource = isSummaryAttendanceExport ? wrapper.innerHTML : exportNode;
    const exportSourceType = isSummaryAttendanceExport ? 'string' : 'element';

    const blob = await html2pdf()
      .set({
        margin: [8, 8, 8, 8],
        filename: `${safeFileTitle}_${today}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: {
          scale: 1.5,
          useCORS: true,
          allowTaint: true,
          scrollX: 0,
          scrollY: 0,
          windowWidth: exportWidth,
          backgroundColor: '#ffffff'
        },
        jsPDF: { unit: 'mm', format: pdfLayout.format, orientation: 'landscape' },
        pagebreak: { mode: ['css', 'legacy'] }
      })
      .from(exportSource, exportSourceType)
      .outputPdf('blob');

      if (!(blob instanceof Blob)) throw new Error('The generated PDF is invalid.');
      if (pdfPreviewUrlRef.current) URL.revokeObjectURL(pdfPreviewUrlRef.current);
      const previewUrl = URL.createObjectURL(blob);
      pdfPreviewUrlRef.current = previewUrl;
      setPdfPreview({
        url: previewUrl,
        filename: `${safeFileTitle}_${today}.pdf`,
        title: safeTitle,
        reportType: report,
        recordCount: pdfRecordCount,
        recordLabel: previewRecordLabel,
        fieldCount: previewExportColumns.length,
      });
      setPdfPreviewFullscreen(false);
    } catch (error) {
      console.error('PDF preview failed', error);
      alert('The PDF preview could not be generated. Please try again.');
    } finally {
      if (wrapper && wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
      setExporting('');
    }
  }

  // --- Visualization Data Logic ---
  const chartData = useMemo(() => {
    if (!analyticsRows.length) return { pie: [], bar: [], barMode: 'default' };

    let pie = [], bar = [];
    let barMode = 'default';

    // DATA PROCESSING BASED ON REPORT TYPE
    if (isAttendanceRecordsReport) {
        // PIE: Count one overall result per attendance record.
        const counts = { Present: 0, Late: 0, Absent: 0, 'Partial Attendance': 0, Pending: 0, Upcoming: 0, Substituted: 0, 'On Leave': 0 };
        analyticsRows.forEach(r => {
            const overall = reportValue(r, 'Overall Status') || overallAttendanceStatus(r);
            const key = attendanceFlagKey(null, String(overall || '').toLowerCase());
            if (key === 'present') counts.Present++;
            else if (key === 'late') counts.Late++;
            else if (key === 'absent') counts.Absent++;
            else if (key === 'incomplete') counts['Partial Attendance']++;
            else if (key === 'pending') counts.Pending++;
            else if (key === 'upcoming') counts.Upcoming++;
            else if (key === 'substituted') counts.Substituted++;
            else if (key === 'on_leave') counts['On Leave']++;
            else counts['Partial Attendance']++;
        });
        pie = Object.keys(counts).map(k => ({ label: k, value: counts[k] })).filter(d => d.value > 0);

        // BAR: Top 5 Rooms by Usage (Count)
        const roomCounts = {};
        analyticsRows.forEach(r => {
            const rm = r['Room'] || r.room_name || 'Unknown';
            roomCounts[rm] = (roomCounts[rm] || 0) + 1;
        });
        bar = Object.entries(roomCounts)
            .map(([label, value]) => ({ label, value }))
            .sort((a,b) => b.value - a.value)
            .slice(0, 5); // Top 5
    
    } else if (report === 'teacher_attendance_summary') {
        // PIE: Aggregate teacher-level attendance totals
        const totals = { Present: 0, Late: 0, Absent: 0 };
        analyticsRows.forEach(r => {
            totals.Present += parseInt(r['Present'] || r.present || 0, 10) || 0;
            totals.Late += parseInt(r['Late'] || r.late || 0, 10) || 0;
            totals.Absent += parseInt(r['Absent'] || r.absent || 0, 10) || 0;
        });
        pie = Object.keys(totals).map(k => ({ label: k, value: totals[k] })).filter(d => d.value > 0);

        // BAR: Top 5 teaching staff by semester late-warning checkpoints.
        const teacherStats = analyticsRows.map(r => ({
            label: r['Teacher'] || r.teacher || 'Unknown',
            warnings: parseInt(r['Late Warnings'] || r.late_warnings || 0, 10) || 0,
            lateMins: parseInt(r['Total Late Minutes'] || r.total_late_minutes || 0, 10) || 0
        }));
        const useLateMinutes = teacherStats.every(s => s.warnings === 0);
        barMode = useLateMinutes ? 'late_minutes' : 'late_warnings';
        bar = teacherStats
            .map(s => ({ label: s.label, value: useLateMinutes ? s.lateMins : s.warnings, lateMins: s.lateMins }))
            .sort((a, b) => (b.value - a.value) || (b.lateMins - a.lateMins))
            .slice(0, 5)
            .map(({ label, value }) => ({ label, value }));
    } else if (report === 'classroom_utilization') {
        // PIE: Distribution of hours
        pie = analyticsRows.slice(0, 5).map(r => ({
            label: r['Room Name'] || r.room_name,
            value: parseFloat(r['Total Hours Used (hrs)'] || 0)
        }));
        
        // BAR: Classes held
        bar = analyticsRows.slice(0, 5).map(r => ({
            label: r['Room Name'] || r.room_name,
            value: parseInt(r['Total Classes Held'] || 0)
        }));
    } else {
        const categoryCounts = {};
        const dateCounts = {};
        analyticsRows.forEach((row) => {
          const category = report === 'leave_substitution'
            ? (row['Coverage Status'] || row['Leave Status'] || 'Other')
            : report === 'attendance_logs'
              ? (row.Action || row.action || 'Change')
              : (row.action || row.Action || 'Activity');
          categoryCounts[category] = (categoryCounts[category] || 0) + 1;
          const rawDate = row.Date || row.date || String(row['Leave Period'] || '').split(' to ')[0] || row.occurred_at || row.created_at || '';
          const parsed = new Date(String(rawDate).replace(' - ', ' '));
          const label = Number.isNaN(parsed.getTime()) ? String(rawDate).slice(0, 10) : parsed.toLocaleDateString([], { month: 'short', day: 'numeric' });
          if (label) dateCounts[label] = (dateCounts[label] || 0) + 1;
        });
        pie = Object.entries(categoryCounts).map(([label, value]) => ({ label: titleWords(label), value })).sort((a, b) => b.value - a.value).slice(0, 6);
        bar = Object.entries(dateCounts).map(([label, value]) => ({ label, value })).slice(-7);
    }

    return { pie, bar, barMode };
  }, [analyticsRows, report]);

  const reportMeta = useMemo(() => {
    const map = {
      attendance_records: ['Attendance Records', 'Review each attendance stage, status, and recorded timestamp.'],
      my_attendance_records: ['My Attendance Records', 'Review only your own attendance stages, statuses, and recorded timestamps.'],
      teacher_attendance_summary: ['Teacher Attendance Summary', 'Compare attendance performance, late minutes, and red-flag activity.'],
      attendance_logs: ['Attendance Audit Logs', 'Inspect attendance adjustments, reasons, editors, and source addresses.'],
      classroom_utilization: ['Classroom Utilization', 'Understand room activity, scheduled classes, and hours used.'],
      leave_substitution: ['Leave & Substitution Coverage', 'Measure whether every class affected by a recorded leave has an assigned substitute.'],
      system_logs: ['System Security Logs', 'Review authenticated system events and security-relevant activity.'],
    };
    return map[report] || ['System Report', 'Review filtered operational data and analytics.'];
  }, [report]);

  const metrics = useMemo(() => {
    const metric = (label, value, note, icon, tone) => ({ label, value, note, icon, tone });
    const sum = (key) => analyticsRows.reduce((total, row) => total + (parseFloat(row[key] || 0) || 0), 0);
    const unique = (key) => new Set(analyticsRows.map((row) => row[key]).filter((value) => value !== null && value !== undefined && value !== '' && value !== '-')).size;
    if (isAttendanceRecordsReport) {
      const overallKey = (row) => attendanceFlagKey(null, reportValue(row, 'Overall Status') || overallAttendanceStatus(row));
      return [
        metric('Records', analyticsRows.length, 'Selected date range', 'bi-journal-check', 'green'),
        metric('Present', analyticsRows.filter((row) => overallKey(row) === 'present').length, 'Overall attendance result', 'bi-check-circle', 'green'),
        metric('Late', analyticsRows.filter((row) => overallKey(row) === 'late').length, 'Overall attendance result', 'bi-clock', 'amber'),
        metric('Absent', analyticsRows.filter((row) => overallKey(row) === 'absent').length, 'Overall attendance result', 'bi-person-x', 'red'),
        metric('Other', analyticsRows.filter((row) => !['present', 'late', 'absent'].includes(overallKey(row))).length, 'Upcoming, pending, or other', 'bi-three-dots', 'purple'),
      ];
    }
    if (report === 'teacher_attendance_summary') return [
      metric('Teachers', analyticsRows.length, 'Included in report', 'bi-people', 'green'),
      metric('Total Classes', sum('Total Classes'), 'Scheduled classes', 'bi-calendar3', 'blue'),
      metric('Present', sum('Present'), 'Recorded present', 'bi-check-circle', 'green'),
      metric('Late Warnings', sum('Late Warnings'), 'Check-in and middle-check warnings', 'bi-flag', 'red'),
    ];
    if (report === 'attendance_logs') return [
      metric('Changes', analyticsRows.length, 'Audit entries', 'bi-pencil-square', 'green'),
      metric('Editors', unique('Edited By'), 'Unique editors', 'bi-person-check', 'blue'),
      metric('Sessions', unique('Edit Session'), 'Edit sessions', 'bi-layers', 'amber'),
      metric('IP Addresses', unique('IP Address'), 'Recorded sources', 'bi-globe2', 'purple'),
    ];
    if (report === 'classroom_utilization') {
      const top = analyticsRows.slice().sort((a, b) => (parseFloat(b['Total Classes Held']) || 0) - (parseFloat(a['Total Classes Held']) || 0))[0];
      return [
        metric('Rooms', analyticsRows.length, 'Rooms with activity', 'bi-door-open', 'green'),
        metric('Classes Held', sum('Total Classes Held'), 'Completed usage', 'bi-calendar-check', 'blue'),
        metric('Hours Used', sum('Total Hours Used (hrs)').toFixed(1), 'Combined hours', 'bi-hourglass-split', 'amber'),
        metric('Top Room', top?.['Room Name'] || '—', 'Most classes held', 'bi-trophy', 'purple'),
      ];
    }
    if (report === 'leave_substitution') {
      const recordedLeaves = leaveCoverageView === 'summary'
        ? analyticsRows.filter((row) => String(row['Leave Status'] || '').toLowerCase() === 'recorded').length
        : new Set(analyticsRows.filter((row) => String(row['Leave Status'] || '').toLowerCase() === 'recorded').map((row) => row._leave_id).filter(Boolean)).size;
      const affected = leaveCoverageView === 'summary'
        ? sum('Affected Classes')
        : analyticsRows.filter((row) => row._attendance_id || row.Date).length;
      const covered = leaveCoverageView === 'summary'
        ? sum('Covered Classes')
        : analyticsRows.filter((row) => String(row['Coverage Status'] || '').toLowerCase() === 'covered').length;
      const uncovered = leaveCoverageView === 'summary'
        ? sum('Uncovered Classes')
        : analyticsRows.filter((row) => String(row['Coverage Status'] || '').toLowerCase() === 'uncovered').length;
      const coverageRate = affected > 0 ? `${((covered / affected) * 100).toFixed(1)}%` : 'N/A';
      return [
        metric('Recorded Leaves', recordedLeaves, 'Leave records in scope', 'bi-calendar2-heart', 'green'),
        metric('Affected Classes', affected, 'Classes inside leave dates', 'bi-journal-text', 'blue'),
        metric('Covered', covered, 'Substitute assigned', 'bi-person-check', 'green'),
        metric('Uncovered', uncovered, 'Needs substitute', 'bi-exclamation-triangle', 'red'),
        metric('Coverage', coverageRate, 'Covered affected classes', 'bi-pie-chart', 'purple'),
      ];
    }
    return [
      metric('Events', analyticsRows.length, 'Security records', 'bi-shield-check', 'green'),
      metric('Users', unique('User'), 'Unique actors', 'bi-people', 'blue'),
      metric('IP Addresses', unique('ip_address'), 'Recorded sources', 'bi-globe2', 'purple'),
      metric('Period', `${startDate || '—'} → ${endDate || '—'}`, 'Active date filter', 'bi-calendar-range', 'amber'),
    ];
  }, [analyticsRows, report, startDate, endDate, isAttendanceRecordsReport, leaveCoverageView]);

  const chartTitles = useMemo(() => {
    if (isAttendanceRecordsReport) return ['Overall Status', 'Activity by Room'];
    if (report === 'teacher_attendance_summary') return ['Attendance Distribution', chartData.barMode === 'late_minutes' ? 'Top Late Minutes' : 'Top Late Warnings'];
    if (report === 'classroom_utilization') return ['Hours by Room', 'Classes by Room'];
    if (report === 'leave_substitution') return ['Coverage Status', 'Leave Activity Trend'];
    if (report === 'attendance_logs') return ['Change Types', 'Changes by Date'];
    return ['Event Breakdown', 'Events by Date'];
  }, [report, chartData.barMode, isAttendanceRecordsReport]);

  const applyDatePreset = (days) => {
    const today = new Date().toISOString().slice(0, 10);
    const boundedEnd = isSemesterScopedReport && semester
      ? (today < semester.start_date ? semester.start_date : (today > semester.end_date ? semester.end_date : today))
      : today;
    const end = new Date(`${boundedEnd}T00:00:00`);
    const start = new Date(end);
    start.setDate(start.getDate() - Math.max(0, days - 1));
    const nextStart = start.toISOString().slice(0, 10);
    setStartDate(isSemesterScopedReport && semester?.start_date && nextStart < semester.start_date ? semester.start_date : nextStart);
    setEndDate(boundedEnd);
  };

  const selectSemester = (value) => {
    const selected = semesterOptions.find((option) => String(option.semester_id) === String(value)) || null;
    setSelectedSemesterId(selected ? String(selected.semester_id) : '');
    setSemester(selected);
    if (selected?.start_date) setStartDate(selected.start_date);
    if (selected?.end_date) setEndDate(selected.end_date);
  };

  const resetFilters = () => {
    setTeacherId('');
    setRoomId('');
    setBuildingId('');
    setFloorId('');
    setDepartmentId('');
    setProgramId('');
    setAttendanceStatus('');
    setWarningProgress('');
    setPenaltyStatus('');
    setSubstituteTeacherId('');
    setLeaveTypeId('');
    setCoverageStatus('');
    setLeaveStatus('');
    setTimeFrom('');
    setTimeTo('');
    if (isAttendanceRecordsReport) setAttendanceView('summary');
    if (isLeaveCoverageReport) setLeaveCoverageView('summary');
    if (isSemesterScopedReport) {
      const today = new Date().toISOString().slice(0, 10);
      const active = semesterOptions.find((option) => String(option.status || '').toLowerCase() === 'active' && today >= option.start_date && today <= option.end_date);
      if (active) selectSemester(String(active.semester_id));
      else selectSemester('');
    } else applyDatePreset(30);
  };

  return (
    <div className="report-dashboard-page">
      <div className="rp-page-head">
        <div><h1>System Reports</h1><p>Generate operational reports, review trends, and inspect individual records.</p></div>
        <div className="rp-head-actions">
          <button type="button" className="btn btn-sm btn-outline-secondary rp-export-btn" onClick={() => fetchReport()} disabled={loading || refreshing}><i className={`bi bi-arrow-clockwise me-1${loading || refreshing ? ' is-spinning' : ''}`}></i>{loading || refreshing ? 'Refreshing…' : 'Refresh'}</button>
          <button type="button" className="btn btn-sm btn-outline-success rp-export-btn" onClick={exportToExcel} disabled={!activeReportRows.length || Boolean(exporting)}><i className={`bi ${exporting === 'excel' ? 'bi-arrow-repeat is-spinning' : 'bi-file-earmark-excel'} me-1`}></i>{exporting === 'excel' ? 'Preparing…' : 'Excel'}</button>
          <button type="button" className="btn btn-sm btn-outline-danger rp-export-btn" onClick={exportToPDF} disabled={!activeReportRows.length || Boolean(exporting)}><i className={`bi ${exporting === 'pdf' ? 'bi-arrow-repeat is-spinning' : 'bi-file-earmark-pdf'} me-1`}></i>{exporting === 'pdf' ? 'Preparing…' : 'PDF'}</button>
        </div>
      </div>

      <div className="rp-filter-card">
        <div className="rp-filter-heading">
          <div><h5>Report Configuration</h5><p>Choose a report and narrow the records included.</p></div>
          <div className="rp-filter-tools">
            <div className="rp-date-presets"><button type="button" onClick={() => applyDatePreset(1)}>Today</button><button type="button" onClick={() => applyDatePreset(7)}>7 Days</button><button type="button" onClick={() => applyDatePreset(30)}>30 Days</button></div>
            <button type="button" className="rp-mobile-filter-toggle" aria-expanded={mobileFiltersOpen} aria-controls="report-filter-fields" onClick={() => setMobileFiltersOpen((value) => !value)}><i className={`bi ${mobileFiltersOpen ? 'bi-chevron-up' : 'bi-sliders'}`} />{mobileFiltersOpen ? 'Hide Filters' : 'Show Filters'}</button>
          </div>
        </div>
        <div id="report-filter-fields" className={`rp-filter-grid${mobileFiltersOpen ? ' is-mobile-open' : ''}`} style={{ '--rp-filter-count': filterColumnCount }}>
          <label><span>Report Type</span><select value={report} onChange={(event) => { setReport(event.target.value); setTeacherId(''); setSubstituteTeacherId(''); setLeaveTypeId(''); setCoverageStatus(''); setLeaveStatus(''); setBuildingId(''); setFloorId(''); setRoomId(''); setAttendanceStatus(''); setWarningProgress(''); setPenaltyStatus(''); }}>{reportOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          {isSemesterScopedReport && <label><span>Semester</span><select value={selectedSemesterId} onChange={(event) => selectSemester(event.target.value)}><option value="">{semesterOptions.length ? 'Select semester' : 'No semesters available'}</option>{semesterOptions.map((option) => <option key={option.semester_id} value={option.semester_id}>{[option.session_name, option.term].filter(Boolean).join(' · ') || `Semester #${option.semester_id}`}{String(option.status || '').toLowerCase() === 'active' ? ' (Active)' : ''}</option>)}</select></label>}
          {isAdmin && <label><span>Department</span><select value={departmentId} onChange={(event) => { setDepartmentId(event.target.value); setTeacherId(''); }}><option value="">All departments</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.label}</option>)}</select></label>}
          {showFixedDepartment && <label><span>Department Scope</span><input value={fixedDepartmentLabel} readOnly aria-label="Fixed department scope" /></label>}
          {showProgramFilter && <label><span>Program Scope</span>{programs.length > 1 ? <select value={programId} onChange={(event) => { setProgramId(event.target.value); setTeacherId(''); }}><option value="">All owned programs</option>{programs.map((program) => <option key={program.id} value={program.id}>{program.label}</option>)}</select> : <input value={programs[0]?.label || 'No owned programs'} readOnly aria-label="Fixed program scope" />}</label>}
          {showTeacherFilter && <label><span>{isLeaveCoverageReport ? 'Original Teacher' : isAttendanceRecordsReport ? 'Teacher' : 'User / Name'}</span><select value={teacherId} onChange={(event) => setTeacherId(event.target.value)}><option value="">{isLeaveCoverageReport ? 'All original teachers' : isAttendanceRecordsReport ? 'All teachers' : 'All users'}</option>{teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.label}</option>)}</select></label>}
          {showLeaveCoverageFilters && <label><span>Substitute Teacher</span><select value={substituteTeacherId} onChange={(event) => setSubstituteTeacherId(event.target.value)}><option value="">All substitute teachers</option>{teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.label}</option>)}</select></label>}
          {showLeaveCoverageFilters && <label><span>Leave Type</span><select value={leaveTypeId} onChange={(event) => setLeaveTypeId(event.target.value)}><option value="">All leave types</option>{leaveTypes.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}</select></label>}
          {showLeaveCoverageFilters && <label><span>Coverage Status</span><select value={coverageStatus} onChange={(event) => setCoverageStatus(event.target.value)}><option value="">All coverage statuses</option><option value="covered">Fully covered</option><option value="uncovered">Needs coverage</option><option value="no_classes">No affected classes</option></select></label>}
          {showLeaveCoverageFilters && <label><span>Leave Status</span><select value={leaveStatus} onChange={(event) => setLeaveStatus(event.target.value)}><option value="">All leave statuses</option><option value="recorded">Recorded</option><option value="voided">Voided</option><option value="pending">Pending</option></select></label>}
          {showTeacherSummaryFilters && <label><span>Warning Progress</span><select value={warningProgress} onChange={(event) => setWarningProgress(event.target.value)}><option value="">All warning levels</option><option value="ok">OK</option><option value="warning_1">Warning (1/3)</option><option value="warning_2">Warning (2/3)</option><option value="red_flag">Red Flag</option></select></label>}
          {showTeacherSummaryFilters && <label><span>Penalty Status</span><select value={penaltyStatus} onChange={(event) => setPenaltyStatus(event.target.value)}><option value="">All penalty statuses</option><option value="active">Active</option><option value="voided">Voided</option><option value="none">None</option></select></label>}
          {showLocationHierarchyFilters && <label><span>Building</span><select value={buildingId} onChange={(event) => { setBuildingId(event.target.value); setFloorId(''); setRoomId(''); }}><option value="">All buildings</option>{buildings.map((building) => <option key={building.id} value={building.id}>{building.label}</option>)}</select></label>}
          {showLocationHierarchyFilters && <label><span>Floor</span><select value={floorId} onChange={(event) => { setFloorId(event.target.value); setRoomId(''); }} disabled={!buildingId}><option value="">{buildingId ? 'All floors' : 'Select a building first'}</option>{availableFloors.map((floor) => <option key={floor.id} value={floor.id}>{floor.label}</option>)}</select></label>}
          {showRoomFilter && <label><span>Room</span><select value={roomId} onChange={(event) => setRoomId(event.target.value)} disabled={showLocationHierarchyFilters && !floorId}><option value="">{showLocationHierarchyFilters && !floorId ? 'Select a floor first' : 'All rooms'}</option>{availableRooms.map((room) => <option key={room.id} value={room.id}>{room.label}</option>)}</select></label>}
          {showAttendanceStatusFilter && <label><span>Overall Status</span><select value={attendanceStatus} onChange={(event) => setAttendanceStatus(event.target.value)}><option value="">All statuses</option><option value="present">Present</option><option value="late">Late</option><option value="absent">Absent</option><option value="incomplete">Partial Attendance</option><option value="upcoming">Upcoming</option><option value="pending">Pending</option><option value="substituted">Substituted</option><option value="on_leave">On Leave</option><option value="other">Other</option></select></label>}
          <label><span>From</span><input type="date" value={startDate} min={isSemesterScopedReport ? (semester?.start_date || undefined) : undefined} max={isSemesterScopedReport ? ([endDate, semester?.end_date].filter(Boolean).sort()[0] || undefined) : (endDate || undefined)} onChange={(event) => setStartDate(event.target.value)} /></label>
          <label><span>To</span><input type="date" value={endDate} min={isSemesterScopedReport ? ([startDate, semester?.start_date].filter(Boolean).sort().slice(-1)[0] || undefined) : (startDate || undefined)} max={isSemesterScopedReport ? (semester?.end_date || undefined) : undefined} onChange={(event) => setEndDate(event.target.value)} /></label>
          {isAttendanceRecordsReport && <label><span>Time From</span><input type="time" value={timeFrom} max={timeTo || undefined} onChange={(event) => setTimeFrom(event.target.value)} /></label>}
          {isAttendanceRecordsReport && <label><span>Time To</span><input type="time" value={timeTo} min={timeFrom || undefined} onChange={(event) => setTimeTo(event.target.value)} /></label>}
          <button type="button" className="rp-reset-filter" onClick={resetFilters}><i className="bi bi-arrow-counterclockwise"></i>Reset</button>
        </div>
      </div>

      <div className="rp-report-title"><div><small>Active Report</small><h2>{reportMeta[0]}</h2><p>{reportMeta[1]}</p></div><div className="rp-report-scopes">{isSemesterScopedReport && <span className={semester ? '' : 'is-empty'}><i className="bi bi-journal-bookmark"></i>{semesterLabel}</span>}{showLocationHierarchyFilters && buildingId && <span><i className="bi bi-building"></i>{buildingScopeLabel}</span>}{showLocationHierarchyFilters && floorId && <span><i className="bi bi-layers"></i>{floorScopeLabel}</span>}{showLocationHierarchyFilters && roomId && <span><i className="bi bi-door-open"></i>{roomScopeLabel}</span>}<span>{startDate || 'Beginning'} <i className="bi bi-arrow-right"></i> {endDate || 'Today'}</span></div></div>

      {isAttendanceRecordsReport && (
        <div className="rp-attendance-view-bar">
          <div><small>Attendance Display</small><strong>{attendanceView === 'summary' ? 'Summary View' : 'Detailed View'}</strong><span>{attendanceView === 'summary' ? 'One row per teacher. Click a teacher to open the complete records.' : 'Dates, schedules, rooms, attendance stages, and timestamps.'}</span></div>
          <div className="rp-attendance-view-toggle" role="group" aria-label="Attendance report view">
            <button type="button" className={attendanceView === 'summary' ? 'is-active' : ''} aria-pressed={attendanceView === 'summary'} onClick={() => { setSelectedRow(null); setAttendanceView('summary'); }}><i className="bi bi-people"></i>Summary View</button>
            <button type="button" className={attendanceView === 'detailed' ? 'is-active' : ''} aria-pressed={attendanceView === 'detailed'} onClick={() => { setSelectedRow(null); setAttendanceView('detailed'); }}><i className="bi bi-table"></i>Detailed View</button>
          </div>
        </div>
      )}

      {isLeaveCoverageReport && (
        <div className="rp-attendance-view-bar">
          <div><small>Coverage Display</small><strong>{leaveCoverageView === 'summary' ? 'Summary View' : 'Detailed View'}</strong><span>{leaveCoverageView === 'summary' ? 'One row per recorded leave with affected, covered, and uncovered class totals.' : 'One row per affected class with its schedule, room, substitute, and coverage status.'}</span></div>
          <div className="rp-attendance-view-toggle" role="group" aria-label="Leave and substitution coverage report view">
            <button type="button" className={leaveCoverageView === 'summary' ? 'is-active' : ''} aria-pressed={leaveCoverageView === 'summary'} onClick={() => { setSelectedRow(null); setLeaveCoverageView('summary'); }}><i className="bi bi-card-checklist"></i>Summary View</button>
            <button type="button" className={leaveCoverageView === 'detailed' ? 'is-active' : ''} aria-pressed={leaveCoverageView === 'detailed'} onClick={() => { setSelectedRow(null); setLeaveCoverageView('detailed'); }}><i className="bi bi-table"></i>Detailed View</button>
          </div>
        </div>
      )}

      <div className={`rp-metrics-grid${isAttendanceRecordsReport || isLeaveCoverageReport ? ' is-five' : ''}`}>
        {metrics.map((item) => <div className="rp-metric-card" key={item.label}><span className={`is-${item.tone}`}><i className={`bi ${item.icon}`}></i></span><div><small>{item.label}</small><strong title={loading ? 'Loading' : String(item.value)}>{loading ? '—' : item.value}</strong><em>{item.note}</em></div></div>)}
      </div>

      {error && <div className="alert alert-danger mb-0"><i className="bi bi-exclamation-circle me-2"></i>{error}</div>}

      <button type="button" className="rp-mobile-section-toggle" aria-expanded={mobileAnalyticsOpen} aria-controls="report-analytics" onClick={() => setMobileAnalyticsOpen((value) => !value)}><span><i className="bi bi-bar-chart" />Report Charts</span><span>{mobileAnalyticsOpen ? 'Hide' : 'Show'}<i className={`bi ${mobileAnalyticsOpen ? 'bi-chevron-up' : 'bi-chevron-down'}`} /></span></button>

      <div id="report-analytics" className={`rp-analytics-grid${mobileAnalyticsOpen ? ' is-mobile-open' : ''}`}>
        <div className="rp-chart-card"><div className="rp-card-heading"><div><small>Distribution</small><h5>{chartTitles[0]}</h5></div><i className="bi bi-pie-chart"></i></div><div className="rp-chart-body">{loading ? <div className="rp-no-data"><span className="spinner-border spinner-border-sm text-success"></span>Loading chart…</div> : analyticsRows.length && chartData.pie.length ? <DonutChart data={chartData.pie} colors={["#16a34a", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#0d9488"]} colorForLabel={(isAttendanceRecordsReport || report === 'teacher_attendance_summary') ? (label) => attendanceStatusVisual(label).color : null} title="" /> : <div className="rp-no-data"><i className="bi bi-bar-chart"></i>No chart data available.</div>}</div></div>
        <div className="rp-chart-card"><div className="rp-card-heading"><div><small>Comparison</small><h5>{chartTitles[1]}</h5></div><i className="bi bi-graph-up"></i></div><div className="rp-chart-body">{loading ? <div className="rp-no-data"><span className="spinner-border spinner-border-sm text-success"></span>Loading chart…</div> : analyticsRows.length && chartData.bar.length ? <BarChart data={chartData.bar} color="#168246" title="" /> : <div className="rp-no-data"><i className="bi bi-bar-chart"></i>No chart data available.</div>}</div></div>
      </div>

      <div id="report-printable-area" className="rp-results-card">
        <div className="rp-results-head"><div><small>Report Data</small><h5>{activeReportTitle || reportMeta[0]}</h5><p>{isAttendanceRecordsReport && attendanceView === 'summary' ? 'Click a teacher to open their complete attendance records.' : isLeaveCoverageReport && leaveCoverageView === 'summary' ? 'Each row represents one recorded leave and its class coverage.' : 'Select a row to inspect all available fields.'}</p></div><span>{loading ? 'Loading…' : `${Number(reportPagination.total || 0)} record${Number(reportPagination.total || 0) === 1 ? '' : 's'}`}</span></div>
        {isAttendanceRecordsReport && attendanceView === 'detailed'
          ? <GroupedAttendanceTable rows={activeReportRows} loading={loading} onRowClick={setSelectedRow} serverPagination={reportPagination} onPageChange={setReportPage} />
          : <>
              <div className="rp-desktop-report-table"><Table columns={activeReportColumns} data={activeReportRows} loading={loading} pageSize={Number(reportPagination.page_size || 15)} wrapCells={report === 'teacher_attendance_summary' || isLeaveCoverageReport} rowKey={(row, index) => row.log_id || row._teacherId || row._leave_id || row['#'] || `${report}-${index}`} onRowClick={isAttendanceRecordsReport ? openAttendanceSummary : setSelectedRow} emptyText={loading ? 'Loading report…' : 'No records found. Try adjusting the filters.'} serverPagination totalItems={Number(reportPagination.total || 0)} page={reportPage} onPageChange={setReportPage} /></div>
              <MobileReportCards rows={activeReportRows} columns={activeReportColumns} loading={loading} onRowClick={isAttendanceRecordsReport ? openAttendanceSummary : setSelectedRow} emptyText={loading ? 'Loading report…' : 'No records found. Try adjusting the filters.'} serverPagination={reportPagination} onPageChange={setReportPage} />
            </>}
      </div>

      <ReportDetailsDrawer row={selectedRow} columns={activeReportColumns} onClose={() => setSelectedRow(null)} />

      {pdfPreview && typeof document !== 'undefined' ? ReactDOM.createPortal((
        <div className="rp-pdf-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePdfPreview(); }}>
          <section className={`rp-pdf-preview-dialog${pdfPreviewFullscreen ? ' is-fullscreen' : ''}`} role="dialog" aria-modal="true" aria-labelledby="rp-pdf-preview-title">
            <header className="rp-pdf-preview-head">
              <div>
                <small>PDF Preview</small>
                <h2 id="rp-pdf-preview-title">{pdfPreview.title}</h2>
                <p>This is the exact PDF file that will be downloaded.</p>
              </div>
              <button type="button" className="rp-pdf-preview-close" onClick={closePdfPreview} aria-label="Close PDF preview"><i className="bi bi-x-lg"></i></button>
            </header>
            <div className="rp-pdf-preview-toolbar">
              <div className="rp-pdf-preview-summary" aria-live="polite">
                <strong>{pdfPreview.recordCount || 0}</strong> {pdfPreview.recordLabel || 'records'} · <strong>{pdfPreview.fieldCount || 0}</strong> fields
                <span>Actual generated PDF</span>
              </div>
              <div className="rp-pdf-preview-tools">
                <button type="button" className="rp-pdf-fullscreen-btn" onClick={() => setPdfPreviewFullscreen((value) => !value)} aria-pressed={pdfPreviewFullscreen}>
                  <i className={`bi ${pdfPreviewFullscreen ? 'bi-fullscreen-exit' : 'bi-arrows-fullscreen'}`}></i>{pdfPreviewFullscreen ? 'Exit full screen' : 'Full screen'}
                </button>
              </div>
            </div>
            <div className="rp-pdf-preview-body">
              {isMobileLayout ? (
                <div className="rp-mobile-pdf-ready">
                  <span className="rp-mobile-pdf-ready-icon" aria-hidden="true"><i className="bi bi-file-earmark-pdf" /></span>
                  <div><small>PDF generated successfully</small><h3>Your report is ready</h3><p>Mobile browsers cannot reliably display this PDF inside the page. Open it in your phone&apos;s PDF viewer or download a copy.</p></div>
                  <div className="rp-mobile-pdf-ready-actions">
                    <a className="btn btn-success" href={pdfPreview.url} target="_blank" rel="noopener noreferrer"><i className="bi bi-box-arrow-up-right me-2" />Open PDF</a>
                    <a className="btn btn-outline-success" href={pdfPreview.url} download={pdfPreview.filename}><i className="bi bi-download me-2" />Download PDF</a>
                  </div>
                </div>
              ) : <iframe className="rp-pdf-preview-frame" src={`${pdfPreview.url}#toolbar=1&navpanes=0&view=FitH`} title={`${pdfPreview.title} PDF preview`} />}
            </div>
            {isMobileLayout ? (
              <footer className="rp-pdf-preview-actions is-mobile">
                <button type="button" className="btn btn-outline-secondary" onClick={closePdfPreview}>Close Preview</button>
              </footer>
            ) : (
              <footer className="rp-pdf-preview-actions">
                <div className="rp-pdf-preview-confirmation"><i className="bi bi-eye"></i>Review the PDF above before downloading.</div>
                <div className="rp-pdf-preview-download-actions">
                  <button type="button" className="btn btn-outline-secondary" onClick={closePdfPreview}>Close</button>
                  <a className="btn btn-success" href={pdfPreview.url} download={pdfPreview.filename}><i className="bi bi-download me-2"></i>Download PDF</a>
                </div>
              </footer>
            )}
          </section>
        </div>
      ), document.body) : null}
    </div>
  );
}
