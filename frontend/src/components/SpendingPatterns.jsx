import { useEffect, useState } from 'react'
import { getPatterns } from '../api'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const compact = (v) => (v >= 1000 ? `₹${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `₹${Math.round(v)}`)

const PERIOD_COLORS = { Early: '#fdba74', Day: '#f97316', Night: '#1e293b' }
const PERIOD_HOURS = { Early: '1am–11am', Day: '11am–6pm', Night: '6pm–1am' }

/**
 * When the money goes, for Home: the caller's own share over the last 12
 * months (backend /stats/patterns) - a few plain-language insights first,
 * then time of day, day of the week, and how much rides on big days.
 */
export default function SpendingPatterns() {
  const [p, setP] = useState(null)

  useEffect(() => {
    getPatterns().then((r) => setP(r.data)).catch(() => setP(null))
  }, [])

  if (!p || !p.daily) return null
  const topDay = p.days.reduce((a, b) => (b.per_day > a.per_day ? b : a), p.days[0])
  const maxDay = topDay.per_day || 1

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Your spending patterns</p>
        <p className="text-[10px] text-gray-400">your share · last 12 months</p>
      </div>

      <div className="space-y-3">
        {/* What's worth acting on */}
        {p.insights.length > 0 && (
          <div className="card !p-0 overflow-hidden">
            {p.insights.map((i, n) => (
              <div key={n} className="px-4 py-3 border-b border-amber-100 last:border-0 flex gap-3">
                <span className="w-1 self-stretch bg-brand-400 shrink-0" />
                <div>
                  <p className="text-sm font-bold text-gray-900">{i.title}</p>
                  <p className="text-xs text-gray-600 mt-0.5 leading-snug">{i.text}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Time of day */}
        <div className="card">
          <div className="flex items-baseline justify-between mb-2">
            <h3 className="text-xs font-black text-gray-500 uppercase tracking-widest">Time of day</h3>
            <span className="text-[10px] text-gray-400">{Math.round(p.timed_share)}% of spending has a time</span>
          </div>
          <div className="flex h-3 w-full overflow-hidden">
            {p.periods.filter((x) => x.share > 0).map((x) => (
              <div key={x.name} style={{ width: `${x.share}%`, background: PERIOD_COLORS[x.name] }} title={`${x.name}: ${x.share}%`} />
            ))}
          </div>
          <div className="grid grid-cols-3 gap-x-3 gap-y-2 mt-3">
            {p.periods.map((x) => (
              <div key={x.name} className="flex items-start gap-2">
                <span className="inline-block w-2.5 h-2.5 mt-1 shrink-0" style={{ background: PERIOD_COLORS[x.name] }} />
                <div className="min-w-0">
                  <p className="text-xs font-bold text-gray-800">
                    {x.name} <span className="font-black">{Math.round(x.share)}%</span>
                  </p>
                  <p className="text-[10px] text-gray-400 leading-tight">
                    {PERIOD_HOURS[x.name]} · {x.count ? `avg ${INR(x.avg_payment)} a payment` : 'none'}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Day of the week: what a typical one costs */}
        <div className="card">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-xs font-black text-gray-500 uppercase tracking-widest">A typical…</h3>
            <span className="text-[10px] text-gray-400">
              weekday {INR(p.weekday_avg)} · weekend day {INR(p.weekend_avg)}
            </span>
          </div>
          <div className="flex items-end gap-1.5 h-28">
            {p.days.map((d) => {
              const top = d.name === topDay.name
              return (
                <div key={d.name} className="flex-1 flex flex-col items-center justify-end h-full">
                  <span className={`text-[9px] mb-0.5 ${top ? 'font-black text-brand-600' : 'text-gray-400'}`}>{compact(d.per_day)}</span>
                  <div
                    className={top ? 'w-full bg-brand-400' : 'w-full bg-amber-200'}
                    style={{ height: `${Math.max((d.per_day / maxDay) * 100, 3)}%` }}
                    title={`A typical ${d.name}: ${INR(d.per_day)}`}
                  />
                  <span className={`text-[10px] mt-1 ${top ? 'font-black text-gray-900' : 'text-gray-500'}`}>{d.name.slice(0, 3)}</span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Your days */}
        <div className="card">
          <h3 className="text-xs font-black text-gray-500 uppercase tracking-widest mb-3">Your days</h3>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Typical day</p>
              <p className="text-base font-black text-gray-900 mt-0.5">{INR(p.daily.median)}</p>
              <p className="text-[10px] text-gray-400">median</p>
            </div>
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Average day</p>
              <p className="text-base font-black text-gray-900 mt-0.5">{INR(p.daily.average)}</p>
              <p className="text-[10px] text-gray-400">{p.daily.spend_days} days with spending</p>
            </div>
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Big days</p>
              <p className="text-base font-black text-brand-600 mt-0.5">{p.daily.big_days}</p>
              <p className="text-[10px] text-gray-400">over {INR(p.daily.big_threshold)}</p>
            </div>
          </div>
          <div className="mt-3">
            <div className="flex h-2 w-full bg-amber-100 overflow-hidden">
              <div className="h-full bg-brand-400" style={{ width: `${p.daily.big_share}%` }} />
            </div>
            <p className="text-[11px] text-gray-600 mt-1.5">
              Those {p.daily.big_days} big days were <span className="font-bold">{Math.round(p.daily.big_share)}%</span> of
              everything you spent. Biggest: {INR(p.daily.biggest.amount)} on{' '}
              {new Date(p.daily.biggest.date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
