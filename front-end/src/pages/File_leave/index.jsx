import React from 'react';
import Table from '../../components/Table.jsx';
import Modal from '../../components/Modal.jsx';
import UserStatusBadge from '../../components/UserStatusBadge.jsx';
import { AuthContext } from '../../context/AuthContext.jsx';
import { apiGet, apiPost, apiPut } from '../../services/api.js'; 
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';
import { MasterPageHeader, MasterStats, MasterToolbar, MasterSearch, MasterResults, MasterSelect } from '../../components/MasterDataPage.jsx';

const leaveStatusLabel = (status) => {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'approve') return 'Approved';
  if (normalized === 'void') return 'Cancelled';
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Unknown';
};

export default function LeavesFiles() {
  const { user } = React.useContext(AuthContext);
  const currentRoleId = Number(user?.role_id || 0);
  const canManageLeaves = [2, 6].includes(currentRoleId);
  
  // -- State --
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  
  // File/Edit Leave Modal State
  const [showModal, setShowModal] = React.useState(false);
  const [editing, setEditing] = React.useState(null);
  const [form, setForm] = React.useState({ date_from:'', date_to:'', leave_type_id:'', teacher_id:'', reason:'', req_status: 'approve' });
  
  // Detail Modal State
  const [showDetailModal, setShowDetailModal] = React.useState(false);
  const [detailItem, setDetailItem] = React.useState(null);

  // Data Lists
  const [leaveTypes, setLeaveTypes] = React.useState([]);
  const [teachers, setTeachers] = React.useState([]);
  const [teacherSearch, setTeacherSearch] = React.useState('');
  const [teacherFilter, setTeacherFilter] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState(''); 
  const [resolvedDeptId, setResolvedDeptId] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pagination, setPagination] = React.useState({ page: 1, page_size: 10, total: 0, total_pages: 1 });
  const [leaveStats, setLeaveStats] = React.useState({ total: 0, activeToday: 0, upcoming: 0 });
  const [debouncedTeacherSearch, setDebouncedTeacherSearch] = React.useState('');

  React.useEffect(() => {
    if (!user) return;
    const rid = Number(user.role_id);
    if (![2, 6].includes(rid)) { window.location.hash = '#/dashboard'; }
  }, [user]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedTeacherSearch(teacherSearch.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [teacherSearch]);

  React.useEffect(() => { setPage(1); }, [debouncedTeacherSearch, teacherFilter, statusFilter]);

  const fetchRows = React.useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams({ paginate: '1', page: String(page), page_size: '10' });
      if (debouncedTeacherSearch) params.set('search', debouncedTeacherSearch);
      if (teacherFilter) params.set('teacher_id', teacherFilter);
      if (statusFilter) params.set('status', statusFilter);
      const d = await apiGet(`leaves?${params.toString()}`);
      const list = Array.isArray(d?.rows) ? d.rows : (Array.isArray(d) ? d : []);
      setRows(list.map(r => ({ ...r, _status: String(r.req_status || '').toLowerCase() })));
      if (d?.pagination) {
        setPagination(d.pagination);
        if (Number(d.pagination.page || 1) !== page) setPage(Number(d.pagination.page || 1));
      }
      if (d?.summary) setLeaveStats({
        total: Number(d.summary.total || 0),
        activeToday: Number(d.summary.active_today || 0),
        upcoming: Number(d.summary.upcoming || 0),
      });
    } catch (e) { console.error(e); }
    if (!silent) setLoading(false);
  }, [page, debouncedTeacherSearch, teacherFilter, statusFilter]);

  const loadOptions = React.useCallback(async () => {
    try {
      const [types, usersList, teacherList] = await Promise.all([
        apiGet('leaves/types').catch(() => []),
        apiGet('users?list=1&teaching_roles=1&include_inactive=1').catch(() => []),
        apiGet('teachers').catch(() => [])
      ]);
      setLeaveTypes(Array.isArray(types) ? types : []);

      // Use users endpoint for role-aware filtering; fallback to teachers endpoint if needed.
      const mergedUsers = (Array.isArray(usersList) && usersList.length)
        ? usersList
        : (Array.isArray(teacherList) ? teacherList.map(t => ({ ...t, role_id: 5, status: t.status ?? 'active' })) : []);

      const teachingUsers = mergedUsers
        .map(u => ({
          ...u,
          user_id: Number(u.user_id || 0),
          role_id: Number(u.role_id || 0),
          dept_id: u.dept_id ?? null,
          status: String(u.status ?? 'active').toLowerCase(),
        }))
        .filter(u => u.user_id > 0)
        .filter(u => [2, 3, 4, 5].includes(Number(u.role_id)));

      setTeachers(teachingUsers);

      const userDept = (user && user.dept_id != null && String(user.dept_id) !== '')
        ? String(user.dept_id)
        : '';
      const fallbackDept = userDept
        || String(teachingUsers.find(u => Number(u.user_id) === Number(user?.user_id))?.dept_id || '');

      setResolvedDeptId(fallbackDept);

    } catch (e) { console.error(e); }
  }, [user]);

  React.useEffect(() => {
    if (!user) return;
    loadOptions();
  }, [user, loadOptions]);

  React.useEffect(() => {
    if (!user) return;
    fetchRows();
  }, [user, fetchRows]);

  useAutoRefresh({
    refresh: () => fetchRows({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.WORKFLOW,
    enabled: Boolean(user) && !showModal,
  });

  const displayedRows = rows;

  const availableTeachersForForm = React.useMemo(() => {
    if (!user || !teachers) return [];
    // Teaching staff: deans (2), program heads (3), secretaries (4), and teachers (5).
    const allowedRoles = new Set(currentRoleId === 6 ? [2, 3, 4, 5] : [3, 4, 5]);
    const roleOrder = { 2: 1, 3: 2, 4: 3, 5: 4 };
    const source = Number(user.role_id) === 1
      ? teachers
      : teachers.filter(t => resolvedDeptId && String(t.dept_id) === String(resolvedDeptId));

    return source
      .filter(t => allowedRoles.has(Number(t.role_id)))
      .filter(t => ['active', '1', 'true'].includes(String(t.status || 'active').trim().toLowerCase()))
      .slice()
      .sort((a, b) => {
        const ra = roleOrder[Number(a.role_id)] || 99;
        const rb = roleOrder[Number(b.role_id)] || 99;
        if (ra !== rb) return ra - rb;
        const aName = `${a.last_name || ''} ${a.first_name || ''}`.trim().toLowerCase();
        const bName = `${b.last_name || ''} ${b.first_name || ''}`.trim().toLowerCase();
        return aName.localeCompare(bName);
      });
  }, [teachers, user, resolvedDeptId, currentRoleId]);

  const roleLabel = React.useCallback((roleId) => {
    const r = Number(roleId);
    if (r === 5) return 'Teacher';
    if (r === 2) return 'Dean';
    if (r === 6) return 'Department Admin';
    if (r === 3) return 'Program Head';
    if (r === 4) return 'Secretary';
    return 'User';
  }, []);

  const availableTeachersForFilter = React.useMemo(() => {
    const map = new Map();
    teachers
      .filter((t) => resolvedDeptId && String(t.dept_id) === String(resolvedDeptId))
      .forEach((t) => {
      const id = String(t.user_id);
      if (!id) return;
      if (!map.has(id)) map.set(id, t);
    });
    return Array.from(map.values());
  }, [teachers, resolvedDeptId]);

  const canManageLeaveRecord = React.useCallback((row) => {
    if (!canManageLeaves) return false;
    if (!['active', '1', 'true'].includes(String(row?.user_status || '').trim().toLowerCase())) return false;
    return currentRoleId === 6 || Number(row?.role_id) !== 2;
  }, [canManageLeaves, currentRoleId]);

  const openModal = (row = null) => {
    setEditing(row);
    if (row) { 
        setForm({ 
            date_from: row.date_from, 
            date_to: row.date_to, 
            leave_type_id: row.leave_type_id || '', 
            teacher_id: row.teacher_id || '', 
            reason: row.reason || '',
            req_status: row.req_status || 'approve'
        }); 
    } else { 
        setForm({ date_from: '', date_to: '', leave_type_id: '', teacher_id: '', reason: '', req_status: 'approve' }); 
    }
    setShowModal(true);
  };

  const openDetail = (r) => { setDetailItem(r); setShowDetailModal(true); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (!canManageLeaves) throw new Error('Only the Dean or Department Admin can record or edit leave records.');
      const payloadTeacher = Number(form.teacher_id) || null;
      if (!payloadTeacher) throw new Error('Teacher is required');
      const target = teachers.find(x => Number(x.user_id) === Number(payloadTeacher));
      if (!resolvedDeptId) throw new Error('Your department is not set on your account');
      if (!target || String(target.dept_id) !== String(resolvedDeptId)) throw new Error('Selected teacher is not in your department');
      if (currentRoleId === 2 && Number(target.role_id) === 2) throw new Error("Only the Department Admin can manage a Dean's leave.");

      const payload = { 
          teacher_id: payloadTeacher, 
          leave_type_id: Number(form.leave_type_id) || 1, 
          date_from: form.date_from, 
          date_to: form.date_to, 
          reason: form.reason 
      };

      const teacherName = target ? `${target.first_name || ''} ${target.last_name || ''}`.trim() : 'the selected teacher';
      const confirmation = window.Swal ? await window.Swal.fire({
        title: editing ? 'Update Approved Leave?' : 'Record Approved Leave?',
        text: `${teacherName}: ${form.date_from} to ${form.date_to}. Matching attendance records may be changed to On Leave.`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: editing ? 'Update Record' : 'Record Approved Leave',
        confirmButtonColor: '#198754'
      }) : { isConfirmed: confirm(`${editing ? 'Update' : 'Record'} approved leave for ${teacherName}?`) };
      if (!confirmation.isConfirmed) return;
      
      if (editing && editing.leave_id) {
        payload.req_status = form.req_status;
        await apiPut(`leaves/${editing.leave_id}`, payload);
        window.Swal && window.Swal.fire('Update Successful', 'The leave record has been securely updated.', 'success');
      } else {
        await apiPost('leaves', payload);
        window.Swal && window.Swal.fire('Approved Leave Recorded', 'The approved leave has been successfully recorded.', 'success');
      }
      setShowModal(false);
      fetchRows();
    } catch (err) {
      console.error(err);
      
      const errorCode = String(err?.body?.error || err?.code || '').toLowerCase();
      const errorString = String(err?.body?.message || err?.message || err).toLowerCase();

      if (errorCode === 'leave_has_substitutions') {
          window.Swal && window.Swal.fire(
              'Cancellation Blocked',
              err?.body?.message || 'This leave cannot be cancelled or moved because an affected class already has a substitute.',
              'warning'
          );
      } else if (errorCode === 'duplicate_leave' || errorString.includes('overlap')) {
          window.Swal && window.Swal.fire(
              'Date Overlap Detected', 
              'The selected dates overlap with an already existing active leave for this teacher. Please adjust the dates.', 
              'warning'
          );
      } else {
          let cleanMsg = err?.body?.message || err?.message || 'An unknown error occurred.';
          if (cleanMsg.includes('Network request failed') || cleanMsg.includes('http')) {
              cleanMsg = 'Failed to process the request. Please verify your data or check your connection.';
          }
          window.Swal && window.Swal.fire('Action Failed', cleanMsg, 'error');
      }
    }
  };

  const columns = [
    { key: 'rownum', label: '#', render: (r, pIdx, gIdx) => gIdx + 1 },
    { key: 'teacher', label: 'Teacher', render: (r) => <div className="flex flex-col gap-1"><span>{`${r.first_name || ''} ${r.last_name || ''}`}</span><UserStatusBadge status={r.user_status} /></div> },
    { key: 'date', label: 'From - To', render: (r) => `${r.date_from} → ${r.date_to}` },
    { key: 'type', label: 'Type', render: (r) => r.name_type || r.leave_type || 'N/A' },
    { key: 'status', label: 'Status', render: (r) => (
        <span className={`badge ${r.req_status === 'approve' ? 'bg-green-600 text-white' : 'bg-red-500 text-white'}`}>
          {leaveStatusLabel(r.req_status)}
        </span>
      ) },
    { key: 'actions', label: 'Actions', actions: (row) => {
        const actions = [];
        actions.push({ label: 'View', onClick: () => openDetail(row) });

        if (canManageLeaveRecord(row)) {
          actions.push({ label: 'Edit', onClick: () => openModal(row), variant: 'primary' });
        }
        
        return actions;
      } 
    }
  ];

  const renderDetailModal = () => (
    <Modal show={showDetailModal} title={detailItem ? `${detailItem.first_name || ''} ${detailItem.last_name || ''} — Leave` : 'Leave Details'} onClose={() => setShowDetailModal(false)} size="md">
      <div className="rounded-lg bg-white shadow-lg p-4">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-lg">{detailItem ? (detailItem.first_name || '').charAt(0) : ''}</div>
            <div>
              <div className="text-lg font-semibold">{detailItem ? `${detailItem.first_name || ''} ${detailItem.last_name || ''}` : '—'}</div>
              <UserStatusBadge status={detailItem?.user_status} />
              <div className="text-sm text-gray-500">{detailItem && (detailItem.dept_name || detailItem.department || '')}</div>
            </div>
          </div>
          <div className="text-right">
            {detailItem && (
              <div className={`inline-block px-3 py-1 rounded-full text-sm font-semibold ${detailItem.req_status === 'approve' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
                {leaveStatusLabel(detailItem.req_status)}
              </div>
            )}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-3">
            <div className="bg-gray-50 p-3 rounded-lg"><div className="text-xs text-gray-500">Date Range</div><div className="font-medium">{detailItem ? `${detailItem.date_from} → ${detailItem.date_to}` : '—'}</div></div>
            <div className="bg-gray-50 p-3 rounded-lg"><div className="text-xs text-gray-500">Type</div><div className="font-medium">{detailItem?.name_type || detailItem?.leave_type || '—'}</div></div>
          </div>
          <div className="space-y-3">
            <div className="bg-gray-50 p-3 rounded-lg"><div className="text-xs text-gray-500">Reason</div><div className="font-medium">{detailItem?.reason || '—'}</div></div>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={() => setShowDetailModal(false)} className="px-4 py-2 rounded border">Close</button>
        </div>
      </div>
    </Modal>
  );

  return (
    <div className="mdp-page">
      <MasterPageHeader
        eyebrow="Faculty coverage"
        title="Approved Leave Records"
        description="Record externally approved faculty leave and make covered class dates available for substitute assignment."
        action={canManageLeaves ? (
          <button 
            className="mdp-primary"
            onClick={() => openModal()}
          >
            <i className="bi bi-calendar2-plus mr-2" aria-hidden="true"></i>
            Record Leave
          </button>
        ) : null}
      />

      <MasterStats loading={loading} items={[
        { label: 'Recorded Leaves', value: leaveStats.total, help: 'All leave records in your department', tone: 'green', icon: <i className="bi bi-journal-check" /> },
        { label: 'Active Today', value: leaveStats.activeToday, help: 'Approved leave covering today', tone: 'blue', icon: <i className="bi bi-calendar2-check" /> },
        { label: 'Upcoming', value: leaveStats.upcoming, help: 'Approved leave starting later', tone: 'amber', icon: <i className="bi bi-calendar-event" /> },
      ]} />

      <div className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 flex items-start gap-3 text-sm text-green-900">
        <div className="w-9 h-9 rounded-lg bg-white border border-green-200 flex items-center justify-center flex-none text-green-700"><i className="bi bi-diagram-3" aria-hidden="true"></i></div>
        <div>
          <div className="font-bold">Coverage workflow</div>
          <div className="text-green-800 mt-0.5">External leave approval → record approved leave here → assign substitutes only to attendance dates inside the leave period.</div>
        </div>
      </div>

      <MasterToolbar>
        <MasterSelect label="Status" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="approve">Approved</option>
          <option value="void">Cancelled</option>
        </MasterSelect>

        <MasterSearch value={teacherSearch} onChange={e => setTeacherSearch(e.target.value)} placeholder="Search teacher…" />

        <MasterSelect label="Teacher" value={teacherFilter} onChange={e => setTeacherFilter(e.target.value)}>
          <option value="">All people</option>
          {availableTeachersForFilter.map((t) => (
            <option key={t.user_id} value={t.user_id}>
              {t.first_name} {t.last_name} ({roleLabel(t.role_id)})
            </option>
          ))}
        </MasterSelect>
      </MasterToolbar>

      <MasterResults
        title="Leave Registry"
        count={Number(pagination.total || 0)}
        loading={loading}
        description="Approved and cancelled leave records available to your department."
      >
        <Table columns={columns} data={displayedRows} pageSize={10} loading={loading} serverPagination totalItems={Number(pagination.total || 0)} page={page} onPageChange={setPage} />
      </MasterResults>

      {/* File/Edit Leave Modal */}
      <Modal show={showModal} title={editing ? 'Edit Leave' : 'Record Approved Leave'} onClose={() => setShowModal(false)} size="md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div><label className="block text-sm font-medium">From</label><input type="date" required name="date_from" value={form.date_from} onChange={(e) => setForm(s => ({ ...s, date_from: e.target.value }))} className="form-control" /></div>
          <div><label className="block text-sm font-medium">To</label><input type="date" required name="date_to" value={form.date_to} onChange={(e) => setForm(s => ({ ...s, date_to: e.target.value }))} className="form-control" /></div>
          <div>
            <label className="block text-sm font-medium">Leave Type</label>
            <select required value={form.leave_type_id} onChange={(e) => setForm(s => ({ ...s, leave_type_id: e.target.value }))} className="form-select">
              <option value="">Select Leave Type</option>
              {leaveTypes.map((type) => (<option key={type.leave_type_id ?? type.id} value={type.leave_type_id ?? type.id}>{type.name_type ?? type.name}</option>))}
            </select>
          </div>
          {canManageLeaves && (
            <div>
              <label className="block text-sm font-medium">Teacher</label>
              <select required value={form.teacher_id} onChange={(e) => setForm(s => ({ ...s, teacher_id: e.target.value }))} className="form-select">
                <option value="">Select Teacher</option>
                {availableTeachersForForm.map((teacher) => (
                  <option key={teacher.user_id} value={teacher.user_id}>
                    {teacher.first_name} {teacher.last_name} ({roleLabel(teacher.role_id)})
                  </option>
                ))}
              </select>
              {!availableTeachersForForm.length && (
                <div className="text-xs text-gray-500 mt-1">No eligible teaching staff were found in your department.</div>
              )}
            </div>
          )}
          
          {editing && (
            <div>
              <label className="block text-sm font-medium">Status</label>
              <select required value={form.req_status} onChange={(e) => setForm(s => ({ ...s, req_status: e.target.value }))} className="form-select">
                <option value="approve">Approved</option>
                <option value="void">Cancelled</option>
              </select>
            </div>
          )}

          <div><label className="block text-sm font-medium">Reason</label><textarea required value={form.reason} onChange={(e) => setForm(s => ({ ...s, reason: e.target.value }))} className="form-control" /></div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setShowModal(false)} className="px-3 py-2 rounded border">Cancel</button>
            <button type="submit" className="px-4 py-2 rounded bg-green-600 hover:bg-green-700 text-white font-medium shadow">{editing ? 'Update Record' : 'Record Approved Leave'}</button>
          </div>
        </form>
      </Modal>

      {renderDetailModal()}
    </div>
  );
}
