import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AuthContext } from '../../context/AuthContext.jsx';
import { apiUrl, apiFetch, apiGet, apiPost } from '../../services/api.js';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';
import LoadingState from '../../components/LoadingState.jsx';
import TeacherTableView from './TeacherTableView.jsx';
import './Index.css';

function ThreeDBuildingIndex() {
  const auth = React.useContext(AuthContext) || {};
  const currentUser = auth.user || null;
  const canSaveFrontView = Number(currentUser?.role_id) === 1;
  const defaultAvatarSrc = (() => {
    try {
      if (typeof window === 'undefined') return '/src/assets/unknown.jpg';
      const parts = window.location.pathname.split('/').filter(Boolean);
      let projectRoot = '';
      if (parts.length) {
        const first = String(parts[0]).toLowerCase();
        if (first !== 'public') projectRoot = '/' + parts[0];
      }
      return `${projectRoot}/src/assets/unknown.jpg`;
    } catch (e) {
      return '/src/assets/unknown.jpg';
    }
  })();

  const resolveApiAssetUrl = (path) => {
    return apiUrl(path);
  };
  // Models are frontend static assets. Resolve them from the document base so
  // localhost subfolders and a future /tams deployment work without depending
  // on the PHP API address.
  const resolveBuildingModelUrl = (filename) => {
    const safeFilename = String(filename || '').split('/').pop();
    const url = new URL(`building/models/${safeFilename}`, document.baseURI);
    const assetVersion = window.APP_ASSET_VERSIONS?.[url.pathname];
    if (assetVersion) url.searchParams.set('v', assetVersion);
    return url.href;
  };
  const resolveStoredBuildingModelUrl = (path, version = '') => {
    const cleanPath = String(path || '').replace(/^\/+/, '');
    if (!cleanPath) return null;
    const url = new URL(cleanPath, document.baseURI);
    const staticAssetVersion = window.APP_ASSET_VERSIONS?.[url.pathname];
    if (staticAssetVersion) url.searchParams.set('v', staticAssetVersion);
    else if (version) url.searchParams.set('v', String(version));
    return url.href;
  };
  const bundledModelFilenameForBuilding = (buildingName) => {
    const normalized = String(buildingName || '').trim().toLowerCase();
    if (normalized.includes('main west') || normalized.includes('mainwest') || normalized.includes('main_west') || normalized === 'mw') return 'MW.glb';
    if (normalized.includes('main south') || normalized.includes('mainsouth') || normalized.includes('main_south') || normalized === 'ms') return 'MS.glb';
    if (normalized.includes('phinma hall') || normalized.includes('phinmahall') || normalized.includes('phinma_hall') || normalized === 'ph') return 'PH.glb';
    if (normalized.includes('main north') || normalized.includes('mainnorth') || normalized.includes('main_north') || normalized === 'mn') return 'MN.glb';
    if (normalized.includes('senior high') || normalized.includes('seniorhigh') || normalized.includes('senior_high') || normalized === 'shs') return 'SHS.glb';
    if (normalized === 'bed' || normalized.includes('basic education')) return 'BED.glb';
    return null;
  };
  const getBuildingModelSrc = (buildingName) => {
    const normalized = String(buildingName || '').trim();
    if (!normalized) return null;
    const storedBuilding = (catalog?.buildings || []).find((building) => nameEq(building.building_name, normalized));
    if (storedBuilding) {
      return resolveStoredBuildingModelUrl(
        storedBuilding.model_path,
        storedBuilding.model_updated_at || storedBuilding.model_size || ''
      );
    }
    const bundledFilename = bundledModelFilenameForBuilding(normalized);
    return bundledFilename ? resolveBuildingModelUrl(bundledFilename) : null;
  };
  const defaultCameraPresets = {
    Building_PhinmaHall: { position: [-22, 10, 22], target: [0, 3, 0] },
    Building_MainSouth: { position: [22, 10, 16], target: [0, 3, 0] },
    Building_MainNorth: { position: [-22, 10, -16], target: [0, 3, 0] },
    Building_MainWest: { position: [22, 10, -16], target: [0, 3, 0] },
    Building_SeniorHigh: { position: [22, 10, -16], target: [0, 3, 0] },
    Building_BED: { position: [22, 10, -16], target: [0, 3, 0] },
    PhinmaHall: { position: [-22, 10, 22], target: [0, 3, 0] },
    MainSouth: { position: [22, 10, 16], target: [0, 3, 0] },
    MainNorth: { position: [-22, 10, -16], target: [0, 3, 0] },
    MainWest: { position: [22, 10, -16], target: [0, 3, 0] },
    SeniorHigh: { position: [22, 10, -16], target: [0, 3, 0] },
    'Senior High Building': { position: [22, 10, -16], target: [0, 3, 0] },
    BED: { position: [22, 10, -16], target: [0, 3, 0] }
  };
  const cameraModelDefinitions = {
    MW: { code: 'MW', cameraKey: 'Building_MainWest', aliasKey: 'MainWest', filename: 'MW.glb' },
    MN: { code: 'MN', cameraKey: 'Building_MainNorth', aliasKey: 'MainNorth', filename: 'MN.glb' },
    MS: { code: 'MS', cameraKey: 'Building_MainSouth', aliasKey: 'MainSouth', filename: 'MS.glb' },
    PH: { code: 'PH', cameraKey: 'Building_PhinmaHall', aliasKey: 'PhinmaHall', filename: 'PH.glb' },
    SHS: { code: 'SHS', cameraKey: 'Building_SeniorHigh', aliasKey: 'SeniorHigh', filename: 'SHS.glb' },
    BED: { code: 'BED', cameraKey: 'Building_BED', aliasKey: 'BED', filename: 'BED.glb' }
  };
  const getCameraModelDefinition = (source = modelSrcRef.current) => {
    let pathname = String(source || '');
    try { pathname = new URL(source, window.location.href).pathname; } catch (e) { /* use raw source */ }
    const filename = decodeURIComponent(pathname).split('/').pop()?.toLowerCase() || '';
    const matchedBuilding = (catalog?.buildings || []).find((building) => {
      const storedUrl = resolveStoredBuildingModelUrl(building.model_path);
      if (!storedUrl) return false;
      try { return new URL(storedUrl).pathname === pathname; } catch (error) { return false; }
    });
    const knownFilename = bundledModelFilenameForBuilding(matchedBuilding?.building_name || '');
    const knownDefinition = Object.values(cameraModelDefinitions).find((entry) => (
      entry.filename.toLowerCase() === filename
      || (knownFilename && entry.filename.toLowerCase() === knownFilename.toLowerCase())
    ));
    if (knownDefinition) return { ...knownDefinition, buildingId: matchedBuilding?.building_id || null };
    if (matchedBuilding?.building_id) {
      return {
        code: `B${matchedBuilding.building_id}`,
        cameraKey: `Building_ID_${matchedBuilding.building_id}`,
        aliasKey: matchedBuilding.building_name,
        filename,
        buildingId: matchedBuilding.building_id
      };
    }
    return null;
  };

  const [modelSrc, setModelSrc] = useState('');
  const [viewMode, setViewMode] = useState('3d');
  const [graphicsMode, setGraphicsMode] = useState(() => {
    try {
      const savedMode = window.localStorage.getItem('tdb_graphics_mode');
      return savedMode === 'high' ? 'high' : 'performance';
    } catch (error) {
      return 'performance';
    }
  });
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('');
  const [presenceMarkers, setPresenceMarkers] = useState([]);
  const [presenceMarkersVisible, setPresenceMarkersVisible] = useState(true);
  const [movementGuideExpanded, setMovementGuideExpanded] = useState(true);
  const [presenceLastUpdated, setPresenceLastUpdated] = useState('');
  const [presenceError, setPresenceError] = useState('');
  const [presenceDiagnostics, setPresenceDiagnostics] = useState({ unmatched: [], duplicates: [] });
  const [presenceRefreshToken, setPresenceRefreshToken] = useState(0);
  const [attendanceRecords, setAttendanceRecords] = useState([]);
  const [attendanceRecordsLoading, setAttendanceRecordsLoading] = useState(true);
  const [attendanceRecordsError, setAttendanceRecordsError] = useState('');
  const [attendanceRefreshToken, setAttendanceRefreshToken] = useState(0);
  const [nowTime, setNowTime] = useState(new Date());
  const [catalog, setCatalog] = useState({ schools: [], buildings: [], floors: [], rooms: [] });
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [scheduleCatalog, setScheduleCatalog] = useState([]);
  const [scheduleCatalogLoaded, setScheduleCatalogLoaded] = useState(false);

  const [searchTeacher, setSearchTeacher] = useState('');
  const [selectedDepartment, setSelectedDepartment] = useState('');
  const [pendingFilters, setPendingFilters] = useState({ campus: '', building: '', floor: '', room: '' });
  const [appliedFilters, setAppliedFilters] = useState({ campus: '', building: '', floor: '', room: '' });
  const [logsPage, setLogsPage] = useState(1);
  const [recentLogStatusFilter, setRecentLogStatusFilter] = useState('recent');
  const [pagedLogs, setPagedLogs] = useState([]);
  const [recentLogsLoading, setRecentLogsLoading] = useState(true);
  const [recentLogsError, setRecentLogsError] = useState('');
  const [recentLogsPagination, setRecentLogsPagination] = useState({ page: 1, page_size: 15, total: 0, total_pages: 1 });
  const [hoveredLogGroup, setHoveredLogGroup] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [sceneBusyLabel, setSceneBusyLabel] = useState('Loading 3D model');
  const [isUploadBusy, setIsUploadBusy] = useState(false);
  const [pendingUpload, setPendingUpload] = useState(null);
  const [moveModeEnabled, setMoveModeEnabled] = useState(false);
  const [activeUploadTransform, setActiveUploadTransform] = useState(null);
  const [teacherStatusModal, setTeacherStatusModal] = useState(null);
  const [availableCameras, setAvailableCameras] = useState(null);
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [roomListOpen, setRoomListOpen] = useState(true);
  const [roomListFilter, setRoomListFilter] = useState('');
  const [buildingExplorerOpen, setBuildingExplorerOpen] = useState(true);
  const [buildingSearchText, setBuildingSearchText] = useState('');
  const [navigatorBuilding, setNavigatorBuilding] = useState('');
  const [navigatorFloor, setNavigatorFloor] = useState('');
  const [navigatorRoom, setNavigatorRoom] = useState('');
  const [cameraPresets, setCameraPresets] = useState(defaultCameraPresets);
  const [isSavingFrontView, setIsSavingFrontView] = useState(false);
  const [modelHierarchy, setModelHierarchy] = useState({ buildings: [], floors: [], rooms: [] });

  const viewerWrapRef = useRef(null);
  const mountRef = useRef(null);
  const mainPanelRef = useRef(null);
  const logsPanelRef = useRef(null);
  const fileInputRef = useRef(null);
  const buildingModelInputRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const rendererRef = useRef(null);
  const controlsRef = useRef(null);
  const modelRef = useRef(null);
  const modelInitialQuaternionRef = useRef(null);
  const frameNextBuildingModelRef = useRef(false);
  const uploadedObjectsRef = useRef([]);
  const meshMapRef = useRef({});
  const meshNameCollisionsRef = useRef({});
  const requestRef = useRef(null);
  const graphicsModeRef = useRef(graphicsMode);
  const interactiveRenderingRef = useRef(false);
  const graphicsRestoreTimerRef = useRef(null);
  const lastSceneRenderAtRef = useRef(0);
  const camAnimRef = useRef(null);
  const fullscreenRef = useRef(false);
  const sceneBusyRef = useRef(true);
  const nativeFullscreenRef = useRef(false);
  const filePickerActiveRef = useRef(false);
  const pendingUploadObjectRef = useRef(null);
  const pendingUploadActiveRef = useRef(false);
  const uploadAnchorRefs = useRef({});
  const uploadAnchorPositionsRef = useRef([
    { id: 'upload-anchor-left', x: -25, y: 0, z: 0 },
    { id: 'upload-anchor-right', x: 25, y: 0, z: 0 }
  ]);
  const moveModeRef = useRef(false);
  const selectedUploadAnchorIdRef = useRef('upload-anchor-left');
  const raycasterRef = useRef(null);
  const dragStateRef = useRef({
    active: false,
    pointerId: null,
    object: null,
    plane: null,
    offsetX: 0,
    offsetZ: 0
  });
  const presenceMarkerRefs = useRef({});
  const presenceAnchorsRef = useRef({});
  const presenceVersionRef = useRef('');
  const presenceMarkersVisibleRef = useRef(true);
  const namedCameraDataRef = useRef(null);
  const cameraTweenTokenRef = useRef(0);
  const pendingNavigatorRoomRef = useRef(null);
  const keyboardKeysRef = useRef(new Set());
  const keyboardAnimationRef = useRef(null);
  const keyboardLastFrameRef = useRef(0);
  const cameraMoveSpeedRef = useRef(4);
  const fittedViewRef = useRef({ active: false, direction: [1, 0.45, 1] });
  const cameraPresetsRef = useRef(defaultCameraPresets);
  const modelSrcRef = useRef('');
  const modelLoadMeterRef = useRef(null);
  const modelLoadFillRef = useRef(null);
  const modelLoadValueRef = useRef(null);

  const updateModelLoadProgress = (value) => {
    const percentage = Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
    modelLoadMeterRef.current?.setAttribute('aria-valuenow', String(percentage));
    if (modelLoadFillRef.current) {
      modelLoadFillRef.current.style.strokeDashoffset = String(100 - percentage);
    }
    if (modelLoadValueRef.current) {
      modelLoadValueRef.current.textContent = String(percentage);
    }
  };

  const uniqueValues = (list) => Array.from(new Set((list || []).filter(Boolean)));
  const isEntityActive = (entity) => ['active', '1', 'true'].includes(String(entity?.status || '').trim().toLowerCase());
  const normalizeKey = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/building[_\s-]*/gi, '')
    .replace(/room[_\s-]*/gi, '')
    .replace(/floor[_\s-]*/gi, '')
    .replace(/[^a-z0-9]+/g, '');
  const nameEq = (a, b) => normalizeKey(a) === normalizeKey(b);
  const normalizeNavigator = (value, prefix) => normalizeKey(String(value || '').replace(new RegExp(`^${prefix}`, 'i'), ''));
  const toLocalYmd = (dateValue = new Date()) => {
    const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const selectedScheduleDate = toLocalYmd(nowTime);
  const [selectedTableDate, setSelectedTableDate] = useState(() => toLocalYmd());
  const [modalScheduleDate, setModalScheduleDate] = useState(() => toLocalYmd());
  const [modalAttendanceRecords, setModalAttendanceRecords] = useState([]);
  const [modalRecordsLoading, setModalRecordsLoading] = useState(false);
  const [modalRecordsError, setModalRecordsError] = useState('');
  const [modalTodayAttendanceRecords, setModalTodayAttendanceRecords] = useState([]);
  const [modalTodayRecordsLoading, setModalTodayRecordsLoading] = useState(false);
  const [modalTodayRecordsError, setModalTodayRecordsError] = useState('');
  const currentDateKey = toLocalYmd(nowTime);

  const normalizeMeshKey = (name) => {
    return String(name || '')
      .trim()
      .toLowerCase()
      .replace(/\.\d+$/, '') // strip Blender suffix like .001
      .replace(/[\s._-]+/g, '');
  };

  const toDisplayName = (value) => {
    const text = String(value || '').trim();
    if (!text) return '';
    return text.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  };

  const buildModelHierarchy = (object) => {
    if (!object) return { buildings: [], floors: [], rooms: [] };

    const buildingMap = new Map();
    const floorMap = new Map();
    const roomMap = new Map();

    const addBuilding = (name) => {
      if (!name) return null;
      const key = String(name).trim().toLowerCase();
      if (!buildingMap.has(key)) {
        const displayName = toDisplayName(name.replace(/^Building\s*/i, ''));
        buildingMap.set(key, { name, displayName });
      }
      return buildingMap.get(key);
    };

    const addFloor = (buildingName, floorName) => {
      if (!buildingName || !floorName) return null;
      const key = `${String(buildingName).trim().toLowerCase()}::${String(floorName).trim().toLowerCase()}`;
      if (!floorMap.has(key)) {
        floorMap.set(key, { buildingName, floorName, displayName: toDisplayName(floorName) });
      }
      return floorMap.get(key);
    };

    const addRoom = (buildingName, floorName, roomName) => {
      if (!roomName) return null;
      const key = `${String(buildingName || '').trim().toLowerCase()}::${String(floorName || '').trim().toLowerCase()}::${String(roomName).trim().toLowerCase()}`;
      if (!roomMap.has(key)) {
        roomMap.set(key, { buildingName, floorName, roomName, displayName: toDisplayName(roomName) });
      }
      return roomMap.get(key);
    };

    const visit = (node, parentBuilding = '', parentFloor = '') => {
      if (!node || !node.name) return;
      const rawName = String(node.name).trim();
      const cleaned = rawName.replace(/\.\d+$/, '');
      const buildingMatch = cleaned.match(/Building[_\s-]+(.+)/i);
      const floorMatch = cleaned.match(/Floor[_\s-]+(\d+)/i);
      const roomMatch = cleaned.match(/Room[_\s-]+([^/]+)$/i);
      const buildingName = buildingMatch?.[1] ? `Building_${buildingMatch[1]}` : parentBuilding;
      const floorName = floorMatch?.[1] ? `Floor_${floorMatch[1]}` : parentFloor;
      const roomName = roomMatch?.[1] ? `Room_${roomMatch[1]}`.trim() : '';

      if (buildingName) {
        const buildingEntry = addBuilding(buildingName);
        if (floorName) addFloor(buildingEntry?.name || buildingName, floorName);
        if (roomName && buildingEntry) addRoom(buildingEntry.name, floorName || '', roomName);
      } else if (floorName) {
        addFloor(parentBuilding || 'Campus', floorName);
        if (roomName) addRoom(parentBuilding || 'Campus', floorName, roomName);
      } else if (roomName) {
        addRoom(parentBuilding || 'Campus', parentFloor || '', roomName);
      }

      (node.children || []).forEach((child) => visit(child, buildingName || parentBuilding, floorName || parentFloor));
    };

    visit(object);

    return {
      buildings: Array.from(buildingMap.values()),
      floors: Array.from(floorMap.values()),
      rooms: Array.from(roomMap.values())
    };
  };

  const getPresetForTarget = (targetName) => {
    const normalized = String(targetName || '').trim();
    if (!normalized) return null;
    const variants = [normalized, normalized.replace(/^Building_/i, ''), normalized.replace(/^Room_/i, 'Room_')];
    for (const variant of variants) {
      const direct = cameraPresets?.[variant];
      const alt = cameraPresets?.[`Building_${variant}`];
      if (direct) return direct;
      if (alt) return alt;
    }
    return null;
  };

  useEffect(() => {
    fullscreenRef.current = isFullscreen;
  }, [isFullscreen]);

  useEffect(() => {
    cameraPresetsRef.current = cameraPresets;
  }, [cameraPresets]);

  useEffect(() => {
    modelSrcRef.current = modelSrc;
  }, [modelSrc]);

  useEffect(() => {
    sceneBusyRef.current = status === 'loading' || isUploadBusy;
  }, [status, isUploadBusy]);

  useEffect(() => {
    presenceMarkersVisibleRef.current = presenceMarkersVisible;
    requestSceneRender();
  }, [presenceMarkersVisible]);

  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    if (isFullscreen) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = originalOverflow;

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isFullscreen]);

  useEffect(() => {
    if (!isFullscreen) return undefined;

    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (nativeFullscreenRef.current) return;
      setIsFullscreen(false);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen]);

  useEffect(() => {
    requestAnimationFrame(() => {
      syncViewerSize();
      updateUploadAnchorButtons();
    });
  }, [isFullscreen]);

  useEffect(() => {
    moveModeRef.current = moveModeEnabled;
    if (!moveModeEnabled) stopDraggingMoveTarget();
    updateViewerCursor();
  }, [moveModeEnabled]);

  useEffect(() => {
    if (!activeUploadTransform && moveModeEnabled) {
      setMoveModeEnabled(false);
      return;
    }
    updateViewerCursor();
  }, [activeUploadTransform, moveModeEnabled]);

  useEffect(() => {
    const handleWindowFocus = () => {
      if (!filePickerActiveRef.current) return;
      window.setTimeout(() => {
        filePickerActiveRef.current = false;
        requestAnimationFrame(() => syncViewerSize());
      }, 240);
    };

    window.addEventListener('focus', handleWindowFocus);
    return () => window.removeEventListener('focus', handleWindowFocus);
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement || null;
      const viewerIsFullscreen = fullscreenElement === viewerWrapRef.current;
      const hadNativeFullscreen = nativeFullscreenRef.current;
      nativeFullscreenRef.current = viewerIsFullscreen;
      if (viewerIsFullscreen) {
        setIsFullscreen(true);
      } else if (hadNativeFullscreen && !filePickerActiveRef.current) {
        setIsFullscreen(false);
      }
      requestAnimationFrame(() => syncViewerSize());
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);
    handleFullscreenChange();

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    };
  }, []);

  const smoothCameraTo = (targetPos, targetLookAt, duration = 700, onComplete) => {
    if (!cameraRef.current) return;
    if (camAnimRef.current) cancelAnimationFrame(camAnimRef.current);
    beginInteractiveRendering();
    fittedViewRef.current.active = false;

    const cam = cameraRef.current;
    cam.zoom = 1;
    cam.updateProjectionMatrix();
    const startPos = cam.position.clone();
    const startTarget = controlsRef.current?.target ? controlsRef.current.target.clone() : new window.THREE.Vector3(0, 0, 0);
    const endPos = targetPos.clone();
    const endTarget = targetLookAt.clone();
    const startTime = performance.now();

    const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    const step = (now) => {
      const t = Math.min(1, (now - startTime) / duration);
      const k = easeInOutCubic(t);
      cam.position.lerpVectors(startPos, endPos, k);
      if (controlsRef.current) {
        controlsRef.current.target.lerpVectors(startTarget, endTarget, k);
        controlsRef.current.update();
      } else {
        cam.lookAt(endTarget);
      }
      requestSceneRender();
      if (t < 1) {
        camAnimRef.current = requestAnimationFrame(step);
      } else {
        camAnimRef.current = null;
        endInteractiveRendering();
        if (onComplete) {
          try { onComplete(); } catch (e) { /* ignore */ }
        }
      }
    };
    camAnimRef.current = requestAnimationFrame(step);
  };

  const animateCameraToPreset = (targetName, onComplete) => {
    const preset = getPresetForTarget(targetName);
    if (!preset || !cameraRef.current) {
      if (typeof onComplete === 'function') onComplete();
      return false;
    }

    cameraTweenTokenRef.current += 1;
    const token = cameraTweenTokenRef.current;
    const position = new window.THREE.Vector3(...(preset.position || [0, 0, 0]));
    const target = new window.THREE.Vector3(...(preset.target || [0, 0, 0]));
    smoothCameraTo(position, target, 1300, () => {
      if (token !== cameraTweenTokenRef.current) return;
      if (typeof onComplete === 'function') onComplete();
    });
    return true;
  };

  const focusBuildingCamera = (buildingName, onDone) => {
    if (!buildingName) return false;
    const preset = getPresetForTarget(buildingName);
    if (!preset) return false;
    animateCameraToPreset(buildingName, onDone);
    return true;
  };

  const extractTimeText = (value) => {
    const txt = String(value || '').trim();
    if (!txt) return '';
    const match = txt.match(/(?:T|\s|^)(\d{1,2}:\d{2}(?::\d{2})?)/);
    return match ? match[1] : txt;
  };
  const toMinutes = (t) => {
    const txt = extractTimeText(t);
    if (!txt) return null;
    const parts = txt.split(':');
    if (parts.length < 2) return null;
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return (h * 60) + m;
  };
  const formatClock = (timeText) => {
    const txt = extractTimeText(timeText);
    if (!txt) return '--:--';
    const parts = txt.split(':');
    if (parts.length < 2) return txt;
    let h = Number(parts[0]);
    const m = parts[1];
    if (!Number.isFinite(h)) return txt;
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${m}${ampm}`;
  };
  const toDateTime = (dateText, timeText) => {
    const d = String(dateText || '').trim();
    const rawTime = String(timeText || '').trim();
    if (/^\d{4}-\d{2}-\d{2}[ T]/.test(rawTime)) {
      const direct = new Date(rawTime.replace(' ', 'T'));
      if (!Number.isNaN(direct.getTime())) return direct;
    }
    const t = extractTimeText(rawTime);
    if (!d || !t) return null;
    const dt = new Date(`${d}T${t}`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  };
  const normalizeDateKey = (value) => {
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
  };
  const dayNameForDate = (dateValue) => {
    const key = normalizeDateKey(dateValue);
    if (!key) return '';
    const d = new Date(`${key}T00:00:00`);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  };
  const modalDateParts = (dateValue) => {
    const key = normalizeDateKey(dateValue) || toLocalYmd();
    const date = new Date(`${key}T00:00:00`);
    if (Number.isNaN(date.getTime())) {
      return { day: 'Selected day', date: key };
    }
    return {
      day: date.toLocaleDateString('en-US', { weekday: 'long' }),
      date: date.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      })
    };
  };
  const isDateWithinScheduleRange = (dateValue, startValue, endValue) => {
    const dateKey = normalizeDateKey(dateValue);
    const startKey = normalizeDateKey(startValue);
    const endKey = normalizeDateKey(endValue);
    if (!dateKey) return false;
    if (startKey && dateKey < startKey) return false;
    if (endKey && dateKey > endKey) return false;
    return true;
  };
  const deriveBuildingFromRoom = (roomName) => {
    const match = String(roomName || '').trim().match(/^([A-Za-z]+)[-\s]/);
    if (match && match[1]) return match[1].toUpperCase();
    return '';
  };
  const deriveFloorFromRoom = (roomName, buildingName = '') => {
    const room = String(roomName || '').trim();
    const digits = room.match(/(\d{3,4})/);
    if (!digits || !digits[1]) return '';
    const level = Number(digits[1].charAt(0));
    if (!level || Number.isNaN(level)) return '';
    const ordMap = { 1: '1ST', 2: '2ND', 3: '3RD', 4: '4TH', 5: '5TH' };
    const ord = ordMap[level] || `${level}TH`;
    const b = buildingName || deriveBuildingFromRoom(room);
    return b ? `${b}-${ord}-FLOOR` : `${ord}-FLOOR`;
  };
  const supportedUploadExts = ['.glb', '.gltf', '.obj', '.fbx', '.stl'];
  const moveNudgeStep = 0.5;
  const uploadAnchorDefs = [
    { id: 'upload-anchor-left', label: 'Add building on the left' },
    { id: 'upload-anchor-right', label: 'Add building on the right' }
  ];
  const getMoveTargetObject = () => pendingUploadObjectRef.current || uploadedObjectsRef.current[0] || null;
  const syncActiveUploadTransform = (object = getMoveTargetObject()) => {
    if (!object) {
      setActiveUploadTransform(null);
      return;
    }

    const next = {
      name: object.name || 'uploaded model',
      x: Number(object.position.x.toFixed(2)),
      y: Number(object.position.y.toFixed(2)),
      z: Number(object.position.z.toFixed(2))
    };

    setActiveUploadTransform((prev) => {
      if (
        prev
        && prev.name === next.name
        && prev.x === next.x
        && prev.y === next.y
        && prev.z === next.z
      ) {
        return prev;
      }
      return next;
    });
  };
  const updateViewerCursor = () => {
    const canvas = rendererRef.current?.domElement;
    if (!canvas) return;
    if (dragStateRef.current.active) {
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (moveModeRef.current && getMoveTargetObject()) {
      canvas.style.cursor = 'grab';
      return;
    }
    canvas.style.cursor = '';
  };
  const stopDraggingMoveTarget = () => {
    const canvas = rendererRef.current?.domElement;
    const dragState = dragStateRef.current;
    if (canvas && dragState.pointerId != null && typeof canvas.releasePointerCapture === 'function') {
      try { canvas.releasePointerCapture(dragState.pointerId); } catch (e) { /* ignore */ }
    }
    dragStateRef.current = {
      active: false,
      pointerId: null,
      object: null,
      plane: null,
      offsetX: 0,
      offsetZ: 0
    };
    if (controlsRef.current) controlsRef.current.enabled = true;
    updateViewerCursor();
  };
  const applyUploadAnchorPlacement = (object) => {
    if (!object || !window.THREE) return;
    const anchor = uploadAnchorPositionsRef.current.find((item) => item.id === selectedUploadAnchorIdRef.current)
      || uploadAnchorPositionsRef.current[0]
      || null;
    if (!anchor) return;
    object.position.add(new window.THREE.Vector3(anchor.x, 0, anchor.z));
  };
  const storeInitialUploadPosition = (object) => {
    if (!object || !window.THREE) return;
    object.userData.initialViewerPosition = object.position.clone();
  };
  const resetMoveTargetPosition = () => {
    const object = getMoveTargetObject();
    const initialPosition = object?.userData?.initialViewerPosition || null;
    if (!object || !initialPosition) return;
    object.position.copy(initialPosition);
    if (controlsRef.current) controlsRef.current.update();
    syncActiveUploadTransform(object);
    requestSceneRender();
    setMessage(`Reset "${object.name || 'uploaded model'}" to its initial viewer position.`);
  };
  const nudgeMoveTarget = (dx = 0, dy = 0, dz = 0) => {
    const object = getMoveTargetObject();
    if (!object) return;
    stopDraggingMoveTarget();
    object.position.x += dx;
    object.position.y += dy;
    object.position.z += dz;
    if (controlsRef.current) controlsRef.current.update();
    syncActiveUploadTransform(object);
    requestSceneRender();
  };

  const disposeMaterial = (material) => {
    if (!material) return;
    if (Array.isArray(material)) {
      material.forEach(disposeMaterial);
      return;
    }
    Object.values(material).forEach((value) => {
      if (value && value.isTexture && typeof value.dispose === 'function') {
        try { value.dispose(); } catch (e) { /* ignore */ }
      }
    });
    if (typeof material.dispose === 'function') {
      try { material.dispose(); } catch (e) { /* ignore */ }
    }
  };

  const disposeObject = (object) => {
    if (!object) return;
    object.traverse((child) => {
      if (child.geometry && typeof child.geometry.dispose === 'function') {
        try { child.geometry.dispose(); } catch (e) { /* ignore */ }
      }
      if (child.material) disposeMaterial(child.material);
    });
  };

  const removeSceneObject = (object) => {
    if (!object) return;
    if (object.parent) object.parent.remove(object);
    disposeObject(object);
  };

  const clearUploadedObjects = ({ suppressTransformSync = false } = {}) => {
    stopDraggingMoveTarget();
    uploadedObjectsRef.current.forEach((object) => removeSceneObject(object));
    uploadedObjectsRef.current = [];
    if (!suppressTransformSync) syncActiveUploadTransform(null);
    requestSceneRender();
  };

  const setPendingUploadState = (nextUpload) => {
    pendingUploadActiveRef.current = !!nextUpload;
    setPendingUpload(nextUpload);
  };

  const setAcceptedUploadsVisible = (visible) => {
    uploadedObjectsRef.current.forEach((object) => {
      if (object) object.visible = visible;
    });
    requestSceneRender();
  };

  const clearPendingUploadPreview = ({ restoreCommitted = false, suppressState = false, suppressTransformSync = false } = {}) => {
    stopDraggingMoveTarget();
    if (pendingUploadObjectRef.current) {
      removeSceneObject(pendingUploadObjectRef.current);
      pendingUploadObjectRef.current = null;
    }
    if (restoreCommitted) setAcceptedUploadsVisible(true);
    if (suppressState) {
      pendingUploadActiveRef.current = false;
    } else {
      setPendingUploadState(null);
    }
    if (!suppressTransformSync) syncActiveUploadTransform();
    requestSceneRender();
  };

  const rebuildMeshMap = (object) => {
    const nextMeshMap = {};
    const collisions = {};
    object?.traverse((child) => {
      if (!child.isMesh) return;
      const normalized = normalizeMeshKey(child.name);
      if (normalized) {
        if (nextMeshMap[normalized]) {
          collisions[normalized] = [
            ...(collisions[normalized] || [nextMeshMap[normalized].name]),
            child.name
          ];
        } else {
          nextMeshMap[normalized] = child;
        }
      }
    });
    meshMapRef.current = nextMeshMap;
    meshNameCollisionsRef.current = collisions;
  };

  const centerObjectAtOrigin = (object) => {
    if (!object || !window.THREE) return;
    const box = new window.THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const center = box.getCenter(new window.THREE.Vector3());
    object.position.sub(center);
  };
  const placeObjectOnGround = (object, groundY = 0) => {
    if (!object || !window.THREE) return;
    const box = new window.THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    object.position.y += groundY - box.min.y;
  };

  const frameObjectInCamera = (
    object,
    directionValues = [1, 0.45, 1],
    rememberView = true
  ) => {
    if (!object || !cameraRef.current || !window.THREE) return;
    object.updateWorldMatrix?.(true, true);
    const box = new window.THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const camera = cameraRef.current;
    const center = box.getCenter(new window.THREE.Vector3());
    const size = box.getSize(new window.THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const direction = new window.THREE.Vector3(...directionValues);
    if (direction.lengthSq() === 0) direction.set(1, 0.45, 1);
    direction.normalize();

    camera.position.copy(center).add(direction);
    camera.lookAt(center);
    camera.updateMatrixWorld(true);

    const inverseCameraRotation = camera.quaternion.clone().invert();
    const verticalFov = window.THREE.MathUtils.degToRad(camera.fov);
    const tanVertical = Math.tan(verticalFov / 2);
    const tanHorizontal = tanVertical * Math.max(camera.aspect, 0.01);
    let fitDistance = 0;

    [box.min.x, box.max.x].forEach((x) => {
      [box.min.y, box.max.y].forEach((y) => {
        [box.min.z, box.max.z].forEach((z) => {
          const localCorner = new window.THREE.Vector3(x, y, z)
            .sub(center)
            .applyQuaternion(inverseCameraRotation);
          fitDistance = Math.max(
            fitDistance,
            localCorner.z + Math.abs(localCorner.x) / tanHorizontal,
            localCorner.z + Math.abs(localCorner.y) / tanVertical
          );
        });
      });
    });

    fitDistance = Math.max(fitDistance * 1.05, maxDim * 0.55, camera.near * 4);
    camera.position.copy(center).add(direction.multiplyScalar(fitDistance));
    camera.lookAt(center);
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    if (controlsRef.current) {
      controlsRef.current.target.copy(center);
      controlsRef.current.update();
    }
    cameraMoveSpeedRef.current = Math.max(maxDim * 0.12, 1);
    if (rememberView) {
      fittedViewRef.current = { active: true, direction: [...directionValues] };
    }
    requestSceneRender();
  };

  const syncViewerSize = () => {
    if (!mountRef.current || !cameraRef.current || !rendererRef.current) return;
    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;
    if (!width || !height) return;
    cameraRef.current.aspect = width / height;
    cameraRef.current.updateProjectionMatrix();
    rendererRef.current.setSize(width, height);
    if (fittedViewRef.current.active && modelRef.current) {
      frameObjectInCamera(
        modelRef.current,
        fittedViewRef.current.direction,
        false
      );
      return;
    }
    requestSceneRender();
  };

  const setUploadAnchorRef = (id, node) => {
    if (node) uploadAnchorRefs.current[id] = node;
    else delete uploadAnchorRefs.current[id];
  };

  const hideUploadAnchorButtons = () => {
    Object.values(uploadAnchorRefs.current).forEach((button) => {
      if (!button) return;
      button.style.display = 'none';
    });
  };

  const updateUploadAnchorLayout = (rootObject = modelRef.current) => {
    if (!window.THREE || !rootObject) {
      uploadAnchorPositionsRef.current = [
        { id: 'upload-anchor-left', x: -25, y: 0, z: 0 },
        { id: 'upload-anchor-right', x: 25, y: 0, z: 0 }
      ];
      return;
    }

    const box = new window.THREE.Box3().setFromObject(rootObject);
    if (box.isEmpty()) return;

    const center = box.getCenter(new window.THREE.Vector3());
    const size = box.getSize(new window.THREE.Vector3());
    const sidePadding = Math.max(size.x * 0.08, 4);
    const anchorY = box.min.y + Math.max(size.y * 0.04, 0.25);

    uploadAnchorPositionsRef.current = [
      { id: 'upload-anchor-left', x: box.min.x - sidePadding, y: anchorY, z: center.z },
      { id: 'upload-anchor-right', x: box.max.x + sidePadding, y: anchorY, z: center.z }
    ];
  };

  const updateUploadAnchorButtons = () => {
    if (!mountRef.current || !cameraRef.current || !window.THREE) return;
    if (!fullscreenRef.current || sceneBusyRef.current || pendingUploadActiveRef.current) {
      hideUploadAnchorButtons();
      return;
    }

    const rect = mountRef.current.getBoundingClientRect();
    uploadAnchorPositionsRef.current.forEach((anchor) => {
      const button = uploadAnchorRefs.current[anchor.id];
      if (!button) return;

      const point = new window.THREE.Vector3(anchor.x, anchor.y, anchor.z).project(cameraRef.current);
      if (point.z < -1 || point.z > 1) {
        button.style.display = 'none';
        return;
      }

      const x = (point.x * 0.5 + 0.5) * rect.width;
      const y = (-point.y * 0.5 + 0.5) * rect.height;
      if (x < -48 || x > rect.width + 48 || y < -48 || y > rect.height + 48) {
        button.style.display = 'none';
        return;
      }

      button.style.display = 'inline-flex';
      button.style.left = `${x}px`;
      button.style.top = `${y}px`;
    });
  };

  const updatePresenceMarkerPositions = () => {
    const camera = cameraRef.current;
    const mount = mountRef.current;
    const wrap = viewerWrapRef.current;
    const visible = presenceMarkersVisibleRef.current && !sceneBusyRef.current;
    if (!camera || !mount || !wrap || !window.THREE || !visible) {
      Object.values(presenceMarkerRefs.current).forEach((node) => {
        if (node) node.style.display = 'none';
      });
      return;
    }

    const mountRect = mount.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    Object.entries(presenceMarkerRefs.current).forEach(([roomId, node]) => {
      if (!node) return;
      const anchor = presenceAnchorsRef.current[roomId];
      if (!anchor) {
        node.style.display = 'none';
        return;
      }

      const projected = anchor.clone().project(camera);
      if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1.08 || Math.abs(projected.y) > 1.08) {
        node.style.display = 'none';
        return;
      }

      const x = (mountRect.left - wrapRect.left) + ((projected.x * 0.5 + 0.5) * mountRect.width);
      const y = (mountRect.top - wrapRect.top) + ((-projected.y * 0.5 + 0.5) * mountRect.height);
      node.style.display = 'inline-flex';
      node.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -100%)`;
    });
  };

  const renderScene = () => {
    if (rendererRef.current && sceneRef.current && cameraRef.current) {
      rendererRef.current.render(sceneRef.current, cameraRef.current);
    }
    updateUploadAnchorButtons();
    updatePresenceMarkerPositions();
  };

  const applyGraphicsResolution = (moving = interactiveRenderingRef.current) => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const mode = graphicsModeRef.current;
    const pixelRatio = moving
      ? (mode === 'performance' ? 0.5 : 0.75)
      : (mode === 'performance' ? 0.75 : 1);
    if (Math.abs(renderer.getPixelRatio() - pixelRatio) < 0.001) return;
    renderer.setPixelRatio(pixelRatio);
  };

  const beginInteractiveRendering = () => {
    if (graphicsRestoreTimerRef.current != null) {
      window.clearTimeout(graphicsRestoreTimerRef.current);
      graphicsRestoreTimerRef.current = null;
    }
    if (!interactiveRenderingRef.current) {
      interactiveRenderingRef.current = true;
      applyGraphicsResolution(true);
    }
    requestSceneRender();
  };

  const endInteractiveRendering = () => {
    if (graphicsRestoreTimerRef.current != null) {
      window.clearTimeout(graphicsRestoreTimerRef.current);
    }
    graphicsRestoreTimerRef.current = window.setTimeout(() => {
      graphicsRestoreTimerRef.current = null;
      interactiveRenderingRef.current = false;
      applyGraphicsResolution(false);
      requestSceneRender();
    }, 160);
  };

  const requestSceneRender = () => {
    if (requestRef.current != null) return;
    const renderFrame = (now) => {
      const capInteractiveFps = graphicsModeRef.current === 'performance' && interactiveRenderingRef.current;
      const minimumFrameTime = capInteractiveFps ? (1000 / 30) : 0;
      if (minimumFrameTime && (now - lastSceneRenderAtRef.current) < minimumFrameTime) {
        requestRef.current = requestAnimationFrame(renderFrame);
        return;
      }
      requestRef.current = null;
      lastSceneRenderAtRef.current = now;
      renderScene();
    };
    requestRef.current = requestAnimationFrame(renderFrame);
  };

  const stopKeyboardNavigation = () => {
    keyboardKeysRef.current.clear();
    keyboardLastFrameRef.current = 0;
    if (keyboardAnimationRef.current != null) {
      cancelAnimationFrame(keyboardAnimationRef.current);
      keyboardAnimationRef.current = null;
    }
    endInteractiveRendering();
  };

  const cancelCameraMotion = () => {
    stopKeyboardNavigation();
    cameraTweenTokenRef.current += 1;
    if (camAnimRef.current != null) {
      cancelAnimationFrame(camAnimRef.current);
      camAnimRef.current = null;
    }
  };

  useEffect(() => {
    graphicsModeRef.current = graphicsMode;
    try { window.localStorage.setItem('tdb_graphics_mode', graphicsMode); } catch (error) { /* storage unavailable */ }
    applyGraphicsResolution(interactiveRenderingRef.current);
    requestSceneRender();
  }, [graphicsMode]);

  const applyCameraPreset = (preset) => {
    if (!cameraRef.current || !window.THREE) return false;
    if (!Array.isArray(preset?.position) || !Array.isArray(preset?.target)) return false;
    if (preset.position.length !== 3 || preset.target.length !== 3) return false;
    const values = [...preset.position, ...preset.target].map(Number);
    if (!values.every(Number.isFinite)) return false;

    cancelCameraMotion();
    cameraRef.current.position.set(...values.slice(0, 3));
    cameraRef.current.zoom = 1;
    cameraRef.current.updateProjectionMatrix();
    if (controlsRef.current) {
      controlsRef.current.target.set(...values.slice(3, 6));
      controlsRef.current.update();
    } else {
      cameraRef.current.lookAt(new window.THREE.Vector3(...values.slice(3, 6)));
    }
    fittedViewRef.current.active = false;
    requestSceneRender();
    return true;
  };

  const applyCurrentBuildingFrontView = (source = modelSrcRef.current) => {
    const definition = getCameraModelDefinition(source);
    if (!definition) return false;
    const presets = cameraPresetsRef.current || defaultCameraPresets;
    const preset = presets[definition.cameraKey]
      || presets[definition.aliasKey]
      || defaultCameraPresets[definition.cameraKey]
      || defaultCameraPresets[definition.aliasKey];
    return applyCameraPreset(preset);
  };

  const getFileExtension = (filename) => {
    const parts = String(filename || '').toLowerCase().match(/(\.[a-z0-9]+)$/);
    return parts?.[1] || '';
  };

  const readFileAsArrayBuffer = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Unable to read "${file.name}".`));
    reader.readAsArrayBuffer(file);
  });

  const readFileAsText = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Unable to read "${file.name}".`));
    reader.readAsText(file);
  });

  const normalizeRecord = (raw) => {
    const roomName = raw?.room_name || raw?.room || raw?.Room || '';
    const teacherName = `${raw?.first_name || ''} ${raw?.last_name || ''}`.trim() || raw?.teacher_name || 'Teacher';
    const buildingName = raw?.building_name || deriveBuildingFromRoom(roomName);
    const floorName = raw?.floor_name || raw?.attendance_floor_name || deriveFloorFromRoom(roomName, buildingName);
    return {
      attendance_id: raw?.attendance_id || '',
      schedule_id: raw?.schedule_id || '',
      user_id: raw?.teacher_id ?? raw?.user_id ?? '',
      room_id: raw?.room_id ?? '',
      section_id: raw?.section_id ?? '',
      avatar: raw?.avatar || raw?.image || raw?.teacher_avatar || '',
      date: raw?.date || '',
      room_name: roomName,
      teacher_name: teacherName,
      campus_name: raw?.campus_name || raw?.school_name || '',
      building_name: buildingName,
      floor_name: floorName,
      department_id: raw?.department_id || raw?.dept_id || raw?.teacher_dept_id || '',
      department_name: raw?.department_name || raw?.dept_name || '',
      subject_id: raw?.subject_id || '',
      subject_code: raw?.subject_code || '',
      subject_name: raw?.subject_name || raw?.subject || '',
      section_name: raw?.section_name || '',
      semester_id: raw?.semester_id || '',
      start_time: raw?.start_time || '',
      end_time: raw?.end_time || '',
      time_in: raw?.time_in || '',
      time_check: raw?.time_check || '',
      time_out: raw?.time_out || '',
      flag_in_id: raw?.flag_in_id ?? null,
      flag_in_name: raw?.flag_in_name || '',
      flag_check_id: raw?.flag_check_id ?? null,
      flag_check_name: raw?.flag_check_name || '',
      flag_out_id: raw?.flag_out_id ?? null,
      flag_out_name: raw?.flag_out_name || '',
      is_schedule_only: !!raw?._schedule_only
    };
  };

  const statusFromFlag = (flagIdValue, flagNameValue) => {
    const flagId = Number(flagIdValue || 0);
    const flagName = String(flagNameValue || '').trim().toLowerCase();
    if (flagId === 5 || flagName === 'late') return 'LATE';
    if (flagId === 3 || flagName === 'absent') return 'ABSENT';
    if (flagId === 2 || flagName === 'present') return 'PRESENT';
    if (flagId === 4 || flagName === 'substituted') return 'SUBSTITUTED';
    if (flagId === 7 || flagName === 'on leave' || flagName === 'on_leave') return 'ON_LEAVE';
    if (flagId === 1 || flagName === 'upcoming') return 'UPCOMING';
    if (flagId === 8 || flagName === 'pending') return 'PENDING';
    return '';
  };

  const computeAttendanceStatus = (record) => {
    const flagStatus = statusFromFlag(record?.flag_in_id, record?.flag_in_name);
    if (flagStatus) return flagStatus;

    const hasIn = !!String(record?.time_in || '').trim();
    if (!hasIn) return 'PENDING';
    const inMins = toMinutes(record?.time_in);
    const startMins = toMinutes(record?.start_time);
    if (inMins !== null && startMins !== null && inMins > (startMins + 5)) return 'LATE';
    return 'PRESENT';
  };

  const computeCheckpointStatus = (record, checkpoint) => {
    const config = {
      in: {
        timeKey: 'time_in',
        flagIdKey: 'flag_in_id',
        flagNameKey: 'flag_in_name',
        compareTimeKey: 'start_time'
      },
      mid: {
        timeKey: 'time_check',
        flagIdKey: 'flag_check_id',
        flagNameKey: 'flag_check_name'
      },
      out: {
        timeKey: 'time_out',
        flagIdKey: 'flag_out_id',
        flagNameKey: 'flag_out_name'
      }
    }[checkpoint];
    if (!config) return 'PENDING';

    const flagStatus = statusFromFlag(record?.[config.flagIdKey], record?.[config.flagNameKey]);
    if (flagStatus) return flagStatus;

    const timeValue = String(record?.[config.timeKey] || '').trim();
    if (!timeValue) return 'PENDING';
    if (checkpoint === 'in') {
      const inMins = toMinutes(timeValue);
      const startMins = toMinutes(record?.[config.compareTimeKey]);
      if (inMins !== null && startMins !== null && inMins > (startMins + 5)) return 'LATE';
    }
    return 'PRESENT';
  };

  const computeOverallAttendanceStatus = (record) => {
    const statuses = ['in', 'mid', 'out'].map((checkpoint) => computeCheckpointStatus(record, checkpoint));
    const counts = statuses.reduce((result, value) => ({ ...result, [value]: (result[value] || 0) + 1 }), {});
    const winner = Object.entries(counts).find(([, count]) => count >= 2);
    return winner ? winner[0] : 'INCOMPLETE';
  };

  const normalizeScheduleForDate = (schedule, dateKey) => normalizeRecord({
    ...schedule,
    date: dateKey,
    user_id: schedule?.teacher_id || schedule?.user_id || '',
    _schedule_only: true
  });

  const buildScheduleRecordsForDate = (schedules, dateKey) => {
    const dayName = dayNameForDate(dateKey);
    if (!dayName || !Array.isArray(schedules)) return [];
    return schedules
      .filter((schedule) => String(schedule?.day_of_week || '').trim().toLowerCase() === dayName)
      .filter((schedule) => isDateWithinScheduleRange(dateKey, schedule?.semester_start, schedule?.semester_end))
      .map((schedule) => normalizeScheduleForDate(schedule, dateKey));
  };

  const attendanceRecordKey = (record, fallbackDate = selectedScheduleDate) => [
    String(record?.schedule_id || ''),
    String(record?.user_id || record?.teacher_id || ''),
    normalizeDateKey(record?.date) || fallbackDate
  ].join('|');

  const mergeSchedulesWithAttendance = (scheduleRecords, attendanceRows, dateKey) => {
    const merged = new Map();
    scheduleRecords.forEach((record) => {
      merged.set(attendanceRecordKey(record, dateKey), record);
    });
    attendanceRows.forEach((record) => {
      const key = attendanceRecordKey(record, dateKey);
      const scheduleRecord = merged.get(key);
      merged.set(key, scheduleRecord ? {
        ...scheduleRecord,
        ...record,
        campus_name: scheduleRecord.campus_name || record.campus_name,
        building_name: scheduleRecord.building_name || record.building_name,
        floor_name: scheduleRecord.floor_name || record.floor_name
      } : record);
    });
    return Array.from(merged.values());
  };

  const scheduleSubjectKey = (record) => {
    if (record?.subject_id !== undefined && record?.subject_id !== null && String(record.subject_id) !== '') {
      return `id:${record.subject_id}`;
    }
    return `text:${String(record?.subject_code || record?.subject_name || record?.subject || '').trim().toLowerCase()}`;
  };
  const scheduleTeacherKey = (record) => String(
    record?.teacher_id ?? record?.user_id ?? record?.teacher_name ?? ''
  ).trim().toLowerCase();
  const parallelScheduleGroupKey = (record) => [
    scheduleTeacherKey(record),
    String(record?.semester_id ?? ''),
    normalizeDateKey(record?.date),
    String(record?.start_time || '').slice(0, 5),
    String(record?.end_time || '').slice(0, 5),
    scheduleSubjectKey(record)
  ].join('|');
  const isParallelSchedule = (left, right) => {
    if (!left || !right) return false;
    const leftTeacher = scheduleTeacherKey(left);
    const rightTeacher = scheduleTeacherKey(right);
    const leftSemester = String(left.semester_id ?? '');
    const rightSemester = String(right.semester_id ?? '');
    const leftDate = normalizeDateKey(left.date);
    const rightDate = normalizeDateKey(right.date);
    const leftStart = String(left.start_time || '').slice(0, 5);
    const rightStart = String(right.start_time || '').slice(0, 5);
    const leftEnd = String(left.end_time || '').slice(0, 5);
    const rightEnd = String(right.end_time || '').slice(0, 5);
    const leftSubject = scheduleSubjectKey(left);
    const rightSubject = scheduleSubjectKey(right);
    const leftSchedule = String(left.schedule_id ?? '');
    const rightSchedule = String(right.schedule_id ?? '');
    const leftSection = String(left.section_id ?? '');
    const rightSection = String(right.section_id ?? '');
    const leftRoom = String(left.room_id ?? '');
    const rightRoom = String(right.room_id ?? '');
    if (!leftTeacher || !rightTeacher || !leftSemester || !rightSemester || !leftDate || !rightDate || !leftStart || !rightStart || !leftEnd || !rightEnd) return false;
    if (!leftSchedule || !rightSchedule || !leftSection || !rightSection || !leftRoom || !rightRoom) return false;
    if (leftSubject === 'text:' || rightSubject === 'text:') return false;
    return leftTeacher === rightTeacher
      && leftSemester === rightSemester
      && leftDate === rightDate
      && leftStart === rightStart
      && leftEnd === rightEnd
      && leftSubject === rightSubject
      && leftSchedule !== rightSchedule
      && leftSection !== rightSection
      && leftRoom !== rightRoom;
  };
  const getParallelSchedules = (record, records = attendanceRecords) => {
    const parallelPeers = (records || []).filter((candidate) => isParallelSchedule(candidate, record));
    return parallelPeers.length > 0 ? [record, ...parallelPeers] : [];
  };

  const attendanceCampusOptions = useMemo(() => {
    const vals = uniqueValues(attendanceRecords.map(r => r.campus_name));
    return vals;
  }, [attendanceRecords]);
  const attendanceBuildingOptions = useMemo(() => {
    return uniqueValues(
      attendanceRecords
        .filter(r => !pendingFilters.campus || nameEq(r.campus_name, pendingFilters.campus))
        .map(r => r.building_name)
    );
  }, [attendanceRecords, pendingFilters.campus]);
  const attendanceFloorOptions = useMemo(() => {
    return uniqueValues(
      attendanceRecords
        .filter(r => (!pendingFilters.campus || nameEq(r.campus_name, pendingFilters.campus))
          && (!pendingFilters.building || nameEq(r.building_name, pendingFilters.building)))
        .map(r => r.floor_name)
    );
  }, [attendanceRecords, pendingFilters.campus, pendingFilters.building]);
  const attendanceRoomOptions = useMemo(() => {
    return uniqueValues(
      attendanceRecords
        .filter(r => (!pendingFilters.campus || nameEq(r.campus_name, pendingFilters.campus))
          && (!pendingFilters.building || nameEq(r.building_name, pendingFilters.building))
          && (!pendingFilters.floor || nameEq(r.floor_name, pendingFilters.floor)))
        .map(r => r.room_name)
    );
  }, [attendanceRecords, pendingFilters.campus, pendingFilters.building, pendingFilters.floor]);

  const campusOptions = useMemo(() => {
    const schoolNames = uniqueValues((catalog.schools || []).map(s => s.school_name));
    return catalogLoaded ? schoolNames : attendanceCampusOptions;
  }, [catalog.schools, attendanceCampusOptions, catalogLoaded]);

  const selectedCampusId = useMemo(() => {
    if (!pendingFilters.campus) return null;
    const found = (catalog.schools || []).find(s => nameEq(s.school_name, pendingFilters.campus));
    return found ? found.school_id : null;
  }, [catalog.schools, pendingFilters.campus]);

  const catalogBuildingOptions = useMemo(() => {
    const list = Array.isArray(catalog.buildings) ? catalog.buildings : [];
    if (!list.length) return [];
    const filtered = list.filter(b => {
      if (!selectedCampusId) return true;
      return String(b.school_id) === String(selectedCampusId);
    });
    return uniqueValues(filtered.map(b => b.building_name));
  }, [catalog.buildings, selectedCampusId]);

  const buildingOptions = useMemo(() => {
    return catalogLoaded ? catalogBuildingOptions : attendanceBuildingOptions;
  }, [catalogBuildingOptions, attendanceBuildingOptions, catalogLoaded]);

  const selectedBuilding = useMemo(() => {
    if (!pendingFilters.building) return null;
    return (catalog.buildings || []).find(b => nameEq(b.building_name, pendingFilters.building)) || null;
  }, [catalog.buildings, pendingFilters.building]);

  const selectedBuildingId = selectedBuilding ? selectedBuilding.building_id : null;

  const catalogFloorOptions = useMemo(() => {
    const list = Array.isArray(catalog.floors) ? catalog.floors : [];
    if (!list.length) return [];
    const filtered = list.filter(f => {
      if (!selectedBuildingId) return true;
      return String(f.building_id) === String(selectedBuildingId);
    });
    return uniqueValues(filtered.map(f => f.floor_name));
  }, [catalog.floors, selectedBuildingId]);

  const floorOptions = useMemo(() => {
    return catalogLoaded ? catalogFloorOptions : attendanceFloorOptions;
  }, [catalogFloorOptions, attendanceFloorOptions, catalogLoaded]);

  const selectedFloor = useMemo(() => {
    if (!pendingFilters.floor) return null;
    return (catalog.floors || []).find(f =>
      nameEq(f.floor_name, pendingFilters.floor)
      && (!selectedBuildingId || String(f.building_id) === String(selectedBuildingId))
    ) || null;
  }, [catalog.floors, pendingFilters.floor, selectedBuildingId]);

  const selectedFloorId = selectedFloor ? selectedFloor.floor_id : null;

  const catalogRoomOptions = useMemo(() => {
    const list = Array.isArray(catalog.rooms) ? catalog.rooms : [];
    if (!list.length) return [];
    const filtered = list.filter(r => {
      if (selectedBuildingId && String(r.building_id) !== String(selectedBuildingId)) return false;
      if (selectedFloorId && String(r.floor_id) !== String(selectedFloorId)) return false;
      return true;
    });
    return uniqueValues(filtered.map(r => r.room_name));
  }, [catalog.rooms, selectedBuildingId, selectedFloorId]);

  const roomOptions = useMemo(() => {
    return catalogLoaded ? catalogRoomOptions : attendanceRoomOptions;
  }, [catalogRoomOptions, attendanceRoomOptions, catalogLoaded]);
  const sortedRoomOptions = useMemo(() => {
    return [...roomOptions].sort((a, b) => String(a).localeCompare(String(b)));
  }, [roomOptions]);

  const navigatorBuildings = useMemo(() => {
    if (catalogLoaded) {
      return [...(catalog.buildings || [])]
        .filter((building) => building.building_name)
        .map((building) => ({
          id: building.building_id,
          name: building.building_name,
          displayName: toDisplayName(building.building_name)
        }))
        .sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
    }
    const activeNames = (catalog.buildings || []).map((building) => building.building_name);
    const fromModel = (modelHierarchy.buildings || []).map((entry) => ({
      id: (catalog.buildings || []).find((building) => nameEq(building.building_name, entry.name))?.building_id || null,
      name: entry.name,
      displayName: entry.displayName
    })).filter((entry) => !catalogLoaded || activeNames.some((name) => nameEq(name, entry.name)));
    if (fromModel.length) {
      return fromModel.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
    }
    return [];
  }, [modelHierarchy.buildings, catalog.buildings, catalogLoaded]);

  const navigatorFloors = useMemo(() => {
    if (!navigatorBuilding) return [];
    const fromModel = [...(modelHierarchy.floors || [])]
      .filter((floor) => nameEq(floor.buildingName, navigatorBuilding))
      .filter((floor) => !catalogLoaded || (catalog.floors || []).some((activeFloor) =>
        nameEq(activeFloor.floor_name, floor.floorName)
        && nameEq(activeFloor.building_name, floor.buildingName)
      ))
      .sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
    if (fromModel.length) return fromModel;
    return [...(catalog.floors || [])]
      .filter((floor) => nameEq(floor.building_name, navigatorBuilding))
      .map((floor) => ({
        buildingName: navigatorBuilding,
        floorName: floor.floor_name,
        displayName: toDisplayName(floor.floor_name)
      }))
      .sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
  }, [modelHierarchy.floors, navigatorBuilding, catalog.floors, catalogLoaded]);

  const tableFloorOptions = useMemo(() => {
    if (navigatorBuilding) return navigatorFloors;
    const uniqueFloors = new Map();
    (catalog.floors || []).forEach((floor) => {
      const floorName = String(floor.floor_name || '').trim();
      const key = floorName.toLowerCase();
      if (!key || uniqueFloors.has(key)) return;
      uniqueFloors.set(key, {
        buildingName: '',
        floorName,
        displayName: toDisplayName(floorName)
      });
    });
    return [...uniqueFloors.values()].sort((left, right) => String(left.displayName).localeCompare(String(right.displayName)));
  }, [navigatorBuilding, navigatorFloors, catalog.floors]);

  const navigatorBuildingRecord = useMemo(() => (
    (catalog.buildings || []).find((building) => nameEq(building.building_name, navigatorBuilding)) || null
  ), [catalog.buildings, navigatorBuilding]);

  const navigatorRooms = useMemo(() => {
    const search = String(buildingSearchText || '').trim().toLowerCase();
    const baseRooms = (modelHierarchy.rooms && modelHierarchy.rooms.length > 0)
      ? [...modelHierarchy.rooms]
      : [...(catalog.rooms || [])].map((room) => {
          const buildingEntry = (catalog.buildings || []).find((building) => String(building.building_id) === String(room.building_id));
          const floorEntry = (catalog.floors || []).find((floor) => String(floor.floor_id) === String(room.floor_id));
          return {
            buildingName: buildingEntry?.building_name || room.building_name || '',
            floorName: floorEntry?.floor_name || room.floor_name || '',
            roomName: room.room_name || '',
            displayName: toDisplayName(room.room_name || room.roomName)
          };
        });

    return baseRooms
      .filter((room) => {
        if (catalogLoaded && !(catalog.rooms || []).some((activeRoom) => {
          if (!nameEq(activeRoom.room_name, room.roomName)) return false;
          const activeBuilding = (catalog.buildings || []).find((building) => String(building.building_id) === String(activeRoom.building_id));
          const activeFloor = (catalog.floors || []).find((floor) => String(floor.floor_id) === String(activeRoom.floor_id));
          return (!room.buildingName || nameEq(activeBuilding?.building_name, room.buildingName))
            && (!room.floorName || nameEq(activeFloor?.floor_name, room.floorName));
        })) return false;
        if (navigatorBuilding && !nameEq(room.buildingName, navigatorBuilding)) return false;
        if (navigatorFloor && !nameEq(room.floorName, navigatorFloor)) return false;
        if (!search) return true;
        return room.displayName.toLowerCase().includes(search)
          || room.buildingName.toLowerCase().includes(search)
          || room.floorName.toLowerCase().includes(search);
      })
      .sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
  }, [modelHierarchy.rooms, navigatorBuilding, navigatorFloor, buildingSearchText, catalog.rooms, catalog.buildings, catalog.floors, catalogLoaded]);

  const roomExplorerRooms = useMemo(() => {
    const labelFilter = String(roomListFilter || '').trim().toLowerCase();

    // Find the building_id from the catalog that matches the navigatorBuilding name
    let filterBuildingId = null;
    if (navigatorBuilding) {
      const matchedBuilding = (catalog.buildings || []).find(b =>
        nameEq(b.building_name, navigatorBuilding)
      );
      if (matchedBuilding) {
        filterBuildingId = String(matchedBuilding.building_id);
      }
    }

    // Resolve the selected floor inside the selected building so rooms are
    // filtered by their stable floor_id instead of a display-name comparison.
    let filterFloorId = null;
    if (navigatorFloor && filterBuildingId) {
      const matchedFloor = (catalog.floors || []).find(floor =>
        String(floor.building_id) === filterBuildingId
        && nameEq(floor.floor_name, navigatorFloor)
      );
      if (!matchedFloor) return [];
      filterFloorId = String(matchedFloor.floor_id);
    }

    return (catalog.rooms || [])
      .filter((room) => {
        // Filter by building if navigatorBuilding is set
        if (filterBuildingId && String(room.building_id) !== filterBuildingId) return false;
        // Filter by floor unless ALL is selected
        if (filterFloorId && String(room.floor_id) !== filterFloorId) return false;
        // Filter by search text
        if (labelFilter && !String(room.room_name || '').toLowerCase().includes(labelFilter)) return false;
        return true;
      })
      .sort((a, b) => String(a.room_name || '').localeCompare(String(b.room_name || '')));
  }, [catalog.rooms, catalog.buildings, catalog.floors, navigatorBuilding, navigatorFloor, roomListFilter]);

  useEffect(() => {
    const keepValidFilters = (prev) => {
      const next = {
        campus: (prev.campus && campusOptions.includes(prev.campus)) ? prev.campus : '',
        building: prev.building && buildingOptions.includes(prev.building) ? prev.building : '',
        floor: prev.floor && floorOptions.includes(prev.floor) ? prev.floor : '',
        room: prev.room && roomOptions.includes(prev.room) ? prev.room : ''
      };
      const unchanged = next.campus === prev.campus
        && next.building === prev.building
        && next.floor === prev.floor
        && next.room === prev.room;
      return unchanged ? prev : next;
    };
    setPendingFilters(keepValidFilters);
    setAppliedFilters(keepValidFilters);
  }, [campusOptions, buildingOptions, floorOptions, roomOptions]);

  const recordMatchesFilter = (record, filters) => {
    const eq = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    if (filters.campus && !eq(record.campus_name, filters.campus)) return false;
    if (filters.building && !eq(record.building_name, filters.building)) return false;
    if (filters.floor && !eq(record.floor_name, filters.floor)) return false;
    if (filters.room && !eq(record.room_name, filters.room)) return false;
    return true;
  };

  const filteredRecords = useMemo(
    () => attendanceRecords.filter(r => recordMatchesFilter(r, appliedFilters)),
    [attendanceRecords, appliedFilters]
  );

  const visiblePresenceMarkers = presenceMarkers;
  const searchedRecords = filteredRecords;

  const stats = useMemo(() => {
    let totalPresent = 0;
    let totalOther = 0;
    let totalLate = 0;
    let totalAbsent = 0;
    searchedRecords.forEach((rec) => {
      ['in', 'mid', 'out'].forEach((checkpoint) => {
        const statusTag = computeCheckpointStatus(rec, checkpoint);
        if (statusTag === 'PRESENT') totalPresent += 1;
        else if (statusTag === 'LATE') totalLate += 1;
        else if (statusTag === 'ABSENT') totalAbsent += 1;
        else totalOther += 1;
      });
    });
    return { totalPresent, totalOther, totalLate, totalAbsent };
  }, [searchedRecords]);

  const computeRecentLogStatus = (record, checkpoint) => {
    const flagConfig = {
      in: ['flag_in_id', 'flag_in_name'],
      mid: ['flag_check_id', 'flag_check_name'],
      out: ['flag_out_id', 'flag_out_name']
    }[checkpoint];
    if (!flagConfig) return 'PENDING';
    const flagId = Number(record?.[flagConfig[0]] || 0);
    const flagName = String(record?.[flagConfig[1]] || '').trim().toLowerCase();
    if (flagId === 1 || flagName === 'upcoming') return 'UPCOMING';
    if (flagId === 8 || flagName === 'pending') return 'PENDING';
    return computeCheckpointStatus(record, checkpoint);
  };

  const getRecentLogTimeDisplay = (record, checkpoint, status) => {
    const timeKey = { in: 'time_in', mid: 'time_check', out: 'time_out' }[checkpoint];
    const actualTime = timeKey ? record?.[timeKey] : '';
    if (status === 'ABSENT') {
      return record?.end_time ? { label: formatClock(record.end_time), kind: 'single' } : { label: '', kind: 'none' };
    }
    if (status === 'UPCOMING' || status === 'PENDING') {
      if (!record?.start_time || !record?.end_time) return { label: '', kind: 'none' };
      return {
        label: `${formatClock(record.start_time)} - ${formatClock(record.end_time)}`,
        kind: 'range'
      };
    }
    if (status === 'PRESENT' || status === 'LATE') {
      return actualTime ? { label: formatClock(actualTime), kind: 'single' } : { label: '', kind: 'none' };
    }
    return { label: '', kind: 'none' };
  };

  const LOGS_PER_PAGE = 10;
  const totalLogPages = Math.max(1, Number(recentLogsPagination.total_pages || 1));
  const visibleLogPages = useMemo(() => {
    const buttonCount = Math.min(5, totalLogPages);
    const maximumStart = Math.max(1, totalLogPages - buttonCount + 1);
    const startPage = Math.min(
      Math.max(1, logsPage - Math.floor(buttonCount / 2)),
      maximumStart
    );
    return Array.from({ length: buttonCount }, (_, index) => startPage + index);
  }, [logsPage, totalLogPages]);

  useEffect(() => {
    if (logsPage > totalLogPages) setLogsPage(totalLogPages);
  }, [logsPage, totalLogPages]);

  useEffect(() => {
    setLogsPage(1);
  }, [appliedFilters, selectedScheduleDate, recentLogStatusFilter]);

  useEffect(() => {
    const controller = new AbortController();
    const fetchRecentLogs = async () => {
      setRecentLogsLoading(true);
      setRecentLogsError('');
      try {
        const query = new URLSearchParams({
          date: normalizeDateKey(selectedScheduleDate) || toLocalYmd(),
          log_view: '1',
          log_status: recentLogStatusFilter,
          page: String(logsPage),
          page_size: String(LOGS_PER_PAGE),
          include_avatar: '0'
        });
        if (appliedFilters.campus) query.set('campus_name', appliedFilters.campus);
        if (appliedFilters.building) query.set('building_name', appliedFilters.building);
        if (appliedFilters.floor) query.set('floor_name', appliedFilters.floor);
        if (appliedFilters.room) query.set('room_name', appliedFilters.room);
        const payload = await apiGet(`attendance?${query.toString()}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const nextRows = (Array.isArray(payload?.rows) ? payload.rows : []).map((log) => ({
          ...log,
          avatar: log.avatar ? resolveApiAssetUrl(log.avatar) : '',
          record: normalizeRecord(log.record || {})
        }));
        setPagedLogs(nextRows);
        setRecentLogsPagination(payload?.pagination || { page: 1, page_size: LOGS_PER_PAGE, total: nextRows.length, total_pages: 1 });
      } catch (error) {
        if (controller.signal.aborted) return;
        setPagedLogs([]);
        setRecentLogsError(error?.body?.message || error?.message || 'Unable to load recent logs.');
      } finally {
        if (!controller.signal.aborted) setRecentLogsLoading(false);
      }
    };
    fetchRecentLogs();
    return () => controller.abort();
  }, [appliedFilters, selectedScheduleDate, recentLogStatusFilter, logsPage, attendanceRefreshToken]);

  useEffect(() => {
    const timer = setInterval(() => setNowTime(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const mainPanel = mainPanelRef.current;
    const logsPanel = logsPanelRef.current;
    if (!mainPanel || !logsPanel) return undefined;

    const syncLogsPanelHeight = () => {
      const height = Math.ceil(mainPanel.getBoundingClientRect().height);
      if (height > 0) logsPanel.style.height = `${height}px`;
    };

    syncLogsPanelHeight();
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(syncLogsPanelHeight)
      : null;
    observer?.observe(mainPanel);
    window.addEventListener('resize', syncLogsPanelHeight);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', syncLogsPanelHeight);
      logsPanel.style.height = '';
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [schools, buildings, floors, rooms] = await Promise.all([
          apiGet('school'),
          apiGet('buildings'),
          apiGet('floors'),
          apiGet('rooms')
        ]);
        if (!mounted) return;
        const clean = (list) => Array.isArray(list)
          ? list.filter(isEntityActive)
          : [];
        const activeSchools = clean(schools);
        const activeSchoolIds = new Set(activeSchools.map((school) => String(school.school_id)));
        const activeBuildings = clean(buildings).filter((building) => (
          !building.school_id || activeSchoolIds.has(String(building.school_id))
        ));
        const activeBuildingIds = new Set(activeBuildings.map((building) => String(building.building_id)));
        const activeFloors = clean(floors).filter((floor) => activeBuildingIds.has(String(floor.building_id)));
        const activeFloorIds = new Set(activeFloors.map((floor) => String(floor.floor_id)));
        const activeRooms = clean(rooms).filter((room) => (
          activeBuildingIds.has(String(room.building_id))
          && activeFloorIds.has(String(room.floor_id))
        ));
        setCatalog({
          schools: activeSchools,
          buildings: activeBuildings,
          floors: activeFloors,
          rooms: activeRooms
        });
        setCatalogLoaded(true);
      } catch (err) {
        console.error('Catalog fetch failed:', err);
        if (mounted) setCatalogLoaded(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let active = true;
    apiGet('class-schedules?compact=1&include_avatar=0')
      .then((rows) => {
        if (active) setScheduleCatalog(Array.isArray(rows) ? rows : []);
      })
      .catch((error) => console.warn('Schedule fetch failed for 3D viewer:', error))
      .finally(() => { if (active) setScheduleCatalogLoaded(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!scheduleCatalogLoaded) return undefined;
    const fetchTeacherLocation = async () => {
      setAttendanceRecordsLoading(true);
      setAttendanceRecordsError('');
      try {
        const queryDate = selectedScheduleDate || toLocalYmd();
        const query = new URLSearchParams({ date: queryDate, include_avatar: '0' });
        if (appliedFilters.campus) query.set('campus_name', appliedFilters.campus);
        if (appliedFilters.building) query.set('building_name', appliedFilters.building);
        if (appliedFilters.floor) query.set('floor_name', appliedFilters.floor);
        if (appliedFilters.room) query.set('room_name', appliedFilters.room);
        const records = await apiGet(`attendance?${query.toString()}`);
        const normalizedAttendance = Array.isArray(records) ? records.map(normalizeRecord) : [];
        const scheduleRecords = buildScheduleRecordsForDate(scheduleCatalog, queryDate)
          .filter(record => recordMatchesFilter(record, appliedFilters));
        setAttendanceRecords(mergeSchedulesWithAttendance(scheduleRecords, normalizedAttendance, queryDate));
        setMessage('');
      } catch (err) {
        console.error('Attendance fetch failed:', err);
        setAttendanceRecordsError(err?.body?.message || err?.message || 'Unable to load attendance records.');
        if (err?.status === 401 || err?.status === 403) {
          setMessage('Unable to load schedules. Please sign in again.');
          setAttendanceRecords([]);
        }
      } finally {
        setAttendanceRecordsLoading(false);
      }
    };

    fetchTeacherLocation();
    // Live markers use their own compact 30-second feed. Keep the much larger
    // attendance/history refresh infrequent so it does not interrupt the viewer.
    const interval = setInterval(fetchTeacherLocation, 300000);
    return () => clearInterval(interval);
  }, [selectedScheduleDate, attendanceRefreshToken, scheduleCatalog, scheduleCatalogLoaded, appliedFilters]);

  useEffect(() => {
    if (!scheduleCatalogLoaded) return undefined;
    if (!teacherStatusModal) {
      setModalAttendanceRecords([]);
      setModalRecordsLoading(false);
      setModalRecordsError('');
      return undefined;
    }

    const modalDateKey = normalizeDateKey(modalScheduleDate) || toLocalYmd();
    const pageDateKey = normalizeDateKey(selectedScheduleDate) || toLocalYmd();
    if (modalDateKey === pageDateKey) {
      setModalAttendanceRecords([]);
      setModalRecordsLoading(false);
      setModalRecordsError('');
      return undefined;
    }

    let cancelled = false;
    setModalRecordsLoading(true);
    setModalRecordsError('');
    setModalAttendanceRecords([]);

    (async () => {
      try {
        const records = await apiGet(`attendance?date=${encodeURIComponent(modalDateKey)}&include_avatar=0`);
        if (cancelled) return;
        const normalizedAttendance = Array.isArray(records) ? records.map(normalizeRecord) : [];
        const scheduleRecords = buildScheduleRecordsForDate(scheduleCatalog, modalDateKey);
        setModalAttendanceRecords(mergeSchedulesWithAttendance(scheduleRecords, normalizedAttendance, modalDateKey));
      } catch (error) {
        if (cancelled) return;
        console.error('Modal attendance fetch failed:', error);
        setModalRecordsError('Unable to load records for the selected modal date.');
      } finally {
        if (!cancelled) setModalRecordsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [teacherStatusModal, modalScheduleDate, selectedScheduleDate, scheduleCatalog, scheduleCatalogLoaded]);

  useEffect(() => {
    if (!scheduleCatalogLoaded) return undefined;
    if (!teacherStatusModal) {
      setModalTodayAttendanceRecords([]);
      setModalTodayRecordsLoading(false);
      setModalTodayRecordsError('');
      return undefined;
    }

    const todayKey = currentDateKey;
    const pageDateKey = normalizeDateKey(selectedScheduleDate) || todayKey;
    if (pageDateKey === todayKey) {
      setModalTodayAttendanceRecords([]);
      setModalTodayRecordsLoading(false);
      setModalTodayRecordsError('');
      return undefined;
    }

    let cancelled = false;
    setModalTodayRecordsLoading(true);
    setModalTodayRecordsError('');
    setModalTodayAttendanceRecords([]);

    (async () => {
      try {
        const records = await apiGet(`attendance?date=${encodeURIComponent(todayKey)}&operational_only=1&include_avatar=0`);
        if (cancelled) return;
        const normalizedAttendance = Array.isArray(records) ? records.map(normalizeRecord) : [];
        const scheduleRecords = buildScheduleRecordsForDate(scheduleCatalog, todayKey);
        setModalTodayAttendanceRecords(mergeSchedulesWithAttendance(scheduleRecords, normalizedAttendance, todayKey));
      } catch (error) {
        if (cancelled) return;
        console.error('Today attendance fetch failed:', error);
        setModalTodayRecordsError("Unable to load today's attendance records.");
      } finally {
        if (!cancelled) setModalTodayRecordsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [teacherStatusModal, selectedScheduleDate, currentDateKey, scheduleCatalog, scheduleCatalogLoaded]);

  useEffect(() => {
    if (!window.THREE || !mountRef.current) return;

    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;

    const scene = new window.THREE.Scene();
    scene.background = new window.THREE.Color(0x1f1f1f);
    sceneRef.current = scene;

    const camera = new window.THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
    cameraRef.current = camera;

    const renderer = new window.THREE.WebGLRenderer({ antialias: false, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(graphicsModeRef.current === 'performance' ? 0.75 : 1);
    renderer.shadowMap.enabled = false;
    renderer.outputEncoding = window.THREE.sRGBEncoding;
    raycasterRef.current = new window.THREE.Raycaster();

    mountRef.current.innerHTML = '';
    mountRef.current.appendChild(renderer.domElement);
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('aria-label', 'Interactive 3D building viewer. Use WASD or arrow keys to move, Q to move down, and E to move up.');
    rendererRef.current = renderer;

    const controls = new window.THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.rotateSpeed = 0.025;
    controls.zoomSpeed = 0.15;
    controls.panSpeed = 0.015;
    controls.addEventListener('change', requestSceneRender);
    const handleControlsStart = () => {
      fittedViewRef.current.active = false;
      beginInteractiveRendering();
    };
    const handleControlsEnd = () => endInteractiveRendering();
    controls.addEventListener('start', handleControlsStart);
    controls.addEventListener('end', handleControlsEnd);
    controlsRef.current = controls;

    const ambientLight = new window.THREE.AmbientLight(0xffffff, 0.78);
    scene.add(ambientLight);
    const dirLight = new window.THREE.DirectionalLight(0xffffff, 1.15);
    dirLight.position.set(50, 100, 50);
    scene.add(dirLight);

    const getPointerNdc = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return new window.THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );
    };

    const supportedCameraKeys = new Set([
      'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
      'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'
    ]);
    const keyboardSpeedScale = 0.75;

    const runKeyboardNavigation = (now) => {
      const keys = keyboardKeysRef.current;
      if (!keys.size) {
        keyboardAnimationRef.current = null;
        keyboardLastFrameRef.current = 0;
        return;
      }

      const lastTime = keyboardLastFrameRef.current || now;
      const deltaSeconds = Math.min((now - lastTime) / 1000, 0.05);
      keyboardLastFrameRef.current = now;

      if (cameraRef.current && controlsRef.current?.enabled && window.THREE) {
        const activeCamera = cameraRef.current;
        const activeControls = controlsRef.current;
        const viewDirection = activeControls.target.clone().sub(activeCamera.position);
        if (viewDirection.lengthSq() < 0.000001) viewDirection.set(0, 0, -1);

        const turnLeft = keys.has('KeyA') || keys.has('ArrowLeft');
        const turnRight = keys.has('KeyD') || keys.has('ArrowRight');
        const turnInput = Number(turnLeft) - Number(turnRight);
        if (turnInput) {
          const turnRadians = window.THREE.MathUtils.degToRad(75 * keyboardSpeedScale) * deltaSeconds * turnInput;
          viewDirection.applyAxisAngle(new window.THREE.Vector3(0, 1, 0), turnRadians);
          activeControls.target.copy(activeCamera.position).add(viewDirection);
        }

        const moveForward = keys.has('KeyW') || keys.has('ArrowUp');
        const moveBackward = keys.has('KeyS') || keys.has('ArrowDown');
        const moveInput = Number(moveForward) - Number(moveBackward);
        if (moveInput) {
          const groundDirection = viewDirection.clone();
          groundDirection.y = 0;
          if (groundDirection.lengthSq() > 0.000001) {
            groundDirection.normalize().multiplyScalar(cameraMoveSpeedRef.current * keyboardSpeedScale * deltaSeconds * moveInput);
            activeCamera.position.add(groundDirection);
            activeControls.target.add(groundDirection);
          }
        }

        const moveUp = keys.has('KeyE');
        const moveDown = keys.has('KeyQ');
        const verticalInput = Number(moveUp) - Number(moveDown);
        if (verticalInput) {
          const verticalDistance = cameraMoveSpeedRef.current * keyboardSpeedScale * deltaSeconds * verticalInput;
          activeCamera.position.y += verticalDistance;
          activeControls.target.y += verticalDistance;
        }

        activeControls.update();
        requestSceneRender();
      }

      keyboardAnimationRef.current = requestAnimationFrame(runKeyboardNavigation);
    };

    const handleCameraKeyDown = (event) => {
      if (!supportedCameraKeys.has(event.code)) return;
      event.preventDefault();
      if (!keyboardKeysRef.current.size) beginInteractiveRendering();
      keyboardKeysRef.current.add(event.code);
      fittedViewRef.current.active = false;
      cameraTweenTokenRef.current += 1;
      if (camAnimRef.current != null) {
        cancelAnimationFrame(camAnimRef.current);
        camAnimRef.current = null;
      }
      if (keyboardAnimationRef.current == null) {
        keyboardLastFrameRef.current = performance.now();
        keyboardAnimationRef.current = requestAnimationFrame(runKeyboardNavigation);
      }
    };

    const handleCameraKeyUp = (event) => {
      if (!supportedCameraKeys.has(event.code)) return;
      event.preventDefault();
      keyboardKeysRef.current.delete(event.code);
      if (!keyboardKeysRef.current.size) stopKeyboardNavigation();
    };

    const handleCameraBlur = () => stopKeyboardNavigation();
    renderer.domElement.addEventListener('keydown', handleCameraKeyDown);
    renderer.domElement.addEventListener('keyup', handleCameraKeyUp);
    renderer.domElement.addEventListener('blur', handleCameraBlur);

    const handleViewerPointerDown = (event) => {
      if (event.button !== 0) return;
      try { renderer.domElement.focus({ preventScroll: true }); } catch (e) { renderer.domElement.focus(); }
      if (!cameraRef.current || !raycasterRef.current || !window.THREE) return;

      const pointer = getPointerNdc(event);
      if (!pointer) return;

      raycasterRef.current.setFromCamera(pointer, cameraRef.current);

      if (!moveModeRef.current) return;

      const moveTarget = getMoveTargetObject();
      if (!moveTarget) return;

      raycasterRef.current.setFromCamera(pointer, cameraRef.current);
      const hits = raycasterRef.current.intersectObject(moveTarget, true);
      if (!hits.length) return;

      const moveTargetCenter = new window.THREE.Box3()
        .setFromObject(moveTarget)
        .getCenter(new window.THREE.Vector3());
      const plane = new window.THREE.Plane(new window.THREE.Vector3(0, 1, 0), -moveTargetCenter.y);
      const planePoint = raycasterRef.current.ray.intersectPlane(plane, new window.THREE.Vector3());
      if (!planePoint) return;

      dragStateRef.current = {
        active: true,
        pointerId: event.pointerId ?? null,
        object: moveTarget,
        plane,
        offsetX: planePoint.x - moveTarget.position.x,
        offsetZ: planePoint.z - moveTarget.position.z
      };

      if (controlsRef.current) controlsRef.current.enabled = false;
      beginInteractiveRendering();
      if (typeof renderer.domElement.setPointerCapture === 'function' && event.pointerId != null) {
        try { renderer.domElement.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
      }
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      event.stopPropagation();
      event.preventDefault();
      updateViewerCursor();
    };

    const handleViewerPointerMove = (event) => {
      const dragState = dragStateRef.current;
      if (!dragState.active || !dragState.object || !dragState.plane) return;
      if (!cameraRef.current || !raycasterRef.current || !window.THREE) return;
      const pointer = getPointerNdc(event);
      if (!pointer) return;

      raycasterRef.current.setFromCamera(pointer, cameraRef.current);
      const planePoint = raycasterRef.current.ray.intersectPlane(dragState.plane, new window.THREE.Vector3());
      if (!planePoint) return;

      dragState.object.position.set(
        planePoint.x - dragState.offsetX,
        dragState.object.position.y,
        planePoint.z - dragState.offsetZ
      );
      syncActiveUploadTransform(dragState.object);
      requestSceneRender();
      event.preventDefault();
    };

    const handleViewerPointerUp = () => {
      if (!dragStateRef.current.active) return;
      stopDraggingMoveTarget();
      syncActiveUploadTransform();
      endInteractiveRendering();
    };

    requestSceneRender();

    const handleResize = () => syncViewerSize();
    const resizeObserver = window.ResizeObserver
      ? new window.ResizeObserver(() => syncViewerSize())
      : null;

    window.addEventListener('resize', handleResize);
    window.addEventListener('pointermove', handleViewerPointerMove);
    window.addEventListener('pointerup', handleViewerPointerUp);
    window.addEventListener('pointercancel', handleViewerPointerUp);
    renderer.domElement.addEventListener('pointerdown', handleViewerPointerDown, true);
    resizeObserver?.observe(mountRef.current);
    if (viewerWrapRef.current && viewerWrapRef.current !== mountRef.current) {
      resizeObserver?.observe(viewerWrapRef.current);
    }
    syncViewerSize();

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('pointermove', handleViewerPointerMove);
      window.removeEventListener('pointerup', handleViewerPointerUp);
      window.removeEventListener('pointercancel', handleViewerPointerUp);
      renderer.domElement.removeEventListener('pointerdown', handleViewerPointerDown, true);
      renderer.domElement.removeEventListener('keydown', handleCameraKeyDown);
      renderer.domElement.removeEventListener('keyup', handleCameraKeyUp);
      renderer.domElement.removeEventListener('blur', handleCameraBlur);
      resizeObserver?.disconnect();
      if (requestRef.current != null) cancelAnimationFrame(requestRef.current);
      requestRef.current = null;
      stopDraggingMoveTarget();
      clearPendingUploadPreview({ suppressState: true, suppressTransformSync: true });
      clearUploadedObjects({ suppressTransformSync: true });
      removeSceneObject(modelRef.current);
      modelRef.current = null;
      modelInitialQuaternionRef.current = null;
      renderer.renderLists?.dispose?.();
      hideUploadAnchorButtons();
      meshMapRef.current = {};
      meshNameCollisionsRef.current = {};
      presenceAnchorsRef.current = {};
      presenceMarkerRefs.current = {};
      if (mountRef.current) mountRef.current.innerHTML = '';
      controls.removeEventListener('change', requestSceneRender);
      controls.removeEventListener('start', handleControlsStart);
      controls.removeEventListener('end', handleControlsEnd);
      stopKeyboardNavigation();
      if (graphicsRestoreTimerRef.current != null) {
        window.clearTimeout(graphicsRestoreTimerRef.current);
        graphicsRestoreTimerRef.current = null;
      }
      interactiveRenderingRef.current = false;
      if (controlsRef.current?.dispose) controlsRef.current.dispose();
      if (requestRef.current != null) cancelAnimationFrame(requestRef.current);
      requestRef.current = null;
      if (rendererRef.current) rendererRef.current.dispose();
      rendererRef.current = null;
      raycasterRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!sceneRef.current || !window.THREE) return;
    let cancelled = false;

    stopKeyboardNavigation();
    clearPendingUploadPreview();
    clearUploadedObjects();
    presenceVersionRef.current = '';
    presenceAnchorsRef.current = {};
    setPresenceMarkers([]);
    setPresenceError('');
    setPresenceLastUpdated('');
    setPresenceDiagnostics({ unmatched: [], duplicates: [] });
    if (modelRef.current) {
      removeSceneObject(modelRef.current);
      modelRef.current = null;
      modelInitialQuaternionRef.current = null;
      rendererRef.current?.renderLists?.dispose?.();
      requestSceneRender();
    }
    meshMapRef.current = {};
    setSceneBusyLabel('Loading 3D model');
    updateModelLoadProgress(0);
    setStatus('loading');
    setMessage('');

    if (!modelSrc) {
      setModelHierarchy({ buildings: [], floors: [], rooms: [] });
      setStatus('empty');
      setMessage('No 3D building model has been added yet.');
      requestSceneRender();
      return () => { cancelled = true; };
    }

    const loader = new window.THREE.GLTFLoader();
    loader.load(
      modelSrc,
      (gltf) => {
        const object = gltf.scene || gltf.scenes?.[0];
        if (cancelled) {
          if (object) disposeObject(object);
          return;
        }
        if (!object) {
          setStatus('error');
          setMessage('Failed to load model scene.');
          return;
        }

        rebuildMeshMap(object);
        const hierarchy = buildModelHierarchy(object);
        setModelHierarchy(hierarchy);
        if (hierarchy.buildings?.length) {
          const buildingNames = hierarchy.buildings.map((entry) => entry.name);
          setCameraPresets((prev) => ({ ...defaultCameraPresets, ...prev, ...Object.fromEntries(buildingNames.map((name) => [name, prev[name] || defaultCameraPresets[name] || defaultCameraPresets.Building_PhinmaHall])) }));
        }
        updateUploadAnchorLayout(object);
        const namedCam = extractNamedCameraFromGLTF(gltf);
        if (namedCam) {
          namedCameraDataRef.current = namedCam;
          setAvailableCameras(namedCam);
        }
        sceneRef.current.add(object);
        modelRef.current = object;
        modelInitialQuaternionRef.current = object.quaternion.clone();
        const modelBounds = new window.THREE.Box3().setFromObject(object);
        if (!modelBounds.isEmpty()) {
          const modelSize = modelBounds.getSize(new window.THREE.Vector3());
          cameraMoveSpeedRef.current = Math.max(Math.max(modelSize.x, modelSize.y, modelSize.z) * 0.12, 1);
        }
        if (frameNextBuildingModelRef.current) {
          frameNextBuildingModelRef.current = false;
          frameObjectInCamera(object);
        } else if (!applyCurrentBuildingFrontView(modelSrc)) {
          frameObjectInCamera(object);
        }
        requestAnimationFrame(() => {
          syncViewerSize();
          requestSceneRender();
        });
        updateModelLoadProgress(100);
        setStatus('ready');
      },
      (event) => {
        if (cancelled || !event?.lengthComputable || !event.total) return;
        const percentage = Math.min(100, Math.max(0, Math.round((event.loaded / event.total) * 100)));
        updateModelLoadProgress(percentage);
        if (percentage >= 100) setSceneBusyLabel('Preparing 3D building');
      },
      (error) => {
        if (cancelled) return;
        frameNextBuildingModelRef.current = false;
        console.error(error);
        setStatus('error');
        setMessage('Failed to load model.');
      }
    );

    return () => {
      cancelled = true;
    };
  }, [modelSrc]);

  const presenceRequestRef = useRef(null);

  const refreshPresence = React.useCallback(async () => {
    const definition = getCameraModelDefinition(modelSrc);
    const isTableView = viewMode === 'table';
    if (isTableView || status !== 'ready' || !definition || !modelRef.current) return;

    presenceRequestRef.current?.abort();
    const controller = new AbortController();
    presenceRequestRef.current = controller;
    try {
      const scopeQuery = definition.buildingId
        ? `building_id=${encodeURIComponent(definition.buildingId)}`
        : `building_code=${encodeURIComponent(definition.code)}`;
      const payload = await apiGet(
        `3d-room-presence.php?${scopeQuery}`,
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      const markers = Array.isArray(payload?.markers) ? payload.markers : [];
      const version = `${scopeQuery}|${String(payload?.version || '')}`;
      if (version !== presenceVersionRef.current) {
        presenceVersionRef.current = version;
        setPresenceMarkers(markers);
        setAttendanceRefreshToken((value) => value + 1);
        const liveByScheduleTeacher = new Map(markers.map((marker) => [
          `${marker.schedule_id || ''}|${marker.teacher_id || ''}`,
          marker
        ]));
        if ((normalizeDateKey(selectedScheduleDate) || toLocalYmd()) === toLocalYmd()) {
          setAttendanceRecords((previous) => previous.map((record) => {
            const live = liveByScheduleTeacher.get(`${record.schedule_id || ''}|${record.user_id || record.teacher_id || ''}`);
            if (!live) return record;
            return {
              ...record,
              flag_in_id: live.flag_in_id,
              flag_check_id: live.flag_check_id,
              flag_out_id: live.flag_out_id,
              time_in: live.time_in || '',
              time_check: live.time_check || '',
              time_out: live.time_out || '',
              department_id: live.department_id || record.department_id,
              department_name: live.department_name || record.department_name
            };
          }));
        }
      }
      setPresenceLastUpdated(payload?.generated_at || new Date().toISOString());
      setPresenceError('');
    } catch (error) {
      if (controller.signal.aborted) return;
      console.warn('Live 3D room presence unavailable:', error);
      setPresenceError(error?.body?.message || error?.message || 'Unable to refresh teacher markers.');
    }
  }, [modelSrc, status, viewMode, selectedScheduleDate]);

  useEffect(() => {
    refreshPresence();
    return () => {
      presenceRequestRef.current?.abort();
    };
  }, [refreshPresence, presenceRefreshToken]);

  useAutoRefresh({
    refresh: refreshPresence,
    intervalMs: AUTO_REFRESH_INTERVALS.LIVE,
    enabled: viewMode === '3d' && status === 'ready' && Boolean(modelSrc),
  });

  useEffect(() => {
    if (status !== 'ready' || !modelRef.current || !window.THREE) {
      presenceAnchorsRef.current = {};
      requestSceneRender();
      return;
    }

    const anchors = {};
    const unmatched = [];
    const duplicates = [];
    presenceMarkers.forEach((marker) => {
      const key = normalizeMeshKey(marker?.room_name);
      if (!key) return;
      if (meshNameCollisionsRef.current[key]) {
        duplicates.push({ room_name: marker.room_name, meshes: meshNameCollisionsRef.current[key] });
        return;
      }
      const targetMesh = meshMapRef.current[key];
      if (!targetMesh) {
        unmatched.push(marker.room_name || `Room ${marker.room_id}`);
        return;
      }

      const box = new window.THREE.Box3().setFromObject(targetMesh);
      if (box.isEmpty()) {
        unmatched.push(marker.room_name || `Room ${marker.room_id}`);
        return;
      }
      const center = box.getCenter(new window.THREE.Vector3());
      const size = box.getSize(new window.THREE.Vector3());
      center.y = box.max.y + Math.max(size.y * 0.08, 0.35);
      anchors[String(marker.room_id)] = center;
    });

    presenceAnchorsRef.current = anchors;
    setPresenceDiagnostics({ unmatched, duplicates });
    requestSceneRender();
  }, [presenceMarkers, status, modelSrc]);

  useEffect(() => {
    const pending = pendingNavigatorRoomRef.current;
    if (status !== 'ready' || !pending || pending.modelSrc !== modelSrc) return;
    pendingNavigatorRoomRef.current = null;
    const focused = focusRoomCamera(pending.roomName, () => {
      if (pending.record) openTeacherRecordDetails(pending.record, pending.source || 'recent-log', pending.avatar || '');
      else openRoomTeacherDetails(pending.roomName, pending.source || 'navigation');
    });
    if (!focused) {
      showMissingRoomObjectAlert(pending.roomName).then(() => {
        if (pending.record) {
          openTeacherRecordDetails(pending.record, pending.source || 'recent-log', pending.avatar || '');
        } else {
          openRoomTeacherDetails(pending.roomName, pending.source || 'navigation', false);
        }
      });
    }
  }, [status, modelSrc]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const payload = await apiGet('camera-positions.php').catch(() => null);
        if (!active || !payload) return;
        const presets = {};
        Object.entries(payload || {}).forEach(([key, value]) => {
          if (value && Array.isArray(value.position) && Array.isArray(value.target)) {
            presets[key] = { position: value.position, target: value.target };
          }
        });
        const nextPresets = { ...defaultCameraPresets, ...cameraPresetsRef.current, ...presets };
        cameraPresetsRef.current = nextPresets;
        setCameraPresets(nextPresets);
        if (modelRef.current) applyCurrentBuildingFrontView(modelSrcRef.current);
      } catch (error) {
        console.warn('Camera presets unavailable:', error);
      }
    })();
    return () => { active = false; };
  }, []);

  const extractNamedCameraFromGLTF = (gltf) => {
    if (!gltf || !gltf.scene || !window.THREE) return null;

    let cameraNode = null;
    gltf.scene.traverse((child) => {
      if (child.isCamera && (child.name === 'CameraMW' || child.name === 'Camera.MW')) {
        cameraNode = child;
      }
    });

    if (!cameraNode) return null;

    const position = new window.THREE.Vector3();
    cameraNode.getWorldPosition(position);

    const direction = new window.THREE.Vector3(0, 0, -1);
    const quat = new window.THREE.Quaternion();
    cameraNode.getWorldQuaternion(quat);
    direction.applyQuaternion(quat);

    const target = position.clone().add(direction.multiplyScalar(15));

    return { position, target, name: cameraNode.name };
  };

  const applyView = (view) => {
    if (!modelRef.current) return;
    if (view !== 'top') {
      if (applyCurrentBuildingFrontView()) return;
    }
    cancelCameraMotion();
    const direction = view === 'top' ? [0, 1, 0.001] : [1, 0.45, 1];
    frameObjectInCamera(modelRef.current, direction);
  };

  const rotateModel = (degrees) => {
    if (!modelRef.current || !window.THREE) return;
    const rad = window.THREE.MathUtils.degToRad(degrees);
    modelRef.current.rotation.y += rad;
    requestSceneRender();
  };

  const handleDefaultView = () => {
    if (modelRef.current && modelInitialQuaternionRef.current) {
      modelRef.current.quaternion.copy(modelInitialQuaternionRef.current);
      modelRef.current.updateMatrixWorld(true);
    }
    if (!applyCurrentBuildingFrontView() && modelRef.current) {
      cancelCameraMotion();
      frameObjectInCamera(modelRef.current, [1, 0.45, 1]);
    }
  };

  const showSwal = async ({ title, text, icon = 'info' }) => {
    if (window.Swal) {
      await window.Swal.fire({ title, text, icon });
    } else {
      alert(`${title}\n${text}`);
    }
  };

  const showMissingRoomObjectAlert = async (roomName) => {
    if (!applyCurrentBuildingFrontView() && modelRef.current) {
      cancelCameraMotion();
      frameObjectInCamera(modelRef.current, [1, 0.45, 1]);
    }
    requestSceneRender();
    await showSwal({
      title: '3D Room Object Missing',
      text: `The building model is displayed, but database room "${roomName}" has no matching renamed room object in this 3D model.`,
      icon: 'warning'
    });
  };

  const handleSaveFrontView = async () => {
    if (!canSaveFrontView || isSavingFrontView) return;
    const definition = getCameraModelDefinition();
    if (!definition || !cameraRef.current || !controlsRef.current || status !== 'ready') {
      await showSwal({
        title: 'Camera Not Ready',
        text: 'Wait for one of the six building models to finish loading.',
        icon: 'warning'
      });
      return;
    }

    let confirmed = true;
    if (window.Swal) {
      const result = await window.Swal.fire({
        title: `Save ${definition.code} Front View?`,
        text: 'The current camera position will become the default view for all users.',
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: 'Save Front View',
        confirmButtonColor: '#198754'
      });
      confirmed = !!result.isConfirmed;
    } else {
      confirmed = window.confirm(`Save the current camera as the global ${definition.code} front view?`);
    }
    if (!confirmed) return;

    const roundVector = (vector) => vector.toArray().map((value) => Number(value.toFixed(4)));
    const position = roundVector(cameraRef.current.position);
    const target = roundVector(controlsRef.current.target);

    setIsSavingFrontView(true);
    try {
      const response = await apiPost('camera-positions.php', {
        building_code: definition.code,
        position,
        target
      });
      const preset = response?.preset || { position, target };
      const nextPresets = {
        ...cameraPresetsRef.current,
        [definition.cameraKey]: preset,
        [definition.aliasKey]: preset
      };
      cameraPresetsRef.current = nextPresets;
      setCameraPresets(nextPresets);
      await showSwal({
        title: 'Front View Saved',
        text: `${definition.code} will now open at this camera position for all users.`,
        icon: 'success'
      });
    } catch (error) {
      console.error('Unable to save front camera view:', error);
      await showSwal({
        title: 'Save Failed',
        text: error?.body?.message || error?.message || 'Unable to save the camera position.',
        icon: 'error'
      });
    } finally {
      setIsSavingFrontView(false);
    }
  };

  const requestViewerFullscreen = async () => {
    const viewerElement = viewerWrapRef.current;
    if (!viewerElement) return;

    setIsFullscreen(true);
    setMessage('');
    filePickerActiveRef.current = false;

    try {
      if (viewerElement.requestFullscreen) {
        await viewerElement.requestFullscreen();
      } else if (viewerElement.webkitRequestFullscreen) {
        viewerElement.webkitRequestFullscreen();
      } else if (viewerElement.msRequestFullscreen) {
        viewerElement.msRequestFullscreen();
      } else {
        throw new Error('Fullscreen mode is not supported in this browser.');
      }
      requestAnimationFrame(() => syncViewerSize());
    } catch (error) {
      console.warn('Browser fullscreen request was not kept; using expanded viewer mode instead.', error);
      requestAnimationFrame(() => syncViewerSize());
    }
  };

  const exitViewerFullscreen = async () => {
    filePickerActiveRef.current = false;

    try {
      if (document.fullscreenElement === viewerWrapRef.current && document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (document.webkitFullscreenElement === viewerWrapRef.current && document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      } else if (document.msFullscreenElement === viewerWrapRef.current && document.msExitFullscreen) {
        document.msExitFullscreen();
      }
    } catch (error) {
      console.warn('Could not exit native fullscreen cleanly.', error);
    } finally {
      nativeFullscreenRef.current = false;
      setIsFullscreen(false);
      requestAnimationFrame(() => {
        syncViewerSize();
        updateUploadAnchorButtons();
      });
    }
  };

  const triggerUploadDialog = (anchorId = selectedUploadAnchorIdRef.current) => {
    if (!fileInputRef.current || isUploadBusy || pendingUploadActiveRef.current) return;
    selectedUploadAnchorIdRef.current = anchorId;
    setMessage('');
    filePickerActiveRef.current = true;
    fileInputRef.current.click();
  };

  const parseUploadedModelFile = async (file, ext) => {
    if (!window.THREE) throw new Error('The 3D engine is not ready yet.');

    if (ext === '.glb' || ext === '.gltf') {
      const loader = new window.THREE.GLTFLoader();
      const source = ext === '.glb' ? await readFileAsArrayBuffer(file) : await readFileAsText(file);
      return new Promise((resolve, reject) => {
        loader.parse(
          source,
          '',
          (gltf) => {
            const object = gltf.scene || gltf.scenes?.[0];
            if (!object) {
              reject(new Error(`"${file.name}" did not contain a usable 3D scene.`));
              return;
            }
            resolve(object);
          },
          (error) => {
            const fallbackText = ext === '.gltf'
              ? 'Use a self-contained .gltf or .glb file for uploads.'
              : 'The file could not be parsed.';
            reject(new Error(error?.message ? `${error.message} ${fallbackText}` : fallbackText));
          }
        );
      });
    }

    if (ext === '.obj') {
      if (!window.THREE.OBJLoader) throw new Error('OBJ uploads are not available in this build.');
      const source = await readFileAsText(file);
      return new window.THREE.OBJLoader().parse(source);
    }

    if (ext === '.fbx') {
      if (!window.THREE.FBXLoader) throw new Error('FBX uploads are not available in this build.');
      const source = await readFileAsArrayBuffer(file);
      return new window.THREE.FBXLoader().parse(source, '');
    }

    if (ext === '.stl') {
      if (!window.THREE.STLLoader) throw new Error('STL uploads are not available in this build.');
      const source = await readFileAsArrayBuffer(file);
      const geometry = new window.THREE.STLLoader().parse(source);
      if (typeof geometry.computeVertexNormals === 'function') geometry.computeVertexNormals();
      const material = new window.THREE.MeshStandardMaterial({
        color: 0xd9e2ec,
        metalness: 0.08,
        roughness: 0.72
      });
      return new window.THREE.Mesh(geometry, material);
    }

    throw new Error(`Unsupported file type. Choose one of: ${supportedUploadExts.join(', ')}`);
  };

  const handleUploadedModelSelection = async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      filePickerActiveRef.current = false;
      return;
    }

    const ext = getFileExtension(file.name);
    if (!supportedUploadExts.includes(ext)) {
      setMessage(`Unsupported file type. Choose one of: ${supportedUploadExts.join(', ')}`);
      filePickerActiveRef.current = false;
      event.target.value = '';
      return;
    }

    setMessage('');
    setIsUploadBusy(true);
    setSceneBusyLabel(`Importing ${file.name}`);

    try {
      const object = await parseUploadedModelFile(file, ext);
      object.name = object.name || file.name;
      centerObjectAtOrigin(object);
      placeObjectOnGround(object);
      applyUploadAnchorPlacement(object);
      storeInitialUploadPosition(object);
      if (!sceneRef.current) {
        removeSceneObject(object);
        return;
      }
      clearPendingUploadPreview({ suppressState: true });
      setAcceptedUploadsVisible(false);
      sceneRef.current.add(object);
      pendingUploadObjectRef.current = object;
      setPendingUploadState({ name: file.name });
      syncActiveUploadTransform(object);
      setMessage(`Preview ready for "${file.name}". Accept or cancel the upload changes.`);
      controlsRef.current?.update();
      requestAnimationFrame(() => {
        syncViewerSize();
        updateUploadAnchorButtons();
      });
    } catch (error) {
      console.error(error);
      setMessage(error?.message || `Failed to import "${file.name}".`);
    } finally {
      setIsUploadBusy(false);
      setSceneBusyLabel('Loading 3D model');
      filePickerActiveRef.current = false;
      event.target.value = '';
    }
  };

  const acceptPendingUploadChanges = () => {
    const pendingObject = pendingUploadObjectRef.current;
    if (!pendingObject) return;

    clearUploadedObjects();
    pendingObject.visible = true;
    uploadedObjectsRef.current = [pendingObject];
    pendingUploadObjectRef.current = null;
    setPendingUploadState(null);
    syncActiveUploadTransform(pendingObject);
    setMessage(`Accepted "${pendingObject.name || 'uploaded model'}".`);
    requestAnimationFrame(() => {
      syncViewerSize();
      updateUploadAnchorButtons();
    });
  };

  const cancelPendingUploadChanges = () => {
    const pendingName = pendingUpload?.name || pendingUploadObjectRef.current?.name || 'upload preview';
    clearPendingUploadPreview({ restoreCommitted: true });
    setMessage(`Canceled changes for "${pendingName}".`);
    requestAnimationFrame(() => {
      syncViewerSize();
      updateUploadAnchorButtons();
    });
  };

  const focusRoomCamera = (roomName, onDone) => {
    if (!roomName || !modelRef.current || !cameraRef.current || !window.THREE) return false;
    const normalizedTarget = normalizeMeshKey(roomName);
    let targetMesh = meshMapRef.current[normalizedTarget] || null;
    if (!targetMesh) {
      modelRef.current.traverse((child) => {
        if (child.isMesh && normalizeMeshKey(child.name) === normalizedTarget) {
          targetMesh = child;
        }
      });
    }
    if (!targetMesh) return false;

    const box = new window.THREE.Box3().setFromObject(targetMesh);
    const center = box.getCenter(new window.THREE.Vector3());
    const size = box.getSize(new window.THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = cameraRef.current.fov * (Math.PI / 180);
    let distance = Math.abs(maxDim / 2 / Math.tan(fov / 2));
    distance = Math.max(distance * 0.85, 1.8);

    const direction = new window.THREE.Vector3(1, 0.4, 1).normalize();
    const position = center.clone().add(direction.multiplyScalar(distance));
    smoothCameraTo(position, center, 650, onDone);
    return true;
  };

  const handleNavigatorBuildingSelect = async (buildingName) => {
    const clean = String(buildingName || '').trim();
    if (!clean) return;
    setNavigatorBuilding(clean);
    setNavigatorFloor('');
    setNavigatorRoom('');
    const mappedModel = getBuildingModelSrc(clean);
    if (!mappedModel) {
      setModelSrc('');
      setBuildingExplorerOpen(false);
      setRoomListOpen(true);
      return;
    }
    if (getCameraModelDefinition(mappedModel)?.code !== getCameraModelDefinition(modelSrc)?.code) {
      setModelSrc(mappedModel);
      setBuildingExplorerOpen(false);
      setRoomListOpen(true);
      return;
    }
    focusBuildingCamera(clean, () => {
      setBuildingExplorerOpen(false);
      setRoomListOpen(true);
    });
  };

  const handleTableBuildingSelect = (buildingName) => {
    const clean = String(buildingName || '').trim();
    if (clean) {
      handleNavigatorBuildingSelect(clean);
      return;
    }
    setNavigatorBuilding('');
    setNavigatorFloor('');
    setNavigatorRoom('');
  };

  const openBuildingModelPicker = () => {
    if (!canSaveFrontView || !navigatorBuildingRecord?.building_id || isUploadBusy) return;
    buildingModelInputRef.current?.click();
  };

  const handlePersistentBuildingModelSelection = async (event) => {
    const file = event.target.files?.[0] || null;
    event.target.value = '';
    if (!file || !navigatorBuildingRecord?.building_id || !canSaveFrontView) return;
    if (!String(file.name || '').toLowerCase().endsWith('.glb')) {
      await showSwal({ title: 'Invalid Model', text: 'Only binary .glb building models are allowed.', icon: 'warning' });
      return;
    }
    if (file.size <= 0 || file.size > 40 * 1024 * 1024) {
      await showSwal({ title: 'Invalid Model Size', text: 'The GLB must be larger than 0 bytes and no more than 40 MB.', icon: 'warning' });
      return;
    }

    const replacing = Boolean(navigatorBuildingRecord.model_path);
    if (replacing && window.Swal) {
      const confirmation = await window.Swal.fire({
        title: 'Change Building Model?',
        text: `Replace the current GLB for ${navigatorBuildingRecord.building_name}? Its saved default camera view will be reset.`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Change Building'
      });
      if (!confirmation.isConfirmed) return;
    }

    setIsUploadBusy(true);
    setSceneBusyLabel(replacing ? 'Changing building model' : 'Adding building model');
    try {
      const replacedDefinition = getCameraModelDefinition(modelSrc);
      const payload = new FormData();
      payload.append('model', file, file.name);
      const uploaded = await apiFetch(`buildings/${navigatorBuildingRecord.building_id}/model`, { method: 'POST', body: payload });
      const freshBuildings = await apiGet('buildings');
      setCatalog((previous) => ({ ...previous, buildings: Array.isArray(freshBuildings) ? freshBuildings : previous.buildings }));
      if (replacedDefinition) {
        const nextPresets = { ...cameraPresetsRef.current };
        [replacedDefinition.cameraKey, replacedDefinition.aliasKey].forEach((key) => {
          if (!key) return;
          if (defaultCameraPresets[key]) nextPresets[key] = defaultCameraPresets[key];
          else delete nextPresets[key];
        });
        cameraPresetsRef.current = nextPresets;
        setCameraPresets(nextPresets);
      }
      const nextSource = resolveStoredBuildingModelUrl(uploaded?.model_path, uploaded?.model_updated_at || Date.now());
      if (nextSource) {
        frameNextBuildingModelRef.current = true;
        setModelSrc(nextSource);
      }
      await showSwal({
        title: replacing ? 'Building Model Changed' : 'Building Model Added',
        text: `${file.name} is now connected to ${navigatorBuildingRecord.building_name}.`,
        icon: 'success'
      });
    } catch (error) {
      await showSwal({
        title: 'Model Upload Failed',
        text: error?.body?.message || error?.message || 'Unable to upload the GLB building model.',
        icon: 'error'
      });
    } finally {
      setIsUploadBusy(false);
    }
  };

  const handleNavigatorFloorSelect = (floorName) => {
    const clean = String(floorName || '').trim();
    setNavigatorFloor(clean);
    setNavigatorRoom('');
  };

  const handleNavigatorRoomSelect = async (roomName) => {
    const clean = String(roomName || '').trim();
    if (!clean) return;

    const roomCatalogEntry = (catalog.rooms || []).find((room) => nameEq(room.room_name, clean) || nameEq(room.roomName, clean));
    const buildingMeta = roomCatalogEntry
      ? (catalog.buildings || []).find((building) => String(building.building_id) === String(roomCatalogEntry.building_id))
      : null;
    const floorMeta = roomCatalogEntry
      ? (catalog.floors || []).find((floor) => String(floor.floor_id) === String(roomCatalogEntry.floor_id))
      : null;
    const inferredBuilding = buildingMeta?.building_name || roomCatalogEntry?.building_name || roomCatalogEntry?.buildingName || '';
    const inferredFloor = floorMeta?.floor_name || roomCatalogEntry?.floor_name || roomCatalogEntry?.floorName || '';

    setNavigatorBuilding(inferredBuilding || navigatorBuilding || '');
    setNavigatorFloor(inferredFloor || navigatorFloor || '');
    setNavigatorRoom(clean);

    const mappedModel = getBuildingModelSrc(inferredBuilding || navigatorBuilding);
    const currentCode = getCameraModelDefinition(modelSrc)?.code;
    const destinationCode = getCameraModelDefinition(mappedModel)?.code;
    if (mappedModel && destinationCode && destinationCode !== currentCode) {
      pendingNavigatorRoomRef.current = { roomName: clean, modelSrc: mappedModel };
      setModelSrc(mappedModel);
      return;
    }

    if (!focusRoomCamera(clean, () => openRoomTeacherDetails(clean, 'navigation'))) {
      await showMissingRoomObjectAlert(clean);
      openRoomTeacherDetails(clean, 'navigation', false);
    }
  };

  const handleRecentLogClick = async (log) => {
    const roomName = String(log?.roomName || '').trim();
    if (!roomName || roomName === '-') {
      await showSwal({
        title: 'Room Not Found',
        text: 'This log has no room assigned.',
        icon: 'warning'
      });
      return;
    }

    setPendingFilters((prev) => ({
      ...prev,
      campus: log.campusName || prev.campus || '',
      building: log.buildingName || prev.building || '',
      floor: log.floorName || prev.floor || '',
      room: roomName
    }));

    const mappedModel = getBuildingModelSrc(log.buildingName || log.record?.building_name || '');
    const currentCode = getCameraModelDefinition(modelSrc)?.code;
    const destinationCode = getCameraModelDefinition(mappedModel)?.code;
    if (mappedModel && destinationCode && destinationCode !== currentCode) {
      pendingNavigatorRoomRef.current = {
        roomName,
        modelSrc: mappedModel,
        record: log.record,
        avatar: log.avatar,
        source: 'recent-log'
      };
      setModelSrc(mappedModel);
      return;
    }

    const ok = focusRoomCamera(roomName, () => {
      openTeacherRecordDetails(log.record, 'recent-log', log.avatar);
    });

    if (!ok) {
      await showMissingRoomObjectAlert(roomName);
      openTeacherRecordDetails(log.record, 'recent-log', log.avatar);
    }
  };

  const applyFilterView = async () => {
    setAppliedFilters({ ...pendingFilters });
    const hasAttendance = attendanceRecords.some(r => recordMatchesFilter(r, pendingFilters));
    const hasCatalog = (() => {
      if (pendingFilters.room) return roomOptions.includes(pendingFilters.room);
      if (pendingFilters.floor) return roomOptions.length > 0;
      if (pendingFilters.building) return floorOptions.length > 0 || roomOptions.length > 0;
      if (pendingFilters.campus) return buildingOptions.length > 0 || floorOptions.length > 0 || roomOptions.length > 0;
      return true;
    })();
    if (!hasAttendance && !hasCatalog) {
      await showSwal({
        title: 'No Rooms Found',
        text: 'No rooms or schedules match your selected filters.',
        icon: 'warning'
      });
      return;
    }

    if (pendingFilters.building && namedCameraDataRef.current && cameraRef.current) {
      const camData = namedCameraDataRef.current;
      if (camData.position) {
        const lookAtPos = camData.target || new window.THREE.Vector3(0, 0, 0);
        smoothCameraTo(camData.position, lookAtPos, 800);
        return;
      }
    }

    if (pendingFilters.room) {
      const ok = focusRoomCamera(pendingFilters.room);
      if (!ok) {
        await showMissingRoomObjectAlert(pendingFilters.room);
        openRoomTeacherDetails(pendingFilters.room, 'filter', false);
      }
    } else {
    }
  };

  const selectedLogDate = (() => {
    const key = normalizeDateKey(selectedScheduleDate) || toLocalYmd();
    const d = new Date(`${key}T00:00:00`);
    return Number.isNaN(d.getTime()) ? nowTime : d;
  })();
  const dateTimeStamp = `${selectedLogDate
    .toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
    .toUpperCase()
    .replace(', ', ',')} ${nowTime
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .toUpperCase()
    .replace(' ', '')}`;
  const isSceneBusy = status === 'loading' || isUploadBusy;
  const hasMovableUpload = !!activeUploadTransform;
  const presenceLastUpdatedLabel = presenceLastUpdated
    ? new Date(presenceLastUpdated).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : 'Not updated';
  const getPresenceAvatarUrl = (marker) => marker?.avatar_url
    ? resolveApiAssetUrl(marker.avatar_url)
    : defaultAvatarSrc;
  const formatPresenceGrace = (marker) => {
    const totalSeconds = Math.max(0, Number(marker?.grace_seconds_remaining || 0));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  };
  const setPresenceMarkerRef = (roomId, node) => {
    const key = String(roomId);
    if (node) presenceMarkerRefs.current[key] = node;
    else delete presenceMarkerRefs.current[key];
  };
  const openTeacherRecordDetails = (rawRecord, source = 'record', avatarOverride = '') => {
    if (!rawRecord) return;
    const record = rawRecord.room_name ? rawRecord : normalizeRecord(rawRecord);
    const statusValue = record.status || computeAttendanceStatus(record);
    const parallelSchedules = record.is_parallel
      ? (record.parallel_rooms || []).map((roomName) => ({ room_name: roomName }))
      : getParallelSchedules(record);
    setModalScheduleDate(normalizeDateKey(record.date) || normalizeDateKey(selectedScheduleDate) || toLocalYmd());
    setSearchTeacher(record.teacher_name || '');
    setSelectedDepartment('');
    setTeacherStatusModal({
      record: {
        ...record,
        teacher_name: record.teacher_name || 'Teacher',
        room_name: record.room_name || '-',
        subject: record.subject || `${record.subject_code || ''} ${record.subject_name || ''}`.trim(),
        scheduled_time: record.scheduled_time || `${formatClock(record.start_time)} - ${formatClock(record.end_time)}`,
        is_parallel: !!record.is_parallel || parallelSchedules.length > 1,
        parallel_rooms: record.parallel_rooms || parallelSchedules.map((item) => item.room_name).filter(Boolean)
      },
      teacherId: record.teacher_id || record.user_id || '',
      avatarUrl: avatarOverride || record.avatar || '',
      status: statusValue,
      attendanceStatus: record.attendance_status || statusValue,
      statusText: statusValue,
      source
    });
  };
  const openPresenceMarkerDetails = (marker) => {
    openTeacherRecordDetails(marker, 'live-presence', getPresenceAvatarUrl(marker));
  };
  const locateTableRecordIn3D = (record) => {
    setViewMode('3d');
    requestAnimationFrame(() => {
      handleNavigatorRoomSelect(record?.room_name || '');
    });
  };
  const openRoomTeacherDetails = (roomName, source = 'navigation', notifyIfEmpty = true) => {
    const liveMarker = visiblePresenceMarkers.find((marker) => nameEq(marker.room_name, roomName));
    if (liveMarker) {
      openPresenceMarkerDetails(liveMarker);
      return true;
    }
    const dateKey = normalizeDateKey(selectedScheduleDate) || toLocalYmd();
    const roomRecords = attendanceRecords.filter((record) => (
      nameEq(record.room_name, roomName) && normalizeDateKey(record.date) === dateKey
    ));
    if (roomRecords.length > 0) {
      const now = new Date();
      const activeRecord = roomRecords.find((record) => {
        const start = toDateTime(record.date, record.start_time);
        const end = toDateTime(record.date, record.end_time);
        return start && end && now >= start && now <= end;
      });
      openTeacherRecordDetails(activeRecord || roomRecords[0], source);
      return true;
    }
    setModalScheduleDate(normalizeDateKey(selectedScheduleDate) || toLocalYmd());
    setSearchTeacher('');
    setSelectedDepartment('');
    setTeacherStatusModal({
      record: {
        room_name: roomName || 'Room',
        teacher_name: '',
        subject: '',
        section_name: '',
        scheduled_time: '',
        no_records: true
      },
      teacherId: '',
      avatarUrl: '',
      status: 'PENDING',
      attendanceStatus: 'PENDING',
      statusText: 'PENDING',
      source,
      notifyIfEmpty
    });
    return true;
  };
  const presenceBadgeClass = (value) => String(value || 'PENDING').toLowerCase().replace(/_/g, '-');
  const presenceFlagLabel = (value) => {
    const flagId = Number(value || 1);
    if (flagId === 2) return 'Present';
    if (flagId === 3) return 'Absent';
    if (flagId === 4) return 'Substituted';
    if (flagId === 5) return 'Late';
    if (flagId === 7) return 'On leave';
    if (flagId === 8) return 'Pending';
    return 'Upcoming';
  };
  const formatPresenceCheckpoint = (value) => {
    if (!value) return 'Not recorded';
    const date = new Date(String(value).replace(' ', 'T'));
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
    return String(value);
  };
  const formatPresenceCheckpointDetail = (time, flagId) => (
    `${presenceFlagLabel(flagId)} - ${formatPresenceCheckpoint(time)}`
  );

  const modalSourceRecords = (normalizeDateKey(modalScheduleDate) || toLocalYmd())
    === (normalizeDateKey(selectedScheduleDate) || toLocalYmd())
    ? attendanceRecords
    : modalAttendanceRecords;

  const modalTodaySourceRecords = (normalizeDateKey(selectedScheduleDate) || currentDateKey) === currentDateKey
    ? attendanceRecords
    : modalTodayAttendanceRecords;
  const modalTodayIsLoading = (normalizeDateKey(selectedScheduleDate) || currentDateKey) === currentDateKey
    ? attendanceRecordsLoading
    : modalTodayRecordsLoading;
  const modalTodayError = (normalizeDateKey(selectedScheduleDate) || currentDateKey) === currentDateKey
    ? attendanceRecordsError
    : modalTodayRecordsError;

  const modalRoomSchedules = useMemo(() => {
    if (!teacherStatusModal) return [];
    const roomName = String(teacherStatusModal.record?.room_name || '').trim();
    const teacherQuery = String(searchTeacher || '').trim().toLowerCase();
    const dateKey = normalizeDateKey(modalScheduleDate) || toLocalYmd();
    return modalSourceRecords
      .filter((record) => normalizeDateKey(record.date) === dateKey)
      .filter((record) => !roomName || nameEq(record.room_name, roomName))
      .filter((record) => !canSaveFrontView || !selectedDepartment || nameEq(record.department_name, selectedDepartment))
      .filter((record) => !teacherQuery || String(record.teacher_name || '').toLowerCase().includes(teacherQuery))
      .sort((left, right) => String(left.start_time || '').localeCompare(String(right.start_time || '')));
  }, [teacherStatusModal, modalSourceRecords, modalScheduleDate, selectedDepartment, searchTeacher, canSaveFrontView]);

  const modalTeacherOptions = useMemo(() => uniqueValues(
    modalSourceRecords
      .filter((record) => normalizeDateKey(record.date) === (normalizeDateKey(modalScheduleDate) || toLocalYmd()))
      .filter((record) => !teacherStatusModal?.record?.room_name || nameEq(record.room_name, teacherStatusModal.record.room_name))
      .filter((record) => !canSaveFrontView || !selectedDepartment || nameEq(record.department_name, selectedDepartment))
      .map((record) => record.teacher_name)
  ), [modalSourceRecords, modalScheduleDate, selectedDepartment, teacherStatusModal, canSaveFrontView]);

  const modalDepartmentOptions = useMemo(() => uniqueValues(
    modalSourceRecords.map((record) => record.department_name)
  ).sort(), [modalSourceRecords]);

  const modalTodayRoomSchedules = useMemo(() => {
    if (!teacherStatusModal) return [];
    const roomName = String(teacherStatusModal.record?.room_name || '').trim();
    const todayKey = currentDateKey;
    return modalTodaySourceRecords
      .filter((record) => normalizeDateKey(record.date) === todayKey)
      .filter((record) => !roomName || nameEq(record.room_name, roomName))
      .filter((record) => !canSaveFrontView || !selectedDepartment || nameEq(record.department_name, selectedDepartment))
      .sort((left, right) => String(left.start_time || '').localeCompare(String(right.start_time || '')));
  }, [teacherStatusModal, modalTodaySourceRecords, selectedDepartment, canSaveFrontView, currentDateKey]);

  const modalRecentAttendance = useMemo(() => {
    return modalTodayRoomSchedules
      .flatMap((record, recordIndex) => ([
        { key: `${record.schedule_id || recordIndex}-in`, label: 'Check in', teacherName: record.teacher_name, status: computeCheckpointStatus(record, 'in'), time: record.time_in },
        { key: `${record.schedule_id || recordIndex}-mid`, label: 'Mid-check', teacherName: record.teacher_name, status: computeCheckpointStatus(record, 'mid'), time: record.time_check },
        { key: `${record.schedule_id || recordIndex}-out`, label: 'Check out', teacherName: record.teacher_name, status: computeCheckpointStatus(record, 'out'), time: record.time_out }
      ]))
      .sort((left, right) => {
    if (!left.time && !right.time) return 0;
    if (!left.time) return 1;
    if (!right.time) return -1;
    return String(right.time).localeCompare(String(left.time));
      });
  }, [modalTodayRoomSchedules]);

  const modalSelectedDate = modalDateParts(modalScheduleDate);
  const modalTodayDate = modalDateParts(currentDateKey);

  return (
    <div className="tdb-page">
      <div className="tdb-shell">
        <div className="tdb-main" ref={mainPanelRef}>
          <div className="tdb-top-row">
            <div className="tdb-title-row">
              <h2 className="tdb-title">3D Building Viewer</h2>
              <div className="tdb-view-mode-switch" role="group" aria-label="Building viewer display mode">
                <button
                  type="button"
                  className={viewMode === '3d' ? 'is-active' : ''}
                  onClick={() => setViewMode('3d')}
                  aria-pressed={viewMode === '3d'}
                >
                  3D View
                </button>
                <button
                  type="button"
                  className={viewMode === 'table' ? 'is-active' : ''}
                  onClick={() => setViewMode('table')}
                  aria-pressed={viewMode === 'table'}
                >
                  Table View
                </button>
              </div>
            </div>
            <div className="tdb-stats">
              <div className="tdb-stat-card">
                <div className="tdb-stat-label">OTHER (UPCOMING, PENDING, ETC...)</div>
                <div className="tdb-stat-value">{stats.totalOther}</div>
              </div>
              <div className="tdb-stat-card">
                <div className="tdb-stat-label">TOTAL PRESENT</div>
                <div className="tdb-stat-value">{stats.totalPresent}</div>
              </div>
              <div className="tdb-stat-card">
                <div className="tdb-stat-label">TOTAL LATE</div>
                <div className="tdb-stat-value">{stats.totalLate}</div>
              </div>
              <div className="tdb-stat-card">
                <div className="tdb-stat-label">TOTAL ABSENT</div>
                <div className="tdb-stat-value">{stats.totalAbsent}</div>
              </div>
            </div>
          </div>

          <div
            className={`tdb-viewer-wrap${isFullscreen ? ' tdb-viewer-wrap--fullscreen' : ''}${viewMode === 'table' ? ' tdb-viewer-wrap--table' : ''}`}
            ref={viewerWrapRef}
          >
            <input
              ref={fileInputRef}
              type="file"
              className="tdb-hidden-file-input"
              accept={supportedUploadExts.join(',')}
              onChange={handleUploadedModelSelection}
            />
            <input
              ref={buildingModelInputRef}
              type="file"
              className="tdb-hidden-file-input"
              accept=".glb,model/gltf-binary"
              onChange={handlePersistentBuildingModelSelection}
            />

            {!isFullscreen && (
              <button
                type="button"
                className="tdb-glass-plus-btn tdb-glass-plus-btn--entry"
                onClick={requestViewerFullscreen}
                aria-label="Expand 3D viewer fullscreen"
                title="Expand 3D viewer"
              >
                <svg className="tdb-fullscreen-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9 4H4v5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
                </svg>
              </button>
            )}

            {isFullscreen && (
              <button
                type="button"
                className="tdb-glass-plus-btn tdb-glass-plus-btn--exit"
                onClick={exitViewerFullscreen}
                aria-label="Exit fullscreen"
                title="Exit fullscreen"
              >
                <svg className="tdb-fullscreen-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 9h5V4M20 9h-5V4M15 20v-5h5M9 20v-5H4" />
                </svg>
              </button>
            )}

            <div className="tdb-viewer" ref={mountRef} />
            {viewMode === 'table' && (
              <TeacherTableView
                buildings={navigatorBuildings}
                floors={tableFloorOptions}
                selectedBuilding={navigatorBuilding}
                selectedFloor={navigatorFloor}
                selectedDate={selectedTableDate}
                getAvatarUrl={(record) => record?.avatar || getPresenceAvatarUrl(record)}
                fallbackAvatar={defaultAvatarSrc}
                onBuildingChange={handleTableBuildingSelect}
                onFloorChange={handleNavigatorFloorSelect}
                onDateChange={(dateValue) => setSelectedTableDate(dateValue || selectedScheduleDate)}
                onViewDetails={(record) => openTeacherRecordDetails(record, 'table-view', record?.avatar || getPresenceAvatarUrl(record))}
                onLocateIn3D={locateTableRecordIn3D}
              />
            )}
            {navigatorBuildingRecord && !navigatorBuildingRecord.model_path && (
              <div className="tdb-missing-building-model">
                {canSaveFrontView ? (
                  <button type="button" onClick={openBuildingModelPicker} disabled={isUploadBusy}>
                    <span aria-hidden="true">+</span>
                    <strong>{isUploadBusy ? 'Uploading GLB...' : 'Add Building Model'}</strong>
                    <small>{navigatorBuildingRecord.building_name}</small>
                  </button>
                ) : (
                  <div>
                    <strong>No 3D model available</strong>
                    <small>{navigatorBuildingRecord.building_name}</small>
                  </div>
                )}
              </div>
            )}
            <div className="tdb-presence-layer">
              {presenceMarkersVisible && visiblePresenceMarkers.map((marker) => (
                <button
                  key={`${marker.room_id}-${marker.schedule_id}-${marker.teacher_id}`}
                  type="button"
                  className={`tdb-presence-marker tdb-presence-marker--${String(marker.status || 'PENDING').toLowerCase()}`}
                  ref={(node) => setPresenceMarkerRef(marker.room_id, node)}
                  onClick={() => openPresenceMarkerDetails(marker)}
                  title={`${marker.teacher_name} · ${marker.room_name} · ${marker.status}${marker.is_recently_ended ? ` · Previous class · ${formatPresenceGrace(marker)} remaining` : ''}`}
                  aria-label={`Open ${marker.teacher_name} attendance details for ${marker.room_name}`}
                >
                  <img
                    src={getPresenceAvatarUrl(marker)}
                    alt=""
                    width="48"
                    height="48"
                    loading="lazy"
                    decoding="async"
                    onError={(event) => {
                      if (event.currentTarget.src !== defaultAvatarSrc) event.currentTarget.src = defaultAvatarSrc;
                    }}
                  />
                  {marker.is_substitute && <span className="tdb-presence-sub-badge" aria-label="Substitute">S</span>}
                  {marker.is_parallel && <span className="tdb-presence-parallel-badge" aria-label="Parallel class">P</span>}
                  <span className="tdb-presence-marker-name">
                    {marker.teacher_name}{marker.is_recently_ended ? ` · Previous class (${formatPresenceGrace(marker)})` : ''}
                  </span>
                </button>
              ))}
            </div>

            <div className="tdb-presence-toolbar">
              <button
                type="button"
                className={`tdb-presence-toggle${presenceMarkersVisible ? ' tdb-presence-toggle--active' : ''}`}
                onClick={() => setPresenceMarkersVisible((value) => !value)}
              >
                {presenceMarkersVisible ? 'Hide teachers' : 'Show teachers'}
              </button>
              {presenceMarkersVisible && (
                <div className="tdb-presence-legend" aria-label="Teacher marker legend">
                  <span><i className="tdb-presence-dot tdb-presence-dot--present" />Present</span>
                  <span><i className="tdb-presence-dot tdb-presence-dot--late" />Late</span>
                  <span><i className="tdb-presence-dot tdb-presence-dot--absent" />Absent</span>
                  <span><i className="tdb-presence-dot tdb-presence-dot--pending" />Pending</span>
                  <span><i className="tdb-presence-dot tdb-presence-dot--on_leave" />Leave</span>
                  <span><i className="tdb-presence-dot tdb-presence-dot--substituted" />Substitute</span>
                </div>
              )}
              <span className="tdb-presence-updated">Updated {presenceLastUpdatedLabel}</span>
              {presenceError && (
                <button type="button" className="tdb-presence-retry" onClick={() => setPresenceRefreshToken((value) => value + 1)}>
                  Retry
                </button>
              )}
            </div>

            {canSaveFrontView && (presenceDiagnostics.unmatched.length > 0 || presenceDiagnostics.duplicates.length > 0) && (
              <details className="tdb-presence-diagnostics">
                <summary>Marker mapping: {presenceDiagnostics.unmatched.length} unmatched, {presenceDiagnostics.duplicates.length} duplicate</summary>
                {presenceDiagnostics.unmatched.length > 0 && (
                  <div>Unmatched: {presenceDiagnostics.unmatched.join(', ')}</div>
                )}
                {presenceDiagnostics.duplicates.length > 0 && (
                  <div>Duplicate: {presenceDiagnostics.duplicates.map((item) => item.room_name).join(', ')}</div>
                )}
              </details>
            )}

            {presenceError && <div className="tdb-presence-error">{presenceError}</div>}
            {movementGuideExpanded && (
              <div className="tdb-movement-guide">
                <div className="tdb-movement-guide-header">
                  <strong>Movement Guide</strong>
                  <button
                    type="button"
                    className="tdb-movement-guide-toggle"
                    onClick={() => setMovementGuideExpanded(false)}
                    aria-label="Minimize movement guide"
                    aria-expanded="true"
                    aria-controls="tdb-movement-guide-content"
                    title="Minimize movement guide"
                  >
                    &minus;
                  </button>
                </div>
                <div id="tdb-movement-guide-content" className="tdb-movement-guide-content">
                  Click the 3D view · WASD/arrows move · Q down · E up
                </div>
              </div>
            )}

            <button
              type="button"
              className="tdb-room-explorer-btn"
              onClick={() => setRoomListOpen(!roomListOpen)}
              aria-label="Toggle room explorer"
              title="Toggle room explorer"
            >
              🏛️
            </button>

            {roomListOpen && (
              <div className="tdb-room-explorer-panel">
                <div className="tdb-room-explorer-header">
                  <div className="tdb-room-explorer-title">Campus Navigator</div>
                  <input
                    type="text"
                    className="tdb-room-explorer-search"
                    placeholder="Search buildings, floors, rooms..."
                    value={buildingSearchText}
                    onChange={(e) => setBuildingSearchText(e.target.value)}
                  />
                </div>
                <div className="tdb-navigator-section">
                  <div className="tdb-navigator-title">Buildings</div>
                  <div className="tdb-navigator-chips">
                    {navigatorBuildings.length > 0 ? (
                      navigatorBuildings.map((building) => (
                        <button
                          key={building.name}
                          type="button"
                          className={`tdb-navigator-chip ${nameEq(building.name, navigatorBuilding) ? 'tdb-navigator-chip--active' : ''}`}
                          onClick={() => handleNavigatorBuildingSelect(building.name)}
                        >
                          {building.displayName}
                        </button>
                      ))
                    ) : (
                      <div className="tdb-navigator-empty"><LoadingState label="Loading building hierarchy..." compact /></div>
                    )}
                  </div>
                </div>
                {navigatorBuilding && (
                  <div className="tdb-navigator-section">
                    <div className="tdb-navigator-title">Floors</div>
                    <div className="tdb-navigator-chips">
                      <button
                        type="button"
                        className={`tdb-navigator-chip ${!navigatorFloor ? 'tdb-navigator-chip--active' : ''}`}
                        onClick={() => handleNavigatorFloorSelect('')}
                      >
                        ALL
                      </button>
                      {navigatorFloors.length > 0 ? (
                        navigatorFloors.map((floor) => (
                          <button
                            key={`${floor.buildingName}-${floor.floorName}`}
                            type="button"
                            className={`tdb-navigator-chip ${nameEq(floor.floorName, navigatorFloor) ? 'tdb-navigator-chip--active' : ''}`}
                            onClick={() => handleNavigatorFloorSelect(floor.floorName)}
                          >
                            {floor.displayName}
                          </button>
                        ))
                      ) : (
                        <div className="tdb-navigator-empty">No floors found for this building.</div>
                      )}
                    </div>
                  </div>
                )}
                <div className="tdb-room-list">
                  {roomExplorerRooms && roomExplorerRooms.length > 0 ? (
                    roomExplorerRooms.map((room, idx) => {
                      const roomName = room.room_name || room.roomName || `Room ${idx + 1}`;
                      const teachersInRoom = searchedRecords.filter(rec =>
                        nameEq(rec.room_name, roomName) && (rec.time_in || rec.time_check || rec.time_out)
                      ).length;
                      const building = catalog.buildings?.find(b => String(b.building_id) === String(room.building_id));
                      return (
                        <button
                          key={`${roomName}-${idx}`}
                          type="button"
                          className="tdb-room-list-item"
                          onClick={() => {
                            handleNavigatorRoomSelect(roomName);
                          }}
                        >
                          <div className="tdb-room-list-item-name">{roomName}</div>
                          <div className="tdb-room-list-item-meta">
                            {building?.building_name || '-'}
                            {teachersInRoom > 0 && (
                              <span className="tdb-room-list-item-count">{teachersInRoom}</span>
                            )}
                          </div>
                        </button>
                      );
                    })
                  ) : (
                    <div className="tdb-navigator-empty">No rooms found.</div>
                  )}
                </div>
              </div>
            )}

            <div className="tdb-side-controls">
              <button
                type="button"
                className={`tdb-movement-guide-switch${movementGuideExpanded ? ' tdb-movement-guide-switch--active' : ''}`}
                onClick={() => setMovementGuideExpanded((value) => !value)}
                aria-expanded={movementGuideExpanded}
                aria-controls="tdb-movement-guide-content"
              >
                {movementGuideExpanded ? 'Hide Guide' : 'Show Guide'}
              </button>
              <label className="tdb-graphics-control">
                <span>Graphics</span>
                <select
                  value={graphicsMode}
                  onChange={(event) => setGraphicsMode(event.target.value === 'high' ? 'high' : 'performance')}
                  aria-label="3D graphics quality"
                >
                  <option value="performance">Performance</option>
                  <option value="high">High Detail</option>
                </select>
              </label>
              <button
                type="button"
                className="btn btn-sm tdb-default-view-btn"
                onClick={handleDefaultView}
                title="Return to this building's saved front view"
              >
                Default View
              </button>
              {canSaveFrontView && (
                <button
                  type="button"
                  className="btn btn-sm tdb-save-front-btn"
                  onClick={handleSaveFrontView}
                  disabled={status !== 'ready' || isSavingFrontView || !getCameraModelDefinition()}
                  title="Save the current camera as this building's global front view"
                >
                  {isSavingFrontView ? 'Saving Front...' : 'Save Front View'}
                </button>
              )}
              {canSaveFrontView && navigatorBuildingRecord?.model_path && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm tdb-change-building-btn"
                  onClick={openBuildingModelPicker}
                  disabled={isUploadBusy}
                >
                  {isUploadBusy ? 'Uploading...' : 'Change Building'}
                </button>
              )}
              <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => applyView('top')}>Top View</button>
              <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => rotateModel(45)}>Rotate</button>
              {activeUploadTransform && (
                <div className={`tdb-move-chip${moveModeEnabled ? ' tdb-move-chip--active' : ''}`}>
                  <div className="tdb-move-chip-title">
                    {moveModeEnabled ? 'Move mode: drag building' : activeUploadTransform.name}
                  </div>
                  <div className="tdb-move-chip-coords">
                    X: {activeUploadTransform.x} | Y: {activeUploadTransform.y} | Z: {activeUploadTransform.z}
                  </div>
                  <div className="tdb-nudge-grid" aria-label="Fine move controls">
                    <span className="tdb-nudge-spacer" aria-hidden="true" />
                    <button
                      type="button"
                      className="tdb-nudge-btn"
                      onClick={() => nudgeMoveTarget(0, 0, -moveNudgeStep)}
                      title={`Move forward by ${moveNudgeStep}`}
                    >
                      ^
                    </button>
                    <span className="tdb-nudge-spacer" aria-hidden="true" />
                    <button
                      type="button"
                      className="tdb-nudge-btn"
                      onClick={() => nudgeMoveTarget(-moveNudgeStep, 0, 0)}
                      title={`Move left by ${moveNudgeStep}`}
                    >
                      &lt;
                    </button>
                    <div className="tdb-nudge-step">step {moveNudgeStep}</div>
                    <button
                      type="button"
                      className="tdb-nudge-btn"
                      onClick={() => nudgeMoveTarget(moveNudgeStep, 0, 0)}
                      title={`Move right by ${moveNudgeStep}`}
                    >
                      &gt;
                    </button>
                    <span className="tdb-nudge-spacer" aria-hidden="true" />
                    <button
                      type="button"
                      className="tdb-nudge-btn"
                      onClick={() => nudgeMoveTarget(0, 0, moveNudgeStep)}
                      title={`Move backward by ${moveNudgeStep}`}
                    >
                      v
                    </button>
                    <span className="tdb-nudge-spacer" aria-hidden="true" />
                  </div>
                  {!moveModeEnabled && (
                    <div className="tdb-move-chip-hint">Toggle move mode or use the arrows to adjust the location on the ground.</div>
                  )}
                </div>
              )}
            </div>

            {isSceneBusy && (
              <div className="tdb-loading-overlay" role="status" aria-live="polite">
                {status === 'loading' ? (
                  <div
                    className="tdb-loading-meter"
                    ref={modelLoadMeterRef}
                    role="progressbar"
                    aria-label="3D building loading progress"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    aria-valuenow="0"
                  >
                    <svg className="tdb-loading-meter-svg" viewBox="0 0 120 120" aria-hidden="true">
                      <circle className="tdb-loading-meter-track" cx="60" cy="60" r="49" />
                      <circle
                        className="tdb-loading-meter-fill"
                        cx="60"
                        cy="60"
                        r="49"
                        pathLength="100"
                        ref={modelLoadFillRef}
                        style={{ strokeDashoffset: 100 }}
                      />
                    </svg>
                    <div
                      className="tdb-loading-meter-value"
                      style={{ color: '#ffffff', WebkitTextFillColor: '#ffffff' }}
                    >
                      <strong ref={modelLoadValueRef}>0</strong>
                      <span>%</span>
                    </div>
                  </div>
                ) : (
                  <div className="tdb-loading-spinner" />
                )}
                <div className="tdb-loading-text">
                  {sceneBusyLabel}
                  <span className="tdb-loading-dots" aria-hidden="true">
                    <span>.</span><span>.</span><span>.</span>
                  </span>
                </div>
              </div>
            )}

            {pendingUpload && (
              <div className="tdb-upload-review">
                <div className="tdb-upload-review-copy">
                  <div className="tdb-upload-review-title">Review Upload</div>
                  <div className="tdb-upload-review-name">{pendingUpload.name}</div>
                </div>
                <div className="tdb-upload-review-actions">
                  <button
                    type="button"
                    className="btn btn-outline-light btn-sm"
                    onClick={cancelPendingUploadChanges}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-success btn-sm"
                    onClick={acceptPendingUploadChanges}
                  >
                    Accept
                  </button>
                </div>
              </div>
            )}

            {message && <div className="tdb-note tdb-note-error">{message}</div>}

            {teacherStatusModal && (
              <div className="tdb-teacher-status-backdrop" onClick={() => setTeacherStatusModal(null)}>
                <div className="tdb-teacher-status-card" onClick={(e) => e.stopPropagation()}>
                  <div className="tdb-teacher-status-header">
                    <div className="tdb-teacher-room-icon" aria-hidden="true">
                      ROOM
                    </div>
                    <div className="tdb-teacher-status-info">
                      <div className="tdb-teacher-status-room-label">Room attendance</div>
                      <div className="tdb-teacher-status-name">{teacherStatusModal.record?.room_name || 'Room'}</div>
                      <div className="tdb-teacher-status-room">Schedules and attendance checkpoints</div>
                    </div>
                    <button
                      type="button"
                      className="tdb-teacher-status-close"
                      onClick={() => setTeacherStatusModal(null)}
                      aria-label="Close teacher details"
                    >
                      &times;
                    </button>
                  </div>
                  <div className="tdb-teacher-schedule-block">
                    <div className="tdb-teacher-modal-columns">
                      <div className="tdb-teacher-modal-column">
                        <h4>Room schedules</h4>
                        <div className="tdb-modal-date-context" aria-label={`${modalSelectedDate.day}, ${modalSelectedDate.date}`}>
                          <span className="tdb-modal-date-day">{modalSelectedDate.day}</span>
                          <span className="tdb-modal-date-full">{modalSelectedDate.date}</span>
                        </div>
                        <div className="tdb-teacher-modal-filters">
                          <div className="tdb-field">
                            <label htmlFor="tdb-modal-filter-date">Date</label>
                            <input
                              id="tdb-modal-filter-date"
                              type="date"
                              className="form-control form-control-sm"
                              value={modalScheduleDate}
                              onChange={(event) => {
                                setModalScheduleDate(event.target.value || toLocalYmd());
                                setSelectedDepartment('');
                                setSearchTeacher('');
                              }}
                            />
                          </div>
                          {canSaveFrontView && (
                            <div className="tdb-field">
                              <label htmlFor="tdb-modal-filter-department">Department</label>
                              <select
                                id="tdb-modal-filter-department"
                                className="form-select form-select-sm"
                                value={selectedDepartment}
                                onChange={(event) => setSelectedDepartment(event.target.value)}
                              >
                                <option value="">All departments</option>
                                {modalDepartmentOptions.map((department) => <option key={department} value={department}>{department}</option>)}
                              </select>
                            </div>
                          )}
                          <div className="tdb-field">
                            <label htmlFor="tdb-modal-filter-teacher">Teacher</label>
                            <input
                              id="tdb-modal-filter-teacher"
                              type="search"
                              list="tdb-modal-teacher-options"
                              className="form-control form-control-sm"
                              placeholder="Filter attendance"
                              value={searchTeacher}
                              onChange={(event) => setSearchTeacher(event.target.value)}
                            />
                            <datalist id="tdb-modal-teacher-options">
                              {modalTeacherOptions.map((teacher) => <option key={teacher} value={teacher} />)}
                            </datalist>
                          </div>
                        </div>
                        <div className="tdb-teacher-schedule-list">
                          {modalRecordsLoading ? (
                            <div className="tdb-teacher-schedule-empty"><LoadingState label="Loading records for the selected date..." compact /></div>
                          ) : modalRecordsError ? (
                            <div className="tdb-teacher-schedule-empty">{modalRecordsError}</div>
                          ) : modalRoomSchedules.length > 0 ? modalRoomSchedules.map((schedule, index) => {
                            const parallelRows = getParallelSchedules(schedule, modalSourceRecords);
                            return (
                              <div className="tdb-teacher-schedule-item" key={`${schedule.schedule_id || index}-${schedule.room_name}`}>
                                <div>
                                  <strong>{formatClock(schedule.start_time)} - {formatClock(schedule.end_time)}</strong>
                                </div>
                                <div className="tdb-teacher-schedule-person">
                                  <img
                                    src={schedule.avatar || (nameEq(schedule.teacher_name, teacherStatusModal.record?.teacher_name) ? teacherStatusModal.avatarUrl : '') || defaultAvatarSrc}
                                    alt={schedule.teacher_name || 'Teacher'}
                                    onError={(event) => {
                                      if (event.currentTarget.src !== defaultAvatarSrc) event.currentTarget.src = defaultAvatarSrc;
                                    }}
                                  />
                                  <span>{schedule.teacher_name || 'Teacher'}</span>
                                  {parallelRows.length > 1 && <span className="tdb-mini-parallel">PARALLEL</span>}
                                </div>
                                <div className="tdb-schedule-course-details">
                                  <span>{`${schedule.subject_code || ''} ${schedule.subject_name || ''}`.trim() || 'Subject not specified'}</span>
                                  <span className="tdb-schedule-section">Section: {schedule.section_name || 'Not specified'}</span>
                                </div>
                                <div className="tdb-schedule-checkpoints">
                                  {[
                                    { key: 'in', label: 'Check-in', time: schedule.time_in },
                                    { key: 'mid', label: 'Mid-check', time: schedule.time_check },
                                    { key: 'out', label: 'Check-out', time: schedule.time_out }
                                  ].map((checkpoint) => {
                                    const checkpointStatus = computeCheckpointStatus(schedule, checkpoint.key);
                                    return (
                                      <div className="tdb-schedule-checkpoint" key={checkpoint.key}>
                                        <span>{checkpoint.label}</span>
                                        <strong className={`tdb-mini-status tdb-mini-status--${presenceBadgeClass(checkpointStatus)}`}>
                                          {checkpointStatus}
                                        </strong>
                                        {(checkpointStatus === 'PRESENT' || checkpointStatus === 'LATE') && checkpoint.time && (
                                          <small>{formatPresenceCheckpoint(checkpoint.time)}</small>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          }) : <div className="tdb-teacher-schedule-empty">No schedule records found for this room on the selected date.</div>}
                        </div>
                      </div>
                      <div className="tdb-teacher-modal-column">
                        <h4>Today/Recent attendance</h4>
                        <div className="tdb-modal-date-context" aria-label={`${modalTodayDate.day}, ${modalTodayDate.date}`}>
                          <span className="tdb-modal-date-day">{modalTodayDate.day}</span>
                          <span className="tdb-modal-date-full">{modalTodayDate.date}</span>
                        </div>
                        {!teacherStatusModal.record?.no_records ? (
                          <>
                            <div className="tdb-recent-teacher-profile">
                              <div className="tdb-teacher-status-avatar">
                                <img
                                  src={teacherStatusModal.avatarUrl || defaultAvatarSrc}
                                  alt={teacherStatusModal.record?.teacher_name || 'Teacher'}
                                  onError={(event) => {
                                    if (event.currentTarget.src !== defaultAvatarSrc) event.currentTarget.src = defaultAvatarSrc;
                                  }}
                                />
                              </div>
                              <div className="tdb-recent-teacher-info">
                                <strong>{teacherStatusModal.record?.teacher_name || 'Teacher'}</strong>
                                <span>{teacherStatusModal.record?.scheduled_time || 'Schedule not specified'}</span>
                              </div>
                            </div>
                            <div className="tdb-teacher-compact-summary">
                              <span>{teacherStatusModal.record?.subject || 'Subject not specified'}</span>
                              <span>{teacherStatusModal.record?.section_name || 'Section not specified'}</span>
                              {teacherStatusModal.record?.is_parallel && <strong>PARALLEL</strong>}
                              {teacherStatusModal.record?.is_substitute && <strong>SUBSTITUTE</strong>}
                              {teacherStatusModal.status === 'ON_LEAVE' && <strong>{teacherStatusModal.record?.leave_type || 'ON LEAVE'}</strong>}
                            </div>
                          </>
                        ) : (
                          <div className="tdb-teacher-empty-summary">
                            <strong>No attendance record</strong>
                            <span>This room has no teacher attendance data for today.</span>
                          </div>
                        )}
                        <div className="tdb-teacher-attendance-list">
                          {modalTodayIsLoading ? (
                            <div className="tdb-teacher-schedule-empty"><LoadingState label="Loading today's attendance..." compact /></div>
                          ) : modalTodayError ? (
                            <div className="tdb-teacher-schedule-empty">{modalTodayError}</div>
                          ) : modalRecentAttendance.length > 0 ? modalRecentAttendance.map((checkpoint) => (
                            <div className="tdb-teacher-attendance-item" key={checkpoint.key}>
                              <div>
                                <strong>{checkpoint.label}</strong>
                                <span>{checkpoint.teacherName || 'Teacher'}</span>
                                {(checkpoint.status === 'PRESENT' || checkpoint.status === 'LATE') && checkpoint.time && (
                                  <span>{formatPresenceCheckpoint(checkpoint.time)}</span>
                                )}
                              </div>
                              <span className={`tdb-mini-status tdb-mini-status--${presenceBadgeClass(checkpoint.status)}`}>
                                {checkpoint.status}
                              </span>
                            </div>
                          )) : <div className="tdb-teacher-schedule-empty">No attendance records found for this room today.</div>}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {selectedRoom && (
              <div className="tdb-room-info-modal" onClick={() => setSelectedRoom(null)}>
                <div className="tdb-room-info-card" onClick={(e) => e.stopPropagation()}>
                  <div className="tdb-room-info-header">
                    <div className="tdb-room-info-title">{selectedRoom.roomName}</div>
                    <div className="tdb-room-info-meta">
                      {catalog.buildings?.find(b => String(b.building_id) === String(selectedRoom.buildingId))?.building_name || '-'}
                      {' • '}
                      {catalog.floors?.find(f => String(f.floor_id) === String(selectedRoom.floorId))?.floor_name || '-'}
                    </div>
                  </div>

                  <div className="tdb-room-info-occupants">
                    <div className="tdb-room-info-occupants-title">Currently in this room</div>
                    {searchedRecords.filter(rec =>
                      rec.room_name === selectedRoom.roomName && (rec.time_in || rec.time_check || rec.time_out)
                    ).length > 0 ? (
                      searchedRecords
                        .filter(rec =>
                          rec.room_name === selectedRoom.roomName && (rec.time_in || rec.time_check || rec.time_out)
                        )
                        .map((rec, idx) => (
                          <div key={`${rec.user_id}-${idx}`} className="tdb-room-occupant">
                            <div className="tdb-room-occupant-avatar">
                              <img
                                src={rec.avatar || defaultAvatarSrc}
                                alt={rec.teacher_name || 'Teacher'}
                                onError={(e) => {
                                  if (e.currentTarget.src !== defaultAvatarSrc) {
                                    e.currentTarget.src = defaultAvatarSrc;
                                  }
                                }}
                              />
                            </div>
                            <div className="tdb-room-occupant-info">
                              <div className="tdb-room-occupant-name">{rec.teacher_name || 'Teacher'}</div>
                              <div className="tdb-room-occupant-status">
                                {computeAttendanceStatus(rec)}
                              </div>
                            </div>
                          </div>
                        ))
                    ) : (
                      <div className="tdb-room-info-empty">No one checked in</div>
                    )}
                  </div>

                  <div className="tdb-room-info-actions">
                    <button
                      type="button"
                      className="btn btn-outline-light btn-sm"
                      onClick={() => setSelectedRoom(null)}
                    >
                      Close
                    </button>
                    <button
                      type="button"
                      className="btn btn-success btn-sm"
                      onClick={() => {
                        focusRoomCamera(selectedRoom.roomName);
                        setSelectedRoom(null);
                      }}
                    >
                      Focus Camera
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <aside className="tdb-logs-panel" ref={logsPanelRef}>
          <div className="tdb-time-chip">{dateTimeStamp}</div>
          <div className="tdb-log-status-filters" aria-label="Recent log status filters">
            <button
              type="button"
              className={`tdb-log-recent-filter${recentLogStatusFilter === 'recent' ? ' tdb-log-recent-filter--active' : ''}`}
              onClick={() => setRecentLogStatusFilter('recent')}
            >
              Recent
            </button>
            <select
              className="form-select form-select-sm tdb-log-other-filter"
              aria-label="Filter recent logs by checkpoint or overall status"
              value={recentLogStatusFilter === 'recent' ? '' : recentLogStatusFilter}
              onChange={(event) => setRecentLogStatusFilter(event.target.value || 'recent')}
            >
              <option value="">Choose status filter</option>
              <optgroup label="Checkpoint status">
                <option value="PRESENT">Present</option>
                <option value="LATE">Late</option>
                <option value="ABSENT">Absent</option>
              </optgroup>
              <optgroup label="Overall status">
                <option value="OVERALL">All overall results</option>
                <option value="OVERALL_PRESENT">Overall: Present</option>
                <option value="OVERALL_LATE">Overall: Late</option>
                <option value="OVERALL_ABSENT">Overall: Absent</option>
                <option value="OVERALL_INCOMPLETE">Overall: Partial Attendance</option>
              </optgroup>
              <optgroup label="Other checkpoint status">
                <option value="other">All other statuses</option>
                <option value="UPCOMING">Upcoming</option>
                <option value="PENDING">Pending</option>
                <option value="SUBSTITUTED">Substituted</option>
                <option value="ON_LEAVE">On leave</option>
              </optgroup>
            </select>
          </div>
          <div className="tdb-logs-title">Recent Logs</div>

          <div className="tdb-logs-list">
            {recentLogsLoading && pagedLogs.length === 0 ? (
              <div className="tdb-no-logs">Loading recent logs...</div>
            ) : recentLogsError && pagedLogs.length === 0 ? (
              <div className="tdb-no-logs">{recentLogsError}</div>
            ) : pagedLogs.length === 0 ? (
              <div className="tdb-no-logs">No logs found for current filters.</div>
            ) : (
              pagedLogs.map((log) => {
                const statusClass = `tdb-status-${String(log.status || 'PENDING').toLowerCase().replace(/_/g, '-')}`;
                return (
                  <button
                    key={log.id}
                    type="button"
                    className={`tdb-log-item tdb-log-item--clickable${log.highlightGroupKey && hoveredLogGroup === log.highlightGroupKey ? ' tdb-log-item--group-highlight' : ''}`}
                    onClick={() => handleRecentLogClick(log)}
                    onMouseEnter={() => {
                      if (log.highlightGroupKey) setHoveredLogGroup(log.highlightGroupKey);
                    }}
                    onMouseLeave={() => setHoveredLogGroup('')}
                    onFocus={() => {
                      if (log.highlightGroupKey) setHoveredLogGroup(log.highlightGroupKey);
                    }}
                    onBlur={() => setHoveredLogGroup('')}
                    aria-label={`View room ${log.roomName}`}
                    title={`View ${log.roomName}`}
                  >
                    <div className="tdb-log-avatar">
                      <img
                        src={log.avatar || defaultAvatarSrc}
                        alt={log.teacherName || 'User'}
                        onError={(e) => {
                          if (e.currentTarget.src !== defaultAvatarSrc) e.currentTarget.src = defaultAvatarSrc;
                        }}
                      />
                    </div>
                    <div className="tdb-log-body">
                      <div className="tdb-log-name">{log.teacherName} ({log.roomName})</div>
                      <div
                        className="tdb-log-context"
                        title={`Subject: ${log.subjectLabel} • Section: ${log.sectionName}`}
                      >
                        <span>Subject: {log.subjectLabel}</span>
                        <i aria-hidden="true">•</i>
                        <span>Section: {log.sectionName}</span>
                      </div>
                      <div className="tdb-log-meta">
                        <span className="tdb-pill tdb-pill-type">{log.type}:</span>
                        <span className={`tdb-pill ${statusClass}`}>{log.status}</span>
                        {log.isParallel && <span className="tdb-log-parallel">PARALLEL</span>}
                        {log.timeLabel && (
                          <span className={`tdb-log-time${log.timeKind === 'range' ? ' tdb-log-time--range' : ''}`}>
                            {log.timeLabel}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          <div className="tdb-pagination">
            <button
              type="button"
              className="btn btn-success btn-sm tdb-page-btn"
              disabled={logsPage <= 1}
              onClick={() => setLogsPage((p) => Math.max(1, p - 1))}
            >
              {'<'}
            </button>
            {visibleLogPages.map((pageNo) => (
              <button
                key={pageNo}
                type="button"
                className={`btn btn-sm tdb-page-btn ${logsPage === pageNo ? 'btn-light' : 'btn-outline-light'}`}
                onClick={() => setLogsPage(pageNo)}
              >
                {pageNo}
              </button>
            ))}
            <button
              type="button"
              className="btn btn-success btn-sm tdb-page-btn"
              disabled={logsPage >= totalLogPages}
              onClick={() => setLogsPage((p) => Math.min(totalLogPages, p + 1))}
            >
              {'>'}
            </button>
          </div>
        </aside>
      </div>

    </div>
  );
}

export default ThreeDBuildingIndex;
