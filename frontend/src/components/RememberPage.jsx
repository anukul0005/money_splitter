import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

/**
 * Opening the app again (after closing it, or after a redeploy reloads it)
 * goes back to the page last looked at - not wherever the phone happens to
 * start it, which was sometimes the notifications page. Nothing remembered:
 * Home. A link that opens the app somewhere specific (a notification's
 * /balances/owe, say) is left where it is.
 */
const KEY = 'splitter_last_page'
const SESSION = 'splitter_page_restored'
const NOT_KEPT = ['/notifications']               // passing visits, not where you were

export default function RememberPage() {
  const loc = useLocation()
  const nav = useNavigate()
  const ready = useRef(false)

  // Once per app launch (sessionStorage starts empty each time the app does)
  useEffect(() => {
    let restored = false
    try { restored = sessionStorage.getItem(SESSION) === '1'; sessionStorage.setItem(SESSION, '1') } catch { /* private mode */ }
    if (!restored && (loc.pathname === '/' || NOT_KEPT.includes(loc.pathname))) {
      let last = null
      try { last = localStorage.getItem(KEY) } catch { /* private mode */ }
      const here = loc.pathname + loc.search
      if (last && last !== here) nav(last, { replace: true })
      else if (NOT_KEPT.includes(loc.pathname)) nav('/', { replace: true })
    }
  }, [])

  // Kept from the first move on - not the launch page itself, which would
  // overwrite the page being restored before the app gets there
  useEffect(() => {
    if (!ready.current) { ready.current = true; return }
    if (NOT_KEPT.includes(loc.pathname)) return
    try { localStorage.setItem(KEY, loc.pathname + loc.search) } catch { /* private mode */ }
  }, [loc.pathname, loc.search])

  return null
}
