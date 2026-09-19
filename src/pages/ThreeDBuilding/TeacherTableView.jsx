import React from 'react';
import AttendanceTableExport from './AttendanceTableExport.jsx';
import { apiGet } from '../../services/api.js';

const PAGE_SIZES = [10, 25, 50];

const STATUS_LABELS = {
  PRESENT: 'Present',
  LATE: 'Late',
  ABSENT: 'Absent',
  PENDING: 'Pending',
  UPCOMING: 'Upcoming',
  ON_LEAVE: 'On leave',
  SUBSTITUTED: 'Substitute',
  INCOMPLETE: 'Partial Attendance'
};

function normalizeStatus(value) {
  const normalized = String(value || 'PENDING').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return STATUS_LABELS[normalized] ? normalized : 'PENDING';
}

function checkpointStatus(flagId, flagName = '') {
  const id = Number(flagId || 0);
  const name = String(flagName || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (name && STATUS_LABELS[name]) return name;
  if (id === 2) return 'PRESENT';
  if (id === 3) return 'ABSENT';
  if (id === 4) return 'SUBSTITUTED';
  if (id === 5) return 'LATE';
  if (id === 7) return 'ON_LEAVE';
  if (id === 1) return 'UPCOMING';
  return 'PENDING';
}

function overallCheckpointStatus(statuses, recordStatus = '') {
  const specialStatus = normalizeStatus(recordStatus);
  if (specialStatus === 'ON_LEAVE' || specialStatus === 'SUBSTITUTED') return specialStatus;
  const counts = statuses.reduce((result, status) => {
    const normalized = normalizeStatus(status);
    result[normalized] = (result[normalized] || 0) + 1;
    return result;
  }, {});
  const winner = statuses.map(normalizeStatus).find((status) => (counts[status] || 0) >= 2);
  return winner || 'INCOMPLETE';
}

function formatClock(value) {
  const raw = String(value || '').trim();
  if (!raw) return '--:--';
  const match = raw.match(/(?:T|\s|^)(\d{1,2}):(\d{2})/);
  if (!match) return raw;
  let hour = Number(match[1]);
  const minute = match[2];
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour %= 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute} ${suffix}`;
}

function checkpointDisplay(flagId, flagName, timestamp) {
  const status = checkpointStatus(flagId, flagName);
  const showTime = timestamp && (status === 'PRESENT' || status === 'LATE' || status === 'SUBSTITUTED');
  return { status, time: showTime ? formatClock(timestamp) : '' };
}

function statusClass(status) {
  return String(status || 'PENDING').toLowerCase().replace(/_/g, '-');
}

function scheduleProgress(record) {
  if (record?.is_recently_ended) return 'Previous class';
  if (record?.is_active) return 'Ongoing';
  const date = String(record?.date || '').slice(0, 10);
  const start = String(record?.start_time || '').match(/\d{1,2}:\d{2}(?::\d{2})?/)?.[0] || '';
  const end = String(record?.end_time || '').match(/\d{1,2}:\d{2}(?::\d{2})?/)?.[0] || '';
  const startAt = date && start ? new Date(`${date}T${start}`) : null;
  const endAt = date && end ? new Date(`${date}T${end}`) : null;
  const now = new Date();
  if (startAt && !Number.isNaN(startAt.getTime()) && now < startAt) return 'Upcoming';
  if (startAt && endAt && !Number.isNaN(endAt.getTime()) && now <= endAt) return 'Ongoing';
  if (endAt && !Number.isNaN(endAt.getTime()) && now > endAt) return 'Completed';
  return 'Scheduled';
}

function AttendanceBadge({ status }) {
  const normalized = normalizeStatus(status);
  return (
    <span className={`tdb-table-status tdb-table-status--${statusClass(normalized)}`}>
      <i aria-hidden="true" />
      {STATUS_LABELS[normalized]}
    </span>
  );
}

function CheckpointCell({ flagId, flagName, timestamp }) {
  const checkpoint = checkpointDisplay(flagId, flagName, timestamp);
  return (
    <div className="tdb-table-checkpoint">
      <AttendanceBadge status={checkpoint.status} />
      <small>{checkpoint.time || 'No timestamp'}</small>
    </div>
  );
}

function TeacherTableView({
  buildings = [],
  floors = [],
  selectedBuilding = '',
  selectedFloor = '',
  selectedDate = '',
  getAvatarUrl,
  fallbackAvatar,
  onBuildingChange,
  onFloorChange,
  onDateChange,
  onViewDetails,
  onLocateIn3D
}) {
  const [dataMode, setDataMode] = React.useState('current');
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('');
  const [pageSize, setPageSize] = React.useState(10);
  const [page, setPage] = React.useState(1);
  const [queryVersion, setQueryVersion] = React.useState(0);
  const [serverRecords, setServerRecords] = React.useState([]);
  const [serverLoading, setServerLoading] = React.useState(true);
  const [serverError, setServerError] = React.useState('');
  const [serverPagination, setServerPagination] = React.useState({ page: 1, page_size: 10, total: 0, total_pages: 1 });
  const [serverSummary, setServerSummary] = React.useState({ total_records: 0, status_counts: {} });

  const selectedBuildingRecord = React.useMemo(() => (
    buildings.find((building) => String(building.name) === String(selectedBuilding)) || null
  ), [buildings, selectedBuilding]);

  const buildQuery = React.useCallback((mode, options = {}) => {
    const query = new URLSearchParams();
    const exportAll = Boolean(options.exportAll);
    if (mode === 'current') {
      query.set('table_view', '1');
      if (selectedBuildingRecord?.id) query.set('building_id', String(selectedBuildingRecord.id));
      else {
        query.set('all_buildings', '1');
        if (selectedBuilding) query.set('building_name', selectedBuilding);
      }
      if (selectedFloor) query.set('floor_name', selectedFloor);
      if (search.trim()) query.set('search', search.trim());
      if (statusFilter) query.set('status', statusFilter);
      if (exportAll) query.set('export', '1');
      else {
        query.set('page', String(options.page || page));
        query.set('page_size', String(options.pageSize || pageSize));
      }
      return `3d-room-presence.php?${query.toString()}`;
    }
    query.set('date', String(selectedDate || '').slice(0, 10));
    query.set('include_avatar', '0');
    query.set('status_mode', 'overall');
    if (selectedBuilding) query.set('building_name', selectedBuilding);
    if (selectedFloor) query.set('floor_name', selectedFloor);
    if (search.trim()) query.set('search', search.trim());
    if (statusFilter) query.set('status', statusFilter);
    if (!exportAll) {
      query.set('paginate', '1');
      query.set('page', String(options.page || page));
      query.set('page_size', String(options.pageSize || pageSize));
    }
    return `attendance?${query.toString()}`;
  }, [selectedBuildingRecord, selectedBuilding, selectedFloor, selectedDate, search, statusFilter, page, pageSize]);

  const normalizeServerRecord = React.useCallback((record) => {
    if (record?.teacher_name) return record;
    const teacherName = `${record?.first_name || ''} ${record?.last_name || ''}`.trim() || 'Teacher';
    return {
      ...record,
      teacher_id: record?.teacher_id || record?.user_id || '',
      teacher_name: teacherName,
      department_name: record?.department_name || record?.dept_name || '',
      subject: `${record?.subject_code || ''} ${record?.subject_name || ''}`.trim(),
      status: overallCheckpointStatus([
        checkpointStatus(record?.flag_in_id, record?.flag_in_name),
        checkpointStatus(record?.flag_check_id, record?.flag_check_name),
        checkpointStatus(record?.flag_out_id, record?.flag_out_name)
      ], record?.status || record?.attendance_status),
      avatar_url: record?.avatar_url || (record?.user_id ? `avatar-thumbnail.php?user_id=${encodeURIComponent(record.user_id)}` : '')
    };
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    const debounce = setTimeout(async () => {
      setServerLoading(true);
      setServerError('');
      try {
        const payload = await apiGet(buildQuery(dataMode), { signal: controller.signal });
        if (controller.signal.aborted) return;
        const rawRows = dataMode === 'current' ? payload?.markers : payload?.rows;
        const nextRows = (Array.isArray(rawRows) ? rawRows : []).map(normalizeServerRecord);
        setServerRecords(nextRows);
        setServerPagination(payload?.pagination || { page: 1, page_size: pageSize, total: nextRows.length, total_pages: 1 });
        setServerSummary(payload?.summary || { total_records: nextRows.length, status_counts: {} });
      } catch (requestError) {
        if (controller.signal.aborted) return;
        setServerRecords([]);
        setServerError(requestError?.body?.message || requestError?.message || 'Unable to load teacher records.');
      } finally {
        if (!controller.signal.aborted) setServerLoading(false);
      }
    }, search.trim() ? 250 : 0);
    return () => {
      clearTimeout(debounce);
      controller.abort();
    };
  }, [dataMode, buildQuery, normalizeServerRecord, queryVersion]);

  React.useEffect(() => {
    if (dataMode !== 'current') return undefined;
    const interval = setInterval(() => setQueryVersion((value) => value + 1), 30000);
    return () => clearInterval(interval);
  }, [dataMode]);

  const filteredRecords = serverRecords;
  const scopedRecords = serverRecords;
  const activeLoading = serverLoading;
  const activeError = serverError;
  const activeRetry = () => setQueryVersion((value) => value + 1);

  React.useEffect(() => {
    setPage(1);
  }, [dataMode, search, statusFilter, pageSize, selectedDate, selectedBuilding, selectedFloor]);

  const pageCount = Math.max(1, Number(serverPagination.total_pages || 1));
  const safePage = Math.min(Number(serverPagination.page || page), pageCount);
  const pageRecords = filteredRecords;
  const totalFilteredRecords = Number(serverPagination.total || 0);
  const totalScopedRecords = Number(serverSummary.total_records ?? totalFilteredRecords);
  const statusCounts = React.useMemo(() => Object.entries(serverSummary.status_counts || {}).reduce((counts, [status, count]) => {
    counts[normalizeStatus(status)] = Number(count || 0);
    return counts;
  }, {}), [serverSummary]);

  const loadAllFilteredRecords = React.useCallback(async () => {
    const payload = await apiGet(buildQuery(dataMode, { exportAll: true }));
    const rawRows = dataMode === 'current' ? payload?.markers : payload;
    return (Array.isArray(rawRows) ? rawRows : []).map(normalizeServerRecord);
  }, [buildQuery, dataMode, normalizeServerRecord]);
  const selectedDateLabel = selectedDate
    ? new Date(`${String(selectedDate).slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'selected date';
  const selectedBuildingLabel = selectedBuilding
    ? (buildings.find((building) => String(building.name) === String(selectedBuilding))?.displayName || selectedBuilding)
    : 'All buildings';
  const selectedFloorLabel = selectedFloor
    ? (floors.find((floor) => String(floor.floorName) === String(selectedFloor))?.displayName || selectedFloor)
    : 'All floors';

  const renderAvatar = (record) => (
    <img
      src={(getAvatarUrl && getAvatarUrl(record)) || fallbackAvatar}
      alt=""
      width="42"
      height="42"
      loading="lazy"
      onError={(event) => {
        if (fallbackAvatar && event.currentTarget.src !== fallbackAvatar) event.currentTarget.src = fallbackAvatar;
      }}
    />
  );

  const renderActions = (record) => (
    <div className="tdb-table-actions">
      <button type="button" className="tdb-table-action-primary" onClick={() => onViewDetails?.(record)}>View details</button>
      <button type="button" onClick={() => onLocateIn3D?.(record)}>Locate in 3D</button>
    </div>
  );

  const selectDataMode = (mode) => {
    setDataMode(mode === 'current' ? 'current' : 'records');
    setStatusFilter('');
    setPage(1);
  };

  return (
    <section className="tdb-table-view" aria-label="Teacher attendance table view">
      <div className="tdb-table-view-header">
        <div>
          <span className="tdb-table-eyebrow">{dataMode === 'current' ? 'Live building attendance' : 'Attendance records'}</span>
          <h3>Teacher Status and Schedule</h3>
          <p>{dataMode === 'current' ? 'Classes happening now or still inside the recently-ended grace period.' : `Schedules and attendance checkpoint results for ${selectedDateLabel}.`}</p>
          <div className="tdb-table-data-mode" role="group" aria-label="Choose current classes or selected-date records">
            <button type="button" className={dataMode === 'current' ? 'is-active' : ''} onClick={() => selectDataMode('current')} aria-pressed={dataMode === 'current'}>Current Classes</button>
            <button type="button" className={dataMode === 'records' ? 'is-active' : ''} onClick={() => selectDataMode('records')} aria-pressed={dataMode === 'records'}>Date Records</button>
          </div>
        </div>
        <div className="tdb-table-header-actions">
          <AttendanceTableExport
            records={filteredRecords}
            loadRecords={loadAllFilteredRecords}
            dataMode={dataMode}
            selectedDate={selectedDate}
            buildingLabel={selectedBuildingLabel}
            floorLabel={selectedFloorLabel}
          />
          {activeError && (
            <div className="tdb-table-live-state" aria-live="polite">
              <span className="tdb-table-live-dot tdb-table-live-dot--error" />
              Update unavailable
              <button type="button" onClick={activeRetry}>Retry</button>
            </div>
          )}
        </div>
      </div>

      <div className={`tdb-table-scope-controls${dataMode === 'records' ? ' tdb-table-scope-controls--with-date' : ''}`}>
        {dataMode === 'records' && (
          <label>
            <span>Records Date</span>
            <input
              type="date"
              value={selectedDate}
              onChange={(event) => onDateChange?.(event.target.value)}
            />
          </label>
        )}
        <label>
          <span>Building</span>
          <select value={selectedBuilding} onChange={(event) => onBuildingChange?.(event.target.value)}>
            <option value="">ALL buildings</option>
            {buildings.map((building) => <option key={building.name} value={building.name}>{building.displayName || building.name}</option>)}
          </select>
        </label>
        <label>
          <span>Floor</span>
          <select value={selectedFloor} onChange={(event) => onFloorChange?.(event.target.value)}>
            <option value="">ALL</option>
            {floors.map((floor) => <option key={`${floor.buildingName}-${floor.floorName}`} value={floor.floorName}>{floor.displayName || floor.floorName}</option>)}
          </select>
        </label>
        <label className="tdb-table-search-field">
          <span>Search</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} type="search" placeholder="Teacher, subject, section, or room" />
        </label>
        <label>
          <span>Status</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="">All statuses</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>

      <div className="tdb-table-summary" aria-label="Visible teacher status totals">
        <button type="button" className={!statusFilter ? 'is-active' : ''} onClick={() => setStatusFilter('')}><span>Displayed</span><strong>{totalScopedRecords}</strong></button>
        {['PRESENT', 'LATE', 'ABSENT', 'INCOMPLETE', 'PENDING'].map((status) => (
          <button type="button" key={status} className={statusFilter === status ? 'is-active' : ''} onClick={() => setStatusFilter(statusFilter === status ? '' : status)}>
            <span>{STATUS_LABELS[status]}</span><strong>{statusCounts[status] || 0}</strong>
          </button>
        ))}
      </div>

      {activeLoading && scopedRecords.length === 0 ? (
        <div className="tdb-table-empty"><strong>{dataMode === 'current' ? 'Loading current classes' : 'Loading attendance records'}</strong><span>{dataMode === 'current' ? 'Please wait while live teacher status is loaded.' : `Please wait while schedules and attendance checks for ${selectedDateLabel} are loaded.`}</span></div>
      ) : activeError && scopedRecords.length === 0 ? (
        <div className="tdb-table-empty tdb-table-empty--error"><strong>Teacher data is temporarily unavailable</strong><span>{activeError}</span><button type="button" onClick={activeRetry}>Try again</button></div>
      ) : filteredRecords.length === 0 ? (
        <div className="tdb-table-empty"><strong>{dataMode === 'current' ? 'No current classes' : 'No matching teacher schedules'}</strong><span>{dataMode === 'current' ? 'No class is currently active or inside the recently-ended grace period for the selected filters.' : `No schedule or attendance record for ${selectedDateLabel} matches the selected filters.`}</span></div>
      ) : (
        <>
          <div className="tdb-table-scroll">
            <table className="tdb-teacher-table">
              <thead><tr><th>#</th><th>Teacher</th><th>Overall</th><th>Check In</th><th>Mid Check</th><th>Check Out</th><th>Subject</th><th>Section</th><th>Room</th><th>Schedule</th><th>Action</th></tr></thead>
              <tbody>
                {pageRecords.map((record, index) => (
                  <tr key={`${record.room_id}-${record.schedule_id}-${record.teacher_id}`}>
                    <td>{((safePage - 1) * pageSize) + index + 1}</td>
                    <td><div className="tdb-table-teacher">{renderAvatar(record)}<div><strong>{record.teacher_name || 'Teacher'}</strong>{record.is_substitute && <em>Substitute</em>}</div></div></td>
                    <td><AttendanceBadge status={record.status || record.attendance_status} /></td>
                    <td><CheckpointCell flagId={record.flag_in_id} flagName={record.flag_in_name} timestamp={record.time_in} /></td>
                    <td><CheckpointCell flagId={record.flag_check_id} flagName={record.flag_check_name} timestamp={record.time_check} /></td>
                    <td><CheckpointCell flagId={record.flag_out_id} flagName={record.flag_out_name} timestamp={record.time_out} /></td>
                    <td><div className="tdb-table-primary-cell"><strong>{record.subject || 'Not specified'}</strong>{record.department_name && <small>{record.department_name}</small>}</div></td>
                    <td>{record.section_name || '-'}</td>
                    <td><div className="tdb-table-primary-cell"><strong>{record.room_name || '-'}</strong><small>{record.floor_name || '-'}</small></div></td>
                    <td><div className="tdb-table-primary-cell"><strong>{formatClock(record.start_time)} - {formatClock(record.end_time)}</strong><small>{scheduleProgress(record)}</small></div></td>
                    <td>{renderActions(record)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="tdb-table-mobile-list">
            {pageRecords.map((record) => (
              <article key={`mobile-${record.room_id}-${record.schedule_id}-${record.teacher_id}`} className="tdb-table-mobile-card">
                <header>{renderAvatar(record)}<div><strong>{record.teacher_name || 'Teacher'}</strong></div><AttendanceBadge status={record.status || record.attendance_status} /></header>
                <div className="tdb-table-mobile-schedule"><strong>{record.subject || 'Subject not specified'}</strong><span>{record.section_name || 'No section'} | {record.room_name || 'No room'}</span><span>{formatClock(record.start_time)} - {formatClock(record.end_time)} | {record.floor_name || 'No floor'}</span></div>
                <div className="tdb-table-mobile-checks"><div><span>Check In</span><CheckpointCell flagId={record.flag_in_id} flagName={record.flag_in_name} timestamp={record.time_in} /></div><div><span>Mid Check</span><CheckpointCell flagId={record.flag_check_id} flagName={record.flag_check_name} timestamp={record.time_check} /></div><div><span>Check Out</span><CheckpointCell flagId={record.flag_out_id} flagName={record.flag_out_name} timestamp={record.time_out} /></div></div>
                {renderActions(record)}
              </article>
            ))}
          </div>

          <div className="tdb-table-pagination">
            <span>Showing {totalFilteredRecords ? ((safePage - 1) * pageSize) + 1 : 0}-{Math.min(safePage * pageSize, totalFilteredRecords)} of {totalFilteredRecords}</span>
            <label>Rows <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>{PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
            <div><button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={safePage <= 1}>Previous</button><span>Page {safePage} of {pageCount}</span><button type="button" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={safePage >= pageCount}>Next</button></div>
          </div>
        </>
      )}
    </section>
  );
}

export default TeacherTableView;
