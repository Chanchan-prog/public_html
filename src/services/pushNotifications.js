import { apiFetch, apiGet, apiPost } from './api.js';

// Change the worker URL when its notification behavior changes so mobile
// Chrome installs the corrected worker immediately instead of retaining a
// cached copy until its normal update interval.
const WORKER_FILE = 'push-sw.js?v=3';
const LOGOUT_CLEANUP_TIMEOUT_MS = 2000;
const PUSH_ENDPOINT_STORAGE_KEY = 'push_subscription_endpoint';
const PUSH_NOTICE_STORAGE_PREFIX = 'push_status_notice';
let syncInFlight = null;

function settleWithin(promise, timeoutMs = LOGOUT_CLEANUP_TIMEOUT_MS, fallback = null) {
  return new Promise((resolve) => {
    let settled = false;
    const timerId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);

    Promise.resolve(promise).then((value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timerId);
      resolve(value);
    }).catch(() => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timerId);
      resolve(fallback);
    });
  });
}

function supportsPush() {
  return typeof window !== 'undefined'
    && window.isSecureContext
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

function workerUrl() {
  return new URL(WORKER_FILE, document.baseURI || window.location.href).href;
}

function base64UrlToUint8Array(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map(char => char.charCodeAt(0)));
}

async function registerPushWorker() {
  if (!supportsPush()) return null;
  return navigator.serviceWorker.register(workerUrl(), { updateViaCache: 'none' });
}

function dispatchPushStatus(status) {
  try {
    window.dispatchEvent(new CustomEvent('push-notification-status-changed', { detail: status }));
  } catch (e) {}
  return status;
}

function rememberPushEndpoint(endpoint) {
  try {
    if (endpoint) localStorage.setItem(PUSH_ENDPOINT_STORAGE_KEY, String(endpoint));
    else localStorage.removeItem(PUSH_ENDPOINT_STORAGE_KEY);
  } catch (e) {}
}

function getRememberedPushEndpoint() {
  try { return String(localStorage.getItem(PUSH_ENDPOINT_STORAGE_KEY) || ''); }
  catch (e) { return ''; }
}

function pushNoticeSessionKey(kind) {
  let userId = 'unknown';
  let sessionExpiry = 'current';
  try {
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    userId = String(user?.user_id || user?.id || user?.userId || 'unknown');
    const session = JSON.parse(localStorage.getItem('session_meta') || 'null');
    sessionExpiry = String(session?.absolute_expires_at_unix || 'current');
  } catch (e) {}
  return `${PUSH_NOTICE_STORAGE_PREFIX}:${userId}:${sessionExpiry}:${kind}`;
}

function shouldShowPushNotice(kind, once) {
  if (!once) return true;
  try {
    const groupedKind = ['disconnected', 'verification-failed'].includes(kind) ? 'connection-problem' : kind;
    const key = pushNoticeSessionKey(groupedKind);
    if (sessionStorage.getItem(key) === '1') return false;
    sessionStorage.setItem(key, '1');
  } catch (e) {}
  return true;
}

function pushErrorMessage(error, fallback) {
  return String(error?.body?.message || error?.message || fallback || 'Background alerts could not be updated.');
}

