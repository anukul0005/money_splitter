// SplitEasy's push service worker.
//
// This file has to live at the site root (not under /src) - a service
// worker's scope is everything at or below the path it's served from, and
// push notifications need it covering the whole app, not just one folder.
// Vite serves everything under /public unprocessed at the root for exactly
// this kind of file.

self.addEventListener('push', (event) => {
  let data = { title: 'SplitEasy', body: '', url: '/' }
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

// Clicking the notification focuses an already-open SplitEasy tab if one
// exists, rather than always opening a new one - the same behaviour any
// native app's own notifications have.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification.data?.url || '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(targetUrl)
          return client.focus()
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl)
    })
  )
})
