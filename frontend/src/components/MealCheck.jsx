import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { recipesMe } from '../api'
import { MealLog, dayLabel, planDate } from '../pages/Recipes'

// When each meal is taken to be over - after this it's asked about
const DUE = { breakfast: [10, 30], lunch: [15, 0], snack: [18, 30], dinner: [22, 0] }
const ORDER = ['breakfast', 'lunch', 'snack', 'dinner']
const SKIP_KEY = 'mealcheck_skipped'
const skipped = () => { try { return JSON.parse(localStorage.getItem(SKIP_KEY) || '[]') } catch { return [] } }

/**
 * Home: with a meal plan for this week, the latest meal that's over and not
 * logged yet is asked about - had it as planned, or what you had instead
 * (typed or said, any language). "Not now" skips that meal for good.
 */
export default function MealCheck() {
  const [me, setMe] = useState(null)
  const [skip, setSkip] = useState(skipped)
  const [done, setDone] = useState('')

  useEffect(() => { recipesMe().then((r) => setMe(r.data)).catch(() => {}) }, [])
  const plan = me?.plan
  if (!plan?.days?.length) return null

  // Meals of yesterday and today that are over, not logged, not skipped - latest first
  const now = new Date()
  const open = []
  for (const d of plan.days) {
    const date = planDate(plan, d.day)
    const age = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - date) / 86400000)
    if (age < 0 || age > 1) continue
    for (const meal of ORDER) {
      const xs = d.meals?.[meal] || []
      if (!xs.length || me.log?.[String(d.day)]?.[meal]) continue
      const [h, m] = DUE[meal]
      const due = new Date(date); due.setHours(h, m, 0, 0)
      const id = `${plan.made_at}:${d.day}:${meal}`
      if (due <= now && !skip.includes(id)) open.push({ day: d.day, meal, xs, date, id, due })
    }
  }
  open.sort((a, b) => b.due - a.due)
  const cur = open[0]
  if (!cur) {
    return done ? <div className="card bg-green-50 border-green-200 text-xs font-bold text-green-800">✓ {done}</div> : null
  }

  const notNow = () => {
    const next = [...skip, cur.id].slice(-60)
    setSkip(next)
    try { localStorage.setItem(SKIP_KEY, JSON.stringify(next)) } catch { /* storage blocked */ }
  }
  const isToday = cur.date.toDateString() === now.toDateString()
  return (
    <div className="card border-brand-400/60 bg-amber-50/60">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{isToday ? 'Today' : 'Yesterday'} · {dayLabel(cur.date)}</p>
          <p className="text-sm font-black text-gray-900 mt-0.5">Did you have the planned {cur.meal}?</p>
        </div>
        <button onClick={notNow} className="text-[11px] font-bold text-gray-400 flex-shrink-0">Not now</button>
      </div>
      <div className="mt-1">
        {cur.xs.map((x, i) => (
          <p key={i} className="text-xs text-gray-700">{x.name} <span className="text-gray-400">× {x.servings} {x.unit} · {Math.round(x.kcal)} kcal</span></p>
        ))}
      </div>
      <MealLog key={cur.id} day={cur.day} meal={cur.meal} planned={cur.xs} entry={null}
        onLog={(log) => { setMe((m) => ({ ...m, log })); setDone(`${cur.meal[0].toUpperCase()}${cur.meal.slice(1)} logged`) }} />
      <div className="flex justify-between mt-1.5">
        {open.length > 1 ? <span className="text-[10px] text-gray-500">{open.length - 1} more meal{open.length > 2 ? 's' : ''} to log after this</span> : <span />}
        <Link to="/recommend?tab=recipes" className="text-[10px] font-bold text-brand-600">The whole plan →</Link>
      </div>
    </div>
  )
}
