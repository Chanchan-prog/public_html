import React from 'react';
import { apiGet, apiPost, apiPut } from '../../services/api.js'; // Fixed import path with .js
import Table from "../../components/Table.jsx";
import Modal from "../../components/Modal.jsx";
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';
import { MasterPageHeader, MasterStats, MasterToolbar, MasterSearch, MasterResults, MasterSelect } from '../../components/MasterDataPage.jsx';

const generateSubName = (name = '') => (String(name).match(/[A-Z0-9]/g) || []).join('').slice(0, 30);

function ProgramIndex(){
  // determine current user and roles
  const currentUser = React.useMemo(() => { try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch(e) { return null; } }, []);
  const isAdmin = Number(currentUser?.role_id) === 1;

  const [programs, setPrograms] = React.useState([]);
  const [departments, setDepartments] = React.useState([]);
  const [heads, setHeads] = React.useState([]);
  const [showModal, setShowModal] = React.useState(false);
  const [editing, setEditing] = React.useState(null);
  const [form, setForm] = React.useState({ sub_name: '', program_name: '', dept_id: '', head_ids: [] });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [departmentFilter, setDepartmentFilter] = React.useState('all');
  const [statusFilter, setStatusFilter] = React.useState('active');
  const [showArchived, setShowArchived] = React.useState(false);
  const [needsHeadOnly, setNeedsHeadOnly] = React.useState(false);

  const runWithFallback = async (primary, fallback) => {
    try { return await primary(); } catch (err) { if (err?.status === 405 || err?.status === 500) return await fallback(); throw err; }
  };

  const loadProgramData = React.useCallback(async ({ silent = false } = {})=>{
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try{
      const [p, d, u] = await Promise.all([apiGet('programs'), apiGet('departments'), apiGet('users?list=1')]);
      setPrograms(Array.isArray(p) ? p : []);
      setDepartments(Array.isArray(d)? d: []);
      const programHeads = Array.isArray(u) ? u.filter(x => (Number(x.role_id) === 3 || String(x.role_name || '').toLowerCase().includes('program')) && String(x.status || 'active').toLowerCase() === 'active') : [];
      setHeads(programHeads);
    }catch(e){ console.error(e); if (!silent) setError('Failed to load programs'); }
    finally { if (!silent) setLoading(false); }
  }, []);

  React.useEffect(()=>{
    loadProgramData();
  }, [loadProgramData]);

  useAutoRefresh({
    refresh: () => loadProgramData({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.ADMIN,
    enabled: !showModal,
  });

  const openModal = (prog=null) => {
    setError('');
    if (prog) {
      setEditing(prog);
      const hasMultiHeadField = Object.prototype.hasOwnProperty.call(prog, 'head_ids');
      const rawHeadIds = hasMultiHeadField ? prog.head_ids : prog.head_id;
      const assignedHeadIds = Array.isArray(rawHeadIds)
        ? rawHeadIds
        : String(rawHeadIds || '').split(',').filter(Boolean);
      setForm({ 
        sub_name: prog.sub_name || generateSubName(prog.program_name),
        program_name: prog.program_name || '', 
        dept_id: prog.dept_id || '', // Handles null dept_id from DB
        head_ids: assignedHeadIds.map(String)
      });
    } else {
      setEditing(null);
      // Default to '' (None) instead of the first department
      setForm({ sub_name: '', program_name:'', dept_id: '', head_ids: [] });
    }
    setShowModal(true);
  };
  
  const closeModal = ()=> setShowModal(false);
  
  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((previous) => name === 'program_name'
      ? { ...previous, program_name: value, sub_name: generateSubName(value) }
      : { ...previous, [name]: value });
  };

  const validateForm = () => {
    const name = (form.program_name||'').trim();
    const subName = (form.sub_name || '').trim().toLowerCase();
    if (!subName) return 'Program sub name is required';
    if (!name) return 'Program name is required';
    if (!editing && !form.dept_id) return 'Department is required when adding a program';
    const duplicateSubName = subName && programs.find(p => String(p.sub_name || '').trim().toLowerCase() === subName && (!editing || Number(p.program_id) !== Number(editing.program_id)));
    if (duplicateSubName) return 'A program with the same sub name already exists';
    
    // Check for duplicate program names (case-insensitive)
    const dup = programs.find(p => p.program_name && String(p.program_name).toLowerCase() === name.toLowerCase() && (!editing || Number(p.program_id) !== Number(editing.program_id)));
    if (dup) return 'A program with the same name already exists';
    
    return null;
  };

  const headOptions = React.useMemo(() => {
    const selectedDeptId = form.dept_id ? String(form.dept_id) : '';
    const targetProgramId = editing?.program_id ? String(editing.program_id) : '';

    return (heads || []).filter(h => {
      if (selectedDeptId && h.dept_id && String(h.dept_id) !== selectedDeptId) return false;
      const assignedProgramId = h?.assigned_program_head_id !== null && h?.assigned_program_head_id !== undefined && String(h.assigned_program_head_id) !== ''
        ? String(h.assigned_program_head_id)
        : '';
      if (assignedProgramId && (!targetProgramId || assignedProgramId !== targetProgramId)) return false;
      return true;
    });
  }, [heads, form.dept_id, editing]);

  const activeDepartments = React.useMemo(() => departments.filter(d => String(d.status || '').toLowerCase() === 'active'), [departments]);

  React.useEffect(() => {
    const validIds = new Set(headOptions.map(h => String(h.user_id)));
    const nextIds = form.head_ids.filter(id => validIds.has(String(id)));
    if (nextIds.length !== form.head_ids.length) setForm(prev => ({ ...prev, head_ids: nextIds }));
  }, [headOptions, form.head_ids]);

  const handleHeadToggle = (userId) => {
    const id = String(userId);
    setForm(prev => ({
      ...prev,
      head_ids: prev.head_ids.includes(id)
        ? prev.head_ids.filter(value => value !== id)
        : [...prev.head_ids, id]
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');
    const v = validateForm();
    if (v) { try { if (window.Swal) await window.Swal.fire({ icon:'warning', title:'Validation', text: v }); else alert(v); } catch(e){} setLoading(false); return; }
    
    try{
      // LOGIC FIX: If dept_id is empty string, send null to backend
      const payload = { 
          sub_name: form.sub_name.trim() || null,
          program_name: form.program_name.trim(), 
          dept_id: form.dept_id ? Number(form.dept_id) : null, 
          head_ids: form.head_ids.map(Number),
          head_id: form.head_ids.length ? Number(form.head_ids[0]) : null
      };

      if (editing && editing.program_id) {
        await runWithFallback(
          () => apiPut(`programs/${editing.program_id}`, payload),
          () => apiPost(`programs/${editing.program_id}/update`, payload)
        );
      } else {
        await apiPost('programs', payload);
      }
      
      await loadProgramData();
      
      closeModal();
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: editing ? 'Program updated' : 'Program added', timer: 1400, showConfirmButton: false }); } catch(e){}
    } catch (err) {
      console.error(err);
      const msg = err?.body?.message || err?.body?.error || err?.message || 'Failed to save';
      try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: msg }); else alert(msg); } catch(e){}
      setError(msg);
    } finally { setLoading(false); }
  };

  const handleToggle = async (prog) => {
    if (!prog || !prog.program_id) return;
    const newStatus = String(prog.status) === 'active' ? 'inactive' : 'active';
    const action = newStatus === 'active' ? 'Activate' : 'Deactivate';
    const answer = window.Swal ? await window.Swal.fire({ title: `${action} program?`, text: `${prog.program_name || 'This program'} will be ${newStatus}.`, icon: 'question', showCancelButton: true, confirmButtonText: action }) : { isConfirmed: confirm(`${action} this program?`) };
    if (!answer.isConfirmed) return;
    try{
      await runWithFallback(
        () => apiPut(`programs/${prog.program_id}`, { status: newStatus }),
        () => apiPost(`programs/${prog.program_id}/update`, { status: newStatus })
      );
      await loadProgramData();
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'Status updated', timer:1200, showConfirmButton:false }); } catch(e){}
    } catch (err) { console.error(err); try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: err.body?.message || err.body?.error || err.message || 'Failed to update status' }); } catch(e){} }
  };

  const handleArchive = async (prog) => {
    if (!prog || !prog.program_id) return;
    try{
      const res = window.Swal ? await window.Swal.fire({ title: 'Archive program?', text: 'This will remove the program from the active list.', icon: 'warning', showCancelButton: true }) : { isConfirmed: confirm('Archive program?') };
      if (!res.isConfirmed) return;
      await runWithFallback(
        () => apiPut(`programs/${prog.program_id}`, { status: 'archive' }),
        () => apiPost(`programs/${prog.program_id}/update`, { status: 'archive' })
      );
      await loadProgramData();
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'Archived', timer:1200, showConfirmButton:false }); } catch(e){}
    } catch (err) { console.error(err); try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: err.body?.message || err.body?.error || err.message || 'Failed to archive' }); } catch(e){} }
  };

  const handleRestore = async (prog) => {
    if (!prog?.program_id) return;
    const result = window.Swal ? await window.Swal.fire({ title:'Restore program?', text:'The program will be restored as inactive for review.', icon:'question', showCancelButton:true }) : { isConfirmed:confirm('Restore program?') };
    if (!result.isConfirmed) return;
    try {
      await runWithFallback(() => apiPut(`programs/${prog.program_id}`, { status:'inactive' }), () => apiPost(`programs/${prog.program_id}/update`, { status:'inactive' }));
      await loadProgramData();
      if (window.Swal) await window.Swal.fire({ icon:'success', title:'Program restored', timer:1200, showConfirmButton:false });
    } catch (err) {
      if (window.Swal) await window.Swal.fire({ icon:'error', title:'Restore failed', text:err?.body?.message || err?.message || 'Failed to restore program' });
    }
  };

  const columns = [
    { key: 'rownum', label: '#', render: (r, pIdx, gIdx) => gIdx + 1 },
    { key: 'sub_name', label: 'Sub Name', render: (r) => r.sub_name || <span className="text-slate-400">—</span> },
    { key: 'program_name', label: 'Program Name' },
    // Show 'None' if dept_name is missing
    { key: 'dept_name', label: 'Department', render: (r) => r.dept_name || <span className="text-gray-400 italic">None</span> },
    { key: 'head', label: 'Program Heads', render: (r) => {
      const names = Array.isArray(r.head_names) ? r.head_names : String(r.head_names || '').split('||').filter(Boolean);
      const fallback = `${r.head_first || r.first_name || ''} ${r.head_last || r.last_name || ''}`.trim();
      const hasMultiHeadField = Object.prototype.hasOwnProperty.call(r, 'head_ids');
      const leaders = names.length ? names : (!hasMultiHeadField && fallback ? [fallback] : []);
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
      actions: (row) => String(row.status || '').toLowerCase() === 'archive'
        ? [{ label:'Restore', variant:'success', onClick:() => handleRestore(row) }]
        : [{ label:'Edit', onClick:() => openModal(row) }, { label:'Toggle', onClick:() => handleToggle(row) }, { label:'Archive', variant:'danger', onClick:() => handleArchive(row) }]
    });
  }

  const filteredPrograms = programs.filter((program) => {
    if ((String(program.status || '').toLowerCase() === 'archive') !== showArchived) return false;
    const query = search.trim().toLowerCase();
    const hasMultiHeadField = Object.prototype.hasOwnProperty.call(program, 'head_ids');
    const head = Array.isArray(program.head_names)
      ? program.head_names.join(' ')
      : `${program.head_names || ''}${hasMultiHeadField ? '' : ` ${program.head_first || program.first_name || ''} ${program.head_last || program.last_name || ''}`}`;
    const hasMultiHeadFieldForFilter = Object.prototype.hasOwnProperty.call(program, 'head_ids');
    const assignedIds = Array.isArray(program.head_ids) ? program.head_ids : String(program.head_ids || '').split(',').filter(Boolean);
    const hasNoHead = hasMultiHeadFieldForFilter ? assignedIds.length === 0 : !program.head_id && !program.head_first && !program.first_name;
    return (!query || `${program.sub_name || ''} ${program.program_name || ''} ${program.dept_name || ''} ${head}`.toLowerCase().includes(query)) && (departmentFilter === 'all' || String(program.dept_id) === departmentFilter) && String(program.status).toLowerCase() === statusFilter && (!needsHeadOnly || hasNoHead);
  });
  const activeCount = programs.filter((item) => String(item.status).toLowerCase() === 'active').length;
  const unassignedCount = programs.filter((item) => {
    const hasMultiHeadField = Object.prototype.hasOwnProperty.call(item, 'head_ids');
    const ids = Array.isArray(item.head_ids) ? item.head_ids : String(item.head_ids || '').split(',').filter(Boolean);
    return String(item.status).toLowerCase() === 'active' && (hasMultiHeadField
      ? ids.length === 0
      : !item.head_id && !item.head_first && !item.first_name);
  }).length;
  const inactiveCount = programs.filter((item) => String(item.status).toLowerCase() === 'inactive').length;
  const archivedCount = programs.filter((item) => String(item.status).toLowerCase() === 'archive').length;
  const selectProgramStatus = (status, needsHead = false) => {
    setStatusFilter(status);
    setNeedsHeadOnly(needsHead);
    setShowArchived(status === 'archive');
  };

  return (
    <div className="mdp-page">
      <MasterPageHeader title="Programs" description="Organize programs by department and keep Program Head assignments complete." action={isAdmin ? <button className="mdp-primary" onClick={()=>openModal()}>+ Add Program</button> : null} />
      <MasterStats loading={loading} items={[{ label: 'Active', value: activeCount, help: 'Available for scheduling', icon: '\u2713', active: statusFilter === 'active' && !needsHeadOnly, onClick: () => selectProgramStatus('active') }, { label: 'Needs Program Head', value: unassignedCount, help: 'Active without a Program Head', icon: '!', tone: 'amber', active: needsHeadOnly, onClick: () => selectProgramStatus('active', true) }, { label: 'Inactive', value: inactiveCount, help: 'Currently unavailable', icon: 'I', tone: 'red', active: statusFilter === 'inactive', onClick: () => selectProgramStatus('inactive') }, { label: 'Archived', value: archivedCount, help: 'Available for restoration', icon: 'A', active: statusFilter === 'archive', onClick: () => selectProgramStatus('archive') }]} />

      {!isAdmin && <div className="alert alert-info py-2 mb-3">View-only access: You can only view programs assigned to you.</div>}

      {error && <div className="mb-3 text-red-600">{error}</div>}

      <MasterToolbar><MasterSearch value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search program, department, or head..." /><MasterSelect label="Department" value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)}><option value="all">All departments</option>{departments.map((department) => <option key={department.dept_id} value={department.dept_id}>{department.dept_name}</option>)}</MasterSelect><MasterSelect label="Status" value={statusFilter} onChange={(event) => selectProgramStatus(event.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option><option value="archive">Archived</option></MasterSelect></MasterToolbar>
      <MasterResults title="Program Directory" count={filteredPrograms.length} loading={loading} description="Program ownership, department assignment, and current availability."><Table columns={columns} data={filteredPrograms} loading={loading} pageSize={10} /></MasterResults>

      <Modal show={showModal} title={editing ? 'Edit Program' : 'Add Program'} onClose={closeModal} size="md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Department</label>
            <select name="dept_id" value={form.dept_id} onChange={handleChange} required={!editing} className="block w-full border border-gray-200 rounded px-3 py-2">
              <option value="">{editing ? 'None' : 'Select a department'}</option>
              {editing && form.dept_id && !activeDepartments.some(d => String(d.dept_id) === String(form.dept_id)) && <option value={form.dept_id}>{editing.dept_name || 'Current department'} (Inactive)</option>}
              {activeDepartments.map(d => <option key={d.dept_id} value={d.dept_id}>{d.dept_name}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Sub Name</label>
            <input name="sub_name" value={form.sub_name} onChange={handleChange} required maxLength={30} placeholder="Automatically generated from capital letters" className="block w-full border border-gray-200 rounded px-3 py-2" />
            <p className="mt-1 text-xs text-gray-500">Automatically uses capital letters and numbers from the Program Name. You may still edit it.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Program Name</label>
            <input name="program_name" value={form.program_name} onChange={handleChange} required className="block w-full border border-gray-200 rounded px-3 py-2" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Program Heads</label>
            <p className="mb-2 text-xs text-gray-500">Select unassigned Program Heads or heads already assigned here. Transfer assignments from the User page.</p>
            <div className="max-h-52 space-y-2 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-3">
              {headOptions.length === 0 ? <div className="text-sm text-gray-500">No Program Head users are available for this department.</div> : headOptions.map(h => {
                const id = String(h.user_id);
                return (
                  <label key={id} className="flex cursor-pointer items-center gap-3 rounded-lg bg-white px-3 py-2 shadow-sm">
                    <input type="checkbox" checked={form.head_ids.includes(id)} onChange={() => handleHeadToggle(id)} className="h-4 w-4 rounded border-gray-300 text-emerald-600" />
                    <span className="text-sm font-medium text-gray-800">{h.first_name} {h.last_name}{h.assigned_program_name ? ` — ${h.assigned_program_name}` : ' — Unassigned'}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeModal} className="px-3 py-2 rounded border">Cancel</button>
            <button type="submit" disabled={loading} className="px-4 py-2 rounded bg-green-600 text-white">{loading ? 'Saving...' : (editing ? 'Update Program' : 'Save Program')}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default ProgramIndex;
