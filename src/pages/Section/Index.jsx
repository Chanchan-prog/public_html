import React, { useState, useEffect, useMemo, useRef } from "react";
import Table from "../../components/Table.jsx";
import Modal from "../../components/Modal.jsx";
import { apiGet, apiPost, apiPut } from '../../services/api.js';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';
import { MasterPageHeader, MasterStats, MasterToolbar, MasterSearch, MasterResults, MasterSelect } from '../../components/MasterDataPage.jsx';
import { formatDepartmentLabel, formatProgramLabel } from '../../utils/academicLabels.js';

const SECTION_SHIFTS = ['FA', 'FB', 'FC', 'FAB', 'FAC', 'FBC', 'EA', 'EB', 'EC', 'FD', 'FE'];
const SECTION_QUANTITIES = Array.from({ length: 50 }, (_, index) => index + 1);
const normalizeSectionIdentity = (value) => String(value || '').trim().toUpperCase().replace(/\s*-\s*/g, '-').replace(/\s+/g, '');
const generateSubName = (name = '') => (String(name).match(/[A-Z0-9]/g) || []).join('').slice(0, 30);
const isGeneralProgram = (program) => String(program?.program_name || '').trim().toLowerCase() === 'general';
const getYearNumber = (year) => String(year?.level || year?.year_level || '').match(/\d+/)?.[0] || '';

