import React from 'react';
import Modal from '../../components/Modal.jsx';
// Ensure these components exist in your project or adjust imports
import { apiGet, apiPost } from '../../services/api.js';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';

const ALTITUDE_CALIBRATION_STORAGE_KEY = 'attendance_altitude_calibration_v1';
const IOS_CALIBRATION_MAX_OFFSET_METERS = 200;

// --- Helpers ---
const deg2rad = (deg) => (deg * Math.PI) / 180;
const toFiniteNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const detectDevicePlatform = () => {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = String(navigator.userAgent || '');
  const platform = String(navigator.userAgentData?.platform || navigator.platform || '');
  if (/android/i.test(ua) || /android/i.test(platform)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua) || /iphone|ipad|ipod/i.test(platform)) return 'ios';
  if (/mac/i.test(platform) && Number(navigator.maxTouchPoints || 0) > 1) return 'ios';
  if (/windows|mac|linux/i.test(platform)) return 'desktop';
  return 'unknown';
};

const altitudeCalibrationKey = (platform, buildingId) => `${platform || 'unknown'}:${buildingId || 'global'}`;

const readAltitudeCalibrationMap = () => {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(ALTITUDE_CALIBRATION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
};

const readAltitudeCalibration = (platform, buildingId = null) => {
  const map = readAltitudeCalibrationMap();
  const specific = map[altitudeCalibrationKey(platform, buildingId)];
  const fallback = map[altitudeCalibrationKey(platform, null)];
  const found = specific || fallback || null;
  return found && toFiniteNumber(found.offset) !== null ? found : null;
};

const saveAltitudeCalibration = (calibration) => {
  if (typeof localStorage === 'undefined' || !calibration) return;
  const platform = calibration.platform || 'unknown';
  const map = readAltitudeCalibrationMap();
  map[altitudeCalibrationKey(platform, calibration.building_id)] = calibration;
  map[altitudeCalibrationKey(platform, null)] = calibration;
  try {
    localStorage.setItem(ALTITUDE_CALIBRATION_STORAGE_KEY, JSON.stringify(map));
  } catch (e) {}
};

const getDistanceMeters = (lat1, lon1, lat2, lon2) => {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return Infinity;
  const R = 6371000;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const isInsideBox = (coords, room) => {
  if (!coords || !room) return false;
  const metersPerDegLat = 111320;
  const deltaLat = Number(room.radius) / metersPerDegLat;
  const latRad = deg2rad(Number(room.latitude || 0));
  const metersPerDegLon = Math.max(1e-6, metersPerDegLat * Math.cos(latRad));
  const deltaLon = Number(room.radius) / metersPerDegLon;
    
  const minLat = Number(room.latitude) - deltaLat;
  const maxLat = Number(room.latitude) + deltaLat;
  const minLon = Number(room.longitude) - deltaLon;
  const maxLon = Number(room.longitude) + deltaLon;

  return coords.latitude >= minLat && coords.latitude <= maxLat && 
         coords.longitude >= minLon && coords.longitude <= maxLon;
};

const formatDateYMD = (d) => {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatTime12 = (value) => {
  if (!value) return '—';
  const timeStr = value.includes('T') ? value : `1970-01-01T${value}`;
  const d = new Date(timeStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

const timeKey = (value) => String(value || '').slice(0, 5);

const subjectKey = (record) => {
  if (!record) return '';
  if (record.subject_id !== undefined && record.subject_id !== null && String(record.subject_id) !== '') {
    return `id:${record.subject_id}`;
  }
  return `text:${String(record.subject_code || record.subject_name || '').trim().toLowerCase()}`;
};

const isSameScheduleGroup = (a, b) => {
  if (!a || !b) return false;
  const leftSemester = String(a.semester_id ?? '');
  const rightSemester = String(b.semester_id ?? '');
  if (!leftSemester || !rightSemester || leftSemester !== rightSemester) return false;
  return String(a.date || '') === String(b.date || '')
    && timeKey(a.start_time) === timeKey(b.start_time)
    && timeKey(a.end_time) === timeKey(b.end_time)
    && subjectKey(a) === subjectKey(b);
};

const hasDistinctParallelIdentity = (a, b, field) => {
  const left = a?.[field];
  const right = b?.[field];
  return left !== undefined && left !== null && String(left) !== ''
    && right !== undefined && right !== null && String(right) !== ''
    && String(left) !== String(right);
};

const isParallelSchedulePair = (a, b) => isSameScheduleGroup(a, b)
  && hasDistinctParallelIdentity(a, b, 'schedule_id')
  && hasDistinctParallelIdentity(a, b, 'section_id')
  && hasDistinctParallelIdentity(a, b, 'room_id');

const isRecordActiveNow = (record, now = new Date()) => {
  if (!record?.date || !record?.start_time || !record?.end_time) return false;
  const start = new Date(`${record.date}T${record.start_time}`);
  const end = new Date(`${record.date}T${record.end_time}`);
  return now >= start && now <= end;
};

const isSubstitutedRecord = (record) => Number(record?.flag_in_id) === 4
  || Number(record?.flag_check_id) === 4
  || Number(record?.flag_out_id) === 4;

const isOnLeaveRecord = (record) => Number(record?.flag_in_id) === 7
  || Number(record?.flag_check_id) === 7
  || Number(record?.flag_out_id) === 7;

const isAttendanceExemptRecord = (record) => isSubstitutedRecord(record) || isOnLeaveRecord(record);

const getFlagLabel = (flagId) => {
  switch (Number(flagId)) {
    case 1: return 'Upcoming';
    case 2: return 'Present';
    case 3: return 'Absent';
    case 4: return 'Substituted';
    case 5: return 'Late';
    case 7: return 'On Leave';
    case 8: return 'Pending';
    default: return '—';
  }
};

// Status color map matching the attendance management page colors
const getStatusColor = (flagId) => {
  switch (Number(flagId)) {
    case 1: return { bg: '#64748b', text: '#ffffff' }; // Upcoming - slate
    case 2: return { bg: '#16a34a', text: '#ffffff' }; // Present - green
    case 3: return { bg: '#dc2626', text: '#ffffff' }; // Absent - red
    case 4: return { bg: '#4f46e5', text: '#ffffff' }; // Substituted - indigo
    case 5: return { bg: '#f59e0b', text: '#0f172a' }; // Late - amber
    case 7: return { bg: '#0891b2', text: '#ffffff' }; // On Leave - cyan
    case 8: return { bg: '#f97316', text: '#ffffff' }; // Pending - orange
    default: return { bg: '#64748b', text: '#ffffff' }; // Default - slate
  }
};

const getDayOfWeek = (dateStr) => {
  if (!dateStr) return '';
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  return days[d.getDay()];
};

const formatClockDate = (d) => {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return '—';
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const month = months[d.getMonth()];
  const day = d.getDate();
  const year = d.getFullYear();
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12;
  return `${month} ${day},${year} ${hours}:${minutes}${ampm}`;
};

const ClockDisplay = React.memo(function ClockDisplay() {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <>{formatClockDate(now)}</>;
});

const CountdownDisplay = React.memo(function CountdownDisplay({ targetDate }) {
  const getSecondsLeft = React.useCallback(() => {
    if (!targetDate) return null;
    return Math.max(0, Math.ceil((targetDate.getTime() - Date.now()) / 1000));
  }, [targetDate]);
  const [secondsLeft, setSecondsLeft] = React.useState(getSecondsLeft);

  React.useEffect(() => {
    setSecondsLeft(getSecondsLeft());
    if (!targetDate) return undefined;
    const timer = window.setInterval(() => setSecondsLeft(getSecondsLeft()), 1000);
    return () => window.clearInterval(timer);
  }, [getSecondsLeft, targetDate]);

  if (secondsLeft == null) return null;
  if (secondsLeft <= 0) return <>now</>;
  const days = Math.floor(secondsLeft / 86400);
  const hours = Math.floor((secondsLeft % 86400) / 3600);
  const mins = Math.floor((secondsLeft % 3600) / 60);
  const secs = secondsLeft % 60;
  const value = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return <>{days > 0 ? `${days}d ${value}` : value}</>;
});

const arraysEqualByJson = (left, right) => {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  try { return JSON.stringify(left) === JSON.stringify(right); } catch (e) { return false; }
};

const ensureSwalLoaded = async () => {
  if (typeof window === 'undefined') return;
  if (window.Swal) return;
  if (!document.querySelector('link[data-swal]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/sweetalert2.min.css';
    link.setAttribute('data-swal', '1');
    document.head.appendChild(link);
  }
  if (document.querySelector('script[data-swal]')) {
    const existing = document.querySelector('script[data-swal]');
    if (existing.getAttribute('data-loaded') === '1' && window.Swal) return;
    await new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Failed to load SweetAlert')), { once: true });
    });
    if (window.Swal) return;
  }
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/sweetalert2.all.min.js';
    script.async = true;
    script.setAttribute('data-swal', '1');
    script.onload = () => { script.setAttribute('data-loaded', '1'); resolve(); };
    script.onerror = () => reject(new Error('Failed to load SweetAlert script'));
    document.head.appendChild(script);
  });
  if (!window.Swal) throw new Error('SweetAlert failed to initialize');
};

export default function AttendanceIndex() {
  const [userId, setUserId] = React.useState(null);
  const [teacherName, setTeacherName] = React.useState('');
    
  const [records, setRecords] = React.useState([]);
  const [rooms, setRooms] = React.useState([]);
  const [floors, setFloors] = React.useState([]);
  const [buildings, setBuildings] = React.useState([]);
  const [referenceDataLoaded, setReferenceDataLoaded] = React.useState(false);
  const [currentBuilding, setCurrentBuilding] = React.useState(null);
    
  const [coords, setCoords] = React.useState(null);
  const [errorMessage, setErrorMessage] = React.useState(null);
  const [locationPermission, setLocationPermission] = React.useState('checking');
  const [locationIssue, setLocationIssue] = React.useState(null);
  const [gpsEnabled, setGpsEnabled] = React.useState(true);
  const [wrongFloorInfo, setWrongFloorInfo] = React.useState(null);
    
  const [actionAllowed, setActionAllowed] = React.useState(false);
  const [allowAt, setAllowAt] = React.useState(null);
  const [currentAction, setCurrentAction] = React.useState(null);
    
  const [isCameraVisible, setIsCameraVisible] = React.useState(false);
  const [detectedFloor, setDetectedFloor] = React.useState(null);
  const [usingDbFloor, setUsingDbFloor] = React.useState(false);

  const debugVideoRef = React.useRef(null);
  const previewStreamRef = React.useRef(null);
  const [previewActive, setPreviewActive] = React.useState(false);
  const scannerStartedRef = React.useRef(false);
  const handleCheckNowRef = React.useRef(null);
  const scannerSessionRef = React.useRef(0);
  const locationSuppressedRef = React.useRef(false);
  const substitutedNoticeKeyRef = React.useRef('');
    
  const [cameraPermission, setCameraPermission] = React.useState('prompt');

  const [scannedQrToken, setScannedQrToken] = React.useState(null);
  const [scannedFloor, setScannedFloor] = React.useState(null);
  const [manualFloorCode, setManualFloorCode] = React.useState('');
  const [manualCodeError, setManualCodeError] = React.useState('');
  const [manualCodeVerifying, setManualCodeVerifying] = React.useState(false);
  const [qrVerificationMode, setQrVerificationMode] = React.useState('scan');
  const [devicePlatform] = React.useState(() => detectDevicePlatform());
  const [connectionQuality, setConnectionQuality] = React.useState(null);
  const pingIntervalRef = React.useRef(null);

  // State for parallel class modal
  const [parallelModalData, setParallelModalData] = React.useState(null);
  const [showParallelModal, setShowParallelModal] = React.useState(false);

  const [scheduleEpoch, setScheduleEpoch] = React.useState(0);
  React.useEffect(() => {
    let timer = null;
    let cancelled = false;

    const scheduleNextTick = () => {
      const delay = 5000 - (Date.now() % 5000);
      timer = window.setTimeout(() => {
        if (cancelled) return;
        setScheduleEpoch(value => value + 1);
        scheduleNextTick();
      }, delay);
    };

    scheduleNextTick();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  React.useEffect(() => {
    let pingController = null;
    const measurePing = async () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setConnectionQuality({ rtt: null, downlink: null, effectiveType: 'offline', label: 'Offline', color: '#6c757d' });
        return;
      }
      const start = performance.now();
      let ok = true;
      let timeout = null;
      try {
        if (pingController) pingController.abort();
        pingController = new AbortController();
        timeout = window.setTimeout(() => pingController?.abort(), 5000);
        const pingUrl = new URL('network-ping.json', document.baseURI);
        pingUrl.searchParams.set('t', String(Date.now()));
        const response = await fetch(pingUrl.toString(), {
          method: 'GET',
          cache: 'no-store',
          signal: pingController.signal,
        });
        if (!response.ok) throw new Error(`Network check failed (${response.status})`);
      } catch (err) {
        if (err?.name === 'AbortError') return;
        ok = false;
      } finally {
        if (timeout !== null) window.clearTimeout(timeout);
      }
      const elapsed = Math.round(performance.now() - start);
      const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
      const downlink = Number(connection?.downlink);
      const estimatedDownlink = Number.isFinite(downlink) && downlink >= 0 ? downlink : null;
      const effectiveType = connection?.effectiveType || 'unknown';
      if (!ok) {
        setConnectionQuality({ rtt: null, downlink: estimatedDownlink, effectiveType, label: 'Offline', color: '#6c757d' });
        return;
      }
      const clamped = Math.min(Math.max(elapsed, 0), 999);
      let label, color;
      const slowDownlink = estimatedDownlink !== null && estimatedDownlink < 1.5;
      const fairDownlink = estimatedDownlink !== null && estimatedDownlink < 5;
      if (clamped < 100 && !fairDownlink) { label = 'Good'; color = '#28a745'; }
      else if (clamped < 250 && !slowDownlink) { label = 'Fair'; color = '#ffc107'; }
      else { label = 'Poor'; color = '#dc3545'; }
      setConnectionQuality({ rtt: clamped, downlink: estimatedDownlink, effectiveType, label, color });
    };
    measurePing();
    const onOnline = () => measurePing();
    const onOffline = () => setConnectionQuality({ rtt: null, downlink: null, effectiveType: 'offline', label: 'Offline', color: '#6c757d' });
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') measurePing();
      else if (pingController) pingController.abort();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibilityChange);
    pingIntervalRef.current = window.setInterval(measurePing, 10000);
    return () => {
      if (pingController) pingController.abort();
      if (pingIntervalRef.current) window.clearInterval(pingIntervalRef.current);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);
  const [altitudeCalibration, setAltitudeCalibration] = React.useState(null);
  const LOCAL_STORAGE_KEY = 'attendance_scanned_qr_v1';

  // --- Logic Effects ---
  React.useEffect(() => {
    try {
      const floorsReady = Array.isArray(floors) && floors.length > 0;
      const recordsReady = Array.isArray(records); 
      if (!floorsReady || !recordsReady) return; 

      const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.token) return;

      const now = new Date();
      const todayStr = formatDateYMD(now);
      const todays = records.filter(r => r.date === todayStr);
      const active = todays.find(r => {
        if (!r.start_time || !r.end_time) return false;
        const start = new Date(`${r.date}T${r.start_time}`);
        const end = new Date(`${r.date}T${r.end_time}`);
        return now >= start && now <= end;
      }) || null;

      if (parsed.schedule_id && active && (String(parsed.schedule_id) !== String(active.schedule_id))) {
        const parsedRecord = todays.find(r => String(r.schedule_id) === String(parsed.schedule_id));
        if (parsedRecord && isSameScheduleGroup(parsedRecord, active)) {
          // Keep one QR scan alive when the teacher has multiple sections in the same subject/time slot.
        } else {
          localStorage.removeItem(LOCAL_STORAGE_KEY);
          return;
        }
      }

      if (parsed.group_key && active && parsed.group_key !== `${active.date}|${subjectKey(active)}|${timeKey(active.start_time)}|${timeKey(active.end_time)}`) {
        localStorage.removeItem(LOCAL_STORAGE_KEY);
        return;
      }

      if (parsed.floor_id) {
        const f = floors.find(ff => String(ff.floor_id) === String(parsed.floor_id));
        if (f) {
          setScannedQrToken(parsed.token);
          setScannedFloor(f);
        } else {
          localStorage.removeItem(LOCAL_STORAGE_KEY);
        }
      } else {
        setScannedQrToken(parsed.token);
      }
    } catch (e) { }
  }, [floors, records]);

  React.useEffect(() => {
    try {
      if (!scannedQrToken) {
        localStorage.removeItem(LOCAL_STORAGE_KEY);
        return;
      }
      const now = new Date();
      const todayStr = formatDateYMD(now);
      const todays = records.filter(r => r.date === todayStr);
      const active = todays.find(r => {
        if (!r.start_time || !r.end_time) return false;
        const start = new Date(`${r.date}T${r.start_time}`);
        const end = new Date(`${r.date}T${r.end_time}`);
        return now >= start && now <= end;
      }) || null;

      const payload = {
        token: scannedQrToken,
        floor_id: scannedFloor ? scannedFloor.floor_id : null,
        schedule_id: active ? active.schedule_id : null,
        group_key: active ? `${active.date}|${subjectKey(active)}|${timeKey(active.start_time)}|${timeKey(active.end_time)}` : null,
        ts: Date.now()
      };
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {}
  }, [scannedQrToken, scannedFloor, records]);

  const lastCoordsRef = React.useRef(null);
  const watchIdRef = React.useRef(null);
  const locationTrackingActiveRef = React.useRef(false);
  const isFetchingRef = React.useRef(false);
  const attendanceAbortRef = React.useRef(null);
  const attendanceRequestSeqRef = React.useRef(0);
  const attendanceEtagRef = React.useRef('');
  const attendanceSignatureRef = React.useRef('');
  const referenceAbortRef = React.useRef(null);
  const referenceRequestSeqRef = React.useRef(0);
  const lastPositionAtRef = React.useRef(0);
  const fallbackLocationInFlightRef = React.useRef(false);
  const locationPermissionRef = React.useRef('checking');
  const locationRetryRequiredRef = React.useRef(false);
  const gpsEnabledRef = React.useRef(true);
  const locationAutoRetryCountRef = React.useRef(0);
  const locationAutoRetryTimerRef = React.useRef(null);
  const startLocationTrackingRef = React.useRef(null);
  const locationRequiredAlertShownRef = React.useRef(false);
  const locationBlockedAlertShownRef = React.useRef(false);

  const ACCURACY_THRESHOLD_METERS = 30;
  const ALTITUDE_ACCURACY_THRESHOLD_METERS = 30;
  const LOCATION_DISTANCE_INTERVAL_METERS = 5;
  const MAX_LOCATION_AUTO_RETRIES = 3;
  const LOCATION_AUTO_RETRY_DELAY_MS = 1000;

  const showLocationRequiredAlert = React.useCallback(async () => {
    if (locationRequiredAlertShownRef.current) return false;
    locationRequiredAlertShownRef.current = true;
    try {
      await ensureSwalLoaded();
      const result = await window.Swal.fire({
        icon: 'info',
        title: 'Location Required',
        text: 'Attendance needs your location. Select Enable Location, then allow location access in your browser.',
        confirmButtonText: 'Enable Location',
        showCancelButton: true,
        cancelButtonText: 'Cancel',
        confirmButtonColor: '#15803d',
        reverseButtons: true,
      });
      return Boolean(result?.isConfirmed);
    } catch (error) {
      console.warn('Location permission alert unavailable:', error);
      return false;
    }
  }, []);

  const showLocationBlockedAlert = React.useCallback(async () => {
    if (locationBlockedAlertShownRef.current) return;
    locationBlockedAlertShownRef.current = true;
    try {
      await ensureSwalLoaded();
      await window.Swal.fire({
        icon: 'error',
        title: 'Location Permission Blocked',
        text: 'Allow Location for this website in your browser settings, then press Turn on GPS.',
        confirmButtonText: 'OK',
        confirmButtonColor: '#15803d',
      });
    } catch (error) {
      console.warn('Location blocked alert unavailable:', error);
    }
  }, []);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const uid = params.get('userId');
    const nameParam = params.get('name') || '';
    if (uid) {
      setUserId(Number(uid));
      setTeacherName(nameParam);
      return;
    }
    try {
      const stored = localStorage.getItem('user');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && (parsed.user_id || parsed.id || parsed.userId)) {
          const resolvedId = parsed.user_id || parsed.id || parsed.userId;
          setUserId(Number(resolvedId));
          setTeacherName((parsed.first_name && parsed.last_name) ? `${parsed.first_name} ${parsed.last_name}` : (nameParam || parsed.name || ''));
          return;
        }
      }
    } catch (e) {}
    setUserId(null);
    setTeacherName(nameParam || '');
  }, []);

  const loadReferenceData = React.useCallback(async ({ silent = false } = {}) => {
    const requestSeq = ++referenceRequestSeqRef.current;
    if (referenceAbortRef.current) referenceAbortRef.current.abort();
    const controller = new AbortController();
    referenceAbortRef.current = controller;
    try {
      const [roomsData, floorsData, buildingsData] = await Promise.all([
        apiGet('rooms', { signal: controller.signal }),
        apiGet('floors', { signal: controller.signal }),
        apiGet('buildings', { signal: controller.signal }),
      ]);
      if (requestSeq !== referenceRequestSeqRef.current) return;
      const isActive = (item) => String(item?.status || '').toLowerCase() === 'active';
      const activeBuildings = Array.isArray(buildingsData)
        ? buildingsData.filter((building) => isActive(building) && (!building.school_id || String(building.school_status || '').toLowerCase() === 'active'))
        : [];
      const activeBuildingIds = new Set(activeBuildings.map((building) => String(building.building_id)));
      const activeFloors = Array.isArray(floorsData)
        ? floorsData.filter((floor) => isActive(floor) && activeBuildingIds.has(String(floor.building_id)))
        : [];
      const activeFloorIds = new Set(activeFloors.map((floor) => String(floor.floor_id)));
      const activeRooms = Array.isArray(roomsData)
        ? roomsData.filter((room) => isActive(room) && activeBuildingIds.has(String(room.building_id)) && activeFloorIds.has(String(room.floor_id)))
        : [];
      setRooms(previous => arraysEqualByJson(previous, activeRooms) ? previous : activeRooms);
      setFloors(previous => arraysEqualByJson(previous, activeFloors) ? previous : activeFloors);
      setBuildings(previous => arraysEqualByJson(previous, activeBuildings) ? previous : activeBuildings);
      setReferenceDataLoaded(true);
    } catch (err) {
      if (err?.name !== 'AbortError' && !silent) console.error('Failed loading attendance reference data:', err);
    }
  }, []);

  React.useEffect(() => {
    loadReferenceData();
    const refresh = () => loadReferenceData({ silent: true });
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && navigator.onLine !== false) refresh();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      if (referenceAbortRef.current) referenceAbortRef.current.abort();
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [loadReferenceData]);

  const loadMyAttendance = React.useCallback(async ({ silent = false } = {}) => {
    if (!userId || isFetchingRef.current) return;
    isFetchingRef.current = true;
    const requestSeq = ++attendanceRequestSeqRef.current;
    const controller = new AbortController();
    attendanceAbortRef.current = controller;
    try {
      // The live GPS screen only needs today's classes. Historical and future
      // records are loaded independently by the Attendance History calendar.
      const today = formatDateYMD(new Date());
      const headers = attendanceEtagRef.current ? { 'If-None-Match': attendanceEtagRef.current } : {};
      const response = await apiGet(`attendance?teacher_id=${userId}&date=${encodeURIComponent(today)}&include_avatar=0&operational_only=1`, {
        signal: controller.signal,
        headers,
        returnMeta: true,
      });
      if (requestSeq !== attendanceRequestSeqRef.current || response?.status === 304) return;
      const data = Array.isArray(response?.data) ? response.data : [];
      const etag = response?.headers?.get?.('ETag');
      if (etag) attendanceEtagRef.current = etag;
      let signature = '';
      try { signature = JSON.stringify(data); } catch (e) {}
      if (!signature || signature !== attendanceSignatureRef.current) {
        attendanceSignatureRef.current = signature;
        setRecords(data);
      }
      setErrorMessage(null);
    } catch (err) {
      if (err?.name !== 'AbortError' && !silent) {
        setErrorMessage(err && err.message ? `Network Error: ${err.message}` : 'Network Error');
      }
    } finally {
      if (requestSeq === attendanceRequestSeqRef.current) {
        isFetchingRef.current = false;
        attendanceAbortRef.current = null;
      }
    }
  }, [userId]);

  const acceptLocation = React.useCallback((newCoords) => {
    if (!newCoords) return;
    if (locationAutoRetryTimerRef.current !== null) {
      window.clearTimeout(locationAutoRetryTimerRef.current);
      locationAutoRetryTimerRef.current = null;
    }
    locationAutoRetryCountRef.current = 0;
    lastPositionAtRef.current = Date.now();
    locationRetryRequiredRef.current = false;
    locationPermissionRef.current = 'granted';
    setLocationPermission('granted');
    setLocationIssue(null);
    const last = lastCoordsRef.current;
    if (last) {
      const dist = getDistanceMeters(newCoords.latitude, newCoords.longitude, last.latitude, last.longitude);
      const previousAccuracy = Number(last.accuracy);
      const nextAccuracy = Number(newCoords.accuracy);
      const accuracyImproved = Number.isFinite(nextAccuracy)
        && (!Number.isFinite(previousAccuracy) || nextAccuracy < previousAccuracy);
      if (dist < LOCATION_DISTANCE_INTERVAL_METERS && !accuracyImproved) return;
    }
    lastCoordsRef.current = newCoords;
    setCoords(newCoords);
    setErrorMessage(null);
  }, []);

  const stopLocationTracking = React.useCallback(() => {
    locationTrackingActiveRef.current = false;
    if (watchIdRef.current !== null) {
      try { navigator.geolocation.clearWatch(watchIdRef.current); } catch (e) {}
      watchIdRef.current = null;
    }
  }, []);

  const handleLocationFailure = React.useCallback((error) => {
    const code = Number(error?.code);
    const rawMessage = String(error?.message || '');
    const normalizedMessage = rawMessage.toLowerCase();
    let type = 'unavailable';
    let message = 'Location is temporarily unavailable. Move near a window or open area, then press Turn on GPS.';

    if (code === 1) {
      type = 'permission-denied';
      message = 'Location permission is blocked. Allow Location for this website in your browser settings, then press Turn on GPS.';
      locationPermissionRef.current = 'denied';
      setLocationPermission('denied');
      void showLocationBlockedAlert();
    } else if (code === 3) {
      type = 'timeout';
      message = 'The location request timed out after 3 automatic retries. Check that device location is on, then press Turn on GPS.';
    } else if (
      normalizedMessage.includes('turned off')
      || normalizedMessage.includes('disabled')
      || normalizedMessage.includes('location service')
      || normalizedMessage.includes('location setting')
    ) {
      type = 'device-location-off';
      message = 'Device location appears to be turned off. Turn it on, then press Turn on GPS.';
    } else if (!('geolocation' in navigator)) {
      type = 'unsupported';
      message = 'This browser does not support location access.';
    }

    fallbackLocationInFlightRef.current = false;
    stopLocationTracking();
    if (code === 3 && gpsEnabledRef.current && !locationSuppressedRef.current && locationAutoRetryCountRef.current < MAX_LOCATION_AUTO_RETRIES) {
      locationAutoRetryCountRef.current += 1;
      locationRetryRequiredRef.current = false;
      setLocationIssue(null);
      if (locationAutoRetryTimerRef.current !== null) window.clearTimeout(locationAutoRetryTimerRef.current);
      locationAutoRetryTimerRef.current = window.setTimeout(() => {
        locationAutoRetryTimerRef.current = null;
        if (!gpsEnabledRef.current || locationSuppressedRef.current || document.visibilityState !== 'visible' || navigator.onLine === false) return;
        lastPositionAtRef.current = Date.now();
        if (typeof startLocationTrackingRef.current === 'function') startLocationTrackingRef.current();
      }, LOCATION_AUTO_RETRY_DELAY_MS);
      return;
    }

    locationAutoRetryCountRef.current = 0;
    locationRetryRequiredRef.current = true;
    gpsEnabledRef.current = false;
    setGpsEnabled(false);
    setLocationIssue({ type, message });
  }, [showLocationBlockedAlert, stopLocationTracking]);

  const startLocationTracking = React.useCallback(() => {
    if (locationSuppressedRef.current || !gpsEnabledRef.current) return;
    if (!('geolocation' in navigator)) {
      handleLocationFailure({ code: 0, message: 'Geolocation is not supported.' });
      return;
    }
    if (watchIdRef.current !== null) return;
    try {
      lastPositionAtRef.current = Date.now();
      locationTrackingActiveRef.current = true;
      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          if (!locationTrackingActiveRef.current) return;
          acceptLocation(pos.coords);
        },
        (err) => {
          if (!locationTrackingActiveRef.current) return;
          handleLocationFailure(err);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    } catch (err) {
      handleLocationFailure({ code: 0, message: err?.message || String(err) });
    }
  }, [acceptLocation, handleLocationFailure]);
  startLocationTrackingRef.current = startLocationTracking;

  const retryLocationTracking = React.useCallback(async () => {
    gpsEnabledRef.current = true;
    setGpsEnabled(true);
    locationAutoRetryCountRef.current = 0;
    if (locationAutoRetryTimerRef.current !== null) {
      window.clearTimeout(locationAutoRetryTimerRef.current);
      locationAutoRetryTimerRef.current = null;
    }
    stopLocationTracking();
    fallbackLocationInFlightRef.current = false;
    setLocationIssue(null);

    if (locationPermissionRef.current === 'denied' && navigator.permissions?.query) {
      try {
        const permission = await navigator.permissions.query({ name: 'geolocation' });
        locationPermissionRef.current = permission.state;
        setLocationPermission(permission.state);
        if (permission.state === 'denied') {
          gpsEnabledRef.current = false;
          setGpsEnabled(false);
          locationRetryRequiredRef.current = true;
          setLocationIssue({
            type: 'permission-denied',
            message: 'Location permission is blocked. Allow Location for this website in your browser settings, then press Turn on GPS.',
          });
          locationBlockedAlertShownRef.current = false;
          void showLocationBlockedAlert();
          return;
        }
      } catch (error) {
        // The geolocation request below remains the source of truth when Permissions API is unavailable.
      }
    }

    locationRetryRequiredRef.current = false;
    lastPositionAtRef.current = Date.now();
    startLocationTracking();
  }, [showLocationBlockedAlert, startLocationTracking, stopLocationTracking]);

  const toggleGpsTracking = React.useCallback(async () => {
    if (gpsEnabledRef.current) {
      gpsEnabledRef.current = false;
      setGpsEnabled(false);
      locationRetryRequiredRef.current = true;
      locationAutoRetryCountRef.current = 0;
      fallbackLocationInFlightRef.current = false;
      if (locationAutoRetryTimerRef.current !== null) {
        window.clearTimeout(locationAutoRetryTimerRef.current);
        locationAutoRetryTimerRef.current = null;
      }
      stopLocationTracking();
      lastCoordsRef.current = null;
      lastPositionAtRef.current = 0;
      setCoords(null);
      setLocationIssue({ type: 'gps-off', message: 'GPS tracking is turned off. Press Turn on GPS to continue.' });
      return;
    }
    await retryLocationTracking();
  }, [retryLocationTracking, stopLocationTracking]);

  React.useEffect(() => {
    if (!userId) return undefined;
    let mounted = true;
    let permissionStatus = null;

    const applyPermissionState = async (state) => {
      if (!mounted) return;
      const nextState = state || 'unknown';
      locationPermissionRef.current = nextState;
      setLocationPermission(nextState);

      if (nextState === 'denied') {
        handleLocationFailure({ code: 1, message: 'Location permission denied.' });
        return;
      }

      if (nextState === 'prompt') {
        gpsEnabledRef.current = false;
        setGpsEnabled(false);
        locationRetryRequiredRef.current = true;
        setLocationIssue({
          type: 'permission-required',
          message: 'Location permission is required for attendance. Select Enable Location to continue.',
        });
        const shouldEnable = await showLocationRequiredAlert();
        if (!mounted) return;
        if (shouldEnable) {
          await retryLocationTracking();
        }
      }
    };

    if (!('geolocation' in navigator)) {
      locationPermissionRef.current = 'unsupported';
      setLocationPermission('unsupported');
      handleLocationFailure({ code: 0, message: 'Geolocation is not supported.' });
      return () => { mounted = false; };
    }

    if (!navigator.permissions?.query) {
      locationPermissionRef.current = 'unknown';
      setLocationPermission('unknown');
      return () => { mounted = false; };
    }

    navigator.permissions.query({ name: 'geolocation' })
      .then((status) => {
        if (!mounted) return;
        permissionStatus = status;
        void applyPermissionState(status.state);
        status.onchange = () => { void applyPermissionState(status.state); };
      })
      .catch(() => {
        if (!mounted) return;
        locationPermissionRef.current = 'unknown';
        setLocationPermission('unknown');
      });

    return () => {
      mounted = false;
      if (permissionStatus) permissionStatus.onchange = null;
    };
  }, [userId, handleLocationFailure, retryLocationTracking, showLocationRequiredAlert]);

  React.useEffect(() => {
    const update = () => {
      const visible = document.visibilityState === 'visible';
      const online = navigator.onLine !== false;
      const permissionAllowsStart = locationPermission === 'granted' || locationPermission === 'unknown';
      if (userId && gpsEnabled && visible && online && !isCameraVisible && permissionAllowsStart && !locationRetryRequiredRef.current) startLocationTracking();
      else stopLocationTracking();
    };
    update();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      stopLocationTracking();
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [userId, gpsEnabled, isCameraVisible, locationPermission, startLocationTracking, stopLocationTracking]);

  React.useEffect(() => {
    if (!userId || !('geolocation' in navigator)) return undefined;
    const timer = window.setInterval(() => {
      const active = document.visibilityState === 'visible'
        && navigator.onLine !== false
        && !isCameraVisible
        && !locationSuppressedRef.current
        && !locationRetryRequiredRef.current;
      if (!active || fallbackLocationInFlightRef.current || Date.now() - lastPositionAtRef.current < 5000) return;
      fallbackLocationInFlightRef.current = true;
      try {
        navigator.geolocation.getCurrentPosition(
          pos => {
            fallbackLocationInFlightRef.current = false;
            if (locationTrackingActiveRef.current) acceptLocation(pos.coords);
          },
          error => {
            fallbackLocationInFlightRef.current = false;
            if (locationTrackingActiveRef.current) handleLocationFailure(error);
          },
          { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
        );
      } catch (e) { fallbackLocationInFlightRef.current = false; }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [userId, isCameraVisible, acceptLocation, handleLocationFailure]);

  React.useEffect(() => () => {
    if (locationAutoRetryTimerRef.current !== null) window.clearTimeout(locationAutoRetryTimerRef.current);
  }, []);

  React.useEffect(() => {
    if (!userId) return undefined;
    attendanceEtagRef.current = '';
    attendanceSignatureRef.current = '';
    loadMyAttendance();
    return () => {
      attendanceRequestSeqRef.current += 1;
      isFetchingRef.current = false;
      if (attendanceAbortRef.current) attendanceAbortRef.current.abort();
    };
  }, [userId, loadMyAttendance]);

  useAutoRefresh({
    refresh: () => loadMyAttendance({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.LIVE,
    enabled: Boolean(userId) && !isCameraVisible,
  });

  const detectFloorFromAltitude = React.useCallback((alt, buildingId = null) => {
    if (alt == null || !floors.length) return null;
    const candidates = buildingId ? floors.filter(f => f.building_id === buildingId) : floors;
    if (!candidates.length) return null;
    let best = null;
    for (const f of candidates) {
      if (f.baseline_altitude == null) continue;
      const diff = Math.abs(Number(f.baseline_altitude) - Number(alt));
      if (!best || diff < best.diff) {
        best = { diff, floor: f };
      }
    }
    return best ? best.floor : null;
  }, [floors]);

  const getActiveSchedules = React.useCallback(() => {
    const now = new Date();
    const todayStr = formatDateYMD(now);
    const todays = records.filter(r => r.date === todayStr);
    return todays.filter(r => isRecordActiveNow(r, now));
  }, [records]);

  const isUpcomingWithinWindow = React.useCallback((record, windowMinutes = 30) => {
    if (!record?.date || !record?.start_time) return false;
    const now = new Date();
    const todayStr = formatDateYMD(now);
    if (record.date !== todayStr) return false;
    const start = new Date(`${record.date}T${record.start_time}`);
    const diffMs = start.getTime() - now.getTime();
    const diffMinutes = diffMs / 60000;
    return diffMinutes > 0 && diffMinutes <= windowMinutes;
  }, []);

  const pickScheduleByLocation = React.useCallback((items) => {
    if (!Array.isArray(items) || !items.length) return null;

    const roomFor = (rec) => rooms.find(r => Number(r.room_id) === Number(rec.room_id)) || null;

    if (coords) {
      let best = null;
      for (const rec of items) {
        const room = roomFor(rec);
        if (!room || room.latitude == null || room.longitude == null) continue;
        if (scannedFloor && Number(room.floor_id) !== Number(scannedFloor.floor_id)) continue;
        if (!isInsideBox(coords, room)) continue;
        const dist = getDistanceMeters(coords.latitude, coords.longitude, Number(room.latitude), Number(room.longitude));
        if (!best || dist < best.dist) best = { rec, dist };
      }
      if (best) return best.rec;
    }

    if (scannedFloor) {
      const onScannedFloor = items.find(rec => {
        const room = roomFor(rec);
        return room && Number(room.floor_id) === Number(scannedFloor.floor_id);
      });
      if (onScannedFloor) return onScannedFloor;
    }

    if (coords) {
      let best = null;
      for (const rec of items) {
        const room = roomFor(rec);
        if (!room || room.latitude == null || room.longitude == null) continue;
        if (!isInsideBox(coords, room)) continue;
        const dist = getDistanceMeters(coords.latitude, coords.longitude, Number(room.latitude), Number(room.longitude));
        if (!best || dist < best.dist) best = { rec, dist };
      }
      if (best) return best.rec;
    }

    return items[0];
  }, [coords, rooms, scannedFloor]);

  const findActiveSchedule = React.useCallback(() => {
    return pickScheduleByLocation(getActiveSchedules());
  }, [getActiveSchedules, pickScheduleByLocation]);

  // Get upcoming schedules that start within 30 minutes
  const getUpcomingSchedules = React.useCallback(() => {
    if (!Array.isArray(records)) return [];
    const now = new Date();
    const todayStr = formatDateYMD(now);
    const todays = records.filter(r => r.date === todayStr);
    return todays.filter(r => isUpcomingWithinWindow(r, 30));
  }, [records, isUpcomingWithinWindow]);

  // Find the best target schedule: active first, then upcoming within 30 min window
  const findTargetSchedule = React.useCallback(() => {
    const active = findActiveSchedule();
    if (active) return active;
    const upcoming = getUpcomingSchedules();
    if (upcoming.length > 0) {
      return pickScheduleByLocation(upcoming);
    }
    return null;
  }, [findActiveSchedule, getUpcomingSchedules, pickScheduleByLocation]);

  const findMatchingScheduleGroup = React.useCallback((base) => {
    if (!base) return [];
    return getActiveSchedules().filter(r => isSameScheduleGroup(r, base));
  }, [getActiveSchedules]);

  // Find matching group for upcoming schedules too (for QR validation)
  const findTargetScheduleGroup = React.useCallback((base) => {
    if (!base) return [];
    const active = getActiveSchedules().filter(r => isSameScheduleGroup(r, base));
    if (active.length > 0) return active;
    const upcoming = getUpcomingSchedules().filter(r => isSameScheduleGroup(r, base));
    return upcoming;
  }, [getActiveSchedules, getUpcomingSchedules]);

  const activeSchedule = React.useMemo(() => findActiveSchedule(), [findActiveSchedule, scheduleEpoch]);
  const activeAttendanceOnLeave = isOnLeaveRecord(activeSchedule);
  const activeAttendanceBlocked = isAttendanceExemptRecord(activeSchedule);

  React.useEffect(() => {
    locationSuppressedRef.current = activeAttendanceBlocked;
    if (activeAttendanceBlocked) {
      stopLocationTracking();
      setWrongFloorInfo(null);
      setErrorMessage(previous => {
        const message = String(previous || '').toLowerCase();
        return message.includes('gps') || message.includes('geolocation') || message.includes('wrong_floor')
          ? null
          : previous;
      });
      return;
    }
    const permissionAllowsStart = locationPermission === 'granted' || locationPermission === 'unknown';
    if (userId && gpsEnabled && document.visibilityState === 'visible' && navigator.onLine !== false && !isCameraVisible && permissionAllowsStart && !locationRetryRequiredRef.current) {
      startLocationTracking();
    }
  }, [activeAttendanceBlocked, userId, gpsEnabled, isCameraVisible, locationPermission, startLocationTracking, stopLocationTracking]);

  const activeScheduleGroup = React.useMemo(() => (
    activeSchedule ? findMatchingScheduleGroup(activeSchedule) : []
  ), [activeSchedule, findMatchingScheduleGroup]);

  // targetSchedule = active OR upcoming within 30 min (for QR validation)
  const targetSchedule = React.useMemo(() => findTargetSchedule(), [findTargetSchedule, scheduleEpoch]);
  const targetScheduleGroup = React.useMemo(() => (
    targetSchedule ? findTargetScheduleGroup(targetSchedule) : []
  ), [targetSchedule, findTargetScheduleGroup]);

  const getScheduleRoomName = React.useCallback((record) => {
    if (!record) return '';
    if (record.room_name) return String(record.room_name);
    const room = rooms.find(r => Number(r.room_id) === Number(record.room_id));
    return room?.room_name ? String(room.room_name) : '';
  }, [rooms]);

  const getParallelRoomNames = React.useCallback((record) => {
    if (!record) return [];
    const seen = new Set();
    return records
      .filter(other => {
        if (!other || !isParallelSchedulePair(other, record)) return false;
        const sameAttendance = other.attendance_id && record.attendance_id && String(other.attendance_id) === String(record.attendance_id);
        return !sameAttendance;
      })
      .map(getScheduleRoomName)
      .filter(name => {
        const key = name.trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [records, getScheduleRoomName]);

  const activeOtherParallelRoomNames = React.useMemo(() => (
    activeSchedule ? getParallelRoomNames(activeSchedule) : []
  ), [activeSchedule, getParallelRoomNames]);

  const activeParallelRoomNames = React.useMemo(() => {
    if (!activeSchedule || activeOtherParallelRoomNames.length === 0) return [];
    const seen = new Set();
    return [getScheduleRoomName(activeSchedule), ...activeOtherParallelRoomNames]
      .filter(name => {
        const key = name.trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [activeSchedule, activeOtherParallelRoomNames, getScheduleRoomName]);

  const currentRoomObj = React.useMemo(() => {
    return activeSchedule ? rooms.find(r => Number(r.room_id) === Number(activeSchedule.room_id)) || null : null;
  }, [activeSchedule, rooms]);

  const scheduledGroupRooms = React.useMemo(() => {
    if (!activeSchedule || !Array.isArray(rooms)) return [];
    const group = (activeScheduleGroup.length > 0 ? activeScheduleGroup : [activeSchedule])
      .filter(record => !isAttendanceExemptRecord(record));
    const seen = new Set();
    return group.map(record => rooms.find(room => Number(room.room_id) === Number(record.room_id)) || null)
      .filter(room => {
        if (!room) return false;
        const key = String(room.room_id ?? '');
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [activeSchedule, activeScheduleGroup, rooms]);

  const scheduledGroupBuildings = React.useMemo(() => {
    if (!activeSchedule || !Array.isArray(buildings)) return [];
    const allowedIds = new Set(scheduledGroupRooms.map(room => String(room.building_id ?? '')).filter(Boolean));
    return buildings.filter(building => allowedIds.has(String(building.building_id ?? '')));
  }, [activeSchedule, buildings, scheduledGroupRooms]);

  const scheduledBuildingObj = React.useMemo(() => {
    if (!currentRoomObj || !Array.isArray(buildings)) return null;
    return buildings.find(b => Number(b.building_id) === Number(currentRoomObj.building_id)) || null;
  }, [currentRoomObj, buildings]);

  const scheduledFloorObj = React.useMemo(() => {
    if (!currentRoomObj || !Array.isArray(floors)) return null;
    return floors.find(f => Number(f.floor_id) === Number(currentRoomObj.floor_id)) || null;
  }, [currentRoomObj, floors]);

  const attendanceLocationOperational = React.useMemo(() => {
    const isActive = (item) => ['active', '1', 'true'].includes(String(item?.status || '').trim().toLowerCase());
    return Boolean(currentRoomObj && scheduledFloorObj && scheduledBuildingObj
      && isActive(currentRoomObj)
      && isActive(scheduledFloorObj)
      && isActive(scheduledBuildingObj));
  }, [currentRoomObj, scheduledFloorObj, scheduledBuildingObj]);

  const altitudeCalibrationBuildingId = React.useMemo(() => {
    const id = scannedFloor?.building_id ?? currentRoomObj?.building_id ?? currentBuilding?.building_id ?? scheduledBuildingObj?.building_id ?? null;
    const n = toFiniteNumber(id);
    return n !== null ? Number(n) : null;
  }, [scannedFloor, currentRoomObj, currentBuilding, scheduledBuildingObj]);

  const rawAltitude = React.useMemo(() => toFiniteNumber(coords?.altitude), [coords]);

  React.useEffect(() => {
    setAltitudeCalibration(readAltitudeCalibration(devicePlatform, altitudeCalibrationBuildingId));
  }, [devicePlatform, altitudeCalibrationBuildingId]);

  React.useEffect(() => {
    if (devicePlatform !== 'ios' || !scannedFloor) return;
    const baseline = toFiniteNumber(scannedFloor.baseline_altitude);
    if (baseline === null || rawAltitude === null) return;

    const offset = baseline - rawAltitude;
    if (!Number.isFinite(offset) || Math.abs(offset) > IOS_CALIBRATION_MAX_OFFSET_METERS) return;

    const calibration = {
      platform: devicePlatform,
      building_id: altitudeCalibrationBuildingId,
      floor_id: scannedFloor.floor_id ?? null,
      offset,
      raw_altitude: rawAltitude,
      baseline_altitude: baseline,
      updated_at: Date.now()
    };

    saveAltitudeCalibration(calibration);
    setAltitudeCalibration(prev => {
      const prevOffset = toFiniteNumber(prev?.offset);
      if (
        prev &&
        prevOffset !== null &&
        Math.abs(prevOffset - offset) < 1 &&
        String(prev.floor_id || '') === String(calibration.floor_id || '')
      ) {
        return prev;
      }
      return calibration;
    });
  }, [devicePlatform, scannedFloor, rawAltitude, altitudeCalibrationBuildingId]);

  const attendanceAltitude = React.useMemo(() => {
    const info = {
      platform: devicePlatform,
      building_id: altitudeCalibrationBuildingId,
      raw: rawAltitude,
      normalized: rawAltitude,
      offset: null,
      source: 'raw',
      calibrated: false
    };

    if (devicePlatform !== 'ios') return info;

    const scannedBaseline = toFiniteNumber(scannedFloor?.baseline_altitude);
    if (scannedBaseline !== null) {
      if (rawAltitude === null) {
        return {
          ...info,
          normalized: scannedBaseline,
          source: 'ios_scanned_floor',
          calibrated: true
        };
      }
      const offset = scannedBaseline - rawAltitude;
      if (Number.isFinite(offset) && Math.abs(offset) <= IOS_CALIBRATION_MAX_OFFSET_METERS) {
        return {
          ...info,
          normalized: rawAltitude + offset,
          offset,
          source: 'ios_scanned_floor',
          calibrated: true
        };
      }
    }

    if (rawAltitude === null) return info;

    const storedOffset = toFiniteNumber(altitudeCalibration?.offset);
    if (storedOffset !== null && Math.abs(storedOffset) <= IOS_CALIBRATION_MAX_OFFSET_METERS) {
      return {
        ...info,
        normalized: rawAltitude + storedOffset,
        offset: storedOffset,
        source: 'ios_saved_offset',
        calibrated: true
      };
    }

    return info;
  }, [devicePlatform, altitudeCalibrationBuildingId, rawAltitude, scannedFloor, altitudeCalibration]);

  React.useEffect(() => {
    if (!coords || !Array.isArray(buildings) || buildings.length === 0) { setCurrentBuilding(null); return; }
    const findNearestContainingBuilding = (candidates) => {
      let nearest = null;
      for (const building of candidates) {
        const status = String(building?.status || '').trim().toLowerCase();
        if (status && !['active', '1', 'true'].includes(status)) continue;
        const latitude = building.latitude ?? building.lat ?? null;
        const longitude = building.longitude ?? building.lon ?? building.lng ?? null;
        const radius = Number(building.radius ?? building.building_radius ?? 0);
        if (latitude == null || longitude == null || !Number.isFinite(radius) || radius <= 0) continue;
        const distance = getDistanceMeters(coords.latitude, coords.longitude, Number(latitude), Number(longitude));
        if (distance <= radius && (!nearest || distance < nearest.dist)) nearest = { building, dist: distance };
      }
      return nearest;
    };

    // An assigned solo/parallel building takes priority when GPS areas overlap.
    // Another building is retained only to explain that it is not scheduled.
    if (activeSchedule && scheduledGroupBuildings.length > 0) {
      const scheduledMatch = findNearestContainingBuilding(scheduledGroupBuildings);
      if (scheduledMatch) {
        setCurrentBuilding(scheduledMatch.building);
        return;
      }
    }

    const best = findNearestContainingBuilding(buildings);
    setCurrentBuilding(best ? best.building : null);
  }, [coords, buildings, activeSchedule, scheduledGroupBuildings]);

  const findNearestRoom = React.useCallback((coords) => {
    if (!coords || !rooms.length) return null;
    const buildingIdToUse = scannedFloor?.building_id ?? currentBuilding?.building_id ?? scheduledBuildingObj?.building_id ?? null;
    let candidates = rooms.filter(room => {
      if (!room) return false;
      if (buildingIdToUse && Number(room.building_id) !== Number(buildingIdToUse)) return false;
      return isInsideBox(coords, room);
    });

    if (scannedFloor) {
      candidates = candidates.filter(r => String(r.floor_id) === String(scannedFloor.floor_id));
      const NEAREST_FALLBACK_METERS = 100;
      if (!candidates.length) {
        const within = [];
        for (const room of rooms) {
          if (String(room.floor_id) !== String(scannedFloor.floor_id)) continue;
          if (room.latitude == null || room.longitude == null) continue;
          const d = getDistanceMeters(coords.latitude, coords.longitude, room.latitude, room.longitude);
          if (d <= NEAREST_FALLBACK_METERS) within.push({ room, dist: d });
        }
        if (within.length) {
          within.sort((a,b)=> a.dist - b.dist);
          candidates = within.map(w => w.room);
        } else {
          return null;
        }
      }
    } else {
      const NEAREST_FALLBACK_METERS = 100;
      if (!candidates.length) {
        const within = [];
        for (const room of rooms) {
          if (room.latitude == null || room.longitude == null) continue;
          const d = getDistanceMeters(coords.latitude, coords.longitude, room.latitude, room.longitude);
          if (d <= NEAREST_FALLBACK_METERS) within.push({ room, dist: d });
        }
        if (within.length) {
          within.sort((a,b)=> a.dist - b.dist);
          candidates = within.map(w => w.room);
        } else {
          let best = null; let bestDist = Infinity;
          for (const room of rooms) {
            if (room.latitude == null || room.longitude == null) continue;
            const d = getDistanceMeters(coords.latitude, coords.longitude, room.latitude, room.longitude);
            if (d < bestDist) { bestDist = d; best = room; }
          }
          return best;
        }
      }
    }

    const alt = scannedFloor && scannedFloor.baseline_altitude != null
      ? Number(scannedFloor.baseline_altitude)
      : attendanceAltitude.normalized;
    if (alt != null && Array.isArray(floors) && floors.length) {
      const preferred = [];
        
      for (const room of candidates) {
        const roomFloor = room.floor_id ? floors.find(f => f.floor_id === room.floor_id) : null;
        const buildingId = room.building_id || (roomFloor ? roomFloor.building_id : null);
        
        let baseline = null;
        let vertical = null;

        if (roomFloor && roomFloor.baseline_altitude != null) {
          baseline = Number(roomFloor.baseline_altitude);
          vertical = roomFloor.floor_meter_vertical != null ? Number(roomFloor.floor_meter_vertical) : null;
        } else if (buildingId) {
          const matchedFloor = detectFloorFromAltitude(alt, buildingId);
          if (matchedFloor && matchedFloor.floor_id === room.floor_id && matchedFloor.baseline_altitude != null) {
            baseline = Number(matchedFloor.baseline_altitude);
            vertical = matchedFloor.floor_meter_vertical != null ? Number(matchedFloor.floor_meter_vertical) : null;
          }
        }

        if (baseline != null) {
          const diff = Math.abs(baseline - Number(alt));
          const tolerance = vertical != null ? vertical / 2 : 1.5;
            
          if (diff <= tolerance) {
            const dist = getDistanceMeters(coords.latitude, coords.longitude, room.latitude, room.longitude);
            preferred.push({ room, dist });
          }
        }
      }

      if (preferred.length) {
        preferred.sort((a, b) => a.dist - b.dist);
        return preferred[0].room;
      }
    }

    let best = null;
    let bestDist = Infinity;
    for (const room of candidates) {
      const d = getDistanceMeters(coords.latitude, coords.longitude, room.latitude, room.longitude);
      if (d < bestDist) {
        bestDist = d;
        best = room;
      }
    }
    return best;
  }, [rooms, floors, detectFloorFromAltitude, scannedFloor, currentBuilding, scheduledBuildingObj, attendanceAltitude]);

  const getNearestRoomLabel = (coords) => {
    if (!coords) return { name: 'X', floor: 'X', building: 'X' };
    if (!currentBuilding && !scannedFloor && !usingDbFloor && !detectedFloor) {
      return { name: 'X', floor: 'X', building: 'X' };
    }
    const room = findNearestRoom(coords);
    if (!room) {
      return scannedFloor
        ? { name: 'No nearby room found on scanned floor', floor: scannedFloor.floor_name || 'Scanned floor', building: 'X' }
        : { name: 'X', floor: 'X', building: 'X' };
    }
    if (scannedFloor && String(room.floor_id) !== String(scannedFloor.floor_id)) {
      return { name: 'No nearby room found on scanned floor', floor: scannedFloor.floor_name || 'Scanned floor', building: 'X' };
    }
    const dist = getDistanceMeters(coords.latitude, coords.longitude, room.latitude, room.longitude);
    const roomFloor = (room.floor_id && floors.length) ? floors.find(f => f.floor_id === room.floor_id) : null;
    const floorName = scannedFloor ? (scannedFloor.floor_name || 'X') : (roomFloor ? roomFloor.floor_name : (detectFloorFromAltitude(attendanceAltitude.normalized, room.building_id)?.floor_name || 'X'));
    const buildingObj = buildings.find(b => Number(b.building_id) === Number(room.building_id)) || currentBuilding || null;
    const buildingName = buildingObj ? (buildingObj.building_name || 'X') : 'X';
    return { name: `${room.room_name || 'Unnamed'} (${Math.round(dist)}m)`, floor: floorName, building: buildingName };
  };

  React.useEffect(() => {
    if (!('permissions' in navigator)) return;
    let mounted = true;
    try {
      navigator.permissions.query({ name: 'camera' }).then(status => {
        if (!mounted) return;
        setCameraPermission(status.state || 'prompt');
        status.onchange = () => { if (mounted) setCameraPermission(status.state || 'prompt'); };
      }).catch(() => {});
    } catch (e) {}
    return () => { mounted = false; };
  }, []);

  const computeActionState = React.useCallback((rec, group = null) => {
    if (!rec) return { allowed: false, action: null, allowAt: null, predictedFlag: null };
    if (isAttendanceExemptRecord(rec)) {
      return {
        allowed: false,
        action: null,
        allowAt: null,
        predictedFlag: null,
        substituted: isSubstitutedRecord(rec),
        onLeave: isOnLeaveRecord(rec),
      };
    }
    const now = new Date();
    const classStart = new Date(`${rec.date}T${rec.start_time}`);
    const classEnd = new Date(`${rec.date}T${rec.end_time}`);
    const groupRecords = (Array.isArray(group) && group.length ? group : [rec])
      .filter(item => !isAttendanceExemptRecord(item));

    let action = null;
    if (groupRecords.some(item => !item.time_in)) action = 'check-in';
    else if (groupRecords.some(item => !item.time_check)) action = 'mid-check';
    else if (groupRecords.some(item => !item.time_out)) action = 'check-out';
    else return { allowed: false, action: null, allowAt: null, predictedFlag: null };

    if (action === 'check-in') {
      if (now < classStart) return { allowed: false, allowAt: classStart.toISOString(), action, predictedFlag: null };
      const presentEnd = new Date(classStart.getTime() + 15 * 60000);
      const predictedFlag = now <= presentEnd ? 'present' : 'late';
      return { allowed: true, allowAt: null, action, predictedFlag };
    }

    if (action === 'mid-check') {
      const center = new Date(classStart.getTime() + (classEnd.getTime() - classStart.getTime()) / 2);
      const midStart = new Date(center.getTime() - 10 * 60000);
      if (now < midStart) return { allowed: false, allowAt: midStart.toISOString(), action, predictedFlag: null };
      const predictedFlag = (now >= midStart && now <= new Date(center.getTime() + 10 * 60000)) ? 'present' : 'late';
      return { allowed: true, allowAt: null, action, predictedFlag };
    }

    const outStart = new Date(classEnd.getTime() - 15 * 60000);
    if (now < outStart) return { allowed: false, allowAt: outStart.toISOString(), action, predictedFlag: null };
    if (now > classEnd) return { allowed: false, allowAt: null, action, predictedFlag: null };
    return { allowed: true, allowAt: null, action, predictedFlag: 'present' };
  }, []);

  const nextScheduleState = React.useMemo(() => {
    if (!records || !records.length) return { schedule: null, startDate: null };
    const now = new Date();
    let best = null;
    let bestStart = null;

    for (const r of records) {
      const st = new Date(`${r.date}T${r.start_time}`);
      if (st.getTime() >= now.getTime()) {
        if (!bestStart || st < bestStart) {
          best = r;
          bestStart = st;
        }
      }
    }

    return { schedule: best, startDate: bestStart };
  }, [records, scheduleEpoch]);
  const nextSchedule = nextScheduleState.schedule;
  const nextStartDate = nextScheduleState.startDate;

  React.useEffect(() => {
    const active = findActiveSchedule();
    const group = active ? findMatchingScheduleGroup(active) : [];
    const st = computeActionState(active, group);
    setActionAllowed(st.allowed);
    setAllowAt(st.allowAt);
    setCurrentAction(st.action);
  }, [records, scheduleEpoch, findActiveSchedule, findMatchingScheduleGroup, computeActionState]);

  const filteredRecords = React.useMemo(() => {
    if (!Array.isArray(records)) return [];
    const now = new Date();
    const todayStr = formatDateYMD(now);
    const activeFirst = (list) => list
      .map((record, index) => ({ record, index, active: isRecordActiveNow(record, now) }))
      .sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return a.index - b.index;
      })
      .map(item => item.record);
    try {
      return activeFirst(records.filter(r => r.date === todayStr));
    } catch (e) {
      return [];
    }
  }, [records, scheduleEpoch]);

  const matchedScheduledRoom = React.useMemo(() => {
    if (!coords || scheduledGroupRooms.length === 0) return null;
    let nearest = null;
    for (const room of scheduledGroupRooms) {
      if (!isInsideBox(coords, room)) continue;
      const distance = getDistanceMeters(coords.latitude, coords.longitude, Number(room.latitude), Number(room.longitude));
      if (!nearest || distance < nearest.distance) nearest = { room, distance };
    }
    return nearest?.room || null;
  }, [coords, scheduledGroupRooms]);

  const currentDist = React.useMemo(() => {
    if (!coords || scheduledGroupRooms.length === 0) return null;
    const distances = scheduledGroupRooms
      .filter(room => room.latitude != null && room.longitude != null)
      .map(room => getDistanceMeters(coords.latitude, coords.longitude, Number(room.latitude), Number(room.longitude)));
    return distances.length > 0 ? Math.min(...distances) : null;
  }, [coords, scheduledGroupRooms]);

  const isOutOfRange = Boolean(currentRoomObj && !matchedScheduledRoom);

  const scannedFloorInRange = React.useMemo(() => {
    try {
      if (!scannedFloor || !coords) return false;
      const base = (scannedFloor.baseline_altitude != null) ? Number(scannedFloor.baseline_altitude) : null;
      const vert = (scannedFloor.floor_meter_vertical != null) ? Number(scannedFloor.floor_meter_vertical) : null;
      if (base == null || vert == null) return false;
      const min = base - vert;
      const max = base + vert;
      const alt = attendanceAltitude.normalized;
      if (alt == null) return false;
      return alt >= min && alt <= max;
    } catch (e) { return false; }
  }, [scannedFloor, coords, attendanceAltitude]);

  const scannedFloorRange = React.useMemo(() => {
    if (!scannedFloor) return null;
    const base = (scannedFloor.baseline_altitude != null) ? Number(scannedFloor.baseline_altitude) : null;
    const vert = (scannedFloor.floor_meter_vertical != null) ? Number(scannedFloor.floor_meter_vertical) : null;
    if (base == null || vert == null) return null;
    return { min: base - vert, max: base + vert, base };
  }, [scannedFloor]);

  const altDetectedFloor = React.useMemo(() => {
    if (!coords || attendanceAltitude.normalized === null) return null;
    const bId = currentBuilding && currentBuilding.building_id ? Number(currentBuilding.building_id) : null;
    return detectFloorFromAltitude(attendanceAltitude.normalized, bId);
  }, [coords, attendanceAltitude, detectFloorFromAltitude, currentBuilding]);

  const scheduledBuildingRange = React.useMemo(() => {
    if (!activeSchedule || !coords || scheduledGroupBuildings.length === 0) return null;
    let nearest = null;
    for (const building of scheduledGroupBuildings) {
      const latitude = Number(building.latitude ?? building.lat);
      const longitude = Number(building.longitude ?? building.lon ?? building.lng);
      const radius = Number(building.radius ?? building.building_radius ?? 0);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(radius) || radius <= 0) continue;
      const distance = getDistanceMeters(coords.latitude, coords.longitude, latitude, longitude);
      const candidate = { building, distance, outsideBy: Math.max(0, distance - radius), inside: distance <= radius };
      if (!nearest || candidate.outsideBy < nearest.outsideBy || (candidate.outsideBy === nearest.outsideBy && distance < nearest.distance)) nearest = candidate;
    }
    return nearest;
  }, [activeSchedule, coords, scheduledGroupBuildings]);

  const isOutsideBuilding = Boolean(currentRoomObj && scheduledBuildingRange && !scheduledBuildingRange.inside);
  const detectedDifferentBuilding = React.useMemo(() => {
    if (!isOutsideBuilding || !currentBuilding) return null;
    const isAllowed = scheduledGroupBuildings.some(building => Number(building.building_id) === Number(currentBuilding.building_id));
    return isAllowed ? null : currentBuilding;
  }, [isOutsideBuilding, currentBuilding, scheduledGroupBuildings]);

  const notInAnyBuilding = React.useMemo(() => (
    !activeSchedule && !currentBuilding && Array.isArray(buildings) && buildings.length > 0
  ), [activeSchedule, currentBuilding, buildings]);

  const renderWrongFloorMessage = () => {
    const info = wrongFloorInfo;
    if (!info && (!errorMessage || !String(errorMessage).includes('wrong_floor'))) return null;

    if (info) {
      const floorId = info.expected_floor_id || info.floor_id || null;
      const floorObj = floorId && Array.isArray(floors) ? floors.find(f => Number(f.floor_id) === Number(floorId)) : null;
      const floorName = floorObj ? (floorObj.floor_name || `Floor ${floorId}`) : (info.expected_floor_name || 'the expected floor');
      const minAlt = (info.min_altitude != null) ? Number(info.min_altitude).toFixed(1) : null;
      const maxAlt = (info.max_altitude != null) ? Number(info.max_altitude).toFixed(1) : null;
      const detected = (info.detected_altitude != null) ? Number(info.detected_altitude).toFixed(1) : (attendanceAltitude.normalized !== null ? Number(attendanceAltitude.normalized).toFixed(1) : 'N/A');

      return (
        <div style={{ padding: 10, backgroundColor: '#fff3cd', color: '#856404', borderRadius: 5, margin: '10px 0', textAlign: 'center', border: '1px solid #ffeeba' }}>
          <div>You appear to be on a different floor.</div>
          <div>Expected: {floorName} — altitude range {minAlt !== null ? `${minAlt}m` : 'N/A'} to {maxAlt !== null ? `${maxAlt}m` : 'N/A'}</div>
          <div>Your altitude: {detected}m</div>
        </div>
      );
    }
    return (
      <div style={{ padding: 10, backgroundColor: '#fff3cd', color: '#856404', borderRadius: 5, margin: '10px 0', textAlign: 'center', border: '1px solid #ffeeba' }}>
        Your device altitude indicates you may be on a different floor. Move to the correct floor or contact the administrator.
      </div>
    );
  };

  const openScannerWithPermission = async () => {
    const rec = findTargetSchedule();
    if (isAttendanceExemptRecord(rec)) {
      const onLeave = isOnLeaveRecord(rec);
      await showAttendanceToast({
        icon: 'info',
        title: onLeave ? 'On Leave' : 'Attendance Transferred',
        text: onLeave
          ? 'This class is covered by your approved leave. GPS, room-range checks, and QR scanning are not required.'
          : 'This class attendance has been assigned to a substitute teacher. No attendance action is required from you.',
        timer: 3500,
      });
      return;
    }
    if (!rec) return;
    setQrVerificationMode('scan');
    setManualFloorCode('');
    setManualCodeError('');
    setIsCameraVisible(true);
  };

  const closeQrVerificationModal = () => {
    setIsCameraVisible(false);
    setQrVerificationMode('scan');
    setManualFloorCode('');
    setManualCodeError('');
  };

  const showAttendanceToast = React.useCallback(async ({ icon = 'info', title, text, timer = 3000 }) => {
    try {
      await ensureSwalLoaded();
      await window.Swal.fire({
        toast: true,
        position: 'top-end',
        icon,
        title,
        text,
        timer,
        timerProgressBar: true,
        showConfirmButton: false,
      });
      return true;
    } catch (error) {
      console.warn('SweetAlert notification unavailable:', error);
      return false;
    }
  }, []);

  React.useEffect(() => {
    if (!activeAttendanceBlocked || !activeSchedule) {
      substitutedNoticeKeyRef.current = '';
      return;
    }
    const noticeKey = String(
      activeSchedule.attendance_id
      || `${activeSchedule.schedule_id || ''}|${activeSchedule.date || ''}`
    );
    if (!noticeKey || substitutedNoticeKeyRef.current === noticeKey) return;
    substitutedNoticeKeyRef.current = noticeKey;
    showAttendanceToast({
      icon: 'info',
      title: activeAttendanceOnLeave ? 'On Leave' : 'Attendance Transferred',
      text: activeAttendanceOnLeave
        ? 'This current class is covered by your approved leave. GPS, room-range checks, and QR scanning are not required.'
        : 'This current class attendance has been assigned to a substitute teacher. No attendance action is required from you.',
      timer: 3500,
    });
  }, [activeAttendanceBlocked, activeAttendanceOnLeave, activeSchedule, showAttendanceToast]);

  const handleCheckNow = React.useCallback(async (scannedQrToken = null) => {
    setErrorMessage(null); 
    setWrongFloorInfo(null);

    const rec = findActiveSchedule();
    if (isAttendanceExemptRecord(rec)) {
      const onLeave = isOnLeaveRecord(rec);
      await showAttendanceToast({
        icon: 'info',
        title: onLeave ? 'On Leave' : 'Attendance Transferred',
        text: onLeave
          ? 'This class is covered by your approved leave. No attendance action is required.'
          : 'This class attendance has been assigned to a substitute teacher. No attendance action is required from you.',
        timer: 3500,
      });
      if (scannedQrToken) setIsCameraVisible(false);
      return;
    }
    if (!rec) {
      if (scannedQrToken) setIsCameraVisible(false);
      return;
    }
    if (!referenceDataLoaded) {
      setErrorMessage('Location information is still loading. Please try again in a moment.');
      if (scannedQrToken) setIsCameraVisible(false);
      return;
    }
    if (!attendanceLocationOperational) {
      setErrorMessage('Attendance is unavailable because the assigned room, floor, building, or campus is inactive or archived. Please contact your administrator.');
      if (scannedQrToken) setIsCameraVisible(false);
      return;
    }

    const activeGroup = findMatchingScheduleGroup(rec);
    const actionState = computeActionState(rec, activeGroup);
    const actionToRun = actionState.action || currentAction || 'check-in';

    if (!scannedQrToken) {
      if (!actionState.allowed) return alert('Action not allowed at this time.');
      if (!coords) {
        await showAttendanceToast({
          icon: 'info',
          title: 'Location Still Loading',
          text: 'Your location is still being detected. Keep location services enabled and try again in a moment.',
          timer: 3000,
        });
        return;
      }
      if (!currentRoomObj) {
        console.warn('Room lookup failed for schedule:', rec);
        try {
          const refreshed = await apiGet('rooms');
          if (Array.isArray(refreshed) && refreshed.length) {
            const operationalRooms = refreshed.filter((room) => String(room?.status || '').toLowerCase() === 'active');
            setRooms(operationalRooms);
            const found = operationalRooms.find(r => Number(r.room_id) === Number(rec.room_id));
            if (!found) {
              console.warn('Room data not found after refreshing rooms. Contact admin.');
              return;
            }
          } else {
            console.warn('Room data not found (rooms API empty).');
            return;
          }
        } catch (e) {
          console.error('Failed to refresh rooms:', e);
          return;
        }
      }
      if (isOutOfRange) return;
      if (coords.accuracy > ACCURACY_THRESHOLD_METERS) {
        await showAttendanceToast({
          icon: 'warning',
          title: 'Location Accuracy Too Low',
          text: 'Your current GPS accuracy is not sufficient to verify attendance. Move to an open area and try again.',
          timer: 3500,
        });
        return;
      }

      const poorAltitude = (!coords.altitudeAccuracy && coords.altitudeAccuracy !== 0) || (coords.altitudeAccuracy > ALTITUDE_ACCURACY_THRESHOLD_METERS);
      if (poorAltitude) {
        try {
          await ensureSwalLoaded();
          const res = await window.Swal.fire({
            title: 'Poor altitude accuracy',
            text: '(Not recommended to do check right now) Altitude accuracy too poor — move outdoors or scan the floor QR? for more vertical altitude validition.',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Scan QR',
            cancelButtonText: 'Cancel'
          });
          if (res.isConfirmed) { openScannerWithPermission(); return; }
          return;
        } catch (e) {
          const ok = window.confirm('Altitude accuracy too poor — move outdoors or scan the floor QR. Press OK to open scanner now.');
          if (ok) { openScannerWithPermission(); return; }
          return;
        }
      }
    }

    const payload = {
      schedule_id: rec.schedule_id,
      user_id: userId,
      date: rec.date,
      latitude: coords?.latitude || 0,
      longitude: coords?.longitude || 0,
      accuracy: coords?.accuracy || 100,
      altitude: attendanceAltitude.normalized !== null ? attendanceAltitude.normalized : null,
      raw_altitude: attendanceAltitude.raw !== null ? attendanceAltitude.raw : null,
      normalized_altitude: attendanceAltitude.normalized !== null ? attendanceAltitude.normalized : null,
      altitude_offset: attendanceAltitude.offset !== null ? attendanceAltitude.offset : null,
      altitude_source: attendanceAltitude.source,
      device_platform: devicePlatform,
      altitudeAccuracy: coords?.altitudeAccuracy ?? null,
      qr_token: scannedQrToken || null,
    };

    try {
      const endpoint = actionToRun ? `attendance/${actionToRun}` : 'attendance/check-in';
      const data = await apiPost(endpoint, payload);

      const updatedRecords = Array.isArray(data?.records)
        ? data.records
        : [data?.attendance || data?.record].filter(Boolean);

      if (updatedRecords.length) {
        setRecords(prev => {
          try {
            let copy = prev.slice();
            for (const att of updatedRecords) {
              const idx = copy.findIndex(r => (r.attendance_id && att.attendance_id && r.attendance_id === att.attendance_id) || (r.schedule_id === att.schedule_id && r.date === att.date));
              if (idx >= 0) {
                copy[idx] = { ...copy[idx], ...att };
              } else {
                copy = [att, ...copy];
              }
            }
            return copy;
          } catch (e) { return prev; }
        });

        const primaryAttendance = updatedRecords[0];
        if (primaryAttendance?.floor_id) {
          const serverFloor = floors.find(f => f.floor_id === Number(primaryAttendance.floor_id));
          if (serverFloor) setDetectedFloor(serverFloor);
        }
        setWrongFloorInfo(null);
        if (data && data.used_db_floor) {
          setUsingDbFloor(true);
          if (primaryAttendance?.floor_id) {
            const serverFloor = floors.find(f => f.floor_id === Number(primaryAttendance.floor_id));
            if (serverFloor) setDetectedFloor(serverFloor);
          }
          try { alert('Using floor altitude (QR)'); } catch(e){}
        }
      } else {
        await loadMyAttendance();
      }

      const groupCount = Number(data?.group_count || updatedRecords.length || 1);
      await showAttendanceToast({
        icon: 'success',
        title: 'Attendance Recorded',
        text: `${data.message || 'Attendance was recorded successfully.'}${groupCount > 1 ? ` ${groupCount} schedules were updated.` : ''}`,
        timer: 2500,
      });
      setIsCameraVisible(false);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const body = err && err.body ? err.body : null;
      if (body && body.error === 'wrong_floor') {
        setWrongFloorInfo(body);
        setErrorMessage('wrong_floor');
      } else {
        setWrongFloorInfo(null);
        setErrorMessage(body && (body.message || body.error) ? (body.message || body.error) : msg);
      }
      if (scannedQrToken) setIsCameraVisible(false);
    }
  }, [findActiveSchedule, findMatchingScheduleGroup, computeActionState, coords, attendanceAltitude, devicePlatform, currentRoomObj, referenceDataLoaded, attendanceLocationOperational, isOutOfRange, userId, currentAction, floors, loadMyAttendance, showAttendanceToast]);

  React.useEffect(() => {
    handleCheckNowRef.current = handleCheckNow;
  }, [handleCheckNow]);

  const lastAutoTriggerRef = React.useRef(0);
  React.useEffect(() => {
    if (!userId) return;
    if (actionAllowed && attendanceLocationOperational && !isOutOfRange && currentAction) {
      const now = Date.now();
      if (now - lastAutoTriggerRef.current > 15000) {
        lastAutoTriggerRef.current = now;
        handleCheckNow(scannedQrToken).catch(() => {});
      }
    }
  }, [actionAllowed, attendanceLocationOperational, isOutOfRange, currentAction, userId, scannedQrToken, handleCheckNow]);

  const ensureHtml5QrcodeLoaded = async () => {
    if (typeof window === 'undefined') return;
    if (window.Html5Qrcode || window.Html5QrcodeScanner) return;
    const existing = document.querySelector('script[data-html5qrcode]');
    if (existing) {
      await new Promise((resolve, reject) => {
        if (existing.getAttribute('data-loaded') === '1') return resolve();
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error('Failed loading html5-qrcode script')));
      });
      if (window.Html5Qrcode || window.Html5QrcodeScanner) return;
      throw new Error('html5-qrcode loaded but globals not exposed');
    }

    const cdns = [
      'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.7/minified/html5-qrcode.min.js',
      'https://unpkg.com/html5-qrcode@2.3.7/minified/html5-qrcode.min.js',
      'https://rawcdn.githack.com/mebjas/html5-qrcode/v2.3.7/minified/html5-qrcode.min.js'
    ];

    let lastErr = null;
    for (const src of cdns) {
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = src;
          s.async = true;
          s.setAttribute('data-html5qrcode', '1');
          s.onload = () => {
            s.setAttribute('data-loaded', '1');
            setTimeout(() => {
              if (window.Html5Qrcode || window.Html5QrcodeScanner) resolve();
              else reject(new Error('html5-qrcode did not expose expected globals after load'));
            }, 50);
          };
          s.onerror = () => reject(new Error('Failed to load html5-qrcode from ' + src));
          document.head.appendChild(s);
        });
        return;
      } catch (err) {
        lastErr = err;
        try {
          const failed = document.querySelector('script[data-html5qrcode]');
          if (failed && failed.getAttribute('src') === src) failed.parentNode.removeChild(failed);
        } catch (e) {}
      }
    }
    throw lastErr || new Error('All CDNs failed for html5-qrcode');
  };

  const handleManualFloorCodeSubmit = async (event) => {
    event?.preventDefault?.();
    if (manualCodeVerifying) return;

    const code = String(manualFloorCode || '').trim().toUpperCase();
    setManualCodeError('');
    if (!/^[A-Z0-9]{6,16}$/.test(code)) {
      setManualCodeError('Enter the 6–16 character code printed below the QR.');
      return;
    }

    const target = findTargetSchedule ? findTargetSchedule() : null;
    if (!target) {
      setManualCodeError('No active class schedule is available for manual floor verification.');
      return;
    }

    setManualCodeVerifying(true);
    try {
      const data = await apiPost('attendance/verify-floor-code', { manual_code: code });
      const matchedFloor = floors.find((floor) => String(floor.floor_id) === String(data.floor_id)) || {
        floor_id: data.floor_id,
        floor_name: data.floor_name,
        building_id: data.building_id,
        building_name: data.building_name,
        status: data.status,
      };
      const targetGroup = findTargetScheduleGroup(target);
      const scheduledFloorIds = new Set();
      for (const record of targetGroup.length ? targetGroup : [target]) {
        const room = rooms.find((candidate) => Number(candidate.room_id) === Number(record.room_id));
        if (room?.floor_id !== undefined && room.floor_id !== null) scheduledFloorIds.add(Number(room.floor_id));
      }

      if (scheduledFloorIds.size === 0 || !scheduledFloorIds.has(Number(data.floor_id))) {
        setManualCodeError('This floor does not match your active class schedule.');
        return;
      }

      setScannedQrToken(data.qr_token);
      setScannedFloor(matchedFloor);
      setManualFloorCode('');
      setManualCodeError('');
      setIsCameraVisible(false);
      try {
        await ensureSwalLoaded();
        window.Swal.fire({ toast:true, position:'top', icon:'success', title:`Verified: ${data.floor_name || 'floor'}`, showConfirmButton:false, timer:2000 });
      } catch (e) {}
    } catch (err) {
      const body = err?.body || {};
      setManualCodeError(body.message || 'Manual floor code is not recognized.');
    } finally {
      setManualCodeVerifying(false);
    }
  };

  React.useEffect(() => {
    if (!isCameraVisible || qrVerificationMode !== 'scan') return;
    const sessionId = ++scannerSessionRef.current;
    let activeScanner = null;
    let stopped = false;

    const startScanner = async () => {
      try {
        if (typeof window.Html5Qrcode === 'undefined' && typeof window.Html5QrcodeScanner === 'undefined') {
          try {
            await ensureHtml5QrcodeLoaded();
          } catch (err) {
            if (stopped || scannerSessionRef.current !== sessionId) return;
            setErrorMessage('QR library failed to load: ' + (err && err.message ? err.message : String(err)));
            return;
          }
        }
        if (stopped || scannerSessionRef.current !== sessionId || scannerStartedRef.current) return;
        const html5QrCode = new window.Html5Qrcode('qr-scanner-container');
        activeScanner = html5QrCode;

        const config = { fps: 10, qrbox: { width: 250, height: 250 } };
        const cameraOrConstr = { facingMode: 'environment' };

        try {
          await html5QrCode.start(
            cameraOrConstr,
            config,
            (decodedText) => {
              try { html5QrCode.stop(); } catch (e) {}
              try { html5QrCode.clear(); } catch (e) {}
              if (!stopped && scannerSessionRef.current === sessionId) {
                const matchedFloor = floors.find(f => f.qr_token === decodedText);
                const target = findTargetSchedule ? findTargetSchedule() : null;
                const targetGroup = target ? findTargetScheduleGroup(target) : [];
                const scheduledFloorIds = new Set();
                try {
                  for (const rec of targetGroup.length ? targetGroup : (target ? [target] : [])) {
                    const rr = rooms.find(r => Number(r.room_id) === Number(rec.room_id));
                    if (rr?.floor_id !== undefined && rr.floor_id !== null) scheduledFloorIds.add(Number(rr.floor_id));
                  }
                } catch(e) {}

                // 1. CRITICAL SECURITY FIX: Reject if no target schedule exists
                if (!target) {
                  setIsCameraVisible(false);
                } 
                // 2. Reject if QR is invalid
                else if (!matchedFloor) {
                  (async () => {
                    try { await ensureSwalLoaded(); window.Swal.fire({ toast:true, position:'top', icon:'error', title: 'Scanned QR is not recognized', showConfirmButton:false, timer:3000 }); } catch (e) { alert('Scanned QR is not recognized'); }
                  })();
                } 
                // 3. Reject if floor mismatch
                else if (scheduledFloorIds.size === 0 || !scheduledFloorIds.has(Number(matchedFloor.floor_id))) {
                  (async () => {
                    try { await ensureSwalLoaded(); window.Swal.fire({ toast:true, position:'top', icon:'error', title: 'Scanned floor does not match your class', showConfirmButton:false, timer:3500 }); } catch (e) { alert('Scanned floor does not match your class'); }
                  })();
                } 
                // 4. Accept
                else {
                  (async () => {
                    try { await ensureSwalLoaded(); window.Swal.fire({ toast:true, position:'top', icon:'success', title: `Scanned: ${matchedFloor.floor_name || 'floor'}`, showConfirmButton:false, timer:2000 }); } catch (e) { /* ignore */ }
                  })();
                  setScannedQrToken(decodedText);
                  setScannedFloor(matchedFloor);
                }
                setIsCameraVisible(false);
              }
            },
            (_error) => { }
          );
          if (stopped || scannerSessionRef.current !== sessionId) {
            try { await html5QrCode.stop(); } catch (e) {}
            try { html5QrCode.clear(); } catch (e) {}
            return;
          }
          scannerStartedRef.current = true;
          setCameraPermission('granted');
        } catch (startErr) {
          const em = (startErr && startErr.message) ? startErr.message : String(startErr);
          if (em.toLowerCase().includes('notreadable') || em.toLowerCase().includes('could not start video')) {
            setErrorMessage('Camera busy or inaccessible. Close other apps/tabs using the camera and try again.');
          } else if (em.toLowerCase().includes('notallowed') || em.toLowerCase().includes('permission')) {
            setCameraPermission('denied');
            setErrorMessage('Camera permission denied. Allow camera access in browser/site settings.');
          } else {
            setErrorMessage('Failed to start QR scanner: ' + em);
          }
          try { html5QrCode.clear(); } catch (e) {}
          return;
        }
        return;
      } catch (err) {
        setErrorMessage('Failed to start QR scanner: ' + (err && err.message ? err.message : String(err)));
      }
    };

    startScanner();

    return () => {
      stopped = true;
      if (scannerSessionRef.current === sessionId) scannerSessionRef.current += 1;
      scannerStartedRef.current = false;
      try {
        if (previewStreamRef.current) {
          previewStreamRef.current.getTracks().forEach(t => { try{ t.stop(); }catch(e){} });
          previewStreamRef.current = null;
        }
        setPreviewActive(false);
        if (debugVideoRef.current) { try { debugVideoRef.current.srcObject = null; } catch (e) {} }
      } catch (e) {}
      (async () => {
        try {
          if (!activeScanner) return;
          if (typeof activeScanner.stop === 'function') {
            try { await activeScanner.stop(); } catch (e) {}
            try { activeScanner.clear(); } catch (e) {}
          }
        } catch (e) {}
      })();
    };
  }, [isCameraVisible, qrVerificationMode, floors, rooms, findTargetSchedule, findTargetScheduleGroup]);

  React.useEffect(() => {
    try {
      const rec = findActiveSchedule();
      if (!rec) {
        setUsingDbFloor(false);
        return;
      }
      const current = records.find(r => (r.attendance_id && rec.attendance_id && r.attendance_id === rec.attendance_id) || (r.schedule_id === rec.schedule_id && r.date === rec.date));
      if (!current || !current.floor_id || !current.room_id) {
        setUsingDbFloor(false);
        return;
      }
      const room = rooms.find(r => Number(r.room_id) === Number(current.room_id));
      if (room && Number(current.floor_id) === Number(room.floor_id)) {
        setUsingDbFloor(false);
      } else {
        setUsingDbFloor(true);
        const f = floors.find(ff => Number(ff.floor_id) === Number(current.floor_id));
        if (f) setDetectedFloor(f);
      }
    } catch (e) { }
  }, [records, rooms, floors, findActiveSchedule]);

  React.useEffect(() => {
    let timer = null;
    try {
      const now = new Date();
      const todayStr = formatDateYMD(now);
      const todays = records.filter(r => r.date === todayStr);
      const active = todays.find(r => {
        if (!r.start_time || !r.end_time) return false;
        const start = new Date(`${r.date}T${r.start_time}`);
        const end = new Date(`${r.date}T${r.end_time}`);
        return now >= start && now <= end;
      }) || null;
    
      if (!active) {
        setScannedQrToken(null);
        setScannedFloor(null);
        try { localStorage.removeItem(LOCAL_STORAGE_KEY); } catch(e){}
        return () => {};
      }
    
      const endTs = new Date(`${active.date}T${active.end_time}`).getTime();
      const msLeft = endTs - Date.now();
      if (msLeft <= 0) {
        setScannedQrToken(null);
        setScannedFloor(null);
        try { localStorage.removeItem(LOCAL_STORAGE_KEY); } catch(e){}
        return () => {};
      }
    
      timer = setTimeout(() => {
        setScannedQrToken(null);
        setScannedFloor(null);
        try { localStorage.removeItem(LOCAL_STORAGE_KEY); } catch(e){}
      }, msLeft + 1000);
    } catch (e) {
      setScannedQrToken(null);
      setScannedFloor(null);
      try { localStorage.removeItem(LOCAL_STORAGE_KEY); } catch(e){}
    }
    return () => { if (timer) clearTimeout(timer); };
  }, [records]);

  const nearestRoomLabel = coords ? getNearestRoomLabel(coords) : null;
  const roomGuideLabel = scannedFloor ? 'Scanned-floor room' : 'Estimated room';
  const altitudeLabel = attendanceAltitude.normalized !== null ? `${Number(attendanceAltitude.normalized).toFixed(1)}m` : 'N/A';
  const rawAltitudeLabel = attendanceAltitude.raw !== null ? `${Number(attendanceAltitude.raw).toFixed(1)}m` : 'N/A';
  const altitudeDisplayLabel = attendanceAltitude.calibrated ? `${altitudeLabel} (raw ${rawAltitudeLabel})` : altitudeLabel;
  const gpsAccuracy = Number(coords?.accuracy);
  const gpsAccuracyTooLow = Number.isFinite(gpsAccuracy) && gpsAccuracy > ACCURACY_THRESHOLD_METERS;
  const gpsInlineMessage = locationIssue?.message || (gpsAccuracyTooLow
    ? `GPS accuracy is ${gpsAccuracy.toFixed(1)} metres. It must be ${ACCURACY_THRESHOLD_METERS} metres or better. Move to an open area and wait for GPS to improve.`
    : '');

  // Helper to render a status badge with color
  const renderStatusBadge = (flagId, label) => {
    const colors = getStatusColor(flagId);
    return (
      <span style={{ backgroundColor: colors.bg, color: colors.text, padding: '2px 10px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: '800', display: 'inline-block' }}>
        {label.toUpperCase()}
      </span>
    );
  };

  // Helper to get the status label for a check type
  const getCheckStatus = (record, checkType) => {
    if (!record) return { label: '—', flagId: null };
    if (checkType === 'in') {
      const flagId = record.flag_in_id != null ? Number(record.flag_in_id) : null;
      if (flagId && flagId !== 1) return { label: getFlagLabel(flagId), flagId };
      if (record.time_in) return { label: getFlagLabel(flagId || 2), flagId: flagId || 2 };
      return { label: getFlagLabel(flagId || 1), flagId: flagId || 1 };
    }
    if (checkType === 'mid') {
      const flagId = record.flag_check_id != null ? Number(record.flag_check_id) : null;
      if (flagId && flagId !== 1) return { label: getFlagLabel(flagId), flagId };
      if (record.time_check) return { label: getFlagLabel(flagId || 2), flagId: flagId || 2 };
      return { label: getFlagLabel(flagId || 1), flagId: flagId || 1 };
    }
    if (checkType === 'out') {
      const flagId = record.flag_out_id != null ? Number(record.flag_out_id) : null;
      if (flagId && flagId !== 1) return { label: getFlagLabel(flagId), flagId };
      if (record.time_out) return { label: getFlagLabel(flagId || 2), flagId: flagId || 2 };
      return { label: getFlagLabel(flagId || 1), flagId: flagId || 1 };
    }
    return { label: '—', flagId: null };
  };

  // Helper to get parallel class data for a schedule
  const getParallelClassData = (schedule) => {
    if (!schedule) return [];
    const parallelSchedules = records.filter(r => isParallelSchedulePair(r, schedule));
    return parallelSchedules.length > 0 ? [schedule, ...parallelSchedules] : [];
  };

  // Handle view parallel classes
  const handleViewParallel = (schedule) => {
    const parallelData = getParallelClassData(schedule);
    setParallelModalData(parallelData);
    setShowParallelModal(true);
  };

  // Render schedule card (used for both CURRENT and NEXT)
  const renderScheduleCard = (title, schedule, isCurrent) => {
    const isParallel = schedule && getParallelClassData(schedule).length > 1;
    const isSubstituted = isSubstitutedRecord(schedule);
    const isOnLeave = isOnLeaveRecord(schedule);
    const dayOfWeek = schedule ? getDayOfWeek(schedule.date) : '';
    const checkIn = getCheckStatus(schedule, 'in');
    const checkMid = getCheckStatus(schedule, 'mid');
    const checkOut = getCheckStatus(schedule, 'out');

    return (
      <div style={{ backgroundColor: '#e2e8f0', borderRadius: '16px', overflow: 'hidden', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)' }}>
        <div style={{ backgroundColor: isCurrent ? '#15803d' : '#a3b1ab', color: isCurrent ? '#ffffff' : '#1e293b', padding: '12px 20px', fontSize: '1rem', fontWeight: '700', letterSpacing: '0.05em', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{title}</span>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {isSubstituted && (
            <span style={{ backgroundColor: '#4f46e5', color: '#ffffff', padding: '2px 10px', borderRadius: '12px', fontSize: '0.7rem', fontWeight: '800' }}>
              SUBSTITUTED
            </span>
          )}
          {isOnLeave && (
            <span style={{ backgroundColor: '#0891b2', color: '#ffffff', padding: '2px 10px', borderRadius: '12px', fontSize: '0.7rem', fontWeight: '800' }}>
              ON LEAVE
            </span>
          )}
          {isParallel && (
            <span style={{ backgroundColor: isCurrent ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.1)', padding: '2px 10px', borderRadius: '12px', fontSize: '0.7rem', fontWeight: '800' }}>
              PARALLEL
            </span>
          )}
          </div>
        </div>
        {schedule ? (
          <div className="attendance-schedule-grid" style={{ padding: 'clamp(14px, 3vw, 20px)', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '16px', fontSize: '0.9rem', color: '#334155', fontWeight: '600', lineHeight: '1.6' }}>
            <div>
              <div style={{ marginBottom: '4px' }}>SECTION: <span style={{ fontWeight: '700', color: '#0f172a' }}>{schedule.section_name || '—'}</span></div>
              <div style={{ marginBottom: '16px' }}>SUBJECT: <span style={{ fontWeight: '700', color: '#0f172a' }}>{schedule.subject_code ? `${schedule.subject_code} - ${schedule.subject_name || ''}` : '—'}</span></div>
              <div>BUILDING: <span style={{ fontWeight: '700', color: '#0f172a' }}>{schedule.building_name || '—'}</span></div>
              <div>FLOOR: <span style={{ fontWeight: '700', color: '#0f172a' }}>{schedule.floor_name || '—'}</span></div>
              <div>ROOM: <span style={{ fontWeight: '700', color: '#0f172a' }}>{schedule.room_name || '—'}</span></div>
              {dayOfWeek && <div style={{ marginTop: '8px' }}>DAY: <span style={{ fontWeight: '700', color: '#0f172a' }}>{dayOfWeek}</span></div>}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start' }}>
              <div>SCHEDULE: <span style={{ fontWeight: '700', color: '#0f172a' }}>{`${formatTime12(schedule.start_time)} - ${formatTime12(schedule.end_time)}`}</span></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                CHECK IN: {renderStatusBadge(checkIn.flagId, checkIn.label)}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                CHECK MID: {renderStatusBadge(checkMid.flagId, checkMid.label)}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                CHECK OUT: {renderStatusBadge(checkOut.flagId, checkOut.label)}
              </div>
              {isParallel && (
                <button 
                  onClick={() => handleViewParallel(schedule)}
                  style={{ marginTop: '8px', border: 'none', backgroundColor: '#0f172a', color: '#ffffff', padding: '6px 16px', borderRadius: '8px', fontWeight: '700', fontSize: '0.8rem', cursor: 'pointer' }}
                >
                  VIEW PARALLEL CLASSES
                </button>
              )}
            </div>
          </div>
        ) : (
          <div style={{ padding: '28px', textAlign: 'center', color: '#64748b', fontSize: '0.95rem', fontWeight: '600' }}>
            {isCurrent ? 'No active class schedule at the moment.' : 'No upcoming schedule found for today.'}
          </div>
        )}
      </div>
    );
  };

  // --- Render ---
  return (
    <div className="attendance-container" style={{ padding: 'clamp(12px, 3vw, 24px)', fontFamily: 'system-ui, -apple-system, sans-serif', backgroundColor: '#f8fafc', minHeight: '100vh', width: '100%', maxWidth: '100%', overflowX: 'hidden' }}>
      <style>{`
        .attendance-container,
        .attendance-container * {
          box-sizing: border-box;
        }

        .attendance-container {
          overflow-wrap: anywhere;
        }

        .attendance-card {
          min-width: 0;
        }

        .attendance-shell-grid,
        .attendance-schedule-grid,
        .attendance-gps-grid,
        .attendance-location-grid {
          min-width: 0;
        }

        .attendance-container button {
          max-width: 100%;
          white-space: normal;
        }

        #qr-scanner-container,
        #qr-scanner-container video,
        #qr-scanner-container canvas {
          max-width: 100% !important;
        }

        @media (max-width: 640px) {
          .attendance-card {
            padding: 16px !important;
            border-radius: 16px !important;
          }

          .attendance-page-title {
            font-size: clamp(1.45rem, 9vw, 2.2rem) !important;
            line-height: 1.1 !important;
          }

          .attendance-card-title {
            font-size: 1.35rem !important;
          }

          .attendance-top-actions {
            width: 100%;
            align-items: stretch !important;
          }

          .attendance-top-actions > button {
            flex: 1 1 120px;
          }

          .attendance-schedule-grid,
          .attendance-gps-grid,
          .attendance-location-grid {
            grid-template-columns: 1fr !important;
          }

          .attendance-filter-tabs,
          .attendance-record-flags {
            flex-wrap: wrap;
          }

          .attendance-action-button {
            width: 100% !important;
            min-width: 0 !important;
            padding-inline: 14px !important;
          }
        }
      `}</style>
      
      {/* HEADER SECTION - Matches Reference Image Top Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
        <h1 className="attendance-page-title" style={{ margin: 0, fontSize: '2.2rem', fontWeight: '800', color: '#0f172a', letterSpacing: '-0.025em' }}>
          {teacherName || 'John Lester Zarsosa'}
        </h1>
        <div style={{ backgroundColor: '#15803d', color: '#ffffff', padding: '10px 24px', borderRadius: '12px', fontSize: '1.2rem', fontWeight: '700', boxShadow: '0 4px 6px -1px rgba(21, 128, 61, 0.3)', letterSpacing: '0.025em' }}>
          <ClockDisplay />
        </div>
      </div>

      {/* MAIN CONTAINER CARD */}
      <div className="attendance-card" style={{ backgroundColor: '#ffffff', borderRadius: '20px', padding: 'clamp(16px, 3vw, 28px)', boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.01)', border: '1px solid #e2e8f0' }}>
        
        {/* CARD TOP BAR: Title & Scan QR Button */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
          <h2 className="attendance-card-title" style={{ margin: 0, fontSize: '1.75rem', fontWeight: '700', color: '#1e293b' }}>My Attendance</h2>
          <div className="attendance-top-actions" style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            {!activeAttendanceBlocked && (
              <button onClick={toggleGpsTracking} aria-pressed={gpsEnabled} style={{ border: 'none', backgroundColor: gpsEnabled ? '#dc2626' : '#15803d', color: '#ffffff', padding: '10px 18px', borderRadius: '10px', fontWeight: '700', cursor: 'pointer', fontSize: '0.95rem', boxShadow: gpsEnabled ? '0 3px 6px rgba(220, 38, 38, 0.24)' : '0 3px 6px rgba(21, 128, 61, 0.24)' }}>
                {gpsEnabled ? 'Turn off GPS' : 'Turn on GPS'}
              </button>
            )}
            <button 
              onClick={openScannerWithPermission} 
              disabled={activeAttendanceBlocked || !referenceDataLoaded || !attendanceLocationOperational}
              style={{ border: 'none', backgroundColor: '#e2e8f0', color: '#1e293b', padding: '10px 24px', borderRadius: '10px', fontWeight: '700', cursor: activeAttendanceBlocked || !referenceDataLoaded || !attendanceLocationOperational ? 'not-allowed' : 'pointer', opacity: activeAttendanceBlocked || !referenceDataLoaded || !attendanceLocationOperational ? 0.55 : 1, fontSize: '0.95rem', transition: 'background-color 0.2s' }}
            >
              {activeAttendanceBlocked ? 'QR Not Required' : 'Scan QR'}
            </button>
          </div>
        </div>

        {/* BANNERS (Building / Errors / Warnings) */}
        <div className="attendance-banners" style={{ marginBottom: '20px' }}>
          {!activeAttendanceBlocked && (currentBuilding || scheduledBuildingObj || scannedFloor || usingDbFloor || detectedFloor) && (
            <div style={{ backgroundColor: '#f1f5f9', padding: '12px 16px', borderRadius: '10px', fontSize: '0.85rem', color: '#475569', marginBottom: '12px' }}>
              {currentBuilding && <div>Detected building: {currentBuilding.building_name || 'Building'} (radius {Math.round(Number(currentBuilding.radius || currentBuilding.building_radius || 0))}m)</div>}
              {currentRoomObj && <div style={{ marginTop:4 }}>Scheduled building{scheduledGroupBuildings.length > 1 ? 's' : ''}: {scheduledGroupBuildings.map(building => building.building_name || 'Building').join(', ') || 'X'}</div>}

              {isOutsideBuilding && currentRoomObj && scheduledBuildingRange && (
                <div style={{ color: '#dc2626', fontWeight: '600', marginTop: 4 }}>
                  {detectedDifferentBuilding
                    ? `You appear to be inside ${detectedDifferentBuilding.building_name || 'another building'}, but your current class is assigned to ${scheduledBuildingRange.building.building_name || 'a different building'}. You are ${Math.round(scheduledBuildingRange.outsideBy)}m outside the scheduled building range.`
                    : `You are ${Math.round(scheduledBuildingRange.outsideBy)}m outside ${scheduledBuildingRange.building.building_name || 'the scheduled building'}. Move closer to the scheduled building.`}
                </div>
              )}

              {scannedFloor && <div style={{ color: '#16a34a', fontWeight: '600', marginTop: 4 }}>QR validated — floor: {scannedFloor.floor_name || 'floor'}</div>}
              {!scannedFloor && usingDbFloor && detectedFloor && <div style={{ color: '#16a34a', fontWeight: '600', marginTop: 4 }}>Using DB floor altitude — floor: {detectedFloor.floor_name || 'floor'}</div>}
              {!scannedFloor && !usingDbFloor && detectedFloor && currentRoomObj && (
                <div style={{ color: '#0284c7', fontWeight: '600', marginTop: 4 }}>
                  GPS-detected floor: {detectedFloor.floor_name || '...'} — expected: { (floors.find(f=>String(f.floor_id)===String(currentRoomObj.floor_id)) || {}).floor_name || 'scheduled floor' }
                </div>
              )}
            </div>
          )}

          {!userId && (
            <div style={{ backgroundColor: '#fee2e2', color: '#991b1b', padding: '14px', borderRadius: '10px', marginBottom: '12px', fontSize: '0.9rem' }}>
              <div>No user selected. Open this page with a teacher id in the URL (e.g. ?userId=6) or log in.</div>
              <div style={{ marginTop:8 }}><button onClick={()=> { const id = prompt('Enter test userId (e.g. 6)'); if (id) { setUserId(Number(id)); } }} style={{ backgroundColor: '#991b1b', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600' }}>Use test user id</button></div>
            </div>
          )}

          {activeAttendanceBlocked && (
            <div style={{ backgroundColor: activeAttendanceOnLeave ? '#cffafe' : '#e0e7ff', color: activeAttendanceOnLeave ? '#0e7490' : '#4338ca', padding: '12px 16px', borderRadius: '10px', marginBottom: '12px', fontWeight: '700', fontSize: '0.9rem' }}>
              {activeAttendanceOnLeave
                ? 'This attendance is marked On Leave. GPS, room-range checks, and QR scanning are not required for you.'
                : 'This attendance has been transferred to the assigned substitute teacher. GPS, room-range checks, and QR scanning are not required for you.'}
            </div>
          )}
          {!activeAttendanceBlocked && referenceDataLoaded && activeSchedule && !attendanceLocationOperational && (
            <div style={{ backgroundColor: '#fee2e2', color: '#991b1b', padding: '12px 16px', borderRadius: '10px', marginBottom: '12px', fontWeight: '700', fontSize: '0.9rem' }}>
              Attendance is unavailable because the assigned room, floor, building, or campus is inactive or archived. Please contact your administrator.
            </div>
          )}
          {!activeAttendanceBlocked && gpsInlineMessage && (
            <div style={{ backgroundColor: locationIssue?.type === 'permission-denied' ? '#fee2e2' : '#fef3c7', color: locationIssue?.type === 'permission-denied' ? '#991b1b' : '#92400e', padding: '12px 16px', borderRadius: '10px', marginBottom: '12px', fontWeight: '600', fontSize: '0.9rem' }}>
              {gpsInlineMessage}
            </div>
          )}
          {!activeAttendanceBlocked && errorMessage && <div style={{ backgroundColor: '#fee2e2', color: '#b91c1c', padding: '12px 16px', borderRadius: '10px', marginBottom: '12px', fontWeight: '600', fontSize: '0.9rem' }}>{errorMessage}</div>}
          {!activeAttendanceBlocked && renderWrongFloorMessage()}
          {!activeAttendanceBlocked && notInAnyBuilding && <div style={{ backgroundColor: '#fef3c7', color: '#92400e', padding: '12px 16px', borderRadius: '10px', marginBottom: '12px', fontWeight: '500', fontSize: '0.9rem' }}>You are not inside any known building. Move closer to the building or check location permissions.</div>}
          {!activeAttendanceBlocked && isOutsideBuilding && currentRoomObj && !scheduledBuildingObj && (
             <div style={{ backgroundColor: '#fef3c7', color: '#92400e', padding: '12px 16px', borderRadius: '10px', marginBottom: '12px', fontWeight: '500', fontSize: '0.9rem' }}>You are not in the correct building for the active class. Move to the assigned building or scan the floor QR.</div>
          )}
          {!activeAttendanceBlocked && activeParallelRoomNames.length > 1 && (
            <div style={{ backgroundColor: '#e0f2fe', color: '#0369a1', padding: '12px 16px', borderRadius: '10px', marginBottom: '12px', fontSize: '0.9rem' }}>
              Parallel class detected for the current time. Rooms in this class group: {activeParallelRoomNames.join(', ')}. Active schedules are shown first.
            </div>
          )}
          {!activeAttendanceBlocked && isOutOfRange && currentRoomObj && (
            <div style={{ backgroundColor: '#fef3c7', color: '#92400e', padding: '12px 16px', borderRadius: '10px', marginBottom: '12px', fontWeight: '500', fontSize: '0.9rem' }}>
              You are out of range for the active class ({currentDist ? Math.round(currentDist) : 'N/A'}m away). Move closer to room '{currentRoomObj.room_name}'{activeOtherParallelRoomNames.length > 0 ? ` or another parallel room: ${activeOtherParallelRoomNames.join(', ')}` : ''}.
            </div>
          )}
        </div>

        {/* TWO-COLUMN UI LAYOUT EXACTLY MATCHING THE DESIGN */}
        <div className="attendance-shell-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 'clamp(16px, 3vw, 24px)' }}>
          
          {/* LEFT COLUMN: Schedules */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            
            {/* CURRENT SCHEDULE CARD */}
            {renderScheduleCard('CURRENT SCHEDULE', activeSchedule, true)}

            {/* NEXT SCHEDULE CARD */}
            {renderScheduleCard('NEXT SCHEDULE', nextSchedule, false)}

            {/* PRESERVED FILTER PILLS & LIST FOR EXTENDED USAGE */}
            <div style={{ marginTop: '10px' }}>
              <div className="attendance-filter-tabs" style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                <button type="button" style={{ border: 'none', padding: '6px 14px', borderRadius: '20px', fontSize: '0.8rem', fontWeight: '600', cursor: 'default', backgroundColor: '#0f172a', color: '#ffffff' }}>
                  Today
                </button>
                <button
                  type="button"
                  onClick={() => { window.location.hash = '#/attendance-history'; }}
                  style={{ border: 'none', padding: '6px 14px', borderRadius: '20px', fontSize: '0.8rem', fontWeight: '600', cursor: 'pointer', backgroundColor: '#e2e8f0', color: '#475569', transition: 'all 0.2s' }}
                >
                  View Past/Future Record(s)
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '250px', overflowY: 'auto' }}>
                {filteredRecords.length > 0 ? filteredRecords.map(item => {
                  const isActive = isRecordActiveNow(item);
                  const parallelRooms = getParallelRoomNames(item);
                  return (
                    <div key={item.attendance_id || `${item.schedule_id}-${item.date}`} style={{ padding: '12px 16px', backgroundColor: isActive ? '#f0fdf4' : '#f8fafc', border: `1px solid ${isActive ? '#86efac' : '#e2e8f0'}`, borderRadius: '10px', fontSize: '0.85rem' }}>
                      <div style={{ fontWeight: '700', color: '#0f172a', marginBottom: '4px' }}>{item.date} ({item.day_of_week || ''})</div>
                      {isActive && <div style={{ color: '#16a34a', fontWeight: '600', fontSize: '0.75rem', marginBottom: '4px' }}>Current active schedule</div>}
                      {parallelRooms.length > 0 && (
                        <div style={{ color: '#0284c7', fontSize: '0.75rem', marginBottom: '4px' }}>
                          Parallel room{parallelRooms.length > 1 ? 's' : ''}: {parallelRooms.join(', ')}
                        </div>
                      )}
                      <div style={{ color: '#475569' }}><strong style={{ color: '#1e293b' }}>Class:</strong> {item.subject_code || ''} - {item.section_name || ''}</div>
                      <div style={{ color: '#475569' }}><strong style={{ color: '#1e293b' }}>Time:</strong> {formatTime12(item.start_time)} - {formatTime12(item.end_time)}</div>
                      <div style={{ color: '#475569' }}><strong style={{ color: '#1e293b' }}>Room:</strong> {item.room_name || ''}</div>
                      <div className="attendance-record-flags" style={{ display: 'flex', gap: '12px', marginTop: '6px', fontSize: '0.75rem', fontWeight: '600', color: '#334155' }}>
                        <span>In: <span style={{ color: '#0f172a' }}>{getFlagLabel(item.flag_in_id)}</span></span>
                        <span>Mid: <span style={{ color: '#0f172a' }}>{getFlagLabel(item.flag_check_id)}</span></span>
                        <span>Out: <span style={{ color: '#0f172a' }}>{getFlagLabel(item.flag_out_id)}</span></span>
                      </div>
                    </div>
                  );
                }) : (
                  <div style={{ color: '#64748b', fontSize: '0.85rem', padding: '12px 0' }}>No records for this filter.</div>
                )}
              </div>
            </div>

          </div>

          {/* RIGHT COLUMN: Action & Status Panel */}
          <div style={{ backgroundColor: '#d1d5db', borderRadius: '20px', padding: 'clamp(16px, 3vw, 24px)', display: 'flex', flexDirection: 'column', gap: '20px', boxShadow: 'inset 0 2px 4px 0 rgba(0, 0, 0, 0.05)', minWidth: 0 }}>
            
            {/* CURRENT ACTION */}
            <div>
              <div style={{ fontSize: '0.9rem', fontWeight: '700', color: '#1e293b', marginBottom: '10px', letterSpacing: '0.025em' }}>CURRENT ACTION</div>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <button 
                  onClick={() => handleCheckNow(scannedQrToken)}
                  disabled={activeAttendanceBlocked}
                  className="attendance-action-button"
                  style={{ backgroundColor: activeAttendanceOnLeave ? '#0891b2' : activeAttendanceBlocked ? '#4f46e5' : '#15803d', color: '#ffffff', border: 'none', padding: '12px 28px', borderRadius: '10px', fontWeight: '700', fontSize: '0.95rem', boxShadow: activeAttendanceBlocked ? 'none' : '0 4px 6px -1px rgba(21, 128, 61, 0.3)', cursor: activeAttendanceBlocked ? 'not-allowed' : 'pointer', transition: 'transform 0.1s', width: 'auto', minWidth: 'min(220px, 100%)' }}
                >
                  {activeAttendanceBlocked
                    ? (activeAttendanceOnLeave ? 'ON LEAVE - ATTENDANCE NOT REQUIRED' : 'SUBSTITUTED - ATTENDANCE TRANSFERRED')
                    : actionAllowed && !isOutOfRange ? (currentAction ? `AUTOMATIC ${currentAction.replace('-', ' ').toUpperCase()}` : 'AUTOMATIC CHECK') : (currentAction ? `READY: ${currentAction.replace('-', ' ').toUpperCase()}` : 'AUTOMATIC CHECK')}
                </button>
              </div>
              {!actionAllowed && allowAt && <div style={{ fontSize: '0.8rem', color: '#475569', textAlign: 'center', marginTop: '8px', fontWeight: '600' }}>Allowed at: {new Date(allowAt).toLocaleTimeString()}</div>}
              {nextSchedule && (
                <div style={{ fontSize: '0.8rem', color: '#334155', textAlign: 'center', marginTop: '8px', fontWeight: '600' }}>
                   Next: {nextSchedule.subject_code} at {formatTime12(nextSchedule.start_time)} (Starts in <CountdownDisplay targetDate={nextStartDate} />)
                </div>
              )}
            </div>

            {!activeAttendanceBlocked && <React.Fragment>
            {/* QR STATUS */}
            <div>
              <div style={{ fontSize: '0.9rem', fontWeight: '700', color: '#1e293b', marginBottom: '10px', letterSpacing: '0.025em' }}>QR STATUS</div>
              <div style={{ backgroundColor: '#15803d', color: '#ffffff', padding: '14px', borderRadius: '12px', textAlign: 'center', fontWeight: '700', fontSize: '0.85rem', lineHeight: '1.5', boxShadow: '0 4px 6px -1px rgba(21, 128, 61, 0.2)', position: 'relative' }}>
                {!scannedQrToken ? (
                  <div>
                    <div>NO QR SCANNED YET</div>
                    <div style={{ fontWeight: '600', opacity: 0.9, fontSize: '0.75rem', marginTop: '4px' }}>Scan room QR code to verify vertical altitude</div>
                  </div>
                ) : (
                  <div>
                    <div>SCANNED: {(scannedFloor && scannedFloor.floor_name) ? scannedFloor.floor_name.toUpperCase() : scannedQrToken}</div>
                    {scannedFloor && (
                      <div style={{ fontWeight: '600', opacity: 0.9 }}>
                        {scannedFloorInRange ? 'ON SCANNED FLOOR' : 'NOT ON SCANNED FLOOR'} | BASELINE: {scannedFloorRange ? Number(scannedFloorRange.base).toFixed(2) + 'm' : 'N/A'}
                      </div>
                    )}
                    {(!scannedFloorInRange && altDetectedFloor) && (
                      <div style={{ marginTop: 4, fontSize: '0.75rem', opacity: 0.85 }}>
                        Detected floor by GPS: {altDetectedFloor.floor_name || 'Unknown'}
                      </div>
                    )}
                    <button style={{ position: 'absolute', right: '10px', top: '10px', background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '1rem', fontWeight: 'bold' }} onClick={() => { setScannedQrToken(null); setScannedFloor(null); try { localStorage.removeItem(LOCAL_STORAGE_KEY); } catch(e){} }}>✕</button>
                  </div>
                )}
              </div>
            </div>

            {/* GPS COORDINATE */}
            <div>
              <div style={{ fontSize: '0.9rem', fontWeight: '700', color: '#1e293b', marginBottom: '10px', letterSpacing: '0.025em' }}>GPS COORDINATE</div>
              <div className="attendance-gps-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px', fontSize: '0.85rem', color: '#334155', fontWeight: '600', marginBottom: '8px' }}>
                <div>LATITUDE: <span style={{ color: '#0f172a' }}>{coords?.latitude ? coords.latitude.toFixed(7) : '—'}</span></div>
                <div>LONGITUDE: <span style={{ color: '#0f172a' }}>{coords?.longitude ? coords.longitude.toFixed(7) : '—'}</span></div>
              </div>
              <div style={{ fontSize: '0.85rem', color: '#334155', fontWeight: '600', marginBottom: '14px' }}>
                ALTITUDE: <span style={{ color: '#0f172a' }}>{attendanceAltitude.normalized !== null ? Number(attendanceAltitude.normalized).toFixed(3) : '—'}</span>
              </div>
              <div className="attendance-location-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.1fr)', gap: '12px', alignItems: 'center' }}>
                <div style={{ fontSize: '0.85rem', color: '#334155', fontWeight: '600', lineHeight: '1.6' }}>
                  <div>CAMPUS: <span style={{ color: '#0f172a' }}>{activeSchedule?.campus_name || '—'}</span></div>
                  <div>BUILDING: <span style={{ color: '#0f172a' }}>{currentBuilding?.building_name || activeSchedule?.building_name || '—'}</span></div>
                  <div>FLOOR: <span style={{ color: '#0f172a' }}>{detectedFloor?.floor_name || activeSchedule?.floor_name || '—'}</span></div>
                  <div>ROOM: <span style={{ color: '#0f172a' }}>{currentRoomObj?.room_name || activeSchedule?.room_name || '—'}</span></div>
                </div>
                <div style={{ backgroundColor: isOutOfRange ? '#dc2626' : '#15803d', color: '#ffffff', padding: '14px 12px', borderRadius: '12px', textAlign: 'center', fontWeight: '800', fontSize: '0.75rem', lineHeight: '1.4', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '64px' }}>
                  {!activeSchedule ? "NO ACTIVE CLASS SCHEDULE" : isOutOfRange ? "YOU'RE CURRENTLY OUTSIDE OF YOUR SCHEDULED ROOM" : "YOU'RE CURRENTLY INSIDE OF YOUR SCHEDULED ROOM"}
                </div>
              </div>
            </div>

            </React.Fragment>}

            {/* PRESERVED WIFI SPEED & MINI DEBUG */}
            <div style={{ borderTop: '1px solid #9ca3af', paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {connectionQuality && (
                <div style={{ fontSize: '0.8rem', color: '#334155', fontWeight: '600' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: '700', color: '#475569', marginBottom: '4px' }}>WIFI SPEED</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontWeight: '700', color: connectionQuality.color }}>● {connectionQuality.label}</span>
                    <span style={{ color: '#475569' }}>
                      {connectionQuality.rtt !== null ? `${connectionQuality.rtt}ms` : ''}
                      {connectionQuality.downlink !== null && typeof connectionQuality.downlink !== 'undefined' ? `${connectionQuality.rtt !== null ? ', ' : ''}${connectionQuality.downlink.toFixed(1)} Mbps` : ''}
                      {connectionQuality.effectiveType && !['offline', 'unknown'].includes(connectionQuality.effectiveType) ? `, ${connectionQuality.effectiveType}` : ''}
                    </span>
                  </div>
                </div>
              )}
              {coords && (
                <div style={{ fontSize: '0.75rem', color: '#475569', lineHeight: '1.4' }}>
                  <div style={{ fontWeight: '700', color: '#334155' }}>GPS STATUS</div>
                  Acc: {coords.accuracy?.toFixed(1)}m | Device: {devicePlatform} | {roomGuideLabel}: {nearestRoomLabel ? nearestRoomLabel.name : 'X'}
                </div>
              )}
            </div>

          </div>

        </div>

        {/* PARALLEL CLASS MODAL */}
        <Modal show={showParallelModal} title="Parallel Classes" onClose={() => setShowParallelModal(false)}>
          <div style={{ width: 'min(100%, 520px)', maxHeight: '70vh', overflowY: 'auto' }}>
            {parallelModalData && parallelModalData.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {parallelModalData.map((item, idx) => {
                  const checkIn = getCheckStatus(item, 'in');
                  const checkMid = getCheckStatus(item, 'mid');
                  const checkOut = getCheckStatus(item, 'out');
                  return (
                    <div key={item.attendance_id || `${item.schedule_id}-${item.date}-${idx}`} style={{ padding: '16px', backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <div style={{ fontWeight: '700', color: '#0f172a', fontSize: '1rem' }}>
                          {item.section_name || 'Section ' + (idx + 1)}
                        </div>
                        <div style={{ fontSize: '0.8rem', color: '#64748b', fontWeight: '600' }}>
                          {item.date} ({getDayOfWeek(item.date)})
                        </div>
                      </div>
                      <div style={{ color: '#475569', fontSize: '0.85rem', marginBottom: '4px' }}>
                        <strong>Subject:</strong> {item.subject_code ? `${item.subject_code} - ${item.subject_name || ''}` : '—'}
                      </div>
                      <div style={{ color: '#475569', fontSize: '0.85rem', marginBottom: '4px' }}>
                        <strong>Time:</strong> {formatTime12(item.start_time)} - {formatTime12(item.end_time)}
                      </div>
                      <div style={{ color: '#475569', fontSize: '0.85rem', marginBottom: '4px' }}>
                        <strong>Room:</strong> {item.room_name || '—'} | <strong>Building:</strong> {item.building_name || '—'} | <strong>Floor:</strong> {item.floor_name || '—'}
                      </div>
                      <div style={{ display: 'flex', gap: '16px', marginTop: '8px', flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', fontWeight: '600' }}>
                          CHECK IN: {renderStatusBadge(checkIn.flagId, checkIn.label)}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', fontWeight: '600' }}>
                          CHECK MID: {renderStatusBadge(checkMid.flagId, checkMid.label)}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', fontWeight: '600' }}>
                          CHECK OUT: {renderStatusBadge(checkOut.flagId, checkOut.label)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ padding: '20px', textAlign: 'center', color: '#64748b', fontSize: '0.9rem' }}>
                No parallel class data available.
              </div>
            )}
          </div>
        </Modal>

        {/* QR and manual-code verification use separate views in one modal. */}
        <Modal show={isCameraVisible} title="Floor Verification" onClose={closeQrVerificationModal}>
          <div
            role="tablist"
            aria-label="Choose floor verification method"
            style={{display:'grid',gridTemplateColumns:'repeat(2, minmax(0, 1fr))',gap:6,padding:5,marginBottom:18,border:'1px solid #dbe4df',borderRadius:12,background:'#f1f5f9'}}
          >
            <button
              type="button"
              role="tab"
              aria-selected={qrVerificationMode === 'scan'}
              onClick={() => setQrVerificationMode('scan')}
              style={{border:0,borderRadius:9,padding:'10px 12px',background:qrVerificationMode === 'scan' ? '#15803d' : 'transparent',color:qrVerificationMode === 'scan' ? '#ffffff' : '#475569',fontWeight:800,fontSize:13,cursor:'pointer',boxShadow:qrVerificationMode === 'scan' ? '0 3px 8px rgba(21,128,61,.2)' : 'none'}}
            >
              QR SCANNING
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={qrVerificationMode === 'code'}
              onClick={() => setQrVerificationMode('code')}
              style={{border:0,borderRadius:9,padding:'10px 12px',background:qrVerificationMode === 'code' ? '#15803d' : 'transparent',color:qrVerificationMode === 'code' ? '#ffffff' : '#475569',fontWeight:800,fontSize:13,cursor:'pointer',boxShadow:qrVerificationMode === 'code' ? '0 3px 8px rgba(21,128,61,.2)' : 'none'}}
            >
              Enter Code
            </button>
          </div>

          {qrVerificationMode === 'scan' ? (
            <div role="tabpanel" aria-label="QR scanning">
              <div style={{marginBottom:12,padding:'10px 12px',borderRadius:10,background:'#ecfdf3',color:'#166534',fontSize:13,lineHeight:1.45}}>
                Point your camera at the QR code displayed on your assigned floor.
              </div>
              <div style={{ position: 'relative', width: 'min(100%, 420px)', minHeight: 'min(300px, 80vw)', margin: '0 auto' }}>
                {previewActive && (
                  <div style={{ marginBottom: 8, textAlign: 'center' }}>
                    <video ref={debugVideoRef} autoPlay playsInline muted id="debug-camera-preview" style={{ width: '100%', maxHeight: 220, objectFit: 'cover', borderRadius: 6 }} />
                  </div>
                )}
                <div id="qr-scanner-container" style={{ width: '100%', minHeight: 'min(300px, 80vw)' }}></div>
                <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 'min(250px, 72vw)', height: 'min(250px, 72vw)', border: '2px solid #00FF00', pointerEvents: 'none', borderRadius: 6 }}></div>
              </div>
            </div>
          ) : (
            <div role="tabpanel" aria-label="Enter floor code" style={{width:'min(100%, 420px)',margin:'0 auto'}}>
              <div style={{marginBottom:16,padding:'12px 14px',borderRadius:10,background:'#f8fafc',border:'1px solid #e2e8f0'}}>
                <div style={{fontSize:14,fontWeight:800,color:'#1f2937'}}>Enter the code below the floor QR</div>
                <div style={{marginTop:4,fontSize:12,color:'#64748b',lineHeight:1.45}}>Use this option when the camera cannot scan the printed QR code.</div>
              </div>
              <form onSubmit={handleManualFloorCodeSubmit}>
                <label htmlFor="manual-floor-code" style={{display:'block',fontSize:14,fontWeight:700,color:'#1f2937',marginBottom:7}}>
                  Manual QR code
                </label>
                <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                  <input
                    id="manual-floor-code"
                    type="text"
                    value={manualFloorCode}
                    onChange={(event) => {
                      setManualFloorCode(event.target.value.toUpperCase().replace(/\s+/g, ''));
                      setManualCodeError('');
                    }}
                    maxLength={16}
                    autoFocus
                    autoCapitalize="characters"
                    autoComplete="off"
                    placeholder="MW2A7K9"
                    aria-invalid={Boolean(manualCodeError)}
                    style={{flex:'1 1 210px',minWidth:0,border:`1px solid ${manualCodeError ? '#dc2626' : '#cbd5e1'}`,borderRadius:8,padding:'11px 12px',fontWeight:700,letterSpacing:'0.08em',textTransform:'uppercase',outline:'none'}}
                  />
                  <button
                    type="submit"
                    disabled={manualCodeVerifying || !manualFloorCode.trim()}
                    style={{flex:'0 0 auto',border:0,borderRadius:8,padding:'11px 18px',background:'#15803d',color:'#fff',fontWeight:700,opacity:(manualCodeVerifying || !manualFloorCode.trim()) ? 0.55 : 1,cursor:(manualCodeVerifying || !manualFloorCode.trim()) ? 'not-allowed' : 'pointer'}}
                  >
                    {manualCodeVerifying ? 'Verifying...' : 'Verify'}
                  </button>
                </div>
                {manualCodeError && <div style={{marginTop:8,color:'#dc2626',fontSize:13,fontWeight:600}}>{manualCodeError}</div>}
              </form>
            </div>
          )}
        </Modal>

      </div>
    </div>
  );
}
