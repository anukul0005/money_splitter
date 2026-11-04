import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

/**
 * A tapped notification's page. The push worker (public/sw.js) writes the
 * page down (TAP_CACHE) and, when the app is open, also posts it. This moves
 * there with the router - on the message, on starting, and each time the
 * app comes back to the screen - so it arrives however the tap started the
 * app: an iPhone home-screen app may open on its usual page (then
 * RememberPage takes it to the last page seen), and iPhone may stop the
 * worker before the app is up. Signed out, it waits here until after login.
 * And while the app is on screen it looks every second: a tap with the app
 * already open neither starts it nor brings it back, and iPhone doesn't
 * always deliver the worker's message to it.
 */
const TAP_CACHE = 'settle-notification-tap'
const TAP_KEY = '/__notification-tap'
const FRESH_MS = 2 * 60 * 1000             // an older tap isn't what's being opened now
const LOOK_MS = 1000                       // while on screen - a local lookup, no network

async function takeTap() {
  if (!('caches' in window)) return null
  try {
    const c = await caches.open(TAP_CACHE)
    const r = await c.match(TAP_KEY)
    if (!r) return null
    await c.delete(TAP_KEY)
    const { path, at } = await r.json()
    return typeof path === 'string' && Date.now() - at < FRESH_MS ? path : null
  } catch { return null }
}

export default function NotificationLinks() {
  const nav = useNavigate()

  useEffect(() => {
    const go = (path) => {
      if (path && path.startsWith('/') && path !== window.location.pathname + window.location.search) nav(path)
    }
    const check = () => {
      if (document.visibilityState === 'visible') takeTap().then(go)
    }
    const onMessage = (e) => {
      if (e.data?.type === 'open' && typeof e.data.url === 'string') takeTap().then(() => go(e.data.url))
    }
    const sw = navigator.serviceWorker
    sw?.addEventListener('message', onMessage)
    sw?.startMessages?.()
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    window.addEventListener('pageshow', check)
    const timer = setInterval(check, LOOK_MS)
    check()
    return () => {
      clearInterval(timer)
      window.removeEventListener('pageshow', check)
      sw?.removeEventListener('message', onMessage)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
    }
  }, [nav])

  return null
}
