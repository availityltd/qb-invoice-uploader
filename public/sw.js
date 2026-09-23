// a new name clears what the old worker kept, so no computer keeps serving a
// page from before the update
const CACHE = 'sqbo-v4';
// Only what a page is made of, never a page. A page now answers with a redirect
// when the person looking at it should be somewhere else, and addAll refuses a
// redirect - which would fail the install and leave no worker at all.
const SHELL = ['/app.css', '/logo.svg', '/favicon.svg', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never cache API or auth calls — they must always hit the server
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // A page is the server's to decide - it answers with the door, the waiting
  // screen or the app, depending on who is asking. A kept copy would show the
  // wrong one of the three, so pages are never kept.
  if (e.request.mode === 'navigate') return;

  // Network first, fall back to cache when offline
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

/* ---------- notices on the phone ---------- */
// The app is closed and the worker is all that is running. It shows what the
// server sent, and a tap opens the page the notice was about - the person's own
// row on Manage users, say - rather than the front door.

self.addEventListener('push', e => {
  let n = {};
  try { n = e.data ? e.data.json() : {}; } catch (err) { n = {}; }

  e.waitUntil(
    self.registration.showNotification(n.title || 'Shopify → QuickBooks', {
      body: n.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { link: n.link || '/' },
      // one notice per subject replaces the last rather than stacking up
      tag: n.link || 'note',
      renotify: true
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const link = (e.notification.data && e.notification.data.link) || '/';
  const want = new URL(link, self.location.origin).href;

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // a window of this app is already open - use it rather than opening another
      for (const c of list) {
        if (c.url.indexOf(self.location.origin) === 0 && 'navigate' in c) {
          return c.navigate(want).then(w => w && w.focus());
        }
      }
      return self.clients.openWindow(want);
    })
  );
});
