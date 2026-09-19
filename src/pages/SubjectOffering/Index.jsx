import React, { useState, useEffect, useMemo, useRef } from 'react';
import { apiGet, apiPost, apiPut, apiDelete } from '../../services/api.js';
import Table from "../../components/Table.jsx";
import Modal from "../../components/Modal.jsx";
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';

function SubjectOfferingIndex() {
  const [items, setItems] = useState([]);
  const [subjects, setSubjects] = useState([]);
  const [sections, setSections] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [semesters, setSemesters] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [departments, setDepartments] = useState([]);

  // States for Table UI Filters
  const [filterSubject, setFilterSubject] = useState('');
  const [filterTeacher, setFilterTeacher] = useState('');

  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ semester_id: '', section_id: '', subject_id: '', user_id: '' });
  const [loading, setLoading] = useState(false);
  const [dataLoading, setDataLoading] = useState(true);
  const [error, setError] = useState('');

  // Spreadsheet import states
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState(null);
  const [importErrors, setImportErrors] = useState([]);
  const fileInputRef = useRef(null);

  // Authentication & Role Check logic
  const user = (() => { try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch(e) { return null; } })();
  const isAdmin = Number(user?.role_id) === 1;
  const isDean = [2, 6].includes(Number(user?.role_id));
  const isProgramHead = Number(user?.role_id) === 3;
  const isSecretary = Number(user?.role_id) === 4;
  
  // Only Admin and Program Heads can edit, delete, or import
  const canEdit = isAdmin || isProgramHead;

  const runWithFallback = async (primary, fallback) => {
    try { return await primary(); } catch (err) { if (err?.status === 405 || err?.status === 500) return await fallback(); throw err; }
  };

  useEffect(() => { 
    (async () => {
      setDataLoading(true);
      try{ 
        const [data, s, sec, sem, teachersRes, prog, dept] = await Promise.all([
          apiGet('subject-offerings'), 
          apiGet('subjects'), 
          apiGet('sections'), 
          apiGet('semesters'), 
          apiGet('users?list=1&teaching_roles=1&include_inactive=1').catch(() => []),
          apiGet('programs'),
          apiGet('departments')
        ]);
        
        let teacherList = Array.isArray(teachersRes) ? teachersRes : [];
        if (!teacherList.length || !('role_id' in (teacherList[0] || {}))) {
          try {
            const users = await apiGet('users?list=1&teaching_roles=1&include_inactive=1');
            teacherList = Array.isArray(users) ? users.filter(u => [2,3,4,5].includes(Number(u.role_id))).map(u => ({ ...u, user_id: u.user_id || u.id })) : teacherList;
          } catch(e) {}
        } else {
          teacherList = teacherList.map(ti => ({ ...(ti||{}), role_id: ti.role_id ?? 5, user_id: ti.user_id ?? ti.id }));
        }

        setItems(Array.isArray(data) ? data : []); 
        setSubjects(Array.isArray(s) ? s : []); 
        setSections(Array.isArray(sec) ? sec : []); 
        setSemesters(Array.isArray(sem) ? sem : []); 
        setTeachers(teacherList);
        setPrograms(Array.isArray(prog) ? prog : []); 
        setDepartments(Array.isArray(dept) ? dept : []);
      } catch(e){ 
        console.error(e); 
        setError('Failed to load subject offerings or related data'); 
      } finally {
        setDataLoading(false);
      }
    })(); 
  }, []);

  // --- BULLETPROOF ROLE-BASED VISIBILITY & FILTERING ---
  const visibleOfferings = useMemo(() => {
    return items.filter(it => {
      if (isAdmin) return true;
      
      if (!user?.dept_id) return false; 
      
      if (isProgramHead || isDean || isSecretary) {
        const uDept = String(user.dept_id);
        const tDept = it.teacher_dept_id ? String(it.teacher_dept_id) : null;
        const pDept = it.program_dept_id ? String(it.program_dept_id) : null;
        
        // STRICT RULE: If a teacher is assigned and they belong to a DIFFERENT department, 
        // completely hide this row so you never see users from outside your department.
        if (tDept && tDept !== uDept) {
          return false;
        }
        
        // If the strict rule passes, show it if either the teacher OR the program belongs to your department.
        return (tDept === uDept) || (pDept === uDept);
      }
      return false;
    });
  }, [items, isAdmin, isProgramHead, isDean, isSecretary, user]);

  const displayedAndFiltered = useMemo(() => {
    return visibleOfferings.filter(it => {
      if (filterSubject && String(it.subject_id) !== String(filterSubject)) return false;
      if (filterTeacher && String(it.user_id) !== String(filterTeacher)) return false;
      return true;
    });
  }, [visibleOfferings, filterSubject, filterTeacher]);

  const displayData = useMemo(() => {
    return displayedAndFiltered.map((it, i) => ({
      ...it,
      id: it.offering_id || `offering-${i}`, 
      display_index: i + 1
    }));
  }, [displayedAndFiltered]);


  const availableSubjectsFilter = useMemo(() => {
    let list = subjects;
    if (!isAdmin && user?.dept_id) {
      list = list.filter(s => s.dept_id && String(s.dept_id) === String(user.dept_id));
    }
    return list;
  }, [subjects, isAdmin, user]);

  const availableTeachers = useMemo(() => {
    let list = teachers.filter(t => String(t.status || 'active').toLowerCase() === 'active');
    if (!isAdmin && user?.dept_id) {
      list = list.filter(t => t.dept_id && String(t.dept_id) === String(user.dept_id));
    }
    return list;
  }, [teachers, isAdmin, user]);

  const historicalTeacherOptions = useMemo(() => {
    let list = teachers.filter(t => [2, 3, 4, 5].includes(Number(t.role_id)));
    if (!isAdmin && user?.dept_id) {
      list = list.filter(t => t.dept_id && String(t.dept_id) === String(user.dept_id));
    }
    return list;
  }, [teachers, isAdmin, user]);

  const activeProgramIds = useMemo(() => {
    const activeDepartmentIds = new Set(departments.filter(d => String(d.status || '').toLowerCase() === 'active').map(d => String(d.dept_id)));
    return new Set(programs.filter(p => String(p.status || '').toLowerCase() === 'active' && activeDepartmentIds.has(String(p.dept_id))).map(p => String(p.program_id)));
  }, [programs, departments]);

  const activeSemesters = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return semesters.filter((semester) => {
      if (String(semester.status || '').toLowerCase() !== 'active') return false;
      const start = semester.start_date ? new Date(`${semester.start_date}T00:00:00`) : null;
      const end = semester.end_date ? new Date(`${semester.end_date}T23:59:59`) : null;
      return start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && today >= start && today <= end;
    });
  }, [semesters]);

  const addEditSubjects = useMemo(() => {
    let list = subjects.filter(s => String(s.status || '').toLowerCase() === 'active' && activeProgramIds.has(String(s.program_id)));
    if (isProgramHead) {
      return list;
    }
    return list;
  }, [subjects, isProgramHead, activeProgramIds]);

  const addEditSections = useMemo(() => {
    let list = sections.filter(s => String(s.status || '').toLowerCase() === 'active' && activeProgramIds.has(String(s.program_id)));
    if (isProgramHead) {
      return list;
    }
    return list;
  }, [sections, isProgramHead, activeProgramIds]);


  const checkProgramHeadPermission = (rowHeadId) => {
    if (isAdmin) return true;
    // The backend already returns only programs assigned to this Program Head,
    // including secondary heads in a multi-head program.
    if (isProgramHead) return true;
    return true;
  };

  const openModal = (it=null) => {
    setError('');
    if (it) {
      if (!checkProgramHeadPermission(it.head_id)) return;

      setEditing(it);
      setForm({ semester_id: activeSemesters.some(s => String(s.semester_id) === String(it.semester_id)) ? it.semester_id : '', section_id: it.section_id || '', subject_id: it.subject_id || '', user_id: it.user_id || '' });
    } else {
      setEditing(null);
      setForm({ semester_id: activeSemesters[0]?.semester_id || '', section_id: addEditSections[0]?.section_id || '', subject_id: '', user_id: '' });
    }
    setShowModal(true);
  };
  
  const closeModal = () => setShowModal(false);
  const handleChange = (e) => setForm(p => ({...p, [e.target.name]: e.target.value}));

  const validateForm = () => {
    if (!form.semester_id) return 'Semester is required';
    if (!form.section_id) return 'Section is required';
    if (!form.subject_id) return 'Subject is required';
    
    const dup = items.find(o => Number(o.subject_id) === Number(form.subject_id) && Number(o.section_id) === Number(form.section_id) && Number(o.semester_id) === Number(form.semester_id) && (!editing || Number(o.offering_id) !== Number(editing.offering_id)));
    if (dup) return 'The same subject offering (subject + section + semester) already exists.';
    return null;
  };

  const refresh = async () => {
    const data = await apiGet('subject-offerings');
    setItems(Array.isArray(data) ? data : []);
  };

  useAutoRefresh({
    refresh,
    intervalMs: AUTO_REFRESH_INTERVALS.ADMIN,
    enabled: !showModal,
  });

  const handleSubmit = async (e) => { 
    e.preventDefault(); 
    setLoading(true); 
    setError(''); 
    const v = validateForm(); 
    if (v) { try { if (window.Swal) await window.Swal.fire({ icon:'warning', title:'Validation', text: v }); else alert(v); } catch(e){} setLoading(false); return; }
    try{
      const payload = { semester_id: Number(form.semester_id), subject_id: Number(form.subject_id), section_id: Number(form.section_id), user_id: form.user_id === '' ? null : Number(form.user_id) };
      if (editing && editing.offering_id) {
        await runWithFallback(
          () => apiPut(`subject-offerings/${editing.offering_id}`, payload),
          () => apiPost(`subject-offerings/${editing.offering_id}/update`, payload)
        );
      } else {
        await apiPost('subject-offerings', payload);
      }
      await refresh();
      closeModal();
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: editing ? 'Offering updated' : 'Offering added', timer:1400, showConfirmButton:false }); } catch(e){}
    } catch (err) { console.error(err); const msg = err?.body?.message || err?.body?.error || err?.message || 'Failed to save'; try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: msg }); else alert(msg); } catch(e){} setError(msg); } finally{ setLoading(false); } 
  };

  const handleDelete = async (offering) => {
    if (!offering?.offering_id) return;
    if (!checkProgramHeadPermission(offering.head_id)) return;

    setError('');
    try {
      if (window.Swal) {
        const res = await window.Swal.fire({ title: 'Delete offering?', text: 'This action cannot be undone.', icon: 'warning', showCancelButton: true, confirmButtonText: 'Delete', cancelButtonText: 'Cancel' });
        if (!res.isConfirmed) return;
      } else {
        const ok = window.confirm('Delete this offering?'); if (!ok) return;
      }

      await runWithFallback(
        () => apiDelete(`subject-offerings/${offering.offering_id}`),
        () => apiPost(`subject-offerings/${offering.offering_id}/delete`, {})
      );
      await refresh();
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'Deleted', timer: 1200, showConfirmButton: false }); } catch(e){}
    } catch (err) {
      console.error(err);
      try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: err.body?.message || err.body?.error || err.message || 'Failed to delete offering' }); else alert(err.body?.error || err.message || 'Failed to delete offering'); } catch(e){}
    }
  };

  // --- SPREADSHEET IMPORT LOGIC ---
  const getFileArrayBuffer = (file) => {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  };

  const parseSpreadsheet = async (file) => {
    if (!window.XLSX) throw new Error('Spreadsheet parser is not available. Please reload the page.');
    const buffer = await getFileArrayBuffer(file);
    const workbook = window.XLSX.read(buffer, { type: 'array' });
    const sheetName = workbook.SheetNames && workbook.SheetNames[0];
    if (!sheetName) return [];
    const worksheet = workbook.Sheets[sheetName];
    const rows = window.XLSX.utils.sheet_to_json(worksheet, { defval: '', raw: false });
    return Array.isArray(rows) ? rows : [];
  };

  const handleImportFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setImporting(true);
    setImportSummary(null);
    setImportErrors([]);
    setError('');
    try {
      const rows = await parseSpreadsheet(file);
      const cleaned = rows.filter(r => Object.values(r || {}).some(v => String(v ?? '').trim() !== ''));
      if (!cleaned.length) {
        setError('No data rows found in the spreadsheet.');
        return;
      }
      const result = await apiPost('subject-offerings', { rows: cleaned });
      setImportSummary({
        inserted: Number(result?.inserted || 0),
        skipped: Number(result?.skipped || 0),
        total: cleaned.length,
      });
      const errs = Array.isArray(result?.errors) ? result.errors : [];
      setImportErrors(errs);
      if (errs.length) setError('Some rows failed to import. See details below.');
      await refresh();
    } catch (err) {
      console.error(err);
      setError(err.body?.error || err.message || 'Failed to import spreadsheet');
    } finally {
      setImporting(false);
      if (e.target) e.target.value = '';
    }
  };

  const columns = [
    { key: 'display_index', label: '#', render: (it) => <div style={{ whiteSpace: 'nowrap' }}>{it.display_index}</div> },
    { key: 'subject_code', label: 'Subject Code', render: (it) => <div style={{ whiteSpace: 'nowrap' }}>{it.subject_code}</div> },
    { key: 'subject_name', label: 'Subject', render: (it) => <div style={{ whiteSpace: 'nowrap', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis' }} title={it.subject_name}>{it.subject_name}</div> },
    { key: 'term', label: 'Semester', render: (it) => <div style={{ whiteSpace: 'nowrap' }}>{it.term}</div> },
    { key: 'section_name', label: 'Section', render: (it) => <div style={{ whiteSpace: 'nowrap' }}>{it.section_name}</div> },
    { key: 'teacher_name', label: 'Teacher', render: (it) => <div style={{ whiteSpace: 'nowrap' }}>{it.teacher_name || 'N/A'}</div> }
  ];

  if (canEdit) {
    columns.push({ 
      key: 'actions', 
      label: 'Actions', 
      actions: [
        { label: 'Edit', onClick: (row) => openModal(row) },
        { label: 'Delete', onClick: (row) => handleDelete(row) }
      ] 
    });
  }

  return (
    <div className="p-6">
      <div className="flex flex-col sm:flex-row justify-between items-center mb-4 gap-3">
        <h2 className="text-2xl font-semibold m-0">Subject Offerings</h2>
        
        {canEdit && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current && fileInputRef.current.click()}
              disabled={importing}
              className="inline-flex items-center gap-2 px-3 py-2 rounded bg-white border text-sm hover:bg-gray-50"
            >
              {importing ? 'Importing...' : 'Import Spreadsheet'}
            </button>

            <button 
              className="inline-flex items-center gap-2 px-3 py-2 rounded bg-green-600 text-white text-sm hover:bg-green-700 border-0" 
              onClick={()=>openModal()}
              disabled={importing}
            >
              Add Offering
            </button>
            
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleImportFile}
              style={{display:'none'}}
            />
          </div>
        )}
      </div>

      <div className="bg-gray-50 p-4 rounded mb-4 flex flex-col sm:flex-row gap-4 border border-gray-200">
        <div className="flex-1">
          <label className="block text-xs text-gray-500 mb-1 font-semibold uppercase">Filter by Subject</label>
          <select className="w-full border border-gray-300 rounded p-2 text-sm focus:outline-none focus:ring-1 focus:ring-green-500 bg-white" value={filterSubject} onChange={e=>setFilterSubject(e.target.value)}>
            <option value="">All Subjects</option>
            {availableSubjectsFilter.map(s=><option key={s.subject_id} value={s.subject_id}>{s.subject_code} - {s.subject_name}</option>)}
          </select>
        </div>
        <div className="flex-1">
          <label className="block text-xs text-gray-500 mb-1 font-semibold uppercase">Filter by Teacher</label>
          <select className="w-full border border-gray-300 rounded p-2 text-sm focus:outline-none focus:ring-1 focus:ring-green-500 bg-white" value={filterTeacher} onChange={e=>setFilterTeacher(e.target.value)}>
            <option value="">All Teachers</option>
            {historicalTeacherOptions.map(t=><option key={t.user_id} value={t.user_id}>{t.first_name} {t.last_name}{String(t.status || 'active').toLowerCase() === 'active' ? '' : ' (Inactive)'}</option>)}
          </select>
        </div>
      </div>

      {error && <div className="mb-3 text-red-600">{error}</div>}

      {importSummary && (
        <div className={`mb-3 p-3 rounded ${importErrors.length ? 'bg-yellow-50 text-yellow-800 border border-yellow-200' : 'bg-green-50 text-green-800 border border-green-200'}`}>
          Import summary: {importSummary.inserted} inserted, {importSummary.skipped} skipped, {importSummary.total} total rows.
        </div>
      )}

      {importErrors.length > 0 && (
        <div className="mb-4 p-3 border border-red-200 bg-red-50 text-red-800 rounded">
          <div className="font-semibold mb-2">Import errors (first 20 rows)</div>
          <ul className="list-disc pl-5">
            {importErrors.slice(0,20).map((err, idx)=>(
              <li key={`${err.row || idx}-${idx}`}>Row {err.row || idx + 1}: {err.message || err.error || 'Invalid data'}</li>
            ))}
          </ul>
          {importErrors.length > 20 && <div className="mt-2">And {importErrors.length - 20} more...</div>}
        </div>
      )}

      <div className="overflow-x-auto bg-white rounded-xl shadow-sm border border-gray-200">
        <Table columns={columns} data={displayData} loading={dataLoading} pageSize={10} />
      </div>

      <Modal show={showModal} title={editing ? 'Edit Offering' : 'Add Offering'} onClose={closeModal}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Section</label>
            <select name="section_id" value={form.section_id||''} onChange={handleChange} required className="block w-full border border-gray-200 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-green-500">
              <option value="">{addEditSections.length ? 'Select section...' : 'No sections available'}</option>
              {addEditSections.map(s => <option key={s.section_id} value={s.section_id}>{s.section_name}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Subject</label>
            <select name="subject_id" value={form.subject_id||''} onChange={handleChange} required className="block w-full border border-gray-200 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-green-500">
              <option value="">{addEditSubjects.length ? 'Select subject...' : 'No subjects available'}</option>
              {addEditSubjects.map(s => <option key={s.subject_id} value={s.subject_id}>{s.subject_code} - {s.subject_name}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Semester</label>
            <select name="semester_id" value={form.semester_id||''} onChange={handleChange} required className="block w-full border border-gray-200 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-green-500">
              <option value="">{activeSemesters.length ? 'Select active semester...' : 'No active semesters available'}</option>
              {activeSemesters.map(s => <option key={s.semester_id} value={s.semester_id}>{s.term}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Teacher</label>
            <select name="user_id" value={form.user_id||''} onChange={handleChange} className="block w-full border border-gray-200 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-green-500">
              <option value="">
                {availableTeachers.length ? 'Select teacher...' : 'No teachers in this department'}
              </option>
              {availableTeachers.map(t => <option key={t.user_id} value={t.user_id}>{t.first_name} {t.last_name}</option>)}
            </select>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={closeModal} className="px-3 py-2 rounded border bg-white text-sm">Cancel</button>
            <button type="submit" disabled={loading} className="px-4 py-2 rounded bg-green-600 text-white hover:bg-green-700">{loading ? 'Saving...' : (editing ? 'Update Offering' : 'Save Offering')}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default SubjectOfferingIndex;
