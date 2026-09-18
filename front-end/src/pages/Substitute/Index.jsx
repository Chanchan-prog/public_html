import React from 'react';
import { AuthContext } from "../../context/AuthContext.jsx";
import Table from '../../components/Table.jsx';
import Modal from '../../components/Modal.jsx';
import UserStatusBadge from '../../components/UserStatusBadge.jsx';
import LoadingState from '../../components/LoadingState.jsx';
import { apiGet, apiPost } from '../../services/api.js';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';
import { MasterPageHeader, MasterStats, MasterToolbar, MasterResults } from '../../components/MasterDataPage.jsx';

// Avoid importing sweetalert2 directly to prevent dev-tunnel/module-loader issues.
// Use global SweetAlert2 (window.Swal) when available, otherwise fallback to alert().
const swalFire = (title, text, icon) => {
  if (typeof window !== 'undefined' && window.Swal && typeof window.Swal.fire === 'function') {
    return window.Swal.fire(title, text, icon);
  }
  // Fallback: combine title and text for basic feedback
  const msg = text ? `${title}: ${text}` : title;
  if (icon === 'error' || icon === 'warning') alert(msg); else alert(msg);
  return Promise.resolve();
};

const sameId = (a, b) => String(a ?? '') === String(b ?? '');

const formatTime12 = (value) => {
  if (!value) return '--';
  const parts = String(value).split(':');
  const hours = Number(parts[0]);
  const minutes = Number(parts[1] || 0);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return String(value);
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHour = hours % 12 || 12;
  return `${displayHour}:${String(minutes).padStart(2, '0')} ${period}`;
};

const localDateKey = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getHistoryStatus = (record) => {
  const date = String(record?.date || '');
  const today = localDateKey();
  if (date === today) return 'today';
  if (date > today) return 'upcoming';
  return 'completed';
};

const isCurrentSemesterRecord = (record) => {
  if (String(record?.semester_status || '').toLowerCase() !== 'active') return false;
  const today = localDateKey();
  if (record?.semester_start && today < String(record.semester_start)) return false;
  if (record?.semester_end && today > String(record.semester_end)) return false;
  return true;
};

const historyGroupKey = (record) => [
  record?.leave_id || `legacy-${record?.substitution_id || ''}`,
  record?.teacher_id || '',
  record?.substitute_id || '',
  record?.date || '',
  record?.semester_id || '',
  record?.subject_id || record?.subject_code || '',
  record?.start_time || '',
  record?.end_time || ''
].join('|');

const semesterLabel = (record) => {
  const parts = [record?.school_year_name, record?.semester_term].filter(Boolean);
  return parts.join(' - ') || 'Semester not specified';
};

const scheduleSelectionKey = (schedule) => `${schedule?.schedule_id ?? ''}|${schedule?.date ?? ''}`;

const isAssignedSchedule = (schedule) => Number(schedule?.is_assigned) === 1 || Boolean(schedule?.substitution_id);

const buildParallelGroupKey = (schedule) => {
  const subjectIdentity = schedule?.subject_id || schedule?.subject_code;
  if (!subjectIdentity) return `single|${scheduleSelectionKey(schedule)}`;
  return [
    schedule?.date || '',
    schedule?.semester_id || '',
    subjectIdentity,
    schedule?.start_time || '',
    schedule?.end_time || ''
  ].join('|');
};

const SelectionCheckbox = ({ indeterminate = false, ...props }) => {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);
  return <input ref={ref} type="checkbox" {...props} />;
};

const getScheduleOffering = (schedule, offerings) => {
  if (!schedule || schedule.offering_id == null) return null;
  return offerings.find(o => sameId(o.offering_id, schedule.offering_id)) || null;
};

const buildScheduleLabel = (schedule, offerings) => {
  const offering = getScheduleOffering(schedule, offerings);
  const subjectCode = schedule?.subject_code || offering?.subject_code || 'Class';
  const sectionName = schedule?.section_name || offering?.section_name || '';
  const day = schedule?.day_of_week || '';
  const start = formatTime12(schedule?.start_time);
  const end = formatTime12(schedule?.end_time);
  const room = schedule?.room_name ? ` | ${schedule.room_name}` : '';
  return `${subjectCode}${sectionName ? ` - ${sectionName}` : ''} (${day} ${start}-${end})${room}`;
};

const buildAvailableScheduleLabel = (schedule) => {
  const subjectCode = schedule?.subject_code || schedule?.subject_name || 'Class';
  const sectionName = schedule?.section_name || '';
  const day = schedule?.day_of_week || '';
  const start = formatTime12(schedule?.start_time);
  const end = formatTime12(schedule?.end_time);
  const room = schedule?.room_name ? ` | ${schedule.room_name}` : '';
  return `${subjectCode}${sectionName ? ` - ${sectionName}` : ''} (${day} ${start}-${end})${room}`;
};

