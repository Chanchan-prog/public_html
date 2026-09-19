import React from 'react';
import Modal from '../../components/Modal.jsx';
import { apiGet, apiPost } from '../../services/api.js';
import { AuthContext } from '../../context/AuthContext.jsx';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';

const getUserIdValue = (userLike) => {
  const id = userLike?.user_id ?? userLike?.id ?? userLike?.userId ?? 0;
  const n = Number(id);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const getStoredUser = () => {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null');
  } catch (e) {
    return null;
  }
};

const toDateKeyFromDate = (dateObj) => {
  if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) return '';
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const normalizeDateKey = (value) => {
  if (value === undefined || value === null || value === '') return '';
  if (value instanceof Date) return toDateKeyFromDate(value);
  const raw = String(value).trim();
  const direct = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (direct) return `${direct[1]}-${direct[2]}-${direct[3]}`;
  const parsed = new Date(raw.replace(' ', 'T'));
  return toDateKeyFromDate(parsed);
};

const getPayloadList = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.items)) return payload.items;
  return null;
};

const getAttendanceDateKey = (record) => normalizeDateKey(
  record?.date || record?.attendance_date || record?.checked_in_at || record?.time_in
);

const normalizeAttendanceRecord = (record) => {
  const date = getAttendanceDateKey(record);
  return {
    ...record,
    date,
    user_id: getUserIdValue(record),
    time_in: record?.time_in ?? record?.checked_in_at ?? null,
    time_check: record?.time_check ?? record?.checked_mid_at ?? null,
    time_out: record?.time_out ?? record?.checked_out_at ?? null,
    subject_code: record?.subject_code || record?.subject || record?.subject_name || 'Class',
    subject_name: record?.subject_name || record?.subject_code || 'Scheduled class'
  };
};

const dateMatches = (value, dateKey) => normalizeDateKey(value) === dateKey;

const ATTENDANCE_STATUS_OPTIONS = [[2, 'Present'], [5, 'Late'], [3, 'Absent'], [0, 'Partial Attendance'], [1, 'Upcoming'], [8, 'Pending'], [4, 'Substituted'], [7, 'On Leave']];
const ACTIVITY_OPTIONS = [['attendance', 'Attendance'], ['leaves', 'Leaves'], ['substitutions', 'Substitutions'], ['penalties', 'Penalties']];

const isSemesterActiveNow = (semester) => {
  if (String(semester?.status || '').toLowerCase() !== 'active') return false;
  const today = toDateKeyFromDate(new Date());
  const start = normalizeDateKey(semester?.start_date);
  const end = normalizeDateKey(semester?.end_date);
  return Boolean(start && end && today >= start && today <= end);
};

const getMonthBounds = (dateObj) => {
  const year = dateObj.getFullYear();
  const month = dateObj.getMonth();
  return {
    from: toDateKeyFromDate(new Date(year, month, 1)),
    to: toDateKeyFromDate(new Date(year, month + 1, 0))
  };
};

const isCurrentCalendarMonth = (dateObj) => {
  const now = new Date();
  return dateObj.getFullYear() === now.getFullYear() && dateObj.getMonth() === now.getMonth();
};

