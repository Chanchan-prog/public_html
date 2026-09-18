import { dispatchPushStatus, getRememberedPushEndpoint, initializePushForSignedInUser } from '../services/pushNotifications.js';
import { apiFetch } from '../services/api.js';

const { createContext, useCallback, useEffect, useRef, useState } = React;

const AuthContext = createContext(null);

const USER_STORAGE_KEY = 'user';
const SESSION_META_STORAGE_KEY = 'session_meta';
const LAST_ACTIVITY_KEY = 'last_activity_at';
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const SESSION_WARNING_MS = 5 * 60 * 1000;
const ACTIVITY_WRITE_THROTTLE_MS = 30000;
const ACTIVITY_SYNC_INTERVAL_MS = 60 * 1000;
const SESSION_TEST_IDLE_SECONDS_KEY = 'session_test_idle_seconds';
const SESSION_TEST_WARNING_SECONDS_KEY = 'session_test_warning_seconds';

function readSessionTiming(sessionMeta) {
  const configuredIdleSeconds = Math.max(
    60,
    Number(sessionMeta?.idle_timeout_seconds || IDLE_TIMEOUT_MS / 1000)
  );
  let idleTimeoutMs = configuredIdleSeconds * 1000;
  let warningMs = Math.min(SESSION_WARNING_MS, Math.max(1000, idleTimeoutMs - 1000));

  // Local development can use a shorter countdown without changing the
  // production security policy. The override can never lengthen a session.
  try {
    const host = String(window.location.hostname || '').toLowerCase();
    const isLocalDevelopment = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (isLocalDevelopment) {
      const testIdleSeconds = Number(localStorage.getItem(SESSION_TEST_IDLE_SECONDS_KEY) || 0);
      if (Number.isFinite(testIdleSeconds) && testIdleSeconds >= 30 && testIdleSeconds < configuredIdleSeconds) {
        idleTimeoutMs = testIdleSeconds * 1000;
      }

      const testWarningSeconds = Number(localStorage.getItem(SESSION_TEST_WARNING_SECONDS_KEY) || 0);
      if (Number.isFinite(testWarningSeconds) && testWarningSeconds >= 10) {
        warningMs = Math.min(testWarningSeconds * 1000, Math.max(1000, idleTimeoutMs - 1000));
      } else {
        warningMs = Math.min(SESSION_WARNING_MS, Math.max(1000, idleTimeoutMs - 1000));
      }
    }
  } catch (e) {}

  return { idleTimeoutMs, warningMs };
}

function readStoredUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_STORAGE_KEY) || 'null');
  } catch (e) {
    return null;
  }
}

function readStoredSessionMeta() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_META_STORAGE_KEY) || 'null') || {};
  } catch (e) {
    return {};
  }
}

function readStoredActivity() {
  try {
    const value = Number(localStorage.getItem(LAST_ACTIVITY_KEY) || 0);
    return Number.isFinite(value) ? value : 0;
  } catch (e) {
    return 0;
  }
}

function isPageReloadNavigation() {
  try {
    const navigationEntry = window.performance?.getEntriesByType?.('navigation')?.[0];
    if (navigationEntry?.type) return navigationEntry.type === 'reload';
    return Number(window.performance?.navigation?.type) === 1;
  } catch (e) {
    return false;
  }
}

function shouldRestartRequiredPasswordSetup() {
  const storedUser = readStoredUser();
  return Number(storedUser?.is_first_login || 0) === 1 && isPageReloadNavigation();
}

