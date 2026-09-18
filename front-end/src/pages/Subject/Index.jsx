import React, { useState, useEffect, useMemo, useRef } from "react";
import Table from "../../components/Table.jsx";
import Modal from "../../components/Modal.jsx";
import { apiGet, apiPost, apiPut } from '../../services/api.js';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';
import { MasterPageHeader, MasterStats, MasterToolbar, MasterSearch, MasterResults, MasterSelect } from '../../components/MasterDataPage.jsx';
import { formatDepartmentLabel, formatProgramLabel } from '../../utils/academicLabels.js';

function SubjectIndex() {
  const [subjects, setSubjects] = useState([]);
  const [subjectIdentities, setSubjectIdentities] = useState([]);
  const [subjectPage, setSubjectPage] = useState(1);
  const [subjectPagination, setSubjectPagination] = useState({ page: 1, page_size: 10, total: 0, total_pages: 1 });
  const [subjectStatusCounts, setSubjectStatusCounts] = useState({ active: 0, inactive: 0, archive: 0 });
  const [programs, setPrograms] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ dept_id:'', program_id:'', subject_code:'', subject_name:'' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // States for Table UI Filters
  const [filterDept, setFilterDept] = useState('');
  const [filterProgram, setFilterProgram] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const subjectRequestRef = useRef(0);

  // Authentication & Role Check logic
  const user = (() => { try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch(e) { return null; } })();
  const isAdmin = Number(user?.role_id) === 1;
  const isDean = [2, 6].includes(Number(user?.role_id));
  const isProgramHead = Number(user?.role_id) === 3;
  const isSecretary = Number(user?.role_id) === 4;
  
  // Only admin and dean can manage subjects.
  const canEdit = isAdmin || isDean;
  const canAdd = isAdmin || isDean;

  const runWithFallback = async (primary, fallback) => {
    try { return await primary(); } catch (err) { if (err?.status === 405 || err?.status === 500) return await fallback(); throw err; }
  };

  const loadSubjectIdentities = React.useCallback(async () => {
    const data = await apiGet('subjects?identities=1');
    setSubjectIdentities(Array.isArray(data) ? data : []);
  }, []);

  const loadReferenceData = React.useCallback(async () => {
    try {
      const [p, d, identities] = await Promise.all([
        apiGet('programs'),
        apiGet('departments'),
        apiGet('subjects?identities=1'),
      ]);
      setPrograms(Array.isArray(p) ? p : []);
      setDepartments(Array.isArray(d) ? d : []);
      setSubjectIdentities(Array.isArray(identities) ? identities : []);
    } catch (e) {
      console.error(e);
      setError('Failed to load subject filter options');
    }
  }, []);

  const loadData = React.useCallback(async ({ silent = false } = {}) => {
    const requestId = ++subjectRequestRef.current;
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      const params = new URLSearchParams({
        paginate: '1',
        page: String(subjectPage),
        page_size: '10',
        status: statusFilter,
      });
      if (filterDept) params.set('dept_id', filterDept);
      if (filterProgram) params.set('program_id', filterProgram);
      if (debouncedSearch) params.set('search', debouncedSearch);
      const data = await apiGet(`subjects?${params.toString()}`);
      if (requestId !== subjectRequestRef.current) return;
      const nextRows = Array.isArray(data?.rows) ? data.rows : [];
      const nextPagination = data?.pagination || { page: 1, page_size: 10, total: nextRows.length, total_pages: 1 };
      setSubjects(nextRows);
      setSubjectPagination(nextPagination);
      setSubjectStatusCounts(data?.status_counts || { active: 0, inactive: 0, archive: 0 });
      if (Number(nextPagination.page || 1) !== Number(subjectPage)) setSubjectPage(Number(nextPagination.page || 1));
    } catch(e) {
      if (requestId !== subjectRequestRef.current) return;
      console.error(e);
      if (!silent) setError('Failed to load subjects');
    } finally {
      if (requestId === subjectRequestRef.current && !silent) setLoading(false);
    }
  }, [subjectPage, statusFilter, filterDept, filterProgram, debouncedSearch]);

  useEffect(() => { loadReferenceData(); }, [loadReferenceData]);
  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSubjectPage(1);
      setDebouncedSearch(search.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  useAutoRefresh({
    refresh: () => loadData({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.ADMIN,
    enabled: !showModal,
  });

  const displayData = useMemo(() => {
    return subjects.map((sub, i) => ({
      ...sub,
      display_index: (Number(subjectPagination.page || 1) - 1) * Number(subjectPagination.page_size || 10) + i + 1
    }));
  }, [subjects, subjectPagination]);

  // Dropdown list for Filtering view
  const availablePrograms = useMemo(() => {
    let list = programs;
    if (isAdmin && filterDept) list = list.filter(p => String(p.dept_id) === String(filterDept));
    if (isProgramHead) {
      return list;
    } else if (isDean || isSecretary) {
      list = list.filter(p => Number(p.dept_id) === Number(user?.dept_id));
    }
    return list;
  }, [programs, isProgramHead, isDean, isSecretary, isAdmin, user, filterDept]);

  const activeDepartments = useMemo(() => departments.filter((department) => String(department.status || '').toLowerCase() === 'active'), [departments]);
  const fixedDepartment = useMemo(() => departments.find((department) => Number(department.dept_id) === Number(user?.dept_id)) || null, [departments, user]);

  // Dropdown strictly for Add/Edit Modal (Program Head can only see their exact program here)
  const addEditPrograms = useMemo(() => {
    let list = programs.filter(p => String(p.status || '').toLowerCase() === 'active' && String(p.department_status || '').toLowerCase() === 'active');
    if (isAdmin && form.dept_id) list = list.filter(p => String(p.dept_id) === String(form.dept_id));
    if (isProgramHead) {
      return list;
    } else if (isDean) {
      list = list.filter(p => Number(p.dept_id) === Number(user?.dept_id));
    }
    return list;
  }, [programs, isProgramHead, isDean, isAdmin, user, form.dept_id]);

  useEffect(() => {
    if (filterProgram && !availablePrograms.some((program) => String(program.program_id) === String(filterProgram))) setFilterProgram('');
  }, [availablePrograms, filterProgram]);


  const checkManagePermission = (row) => {
    if (isAdmin) return true;
    if (isDean && Number(row?.dept_id) !== Number(user?.dept_id)) {
      try { if (window.Swal) window.Swal.fire('Unauthorized', 'You can only modify subjects inside your assigned department.', 'error'); else alert('Unauthorized'); } catch(e){}
      return false;
    }
    return isDean;
  };

  const openModal = (it=null) => {
    setError('');
    if (it) {
      if (!checkManagePermission(it)) return;
      setEditing(it);
      setForm({ dept_id: it.dept_id || '', program_id: it.program_id || '', subject_code: it.subject_code || '', subject_name: it.subject_name || '' });
    } else {
      if (!canAdd) return;
      setEditing(null);
      const defaultDeptId = isAdmin ? (activeDepartments[0]?.dept_id || '') : (user?.dept_id || '');
      const defaultProgram = programs.find((program) => String(program.status || '').toLowerCase() === 'active' && String(program.dept_id) === String(defaultDeptId));
      setForm({ dept_id: defaultDeptId, program_id: defaultProgram?.program_id || '', subject_code:'', subject_name:'' });
    }
    setShowModal(true);
  };
  
  const closeModal = () => setShowModal(false);
  const handleChange = (e) => setForm(p=>({...p, [e.target.name]: e.target.value, ...(e.target.name === 'dept_id' ? { program_id: '' } : {})}));

  const validateForm = () => {
    if (!form.program_id) return 'Program is required';
    if (!form.subject_code || !form.subject_code.trim()) return 'Subject code is required';
    if (!form.subject_name || !form.subject_name.trim()) return 'Subject name is required';
    const code = String(form.subject_code).trim().toLowerCase();
    const name = String(form.subject_name).trim().toLowerCase();
    const dup = subjectIdentities.find(s => Number(s.program_id) === Number(form.program_id) && (!editing || Number(s.subject_id) !== Number(editing.subject_id)) && (String(s.subject_code||'').trim().toLowerCase() === code || String(s.subject_name||'').trim().toLowerCase() === name));
    if (dup) return 'A subject with the same code or name already exists for the selected program';
    return null;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');
    const v = validateForm();
    if (v) { try { if (window.Swal) await window.Swal.fire({ icon:'warning', title:'Validation', text: v }); else alert(v); } catch(e){} setLoading(false); return; }

    try{
      const payload = { program_id: Number(form.program_id), subject_code: form.subject_code.trim(), subject_name: form.subject_name.trim() };
      if (editing && editing.subject_id) {
        await runWithFallback(
          () => apiPut(`subjects/${editing.subject_id}`, payload),
          () => apiPost(`subjects/${editing.subject_id}/update`, payload)
        );
      } else {
        if (!canAdd) {
          const msg = 'Only admin and dean can add subjects.';
          try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Unauthorized', text: msg }); else alert(msg); } catch(e){}
          setLoading(false);
          return;
        }
        await apiPost('subjects', payload);
      }
      await Promise.all([loadData({ silent: true }), loadSubjectIdentities()]);
      closeModal();
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: editing ? 'Subject updated' : 'Subject added', timer:1400, showConfirmButton:false }); } catch(e){}
    } catch (err) {
      console.error(err);
      const msg = err?.body?.message || err?.body?.error || err?.message || 'Failed to save';
      try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: msg }); else alert(msg); } catch(e){}
      setError(msg);
    } finally { setLoading(false); }
  };

  const handleToggle = async (row) => {
    if (!row || !row.subject_id) return;
    if (!checkManagePermission(row)) return;

    const newStatus = String(row.status) === 'active' ? 'inactive' : 'active';
    const action = newStatus === 'active' ? 'Activate' : 'Deactivate';
    const answer = window.Swal ? await window.Swal.fire({ title: `${action} subject?`, text: `${row.subject_code || row.subject_name || 'This subject'} will be ${newStatus}.`, icon: 'question', showCancelButton: true, confirmButtonText: action }) : { isConfirmed: confirm(`${action} this subject?`) };
    if (!answer.isConfirmed) return;
    try {
      await runWithFallback(
        () => apiPut(`subjects/${row.subject_id}`, { status: newStatus }),
        () => apiPost(`subjects/${row.subject_id}/update`, { status: newStatus })
      );
      await Promise.all([loadData({ silent: true }), loadSubjectIdentities()]);
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'Status updated', timer:1200, showConfirmButton:false }); } catch(e){}
    } catch (err) { console.error(err); try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: err.body?.message || err.body?.error || err.message || 'Failed to update status' }); } catch(e){} }
  };

  const handleArchive = async (row) => {
    if (!row || !row.subject_id) return;
    if (!checkManagePermission(row)) return;

    try{
      const res = window.Swal ? await window.Swal.fire({ title: 'Archive subject?', text: 'This will remove the subject from the active list.', icon: 'warning', showCancelButton: true }) : { isConfirmed: confirm('Archive subject?') };
      if (!res.isConfirmed) return;
      await runWithFallback(
        () => apiPut(`subjects/${row.subject_id}`, { status: 'archive' }),
        () => apiPost(`subjects/${row.subject_id}/update`, { status: 'archive' })
      );
      await Promise.all([loadData({ silent: true }), loadSubjectIdentities()]);
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'Archived', timer:1200, showConfirmButton:false }); } catch(e){}
    } catch (err) { console.error(err); try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: err.body?.message || err.body?.error || err.message || 'Failed to archive' }); } catch(e){} }
  };

  const handleRestore = async (row) => {
    if (!row?.subject_id || !checkManagePermission(row)) return;
    const result = window.Swal ? await window.Swal.fire({ title:'Restore subject?', text:'The subject will be restored as inactive for review.', icon:'question', showCancelButton:true }) : { isConfirmed: confirm('Restore subject?') };
    if (!result.isConfirmed) return;
    try {
      await runWithFallback(() => apiPut(`subjects/${row.subject_id}`, { status:'inactive' }), () => apiPost(`subjects/${row.subject_id}/update`, { status:'inactive' }));
      await Promise.all([loadData(), loadSubjectIdentities()]);
      if (window.Swal) await window.Swal.fire({ icon:'success', title:'Subject restored', timer:1200, showConfirmButton:false });
    } catch (err) {
      if (window.Swal) await window.Swal.fire({ icon:'error', title:'Restore failed', text:err?.body?.message || err?.message || 'Failed to restore subject' });
    }
  };

  const columns = [
    { key: 'display_index', label: '#' },
    { key: 'subject_code', label: 'Code' },
    { key: 'subject_name', label: 'Name' },
    { key: 'dept_name', label: 'Department', render: (row) => formatDepartmentLabel({ sub_name: row.department_sub_name, dept_name: row.dept_name }, 'N/A') },
    { key: 'program_name', label: 'Program', render: (row) => formatProgramLabel({ sub_name: row.program_sub_name, program_name: row.program_name }, 'N/A') },
    { key: 'status', label: 'Status', render: (r) => {
      const s = (r.status||'').toLowerCase();
      const cls = s === 'active' ? 'bg-success' : (s === 'inactive' ? 'bg-danger' : 'bg-secondary');
      const text = s === 'active' ? 'Active' : (s === 'inactive' ? 'Inactive' : (r.status||'N/A'));
      return (<span className={`mdp-status mdp-status-${s}`}>{text}</span>);
    }}
  ];

  if (canEdit) {
    columns.push({ 
      key: 'actions', 
      label: 'Actions', 
      actions: (row) => String(row.status || '').toLowerCase() === 'archive'
        ? [{ label:'Restore', variant:'success', onClick:() => handleRestore(row) }]
        : [{ label:'Edit', onClick:() => openModal(row) }, { label:'Toggle', onClick:() => handleToggle(row) }, { label:'Archive', variant:'danger', onClick:() => handleArchive(row) }]
    });
  }

  const selectSubjectStatus = (status) => {
    setSubjectPage(1);
    setStatusFilter(status);
  };
  const subjectStatusCount = (status) => Number(subjectStatusCounts?.[status] || 0);

  return (
    <div className="mdp-page">
      <MasterPageHeader title="Subjects" description="Maintain the subject catalog and its program ownership." action={canAdd ? <button className="mdp-primary" onClick={()=>openModal()}>+ Add Subject</button> : null} />
      <MasterStats loading={loading} items={[{ label: 'Active', value: subjectStatusCount('active'), help: 'Ready for assignment', icon: '\u2713', active: statusFilter === 'active', onClick: () => selectSubjectStatus('active') }, { label: 'Inactive', value: subjectStatusCount('inactive'), help: 'Currently unavailable', icon: 'I', tone: 'red', active: statusFilter === 'inactive', onClick: () => selectSubjectStatus('inactive') }, { label: 'Archived', value: subjectStatusCount('archive'), help: 'Available for restoration', icon: 'A', active: statusFilter === 'archive', onClick: () => selectSubjectStatus('archive') }]} />
      <MasterToolbar><MasterSearch value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search code, subject, department, or program..." />{isAdmin ? <MasterSelect label="Department" value={filterDept} onChange={(event) => { setSubjectPage(1); setFilterDept(event.target.value); setFilterProgram(''); }}><option value="">All departments</option>{activeDepartments.map((department) => <option key={department.dept_id} value={department.dept_id}>{formatDepartmentLabel(department, department.dept_id)}</option>)}</MasterSelect> : <div className="mdp-filter"><span>Department</span><div className="rounded border border-gray-200 bg-gray-100 px-3 py-2 text-sm text-gray-700">{formatDepartmentLabel(fixedDepartment, 'No assigned department')}</div></div>}<MasterSelect label="Program" value={filterProgram} onChange={(event) => { setSubjectPage(1); setFilterProgram(event.target.value); }}><option value="">All programs</option>{availablePrograms.map((program) => <option key={program.program_id} value={program.program_id}>{formatProgramLabel(program, program.program_id)}</option>)}</MasterSelect><MasterSelect label="Status" value={statusFilter} onChange={(event) => selectSubjectStatus(event.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option><option value="archive">Archived</option></MasterSelect></MasterToolbar>

      {error && <div className="mb-3 text-red-600">{error}</div>}

      <MasterResults title="Subject Catalog" count={Number(subjectPagination.total || 0)} loading={loading} description="Course codes, names, and assigned programs."><Table columns={columns} data={displayData} loading={loading} pageSize={Number(subjectPagination.page_size || 10)} serverPagination totalItems={Number(subjectPagination.total || 0)} page={subjectPage} onPageChange={setSubjectPage} /></MasterResults>

      <Modal show={showModal} title={editing ? 'Edit Subject' : 'Add Subject'} onClose={closeModal}>
        <form onSubmit={handleSubmit} className="space-y-4">
          {isAdmin ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Department</label>
              <select name="dept_id" value={form.dept_id} onChange={handleChange} required className="block w-full border border-gray-200 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-green-500">
                <option value="">Select department...</option>
                {activeDepartments.map((department) => <option key={department.dept_id} value={department.dept_id}>{formatDepartmentLabel(department, department.dept_id)}</option>)}
              </select>
            </div>
          ) : (
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Department</label><div className="rounded border border-gray-200 bg-gray-100 px-3 py-2">{formatDepartmentLabel(fixedDepartment, 'No assigned department')}</div></div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Program</label>
            <select name="program_id" value={form.program_id} onChange={handleChange} required className="block w-full border border-gray-200 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-green-500">
              <option value="">{addEditPrograms.length ? 'Select program...' : 'No programs available'}</option>
              {addEditPrograms.map(p => <option key={p.program_id} value={p.program_id}>{formatProgramLabel(p, p.program_id)}</option>)}
            </select>
            {isDean && (
              <div className="mt-1 text-xs text-gray-500">
                Programs are limited to your assigned department.
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Subject Code</label>
            <input name="subject_code" value={form.subject_code} onChange={handleChange} required className="block w-full border border-gray-200 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-green-500" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Subject Name</label>
            <input name="subject_name" value={form.subject_name} onChange={handleChange} required className="block w-full border border-gray-200 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-green-500" />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={closeModal} className="px-3 py-2 rounded border bg-white text-sm">Cancel</button>
            <button type="submit" disabled={loading} className="px-4 py-2 rounded bg-green-600 text-white hover:bg-green-700">{loading ? 'Saving...' : (editing ? 'Update Subject' : 'Save Subject')}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default SubjectIndex;
