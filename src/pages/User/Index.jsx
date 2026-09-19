import React from 'react';
import ReactDOM from 'react-dom';
import Table from "../../components/Table.jsx";
import Modal from "../../components/Modal.jsx";
import { MasterPageHeader, MasterStats, MasterToolbar, MasterSearch, MasterResults, MasterSelect } from '../../components/MasterDataPage.jsx';
import { apiGet, apiPost, apiPut } from '../../services/api.js';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';
import { formatAcademicLabel, formatDepartmentLabel, formatProgramLabel } from '../../utils/academicLabels.js';

const PROGRAM_REQUIRED_ROLE_IDS = ['2', '3', '4', '5'];
const roleNeedsProgram = (roleId) => PROGRAM_REQUIRED_ROLE_IDS.includes(String(roleId));
const generateSubName = (name = '') => (String(name).match(/[A-Z0-9]/g) || []).join('').slice(0, 30);
const ROLE_COLORS = { 2: '#8b5cf6', 3: '#0d9488', 4: '#64748b', 5: '#16a34a', 6: '#2563eb' };
const USER_IMPORT_HEADERS = ['First Name', 'Last Name', 'Email', 'School ID', 'Contact No', 'Role', 'Department', 'Program'];

function UserTableAvatar({ user }) {
  const imageSrc = user?.avatar || user?.image || '';
  const [imageFailed, setImageFailed] = React.useState(false);

  React.useEffect(() => {
    setImageFailed(false);
  }, [imageSrc]);

  const initials = [user?.first_name, user?.last_name]
    .map((part) => String(part || '').trim().charAt(0).toUpperCase())
    .filter(Boolean)
    .join('') || '?';

  const circleStyle = {
    width: 44,
    height: 44,
    borderRadius: '50%',
    border: '2px solid #d1fae5'
  };

  if (!imageSrc || imageFailed) {
    return React.createElement('span', {
      'aria-label': `${`${user?.first_name || ''} ${user?.last_name || ''}`.trim() || 'User'} initials`,
      style: {
        ...circleStyle,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#ecfdf5',
        color: '#047857',
        fontSize: 14,
        fontWeight: 800,
        letterSpacing: '0.02em'
      }
    }, initials);
  }

  return React.createElement('img', {
    src: imageSrc,
    alt: '',
    style: { ...circleStyle, objectFit: 'cover' },
    onError: () => setImageFailed(true)
  });
}

