import React, { useState, useEffect, useContext, useRef } from 'react';
import { AuthContext } from "../context/AuthContext.jsx";
import { canAccessModule, resolveRoleName as resolveRoleNameUtil } from "../utils/moduleAccess.js";
import { apiUrl, getCsrfToken } from '../services/api.js';
import {
  disablePushNotifications,
  getPushNotificationStatus,
  showPushStatusSweetAlert,
  syncPushSubscription,
} from '../services/pushNotifications.js';
import Modal from './Modal.jsx';
import LoadingState from './LoadingState.jsx';

const NAVBAR_NOTIFICATION_LIMIT = 20;
const NAVBAR_NOTIFICATION_POLL_MS = 15000;

// Fallback avatar path that works on localhost subfolder deployments (e.g. /3D1.2)
const unknownImg = (() => {
  try {
    if (typeof window === 'undefined') return '/src/assets/unknown.jpg';
    const parts = window.location.pathname.split('/').filter(Boolean);
    let projectRoot = '';
    if (parts.length) {
      const first = String(parts[0]).toLowerCase();
      if (first !== 'public') projectRoot = '/' + parts[0];
    }
    return projectRoot + '/src/assets/unknown.jpg';
  } catch (e) {
    return '/src/assets/unknown.jpg';
  }
})();

