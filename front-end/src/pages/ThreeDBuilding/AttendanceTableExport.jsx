import React from 'react';
import ReactDOM from 'react-dom';
import '../Report/index.css';

const EXPORT_COLUMNS = [
  { key: 'teacher', label: 'Teacher' },
  { key: 'date', label: 'Date' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'room', label: 'Room' },
  { key: 'scheduled_time', label: 'Scheduled Time' },
  { key: 'check_in_status', label: 'Check In Status' },
  { key: 'check_in_timestamp', label: 'Check In Timestamp' },
  { key: 'mid_check_status', label: 'Mid Check Status' },
  { key: 'mid_check_timestamp', label: 'Mid Check Timestamp' },
  { key: 'check_out_status', label: 'Check Out Status' },
  { key: 'check_out_timestamp', label: 'Check Out Timestamp' },
  { key: 'overall_status', label: 'Overall Status' },
];

const STATUS_LABELS = {
  PRESENT: 'Present',
  LATE: 'Late',
  ABSENT: 'Absent',
  PENDING: 'Pending',
  UPCOMING: 'Upcoming',
  ON_LEAVE: 'On Leave',
  SUBSTITUTED: 'Substituted',
  INCOMPLETE: 'Partial Attendance',
};

function normalizedStatus(value) {
  const normalized = String(value || 'PENDING').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return STATUS_LABELS[normalized] ? normalized : 'PENDING';
}

