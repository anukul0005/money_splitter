import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { recipeDish, recipesMe } from '../api'
import { MealLog, SourceLine, cachedDish, dayLabel, keepDish, planDate, readRecipe } from './Recipes'

const r0 = (n) => Math.round(n || 0)
const r1 = (n) => Math.round((n || 0) * 10) / 10
const ROWS = [['Calories', 'kcal', ''], ['Protein', 'protein', 'g'], ['Carbs', 'carbs', 'g'], ['Fat', 'fat', 'g'],
              ['Fibre', 'fibre', 'g'], ['Sugar', 'sugar', 'g'], ['Sodium', 'sodium_mg', 'mg']]
const fmtN = (k, v) => (k === 'kcal' || k === 'sodium_mg' ? r0(v) : r1(v))
const total = (items, k) => items.reduce((t, x) => t + (x[k] || 0), 0)

// Share of the calories from protein, carbs and fat (4, 4 and 9 kcal a gram)
function SplitBar({ n }) {
  const p = 4 * (n.protein || 0), c = 4 * (n.carbs || 0), f = 9 * (n.fat || 0)
  const all = p + c + f || 1
  const pct = { protein: r0(p / all * 100), carbs: r0(c / all * 100), fat: r0(f / all * 100) }
  return (
    <>
      <div className="flex h-2.5 rounded-full overflow-hidden mt-3 bg-gray-100">
        <div className="bg-green-500" style={{ width: `${pct.protein}%` }} />
        <div className="bg-amber-400" style={{ width: `${pct.carbs}%` }} />
        <div className="bg-red-400" style={{ width: `${pct.fat}%` }} />
      </div>
      <div className="flex justify-between text-[10px] font-bold mt-1">
        <span className="text-green-700">Protein {pct.protein}%</span>
        <span className="text-amber-700">Carbs {pct.carbs}%</span>
        <span className="text-red-600">Fat {pct.fat}%</span>
      </div>
    </>
  )
}

function PlannedList({ items, day, meal, current }) {
  if (!items?.length) return null
  return (
    <div className="mt-1 mb-1">
      {items.map((x, i) => {
        const here = x.name === current
        const href = `/recipes/dish?${new URLSearchParams({ name: x.name, s: String(x.servings), u: x.unit || '', day: String(day), meal })}`
        return (
          <div key={i} className="flex items-baseline justify-between gap-2 text-xs py-0.5">
            {here ? <span className="text-gray-800 font-bold min-w-0">{x.name} <span className="font-normal text-gray-400">× {x.servings} {x.unit} · this page</span></span>
              : <Link to={href} className="text-gray-800 min-w-0 underline decoration-amber-300 underline-offset-2">{x.name} <span className="text-gray-400">× {x.servings} {x.unit}</span></Link>}
            <span className="text-gray-500 tabular-nums flex-shrink-0">{r0(x.kcal)} kcal · {r0(x.protein)} g P</span>
          </div>
        )
      })}
    </div>
  )
}

