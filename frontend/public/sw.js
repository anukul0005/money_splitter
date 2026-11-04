// Settle's push service worker.
//
// This file has to live at the site root (not under /src) - a service
// worker's scope is everything at or below the path it's served from, and
// push notifications need it covering the whole app, not just one folder.
// Vite serves everything under /public unprocessed at the root for exactly
// this kind of file.

// A new version of this file takes over at once, rather than waiting for
// every open copy of the app to close - a home-screen app is hardly ever
// fully closed, so a fix here would otherwise never arrive.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = { title: 'Settle', body: '', url: '/' }
  try {
    if (event.data) data = { ...data, ...event.data.json() }
  } catch {
    // Not JSON - fall back to plain text as the body rather than dropping
    // the notification entirely.
    if (event.data) data.body = event.data.text()
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/' },
    })
  )
})

// Tapping a notification opens the app on the page it is about.
//
// The app moves itself there (components/NotificationLinks.jsx, its own
// router - no reload): client.navigate() is refused for a page this worker
// didn't load, and unreliable on iPhone. The page is also written down where
// the app reads it however it starts (TAP_CACHE): an iPhone home-screen app
// opened by the tap may start on its usual page, and iPhone may stop this
// worker before the app is up - so a message alone can be lost.
const TAP_CACHE = 'settle-notification-tap'
const TAP_KEY = '/__notification-tap'

// Always a page on this site: a notification may carry a full address,
// from a server that knows the site by another name
function pathOf(url) {
  try {
    const u = new URL(url || '/', self.location.origin)
    return u.pathname + u.search + u.hash
  } catch { return '/' }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const path = pathOf(event.notification.data?.url)

  event.waitUntil((async () => {
    try {
      const c = await caches.open(TAP_CACHE)
      await c.put(TAP_KEY, new Response(JSON.stringify({ path, at: Date.now() })))
    } catch { /* storage refused - the message below still works when the app is open */ }
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const open = wins.find((c) => new URL(c.url).origin === self.location.origin)
    if (open) {
      open.postMessage({ type: 'open', url: path })
      try { await open.focus() } catch { /* iPhone brings it up itself */ }
    } else {
      try { await self.clients.openWindow(new URL(path, self.location.origin).href) } catch { /* ditto */ }
    }
  })())
})
