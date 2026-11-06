import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { recipesMe } from '../api'
import { Plan, isoDay, planDate } from './Recipes'

const n0 = (n) => Math.round(n || 0).toLocaleString('en-IN')
const fmt = (iso, o = { weekday: 'short', day: 'numeric', month: 'short' }) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', o)

/**
 * /recipes/week?w=2026-11-06 - one week (Friday to Thursday): how it's
 * going against the target, then its 7 day cards - each day's analysis from
 * what was logged, its meals, and logging. A past week (its plan replaced)
 * keeps its day-by-day numbers.
 */
export default function RecipeWeek() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const w = params.get('w') || ''
  const [me, setMe] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    recipesMe().then((r) => setMe(r.data)).catch(() => setErr("Couldn't load the week - try again."))
  }, [])

  const plan = me?.plan
  const live = plan?.days?.length && isoDay(planDate(plan, 1)) === w
  const week = (me?.weeks || []).find((x) => x.starts === w)
  const back = () => (window.history.length > 1 ? nav(-1) : nav('/recommend?tab=recipes'))
  const setLog = (log, weeks) => setMe((m) => ({ ...m, log, weeks: weeks || m.weeks }))

  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={back} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <h1 className="text-xl font-black tracking-tight">{week ? `${fmt(week.starts, { day: 'numeric', month: 'short' })} – ${fmt(week.ends, { day: 'numeric', month: 'short' })}` : 'Your week'}</h1>
        <p className="text-xs text-gray-400 mt-1">Day by day - what was planned, what you had, and how it went</p>
      </div>

      <div className="px-5 mt-4 space-y-3 max-w-2xl">
        {!me && !err && <div className="card text-center py-10"><div className="w-6 h-6 mx-auto border-2 border-brand-400 border-t-transparent rounded-full animate-spin" /></div>}
        {err && <p className="text-sm text-red-600">{err}</p>}

        {week && <WeekSummary w={week} />}

        {me && live && <Plan r={plan} log={me.log || {}} setLog={setLog} onProfile={() => nav('/recommend?tab=recipes')} />}

        {/* A week gone by: its plan was replaced, its numbers kept */}
        {me && !live && week && week.days.map((d) => <PastDay key={d.day} d={d} />)}
        {me && !live && !week && <p className="text-sm text-gray-500">No plan for that week.</p>}
      </div>
    </div>
  )
}

function WeekSummary({ w }) {
  const full = w.target_day * w.off_days
  const tone = !w.off_days ? 'text-gray-400' : Math.abs(w.off) <= full * 0.05 ? 'text-green-700' : w.off > 0 ? 'text-red-600' : 'text-amber-700'
  return (
    <div className="card">
      <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">The week so far</p>
      <div className="grid grid-cols-3 gap-2 mt-2">
        <div><p className="text-base font-black text-gray-900 tabular-nums">{n0(w.target_week)}</p><p className="text-[10px] text-gray-500">kcal target</p></div>
        <div><p className="text-base font-black text-gray-900 tabular-nums">{n0(w.eaten)}</p><p className="text-[10px] text-gray-500">kcal you had · {w.meals_logged}/{w.meals_planned} meals</p></div>
        <div>
          <p className={`text-base font-black tabular-nums ${tone}`}>{w.off_days ? (w.off === 0 ? 'On target' : `${n0(Math.abs(w.off))} ${w.off > 0 ? 'over' : 'under'}`) : '-'}</p>
          <p className="text-[10px] text-gray-500">{w.off_days ? `on ${w.off_days} fully logged day${w.off_days === 1 ? '' : 's'}` : 'log a whole day to see'}</p>
        </div>
      </div>
    </div>
  )
}

function PastDay({ d }) {
  const tone = !d.complete ? 'text-gray-500' : Math.abs(d.eaten - d.target) <= d.target * 0.1 ? 'text-green-700' : d.eaten > d.target ? 'text-red-600' : 'text-amber-700'
  return (
    <div className="card">
      <p className="text-sm font-black text-gray-900">{fmt(d.date)} <span className="text-[10px] font-bold text-gray-400">Day {d.day}</span></p>
      <div className="grid grid-cols-3 gap-1.5 mt-2">
        <div className="bg-amber-50 rounded-md px-2 py-1.5"><p className="text-sm font-black tabular-nums">{n0(d.target)}</p><p className="text-[9px] text-gray-500">kcal target</p></div>
        <div className="bg-amber-50 rounded-md px-2 py-1.5"><p className="text-sm font-black tabular-nums">{d.meals_logged ? n0(d.eaten) : '-'}</p><p className="text-[9px] text-gray-500">kcal you had ({d.meals_logged}/{d.meals_planned})</p></div>
        <div className="bg-amber-50 rounded-md px-2 py-1.5">
          <p className={`text-sm font-black tabular-nums ${tone}`}>{d.complete ? (d.eaten === d.target ? 'On target' : `${n0(Math.abs(d.eaten - d.target))} ${d.eaten > d.target ? 'over' : 'under'}`) : d.meals_logged ? 'Partly logged' : 'Not logged'}</p>
          <p className="text-[9px] text-gray-500">against target</p>
        </div>
      </div>
    </div>
  )
}