/** The meal as eaten, first: its numbers, then side by side with the plan's. */
function EatenMeal({ day, meal, entry, planned, when }) {
  const had = entry.totals
  const plan = Object.fromEntries(ROWS.map(([, k]) => [k, total(planned, k)]))
  const planCost = planned.some((x) => x.cost != null) ? total(planned, 'cost') : null
  const hasPlan = planned.length > 0
  return (
    <div className="card">
      <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{when || `Day ${day}`} · {meal} - what you had</p>
      <p className="text-3xl font-black text-gray-900 leading-none mt-2">{r0(had.kcal)} <span className="text-sm font-bold text-gray-400">kcal</span>
        {hasPlan && (() => {
          const diff = r0(had.kcal - plan.kcal)
          return <span className={`ml-2 text-sm font-bold ${Math.abs(diff) <= plan.kcal * 0.1 ? 'text-green-700' : diff > 0 ? 'text-red-600' : 'text-amber-700'}`}>{diff === 0 ? 'as planned' : `${diff > 0 ? '+' : ''}${diff} vs plan`}</span>
        })()}
      </p>
      <SplitBar n={had} />
      <p className="text-[10px] text-gray-400 mt-0.5">Share of the calories (protein and carbs 4 kcal a gram, fat 9)</p>

      <table className="w-full text-xs mt-3">
        <thead><tr className="text-[10px] text-gray-400 text-left">
          <th className="font-bold pb-1" /><th className="font-bold text-right pb-1 text-gray-900">You had</th>
          {hasPlan && <><th className="font-bold text-right pb-1">Planned</th><th className="font-bold text-right pb-1">Difference</th></>}
        </tr></thead>
        <tbody>
          {ROWS.map(([label, k, u]) => {
            const diff = (had[k] || 0) - (plan[k] || 0)
            // More protein and fibre is the good way round; for the rest, less
            const good = ['protein', 'fibre'].includes(k) ? diff >= 0 : diff <= 0
            return (
              <tr key={k} className="border-t border-amber-100">
                <td className="py-1.5 text-gray-600">{label}</td>
                <td className="text-right tabular-nums font-black text-gray-900">{fmtN(k, had[k])}{u}</td>
                {hasPlan && <>
                  <td className="text-right tabular-nums text-gray-500">{fmtN(k, plan[k])}{u}</td>
                  <td className={`text-right tabular-nums font-bold ${Math.abs(diff) < 0.5 ? 'text-gray-400' : good ? 'text-green-700' : 'text-red-600'}`}>
                    {Math.abs(diff) < 0.5 ? '-' : `${diff > 0 ? '+' : '−'}${fmtN(k, Math.abs(diff))}${u}`}
                  </td>
                </>}
              </tr>
            )
          })}
          <tr className="border-t border-amber-100">
            <td className="py-1.5 text-gray-600">Cost</td>
            <td className="text-right tabular-nums font-black text-gray-900">{entry.cost != null ? `₹${entry.cost}` : '-'}</td>
            {hasPlan && <>
              <td className="text-right tabular-nums text-gray-500">{planCost != null ? `₹${r0(planCost)}` : '-'}</td>
              <td className="text-right tabular-nums font-bold text-gray-500">{entry.cost != null && planCost != null ? `${entry.cost - planCost >= 0 ? '+' : '−'}₹${r0(Math.abs(entry.cost - planCost))}` : '-'}</td>
            </>}
          </tr>
        </tbody>
      </table>
      {entry.unknown?.length > 0 && <p className="text-[10px] text-amber-700 mt-1">Not in these numbers (couldn't work out): {entry.unknown.join(', ')}</p>}

      {hasPlan && (
        <div className="mt-3">
          <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">What was planned</p>
          <PlannedList items={planned} day={day} meal={meal} />
        </div>
      )}
    </div>
  )
}

/**
 * /recipes/dish?name=…&s=1.5&u=bowl - one dish on its own page: photo, the
 * full breakdown for a serving and for the portion eaten, effective cost,
 * priced ingredients and the method. `r` names a recipe the AI wrote (kept
 * on this device when its link was opened), so it shows as written.
 */
export default function RecipeDish() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const name = params.get('name') || ''
  const unit = params.get('u') || ''
  const recipe = readRecipe(params.get('r'))
  const [servings, setServings] = useState(() => Math.max(0.5, parseFloat(params.get('s')) || 1))
  // Another dish of the meal opened from here: its own portion
  useEffect(() => { setServings(Math.max(0.5, parseFloat(params.get('s')) || 1)) }, [params.get('name'), params.get('s')])
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  // Opened from a meal of the plan: what was actually had there can be logged here
  const day = parseInt(params.get('day')) || null
  const meal = params.get('meal') || null
  const [log, setLog] = useState(null)
  const [planned, setPlanned] = useState([])      // what the plan has for this meal
  const [when, setWhen] = useState(day ? `Day ${day}` : '')   // the plan's date for that day
  useEffect(() => {
    if (!day || !meal) return
    recipesMe().then((r) => {
      setLog(r.data.log || {})
      setPlanned(r.data.plan?.days?.find((x) => x.day === day)?.meals?.[meal] || [])
      if (r.data.plan) setWhen(dayLabel(planDate(r.data.plan, day)))
    }).catch(() => setLog({}))
  }, [day, meal])
  const entry = day && meal ? log?.[String(day)]?.[meal] : null

  useEffect(() => {
    setErr('')
    if (!name) { setErr('Which dish?'); return }
    // The copy kept on this device shows at once; the server's replaces it
    const rKey = params.get('r')
    const kept = cachedDish(name, rKey)
    setD(kept)
    recipeDish(name, 1, recipe).then((r) => { setD(r.data); keepDish(name, rKey, r.data) })
      .catch((e) => { if (!kept) setErr(e?.response?.data?.detail || "Couldn't open that dish - try again.") })
  }, [name])

  const back = () => (window.history.length > 1 ? nav(-1) : nav('/recommend?tab=recipes'))
  const n = d?.nutrition
  const s = servings
  const rows = [['Calories', 'kcal', ''], ['Protein', 'protein', 'g'], ['Carbs', 'carbs', 'g'], ['Fat', 'fat', 'g'],
                ['Fibre', 'fibre', 'g'], ['Sugar', 'sugar', 'g'], ['Sodium', 'sodium_mg', 'mg']]
  const fmt = (k, v) => (k === 'kcal' || k === 'sodium_mg' ? r0(v) : r1(v))
  const cost = d?.cost?.total
  const unitOf = d?.indb?.serving?.unit || unit || 'serving'

  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={back} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <h1 className="text-xl font-black tracking-tight leading-tight">{name || 'Dish'}</h1>
        <p className="text-xs text-gray-400 mt-1">
          {d?.indb && d.indb.name !== name ? `INDB: ${d.indb.name}` : 'Nutrition and cost worked out - not guessed'}
          {d?.time_min ? ` · ${d.time_min} min` : ''}
        </p>
      </div>

      <div className="px-5 mt-4 space-y-4 max-w-2xl">
        {!d && !err && (
          <div className="card text-center py-10">
            <div className="w-6 h-6 mx-auto border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
            <p className="text-xs text-gray-500 mt-2">Working out the numbers…</p>
          </div>
        )}
        {err && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-4 py-3">{err}</p>}

        {/* Logged: the meal as eaten leads - its numbers, beside what was planned */}
        {entry && (
          <>
            <EatenMeal day={day} meal={meal} entry={entry} planned={planned} when={when} />
            <div className="card">
              <MealLog day={day} meal={meal} entry={entry} onLog={setLog} />
            </div>
            <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest pt-2">The planned dish</p>
          </>
        )}

        {d && (
          <>
            {d.photo && (
              <div className="relative">
                <img src={d.photo.url} alt={name} className="w-full h-56 md:h-72 object-cover rounded-md border border-amber-100" />
                <a href={d.photo.page} target="_blank" rel="noreferrer"
                  className="absolute bottom-1.5 right-2 text-[9px] text-white/90 bg-black/40 rounded px-1.5 py-0.5">Photo: {d.photo.title} · Wikipedia</a>
              </div>
            )}

            {/* Portion */}
            <div className="flex items-center justify-between card py-2.5">
              <span className="text-xs font-bold text-gray-700">Your portion</span>
              <span className="flex items-center gap-2">
                <button onClick={() => setServings((x) => Math.max(0.5, x - 0.5))} className="w-8 h-8 border border-amber-300 rounded-md font-bold text-gray-700">−</button>
                <span className="text-sm font-black text-gray-900 tabular-nums w-28 text-center">{s} {unitOf}</span>
                <button onClick={() => setServings((x) => Math.min(6, x + 0.5))} className="w-8 h-8 border border-amber-300 rounded-md font-bold text-gray-700">+</button>
              </span>
            </div>

            {/* Not logged yet: what the plan has for this meal, and the box to log it */}
            {day && meal && log && !entry && (
              <div className="card">
                <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{when} · {meal} - planned</p>
                <PlannedList items={planned} day={day} meal={meal} current={d.indb?.name || name} />
                <MealLog day={day} meal={meal} entry={null} onLog={setLog} add
                  planned={[{ name: d.indb?.name || name, servings: s }]}
                  quickLabel={`I had this - ${s} ${unitOf}`} />
                <p className="text-[10px] text-gray-400 mt-1">The quick button adds this dish to the meal; writing it out replaces the whole meal with what you write.</p>
              </div>
            )}

            {/* Calories and where they come from */}
            <div className="card">
              <p className="text-3xl font-black text-gray-900 leading-none">{r0(n.kcal * s)} <span className="text-sm font-bold text-gray-400">kcal</span></p>
              <div className="flex h-2.5 rounded-full overflow-hidden mt-3 bg-gray-100">
                <div className="bg-green-500" style={{ width: `${d.split.protein}%` }} />
                <div className="bg-amber-400" style={{ width: `${d.split.carbs}%` }} />
                <div className="bg-red-400" style={{ width: `${d.split.fat}%` }} />
              </div>
              <div className="flex justify-between text-[10px] font-bold mt-1">
                <span className="text-green-700">Protein {d.split.protein}%</span>
                <span className="text-amber-700">Carbs {d.split.carbs}%</span>
                <span className="text-red-600">Fat {d.split.fat}%</span>
              </div>
              <p className="text-[10px] text-gray-400 mt-0.5">Share of the calories (protein and carbs 4 kcal a gram, fat 9)</p>

              <table className="w-full text-xs mt-3">
                <thead><tr className="text-[10px] text-gray-400 text-left"><th className="font-bold pb-1" /><th className="font-bold text-right pb-1">1 {unitOf}</th><th className="font-bold text-right pb-1">Your {s}</th>{d.indb && <th className="font-bold text-right pb-1">Per 100 g</th>}</tr></thead>
                <tbody>
                  {rows.map(([label, k, u]) => (
                    <tr key={k} className="border-t border-amber-100">
                      <td className="py-1.5 text-gray-600">{label}</td>
                      <td className="text-right tabular-nums text-gray-800">{fmt(k, n[k])}{u}</td>
                      <td className="text-right tabular-nums font-black text-gray-900">{fmt(k, n[k] * s)}{u}</td>
                      {d.indb && <td className="text-right tabular-nums text-gray-500">{fmt(k, d.indb.per100[k])}{u}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Effective cost */}
            <div className="card">
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Effective cost</p>
              {cost != null ? (
                <>
                  <p className="text-lg font-black text-gray-900 mt-0.5">₹{r0(cost * s)} <span className="text-xs font-bold text-gray-500">for your {s} {unitOf} · ₹{r1(cost)} each</span></p>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <div className="bg-amber-50 rounded-md px-2.5 py-2"><p className="text-sm font-black text-gray-900">{d.effective.per_100_kcal != null ? `₹${d.effective.per_100_kcal}` : '-'}</p><p className="text-[10px] text-gray-500">a 100 kcal</p></div>
                    <div className="bg-amber-50 rounded-md px-2.5 py-2"><p className="text-sm font-black text-gray-900">{d.effective.per_10g_protein != null ? `₹${d.effective.per_10g_protein}` : '-'}</p><p className="text-[10px] text-gray-500">a 10 g of protein</p></div>
                  </div>
                  <p className="text-[10px] text-gray-400 mt-1.5">
                    {d.cost.basis === 'estimate' ? 'At typical Delhi shop prices (estimates).' : 'At today’s mandi prices where there are any (wholesale).'}
                    {d.cost.unpriced?.length > 0 && ` Not priced: ${d.cost.unpriced.join(', ')}.`}
                  </p>
                </>
              ) : <p className="text-xs text-gray-500 mt-0.5">Couldn't price its ingredients.</p>}
            </div>

            {/* Ingredients */}
            {d.ingredients?.length > 0 && (
              <div className="card">
                <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">Ingredients · for your {s} {unitOf}</p>
                <table className="w-full text-xs">
                  <tbody>
                    {d.ingredients.map((l, i) => (
                      <tr key={i} className="border-t border-amber-100 first:border-0">
                        <td className="py-1.5 pr-2 text-gray-800">{l.item}</td>
                        <td className="text-right tabular-nums text-gray-500">{r0(l.grams * s)} g</td>
                        <td className="text-right tabular-nums font-bold text-gray-800 w-16">{l.cost != null ? `₹${r1(l.cost * s)}` : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {d.steps?.length > 0 && (
              <div className="card">
                <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Method</p>
                <ol className="list-decimal list-inside space-y-1.5 text-sm text-gray-700">{d.steps.map((x, i) => <li key={i}>{x}</li>)}</ol>
              </div>
            )}

            <div className="text-[10px] text-gray-400">
              <SourceLine s={d.nutrition_source} />
              <p className="mt-0.5">Ingredients and method: suggested by AI. Every number on this page: worked out from the data, not by the AI.</p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
