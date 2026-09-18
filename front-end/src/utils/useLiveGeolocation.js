import React from 'react';

const DEFAULT_CURRENT_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 4000 };
const DEFAULT_WATCH_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 6000 };
const DEFAULT_POLL_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 2000 };

export function useLiveGeolocation({
  onPosition,
  onError,
  pollIntervalMs = 800,
  currentOptions = DEFAULT_CURRENT_OPTIONS,
  watchOptions = DEFAULT_WATCH_OPTIONS,
  pollOptions = DEFAULT_POLL_OPTIONS
} = {}) {
  const [active, setActive] = React.useState(false);
  const watchIdRef = React.useRef(null);
  const pollIdRef = React.useRef(null);
  const activeRef = React.useRef(false);
  const sessionRef = React.useRef(0);
  const onPositionRef = React.useRef(onPosition);
  const onErrorRef = React.useRef(onError);

  React.useEffect(() => {
    onPositionRef.current = onPosition;
  }, [onPosition]);

  React.useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const stop = React.useCallback(() => {
    sessionRef.current += 1;
    if (watchIdRef.current != null && typeof navigator !== 'undefined' && navigator.geolocation) {
      try { navigator.geolocation.clearWatch(watchIdRef.current); } catch (e) { /* ignore cleanup errors */ }
    }
    if (pollIdRef.current != null) {
      try { clearInterval(pollIdRef.current); } catch (e) { /* ignore cleanup errors */ }
    }
    watchIdRef.current = null;
    pollIdRef.current = null;
    activeRef.current = false;
    setActive(false);
  }, []);

  const isCurrentSession = React.useCallback((sessionId) => (
    sessionId == null || (activeRef.current && sessionRef.current === sessionId)
  ), []);

  const reportError = React.useCallback((err, fallbackMessage, sessionId = null) => {
    if (!isCurrentSession(sessionId)) return;
    const message = err?.message || fallbackMessage || 'Failed to read GPS position';
    if (typeof onErrorRef.current === 'function') onErrorRef.current(message, err);
    if (err?.code === 1) stop();
  }, [isCurrentSession, stop]);

  const pushPosition = React.useCallback((pos, sessionId = null) => {
    if (!isCurrentSession(sessionId)) return;
    const coords = pos?.coords || {};
    if (typeof onPositionRef.current === 'function') onPositionRef.current(coords);
  }, [isCurrentSession]);

  const pollCurrentPosition = React.useCallback((sessionId) => {
    if (!isCurrentSession(sessionId) || typeof navigator === 'undefined' || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => pushPosition(pos, sessionId),
      (err) => {
        if (err?.code === 1) reportError(err, 'GPS permission was denied', sessionId);
      },
      pollOptions
    );
  }, [isCurrentSession, pollOptions, pushPosition, reportError]);

  const start = React.useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reportError(null, 'Geolocation is not supported in this browser');
      return false;
    }
    if (activeRef.current) return true;

    try {
      const sessionId = sessionRef.current + 1;
      sessionRef.current = sessionId;
      activeRef.current = true;
      setActive(true);

      navigator.geolocation.getCurrentPosition(
        (pos) => pushPosition(pos, sessionId),
        (err) => {
          if (err?.code === 1) reportError(err, 'GPS permission was denied', sessionId);
        },
        currentOptions
      );

      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => pushPosition(pos, sessionId),
        (err) => reportError(err, 'Failed to watch GPS position', sessionId),
        watchOptions
      );

      pollIdRef.current = setInterval(() => pollCurrentPosition(sessionId), pollIntervalMs);
      return true;
    } catch (err) {
      stop();
      reportError(err, 'Failed to start GPS');
      return false;
    }
  }, [currentOptions, pollCurrentPosition, pollIntervalMs, pushPosition, reportError, stop, watchOptions]);

  React.useEffect(() => stop, [stop]);

  return { active, start, stop };
}