async function showPushStatusSweetAlert(kind, { message = '', once = true } = {}) {
  if (typeof window === 'undefined' || !window.Swal || typeof window.Swal.fire !== 'function') return null;
  if (!shouldShowPushNotice(kind, once)) return null;

  const retrySync = async (requestPermission = false) => {
    try {
      const status = await syncPushSubscription({ requestPermission });
      if (!status?.enabled) throw new Error('The server did not confirm this device.');
      return status;
    } catch (error) {
      if (window.Swal && typeof window.Swal.showValidationMessage === 'function') {
        window.Swal.showValidationMessage(pushErrorMessage(error, 'Unable to connect background alerts.'));
      }
      return false;
    }
  };

  if (kind === 'restored') {
    return window.Swal.fire({
      toast: true,
      position: 'top-end',
      icon: 'success',
      title: 'Background alerts restored',
      showConfirmButton: false,
      timer: 2600,
      timerProgressBar: true,
    });
  }

  if (kind === 'disabled') {
    return window.Swal.fire({
      toast: true,
      position: 'top-end',
      icon: 'success',
      title: 'Background alerts turned off',
      showConfirmButton: false,
      timer: 2400,
      timerProgressBar: true,
    });
  }

  if (kind === 'permission-required') {
    const result = await window.Swal.fire({
      icon: 'info',
      title: 'Background Alerts Are Off',
      text: 'Enable alerts to receive updates while this website is closed.',
      showCancelButton: true,
      confirmButtonText: 'Enable Alerts',
      cancelButtonText: 'Not Now',
      confirmButtonColor: '#198754',
      showLoaderOnConfirm: true,
      allowOutsideClick: () => !window.Swal.isLoading(),
      preConfirm: () => retrySync(true),
    });
    if (result?.isConfirmed && result.value?.enabled) {
      return showPushStatusSweetAlert('restored', { once: false });
    }
    return result;
  }

  if (kind === 'blocked') {
    return window.Swal.fire({
      icon: 'warning',
      title: 'Notifications Are Blocked',
      text: 'Allow notifications for this website through your browser settings, then select Enable Alerts again.',
      confirmButtonText: 'Okay',
      confirmButtonColor: '#198754',
    });
  }

  if (kind === 'offline') {
    return window.Swal.fire({
      icon: 'info',
      title: 'Alerts Temporarily Offline',
      text: 'Background alerts will reconnect automatically when your internet connection returns.',
      confirmButtonText: 'Okay',
      confirmButtonColor: '#198754',
    });
  }

  if (kind === 'unsupported') {
    return window.Swal.fire({
      icon: 'warning',
      title: 'Background Alerts Unavailable',
      text: 'This browser or connection does not support background alerts. Use HTTPS in production.',
      confirmButtonText: 'Okay',
      confirmButtonColor: '#198754',
    });
  }

  const disconnected = kind === 'disconnected';
  const result = await window.Swal.fire({
    icon: 'warning',
    title: disconnected ? 'Background Alerts Disconnected' : 'Unable to Verify Alerts',
    text: message || (disconnected
      ? 'This device is no longer connected to background alerts.'
      : 'The server could not verify this device. Background alerts may not arrive.'),
    showCancelButton: true,
    confirmButtonText: disconnected ? 'Reconnect' : 'Retry',
    cancelButtonText: 'Later',
    confirmButtonColor: '#198754',
    showLoaderOnConfirm: true,
    allowOutsideClick: () => !window.Swal.isLoading(),
    preConfirm: () => retrySync(false),
  });
  if (result?.isConfirmed && result.value?.enabled) {
    return showPushStatusSweetAlert('restored', { once: false });
  }
  return result;
}

async function getPushNotificationStatus({ verifyServer = true } = {}) {
  if (!supportsPush()) {
    return { supported: false, enabled: false, permission: 'unsupported' };
  }
  const registration = await registerPushWorker();
  const subscription = await registration.pushManager.getSubscription();
  const browserSubscribed = Notification.permission === 'granted' && Boolean(subscription);
  const baseStatus = {
    supported: true,
    enabled: false,
    permission: Notification.permission,
    subscription,
    browserSubscribed,
    serverRegistered: false,
  };

  if (!browserSubscribed) {
    rememberPushEndpoint('');
    return baseStatus;
  }

  rememberPushEndpoint(subscription.endpoint);
  if (!verifyServer || !localStorage.getItem('user')) {
    return baseStatus;
  }

  try {
    const serverStatus = await apiPost('notification/push-subscription-status', {
      endpoint: subscription.endpoint,
    });
    const serverRegistered = Boolean(serverStatus?.registered);
    return {
      ...baseStatus,
      enabled: serverRegistered,
      serverRegistered,
      needsSync: !serverRegistered,
    };
  } catch (error) {
    return {
      ...baseStatus,
      verificationFailed: true,
      needsSync: true,
      syncError: error?.body?.message || error?.message || 'The alert subscription could not be verified.',
    };
  }
}

