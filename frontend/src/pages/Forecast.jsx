import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getForecastBudget, getForecastItems, getRecommendMeta, getFoodMeta, getFriends,
} from '../api'

import LoadingSpinner from '../components/LoadingSpinner'
import RecommendTabs from '../components/RecommendTabs'
import { useUser } from '../UserContext'

// Same helper as Recommend.jsx / RecommendFood.jsx, duplicated rather than
// imported - both of those keep their own copy too, since a shared page each
// renders independently is not worth a new file for one function.
const INR = (n) => {
  const v = Number(n)
  return Number.isFinite(v)
    ? `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
    : '—'
}

const FALLBACK_STATES = ['Delhi', 'Maharashtra', 'Uttar Pradesh']
const FALLBACK_CITIES = ['Delhi', 'Gurugram', 'Noida']

// The three sizes spirits are actually sold in, same as the Drinks tab - a
// forecast line for "2 quarters of Old Monk" needs the same vocabulary the
// recommender already uses, not a fourth invented one.
const SIZES = [
  ['180', 'Quarter · 180ml'],
  ['375', 'Half · 375ml'],
  ['750', 'Full · 750ml'],
  ['650', 'Beer · 650ml'],
  ['330', 'Beer · 330ml'],
]

/**
 * How much this session is actually going to cost.
 *
 * Two directions on the same question, switched between rather than shown
 * together because they start from opposite ends: one takes a total and
 * splits it, the other takes a shopping list and totals it.
 *
 * Both route through the same machinery /recommend already has - the
 * cross-state price catalogue, and this person's own historical spending -
 * so a number here is never one a real pick list would disagree with.
 */
export default function Forecast({ tab, setTab }) {
  const nav  = useNavigate()
  const user = useUser()

  const [mode, setMode] = useState('budget')   // 'budget' | 'items'
  const [drinkMeta, setDrinkMeta] = useState(null)
  const [foodMeta, setFoodMeta]   = useState(null)
  const [friends, setFriends]     = useState([])
  const [withWho, setWithWho]     = useState([])

  useEffect(() => {
    getRecommendMeta()
      .then((r) => setDrinkMeta(r.data))
      .catch(() => setDrinkMeta({ states: FALLBACK_STATES }))
    getFoodMeta()
      .then((r) => setFoodMeta(r.data))
      .catch(() => setFoodMeta({ cities: FALLBACK_CITIES }))
    getFriends(user?.name)
      .then((f) => setFriends(f.data.map((x) => x.name)))
      .catch(() => setFriends([]))
  }, [user?.name])

  const toggle = (n) =>
    setWithWho((cur) => (cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]))

  // ── Budget → split ──────────────────────────────────────────────────────
  const [people, setPeople]   = useState('2')
  const [budget, setBudget]   = useState('3000')
  const [beerOnly, setBeerOnly] = useState(false)
  const [state, setState]     = useState('')
  const [city, setCity]       = useState('')
  const [result, setResult]   = useState(null)
  const [error, setError]     = useState('')
  const [busy, setBusy]       = useState(false)

  useEffect(() => {
    if (drinkMeta?.states?.length && !state) setState(drinkMeta.states[0])
  }, [drinkMeta])
  useEffect(() => {
    if (foodMeta?.cities?.length && !city) setCity(foodMeta.cities[0])
  }, [foodMeta])

  const peopleN = Math.max(1, parseInt(people, 10) || 0)
  const budgetN = Math.max(0, parseFloat(budget) || 0)

  const runBudget = async () => {
    setError(''); setBusy(true); setResult(null)
    try {
      const r = await getForecastBudget({
        people: peopleN, budget: budgetN, beer_only: beerOnly,
        state, city, names: withWho.join(','),
      })
      setResult(r.data)
    } catch (err) {
      setError(err.response?.data?.detail || `Could not forecast (${err.response?.status || 'network error'}).`)
    } finally { setBusy(false) }
  }

  // ── Items → total ───────────────────────────────────────────────────────
  const [itemState, setItemState] = useState('')
  const [drinkLines, setDrinkLines] = useState([{ brand: '', size_ml: '750', qty: '1' }])
  const [foodLines, setFoodLines]   = useState([{ name: '', amount: '' }])
  const [itemResult, setItemResult] = useState(null)
  const [itemError, setItemError]   = useState('')
  const [itemBusy, setItemBusy]     = useState(false)

  useEffect(() => {
    if (drinkMeta?.states?.length && !itemState) setItemState(drinkMeta.states[0])
  }, [drinkMeta])

  const setDrinkLine = (i, patch) =>
    setDrinkLines((cur) => cur.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  const setFoodLine = (i, patch) =>
    setFoodLines((cur) => cur.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))

  const runItems = async () => {
    setItemError(''); setItemBusy(true); setItemResult(null)
    const drinks = drinkLines
      .filter((l) => l.brand.trim())
      .map((l) => ({ brand: l.brand.trim(), size_ml: parseInt(l.size_ml, 10), qty: Math.max(1, parseInt(l.qty, 10) || 1) }))
    const food = foodLines
      .filter((l) => l.name.trim() && parseFloat(l.amount) > 0)
      .map((l) => ({ name: l.name.trim(), amount: parseFloat(l.amount) }))
    if (!drinks.length && !food.length) {
      setItemError('Add at least one drink or food line first.')
      setItemBusy(false)
      return
    }
    try {
      const r = await getForecastItems({
        people: Math.max(1, parseInt(people, 10) || 0), state: itemState, drinks, food,
      })
      setItemResult(r.data)
    } catch (err) {
      setItemError(err.response?.data?.detail || `Could not forecast (${err.response?.status || 'network error'}).`)
    } finally { setItemBusy(false) }
  }

  if (!drinkMeta || !foodMeta) return <LoadingSpinner />

  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <h1 className="text-xl font-black tracking-tight">What will this cost</h1>
        <p className="text-xs text-gray-400 mt-1">
          Split a budget, or price out exactly what you're having
        </p>
        <RecommendTabs tab={tab} setTab={setTab} />

        <div className="flex gap-1 mt-2 bg-amber-100/60 rounded-lg p-0.5">
          {[['budget', 'I have a budget'], ['items', "I know what I'm having"]].map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => setMode(v)}
              className={`flex-1 rounded-md py-1.5 text-xs font-bold transition-all ${
                mode === v ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {mode === 'budget' ? (
        <div className="px-5 mt-4 space-y-4 max-w-2xl">
          <div className="card space-y-3">
            <label className="flex items-center gap-2 text-xs font-bold text-gray-600">
              <input type="checkbox" checked={beerOnly} onChange={(e) => setBeerOnly(e.target.checked)} />
              Just beer — no disposable glasses needed
            </label>

            <div>
              <label className="label">People</label>
              <input
                className="input font-bold" type="number" min="1" max="30" inputMode="numeric"
                value={people} onChange={(e) => setPeople(e.target.value)}
                onBlur={() => setPeople((v) => (parseInt(v, 10) > 0 ? String(parseInt(v, 10)) : '1'))}
              />
            </div>

            <div>
              <label className="label">Total budget</label>
              <input
                className="input font-bold" type="number" min="0" step="50" inputMode="numeric"
                value={budget} onChange={(e) => setBudget(e.target.value)}
              />
            </div>

            <div>
              <label className="label">State (for drink prices)</label>
              <select className="input" value={state} onChange={(e) => setState(e.target.value)}>
                {(drinkMeta?.states ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <p className="text-[10px] text-gray-400 mt-1">
                A bottle this state doesn't sell is still priced — at whatever
                the cheapest other state charges for it, labelled as such.
              </p>
            </div>

            <div>
              <label className="label">City (for food prices)</label>
              <select className="input" value={city} onChange={(e) => setCity(e.target.value)}>
                {(foodMeta?.cities ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            {friends.length > 0 && (
              <div>
                <label className="label">Whose history? (optional)</label>
                <div className="flex flex-wrap gap-1.5">
                  {friends.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => toggle(n)}
                      className={`rounded-md px-2.5 py-1 text-xs font-bold border transition-all active:scale-95 ${
                        withWho.includes(n)
                          ? 'bg-brand-400 border-brand-400 text-white'
                          : 'bg-cream border-amber-200 text-gray-600 hover:bg-amber-50'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-gray-400 mt-1">
                  Nobody picked uses just your own history to work out the
                  drinks/food split.
                </p>
              </div>
            )}

            <button onClick={runBudget} className="btn-primary" disabled={busy || budgetN <= 0}>
              {busy ? 'Working it out…' : 'Forecast'}
            </button>
            {error && <p className="text-xs text-red-500 font-bold">{error}</p>}
          </div>

          {result && (
            <div className="space-y-3">
              {result.shortfall > 0 && (
                <div className="card p-3.5 bg-red-50 border-red-200">
                  <p className="text-xs font-bold text-red-600">
                    Glasses and snacks alone come to {INR(result.extras.total)} — that's
                    {' '}{INR(result.shortfall)} more than the whole budget for {result.people} people.
                    Raise the budget or drop to fewer people.
                  </p>
                </div>
              )}

              <div className="card p-3.5">
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Extras</p>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">
                    Disposable glasses{result.beer_only ? ' (skipped — beer only)' : ` (₹${result.extras.glass_cost} × ${result.people})`}
                  </span>
                  <span className="font-bold">{INR(result.extras.glasses)}</span>
                </div>
                <div className="flex justify-between text-sm mt-1">
                  <span className="text-gray-600">
                    Snacks (₹{result.extras.snack_cost_per_person} × {result.people})
                  </span>
                  <span className="font-bold">{INR(result.extras.snacks)}</span>
                </div>
                <div className="flex justify-between text-sm mt-1 pt-1 border-t border-amber-100">
                  <span className="font-bold text-gray-700">Extras total</span>
                  <span className="font-black text-brand-600">{INR(result.extras.total)}</span>
                </div>
              </div>

              <div className="card p-3.5">
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">
                  Split of the remaining {INR(result.remaining)}
                </p>
                <p className="text-[10px] text-gray-400 mb-2">
                  {result.ratio_source === 'history'
                    ? "Based on your own past drinks-with-food sessions"
                    : "No history yet — using a starting 55/45 lean towards drinks"}
                </p>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Drinks ({Math.round(result.drink_share * 100)}%)</span>
                  <span className="font-black text-brand-600">{INR(result.drink_budget)}</span>
                </div>
                <div className="flex justify-between text-sm mt-1">
                  <span className="text-gray-600">Food ({Math.round(result.food_share * 100)}%)</span>
                  <span className="font-black text-brand-600">{INR(result.food_budget)}</span>
                </div>
              </div>

              {(result.drink_budget > 0) && (
                <div className="card p-3.5">
                  <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">
                    Drinks — around {INR(result.drink_budget)}
                    {result.drink_band && ` (₹${result.drink_band.min}–₹${result.drink_band.max})`}
                  </p>
                  {result.drink_preview?.sample?.length ? (
                    <div className="space-y-1.5">
                      {result.drink_preview.sample.map((p, i) => (
                        <div key={`${p.brand}-${i}`} className="flex justify-between text-xs">
                          <span className="font-semibold text-gray-700 truncate pr-2">
                            {p.brand}{p.is_price_fallback && (
                              <span className="text-amber-600 font-normal"> (from {p.state})</span>
                            )}
                          </span>
                          <span className="font-black text-brand-600 flex-shrink-0">{INR(p.total ?? p.price)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-gray-400">
                      Pick a state above to see real bottles this buys.
                    </p>
                  )}
                </div>
              )}

              {(result.food_budget > 0) && (
                <div className="card p-3.5">
                  <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">
                    Food — around {INR(result.food_budget)}
                    {result.food_band && ` (₹${result.food_band.min}–₹${result.food_band.max})`}
                  </p>
                  {result.food_preview?.sample?.length ? (
                    <div className="space-y-1.5">
                      {result.food_preview.sample.map((p, i) => (
                        <div key={`${p.name}-${i}`} className="flex justify-between text-xs">
                          <span className="font-semibold text-gray-700 truncate pr-2">{p.name}</span>
                          <span className="font-black text-brand-600 flex-shrink-0">{INR(p.total)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-gray-400">
                      Pick a city above to see real places this buys.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="px-5 mt-4 space-y-4 max-w-2xl">
          <div className="card space-y-3">
            <div>
              <label className="label">People</label>
              <input
                className="input font-bold" type="number" min="1" max="30" inputMode="numeric"
                value={people} onChange={(e) => setPeople(e.target.value)}
              />
            </div>
            <div>
              <label className="label">State (for drink prices)</label>
              <select className="input" value={itemState} onChange={(e) => setItemState(e.target.value)}>
                {(drinkMeta?.states ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div className="card space-y-3">
            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Drinks</p>
            {drinkLines.map((l, i) => (
              <div key={i} className="flex gap-1.5 items-start">
                <input
                  className="input flex-1 min-w-0" placeholder="e.g. Old Monk"
                  value={l.brand} onChange={(e) => setDrinkLine(i, { brand: e.target.value })}
                />
                <select
                  className="input w-auto flex-shrink-0" value={l.size_ml}
                  onChange={(e) => setDrinkLine(i, { size_ml: e.target.value })}
                >
                  {SIZES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
                <input
                  className="input w-14 flex-shrink-0 text-center" type="number" min="1"
                  value={l.qty} onChange={(e) => setDrinkLine(i, { qty: e.target.value })}
                />
                <button
                  type="button" onClick={() => setDrinkLines((cur) => cur.filter((_, idx) => idx !== i))}
                  className="text-gray-300 hover:text-red-500 px-1 flex-shrink-0"
                >✕</button>
              </div>
            ))}
            <p className="text-[10px] text-gray-400">
              Use the specific name off the bottle where you can — "Kingfisher
              Strong" matches, a bare "Kingfisher" is too generic to place.
            </p>
            <button
              type="button"
              onClick={() => setDrinkLines((cur) => [...cur, { brand: '', size_ml: '750', qty: '1' }])}
              className="text-xs font-bold text-brand-600 hover:text-brand-700"
            >
              + Add a drink
            </button>
          </div>

          <div className="card space-y-3">
            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Food</p>
            {foodLines.map((l, i) => (
              <div key={i} className="flex gap-1.5 items-start">
                <input
                  className="input flex-1 min-w-0" placeholder="e.g. Dinner for the table"
                  value={l.name} onChange={(e) => setFoodLine(i, { name: e.target.value })}
                />
                <input
                  className="input w-24 flex-shrink-0" type="number" min="0" placeholder="₹"
                  value={l.amount} onChange={(e) => setFoodLine(i, { amount: e.target.value })}
                />
                <button
                  type="button" onClick={() => setFoodLines((cur) => cur.filter((_, idx) => idx !== i))}
                  className="text-gray-300 hover:text-red-500 px-1 flex-shrink-0"
                >✕</button>
              </div>
            ))}
            <p className="text-[10px] text-gray-400">
              There's no per-dish price list here — type what you expect this
              to cost, same as you would when adding an expense.
            </p>
            <button
              type="button"
              onClick={() => setFoodLines((cur) => [...cur, { name: '', amount: '' }])}
              className="text-xs font-bold text-brand-600 hover:text-brand-700"
            >
              + Add a food line
            </button>
          </div>

          <button onClick={runItems} className="btn-primary" disabled={itemBusy}>
            {itemBusy ? 'Pricing it out…' : 'Total it up'}
          </button>
          {itemError && <p className="text-xs text-red-500 font-bold">{itemError}</p>}

          {itemResult && (
            <div className="space-y-3">
              {itemResult.drinks.length > 0 && (
                <div className="card p-3.5">
                  <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Drinks</p>
                  {itemResult.drinks.map((d, i) => (
                    <div key={i} className="flex justify-between text-xs py-0.5">
                      <span className={`truncate pr-2 ${d.matched ? 'text-gray-700 font-semibold' : 'text-gray-400'}`}>
                        {d.qty} × {d.matched ? d.brand : d.brand}
                        {d.matched && d.is_price_fallback && (
                          <span className="text-amber-600 font-normal"> (from {d.state})</span>
                        )}
                        {!d.matched && <span className="text-red-400 font-normal"> — not matched</span>}
                      </span>
                      <span className="font-black text-brand-600 flex-shrink-0">{INR(d.total)}</span>
                    </div>
                  ))}
                  {itemResult.drinks.some((d) => !d.matched) && (
                    <p className="text-[10px] text-red-400 mt-1">
                      {itemResult.drinks.find((d) => !d.matched)?.note}
                    </p>
                  )}
                  <div className="flex justify-between text-sm mt-1.5 pt-1.5 border-t border-amber-100">
                    <span className="font-bold text-gray-700">Drinks total</span>
                    <span className="font-black text-brand-600">{INR(itemResult.drink_total)}</span>
                  </div>
                </div>
              )}

              {itemResult.food.length > 0 && (
                <div className="card p-3.5">
                  <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Food</p>
                  {itemResult.food.map((f, i) => (
                    <div key={i} className="flex justify-between text-xs py-0.5">
                      <span className="text-gray-700 font-semibold truncate pr-2">{f.name}</span>
                      <span className="font-black text-brand-600 flex-shrink-0">{INR(f.amount)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between text-sm mt-1.5 pt-1.5 border-t border-amber-100">
                    <span className="font-bold text-gray-700">Food total</span>
                    <span className="font-black text-brand-600">{INR(itemResult.food_total)}</span>
                  </div>
                </div>
              )}

              <div className="card p-3.5">
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Extras</p>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">
                    Disposable glasses (₹{itemResult.extras.glass_cost} × {itemResult.people})
                  </span>
                  <span className="font-bold">{INR(itemResult.extras.glasses)}</span>
                </div>
                <div className="flex justify-between text-sm mt-1">
                  <span className="text-gray-600">
                    Snacks (₹{itemResult.extras.snack_cost_per_person} × {itemResult.people})
                  </span>
                  <span className="font-bold">{INR(itemResult.extras.snacks)}</span>
                </div>
              </div>

              <div className="card p-4 bg-brand-50 border-brand-200">
                <div className="flex justify-between items-baseline">
                  <span className="text-sm font-bold text-gray-700">Grand total</span>
                  <span className="text-xl font-black text-brand-600">{INR(itemResult.grand_total)}</span>
                </div>
                <div className="flex justify-between items-baseline mt-1">
                  <span className="text-xs text-gray-500">Per head ({itemResult.people})</span>
                  <span className="text-sm font-bold text-gray-600">{INR(itemResult.per_head)}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
