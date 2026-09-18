import React from 'react';
import { AuthContext } from "../../context/AuthContext.jsx";
import Table from "../../components/Table.jsx";
import Modal from "../../components/Modal.jsx";
import UserStatusBadge from "../../components/UserStatusBadge.jsx";
import { apiGet, apiPut } from "../../services/api.js";
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from "../../utils/useAutoRefresh.js";

// --- CUSTOM COMPONENT: Searchable Dropdown (No external tools) ---
const SearchableSelect = ({ options, value, onChange, placeholder, className, disabled }) => {
  const [isOpen, setIsOpen] = React.useState(false);
  const [searchTerm, setSearchTerm] = React.useState('');
  const wrapperRef = React.useRef(null);

  // Close when clicking outside
  React.useEffect(() => {
    function handleClickOutside(event) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [wrapperRef]);

  // Filter options based on search
  const filteredOptions = options.filter(opt => 
    opt.label.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Find selected label
  const selectedOption = options.find(o => String(o.value) === String(value));
  const displayLabel = selectedOption ? selectedOption.label : (placeholder || "Select...");

  return (
    <div className={`relative ${className}`} ref={wrapperRef}>
      <div 
        onClick={() => !disabled && setIsOpen(!isOpen)} 
        className={`border border-gray-200 rounded px-3 py-2 w-full bg-white flex justify-between items-center cursor-pointer ${disabled ? 'bg-gray-100 cursor-not-allowed' : ''}`}
      >
        <span className={`truncate ${!selectedOption ? 'text-gray-500' : 'text-gray-900'}`}>
          {displayLabel}
        </span>
        <span className="text-gray-400 text-xs ml-2">▼</span>
      </div>

      {isOpen && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded shadow-lg max-h-60 overflow-hidden flex flex-col">
          <div className="p-2 border-b border-gray-100">
            <input 
              type="text" 
              autoFocus
              placeholder="Search..." 
              className="w-full text-sm px-2 py-1 border border-gray-200 rounded focus:outline-none focus:border-green-500"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onClick={(e) => e.stopPropagation()} 
            />
          </div>
          <div className="overflow-y-auto flex-1">
            <div 
                className="px-4 py-2 hover:bg-gray-50 cursor-pointer text-sm text-gray-500 italic"
                onClick={() => { onChange(''); setIsOpen(false); setSearchTerm(''); }}
            >
                -- None / All --
            </div>
            {filteredOptions.length > 0 ? (
              filteredOptions.map((opt) => (
                <div 
                  key={opt.value} 
                  className={`px-4 py-2 hover:bg-green-50 cursor-pointer text-sm ${String(value) === String(opt.value) ? 'bg-green-50 text-green-700 font-medium' : 'text-gray-700'}`}
                  onClick={() => { onChange(opt.value); setIsOpen(false); setSearchTerm(''); }}
                >
                  {opt.label}
                </div>
              ))
            ) : (
              <div className="px-4 py-3 text-sm text-gray-400 text-center">No results found</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
// ------------------------------------------------------------------

const normalizeAttendanceRows = (data) => (
  Array.isArray(data)
    ? data.map((rec, i) => ({ ...rec, key: rec.attendance_id ? `${rec.attendance_id}-${i}` : `rec-${i}` }))
    : []
);

const ATTENDANCE_PAGE_SIZE = 10;

const emptyAttendanceSummary = () => ({
  total_records: 0,
  teacher_count: 0,
  completion_rate: 0,
  status_counts: {},
  checkpoints: {}
});

const formatScopeLabel = (subName, fullName) => {
  const shortLabel = String(subName || '').trim();
  const name = String(fullName || '').trim();
  if (!shortLabel) return name;
  if (!name || shortLabel.toLowerCase() === name.toLowerCase()) return shortLabel;
  return `${shortLabel} (${name})`;
};

const getAttendanceRecordStatusKey = (record) => {
  const flags = [record?.flag_in_id, record?.flag_check_id, record?.flag_out_id].map((flag) => Number(flag || 1));
  if (flags.includes(3)) return 'absent';
  if (flags.includes(7)) return 'on_leave';
  if (flags.includes(4)) return 'substituted';
  if (flags.includes(5)) return 'late';
  if (flags.every((flag) => flag === 2)) return 'present';
  if (flags.includes(8)) return 'pending';
  return 'upcoming';
};

function AttedanceManagement(){
  const { user } = React.useContext(AuthContext);
  const [records, setRecords] = React.useState([]);
  const [recordsPage, setRecordsPage] = React.useState(1);
  const [recordsTotal, setRecordsTotal] = React.useState(0);
  const [recordsSummary, setRecordsSummary] = React.useState(null);
  const [teachersAll, setTeachersAll] = React.useState([]);
  const [schedules, setSchedules] = React.useState([]);
  const [rooms, setRooms] = React.useState([]);
  const [departments, setDepartments] = React.useState([]);
  const [programs, setPrograms] = React.useState([]);
  const [semesters, setSemesters] = React.useState([]);
  const [initialLoaded, setInitialLoaded] = React.useState(false);
  
  const [resolvedDeptId, setResolvedDeptId] = React.useState(''); 

  const [selectedDeptFilter, setSelectedDeptFilter] = React.useState('');
  const [selectedProgramFilter, setSelectedProgramFilter] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [filterDate, setFilterDate] = React.useState('');
  const [filterDateDraft, setFilterDateDraft] = React.useState('');
  const [filterStatus, setFilterStatus] = React.useState('');
  const [filterTeacher, setFilterTeacher] = React.useState('');
  const [showModal, setShowModal] = React.useState(false);
  const [showEditModal, setShowEditModal] = React.useState(false);
  const [selectedRecord, setSelectedRecord] = React.useState(null);
  const [roomInfo, setRoomInfo] = React.useState(null);
  
  const [showHistoricalModal, setShowHistoricalModal] = React.useState(false);
  const [historicalFilterSemester, setHistoricalFilterSemester] = React.useState('');
  const [historicalFilterDepartment, setHistoricalFilterDepartment] = React.useState('');
  const [historicalFilterProgram, setHistoricalFilterProgram] = React.useState('');
  const [historicalFilterDate, setHistoricalFilterDate] = React.useState('');
  const [historicalFilterDateDraft, setHistoricalFilterDateDraft] = React.useState('');
  const [historicalFilterStatus, setHistoricalFilterStatus] = React.useState('');
  const [historicalFilterTeacher, setHistoricalFilterTeacher] = React.useState('');
  const [historicalRecords, setHistoricalRecords] = React.useState([]);
  const [historicalLoading, setHistoricalLoading] = React.useState(false);
  const [historicalPage, setHistoricalPage] = React.useState(1);
  const [historicalTotal, setHistoricalTotal] = React.useState(0);
  const [historicalSummary, setHistoricalSummary] = React.useState(null);
  
  const [editForm, setEditForm] = React.useState({ attendance_id:'', user_id: '', schedule_id: '', date: '', status_id: '', flag_in_id: 1, flag_check_id: 1, flag_out_id: 1, remarks: '' });
  const recordsFetchInFlightRef = React.useRef(false);
  const recordsFetchSeqRef = React.useRef(0);
  const activeFiltersRef = React.useRef({ date: '', status: '', teacherId: '', departmentId: '', programId: '', semesterId: '' });

  // Active semester detection
  const activeSemester = React.useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const isActiveStatus = (s) => String(s?.status || '').toLowerCase() === 'active';
    const isInDateRange = (s) => {
      if (!s?.start_date || !s?.end_date) return false;
      const start = new Date(`${s.start_date}T00:00:00`);
      const end = new Date(`${s.end_date}T23:59:59`);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
      return today >= start && today <= end;
    };
    return (Array.isArray(semesters) ? semesters : []).find(s => isActiveStatus(s) && isInDateRange(s)) || null;
  }, [semesters]);
  const activeSemesterId = activeSemester?.semester_id ? Number(activeSemester.semester_id) : null;
  const activeSemesterLabel = React.useMemo(() => {
    if (!activeSemester) return '';
    const schoolYear = activeSemester.session_name || activeSemester.school_year || activeSemester.school_year_name || '';
    const term = activeSemester.term || activeSemester.semester_name || activeSemester.semester || '';
    const title = [schoolYear, term].filter(Boolean).join(' - ');
    const range = activeSemester.start_date && activeSemester.end_date ? `${activeSemester.start_date} to ${activeSemester.end_date}` : '';
    return [title, range].filter(Boolean).join(' | ') || 'Current active semester';
  }, [activeSemester]);
  const activeSemesterStart = activeSemester?.start_date || '';
  const activeSemesterEnd = activeSemester?.end_date || '';

  React.useEffect(() => {
    if (!filterDate) return;
    if ((activeSemesterStart && filterDate < activeSemesterStart) || (activeSemesterEnd && filterDate > activeSemesterEnd)) {
      setFilterDate('');
      setFilterDateDraft('');
    }
  }, [filterDate, activeSemesterStart, activeSemesterEnd]);

  const getUserId = (u) => {
    if (!u) return '';
    return (u.user_id || u.id || u.userId || u.uid || '') ;
  };
  const getDeptId = (u) => {
    if (!u) return '';
    return (u.dept_id || u.department_id || u.deptId || (u.dept && (u.dept.dept_id || u.dept.id)) || u.department || '');
  };

  const getProgramId = (u) => {
    if (!u) return '';
    return u.assigned_program_head_id || u.assigned_program_id || u.program_id || '';
  };

  const roleNames = {1: 'admin', 2: 'dean', 3: 'program_head', 4: 'secretary', 5: 'teacher', 6: 'department_admin'};
  const roleId = Number(user?.role_id || 0);
  const isAdmin = roleId === 1;
  const isProgramHead = roleId === 3;
  const hasFixedDepartment = [2, 3, 4, 6].includes(roleId);

  React.useEffect(()=>{
    if (!user) { window.location.hash = '#/login'; return; }
    if (Number(user.role_id) === 5) { window.location.hash = '#/dashboard'; return; }
    
    const ctxDept = getDeptId(user);
    if(ctxDept) setResolvedDeptId(String(ctxDept));

    loadInitial();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const loadInitial = async ()=>{
    setLoading(true); setInitialLoaded(false); setError('');
    try{
      // This is a historical/read-only filter, so retain inactive teachers.
      // Archived accounts are always excluded by the users API.
      const teachersPromise = apiGet('users?list=1&teaching_roles=1&include_inactive=1').catch(async () => {
        try {
          const usersRes = await apiGet('users');
          return Array.isArray(usersRes) ? usersRes.filter(u => [2,3,4,5].includes(Number(u.role_id))) : [];
        } catch (e) {
          return [];
        }
      });
      const [sres, roomsRes, offeringsRes, deptsRes, programsRes, semsRes, teachersRes] = await Promise.all([
        apiGet('class-schedules'),
        apiGet('rooms'),
        apiGet('subject-offerings'),
        apiGet('departments'),
        apiGet('programs'),
        apiGet('semesters'),
        teachersPromise
      ]);

      const teacherList = Array.isArray(teachersRes) ? teachersRes : [];
      const normalizedTeachers = teacherList.map(t => {
        const user_id = t.user_id ?? t.id ?? t.userId ?? t.uid ?? null;
        const dept_id = t.dept_id ?? t.department_id ?? t.deptId ?? (t.dept && (t.dept.dept_id ?? t.dept.id)) ?? t.department ?? null;
        return { ...t, user_id: user_id, dept_id: dept_id };
      });
      setTeachersAll(normalizedTeachers);
      setDepartments(Array.isArray(deptsRes) ? deptsRes : []);
      setPrograms(Array.isArray(programsRes) ? programsRes : []);

      let foundDeptId = getDeptId(user);
      if (!foundDeptId && user && normalizedTeachers.length > 0) {
        const me = normalizedTeachers.find(t => String(t.user_id) === String(user.user_id));
        if (me) foundDeptId = getDeptId(me);
      }

      if (foundDeptId) {
        setResolvedDeptId(String(foundDeptId));
        if (user && [2,3,4,5,6].includes(Number(user.role_id))) {
          setSelectedDeptFilter(String(foundDeptId));
        }
      }

      const offeringsMap = Array.isArray(offeringsRes) ? offeringsRes.reduce((acc,it)=> { acc[String(it.offering_id)] = it; return acc; }, {}) : {};
      const schedulesAug = Array.isArray(sres) ? sres.map(s => ({
        ...s,
        teacher_id: s.teacher_id || s.user_id || (s.offering_id ? (offeringsMap[String(s.offering_id)] ? offeringsMap[String(s.offering_id)].user_id : null) : null)
      })) : [];
      setSemesters(Array.isArray(semsRes) ? semsRes : []);
      setSchedules(schedulesAug);
      // Archived locations belong only in Room Management's archive view.
      // Inactive rooms remain here so historical attendance can still be filtered.
      setRooms(Array.isArray(roomsRes) ? roomsRes.filter((room) => String(room?.status || '').toLowerCase() !== 'archive') : []);
    }catch(err){ console.error(err); setError(err?.message || 'Failed to load'); }
    finally{ setLoading(false); setInitialLoaded(true); }
  };

  const departmentOptions = React.useMemo(() => (
    (Array.isArray(departments) ? departments : []).map((department) => ({
      ...department,
      label: formatScopeLabel(department.sub_name || department.department_sub_name, department.dept_name)
    }))
  ), [departments]);

  const programsForDepartment = React.useCallback((departmentId) => {
    const list = Array.isArray(programs) ? programs : [];
    if (!departmentId) return isAdmin ? list : (resolvedDeptId ? list.filter((program) => String(program.dept_id) === String(resolvedDeptId)) : list);
    return list.filter((program) => String(program.dept_id) === String(departmentId));
  }, [programs, isAdmin, resolvedDeptId]);

  const mainProgramOptions = React.useMemo(() => programsForDepartment(selectedDeptFilter).map((program) => ({
    ...program,
    label: formatScopeLabel(program.sub_name || program.program_sub_name, program.program_name)
  })), [programsForDepartment, selectedDeptFilter]);

  React.useEffect(() => {
    if (!initialLoaded || !isProgramHead) return;
    const assignedProgramId = getProgramId(user) || mainProgramOptions[0]?.program_id || '';
    if (assignedProgramId && String(selectedProgramFilter) !== String(assignedProgramId)) {
      setSelectedProgramFilter(String(assignedProgramId));
    }
  }, [initialLoaded, isProgramHead, user, mainProgramOptions, selectedProgramFilter]);

  const teacherMatchesProgram = React.useCallback((teacher, programId) => {
    if (!programId) return true;
    if (String(getProgramId(teacher)) === String(programId)) return true;
    const teacherId = getUserId(teacher);
    return (Array.isArray(schedules) ? schedules : []).some((schedule) => (
      String(schedule.teacher_id || schedule.user_id) === String(teacherId)
      && String(schedule.program_id || schedule.subject_program_id || schedule.section_program_id) === String(programId)
    ));
  }, [schedules]);

  const teachersVisible = React.useMemo(()=>{
    const all = Array.isArray(teachersAll) ? teachersAll : [];
    const departmentId = isAdmin ? selectedDeptFilter : resolvedDeptId;
    let list = departmentId ? all.filter(t => String(getDeptId(t)) === String(departmentId)) : all;
    if (selectedProgramFilter) {
      list = list.filter((teacher) => teacherMatchesProgram(teacher, selectedProgramFilter));
    }
    return list;
  }, [teachersAll, isAdmin, selectedDeptFilter, selectedProgramFilter, resolvedDeptId, teacherMatchesProgram]);

  const teacherFilterOptions = React.useMemo(() => {
    return teachersVisible.map(t => ({
      value: getUserId(t),
      label: `${t.last_name || ''}, ${t.first_name || ''} ${t.role_name ? `(${t.role_name})` : ''}`
    }));
  }, [teachersVisible]);

  const buildUrl = React.useCallback((filters = {})=>{
    let url = 'attendance';
    const params = new URLSearchParams();
    // Attendance tables show names rather than profile photos. Excluding the
    // repeated Base64 avatar column removes most of the response size.
    params.set('include_avatar', '0');
    if (filters.date) params.set('date', filters.date);
    if (filters.status) params.set('status', filters.status);
    if (filters.teacherId) params.set('teacher_id', filters.teacherId);
    if (filters.departmentId) params.set('department_id', filters.departmentId);
    if (filters.programId) params.set('program_id', filters.programId);
    if (filters.semesterId) params.set('semester_id', filters.semesterId);
    if (filters.currentFirst) params.set('current_first', '1');
    if (filters.paginate) {
      params.set('paginate', '1');
      params.set('page', String(filters.page || 1));
      params.set('page_size', String(filters.pageSize || ATTENDANCE_PAGE_SIZE));
    }
    const query = params.toString();
    return query ? `${url}?${query}` : url;
  }, []);

  const fetchRecords = React.useCallback(async (filters = {}, options = {})=>{
    const silent = Boolean(options.silent);
    const force = Boolean(options.force);
    if (recordsFetchInFlightRef.current && !force) return;
    recordsFetchInFlightRef.current = true;
    const requestId = recordsFetchSeqRef.current + 1;
    recordsFetchSeqRef.current = requestId;
    if (!silent) setLoading(true);
    try{
      const url = buildUrl(filters);
      const data = await apiGet(url);
      if (requestId === recordsFetchSeqRef.current) {
        const paginated = data && !Array.isArray(data) && Array.isArray(data.rows);
        const rows = paginated ? data.rows : data;
        setRecords(normalizeAttendanceRows(rows));
        if (paginated) {
          setRecordsPage(Number(data.pagination?.page) || 1);
          setRecordsTotal(Number(data.pagination?.total) || 0);
          setRecordsSummary(data.summary || emptyAttendanceSummary());
        } else {
          const normalizedRows = normalizeAttendanceRows(rows);
          setRecordsTotal(normalizedRows.length);
          setRecordsSummary(null);
        }
        if (!silent) setError('');
      }
    }catch(err){
      console.error(err);
      if (!silent) setError(err?.message || 'Failed to load');
    }
    finally{
      if (requestId === recordsFetchSeqRef.current) {
        recordsFetchInFlightRef.current = false;
        if (!silent) setLoading(false);
      }
    }
  }, [buildUrl]);

  const refreshCurrentRecords = React.useCallback((options = {}) => {
    const current = activeFiltersRef.current || {};
    return fetchRecords(current, options);
  }, [fetchRecords]);

  useAutoRefresh({
    refresh: () => refreshCurrentRecords({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.HEAVY,
    enabled: Boolean(user)
      && Number(user.role_id) !== 5
      && !showEditModal,
  });

  React.useEffect(() => {
    if (!initialLoaded) return undefined;
    if (!activeSemesterId) {
      setRecords([]);
      setRecordsTotal(0);
      setRecordsSummary(null);
      setLoading(false);
      return undefined;
    }
    const filters = {
      date: filterDate,
      status: filterStatus,
      teacherId: filterTeacher,
      departmentId: selectedDeptFilter,
      programId: selectedProgramFilter,
      semesterId: String(activeSemesterId),
      currentFirst: true,
      paginate: true,
      page: recordsPage,
      pageSize: ATTENDANCE_PAGE_SIZE
    };
    activeFiltersRef.current = filters;
    const timer = window.setTimeout(() => fetchRecords(filters, { force: true }), 180);
    return () => window.clearTimeout(timer);
  }, [initialLoaded, activeSemesterId, filterDate, filterStatus, filterTeacher, selectedDeptFilter, selectedProgramFilter, recordsPage, fetchRecords]);

  React.useEffect(() => {
    setRecordsPage(1);
  }, [activeSemesterId, filterDate, filterStatus, filterTeacher, selectedDeptFilter, selectedProgramFilter]);

  React.useEffect(() => {
    if (!filterTeacher) return;
    if (!teacherFilterOptions.some((option) => String(option.value) === String(filterTeacher))) setFilterTeacher('');
  }, [filterTeacher, teacherFilterOptions]);

  const handleClearFilter = ()=>{
    setFilterDate('');
    setFilterDateDraft('');
    setFilterStatus('');
    setFilterTeacher('');
    if (!isProgramHead) setSelectedProgramFilter('');
    if (isAdmin) setSelectedDeptFilter('');
  };

  // Historical modal handlers
  const openHistoricalModal = () => {
    setHistoricalFilterSemester(activeSemesterId ? String(activeSemesterId) : '');
    setHistoricalFilterDepartment(isAdmin ? selectedDeptFilter : resolvedDeptId);
    setHistoricalFilterProgram(selectedProgramFilter);
    setHistoricalFilterDate('');
    setHistoricalFilterDateDraft('');
    setHistoricalFilterStatus('');
    setHistoricalFilterTeacher('');
    setShowHistoricalModal(true);
  };
  const closeHistoricalModal = () => {
    setShowHistoricalModal(false);
    setHistoricalFilterSemester('');
    setHistoricalFilterDepartment('');
    setHistoricalFilterProgram('');
    setHistoricalFilterDate('');
    setHistoricalFilterDateDraft('');
    setHistoricalFilterStatus('');
    setHistoricalFilterTeacher('');
    setHistoricalRecords([]);
    setHistoricalPage(1);
    setHistoricalTotal(0);
    setHistoricalSummary(null);
  };

  const historicalProgramOptions = React.useMemo(() => programsForDepartment(historicalFilterDepartment).map((program) => ({
    ...program,
    label: formatScopeLabel(program.sub_name || program.program_sub_name, program.program_name)
  })), [programsForDepartment, historicalFilterDepartment]);

  const historicalTeacherOptions = React.useMemo(() => {
    let list = Array.isArray(teachersAll) ? teachersAll : [];
    if (historicalFilterDepartment) list = list.filter((teacher) => String(getDeptId(teacher)) === String(historicalFilterDepartment));
    if (historicalFilterProgram) list = list.filter((teacher) => teacherMatchesProgram(teacher, historicalFilterProgram));
    return list.map((teacher) => ({
      value: getUserId(teacher),
      label: `${teacher.last_name || ''}, ${teacher.first_name || ''} ${teacher.role_name ? `(${teacher.role_name})` : ''}`
    }));
  }, [teachersAll, historicalFilterDepartment, historicalFilterProgram, teacherMatchesProgram]);

  React.useEffect(() => {
    if (!historicalFilterTeacher) return;
    if (!historicalTeacherOptions.some((option) => String(option.value) === String(historicalFilterTeacher))) setHistoricalFilterTeacher('');
  }, [historicalFilterTeacher, historicalTeacherOptions]);

  const selectedHistoricalSemester = React.useMemo(() => (
    (Array.isArray(semesters) ? semesters : []).find((semester) => String(semester.semester_id) === String(historicalFilterSemester)) || null
  ), [semesters, historicalFilterSemester]);
  const historicalDateMin = selectedHistoricalSemester?.start_date || '';
  const historicalDateMax = selectedHistoricalSemester?.end_date || '';

  React.useEffect(() => {
    if (!historicalFilterDate) return;
    if ((historicalDateMin && historicalFilterDate < historicalDateMin) || (historicalDateMax && historicalFilterDate > historicalDateMax)) {
      setHistoricalFilterDate('');
      setHistoricalFilterDateDraft('');
    }
  }, [historicalFilterDate, historicalDateMin, historicalDateMax]);

  React.useEffect(() => {
    if (!showHistoricalModal) return undefined;
    const filters = {
      date: historicalFilterDate,
      status: historicalFilterStatus,
      teacherId: historicalFilterTeacher,
      departmentId: historicalFilterDepartment,
      programId: historicalFilterProgram,
      semesterId: historicalFilterSemester,
      paginate: true,
      page: historicalPage,
      pageSize: ATTENDANCE_PAGE_SIZE
    };
    let active = true;
    const timer = window.setTimeout(async () => {
      setHistoricalLoading(true);
      try {
        const data = await apiGet(buildUrl(filters));
        if (active) {
          const paginated = data && !Array.isArray(data) && Array.isArray(data.rows);
          const rows = paginated ? data.rows : data;
          setHistoricalRecords(normalizeAttendanceRows(rows));
          setHistoricalPage(paginated ? (Number(data.pagination?.page) || 1) : 1);
          setHistoricalTotal(paginated ? (Number(data.pagination?.total) || 0) : (Array.isArray(rows) ? rows.length : 0));
          setHistoricalSummary(paginated ? (data.summary || null) : null);
        }
      } catch (err) {
        if (active) {
          setHistoricalRecords([]);
          setError(err?.body?.message || err?.message || 'Failed to load historical attendance records.');
        }
      } finally {
        if (active) setHistoricalLoading(false);
      }
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [showHistoricalModal, historicalFilterDate, historicalFilterStatus, historicalFilterTeacher, historicalFilterDepartment, historicalFilterProgram, historicalFilterSemester, historicalPage, buildUrl]);

  React.useEffect(() => {
    setHistoricalPage(1);
  }, [historicalFilterDate, historicalFilterStatus, historicalFilterTeacher, historicalFilterDepartment, historicalFilterProgram, historicalFilterSemester]);

  const historicalFilteredRecords = React.useMemo(() => {
    return normalizeAttendanceRows(Array.isArray(historicalRecords) ? historicalRecords : []);
  }, [historicalRecords]);

  const historicalSemesterOptions = React.useMemo(() => {
    return (Array.isArray(semesters) ? semesters : []).map(s => ({ 
      id: String(s.semester_id), 
      label: `${`${s.session_name || s.school_year || ''} ${s.term || s.semester_name || ''}`.trim() || `Semester ${s.semester_id}`}${Number(s.semester_id) === Number(activeSemesterId) ? ' (Active)' : ''}`
    }));
  }, [semesters, activeSemesterId]);

  const openViewModal = async (r)=>{
    setSelectedRecord(r);
    setRoomInfo(null);
    setShowModal(true);
    try{ if (r && r.room_id) { const room = await apiGet(`rooms/${r.room_id}`); setRoomInfo(room); } }catch(e){ console.warn('room fetch', e); }
  };
  const closeViewModal = ()=>{ setSelectedRecord(null); setRoomInfo(null); setShowModal(false); };

  const openEditModal = (r) => {
    const currentFlags = [r.flag_in_id, r.flag_check_id, r.flag_out_id].map(Number);
    const initialStatus = currentFlags.every(flag => flag === currentFlags[0]) && [2, 3, 7].includes(currentFlags[0])
      ? String(currentFlags[0])
      : '';
    setEditForm({
      attendance_id: r.attendance_id,
      user_id: r.user_id,
      schedule_id: r.schedule_id,
      date: r.date,
      status_id: initialStatus,
      flag_in_id: r.flag_in_id || 1,
      flag_check_id: r.flag_check_id || 1,
      flag_out_id: r.flag_out_id || 1,
      remarks: r.remarks || ''
    });
    setShowEditModal(true);
  };

  const handleEditSubmit = async (e) => {
    e && e.preventDefault && e.preventDefault();
    setLoading(true); setError('');
    try{
      const id = editForm.attendance_id;
      const statusId = Number(editForm.status_id);
      if (![2, 3, 7].includes(statusId)) {
        setError('Select an attendance status.');
        return;
      }

      const statusLabel = statusId === 2 ? 'Present' : (statusId === 3 ? 'Absent' : 'On Leave');
      const confirmation = window.Swal ? await window.Swal.fire({
        title: 'Apply Attendance Status?',
        text: `${editForm.date || 'This record'}: Check In, Mid Check, and Check Out will all be changed to ${statusLabel}.`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Save Status',
        confirmButtonColor: '#198754'
      }) : { isConfirmed: confirm(`Change all checkpoints to ${statusLabel}?`) };
      if (!confirmation.isConfirmed) return;

      // Apply one selected status consistently to all attendance checkpoints.
      const payload = {
        flag_in_id: statusId,
        flag_check_id: statusId,
        flag_out_id: statusId,
      };
      
      if (typeof editForm.remarks !== 'undefined') payload.remarks = editForm.remarks;

      await apiPut(`attendance/${id}`, payload);
      await refreshCurrentRecords({ force: true });
      setShowEditModal(false);
    }catch(err){ console.error(err); setError(err?.message || 'Failed to update'); }
    finally{ setLoading(false); }
  };

  const restrictionNote = (
    <div className="text-xs text-gray-500 p-2 bg-yellow-50 border-l-4 border-yellow-200 rounded mb-3">
      The selected status applies to Check In, Mid Check, and Check Out together.
    </div>
  );

  const renderBadge = (flagId) => {
    const fid = flagId == null ? null : Number(flagId);
    const map = {
      1: ['UPCOMING','bg-slate-100 text-slate-700'],
      2: ['PRESENT','bg-green-100 text-green-800'],
      3: ['ABSENT','bg-red-100 text-red-800'],
      4: ['SUBSTITUTED','bg-indigo-100 text-indigo-800'],
      5: ['LATE','bg-amber-100 text-amber-800'],
      7: ['ON LEAVE','bg-cyan-100 text-cyan-800'],
      8: ['PENDING','bg-orange-100 text-orange-800']
    };
    const val = map[fid] || ['','bg-gray-100 text-gray-700'];
    return React.createElement('span', { className: `inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full ${val[1]}` }, val[0]);
  };

  const renderTimeWithFlag = (time, flag) => {
    const raw = time || '';
    let formatted = '';
    if (raw) {
      try {
        let dt = null;
        if (/^\d{4}-\d{2}-\d{2}[ T]/.test(raw)) dt = new Date(raw.replace(' ', 'T'));
        else if (/^\d{2}:\d{2}(:\d{2})?$/.test(raw)) dt = new Date(`1970-01-01T${raw}`);
        else dt = new Date(raw);
        if (dt && !isNaN(dt.getTime())) formatted = dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
      } catch (e) { formatted = ''; }
    }
    return React.createElement('div', { className: 'flex items-center gap-2' }, renderBadge(flag), formatted ? React.createElement('span', { className: 'text-sm text-gray-700' }, formatted) : null);
  };

  const formatTime12 = (value) => {
    if (!value) return '';
    try {
      let dt = null;
      if (/^\d{2}:\d{2}(:\d{2})?$/.test(value)) dt = new Date(`1970-01-01T${value}`);
      else if (/^\d{4}-\d{2}-\d{2}[ T]/.test(value)) dt = new Date(value.replace(' ', 'T'));
      else dt = new Date(value);
      if (dt && !isNaN(dt.getTime())) return dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
    } catch (e) {}
    return value;
  };

  const formatDayLabel = (day, date) => {
    const raw = String(day || '').trim();
    if (raw) return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    if (!date) return '';
    const dt = new Date(`${date}T00:00:00`);
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toLocaleDateString('en-US', { weekday: 'long' });
  };

  // Admin, Dean, and Department Admin may correct generated records.
  // Program Head and Secretary remain view-only.
  const canEdit = user && [1, 2, 6].includes(Number(user.role_id));

  const attendanceStatusMeta = {
    present: { label: 'Present', color: 'bg-green-600', soft: 'bg-green-50', text: 'text-green-700', border: 'border-green-200' },
    late: { label: 'Late', color: 'bg-amber-500', soft: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' },
    absent: { label: 'Absent', color: 'bg-red-600', soft: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
    on_leave: { label: 'On Leave', color: 'bg-cyan-600', soft: 'bg-cyan-50', text: 'text-cyan-700', border: 'border-cyan-200' },
    substituted: { label: 'Substituted', color: 'bg-indigo-600', soft: 'bg-indigo-50', text: 'text-indigo-700', border: 'border-indigo-200' },
    pending: { label: 'Pending', color: 'bg-orange-500', soft: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200' },
    upcoming: { label: 'Upcoming', color: 'bg-slate-500', soft: 'bg-slate-100', text: 'text-slate-700', border: 'border-slate-200' }
  };
  const statusOrder = ['present', 'late', 'absent', 'on_leave', 'substituted', 'pending', 'upcoming'];
  const checkpointFields = [
    { key: 'in', label: 'Check In', field: 'flag_in_id' },
    { key: 'mid', label: 'Middle Check', field: 'flag_check_id' },
    { key: 'out', label: 'Check Out', field: 'flag_out_id' }
  ];

  // Filter main table to only show active semester records
  const displayRecords = React.useMemo(() => {
    if (!Array.isArray(records)) return [];
    if (!activeSemesterId) return [];
    let list = records.filter(r => Number(r.semester_id) === Number(activeSemesterId));
    if (filterStatus) {
      const statusKey = String(filterStatus).trim().toLowerCase().replace(/\s+/g, '_');
      list = list.filter((record) => getAttendanceRecordStatusKey(record) === statusKey);
    }
    return list;
  }, [records, activeSemesterId, filterStatus]);

  const getFlagGroup = (flagId) => {
    const fid = Number(flagId || 1);
    if (fid === 2) return 'present';
    if (fid === 5) return 'late';
    if (fid === 3) return 'absent';
    if (fid === 7) return 'on_leave';
    if (fid === 4) return 'substituted';
    if (fid === 8) return 'pending';
    return 'upcoming';
  };

  const getRecordStatusKey = getAttendanceRecordStatusKey;

  const attendanceStats = React.useMemo(() => {
    const rows = Array.isArray(displayRecords) ? displayRecords : [];
    if (recordsSummary && recordsSummary.status_counts && recordsSummary.checkpoints) {
      const totalRecords = Number(recordsSummary.total_records) || 0;
      const statusRows = statusOrder.map((key) => {
        const count = Number(recordsSummary.status_counts[key]) || 0;
        return {
          key,
          count,
          percent: totalRecords ? Math.round((count / totalRecords) * 100) : 0
        };
      });
      const topStatus = statusRows.reduce((best, item) => item.count > best.count ? item : best, statusRows[0] || { key: 'upcoming', count: 0 });
      const checkpointRows = checkpointFields.map((cp) => ({
        ...cp,
        total: Number(recordsSummary.checkpoints?.[cp.key]?.total) || 0,
        counts: statusOrder.reduce((acc, key) => ({
          ...acc,
          [key]: Number(recordsSummary.checkpoints?.[cp.key]?.counts?.[key]) || 0
        }), {})
      }));
      return {
        totalRecords,
        teacherCount: Number(recordsSummary.teacher_count) || 0,
        completionRate: Number(recordsSummary.completion_rate) || 0,
        topStatus,
        statusRows,
        checkpointRows
      };
    }

    const counts = statusOrder.reduce((acc, key) => ({ ...acc, [key]: 0 }), {});
    const teachers = new Set();
    let completedCheckpoints = 0;
    let totalCheckpoints = 0;

    const checkpointRows = checkpointFields.map((cp) => ({
      ...cp,
      counts: statusOrder.reduce((acc, key) => ({ ...acc, [key]: 0 }), {}),
      total: 0
    }));

    rows.forEach((record) => {
      const statusKey = getRecordStatusKey(record);
      counts[statusKey] = (counts[statusKey] || 0) + 1;

      const teacherKey = record?.user_id || `${record?.first_name || ''}-${record?.last_name || ''}`;
      if (String(teacherKey || '').trim()) teachers.add(String(teacherKey));

      checkpointRows.forEach((cp) => {
        const group = getFlagGroup(record?.[cp.field]);
        cp.counts[group] = (cp.counts[group] || 0) + 1;
        cp.total += 1;
        totalCheckpoints += 1;
        if (group !== 'upcoming' && group !== 'pending') completedCheckpoints += 1;
      });
    });

    const totalRecords = rows.length;
    const statusRows = statusOrder.map((key) => ({
      key,
      count: counts[key] || 0,
      percent: totalRecords ? Math.round(((counts[key] || 0) / totalRecords) * 100) : 0
    }));
    const topStatus = statusRows.reduce((best, item) => item.count > best.count ? item : best, statusRows[0] || { key: 'upcoming', count: 0 });
    const completionRate = totalCheckpoints ? Math.round((completedCheckpoints / totalCheckpoints) * 100) : 0;

    return {
      totalRecords,
      teacherCount: teachers.size,
      completionRate,
      topStatus,
      statusRows,
      checkpointRows
    };
  }, [displayRecords, recordsSummary]);

  const topStatusMeta = attendanceStatusMeta[attendanceStats.topStatus?.key] || attendanceStatusMeta.upcoming;
  const attendanceMetricCards = [
    { label: 'Total Records', value: attendanceStats.totalRecords, helper: 'Filtered rows', meta: attendanceStatusMeta.present },
    { label: 'Teachers', value: attendanceStats.teacherCount, helper: 'With records shown', meta: attendanceStatusMeta.upcoming },
    { label: 'Checkpoint Completion', value: `${attendanceStats.completionRate}%`, helper: 'In, middle, out', meta: attendanceStatusMeta.on_leave },
    { label: 'Top Status', value: topStatusMeta.label, helper: `${attendanceStats.topStatus?.count || 0} record(s)`, meta: topStatusMeta }
  ];

  const columns = [
    { key: 'date', label: 'Date' },
    { key: 'day', label: 'Day', render: (r)=> formatDayLabel(r.day_of_week, r.date) },
    { key: 'teacher', label: 'Teacher', render: (r)=> <div className="flex flex-col gap-1"><span>{`${r.last_name || ''}, ${r.first_name || ''}`}</span><UserStatusBadge status={r.user_status} /></div> },
    { key: 'subject', label: 'Subject / Section', render: (r)=> `${r.subject_code || ''} - ${r.section_name || ''}` },
    { key: 'building', label: 'Building', render: (r)=> r.building_name || r.room_building_name || '-' },
    { key: 'room', label: 'Room', render: (r)=> r.room_name || '-' },
    { key: 'class_time', label: 'Class Time', render: (r)=> `${formatTime12(r.start_time)||''} - ${formatTime12(r.end_time)||''}` },
    { key: 'time_in', label: 'Checked In', render: (r)=> renderTimeWithFlag(r.time_in, r.flag_in_id) },
    { key: 'time_check', label: 'Checked Mid', render: (r)=> renderTimeWithFlag(r.time_check, r.flag_check_id) },
    { key: 'time_out', label: 'Checked Out', render: (r)=> renderTimeWithFlag(r.time_out, r.flag_out_id) },
    { key: 'actions', label: 'Action', actions: (r) => [
      { label: 'View', onClick: (row) => openViewModal(row) },
      ...(canEdit ? [{ label: 'Edit', onClick: (row) => openEditModal(row) }] : [])
    ] }
  ];

  return (
    <div className="p-6 class-schedule-page class-schedule-dashboard">
      <div className="mb-6 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="grid gap-6 p-5 lg:grid-cols-[1.6fr_1fr] lg:p-7">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">Teacher Attendance Records</h2>
            <div className="mt-3">
              <div className={`inline-flex rounded-xl border px-3 py-2 text-xs font-medium ${
                activeSemesterId ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'
              }`}>
                {activeSemesterId
                  ? `Active semester: ${activeSemesterLabel || 'Current term'}`
                  : 'No active semester found for today.'}
              </div>
            </div>
            {error && <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">{error}</div>}

            <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {attendanceMetricCards.map((card) => (
                <div key={card.label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{card.label}</div>
                  <div className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{card.value}</div>
                  <div className="mt-1 text-xs text-slate-500">{card.helper}</div>
                </div>
              ))}
            </div>

            <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Checkpoint Flow</div>
                  <div className="mt-1 text-xs text-slate-500">Check-in, middle, and check-out progress</div>
                </div>
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">{attendanceStats.completionRate}% complete</span>
              </div>
              <div className="mt-4 space-y-4">
                {attendanceStats.checkpointRows.map((cp) => {
                  const waitingCount = (cp.counts.upcoming || 0) + (cp.counts.pending || 0);
                  const done = Math.max(0, cp.total - waitingCount);
                  return (
                    <div key={cp.key}>
                      <div className="mb-1 grid grid-cols-[96px_1fr_auto] items-center gap-3 text-xs">
                        <span className="font-semibold text-slate-600">{cp.label}</span>
                        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
                          {statusOrder.map((key) => {
                            const count = cp.counts[key] || 0;
                            if (!count || !cp.total) return null;
                            const meta = attendanceStatusMeta[key] || attendanceStatusMeta.upcoming;
                            return (
                              <div
                                key={`${cp.key}-${key}`}
                                className={`${meta.color} h-full`}
                                style={{ width: `${(count / cp.total) * 100}%` }}
                                title={`${meta.label}: ${count}`}
                              ></div>
                            );
                          })}
                          {!cp.total && <div className="h-full w-full bg-slate-100"></div>}
                        </div>
                        <span className="font-medium text-slate-500">{done}/{cp.total || 0}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Status Distribution</div>
            <div className="mt-4 space-y-3">
              {attendanceStats.statusRows.map((row) => {
                const meta = attendanceStatusMeta[row.key] || attendanceStatusMeta.upcoming;
                return (
                  <div key={row.key} className="grid grid-cols-[88px_1fr_auto] items-center gap-3">
                    <span className="text-xs font-semibold text-slate-600">{meta.label}</span>
                    <div className="h-2 rounded-full bg-slate-100">
                      <div className={`h-full rounded-full ${meta.color}`} style={{ width: `${row.percent}%` }}></div>
                    </div>
                    <span className="text-xs font-semibold text-slate-500">{row.count}</span>
                  </div>
                );
              })}
            </div>
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">
              {attendanceStats.totalRecords} total record(s) in view
            </div>
          </div>
        </div>
      </div>

      {restrictionNote}

      <div className="mb-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-[minmax(170px,1fr)_minmax(170px,1fr)_minmax(210px,1.2fr)_140px_165px_auto]">
        <div className="min-w-0">
          <label className="block text-xs font-medium text-gray-500 mb-1">Department</label>
          <select
            value={selectedDeptFilter}
            disabled={hasFixedDepartment}
            onChange={e=>{ setSelectedDeptFilter(e.target.value); setSelectedProgramFilter(''); setFilterTeacher(''); }}
            className="border border-gray-200 rounded px-3 py-2 w-full disabled:bg-gray-100 disabled:cursor-not-allowed"
          >
            {isAdmin && <option value="">All Departments</option>}
            {departmentOptions.map(d=> <option key={d.dept_id} value={d.dept_id}>{d.label}</option>)}
          </select>
        </div>

        <div className="min-w-0">
          <label className="block text-xs font-medium text-gray-500 mb-1">Program</label>
          <select
            value={selectedProgramFilter}
            disabled={isProgramHead || (!selectedDeptFilter && !isAdmin)}
            onChange={e=>{ setSelectedProgramFilter(e.target.value); setFilterTeacher(''); }}
            className="border border-gray-200 rounded px-3 py-2 w-full disabled:bg-gray-100 disabled:cursor-not-allowed"
          >
            {!isProgramHead && <option value="">All Programs</option>}
            {mainProgramOptions.map(program => <option key={program.program_id} value={program.program_id}>{program.label}</option>)}
          </select>
        </div>

        <div className="min-w-0">
          <label className="block text-xs font-medium text-gray-500 mb-1">Teacher</label>
          <SearchableSelect 
            options={teacherFilterOptions}
            value={filterTeacher}
            onChange={(val) => setFilterTeacher(val)}
            placeholder="Search Teacher..."
          />
        </div>

        <div className="min-w-0">
          <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
          <select value={filterStatus} onChange={e=>setFilterStatus(e.target.value)} className="w-full border border-gray-200 rounded px-3 py-2">
            <option value="">All Statuses</option>
            <option value="upcoming">Upcoming</option>
            <option value="pending">Pending</option>
            <option value="present">Present</option>
            <option value="absent">Absent</option>
            <option value="substituted">Substituted</option>
            <option value="late">Late</option>
            <option value="on leave">On Leave</option>
          </select>
        </div>

        <div className="min-w-0">
          <label className="block text-xs font-medium text-gray-500 mb-1">Date {filterDate ? '' : '(All Dates)'}</label>
          <input
            type="date"
            value={filterDateDraft}
            min={activeSemesterStart || undefined}
            max={activeSemesterEnd || undefined}
            disabled={!activeSemesterId}
            onChange={e=>{
              const value = e.target.value;
              setFilterDateDraft(value);
              setFilterDate(value);
            }}
            onKeyDown={e=>{
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') { setFilterDateDraft(filterDate); e.currentTarget.blur(); }
            }}
            className="w-full border border-gray-200 rounded px-3 py-2 disabled:bg-gray-100 disabled:cursor-not-allowed"
          />
        </div>

        <div className="flex items-end gap-2 whitespace-nowrap">
          <button onClick={handleClearFilter} className="rounded border border-slate-300 bg-slate-100 px-3 py-2 text-slate-700 hover:bg-slate-200">Clear</button>
          <button onClick={openHistoricalModal} className="px-3 py-2 border rounded bg-white text-slate-700 hover:bg-slate-100">View Historical Attendance</button>
        </div>
      </div>

      <Table
        columns={columns}
        data={displayRecords}
        pageSize={ATTENDANCE_PAGE_SIZE}
        loading={loading}
        emptyText={'No attendance records found for the active semester'}
        rowKey={(r,i)=> r.attendance_id || r.key || i}
        horizontalScroll={true}
        wrapCells
        className="responsive-table"
        serverPagination
        totalItems={recordsTotal}
        page={recordsPage}
        onPageChange={setRecordsPage}
      />

      <Modal show={showModal} title={'Attendance Details'} onClose={closeViewModal} size="lg">
        {selectedRecord ? (
          <div className="space-y-6">
            <div className="bg-gradient-to-r from-white to-gray-50 p-6 rounded-2xl border shadow-sm transform transition-all duration-300">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-xs text-gray-500">Teacher</div>
                  <div className="mt-1 text-2xl font-bold text-gray-900">{`${selectedRecord.last_name || ''}, ${selectedRecord.first_name || ''}`}</div>
                  <UserStatusBadge status={selectedRecord.user_status} className="mt-2" />
                  <div className="mt-2 text-sm text-gray-600">{`${selectedRecord.subject_code || ''} — ${selectedRecord.subject_name || ''}`}</div>
                </div>

                <div className="text-right">
                  <div className="text-xs text-gray-500">Date</div>
                  <div className="mt-1 text-sm font-medium text-gray-800">{selectedRecord.date}</div>
                  <div className="mt-3 text-xs text-gray-500">Class Time</div>
                  <div className="text-sm font-medium text-gray-700">{`${formatTime12(selectedRecord.start_time) || ''} — ${formatTime12(selectedRecord.end_time) || ''}`}</div>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-3">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gray-100 text-gray-800 text-sm">
                  <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7v4a1 1 0 001 1h3m10-6h3a1 1 0 011 1v4m-6 4v6m-4-6v6"></path></svg>
                  <span>{roomInfo?.building_name || selectedRecord.building_name || selectedRecord.room_building_name || 'N/A'}</span>
                </div>

                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gray-100 text-gray-800 text-sm">
                  <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a1 1 0 001-1V7a1 1 0 00-1-1H5a1 1 0 00-1 1v13a1 1 0 001 1z"></path></svg>
                  <span>{roomInfo?.room_name || selectedRecord.room_name || 'N/A'}</span>
                </div>

                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gray-100 text-gray-800 text-sm">
                  <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8c-1.657 0-3-1.343-3-3S10.343 2 12 2s3 1.343 3 3-1.343 3-3 3zM6 20c0-3.314 2.686-6 6-6s6 2.686 6 6"></path></svg>
                  <span>{roomInfo?.floor_name || selectedRecord.attendance_floor_name || selectedRecord.floor_name || 'N/A'}</span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="p-4 bg-white border rounded-xl shadow-sm transform transition-transform duration-300 hover:-translate-y-1 hover:shadow-lg motion-reduce:transform-none">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs text-gray-500">Checked In</div>
                    <div className="mt-2 flex items-center gap-3">
                      {renderTimeWithFlag(selectedRecord.time_in, selectedRecord.flag_in_id)}
                    </div>
                  </div>
                  {(selectedRecord.checked_in_at || selectedRecord.time_in) ? <div className="text-xs text-gray-400">{selectedRecord.checked_in_at || selectedRecord.time_in}</div> : null}
                </div>
                <div className="mt-3 text-xs text-gray-600">Location</div>
                <div className="mt-1 font-mono text-sm bg-gray-50 p-3 rounded text-gray-800">{`${selectedRecord.latitude_in || 'N/A'}, ${selectedRecord.longitude_in || 'N/A'}${selectedRecord.altitude_in ? ` • alt ${selectedRecord.altitude_in}m` : ''}`}</div>
              </div>

              <div className="p-4 bg-white border rounded-xl shadow-sm transform transition-transform duration-300 hover:-translate-y-1 hover:shadow-lg motion-reduce:transform-none">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs text-gray-500">Checked Mid</div>
                    <div className="mt-2 flex items-center gap-3">
                      {renderTimeWithFlag(selectedRecord.time_check, selectedRecord.flag_check_id)}
                    </div>
                  </div>
                  {(selectedRecord.checked_mid_at || selectedRecord.time_check) ? <div className="text-xs text-gray-400">{selectedRecord.checked_mid_at || selectedRecord.time_check}</div> : null}
                </div>
                <div className="mt-3 text-xs text-gray-600">Location</div>
                <div className="mt-1 font-mono text-sm bg-gray-50 p-3 rounded text-gray-800">{`${selectedRecord.latitude_check || 'N/A'}, ${selectedRecord.longitude_check || 'N/A'}${selectedRecord.altitude_check ? ` • alt ${selectedRecord.altitude_check}m` : ''}`}</div>
              </div>

              <div className="p-4 bg-white border rounded-xl shadow-sm transform transition-transform duration-300 hover:-translate-y-1 hover:shadow-lg motion-reduce:transform-none">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs text-gray-500">Checked Out</div>
                    <div className="mt-2 flex items-center gap-3">
                      {renderTimeWithFlag(selectedRecord.time_out, selectedRecord.flag_out_id)}
                    </div>
                  </div>
                  {(selectedRecord.checked_out_at || selectedRecord.time_out) ? <div className="text-xs text-gray-400">{selectedRecord.checked_out_at || selectedRecord.time_out}</div> : null}
                </div>
                <div className="mt-3 text-xs text-gray-600">Location</div>
                <div className="mt-1 font-mono text-sm bg-gray-50 p-3 rounded text-gray-800">{`${selectedRecord.latitude_out || 'N/A'}, ${selectedRecord.longitude_out || 'N/A'}${selectedRecord.altitude_out ? ` • alt ${selectedRecord.altitude_out}m` : ''}`}</div>
              </div>
            </div>

            <div className="flex justify-end">
              <button onClick={closeViewModal} className="px-4 py-2 rounded-lg border bg-white hover:bg-gray-50">Close</button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* Historical Attendance Modal */}
      <Modal show={showHistoricalModal} title="Historical Attendance Records" onClose={closeHistoricalModal} size="xxl">
        <div className="space-y-4">
          <div className={`rounded-xl border p-4 ${activeSemesterId ? 'border-green-200 bg-green-50 text-green-900' : 'border-red-200 bg-red-50 text-red-900'}`}>
            <div className="text-xs font-semibold uppercase tracking-wide mb-1">Semester Context</div>
            <div className="text-sm font-semibold">
              {activeSemesterId
                ? `Currently active: ${activeSemesterLabel}`
                : 'No active semester set for today.'}
            </div>
            <div className="text-xs mt-1">Select a semester below to browse historical attendance records from past academic terms.</div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-600 mb-3">Filter Historical Attendance</div>
            <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-[minmax(150px,1.1fr)_minmax(150px,1fr)_minmax(150px,1fr)_minmax(190px,1.2fr)_130px_155px_120px]">
              <div className="min-w-0">
                <label className="block text-xs font-medium text-gray-700 mb-1">Semester</label>
                <select
                  value={historicalFilterSemester}
                  onChange={e => {
                    setHistoricalFilterSemester(e.target.value);
                    setHistoricalFilterDate('');
                    setHistoricalFilterDateDraft('');
                  }}
                  className="block w-full border border-gray-200 rounded px-3 py-2 text-sm"
                >
                  <option value="">All Semesters</option>
                  {historicalSemesterOptions.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </div>
              <div className="min-w-0">
                <label className="block text-xs font-medium text-gray-700 mb-1">Department</label>
                <select
                  value={historicalFilterDepartment}
                  disabled={hasFixedDepartment}
                  onChange={e => { setHistoricalFilterDepartment(e.target.value); setHistoricalFilterProgram(''); setHistoricalFilterTeacher(''); }}
                  className="block w-full border border-gray-200 rounded px-3 py-2 text-sm disabled:bg-gray-100 disabled:cursor-not-allowed"
                >
                  {isAdmin && <option value="">All Departments</option>}
                  {departmentOptions.map(department => <option key={department.dept_id} value={department.dept_id}>{department.label}</option>)}
                </select>
              </div>
              <div className="min-w-0">
                <label className="block text-xs font-medium text-gray-700 mb-1">Program</label>
                <select
                  value={historicalFilterProgram}
                  disabled={isProgramHead || (!historicalFilterDepartment && !isAdmin)}
                  onChange={e => { setHistoricalFilterProgram(e.target.value); setHistoricalFilterTeacher(''); }}
                  className="block w-full border border-gray-200 rounded px-3 py-2 text-sm disabled:bg-gray-100 disabled:cursor-not-allowed"
                >
                  {!isProgramHead && <option value="">All Programs</option>}
                  {historicalProgramOptions.map(program => <option key={program.program_id} value={program.program_id}>{program.label}</option>)}
                </select>
              </div>
              <div className="min-w-0">
                <label className="block text-xs font-medium text-gray-700 mb-1">Teacher</label>
                <SearchableSelect
                  options={historicalTeacherOptions}
                  value={historicalFilterTeacher}
                  onChange={(val) => setHistoricalFilterTeacher(val)}
                  placeholder="Search Teacher..."
                  className="w-full"
                />
              </div>
              <div className="min-w-0">
                <label className="block text-xs font-medium text-gray-700 mb-1">Status</label>
                <select value={historicalFilterStatus} onChange={e => setHistoricalFilterStatus(e.target.value)} className="block w-full border border-gray-200 rounded px-3 py-2 text-sm">
                  <option value="">All Statuses</option>
                  <option value="present">Present</option>
                  <option value="late">Late</option>
                  <option value="absent">Absent</option>
                  <option value="on_leave">On Leave</option>
                  <option value="substituted">Substituted</option>
                  <option value="pending">Pending</option>
                  <option value="upcoming">Upcoming</option>
                </select>
              </div>
              <div className="min-w-0">
                <label className="block text-xs font-medium text-gray-700 mb-1">Date {historicalFilterDate ? '' : '(All Dates)'}</label>
                <input
                  type="date"
                  value={historicalFilterDateDraft}
                  min={historicalDateMin || undefined}
                  max={historicalDateMax || undefined}
                  onChange={e => {
                    const value = e.target.value;
                    setHistoricalFilterDateDraft(value);
                    setHistoricalFilterDate(value);
                  }}
                  onKeyDown={e=>{
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') { setHistoricalFilterDateDraft(historicalFilterDate); e.currentTarget.blur(); }
                  }}
                  className="block w-full border border-gray-200 rounded px-3 py-2 text-sm"
                />
              </div>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => {
                    setHistoricalFilterSemester(activeSemesterId ? String(activeSemesterId) : '');
                    setHistoricalFilterDepartment(isAdmin ? '' : resolvedDeptId);
                    setHistoricalFilterProgram(isProgramHead ? String(getProgramId(user) || mainProgramOptions[0]?.program_id || '') : '');
                    setHistoricalFilterDate('');
                    setHistoricalFilterDateDraft('');
                    setHistoricalFilterStatus('');
                    setHistoricalFilterTeacher('');
                  }}
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold uppercase tracking-wide text-slate-600 transition hover:bg-slate-100"
                >
                  Reset Filters
                </button>
              </div>
            </div>
          </div>

          {/* Historical Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {(() => {
              const hRows = historicalFilteredRecords;
              const hTeachers = new Set();
              let hCompleted = 0;
              let hTotal = 0;
              hRows.forEach(r => {
                const tKey = r?.user_id || `${r?.first_name || ''}-${r?.last_name || ''}`;
                if (String(tKey || '').trim()) hTeachers.add(String(tKey));
              });
              checkpointFields.forEach(cp => {
                hRows.forEach(r => {
                  hTotal += 1;
                  const g = getFlagGroup(r?.[cp.field]);
                  if (g !== 'upcoming' && g !== 'pending') hCompleted += 1;
                });
              });
              const hPresent = hRows.filter(r => getRecordStatusKey(r) === 'present').length;
              const hAbsent = hRows.filter(r => getRecordStatusKey(r) === 'absent').length;
              const hLate = hRows.filter(r => getRecordStatusKey(r) === 'late').length;
              const compRate = hTotal ? Math.round((hCompleted / hTotal) * 100) : 0;
              const hasSummary = Boolean(historicalSummary && historicalSummary.status_counts);
              const totalRecords = hasSummary ? (Number(historicalSummary.total_records) || 0) : hRows.length;
              const teacherCount = hasSummary ? (Number(historicalSummary.teacher_count) || 0) : hTeachers.size;
              const presentCount = hasSummary ? (Number(historicalSummary.status_counts.present) || 0) : hPresent;
              const absentCount = hasSummary ? (Number(historicalSummary.status_counts.absent) || 0) : hAbsent;
              const lateCount = hasSummary ? (Number(historicalSummary.status_counts.late) || 0) : hLate;
              const completionRate = hasSummary ? (Number(historicalSummary.completion_rate) || 0) : compRate;
              return [
                { label: 'Total Records', value: totalRecords, helper: 'Filtered rows' },
                { label: 'Teachers', value: teacherCount, helper: 'With records' },
                { label: 'Present', value: presentCount, helper: `${lateCount} late` },
                { label: 'Absent', value: absentCount, helper: `${completionRate}% checkpoint completion` },
              ].map((card, idx) => (
                <div key={idx} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{card.label}</div>
                  <div className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{card.value}</div>
                  <div className="mt-1 text-xs text-slate-500">{card.helper}</div>
                </div>
              ));
            })()}
          </div>

          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
              <div className="text-sm font-semibold text-gray-800">Historical Attendance Records</div>
              <div className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600">
                {historicalTotal} record(s)
              </div>
            </div>
            <div className="p-3 sm:p-4">
              {historicalFilteredRecords.length === 0 && !historicalLoading ? (
                <div className="text-center py-14 border-2 border-dashed border-slate-200 rounded-2xl">
                  <div className="text-slate-400 mb-2 text-lg font-medium">📋 No historical attendance records found</div>
                  <p className="text-sm text-slate-500 max-w-md mx-auto">
                    No attendance records match the selected filter criteria. Try adjusting your filters or selecting a different semester.
                  </p>
                </div>
              ) : (
                <Table
                  columns={[
                    { key: 'date', label: 'Date' },
                    { key: 'day', label: 'Day', render: (r)=> formatDayLabel(r.day_of_week, r.date) },
                    { key: 'teacher', label: 'Teacher', render: (r)=> <div className="flex flex-col gap-1"><span>{`${r.last_name || ''}, ${r.first_name || ''}`}</span><UserStatusBadge status={r.user_status} /></div> },
                    { key: 'subject', label: 'Subject / Section', render: (r)=> `${r.subject_code || ''} - ${r.section_name || ''}` },
                    { key: 'building', label: 'Building', render: (r) => <span className="text-xs">{r.building_name || r.room_building_name || 'N/A'}</span> },
                    { key: 'room', label: 'Room', render: (r) => <span className="text-xs">{r.room_name || 'N/A'}</span> },
                    { key: 'class_time', label: 'Class Time', render: (r)=> `${formatTime12(r.start_time)||''} - ${formatTime12(r.end_time)||''}` },
                    {
                      key: 'semester_label',
                      label: 'Semester',
                      render: (r) => {
                        const sem = semesters.find(sem => Number(sem.semester_id) === Number(r.semester_id));
                        return <span className="text-xs">{sem ? `${sem.session_name || sem.school_year || ''} ${sem.term || sem.semester_name || ''}`.trim() || `Semester ${sem.semester_id}` : '-'}</span>;
                      }
                    },
                    { key: 'time_in', label: 'Checked In', render: (r)=> renderTimeWithFlag(r.time_in, r.flag_in_id) },
                    { key: 'time_check', label: 'Checked Mid', render: (r)=> renderTimeWithFlag(r.time_check, r.flag_check_id) },
                    { key: 'time_out', label: 'Checked Out', render: (r)=> renderTimeWithFlag(r.time_out, r.flag_out_id) },
                    { key: 'actions', label: 'Action', actions: (r) => [{ label: 'View', onClick: (row) => openViewModal(row) }] }
                  ]}
                  data={historicalFilteredRecords}
                  loading={historicalLoading}
                  pageSize={ATTENDANCE_PAGE_SIZE}
                  horizontalScroll={true}
                  wrapCells
                  className="class-schedule-table responsive-table"
                  serverPagination
                  totalItems={historicalTotal}
                  page={historicalPage}
                  onPageChange={setHistoricalPage}
                />
              )}
            </div>
          </div>

          <div className="flex justify-end items-center gap-2 border-t border-gray-200 pt-4">
            <button type="button" onClick={closeHistoricalModal} className="px-4 py-2 rounded bg-green-600 text-white hover:bg-green-700 text-sm">Close</button>
          </div>
        </div>
      </Modal>

      {/* Apply one attendance status to all three checkpoints. */}
      <Modal show={showEditModal} title={'Edit Attendance Status'} onClose={()=>setShowEditModal(false)} size="md">
        <form onSubmit={handleEditSubmit}>
          <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-600">Current status</div>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
                <div className="mb-1 text-xs text-gray-500">Check In</div>
                {renderBadge(editForm.flag_in_id)}
              </div>
              <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
                <div className="mb-1 text-xs text-gray-500">Mid Check</div>
                {renderBadge(editForm.flag_check_id)}
              </div>
              <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
                <div className="mb-1 text-xs text-gray-500">Check Out</div>
                {renderBadge(editForm.flag_out_id)}
              </div>
            </div>
          </div>

          <div className="mb-3">
            <label className="block text-xs font-medium text-gray-600 mb-1">New Status for All Checkpoints</label>
            <select
              value={editForm.status_id}
              onChange={e=> setEditForm(prev=> ({...prev, status_id: e.target.value}))}
              className="border border-gray-200 rounded px-3 py-2 w-full"
              required
            >
              <option value="" disabled>Select status</option>
              <option value="2">Present</option>
              <option value="7">On Leave</option>
              <option value="3">Absent</option>
            </select>
          </div>

          <p className="mb-4 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            Saving will set Check In, Mid Check, and Check Out to the selected status.
          </p>

          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-1">Remarks</label>
            <textarea value={editForm.remarks} onChange={e=> setEditForm(prev=> ({...prev, remarks: e.target.value}))} className="border rounded px-3 py-2 w-full" rows="3"></textarea>
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={()=>setShowEditModal(false)} className="px-4 py-2 border rounded text-gray-700">Cancel</button>
            <button type="submit" disabled={loading || !editForm.status_id} className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50">
              {loading ? 'Saving...' : 'Save Status'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

try{ if (typeof window !== 'undefined') window.AttedanceManagement = AttedanceManagement; }catch(e){}

export default AttedanceManagement;
