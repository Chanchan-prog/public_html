import React from 'react';
import { apiGet, apiPost, apiPut } from '../../services/api.js';
import Table from "../../components/Table.jsx";
import Modal from "../../components/Modal.jsx";
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';
import { MasterPageHeader, MasterStats, MasterToolbar, MasterSearch, MasterResults, MasterSelect } from '../../components/MasterDataPage.jsx';

const generateSubName = (name = '') => (String(name).match(/[A-Z0-9]/g) || []).join('').slice(0, 30);

function DepartmentIndex(){
  const currentUser = React.useMemo(() => { try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch(e) { return null; } }, []);
  const isAdmin = Number(currentUser?.role_id) === 1;

  const [departments, setDepartments] = React.useState([]);
  const [deans, setDeans] = React.useState([]);
  const [showModal, setShowModal] = React.useState(false);
  const [editing, setEditing] = React.useState(null);
  const [form, setForm] = React.useState({ sub_name: '', dept_name: '', dean_ids: [] });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [showArchived, setShowArchived] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('active');
  const [needsDeanOnly, setNeedsDeanOnly] = React.useState(false);
  // cache full departments list for instant client-side filtering
  const [allDepartments, setAllDepartments] = React.useState(null);

  const runWithFallback = async (primary, fallback) => {
    try { return await primary(); } catch (err) {
      if (err?.status === 405 || err?.status === 500) return await fallback();
      throw err;
    }
  };

  const loadDepartments = React.useCallback(async ({ silent = false } = {})=>{
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try{
      const [d, ds] = await Promise.all([apiGet('departments'), apiGet('deans')]);
      const normalized = Array.isArray(d) ? d.map(x => ({ ...x, _status: String(x.status || '').toLowerCase().trim() })) : [];
      setAllDepartments(normalized);
      setDepartments(showArchived ? normalized.filter(x => x._status === 'archive') : normalized.filter(x => x._status !== 'archive'));
      setDeans(Array.isArray(ds)?ds:[]);
    }catch(e){ console.error(e); if (!silent) setError('Failed to load departments or deans'); }
    finally { if (!silent) setLoading(false); }
  }, [showArchived]);

  React.useEffect(()=>{
    loadDepartments();
  }, [loadDepartments]);

  useAutoRefresh({
    refresh: () => loadDepartments({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.ADMIN,
    enabled: !showModal,
  });

  const handleToggleShowArchived = async ()=>{
    const next = !showArchived;
    setShowArchived(next);

    if (Array.isArray(allDepartments)){
      const filtered = next ? allDepartments.filter(u => u._status === 'archive') : allDepartments.filter(u => u._status !== 'archive');
      setDepartments(filtered);
      // background revalidation
      (async ()=>{
        try{
          const d = await apiGet('departments');
          const normalized = Array.isArray(d)? d.map(x => ({ ...x, _status: String(x.status || '').toLowerCase().trim() })) : [];
          setAllDepartments(normalized);
          setDepartments(next ? normalized.filter(u=>u._status==='archive') : normalized.filter(u=>u._status!=='archive'));
        }catch(err){ console.error('Background revalidation failed', err); }
      })();
      return;
    }

    try{
      const d = await apiGet('departments');
      const normalized = Array.isArray(d)? d.map(x => ({ ...x, _status: String(x.status || '').toLowerCase().trim() })) : [];
      setAllDepartments(normalized);
      setDepartments(next ? normalized.filter(u=>u._status==='archive') : normalized.filter(u=>u._status!=='archive'));
    }catch(e){ console.error('Failed to fetch departments', e); setError('Failed to load departments'); }
  };

  const handleUnarchive = async (dept) => {
    if (!dept || !dept.dept_id) return;
    try{
      const res = window.Swal ? await window.Swal.fire({ title: 'Unarchive department?', text: 'This will restore the department and set status to inactive.', icon: 'warning', showCancelButton: true }) : { isConfirmed: confirm('Unarchive department?') };
      if (!res.isConfirmed) return;
      await runWithFallback(
        () => apiPut(`departments/${dept.dept_id}`, { status: 'inactive' }),
        () => apiPost(`departments/${dept.dept_id}/update`, { status: 'inactive' })
      );
      // refresh cache + view
      const d = await apiGet('departments');
      const normalized = Array.isArray(d)? d.map(x => ({ ...x, _status: String(x.status || '').toLowerCase().trim() })) : [];
      setAllDepartments(normalized);
      setDepartments(normalized.filter(x => x._status === 'archive'));
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'Unarchived', timer:1200, showConfirmButton:false }); } catch(e){}
    }catch(err){ console.error(err); try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: err.body?.message || err.body?.error || err.message || 'Failed to unarchive' }); } catch(e){} }
  };

  const openModal = (dept=null) => {
    setError('');
    if (dept) {
      setEditing(dept);
      const hasMultiDeanField = Object.prototype.hasOwnProperty.call(dept, 'dean_ids');
      const rawDeanIds = hasMultiDeanField ? dept.dean_ids : dept.dean_id;
      const assignedDeanIds = Array.isArray(rawDeanIds)
        ? rawDeanIds
        : String(rawDeanIds || '').split(',').filter(Boolean);
      setForm({ sub_name: dept.sub_name || generateSubName(dept.dept_name), dept_name: dept.dept_name || '', dean_ids: assignedDeanIds.map(String) });
    } else {
      setEditing(null);
      setForm({ sub_name: '', dept_name:'', dean_ids: [] });
    }
    setShowModal(true);
  };
  const closeModal = ()=> setShowModal(false);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((previous) => name === 'dept_name'
      ? { ...previous, dept_name: value, sub_name: generateSubName(value) }
      : { ...previous, [name]: value });
  };

  const handleDeanToggle = (userId) => {
    const id = String(userId);
    setForm(prev => ({
      ...prev,
      dean_ids: prev.dean_ids.includes(id)
        ? prev.dean_ids.filter(value => value !== id)
        : [...prev.dean_ids, id]
    }));
  };

  const deanOptions = React.useMemo(() => {
    const targetDeptId = editing?.dept_id ? String(editing.dept_id) : '';
    return (Array.isArray(deans) ? deans : []).filter((dean) => {
      const assignedDeptId = dean?.dept_id !== null && dean?.dept_id !== undefined && String(dean.dept_id) !== ''
        ? String(dean.dept_id)
        : '';
      return !assignedDeptId || (targetDeptId && assignedDeptId === targetDeptId);
    });
  }, [deans, editing]);

  const validateForm = () => {
    const name = (form.dept_name||'').trim();
    const subName = (form.sub_name || '').trim().toLowerCase();
    if (!subName) return 'Department sub name is required';
    if (!name) return 'Department name is required';
    // duplicate name check (case-insensitive), exclude editing dept
    const sourceDepartments = Array.isArray(allDepartments) ? allDepartments : departments;
    const conflictSubName = subName && sourceDepartments.find(d => String(d.sub_name || '').trim().toLowerCase() === subName && (!editing || Number(d.dept_id) !== Number(editing.dept_id)));
    if (conflictSubName) return 'A department with the same sub name already exists';
    const conflictName = sourceDepartments.find(d => d.dept_name && String(d.dept_name).toLowerCase() === name.toLowerCase() && (!editing || Number(d.dept_id) !== Number(editing.dept_id)));
    if (conflictName) return 'A department with the same name already exists';
    return null;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');
    const v = validateForm();
    if (v) { try { if (window.Swal) await window.Swal.fire({ icon:'warning', title:'Validation', text: v }); else alert(v); } catch(e){} setLoading(false); return; }

    try{
      const payload = {
        sub_name: form.sub_name.trim() || null,
        dept_name: form.dept_name.trim(),
        dean_ids: form.dean_ids.map(Number),
        dean_id: form.dean_ids.length ? Number(form.dean_ids[0]) : null,
      };
      if (editing && editing.dept_id) {
        await runWithFallback(
          () => apiPut(`departments/${editing.dept_id}`, payload),
          () => apiPost(`departments/${editing.dept_id}/update`, payload)
        );
      } else {
        await apiPost('departments', payload);
      }

      const d = await apiGet('departments');
      const normalized = Array.isArray(d)? d.map(x => ({ ...x, _status: String(x.status || '').toLowerCase().trim() })) : [];
      setAllDepartments(normalized);
      const list = normalized.filter(x => x._status !== 'archive');
      setDepartments(list);
      closeModal();
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: editing ? 'Department updated' : 'Department added', timer: 1400, showConfirmButton: false }); } catch(e){}
    } catch (err) {
      console.error(err);
      const msg = err?.body?.message || err?.body?.error || err?.message || 'Failed to save';
      try { if (window.Swal) await window.Swal.fire({ icon:'error', title: 'Error', text: msg }); else alert(msg); } catch(e){}
      setError(msg);
    } finally { setLoading(false); }
  };

  const handleToggle = async (dept) => {
    if (!dept || !dept.dept_id) return;
    const newStatus = String(dept.status) === 'active' ? 'inactive' : 'active';
    const action = newStatus === 'active' ? 'Activate' : 'Deactivate';
    const answer = window.Swal ? await window.Swal.fire({ title: `${action} department?`, text: `${dept.dept_name || 'This department'} will be ${newStatus}.`, icon: 'question', showCancelButton: true, confirmButtonText: action }) : { isConfirmed: confirm(`${action} this department?`) };
    if (!answer.isConfirmed) return;
    try{
      await runWithFallback(
        () => apiPut(`departments/${dept.dept_id}`, { status: newStatus }),
        () => apiPost(`departments/${dept.dept_id}/update`, { status: newStatus })
      );
      const d = await apiGet('departments');
      const normalized = Array.isArray(d)? d.map(x => ({ ...x, _status: String(x.status || '').toLowerCase().trim() })) : [];
      setAllDepartments(normalized);
      setDepartments(normalized.filter(x => x._status !== 'archive'));
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'Status updated', timer:1200, showConfirmButton:false }); } catch(e){}
    } catch (err) {
      console.error(err);
      try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: err.body?.message || err.body?.error || err.message || 'Failed to update status' }); else alert(err.body?.message || err.body?.error || err.message || 'Failed to update status'); } catch(e){}
    }
  };

  const handleArchive = async (dept) => {
    if (!dept || !dept.dept_id) return;
    try{
      const res = window.Swal ? await window.Swal.fire({ title: 'Archive department?', text: 'This will remove the department from the active list.', icon: 'warning', showCancelButton: true }) : { isConfirmed: confirm('Archive department?') };
      if (!res.isConfirmed) return;
      await runWithFallback(
        () => apiPut(`departments/${dept.dept_id}`, { status: 'archive' }),
        () => apiPost(`departments/${dept.dept_id}/update`, { status: 'archive' })
      );
      const d = await apiGet('departments');
      const normalized = Array.isArray(d)? d.map(x => ({ ...x, _status: String(x.status || '').toLowerCase().trim() })) : [];
      setAllDepartments(normalized);
      setDepartments(normalized.filter(x => x._status !== 'archive'));
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'Archived', timer:1200, showConfirmButton:false }); } catch(e){}
    } catch (err) {
      console.error(err);
      try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: err.body?.message || err.body?.error || err.message || 'Failed to archive' }); else alert(err.body?.message || err.body?.error || err.message || 'Failed to archive'); } catch(e){}
    }
  };

  const columns = [
    { key: 'rownum', label: '#', render: (r, pIdx, gIdx) => gIdx + 1 },
    { key: 'sub_name', label: 'Sub Name', render: (r) => r.sub_name || <span className="text-slate-400">—</span> },
    { key: 'dept_name', label: 'Department Name' },
    { key: 'dean', label: 'Deans', render: (r) => {
      const names = Array.isArray(r.dean_names) ? r.dean_names : String(r.dean_names || '').split('||').filter(Boolean);
      const fallback = `${r.dean_first || r.first_name || ''} ${r.dean_last || r.last_name || ''}`.trim();
      const hasMultiDeanField = Object.prototype.hasOwnProperty.call(r, 'dean_ids');
      const leaders = names.length ? names : (!hasMultiDeanField && fallback ? [fallback] : []);
      return leaders.length ? (
        <div className="flex flex-wrap gap-1.5">
          {leaders.map((name, index) => <span key={`${name}-${index}`} className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">{name}</span>)}
        </div>
      ) : <span className="text-slate-400">Unassigned</span>;
    } },
    { key: 'status', label: 'Status', render: (r) => {
      const s = (r.status || '').toLowerCase();
      const text = s === 'active' ? 'Active' : (s === 'inactive' ? 'Inactive' : (r.status || 'N/A'));
      return (<span className={`mdp-status mdp-status-${s}`}>{text}</span>);
    }}
  ];
  if (isAdmin) {
    columns.push({
      key: 'actions',
      label: 'Actions',
      actions: (row) => {
        if (String(row.status || '').toLowerCase() === 'archive') return [
          { label: 'Restore', variant: 'success', onClick: (r) => handleUnarchive(r) }
        ];
        return [
          { label: 'Edit', onClick: (r) => openModal(r) },
          { label: 'Toggle', onClick: (r) => handleToggle(r) },
          { label: 'Archive', variant: 'danger', onClick: (r) => handleArchive(r) }
        ];
      }
    });
  }

  const departmentSource = Array.isArray(allDepartments) ? allDepartments : departments;
  const hasNoDean = (item) => {
    const hasMultiDeanField = Object.prototype.hasOwnProperty.call(item, 'dean_ids');
    const ids = Array.isArray(item.dean_ids) ? item.dean_ids : String(item.dean_ids || '').split(',').filter(Boolean);
    return hasMultiDeanField ? ids.length === 0 : !item.dean_id && !item.dean_first && !item.first_name;
  };
  const selectDepartmentStatus = (status, needsDean = false) => {
    setStatusFilter(status);
    setNeedsDeanOnly(needsDean);
    setShowArchived(status === 'archive');
  };
  const filteredDepartments = departmentSource.filter((department) => {
    const query = search.trim().toLowerCase();
    const hasMultiDeanField = Object.prototype.hasOwnProperty.call(department, 'dean_ids');
    const dean = Array.isArray(department.dean_names)
      ? department.dean_names.join(' ')
      : `${department.dean_names || ''}${hasMultiDeanField ? '' : ` ${department.dean_first || department.first_name || ''} ${department.dean_last || department.last_name || ''}`}`;
    return (!query || `${department.sub_name || ''} ${department.dept_name || ''} ${dean}`.toLowerCase().includes(query))
      && String(department.status || '').toLowerCase() === statusFilter
      && (!needsDeanOnly || hasNoDean(department));
  });
  const activeCount = departmentSource.filter((item) => String(item.status).toLowerCase() === 'active').length;
  const unassignedCount = departmentSource.filter((item) => String(item.status).toLowerCase() === 'active' && hasNoDean(item)).length;
  const inactiveCount = departmentSource.filter((item) => String(item.status).toLowerCase() === 'inactive').length;
  const archivedCount = departmentSource.filter((item) => String(item.status).toLowerCase() === 'archive').length;

  return (
    <div className="mdp-page department-page">
      <MasterPageHeader title="Departments" description="Manage academic departments, Dean assignments, and operational status." action={isAdmin ? <button className="mdp-primary" onClick={()=>openModal()}>+ Add Department</button> : null} />
      <MasterStats loading={loading} items={[{ label: 'Active', value: activeCount, help: 'Available for operations', icon: '\u2713', active: statusFilter === 'active' && !needsDeanOnly, onClick: () => selectDepartmentStatus('active') }, { label: 'Needs Dean', value: unassignedCount, help: 'Active without a Dean', icon: '!', tone: 'amber', active: needsDeanOnly, onClick: () => selectDepartmentStatus('active', true) }, { label: 'Inactive', value: inactiveCount, help: 'Currently unavailable', icon: 'I', tone: 'red', active: statusFilter === 'inactive', onClick: () => selectDepartmentStatus('inactive') }, { label: 'Archived', value: archivedCount, help: 'Available for restoration', icon: 'A', active: statusFilter === 'archive', onClick: () => selectDepartmentStatus('archive') }]} />

      {!isAdmin && <div className="alert alert-info py-2 mb-3">View-only access: You can only view departments.</div>}

      {error && <div className="mb-3 text-red-600">{error}</div>}

      <MasterToolbar><MasterSearch value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search department or Dean..." /><MasterSelect label="Status" value={statusFilter} onChange={(event) => selectDepartmentStatus(event.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option><option value="archive">Archived</option></MasterSelect></MasterToolbar>
      <MasterResults title={showArchived ? 'Archived Departments' : 'Department Directory'} count={filteredDepartments.length} loading={loading} description="Department ownership and assigned academic leadership."><Table columns={columns} data={filteredDepartments} loading={loading} pageSize={10} horizontalScroll={true} wrapCells className="department-table responsive-table" /></MasterResults>

      <Modal show={showModal} title={editing ? 'Edit Department' : 'Add Department'} onClose={closeModal} size="md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Sub Name</label>
            <input name="sub_name" value={form.sub_name} onChange={handleChange} required maxLength={30} placeholder="Automatically generated from capital letters" className="block w-full border border-gray-200 rounded px-3 py-2" />
            <p className="mt-1 text-xs text-gray-500">Automatically uses capital letters and numbers from the Department Name. You may still edit it.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Department Name</label>
            <input name="dept_name" value={form.dept_name} onChange={handleChange} required className="block w-full border border-gray-200 rounded px-3 py-2" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Deans</label>
            <p className="mb-2 text-xs text-gray-500">Select unassigned Deans or Deans who already manage this department. Transfer assignments from the User page.</p>
            <div className="max-h-52 space-y-2 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-3">
              {deanOptions.length === 0 ? <div className="text-sm text-gray-500">No Dean-role users are available.</div> : deanOptions.map(dn => {
                const id = String(dn.user_id);
                return (
                  <label key={id} className="flex cursor-pointer items-center gap-3 rounded-lg bg-white px-3 py-2 shadow-sm">
                    <input type="checkbox" checked={form.dean_ids.includes(id)} onChange={() => handleDeanToggle(id)} className="h-4 w-4 rounded border-gray-300 text-emerald-600" />
                    <span className="text-sm font-medium text-gray-800">{dn.first_name} {dn.last_name}{dn.dept_name ? ` — ${dn.dept_name}` : ' — Unassigned'}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeModal} className="px-3 py-2 rounded border">Cancel</button>
            <button type="submit" disabled={loading} className="px-4 py-2 rounded bg-green-600 text-white">{loading ? 'Saving...' : (editing ? 'Update Department' : 'Save Department')}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default DepartmentIndex;