export default function UserIndex(){
  const [users, setUsers] = React.useState([]);
  const [roles, setRoles] = React.useState([]);
  const [departments, setDepartments] = React.useState([]);
  const [academicPrograms, setAcademicPrograms] = React.useState([]);
  const [programHeads, setProgramHeads] = React.useState([]);
  const [programOptionsDeptId, setProgramOptionsDeptId] = React.useState('');
  const [showModal, setShowModal] = React.useState(false);
  const [form, setForm] = React.useState({ first_name:'', last_name:'', email:'', password:'', contact_no:'', role_id: '', id_number: '', dept_id: '', assigned_program_head_id: '' });
  const [editImageUrl, setEditImageUrl] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [dataLoading, setDataLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('all');
  const [userPage, setUserPage] = React.useState(1);
  const [userPagination, setUserPagination] = React.useState({ page: 1, page_size: 10, total: 0, total_pages: 1 });
  const [userStats, setUserStats] = React.useState({ total: 0, active: 0, inactive: 0, archived: 0 });
  const [userRoleCounts, setUserRoleCounts] = React.useState({});
  const [importing, setImporting] = React.useState(false);
  const [importSummary, setImportSummary] = React.useState(null);
  const [importErrors, setImportErrors] = React.useState([]);
  const [showImportModal, setShowImportModal] = React.useState(false);
  const [importDraftRows, setImportDraftRows] = React.useState([]);
  const [importRowErrors, setImportRowErrors] = React.useState({});
  const [importDraftSummary, setImportDraftSummary] = React.useState(null);
  const [importFileName, setImportFileName] = React.useState('');
  const [importProcessing, setImportProcessing] = React.useState(false);
  const [importPage, setImportPage] = React.useState(1);
  const [showAddDeptModal, setShowAddDeptModal] = React.useState(false);
  const [addDeptForm, setAddDeptForm] = React.useState({ sub_name: '', dept_name: '' });
  const [addDeptLoading, setAddDeptLoading] = React.useState(false);
  const [addDeptError, setAddDeptError] = React.useState('');
  const [showAddProgramModal, setShowAddProgramModal] = React.useState(false);
  const [addProgramForm, setAddProgramForm] = React.useState({ sub_name: '', program_name: '', dept_id: '' });
  const [addProgramLoading, setAddProgramLoading] = React.useState(false);
  const [addProgramError, setAddProgramError] = React.useState('');
  const fileInputRef = React.useRef(null);
  const importPreviewSeq = React.useRef(0);
  const importAutoValidateTimerRef = React.useRef(null);
  const formRef = React.useRef(form);
  const emailDomainRegex = /^[A-Za-z]{4}\.[A-Za-z]+\.coc@phinmaed\.com$/i;
  const idNumberRegex = /^\d{2}-\d{3}-[A-Za-z]$/;
  const personNameRegex = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;
  const IMPORT_PAGE_SIZE = 10;

  // Filters for the user table
  const [searchTerm, setSearchTerm] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  const [roleFilter, setRoleFilter] = React.useState('');
  const [deptFilter, setDeptFilter] = React.useState('');
  const userRequestRef = React.useRef(0);

  // Authentication & Role Check logic
  const currentUser = React.useMemo(() => {
    try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch(e) { return null; }
  }, []);

  const isAdmin = Number(currentUser?.role_id) === 1;
  const isDean = Number(currentUser?.role_id) === 2;
  const isProgramHead = Number(currentUser?.role_id) === 3;
  const isSecretary = Number(currentUser?.role_id) === 4;
  const isTeacher = Number(currentUser?.role_id) === 5;
  const isDepartmentAdmin = Number(currentUser?.role_id) === 6;
  const isDeanScopedRole = isDean || isDepartmentAdmin;
  const canManageUsers = isAdmin || isDepartmentAdmin;
  const showProgramColumns = !(isDeanScopedRole || isSecretary || isProgramHead);
  const hasFixedDepartmentScope = isDeanScopedRole || isSecretary || isProgramHead;
  const fixedDeptId = hasFixedDepartmentScope ? String(currentUser?.dept_id || '') : '';

  React.useEffect(() => {
    formRef.current = form;
  }, [form]);

  // When role becomes admin (1) ensure dept_id is cleared
  React.useEffect(()=>{
    if (form && String(form.role_id) === '1' && form.dept_id) {
      setForm(f => ({ ...f, dept_id: '' }));
    }
    if (form && !roleNeedsProgram(form.role_id) && form.assigned_program_head_id) {
      setForm(f => ({ ...f, assigned_program_head_id: '' }));
    }
  }, [form.role_id]);

  const normalizeStatus = React.useCallback((user) => {
    return String(user?._status || user?.status || '').toLowerCase().trim();
  }, []);

  const effectiveStatusFilter = (!isAdmin && !isDepartmentAdmin && statusFilter === 'archive') ? 'all' : statusFilter;
  const isArchiveView = effectiveStatusFilter === 'archive';
  const filteredUsers = users;

  const statsItems = React.useMemo(() => {
    const items = [
      { key: 'all', label: 'All Accounts', value: userStats.total, subLabel: 'Active + inactive' },
      { key: 'active', label: 'Active', value: userStats.active, subLabel: 'Available for operations' },
      { key: 'inactive', label: 'Inactive', value: userStats.inactive, subLabel: 'Currently unavailable' }
    ];
    if (isAdmin || isDepartmentAdmin) {
      items.push({ key: 'archive', label: 'Archived', value: userStats.archived, subLabel: 'Available for restoration' });
    }
    return items;
  }, [userStats, isAdmin, isDepartmentAdmin]);

  const roleFilterOptions = React.useMemo(() => {
    const list = Array.isArray(roles) ? roles : [];
    const noAdmin = list.filter(r => String(r?.role_id) !== '1');
    if (isDepartmentAdmin) return noAdmin.filter(r => [2, 3, 4, 5].includes(Number(r.role_id)));
    if (isDean) return noAdmin.filter(r => [3, 4, 5].includes(Number(r.role_id)));
    if (isProgramHead) return noAdmin.filter(r => [4, 5].includes(Number(r.role_id)));
    return noAdmin;
  }, [roles, isDepartmentAdmin, isDean, isProgramHead]);

  const normalizeRoleToken = React.useCallback((value) => {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  }, []);

  const adminRoleTokens = React.useMemo(() => {
    const tokens = new Set(['admin', 'administrator']);
    (Array.isArray(roles) ? roles : []).forEach((r) => {
      if (String(r?.role_id) === '1') {
        const name = r?.role_name || r?.name || '';
        const token = normalizeRoleToken(name);
        if (token) tokens.add(token);
      }
    });
    return tokens;
  }, [roles, normalizeRoleToken]);

  const isAdminRoleValue = React.useCallback((value) => {
    const token = normalizeRoleToken(value);
    return token ? adminRoleTokens.has(token) : false;
  }, [adminRoleTokens, normalizeRoleToken]);

  const resolveRoleIdValue = React.useCallback((value) => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const token = normalizeRoleToken(raw);
    const match = (Array.isArray(roles) ? roles : []).find((r) => {
      const roleName = r?.role_name || r?.name || '';
      return normalizeRoleToken(roleName) === token;
    });
    return match ? Number(match.role_id) : null;
  }, [roles, normalizeRoleToken]);

  const departmentFilterOptions = React.useMemo(() => {
    const list = Array.isArray(departments) ? departments : [];
    if (!hasFixedDepartmentScope) return list;
    if (!fixedDeptId) return [];
    return list.filter(d => String(d.dept_id) === fixedDeptId);
  }, [departments, hasFixedDepartmentScope, fixedDeptId]);

  const departmentOptionsForForm = React.useMemo(() => {
    return Array.isArray(departments) ? departments : [];
  }, [departments]);

  const fixedDeptLabel = React.useMemo(() => {
    if (!fixedDeptId) return '';
    const dept = (Array.isArray(departments) ? departments : []).find(d => String(d.dept_id) === String(fixedDeptId));
    return dept ? formatDepartmentLabel(dept, String(fixedDeptId)) : String(fixedDeptId);
  }, [departments, fixedDeptId]);

  React.useEffect(() => {
    if (!roleFilter) return;
    const isValid = roleFilterOptions.some(r => String(r.role_id) === String(roleFilter));
    if (!isValid) setRoleFilter('');
  }, [roleFilter, roleFilterOptions]);

  React.useEffect(() => {
    if (!hasFixedDepartmentScope) return;
    setDeptFilter(fixedDeptId);
  }, [hasFixedDepartmentScope, fixedDeptId]);

  // Helper: normalize and prettify role names
  const formatRoleName = (name) => {
    if (!name) return 'N/A';
    return name.toString().replace(/_/g, ' ').split(/\s+/).map(w => w ? (w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()) : '').join(' ').trim();
  };

  // Helper to show SweetAlert safely
  const safeSwal = async (options) => {
    if (typeof window === 'undefined' || !window.Swal) {
      if (options && options.showCancelButton) {
        const confirmed = confirm(options.title || options.text || 'Are you sure?');
        return { isConfirmed: confirmed };
      }
      return { isConfirmed: true };
    }

    const body = document.body;
    const prevOverflow = body.style.overflow || '';
    const prevPaddingRight = body.style.paddingRight || '';
    try {
      const hasScrollbar = document.documentElement.scrollHeight > window.innerHeight;
      if (hasScrollbar) {
        const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
        if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
      }
      body.style.overflow = 'hidden';

      const res = await window.Swal.fire(options);
      return res || {};
    } catch (e) {
      console.error('safeSwal error', e);
      return { isConfirmed: false };
    } finally {
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPaddingRight;
    }
  };

  function KebabMenu({ onEdit, onToggle, onArchive, onUnarchive, archived = false }){
    const [open, setOpen] = React.useState(false);
    const containerRef = React.useRef(null);
    const menuRef = React.useRef(null);
    const [menuStyle, setMenuStyle] = React.useState(null);

    React.useEffect(()=>{
      const onDocClick = (e)=>{
        const withinBtn = containerRef.current && containerRef.current.contains(e.target);
        const withinMenu = menuRef.current && menuRef.current.contains(e.target);
        if (!withinBtn && !withinMenu) setOpen(false);
      };
      document.addEventListener('click', onDocClick);
      return ()=> document.removeEventListener('click', onDocClick);
    }, []);

    React.useEffect(()=>{
      if (!open) { setMenuStyle(null); return; }
      const btn = containerRef.current && containerRef.current.querySelector('button');
      if (!btn) return;
      const compute = ()=>{
        const rect = btn.getBoundingClientRect();
        const vh = window.innerHeight; const vw = window.innerWidth;
        const minW = 160;
        const estimatedH = archived ? 40 * 2 : 40 * (onArchive ? 3 : 2);
        const naturalH = menuRef.current ? menuRef.current.scrollHeight : estimatedH;
        const maxH = Math.floor(vh * 0.6);
        const menuH = Math.min(naturalH, maxH);
        const spaceBelow = vh - rect.bottom;
        const top = (spaceBelow >= menuH + 8) ? rect.bottom + 6 : Math.max(6, rect.top - menuH - 6);
        const preferLeft = rect.left + minW <= vw - 8;
        const style = { position: 'fixed', top: `${top}px`, zIndex: 99999, maxHeight: `${maxH}px`, overflowY: 'auto', minWidth: `${minW}px` };
        if (preferLeft) style.left = `${Math.max(8, rect.left)}px`; else style.right = `${Math.max(8, vw - rect.right)}px`;
        setMenuStyle(style);
      };
      const raf = requestAnimationFrame(compute);
      window.addEventListener('resize', compute);
      window.addEventListener('scroll', compute, true);
      return ()=>{ cancelAnimationFrame(raf); window.removeEventListener('resize', compute); window.removeEventListener('scroll', compute, true); };
    }, [open, archived, onArchive]);

    const menuNode = open ? React.createElement('div', { ref: menuRef, className: 'card', style: { ...(menuStyle || { position:'fixed', top:0, right:0 }), boxShadow:'0 6px 18px rgba(0,0,0,0.12)' }, onClick: e=> e.stopPropagation() },
      React.createElement('div', { className: 'list-group list-group-flush', style: { padding:0 } },
        archived ? React.createElement(React.Fragment, null,
          React.createElement('button', { type:'button', className:'list-group-item list-group-item-action text-primary', onClick: ()=>{ setOpen(false); onUnarchive ? onUnarchive() : (onToggle && onToggle()); } }, 'Unarchive')
        ) : React.createElement(React.Fragment, null,
          React.createElement('button', { type:'button', className:'list-group-item list-group-item-action', onClick: ()=>{ setOpen(false); onEdit && onEdit(); } }, 'Edit'),
          React.createElement('button', { type:'button', className:'list-group-item list-group-item-action', onClick: ()=>{ setOpen(false); onToggle && onToggle(); } }, 'Toggle'),
          onArchive ? React.createElement('button', { type:'button', className:'list-group-item list-group-item-action text-danger', onClick: ()=>{ setOpen(false); onArchive(); } }, 'Archive') : null
        )
      )
    ) : null;

    return (
      React.createElement('div', { ref: containerRef, className: 'position-relative d-inline-block' },
        React.createElement('button', { type:'button', className:'btn btn-light btn-sm', onClick: ()=> setOpen(s=>!s), 'aria-haspopup':'true', 'aria-expanded': open, style:{ width:36, height:36, padding:0, borderRadius:6 } }, React.createElement('span', { style:{ fontSize:18, lineHeight:'36px' } }, '\u22EE')),
        menuNode && ReactDOM.createPortal(menuNode, document.body)
      )
    );
  }

  const handleStatusSelect = (key)=>{
    const allowed = ['all','active','inactive','archive'];
    const next = allowed.includes(String(key)) ? String(key) : 'all';
    if (!isAdmin && !isDepartmentAdmin && next === 'archive') return;
    setUserPage(1);
    setStatusFilter(next);
  };

  const handleUnarchive = async (user)=>{
    try{
      const res = await safeSwal({ title: 'Unarchive user?', text: 'This will restore the user and set status to inactive.', icon: 'warning', showCancelButton: true });
      if (!res.isConfirmed) return;
      await apiPost(`users/${user.user_id}/toggle`, {});
      await fetchUsers();
      try { await safeSwal({ icon:'success', title: 'Unarchived', timer:1200, showConfirmButton:false }); } catch(e){}
    }catch(err){ console.error(err); const message = err.body?.message || err.message || 'Failed to unarchive user'; setError(message); try { await safeSwal({ icon:'error', title:'Error', text: message }); } catch(e){} }
  };

  // Compact directory columns keep related information together and reduce
  // horizontal scrolling without changing any underlying user data.
  const columns = [
    { key: 'user', label: 'User', render: (u)=>{
      const val = u?.id_number ?? u?.school_id ?? (u?.school && (u.school.school_id ?? u.school.id)) ?? null;
      const schoolId = val !== null && val !== undefined && String(val) !== '' ? String(val) : 'No School ID';
      return React.createElement('div', { className: 'd-flex align-items-center gap-3', style: { minWidth: 210 } },
        React.createElement('div', { className: 'position-relative flex-shrink-0' },
          React.createElement(UserTableAvatar, { user: u }),
          React.createElement('span', { className: `position-absolute rounded-circle ${normalizeStatus(u) === 'active' ? 'bg-success' : 'bg-secondary'}`, style: { width:10, height:10, right:0, bottom:1, border:'2px solid white' }, title: normalizeStatus(u) || 'unknown' })
        ),
        React.createElement('div', { className: 'min-w-0' },
          React.createElement('div', { className: 'fw-bold text-dark text-truncate' }, `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'Unnamed user'),
          React.createElement('div', { className: 'small text-muted' }, schoolId)
        )
      );
    } },
    { key: 'contact', label: 'Contact', render: u=> React.createElement('div', { style: { minWidth: 190 } },
      React.createElement('div', { className: 'text-dark text-break' }, u.email || 'No email'),
      React.createElement('div', { className: 'small text-muted mt-1' }, u.contact_no || 'No phone number')
    ) },
    { key: 'assignment', label: 'Assignment', render: u=> {
      const department = formatAcademicLabel(u.department_sub_name || u.dept_sub_name, u.dept_name || u.department, u.dept_id ? String(u.dept_id) : 'No department');
      const program = formatAcademicLabel(u.assigned_program_sub_name || u.program_sub_name, u.assigned_program_name, '');
      return React.createElement('div', { style: { minWidth: 210 } },
        React.createElement('div', { className: 'fw-semibold text-dark' }, department),
        showProgramColumns && program ? React.createElement('div', { className: 'small text-muted mt-1' }, program) : null
      );
    } },
    { key: 'role_name', label: 'Role', render: u=> {
      const raw = (u.role_name || u.role || '').toString();
      const display = formatRoleName(raw);
      const key = raw.toLowerCase().replace(/\s+/g, '_');
      const map = {
        admin: 'bg-blue-100 text-blue-700',
        dean: 'bg-purple-100 text-purple-700',
        program_head: 'bg-teal-100 text-teal-700',
        secretary: 'bg-gray-100 text-gray-700',
        teacher: 'bg-green-100 text-green-700'
      };
      const cls = map[key] || 'bg-indigo-100 text-indigo-700';
      return React.createElement('span', { className: `d-inline-flex align-items-center gap-2 px-2 py-1 rounded-2 ${cls}`, style:{fontSize:13, fontWeight:600} },
        React.createElement('span', { style:{width:10,height:10,display:'inline-block',borderRadius:999,marginRight:8, background: cls.includes('blue')? '#bfdbfe' : cls.includes('purple')? '#e9d5ff' : cls.includes('teal')? '#d1fae5' : cls.includes('gray')? '#f3f4f6' : cls.includes('green')? '#bbf7d0' : '#c7d2fe' } }),
        display || 'N/A'
      );
    } },
    { key: 'status', label: 'Status', render: u=> {
      const s = String(u.status || '').toLowerCase();
      const text = s === 'active' ? 'Active' : (s === 'inactive' ? 'Inactive' : s);
      return React.createElement('span', { className: `mdp-status mdp-status-${s === 'active' || s === 'inactive' || s === 'archive' ? s : 'warning'}` }, text);
    }}
  ];

  // Append the Action Button column for accounts allowed to manage users.
  if (canManageUsers) {
    columns.push({ 
      key: 'actions', 
      label: 'Actions', 
      render: u=> React.createElement(KebabMenu, { 
        archived: isArchiveView, 
        onEdit: ()=> handleEdit(u), 
        onToggle: ()=> handleToggleActive(u), 
        onArchive: (isAdmin || isDepartmentAdmin) ? ()=> handleArchive(u) : null,
        onUnarchive: ()=> handleUnarchive(u) 
      }) 
    });
  }

  const fetchUsers = async ({ silent = false } = {})=>{
    const requestId = ++userRequestRef.current;
    if (!silent) setDataLoading(true);
    try{
      const params = new URLSearchParams({
        paginate: '1',
        page: String(userPage),
        page_size: '10',
        status: effectiveStatusFilter,
      });
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (roleFilter) params.set('role_id', roleFilter);
      if (deptFilter) params.set('dept_id', deptFilter);
      const data = await apiGet(`users?${params.toString()}`);
      if (requestId !== userRequestRef.current) return;
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const normalized = rows.map(u => ({ ...u, _status: String(u.status || '').toLowerCase().trim() }));
      const nextPagination = data?.pagination || { page: 1, page_size: 10, total: normalized.length, total_pages: 1 };
      setUsers(normalized);
      setUserPagination(nextPagination);
      setUserStats(data?.status_counts || { total: 0, active: 0, inactive: 0, archived: 0 });
      setUserRoleCounts(data?.role_counts || {});
      if (Number(nextPagination.page || 1) !== Number(userPage)) setUserPage(Number(nextPagination.page || 1));
    }catch(err){
      if (requestId !== userRequestRef.current) return;
      console.error(err);
      if (!silent) setError('Failed to load users');
    }
    finally { if (requestId === userRequestRef.current && !silent) setDataLoading(false); }
  };
  const fetchRoles = async ()=>{
    try{ const data = await apiGet('roles'); setRoles(Array.isArray(data)? data: []); }catch(e){ console.error(e); }
  };
  const fetchDepartments = async ()=>{
    try{
      const d = await apiGet('departments');
      const list = Array.isArray(d) ? d.filter(x => String(x.status || '').toLowerCase() === 'active') : [];
      setDepartments(list);
      return list;
    }catch(e){ console.error('Failed to load departments', e); return []; }
  };
  const fetchPrograms = async ()=>{
    try {
      const data = await apiGet('programs');
      const list = Array.isArray(data) ? data.filter(x => String(x.status || '').toLowerCase() === 'active') : [];
      setAcademicPrograms(list);
      return list;
    } catch (e) {
      console.error('Failed to load programs', e);
      return [];
    }
  };
  const fetchProgramHeads = async (deptId = '', roleId = form.role_id, ownerUserId = form.user_id || '')=>{
    try{
      if (!deptId) {
        setProgramHeads([]);
        setProgramOptionsDeptId('');
        return;
      }
      const data = await apiGet('programs');
      let list = Array.isArray(data) ? data : [];
      list = list.filter(p => String(p.status || '').toLowerCase() === 'active');
      list = list.filter(p => String(p.dept_id) === String(deptId));
      const mapped = list.map(p => {
        const headName = `${p.head_first || ''} ${p.head_last || ''}`.trim();
        const programLabel = formatProgramLabel(p, String(p.program_id));
        const label = headName ? `${programLabel} — ${headName}` : programLabel;
        return { id: p.program_id, label };
      });
      setProgramHeads(mapped);
      setProgramOptionsDeptId(String(deptId));
      return mapped;
    }catch(e){
      console.error('Failed to load program heads', e);
      setProgramHeads([]);
      setProgramOptionsDeptId(String(deptId || ''));
      return [];
    }
  };

  React.useEffect(()=>{
    if (!currentUser) { window.location.hash = '#/login'; return; }
    fetchRoles();
    fetchDepartments();
    fetchPrograms();
  }, []);

  React.useEffect(() => {
    if (!currentUser) return;
    fetchUsers();
  }, [userPage, effectiveStatusFilter, roleFilter, deptFilter, debouncedSearch]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setUserPage(1);
      setDebouncedSearch(searchTerm.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchTerm]);

  useAutoRefresh({
    refresh: () => fetchUsers({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.ADMIN,
    enabled: Boolean(currentUser) && !showModal,
  });

  React.useEffect(()=>{
    if (!canManageUsers || !showModal) return;
    if (!roleNeedsProgram(form.role_id)) {
      setProgramHeads([]);
      return;
    }
    if (!form.dept_id) {
      setProgramHeads([]);
      return;
    }
    fetchProgramHeads(form.dept_id || '', form.role_id, form.user_id || '');
  }, [canManageUsers, showModal, form.role_id, form.dept_id, form.user_id]);

  React.useEffect(() => {
    if (!showModal) return;
    if (!form.dept_id) return;
    const valid = departmentOptionsForForm.some(d => String(d.dept_id) === String(form.dept_id));
    if (!valid) {
      setForm(prev => ({ ...prev, dept_id: departmentOptionsForForm[0]?.dept_id || '', assigned_program_head_id: '' }));
    }
  }, [showModal, form.dept_id, departmentOptionsForForm]);

  React.useEffect(() => {
    if (!showModal) return;
    if (!roleNeedsProgram(form.role_id)) return;
    if (!form.assigned_program_head_id) return;
    if (String(programOptionsDeptId) !== String(form.dept_id || '')) return;
    const valid = programHeads.some(ph => String(ph.id) === String(form.assigned_program_head_id));
    if (!valid) setForm(prev => ({ ...prev, assigned_program_head_id: '' }));
  }, [showModal, form.role_id, form.dept_id, form.assigned_program_head_id, programHeads, programOptionsDeptId]);

  const openModal = ()=>{ 
    const defaultRoleId = roleFilterOptions[0]?.role_id || '';
    const defaultDeptId = isDepartmentAdmin ? fixedDeptId : (String(defaultRoleId) === '1' ? '' : (departments[0]?.dept_id || ''));
    setForm({ first_name:'', last_name:'', email:'', password:'', contact_no:'', role_id: defaultRoleId, id_number: '', dept_id: defaultDeptId, assigned_program_head_id: '' });
    setEditImageUrl('');
    setError('');
    setShowModal(true);
  };
  // Real-time contact number availability check
  const [contactAvailability, setContactAvailability] = React.useState(null);
  const contactCheckTimer = React.useRef(null);
  React.useEffect(() => {
    if (contactCheckTimer.current) {
      clearTimeout(contactCheckTimer.current);
    }
    const digits = String(form.contact_no || '').replace(/\D/g, '').slice(0, 11);
    if (digits.length === 11 && /^09\d{9}$/.test(digits)) {
      setContactAvailability(null);
      contactCheckTimer.current = setTimeout(async () => {
        try {
          const excludeUserId = form.user_id || 0;
          const data = await apiGet(`check-contact?contact_no=${encodeURIComponent(digits)}&exclude_user_id=${excludeUserId}`);
          if (data && data.checked) {
            setContactAvailability(data.available);
          }
        } catch (e) {
          console.warn('Contact availability check failed', e);
        }
      }, 500);
    } else {
      setContactAvailability(null);
    }
    return () => {
      if (contactCheckTimer.current) clearTimeout(contactCheckTimer.current);
    };
  }, [form.contact_no, form.user_id]);

  const closeModal = ()=> setShowModal(false);
  const handleChange = (e)=>{
    const { name, value } = e.target;
    if (name === 'contact_no') {
      const digits = (value || '').toString().replace(/\D/g, '');
      setForm(prev => ({ ...prev, contact_no: digits }));
      return;
    }
    if (name === 'id_number') {
      const clean = (value || '').toString().replace(/[^0-9A-Za-z\-]/g, '').toUpperCase().slice(0, 8);
      setForm(prev => ({ ...prev, id_number: clean }));
      return;
    }
    if (name === 'dept_id' && roleNeedsProgram(form.role_id)) {
      setForm(prev=> ({ ...prev, dept_id: value, assigned_program_head_id: '' }));
      return;
    }
    if (name === 'role_id') {
      setForm(prev => ({
        ...prev,
        role_id: value,
        assigned_program_head_id: prev.has_active_schedule && roleNeedsProgram(value)
          ? prev.assigned_program_head_id
          : ''
      }));
      return;
    }
    setForm(prev=> ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e)=>{
    e && e.preventDefault && e.preventDefault();
    setLoading(true); setError('');
    try{
      let createdEmailNotification = null;
      const normalizedFirstName = String(form.first_name || '').trim();
      const normalizedLastName = String(form.last_name || '').trim();
      if (!normalizedFirstName || !normalizedLastName || !form.email || !form.role_id) { setError('Please fill required fields'); setLoading(false); return; }
      if (!personNameRegex.test(normalizedFirstName)) { setError('First name may contain letters, spaces, apostrophes, periods, and hyphens only'); setLoading(false); return; }
      if (!personNameRegex.test(normalizedLastName)) { setError('Last name may contain letters, spaces, apostrophes, periods, and hyphens only'); setLoading(false); return; }
      if (String(form.role_id) === '1') { setError('Admin role is not allowed here'); setLoading(false); return; }
      const normalizedEmail = String(form.email || '').trim().toLowerCase();
      if (!emailDomainRegex.test(normalizedEmail)) { setError('Email must follow xxxx.name.coc@phinmaed.com'); setLoading(false); return; }
      const normalizedIdNumber = String(form.id_number || '').trim();
      if (!normalizedIdNumber) { setError('ID number is required'); setLoading(false); return; }
      if (!idNumberRegex.test(normalizedIdNumber)) { setError('ID number must match format ##-###-letter (e.g. 24-018-F)'); setLoading(false); return; }

      if (form.contact_no) {
        if (!/^09\d+$/.test(form.contact_no)) { setError('Contact number must start with 09 and contain digits only'); setLoading(false); return; }
        if (form.contact_no.length !== 11) { setError('Contact number must be 11 digits (e.g. 09123456789)'); setLoading(false); return; }
      }

      const payload = { ...form, first_name: normalizedFirstName, last_name: normalizedLastName, email: normalizedEmail, id_number: normalizedIdNumber.toUpperCase() };
      if (form.user_id) delete payload.password;
      if (isDepartmentAdmin) payload.dept_id = fixedDeptId;
      if (String(form.role_id) === '1') delete payload.dept_id;
      if (String(form.role_id) !== '1' && !payload.dept_id) {
        setError('Department is required for this role');
        setLoading(false);
        return;
      }
      if (roleNeedsProgram(form.role_id)) {
        if (!payload.assigned_program_head_id) {
          setError(String(form.role_id) === '3' ? 'Owned Program is required for program heads' : 'Assigned Program is required for this role');
          setLoading(false);
          return;
        }
      } else {
        delete payload.assigned_program_head_id;
      }

      if (isDepartmentAdmin && String(payload.dept_id || '') !== fixedDeptId) {
        setError('Department admin can only manage users in their assigned department');
        setLoading(false);
        return;
      }

      if (form.user_id) {
        const existingUser = users.find(user => String(user.user_id) === String(form.user_id));
        const existingRoleId = Number(existingUser?.role_id || 0);
        const targetRoleId = Number(payload.role_id || 0);
        const deanDepartmentChanged = existingRoleId === 2
          && targetRoleId === 2
          && String(existingUser?.dept_id || '') !== String(payload.dept_id || '');
        const programHeadProgramChanged = existingRoleId === 3
          && targetRoleId === 3
          && String(existingUser?.assigned_program_head_id || existingUser?.assigned_program_id || '') !== String(payload.assigned_program_head_id || '');
        const accessAssignmentChanged = existingRoleId !== targetRoleId
          || String(existingUser?.dept_id || '') !== String(payload.dept_id || '')
          || String(existingUser?.assigned_program_head_id || existingUser?.assigned_program_id || '') !== String(payload.assigned_program_head_id || '');

        if (deanDepartmentChanged || programHeadProgramChanged) {
          const transferType = deanDepartmentChanged ? 'Dean' : 'Program Head';
          const result = await safeSwal({
            icon: 'warning',
            title: `Transfer ${transferType}?`,
            text: deanDepartmentChanged
              ? 'This Dean will stop belonging to the previous department and will belong only to the selected department.'
              : 'This Program Head will stop belonging to the previous program and will belong only to the selected program.',
            showCancelButton: true,
            confirmButtonText: 'Transfer',
            cancelButtonText: 'Cancel',
          });
          if (!result?.isConfirmed) {
            setLoading(false);
            return;
          }
        }
        if (accessAssignmentChanged && !deanDepartmentChanged && !programHeadProgramChanged) {
          const result = await safeSwal({
            icon: 'warning',
            title: 'Change User Assignment?',
            text: 'The user role, department, or program assignment will change and may affect available pages and future assignments.',
            showCancelButton: true,
            confirmButtonText: 'Save User',
            cancelButtonText: 'Cancel'
          });
          if (!result?.isConfirmed) { setLoading(false); return; }
        }
        await apiPut(`users/${form.user_id}`, payload);
      } else {
        if (!form.password) { setError('Password is required for new user'); setLoading(false); return; }
        const createResult = await apiPost('users', payload);
        createdEmailNotification = createResult?.email_notification || null;
      }

      await fetchUsers();
      closeModal();
      try {
        if (!form.user_id && createdEmailNotification && createdEmailNotification.sent === false) {
          await safeSwal({
            icon: 'warning',
            title: 'User created',
            text: 'User was created, but account email could not be sent. Please verify mail settings.',
          });
        } else {
          await safeSwal({ icon:'success', title: form.user_id ? 'User updated' : 'User created', timer: 1400, showConfirmButton: false });
        }
      } catch(e){}
    }catch(err){
      console.error(err);
      const errorMsg = err.body?.message || err.body?.error || err.message || 'Failed to create user';
      if (err.body?.error === 'contact_no_in_use' || errorMsg === 'Contact number already exists') {
        setError('This contact number is already in use by another user. Please use a different number.');
      } else {
        setError(errorMsg);
      }
    }
    finally{ setLoading(false); }
  };

  const handleEdit = (user)=>{
    const editRoleId = String(user.role_id || '');
    setForm({
      user_id: user.user_id,
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      email: user.email || '',
      password: '',
      contact_no: user.contact_no || '',
      role_id: user.role_id || '',
      id_number: user.id_number || '',
      dept_id: isDepartmentAdmin ? fixedDeptId : (user.dept_id || ''),
      assigned_program_head_id: roleNeedsProgram(editRoleId) ? (user.assigned_program_head_id || user.assigned_program_id || '') : '',
      has_active_schedule: Number(user.has_active_schedule || 0) === 1,
      active_schedule_label: user.active_schedule_label || ''
    });
    setEditImageUrl(user?.avatar || user?.image || '/src/assets/unknown.jpg');
    setError('');
    setShowModal(true);
  };
  const handleToggleActive = async (user)=>{
    const nextStatus = String(user.status || '').toLowerCase() === 'active' ? 'inactive' : 'active';
    const action = nextStatus === 'active' ? 'Activate' : 'Deactivate';
    const label = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'this user';
    const confirmation = await safeSwal({ title: `${action} user?`, text: `${label} will be ${nextStatus}${nextStatus === 'inactive' ? ' and unable to sign in or perform attendance.' : '.'}`, icon: 'question', showCancelButton: true, confirmButtonText: action });
    if (!confirmation.isConfirmed) return;
    try{
      await apiPost(`users/${user.user_id}/toggle`, {});
      await fetchUsers();
      try { await safeSwal({ icon:'success', title: 'Status updated', timer:1200, showConfirmButton:false }); } catch(e){}
    }catch(err){ console.error(err); setError(err.message || 'Failed to toggle user'); }
  };
  const handleArchive = async (user)=>{
    if (!isAdmin && !isDepartmentAdmin) {
      setError('Only Admin and Department Admin can archive user accounts.');
      return;
    }
    try{
      const res = await safeSwal({ title: 'Archive user?', text: 'This will remove the user from the active list.', icon: 'warning', showCancelButton: true });
      if (!res.isConfirmed) return;
      await apiPost(`users/${user.user_id}/archive`, {});
      await fetchUsers();
      try { await safeSwal({ icon:'success', title: 'Archived', timer:1200, showConfirmButton:false }); } catch(e){}
    }catch(err){ console.error(err); const message = err.body?.message || err.message || 'Failed to archive user'; setError(message); try { await safeSwal({ icon:'error', title:'Error', text: message }); } catch(e){} }
  };

  const openAddDeptModal = ()=>{
    setAddDeptForm({ sub_name: '', dept_name: '' });
    setAddDeptError('');
    setShowAddDeptModal(true);
  };

  const closeAddDeptModal = ()=>{
    setShowAddDeptModal(false);
    setAddDeptForm({ sub_name: '', dept_name: '' });
    setAddDeptError('');
  };

  const handleAddDeptChange = (e)=>{
    const { name, value } = e.target;
    setAddDeptForm(previous => name === 'dept_name'
      ? { ...previous, dept_name: value, sub_name: generateSubName(value) }
      : { ...previous, [name]: value });
    setAddDeptError('');
  };

  const handleAddDeptSubmit = async (e)=>{
    e && e.preventDefault && e.preventDefault();
    setAddDeptLoading(true);
    setAddDeptError('');
    try{
      const deptName = String(addDeptForm.dept_name || '').trim();
      const subName = String(addDeptForm.sub_name || '').trim();
      if (!subName) {
        setAddDeptError('Department sub name is required');
        setAddDeptLoading(false);
        return;
      }
      if (!deptName) {
        setAddDeptError('Department name is required');
        setAddDeptLoading(false);
        return;
      }

      const newDept = await apiPost('departments', { sub_name: subName, dept_name: deptName });
      const list = await fetchDepartments();
      const newDeptId = newDept?.dept_id || (list || []).find(d => String(d.dept_name || '').toLowerCase() === deptName.toLowerCase())?.dept_id || '';
      if (newDeptId) {
        setForm(prev => ({ ...prev, dept_id: newDeptId, assigned_program_head_id: '' }));
      }
      closeAddDeptModal();
      try {
        await safeSwal({ icon:'success', title: 'Department added', timer: 1400, showConfirmButton: false });
      } catch(e){}
    }catch(err){
      console.error(err);
      const errorMsg = err.body?.message || err.message || 'Failed to create department';
      setAddDeptError(errorMsg);
    }finally{
      setAddDeptLoading(false);
    }
  };

  const openAddProgramModal = ()=>{
    setAddProgramForm({
      sub_name: '',
      program_name: '',
      dept_id: form.dept_id || (isDepartmentAdmin ? fixedDeptId : '')
    });
    setAddProgramError('');
    setShowAddProgramModal(true);
  };

  const closeAddProgramModal = ()=>{
    setShowAddProgramModal(false);
    setAddProgramForm({ sub_name: '', program_name: '', dept_id: '' });
    setAddProgramError('');
  };

  const handleAddProgramChange = (e)=>{
    const { name, value } = e.target;
    setAddProgramForm(previous => name === 'program_name'
      ? { ...previous, program_name: value, sub_name: generateSubName(value) }
      : { ...previous, [name]: value });
    setAddProgramError('');
  };

  const handleAddProgramSubmit = async (e)=>{
    e && e.preventDefault && e.preventDefault();
    setAddProgramLoading(true);
    setAddProgramError('');
    try{
      const programName = String(addProgramForm.program_name || '').trim();
      const subName = String(addProgramForm.sub_name || '').trim();
      const deptId = String(addProgramForm.dept_id || '').trim();
      if (!subName) {
        setAddProgramError('Program sub name is required');
        return;
      }
      if (!programName) {
        setAddProgramError('Program name is required');
        return;
      }
      if (!deptId) {
        setAddProgramError('Department is required');
        return;
      }

      const newProgram = await apiPost('programs', {
        sub_name: subName,
        program_name: programName,
        dept_id: Number(deptId)
      });
      const options = await fetchProgramHeads(deptId, form.role_id, form.user_id || '');
      const newProgramId = newProgram?.program_id
        || options.find(p => String(p.label || '').split(' (')[0].toLowerCase() === programName.toLowerCase())?.id
        || '';
      setForm(prev => ({
        ...prev,
        dept_id: deptId,
        assigned_program_head_id: newProgramId || prev.assigned_program_head_id
      }));
      closeAddProgramModal();
      try {
        await safeSwal({ icon:'success', title: 'Program added', timer: 1400, showConfirmButton: false });
      } catch(e){}
    }catch(err){
      console.error(err);
      setAddProgramError(err.body?.message || err.message || 'Failed to create program');
    }finally{
      setAddProgramLoading(false);
    }
  };

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

  const normalizeImportKey = (key) => String(key || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_');
  const prettifyImportFieldLabel = (field) => {
    const map = {
      first_name: 'First Name',
      last_name: 'Last Name',
      email: 'Email',
      school_id: 'School ID',
      id_number: 'ID Number',
      contact_no: 'Contact No',
      role: 'Role',
      role_id: 'Role',
      department: 'Department',
      dept_id: 'Department',
      department_sub_name: 'Department',
      dept_sub_name: 'Department',
      program: 'Program',
      program_sub_name: 'Program',
      assigned_program_head_id: 'Program'
    };
    const raw = String(field || '').trim();
    if (!raw) return '';
    const key = raw.toLowerCase();
    if (map[key]) return map[key];
    return raw
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .map(w => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : ''))
      .join(' ');
  };
  const prettifyImportErrorMessage = (msg) => {
    const text = String(msg || '');
    if (!text) return text;
    const missingMatch = text.match(/missing required fields\s*\(([^)]+)\)/i);
    if (missingMatch) {
      const fields = missingMatch[1]
        .split(',')
        .map(f => f.trim())
        .filter(Boolean)
        .map(prettifyImportFieldLabel);
      return text.replace(missingMatch[0], `Missing required fields (${fields.join(', ')})`);
    }
    let out = text;
    ['first_name', 'last_name', 'email', 'school_id', 'id_number', 'contact_no', 'role', 'role_id', 'department', 'dept_id', 'program', 'assigned_program_head_id'].forEach((raw) => {
      const pretty = prettifyImportFieldLabel(raw);
      out = out.replace(new RegExp(`\\b${raw}\\b`, 'gi'), pretty);
    });
    return out;
  };

  const canonicalDepartmentImportValue = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const key = raw.toLowerCase();
    const match = departments.find(department => [
      String(department.sub_name || ''),
      String(department.dept_name || ''),
      formatDepartmentLabel(department)
    ].some(candidate => candidate.trim().toLowerCase() === key));
    return match ? formatDepartmentLabel(match, raw) : raw;
  };

  const resolveImportDepartment = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return null;
    return departments.find(department => [
      String(department.sub_name || ''),
      String(department.dept_name || ''),
      formatDepartmentLabel(department)
    ].some(candidate => candidate.trim().toLowerCase() === raw)) || null;
  };

  const canonicalProgramImportValue = (value, departmentValue = '') => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const key = raw.toLowerCase();
    const department = resolveImportDepartment(isDepartmentAdmin ? fixedDeptLabel : departmentValue);
    const candidates = department
      ? academicPrograms.filter(program => String(program.dept_id) === String(department.dept_id))
      : [];
    const match = candidates.find(program => [
      String(program.sub_name || ''),
      String(program.program_name || ''),
      formatProgramLabel(program)
    ].some(candidate => candidate.trim().toLowerCase() === key));
    return match ? formatProgramLabel(match, raw) : raw;
  };

  const mapRowsToImportDraft = (rows) => {
    const pick = (normalized, keys) => {
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(normalized, key)) {
          const val = normalized[key];
          if (val !== null && val !== undefined && String(val).trim() !== '') {
            return String(val).trim();
          }
        }
      }
      return '';
    };

    return (rows || []).map((row, idx) => {
      const normalized = {};
      Object.entries(row || {}).forEach(([k, v]) => {
        const nk = normalizeImportKey(k);
        if (!nk) return;
        normalized[nk] = typeof v === 'string' ? v.trim() : v;
      });
      const department = isDepartmentAdmin
        ? fixedDeptLabel
        : canonicalDepartmentImportValue(pick(normalized, ['department', 'dept', 'dept_name', 'department_sub_name', 'dept_sub_name']));
      const program = canonicalProgramImportValue(pick(normalized, ['program', 'program_name', 'program_sub_name']), department);
      return {
        _row: idx + 2,
        first_name: pick(normalized, ['first_name', 'firstname', 'first', 'given_name']),
        last_name: pick(normalized, ['last_name', 'lastname', 'last', 'family_name']),
        email: pick(normalized, ['email', 'email_address', 'mail']),
        school_id: pick(normalized, ['school_id', 'schoolid', 'school_id_number']),
        contact_no: pick(normalized, ['contact_no', 'contact', 'contact_number', 'phone', 'mobile']),
        role: pick(normalized, ['role', 'role_name']),
        department,
        program
      };
    });
  };

  const buildImportPayloadRows = (rows) => {
    return (rows || []).map(r => ({
      first_name: String(r?.first_name || '').trim(),
      last_name: String(r?.last_name || '').trim(),
      email: String(r?.email || '').trim(),
      school_id: String(r?.school_id || '').trim(),
      contact_no: String(r?.contact_no || '').trim(),
      role: String(r?.role || '').trim(),
      department: isDepartmentAdmin ? fixedDeptLabel : String(r?.department || '').trim(),
      program: String(r?.program || '').trim()
    }));
  };

  const buildImportErrorMap = (errs) => {
    const map = {};
    (Array.isArray(errs) ? errs : []).forEach((err) => {
      const rowNum = Number(err?.row || 0);
      if (!rowNum) return;
      if (!Array.isArray(map[rowNum])) map[rowNum] = [];
      map[rowNum].push(prettifyImportErrorMessage(err?.message || err?.error || 'Invalid data'));
    });
    return map;
  };

  const buildAdminImportErrors = (rows) => {
    const errors = [];
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const roleId = resolveRoleIdValue(row?.role);
      if (isAdminRoleValue(row?.role)) {
        errors.push({ row: row?._row, message: 'Admin role is not allowed.' });
      }
      if ([2, 3, 4, 5].includes(roleId) && !String(row?.program || '').trim()) {
        errors.push({
          row: row?._row,
          message: roleId === 3 ? 'Owned Program is required for Program Head.' : 'Assigned Program is required for this role.'
        });
      }
      if (isDepartmentAdmin) {
        if (roleId && ![2, 3, 4, 5].includes(roleId)) {
          errors.push({ row: row?._row, message: 'Department admin can only import Dean, Program Head, Secretary, and Teacher users.' });
        }
        if (!fixedDeptId) {
          errors.push({ row: row?._row, message: 'Your account has no assigned department.' });
        }
      }
    });
    return errors;
  };

  const escapeHtml = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const showImportIssuesSwal = async (errs, title = 'Validation issues') => {
    const issueList = (Array.isArray(errs) ? errs : []).slice(0, 20);
    if (!issueList.length) return;
    const rowsHtml = issueList.map((err, idx) => {
      const rowNum = err?.row || (idx + 1);
      const msg = prettifyImportErrorMessage(err?.message || err?.error || 'Invalid data');
      return `<li>Row ${escapeHtml(rowNum)}: ${escapeHtml(msg)}</li>`;
    }).join('');
    await safeSwal({
      icon: 'warning',
      title,
      html: `<div style="text-align:left"><div style="margin-bottom:8px">Please fix these rows first:</div><ul style="margin:0;padding-left:18px">${rowsHtml}</ul></div>`
    });
  };

  const totalImportPages = React.useMemo(() => {
    return Math.max(1, Math.ceil(importDraftRows.length / IMPORT_PAGE_SIZE));
  }, [importDraftRows.length, IMPORT_PAGE_SIZE]);

  React.useEffect(() => {
    if (importPage <= totalImportPages) return;
    setImportPage(totalImportPages);
  }, [importPage, totalImportPages]);

  const pagedImportDraftRows = React.useMemo(() => {
    const start = (importPage - 1) * IMPORT_PAGE_SIZE;
    return importDraftRows.slice(start, start + IMPORT_PAGE_SIZE).map((row, offset) => ({
      row,
      globalIndex: start + offset
    }));
  }, [importDraftRows, importPage, IMPORT_PAGE_SIZE]);

  const inferImportErrorFields = (messages) => {
    const fields = new Set();
    (Array.isArray(messages) ? messages : []).forEach((msg) => {
      const text = String(msg || '').toLowerCase();
      if (!text) return;
      if (text.includes('missing required fields')) {
        ['first_name', 'last_name', 'email', 'school_id', 'role'].forEach(f => fields.add(f));
      }
      if (text.includes('first_name') || text.includes('first name')) fields.add('first_name');
      if (text.includes('last_name') || text.includes('last name')) fields.add('last_name');
      if (text.includes('email')) fields.add('email');
      if (text.includes('school id') || text.includes('school_id') || text.includes('id_number')) fields.add('school_id');
      if (text.includes('contact')) fields.add('contact_no');
      if (text.includes('role')) fields.add('role');
      if (text.includes('department')) fields.add('department');
      if (text.includes('program') || text.includes('assigned')) fields.add('program');
    });
    return fields;
  };

  const runImportPreview = async (draftRows) => {
    const seq = ++importPreviewSeq.current;
    const importPath = 'users/impor' + 't';
    const payloadRows = buildImportPayloadRows(draftRows);
    const adminErrs = buildAdminImportErrors(draftRows);
    const preview = await apiPost(importPath, { rows: payloadRows, preview: true });
    const inserted = Number(preview?.inserted || 0);
    const skipped = Number(preview?.skipped || 0);
    const total = Number(preview?.total || payloadRows.length);
    const errs = (Array.isArray(preview?.errors) ? preview.errors : []).concat(adminErrs);
    const rowErrMap = buildImportErrorMap(errs);

    if (seq === importPreviewSeq.current) {
      setImportSummary({ mode: 'preview', inserted, skipped, total });
      setImportErrors(errs);
      setImportDraftSummary({ mode: 'preview', inserted, skipped, total });
      setImportRowErrors(rowErrMap);
    }

    return { inserted, skipped, total, errors: errs, rowErrMap };
  };

  const closeImportModal = (force = false) => {
    if (importProcessing && !force) return;
    setShowImportModal(false);
    setImportDraftRows([]);
    setImportRowErrors({});
    setImportDraftSummary(null);
    setImportFileName('');
    setImportPage(1);
  };

  const handleImportCellChange = (rowIndex, field, value) => {
    let nextValue = value;
    if (field === 'contact_no') nextValue = String(value || '').replace(/\D/g, '').slice(0, 11);
    if (field === 'school_id') nextValue = String(value || '').replace(/[^0-9A-Za-z\-]/g, '').toUpperCase().slice(0, 8);
    setImportDraftRows(prev => prev.map((row, idx) => (idx === rowIndex ? { ...row, [field]: nextValue } : row)));
  };

  const handleImportDepartmentBlur = (rowIndex, value) => {
    const department = canonicalDepartmentImportValue(value);
    setImportDraftRows(prev => prev.map((row, idx) => idx === rowIndex
      ? { ...row, department, program: canonicalProgramImportValue(row.program, department) }
      : row));
  };

  const downloadUserImportTemplate = () => {
    const fileName = 'user-import-template.xlsx';
    if (!window.XLSX) {
      const csv = `${USER_IMPORT_HEADERS.join(',')}\r\n`;
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'user-import-template.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      return;
    }

    const workbook = window.XLSX.utils.book_new();
    const usersSheet = window.XLSX.utils.aoa_to_sheet([USER_IMPORT_HEADERS]);
    usersSheet['!cols'] = [{ wch: 18 }, { wch: 18 }, { wch: 34 }, { wch: 14 }, { wch: 16 }, { wch: 20 }, { wch: 32 }, { wch: 36 }];
    const instructionsSheet = window.XLSX.utils.aoa_to_sheet([
      ['Field', 'Requirement', 'Example'],
      ['First Name', 'Required; letters and common name punctuation only', 'Juan'],
      ['Last Name', 'Required; letters and common name punctuation only', 'Dela Cruz'],
      ['Email', 'Required; xxxx.name.coc@phinmaed.com', 'juan.delacruz.coc@phinmaed.com'],
      ['School ID', 'Required; ##-###-letter and becomes the default password', '24-018-F'],
      ['Contact No', 'Optional; if supplied, 11 digits beginning with 09', '09123456789'],
      ['Role', 'Required; use a Role name from the Reference sheet', 'Teacher'],
      ['Department', 'Required; use a Department label from the Reference sheet', 'CITE (College of Information Technology Education)'],
      ['Program', 'Required for Dean, Program Head, Secretary, and Teacher; must belong to the Department', 'BSIT (BS Information Technology)']
    ]);
    instructionsSheet['!cols'] = [{ wch: 18 }, { wch: 72 }, { wch: 48 }];

    const roleNames = roleFilterOptions.map(role => formatRoleName(role.role_name || role.name || role.role_id));
    const departmentLabels = departments.map(department => formatDepartmentLabel(department, ''));
    const programReferences = academicPrograms.map(program => {
      const department = departments.find(item => String(item.dept_id) === String(program.dept_id));
      return [formatProgramLabel(program, ''), department ? formatDepartmentLabel(department, '') : ''];
    });
    const referenceLength = Math.max(roleNames.length, departmentLabels.length, programReferences.length, 1);
    const referenceRows = [['Roles', 'Departments', 'Programs', 'Program Department']];
    for (let index = 0; index < referenceLength; index += 1) {
      referenceRows.push([
        roleNames[index] || '',
        departmentLabels[index] || '',
        programReferences[index]?.[0] || '',
        programReferences[index]?.[1] || ''
      ]);
    }
    const referenceSheet = window.XLSX.utils.aoa_to_sheet(referenceRows);
    referenceSheet['!cols'] = [{ wch: 22 }, { wch: 48 }, { wch: 48 }, { wch: 48 }];

    window.XLSX.utils.book_append_sheet(workbook, usersSheet, 'Users');
    window.XLSX.utils.book_append_sheet(workbook, instructionsSheet, 'Instructions');
    window.XLSX.utils.book_append_sheet(workbook, referenceSheet, 'Reference');
    window.XLSX.writeFile(workbook, fileName);
  };

  React.useEffect(() => {
    if (!showImportModal) return;
    if (!importDraftRows.length) return;
    if (importProcessing) return;
    if (importAutoValidateTimerRef.current) {
      clearTimeout(importAutoValidateTimerRef.current);
      importAutoValidateTimerRef.current = null;
    }
    importAutoValidateTimerRef.current = setTimeout(() => {
      runImportPreview(importDraftRows).catch((err) => {
        console.error('Auto-validate failed', err);
      });
    }, 600);
    return () => {
      if (importAutoValidateTimerRef.current) {
        clearTimeout(importAutoValidateTimerRef.current);
        importAutoValidateTimerRef.current = null;
      }
    };
  }, [importDraftRows, showImportModal, importProcessing]);

  const handleImportDraftValidate = async () => {
    if (!importDraftRows.length) {
      setError('No rows to validate.');
      return;
    }
    setImportProcessing(true);
    setError('');
    try {
      const previewMeta = await runImportPreview(importDraftRows);
      if (previewMeta.errors.length > 0) {
        await showImportIssuesSwal(previewMeta.errors, 'Validation issues');
      }
    } catch (err) {
      console.error(err);
      setError(err?.body?.message || err?.body?.error || err?.message || 'Failed to validate import rows');
    } finally {
      setImportProcessing(false);
    }
  };

  const handleImportDraftSubmit = async () => {
    if (!importDraftRows.length) {
      setError('No rows to import.');
      return;
    }
    setImportProcessing(true);
    setError('');
    try {
      const previewMeta = await runImportPreview(importDraftRows);
      if (previewMeta.errors.length > 0) {
        await showImportIssuesSwal(previewMeta.errors, 'Cannot import yet');
        return;
      }

      const importPath = 'users/impor' + 't';
      const payloadRows = buildImportPayloadRows(importDraftRows);
      const result = await apiPost(importPath, { rows: payloadRows });
      const inserted = Number(result?.inserted || 0);
      const skipped = Number(result?.skipped || 0);
      const total = Number(result?.total || payloadRows.length);
      const errs = Array.isArray(result?.errors) ? result.errors : [];
      const rowErrMap = buildImportErrorMap(errs);
      const emailSent = Number(result?.email_notifications?.sent || 0);
      const emailFailed = Number(result?.email_notifications?.failed || 0);

      setImportSummary({ mode: 'imported', inserted, skipped, total });
      setImportErrors(errs);
      setImportDraftSummary({ mode: 'imported', inserted, skipped, total });
      setImportRowErrors(rowErrMap);

      if (errs.length > 0) {
        await showImportIssuesSwal(errs, 'Import completed with issues');
        return;
      }

      await fetchUsers();
      closeImportModal(true);
      if (inserted > 0) {
        try {
          if (emailFailed > 0) {
            await safeSwal({
              icon: 'warning',
              title: 'Import completed',
              text: `${inserted} user(s) imported. ${emailSent} email(s) sent, ${emailFailed} failed. Default password is School ID.`,
            });
          } else {
            await safeSwal({
              icon: 'success',
              title: 'Import completed',
              text: `${inserted} user(s) imported. Default password is School ID.`,
              timer: 1600,
              showConfirmButton: false
            });
          }
        } catch (e) {}
      }
    } catch (err) {
      console.error(err);
      const serverErrors = Array.isArray(err?.body?.errors) ? err.body.errors : [];
      if (serverErrors.length > 0) {
        setImportErrors(serverErrors);
        setImportRowErrors(buildImportErrorMap(serverErrors));
        setImportDraftSummary({ mode: 'imported', inserted: 0, skipped: importDraftRows.length, total: importDraftRows.length });
        await showImportIssuesSwal(serverErrors, 'Import cancelled');
      }
      setError(err?.body?.message || err?.body?.error || err?.message || 'Failed to import users');
    } finally {
      setImportProcessing(false);
    }
  };

  const handleImportFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setImporting(true);
    setError('');
    setImportSummary(null);
    setImportErrors([]);
    try {
      const rows = await parseSpreadsheet(file);
      const cleaned = rows.filter(r => Object.values(r || {}).some(v => String(v ?? '').trim() !== ''));
      if (!cleaned.length) {
        setError('No data rows found in the spreadsheet.');
        return;
      }
      const draftRows = mapRowsToImportDraft(cleaned);
      setImportDraftRows(draftRows);
      setImportFileName(file.name || '');
      setImportPage(1);
      setShowImportModal(true);

      const previewMeta = await runImportPreview(draftRows);
      if (previewMeta.errors.length > 0) {
        await showImportIssuesSwal(previewMeta.errors, 'Preview validation issues');
      } else if (previewMeta.inserted <= 0) {
        setError('No valid rows to import after preview checks.');
      }
    } catch (err) {
      console.error(err);
      setError(err?.body?.message || err?.body?.error || err?.message || 'Failed to import users');
    } finally {
      setImporting(false);
      if (e.target) e.target.value = '';
    }
  };

  const directoryRoleStats = React.useMemo(() => {
    const roleLookup = new Map((roles || []).map((role) => [Number(role.role_id), role.role_name || role.name]));
    const counts = new Map(Object.entries(userRoleCounts || {})
      .map(([roleId, value]) => [Number(roleId), Number(value) || 0])
      .filter(([roleId, value]) => roleId > 0 && value > 0));
    const total = Array.from(counts.values()).reduce((sum, value) => sum + value, 0);
    return Array.from(counts.entries()).sort((left, right) => left[0] - right[0]).map(([roleId, value]) => ({
      roleId,
      value,
      percentage: total > 0 ? value / total * 100 : 0,
      label: formatRoleName(roleLookup.get(roleId) || ({ 2: 'Dean', 3: 'Program Head', 4: 'Secretary', 5: 'Teacher', 6: 'Department Admin' }[roleId] || `Role ${roleId}`)),
      color: ROLE_COLORS[roleId] || '#4f46e5'
    }));
  }, [roles, userRoleCounts]);

  const filtersBar = React.useMemo(() => (
    <MasterToolbar>
      <MasterSearch value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Search name, email, ID, department, or program..." />
      <MasterSelect label="Status" value={effectiveStatusFilter} onChange={(event) => handleStatusSelect(event.target.value)}>
        <option value="all">Active + Inactive</option><option value="active">Active</option><option value="inactive">Inactive</option>{(isAdmin || isDepartmentAdmin) ? <option value="archive">Archived</option> : null}
      </MasterSelect>
      <MasterSelect label="Role" value={roleFilter} onChange={(event) => { setUserPage(1); setRoleFilter(event.target.value); }}>
        <option value="">All roles</option>{roleFilterOptions.map((role) => <option key={role.role_id} value={role.role_id}>{formatRoleName(role.role_name || role.name || role.role_id)}</option>)}
      </MasterSelect>
      <MasterSelect label="Department" value={deptFilter} onChange={(event) => { setUserPage(1); setDeptFilter(event.target.value); }} disabled={hasFixedDepartmentScope}>
        {!hasFixedDepartmentScope ? <option value="">All departments</option> : null}{departmentFilterOptions.map((department) => <option key={department.dept_id} value={department.dept_id}>{formatDepartmentLabel(department, department.dept_id)}</option>)}
      </MasterSelect>
      <button type="button" className="mdp-secondary" onClick={() => { setUserPage(1); setSearchTerm(''); setRoleFilter(''); setDeptFilter(hasFixedDepartmentScope ? fixedDeptId : ''); }}><i className="bi bi-x-circle me-2" />Clear</button>
    </MasterToolbar>
  ), [searchTerm, roleFilter, deptFilter, roleFilterOptions, departmentFilterOptions, hasFixedDepartmentScope, fixedDeptId, effectiveStatusFilter, isAdmin, isDepartmentAdmin]);

  // --- EARLY RETURN: Block Teacher entirely ---
  if (isTeacher) {
    return React.createElement('div', { className: 'container py-5 d-flex justify-content-center align-items-center', style: { minHeight: '50vh'} },
      React.createElement('h2', { className: 'text-danger fw-bold' }, 'Unauthorized Access')
    );
  }

  return (
    React.createElement('div', { className: 'mdp-page user-management-page' },
      <MasterPageHeader eyebrow="Administration" title="Users" description="Manage identities, academic assignments, roles, and account access." action={canManageUsers ? <div className="flex flex-wrap justify-end gap-2 user-management-actions"><button type="button" className="mdp-secondary" onClick={downloadUserImportTemplate} disabled={importing}><i className="bi bi-download me-2" />Template</button><button type="button" className="mdp-secondary" onClick={() => fileInputRef.current?.click()} disabled={importing}><i className="bi bi-file-earmark-spreadsheet me-2" />{importing ? 'Importing...' : 'Import Excel'}</button><button type="button" className="mdp-primary" onClick={openModal} disabled={importing}><i className="bi bi-person-plus-fill me-2" />Add User</button><input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleImportFile} className="d-none" /></div> : null} />,
      (!isAdmin && isProgramHead) ? <div className="mb-3 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800"><i className="bi bi-info-circle me-2" />View-only access is limited to secretaries and teachers assigned to your program.</div> : null,
      error ? <div className="mb-3 flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"><span><i className="bi bi-exclamation-circle me-2" />{error}</span><button type="button" className="btn-close btn-sm" aria-label="Dismiss error" onClick={() => setError('')} /></div> : null,
      importSummary ? <div className={`mb-3 flex items-start justify-between gap-3 rounded-xl border px-3 py-2 text-sm ${importErrors.length ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}><span><i className={`bi ${importErrors.length ? 'bi-exclamation-triangle' : 'bi-check-circle'} me-2`} />{importSummary.inserted} valid, {importSummary.skipped} skipped, {importSummary.total} total. {importSummary.mode === 'preview' ? 'Preview only—nothing imported yet.' : 'Import completed; default password is the School ID.'}</span><button type="button" className="btn-close btn-sm" aria-label="Dismiss import summary" onClick={() => setImportSummary(null)} /></div> : null,

      <MasterStats loading={dataLoading} items={statsItems.map((item, index) => ({ label: item.label, value: item.value, help: item.subLabel, icon: item.key === 'all' ? 'U' : item.key === 'active' ? '\u2713' : item.key === 'inactive' ? 'I' : 'A', tone: item.key === 'inactive' ? 'red' : item.key === 'archive' ? 'amber' : index === 0 ? 'blue' : 'green', active: String(effectiveStatusFilter) === String(item.key), onClick: () => handleStatusSelect(item.key) }))} />,
      <div className="mdp-toolbar"><div className="w-full"><div className="mb-2 flex items-center justify-between"><p className="mb-0 text-[10px] font-bold uppercase tracking-wide text-slate-500">Role distribution</p><span className="text-[10px] text-slate-400">Current directory</span></div><div className="flex h-3 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`Role distribution: ${directoryRoleStats.map((item) => `${item.label} ${item.value}`).join(', ') || 'No users'}`}>{directoryRoleStats.map((item) => <span key={item.roleId} style={{ width: `${item.percentage}%`, backgroundColor: item.color }} title={`${item.label}: ${item.value}`} />)}</div><div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">{directoryRoleStats.map((item) => <span key={item.roleId} className="inline-flex items-center gap-1.5 text-[10px] text-slate-500"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />{item.label} <strong className="text-slate-700">{item.value}</strong></span>)}</div></div></div>,
      filtersBar,
      <MasterResults title={isArchiveView ? 'Archived Accounts' : 'User Directory'} count={Number(userPagination.total || 0)} loading={dataLoading} description="Account identity, role, assignment, contact, and status information."><Table columns={columns} data={filteredUsers} pageSize={Number(userPagination.page_size || 10)} loading={dataLoading} emptyText="No users match the selected status and filters." horizontalScroll wrapCells className="user-table responsive-table" onRowClick={canManageUsers && !isArchiveView ? (u) => handleEdit(u) : null} serverPagination totalItems={Number(userPagination.total || 0)} page={userPage} onPageChange={setUserPage} /></MasterResults>,

      React.createElement(Modal, { show: showImportModal, title: 'Import Users (Preview & Edit)', size: 'xxl', onClose: closeImportModal, closeOnBackdrop: !importProcessing },
        React.createElement('div', { className: 'd-flex flex-wrap justify-content-between align-items-start gap-3 mb-3' },
          React.createElement('div', null,
            React.createElement('div', { className: 'fw-semibold' }, importFileName ? `File: ${importFileName}` : 'File: Imported spreadsheet'),
            React.createElement('div', { className: 'small text-muted' }, 'Rows with validation problems are highlighted in red. Edit them, then click Validate.')
          ),
          importDraftSummary && React.createElement('div', { className: `alert py-2 px-3 mb-0 ${Object.keys(importRowErrors || {}).length ? 'alert-warning' : 'alert-success'}` },
            `${importDraftSummary.mode === 'preview' ? 'Preview' : 'Import'}: ${importDraftSummary.inserted} valid, ${importDraftSummary.skipped} skipped, ${importDraftSummary.total} total`
          )
        ),
        isDepartmentAdmin && React.createElement('div', { className: 'alert alert-info py-2 small mb-3' },
          `Department admin import is restricted to ${fixedDeptLabel || 'your assigned department'} and allowed roles only.`
        ),
        React.createElement('div', { className: 'alert alert-light border py-2 small mb-3' },
          'All rows must pass validation before any user is created. Account emails are sent only after the full batch is saved.'
        ),
        React.createElement('div', { className: 'table-responsive border rounded', style: { maxHeight: '520px', overflow: 'auto' } },
          React.createElement('table', { className: 'table table-sm align-middle mb-0' },
            React.createElement('thead', { className: 'table-light' },
              React.createElement('tr', null,
                React.createElement('th', { style: { minWidth: 70 } }, 'Row'),
                React.createElement('th', { style: { minWidth: 140 } }, 'First Name'),
                React.createElement('th', { style: { minWidth: 140 } }, 'Last Name'),
                React.createElement('th', { style: { minWidth: 210 } }, 'Email'),
                React.createElement('th', { style: { minWidth: 140 } }, 'School ID'),
                React.createElement('th', { style: { minWidth: 140 } }, 'Contact'),
                React.createElement('th', { style: { minWidth: 130 } }, 'Role'),
                React.createElement('th', { style: { minWidth: 160 } }, 'Department'),
                React.createElement('th', { style: { minWidth: 160 } }, 'Program'),
                React.createElement('th', { style: { minWidth: 260 } }, 'Validation')
              )
            ),
            React.createElement('tbody', null,
              importDraftRows.length === 0
                ? React.createElement('tr', null,
                    React.createElement('td', { colSpan: 10, className: 'text-center text-muted py-4' }, 'No rows loaded')
                  )
                : pagedImportDraftRows.map(({ row, globalIndex }) => {
                    const rowMessages = importRowErrors?.[row._row] || [];
                    const errorFields = inferImportErrorFields(rowMessages);
                    const rowClass = rowMessages.length ? 'table-danger' : '';
                    const fieldClass = (fieldName) => `form-control form-control-sm ${errorFields.has(fieldName) ? 'is-invalid border-danger' : ''}`;
                    return React.createElement('tr', { key: `import-row-${row._row}-${globalIndex}`, className: rowClass },
                      React.createElement('td', { className: 'fw-semibold' }, row._row),
                      React.createElement('td', null,
                        React.createElement('input', {
                          type: 'text',
                          className: fieldClass('first_name'),
                          value: row.first_name || '',
                          onChange: (e) => handleImportCellChange(globalIndex, 'first_name', e.target.value)
                        })
                      ),
                      React.createElement('td', null,
                        React.createElement('input', {
                          type: 'text',
                          className: fieldClass('last_name'),
                          value: row.last_name || '',
                          onChange: (e) => handleImportCellChange(globalIndex, 'last_name', e.target.value)
                        })
                      ),
                      React.createElement('td', null,
                        React.createElement('input', {
                          type: 'text',
                          className: fieldClass('email'),
                          value: row.email || '',
                          onChange: (e) => handleImportCellChange(globalIndex, 'email', e.target.value)
                        })
                      ),
                      React.createElement('td', null,
                        React.createElement('input', {
                          type: 'text',
                          className: fieldClass('school_id'),
                          value: row.school_id || '',
                          onChange: (e) => handleImportCellChange(globalIndex, 'school_id', e.target.value)
                        })
                      ),
                      React.createElement('td', null,
                        React.createElement('input', {
                          type: 'text',
                          className: fieldClass('contact_no'),
                          value: row.contact_no || '',
                          onChange: (e) => handleImportCellChange(globalIndex, 'contact_no', e.target.value)
                        })
                      ),
                      React.createElement('td', null,
                        React.createElement('input', {
                          type: 'text',
                          className: fieldClass('role'),
                          value: row.role || '',
                          onChange: (e) => handleImportCellChange(globalIndex, 'role', e.target.value)
                        })
                      ),
                      React.createElement('td', null,
                        React.createElement('input', {
                          type: 'text',
                          className: `${fieldClass('department')} ${isDepartmentAdmin ? 'bg-light' : ''}`,
                          value: isDepartmentAdmin ? fixedDeptLabel : (row.department || ''),
                          disabled: isDepartmentAdmin,
                          title: isDepartmentAdmin ? 'Fixed to your assigned department' : undefined,
                          onChange: (e) => handleImportCellChange(globalIndex, 'department', e.target.value),
                          onBlur: (e) => handleImportDepartmentBlur(globalIndex, e.target.value)
                        })
                      ),
                      React.createElement('td', null,
                        React.createElement('input', {
                          type: 'text',
                          className: fieldClass('program'),
                          value: row.program || '',
                          onChange: (e) => handleImportCellChange(globalIndex, 'program', e.target.value),
                          onBlur: (e) => handleImportCellChange(globalIndex, 'program', canonicalProgramImportValue(e.target.value, row.department))
                        })
                      ),
                      React.createElement('td', null,
                        rowMessages.length
                          ? React.createElement('ul', { className: 'mb-0 ps-3 text-danger small' },
                              rowMessages.map((msg, msgIdx) =>
                                React.createElement('li', { key: `import-msg-${row._row}-${msgIdx}` }, msg)
                              )
                            )
                          : React.createElement('span', { className: 'text-success small fw-semibold' }, 'OK')
                      )
                    );
                  })
            )
          )
        ),
        importDraftRows.length > 0 && React.createElement('div', { className: 'd-flex justify-content-between align-items-center mt-2 flex-wrap gap-2' },
          React.createElement('div', { className: 'small text-muted' },
            `Showing ${((importPage - 1) * IMPORT_PAGE_SIZE) + 1}-${Math.min(importPage * IMPORT_PAGE_SIZE, importDraftRows.length)} of ${importDraftRows.length} row(s)`
          ),
          React.createElement('div', { className: 'd-flex align-items-center gap-2' },
            React.createElement('button', {
              type: 'button',
              className: 'btn btn-sm btn-light',
              disabled: importPage <= 1 || importProcessing,
              onClick: () => setImportPage(p => Math.max(1, p - 1))
            }, 'Prev'),
            React.createElement('span', { className: 'small text-muted' }, `Page ${importPage} of ${totalImportPages}`),
            React.createElement('button', {
              type: 'button',
              className: 'btn btn-sm btn-light',
              disabled: importPage >= totalImportPages || importProcessing,
              onClick: () => setImportPage(p => Math.min(totalImportPages, p + 1))
            }, 'Next')
          )
        ),
        React.createElement('div', { className: 'd-flex justify-content-between align-items-center mt-3 flex-wrap gap-2' },
          React.createElement('div', { className: 'small text-muted' },
            `${Object.keys(importRowErrors || {}).length} row(s) with errors`
          ),
          React.createElement('div', { className: 'd-flex gap-2' },
            React.createElement('button', { type: 'button', className: 'btn btn-light', onClick: closeImportModal, disabled: importProcessing }, 'Close'),
            React.createElement('button', { type: 'button', className: 'btn btn-outline-primary', onClick: handleImportDraftValidate, disabled: importProcessing || importDraftRows.length === 0 }, importProcessing ? 'Validating...' : 'Validate'),
            React.createElement('button', { type: 'button', className: 'btn btn-success', onClick: handleImportDraftSubmit, disabled: importProcessing || importDraftRows.length === 0 }, importProcessing ? 'Processing...' : 'Import Users')
          )
        )
      ),

      React.createElement(Modal, { show: showModal, title: form.user_id ? 'Edit User' : 'Add New User', size: 'md', onClose: closeModal },
        React.createElement('form', { onSubmit: handleSubmit },
          form.user_id && React.createElement('div', { className: 'mb-3 d-flex align-items-center gap-3' },
            React.createElement('img', {
              src: editImageUrl || '/src/assets/unknown.jpg',
              alt: `${form.first_name || ''} ${form.last_name || ''}`.trim() || 'User image',
              style: { width: 72, height: 72, borderRadius: '50%', objectFit: 'cover', border: '1px solid #ddd' }
            }),
            React.createElement('div', null,
              React.createElement('div', { className: 'fw-semibold' }, `${form.first_name || ''} ${form.last_name || ''}`.trim() || 'User'),
              React.createElement('div', { className: 'small text-muted' }, form.email || '')
            )
          ),
          React.createElement('div', { className: 'mb-3' },
            React.createElement('label', { className: 'form-label' }, 'First Name'),
            React.createElement('input', { type: 'text', name: 'first_name', value: form.first_name, onChange: handleChange, className: 'form-control', required: true })
          ),
          React.createElement('div', { className: 'mb-3' },
            React.createElement('label', { className: 'form-label' }, 'Last Name'),
            React.createElement('input', { type: 'text', name: 'last_name', value: form.last_name, onChange: handleChange, className: 'form-control', required: true })
          ),
          React.createElement('div', { className: 'mb-3' },
            React.createElement('label', { className: 'form-label' }, 'ID Number'),
            React.createElement('input', { type: 'text', name: 'id_number', value: form.id_number, onChange: handleChange, className: 'form-control', placeholder: 'e.g. 24-018-F', pattern: '\\d{2}-\\d{3}-[A-Za-z]', required: true })
          ),
          React.createElement('div', { className: 'mb-3' },
            React.createElement('label', { className: 'form-label' }, 'Email'),
            React.createElement('input', { type: 'email', name: 'email', value: form.email, onChange: handleChange, className: 'form-control', required: true, pattern: '[A-Za-z]{4}\\.[A-Za-z]+\\.coc@phinmaed\\.com', placeholder: 'jeca.parajes.coc@phinmaed.com', title: 'Use the format xxxx.name.coc@phinmaed.com' })
          ),
          !form.user_id && React.createElement('div', { className: 'mb-3' },
            React.createElement('label', { className: 'form-label' }, 'Password'),
            React.createElement('input', { type: 'password', name: 'password', value: form.password, onChange: handleChange, className: 'form-control', required: true })
          ),
          React.createElement('div', { className: 'mb-3' },
            React.createElement('label', { className: 'form-label' }, 'Contact No'),
            React.createElement('input', { type: 'text', name: 'contact_no', value: form.contact_no, onChange: handleChange, className: 'form-control', placeholder: 'e.g. 09123456789', inputMode: 'numeric', pattern: '09[0-9]+' , maxLength: 11 }),
            contactAvailability !== null && String(form.contact_no || '').replace(/\D/g, '').length === 11 && /^09\d{9}$/.test(String(form.contact_no || '').replace(/\D/g, '')) && React.createElement('div', { className: `mt-1 d-flex align-items-center gap-1 small fw-semibold ${contactAvailability ? 'text-success' : 'text-danger'}` },
              React.createElement('span', { className: `d-inline-block rounded-circle`, style: { width: 8, height: 8, backgroundColor: contactAvailability ? '#28a745' : '#dc3545' } }),
              contactAvailability ? 'Available' : 'Already in use by another user'
            )
          ),
          React.createElement('div', { className: 'mb-3' },
            React.createElement('label', { className: 'form-label' }, 'Role'),
            React.createElement('select', { name: 'role_id', value: form.role_id, onChange: handleChange, className: 'form-select', required: true },
              React.createElement('option', { value: '' }, 'Select role'),
              roleFilterOptions
                .filter(r => !(isAdmin && form.user_id && form.has_active_schedule && Number(r.role_id) === 6))
                .map(r => React.createElement('option', { key: r.role_id, value: r.role_id }, r.role_name))
            )
          ),
          String(form.role_id) !== '1' && (
            React.createElement('div', { className: 'mb-3' },
              React.createElement('div', { className: 'd-flex align-items-center justify-content-between gap-2 mb-1' },
                React.createElement('label', { className: 'form-label mb-0' }, 'Department'),
                isAdmin && React.createElement('button', { type: 'button', className: 'btn btn-sm btn-outline-success', onClick: openAddDeptModal }, 'Add New Dept')
              ),
              React.createElement('select', { value: form.dept_id || '', onChange: handleChange, name: 'dept_id', className: 'form-select', required: String(form.role_id) !== '1', disabled: isDepartmentAdmin || Boolean(form.has_active_schedule), title: form.has_active_schedule ? 'Locked while this user has a schedule in the current active semester' : (isDepartmentAdmin ? 'Fixed to your assigned department' : undefined) },
                React.createElement('option', { value: '' }, 'Select Department'),
                (departmentOptionsForForm || []).map(d => React.createElement('option', { key: d.dept_id, value: d.dept_id }, formatDepartmentLabel(d, d.dept_id)))
              )
            )
          ),
          roleNeedsProgram(form.role_id) && (
            React.createElement('div', { className: 'mb-3' },
              React.createElement('div', { className: 'd-flex align-items-center justify-content-between gap-2 mb-1' },
                React.createElement('label', { className: 'form-label mb-0' }, String(form.role_id) === '3' ? 'Owned Program' : 'Assigned Program'),
                isAdmin && React.createElement('button', { type: 'button', className: 'btn btn-sm btn-outline-success', onClick: openAddProgramModal }, 'Add New Program')
              ),
              React.createElement('select', { value: form.assigned_program_head_id || '', onChange: handleChange, name: 'assigned_program_head_id', className: 'form-select', required: true, disabled: !form.dept_id || Boolean(form.has_active_schedule), title: form.has_active_schedule ? 'Locked while this user has a schedule in the current active semester' : undefined },
                React.createElement('option', { value: '' }, form.dept_id ? 'Select Program' : 'Select Department first'),
                (programHeads || []).map(ph => React.createElement('option', { key: ph.id, value: ph.id }, ph.label))
              )
            )
          ),
          form.user_id && form.has_active_schedule && React.createElement('div', { className: 'alert alert-warning py-2 small mb-3' },
            `Can't change department or program because this user already has an active schedule for ${form.active_schedule_label || 'the current active semester'}.`
          ),

          error && React.createElement('div', { className: 'alert alert-danger py-2' }, error),

          React.createElement('div', { className: 'd-flex justify-content-end gap-2 mt-3' },
            React.createElement('button', { type: 'button', className: 'btn btn-secondary', onClick: closeModal }, 'Cancel'),
            React.createElement('button', { type: 'submit', className: 'btn btn-success', disabled: loading }, loading? 'Saving...':'Save User')
          )
        )
      ),

      React.createElement(Modal, { show: showAddDeptModal, title: 'Add New Department', size: 'sm', onClose: closeAddDeptModal },
        React.createElement('form', { onSubmit: handleAddDeptSubmit },
          React.createElement('div', { className: 'mb-3' },
            React.createElement('label', { className: 'form-label' }, 'Sub Name'),
            React.createElement('input', { type: 'text', name: 'sub_name', value: addDeptForm.sub_name, onChange: handleAddDeptChange, className: 'form-control', placeholder: 'Automatically generated', maxLength: 30, required: true })
          ),
          React.createElement('div', { className: 'mb-3' },
            React.createElement('label', { className: 'form-label' }, 'Department Name'),
            React.createElement('input', { type: 'text', name: 'dept_name', value: addDeptForm.dept_name, onChange: handleAddDeptChange, className: 'form-control', placeholder: 'e.g., Computer Studies', required: true, autoFocus: true })
          ),
          addDeptError && React.createElement('div', { className: 'alert alert-danger py-2 mb-3' }, addDeptError),
          React.createElement('div', { className: 'd-flex justify-content-end gap-2' },
            React.createElement('button', { type: 'button', className: 'btn btn-secondary', onClick: closeAddDeptModal, disabled: addDeptLoading }, 'Cancel'),
            React.createElement('button', { type: 'submit', className: 'btn btn-success', disabled: addDeptLoading }, addDeptLoading ? 'Creating...' : 'Create Department')
          )
        )
      ),

      React.createElement(Modal, { show: showAddProgramModal, title: 'Add New Program', size: 'sm', onClose: closeAddProgramModal },
        React.createElement('form', { onSubmit: handleAddProgramSubmit },
          React.createElement('div', { className: 'mb-3' },
            React.createElement('label', { className: 'form-label' }, 'Sub Name'),
            React.createElement('input', { type: 'text', name: 'sub_name', value: addProgramForm.sub_name, onChange: handleAddProgramChange, className: 'form-control', placeholder: 'Automatically generated', maxLength: 30, required: true })
          ),
          React.createElement('div', { className: 'mb-3' },
            React.createElement('label', { className: 'form-label' }, 'Program Name'),
            React.createElement('input', { type: 'text', name: 'program_name', value: addProgramForm.program_name, onChange: handleAddProgramChange, className: 'form-control', placeholder: 'e.g., BS Information Technology', required: true, autoFocus: true })
          ),
          React.createElement('div', { className: 'mb-3' },
            React.createElement('label', { className: 'form-label' }, 'Department'),
            React.createElement('select', { name: 'dept_id', value: addProgramForm.dept_id, onChange: handleAddProgramChange, className: 'form-select', required: true },
              React.createElement('option', { value: '' }, 'Select Department'),
              (departmentOptionsForForm || []).map(d => React.createElement('option', { key: d.dept_id, value: d.dept_id }, formatDepartmentLabel(d, d.dept_id)))
            )
          ),
          addProgramError && React.createElement('div', { className: 'alert alert-danger py-2 mb-3' }, addProgramError),
          React.createElement('div', { className: 'd-flex justify-content-end gap-2' },
            React.createElement('button', { type: 'button', className: 'btn btn-secondary', onClick: closeAddProgramModal, disabled: addProgramLoading }, 'Cancel'),
            React.createElement('button', { type: 'submit', className: 'btn btn-success', disabled: addProgramLoading }, addProgramLoading ? 'Creating...' : 'Create Program')
          )
        )
      )
    )
  );
}