export default function AttendanceHistory() {
  const { user } = React.useContext(AuthContext);
  const storedUser = React.useMemo(() => getStoredUser(), [user]);
  const effectiveUser = React.useMemo(() => (
    getUserIdValue(user) ? user : storedUser
  ), [user, storedUser]);
  const myUserId = getUserIdValue(effectiveUser);
  const effectiveRoleId = Number(effectiveUser?.role_id || 0);
  const canRequestEdit = [2, 3, 4, 5].includes(Number(effectiveUser?.role_id));
  const requestSelectionMode = React.useMemo(() => {
    const hash = typeof window !== 'undefined' ? String(window.location.hash || '') : '';
    const queryIndex = hash.indexOf('?');
    return queryIndex >= 0 && new URLSearchParams(hash.slice(queryIndex + 1)).get('request_edit') === '1';
  }, []);
  const [records, setRecords] = React.useState([]);
  const [penalties, setPenalties] = React.useState([]);
  const [substitutions, setSubstitutions] = React.useState([]);
  const [leaves, setLeaves] = React.useState([]);
  const [noClassRecords, setNoClassRecords] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [fetchError, setFetchError] = React.useState('');
  const [semesters, setSemesters] = React.useState([]);
  const [selectedSemesterId, setSelectedSemesterId] = React.useState('');
  const [selectedStatuses, setSelectedStatuses] = React.useState([]);
  const [selectedSubjectId, setSelectedSubjectId] = React.useState('');
  const [recordSearch, setRecordSearch] = React.useState('');
  const [substitutionDirection, setSubstitutionDirection] = React.useState('all');
  const [filtersMinimized, setFiltersMinimized] = React.useState(false);
  const [activityVisibility, setActivityVisibility] = React.useState({
    attendance: true,
    leaves: true,
    substitutions: true,
    penalties: true
  });
  
  // Calendar State
  const [currentDate, setCurrentDate] = React.useState(new Date()); 
  const [selectedDayRecords, setSelectedDayRecords] = React.useState(null); 
  const [showModal, setShowModal] = React.useState(false);
  const [showAttendanceEditModal, setShowAttendanceEditModal] = React.useState(false);
  const [selectedAttendanceForEdit, setSelectedAttendanceForEdit] = React.useState(null);
  const [attendanceEditReason, setAttendanceEditReason] = React.useState('');
  const [attendanceEditSubmitting, setAttendanceEditSubmitting] = React.useState(false);
  const [attendanceEditError, setAttendanceEditError] = React.useState('');
  const [pendingAttendanceEditIds, setPendingAttendanceEditIds] = React.useState([]);
  
  // Live Clock State
  const [currentTime, setCurrentTime] = React.useState(new Date());

  // UPDATED MAP BASED ON YOUR DATABASE
  const flagMap = {
    0: 'Partial Attendance',
    1: 'Upcoming',
    2: 'Present',
    3: 'Absent',
    4: 'Substituted',
    5: 'Late',
    7: 'On Leave',
    8: 'Pending'
  };

  // Normalize flag value based on actual DB IDs
  const getFlagId = (v) => {
    if (v === undefined || v === null || v === '') return 1; // default Upcoming
    const n = Number(v);
    if (!isNaN(n) && [1, 2, 3, 4, 5, 7, 8].includes(n)) return n;
    const s = String(v).toLowerCase().trim();
    if (s === 'na' || s === 'n/a' || s === 'upcoming' || s === '1') return 1;
    if (s === 'present' || s === '2') return 2;
    if (s === 'absent' || s === '3') return 3;
    if (s === 'substituted' || s === '4') return 4;
    if (s === 'late' || s === '5') return 5;
    if (s === 'on leave' || s === '7') return 7;
    if (s === 'pending' || s === '8') return 8;
    return 1; // default to Upcoming
  };

  // --- NEW STRICT OVERALL STATUS LOGIC ---
  const getOverallStatus = (r) => {
    const fIn = getFlagId(r.flag_in_id);
    const fMid = getFlagId(r.flag_check_id);
    const fOut = getFlagId(r.flag_out_id);
    const flags = [fIn, fMid, fOut];

    // Match the system-wide overall rule: a two-checkpoint majority wins.
    // Three different checkpoint results are Partial Attendance (ID 0).
    const counts = flags.reduce((result, flagId) => {
      result[flagId] = (result[flagId] || 0) + 1;
      return result;
    }, {});
    const majority = Object.entries(counts).find(([, count]) => count >= 2);
    return majority ? Number(majority[0]) : 0;
  };

  const isAttendanceFullyPresent = (record) => (
    getFlagId(record?.flag_in_id) === 2
    && getFlagId(record?.flag_check_id) === 2
    && getFlagId(record?.flag_out_id) === 2
  );

  // 1. Fetch all data simultaneously (added 'silent' parameter for auto-refresh)
  const fetchRecords = React.useCallback(async (silent = false) => {
    if (!myUserId) return;
    if (!silent) setLoading(true);
    setFetchError('');
    try {
      const monthBounds = getMonthBounds(currentDate);
      const scopedSemester = semesters.find((semester) => String(semester.semester_id) === String(selectedSemesterId));
      const semesterFrom = normalizeDateKey(scopedSemester?.start_date);
      const semesterTo = normalizeDateKey(scopedSemester?.end_date);
      // Fetch only the month currently visible in the calendar. When a
      // semester is selected, clip the first/last month to its exact dates.
      const from = selectedSemesterId && semesterFrom && semesterFrom > monthBounds.from
        ? semesterFrom
        : monthBounds.from;
      const to = selectedSemesterId && semesterTo && semesterTo < monthBounds.to
        ? semesterTo
        : monthBounds.to;
      const commonParams = new URLSearchParams({ date_from: from, date_to: to });
      if (selectedSemesterId) commonParams.set('semester_id', selectedSemesterId);
      const attendanceParams = new URLSearchParams(commonParams);
      attendanceParams.set('teacher_id', myUserId);

      const readOptionalList = async (path, label, shouldFetch = true) => {
        if (!shouldFetch) return [];
        try {
          const payload = await apiGet(path);
          return getPayloadList(payload) || [];
        } catch (err) {
          if (err?.status !== 403) {
            console.warn(`Could not fetch ${label}:`, err);
          }
          return [];
        }
      };

      const canFetchSubstitutions = [2, 3, 4, 5].includes(effectiveRoleId);
      const canFetchLeaves = [1, 2, 3, 4, 5].includes(effectiveRoleId);
      const rangeQuery = commonParams.toString();
      const [attData, penRows, subRows, leaveRows, noClassRows] = await Promise.all([
        apiGet(`attendance?${attendanceParams.toString()}`),
        readOptionalList(`penalties?${rangeQuery}`, 'penalties'),
        readOptionalList(`substitute?${rangeQuery}`, 'substitutions', canFetchSubstitutions),
        readOptionalList(`leaves?date_from=${encodeURIComponent(from)}&date_to=${encodeURIComponent(to)}`, 'leaves', canFetchLeaves),
        readOptionalList(`calendar-events/occurrences?${attendanceParams.toString()}`, 'no-class calendar entries', canFetchSubstitutions)
      ]);

      const attRows = getPayloadList(attData);
      setRecords(attRows ? attRows.map(normalizeAttendanceRecord).filter((r) => r.date) : []);
      setPenalties(penRows);
      setSubstitutions(subRows);
      setLeaves(leaveRows);
      setNoClassRecords(noClassRows);
    } catch (e) {
      console.error("Error fetching attendance history:", e);
      setFetchError(e?.body?.message || e?.message || 'Attendance calendar data could not be loaded.');
      if (!silent) {
        setRecords([]);
        setPenalties([]);
        setSubstitutions([]);
        setLeaves([]);
        setNoClassRecords([]);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [currentDate, effectiveRoleId, myUserId, selectedSemesterId, semesters]);

  const fetchPendingAttendanceRequests = React.useCallback(async () => {
    if (!canRequestEdit) {
      setPendingAttendanceEditIds([]);
      return;
    }
    try {
      const data = await apiGet('request-edit/attendance?scope=my&status=pending');
      const ids = Array.isArray(data)
        ? data
          .map((row) => Number(row?.attendance_id))
          .filter((id) => Number.isFinite(id) && id > 0)
        : [];
      setPendingAttendanceEditIds(ids);
    } catch (e) {
      console.error('Failed to fetch pending attendance edit requests:', e);
    }
  }, [canRequestEdit]);

  React.useEffect(() => {
    let active = true;
    apiGet('semesters')
      .then((payload) => {
        if (!active) return;
        const rows = getPayloadList(payload) || [];
        const currentSemester = rows.find(isSemesterActiveNow) || null;
        setSemesters(rows);
        if (currentSemester?.semester_id) {
          setSelectedSemesterId(String(currentSemester.semester_id));
          setCurrentDate(new Date());
        }
      })
      .catch((e) => console.warn('Could not fetch semesters:', e));
    return () => { active = false; };
  }, []);

  // Reload when the displayed month or selected semester changes.
  React.useEffect(() => {
    fetchRecords(false);
  }, [fetchRecords]);

  useAutoRefresh({
    refresh: async () => {
      await Promise.all([fetchRecords(true), fetchPendingAttendanceRequests()]);
    },
    intervalMs: AUTO_REFRESH_INTERVALS.LIVE,
    enabled: Boolean(myUserId) && isCurrentCalendarMonth(currentDate) && !showModal && !showAttendanceEditModal,
  });

  React.useEffect(() => {
    fetchPendingAttendanceRequests();
  }, [fetchPendingAttendanceRequests]);

  // LIVE CLOCK INTERVAL
  React.useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // --- DATE & DATA HELPERS ---
  const toYMD = (dateObj) => {
      return toDateKeyFromDate(dateObj);
  };

  const isSameMonthKey = (dateKey, d2) => {
      if (!dateKey) return false;
      return dateKey.substring(0, 7) === `${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, '0')}`;
  };

  const isDateInLeaveRange = (targetDateStr, leaveFromStr, leaveToStr) => {
      if (!leaveFromStr || !leaveToStr) return false;
      const fromDateOnly = normalizeDateKey(leaveFromStr);
      const toDateOnly = normalizeDateKey(leaveToStr);
      if (!fromDateOnly || !toDateOnly) return false;
      return targetDateStr >= fromDateOnly && targetDateStr <= toDateOnly;
  };

  const isLeaveOverlappingMonth = (leaveFromStr, leaveToStr, monthDate) => {
      const fromDateOnly = normalizeDateKey(leaveFromStr);
      const toDateOnly = normalizeDateKey(leaveToStr);
      if (!fromDateOnly || !toDateOnly) return false;
      const year = monthDate.getFullYear();
      const month = monthDate.getMonth();
      const monthStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      const monthEnd = toDateKeyFromDate(new Date(year, month + 1, 0));
      return fromDateOnly <= monthEnd && toDateOnly >= monthStart;
  };

  const myPenalties = penalties.filter(p => Number(p.user_id) === myUserId);
  const mySubs = substitutions.filter(s => Number(s.teacher_id) === myUserId || Number(s.substitute_id) === myUserId);
  const myLeaves = leaves.filter(l => {
      const isMine = Number(l.teacher_id) === myUserId;
      const status = String(l.req_status || '').toLowerCase();
      return isMine && (status === 'approved' || status === 'approve');
  });

  const currentMonthStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;

  const activeSemester = semesters.find(isSemesterActiveNow) || null;
  const selectedSemester = semesters.find((semester) => String(semester.semester_id) === String(selectedSemesterId));
  const semesterStart = normalizeDateKey(selectedSemester?.start_date);
  const semesterEnd = normalizeDateKey(selectedSemester?.end_date);
  const isInsideSelectedSemester = (dateKey) => {
    if (!selectedSemesterId || !dateKey) return true;
    return (!semesterStart || dateKey >= semesterStart) && (!semesterEnd || dateKey <= semesterEnd);
  };
  const normalizedSearch = recordSearch.trim().toLowerCase();
  const matchesRecordSearch = (row) => {
    if (!normalizedSearch) return true;
    return [row?.section_name, row?.room_name]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalizedSearch));
  };
  const matchesSubject = (row) => !selectedSubjectId || String(row?.subject_id || '') === String(selectedSubjectId);
  const matchesSubstitutionDirection = (row) => {
    if (substitutionDirection === 'for_me') return Number(row.teacher_id) === myUserId;
    if (substitutionDirection === 'covered') return Number(row.substitute_id) === myUserId;
    return true;
  };

  const subjectOptions = Array.from(new Map(
    [...records, ...noClassRecords, ...mySubs]
      .filter((row) => row?.subject_id)
      .map((row) => [String(row.subject_id), {
        id: String(row.subject_id),
        label: [row.subject_code, row.subject_name].filter(Boolean).join(' - ') || `Subject ${row.subject_id}`
      }])
  ).values()).sort((a, b) => a.label.localeCompare(b.label));

  const visibleRecords = activityVisibility.attendance
    ? records.filter((r) => {
        const dateKey = getAttendanceDateKey(r);
        return isSameMonthKey(dateKey, currentDate)
          && isInsideSelectedSemester(dateKey)
          && (selectedStatuses.length === 0 || selectedStatuses.includes(getOverallStatus(r)))
          && matchesSubject(r)
          && matchesRecordSearch(r);
      })
    : [];
  const visibleNoClassRecords = activityVisibility.attendance && selectedStatuses.length === 0
    ? noClassRecords.filter((r) => {
        const dateKey = normalizeDateKey(r.date);
        return isSameMonthKey(dateKey, currentDate)
          && isInsideSelectedSemester(dateKey)
          && matchesSubject(r)
          && matchesRecordSearch(r);
      })
    : [];
  const visiblePenalties = activityVisibility.penalties
    ? myPenalties.filter((p) => {
        const dateKey = normalizeDateKey(p.date);
        return dateKey.startsWith(currentMonthStr) && isInsideSelectedSemester(dateKey);
      })
    : [];
  const visibleSubs = activityVisibility.substitutions
    ? mySubs.filter((s) => {
        const dateKey = normalizeDateKey(s.date);
        return dateKey.startsWith(currentMonthStr)
          && isInsideSelectedSemester(dateKey)
          && matchesSubject(s)
          && matchesRecordSearch(s)
          && matchesSubstitutionDirection(s);
      })
    : [];
  const visibleLeaves = activityVisibility.leaves
    ? myLeaves.filter((l) => {
        if (!isLeaveOverlappingMonth(l.date_from, l.date_to, currentDate)) return false;
        if (!selectedSemesterId) return true;
        const leaveFrom = normalizeDateKey(l.date_from);
        const leaveTo = normalizeDateKey(l.date_to);
        return (!semesterEnd || leaveFrom <= semesterEnd) && (!semesterStart || leaveTo >= semesterStart);
      })
    : [];

  // The green summary cards cover the whole selected semester. When "All semesters"
  // is selected, the fetched scope remains the displayed calendar month.
  const summaryRecords = activityVisibility.attendance
    ? records.filter((record) => {
        const dateKey = getAttendanceDateKey(record);
        return isInsideSelectedSemester(dateKey)
          && (selectedStatuses.length === 0 || selectedStatuses.includes(getOverallStatus(record)))
          && matchesSubject(record)
          && matchesRecordSearch(record);
      })
    : [];
  const totalClasses = summaryRecords.length;
  const presentCount = summaryRecords.filter(r => getOverallStatus(r) === 2).length;
  const lateCount = summaryRecords.filter(r => getOverallStatus(r) === 5).length;
  const absentCount = summaryRecords.filter(r => getOverallStatus(r) === 3).length;
  const partialCount = summaryRecords.filter(r => getOverallStatus(r) === 0).length;
  const upcomingCount = summaryRecords.filter(r => getOverallStatus(r) === 1).length;
  const pendingCount = summaryRecords.filter(r => getOverallStatus(r) === 8).length;
  const substitutedCount = summaryRecords.filter(r => getOverallStatus(r) === 4).length;
  const onLeaveCount = summaryRecords.filter(r => getOverallStatus(r) === 7).length;
  const completedCount = presentCount + lateCount + absentCount + partialCount;
  
  const substitutionsCount = visibleSubs.length;
  const substitutedForMeCount = visibleSubs.filter((s) => Number(s.teacher_id) === myUserId).length;
  const classesCoveredCount = visibleSubs.filter((s) => Number(s.substitute_id) === myUserId).length;
  const penaltiesCount = visiblePenalties.length;
  const leavesCount = visibleLeaves.length; 

  const finalizedRate = totalClasses > 0 ? Math.round((completedCount / totalClasses) * 100) : 0;
  
  const getBarHeight = (count) => {
    if (totalClasses === 0 || count === 0) return '4px';
    const pct = (count / totalClasses) * 100;
    return Math.max(12, pct) + '%';
  };

  const statusChartData = [
    { id: 2, label: 'Present', shortLabel: 'P', count: presentCount, color: '#16a34a' },
    { id: 5, label: 'Late', shortLabel: 'L', count: lateCount, color: '#f59e0b' },
    { id: 3, label: 'Absent', shortLabel: 'A', count: absentCount, color: '#dc2626' },
    { id: 0, label: 'Partial Attendance', shortLabel: 'PA', count: partialCount, color: '#8b5cf6' },
    { id: 8, label: 'Pending', shortLabel: 'PN', count: pendingCount, color: '#f97316' },
    { id: 1, label: 'Upcoming', shortLabel: 'U', count: upcomingCount, color: '#64748b' },
    { id: 4, label: 'Substituted', shortLabel: 'S', count: substitutedCount, color: '#4f46e5' },
    { id: 7, label: 'On Leave', shortLabel: 'OL', count: onLeaveCount, color: '#0891b2' },
  ];

  const getDaysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();
  const getFirstDayOfMonth = (year, month) => new Date(year, month, 1).getDay();
  const changeMonth = (offset) => {
    let target = new Date(currentDate.getFullYear(), currentDate.getMonth() + offset, 1);
    if (selectedSemesterId) {
      const firstAllowed = semesterStart ? new Date(`${semesterStart}T00:00:00`) : null;
      const lastAllowed = semesterEnd ? new Date(`${semesterEnd}T00:00:00`) : null;
      if (firstAllowed && target < new Date(firstAllowed.getFullYear(), firstAllowed.getMonth(), 1)) {
        target = new Date(firstAllowed.getFullYear(), firstAllowed.getMonth(), 1);
      }
      if (lastAllowed && target > new Date(lastAllowed.getFullYear(), lastAllowed.getMonth(), 1)) {
        target = new Date(lastAllowed.getFullYear(), lastAllowed.getMonth(), 1);
      }
    }
    setCurrentDate(target);
  };
  const jumpToToday = () => {
    const today = new Date();
    const todayKey = toDateKeyFromDate(today);
    if (!selectedSemesterId || isInsideSelectedSemester(todayKey)) {
      setCurrentDate(today);
      return;
    }
    const boundaryKey = semesterStart || semesterEnd;
    if (!boundaryKey) return;
    const [year, month] = boundaryKey.split('-').map(Number);
    setCurrentDate(new Date(year, month - 1, 1));
  };

  const handleSemesterChange = (event) => {
    const value = event.target.value;
    setSelectedSemesterId(value);
    if (!value) return;
    const semester = semesters.find((item) => String(item.semester_id) === String(value));
    const startKey = normalizeDateKey(semester?.start_date);
    const endKey = normalizeDateKey(semester?.end_date);
    const todayKey = toDateKeyFromDate(new Date());
    const targetKey = startKey && endKey && todayKey >= startKey && todayKey <= endKey ? todayKey : startKey;
    if (targetKey) {
      const [year, month] = targetKey.split('-').map(Number);
      setCurrentDate(new Date(year, month - 1, 1));
    }
  };

  const toggleStatus = (statusId) => {
    setSelectedStatuses((previous) => previous.includes(statusId)
      ? previous.filter((id) => id !== statusId)
      : [...previous, statusId]);
  };

  const toggleActivity = (key) => {
    setActivityVisibility((previous) => ({ ...previous, [key]: !previous[key] }));
  };

  const resetFilters = () => {
    setSelectedSemesterId(activeSemester?.semester_id ? String(activeSemester.semester_id) : '');
    if (activeSemester?.semester_id) setCurrentDate(new Date());
    setSelectedStatuses([]);
    setSelectedSubjectId('');
    setRecordSearch('');
    setSubstitutionDirection('all');
    setActivityVisibility({ attendance: true, leaves: true, substitutions: true, penalties: true });
  };

  const handleDayClick = (day) => {
    const clickedDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), day);
    const dStr = toYMD(clickedDate);
    
    const dayRecords = visibleRecords.filter(r => getAttendanceDateKey(r) === dStr);
    const dayNoClass = visibleNoClassRecords.filter(r => normalizeDateKey(r.date) === dStr);
    const dayPenalties = visiblePenalties.filter(p => dateMatches(p.date, dStr));
    const daySubs = visibleSubs.filter(s => dateMatches(s.date, dStr));
    const dayLeaves = isInsideSelectedSemester(dStr)
      ? visibleLeaves.filter(l => isDateInLeaveRange(dStr, l.date_from, l.date_to))
      : [];
    
    if (dayRecords.length > 0 || dayNoClass.length > 0 || dayPenalties.length > 0 || daySubs.length > 0 || dayLeaves.length > 0) {
      dayRecords.sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || ''))
        || String(a.room_name || '').localeCompare(String(b.room_name || ''))
        || String(a.section_name || '').localeCompare(String(b.section_name || '')));
      setSelectedDayRecords({ 
          date: clickedDate, 
          items: dayRecords,
          noClass: dayNoClass,
          penalties: dayPenalties,
          subs: daySubs,
          leaves: dayLeaves
      });
      setShowModal(true);
    }
  };

  const openAttendanceEditRequest = (record) => {
    if (isAttendanceFullyPresent(record)) return;
    setSelectedAttendanceForEdit(record);
    setAttendanceEditReason('');
    setAttendanceEditError('');
    setShowAttendanceEditModal(true);
  };

  const closeAttendanceEditRequest = () => {
    setShowAttendanceEditModal(false);
    setSelectedAttendanceForEdit(null);
    setAttendanceEditReason('');
    setAttendanceEditError('');
  };

  const notifyAttendanceEditRequestSuccess = async () => {
    if (typeof window !== 'undefined' && window.Swal && typeof window.Swal.fire === 'function') {
      await window.Swal.fire({
        icon: 'success',
        title: 'Attendance edit request submitted',
        timer: 1400,
        showConfirmButton: false
      });
    }
  };

  const submitAttendanceEditRequest = async () => {
    if (!selectedAttendanceForEdit?.attendance_id) return;
    if (isAttendanceFullyPresent(selectedAttendanceForEdit)) {
      setAttendanceEditError('This attendance is already complete. All three checkpoints are Present.');
      return;
    }
    const attendanceId = Number(selectedAttendanceForEdit.attendance_id);
    if (pendingAttendanceEditIds.includes(attendanceId)) {
      setAttendanceEditError('A pending request for this attendance record already exists.');
      return;
    }
    const reason = attendanceEditReason.trim();
    if (!reason) {
      setAttendanceEditError('Reason is required.');
      return;
    }
    setAttendanceEditError('');
    setAttendanceEditSubmitting(true);
    try {
      const result = await apiPost('request-edit/attendance', {
        attendance_id: attendanceId,
        reason
      });
      setPendingAttendanceEditIds((prev) => (prev.includes(attendanceId) ? prev : [...prev, attendanceId]));
      closeAttendanceEditRequest();
      await notifyAttendanceEditRequestSuccess();
      if (requestSelectionMode) {
        window.location.hash = `#/my-requested-edits?tab=attendance&request_id=${Number(result?.request_id || 0)}`;
      }
    } catch (e) {
      const msg = e?.body?.message || e?.body?.error || e?.message || 'Failed to submit request';
      if (String(e?.body?.error || '').toLowerCase() === 'duplicate_pending') {
        setPendingAttendanceEditIds((prev) => (prev.includes(attendanceId) ? prev : [...prev, attendanceId]));
      }
      setAttendanceEditError(String(msg));
    } finally {
      setAttendanceEditSubmitting(false);
    }
  };

  // Auto-Update the modal view if records change in the background (via setInterval)
  React.useEffect(() => {
    if (showModal && selectedDayRecords?.date) {
        const dStr = toYMD(selectedDayRecords.date);
        const dayRecords = visibleRecords.filter(r => getAttendanceDateKey(r) === dStr);
        const dayNoClass = visibleNoClassRecords.filter(r => normalizeDateKey(r.date) === dStr);
        const dayPenalties = visiblePenalties.filter(p => dateMatches(p.date, dStr));
        const daySubs = visibleSubs.filter(s => dateMatches(s.date, dStr));
        const dayLeaves = isInsideSelectedSemester(dStr)
          ? visibleLeaves.filter(l => isDateInLeaveRange(dStr, l.date_from, l.date_to))
          : [];
        
        dayRecords.sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || ''))
          || String(a.room_name || '').localeCompare(String(b.room_name || ''))
          || String(a.section_name || '').localeCompare(String(b.section_name || '')));
        setSelectedDayRecords({ 
            date: selectedDayRecords.date, 
            items: dayRecords,
            noClass: dayNoClass,
            penalties: dayPenalties,
            subs: daySubs,
            leaves: dayLeaves
        });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, noClassRecords, penalties, substitutions, leaves, selectedStatuses, selectedSubjectId, recordSearch, substitutionDirection, activityVisibility, selectedSemesterId]);

  // Robust Timestamp parser
  const fmtTime = (t) => {
    if(!t) return '--:--';
    const safeTime = String(t).replace(' ', 'T'); // Fix for iOS/Safari SQL Datetime parsing
    return new Date(safeTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  };

  // Convert "08:00:00" to "8:00 AM" for schedule representation
  const fmtScheduleTime = (timeStr) => {
      if (!timeStr) return '--:--';
      const [h, m] = String(timeStr).split(':');
      const date = new Date();
      date.setHours(parseInt(h, 10), parseInt(m, 10), 0);
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  };

  const fmtFullDate = (d) => d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const getStatusColor = (id) => {
      if(id === 0) return 'bg-violet-500';  // Partial Attendance
      if(id === 2) return 'bg-green-600';   // Present
      if(id === 5) return 'bg-amber-500';   // Late
      if(id === 3) return 'bg-red-600';     // Absent
      if(id === 4) return 'bg-indigo-600';  // Substituted
      if(id === 7) return 'bg-cyan-600';    // On leave
      if(id === 8) return 'bg-orange-500';  // Pending
      return 'bg-slate-500';                // Upcoming
  };
  
  const getStatusTextColor = (id) => {
      if(id === 0) return 'text-violet-700';
      if(id === 2) return 'text-green-700';
      if(id === 5) return 'text-amber-700';
      if(id === 3) return 'text-red-700';
      if(id === 4) return 'text-indigo-700';
      if(id === 7) return 'text-cyan-700';
      if(id === 8) return 'text-orange-700';
      return 'text-slate-700';
  };

  const getAttendanceFlagRows = (record) => ([
    {
      label: 'IN',
      flagId: getFlagId(record?.flag_in_id),
      time: record?.time_in || record?.checked_in_at || null
    },
    {
      label: 'CHECK',
      flagId: getFlagId(record?.flag_check_id),
      time: record?.time_check || record?.checked_mid_at || null
    },
    {
      label: 'OUT',
      flagId: getFlagId(record?.flag_out_id),
      time: record?.time_out || record?.checked_out_at || null
    }
  ]);

  const hasPendingAttendanceEdit = selectedAttendanceForEdit
    ? pendingAttendanceEditIds.includes(Number(selectedAttendanceForEdit.attendance_id))
    : false;

  const renderCalendar = () => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const daysInMonth = getDaysInMonth(year, month);
    const firstDay = getFirstDayOfMonth(year, month);
    
    const days = [];
    
    for (let i = 0; i < firstDay; i++) {
      days.push(<div key={`empty-${i}`} aria-hidden="true" className="h-[72px] border border-gray-100/50 bg-gray-50/30 sm:h-[90px] md:h-[110px]"></div>);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const currentDayDate = new Date(year, month, day);
      const isToday = toYMD(new Date()) === toYMD(currentDayDate);
      const dStr = toYMD(currentDayDate);
      
      const dayRecords = visibleRecords.filter(r => getAttendanceDateKey(r) === dStr);
      const dayNoClass = visibleNoClassRecords.filter(r => normalizeDateKey(r.date) === dStr);
      const dayPenalties = visiblePenalties.filter(p => dateMatches(p.date, dStr));
      const daySubs = visibleSubs.filter(s => dateMatches(s.date, dStr));
      const dayLeaves = isInsideSelectedSemester(dStr)
        ? visibleLeaves.filter(l => isDateInLeaveRange(dStr, l.date_from, l.date_to))
        : [];
      const isAllowedSemesterDay = isInsideSelectedSemester(dStr);
      const isSemesterStart = Boolean(selectedSemesterId && semesterStart && dStr === semesterStart);
      const isSemesterEnd = Boolean(selectedSemesterId && semesterEnd && dStr === semesterEnd);
      
      const hasContent = dayRecords.length > 0 || dayNoClass.length > 0 || dayPenalties.length > 0 || daySubs.length > 0 || dayLeaves.length > 0;

      days.push(
        <button
          type="button"
          key={day} 
          onClick={() => { if (isAllowedSemesterDay) handleDayClick(day); }}
          disabled={!isAllowedSemesterDay}
          aria-label={`${currentDayDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}: ${dayRecords.length} attendance records, ${dayNoClass.length} no class, ${dayLeaves.length} leaves, ${daySubs.length} substitutions, ${dayPenalties.length} penalties`}
          className={`relative flex h-[72px] w-full min-w-0 flex-col overflow-hidden border border-gray-100 p-1 text-left transition-all duration-200 sm:h-[90px] md:h-[110px] md:p-2
            ${!isAllowedSemesterDay ? 'cursor-not-allowed bg-slate-100 text-slate-400 opacity-55' : (isToday ? 'bg-emerald-50 border-emerald-200 shadow-inner' : 'bg-white hover:bg-gray-50')}
            ${hasContent && isAllowedSemesterDay ? 'cursor-pointer hover:-translate-y-0.5 hover:shadow-md focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500' : 'cursor-default'}
          `}
        >
          <div className="flex justify-between items-start mb-1">
            <span className={`text-xs md:text-sm font-bold w-6 h-6 md:w-7 md:h-7 flex items-center justify-center rounded-full 
              ${isToday ? 'bg-emerald-600 text-white shadow-md' : 'text-gray-700'}`}>
              {day}
            </span>
            {(dayRecords.length + dayNoClass.length) > 0 && (
                <span className="hidden md:inline text-[10px] font-bold text-gray-400 mt-1">{dayRecords.length + dayNoClass.length} Class{dayRecords.length + dayNoClass.length > 1 ? 'es' : ''}</span>
            )}
          </div>

          {(isSemesterStart || isSemesterEnd) && (
            <div className={`mb-1 truncate rounded px-1 py-0.5 text-[7px] font-extrabold uppercase leading-tight sm:text-[9px] ${isSemesterStart ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
              <span className="sm:hidden">{isSemesterStart ? 'Start' : 'End'}</span>
              <span className="hidden sm:inline">{isSemesterStart ? 'Start of Semester' : 'End of Semester'}</span>
            </div>
          )}

          <div className="flex flex-col gap-1 mb-1">
             {dayLeaves.length > 0 && (
                 <div className="w-full bg-cyan-100 text-cyan-700 text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded border border-cyan-200 flex items-center justify-between">
                     <span className="flex items-center gap-1">
                         <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                         <span className="hidden sm:inline">Leave</span>
                     </span>
                     {dayLeaves.length > 1 && <span>x{dayLeaves.length}</span>}
                 </div>
             )}
             {dayPenalties.length > 0 && (
                 <div className="w-full bg-red-100 text-red-700 text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded border border-red-200 flex items-center justify-between">
                     <span className="flex items-center gap-1">
                         <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd"></path></svg>
                         <span className="hidden sm:inline">Penalty</span>
                     </span>
                     {dayPenalties.length > 1 && <span>x{dayPenalties.length}</span>}
                 </div>
             )}
             {daySubs.length > 0 && (
                 <div className="w-full bg-indigo-100 text-indigo-700 text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded border border-indigo-200 flex items-center justify-between">
                     <span className="flex items-center gap-1">
                         <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                         <span className="hidden sm:inline">Sub</span>
                     </span>
                     {daySubs.length > 1 && <span>x{daySubs.length}</span>}
                 </div>
             )}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto show-scrollbar flex flex-wrap content-start gap-1 pr-0.5">
             {dayNoClass.map((r) => (
               <div key={r.id} className="w-full" title={`No Class: ${r.event_title || 'Holiday or event'}`}>
                 <div className="mb-0.5 flex items-center gap-1.5 rounded border border-slate-300 bg-slate-100 px-1 py-0.5 shadow-sm md:px-1.5 md:py-1">
                   <div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-slate-500 md:h-2 md:w-2"></div>
                   <div className="hidden min-w-0 items-center gap-1 overflow-hidden md:flex"><span className="truncate text-[10px] font-bold leading-none text-slate-700">{r.subject_code}</span><span className="text-[8px] font-extrabold uppercase text-slate-500">No Class</span></div>
                 </div>
               </div>
             ))}
             {dayRecords.map((r, idx) => {
                 const isSub = daySubs.some(s => Number(s.schedule_id) === Number(r.schedule_id));
                 const overall = getOverallStatus(r);
                 return (
                     <div key={idx} className="w-full">
                        <div className={`flex items-center gap-1.5 px-1 md:px-1.5 py-0.5 md:py-1 rounded border mb-0.5 shadow-sm
                            ${isSub ? 'bg-indigo-50/50 border-indigo-200' : 'bg-white border-gray-100'}
                        `}>
                            <div className={`w-1.5 h-1.5 md:w-2 md:h-2 rounded-full flex-shrink-0 ${getStatusColor(overall)}`}></div>
                            <div className="overflow-hidden hidden md:flex items-center gap-1 w-full">
                                <div className={`text-[10px] font-bold truncate leading-none ${isSub ? 'text-indigo-800' : 'text-gray-700'}`}>{r.subject_code}</div>
                            </div>
                        </div>
                     </div>
                 );
             })}
          </div>
        </button>
      );
    }
    return days;
  };

  const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const boxClass = "min-h-[72px] bg-white/10 border border-white/20 rounded-xl backdrop-blur-md shadow-lg flex items-center sm:min-h-[82px]";

  return (
    <div className="min-h-screen bg-gray-50 p-2 font-sans selection:bg-green-100 sm:p-4 md:p-8">
      {requestSelectionMode ? (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 font-semibold">
          Request-selection mode: choose a date, then select an eligible attendance record. Records with a pending request cannot be selected.
        </div>
      ) : null}
      
      {/* HEADER SECTION */}
      <div className="relative mb-4 overflow-hidden rounded-xl bg-[#1D8551] text-white shadow-xl sm:mb-6 sm:rounded-2xl">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white opacity-5 rounded-full -translate-y-1/2 translate-x-1/4 blur-3xl"></div>
        <div className="absolute bottom-0 left-0 w-40 h-40 bg-white opacity-10 rounded-full translate-y-1/3 -translate-x-1/4 blur-2xl"></div>

        <div className="relative z-10 flex flex-col items-start justify-between gap-4 p-4 md:p-6 xl:flex-row xl:items-center xl:gap-6">
          
          <div className="min-w-0 space-y-1">
             <div className="flex items-center gap-2 text-white/90 text-sm font-medium tracking-wide uppercase">
                Faculty Portal
             </div>
             <h2 className="text-2xl font-extrabold tracking-tight text-white sm:text-3xl">Attendance Calendar</h2>
          </div>

          <div className="attendance-history-header-items grid w-full min-w-0 grid-cols-2 gap-2 sm:flex sm:flex-row sm:flex-wrap sm:gap-4 xl:w-auto xl:justify-end">
             
             {/* VIZ 1: ATTENDANCE RATE */}
             <div className={`${boxClass} attendance-history-header-rate min-w-0 flex-1 justify-center gap-2 px-2 sm:w-auto sm:min-w-[160px] sm:gap-4 sm:px-4 xl:flex-none xl:justify-start`}>
                <div className="relative flex h-12 w-12 flex-shrink-0 items-center justify-center sm:h-14 sm:w-14">
                    <svg className="w-full h-full -rotate-90 transform" viewBox="0 0 36 36">
                        <path className="text-emerald-900/40" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="currentColor" strokeWidth="4" />
                        <path className="text-white drop-shadow-md transition-all duration-1000 ease-out" 
                            strokeDasharray={`${finalizedRate}, 100`}
                            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" 
                            fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" 
                        />
                    </svg>
                    <span className="absolute text-sm font-bold">{finalizedRate}%</span>
                </div>
                <div>
                    <div className="text-xs text-emerald-100 uppercase font-bold tracking-wider">Records Finalized</div>
                    <div className="mt-0.5 text-[10px] text-emerald-200 opacity-80">{completedCount} of {totalClasses} visible records</div>
                </div>
             </div>

             {/* VIZ 2: ALL OVERALL ATTENDANCE STATUSES */}
             <div className={`${boxClass} attendance-history-header-chart col-span-2 min-h-[108px] min-w-0 flex-1 justify-center gap-2 px-2 sm:min-h-[82px] sm:w-auto sm:min-w-[300px] sm:gap-4 sm:px-4 xl:flex-none xl:justify-start`}>
                <div className="flex h-[76px] min-w-0 flex-1 items-end justify-center gap-1 sm:h-14 sm:gap-1.5">
                    {statusChartData.map((status) => (
                      <div
                        key={status.id}
                        className="group relative flex h-[70px] min-w-0 flex-1 cursor-help flex-col items-center justify-end rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 sm:h-14"
                        tabIndex="0"
                        role="img"
                        title={`${status.label}: ${status.count}`}
                        aria-label={`${status.label}: ${status.count}`}
                      >
                        <span className="pointer-events-none absolute top-0 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-950/95 px-1.5 py-0.5 text-[8px] font-bold text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus:opacity-100 sm:block">
                          {status.count} {status.label}
                        </span>
                        <span className="mb-0.5 text-[9px] font-extrabold leading-none text-white sm:hidden" aria-hidden="true">
                          {status.count}
                        </span>
                        <span
                          className="w-3 rounded-t-sm transition-all duration-700 ease-in-out group-hover:brightness-110 sm:w-4"
                          style={{ height: getBarHeight(status.count), maxHeight: '38px', minHeight: '4px', backgroundColor: status.color }}
                          aria-hidden="true"
                        />
                        <span className="mt-1 max-w-full truncate text-[7px] font-bold tracking-tight text-white/80 sm:text-[8px]">{status.shortLabel}</span>
                      </div>
                    ))}
                </div>
                <div className="flex h-full flex-col justify-center border-l border-white/10 pl-2 sm:pl-3">
                    <div className="text-xl font-bold text-white leading-none">{totalClasses}</div>
                     <div className="mt-1 text-[9px] font-semibold uppercase tracking-wide text-emerald-200">
                       {currentDate.toLocaleDateString('en-US', { month: 'long' })} records<br/>{completedCount} Finalized
                     </div>
                </div>
             </div>

             {/* RESPONSIVE STATIC MONTH SWITCHER */}
             <div className={`${boxClass} attendance-history-header-month col-span-2 min-w-0 flex-1 justify-between gap-1 p-1 sm:w-auto sm:min-w-[200px] sm:gap-2 sm:p-2 xl:flex-none`}>
                <button onClick={() => changeMonth(-1)} className="p-3 hover:bg-white/20 rounded-lg transition-colors text-white active:scale-95 h-full flex items-center">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7"></path></svg>
                </button>
                <div className="min-w-0 flex-1 text-center sm:min-w-[120px]">
                    <div className="text-lg font-bold text-white leading-none transition-all duration-300">
                        {currentDate.toLocaleDateString('en-US', { month: 'long' })}
                    </div>
                     <div className="text-xs text-emerald-200 font-medium mt-1">
                         {currentDate.getFullYear()}
                     </div>
                     <button type="button" onClick={jumpToToday} className="mt-1 text-[9px] uppercase tracking-wider text-white/90 hover:text-white underline">
                       Today
                     </button>
                </div>
                <button onClick={() => changeMonth(1)} className="p-3 hover:bg-white/20 rounded-lg transition-colors text-white active:scale-95 h-full flex items-center">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7"></path></svg>
                </button>
             </div>

             {/* LIVE CLOCK */}
             <div 
                onClick={jumpToToday}
                className={`${boxClass} attendance-history-header-clock group min-w-0 flex-1 cursor-pointer flex-col justify-center px-2 transition-all hover:bg-white/20 active:scale-95 sm:w-auto sm:min-w-[160px] sm:px-5 xl:flex-none`}
                title="Click to go to current month"
             >
                <div className="text-xl font-bold font-mono tracking-tighter leading-none text-white tabular-nums transition-transform group-hover:scale-105 sm:text-2xl">
                    {currentTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                </div>
                <div className="text-[10px] text-white/80 uppercase tracking-wider mt-1 truncate">
                    {currentTime.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                </div>
             </div>
          </div>
        </div>
      </div>

      {/* FILTERS */}
      <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3 shadow-sm sm:mb-6 sm:rounded-2xl sm:p-4 md:p-5">
        <div className={`flex items-start justify-between gap-3 ${filtersMinimized ? '' : 'mb-4'}`}>
          <div className="min-w-0">
            <h3 className="text-sm font-extrabold uppercase tracking-widest text-gray-700">Calendar Filters</h3>
            <p className="mt-1 text-xs text-gray-500">{filtersMinimized ? 'Filters are minimized. Expand to review or change them.' : 'Filters update the calendar, daily details, and totals together.'}</p>
          </div>
          <div className="flex flex-none items-center gap-2">
            {!filtersMinimized ? (
              <button type="button" onClick={resetFilters} className="hidden rounded-lg border border-gray-300 px-3 py-2 text-xs font-bold text-gray-600 hover:bg-gray-50 sm:inline-flex">
                Reset filters
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setFiltersMinimized((previous) => !previous)}
              aria-expanded={!filtersMinimized}
              aria-label={filtersMinimized ? 'Expand calendar filters' : 'Minimize calendar filters'}
              title={filtersMinimized ? 'Expand filters' : 'Minimize filters'}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 transition hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              <svg className={`h-5 w-5 transition-transform ${filtersMinimized ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m6 15 6-6 6 6" />
              </svg>
            </button>
          </div>
        </div>

        {!filtersMinimized ? <>
        <div className="mb-3 sm:hidden">
          <button type="button" onClick={resetFilters} className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-bold text-gray-600 hover:bg-gray-50">
            Reset filters
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-4">
          <label className="min-w-0 text-[10px] font-bold uppercase tracking-wide text-gray-500 sm:text-xs">
            Semester
            <select value={selectedSemesterId} onChange={handleSemesterChange} className="mt-1 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-2 py-2.5 text-xs font-medium normal-case text-gray-700 focus:border-emerald-500 focus:outline-none sm:px-3 sm:text-sm">
              <option value="">All semesters</option>
              {semesters.map((semester) => (
                <option key={semester.semester_id} value={semester.semester_id}>
                  {`${[semester.session_name || semester.school_year || semester.school_year_name, semester.term || semester.semester_name].filter(Boolean).join(' - ') || `Semester ${semester.semester_id}`}${isSemesterActiveNow(semester) ? ' (Active)' : ''}`}
                </option>
              ))}
            </select>
          </label>

          <label className="min-w-0 text-[10px] font-bold uppercase tracking-wide text-gray-500 sm:text-xs">
            Subject
            <select value={selectedSubjectId} onChange={(event) => setSelectedSubjectId(event.target.value)} className="mt-1 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-2 py-2.5 text-xs font-medium normal-case text-gray-700 focus:border-emerald-500 focus:outline-none sm:px-3 sm:text-sm">
              <option value="">All subjects</option>
              {subjectOptions.map((subject) => <option key={subject.id} value={subject.id}>{subject.label}</option>)}
            </select>
          </label>

          <label className="min-w-0 text-[10px] font-bold uppercase tracking-wide text-gray-500 sm:text-xs">
            Section or room
            <input value={recordSearch} onChange={(event) => setRecordSearch(event.target.value)} placeholder="Section or room" className="mt-1 w-full min-w-0 rounded-lg border border-gray-300 px-2 py-2.5 text-xs font-medium normal-case text-gray-700 placeholder:text-gray-400 focus:border-emerald-500 focus:outline-none sm:px-3 sm:text-sm" />
          </label>

          <label className="min-w-0 text-[10px] font-bold uppercase tracking-wide text-gray-500 sm:text-xs">
            Substitution view
            <select value={substitutionDirection} onChange={(event) => setSubstitutionDirection(event.target.value)} className="mt-1 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-2 py-2.5 text-xs font-medium normal-case text-gray-700 focus:border-emerald-500 focus:outline-none sm:px-3 sm:text-sm">
              <option value="all">All substitutions</option>
              <option value="for_me">Substituted for me</option>
              <option value="covered">Classes I covered</option>
            </select>
          </label>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:gap-4 xl:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-2 text-[10px] font-extrabold uppercase tracking-widest text-gray-400">Attendance status</div>
            <details className="relative sm:hidden">
              <summary className="flex h-10 cursor-pointer list-none items-center justify-between rounded-lg border border-gray-300 bg-white px-2 text-xs font-bold text-gray-700">
                <span className="truncate">{selectedStatuses.length ? `${selectedStatuses.length} selected` : 'All statuses'}</span>
                <span aria-hidden="true">⌄</span>
              </summary>
              <div className="absolute left-0 right-0 z-30 mt-1 overflow-hidden rounded-lg border border-gray-200 bg-white p-1 shadow-xl">
                {ATTENDANCE_STATUS_OPTIONS.map(([id, label]) => {
                  const checked = selectedStatuses.includes(id);
                  return (
                    <button key={id} type="button" aria-pressed={checked} onClick={() => toggleStatus(id)} className={`flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-xs font-semibold ${checked ? 'bg-emerald-50 text-emerald-700' : 'text-gray-600 hover:bg-gray-50'}`}>
                      <span>{label}</span><span className={checked ? 'text-emerald-600' : 'text-transparent'} aria-hidden="true">✓</span>
                    </button>
                  );
                })}
              </div>
            </details>
            <div className="hidden flex-wrap gap-2 sm:flex">
              {ATTENDANCE_STATUS_OPTIONS.map(([id, label]) => {
                const active = selectedStatuses.includes(id);
                return <button key={id} type="button" onClick={() => toggleStatus(id)} className={`rounded-full border px-3 py-1.5 text-xs font-bold transition ${active ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-gray-300 bg-white text-gray-600 hover:border-emerald-400'}`}>{label}</button>;
              })}
            </div>
          </div>
          <div className="min-w-0">
            <div className="mb-2 text-[10px] font-extrabold uppercase tracking-widest text-gray-400">Show activity</div>
            <details className="relative sm:hidden">
              <summary className="flex h-10 cursor-pointer list-none items-center justify-between rounded-lg border border-gray-300 bg-white px-2 text-xs font-bold text-gray-700">
                <span className="truncate">{Object.values(activityVisibility).filter(Boolean).length} visible</span>
                <span aria-hidden="true">⌄</span>
              </summary>
              <div className="absolute left-0 right-0 z-30 mt-1 overflow-hidden rounded-lg border border-gray-200 bg-white p-1 shadow-xl">
                {ACTIVITY_OPTIONS.map(([key, label]) => {
                  const checked = Boolean(activityVisibility[key]);
                  return (
                    <button key={key} type="button" aria-pressed={checked} onClick={() => toggleActivity(key)} className={`flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-xs font-semibold ${checked ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-50'}`}>
                      <span>{label}</span><span className={checked ? 'text-blue-600' : 'text-transparent'} aria-hidden="true">✓</span>
                    </button>
                  );
                })}
              </div>
            </details>
            <div className="hidden flex-wrap gap-2 sm:flex">
              {ACTIVITY_OPTIONS.map(([key, label]) => (
                <button key={key} type="button" onClick={() => toggleActivity(key)} className={`rounded-full border px-3 py-1.5 text-xs font-bold transition ${activityVisibility[key] ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-gray-300 bg-gray-100 text-gray-400 line-through'}`}>{label}</button>
              ))}
            </div>
          </div>
        </div>
        </> : null}

        {fetchError ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>{fetchError}</span>
            <button type="button" onClick={() => fetchRecords(false)} className="font-bold underline">Retry</button>
          </div>
        ) : null}
      </div>

      {/* CALENDAR & DASHBOARD */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm sm:rounded-2xl">
          
          <div className="flex flex-col gap-3 border-b border-gray-200 bg-gray-50 px-3 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
              <div className="text-sm font-bold text-gray-700 uppercase tracking-widest">Monthly Record Overview</div>
              
              <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-4 lg:w-auto">
                  <div className="flex min-w-0 items-center gap-2 rounded-xl border border-cyan-100 bg-white px-2 py-2 shadow-sm sm:gap-3 sm:px-4">
                      <div className="w-8 h-8 rounded-full bg-cyan-50 flex items-center justify-center text-cyan-600">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                      </div>
                      <div>
                          <div className="text-[10px] uppercase font-bold text-cyan-500 leading-none mb-1">Leaves</div>
                          <div className="text-sm font-bold text-cyan-800 leading-none">{leavesCount} Approved</div>
                      </div>
                  </div>

                  <div className="flex min-w-0 items-center gap-2 rounded-xl border border-indigo-100 bg-white px-2 py-2 shadow-sm sm:gap-3 sm:px-4">
                      <div className="w-8 h-8 rounded-full bg-indigo-50 flex items-center justify-center text-indigo-600">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                      </div>
                      <div>
                          <div className="text-[10px] uppercase font-bold text-indigo-500 leading-none mb-1">Substitutions</div>
                          <div className="text-sm font-bold text-indigo-800 leading-tight">{substitutionsCount} total</div>
                          <div className="mt-1 text-[10px] font-semibold text-indigo-600">{substitutedForMeCount} for me · {classesCoveredCount} covered</div>
                      </div>
                  </div>

                  <div className="col-span-2 flex min-w-0 items-center justify-center gap-2 rounded-xl border border-red-100 bg-white px-2 py-2 shadow-sm sm:col-span-1 sm:justify-start sm:gap-3 sm:px-4">
                      <div className="w-8 h-8 rounded-full bg-red-50 flex items-center justify-center text-red-600">
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd"></path></svg>
                      </div>
                      <div>
                          <div className="text-[10px] uppercase font-bold text-red-400 leading-none mb-1">Penalties</div>
                          <div className="text-sm font-bold text-red-800 leading-none">{penaltiesCount} Incurred</div>
                      </div>
                  </div>
              </div>
          </div>

          <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50">
              {weekDays.map(day => (
                  <div key={day} className="min-w-0 py-2 text-center text-[9px] font-bold uppercase tracking-wide text-gray-500 sm:py-3 sm:text-[10px] sm:tracking-widest md:text-xs">
                      {day}
                  </div>
              ))}
          </div>
          
          <div className="grid grid-cols-7 bg-gray-100 gap-px border-b border-gray-200">
             {loading && records.length === 0 ? (
                 <div className="col-span-7 h-96 flex flex-col items-center justify-center bg-white">
                    <div className="w-10 h-10 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin"></div>
                    <p className="mt-4 text-sm text-gray-500">Loading calendar...</p>
                 </div>
             ) : (
                 renderCalendar()
             )}
          </div>
      </div>
      
      {/* RESPONSIVE LEGEND FOR MOBILE */}
      <div className="mx-auto mt-4 flex w-full flex-col items-center justify-center gap-3 rounded-xl border border-gray-200 bg-white px-3 py-3 text-[10px] font-medium text-gray-600 shadow-sm sm:mt-6 sm:text-xs xl:max-w-fit xl:flex-row xl:gap-5 xl:rounded-full xl:px-6 xl:text-sm">
          <div className="grid w-full grid-cols-4 gap-x-2 gap-y-2 xl:flex xl:w-auto xl:items-center xl:gap-5">
            <div className="flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap"><span className="h-3 w-3 shrink-0 rounded-full bg-green-600 shadow-inner sm:h-3.5 sm:w-3.5"></span> Present</div>
            <div className="flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap"><span className="h-3 w-3 shrink-0 rounded-full bg-amber-500 shadow-inner sm:h-3.5 sm:w-3.5"></span> Late</div>
            <div className="flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap"><span className="h-3 w-3 shrink-0 rounded-full bg-red-600 shadow-inner sm:h-3.5 sm:w-3.5"></span> Absent</div>
            <div className="flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap" title="Partial Attendance"><span className="h-3 w-3 shrink-0 rounded-full bg-violet-500 shadow-inner sm:h-3.5 sm:w-3.5"></span><span className="sm:hidden">Partial</span><span className="hidden sm:inline">Partial Attendance</span></div>
            <div className="flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap"><span className="h-3 w-3 shrink-0 rounded-full bg-slate-500 shadow-inner sm:h-3.5 sm:w-3.5"></span> Upcoming</div>
            <div className="flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap"><span className="h-3 w-3 shrink-0 rounded-full bg-orange-500 shadow-inner sm:h-3.5 sm:w-3.5"></span> Pending</div>
            <div className="flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap"><span className="h-3 w-3 shrink-0 rounded-full bg-indigo-600 shadow-inner sm:h-3.5 sm:w-3.5"></span> Substituted</div>
            <div className="flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap"><span className="h-3 w-3 shrink-0 rounded-full bg-cyan-600 shadow-inner sm:h-3.5 sm:w-3.5"></span> On Leave</div>
          </div>
          <div className="mx-2 hidden h-5 w-px bg-gray-300 xl:block"></div>
          <div className="flex flex-wrap items-center justify-center gap-2 xl:flex-nowrap">
          <div className="flex items-center gap-1.5 text-slate-700 bg-slate-100 px-2 py-0.5 rounded border border-slate-300">
             <span className="h-2.5 w-2.5 rounded-full bg-slate-500"></span> No Class
          </div>
          <div className="flex items-center gap-1.5 text-cyan-700 bg-cyan-50 px-2 py-0.5 rounded border border-cyan-100">
             <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg> Leave
          </div>
          <div className="flex items-center gap-1.5 text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100">
             <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> Substitute
          </div>
          <div className="flex items-center gap-1.5 text-red-600 bg-red-50 px-2 py-0.5 rounded border border-red-100">
             <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd"></path></svg> Penalty
          </div>
          </div>
      </div>

      {/* DAILY DETAILS MODAL */}
      <Modal show={showModal} title="Daily Activity Log" onClose={() => setShowModal(false)} size="lg">
        {selectedDayRecords && (
          <div className="custom-scrollbar h-full max-h-[75vh] overflow-y-auto bg-gray-50 p-3 sm:p-6">
            
            <div className="text-center mb-6 border-b border-gray-200 pb-4">
                <h3 className="text-xl font-extrabold tracking-tight text-gray-800 sm:text-3xl">{fmtFullDate(selectedDayRecords.date)}</h3>
                <p className="text-gray-500 font-medium mt-1">Detailed Daily View</p>
            </div>

            {/* HIGH PRIORITY ALERTS: Leaves, Penalties and Subs */}
            <div className="space-y-3 mb-6">
                {selectedDayRecords.noClass?.map((entry) => (
                    <div key={entry.id} className="rounded-lg border border-slate-300 border-l-4 border-l-slate-600 bg-slate-100 p-4 shadow-sm">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-800">No Class · {entry.subject_code}</h4>
                                <p className="mt-1 text-sm font-medium text-slate-700">{entry.event_title || 'Holiday or event'}</p>
                                <p className="mt-1 text-xs text-slate-600">{entry.section_name || 'No section'} · {entry.room_name || 'No room'} · {fmtScheduleTime(entry.start_time)}–{fmtScheduleTime(entry.end_time)}</p>
                            </div>
                            <span className="rounded-full border border-slate-300 bg-white px-2 py-1 text-[10px] font-extrabold uppercase text-slate-600">Calendar</span>
                        </div>
                    </div>
                ))}
                {selectedDayRecords.leaves?.map((l, idx) => (
                    <div key={`lev-${idx}`} className="bg-cyan-50 border border-cyan-200 border-l-4 border-l-cyan-600 p-4 rounded-lg shadow-sm flex items-start gap-4 animate-fade-in-up">
                         <div className="mt-0.5 text-cyan-600">
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                         </div>
                         <div>
                             <h4 className="text-cyan-900 font-bold uppercase tracking-wider text-xs mb-1">Approved Leave: {l.name_type}</h4>
                             <p className="text-cyan-700 text-sm font-medium">Duration: {l.date_from} to {l.date_to}</p>
                             {l.reason && <p className="text-cyan-600 text-xs mt-1 italic">"{l.reason}"</p>}
                         </div>
                    </div>
                ))}

                {selectedDayRecords.penalties?.map((p, idx) => (
                    <div key={`pen-${idx}`} className="bg-red-50 border border-red-200 border-l-4 border-l-red-500 p-4 rounded-lg shadow-sm flex items-start gap-4 animate-fade-in-up">
                         <div className="mt-0.5 text-red-500">
                            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd"></path></svg>
                         </div>
                         <div>
                             <h4 className="text-red-900 font-bold uppercase tracking-wider text-xs mb-1">Penalty Imposed: {p.type_name}</h4>
                             <p className="text-red-700 text-sm font-medium">{p.reason || 'No specific reason detailed in record.'}</p>
                         </div>
                    </div>
                ))}

                {selectedDayRecords.subs?.map((s, idx) => {
                    const isCovering = Number(s.substitute_id) === myUserId;
                    return (
                        <div key={`sub-${idx}`} className="bg-indigo-50 border border-indigo-200 border-l-4 border-l-indigo-600 p-4 rounded-lg shadow-sm flex items-start gap-4 animate-fade-in-up">
                             <div className="mt-0.5 text-indigo-600">
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"></path></svg>
                             </div>
                             <div>
                                 <h4 className="text-indigo-900 font-bold uppercase tracking-wider text-xs mb-1">
                                     {isCovering ? 'You Covered a Class' : 'Class Substituted'}
                                 </h4>
                                 <p className="text-indigo-700 text-sm font-medium">
                                     {isCovering 
                                         ? `You acted as substitute for ${s.teacher_first} ${s.teacher_last} (${s.subject_code})` 
                                         : `${s.sub_first} ${s.sub_last} substituted this class for you (${s.subject_code})`}
                                 </p>
                             </div>
                        </div>
                    );
                })}
            </div>

            {/* ATTENDANCE RECORDS */}
            <h4 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">Attendance Logs ({selectedDayRecords.items.length})</h4>
            {selectedDayRecords.items.length === 0 ? (
                <div className="text-center py-8 bg-white border border-gray-200 border-dashed rounded-xl text-gray-400 italic">{selectedDayRecords.noClass?.length ? 'No attendance was generated for the No Class schedule above.' : 'No attendance records generated for this date.'}</div>
            ) : (
                <div className="space-y-4">
                    {selectedDayRecords.items.map((record, idx) => {
                        const hasAttachedSub = selectedDayRecords.subs.some(s => Number(s.schedule_id) === Number(record.schedule_id));
                        const overallStatus = getOverallStatus(record);

                        return (
                            <div key={idx} className={`bg-white rounded-xl p-4 md:p-5 shadow-sm border flex flex-col md:flex-row gap-4 items-center relative overflow-hidden group transition-shadow
                                ${hasAttachedSub ? 'border-indigo-200 bg-indigo-50/20' : 'border-gray-200 hover:shadow-md'}
                            `}>
                                <div className={`absolute left-0 top-0 bottom-0 w-2 ${getStatusColor(overallStatus)}`}></div>
                                
                                {/* TIMING BLOCK (IN, CHECK, OUT) */}
                                <div className="w-full md:w-auto md:min-w-[220px] flex flex-col gap-2 md:border-r border-gray-100 pl-2 pr-4">
                                    <div className="flex items-center justify-between text-xs">
                                        <span className="font-bold text-gray-400 uppercase tracking-widest w-14">IN:</span>
                                        {(() => { const fid = getFlagId(record.flag_in_id); return (<>
                                          <span className={`font-bold ${getStatusTextColor(fid)} min-w-[74px] text-left`}>{flagMap[fid] || 'Upcoming'}</span>
                                          {/* FIX: USING record.time_in INSTEAD OF record.checked_in_at */}
                                          <span className="font-mono text-gray-700 font-semibold">{record.time_in ? fmtTime(record.time_in) : '--:--'}</span>
                                        </>); })()}
                                    </div>
                                    <div className="flex items-center justify-between text-xs">
                                        <span className="font-bold text-gray-400 uppercase tracking-widest w-14">CHECK:</span>
                                        {(() => { const fid = getFlagId(record.flag_check_id); return (<>
                                          <span className={`font-bold ${getStatusTextColor(fid)} min-w-[74px] text-left`}>{flagMap[fid] || 'Upcoming'}</span>
                                          {/* FIX: USING record.time_check INSTEAD OF record.checked_mid_at */}
                                          <span className="font-mono text-gray-700 font-semibold">{record.time_check ? fmtTime(record.time_check) : '--:--'}</span>
                                        </>); })()}
                                    </div>
                                    <div className="flex items-center justify-between text-xs">
                                        <span className="font-bold text-gray-400 uppercase tracking-widest w-14">OUT:</span>
                                        {(() => { const fid = getFlagId(record.flag_out_id); return (<>
                                          <span className={`font-bold ${getStatusTextColor(fid)} min-w-[74px] text-left`}>{flagMap[fid] || 'Upcoming'}</span>
                                          {/* FIX: USING record.time_out INSTEAD OF record.checked_out_at */}
                                          <span className="font-mono text-gray-700 font-semibold">{record.time_out ? fmtTime(record.time_out) : '--:--'}</span>
                                        </>); })()}
                                    </div>
                                </div>

                                {/* SUBJECT & ROOM BLOCK */}
                                <div className="flex-1 w-full flex flex-col justify-center text-left">
                                    <div className="flex flex-wrap items-center gap-2 mb-1.5">
                                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-gray-100 text-gray-600 border border-gray-200">
                                            {record.section_name || 'No Section'}
                                        </span>
                                        <span className="text-base font-black text-emerald-800">
                                            {record.subject_code}
                                        </span>
                                    </div>
                                    <div className="text-sm text-gray-600 font-medium leading-tight mb-1">
                                        {record.subject_name}
                                    </div>
                                    
                                    {/* SCHEDULE TIME INSERTED HERE */}
                                    <div className="text-xs font-bold text-gray-500 flex items-center gap-1.5 mb-1.5">
                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                                        {fmtScheduleTime(record.start_time)} - {fmtScheduleTime(record.end_time)}
                                    </div>

                                    <div className="flex items-center gap-1.5 text-xs text-gray-500 font-bold bg-gray-50 px-2.5 py-1.5 rounded-lg border border-gray-100 max-w-fit">
                                        <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"></path></svg>
                                        {record.room_name || 'TBA'}
                                    </div>
                                </div>

                                {/* OVERALL STATUS PILL */}
                                <div className="w-full md:w-auto mt-2 md:mt-0 flex flex-col items-center md:items-end gap-2">
                                     <div className={`px-4 py-1.5 rounded-full text-xs font-bold inline-flex items-center gap-2 border shadow-sm ${
                                         overallStatus === 2 ? 'bg-green-50 text-green-700 border-green-200' :
                                         overallStatus === 5 ? 'bg-amber-50 text-amber-700 border-amber-200' :
                                         overallStatus === 3 ? 'bg-red-50 text-red-800 border-red-200' :
                                         overallStatus === 0 ? 'bg-violet-50 text-violet-700 border-violet-200' :
                                         overallStatus === 4 ? 'bg-indigo-50 text-indigo-700 border-indigo-200' :
                                         overallStatus === 7 ? 'bg-cyan-50 text-cyan-700 border-cyan-200' :
                                         overallStatus === 8 ? 'bg-orange-50 text-orange-800 border-orange-200' :
                                         'bg-slate-100 text-slate-700 border-slate-200'
                                     }`}>
                                        <span className={`w-2 h-2 rounded-full shadow-inner ${getStatusColor(overallStatus)}`}></span>
                                        {flagMap[overallStatus] || 'Upcoming'}
                                     </div>
                                     {canRequestEdit ? (() => {
                                       const isFullyPresent = isAttendanceFullyPresent(record);
                                       const hasPendingRequest = pendingAttendanceEditIds.includes(Number(record.attendance_id));
                                       const requestDisabled = isFullyPresent || hasPendingRequest;
                                       const requestTitle = isFullyPresent
                                         ? 'No edit is needed because all checkpoints are Present'
                                         : hasPendingRequest
                                           ? 'Pending request exists'
                                           : 'Request edit for this attendance record';
                                       return (
                                       <button
                                          type="button"
                                          onClick={() => openAttendanceEditRequest(record)}
                                          disabled={requestDisabled}
                                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 text-xs font-bold hover:bg-emerald-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                          title={requestTitle}
                                       >
                                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5M16.586 3.586a2 2 0 112.828 2.828L11 14.828l-4 1 1-4 8.586-8.242z"></path>
                                          </svg>
                                          {isFullyPresent ? 'Attendance complete' : hasPendingRequest ? 'Pending request exists' : 'Request Edit'}
                                       </button>
                                       );
                                     })() : null}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            <div className="flex justify-end pt-8">
                <button onClick={() => setShowModal(false)} className="px-8 py-3 bg-gray-900 hover:bg-black text-white rounded-xl text-sm font-bold shadow-lg transition-transform active:scale-95">
                    Close Daily Log
                </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        show={showAttendanceEditModal}
        title="Request Attendance Edit"
        onClose={closeAttendanceEditRequest}
        size="md"
      >
        {selectedAttendanceForEdit ? (
          <div className="space-y-4">
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-2">
              <div className="text-sm font-bold text-gray-800">
                {selectedAttendanceForEdit.subject_code} - {selectedAttendanceForEdit.subject_name}
              </div>
              <div className="text-xs text-gray-600">
                {selectedAttendanceForEdit.section_name || 'No Section'} | {selectedAttendanceForEdit.room_name || 'TBA'}
              </div>
              <div className="text-xs text-gray-600">
                {selectedAttendanceForEdit.date} | {fmtScheduleTime(selectedAttendanceForEdit.start_time)} - {fmtScheduleTime(selectedAttendanceForEdit.end_time)}
              </div>
              <div className="text-xs text-gray-700">
                Current status: <span className="font-bold">{flagMap[getOverallStatus(selectedAttendanceForEdit)] || 'Upcoming'}</span>
              </div>
            </div>

            <div className="overflow-x-auto border border-gray-200 rounded-xl">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-gray-100 text-gray-600 uppercase text-[11px] tracking-wider">
                    <th className="px-3 py-2 text-left">Flag</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-left">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {getAttendanceFlagRows(selectedAttendanceForEdit).map((row) => (
                    <tr key={row.label}>
                      <td className="px-3 py-2 font-bold text-gray-700">{row.label}</td>
                      <td className={`px-3 py-2 font-semibold ${getStatusTextColor(row.flagId)}`}>
                        {flagMap[row.flagId] || 'Upcoming'}
                      </td>
                      <td className="px-3 py-2 font-mono text-gray-700">
                        {row.time ? fmtTime(row.time) : '--:--'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {hasPendingAttendanceEdit ? (
              <div className="text-sm text-red-700 bg-red-50 border border-red-300 rounded-lg px-3 py-2 font-semibold">
                A pending request for this attendance record already exists.
              </div>
            ) : null}

            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                Reason for Edit Request
              </label>
              <textarea
                value={attendanceEditReason}
                onChange={(e) => setAttendanceEditReason(e.target.value)}
                rows={4}
                className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                placeholder="Explain what needs to be corrected..."
              />
            </div>

            {attendanceEditError ? (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {attendanceEditError}
              </div>
            ) : null}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={closeAttendanceEditRequest}
                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 text-sm font-semibold hover:bg-gray-50"
                disabled={attendanceEditSubmitting}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitAttendanceEditRequest}
                className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-60"
                disabled={attendanceEditSubmitting || hasPendingAttendanceEdit}
              >
                {attendanceEditSubmitting ? 'Submitting...' : 'Submit Request'}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
