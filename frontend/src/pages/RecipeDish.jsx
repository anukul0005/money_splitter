import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { recipeDish } from '../api'
import { SourceLine, readRecipe } from './Recipes'

const r0 = (n) => Math.round(n || 0)
const r1 = (n) => Math.round((n || 0) * 10) / 10

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
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    setD(null); setErr('')
    if (!name) { setErr('Which dish?'); return }
    recipeDish(name, 1, recipe).then((r) => setD(r.data))
      .catch((e) => setErr(e?.response?.data?.detail || "Couldn't open that dish - try again."))
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