async function performPushSubscriptionSync({ requestPermission = false } = {}) {
  if (!supportsPush()) throw new Error('Background notifications are not supported by this browser or connection.');
  if (requestPermission && Notification.permission === 'default') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notification permission was not granted.');
  }
  if (Notification.permission !== 'granted') {
    return { supported: true, enabled: false, permission: Notification.permission };
  }

  const registration = await registerPushWorker();
  const config = await apiGet('notification/push-config');
  if (!config?.enabled || !config?.public_key) throw new Error('Background notifications are not configured on the server.');

  let subscription = await registration.pushManager.getSubscription();
  const expectedKey = base64UrlToUint8Array(config.public_key);
  if (subscription) {
    const currentKey = subscription.options?.applicationServerKey;
    const bytes = currentKey ? new Uint8Array(currentKey) : null;
    const matches = bytes && bytes.length === expectedKey.length && bytes.every((value, index) => value === expectedKey[index]);
    if (!matches) {
      const oldEndpoint = subscription.endpoint;
      if (!await subscription.unsubscribe()) throw new Error('Please disable and re-enable notifications to renew the subscription.');
      await apiFetch('notification/push-subscription', { method:'DELETE', body:JSON.stringify({endpoint:oldEndpoint}) }).catch(() => null);
      subscription = null;
    }
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: expectedKey,
    });
  }
  await apiPost('notification/push-subscription', {
    subscription: subscription.toJSON(),
    user_agent: navigator.userAgent || '',
  });
  const serverStatus = await apiPost('notification/push-subscription-status', {
    endpoint: subscription.endpoint,
  });
  if (!serverStatus?.registered) {
    throw new Error('The server did not confirm this background alert subscription. Please retry.');
  }
  rememberPushEndpoint(subscription.endpoint);
  return dispatchPushStatus({
    supported: true,
    enabled: true,
    permission: Notification.permission,
    subscription,
    browserSubscribed: true,
    serverRegistered: true,
    needsSync: false,
  });
}

function syncPushSubscription(options = {}) {
  if (syncInFlight) return syncInFlight;
  const currentSync = performPushSubscriptionSync(options);
  syncInFlight = currentSync;
  currentSync.finally(() => {
    if (syncInFlight === currentSync) syncInFlight = null;
  }).catch(() => {});
  return currentSync;
}

async function disablePushNotifications({ unsubscribe = false } = {}) {
  if (!('serviceWorker' in navigator)) return { enabled: false };
  const hadAuthenticatedUser = Boolean(localStorage.getItem('user'));
  const registration = await settleWithin(navigator.serviceWorker.getRegistration(workerUrl()))
    || await settleWithin(navigator.serviceWorker.getRegistration());
  const subscription = registration
    ? await settleWithin(registration.pushManager.getSubscription())
    : null;
  const endpoint = subscription?.endpoint || '';

  try {
    if (hadAuthenticatedUser) {
      await settleWithin(apiFetch('notification/push-subscription', {
        method: 'DELETE',
        body: endpoint ? JSON.stringify({ endpoint }) : undefined,
      }));
    }
  } finally {
    if (unsubscribe && subscription) await settleWithin(subscription.unsubscribe(), LOGOUT_CLEANUP_TIMEOUT_MS, false);
  }
  if (unsubscribe) rememberPushEndpoint('');
  return dispatchPushStatus({
    supported: supportsPush(),
    enabled: false,
    permission: Notification.permission,
    browserSubscribed: unsubscribe ? false : Boolean(subscription),
    serverRegistered: false,
  });
}

async function initializePushForSignedInUser() {
  if (!localStorage.getItem('user')) {
    const status = await getPushNotificationStatus({ verifyServer: false });
    return dispatchPushStatus({ ...status, enabled: false, serverRegistered: false });
  }
  if (!supportsPush()) {
    const status = { supported: false, enabled: false, permission: 'unsupported', serverRegistered: false };
    dispatchPushStatus(status);
    return status;
  }
  if (Notification.permission === 'granted') {
    try {
      const status = await syncPushSubscription();
      return status;
    } catch (error) {
      console.warn('[web_push] subscription sync failed', error);
      const localStatus = await getPushNotificationStatus({ verifyServer: false }).catch(() => ({
        supported: supportsPush(),
        permission: Notification.permission,
      }));
      const failedStatus = {
        ...localStatus,
        enabled: false,
        serverRegistered: false,
        needsSync: true,
        syncError: error?.body?.message || error?.message || 'Background alerts could not reconnect.',
      };
      dispatchPushStatus(failedStatus);
      throw error;
    }
  }
  const status = dispatchPushStatus({
    supported: true,
    enabled: false,
    permission: Notification.permission,
    browserSubscribed: false,
    serverRegistered: false,
  });
  return status;
}

export {
  supportsPush,
  registerPushWorker,
  getPushNotificationStatus,
  syncPushSubscription,
  disablePushNotifications,
  initializePushForSignedInUser,
  getRememberedPushEndpoint,
  dispatchPushStatus,
  showPushStatusSweetAlert,
};