function checkpointStatus(flagId, flagName) {
  const named = String(flagName || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (STATUS_LABELS[named]) return named;
  const byId = { 1: 'UPCOMING', 2: 'PRESENT', 3: 'ABSENT', 4: 'SUBSTITUTED', 5: 'LATE', 7: 'ON_LEAVE' };
  return byId[Number(flagId || 0)] || 'PENDING';
}

function statusLabel(value) {
  return STATUS_LABELS[normalizedStatus(value)] || 'Pending';
}

function overallCheckpointStatus(statuses, recordStatus) {
  const specialStatus = normalizedStatus(recordStatus);
  if (specialStatus === 'ON_LEAVE' || specialStatus === 'SUBSTITUTED') return specialStatus;
  const counts = statuses.reduce((result, status) => {
    const normalized = normalizedStatus(status);
    result[normalized] = (result[normalized] || 0) + 1;
    return result;
  }, {});
  const winner = Object.entries(counts).find(([, count]) => count >= 2);
  return winner ? winner[0] : 'INCOMPLETE';
}

function formatClock(value) {
  const raw = String(value || '').trim();
  if (!raw) return '--:--';
  const match = raw.match(/(?:T|\s|^)(\d{1,2}):(\d{2})/);
  if (!match) return raw;
  let hour = Number(match[1]);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour %= 12;
  if (!hour) hour = 12;
  return `${hour}:${match[2]} ${suffix}`;
}

function formatTimestamp(value) {
  if (!value) return '—';
  const raw = String(value).trim();
  const parsed = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDate(value) {
  const raw = String(value || '').slice(0, 10);
  if (!raw) return '—';
  const parsed = new Date(`${raw}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function localDateKey(value = new Date()) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function statusTone(value) {
  const status = normalizedStatus(value);
  if (status === 'PRESENT') return 'success';
  if (status === 'ABSENT') return 'danger';
  if (status === 'LATE' || status === 'PENDING') return 'warning';
  if (status === 'ON_LEAVE') return 'leave';
  if (status === 'SUBSTITUTED') return 'substituted';
  if (status === 'INCOMPLETE') return 'incomplete';
  return 'upcoming';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function exportRow(record) {
  const checkIn = checkpointStatus(record.flag_in_id, record.flag_in_name);
  const midCheck = checkpointStatus(record.flag_check_id, record.flag_check_name);
  const checkOut = checkpointStatus(record.flag_out_id, record.flag_out_name);
  const overallStatus = overallCheckpointStatus([checkIn, midCheck, checkOut], record.status || record.attendance_status);
  const subjectCode = String(record.subject_code || record.subject || '').trim().split(/\s+/)[0] || '';
  const schedule = [subjectCode, record.section_name].filter(Boolean).join(' / ') || 'Not specified';
  const room = record.room_name || 'Not specified';
  return {
    teacher: record.teacher_name || 'Teacher',
    date: formatDate(record.date),
    schedule,
    room,
    scheduled_time: `${formatClock(record.start_time)} - ${formatClock(record.end_time)}`,
    check_in_status: statusLabel(checkIn),
    check_in_timestamp: formatTimestamp(record.time_in),
    mid_check_status: statusLabel(midCheck),
    mid_check_timestamp: formatTimestamp(record.time_check),
    check_out_status: statusLabel(checkOut),
    check_out_timestamp: formatTimestamp(record.time_out),
    overall_status: statusLabel(overallStatus),
  };
}

function AttendanceTableExport({ records = [], loadRecords, dataMode = 'current', selectedDate = '', buildingLabel = 'All buildings', floorLabel = 'All floors' }) {
  const [exporting, setExporting] = React.useState('');
  const [preview, setPreview] = React.useState(null);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [isMobileLayout, setIsMobileLayout] = React.useState(() => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 767.98px)').matches
  ));
  const previewUrlRef = React.useRef('');
  const visibleRows = React.useMemo(() => records.map(exportRow), [records]);
  const reportDate = dataMode === 'records'
    ? (selectedDate || localDateKey())
    : (String(records[0]?.date || '').slice(0, 10) || localDateKey());
  const title = dataMode === 'current' ? 'Current Classes - Detailed Attendance' : 'Attendance Records - Detailed';
  const safeFileTitle = title.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_');

  React.useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const media = window.matchMedia('(max-width: 767.98px)');
    const update = () => setIsMobileLayout(media.matches);
    update();
    if (media.addEventListener) media.addEventListener('change', update);
    else media.addListener(update);
    return () => {
      if (media.removeEventListener) media.removeEventListener('change', update);
      else media.removeListener(update);
    };
  }, []);

  React.useEffect(() => {
    if (!preview) return undefined;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closePreview();
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [preview]);

  function closePreview() {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = '';
    setPreview(null);
    setFullscreen(false);
  }

  async function resolveExportRows() {
    const source = typeof loadRecords === 'function' ? await loadRecords() : records;
    return (Array.isArray(source) ? source : []).map(exportRow);
  }

  async function exportExcel() {
    const XLSX = window.XLSX;
    if (!XLSX) { window.alert('SheetJS not loaded. Please refresh and try again.'); return; }
    if (!visibleRows.length || exporting) return;
    setExporting('excel');
    await new Promise((resolve) => setTimeout(resolve, 40));
    try {
      const rows = await resolveExportRows();
      if (!rows.length) throw new Error('There are no filtered records to export.');
      const safeCell = (value) => /^[=+\-@]/.test(String(value ?? '')) ? `'${String(value ?? '')}` : String(value ?? '');
      const headings = ['#', ...EXPORT_COLUMNS.map((column) => column.label)];
      const dataRows = rows.map((row, index) => [index + 1, ...EXPORT_COLUMNS.map((column) => safeCell(row[column.key]))]);
      const worksheetRows = [
        [title],
        ['Record date', formatDate(reportDate)],
        ['View', dataMode === 'current' ? 'Current Classes' : 'Date Records'],
        ['Building scope', buildingLabel],
        ['Floor scope', floorLabel],
        ['Generated', new Date().toLocaleString(), '', 'Records', rows.length],
        [],
        headings,
        ...dataRows,
      ];
      const headerRowIndex = 7;
      const ws = XLSX.utils.aoa_to_sheet(worksheetRows);
      const lastColumn = headings.length - 1;
      ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: lastColumn } }];
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: headerRowIndex, c: 0 }, e: { r: headerRowIndex, c: lastColumn } }) };
      ws['!freeze'] = { xSplit: 0, ySplit: headerRowIndex + 1, topLeftCell: `A${headerRowIndex + 2}`, activePane: 'bottomLeft', state: 'frozen' };
      ws['!rows'] = worksheetRows.map((_, index) => ({ hpt: index === 0 ? 26 : index === headerRowIndex ? 24 : index === headerRowIndex - 1 ? 8 : 19 }));
      ws['!cols'] = headings.map((heading, columnIndex) => {
        if (columnIndex === 0) return { wch: 7 };
        const lengths = dataRows.slice(0, 250).map((row) => String(row[columnIndex] ?? '').length);
        const minimum = /timestamp|date|time/i.test(heading) ? 20 : 14;
        return { wch: Math.min(42, Math.max(minimum, heading.length + 2, ...lengths.map((length) => Math.min(length + 2, 42)))) };
      });
      const wb = XLSX.utils.book_new();
      wb.Props = { Title: title, Subject: 'Attendance report', Author: 'System Reports', CreatedDate: new Date() };
      XLSX.utils.book_append_sheet(wb, ws, String(title).slice(0, 31));
      XLSX.writeFile(wb, `${safeFileTitle}_${reportDate}.xlsx`);
    } catch (error) {
      console.error('Table View Excel export failed', error);
      window.alert('The Excel report could not be generated. Please try again.');
    } finally {
      setExporting('');
    }
  }

  async function exportPdf() {
    const html2pdf = window.html2pdf;
    if (!html2pdf) { window.alert('PDF preview is unavailable because the PDF library did not load. Please refresh and try again.'); return; }
    if (!visibleRows.length || exporting) return;
    setExporting('pdf');

    let rows = [];
    try {
      rows = await resolveExportRows();
      if (!rows.length) throw new Error('There are no filtered records to export.');
    } catch (error) {
      console.error('Unable to load all filtered attendance rows for PDF export', error);
      window.alert('The filtered records could not be loaded for export. Please try again.');
      setExporting('');
      return;
    }

    const repeatedColumns = EXPORT_COLUMNS.slice(0, 2);
    const detailColumns = EXPORT_COLUMNS.slice(2);
    const chunks = [];
    for (let index = 0; index < detailColumns.length; index += 10) chunks.push([...repeatedColumns, ...detailColumns.slice(index, index + 10)]);
    const sections = chunks.map((columns, sectionIndex) => {
      const columnWidth = (100 / (columns.length + 1)).toFixed(2);
      const colgroup = `<colgroup>${Array(columns.length + 1).fill(`<col style="width:${columnWidth}%">`).join('')}</colgroup>`;
      const headers = ['<th>#</th>', ...columns.map((column) => `<th>${escapeHtml(column.label)}</th>`)].join('');
      const body = rows.map((row, rowIndex) => {
        const cells = columns.map((column) => {
          const value = row[column.key] || '—';
          const className = /status/.test(column.key) ? ` class="report-pdf-status is-${statusTone(value)}"` : /timestamp/.test(column.key) ? ' class="report-pdf-mono"' : '';
          return `<td${className}>${escapeHtml(value)}</td>`;
        }).join('');
        return `<tr><td class="report-pdf-row-index">${rowIndex + 1}</td>${cells}</tr>`;
      }).join('');
      const label = chunks.length > 1 ? `<div class="report-pdf-section-label">Attendance details — section ${sectionIndex + 1} of ${chunks.length} — Teacher and Date repeated for reference</div>` : '';
      return `<div class="report-pdf-section${sectionIndex ? ' section-break' : ''}">${label}<table class="report-pdf-table">${colgroup}<thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table></div>`;
    }).join('');

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:fixed;top:0;left:-100000px;width:1680px;max-width:none;overflow:visible;background:#fff;z-index:-1;pointer-events:none';
    wrapper.setAttribute('aria-hidden', 'true');
    wrapper.innerHTML = `
      <style>
        .report-pdf-root,.report-pdf-root *{box-sizing:border-box}.report-pdf-root{width:100%;margin:0 auto;overflow:visible;font-family:Arial,sans-serif;color:#172033;padding:18px;background:#fff;transform:translateX(-4.5%);transform-origin:top center}.report-pdf-header{width:90%;margin:0 auto;display:flex;justify-content:space-between;align-items:flex-end;gap:18px;padding:16px 18px;border-left:7px solid #15803d;background:#f0fdf4}.report-pdf-kicker{margin:0 0 4px;color:#15803d;font-size:10px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase}.report-pdf-title{font-size:22px;font-weight:700;margin:0 0 5px}.report-pdf-meta{font-size:11px;color:#64748b;margin:0}.report-pdf-summary{padding:8px 11px;border:1px solid #bbf7d0;border-radius:6px;color:#166534;font-size:11px;font-weight:700;white-space:nowrap;background:#fff}.report-pdf-user{width:90%;margin:0 auto;display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:11px 14px;border:1px solid #dbe8df;border-top:0}.report-pdf-user span{display:block;margin-bottom:3px;color:#64748b;font-size:8px;font-weight:700;letter-spacing:.7px;text-transform:uppercase}.report-pdf-user strong{font-size:11px}.report-pdf-section{width:100%;margin:8px auto 0;overflow:hidden}.report-pdf-section.section-break{page-break-before:always}.report-pdf-section-label{font-size:12px;font-weight:700;margin:8px 0 6px;color:#1f2937}.report-pdf-table{width:100%;margin-left:auto;margin-right:auto;border-collapse:collapse;table-layout:fixed;font-size:13.5px;transform:scale(.9);transform-origin:top center}.report-pdf-table thead{display:table-header-group}.report-pdf-table tr{page-break-inside:avoid}.report-pdf-table th,.report-pdf-table td{overflow:hidden;border:1px solid #dbe5de;padding:6px 7px;text-align:left;vertical-align:top;word-break:break-word;white-space:normal}.report-pdf-table th{color:#fff;background:#187a42;font-weight:700}.report-pdf-table tbody tr:nth-child(even) td{background:#f8faf9}.report-pdf-row-index{text-align:center;font-weight:600}.report-pdf-mono{font-family:Consolas,monospace;font-size:12px}.report-pdf-status{font-weight:700}.report-pdf-status.is-success{color:#166534}.report-pdf-status.is-warning{color:#a16207}.report-pdf-status.is-danger{color:#b91c1c}.report-pdf-status.is-leave{color:#0e7490}.report-pdf-status.is-incomplete,.report-pdf-status.is-substituted{color:#6d28d9}.report-pdf-status.is-upcoming{color:#64748b}
      </style>
      <div class="report-pdf-root"><div class="report-pdf-header"><div><p class="report-pdf-kicker">System Reports</p><h2 class="report-pdf-title">${escapeHtml(title)}</h2><p class="report-pdf-meta">${escapeHtml(formatDate(reportDate))} &nbsp;•&nbsp; ${escapeHtml(dataMode === 'current' ? 'Current Classes' : 'Date Records')} &nbsp;•&nbsp; Generated ${escapeHtml(new Date().toLocaleString())}</p></div><div class="report-pdf-summary">${rows.length} record${rows.length === 1 ? '' : 's'}</div></div><div class="report-pdf-user"><div><span>Building Scope</span><strong>${escapeHtml(buildingLabel)}</strong></div><div><span>Floor Scope</span><strong>${escapeHtml(floorLabel)}</strong></div><div><span>Export Scope</span><strong>All filtered records</strong></div></div>${sections}</div>`;
    document.body.appendChild(wrapper);

    html2pdf().set({
      margin: [8, 8, 8, 8],
      filename: `${safeFileTitle}_${reportDate}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 1.5, useCORS: true, allowTaint: true, scrollX: 0, scrollY: 0, windowWidth: 1680, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a3', orientation: 'landscape' },
      pagebreak: { mode: ['css', 'legacy'] },
    }).from(wrapper.querySelector('.report-pdf-root')).outputPdf('blob').then((blob) => {
      if (!(blob instanceof Blob)) throw new Error('The generated PDF is invalid.');
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;
      setPreview({ url, filename: `${safeFileTitle}_${reportDate}.pdf`, recordCount: rows.length });
      setFullscreen(false);
    }).catch((error) => {
      console.error('Table View PDF preview failed', error);
      window.alert('The PDF preview could not be generated. Please try again.');
    }).finally(() => {
      if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
      setExporting('');
    });
  }

  return (
    <>
      <div className="tdb-table-export-actions" aria-label="Export attendance table">
        <button type="button" className="btn btn-sm btn-outline-success rp-export-btn" onClick={exportExcel} disabled={!visibleRows.length || Boolean(exporting)}><i className={`bi ${exporting === 'excel' ? 'bi-arrow-repeat is-spinning' : 'bi-file-earmark-excel'} me-1`} />{exporting === 'excel' ? 'Preparing…' : 'Excel'}</button>
        <button type="button" className="btn btn-sm btn-outline-danger rp-export-btn" onClick={exportPdf} disabled={!visibleRows.length || Boolean(exporting)}><i className={`bi ${exporting === 'pdf' ? 'bi-arrow-repeat is-spinning' : 'bi-file-earmark-pdf'} me-1`} />{exporting === 'pdf' ? 'Preparing…' : 'PDF'}</button>
      </div>

      {preview && ReactDOM.createPortal((
        <div className="rp-pdf-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePreview(); }}>
          <section className={`rp-pdf-preview-dialog${fullscreen ? ' is-fullscreen' : ''}`} role="dialog" aria-modal="true" aria-labelledby="tdb-pdf-preview-title">
            <header className="rp-pdf-preview-head"><div><small>PDF Preview</small><h2 id="tdb-pdf-preview-title">{title}</h2><p>This is the exact PDF file that will be downloaded.</p></div><button type="button" className="rp-pdf-preview-close" onClick={closePreview} aria-label="Close PDF preview"><i className="bi bi-x-lg" /></button></header>
            <div className="rp-pdf-preview-toolbar"><div className="rp-pdf-preview-summary" aria-live="polite"><strong>{preview.recordCount || 0}</strong> records · <strong>{EXPORT_COLUMNS.length}</strong> fields<span>Actual generated PDF</span></div><div className="rp-pdf-preview-tools"><button type="button" className="rp-pdf-fullscreen-btn" onClick={() => setFullscreen((value) => !value)} aria-pressed={fullscreen}><i className={`bi ${fullscreen ? 'bi-fullscreen-exit' : 'bi-arrows-fullscreen'}`} />{fullscreen ? 'Exit full screen' : 'Full screen'}</button></div></div>
            <div className="rp-pdf-preview-body">
              {isMobileLayout ? (
                <div className="rp-mobile-pdf-ready">
                  <span className="rp-mobile-pdf-ready-icon" aria-hidden="true"><i className="bi bi-file-earmark-pdf" /></span>
                  <div><small>PDF generated successfully</small><h3>Your 3D attendance report is ready</h3><p>Mobile browsers cannot reliably display this PDF inside the page. Open it in your phone&apos;s PDF viewer or download a copy.</p></div>
                  <div className="rp-mobile-pdf-ready-actions">
                    <a className="btn btn-success" href={preview.url} target="_blank" rel="noopener noreferrer"><i className="bi bi-box-arrow-up-right me-2" />Open PDF</a>
                    <a className="btn btn-outline-success" href={preview.url} download={preview.filename}><i className="bi bi-download me-2" />Download PDF</a>
                  </div>
                </div>
              ) : <iframe className="rp-pdf-preview-frame" src={`${preview.url}#toolbar=1&navpanes=0&view=FitH`} title={`${title} PDF preview`} />}
            </div>
            {isMobileLayout ? (
              <footer className="rp-pdf-preview-actions is-mobile">
                <button type="button" className="btn btn-outline-secondary" onClick={closePreview}>Close Preview</button>
              </footer>
            ) : (
              <footer className="rp-pdf-preview-actions"><div className="rp-pdf-preview-confirmation"><i className="bi bi-eye" />Review the PDF above before downloading.</div><div className="rp-pdf-preview-download-actions"><button type="button" className="btn btn-outline-secondary" onClick={closePreview}>Close</button><a className="btn btn-success" href={preview.url} download={preview.filename}><i className="bi bi-download me-2" />Download PDF</a></div></footer>
            )}
          </section>
        </div>
      ), document.body)}
    </>
  );
}

export default AttendanceTableExport;
