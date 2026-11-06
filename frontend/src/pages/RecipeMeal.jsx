import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { recipesMe } from '../api'
import { MealLog, dayLabel, planDate } from './Recipes'
import { EatenMeal, PlannedList, ROWS, SplitBar, fmtN } from './RecipeDish'

const r0 = (n) => Math.round(n || 0)
const total = (items, k) => items.reduce((t, x) => t + (x[k] || 0), 0)

/**
 * /recipes/meal?day=1&meal=breakfast - one meal of the week's plan. Logged:
 * what you had leads, compared with what was planned. Not yet: the planned
 * meal's numbers, and the box to log what you had.
 */
export default function RecipeMeal() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const day = parseInt(params.get('day')) || 1
  const meal = params.get('meal') || 'breakfast'
  const [me, setMe] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => { recipesMe().then((r) => setMe(r.data)).catch(() => setErr("Couldn't load the meal - try again.")) }, [])

  const plan = me?.plan
  const planned = plan?.days?.find((x) => x.day === day)?.meals?.[meal] || []
  const entry = me?.log?.[String(day)]?.[meal] || null
  const when = plan ? dayLabel(planDate(plan, day)) : `Day ${day}`
  const title = `${meal[0].toUpperCase()}${meal.slice(1)}`
  const back = () => (window.history.length > 1 ? nav(-1) : nav('/recommend?tab=recipes'))
  const setLog = (log, weeks) => setMe((m) => ({ ...m, log, weeks: weeks || m.weeks }))
  const n = Object.fromEntries(ROWS.map(([, k]) => [k, total(planned, k)]))
  const cost = planned.some((x) => x.cost != null) ? total(planned, 'cost') : null

  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={back} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <h1 className="text-xl font-black tracking-tight">{title}</h1>
        <p className="text-xs text-gray-400 mt-1">{when} · {entry ? 'what you had, beside the plan' : 'as planned - log what you had'}</p>
      </div>

      <div className="px-5 mt-4 space-y-4 max-w-2xl">
        {!me && !err && <div className="card text-center py-10"><div className="w-6 h-6 mx-auto border-2 border-brand-400 border-t-transparent rounded-full animate-spin" /></div>}
        {err && <p className="text-sm text-red-600">{err}</p>}

        {me && entry && (
          <>
            <EatenMeal day={day} meal={meal} entry={entry} planned={planned} when={when} />
            <div className="card">
              <MealLog day={day} meal={meal} entry={entry} planned={planned} onLog={setLog} />
            </div>
          </>
        )}

        {me && !entry && planned.length > 0 && (
          <>
            <div className="card">
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{when} · {meal} - planned</p>
              <p className="text-3xl font-black text-gray-900 leading-none mt-2">{r0(n.kcal)} <span className="text-sm font-bold text-gray-400">kcal</span>
                {cost != null && <span className="ml-2 text-sm font-bold text-gray-500">₹{r0(cost)}</span>}</p>
              <SplitBar n={n} />
              <table className="w-full text-xs mt-3">
                <tbody>
                  {ROWS.map(([label, k, u]) => (
                    <tr key={k} className="border-t border-amber-100 first:border-0">
                      <td className="py-1.5 text-gray-600">{label}</td>
                      <td className="text-right tabular-nums font-black text-gray-900">{fmtN(k, n[k])}{u}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mt-3">The dishes</p>
              <PlannedList items={planned} day={day} meal={meal} />
            </div>
            <div className="card">
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">What you had</p>
              <MealLog day={day} meal={meal} entry={null} planned={planned} onLog={setLog} />
            </div>
          </>
        )}

        {me && !entry && !planned.length && <p className="text-sm text-gray-500">Nothing planned for this meal.</p>}
      </div>
    </div>
  )
}