function SectionIndex() {
  const [sections, setSections] = useState([]);
  const [sectionIdentities, setSectionIdentities] = useState([]);
  const [sectionPage, setSectionPage] = useState(1);
  const [sectionPagination, setSectionPagination] = useState({ page: 1, page_size: 10, total: 0, total_pages: 1 });
  const [sectionStatusCounts, setSectionStatusCounts] = useState({ active: 0, inactive: 0, archive: 0 });
  const [departments, setDepartments] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [yearLevels, setYearLevels] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ section_name: '', dept_id: '', program_id: '', year_id: '', shift: '', group_code: '', section_start: '01', section_count: '1' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');

  // States for Table UI Filters
  const [filterProgram, setFilterProgram] = useState('');
  const [filterDept, setFilterDept] = useState('');
  const [filterYearLevel, setFilterYearLevel] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const sectionRequestRef = useRef(0);

  // Authentication & Role Check logic
  const user = (() => { try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch(e) { return null; } })();
  const isAdmin = Number(user?.role_id) === 1;
  const isDean = [2, 6].includes(Number(user?.role_id));
  const isProgramHead = Number(user?.role_id) === 3;
  const isSecretary = Number(user?.role_id) === 4;
  
  // Only admin and dean can manage sections.
  const canEdit = isAdmin || isDean;
  const canAdd = isAdmin || isDean;

  const runWithFallback = async (primary, fallback) => {
    try { return await primary(); } catch (err) { if (err?.status === 405 || err?.status === 500) return await fallback(); throw err; }
  };

  const loadSectionIdentities = React.useCallback(async () => {
    const data = await apiGet('sections?identities=1');
    setSectionIdentities(Array.isArray(data) ? data : []);
  }, []);

  const loadReferenceData = React.useCallback(async () => {
    try {
      const [d, p, y, identities] = await Promise.all([
        apiGet('departments'),
        apiGet('programs'),
        apiGet('year-levels'),
        apiGet('sections?identities=1'),
      ]);
      setDepartments(Array.isArray(d) ? d : []);
      setPrograms(Array.isArray(p) ? p : []);
      setYearLevels(Array.isArray(y) ? y : []);
      setSectionIdentities(Array.isArray(identities) ? identities : []);
    } catch (e) {
      console.error(e);
      setError('Failed to load section filter options');
    }
  }, []);

  const loadData = React.useCallback(async ({ silent = false } = {}) => {
    const requestId = ++sectionRequestRef.current;
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      const params = new URLSearchParams({
        paginate: '1',
        page: String(sectionPage),
        page_size: '10',
        status: statusFilter,
      });
      if (filterDept) params.set('dept_id', filterDept);
      if (filterProgram) params.set('program_id', filterProgram);
      if (filterYearLevel) params.set('year_id', filterYearLevel);
      if (debouncedSearch) params.set('search', debouncedSearch);
      const data = await apiGet(`sections?${params.toString()}`);
      if (requestId !== sectionRequestRef.current) return;
      const nextRows = Array.isArray(data?.rows) ? data.rows : [];
      const nextPagination = data?.pagination || { page: 1, page_size: 10, total: nextRows.length, total_pages: 1 };
      setSections(nextRows);
      setSectionPagination(nextPagination);
      setSectionStatusCounts(data?.status_counts || { active: 0, inactive: 0, archive: 0 });
      if (Number(nextPagination.page || 1) !== Number(sectionPage)) setSectionPage(Number(nextPagination.page || 1));
    } catch(e) {
      if (requestId !== sectionRequestRef.current) return;
      console.error(e);
      if (!silent) setError('Failed to load sections');
    } finally {
      if (requestId === sectionRequestRef.current && !silent) setLoading(false);
    }
  }, [sectionPage, statusFilter, filterDept, filterProgram, filterYearLevel, debouncedSearch]);

  useEffect(() => { loadReferenceData(); }, [loadReferenceData]);
  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSectionPage(1);
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
    return sections.map((sec, i) => ({
      ...sec,
      display_index: (Number(sectionPagination.page || 1) - 1) * Number(sectionPagination.page_size || 10) + i + 1
    }));
  }, [sections, sectionPagination]);


  // Dropdown list for Filtering view
  const availablePrograms = useMemo(() => {
    let list = programs;
    if (isProgramHead) {
      return list;
    } else if (isDean || isSecretary) {
      list = list.filter(p => Number(p.dept_id) === Number(user?.dept_id));
    }
    if (isAdmin && filterDept) list = list.filter(p => String(p.dept_id) === String(filterDept));
    return list;
  }, [programs, isProgramHead, isDean, isSecretary, isAdmin, user, filterDept]);

  useEffect(() => {
    if (!filterProgram) return;
    if (!availablePrograms.some(program => String(program.program_id) === String(filterProgram))) setFilterProgram('');
  }, [availablePrograms, filterProgram]);

  // Dropdown strictly for Add/Edit Modal (Program Head can only see their exact program here)
  const addEditPrograms = useMemo(() => {
    let list = programs.filter(p => String(p.status || '').toLowerCase() === 'active' && String(p.department_status || '').toLowerCase() === 'active');
    if (isProgramHead) {
      return list;
    } else if (isDean) {
      list = list.filter(p => Number(p.dept_id) === Number(user?.dept_id));
    }
    return list;
  }, [programs, isProgramHead, isDean, user]);

  const activeDepartments = useMemo(
    () => departments.filter(department => String(department.status || '').toLowerCase() === 'active'),
    [departments]
  );

  const selectedDeptId = isAdmin ? String(form.dept_id || '') : String(user?.dept_id || form.dept_id || '');
  const selectedDepartment = useMemo(() => {
    const fromDepartments = departments.find(department => String(department.dept_id) === selectedDeptId);
    if (fromDepartments) return fromDepartments;
    const fromProgram = programs.find(program => String(program.dept_id) === selectedDeptId);
    return fromProgram ? { dept_id: fromProgram.dept_id, dept_name: fromProgram.dept_name, sub_name: fromProgram.department_sub_name } : null;
  }, [departments, programs, selectedDeptId]);

  const departmentPrograms = useMemo(
    () => addEditPrograms.filter(program => String(program.dept_id) === selectedDeptId),
    [addEditPrograms, selectedDeptId]
  );
  const generalProgram = useMemo(() => departmentPrograms.find(isGeneralProgram) || null, [departmentPrograms]);
  const hideProgramForGeneralDepartment = !isAdmin && !editing && Boolean(generalProgram);
  const effectiveProgramId = hideProgramForGeneralDepartment ? String(generalProgram.program_id) : String(form.program_id || '');
  const selectedYear = useMemo(
    () => yearLevels.find(year => String(year.year_id) === String(form.year_id)) || null,
    [yearLevels, form.year_id]
  );
  const selectedYearNumber = getYearNumber(selectedYear);

  const buildGroupCode = React.useCallback((programId, deptId, yearId) => {
    const program = programs.find(item => String(item.program_id) === String(programId));
    const department = departments.find(item => String(item.dept_id) === String(deptId))
      || (program ? { sub_name: program.department_sub_name, dept_name: program.dept_name } : null);
    const year = yearLevels.find(item => String(item.year_id) === String(yearId));
    const yearNumber = getYearNumber(year);
    if (!yearNumber) return '';
    const useDepartment = isGeneralProgram(program);
    const source = useDepartment ? department : program;
    const prefix = String(source?.sub_name || generateSubName(useDepartment ? source?.dept_name : source?.program_name) || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
    return prefix ? `${prefix}${yearNumber}` : '';
  }, [programs, departments, yearLevels]);

  const generatedSectionNames = useMemo(() => {
    if (editing) return [];
    const shift = String(form.shift || '').trim().toUpperCase();
    const groupCode = String(form.group_code || '').trim().toUpperCase();
    const sectionMatch = String(form.section_start || '').trim().toUpperCase().match(/^(\d{1,2})([A-Z]*)$/);
    const count = Number(form.section_count || 1);
    if (!SECTION_SHIFTS.includes(shift) || !/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(groupCode) || !sectionMatch || count < 1) return [];
    const startNumber = Number(sectionMatch[1]);
    const suffix = sectionMatch[2];
    if (startNumber < 1 || startNumber + Math.min(50, count) - 1 > 99) return [];
    return Array.from({ length: Math.min(50, count) }, (_, index) => `COC-${shift}-${groupCode}-${String(startNumber + index).padStart(2, '0')}${suffix}`);
  }, [editing, form.shift, form.group_code, form.section_start, form.section_count]);

  const sectionAvailability = useMemo(() => {
    const existingByIdentity = new Map();
    sectionIdentities.forEach((section) => {
      if (Number(section.program_id) !== Number(effectiveProgramId)) return;
      existingByIdentity.set(normalizeSectionIdentity(section.section_name), section);
    });
    const existing = generatedSectionNames.filter((name) => existingByIdentity.has(normalizeSectionIdentity(name)));
    const missing = generatedSectionNames.filter((name) => !existingByIdentity.has(normalizeSectionIdentity(name)));
    return { existing, missing };
  }, [sectionIdentities, generatedSectionNames, effectiveProgramId]);

  const generatedSectionRange = useMemo(() => {
    if (!generatedSectionNames.length) return '';
    const first = generatedSectionNames[0].split('-').pop() || '';
    const last = generatedSectionNames[generatedSectionNames.length - 1].split('-').pop() || '';
    return first === last ? first : `${first}-${last}`;
  }, [generatedSectionNames]);

  const liveBuilderError = useMemo(() => {
    if (editing) return '';
    if (selectedDeptId && departmentPrograms.length === 0) return 'This department has no active program. Add a program before creating a section.';
    const groupCode = String(form.group_code || '').trim().toUpperCase();
    if (groupCode && !/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(groupCode)) return 'Use letters and numbers with hyphens only between values.';
    if (groupCode && selectedYearNumber) {
      const trailingYear = groupCode.match(/(\d+)$/)?.[1] || '';
      if (trailingYear !== selectedYearNumber) return `Program/year code must end with the selected year number ${selectedYearNumber}.`;
    }
    const sectionStart = String(form.section_start || '').trim().toUpperCase();
    if (sectionStart && (!/^\d{1,2}[A-Z]*$/.test(sectionStart) || Number(sectionStart.match(/^\d{1,2}/)?.[0] || 0) < 1)) {
      return 'Section must begin with 01-99 and may end with letters, for example 01, 01A, or 02B.';
    }
    if (generatedSectionNames.length && sectionAvailability.missing.length === 0) return 'All generated sections already exist for the selected program.';
    return '';
  }, [editing, selectedDeptId, departmentPrograms.length, form.group_code, form.section_start, selectedYearNumber, generatedSectionNames.length, sectionAvailability.missing.length]);


  const checkManagePermission = (row) => {
    if (isAdmin) return true;
    if (isDean && Number(row?.dept_id) !== Number(user?.dept_id)) {
      try { if (window.Swal) window.Swal.fire('Unauthorized', 'You can only modify sections inside your assigned department.', 'error'); else alert('Unauthorized'); } catch(e){}
      return false;
    }
    return isDean;
  };


  const openModal = (sec=null) => { 
    setError(''); 
    setFormError('');
    if (sec) { 
      if (!checkManagePermission(sec)) return;
      setEditing(sec); 
      setForm({ section_name: sec.section_name||'', dept_id: sec.dept_id||'', program_id: sec.program_id||'', year_id: sec.year_id||'', shift: '', group_code: '', section_start: '01', section_count: '1' });
    } else { 
      if (!canAdd) return;
      setEditing(null);
      const initialDeptId = isAdmin
        ? String(activeDepartments[0]?.dept_id || '')
        : String(user?.dept_id || '');
      const initialPrograms = addEditPrograms.filter(program => String(program.dept_id) === initialDeptId);
      const initialProgram = (!isAdmin ? initialPrograms.find(isGeneralProgram) : null) || initialPrograms[0] || null;
      const initialYearId = String(yearLevels[0]?.year_id || '');
      setForm({
        section_name: '',
        dept_id: initialDeptId,
        program_id: String(initialProgram?.program_id || ''),
        year_id: initialYearId,
        shift: '',
        group_code: buildGroupCode(initialProgram?.program_id, initialDeptId, initialYearId),
        section_start: '01',
        section_count: '1'
      });
    } 
    setShowModal(true); 
  };
  
  const closeModal = () => setShowModal(false);
  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormError('');
    setForm(previous => {
      if (name === 'dept_id') {
        const nextPrograms = addEditPrograms.filter(program => String(program.dept_id) === String(value));
        const nextProgramId = String(nextPrograms[0]?.program_id || '');
        return {
          ...previous,
          dept_id: value,
          program_id: nextProgramId,
          group_code: buildGroupCode(nextProgramId, value, previous.year_id)
        };
      }
      if (name === 'program_id') {
        const program = programs.find(item => String(item.program_id) === String(value));
        const deptId = String(program?.dept_id || previous.dept_id || selectedDeptId);
        return {
          ...previous,
          program_id: value,
          dept_id: deptId,
          group_code: buildGroupCode(value, deptId, previous.year_id)
        };
      }
      if (name === 'year_id') {
        return {
          ...previous,
          year_id: value,
          group_code: buildGroupCode(effectiveProgramId || previous.program_id, previous.dept_id || selectedDeptId, value)
        };
      }
      return { ...previous, [name]: value };
    });
  };

  const validateForm = () => {
    if (!editing && isAdmin && !selectedDeptId) return 'Department is required';
    if (!editing && selectedDeptId && departmentPrograms.length === 0) return 'This department has no active program. Add a program before creating a section.';
    if (!effectiveProgramId) return 'Program is required';
    if (!form.year_id) return 'Year level is required';
    if (!editing) {
      if (!SECTION_SHIFTS.includes(String(form.shift || '').toUpperCase())) return 'Shift is required';
      if (!String(form.group_code || '').trim()) return 'Program/year or group code is required';
      if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(String(form.group_code || '').trim())) return 'Program/year or group code may contain letters, numbers, and internal hyphens only';
      const trailingYear = String(form.group_code || '').trim().match(/(\d+)$/)?.[1] || '';
      if (!selectedYearNumber || trailingYear !== selectedYearNumber) return `Program/year code must end with the selected year number ${selectedYearNumber || ''}`.trim();
      if (!/^\d{1,2}[A-Za-z]*$/.test(String(form.section_start || '').trim())) return 'Section must start with a number and may end with letters, such as 01, 02, 01A, or 02B';
      const sectionNumber = Number(String(form.section_start).match(/^\d{1,2}/)?.[0] || 0);
      if (sectionNumber < 1 || sectionNumber + Number(form.section_count || 1) - 1 > 99) return 'The generated section numbers must stay between 01 and 99';
      if (!generatedSectionNames.length) return 'At least one generated section is required';
      if (!sectionAvailability.missing.length) return 'All generated sections already exist for the selected program';
      return null;
    }
    const name = (form.section_name||'').trim();
    if (!name) return 'Section name is required';
    const conflict = sectionIdentities.find(s => s.section_name && String(s.section_name).toLowerCase() === name.toLowerCase() && Number(s.program_id) === Number(form.program_id) && (!editing || Number(s.section_id) !== Number(editing.section_id)));
    if (conflict) return 'A section with the same name already exists for the selected program';
    return null;
  };

  const handleSubmit = async (e) => { 
    e.preventDefault(); 
    setLoading(true); setError(''); setFormError('');
    const v = validateForm(); 
    if (v) { setFormError(v); setLoading(false); return; }
    try {
      let saveResult = null;
      const payload = editing
        ? { section_name: form.section_name.trim(), program_id: Number(effectiveProgramId), year_id: Number(form.year_id) }
        : { section_names: sectionAvailability.missing, program_id: Number(effectiveProgramId), year_id: Number(form.year_id) };
      if (editing && editing.section_id) {
        await runWithFallback(
          () => apiPut(`sections/${editing.section_id}`, payload),
          () => apiPost(`sections/${editing.section_id}/update`, payload)
        );
      } else {
        if (!canAdd) {
          const msg = 'Only admin and dean can add sections.';
          try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Unauthorized', text: msg }); else alert(msg); } catch(e){}
          setLoading(false);
          return;
        }
        saveResult = await apiPost('sections', payload);
      }
      await Promise.all([loadData({ silent: true }), loadSectionIdentities()]);
      closeModal();
      const createdCount = Number(saveResult?.created_count ?? sectionAvailability.missing.length);
      const skippedCount = Number(saveResult?.skipped_count || 0);
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: editing ? 'Section updated' : `${createdCount} section(s) added`, text: !editing && skippedCount ? `${skippedCount} existing section(s) were skipped.` : undefined, timer:1400, showConfirmButton:false }); } catch(e){}
    } catch(err) { 
      console.error(err); 
      const msg = err?.body?.message || err?.body?.error || err?.message || 'Failed to save'; 
      try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: msg }); else alert(msg); } catch(e){} 
      setError(msg); 
    } finally { setLoading(false); } 
  };

  const handleToggle = async (sec) => {
    if (!sec || !sec.section_id) return;
    if (!checkManagePermission(sec)) return;

    const newStatus = String(sec.status) === 'active' ? 'inactive' : 'active';
    const action = newStatus === 'active' ? 'Activate' : 'Deactivate';
    const answer = window.Swal ? await window.Swal.fire({ title: `${action} section?`, text: `${sec.section_name || 'This section'} will be ${newStatus}.`, icon: 'question', showCancelButton: true, confirmButtonText: action }) : { isConfirmed: confirm(`${action} this section?`) };
    if (!answer.isConfirmed) return;
    try {
      await runWithFallback(
        () => apiPut(`sections/${sec.section_id}`, { status: newStatus }),
        () => apiPost(`sections/${sec.section_id}/update`, { status: newStatus })
      );
      await Promise.all([loadData({ silent: true }), loadSectionIdentities()]);
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'Status updated', timer:1200, showConfirmButton:false }); } catch(e){}
    } catch (err) { console.error(err); try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: err.body?.message || err.body?.error || err.message || 'Failed to update status' }); } catch(e){} }
  };

  const handleArchive = async (sec) => {
    if (!sec || !sec.section_id) return;
    if (!checkManagePermission(sec)) return;

    try {
      const res = window.Swal ? await window.Swal.fire({ title: 'Archive section?', text: 'This will remove the section from the active list.', icon: 'warning', showCancelButton: true }) : { isConfirmed: confirm('Archive section?') };
      if (!res.isConfirmed) return;
      await runWithFallback(
        () => apiPut(`sections/${sec.section_id}`, { status: 'archive' }),
        () => apiPost(`sections/${sec.section_id}/update`, { status: 'archive' })
      );
      await Promise.all([loadData({ silent: true }), loadSectionIdentities()]);
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'Archived', timer:1200, showConfirmButton:false }); } catch(e){}
    } catch (err) { console.error(err); try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: err.body?.message || err.body?.error || err.message || 'Failed to archive' }); } catch(e){} }
  };

  const handleRestore = async (sec) => {
    if (!sec?.section_id || !checkManagePermission(sec)) return;
    const result = window.Swal ? await window.Swal.fire({ title:'Restore section?', text:'The section will be restored as inactive for review.', icon:'question', showCancelButton:true }) : { isConfirmed:confirm('Restore section?') };
    if (!result.isConfirmed) return;
    try {
      await runWithFallback(() => apiPut(`sections/${sec.section_id}`, { status:'inactive' }), () => apiPost(`sections/${sec.section_id}/update`, { status:'inactive' }));
      await Promise.all([loadData(), loadSectionIdentities()]);
      if (window.Swal) await window.Swal.fire({ icon:'success', title:'Section restored', timer:1200, showConfirmButton:false });
    } catch (err) {
      if (window.Swal) await window.Swal.fire({ icon:'error', title:'Restore failed', text:err?.body?.message || err?.message || 'Failed to restore section' });
    }
  };

  const columns = [
    { key: 'display_index', label: '#' },
    { key: 'section_name', label: 'Section Name' },
    { key: 'dept_name', label: 'Department', render: (row) => formatDepartmentLabel({ sub_name: row.department_sub_name, dept_name: row.dept_name }, 'N/A') },
    { key: 'program_name', label: 'Program', render: (row) => formatProgramLabel({ sub_name: row.program_sub_name, program_name: row.program_name }, 'N/A') },
    { key: 'year_level', label: 'Year Level', render: (r) => r.level || r.year_level || '' },
    { key: 'status', label: 'Status', render: (r) => {
      const s = (r.status || '').toLowerCase();
      const cls = s === 'active' ? 'bg-success' : (s === 'inactive' ? 'bg-danger' : 'bg-secondary');
      const text = s === 'active' ? 'Active' : (s === 'inactive' ? 'Inactive' : (r.status || 'N/A'));
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

  const selectSectionStatus = (status) => {
    setSectionPage(1);
    setStatusFilter(status);
  };
  const sectionStatusCount = (status) => Number(sectionStatusCounts?.[status] || 0);

  return (
    <div className="mdp-page">
      <MasterPageHeader title="Sections" description="Manage section structure across programs and year levels." action={canAdd ? <button className="mdp-primary" onClick={() => openModal()}>+ Add Section</button> : null} />
      <MasterStats loading={loading} items={[{ label: 'Active', value: sectionStatusCount('active'), help: 'Available for scheduling', icon: '\u2713', active: statusFilter === 'active', onClick: () => selectSectionStatus('active') }, { label: 'Inactive', value: sectionStatusCount('inactive'), help: 'Currently unavailable', icon: 'I', tone: 'red', active: statusFilter === 'inactive', onClick: () => selectSectionStatus('inactive') }, { label: 'Archived', value: sectionStatusCount('archive'), help: 'Available for restoration', icon: 'A', active: statusFilter === 'archive', onClick: () => selectSectionStatus('archive') }]} />
      <MasterToolbar>
        <MasterSearch value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search section, department, program, or year..." />
        {isAdmin ? <MasterSelect label="Department" value={filterDept} onChange={(event) => { setSectionPage(1); setFilterDept(event.target.value); setFilterProgram(''); }}><option value="">All departments</option>{activeDepartments.map((department) => <option key={department.dept_id} value={department.dept_id}>{formatDepartmentLabel(department, department.dept_id)}</option>)}</MasterSelect> : <div className="mdp-filter"><span>Department</span><div className="rounded border border-gray-200 bg-gray-100 px-3 py-2 text-sm text-gray-700">{formatDepartmentLabel(selectedDepartment, 'No assigned department')}</div></div>}
        <MasterSelect label="Program" value={filterProgram} onChange={(event) => { setSectionPage(1); setFilterProgram(event.target.value); }}><option value="">All programs</option>{availablePrograms.map((program) => <option key={program.program_id} value={program.program_id}>{formatProgramLabel(program, program.program_id)}</option>)}</MasterSelect>
        <MasterSelect label="Year level" value={filterYearLevel} onChange={(event) => { setSectionPage(1); setFilterYearLevel(event.target.value); }}><option value="">All year levels</option>{yearLevels.map((year) => <option key={year.year_id} value={year.year_id}>{year.level}</option>)}</MasterSelect>
        <MasterSelect label="Status" value={statusFilter} onChange={(event) => selectSectionStatus(event.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option><option value="archive">Archived</option></MasterSelect>
      </MasterToolbar>

      {error && <div className="mb-3 text-red-600">{error}</div>}

      <MasterResults title="Section Directory" count={Number(sectionPagination.total || 0)} loading={loading} description="Program and year-level placement for each section."><Table columns={columns} data={displayData} loading={loading} pageSize={Number(sectionPagination.page_size || 10)} serverPagination totalItems={Number(sectionPagination.total || 0)} page={sectionPage} onPageChange={setSectionPage} /></MasterResults>

      <Modal show={showModal} title={editing ? 'Edit Section' : 'Add Section'} size={editing ? 'md' : 'lg'} onClose={closeModal}>
        <form onSubmit={handleSubmit} className="space-y-4">
          {isAdmin ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Department</label>
              <select name="dept_id" value={form.dept_id || ''} onChange={handleChange} required className="block w-full border border-gray-200 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-green-500">
                <option value="">Select department</option>
                {activeDepartments.map(department => <option key={department.dept_id} value={department.dept_id}>{formatDepartmentLabel(department, department.dept_id)}</option>)}
              </select>
            </div>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Department</div>
              <div className="mt-1 font-semibold text-slate-800">{formatDepartmentLabel(selectedDepartment, 'No assigned department')}</div>
            </div>
          )}

          {hideProgramForGeneralDepartment ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              This department uses the General program. The section code will use the Department Sub Name instead of GENERAL.
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Program</label>
              <select name="program_id" value={form.program_id||''} onChange={handleChange} required className="block w-full border border-gray-200 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-green-500">
                <option value="">{departmentPrograms.length ? 'Select program' : 'No program available'}</option>
                {departmentPrograms.map(program => <option key={program.program_id} value={program.program_id}>{formatProgramLabel(program, program.program_id)}</option>)}
              </select>
              {isDean && <div className="mt-1 text-xs text-gray-500">Programs are limited to your assigned department.</div>}
            </div>
          )}
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Year Level</label>
            <select name="year_id" value={form.year_id||''} onChange={handleChange} required className="block w-full border border-gray-200 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-green-500">
              <option value="">Select year level</option>
              {yearLevels.map(y => React.createElement('option', { key: y.year_id, value: y.year_id }, y.level))}
            </select>
          </div>
          
          {editing ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Section Name</label>
              <input name="section_name" value={form.section_name||''} onChange={handleChange} required className="block w-full border border-gray-200 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-green-500" />
              {formError && <div className="mt-2 text-sm font-semibold text-red-600">{formError}</div>}
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Section Name Builder</label>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Campus</label>
                    <input value="COC" disabled aria-label="Campus prefix" className="block w-full border border-gray-200 rounded px-3 py-2 bg-gray-100 font-semibold text-gray-700" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Shift</label>
                    <select name="shift" value={form.shift || ''} onChange={handleChange} required aria-label="Shift" className="block w-full border border-gray-200 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-green-500">
                      <option value="">Select shift</option>
                      {SECTION_SHIFTS.map(shift => <option key={shift} value={shift}>{shift}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Program / Year</label>
                    <input name="group_code" value={form.group_code || ''} onChange={(event) => { setFormError(''); setForm(previous => ({ ...previous, group_code: event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '') })); }} required maxLength={30} placeholder="e.g. BSIT2 or GEC-IT2" aria-label="Program and year code" className="block w-full border border-gray-200 rounded px-3 py-2 uppercase focus:outline-none focus:ring-1 focus:ring-green-500" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Starting Section</label>
                    <input name="section_start" value={form.section_start || ''} onChange={(event) => { setFormError(''); setForm(previous => ({ ...previous, section_start: event.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 6) })); }} required maxLength={6} placeholder="01 or 01A" aria-label="Starting section" className="block w-full border border-gray-200 rounded px-3 py-2 uppercase focus:outline-none focus:ring-1 focus:ring-green-500" />
                  </div>
                </div>
                <div className="mt-1 text-xs text-gray-500">Format: COC - Shift - Program/Year Code - Section. The editable Program/Year Code must end with year {selectedYearNumber || 'selected above'}.</div>
                {(formError || liveBuilderError) && <div className="mt-2 text-sm font-semibold text-red-600">{formError || liveBuilderError}</div>}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">How many sections should be created?</label>
                <select name="section_count" value={form.section_count || '1'} onChange={handleChange} className="block w-full border border-gray-200 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-green-500">
                  {SECTION_QUANTITIES.map(number => <option key={number} value={number}>{number}</option>)}
                </select>
              </div>

              {generatedSectionNames.length > 0 && (
                <div className={`rounded-2xl border-2 border-dashed px-6 py-7 text-center shadow-sm ${sectionAvailability.missing.length ? 'border-emerald-400 bg-emerald-50' : 'border-red-300 bg-red-50'}`}>
                  <div className={`text-xs font-bold uppercase tracking-widest ${sectionAvailability.missing.length ? 'text-emerald-700' : 'text-red-700'}`}>Base Tracking Pattern Preview</div>
                  <div className="mt-3 flex flex-wrap items-baseline justify-center gap-x-3 gap-y-2">
                    <span className={`break-all font-mono text-2xl font-black tracking-wide sm:text-3xl ${sectionAvailability.missing.length ? 'text-emerald-800' : 'text-red-800'}`}>{generatedSectionNames[0]}</span>
                    <span className="text-base font-bold text-slate-600">(Sections About to Generate {generatedSectionRange})</span>
                  </div>
                  {sectionAvailability.existing.length > 0 && sectionAvailability.missing.length === 1 && <div className="mt-4 text-sm font-bold text-blue-700">Only this section has not been created yet: {sectionAvailability.missing[0]}</div>}
                  {sectionAvailability.existing.length > 0 && sectionAvailability.missing.length > 1 && <div className="mt-4 text-sm font-semibold text-amber-700">{sectionAvailability.existing.length} duplicate section(s) will be skipped; {sectionAvailability.missing.length} section(s) are ready.</div>}
                  {sectionAvailability.existing.length > 0 && sectionAvailability.missing.length === 0 && <div className="mt-4 text-sm font-bold text-red-700">All generated sections already exist.</div>}
                </div>
              )}
            </div>
          )}
          
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={closeModal} className="px-3 py-2 rounded border bg-white text-sm">Cancel</button>
            <button type="submit" disabled={loading || (!editing && (!effectiveProgramId || departmentPrograms.length === 0 || (generatedSectionNames.length > 0 && sectionAvailability.missing.length === 0)))} className="px-4 py-2 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed">{loading ? 'Saving...' : (editing ? 'Save' : (sectionAvailability.missing.length ? `Create ${sectionAvailability.missing.length} Section${sectionAvailability.missing.length === 1 ? '' : 's'}` : 'Create Sections'))}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default SectionIndex;
