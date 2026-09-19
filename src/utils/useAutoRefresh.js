import React from 'react';

export const AUTO_REFRESH_INTERVALS = Object.freeze({
  LIVE: 5000,
  WORKFLOW: 10000,
  ADMIN: 15000,
  HEAVY: 30000,
  REPORT: 5 * 60 * 1000,
});

/**
 * Runs a page-owned data loader without reloading or remounting the page.
 * The latest refresh callback is kept in a ref so pages do not need to
 * recreate their timer whenever local filter state changes.
 */
export default function useAutoRefresh({
  refresh,
  intervalMs,
  enabled = true,
  refreshOnFocus = true,
  refreshOnReconnect = true,
} = {}) {
  const refreshRef = React.useRef(refresh);
  const inFlightRef = React.useRef(false);
  const mountedRef = React.useRef(true);
  const enabledRef = React.useRef(Boolean(enabled));

  React.useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    const wasEnabled = enabledRef.current;
    enabledRef.current = Boolean(enabled);
    if (!enabled || typeof refreshRef.current !== 'function') return undefined;

    let timerId = null;

    const canRefresh = () => (
      mountedRef.current
      && enabled
      && (typeof document === 'undefined' || document.visibilityState === 'visible')
      && (typeof navigator === 'undefined' || navigator.onLine !== false)
      && (typeof localStorage === 'undefined' || Boolean(localStorage.getItem('user')))
    );

    const runRefresh = async () => {
      if (!canRefresh() || inFlightRef.current || typeof refreshRef.current !== 'function') return;
      inFlightRef.current = true;
      try {
        await refreshRef.current();
      } catch {
        // Scheduled refresh failures are intentionally silent. Page-owned
        // loaders retain their current data and normal user actions still
        // surface errors through their existing UI.
      } finally {
        inFlightRef.current = false;
      }
    };

    const onFocus = () => {
      if (refreshOnFocus) runRefresh();
    };
    const onVisibilityChange = () => {
      if (refreshOnFocus && document.visibilityState === 'visible') runRefresh();
    };
    const onOnline = () => {
      if (refreshOnReconnect) runRefresh();
    };

    const delay = Math.max(1000, Number(intervalMs) || AUTO_REFRESH_INTERVALS.ADMIN);
    timerId = window.setInterval(runRefresh, delay);
    if (!wasEnabled) Promise.resolve().then(runRefresh);
    if (refreshOnFocus) {
      window.addEventListener('focus', onFocus);
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    if (refreshOnReconnect) window.addEventListener('online', onOnline);

    return () => {
      if (timerId !== null) window.clearInterval(timerId);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onOnline);
    };
  }, [enabled, intervalMs, refreshOnFocus, refreshOnReconnect]);
}
