import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

// The bundle this copy of the app is running
const running = () => document.querySelector('script[type="module"][src*="/assets/index-"]')?.getAttribute('src') || ''

/**
 * A home-screen app is hardly ever fully closed, so it can keep running the
 * build from days ago - and an old build reading data saved by a new one
 * shows it wrong (a note's rows came up blank). Whenever the app comes back
 * on screen, this checks the live index.html's bundle: if it's changed, the
 * app reloads at the next page change, or at once if it was away for a while
 * (nothing half-typed to lose by then).
 */
export default function AppUpdater() {
  const { pathname } = useLocation()
  const stale = useRef(false)
  const hiddenAt = useRef(0)
  const first = useRef(true)

  useEffect(() => {
    if (first.current) { first.current = false; return }
    if (stale.current) window.location.reload()
  }, [pathname])

  useEffect(() => {
    const mine = running()
    if (!mine) return                     // dev server: no hashed bundle
    const check = async (awayMs) => {
      try {
        const html = await (await fetch('/', { cache: 'no-store' })).text()
        const live = html.match(/\/assets\/index-[^"']+\.js/)?.[0]
        if (live && !mine.endsWith(live)) {
          stale.current = true
          if (awayMs > 2 * 60 * 1000) window.location.reload()
        }
      } catch { /* offline - try next time */ }
    }
    const onVis = () => {
      if (document.hidden) { hiddenAt.current = Date.now(); return }
      check(hiddenAt.current ? Date.now() - hiddenAt.current : 0)
    }
    document.addEventListener('visibilitychange', onVis)
    const t = setInterval(() => check(0), 10 * 60 * 1000)
    return () => { document.removeEventListener('visibilitychange', onVis); clearInterval(t) }
  }, [])

  return null
}
