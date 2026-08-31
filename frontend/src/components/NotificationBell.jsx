import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getActivity, markActivitySeen } from '../api'

/** "3h ago", "2d ago" — compact enough for a dropdown row. */
function timeAgo(iso) {
  if (!iso) return ''
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return ''
  const secs = Math.max(0, (Date.now() - then.getTime()) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return then.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

const ICONS = {
  'added an expense':      '💸',
  'edited an expense':     '✏️',
  'deleted an expense':    '🗑️',
  'recorded a payment':    '✅',
  'deleted a payment':     '↩️',
  'created a new group':   '👥',
  'created a new monthly group': '🗓️',
  'updated the group':     '⚙️',
}

/**
 * Bell + dropdown feed of everything that happened in the user's groups.
 *
 * The server only ever returns activity for groups this user belongs to, so
 * someone outside a group can't see its changes even if they go looking.
 */
export default function NotificationBell({ user }) {
  const nav = useNavigate()
  const [open, setOpen]       = useState(false)
  const [items, setItems]     = useState([])
  const [unread, setUnread]   = useState(0)
  const [loading, setLoading] = useState(false)
  const boxRef = useRef(null)

  const load = async () => {
    if (!user?.name) return
    setLoading(true)
    try {
      const r = await getActivity(user.name, 40)
      setItems(r.data)
      setUnread(r.data.filter((a) => a.unread).length)
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  // Fetch once on mount so the badge is right without opening the panel
  useEffect(() => { load() }, [user?.name])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const toggle = async () => {
    const next = !open
    setOpen(next)
    if (next) {
      await load()
      // Opening the panel counts as reading it
      if (user?.name) {
        try {
          await markActivitySeen(user.name)
          setUnread(0)
        } catch { /* badge will correct itself on next load */ }
      }
    }
  }

  return (
    <div className="relative flex-shrink-0" ref={boxRef}>
      <button
        onClick={toggle}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        className="relative p-2 -mr-1 text-white/70 hover:text-white active:scale-95 transition-all"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unread > 0 && (
          <span className="absolute top-0.5 right-0.5 min-w-[18px] h-[18px] px-1 bg-brand-400 text-white text-[10px] font-bold rounded-full flex items-center justify-center ring-2 ring-field-950">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[min(20rem,calc(100vw-2.5rem))] max-h-[26rem] overflow-y-auto bg-cream border border-amber-200 rounded-lg shadow-xl z-50 text-left">
          <div className="sticky top-0 bg-cream border-b border-amber-200 px-4 py-2.5 flex items-center justify-between">
            <p className="text-xs font-bold text-gray-700 uppercase tracking-widest">Activity</p>
            {loading && <span className="text-[10px] text-gray-400">loading…</span>}
          </div>

          {items.length === 0 && !loading && (
            <p className="px-4 py-8 text-center text-sm text-gray-400">
              Nothing yet — activity in your groups will show up here.
            </p>
          )}

          {items.map((a) => (
            <button
              key={a.id}
              onClick={() => { setOpen(false); nav(`/groups/${a.group_id}`) }}
              className={`w-full text-left px-4 py-2.5 border-b border-amber-100 last:border-b-0 hover:bg-amber-50 transition-colors flex gap-2.5 ${
                a.unread ? 'bg-brand-50/60' : ''
              }`}
            >
              <span className="text-base leading-none mt-0.5 flex-shrink-0">{ICONS[a.verb] ?? '•'}</span>
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-semibold text-gray-900 leading-snug">
                  {a.actor ? `${a.actor} ` : ''}{a.verb}
                  {a.group_name ? <span className="text-gray-400 font-normal"> in {a.group_name}</span> : null}
                </span>
                {a.summary && (
                  <span className="block text-xs text-gray-500 mt-0.5 truncate">{a.summary}</span>
                )}
                <span className="block text-[10px] text-gray-400 mt-0.5">{timeAgo(a.created_at)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
