/* 時差ほどき service worker：通知の表示と、画面をいつも最新にすること（オフラインキャッシュはしない） */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

/* 画面（HTML）は毎回サーバーから取り直す。ホーム画面のアプリが古い版を出し続けないように */
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request, { cache: 'no-store' }).catch(() => fetch(e.request)));
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '時差ほどき', {
    body: d.body || '予定の時刻です',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: d.tag || undefined,
    data: { url: './' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) if ('focus' in w) return w.focus();
    return self.clients.openWindow('./');
  }));
});
