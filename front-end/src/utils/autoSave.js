/**
 * Auto-Save / Recoverability Utility
 * 
 * Provides form state persistence to localStorage so that if a user
 * accidentally closes the browser, refreshes, or experiences a network
 * interruption, their form data can be recovered.
 * 
 * Usage:
 *   import { useAutoSave, useFormRecovery } from '../../utils/autoSave.js';
 *   
 *   // In your component:
 *   const { savedData, saveForm, clearSavedForm } = useAutoSave('my-form-key');
 *   const { recoverForm, hasRecoveredData } = useFormRecovery('my-form-key');
 */

import React from 'react';

const AUTOSAVE_PREFIX = 'autosave_';

/**
 * Hook: useAutoSave
 * Automatically saves form data to localStorage on changes.
 * 
 * @param {string} formKey - Unique identifier for the form
 * @param {object} options - Configuration options
 * @param {number} options.debounceMs - Debounce delay in ms (default: 1000)
 * @param {boolean} options.enabled - Enable/disable auto-save (default: true)
 * @returns {object} { savedData, saveForm, clearSavedForm, lastSaved }
 */
export function useAutoSave(formKey, options = {}) {
  const { debounceMs = 1000, enabled = true } = options;
  const storageKey = AUTOSAVE_PREFIX + formKey;
  const [lastSaved, setLastSaved] = React.useState(null);
  const debounceRef = React.useRef(null);

  // Load any previously saved data
  const savedData = React.useMemo(() => {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }, [storageKey]);

  // Save form data with debounce
  const saveForm = React.useCallback((data) => {
    if (!enabled || typeof localStorage === 'undefined') return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      try {
        const payload = {
          data,
          timestamp: Date.now(),
          savedAt: new Date().toISOString()
        };
        localStorage.setItem(storageKey, JSON.stringify(payload));
        setLastSaved(Date.now());
      } catch (e) {
        // localStorage might be full; silently fail
        console.warn('[autoSave] Failed to save form data:', e);
      }
    }, debounceMs);
  }, [storageKey, debounceMs, enabled]);

  // Clear saved form data
  const clearSavedForm = React.useCallback(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.removeItem(storageKey);
      setLastSaved(null);
    } catch (e) {}
  }, [storageKey]);

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return { savedData, saveForm, clearSavedForm, lastSaved };
}

/**
 * Hook: useFormRecovery
 * Checks for and offers to recover previously saved form data.
 * 
 * @param {string} formKey - Unique identifier for the form
 * @returns {object} { recoverForm, hasRecoveredData, recoveredData, dismissRecovery }
 */
export function useFormRecovery(formKey) {
  const storageKey = AUTOSAVE_PREFIX + formKey;
  const [recoveredData, setRecoveredData] = React.useState(null);
  const [dismissed, setDismissed] = React.useState(false);

  // Check for recoverable data on mount
  React.useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.data) {
          setRecoveredData(parsed);
        }
      }
    } catch (e) {}
  }, [storageKey]);

  const hasRecoveredData = recoveredData !== null && !dismissed;

  const recoverForm = React.useCallback(() => {
    if (!recoveredData) return null;
    // Clear the saved data after recovery
    try { localStorage.removeItem(storageKey); } catch (e) {}
    setDismissed(true);
    return recoveredData.data;
  }, [recoveredData, storageKey]);

  const dismissRecovery = React.useCallback(() => {
    setDismissed(true);
  }, []);

  return { recoverForm, hasRecoveredData, recoveredData, dismissRecovery };
}

/**
 * Hook: useNetworkStatus
 * Monitors network connectivity and provides status.
 * 
 * @returns {object} { isOnline, wasOffline, connectionType }
 */
export function useNetworkStatus() {
  const [isOnline, setIsOnline] = React.useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [wasOffline, setWasOffline] = React.useState(false);

  React.useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      setWasOffline(true);
      // Reset the "was offline" flag after 3 seconds
      setTimeout(() => setWasOffline(false), 3000);
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const connectionType = typeof navigator !== 'undefined' && navigator.connection
    ? navigator.connection.effectiveType || 'unknown'
    : 'unknown';

  return { isOnline, wasOffline, connectionType };
}