export default function Navbar() {
  const { user, logout, login } = useContext(AuthContext);
  
  // State
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [currentHash, setCurrentHash] = useState(window.location.hash.slice(1) || '/home');
  const [menuOpen, setMenuOpen] = useState(false);
  const [openSubmenus, setOpenSubmenus] = useState({}); // Tracks expanded menus
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsError, setNotificationsError] = useState('');
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifLoaded, setNotifLoaded] = useState(false);
  const [notificationActioning, setNotificationActioning] = useState(false);
  const [notificationFilter, setNotificationFilter] = useState('all');
  const [navPushStatus, setNavPushStatus] = useState({ supported: true, enabled: false, permission: 'default' });
  const [navPushActioning, setNavPushActioning] = useState(false);
  const [navPushMessage, setNavPushMessage] = useState('');
  const [navigationSearch, setNavigationSearch] = useState('');
  const [navigationSearchOpen, setNavigationSearchOpen] = useState(false);
  const [navigationSearchIndex, setNavigationSearchIndex] = useState(0);

  // Profile State
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileData, setProfileData] = useState(user || null);
  const [uploading, setUploading] = useState(false);
  const [profileForm, setProfileForm] = useState({ first_name: '', last_name: '', email: '', contact_no: '' });
  const [profileAvatarFile, setProfileAvatarFile] = useState(null);
  const [profileAvatarPreview, setProfileAvatarPreview] = useState('');
  const [profileAvatarError, setProfileAvatarError] = useState('');
  const [profileDetailsOpen, setProfileDetailsOpen] = useState(false);
  const profileAvatarInputRef = useRef(null);
  const [notificationAgeTick, setNotificationAgeTick] = useState(Date.now());

  // Avoid repeated profile fetches for the same user
  const fetchedProfileFor = React.useRef(null);
  const notificationPanelRef = useRef(null);
  const desktopNavigationSearchRef = useRef(null);
  const mobileNavigationSearchRef = useRef(null);

  const unreadNotifications = notifLoaded
    ? unreadCount
    : ((profileData && (profileData.unread_notifications || profileData.notifications_count || 0)) || 0);
  const profileUserId = user && (user.user_id || user.id || user.userId) ? (user.user_id || user.id || user.userId) : null;
  const notificationUserId = profileUserId;
  const canEditProfileContact = Boolean(profileUserId);
  const canEditProfileAvatar = Boolean(profileUserId);
  const isOnNotificationRoute = String(currentHash || '').toLowerCase().includes('notification');
  const shouldAnimateNotificationBell = unreadNotifications > 0 && !notificationOpen && !isOnNotificationRoute;
  const filteredNotifications = notificationFilter === 'unread'
    ? notifications.filter((n) => Number(n?.is_read || 0) === 0)
    : notifications;

  // --- 1. DATA & SYNC LOGIC (Kept Exact) ---

  useEffect(() => { setProfileData(user || null); }, [user]);

  useEffect(() => {
    setProfileForm({
      first_name: (profileData && profileData.first_name) || '',
      last_name: (profileData && profileData.last_name) || '',
      email: (profileData && profileData.email) || '',
      contact_no: (profileData && profileData.contact_no) || '',
    });
  }, [profileData]);

  const buildIndexApiUrl = (p) => apiUrl(p);

  const getAuthHeaders = () => {
    const csrfToken = getCsrfToken();
    return csrfToken ? { 'X-CSRF-Token': csrfToken } : {};
  };

  const resetProfileEditor = () => {
    setProfileForm({
      first_name: (profileData && profileData.first_name) || '',
      last_name: (profileData && profileData.last_name) || '',
      email: (profileData && profileData.email) || '',
      contact_no: (profileData && profileData.contact_no) || '',
    });
    setProfileAvatarFile(null);
    setProfileAvatarPreview('');
    setProfileAvatarError('');
    if (profileAvatarInputRef.current) profileAvatarInputRef.current.value = '';
  };

  const applyProfileUpdate = (nextUser) => {
    if (!nextUser) return;
    const merged = { ...(user || {}), ...(profileData || {}), ...nextUser };
    setProfileData(merged);
    try { if (login) login(merged); } catch (e) {}
  };

  const normalizeNotificationLink = (rawLink) => {
    let link = String(rawLink || '').trim();
    if (!link) return '';
    if (link.startsWith('#')) link = link.slice(1);
    if (!link.startsWith('/')) link = '/' + link;
    return link;
  };

  const formatNotificationTime = (createdAt) => {
    if (!createdAt) return '';
    const dt = new Date(createdAt);
    if (Number.isNaN(dt.getTime())) return String(createdAt);
    return dt.toLocaleString();
  };

  // Timer refreshes every 1 minute (no socket), based on local clock.
  const formatNotificationAge = (createdAt) => {
    if (!createdAt) return '';
    const dt = new Date(createdAt);
    if (Number.isNaN(dt.getTime())) return '';
    const baseMs = Number(notificationAgeTick || Date.now());
    let seconds = Math.floor((baseMs - dt.getTime()) / 1000);
    if (!Number.isFinite(seconds) || seconds <= 0) seconds = 1;
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}m`;
    const years = Math.floor(days / 365);
    return `${years}y`;
  };

  const cleanNotificationText = (txt) => {
    return String(txt || '').replace(/\s?#\d+\b/g, '').trim();
  };

  const inferActorNameFromMessage = (message) => {
    const msg = cleanNotificationText(message || '');
    if (!msg) return '';
    const m = msg.match(/^([A-Za-z][A-Za-z .'-]{1,80}?)\s+(requested|requests|approved|rejected|created|submitted|filed|assigned|updated|cancelled|canceled)\b/i);
    return m ? cleanNotificationText(m[1]) : '';
  };

  const getNotificationActorName = (notif) => {
    const fromActor = cleanNotificationText(notif?.actor_name || '');
    if (fromActor) return fromActor;
    const fromMessage = inferActorNameFromMessage(notif?.message || '');
    if (fromMessage) return fromMessage;
    const fromTitle = cleanNotificationText(notif?.title || '');
    return fromTitle || 'Notification';
  };

  const fetchNotifications = React.useCallback(async (silent = true) => {
    try {
      if (!notificationUserId) {
        setNotifications([]);
        setUnreadCount(0);
        setNotifLoaded(true);
        return;
      }
      if (!silent) setNotificationsLoading(true);

      const res = await fetch(buildIndexApiUrl(`notification?limit=${NAVBAR_NOTIFICATION_LIMIT}`), {
        credentials: 'include',
        headers: getAuthHeaders(),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`Failed to load notifications (${res.status})`);
      const payload = await res.json();
      const list = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.notifications) ? payload.notifications : []);
      setNotifications(list);
      const unread = Number(payload?.unread_count);
      setUnreadCount(Number.isFinite(unread) ? unread : list.filter((n) => Number(n?.is_read || 0) === 0).length);
      setNotificationsError('');
      setNotifLoaded(true);
    } catch (e) {
      if (!silent) setNotificationsError('Failed to load notifications');
      console.warn('[Navbar] notifications fetch error', e);
    } finally {
      if (!silent) setNotificationsLoading(false);
    }
  }, [notificationUserId]);

  // Fetch full profile once when user becomes available. Guard so we don't refetch repeatedly
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!user) return;
        const uid = user.user_id || user.id || user.userId || null;
        if (!uid) return;
        // If we've already fetched for this user, skip
        if (fetchedProfileFor.current === uid) return;

        // If local stored user already has role and avatar, avoid fetching
        let stored = null;
        try { stored = JSON.parse(localStorage.getItem('user') || 'null'); } catch(e) { stored = null; }
        if (stored && stored.user_id == uid && stored.role_id && stored.avatar) {
          fetchedProfileFor.current = uid;
          return;
        }

        const url = buildIndexApiUrl(`user-profile?user_id=${uid}`);
        const res = await fetch(url, { credentials: 'include', headers: getAuthHeaders() });
        if (!alive) return;
        if (!res.ok) { console.warn('[Navbar] profile fetch failed', res.status); return; }
        const j = await res.json();
        if (j && j.user) {
          setProfileData(j.user);
          // Only update AuthContext if profile differs to avoid triggering context-loop
          const storedRaw = localStorage.getItem('user');
          let storedObj = null; try { storedObj = storedRaw ? JSON.parse(storedRaw) : null; } catch(e){ storedObj = null; }
          const needsLoginUpdate = !storedObj || Number(storedObj.role_id || -1) !== Number(j.user.role_id || -1) || storedObj.avatar !== j.user.avatar;
          if (needsLoginUpdate && typeof login === 'function') {
            login(j.user);
          }
        }
        fetchedProfileFor.current = uid;
      } catch (e) { console.error('[Navbar] profile fetch error', e); }
    })();
    return () => { alive = false; };
  }, [user, login]);

  useEffect(() => {
    const onHash = () => setCurrentHash(window.location.hash.slice(1) || '/home');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const onDocumentPointerDown = (event) => {
      const inDesktopSearch = desktopNavigationSearchRef.current?.contains(event.target);
      const inMobileSearch = mobileNavigationSearchRef.current?.contains(event.target);
      if (!inDesktopSearch && !inMobileSearch) setNavigationSearchOpen(false);
    };
    document.addEventListener('mousedown', onDocumentPointerDown);
    return () => document.removeEventListener('mousedown', onDocumentPointerDown);
  }, []);

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setNotificationAgeTick(Date.now());
    }, 300000);
    return () => window.clearInterval(timerId);
  }, []);

  useEffect(() => {
    if (!notificationUserId) {
      setNotifications([]);
      setUnreadCount(0);
      setNotifLoaded(false);
      return;
    }

    // The full Notifications page owns live refresh while it is open. Avoid
    // polling the same endpoint a second time from the Navbar.
    if (isOnNotificationRoute) {
      setNotifLoaded(true);
      return;
    }

    fetchNotifications(true);
    const poller = window.setInterval(() => {
      fetchNotifications(true);
    }, NAVBAR_NOTIFICATION_POLL_MS);
    return () => window.clearInterval(poller);
  }, [notificationUserId, fetchNotifications, isOnNotificationRoute]);

  useEffect(() => {
    const onDocMouseDown = (event) => {
      if (!notificationPanelRef.current) return;
      if (!notificationPanelRef.current.contains(event.target)) {
        setNotificationOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, []);

  const ensureSwalLoaded = async () => {
    if (typeof window === 'undefined' || window.Swal) return;
    if (!document.querySelector('link[data-swal]')) {
      const l = document.createElement('link'); l.rel='stylesheet'; l.href='https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/sweetalert2.min.css'; l.setAttribute('data-swal','1'); document.head.appendChild(l);
    }
    if (document.querySelector('script[data-swal]')) {
      const existing = document.querySelector('script[data-swal]');
      await new Promise((resolve,reject)=>{ existing.addEventListener('load',()=>resolve()); existing.addEventListener('error',()=>reject()); });
      if (window.Swal) return;
    }
    await new Promise((resolve,reject)=>{ const s=document.createElement('script'); s.src='https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/sweetalert2.all.min.js'; s.async=true; s.setAttribute('data-swal','1'); s.onload=()=>resolve(); s.onerror=()=>reject(); document.head.appendChild(s); });
  };

  const handleLogout = () => {
    setMenuOpen(false);
    const forceLocalLogout = () => {
      localStorage.removeItem('user');
      localStorage.removeItem('last_activity_at');
      localStorage.removeItem('session_meta');
      window.location.hash = '#/login';
    };
    try {
      if (typeof logout === 'function') {
        const logoutResult = logout();
        Promise.resolve(logoutResult).catch(forceLocalLogout);
      } else {
        forceLocalLogout();
      }
    } catch (e) {
      forceLocalLogout();
    }

    // Confirmation is shown only after logout has started and never delays it.
    try {
      if (window.Swal && typeof window.Swal.fire === 'function') {
        Promise.resolve(window.Swal.fire({
          toast: true,
          position: 'top',
          icon: 'success',
          title: 'Logged out',
          showConfirmButton: false,
          timer: 1200
        })).catch(() => {});
      }
    } catch (e) {}
  };

  const refreshNavPushStatus = React.useCallback(async () => {
    try {
      const next = await getPushNotificationStatus();
      setNavPushStatus(next);
      if (next?.verificationFailed) {
        setNavPushMessage('Server verification failed. Select Enable to retry.');
      } else if (next?.needsSync) {
        setNavPushMessage('Alerts need attention. Select Enable to reconnect.');
      } else if (next?.enabled) {
        setNavPushMessage('Background alerts are on.');
      } else if (next?.permission === 'denied') {
        setNavPushMessage('Alerts are blocked in browser settings.');
      } else {
        setNavPushMessage('Background alerts are off.');
      }
      return next;
    } catch (error) {
      const fallback = { supported: false, enabled: false, permission: 'unsupported' };
      setNavPushStatus(fallback);
      return fallback;
    }
  }, []);

  const toggleNavBackgroundAlerts = async () => {
    if (navPushActioning || !navPushStatus.supported) return;
    setNavPushActioning(true);
    setNavPushMessage('');
    try {
      let next;
      if (navPushStatus.enabled) {
        next = await disablePushNotifications({ unsubscribe: true });
        setNavPushMessage('Background alerts are off.');
        await showPushStatusSweetAlert('disabled', { once: false });
      } else {
        await syncPushSubscription({ requestPermission: true });
        next = await getPushNotificationStatus();
        if (!next?.enabled) throw new Error('The server could not verify this device. Please retry.');
        setNavPushMessage(next?.enabled
          ? 'Background alerts are on.'
          : 'Permission is allowed, but the background subscription is not active.');
        await showPushStatusSweetAlert('restored', { once: false });
      }
      setNavPushStatus(next);
      try { window.dispatchEvent(new CustomEvent('push-notification-status-changed', { detail: next })); } catch (e) {}
    } catch (error) {
      const verified = await getPushNotificationStatus().catch(() => null);
      if (verified?.enabled) {
        setNavPushStatus(verified);
        setNavPushMessage('Background alerts are on.');
      } else {
        const denied = typeof Notification !== 'undefined' && Notification.permission === 'denied';
        setNavPushStatus(previous => ({
          ...previous,
          ...(verified || {}),
          enabled: false,
          permission: denied ? 'denied' : (verified?.permission || previous.permission),
        }));
        setNavPushMessage(denied
          ? 'Alerts are blocked in browser settings.'
          : `Alerts need attention: ${error?.body?.message || error?.message || 'Background alerts could not be updated.'}`);
        await showPushStatusSweetAlert(
          denied ? 'blocked' : (navigator.onLine === false ? 'offline' : 'verification-failed'),
          { message: error?.body?.message || error?.message || '', once: false }
        );
      }
    } finally {
      setNavPushActioning(false);
    }
  };

  useEffect(() => {
    if (!notificationOpen) return;
    refreshNavPushStatus();
  }, [notificationOpen, refreshNavPushStatus]);

  useEffect(() => {
    const syncPushStatus = (event) => {
      if (!event?.detail) return;
      setNavPushStatus(event.detail);
      if (event.detail.syncError) setNavPushMessage(`Alerts need attention: ${event.detail.syncError}`);
      else if (event.detail.enabled) setNavPushMessage('Background alerts are on.');
      else if (event.detail.needsSync) setNavPushMessage('Alerts need attention. Select Enable to reconnect.');
      else if (event.detail.permission === 'denied') setNavPushMessage('Alerts are blocked in browser settings.');
      else setNavPushMessage('Background alerts are off.');
    };
    window.addEventListener('push-notification-status-changed', syncPushStatus);
    return () => window.removeEventListener('push-notification-status-changed', syncPushStatus);
  }, []);

  // --- 2. NAVIGATION CONFIGURATION ---

  const navItems = [
    { label: "Home", path: "/home", permission: null },
    { label: "Dashboard", path: "/dashboard", permission: 'dashboard' },
    { label: "Notification", path: "/notifications", permission: null },
    { label: "Users", path: "/users", permission: 'users' },

    // --- MODIFIED: Faculty Portal (Formerly Attendance Logs) ---
    // Permission 'attendance' allows: Dean, Program Head, Secretary, Teacher. (No Admin)
    { label: "Faculty Portal", path: "/faculty-portal", permission: 'attendance', children: [
      { label: "My Dashboard", path: "/faculty-dashboard", permission: 'faculty_dashboard' },
      { label: "Attendance History", path: "/attendance-history", permission: 'attendance' },
      { label: "Attendance", path: "/attendance", permission: 'attendance' },
      { label: "Teaching Schedule", path: "/my-attendance", permission: 'attendance' },
      { label: "Request Edit", path: "/my-requested-edits", permission: 'attendance' },
    ]},
    // ------------------------------------------------------------

    { label: "Attendance Records", path: "/attendancemgmt", permission: 'attendancemgmt' },
    { label: "Attendance Edit Request", path: "/attendance-edit-requests", permission: 'attendance_edits' },
    { label: "Attendance Adjustment Logs", path: "/attendance-logs", permission: 'attendance_logs' },
    { label: "Class Schedules", path: "/class-schedules", permission: 'class_schedules' },
    { label: "Holidays & Events", path: "/calendar-events", permission: 'calendar_events' },
    { label: "3D Campus Map", path: "/3d-building", permission: '3d_building' },

    // Grouped: Academic Management
    { label: 'Academic', path: '/academic', permission: null, children: [
      { label: 'Departments', path: '/departments', permission: 'academic_admin' },
      { label: 'Programs', path: '/programs', permission: 'academic_program' },
      { label: 'Sections', path: '/sections', permission: 'academic_manage' },
      { label: 'School Year', path: '/school_year', permission: 'academic_admin' },
      { label: 'Subjects', path: '/subjects', permission: 'academic_manage' },
    ]},

    // Grouped: Facility Management
    { label: 'Facility', path: '/facility', permission: null, children: [
      { label: 'Buildings', path: '/building', permission: 'locations' },
      { label: 'Floors', path: '/floors', permission: 'floor_qr' },
      { label: 'Rooms', path: '/rooms', permission: 'locations' }
    ]},

    { label: 'File Leave', path: '/File_leave', permission: 'leaves_file' },
    { label: "Substitutions", path: "/substitutions", permission: 'substitutions' },
    { label: "Penalties", path: "/penalties", permission: 'penalties' },
    { label: "Reports", path: "/reports", permission: 'reports' },
    { label: "Audit Trail", path: "/system-logs", permission: 'logs' },
    { label: 'General Settings', path: '/settings/system', permission: 'settings' },

  ];

  // RBAC Logic
  const resolveRoleName = (obj) => resolveRoleNameUtil(obj);

  const currentAccessUser = React.useMemo(() => {
    try {
      const fromUser = user && resolveRoleName(user) ? user : null;
      if (fromUser) return fromUser;
      const stored = localStorage.getItem('user');
      if (!stored) return null;
      const parsed = JSON.parse(stored || '{}');
      return resolveRoleName(parsed) ? parsed : null;
    } catch (e) {
      return null;
    }
  }, [user]);

  const currentRole = resolveRoleName(currentAccessUser);
  const navRoleLabel = String(
    (profileData && profileData.role_name)
      || (user && user.role_name)
      || currentRole
      || 'Panel'
  )
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

  // Debugging: log role resolution after access snapshot is resolved.
  try {
    console.log('Navbar RBAC debug:', {
      userSnapshot: currentAccessUser || user,
      storedUser: localStorage.getItem('user'),
      resolvedRole: currentRole
    });
    try { window.__NAVBAR_ROLE = { resolvedRole: currentRole, userSnapshot: currentAccessUser || user, storedUser: localStorage.getItem('user') }; } catch(e) {}
  } catch (e) { /* ignore */ }

  // If role couldn't be resolved but we have a user ID, fetch full profile to obtain role info
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!currentRole && user) {
          const uid = user.user_id || user.id || user.userId || null;
          if (!uid) return;
          const url = buildIndexApiUrl(`user-profile?user_id=${uid}`);
          console.log('[Navbar] fetching profile for user_id=', uid, 'url=', url);
          const res = await fetch(url, { credentials: 'include', headers: getAuthHeaders() });
          if (!alive) return;
          if (!res.ok) { console.warn('[Navbar] profile fetch failed status=', res.status); return; }
          const j = await res.json();
          console.log('[Navbar] profile fetch response:', j);
          if (j && j.user) {
            // update AuthContext so role fields propagate
            try { if (login) { login(j.user); try { window.__NAVBAR_ROLE = { resolvedRole: resolveRoleName(j.user), userSnapshot: j.user, storedUser: localStorage.getItem('user') }; } catch(e) {} } } catch (e) { /* ignore */ }
          }
        }
      } catch (e) { console.error('[Navbar] profile fetch error', e); }
    })();
    return () => { alive = false; };
  }, [user, currentRole, login]);

  const canAccess = (perm) => {
    if (!perm) return true;
    if (!currentAccessUser) return false;
    return canAccessModule(currentAccessUser, perm);
  };

  // Compute visible items strictly based on RBAC (no permissive fallback)
  const visibleNavItems = navItems.map(item => {
    if (!item.children) return item;
    const children = item.children.filter(c => canAccess(c.permission));
    return { ...item, children };
  }).filter(item => {
    if (currentRole === 'teacher' && item.path === '/dashboard') return false;
    if (currentRole === 'admin' && ['/file_leave', '/substitutions'].includes(String(item.path || '').toLowerCase())) return false;
    if (!item.permission && item.children) return item.children.length > 0;
    return canAccess(item.permission);
  });

  const searchableNavItems = visibleNavItems.flatMap((item) => {
    if (item.children?.length) {
      return item.children.map((child) => ({
        ...child,
        group: item.label,
        searchText: `${child.label} ${item.label} ${child.path}`.toLowerCase(),
      }));
    }
    return [{
      ...item,
      group: '',
      searchText: `${item.label} ${item.path}`.toLowerCase(),
    }];
  });
  const normalizedNavigationSearch = navigationSearch.trim().toLowerCase();
  const navigationSearchTerms = normalizedNavigationSearch.split(/\s+/).filter(Boolean);
  const navigationSearchResults = normalizedNavigationSearch
    ? searchableNavItems
      .filter((item) => navigationSearchTerms.every((term) => item.searchText.includes(term)))
      .slice(0, 8)
    : [];

  // --- 3. HELPER FUNCTIONS ---

  const toggleSidebar = () => setSidebarOpen(s => !s);
  const navTo = (path) => { window.location.hash = '#' + path; setSidebarOpen(false); };

  const navigateFromSearch = (item) => {
    if (!item?.path) return;
    setNavigationSearch('');
    setNavigationSearchOpen(false);
    setNavigationSearchIndex(0);
    setMenuOpen(false);
    setNotificationOpen(false);
    navTo(item.path);
  };

  const handleNavigationSearchKeyDown = (event) => {
    if (event.key === 'Escape') {
      setNavigationSearchOpen(false);
      return;
    }
    if (!navigationSearchResults.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setNavigationSearchIndex((index) => (index + 1) % navigationSearchResults.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setNavigationSearchIndex((index) => (index - 1 + navigationSearchResults.length) % navigationSearchResults.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      navigateFromSearch(navigationSearchResults[Math.min(navigationSearchIndex, navigationSearchResults.length - 1)]);
    }
  };
  
  const toggleSubmenu = (path) => {
    setOpenSubmenus(prev => ({ ...prev, [path]: !prev[path] }));
  };

  const resolveNavIconKey = (path) => {
    const p = String(path || '').toLowerCase();
    if (p.startsWith('/home')) return 'home';
    if (p.startsWith('/dashboard')) return 'dashboard';
    if (p.startsWith('/faculty-dashboard')) return 'dashboard';
    if (p.startsWith('/users')) return 'users';
    if (p.startsWith('/faculty-portal')) return 'faculty';
    if (p.startsWith('/attendance-edit-requests') || p.startsWith('/my-requested-edits')) return 'edit_request';
    if (p.startsWith('/attendance-history')) return 'history';
    if (p.startsWith('/attendance-logs') || p.startsWith('/system-logs') || p.startsWith('/logs')) return 'logs';
    if (p.startsWith('/attendance') || p.startsWith('/attendancemgmt') || p.startsWith('/my-attendance')) return 'attendance';
    if (p.startsWith('/class-schedules')) return 'schedule';
    if (p.startsWith('/calendar-events')) return 'schedule';
    if (p.startsWith('/3d-building')) return 'map3d';
    if (p.startsWith('/academic') || p.startsWith('/programs') || p.startsWith('/departments') || p.startsWith('/sections') || p.startsWith('/school_year') || p.startsWith('/semesters') || p.startsWith('/subjects') || p.startsWith('/subject-offerings')) return 'academic';
    if (p.startsWith('/facility') || p.startsWith('/building') || p.startsWith('/floors') || p.startsWith('/rooms')) return 'facility';
    if (p.startsWith('/file_leave') || p.startsWith('/leave_approval')) return 'leave';
    if (p.startsWith('/substitute') || p.startsWith('/substitutions')) return 'substitute';
    if (p.startsWith('/reports')) return 'reports';
    if (p.startsWith('/notifications')) return 'notification';
    if (p.startsWith('/settings') || p === '/school') return 'settings';
    if (p.startsWith('/penalties')) return 'warning';
    return 'default';
  };

  const NavIcon = ({ path, className = 'w-4 h-4' }) => {
    const iconKey = resolveNavIconKey(path);
    return (
      <svg
        className={`${className} flex-shrink-0`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {iconKey === 'home' && (
          <>
            <path d="M3 11 12 3l9 8" />
            <path d="M5 10v10h14V10" />
            <path d="M10 20v-6h4v6" />
          </>
        )}
        {iconKey === 'dashboard' && (
          <>
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="4" rx="1" />
            <rect x="14" y="10" width="7" height="11" rx="1" />
            <rect x="3" y="13" width="7" height="8" rx="1" />
          </>
        )}
        {iconKey === 'users' && (
          <>
            <circle cx="8.5" cy="7" r="3" />
            <path d="M2 20a6.5 6.5 0 0 1 13 0" />
            <path d="M20 8v6" />
            <path d="M23 11h-6" />
          </>
        )}
        {iconKey === 'faculty' && (
          <>
            <rect x="3" y="4" width="18" height="12" rx="2" />
            <path d="M7 20h10" />
            <path d="M12 16v4" />
          </>
        )}
        {iconKey === 'attendance' && (
          <>
            <rect x="6" y="4" width="12" height="16" rx="2" />
            <path d="M9 4.5h6" />
            <path d="m9 12 2 2 4-4" />
            <path d="M9 17h6" />
          </>
        )}
        {iconKey === 'history' && (
          <>
            <path d="M3 3v5h5" />
            <path d="M3.5 8A9 9 0 1 0 6 4.5" />
            <path d="M12 7v5l3 2" />
          </>
        )}
        {iconKey === 'edit_request' && (
          <>
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4 11.5-11.5z" />
          </>
        )}
        {iconKey === 'schedule' && (
          <>
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M16 3v4" />
            <path d="M8 3v4" />
            <path d="M3 10h18" />
          </>
        )}
        {iconKey === 'map3d' && (
          <>
            <path d="m12 2 8 4.5v11L12 22 4 17.5v-11L12 2z" />
            <path d="M12 22V11" />
            <path d="m4 6.5 8 4.5 8-4.5" />
          </>
        )}
        {iconKey === 'academic' && (
          <>
            <path d="m2 9 10-5 10 5-10 5-10-5z" />
            <path d="M6 11v4c0 2 2.7 3.5 6 3.5s6-1.5 6-3.5v-4" />
            <path d="M22 9v5" />
          </>
        )}
        {iconKey === 'facility' && (
          <>
            <rect x="4" y="3" width="16" height="18" rx="2" />
            <path d="M9 8h2M13 8h2M9 12h2M13 12h2" />
            <path d="M11 21v-4h2v4" />
          </>
        )}
        {iconKey === 'leave' && (
          <>
            <path d="M7 3h8l2 2v16H7z" />
            <path d="M15 3v3h3" />
            <path d="m10 13 2 2 4-4" />
          </>
        )}
        {iconKey === 'substitute' && (
          <>
            <circle cx="9" cy="7" r="3" />
            <path d="M2 21a7 7 0 0 1 14 0" />
            <path d="M16 5h6" />
            <path d="m19 2 3 3-3 3" />
            <path d="M22 19h-6" />
            <path d="m19 22-3-3 3-3" />
          </>
        )}
        {iconKey === 'reports' && (
          <>
            <path d="M4 20V10" />
            <path d="M10 20V4" />
            <path d="M16 20v-7" />
            <path d="M22 20H2" />
          </>
        )}
        {iconKey === 'notification' && (
          <>
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
            <path d="M13.7 21a2 2 0 0 1-3.4 0" />
          </>
        )}
        {iconKey === 'logs' && (
          <>
            <path d="M7 3h8l4 4v14H7z" />
            <path d="M15 3v4h4" />
            <path d="M10 12h6M10 16h6" />
          </>
        )}
        {iconKey === 'settings' && (
          <>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1A1.7 1.7 0 0 0 10 3.2V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.6h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.4.7z" />
          </>
        )}
        {iconKey === 'warning' && (
          <>
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
            <path d="M10 3 2 19a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 19L14 3a2 2 0 0 0-4 0z" />
          </>
        )}
        {iconKey === 'default' && <circle cx="12" cy="12" r="4" />}
      </svg>
    );
  };

  const renderNavigationSearchResults = (mobile = false) => {
    if (!navigationSearchOpen || !normalizedNavigationSearch) return null;
    return (
      <div
        className={`${mobile ? 'mt-2' : 'absolute left-0 right-0 top-[calc(100%+0.5rem)]'} z-[70] overflow-hidden rounded-xl border border-gray-200 bg-white text-gray-800 shadow-2xl`}
        role="listbox"
        aria-label="Navigation search results"
      >
        {navigationSearchResults.length ? (
          <div className="max-h-[min(60vh,24rem)] overflow-y-auto p-1.5">
            {navigationSearchResults.map((item, index) => (
              <button
                key={item.path}
                type="button"
                role="option"
                aria-selected={index === navigationSearchIndex}
                onMouseEnter={() => setNavigationSearchIndex(index)}
                onClick={() => navigateFromSearch(item)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition ${index === navigationSearchIndex ? 'bg-emerald-50 text-emerald-800' : 'hover:bg-gray-50'}`}
              >
                <span className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-emerald-50 text-emerald-700">
                  <NavIcon path={item.path} className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold">{item.label}</span>
                  <span className="block truncate text-[11px] text-gray-500">{item.group || 'Main navigation'}</span>
                </span>
                <svg className="h-4 w-4 flex-none text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
            ))}
          </div>
        ) : (
          <div className="px-4 py-5 text-center text-sm text-gray-500">No accessible page matches “{navigationSearch.trim()}”.</div>
        )}
      </div>
    );
  };

  const markNotificationRead = async (notifId) => {
    if (!notifId) return;
    try {
      await fetch(buildIndexApiUrl(`notification/${notifId}`), {
        method: 'PUT',
        credentials: 'include',
        headers: {
          ...getAuthHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ is_read: 1 }),
      });
    } catch (e) {
      console.warn('[Navbar] failed to mark notification as read', e);
    }
  };

  const markAllNotificationsRead = async () => {
    setNotificationActioning(true);
    setNotifications(prev => prev.map(n => ({ ...n, is_read: 1 })));
    setUnreadCount(0);
    try {
      await fetch(buildIndexApiUrl('notification/read-all'), {
        method: 'PUT',
        credentials: 'include',
        headers: {
          ...getAuthHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ is_read: 1 }),
      });
    } catch (e) {
      console.warn('[Navbar] failed to mark all notifications as read', e);
    } finally {
      setNotificationActioning(false);
    }
  };

  const confirmNotificationAction = async (title, text, confirmLabel = 'Confirm') => {
    try {
      await ensureSwalLoaded();
      if (window.Swal && typeof window.Swal.fire === 'function') {
        const result = await window.Swal.fire({
          icon: 'warning',
          title,
          text,
          showCancelButton: true,
          confirmButtonColor: '#dc2626',
          confirmButtonText: confirmLabel,
          cancelButtonText: 'Cancel',
        });
        return !!result?.isConfirmed;
      }
    } catch (e) {
      // fallback below
    }
    return window.confirm(text);
  };

  const clearNotifications = async (mode = 'read') => {
    if (notificationActioning) return;

    const isAll = mode === 'all';
    const ok = await confirmNotificationAction(
      isAll ? 'Clear All Notifications?' : 'Clear Read Notifications?',
      isAll
        ? 'This will hide all notifications from the Navbar. They will still appear on the Notifications page.'
        : 'This will hide read notifications from the Navbar. They will still appear on the Notifications page.',
      isAll ? 'Clear All' : 'Clear Read'
    );
    if (!ok) return;

    setNotificationActioning(true);
    try {
      const endpoint = isAll ? 'notification/clear-all' : 'notification/clear-read';
      const res = await fetch(buildIndexApiUrl(endpoint), {
        method: 'DELETE',
        credentials: 'include',
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`Failed to clear notifications (${res.status})`);

      if (isAll) {
        setNotifications([]);
        setUnreadCount(0);
      } else {
        setNotifications((prev) => prev.filter((n) => Number(n?.is_read || 0) === 0));
      }

      try {
        await ensureSwalLoaded();
        if (window.Swal && typeof window.Swal.fire === 'function') {
          window.Swal.fire({
            toast: true,
            position: 'top-end',
            icon: 'success',
            title: isAll ? 'Notifications hidden from Navbar' : 'Read notifications hidden from Navbar',
            showConfirmButton: false,
            timer: 1200,
          });
        }
      } catch (e) {
        // ignore toast failures
      }
    } catch (e) {
      console.warn('[Navbar] clear notifications error', e);
      setNotificationsError('Failed to clear notifications');
      await fetchNotifications(true);
    } finally {
      setNotificationActioning(false);
    }
  };

  const onNotificationItemClick = async (notif) => {
    if (!notif) return;
    const notifId = Number(notif.notif_id || 0);
    const wasUnread = Number(notif.is_read || 0) === 0;
    if (notifId > 0 && wasUnread) {
      setNotifications(prev => prev.map(n => Number(n.notif_id) === notifId ? { ...n, is_read: 1 } : n));
      setUnreadCount(c => Math.max(0, Number(c || 0) - 1));
      await markNotificationRead(notifId);
    }
    setNotificationOpen(false);
    const link = normalizeNotificationLink(notif.link);
    const destination = link || `/notifications${notifId > 0 ? `?notif_id=${notifId}` : ''}`;
    window.location.hash = '#' + destination;
  };

  // Open profile modal and ensure profileData is loaded
  const openProfile = () => {
    setMenuOpen(false);
    setNotificationOpen(false);
    setProfileDetailsOpen(false);
    setProfileOpen(true);
    // Lazy fetch profile if not present
    (async () => {
      try {
        if (profileData && profileData.user_id) {
          // If dept_name missing but dept_id present, try to resolve department name
          if ((!profileData.dept_name || profileData.dept_name === '') && profileData.dept_id) {
            try {
              const dres = await fetch(buildIndexApiUrl('departments'), { credentials: 'include', headers: getAuthHeaders() });
              if (dres.ok) {
                const dj = await dres.json();
                const depts = Array.isArray(dj) ? dj : (dj && Array.isArray(dj.data) ? dj.data : null);
                if (Array.isArray(depts)) {
                  const found = depts.find(dd => String(dd.dept_id) === String(profileData.dept_id));
                  if (found) setProfileData(p => ({ ...(p||{}), dept_name: found.dept_name }));
                }
              }
            } catch (e) { /* ignore */ }
          }
          return;
        }
        const uid = user && (user.user_id || user.id || user.userId) ? (user.user_id || user.id || user.userId) : null;
        if (!uid) return;
        const res = await fetch(buildIndexApiUrl(`user-profile?user_id=${uid}`), { credentials: 'include', headers: getAuthHeaders() });
        if (!res.ok) return;
        const j = await res.json();
        if (j && j.user) {
          let userProfile = j.user;
          // If server didn't include dept_name, attempt to resolve it from departments API
          if ((!userProfile.dept_name || userProfile.dept_name === '') && userProfile.dept_id) {
            try {
              const dres = await fetch(buildIndexApiUrl('departments'), { credentials: 'include', headers: getAuthHeaders() });
              if (dres.ok) {
                const dj = await dres.json();
                const depts = Array.isArray(dj) ? dj : (dj && Array.isArray(dj.data) ? dj.data : null);
                if (Array.isArray(depts)) {
                  const found = depts.find(dd => String(dd.dept_id) === String(userProfile.dept_id));
                  if (found) userProfile.dept_name = found.dept_name;
                }
              }
            } catch (e) { /* ignore */ }
          }
          setProfileData(userProfile);
        }
      } catch (e) { console.warn('openProfile fetch error', e); }
    })();
  };

  const handleProfileAvatarChange = (event) => {
    const file = event.target.files && event.target.files[0] ? event.target.files[0] : null;
    setProfileAvatarError('');
    if (!file) return;
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      setProfileAvatarFile(null);
      setProfileAvatarPreview('');
      setProfileAvatarError('Choose a JPEG, PNG, or WebP image.');
      event.target.value = '';
      return;
    }
    if (file.size > 4000000) {
      setProfileAvatarFile(null);
      setProfileAvatarPreview('');
      setProfileAvatarError('Profile photos must be 4 MB or smaller.');
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setProfileAvatarFile(file);
      setProfileAvatarPreview(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      setProfileAvatarFile(null);
      setProfileAvatarPreview('');
      setProfileAvatarError('This image could not be previewed. Please choose another file.');
    };
    reader.readAsDataURL(file);
  };

  const handleSaveProfile = async () => {
    const uid = profileUserId;
    if (!uid) return alert('No user id');
    const contactNo = String(profileForm.contact_no || '').replace(/\D/g, '').slice(0, 11);
    const currentContactNo = String((profileData && profileData.contact_no) || '').replace(/\D/g, '').slice(0, 11);
    const contactChanged = contactNo !== currentContactNo;
    const avatarChanged = Boolean(profileAvatarFile);
    if (!contactChanged && !avatarChanged) {
      return alert('No changes to save');
    }
    if (contactChanged && contactNo && (!/^09\d+$/.test(contactNo) || contactNo.length !== 11)) {
      return alert('Contact number must be 11 digits and start with 09.');
    }
    const fd = new FormData();
    fd.append('user_id', String(uid));
    if (contactChanged) fd.append('contact_no', contactNo);
    if (avatarChanged) fd.append('avatar', profileAvatarFile);
    setUploading(true);
    try {
      const res = await fetch(buildIndexApiUrl('user-profile'), { method: 'POST', credentials: 'include', headers: getAuthHeaders(), body: fd });
      const j = await res.json();
      if (res.ok && j && j.ok) {
        applyProfileUpdate(j.user || profileData);
        try {
          await ensureSwalLoaded();
          if (window.Swal && typeof window.Swal.fire === 'function') {
            window.Swal.fire({
              toast: true,
              position: 'top-end',
              icon: 'success',
              title: avatarChanged ? (contactChanged ? 'Profile updated' : 'Profile photo updated') : 'Contact number updated',
              showConfirmButton: false,
              timer: 1500,
              timerProgressBar: true
            });
          } else {
            alert(avatarChanged ? 'Profile photo updated' : 'Contact number updated');
          }
        } catch (e) { try { alert(avatarChanged ? 'Profile photo updated' : 'Contact number updated'); } catch (e) {} }
        resetProfileEditor();
        setProfileOpen(false);
      } else {
        const errorMsg = (j && (j.error || j.message)) || 'Profile update failed';
        if (j && j.error === 'contact_no_in_use') {
          alert('This contact number is already in use by another user. Please use a different number.');
        } else {
          alert(errorMsg);
        }
      }
    } catch (e) { console.error(e); alert('Profile update failed'); } finally { setUploading(false); }
  };

  const avatarSrc = (profileData && profileData.avatar) || (user && (user.avatar || user.image)) || unknownImg;
  const normalizedProfileContact = String(profileForm.contact_no || '').replace(/\D/g, '').slice(0, 11);
  const savedProfileContact = String((profileData && profileData.contact_no) || '').replace(/\D/g, '').slice(0, 11);
  const profileContactDirty = normalizedProfileContact !== savedProfileContact;
  const profileContactValid = normalizedProfileContact === '' || /^09\d{9}$/.test(normalizedProfileContact);
  const profileContactError = profileContactDirty && normalizedProfileContact && !profileContactValid
    ? 'Enter an 11-digit mobile number beginning with 09.'
    : '';

  // Real-time contact number availability check
  const [profileContactAvailability, setProfileContactAvailability] = React.useState(null);
  const profileContactCheckTimer = React.useRef(null);
  React.useEffect(() => {
    if (profileContactCheckTimer.current) {
      clearTimeout(profileContactCheckTimer.current);
    }
    const digits = String(profileForm.contact_no || '').replace(/\D/g, '').slice(0, 11);
    if (digits.length === 11 && /^09\d{9}$/.test(digits) && profileContactDirty) {
      setProfileContactAvailability(null);
      profileContactCheckTimer.current = setTimeout(async () => {
        try {
          const uid = profileUserId || 0;
          const res = await fetch(buildIndexApiUrl(`check-contact?contact_no=${encodeURIComponent(digits)}&exclude_user_id=${uid}`), { credentials: 'include', headers: getAuthHeaders() });
          const data = await res.json();
          if (data && data.checked) {
            setProfileContactAvailability(data.available);
          }
        } catch (e) {
          console.warn('Contact availability check failed', e);
        }
      }, 500);
    } else {
      setProfileContactAvailability(null);
    }
    return () => {
      if (profileContactCheckTimer.current) clearTimeout(profileContactCheckTimer.current);
    };
  }, [profileForm.contact_no, profileContactDirty]);
  const hasProfileChange = (canEditProfileContact && profileContactDirty) || (canEditProfileAvatar && Boolean(profileAvatarFile));
  const canSaveProfile = hasProfileChange && (!profileContactDirty || profileContactValid) && !profileAvatarError && !uploading;
  const closeProfileModal = () => {
    resetProfileEditor();
    setProfileDetailsOpen(false);
    setProfileOpen(false);
  };

  // --- 4. RENDER WITH TAILWIND ---

  return (
    <>
      {/* HEADER */}
      <header className="h-16 bg-[#1D8551] text-white flex items-center justify-between px-4 sticky top-0 z-40 shadow-md">
        {/* Left: Burger + Logo */}
        <div className="flex items-center gap-3">
          <button 
            onClick={toggleSidebar} 
            className="p-2 rounded-md bg-white/6 hover:bg-white/10 transition-colors focus:outline-none" 
            aria-label="Toggle Navigation"
          >
            <span className="w-5 h-0.5 bg-white rounded-full block"></span>
            <span className="w-5 h-0.5 bg-white rounded-full block mt-1"></span>
            <span className="w-5 h-0.5 bg-white rounded-full block mt-1"></span>
          </button>

          {/* Logo next to the burger */}
          <img src="cdoc-logo.webp?v=lossless-20260911" alt="logo" className="w-9 h-9 rounded-md object-cover" />
        </div>

        {/* Compact desktop page search, aligned beside the logo. */}
        {user ? (
          <div className="relative ml-4 mr-auto hidden w-72 flex-none sm:block lg:w-80" ref={desktopNavigationSearchRef}>
            <label className="relative block">
              <span className="sr-only">Search navigation</span>
              <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/75" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                type="text"
                value={navigationSearch}
                onFocus={() => setNavigationSearchOpen(true)}
                onChange={(event) => {
                  setNavigationSearch(event.target.value);
                  setNavigationSearchIndex(0);
                  setNavigationSearchOpen(true);
                }}
                onKeyDown={handleNavigationSearchKeyDown}
                placeholder="Search pages..."
                autoComplete="off"
                aria-label="Search pages"
                aria-expanded={navigationSearchOpen && Boolean(normalizedNavigationSearch)}
                className="h-10 w-full rounded-xl border border-white/20 bg-white/10 pl-9 pr-8 text-sm text-white outline-none placeholder:text-white/70 transition focus:border-white/50 focus:bg-white/15 focus:ring-2 focus:ring-white/20"
              />
              {navigationSearch ? (
                <button
                  type="button"
                  onClick={() => {
                    setNavigationSearch('');
                    setNavigationSearchIndex(0);
                    setNavigationSearchOpen(false);
                  }}
                  className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-white/80 hover:bg-white/15 hover:text-white"
                  aria-label="Clear navigation search"
                >
                  <span aria-hidden="true">&times;</span>
                </button>
              ) : null}
            </label>
            {renderNavigationSearchResults(false)}
          </div>
        ) : (
          <div className="flex-1" aria-hidden="true"></div>
        )}

        {/* Right: Actions */}
        <div className="flex items-center gap-2 sm:gap-4">
          {user ? (
            <>
              {/* Mobile navigation search opens below the fixed header. */}
              <div className="relative sm:hidden" ref={mobileNavigationSearchRef}>
                <button
                  type="button"
                  onClick={() => {
                    setNavigationSearchOpen((open) => !open);
                    setNavigationSearchIndex(0);
                    setNotificationOpen(false);
                    setMenuOpen(false);
                  }}
                  className={`grid h-10 w-10 place-items-center rounded-full transition ${navigationSearchOpen ? 'bg-white text-emerald-700' : 'bg-white/6 text-white hover:bg-white/10'}`}
                  aria-label="Search navigation"
                  aria-expanded={navigationSearchOpen}
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                </button>

                {navigationSearchOpen ? (
                  <div className="fixed left-2 right-2 top-[4.5rem] z-[70] rounded-xl border border-gray-200 bg-white p-2 text-gray-800 shadow-2xl">
                    <label className="relative block">
                      <span className="sr-only">Search navigation</span>
                      <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <circle cx="11" cy="11" r="7" />
                        <path d="m20 20-3.5-3.5" />
                      </svg>
                      <input
                        type="text"
                        value={navigationSearch}
                        autoFocus
                        onChange={(event) => {
                          setNavigationSearch(event.target.value);
                          setNavigationSearchIndex(0);
                        }}
                        onKeyDown={handleNavigationSearchKeyDown}
                        placeholder="Search pages..."
                        autoComplete="off"
                        aria-label="Search pages"
                        className="h-11 w-full rounded-lg border border-gray-300 bg-white pl-9 pr-9 text-base text-gray-800 outline-none placeholder:text-gray-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                      />
                      {navigationSearch ? (
                        <button
                          type="button"
                          onClick={() => {
                            setNavigationSearch('');
                            setNavigationSearchIndex(0);
                          }}
                          className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                          aria-label="Clear navigation search"
                        >
                          <span aria-hidden="true">&times;</span>
                        </button>
                      ) : null}
                    </label>
                    {renderNavigationSearchResults(true)}
                  </div>
                ) : null}
              </div>
                            {/* Notification Bell + Dropdown Panel */}
              <div className="relative" ref={notificationPanelRef}>
                <button
                  onClick={() => {
                    const next = !notificationOpen;
                    setNotificationOpen(next);
                    if (next) {
                      setNotificationFilter('all');
                      fetchNotifications(false);
                    }
                  }}
                  title="Notifications"
                  className={`relative p-2 rounded-full bg-white/6 hover:bg-white/10 transition-transform transform ${shouldAnimateNotificationBell ? 'hover:scale-105' : ''}`}
                >
                  <svg
                    className={`w-6 h-6 ${shouldAnimateNotificationBell ? 'animate-bounce' : ''}`}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5" />
                    <path d="M9 17a3 3 0 0 0 6 0" />
                  </svg>
                </button>

                {unreadNotifications > 0 && (
                  <div className="absolute -top-1 -right-1 flex items-center justify-center">
                    <span className="inline-flex min-w-[20px] h-5 px-1 items-center justify-center rounded-full bg-red-600 text-white text-[10px] font-bold leading-none shadow">
                      {unreadNotifications}
                    </span>
                  </div>
                )}

                {notificationOpen && (
                  <div className="fixed right-2 top-16 w-80 max-w-[92vw] bg-white text-gray-800 border border-gray-100 rounded-lg shadow-xl z-50 overflow-hidden">
                    <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
                      <div className="text-sm font-bold text-gray-800">Notifications</div>
                      {unreadNotifications > 0 ? (
                        <button
                          type="button"
                          onClick={markAllNotificationsRead}
                          disabled={notificationActioning}
                          className="text-xs font-semibold text-[#1D8551] hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {notificationActioning ? 'Working...' : 'Mark all read'}
                        </button>
                      ) : null}
                    </div>

                    <div className="flex items-center justify-between gap-3 border-b border-gray-100 bg-emerald-50/70 px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-xs font-bold text-gray-800">
                          <i className={`bi ${navPushStatus.enabled ? 'bi-bell-fill text-emerald-600' : 'bi-bell text-gray-500'}`}></i>
                          Background alerts
                        </div>
                        <div className={`mt-0.5 truncate text-[10px] ${navPushMessage && !navPushStatus.enabled ? 'text-amber-700' : 'text-gray-500'}`} title={navPushMessage || ''}>
                          {navPushMessage || (navPushStatus.enabled ? 'Enabled on this device' : navPushStatus.supported ? 'Receive alerts outside this page' : 'Unavailable in this browser')}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={toggleNavBackgroundAlerts}
                        disabled={navPushActioning || !navPushStatus.supported}
                        className={`inline-flex min-w-[72px] flex-none items-center justify-center rounded-lg px-3 py-1.5 text-[11px] font-bold transition disabled:cursor-not-allowed disabled:opacity-60 ${navPushStatus.enabled ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-50'}`}
                      >
                        {navPushActioning ? 'Updating…' : navPushStatus.enabled ? 'On' : 'Enable'}
                      </button>
                    </div>

                    <div className="border-b border-gray-100 bg-white px-3 py-2">
                      <button
                        type="button"
                        onClick={() => {
                          setNotificationOpen(false);
                          window.location.hash = '#/notifications';
                        }}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700 transition hover:bg-emerald-100"
                      >
                        <i className="bi bi-list-ul" aria-hidden="true"></i>
                        Show all
                      </button>
                    </div>

                    <div className="px-3 py-2 border-b border-gray-100 bg-gray-50">
                      <div className="inline-flex rounded-md border border-gray-200 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setNotificationFilter('all')}
                          className={`px-3 py-1 text-xs font-semibold transition-colors ${notificationFilter === 'all' ? 'bg-[#1D8551] text-white' : 'bg-white text-gray-600 hover:bg-gray-100'}`}
                        >
                          All
                        </button>
                        <button
                          type="button"
                          onClick={() => setNotificationFilter('unread')}
                          className={`px-3 py-1 text-xs font-semibold transition-colors ${notificationFilter === 'unread' ? 'bg-[#1D8551] text-white' : 'bg-white text-gray-600 hover:bg-gray-100'}`}
                        >
                          Unread
                        </button>
                      </div>
                    </div>

                    <div className={filteredNotifications.length >= 3 ? 'max-h-64 overflow-y-scroll' : 'overflow-y-visible'}>
                      {notificationsLoading ? (
                        <LoadingState label="Loading notifications..." compact />
                      ) : filteredNotifications.length === 0 ? (
                        <div className="px-4 py-5 text-sm text-gray-500">
                          {notificationFilter === 'unread' ? 'No unread notifications.' : 'No notifications yet.'}
                        </div>
                      ) : (
                        filteredNotifications.map((notif) => {
                          const isUnread = Number(notif?.is_read || 0) === 0;
                          const actorName = getNotificationActorName(notif);
                          const actorAvatar = notif?.actor_avatar || unknownImg;
                          const titleText = cleanNotificationText(notif?.title || 'Notification');
                          const bodyText = cleanNotificationText(notif?.message || '');
                          const ageText = formatNotificationAge(notif.created_at);
                          return (
                            <button
                              key={notif.notif_id || `${notif.title}-${notif.created_at}`}
                              type="button"
                              onClick={() => onNotificationItemClick(notif)}
                              className={`w-full text-left px-4 py-3 border-b border-gray-200 transition-colors ${isUnread ? 'bg-emerald-100 border-l-4 border-l-emerald-600 hover:bg-emerald-200' : 'bg-gray-100 hover:bg-gray-200'}`}
                            >
                              <div className="flex items-start gap-3">
                                <span
                                  className={`inline-block w-2.5 h-2.5 rounded-full mt-1 flex-shrink-0 ${isUnread ? 'bg-emerald-600' : 'bg-gray-300'}`}
                                  title={isUnread ? 'Unread' : 'Read'}
                                ></span>
                                <img
                                  src={actorAvatar}
                                  alt={actorName}
                                  className="w-9 h-9 rounded-full object-cover border border-gray-200 bg-gray-100 flex-shrink-0"
                                  onError={(e) => {
                                    if (e.currentTarget.dataset.fallbackApplied === '1') return;
                                    e.currentTarget.dataset.fallbackApplied = '1';
                                    e.currentTarget.src = unknownImg;
                                  }}
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className={`text-sm truncate ${isUnread ? 'font-bold text-gray-900' : 'font-semibold text-gray-800'}`}>{actorName}</div>
                                      <div className="text-[11px] text-gray-500 truncate">{titleText}</div>
                                    </div>
                                    <div className="text-[11px] text-gray-500 whitespace-nowrap">{formatNotificationTime(notif.created_at)}</div>
                                  </div>
                                  <div className={`text-xs mt-1 leading-5 ${isUnread ? 'text-gray-800' : 'text-gray-600'}`}>{bodyText}</div>
                                  {ageText ? (
                                    <div className="flex justify-start">
                                      <span className={`inline-flex items-center py-0.5 rounded-full text-[10px] leading-none font-semibold ${isUnread ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-200 text-gray-600'}`}>
                                        {ageText}
                                      </span>
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>

                    {notifications.length > 0 ? (
                      <div className="px-3 py-2 border-t border-gray-100 bg-gray-50 flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => clearNotifications('read')}
                          disabled={notificationActioning}
                          className="text-xs font-semibold text-gray-700 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Clear read
                        </button>
                        <button
                          type="button"
                          onClick={() => clearNotifications('all')}
                          disabled={notificationActioning}
                          className="text-xs font-semibold text-red-600 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Clear all
                        </button>
                      </div>
                    ) : null}

                    {notificationsError ? (
                      <div className="px-4 py-2 text-xs text-red-600 border-t border-red-100 bg-red-50">{notificationsError}</div>
                    ) : null}
                  </div>
                )}
              </div>

              {/* Profile identity + existing overflow menu */}
              <div className="relative flex items-center gap-2">
                <button
                  type="button"
                  onClick={openProfile}
                  className="group inline-flex min-w-0 items-center gap-2 rounded-full bg-white/5 py-1 pl-1 pr-2.5 text-left transition-colors hover:bg-white/12 focus:outline-none focus:ring-2 focus:ring-white/35"
                  aria-label={`Open My Profile. Current role: ${navRoleLabel}`}
                  title="Open My Profile"
                >
                  <img
                    src={avatarSrc}
                    alt=""
                    className="w-9 h-9 flex-none rounded-full object-cover border-2 border-white/30 shadow-sm"
                    onError={(e) => {
                      if (e.currentTarget.dataset.fallbackApplied === '1') return;
                      e.currentTarget.dataset.fallbackApplied = '1';
                      e.currentTarget.src = unknownImg;
                    }}
                  />
                  <span className="hidden max-w-[150px] truncate text-sm font-semibold text-white sm:block">{navRoleLabel}</span>
                </button>
                <button 
                  onClick={() => setMenuOpen(!menuOpen)} 
                  className="w-8 h-8 rounded-full bg-white/8 hover:bg-white/12 flex flex-col items-center justify-center gap-1 transition-colors"
                  aria-label="Open account menu"
                  aria-expanded={menuOpen}
                >
                  <span className="w-1 h-1 bg-white rounded-full"></span>
                  <span className="w-1 h-1 bg-white rounded-full"></span>
                  <span className="w-1 h-1 bg-white rounded-full"></span>
                </button>

                {menuOpen && (
                  <div className="absolute right-0 top-12 bg-white text-gray-800 border border-gray-100 rounded-lg shadow-xl w-44 py-2 z-50 animate-fade-in-down">
                    <div 
                      onClick={() => { setMenuOpen(false); openProfile(); }} 
                      className="px-4 py-2 hover:bg-gray-50 cursor-pointer font-medium text-sm transition-colors"
                    >
                      My Profile
                    </div>
                    <div className="h-px bg-gray-100 my-1"></div>
                    <div 
                      onClick={handleLogout} 
                      className="px-4 py-2 hover:bg-red-50 text-red-600 cursor-pointer font-medium text-sm transition-colors"
                    >
                      Logout
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <a href="#/login" className="text-white hover:underline font-medium">Login</a>
          )}
        </div>
      </header>

      {/* SIDEBAR */}
      <aside 
        className={`fixed top-14 left-0 w-64 bg-white border-r border-gray-200 shadow-xl z-30 transition-transform duration-300 ease-in-out h-[calc(100vh-3.5rem)] overflow-y-auto custom-scrollbar
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Main Navigation</h2>
        </div>
        
        <nav className="p-2 space-y-1" style={{ color: '#374151' }}>
          {visibleNavItems.map((item, index) => {
            // Check if active (for styling)
            const isActive = currentHash === item.path || (item.path !== '/' && currentHash.startsWith(item.path + '/'));
            const hasChildren = item.children && item.children.length > 0;
            const isExpanded = openSubmenus[item.path] || item.children?.some(c => currentHash.startsWith(c.path));

            if (hasChildren) {
              return (
                <div key={index} className="mb-1">
                  <div 
                    onClick={() => toggleSubmenu(item.path)}
                    className={`flex items-center justify-between px-3 py-2.5 rounded-md cursor-pointer transition-colors duration-200 select-none
                      ${isExpanded ? 'bg-gray-50 text-green-700 font-semibold' : 'text-gray-700 hover:bg-gray-50 hover:text-green-600'}`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <NavIcon path={item.path} />
                      <span className="text-sm truncate">{item.label}</span>
                    </span>
                    <span className={`text-[10px] transform transition-transform duration-200 ${isExpanded ? 'rotate-90' : 'rotate-0'}`}>
                      
                    </span>
                  </div>
                  
                  {/* Submenu Items */}
                  <div className={`pl-4 mt-1 space-y-1 overflow-hidden transition-all duration-300 ease-in-out ${isExpanded ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'}`}>
                    {item.children.map((sub, sIdx) => {
                      const isSubActive = currentHash === sub.path;
                      return (
                        <div 
                          key={sIdx} 
                          onClick={() => navTo(sub.path)}
                          className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm cursor-pointer border-l-2 transition-all duration-200
                            ${isSubActive 
                              ? 'border-green-500 bg-green-50 text-green-700 font-medium' 
                              : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'}`}
                        >
                          <NavIcon path={sub.path} className="w-3.5 h-3.5" />
                          <span className="truncate">{sub.label}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            } 
            
            // Single Link
            return (
              <div 
                key={index} 
                onClick={() => navTo(item.path)}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-md text-sm cursor-pointer transition-all duration-200 border-l-4 
                  ${isActive 
                    ? 'border-green-600 bg-green-50 text-green-800 font-semibold shadow-sm' 
                    : 'border-transparent text-gray-700 hover:bg-gray-50 hover:text-green-600'}`}
              >
                <NavIcon path={item.path} />
                <span className="truncate">{item.label}</span>
              </div>
            );
          })}
        </nav>
      </aside>

      {/* OVERLAY (Backdrop for Mobile) */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/30 backdrop-blur-sm z-20 transition-opacity duration-300" 
          onClick={() => setSidebarOpen(false)}
        ></div>
      )}

      {/* PROFILE MODAL */}
      <Modal
        show={profileOpen}
        title="My Profile"
        description="Review your account information and keep your contact number current."
        size="md"
        className="profile-modal"
        onClose={closeProfileModal}
        headerIcon={(
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6.75a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.5 20.25a7.5 7.5 0 0115 0" />
          </svg>
        )}
        footer={(
          <>
            <button
              type="button"
              onClick={closeProfileModal}
              className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-200"
            >
              Close
            </button>
            {canEditProfileContact ? (
              <button
                type="button"
                onClick={handleSaveProfile}
                disabled={!canSaveProfile}
                className={`inline-flex min-w-[132px] items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-colors focus:outline-none focus:ring-2 focus:ring-green-200 ${canSaveProfile ? 'bg-green-600 hover:bg-green-700' : 'cursor-not-allowed bg-gray-300'}`}
              >
                {uploading ? (
                  <svg className="h-4 w-4 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path></svg>
                ) : null}
                {uploading ? 'Saving...' : 'Save Changes'}
              </button>
            ) : null}
          </>
        )}
      >
        <div className="profile-modal-content grid grid-cols-1 items-start gap-[20px] md:grid-cols-5">
          <div className="profile-modal-summary rounded-2xl border border-emerald-100 bg-emerald-50/50 p-[20px] text-center md:col-span-2">
            <div className="profile-modal-avatar relative mx-auto h-24 w-24 rounded-full bg-white p-[6px] shadow-sm ring-1 ring-emerald-100">
              <img
                src={profileAvatarPreview || (profileData && profileData.avatar) || avatarSrc}
                alt={`${`${profileForm.first_name || ''} ${profileForm.last_name || ''}`.trim() || 'User'} profile`}
                className="h-full w-full rounded-full object-cover"
                onError={(e) => {
                  if (e.currentTarget.dataset.fallbackApplied === '1') return;
                  e.currentTarget.dataset.fallbackApplied = '1';
                  e.currentTarget.src = unknownImg;
                }}
              />
              {canEditProfileAvatar ? (
                <>
                  <button
                    type="button"
                    onClick={() => profileAvatarInputRef.current && profileAvatarInputRef.current.click()}
                    className="absolute bottom-0 right-0 inline-flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-green-600 text-white shadow-md transition hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-200"
                    aria-label="Choose a new profile photo"
                    title="Change profile photo"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 008.186 5.5h7.628a2.31 2.31 0 011.359.675l.58.58c.434.434 1.022.678 1.636.678A2.611 2.611 0 0122 10.044v6.345A2.611 2.611 0 0119.389 19H4.61A2.611 2.611 0 012 16.389v-6.345a2.611 2.611 0 012.611-2.611c.614 0 1.202-.244 1.636-.678l.58-.58z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 13a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" /></svg>
                  </button>
                  <input
                    ref={profileAvatarInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleProfileAvatarChange}
                    className="hidden"
                    tabIndex={-1}
                  />
                </>
              ) : null}
            </div>

            <h3 className="profile-modal-name mt-[14px] break-words text-lg font-bold text-gray-900">
              {`${profileForm.first_name || ''} ${profileForm.last_name || ''}`.trim() || 'My Profile'}
            </h3>
            <span className="profile-modal-role mt-[8px] inline-flex max-w-full items-center rounded-full border border-emerald-200 bg-white px-[12px] py-[4px] text-xs font-bold uppercase tracking-wide text-emerald-700">
              {profileData && profileData.role_name ? profileData.role_name : (user && user.role_name ? user.role_name : 'N/A')}
            </span>
            {canEditProfileAvatar ? <div className="profile-modal-avatar-hint mt-[8px] text-xs font-medium text-green-700">Use the camera button to change your photo.</div> : null}
            {profileAvatarError ? <div className="mt-[8px] text-xs font-semibold text-red-600" role="alert">{profileAvatarError}</div> : null}

            <div className="profile-modal-meta mt-[18px] grid grid-cols-2 gap-[12px] border-t border-emerald-100 pt-[16px] text-left md:grid-cols-1">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Department</div>
                <div className="mt-[4px] break-words text-sm font-semibold text-gray-800">{profileData && profileData.dept_name ? profileData.dept_name : 'None assigned'}</div>
              </div>
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500">School ID</div>
                <div className="mt-[4px] break-all font-mono text-sm font-semibold text-gray-800">{profileData && profileData.id_number ? String(profileData.id_number) : 'N/A'}</div>
              </div>
            </div>

            <div className="profile-modal-summary-note mt-[18px] rounded-xl border border-emerald-100 bg-white/80 px-[12px] py-[10px] text-left text-xs leading-5 text-emerald-800">
              {canEditProfileAvatar ? 'You can update your photo here. Other identity details are managed through User Management.' : 'Your photo and identity details are managed through User Management.'}
            </div>
          </div>

          <div className="profile-modal-account min-w-0 md:col-span-3">
            <div className="profile-modal-account-heading mb-4">
              <h4 className="text-base font-bold text-gray-900">Account information</h4>
              <p className="mt-[4px] text-sm text-gray-500">Your official details are shown below for reference.</p>
            </div>

            <button type="button" className="profile-modal-account-toggle" aria-expanded={profileDetailsOpen} aria-controls="profile-account-details" onClick={() => setProfileDetailsOpen((value) => !value)}>
              <span><i className="bi bi-person-vcard" aria-hidden="true" />Account information</span>
              <span>{profileDetailsOpen ? 'Hide' : 'Show'}<i className={`bi ${profileDetailsOpen ? 'bi-chevron-up' : 'bi-chevron-down'}`} aria-hidden="true" /></span>
            </button>

            <div id="profile-account-details" className={`profile-modal-account-content${profileDetailsOpen ? ' is-open' : ''}`}>
            <div className="profile-modal-account-grid grid grid-cols-1 gap-[12px] sm:grid-cols-2">
              <div className="profile-modal-info-card rounded-xl border border-gray-200 bg-gray-50 px-[16px] py-[12px]">
                <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500">First name</div>
                <div className="mt-[4px] break-words text-sm font-semibold text-gray-800">{profileForm.first_name || 'Not provided'}</div>
              </div>
              <div className="profile-modal-info-card rounded-xl border border-gray-200 bg-gray-50 px-[16px] py-[12px]">
                <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Last name</div>
                <div className="mt-[4px] break-words text-sm font-semibold text-gray-800">{profileForm.last_name || 'Not provided'}</div>
              </div>
              <div className="profile-modal-info-card is-wide rounded-xl border border-gray-200 bg-gray-50 px-[16px] py-[12px] sm:col-span-2">
                <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Email address</div>
                <div className="mt-[4px] break-all text-sm font-semibold text-gray-800">{profileForm.email || 'Not provided'}</div>
              </div>
            </div>

            <div className="profile-modal-contact mt-[16px] rounded-2xl border border-green-200 bg-white p-[16px] shadow-sm">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-green-50 text-green-700">
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106a1.125 1.125 0 00-1.173.417l-.97 1.293a1.125 1.125 0 01-1.21.38 12.035 12.035 0 01-7.143-7.143 1.125 1.125 0 01.38-1.21l1.293-.97c.37-.278.534-.758.417-1.173L6.963 3.102A1.125 1.125 0 005.872 2.25H4.5A2.25 2.25 0 002.25 4.5v2.25z" /></svg>
                </div>
                <div className="min-w-0 flex-1">
                  <label htmlFor="navbar-profile-contact" className="block text-sm font-bold text-gray-900">Contact number</label>
                  <p className="mt-[2px] text-xs text-gray-500">Enter a new number below to enable Save Changes.</p>
                </div>
              </div>
              <input
                id="navbar-profile-contact"
                type="text"
                value={profileForm.contact_no}
                onChange={(e) => {
                  const digits = String(e.target.value || '').replace(/\D/g, '').slice(0, 11);
                  setProfileForm((prev) => ({ ...prev, contact_no: digits }));
                }}
                placeholder="09XXXXXXXXX"
                disabled={!canEditProfileContact}
                inputMode="numeric"
                maxLength={11}
                aria-invalid={Boolean(profileContactError)}
                aria-describedby="navbar-profile-contact-help"
                className={`mt-[14px] w-full rounded-xl border px-[16px] py-[10px] text-sm font-medium text-gray-900 outline-none transition ${profileContactError ? 'border-red-300 bg-red-50 focus:border-red-500 focus:ring-2 focus:ring-red-100' : 'border-gray-200 bg-white focus:border-green-500 focus:ring-2 focus:ring-green-100'} ${canEditProfileContact ? '' : 'cursor-not-allowed bg-gray-100'}`}
              />
              {profileContactAvailability !== null && profileContactDirty && profileContactValid && (
                <div className={`mt-[8px] flex items-center gap-1.5 text-xs font-semibold ${profileContactAvailability ? 'text-green-600' : 'text-red-600'}`}>
                  <span className={`inline-block w-2 h-2 rounded-full ${profileContactAvailability ? 'bg-green-500' : 'bg-red-500'}`}></span>
                  {profileContactAvailability ? 'Available' : 'Already in use by another user'}
                </div>
              )}
              <div id="navbar-profile-contact-help" className={`mt-[8px] text-xs ${profileContactError ? 'font-semibold text-red-600' : 'text-gray-500'}`}>
                {profileContactError || (profileContactDirty && profileContactValid ? 'Valid number. Save Changes is now available.' : 'Use 11 digits beginning with 09, for example 09171234567.')}
              </div>
            </div>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}


