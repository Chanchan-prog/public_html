import React from 'react';
import { apiDelete, apiGet, apiPost, apiPut } from '../../services/api.js';
import Table from '../../components/Table.jsx';
import Modal from '../../components/Modal.jsx';
import { MasterPageHeader, MasterResults, MasterSearch, MasterSelect, MasterStats, MasterToolbar } from '../../components/MasterDataPage.jsx';

const today = () => {
  const value = new Date();
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
};
const emptyForm = { title: '', event_type: 'holiday', date_from: today(), date_to: today(), dept_id: '', program_id: '', description: '' };

export default function CalendarEventsIndex() {
  const currentUser = React.useMemo(() => { try { return JSON.parse(localStorage.getItem('user') || 'null') || {}; } catch (_) { return {}; } }, []);
  const isAdmin = Number(currentUser.role_id) === 1;
  const ownDeptId = String(currentUser.dept_id || '');
  const [items, setItems] = React.useState([]);
  const [departments, setDepartments] = React.useState([]);
  const [programs, setPrograms] = React.useState([]);
  const [stats, setStats] = React.useState({ active: 0, cancelled: 0 });
  const [status, setStatus] = React.useState('active');
  const [type, setType] = React.useState('all');
  const [search, setSearch] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [modal, setModal] = React.useState(false);
  const [editing, setEditing] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewData, setPreviewData] = React.useState({ affected_class_count: 0, overlaps: [] });
  const [viewMode, setViewMode] = React.useState('table');
  const [calendarDate, setCalendarDate] = React.useState(() => new Date());
  const [calendarItems, setCalendarItems] = React.useState([]);
  const [calendarLoading, setCalendarLoading] = React.useState(false);
  const [selectedCalendarItem, setSelectedCalendarItem] = React.useState(null);
  const [form, setForm] = React.useState({ ...emptyForm, dept_id: isAdmin ? '' : ownDeptId });

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ page: String(page), page_size: '10', status, event_type: type, q: search });
      const result = await apiGet(`calendar-events?${query}`);
      setItems(Array.isArray(result?.items) ? result.items : []);
      setStats(result?.stats || { active: 0, cancelled: 0 });
      setTotal(Number(result?.total || 0));
    } catch (error) {
      window.Swal?.fire('Unable to load', error?.body?.message || error.message || 'Please try again.', 'error');
    } finally { setLoading(false); }
  }, [page, status, type, search]);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => {
    if (viewMode !== 'calendar') return;
    const monthFrom = `${calendarDate.getFullYear()}-${String(calendarDate.getMonth() + 1).padStart(2, '0')}-01`;
    const monthTo = `${calendarDate.getFullYear()}-${String(calendarDate.getMonth() + 1).padStart(2, '0')}-${String(new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 0).getDate()).padStart(2, '0')}`;
    const query = new URLSearchParams({ page: '1', page_size: '200', status, event_type: type, q: search, date_from: monthFrom, date_to: monthTo });
    setCalendarLoading(true);
    apiGet(`calendar-events?${query}`).then(result => setCalendarItems(Array.isArray(result?.items) ? result.items : [])).catch(error => {
      setCalendarItems([]);
      window.Swal?.fire('Unable to load calendar', error?.body?.message || error.message || 'Please try again.', 'error');
    }).finally(() => setCalendarLoading(false));
  }, [viewMode, calendarDate, status, type, search]);
  React.useEffect(() => {
    Promise.all([apiGet('departments'), apiGet('programs')]).then(([d, p]) => {
      setDepartments((Array.isArray(d) ? d : []).filter(x => String(x.status).toLowerCase() === 'active'));
      setPrograms((Array.isArray(p) ? p : []).filter(x => String(x.status).toLowerCase() === 'active'));
    }).catch(() => {});
  }, []);

  const openForm = (item = null) => {
    setPreviewing(false);
    setPreviewData({ affected_class_count: 0, overlaps: [] });
    setEditing(item);
    setForm(item ? {
      title: item.title || '', event_type: item.event_type || 'event', date_from: item.date_from || today(), date_to: item.date_to || today(),
      dept_id: item.dept_id || (isAdmin ? '' : ownDeptId), program_id: item.program_id || '', description: item.description || ''
    } : { ...emptyForm, dept_id: isAdmin ? '' : ownDeptId });
    setModal(true);
  };

  const openPreview = async (event) => {
    event.preventDefault();
    setPreviewLoading(true);
    try {
      const result = await apiPost('calendar-events/preview', { ...form, event_id: editing?.event_id || undefined });
      setPreviewData({ affected_class_count: Number(result?.affected_class_count || 0), overlaps: Array.isArray(result?.overlaps) ? result.overlaps : [] });
      setPreviewing(true);
    } catch (error) {
      window.Swal?.fire('Unable to preview', error?.body?.message || error.message || 'Please check the form.', 'error');
    } finally { setPreviewLoading(false); }
  };

  const saveConfirmed = async () => {
    setSaving(true);
    try {
      if (editing) await apiPut(`calendar-events/${editing.event_id}`, form);
      else await apiPost('calendar-events', form);
      setModal(false); await load();
      window.Swal?.fire({ icon: 'success', title: editing ? 'Updated' : 'Created', text: 'Future matching classes are now shown as No Class.', timer: 1700, showConfirmButton: false });
    } catch (error) {
      window.Swal?.fire('Unable to save', error?.body?.message || error.message || 'Please check the form.', 'error');
    } finally { setSaving(false); }
  };

  const cancelEvent = async (item) => {
    const answer = window.Swal ? await window.Swal.fire({ title: 'Cancel this entry?', text: 'Future attendance generation will resume where no other event applies.', icon: 'warning', showCancelButton: true, confirmButtonText: 'Cancel entry' }) : { isConfirmed: window.confirm('Cancel this entry?') };
    if (!answer.isConfirmed) return;
    try { await apiDelete(`calendar-events/${item.event_id}`); await load(); window.Swal?.fire({ icon: 'success', title: 'Cancelled', timer: 1200, showConfirmButton: false }); }
    catch (error) { window.Swal?.fire('Unable to cancel', error?.body?.message || error.message || 'Please try again.', 'error'); }
  };

  const scopedPrograms = programs.filter(program => String(program.dept_id || '') === String(form.dept_id || ''));
  const selectedDepartment = departments.find(department => String(department.dept_id) === String(form.dept_id));
  const selectedProgram = programs.find(program => String(program.program_id) === String(form.program_id));
  const canChange = item => item.status === 'active' && item.date_from >= today() && (isAdmin || String(item.dept_id) === ownDeptId);
  const formatDate = value => {
    if (!value) return '—';
    const parsed = new Date(`${value}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const getScopeLabel = item => item.program_id ? 'Program-specific' : (item.dept_id ? 'Department-wide' : 'System-wide');
  const calendarYear = calendarDate.getFullYear();
  const calendarMonth = calendarDate.getMonth();
  const calendarMonthLabel = calendarDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const calendarCells = [
    ...Array.from({ length: new Date(calendarYear, calendarMonth, 1).getDay() }, (_, index) => ({ empty: true, key: `empty-${index}` })),
    ...Array.from({ length: new Date(calendarYear, calendarMonth + 1, 0).getDate() }, (_, index) => {
      const day = index + 1;
      const key = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return { day, key, items: calendarItems.filter(item => item.date_from <= key && item.date_to >= key) };
    })
  ];
  const columns = [
    { key: 'title', label: 'Holiday / Event', render: item => <div className="calendar-event-title-cell"><span className={`calendar-event-kind calendar-event-kind-${item.event_type}`}>{item.event_type === 'holiday' ? 'Holiday' : 'Event'}</span><strong>{item.title}</strong><small>{item.description || 'No description provided'}</small></div> },
    { key: 'date_range', label: 'Effective Date', render: item => <div className="calendar-event-date"><strong>{formatDate(item.date_from)}</strong>{item.date_from !== item.date_to ? <><span>to</span><strong>{formatDate(item.date_to)}</strong></> : <span>One day</span>}</div> },
    { key: 'scope', label: 'Applied Scope', render: item => <div className="calendar-event-scope"><span className={`calendar-event-scope-badge scope-${item.program_id ? 'program' : (item.dept_id ? 'department' : 'system')}`}>{getScopeLabel(item)}</span><strong>{item.dept_name || 'All departments'}</strong><span>{item.program_name || 'All programs'}</span></div> },
    { key: 'created_by_name', label: 'Ownership', render: item => <div className="calendar-event-ownership"><span>Created by</span><strong>{item.created_by_name?.trim() || 'System administrator'}</strong>{item.status === 'cancelled' ? <><span>Cancelled by</span><strong>{item.cancelled_by_name?.trim() || 'Unknown user'}</strong></> : null}</div> },
    { key: 'status', label: 'Status', render: item => <span className={`mdp-status mdp-status-${item.status === 'active' ? 'active' : 'archive'}`}>{item.status === 'active' ? 'Active' : 'Cancelled'}</span> },
    { key: 'actions', label: 'Actions', render: item => canChange(item) ? <div className="calendar-event-row-actions"><button type="button" onClick={() => openForm(item)}>Edit</button><button type="button" className="is-danger" onClick={() => cancelEvent(item)}>Cancel</button></div> : <span className="mdp-muted">Read only</span> }
  ];

  return <div className="mdp-page calendar-events-page">
    <MasterPageHeader
      eyebrow="Academic calendar"
      title="Holidays & Events"
      description="Plan non-class days by department or program while keeping attendance reports and totals unchanged."
      action={<button className="mdp-primary" onClick={() => openForm()}>+ Add Holiday or Event</button>}
    />

    <MasterStats loading={loading} items={[
      { label: 'Active', value: stats.active, help: 'Currently scheduled entries', icon: '✓', active: status === 'active', onClick: () => { setStatus('active'); setPage(1); } },
      { label: 'Cancelled', value: stats.cancelled, help: 'Retained for audit history', icon: '×', tone: 'red', active: status === 'cancelled', onClick: () => { setStatus('cancelled'); setPage(1); } }
    ]} />

    <div className="mdp-notice calendar-event-notice">
      <strong>No Class rule:</strong> matching future classes appear only in Attendance History. They are excluded from GPS attendance, dashboards, reports, and attendance totals.
    </div>

    <MasterToolbar>
      <MasterSearch value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="Search holiday or event..." />
      <MasterSelect label="Type" value={type} onChange={event => { setType(event.target.value); setPage(1); }}>
        <option value="all">All types</option><option value="holiday">Holiday</option><option value="event">Event</option>
      </MasterSelect>
      <MasterSelect label="Status" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}>
        <option value="active">Active</option><option value="cancelled">Cancelled</option>
      </MasterSelect>
    </MasterToolbar>

    <div className="calendar-event-view-switch" aria-label="Record view">
      <button type="button" className={viewMode === 'table' ? 'is-active' : ''} onClick={() => setViewMode('table')}>Table View</button>
      <button type="button" className={viewMode === 'calendar' ? 'is-active' : ''} onClick={() => setViewMode('calendar')}>Calendar View</button>
    </div>

    <MasterResults title={viewMode === 'calendar' ? calendarMonthLabel : (status === 'active' ? 'Upcoming Calendar Entries' : 'Cancelled Calendar Entries')} count={viewMode === 'calendar' ? calendarItems.length : total} loading={viewMode === 'calendar' ? calendarLoading : loading} description={viewMode === 'calendar' ? 'Monthly holiday and event coverage.' : 'Holiday and event coverage with its effective academic scope.'}>
      {viewMode === 'table' ? <Table columns={columns} data={items} loading={loading} emptyText="No holidays or events match the selected filters." rowKey="event_id" pageSize={10} serverPagination totalItems={total} page={page} onPageChange={setPage} horizontalScroll wrapCells className="calendar-events-table" /> : <div className="calendar-event-month-view">
        <div className="calendar-event-month-nav"><button type="button" onClick={() => setCalendarDate(new Date(calendarYear, calendarMonth - 1, 1))} aria-label="Previous month">‹</button><strong>{calendarMonthLabel}</strong><button type="button" onClick={() => setCalendarDate(new Date(calendarYear, calendarMonth + 1, 1))} aria-label="Next month">›</button></div>
        <div className="calendar-event-weekdays">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day => <span key={day}>{day}</span>)}</div>
        <div className="calendar-event-month-grid">{calendarCells.map(cell => cell.empty ? <div key={cell.key} className="is-empty" /> : <div key={cell.key} className={cell.key === today() ? 'is-today' : ''}><span className="calendar-event-day-number">{cell.day}</span><div className="calendar-event-day-items">{cell.items.slice(0, 3).map(item => <button type="button" key={item.event_id} onClick={() => setSelectedCalendarItem(item)} title={`${item.title} · ${getScopeLabel(item)}`} className={`calendar-event-chip calendar-event-chip-${item.event_type}`}><b>{item.title}</b><span>{getScopeLabel(item)}</span></button>)}{cell.items.length > 3 ? <small>+{cell.items.length - 3} more</small> : null}</div></div>)}</div>
        {calendarLoading ? <div className="calendar-event-calendar-loading">Loading calendar...</div> : null}
      </div>}
    </MasterResults>

    <Modal show={modal} title={previewing ? 'Preview Holiday or Event' : (editing ? 'Edit Holiday or Event' : 'Add Holiday or Event')} description={previewing ? 'Review the information before applying it to class schedules.' : 'Only today and future dates are available.'} headerIcon={previewing ? '✓' : 'C'} onClose={() => { setModal(false); setPreviewing(false); }} size="md">
      {previewing ? <div className="calendar-event-preview">
        <div className="calendar-event-preview-banner">
          <span className={`calendar-event-kind calendar-event-kind-${form.event_type}`}>{form.event_type === 'holiday' ? 'Holiday' : 'Event'}</span>
          <h3>{form.title}</h3>
          <p>{form.description || 'No description provided.'}</p>
        </div>
        <div className="calendar-event-preview-grid">
          <div><span>Start date</span><strong>{formatDate(form.date_from)}</strong></div>
          <div><span>End date</span><strong>{formatDate(form.date_to)}</strong></div>
          <div><span>Department</span><strong>{selectedDepartment?.dept_name || 'All departments'}</strong></div>
          <div><span>Program</span><strong>{selectedProgram?.program_name || 'All programs'}</strong></div>
        </div>
        <div className="calendar-event-preview-impact"><strong>{previewData.affected_class_count} future {previewData.affected_class_count === 1 ? 'class' : 'classes'} affected</strong><p>These classes will display as <b>No Class</b> in Attendance History and will not generate attendance records.</p></div>
        {previewData.overlaps.length > 0 ? <div className="calendar-event-overlap-warning"><strong>Overlapping calendar {previewData.overlaps.length === 1 ? 'entry' : 'entries'} found</strong><p>You may still confirm if this overlap is intentional.</p><ul>{previewData.overlaps.map(item => <li key={item.event_id}><b>{item.title}</b><span>{formatDate(item.date_from)}{item.date_from !== item.date_to ? ` – ${formatDate(item.date_to)}` : ''} · {item.department_name} / {item.program_name}</span></li>)}</ul></div> : <div className="calendar-event-no-overlap">✓ No overlapping holiday or event was found.</div>}
        <div className="calendar-event-preview-actions">
          <button type="button" className="mdp-secondary" onClick={() => setPreviewing(false)} disabled={saving}>Edit</button>
          <button type="button" className="calendar-event-cancel-button" onClick={() => { setModal(false); setPreviewing(false); }} disabled={saving}>Cancel</button>
          <button type="button" className="mdp-primary" onClick={saveConfirmed} disabled={saving}>{saving ? 'Applying...' : 'Confirm'}</button>
        </div>
      </div> : <form onSubmit={openPreview} className="calendar-event-form space-y-5">
        <div className="calendar-event-form-section">
          <div className="calendar-event-form-heading"><strong>Event details</strong><span>Name the entry and define its date coverage.</span></div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <label className="md:col-span-2"><span>Title <b>(Required)</b></span><input required maxLength="180" value={form.title} onChange={event => setForm({...form, title:event.target.value})} placeholder="Example: University Foundation Day" /></label>
            <label><span>Type <b>(Required)</b></span><select value={form.event_type} onChange={event => setForm({...form, event_type:event.target.value})}><option value="holiday">Holiday</option><option value="event">Event</option></select></label>
            <label><span>Start date <b>(Required)</b></span><input type="date" required min={today()} value={form.date_from} onChange={event => setForm({...form, date_from:event.target.value, date_to:form.date_to < event.target.value ? event.target.value : form.date_to})} /></label>
            <label><span>End date <b>(Required)</b></span><input type="date" required min={form.date_from || today()} value={form.date_to} onChange={event => setForm({...form, date_to:event.target.value})} /></label>
            <label className="md:col-span-3"><span>Description</span><textarea rows="3" value={form.description} onChange={event => setForm({...form, description:event.target.value})} placeholder="Optional details shown in the calendar" /></label>
          </div>
        </div>

        <div className="calendar-event-form-section">
          <div className="calendar-event-form-heading"><strong>Applied scope</strong><span>{isAdmin ? 'Leave both fields on All to apply system-wide.' : 'Your department is fixed; program selection is optional.'}</span></div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <label><span>Department</span><select disabled={!isAdmin} value={form.dept_id} onChange={event => setForm({...form, dept_id:event.target.value, program_id:''})}><option value="">All departments</option>{departments.map(department => <option key={department.dept_id} value={department.dept_id}>{department.dept_name}</option>)}</select>{!isAdmin ? <small>Fixed to your assigned department.</small> : null}</label>
            <label><span>Program</span><select disabled={!form.dept_id} value={form.program_id} onChange={event => setForm({...form, program_id:event.target.value})}><option value="">All programs</option>{scopedPrograms.map(program => <option key={program.program_id} value={program.program_id}>{program.program_name}</option>)}</select>{!form.dept_id ? <small>Select a department to choose one program.</small> : null}</label>
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:justify-end">
          <button type="button" className="mdp-secondary" onClick={() => setModal(false)}>Cancel</button>
          <button type="submit" className="mdp-primary" disabled={previewLoading}>{previewLoading ? 'Preparing Preview...' : 'Preview'}</button>
        </div>
      </form>
      }
    </Modal>

    <Modal show={Boolean(selectedCalendarItem)} title="Calendar Entry Details" description="Holiday or event coverage for the selected date." headerIcon="C" onClose={() => setSelectedCalendarItem(null)} size="sm">
      {selectedCalendarItem ? <div className="calendar-event-preview">
        <div className="calendar-event-preview-banner"><span className={`calendar-event-kind calendar-event-kind-${selectedCalendarItem.event_type}`}>{selectedCalendarItem.event_type}</span><h3>{selectedCalendarItem.title}</h3><p>{selectedCalendarItem.description || 'No description provided.'}</p></div>
        <div className="calendar-event-preview-grid"><div><span>Effective date</span><strong>{formatDate(selectedCalendarItem.date_from)}{selectedCalendarItem.date_from !== selectedCalendarItem.date_to ? ` – ${formatDate(selectedCalendarItem.date_to)}` : ''}</strong></div><div><span>Scope</span><strong>{getScopeLabel(selectedCalendarItem)}</strong></div><div><span>Department</span><strong>{selectedCalendarItem.dept_name || 'All departments'}</strong></div><div><span>Program</span><strong>{selectedCalendarItem.program_name || 'All programs'}</strong></div>{selectedCalendarItem.status === 'cancelled' ? <div><span>Cancelled by</span><strong>{selectedCalendarItem.cancelled_by_name?.trim() || 'Unknown user'}</strong></div> : null}</div>
        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">{canChange(selectedCalendarItem) ? <button type="button" className="mdp-secondary" onClick={() => { const item = selectedCalendarItem; setSelectedCalendarItem(null); openForm(item); }}>Edit</button> : null}<button type="button" className="mdp-primary" onClick={() => setSelectedCalendarItem(null)}>Close</button></div>
      </div> : null}
    </Modal>
  </div>;
}