function AuthProvider({ children }) {
  const requireFreshLoginRef = useRef(shouldRestartRequiredPasswordSetup());
  const [user, setUser] = useState(() => requireFreshLoginRef.current ? null : readStoredUser());
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authRefreshKey, setAuthRefreshKey] = useState(0);
  const lastTouchRef = useRef(0);
  const logoutRef = useRef(() => {});
  const logoutInProgressRef = useRef(false);
  const sessionWarningOpenRef = useRef(false);
  const sessionWarningTimerRef = useRef(null);

  const clearSession = useCallback(() => {
    try {
      localStorage.removeItem(USER_STORAGE_KEY);
      // One-time cleanup for browsers that signed in before cookie sessions.
      localStorage.removeItem('token');
      localStorage.removeItem(SESSION_META_STORAGE_KEY);
      localStorage.removeItem(LAST_ACTIVITY_KEY);
    } catch (e) {}
  }, []);

  const logout = useCallback((options = {}) => {
    if (logoutInProgressRef.current) return;
    logoutInProgressRef.current = true;

    // Detach this browser's push endpoint and revoke the server session in one
    // request. The browser subscription remains available for the next login.
    const pushEndpoint = getRememberedPushEndpoint();
    const serverLogout = Promise.resolve(apiFetch('logout', {
      method: 'POST',
      body: JSON.stringify(pushEndpoint ? { push_endpoint: pushEndpoint } : {}),
      keepalive: true,
    })).catch(() => {});
    dispatchPushStatus({
      supported: true,
      enabled: false,
      permission: typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
      browserSubscribed: Boolean(pushEndpoint),
      serverRegistered: false,
    });
    // A failed profile validation leaves authError populated. Clear it before
    // navigating so the validation-error screen cannot cover the login page.
    setAuthError('');
    setUser(null);
    clearSession();

    if (typeof window !== 'undefined') window.location.hash = '#/login';

    // Cleanup is best effort and must never hold the user on a protected page.
    const logoutWork = serverLogout
      .finally(() => {
        logoutInProgressRef.current = false;
      });

    if (options.notice) {
      if (typeof window !== 'undefined' && window.Swal && typeof window.Swal.fire === 'function') {
        try {
          const noticeResult = window.Swal.fire({
            title: 'Notice',
            text: options.notice,
            icon: 'info',
            confirmButtonText: 'OK',
            showCloseButton: true
          });
          Promise.resolve(noticeResult).catch(() => {
            try { window.alert(options.notice); } catch (err) {}
          });
        } catch (e) {
          try { window.alert(options.notice); } catch (err) {}
        }
      } else {
        try { window.alert(options.notice); } catch (e) {}
      }
    }
    return logoutWork;
  }, [clearSession]);

  logoutRef.current = logout;

  const touchActivity = useCallback((force = false) => {
    if (!readStoredUser()) return;
    const now = Date.now();
    if (!force && now - lastTouchRef.current < ACTIVITY_WRITE_THROTTLE_MS) return;
    lastTouchRef.current = now;
    try {
      localStorage.setItem(LAST_ACTIVITY_KEY, String(now));
    } catch (e) {}
  }, []);

  const login = useCallback((nextUser, sessionMeta) => {
    logoutInProgressRef.current = false;
    requireFreshLoginRef.current = false;
    setUser(nextUser || null);
    try {
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(nextUser || null));
    } catch (e) {}
    if (sessionMeta && typeof sessionMeta === 'object') {
      try { localStorage.setItem(SESSION_META_STORAGE_KEY, JSON.stringify(sessionMeta)); } catch (e) {}
    }
    touchActivity(true);
  }, [touchActivity]);

  useEffect(() => {
    if (user) {
      const syncPush = () => initializePushForSignedInUser().catch(error => {
        console.warn('[web_push] automatic user sync failed', error);
      });
      syncPush();
      window.addEventListener('online', syncPush);
      return () => window.removeEventListener('online', syncPush);
    }
    return undefined;
  }, [user]);

  const updateUser = useCallback((nextUser) => {
    setUser(nextUser || null);
    try {
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(nextUser || null));
      localStorage.removeItem('token');
    } catch (e) {}
  }, []);

  const refreshAuthenticatedUser = useCallback(() => {
    // Give immediate feedback when Retry is pressed instead of leaving the
    // previous error screen visible while the new profile request starts.
    setAuthError('');
    setAuthReady(false);
    setAuthRefreshKey((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setAuthReady(false);
    setAuthError('');

    if (requireFreshLoginRef.current) {
      // Reloading during mandatory password setup deliberately ends the
      // restricted session. The user must authenticate again before the
      // password setup modal can be reopened.
      clearSession();
      setUser(null);
      apiFetch('logout', { method: 'POST' })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setAuthReady(true);
        });
      return () => { cancelled = true; };
    }

    const storedUserBeforeValidation = readStoredUser();
    let hasSessionCookieHint = false;
    try {
      // The session cookie is HttpOnly, but its paired CSRF cookie tells the
      // client that a browser session may exist and is worth restoring.
      hasSessionCookieHint = /(?:^|;\s*)cdo_csrf=/.test(document.cookie || '');
    } catch (e) {}

    // A visitor with no saved account and no session-cookie hint is simply
    // signed out. Do not call a protected profile endpoint or show a server
    // validation error before presenting the login page.
    if (!storedUserBeforeValidation && !hasSessionCookieHint) {
      setUser(null);
      setAuthReady(true);
      return () => { cancelled = true; };
    }

    apiFetch('user-profile')
      .then((response) => {
        if (cancelled) return;
        const authoritativeUser = response?.user || null;
        if (!authoritativeUser) throw new Error('The server returned an invalid account profile.');
        setUser(authoritativeUser);
        try { localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(authoritativeUser)); } catch (e) {}
        if (response?.session) {
          try { localStorage.setItem(SESSION_META_STORAGE_KEY, JSON.stringify(response.session)); } catch (e) {}
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setUser(null);
        if (error?.status === 401 || error?.status === 403 || !storedUserBeforeValidation) {
          clearSession();
          setAuthError('');
        } else {
          setAuthError('The server could not validate your account. Check the connection and try again.');
        }
      })
      .finally(() => {
        if (!cancelled) setAuthReady(true);
      });

    return () => { cancelled = true; };
  }, [authRefreshKey, clearSession]);

  useEffect(() => {
    const onSessionInvalidated = () => {
      setUser(null);
      clearSession();
    };
    window.addEventListener('auth-session-invalidated', onSessionInvalidated);
    return () => window.removeEventListener('auth-session-invalidated', onSessionInvalidated);
  }, [clearSession]);

  useEffect(() => {
    try {
      window.__touchSessionActivity = touchActivity;
    } catch (e) {}
    return () => {
      try { delete window.__touchSessionActivity; } catch (e) {}
    };
  }, [touchActivity]);

  useEffect(() => {
    if (!user) return;

    let expirationStarted = false;

    const closeSessionWarning = () => {
      if (sessionWarningTimerRef.current) {
        clearInterval(sessionWarningTimerRef.current);
        sessionWarningTimerRef.current = null;
      }
      if (sessionWarningOpenRef.current) {
        sessionWarningOpenRef.current = false;
        try {
          if (window.Swal && typeof window.Swal.close === 'function') window.Swal.close();
        } catch (e) {}
      }
    };

    const expireSession = (notice) => {
      if (expirationStarted) return;
      expirationStarted = true;
      closeSessionWarning();
      logoutRef.current({ notice });
    };

    const formatRemaining = (remainingMs) => {
      const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = String(totalSeconds % 60).padStart(2, '0');
      return `${minutes}:${seconds}`;
    };

    const showSessionWarning = (idleTimeoutMs) => {
      if (sessionWarningOpenRef.current || !window.Swal || typeof window.Swal.fire !== 'function') return;
      const remainingMs = Math.max(0, idleTimeoutMs - (Date.now() - readStoredActivity()));
      if (remainingMs <= 0) return;

      sessionWarningOpenRef.current = true;
      let warningResult;
      try {
        warningResult = window.Swal.fire({
          icon: 'warning',
          title: 'Session Expiring Soon',
          html: `You will be signed out due to inactivity in <strong id="session-idle-countdown">${formatRemaining(remainingMs)}</strong>.<br><small>Touch, click, type, or scroll to stay signed in.</small>`,
          confirmButtonText: 'Stay Signed In',
          confirmButtonColor: '#198754',
          timer: remainingMs,
          timerProgressBar: true,
          allowOutsideClick: true,
          didOpen: () => {
            const updateCountdown = () => {
              const currentRemaining = idleTimeoutMs - (Date.now() - readStoredActivity());
              const countdown = document.getElementById('session-idle-countdown');
              if (countdown) countdown.textContent = formatRemaining(currentRemaining);
              if (currentRemaining <= 0) {
                expireSession(`You were signed out after ${Math.round(idleTimeoutMs / 60000)} minutes of inactivity.`);
              }
            };
            updateCountdown();
            sessionWarningTimerRef.current = setInterval(updateCountdown, 1000);
          },
          willClose: () => {
            if (sessionWarningTimerRef.current) {
              clearInterval(sessionWarningTimerRef.current);
              sessionWarningTimerRef.current = null;
            }
            sessionWarningOpenRef.current = false;
          },
          didClose: () => {
            const lastActivity = readStoredActivity();
            if (lastActivity > 0 && Date.now() - lastActivity >= idleTimeoutMs) {
              expireSession(`You were signed out after ${Math.round(idleTimeoutMs / 60000)} minutes of inactivity.`);
            }
          }
        });
      } catch (error) {
        sessionWarningOpenRef.current = false;
        return;
      }

      // Some SweetAlert2 builds return a thenable without a direct .catch().
      // Normalize it to a native Promise before attaching rejection handling.
      Promise.resolve(warningResult).catch(() => {
        closeSessionWarning();
      });
    };

    const sessionMeta = readStoredSessionMeta();
    const { idleTimeoutMs, warningMs } = readSessionTiming(sessionMeta);

    const checkSession = () => {
      const lastActivity = readStoredActivity();
      const idleElapsedMs = lastActivity > 0 ? Date.now() - lastActivity : 0;
      if (lastActivity > 0 && idleElapsedMs >= idleTimeoutMs) {
        expireSession(`You were signed out after ${Math.round(idleTimeoutMs / 60000)} minutes of inactivity.`);
        return;
      }
      const expiryMs = Number(sessionMeta?.absolute_expires_at_unix || 0) * 1000;
      if (expiryMs > 0 && Date.now() >= expiryMs) {
        expireSession('Your session expired. Please sign in again.');
        return;
      }
      if (lastActivity > 0 && idleTimeoutMs - idleElapsedMs <= warningMs) {
        showSessionWarning(idleTimeoutMs);
      }
    };

    if (!readStoredActivity()) {
      touchActivity(true);
    }
    checkSession();

    const activityEvents = ['mousedown', 'keydown', 'touchstart', 'scroll', 'focus'];
    const onActivity = () => {
      const previousActivity = readStoredActivity();
      if (previousActivity > 0 && Date.now() - previousActivity >= idleTimeoutMs) {
        expireSession(`You were signed out after ${Math.round(idleTimeoutMs / 60000)} minutes of inactivity.`);
        return;
      }
      if (sessionWarningOpenRef.current) {
        touchActivity(true);
        closeSessionWarning();
        syncServerActivity();
        return;
      }
      touchActivity();
      syncServerActivity();
    };
    const onStorage = (event) => {
      if (event.key === USER_STORAGE_KEY) {
        setUser(readStoredUser());
      }
      if (event.key === SESSION_META_STORAGE_KEY && !event.newValue) setUser(null);
      if (event.key === LAST_ACTIVITY_KEY) {
        lastTouchRef.current = Number(event.newValue || 0) || lastTouchRef.current;
        closeSessionWarning();
      }
    };
    const intervalId = setInterval(checkSession, 15000);
    let lastSyncedActivity = 0;
    let lastServerSyncAt = 0;
    let syncInProgress = false;
    const syncServerActivity = async () => {
      if (syncInProgress || expirationStarted) return;
      const currentActivity = readStoredActivity();
      if (!currentActivity || currentActivity <= lastSyncedActivity) return;
      if (Date.now() - currentActivity >= idleTimeoutMs) return;
      if (lastServerSyncAt > 0 && Date.now() - lastServerSyncAt < ACTIVITY_SYNC_INTERVAL_MS) return;

      syncInProgress = true;
      lastServerSyncAt = Date.now();
      try {
        await apiFetch('session-activity', { method: 'POST', body: '{}' });
        lastSyncedActivity = currentActivity;
      } catch (error) {
        if (error?.status === 401) {
          setUser(null);
          clearSession();
        }
      } finally {
        syncInProgress = false;
      }
    };
    syncServerActivity();
    const activitySyncId = setInterval(syncServerActivity, ACTIVITY_SYNC_INTERVAL_MS);

    activityEvents.forEach((eventName) => window.addEventListener(eventName, onActivity, { passive: true }));
    window.addEventListener('storage', onStorage);

    return () => {
      clearInterval(intervalId);
      clearInterval(activitySyncId);
      closeSessionWarning();
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, onActivity, { passive: true }));
      window.removeEventListener('storage', onStorage);
    };
  }, [user, touchActivity, clearSession]);

  return (
    <AuthContext.Provider value={{ user, login, logout, updateUser, touchActivity, authReady, authError, refreshAuthenticatedUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export { AuthContext, AuthProvider };
