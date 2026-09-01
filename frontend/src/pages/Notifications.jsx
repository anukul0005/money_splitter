import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getActivity, markActivitySeen } from '../api'
import { useUser } from '../UserContext'
import LoadingSpinner from '../components/LoadingSpinner'

const ICONS = {
  'added an expense':            '💸',
  'edited an expense':           '✏️',
  'deleted an expense':          '🗑️',
  'recorded a payment':          '✅',
  'deleted a payment':           '↩️',
  'created a new group':         '👥',
  'created a new monthly group': '🗓️',
  'updated the group':           '⚙️',
}

/** Full date + time, e.g. "1 Sep 2026, 4:05 pm". */
function stamp(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

function dayLabel(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Earlier'
  const today = new Date()
  const yest  = new Date(); yest.setDate(today.getDate() - 1)
  const same = (a, b) => a.toDateString() === b.toDateString()
  if (same(d, today)) return 'Today'
  if (same(d, yest))  return 'Yesterday'
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
}

/**
 * /notifications — the activity feed as a full page.
 *
 * Only shows activity from groups this user belongs to; the server enforces
 * that, so someone outside a group can't see its changes.
 */
export default function Notifications() {
  const nav  = useNavigate()
  const user = useUser()

  const [items, setItems]     = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user?.name) { setLoading(false); return }
    getActivity(user.name, 100)
      .then((r) => setItems(r.data))
      .catch(() => setItems([]))
      .finally(() => {
        setLoading(false)
        // Opening the page counts as reading it
        markActivitySeen(user.name).catch(() => {})
      })
  }, [user?.name])

  if (loading) return <LoadingSpinner />

  // Group consecutive entries under a day heading
  const groups = []
  items.forEach((a) => {
    const label = dayLabel(a.created_at)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.rows.push(a)
    else groups.push({ label, rows: [a] })
  })

  return (
    <div className="pb-24 md:pb-8">
      <div className="bg-gradient-to-br from-field-800 to-field-950 text-white px-5 pt-10 md:pt-8 pb-6 md:rounded-b-3xl border-b border-field-700">
        <button onClick={() => nav('/')} className="text-xs font-bold text-white/50 mb-2">← Home</button>
        <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
        <p className="text-slate-300/40 text-xs mt-1 font-medium">
          Everything happening in your groups
        </p>
      </div>

      <div className="px-5 mt-5 max-w-2xl">
        {items.length === 0 && (
          <div className="text-center py-20">
            <p className="text-3xl mb-2">🔔</p>
            <p className="text-sm text-gray-400">
              Nothing yet — activity in your groups will show up here.
            </p>
          </div>
        )}

        {groups.map(({ label, rows }) => (
          <div key={label} className="mb-5">
            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">{label}</p>
            <div className="space-y-2">
              {rows.map((a) => (
                <button
                  key={a.id}
                  onClick={() => nav(`/groups/${a.group_id}`)}
                  className={`card w-full text-left flex gap-3 active:scale-[0.99] transition-transform ${
                    a.unread ? 'border-brand-300 bg-brand-50/40' : ''
                  }`}
                >
                  <span className="text-lg leading-none mt-0.5 flex-shrink-0">
                    {ICONS[a.verb] ?? '•'}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-gray-900 leading-snug">
                      {a.actor ? `${a.actor} ` : ''}{a.verb}
                      {a.group_name && (
                        <span className="text-gray-400 font-normal"> in {a.group_name}</span>
                      )}
                    </span>
                    {a.summary && (
                      <span className="block text-xs text-gray-600 mt-1">{a.summary}</span>
                    )}
                    <span className="block text-[10px] text-gray-400 mt-1">{stamp(a.created_at)}</span>
                  </span>
                  {a.unread && (
                    <span className="w-2 h-2 rounded-full bg-brand-400 flex-shrink-0 mt-1.5" />
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
