import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

/**
 * A tapped notification's page. The push worker (public/sw.js) posts
 * { type: 'open', url } to the app; this moves there with the router. On
 * starting, and each time the app comes back to the screen, it asks the
 * worker whether a tap is waiting - an iPhone home-screen app opened by a
 * tap can start on its usual page, and this is how it still gets there.
 */
export default function NotificationLinks() {
  const nav = useNavigate()

  useEffect(() => {
    const sw = navigator.serviceWorker
    if (!sw) return
    const onMessage = (e) => {
      const url = e.data?.type === 'open' && typeof e.data.url === 'string' ? e.data.url : null
      if (!url || !url.startsWith('/')) return
      if (url !== window.location.pathname + window.location.search) nav(url)
      e.source?.postMessage?.({ type: 'opened' })          // the worker can forget it
    }
    const ask = () => {
      if (document.visibilityState !== 'visible') return
      sw.ready.then((reg) => reg.active?.postMessage({ type: 'ready' })).catch(() => {})
    }
    sw.addEventListener('message', onMessage)
    sw.startMessages?.()
    document.addEventListener('visibilitychange', ask)
    ask()
    return () => {
      sw.removeEventListener('message', onMessage)
      document.removeEventListener('visibilitychange', ask)
    }
  }, [nav])

  return null
}
