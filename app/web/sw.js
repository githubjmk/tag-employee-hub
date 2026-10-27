// TAG Employee Hub service worker: makes the Hub installable as a home-screen app and shows
// reminders (web push). It caches nothing and does not touch page loads: everything comes from the server.
// Pushes carry no content; the worker asks the Hub what to show (never anything private).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let m = null;
    try {
      const sub = await self.registration.pushManager.getSubscription();
      const r = await fetch('/api/push/pending', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Request': '1' }, body: JSON.stringify({ endpoint: sub ? sub.endpoint : '' }) });
      if (r.ok) m = await r.json();
    } catch { /* fall back to a generic message */ }
    if (!m || !m.title) m = { title: 'TAG Employee Hub', body: 'You have an update in the Employee Hub.', url: '/' };
    await self.registration.showNotification(m.title, { body: m.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: m.tag || 'tag-hub', data: { url: m.url || '/' } });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if (w.url.startsWith(self.location.origin)) { try { await w.navigate(url); } catch { /* ignore */ } return w.focus(); } }
    return self.clients.openWindow(url);
  })());
});