export default function SubstituteIndex() {
  const { user } = React.useContext(AuthContext); 
  const isDean = [2, 6].includes(Number(user?.role_id));
  const canAddSubstitution = isDean;
  const [rows, setRows] = React.useState([]);
  
  // Data for Dropdowns
  const [teachers, setTeachers] = React.useState([]);
  const [historyTeachers, setHistoryTeachers] = React.useState([]);
  const [eligibleLeaveTeachers, setEligibleLeaveTeachers] = React.useState([]);
  const [schedules, setSchedules] = React.useState([]);
  const [offerings, setOfferings] = React.useState([]);
  const [schoolYears, setSchoolYears] = React.useState([]);
  const [academicSemesters, setAcademicSemesters] = React.useState([]);
  const [availableSchedules, setAvailableSchedules] = React.useState([]);
  const [availableLoading, setAvailableLoading] = React.useState(false);
  const [expandedGroups, setExpandedGroups] = React.useState({});
  const [conflictCheck, setConflictCheck] = React.useState({ loading: false, conflicts: [], error: '' });
  const conflictRequestRef = React.useRef(0);
  const [candidateCheck, setCandidateCheck] = React.useState({ loading: false, candidates: [], error: '' });
  const candidateRequestRef = React.useRef(0);
  
  const [loading, setLoading] = React.useState(true);
  const [showModal, setShowModal] = React.useState(false);
  const [selected, setSelected] = React.useState(null);
  
  // Filters
  const [filterDate, setFilterDate] = React.useState('');
  const [filterTeacher, setFilterTeacher] = React.useState('');
  const [filterClass, setFilterClass] = React.useState('');
  const [filterSchoolYear, setFilterSchoolYear] = React.useState('');
  const [filterSemester, setFilterSemester] = React.useState('');
  const [historyView, setHistoryView] = React.useState('current');
  const historyFiltersInitializedRef = React.useRef(false);
  const [page, setPage] = React.useState(1);
  const [pagination, setPagination] = React.useState({ page: 1, page_size: 10, total: 0, total_pages: 1 });
  const [substitutionStats, setSubstitutionStats] = React.useState({ assignments: 0, coveredClasses: 0, upcoming: 0 });

  // Form State (Updated for batch selection)
  const [form, setForm] = React.useState({ 
    original_teacher_id: '', 
    substitute_id: '',
    selectedSchedules: [] // Array to hold multiple { schedule_id, date } objects
  });

  const classOptions = React.useMemo(() => {
    const map = {};
    schedules.forEach(s => {
      map[s.schedule_id] = buildScheduleLabel(s, offerings);
    });
    return Object.keys(map).map(k => ({ id: k, label: map[k] }));
  }, [schedules, offerings]);

  const availableScheduleGroups = React.useMemo(() => {
    const groups = new Map();
    availableSchedules.forEach(schedule => {
      const key = buildParallelGroupKey(schedule);
      if (!groups.has(key)) groups.set(key, { key, schedules: [] });
      groups.get(key).schedules.push(schedule);
    });
    return Array.from(groups.values()).map(group => ({
      ...group,
      schedules: group.schedules.slice().sort((a, b) => {
        const sectionCompare = String(a.section_name || '').localeCompare(String(b.section_name || ''));
        if (sectionCompare !== 0) return sectionCompare;
        return String(a.room_name || '').localeCompare(String(b.room_name || ''));
      })
    }));
  }, [availableSchedules]);

  const selectedScheduleKeys = React.useMemo(
    () => new Set(form.selectedSchedules.map(scheduleSelectionKey)),
    [form.selectedSchedules]
  );

  const selectedScheduleSignature = React.useMemo(
    () => form.selectedSchedules.map(scheduleSelectionKey).sort().join(','),
    [form.selectedSchedules]
  );

  const conflictedScheduleKeys = React.useMemo(() => new Set(
    conflictCheck.conflicts.map(conflict => `${conflict.selected_schedule_id}|${conflict.selected_date}`)
  ), [conflictCheck.conflicts]);

  const hasConflictBlock = conflictCheck.loading || Boolean(conflictCheck.error) || conflictCheck.conflicts.length > 0;

  const candidateByUserId = React.useMemo(() => {
    const map = new Map();
    candidateCheck.candidates.forEach(candidate => map.set(String(candidate.user_id), candidate));
    return map;
  }, [candidateCheck.candidates]);

  const substituteOptions = React.useMemo(() => teachers
    .filter(teacher => String(teacher.user_id) !== String(form.original_teacher_id))
    .slice()
    .sort((left, right) => {
      const leftCandidate = candidateByUserId.get(String(left.user_id));
      const rightCandidate = candidateByUserId.get(String(right.user_id));
      const leftRank = leftCandidate ? (leftCandidate.available ? 0 : 2) : 1;
      const rightRank = rightCandidate ? (rightCandidate.available ? 0 : 2) : 1;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return String(left.last_name || '').localeCompare(String(right.last_name || ''))
        || String(left.first_name || '').localeCompare(String(right.first_name || ''));
    }), [teachers, form.original_teacher_id, candidateByUserId]);

  const historyGroups = React.useMemo(() => {
    const groups = new Map();
    (Array.isArray(rows) ? rows : []).forEach(record => {
      const key = historyGroupKey(record);
      if (!groups.has(key)) groups.set(key, { ...record, group_id: key, records: [] });
      groups.get(key).records.push(record);
    });
    return Array.from(groups.values()).map(group => {
      const sections = Array.from(new Set(group.records.map(record => record.section_name).filter(Boolean)));
      const rooms = Array.from(new Set(group.records.map(record => record.room_name).filter(Boolean)));
      return {
        ...group,
        section_count: group.records.length,
        section_names: sections,
        room_names: rooms,
        history_status: getHistoryStatus(group)
      };
    });
  }, [rows]);

  const semesterOptions = React.useMemo(() => {
    return academicSemesters
      .filter(semester => !filterSchoolYear || String(semester.session_id) === String(filterSchoolYear))
      .map(semester => ({
        id: String(semester.semester_id),
        school_year_id: String(semester.session_id || ''),
        label: semester.term || `Semester ${semester.semester_id}`,
        status: semester.status
      }));
  }, [academicSemesters, filterSchoolYear]);

  const schoolYearOptions = React.useMemo(() => schoolYears
    .filter(year => String(year.status || '').toLowerCase() !== 'archive')
    .map(year => ({
      id: String(year.session_id || year.school_year_id || ''),
      label: year.session_name || 'Unnamed school year',
      status: String(year.status || '').toLowerCase()
    })), [schoolYears]);

  const filteredRows = historyGroups;

  const columns = [
    { key: 'date', label: 'Date' },
    { key: 'teacher', label: 'Original Teacher', render: r => <div className="flex flex-col gap-1"><span>{`${r.teacher_last || ''}, ${r.teacher_first || ''}`}</span><UserStatusBadge status={r.teacher_user_status} /></div> },
    { key: 'class_info', label: 'Class', render: r => (
      <div>
        <div className="font-semibold">{r.subject_code || r.subject_name || 'Class'}</div>
        <div className="text-xs text-gray-500">{formatTime12(r.start_time)} - {formatTime12(r.end_time)}</div>
        {r.section_count > 1 && <div className="text-xs font-semibold text-indigo-700">{r.section_count} parallel sections</div>}
      </div>
    ) },
    { key: 'dept_name', label: 'Department' },
    { key: 'substitute', label: 'Substitute', render: r => <div className="flex flex-col gap-1"><span>{`${r.sub_last || ''}, ${r.sub_first || ''}`}</span><UserStatusBadge status={r.substitute_user_status} /></div> },
    { key: 'leave_coverage', label: 'Approved Leave', render: r => r.leave_id ? (
      <div>
        <div className="font-semibold text-green-800">{r.leave_type || 'Approved leave'}</div>
        <div className="text-xs text-gray-500">{r.leave_date_from} to {r.leave_date_to}</div>
        {String(r.leave_status || '').toLowerCase() === 'void' && (
          <div className="text-xs font-bold text-red-700">Cancelled after assignment</div>
        )}
      </div>
    ) : <span className="text-xs text-amber-700 font-semibold">Legacy record</span> },
    { key: 'status', label: 'Status', render: r => {
      const styles = r.history_status === 'upcoming'
        ? 'bg-green-100 text-green-800'
        : r.history_status === 'today'
          ? 'bg-blue-100 text-blue-800'
          : 'bg-gray-200 text-gray-700';
      const label = r.history_status === 'today' ? 'Today' : r.history_status === 'upcoming' ? 'Upcoming' : 'Completed';
      return <span className={`px-2 py-1 rounded-full text-xs font-bold ${styles}`}>{label}</span>;
    } },
    { key: 'actions', label: 'Actions', actions: (row) => [
        { label: 'View', onClick: () => openView(row) }
      ]
    }
  ];

  React.useEffect(() => { setPage(1); }, [historyView, filterSchoolYear, filterSemester, filterDate, filterTeacher, filterClass]);

  const fetchRows = React.useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams({ paginate: '1', page: String(page), page_size: '10' });
      if (historyView && historyView !== 'all') params.set('history_view', historyView);
      if (filterSchoolYear) params.set('school_year_id', filterSchoolYear);
      if (filterSemester) params.set('semester_id', filterSemester);
      if (filterDate) params.set('date', filterDate);
      if (filterTeacher) params.set('teacher_id', filterTeacher);
      if (filterClass) params.set('schedule_id', filterClass);
      const d = await apiGet(`substitute?${params.toString()}`);
      setRows(Array.isArray(d?.rows) ? d.rows : (Array.isArray(d) ? d : []));
      if (d?.pagination) {
        setPagination(d.pagination);
        if (Number(d.pagination.page || 1) !== page) setPage(Number(d.pagination.page || 1));
      }
      if (d?.summary) setSubstitutionStats({
        assignments: Number(d.summary.assignments || 0),
        coveredClasses: Number(d.summary.covered_classes || 0),
        upcoming: Number(d.summary.upcoming || 0),
      });
    } catch(e) { console.error('Failed to load substitutions', e); }
    if (!silent) setLoading(false);
  }, [page, historyView, filterSchoolYear, filterSemester, filterDate, filterTeacher, filterClass]);

  const loadDropdownData = async () => {
    if (!user) return;
    try {
      const [tRes, sRes, oRes, eligibleRes, schoolYearRes, semesterRes] = await Promise.all([
        apiGet('users?list=1&teaching_roles=1&include_inactive=1'),
        apiGet('class-schedules'),
        apiGet('subject-offerings'),
        canAddSubstitution ? apiGet('substitute/eligible-teachers') : Promise.resolve([]),
        apiGet('school-years'),
        apiGet('semesters')
      ]);

      let allTeachingUsers = Array.isArray(tRes)
        ? tRes.filter(candidate => [2, 3, 4, 5].includes(Number(candidate?.role_id)))
        : [];
      let allTeachers = allTeachingUsers.filter(candidate => ['active', '1', 'true'].includes(String(candidate?.status || 'active').trim().toLowerCase()));
      const allSchedules = Array.isArray(sRes) ? sRes : [];
      let myDeptId = user.dept_id;

      allTeachers = allTeachers.sort((left, right) =>
        String(left.last_name || '').localeCompare(String(right.last_name || ''))
        || String(left.first_name || '').localeCompare(String(right.first_name || ''))
      );

      if (!myDeptId && allTeachingUsers.length > 0) {
        const me = allTeachingUsers.find(u => String(u.user_id) === String(user.user_id));
        if (me && me.dept_id) {
            myDeptId = me.dept_id;
        }
      }

      if (Number(user.role_id) !== 1) {
        if (myDeptId) {
          allTeachingUsers = allTeachingUsers.filter(t => String(t.dept_id) === String(myDeptId));
          const filtered = allTeachers.filter(t => String(t.dept_id) === String(myDeptId));
            if (filtered.length > 0) {
                allTeachers = filtered;
            }
        }
      }

      setTeachers(allTeachers);
      setHistoryTeachers(allTeachingUsers);
      setEligibleLeaveTeachers(Array.isArray(eligibleRes) ? eligibleRes : []);
      setSchedules(allSchedules);
      setOfferings(Array.isArray(oRes) ? oRes : []);
      const nextSchoolYears = Array.isArray(schoolYearRes) ? schoolYearRes : [];
      const nextSemesters = Array.isArray(semesterRes) ? semesterRes : [];
      setSchoolYears(nextSchoolYears);
      setAcademicSemesters(nextSemesters);

      if (!historyFiltersInitializedRef.current) {
        const currentSchoolYear = nextSchoolYears.find(year => String(year.status || '').toLowerCase() === 'active');
        const currentSchoolYearId = currentSchoolYear ? String(currentSchoolYear.session_id || currentSchoolYear.school_year_id || '') : '';
        const currentSemester = nextSemesters.find(semester =>
          String(semester.status || '').toLowerCase() === 'active'
          && (!currentSchoolYearId || String(semester.session_id) === currentSchoolYearId)
        );
        setFilterSchoolYear(currentSchoolYearId);
        setFilterSemester(currentSemester ? String(currentSemester.semester_id) : '');
        historyFiltersInitializedRef.current = true;
      }
    } catch (e) { console.error("Failed to load options", e); }
  };

  React.useEffect(() => { 
    if(user) {
      loadDropdownData();
    }
  }, [user]);

  React.useEffect(() => {
    if (user) fetchRows();
  }, [user, fetchRows]);

  useAutoRefresh({
    refresh: () => fetchRows({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.WORKFLOW,
    enabled: Boolean(user) && showModal !== 'add',
  });

  React.useEffect(() => {
    let cancelled = false;
    const loadAvailableSchedules = async () => {
      if (!form.original_teacher_id) {
        setAvailableSchedules([]);
        setAvailableLoading(false);
        return;
      }
      setAvailableSchedules([]);
      setAvailableLoading(true);
      try {
        const data = await apiGet(`substitute/available?teacher_id=${encodeURIComponent(form.original_teacher_id)}`);
        if (!cancelled) {
          setAvailableSchedules(Array.isArray(data) ? data.map(row => ({
            ...row,
            label: buildAvailableScheduleLabel(row)
          })) : []);
        }
      } catch (e) {
        console.error('Failed to load available substitution schedules', e);
        if (!cancelled) setAvailableSchedules([]);
      } finally {
        if (!cancelled) setAvailableLoading(false);
      }
    };

    loadAvailableSchedules();
    return () => { cancelled = true; };
  }, [form.original_teacher_id]);

  React.useEffect(() => {
    const requestId = ++candidateRequestRef.current;
    if (!form.original_teacher_id || form.selectedSchedules.length === 0) {
      setCandidateCheck({ loading: false, candidates: [], error: '' });
      return undefined;
    }

    setCandidateCheck({ loading: true, candidates: [], error: '' });
    const timer = window.setTimeout(async () => {
      try {
        const response = await apiPost('substitute/check-candidates', {
          original_teacher_id: form.original_teacher_id,
          substitutions: form.selectedSchedules
        });
        if (requestId !== candidateRequestRef.current) return;
        setCandidateCheck({
          loading: false,
          candidates: Array.isArray(response?.candidates) ? response.candidates : [],
          error: ''
        });
      } catch (error) {
        if (requestId !== candidateRequestRef.current) return;
        setCandidateCheck({
          loading: false,
          candidates: [],
          error: error.body?.message || error.body?.error || error.message || 'Unable to check teacher availability.'
        });
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [form.original_teacher_id, selectedScheduleSignature]);

  React.useEffect(() => {
    const requestId = ++conflictRequestRef.current;
    if (!form.original_teacher_id || !form.substitute_id || form.selectedSchedules.length === 0) {
      setConflictCheck({ loading: false, conflicts: [], error: '' });
      return undefined;
    }

    setConflictCheck({ loading: true, conflicts: [], error: '' });
    const timer = window.setTimeout(async () => {
      try {
        const response = await apiPost('substitute/check-conflicts', {
          original_teacher_id: form.original_teacher_id,
          substitute_id: form.substitute_id,
          substitutions: form.selectedSchedules
        });
        if (requestId !== conflictRequestRef.current) return;
        setConflictCheck({
          loading: false,
          conflicts: Array.isArray(response?.conflicts) ? response.conflicts : [],
          error: ''
        });
      } catch (error) {
        if (requestId !== conflictRequestRef.current) return;
        setConflictCheck({
          loading: false,
          conflicts: [],
          error: error.body?.message || error.body?.error || error.message || 'Unable to check substitute conflicts.'
        });
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [form.original_teacher_id, form.substitute_id, selectedScheduleSignature]);

  // Handle Select / Input changes
  const handleChange = (e) => {
    const { name, value } = e.target;
    if (name === 'original_teacher_id') {
      // Clear selections when the original teacher changes
      setExpandedGroups({});
      setForm(prev => ({ ...prev, original_teacher_id: value, substitute_id: '', selectedSchedules: [] }));
    } else {
      setForm(prev => ({ ...prev, [name]: value }));
    }
  };

  // Handle Checkbox toggles for batch selection
  const handleScheduleToggle = (schedule_id, date) => {
    const schedule = availableSchedules.find(item => sameId(item.schedule_id, schedule_id) && String(item.date) === String(date));
    if (!schedule || isAssignedSchedule(schedule)) return;
    setForm(prev => {
      const isAlreadySelected = prev.selectedSchedules.some(s => String(s.schedule_id) === String(schedule_id) && String(s.date) === String(date));
      
      if (isAlreadySelected) {
        // Remove from array if unchecked
        return { 
          ...prev, 
          selectedSchedules: prev.selectedSchedules.filter(s => !(String(s.schedule_id) === String(schedule_id) && String(s.date) === String(date)))
        };
      } else {
        // Add to array if checked
        return { 
          ...prev, 
          selectedSchedules: [...prev.selectedSchedules, { schedule_id, date }]
        };
      }
    });
  };

  const handleGroupToggle = (group) => {
    const eligible = group.schedules.filter(schedule => !isAssignedSchedule(schedule));
    if (!eligible.length) return;
    setForm(prev => {
      const selectedKeys = new Set(prev.selectedSchedules.map(scheduleSelectionKey));
      const allEligibleSelected = eligible.every(schedule => selectedKeys.has(scheduleSelectionKey(schedule)));
      if (allEligibleSelected) {
        const eligibleKeys = new Set(eligible.map(scheduleSelectionKey));
        return {
          ...prev,
          selectedSchedules: prev.selectedSchedules.filter(schedule => !eligibleKeys.has(scheduleSelectionKey(schedule)))
        };
      }
      const additions = eligible
        .filter(schedule => !selectedKeys.has(scheduleSelectionKey(schedule)))
        .map(schedule => ({ schedule_id: schedule.schedule_id, date: schedule.date }));
      return { ...prev, selectedSchedules: [...prev.selectedSchedules, ...additions] };
    });
  };

  const toggleGroupExpanded = (groupKey) => {
    setExpandedGroups(prev => ({ ...prev, [groupKey]: !prev[groupKey] }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canAddSubstitution) {
      return swalFire('Not allowed', 'Only dean and department admin can add substitutions.', 'warning');
    }
    if (form.selectedSchedules.length === 0 || !form.substitute_id) {
        return swalFire('Missing Details', 'Please select a substitute and at least one class schedule.', 'warning');
    }
    if (conflictCheck.loading) {
      return swalFire('Please wait', 'The substitute schedule conflict check is still running.', 'warning');
    }
    if (conflictCheck.error) {
      return swalFire('Conflict Check Failed', conflictCheck.error, 'error');
    }
    if (conflictCheck.conflicts.length > 0) {
      return swalFire('Schedule Conflict', 'Remove the red conflicting schedules or choose another substitute teacher.', 'error');
    }

    // FRONTEND DUPLICATE CHECK
    for (const sub of form.selectedSchedules) {
      const isDuplicate = rows.some(r => String(r.schedule_id) === String(sub.schedule_id) && r.date === sub.date);
      if (isDuplicate) {
          return swalFire('Duplicate Entry', `A substitution is already scheduled for one of the selected classes on ${sub.date}.`, 'error');
      }
    }

    const substitute = substituteOptions.find(item => String(item.user_id) === String(form.substitute_id));
    const substituteName = substitute ? `${substitute.first_name || ''} ${substitute.last_name || ''}`.trim() : 'the selected substitute';
    const confirmation = window.Swal
      ? await window.Swal.fire({ title:'Save Substitutions?', text:`Assign ${substituteName} to ${form.selectedSchedules.length} selected class${form.selectedSchedules.length === 1 ? '' : 'es'}?`, icon:'question', showCancelButton:true, confirmButtonText:'Save Substitutions', confirmButtonColor:'#198754' })
      : { isConfirmed:confirm(`Save ${form.selectedSchedules.length} substitution assignment(s)?`) };
    if (!confirmation.isConfirmed) return;

    try {
      // Post the array of schedules
      const response = await apiPost('substitute', {
        original_teacher_id: form.original_teacher_id,
        substitute_id: form.substitute_id,
        substitutions: form.selectedSchedules 
      });

      if (response && response.error) {
          return swalFire('Error', response.message || 'Failed to add substitutions', 'error');
      }

      await swalFire('Success!', response.message || 'Substitutions added successfully.', 'success');
      setShowModal(false);
      setForm({ original_teacher_id: '', substitute_id: '', selectedSchedules: [] });
      setExpandedGroups({});
      fetchRows(); 

    } catch (err) {
      const errorMessage = err.body?.message || err.body?.error || err.message || 'An unexpected error occurred.';
      swalFire('Error', errorMessage, 'error');
    }
  };

  const openView = (r) => { setSelected(r); setShowModal('view'); };
  const openAdd = () => { 
    if (!canAddSubstitution) return;
    setForm({ original_teacher_id: '', substitute_id: '', selectedSchedules: [] });
    setExpandedGroups({});
    setShowModal('add'); 
  };
  const closeView = () => { setSelected(null); setShowModal(false); };

  const currentSchoolYearId = String(
    schoolYearOptions.find(year => year.status === 'active')?.id || ''
  );

  const handleSchoolYearFilterChange = (event) => {
    const schoolYearId = event.target.value;
    setFilterSchoolYear(schoolYearId);
    const matchingActiveSemester = academicSemesters.find(semester =>
      String(semester.session_id) === String(schoolYearId)
      && String(semester.status || '').toLowerCase() === 'active'
    );
    setFilterSemester(matchingActiveSemester ? String(matchingActiveSemester.semester_id) : '');
    if (schoolYearId && currentSchoolYearId && schoolYearId !== currentSchoolYearId) {
      setHistoryView('all');
    }
  };

  const clearHistoryFilters = () => {
    const activeSemester = academicSemesters.find(semester =>
      String(semester.session_id) === currentSchoolYearId
      && String(semester.status || '').toLowerCase() === 'active'
    );
    setFilterSchoolYear(currentSchoolYearId);
    setFilterSemester(activeSemester ? String(activeSemester.semester_id) : '');
    setFilterDate('');
    setFilterTeacher('');
    setFilterClass('');
  };

  return (
    <div className="mdp-page">
      <MasterPageHeader
        eyebrow="Faculty coverage"
        title="Substitution Management"
        description="Assign qualified faculty to classes covered by approved leave and review current or historical assignments."
        action={canAddSubstitution ? (
          <button onClick={openAdd} className="mdp-primary">
            <i className="bi bi-person-plus mr-2" aria-hidden="true"></i>
            Add Substitution
          </button>
        ) : null}
      />

      <MasterStats loading={loading} items={[
        { label: 'Assignments', value: substitutionStats.assignments, help: 'Substitution groups matching the view', tone: 'green', icon: <i className="bi bi-people" /> },
        { label: 'Covered Classes', value: substitutionStats.coveredClasses, help: 'Individual class sections covered', tone: 'blue', icon: <i className="bi bi-journal-check" /> },
        { label: 'Upcoming', value: substitutionStats.upcoming, help: 'Assignments scheduled today or later', tone: 'amber', icon: <i className="bi bi-clock-history" /> },
      ]} />

      <div className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 flex items-start gap-3 text-sm text-green-900">
        <div className="w-9 h-9 rounded-lg bg-white border border-green-200 flex items-center justify-center flex-none text-green-700"><i className="bi bi-shield-check" aria-hidden="true"></i></div>
        <div>
          <div className="font-bold">Approved-leave protection</div>
          <div className="text-green-800 mt-0.5">New substitutions can only use attendance dates covered by the original teacher's recorded approved leave. Schedule conflicts are checked before saving.</div>
        </div>
      </div>

      <MasterToolbar>
        <div className="w-full space-y-3">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Substitution history views">
            {[
              ['current', 'Current Semester'],
              ['upcoming', 'Upcoming'],
              ['completed', 'Completed'],
              ['all', 'All History']
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={historyView === value}
                onClick={() => setHistoryView(value)}
                className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors ${historyView === value ? 'bg-green-700 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
            <select value={filterSchoolYear} onChange={handleSchoolYearFilterChange} aria-label="School Year" title="School Year" className="w-full min-w-0 px-3 py-2 border rounded-lg text-sm bg-white">
              <option value="">All School Years</option>
              {schoolYearOptions.map(year => <option key={year.id} value={year.id}>{year.label}{year.status === 'active' ? ' (Current)' : ''}</option>)}
            </select>
            <select value={filterSemester} onChange={e=>setFilterSemester(e.target.value)} aria-label="Semester" title="Semester" className="w-full min-w-0 px-3 py-2 border rounded-lg text-sm bg-white">
              <option value="">All Semesters</option>
              {semesterOptions.map(semester => <option key={semester.id} value={semester.id}>{semester.label}</option>)}
            </select>
            <input type="date" value={filterDate} onChange={e=>setFilterDate(e.target.value)} aria-label="Substitution date" title="Date" className="w-full min-w-0 px-3 py-2 border rounded-lg text-sm bg-white" />
            <select value={filterTeacher} onChange={e=>setFilterTeacher(e.target.value)} aria-label="Teacher" className="w-full min-w-0 px-3 py-2 border rounded-lg text-sm bg-white">
              <option value="">All Teachers</option>
              {historyTeachers.map(t => (<option key={t.user_id} value={t.user_id}>{t.last_name}, {t.first_name}{String(t.status || 'active').toLowerCase() === 'active' ? '' : ' (Inactive)'}</option>))}
            </select>
            <select value={filterClass} onChange={e=>setFilterClass(e.target.value)} aria-label="Class" className="w-full min-w-0 px-3 py-2 border rounded-lg text-sm bg-white">
              <option value="">All Classes</option>
              {classOptions.map(c => (<option key={c.id} value={c.id}>{c.label}</option>))}
            </select>
            <button onClick={clearHistoryFilters} className="w-full px-3 py-2 border rounded-lg text-sm font-semibold bg-white hover:bg-gray-50">Reset Filters</button>
          </div>
        </div>
      </MasterToolbar>

      <MasterResults
        title="Substitution Registry"
        count={Number(pagination.total || 0)}
        loading={loading}
        description="Assignments matching the selected school year, semester, and history view."
      >
        <Table
          columns={columns}
          data={filteredRows}
          pageSize={10}
          serverPagination
          totalItems={Number(pagination.total || 0)}
          page={page}
          onPageChange={setPage}
          loading={loading}
          emptyText={historyView === 'current'
            ? 'No substitutions in the current active semester. Use All History to view earlier records.'
            : historyView === 'upcoming'
              ? 'No upcoming substitutions.'
              : historyView === 'completed'
                ? 'No completed substitutions match your filters.'
                : 'No substitutions match your filters.'}
          rowKey={(r, idx) => r.group_id ?? `${r.schedule_id}-${r.date}-${idx}`}
        />
      </MasterResults>

      {/* VIEW MODAL */}
      <Modal show={showModal === 'view'} title={selected ? `${selected.teacher_first || ''} ${selected.teacher_last || ''} — Substitution` : 'Substitution Details'} onClose={closeView} size="md">
        <div className="rounded-lg bg-white shadow-lg p-4">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-lg">{selected ? (selected.teacher_first || '').charAt(0) : ''}</div>
              <div>
                <div className="text-lg font-semibold">{selected ? `${selected.teacher_first || ''} ${selected.teacher_last || ''}` : '—'}</div>
                <div className="text-sm text-gray-500">{selected?.dept_name || '—'}</div>
              </div>
            </div>
            <div className="text-right">
              {selected && (
                <div className={`inline-block px-3 py-1 rounded-full text-sm font-semibold ${selected.history_status === 'upcoming' ? 'bg-green-100 text-green-800' : selected.history_status === 'today' ? 'bg-blue-100 text-blue-800' : 'bg-gray-200 text-gray-700'}`}>
                  {selected.history_status === 'upcoming' ? 'UPCOMING' : selected.history_status === 'today' ? 'TODAY' : 'COMPLETED'}
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-3">
              <div className="bg-gray-50 p-3 rounded-lg"><div className="text-xs text-gray-500">Date and Time</div><div className="font-medium">{selected ? `${selected.date} | ${formatTime12(selected.start_time)} - ${formatTime12(selected.end_time)}` : '—'}</div></div>
              <div className="bg-gray-50 p-3 rounded-lg"><div className="text-xs text-gray-500">Class</div><div className="font-medium">{selected ? `${selected.subject_code || selected.subject_name || 'Class'}${selected.section_count > 1 ? ` - ${selected.section_count} parallel sections` : selected.section_name ? ` - ${selected.section_name}` : ''}` : '—'}</div></div>
              <div className="bg-gray-50 p-3 rounded-lg"><div className="text-xs text-gray-500">Semester</div><div className="font-medium">{selected ? semesterLabel(selected) : '—'}</div></div>
            </div>
            <div className="space-y-3">
              <div className="bg-gray-50 p-3 rounded-lg"><div className="text-xs text-gray-500">Original Teacher</div><div className="font-medium">{selected ? `${selected.teacher_first || ''} ${selected.teacher_last || ''}` : '—'}</div></div>
              <div className="bg-gray-50 p-3 rounded-lg"><div className="text-xs text-gray-500">Substitute</div><div className="font-medium">{selected ? `${selected.sub_first || ''} ${selected.sub_last || ''}` : '—'}</div></div>
              <div className={`p-3 rounded-lg border ${selected?.leave_id ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
                <div className="text-xs text-gray-500">Approved Leave Coverage</div>
                {selected?.leave_id ? (
                  <div>
                    <div className="font-medium text-green-900">{selected.leave_type || 'Approved leave'}</div>
                    <div className="text-sm text-green-800">{selected.leave_date_from} to {selected.leave_date_to}</div>
                    {String(selected.leave_status || '').toLowerCase() === 'void' && (
                      <div className="mt-1 text-xs font-bold text-red-700">This leave was later cancelled and requires administrative review.</div>
                    )}
                  </div>
                ) : (
                  <div className="text-sm font-medium text-amber-800">Legacy substitution — no linked leave record.</div>
                )}
              </div>
            </div>
          </div>

          {selected?.records?.length > 0 && (
            <div className="mt-4">
              <div className="text-sm font-semibold text-gray-700 mb-2">Sections and Rooms</div>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {selected.records.map(record => (
                  <div key={record.substitution_id} className="flex justify-between gap-3 p-2 border rounded bg-gray-50 text-sm">
                    <span className="font-medium">{record.section_name || 'Section not specified'}</span>
                    <span className="text-gray-600">{record.room_name || 'Room not specified'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <button onClick={closeView} className="px-4 py-2 rounded border">Close</button>
          </div>
        </div>
      </Modal>

      {/* ADD MODAL */}
      <Modal show={canAddSubstitution && showModal === 'add'} title="Add New Substitution" onClose={closeView} size="md">
        <form onSubmit={handleSubmit} className="space-y-4">
          
          {/* 1. Original Teacher */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Original Teacher</label>
            <select name="original_teacher_id" value={form.original_teacher_id} onChange={handleChange} className="w-full border rounded px-3 py-2">
              <option value="">
                {eligibleLeaveTeachers.length === 0 ? 'No approved leave has eligible classes this week' : '-- Select Teacher on Approved Leave --'}
              </option>
              {eligibleLeaveTeachers.map(t => (
                <option key={t.user_id} value={t.user_id}>{t.last_name}, {t.first_name} — {t.leave_periods}</option>
              ))}
            </select>
            <div className="mt-1 text-xs text-gray-500">Only teachers with an approved leave and eligible attendance records in the current 7-day window are listed.</div>
          </div>

          {/* 2. Schedule Checklist (Batch Selection) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Select Classes to Substitute</label>
            
            {!form.original_teacher_id ? (
              <div className="p-3 bg-gray-50 border rounded text-sm text-gray-500 text-center">
                Select an original teacher to view their classes.
              </div>
            ) : availableSchedules.length === 0 ? (
              availableLoading ? (
                <div className="bg-gray-50 border rounded"><LoadingState label="Loading available classes..." compact /></div>
              ) : (
                <div className="p-3 bg-gray-50 border rounded text-sm text-gray-500 text-center">
                  No upcoming attendance records are covered by this teacher's approved leave in the current 7-day window.
                </div>
              )
            ) : (
              <div className="border rounded max-h-80 overflow-y-auto bg-gray-50 p-2 space-y-3">
                {availableScheduleGroups.map(group => {
                  const first = group.schedules[0];
                  const assignedSchedules = group.schedules.filter(isAssignedSchedule);
                  const eligibleSchedules = group.schedules.filter(schedule => !isAssignedSchedule(schedule));
                  const selectedEligibleCount = eligibleSchedules.filter(schedule => selectedScheduleKeys.has(scheduleSelectionKey(schedule))).length;
                  const allAssigned = assignedSchedules.length === group.schedules.length;
                  const allEligibleSelected = eligibleSchedules.length > 0 && selectedEligibleCount === eligibleSchedules.length;
                  const groupChecked = allAssigned || allEligibleSelected;
                  const groupIndeterminate = !groupChecked && (assignedSchedules.length > 0 || selectedEligibleCount > 0);
                  const isParallel = group.schedules.length > 1;
                  const groupHasConflict = group.schedules.some(schedule => conflictedScheduleKeys.has(scheduleSelectionKey(schedule)));
                  const isExpanded = !isParallel || Boolean(expandedGroups[group.key]) || groupHasConflict;
                  const groupStyle = allAssigned
                    ? 'border-violet-400 bg-violet-50'
                    : groupHasConflict
                      ? 'border-red-500 bg-red-50'
                    : assignedSchedules.length > 0
                      ? 'border-violet-300 bg-white'
                      : selectedEligibleCount > 0
                        ? 'border-green-300 bg-green-50'
                        : 'border-gray-200 bg-white';

                  return (
                    <div key={group.key} className={`border rounded-lg overflow-hidden transition-colors ${groupStyle}`}>
                      <div className="flex items-start gap-3 p-3">
                        <SelectionCheckbox
                          className="mt-1 w-4 h-4 text-green-600 rounded focus:ring-green-500 disabled:cursor-not-allowed"
                          checked={groupChecked}
                          indeterminate={groupIndeterminate}
                          disabled={eligibleSchedules.length === 0}
                          onChange={() => handleGroupToggle(group)}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2 flex-wrap">
                            <div>
                              <div className="font-semibold text-sm text-gray-900">
                                {first.subject_code || first.subject_name || 'Class'}
                                {isParallel ? ` - ${group.schedules.length} parallel sections` : (first.section_name ? ` - ${first.section_name}` : '')}
                              </div>
                              <div className="text-xs text-gray-600 mt-0.5">
                                {first.date} | {formatTime12(first.start_time)} - {formatTime12(first.end_time)}
                              </div>
                              <div className="text-xs font-semibold text-green-700 mt-1">
                                {first.leave_type || 'Approved leave'}: {first.leave_date_from} to {first.leave_date_to}
                              </div>
                            </div>
                            {assignedSchedules.length > 0 && (
                              <span className="px-2 py-1 rounded-full bg-violet-600 text-white text-[10px] font-bold tracking-wide">
                                {allAssigned ? 'SUBSTITUTED' : `${assignedSchedules.length} OF ${group.schedules.length} SUBSTITUTED`}
                              </span>
                            )}
                            {groupHasConflict && (
                              <span className="px-2 py-1 rounded-full bg-red-600 text-white text-[10px] font-bold tracking-wide">
                                CONFLICT
                              </span>
                            )}
                          </div>
                          {isParallel && (
                            <button
                              type="button"
                              onClick={() => toggleGroupExpanded(group.key)}
                              disabled={groupHasConflict}
                              className="mt-2 text-xs font-semibold text-indigo-700 hover:text-indigo-900 disabled:text-red-700 disabled:cursor-default"
                            >
                              {groupHasConflict ? 'Conflicting sections shown' : isExpanded ? 'Hide sections' : 'View and choose sections'}
                            </button>
                          )}
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="border-t border-gray-200 p-2 space-y-2 bg-gray-50/70">
                          {group.schedules.map(schedule => {
                            const assigned = isAssignedSchedule(schedule);
                            const selectedForSave = selectedScheduleKeys.has(scheduleSelectionKey(schedule));
                            const hasConflict = conflictedScheduleKeys.has(scheduleSelectionKey(schedule));
                            const checked = assigned || selectedForSave;
                            const substituteName = [schedule.substitute_first_name, schedule.substitute_last_name].filter(Boolean).join(' ');
                            return (
                              <label
                                key={scheduleSelectionKey(schedule)}
                                className={`flex items-start gap-3 p-2 border rounded transition-colors ${assigned ? 'bg-violet-50 border-violet-300 cursor-not-allowed' : hasConflict ? 'bg-red-50 border-red-500 cursor-pointer' : selectedForSave ? 'bg-green-50 border-green-300 cursor-pointer' : 'bg-white border-gray-200 hover:bg-gray-50 cursor-pointer'}`}
                              >
                                <input
                                  type="checkbox"
                                  className="mt-1 w-4 h-4 text-green-600 rounded focus:ring-green-500 disabled:cursor-not-allowed"
                                  checked={checked}
                                  disabled={assigned}
                                  onChange={() => handleScheduleToggle(schedule.schedule_id, schedule.date)}
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium text-sm text-gray-800">
                                    {schedule.section_name || 'Section not specified'}{schedule.room_name ? ` | ${schedule.room_name}` : ''}
                                  </div>
                                  <div className={`text-xs mt-0.5 font-semibold ${assigned ? 'text-violet-700' : hasConflict ? 'text-red-700' : 'text-green-700'}`}>
                                    {assigned ? `Substituted${substituteName ? ` by ${substituteName}` : ''}` : hasConflict ? 'Schedule conflict - see details below' : `Attendance date: ${schedule.date}`}
                                  </div>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {form.selectedSchedules.length > 0 && (
              <div className="mt-2 text-xs font-semibold text-green-700">
                {form.selectedSchedules.length} attendance {form.selectedSchedules.length === 1 ? 'record' : 'records'} selected for substitution.
              </div>
            )}
          </div>

          {/* 3. Substitute Teacher */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Substitute Teacher</label>
            <select name="substitute_id" value={form.substitute_id} onChange={handleChange} className="w-full border rounded px-3 py-2" required>
              <option value="">-- Select Substitute --</option>
              {substituteOptions.map(teacher => {
                const candidate = candidateByUserId.get(String(teacher.user_id));
                const firstConflict = candidate?.conflicts?.[0];
                const conflictTime = firstConflict
                  ? `${formatTime12(firstConflict.conflict_start_time)}-${formatTime12(firstConflict.conflict_end_time)}`
                  : '';
                const availabilityLabel = candidateCheck.loading
                  ? ' - Checking availability...'
                  : candidate
                    ? candidate.available
                      ? ' - Available'
                      : ` - Conflict${conflictTime ? ` ${conflictTime}` : ''}`
                    : '';
                return (
                  <option key={teacher.user_id} value={teacher.user_id} disabled={Boolean(candidate && !candidate.available)}>
                    {teacher.last_name}, {teacher.first_name}{availabilityLabel}
                  </option>
                );
              })}
            </select>
            {candidateCheck.loading && form.selectedSchedules.length > 0 && (
              <div className="mt-2 text-xs font-semibold text-amber-700">Checking all substitute teachers for availability...</div>
            )}
            {candidateCheck.error && (
              <div className="mt-2 text-xs font-semibold text-amber-700">
                Availability list could not be loaded. The selected teacher will still receive a final conflict check.
              </div>
            )}
            {!candidateCheck.loading && !candidateCheck.error && candidateCheck.candidates.length > 0 && (
              <div className="mt-2 text-xs font-semibold text-green-700">
                {candidateCheck.candidates.filter(candidate => candidate.available).length} available teacher{candidateCheck.candidates.filter(candidate => candidate.available).length === 1 ? '' : 's'} shown first; conflicting teachers are disabled.
              </div>
            )}
            {conflictCheck.loading && (
              <div className="mt-2 p-3 border border-amber-300 bg-amber-50 text-amber-800 rounded text-sm font-medium">
                Checking the substitute teacher's schedule...
              </div>
            )}
            {conflictCheck.error && (
              <div className="mt-2 p-3 border border-red-400 bg-red-50 text-red-800 rounded text-sm font-medium">
                Conflict check failed: {conflictCheck.error}
              </div>
            )}
            {!conflictCheck.loading && !conflictCheck.error && conflictCheck.conflicts.length > 0 && (
              <div className="mt-2 p-3 border border-red-400 bg-red-50 rounded">
                <div className="text-sm font-bold text-red-800 mb-2">
                  Substitute schedule conflict{conflictCheck.conflicts.length === 1 ? '' : 's'}
                </div>
                <div className="space-y-2">
                  {conflictCheck.conflicts.map((conflict, index) => {
                    const selectedSchedule = availableSchedules.find(schedule =>
                      sameId(schedule.schedule_id, conflict.selected_schedule_id)
                      && String(schedule.date) === String(conflict.selected_date)
                    );
                    const selectedLabel = selectedSchedule
                      ? `${selectedSchedule.subject_code || selectedSchedule.subject_name || 'Selected class'}${selectedSchedule.section_name ? ` - ${selectedSchedule.section_name}` : ''}`
                      : `${conflict.selected_subject_code || 'Selected class'}${conflict.selected_section_name ? ` - ${conflict.selected_section_name}` : ''}`;
                    const conflictLabel = `${conflict.conflict_subject_code || conflict.conflict_subject_name || 'Conflicting class'}${conflict.conflict_section_name ? ` - ${conflict.conflict_section_name}` : ''}`;
                    return (
                      <div key={`${conflict.selected_schedule_id}-${conflict.conflict_schedule_id}-${index}`} className="p-2 bg-white border border-red-200 rounded text-xs text-red-800">
                        <div className="font-semibold">{selectedLabel}</div>
                        <div className="mt-1">
                          Conflicts with {conflictLabel} ({formatTime12(conflict.conflict_start_time)} - {formatTime12(conflict.conflict_end_time)})
                          {conflict.conflict_room_name ? ` in ${conflict.conflict_room_name}` : ''}.
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="text-xs text-red-700 font-semibold mt-2">
                  Remove the red schedule or choose another substitute teacher.
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end pt-3">
            <button type="button" onClick={closeView} className="px-4 py-2 border rounded mr-2">Cancel</button>
            <button
              type="submit"
              disabled={hasConflictBlock || form.selectedSchedules.length === 0 || !form.substitute_id}
              className="px-4 py-2 bg-green-600 text-white rounded disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              {conflictCheck.loading ? 'Checking Conflicts...' : 'Save Substitutions'}
            </button>
          </div>

        </form>
      </Modal>
    </div>
  );
}
