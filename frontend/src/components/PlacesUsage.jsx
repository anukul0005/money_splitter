import { useEffect, useState } from 'react'
import { getPlacesUsage } from '../api'

const N = (n) => Number(n || 0).toLocaleString('en-IN')
const MONTH = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long' })

function Meter({ label, u }) {
  const pct = Math.min(100, (u.month / u.free) * 100)
  const tone = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-yellow-500' : 'bg-brand-500'
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-bold text-gray-700">{label}</span>
        <span className="text-[11px] text-gray-500">
          <span className="font-black text-gray-900">{N(u.month)}</span> / {N(u.free)} free
        </span>
      </div>
      <div className="h-1.5 bg-amber-100 mt-1 overflow-hidden" role="meter" aria-valuemin={0} aria-valuemax={u.free} aria-valuenow={u.month}
        aria-label={`${label}: ${u.month} of ${u.free} free this month`}>
        <div className={`h-full ${tone}`} style={{ width: `${Math.max(pct, u.month ? 1 : 0)}%` }} />
      </div>
      <p className="text-[10px] text-gray-400 mt-0.5">
        Today {N(u.today)} / {N(u.daily_cap)}{u.cached_month ? ` · ${N(u.cached_month)} answered free from saved results` : ''}
      </p>
    </div>
  )
}

/**
 * The Google Places counter everyone sees on the Places tab: calls this
 * month against Google's free allowance, and today's against our daily stop
 * (backend routers/gplaces.py FREE / DAILY). `usage` from a search or place
 * answer replaces it at once; otherwise it loads its own.
 */
export default function PlacesUsage({ usage }) {
  const [u, setU] = useState(usage || null)
  useEffect(() => { if (usage) setU(usage) }, [usage])
  useEffect(() => { if (!usage) getPlacesUsage().then((r) => setU(r.data)).catch(() => {}) }, [])
  if (!u) return null
  return (
    <div className="card">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Google Places · {MONTH(u.month)}</p>
        <p className="text-[10px] text-gray-400">shared by everyone</p>
      </div>
      <div className="space-y-2.5">
        <Meter label="Searches" u={u.search} />
        <Meter label="Place details" u={u.details} />
      </div>
    </div>
  )
}
