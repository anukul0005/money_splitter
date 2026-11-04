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
// The app moves itself there (App.jsx's NotificationLinks, its own router -
// no reload): client.navigate() is refused for a page this worker didn't
// load, and unreliable on iPhone. And an iPhone home-screen app started by
// the tap may open on its start page whatever was asked (then RememberPage
// takes it to the last page seen), so the page is handed over again when the
// app says it is up - `pending`, kept for a short while.
let pending = null                         // { path, at, done }
const PENDING_MS = 20000

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
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const open = wins.find((c) => new URL(c.url).origin === self.location.origin)
    await new Promise((resolve) => {
      if (pending) pending.done()
      pending = { path, at: Date.now(), done: resolve }
      setTimeout(resolve, PENDING_MS)
      if (open) {
        open.postMessage({ type: 'open', url: path })
        open.focus().catch(() => {})
      } else {
        self.clients.openWindow(new URL(path, self.location.origin).href).catch(() => {})
      }
    })
  })())
})

// The app, on starting or coming back to the screen: "anything to open?" -
// and "opened", once it is on the page
self.addEventListener('message', (event) => {
  if (!pending) return
  if (event.data?.type === 'ready' && Date.now() - pending.at < PENDING_MS) {
    event.source?.postMessage({ type: 'open', url: pending.path })
  } else if (event.data?.type === 'opened') {
    pending.done()
    pending = null
  }
})
