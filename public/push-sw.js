self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function notificationCenterUrl(notificationId = 0) {
  const query = Number(notificationId) > 0 ? `?notif_id=${Number(notificationId)}` : '';
  return new URL(`./#/notifications${query}`, self.registration.scope).href;
}

function safeNotificationTarget(data = {}) {
  const fallback = notificationCenterUrl(data.notif_id);
  const savedLink = String(data.link || '').trim();
  let candidate = String(data.url || '').trim();

  // Prefer the notification's saved application destination. The server also
  // supplies `url`, while this keeps the worker compatible with older senders.
  if (savedLink.startsWith('/') && !savedLink.startsWith('//') && !savedLink.includes('\\')) {
    candidate = `./#${savedLink}`;
  }
  if (!candidate) return fallback;

  try {
    const target = new URL(candidate, self.registration.scope);
    const scope = new URL(self.registration.scope);
    return target.origin === scope.origin && target.href.startsWith(scope.href)
      ? target.href
      : fallback;
  } catch (error) {
    return fallback;
  }
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch (error) {
      data = { title: 'New notification', body: event.data ? event.data.text() : '' };
    }

    const title = String(data.title || 'New notification');
    const targetUrl = safeNotificationTarget(data);
    await self.registration.showNotification(title, {
      body: String(data.body || ''),
      icon: new URL(String(data.icon || './cdoc-logo.png?v=lossless-20260911'), self.registration.scope).href,
      badge: new URL(String(data.badge || './cdoc-logo.png?v=lossless-20260911'), self.registration.scope).href,
      tag: String(data.tag || `notification-${data.notif_id || Date.now()}`),
      renotify: true,
      data: {
        url: targetUrl,
        notif_id: Number(data.notif_id || 0),
      },
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url
    || notificationCenterUrl(event.notification?.data?.notif_id);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('navigate' in client) await client.navigate(targetUrl);
      if ('focus' in client) return client.focus();
    }
    return self.clients.openWindow(targetUrl);
  })());
});