/**
 * Component: AutoSaveIndicator
 * Shows a small indicator that form data is being auto-saved.
 */
export function AutoSaveIndicator({ lastSaved, isSaving }) {
  if (!lastSaved && !isSaving) return null;

  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px',
      fontSize: '0.75rem', color: '#666', padding: '4px 8px',
      background: '#f5f5f5', borderRadius: '4px'
    }}>
      {isSaving ? (
        <>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#fbbc04', display: 'inline-block' }}></span>
          Saving...
        </>
      ) : lastSaved ? (
        <>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#34a853', display: 'inline-block' }}></span>
          Saved {new Date(lastSaved).toLocaleTimeString()}
        </>
      ) : null}
    </div>
  );
}

/**
 * Component: RecoverDataBanner
 * Shows a banner offering to recover previously saved form data.
 */
export function RecoverDataBanner({ hasRecoveredData, recoveredData, onRecover, onDismiss }) {
  if (!hasRecoveredData || !recoveredData) return null;

  const timeAgo = recoveredData.timestamp
    ? Math.round((Date.now() - recoveredData.timestamp) / 60000)
    : null;

  return (
    <div style={{
      padding: '12px 16px', marginBottom: '15px',
      background: '#fef7e0', border: '1px solid #f9a825',
      borderRadius: '6px', display: 'flex',
      justifyContent: 'space-between', alignItems: 'center',
      flexWrap: 'wrap', gap: '10px'
    }}>
      <div>
        <i className="bi bi-arrow-counterclockwise" style={{ marginRight: '8px', color: '#e37400' }}></i>
        <strong>Unsaved form data found</strong>
        {timeAgo !== null && <span style={{ color: '#666', fontSize: '0.85rem', marginLeft: '5px' }}>
          (saved {timeAgo < 1 ? 'just now' : `${timeAgo} min ago`})
        </span>}
        <p style={{ margin: '4px 0 0 0', fontSize: '0.85rem', color: '#666' }}>
          It looks like you had unsaved changes. Would you like to restore them?
        </p>
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button onClick={onRecover}
          style={{ padding: '6px 16px', background: '#f9a825', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 500 }}>
          <i className="bi bi-arrow-counterclockwise" style={{ marginRight: '4px' }}></i>Restore
        </button>
        <button onClick={onDismiss}
          style={{ padding: '6px 16px', background: '#fff', color: '#666', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer' }}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * Component: NetworkStatusBanner
 * Shows a banner when the user goes offline or comes back online.
 */
export function NetworkStatusBanner({ isOnline, wasOffline }) {
  const [visible, setVisible] = React.useState(false);
  const [message, setMessage] = React.useState('');

  React.useEffect(() => {
    if (!isOnline) {
      setMessage('You are offline. Changes will be saved locally and synced when you reconnect.');
      setVisible(true);
    } else if (wasOffline) {
      setMessage('Connection restored. Your data is being synced.');
      setVisible(true);
      const timer = setTimeout(() => setVisible(false), 4000);
      return () => clearTimeout(timer);
    }
  }, [isOnline, wasOffline]);

  if (!visible) return null;

  return (
    <div style={{
      padding: '10px 16px', marginBottom: '15px', borderRadius: '6px',
      display: 'flex', alignItems: 'center', gap: '8px',
      background: isOnline ? '#e6f4ea' : '#fce8e6',
      border: `1px solid ${isOnline ? '#34a853' : '#c5221f'}`,
      color: isOnline ? '#137333' : '#c5221f',
      fontSize: '0.85rem'
    }}>
      <i className={`bi bi-${isOnline ? 'wifi' : 'wifi-off'}`}></i>
      {message}
    </div>
  );
}

export default { useAutoSave, useFormRecovery, useNetworkStatus, AutoSaveIndicator, RecoverDataBanner, NetworkStatusBanner };