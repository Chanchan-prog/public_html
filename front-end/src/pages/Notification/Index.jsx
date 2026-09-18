import React from 'react';
import { apiGet, apiPut } from '../../services/api.js';
import Modal from '../../components/Modal.jsx';
import { MasterPageHeader, MasterStats, MasterToolbar, MasterSearch, MasterResults, MasterSelect } from '../../components/MasterDataPage.jsx';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';
import {
  disablePushNotifications,
  getPushNotificationStatus,
  showPushStatusSweetAlert,
  syncPushSubscription,
} from '../../services/pushNotifications.js';

const NOTIFICATIONS_PER_PAGE = 10;

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatNotificationTime(value) {
  if (!value) return '';
  const date = new Date(String(value).replace(' ', 'T'));
  if (!date || Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatNotificationAge(value) {
  if (!value) return '';
  const date = new Date(String(value).replace(' ', 'T'));
  if (!date || Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60 * 1000) return 'Just now';
  const mins = Math.floor(diffMs / (60 * 1000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function normalizeNotificationLink(rawLink) {
  const raw = String(rawLink || '').trim();
  if (!raw) return '';
  if (raw.startsWith('#/')) return raw.slice(1);
  if (raw.startsWith('/')) return raw;
  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.origin !== window.location.origin) return '';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch (e) {
    return raw.startsWith('/') ? raw : `/${raw}`;
  }
}

function getInitials(name) {
  const parts = cleanText(name).split(' ').filter(Boolean);
  if (parts.length === 0) return 'N';
  return parts.slice(0, 2).map(part => part.charAt(0).toUpperCase()).join('');
}

function notificationIdFromHash() {
  const hash = String(window.location.hash || '');
  const queryIndex = hash.indexOf('?');
  if (queryIndex < 0) return 0;
  const params = new URLSearchParams(hash.slice(queryIndex + 1));
  return Number(params.get('notif_id') || params.get('notification_id') || 0);
}

export default function NotificationIndex() {
  const [notifications, setNotifications] = React.useState([]);
  const [unreadCount, setUnreadCount] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [actioning, setActioning] = React.useState(false);
  const [statusFilter, setStatusFilter] = React.useState('all');
  const [query, setQuery] = React.useState('');
  const [debouncedQuery, setDebouncedQuery] = React.useState('');
  const [currentPage, setCurrentPage] = React.useState(1);
  const [notificationPagination, setNotificationPagination] = React.useState({ page: 1, page_size: NOTIFICATIONS_PER_PAGE, total: 0, total_pages: 1 });
  const [notificationCounts, setNotificationCounts] = React.useState({ total: 0, unread: 0, read: 0 });
  const [error, setError] = React.useState('');
  const [targetNotificationId, setTargetNotificationId] = React.useState(() => notificationIdFromHash());
  const [selectedNotification, setSelectedNotification] = React.useState(null);
  const [pushStatus, setPushStatus] = React.useState({ supported: true, enabled: false, permission: 'default' });
  const [pushActioning, setPushActioning] = React.useState(false);
  const [pushMessage, setPushMessage] = React.useState('');
  const handledNotificationRef = React.useRef(0);
  const notificationRequestRef = React.useRef(0);

  const loadNotifications = React.useCallback(async ({ silent = false, manual = false } = {}) => {
    const requestId = ++notificationRequestRef.current;
    if (manual) setRefreshing(true);
    else if (!silent) setLoading(true);
    if (!silent) setError('');
    try {
      const params = new URLSearchParams({
        paginate: '1',
        page: String(currentPage),
        page_size: String(NOTIFICATIONS_PER_PAGE),
        include_hidden: '1',
        status: statusFilter,
      });
      if (debouncedQuery) params.set('search', debouncedQuery);
      const payload = await apiGet(`notification?${params.toString()}`);
      if (requestId !== notificationRequestRef.current) return;
      const list = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.notifications) ? payload.notifications : []);
      setNotifications(list);
      const counts = payload?.counts || {
        total: list.length,
        unread: Number(payload?.unread_count || list.filter(n => Number(n?.is_read || 0) === 0).length || 0),
        read: list.filter(n => Number(n?.is_read || 0) !== 0).length,
      };
      const pagination = payload?.pagination || { page: 1, page_size: NOTIFICATIONS_PER_PAGE, total: list.length, total_pages: 1 };
      setNotificationCounts(counts);
      setUnreadCount(Number(counts.unread || 0));
      setNotificationPagination(pagination);
      if (Number(pagination.page || 1) !== Number(currentPage)) setCurrentPage(Number(pagination.page || 1));
      setError('');
    } catch (err) {
      if (requestId !== notificationRequestRef.current) return;
      if (!silent) setError(err?.body?.message || err?.message || 'Failed to load notifications.');
    } finally {
      if (requestId === notificationRequestRef.current) {
        if (manual) setRefreshing(false);
        else if (!silent) setLoading(false);
      }
    }
  }, [currentPage, statusFilter, debouncedQuery]);

  React.useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setCurrentPage(1);
      setDebouncedQuery(query.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  React.useEffect(() => {
    getPushNotificationStatus()
      .then((next) => {
        setPushStatus(next);
        if (next?.verificationFailed) {
          setPushMessage('Alerts need attention. The server could not verify this device; select Enable Alerts to retry.');
        } else if (next?.needsSync) {
          setPushMessage('Alerts need attention. Select Enable Alerts to reconnect this device.');
        }
      })
      .catch(() => setPushStatus({ supported: false, enabled: false, permission: 'unsupported' }));
  }, []);

  React.useEffect(() => {
    const syncPushStatus = (event) => {
      if (!event?.detail) return;
      setPushStatus(event.detail);
      if (event.detail.syncError) setPushMessage(`Alerts need attention: ${event.detail.syncError}`);
      else if (event.detail.enabled) setPushMessage('Background notifications are enabled on this device.');
      else if (event.detail.needsSync) setPushMessage('Alerts need attention. Select Enable Alerts to reconnect this device.');
      else if (event.detail.permission === 'denied') setPushMessage('Notifications are blocked in your browser settings.');
      else setPushMessage('Background notifications are disabled on this device.');
    };
    window.addEventListener('push-notification-status-changed', syncPushStatus);
    return () => window.removeEventListener('push-notification-status-changed', syncPushStatus);
  }, []);

  const toggleBackgroundNotifications = async () => {
    if (pushActioning) return;
    setPushActioning(true);
    setPushMessage('');
    try {
      if (pushStatus.enabled) {
        const next = await disablePushNotifications({ unsubscribe: true });
        setPushStatus(next);
        try { window.dispatchEvent(new CustomEvent('push-notification-status-changed', { detail: next })); } catch (e) {}
        setPushMessage('Background notifications are disabled on this device.');
        await showPushStatusSweetAlert('disabled', { once: false });
      } else {
        await syncPushSubscription({ requestPermission: true });
        const next = await getPushNotificationStatus();
        if (!next?.enabled) throw new Error('The server could not verify this device. Please retry.');
        setPushStatus(next);
        try { window.dispatchEvent(new CustomEvent('push-notification-status-changed', { detail: next })); } catch (e) {}
        setPushMessage(next?.enabled
          ? 'Background notifications are enabled on this device.'
          : 'Notification permission is allowed, but the background subscription is not active yet.');
        await showPushStatusSweetAlert('restored', { once: false });
      }
    } catch (error) {
      const denied = typeof Notification !== 'undefined' && Notification.permission === 'denied';
      const checked = await getPushNotificationStatus().catch(() => null);
      setPushStatus(previous => ({
        ...previous,
        ...(checked || {}),
        enabled: false,
        permission: denied ? 'denied' : (checked?.permission || previous.permission),
      }));
      setPushMessage(denied
        ? 'Notifications are blocked in your browser settings. Allow them for this website and try again.'
        : `Alerts need attention: ${error?.body?.message || error?.message || 'Background notifications could not be updated.'}`);
      await showPushStatusSweetAlert(
        denied ? 'blocked' : (navigator.onLine === false ? 'offline' : 'verification-failed'),
        { message: error?.body?.message || error?.message || '', once: false }
      );
    } finally {
      setPushActioning(false);
    }
  };

  React.useEffect(() => {
    const syncTarget = () => {
      const nextId = notificationIdFromHash();
      setTargetNotificationId(nextId);
      if (nextId !== handledNotificationRef.current) handledNotificationRef.current = 0;
    };
    window.addEventListener('hashchange', syncTarget);
    return () => window.removeEventListener('hashchange', syncTarget);
  }, []);

  useAutoRefresh({
    refresh: () => loadNotifications({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.LIVE,
    enabled: !actioning,
  });

  const readCount = Number(notificationCounts.read || 0);
  const visibleNotifications = notifications;
  const totalPages = Math.max(1, Number(notificationPagination.total_pages || 1));
  const safeCurrentPage = Math.min(Math.max(1, Number(notificationPagination.page || currentPage)), totalPages);
  const pageStart = (safeCurrentPage - 1) * NOTIFICATIONS_PER_PAGE;
  const paginatedNotifications = visibleNotifications;

  React.useEffect(() => {
    setCurrentPage(1);
  }, [statusFilter, query]);

  React.useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  const markRead = async (notifId) => {
    if (!notifId) return;
    setNotifications(prev => prev.map(n => Number(n?.notif_id) === Number(notifId) ? { ...n, is_read: 1 } : n));
    setUnreadCount(prev => Math.max(0, Number(prev || 0) - 1));
    setNotificationCounts(prev => ({ ...prev, unread: Math.max(0, Number(prev.unread || 0) - 1), read: Number(prev.read || 0) + 1 }));
    try {
      await apiPut(`notification/${notifId}`, {});
      await loadNotifications({ silent: true });
    } catch (err) {
      await loadNotifications({ silent: true });
    }
  };

  const markAllRead = async () => {
    if (!unreadCount || actioning) return;
    setActioning(true);
    setNotifications(prev => prev.map(n => ({ ...n, is_read: 1 })));
    setUnreadCount(0);
    setNotificationCounts(prev => ({ ...prev, unread: 0, read: Number(prev.total || 0) }));
    try {
      await apiPut('notification/read-all', {});
      await loadNotifications({ silent: true });
    } catch (err) {
      await loadNotifications({ silent: true });
    } finally {
      setActioning(false);
    }
  };

  React.useEffect(() => {
    if (loading || !targetNotificationId || handledNotificationRef.current === targetNotificationId) return;
    handledNotificationRef.current = targetNotificationId;
    const matched = notifications.find((notif) => Number(notif?.notif_id) === targetNotificationId);
    if (!matched) {
      apiGet(`notification/${targetNotificationId}`)
        .then((payload) => {
          const notification = payload?.notification || null;
          if (!notification) throw new Error('Notification not found.');
          const wasUnread = Number(notification?.is_read || 0) === 0;
          setSelectedNotification(wasUnread ? { ...notification, is_read: 1 } : notification);
          if (wasUnread) markRead(targetNotificationId);
        })
        .catch(() => setError('Notification not found or you do not have permission to view it.'));
      return;
    }
    const wasUnread = Number(matched?.is_read || 0) === 0;
    setSelectedNotification(wasUnread ? { ...matched, is_read: 1 } : matched);
    if (wasUnread) markRead(targetNotificationId);
  // markRead intentionally omitted to avoid reopening the modal after the optimistic state update.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, targetNotificationId, notifications]);

  const openNotification = async (notif) => {
    const notifId = Number(notif?.notif_id || 0);
    if (notifId && Number(notif?.is_read || 0) === 0) {
      await markRead(notifId);
    }
    const link = normalizeNotificationLink(notif?.link);
    if (link) {
      window.location.hash = `#${link.startsWith('/') ? link : `/${link}`}`;
      return;
    }
    setSelectedNotification({ ...notif, is_read: 1 });
  };

  const closeNotificationDetail = () => {
    setSelectedNotification(null);
    const hash = String(window.location.hash || '');
    const queryIndex = hash.indexOf('?');
    if (queryIndex < 0) return;
    const routePath = hash.slice(0, queryIndex);
    const params = new URLSearchParams(hash.slice(queryIndex + 1));
    params.delete('notif_id');
    params.delete('notification_id');
    const queryString = params.toString();
    window.location.hash = `${routePath}${queryString ? `?${queryString}` : ''}`;
  };

  const statCards = [
    { key: 'all', label: 'Total', value: Number(notificationCounts.total || 0), icon: 'N', help: 'Complete notification history', tone: 'blue' },
    { key: 'unread', label: 'Unread', value: unreadCount, icon: '!', help: 'Waiting for your review', tone: 'amber' },
    { key: 'read', label: 'Read', value: readCount, icon: '\u2713', help: 'Already reviewed', tone: 'green' },
  ];

  return (
    <div className="mdp-page notification-page">
        <MasterPageHeader eyebrow="Communication" title="Notifications" description="Review your complete notification history, including items cleared from the Navbar." action={
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={toggleBackgroundNotifications}
                  disabled={pushActioning || !pushStatus.supported}
                  title={!pushStatus.supported ? 'Requires HTTPS and a browser with Web Push support' : ''}
                  className="mdp-secondary"
                >
                  <i className={`bi ${pushStatus.enabled ? 'bi-bell-fill' : 'bi-bell'}`}></i>
                  {pushActioning ? 'Updating...' : pushStatus.enabled ? 'Alerts On' : 'Enable Alerts'}
                </button>
                <button
                  type="button"
                  onClick={() => loadNotifications({ manual: true })}
                  disabled={loading || refreshing}
                  className="mdp-secondary"
                >
                  <i className="bi bi-arrow-repeat"></i>
                  {refreshing ? 'Refreshing...' : 'Refresh'}
                </button>
                <button
                  type="button"
                  onClick={markAllRead}
                  disabled={!unreadCount || actioning}
                  className="mdp-primary"
                >
                  <i className="bi bi-check2-all"></i>
                  Mark All Read
                </button>
              </div>}
        />

        {(!pushStatus.supported || pushMessage) && (
              <div className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
                !pushStatus.supported || pushStatus.permission === 'denied'
                  ? 'border-amber-200 bg-amber-50 text-amber-900'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-800'
              }`}>
                {!pushStatus.supported
                  ? 'Background notifications require HTTPS (localhost is allowed) and a browser that supports Web Push.'
                  : pushMessage}
              </div>
            )}

        <MasterStats loading={loading} items={statCards.map((item) => ({ ...item, active: statusFilter === item.key, onClick: () => setStatusFilter(item.key) }))} />

        <MasterToolbar>
          <MasterSearch value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notifications..." />
          <MasterSelect label="Status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All notifications</option><option value="unread">Unread</option><option value="read">Read</option></MasterSelect>
        </MasterToolbar>

        <MasterResults title="Notification History" count={Number(notificationPagination.total || 0)} loading={loading} description="Messages, account activity, and links that require your attention.">

          {error ? (
            <div className="mx-4 mt-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
              {error}
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center justify-center gap-3 p-10 text-sm font-semibold text-slate-500">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-emerald-600 border-t-transparent"></span>
              Loading notifications...
            </div>
          ) : visibleNotifications.length === 0 ? (
            <div className="p-10 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-2xl text-slate-400">
                <i className="bi bi-bell"></i>
              </div>
              <div className="mt-4 text-lg font-black text-slate-800">No notifications found</div>
              <p className="mt-2 text-sm text-slate-500">New system notifications will appear here automatically.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {paginatedNotifications.map((notif) => {
                const isUnread = Number(notif?.is_read || 0) === 0;
                const title = cleanText(notif?.title) || 'Notification';
                const message = cleanText(notif?.message);
                const actor = cleanText(notif?.actor_name) || 'System';
                const hasLink = !!normalizeNotificationLink(notif?.link);
                const isClearedFromNavbar = Boolean(notif?.navbar_hidden_at);

                return (
                  <button
                    key={notif?.notif_id || `${title}-${notif?.created_at}`}
                    type="button"
                    onClick={() => openNotification(notif)}
                    className={`block w-full px-4 py-4 text-left transition hover:bg-emerald-50/60 md:px-5 ${
                      isUnread ? 'bg-emerald-50/50' : 'bg-white'
                    }`}
                  >
                    <div className="flex gap-4">
                      <div className="relative flex-shrink-0">
                        {notif?.actor_avatar ? (
                          <img
                            src={notif.actor_avatar}
                            alt={actor}
                            className="h-11 w-11 rounded-full border border-slate-200 object-cover"
                          />
                        ) : (
                          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-900 text-sm font-black text-white">
                            {getInitials(actor)}
                          </span>
                        )}
                        {isUnread ? (
                          <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-white bg-emerald-500"></span>
                        ) : null}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-black text-slate-900">{title}</span>
                              <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${
                                isUnread ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-500'
                              }`}>
                                {isUnread ? 'Unread' : 'Read'}
                              </span>
                              {hasLink ? (
                                <span className="rounded-full bg-sky-50 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-sky-700">
                                  Link
                                </span>
                              ) : null}
                              {isClearedFromNavbar ? (
                                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                                  Cleared From Navbar
                                </span>
                              ) : null}
                            </div>
                            {message ? <p className="mt-2 text-sm leading-6 text-slate-600">{message}</p> : null}
                            <div className="mt-2 text-xs font-semibold text-slate-400">From {actor}</div>
                          </div>
                          <div className="whitespace-nowrap text-xs font-semibold text-slate-400">
                            <div>{formatNotificationTime(notif?.created_at)}</div>
                            <div className="mt-1 text-right text-slate-500">{formatNotificationAge(notif?.created_at)}</div>
                            {hasLink ? (
                              <div className="mt-3 text-right">
                                <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-white">
                                  Open
                                  <i className="bi bi-arrow-right-short text-sm"></i>
                                </span>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
              {totalPages > 1 ? (
                <div className="flex flex-col gap-3 border-t border-slate-100 bg-slate-50/70 px-4 py-4 sm:flex-row sm:items-center sm:justify-between md:px-5">
                  <span className="text-sm font-semibold text-slate-500">
                    Showing {pageStart + 1}-{Math.min(pageStart + paginatedNotifications.length, Number(notificationPagination.total || 0))} of {Number(notificationPagination.total || 0)}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setCurrentPage(page => Math.max(1, page - 1))}
                      disabled={safeCurrentPage <= 1}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Previous
                    </button>
                    <span className="px-2 text-sm font-semibold text-slate-600">
                      Page {safeCurrentPage} of {totalPages}
                    </span>
                    <button
                      type="button"
                      onClick={() => setCurrentPage(page => Math.min(totalPages, page + 1))}
                      disabled={safeCurrentPage >= totalPages}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </MasterResults>

        <Modal
          show={Boolean(selectedNotification)}
          title="Notification Details"
          onClose={closeNotificationDetail}
          size="md"
        >
          {selectedNotification ? (
            <div className="space-y-4 p-1">
              <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-4">
                <div className="text-xs font-bold uppercase tracking-wider text-emerald-700">
                  {Number(selectedNotification.is_read || 0) === 0 ? 'Unread' : 'Read'}
                </div>
                <h3 className="mt-1 text-xl font-black text-slate-900">
                  {cleanText(selectedNotification.title) || 'Notification'}
                </h3>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                  {cleanText(selectedNotification.message) || 'No additional details were provided.'}
                </p>
              </div>
              <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 text-sm sm:grid-cols-2">
                <div>
                  <div className="text-xs font-bold uppercase tracking-wide text-slate-400">From</div>
                  <div className="mt-1 font-semibold text-slate-800">{cleanText(selectedNotification.actor_name) || 'System'}</div>
                </div>
                <div>
                  <div className="text-xs font-bold uppercase tracking-wide text-slate-400">Received</div>
                  <div className="mt-1 font-semibold text-slate-800">{formatNotificationTime(selectedNotification.created_at) || '-'}</div>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeNotificationDetail}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Close
                </button>
                {normalizeNotificationLink(selectedNotification.link) ? (
                  <button
                    type="button"
                    onClick={() => {
                      const link = normalizeNotificationLink(selectedNotification.link);
                      if (link) window.location.hash = `#${link}`;
                    }}
                    className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
                  >
                    Open Related Page
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </Modal>
    </div>
  );
}
