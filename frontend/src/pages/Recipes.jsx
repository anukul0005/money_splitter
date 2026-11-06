import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { askRecipes, planRecipes, recipeDish, recipesMe, saveRecipesMe } from '../api'
import RecommendTabs from '../components/RecommendTabs'
import { Typewriter } from '../components/ExpenseChat'
import { useVoice, canRecord as micWorks } from '../components/useVoice'

/**
 * Recommend → Recipes: ask in plain words (typed or said) for Indian
 * recipes. The AI only suggests dishes and writes the method - every number
 * on this page is worked out on the server: nutrition from INDB (Indian
 * dishes) or USDA (ingredients), cost from each ingredient's grams and
 * price. Each card says which.
 */

const EXAMPLES = [
  'Suggest a high-protein breakfast under 350 calories',
  'What can I cook with paneer, mushrooms and curd?',
  'Give me a low-calorie dinner under ₹60',
  'Plan seven days of meals for weight loss',
  'Recommend recipes using what’s already in my kitchen',
  'Compare the cost and nutrition of rajma chawal and chole bhature',
]
const IDEAS = [
  ['Suggest ', 'a high-protein breakfast under 350 calories'],
  ['What can I cook with ', 'paneer, mushrooms and curd?'],
  ['Give me ', 'a low-calorie dinner under ₹60'],
  ['Plan ', 'seven days of meals for weight loss'],
  ['Compare ', 'rajma chawal and chole bhature'],
]
const ACTIVITY = [['sitting', 'Mostly sitting'], ['light', 'Light (walks)'], ['moderate', 'Exercise 3-5 days'], ['active', 'Very active']]
const PACE = [['slow', '¼ kg a week'], ['steady', '½ kg a week'], ['fast', '¾ kg a week'], ['maintain', 'Stay the same']]
const DIETS = [['veg', 'Veg'], ['egg', 'Veg + egg'], ['nonveg', 'Non-veg'], ['any', 'Anything']]
const r0 = (n) => Math.round(n || 0)
const r1 = (n) => Math.round((n || 0) * 10) / 10
const chip = (on) => `px-2.5 py-1 text-[11px] font-bold border rounded-md ${on ? 'bg-brand-400 text-white border-brand-400' : 'bg-white text-gray-600 border-amber-200'}`

export default function Recipes({ tab, setTab }) {
  const nav = useNavigate()
  const [me, setMe]         = useState(null)     // { profile, pantry, targets, sources }
  const [q, setQ]           = useState('')
  const [focused, setFocused] = useState(false)
  const [busy, setBusy]     = useState('')        // what's being worked out
  const [err, setErr]       = useState('')
  const [result, setResult] = useState(null)
  const [asked, setAsked]   = useState('')
  const [showMe, setShowMe] = useState(false)
  const [opened, setOpened] = useState(null)    // { name, servings, unit?, recipe? } - the dish page open

  useEffect(() => { recipesMe().then((r) => setMe(r.data)).catch(() => setMe({ profile: {}, pantry: [] })) }, [])

  const voice = useVoice({
    onText: (said) => { setErr(''); setQ((p) => (p.trim() ? `${p.trim()} ${said}` : said)) },
    onError: setErr,
  })

  const ask = async (text) => {
    const question = (text ?? q).trim()
    if (question.length < 3 || busy) return
    setQ(question); setAsked(question); setErr(''); setResult(null)
    setBusy(/plan|week|days/i.test(question) ? 'Planning the week - picking dishes and working out each day…' : 'Finding recipes and working out their numbers…')
    try {
      const { data } = await askRecipes(question)
      setResult(data)
      if (data.need_profile) setShowMe(true)
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't work that out just now - try again.")
    } finally { setBusy('') }
  }

  const plan = async () => {
    setErr(''); setResult(null); setAsked('A week of meals for weight loss')
    setBusy('Planning the week - picking dishes and working out each day…')
    try {
      const { data } = await planRecipes(7, me?.profile?.diet || 'any')
      setResult(data)
      if (data.need_profile) setShowMe(true)
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't make the plan just now - try again.")
    } finally { setBusy('') }
  }

  const save = async (patch) => {
    const { data } = await saveRecipesMe(patch)
    setMe((m) => ({ ...m, ...data }))
    return data
  }

  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <h1 className="text-xl font-black tracking-tight">What to cook</h1>
        <p className="text-xs text-gray-400 mt-1">Indian recipes with nutrition and cost worked out - not guessed</p>
        <RecommendTabs tab={tab} setTab={setTab} />
      </div>

      <div className="px-5 mt-4 space-y-4 max-w-2xl">
        {/* Ask */}
        <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3">
          <p className="text-xs font-bold text-gray-700">Ask for a recipe <span className="font-normal text-gray-400">- type it or say it</span></p>
          <div className="relative mt-2">
            <textarea value={q} onChange={(e) => setQ(e.target.value)} rows={2}
              onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask() } }}
              placeholder={focused ? EXAMPLES[0] : ''} aria-label="Your question"
              className="input text-sm bg-white" />
            {!q && !focused && (
              <div className="absolute inset-0 px-4 py-3 pointer-events-none overflow-hidden">
                {voice.recording ? <p className="text-sm font-bold text-brand-600">● Listening… {voice.seconds}s - tap ■ when you're done</p>
                  : voice.hearing ? <p className="text-sm text-gray-400">Writing down what you said…</p>
                  : <Typewriter running ideas={IDEAS} className="text-sm leading-relaxed" />}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <button onClick={() => ask()} disabled={!!busy || q.trim().length < 3}
              className="btn-primary text-xs py-2 px-5 disabled:opacity-50">{busy ? 'Working…' : 'Ask'}</button>
            {micWorks() && (
              <button type="button" onClick={voice.recording ? voice.stop : voice.start} disabled={voice.hearing || !!busy}
                aria-label={voice.recording ? 'Stop' : 'Say it'}
                className={`w-9 h-9 rounded-md flex items-center justify-center active:scale-95 transition-all disabled:opacity-50 ${voice.recording ? 'bg-red-500' : 'bg-white border border-amber-300 hover:bg-amber-100'}`}>
                {voice.recording ? <span className="w-3 h-3 rounded-sm bg-white" /> : (
                  <svg className="w-4 h-4 text-gray-700" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" viewBox="0 0 24 24">
                    <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
                  </svg>
                )}
              </button>
            )}
            {q && !busy && <button onClick={() => setQ('')} className="text-[11px] font-bold text-gray-400">Clear</button>}
          </div>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {EXAMPLES.map((x) => (
              <button key={x} type="button" disabled={!!busy} onClick={() => ask(x)}
                className="text-[11px] text-gray-600 bg-white border border-amber-200 rounded-md px-2 py-1 text-left hover:bg-amber-100 disabled:opacity-50">
                {x}
              </button>
            ))}
          </div>
          {err && <p className="text-[11px] text-red-600 mt-2">{err}</p>}
        </div>

        {busy && (
          <div className="card text-center py-6">
            <div className="w-6 h-6 mx-auto border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
            <p className="text-xs text-gray-500 mt-2">{busy}</p>
          </div>
        )}

        {result && !busy && <Result r={result} asked={asked} onPlan={plan} onProfile={() => setShowMe(true)} onOpen={setOpened} />}
        {opened && <DishSheet open={opened} onClose={() => setOpened(null)} />}

        {/* You, and your kitchen */}
        {me && <Profile me={me} open={showMe} setOpen={setShowMe} save={save} onPlan={plan} busy={!!busy} />}
        {me && <Kitchen pantry={me.pantry || []} save={save} onUse={() => ask(EXAMPLES[4])} busy={!!busy} />}

        <Sources s={me?.sources} />
      </div>
    </div>
  )
}

// A dish's own page, over the list: photo, the full breakdown for a serving
// and for the portion eaten, effective cost, priced ingredients, method
function DishSheet({ open, onClose }) {
  const [servings, setServings] = useState(open.servings || 1)
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    setD(null); setErr('')
    recipeDish(open.name, 1, open.recipe || null).then((r) => setD(r.data))
      .catch((e) => setErr(e?.response?.data?.detail || "Couldn't open that dish - try again."))
  }, [open.name])
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  const n = d?.nutrition
  const s = servings
  const rows = [['Calories', 'kcal', ''], ['Protein', 'protein', 'g'], ['Carbs', 'carbs', 'g'], ['Fat', 'fat', 'g'],
                ['Fibre', 'fibre', 'g'], ['Sugar', 'sugar', 'g'], ['Sodium', 'sodium_mg', 'mg']]
  const fmt = (k, v) => (k === 'kcal' || k === 'sodium_mg' ? r0(v) : r1(v))
  const cost = d?.cost?.total
  const unitOf = d?.indb?.serving?.unit || open.unit || 'serving'
  return (
    <div className="fixed inset-0 z-[200] flex items-end md:items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-cream w-full md:max-w-lg max-h-[92svh] overflow-y-auto overscroll-contain border border-amber-100/60 shadow-2xl rounded-t-xl md:rounded-xl">
        {d?.photo && (
          <div className="relative">
            <img src={d.photo.url} alt={open.name} className="w-full h-52 object-cover rounded-t-xl" loading="lazy" />
            <a href={d.photo.page} target="_blank" rel="noreferrer"
              className="absolute bottom-1.5 right-2 text-[9px] text-white/90 bg-black/40 rounded px-1.5 py-0.5">Photo: {d.photo.title} · Wikipedia</a>
          </div>
        )}
        <div className="px-5 py-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-black text-gray-900 leading-tight">{open.name}</h2>
              {d?.indb && d.indb.name !== open.name && <p className="text-[11px] text-gray-400 mt-0.5">INDB: {d.indb.name}</p>}
              {d?.time_min && <p className="text-[11px] text-gray-500 mt-0.5">{d.time_min} min</p>}
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-700 p-1 -mr-1" aria-label="Close">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          {!d && !err && <div className="py-8 text-center"><div className="w-6 h-6 mx-auto border-2 border-brand-400 border-t-transparent rounded-full animate-spin" /><p className="text-xs text-gray-500 mt-2">Working out the numbers…</p></div>}
          {err && <p className="text-xs text-red-600">{err}</p>}

          {d && (
            <>
              {/* Portion */}
              <div className="flex items-center justify-between bg-white border border-amber-200 rounded-md px-3 py-2">
                <span className="text-xs font-bold text-gray-700">Your portion</span>
                <span className="flex items-center gap-2">
                  <button onClick={() => setServings((x) => Math.max(0.5, x - 0.5))} className="w-7 h-7 border border-amber-300 rounded-md font-bold text-gray-700">−</button>
                  <span className="text-sm font-black text-gray-900 tabular-nums w-24 text-center">{s} {unitOf}</span>
                  <button onClick={() => setServings((x) => Math.min(6, x + 0.5))} className="w-7 h-7 border border-amber-300 rounded-md font-bold text-gray-700">+</button>
                </span>
              </div>

              {/* Calories and where they come from */}
              <div>
                <p className="text-3xl font-black text-gray-900 leading-none">{r0(n.kcal * s)} <span className="text-sm font-bold text-gray-400">kcal</span></p>
                <div className="flex h-2.5 rounded-full overflow-hidden mt-2.5 bg-gray-100">
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
              </div>

              {/* The breakdown */}
              <table className="w-full text-xs">
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

              {/* Effective cost */}
              <div className="bg-white border border-amber-200 rounded-md px-3 py-2.5">
                <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Effective cost</p>
                {cost != null ? (
                  <>
                    <p className="text-lg font-black text-gray-900 mt-0.5">₹{r0(cost * s)} <span className="text-xs font-bold text-gray-500">for your {s} {unitOf} · ₹{r1(cost)} each</span></p>
                    <div className="grid grid-cols-2 gap-2 mt-1.5">
                      <div className="bg-amber-50 rounded-md px-2 py-1.5"><p className="text-sm font-black text-gray-900">{d.effective.per_100_kcal != null ? `₹${d.effective.per_100_kcal}` : '-'}</p><p className="text-[10px] text-gray-500">a 100 kcal</p></div>
                      <div className="bg-amber-50 rounded-md px-2 py-1.5"><p className="text-sm font-black text-gray-900">{d.effective.per_10g_protein != null ? `₹${d.effective.per_10g_protein}` : '-'}</p><p className="text-[10px] text-gray-500">a 10 g of protein</p></div>
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
                <div>
                  <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">Ingredients · for your {s} {unitOf}</p>
                  <table className="w-full text-[11px]">
                    <tbody>
                      {d.ingredients.map((l, i) => (
                        <tr key={i} className="border-t border-amber-100">
                          <td className="py-1 pr-2 text-gray-800">{l.item}</td>
                          <td className="text-right tabular-nums text-gray-500">{r0(l.grams * s)} g</td>
                          <td className="text-right tabular-nums font-bold text-gray-800 w-14">{l.cost != null ? `₹${r1(l.cost * s)}` : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {d.steps?.length > 0 && (
                <div>
                  <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">Method</p>
                  <ol className="list-decimal list-inside space-y-1 text-xs text-gray-700">{d.steps.map((x, i) => <li key={i}>{x}</li>)}</ol>
                </div>
              )}

              <div className="text-[10px] text-gray-400">
                <SourceLine s={d.nutrition_source} />
                <p className="mt-0.5">Ingredients and method: suggested by AI. Every number above: worked out from the data, not by the AI.</p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Result({ r, asked, onPlan, onProfile, onOpen }) {
  if (r.mode === 'plan') return <Plan r={r} onProfile={onProfile} onOpen={onOpen} />
  const recs = r.recipes || []
  if (!recs.length) return <div className="card text-xs text-gray-500">Nothing came back for “{asked}” - try asking another way.</div>
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-gray-500">For “{asked}”{r.want?.max_kcal ? ` · up to ${r.want.max_kcal} kcal` : ''}{r.want?.min_protein_g ? ` · at least ${r.want.min_protein_g} g protein` : ''}{r.want?.max_cost_inr ? ` · up to ₹${r.want.max_cost_inr}` : ''}</p>
      {r.mode === 'compare' && recs.length >= 2 && <Compare a={recs[0]} b={recs[1]} />}
      {recs.map((x, i) => <RecipeCard key={i} x={x} onOpen={onOpen} />)}
      {/plan|week|weight/i.test(asked) && (
        <button onClick={onPlan} className="text-xs font-bold text-brand-600">Make a 7-day weight-loss plan instead →</button>
      )}
    </div>
  )
}

function Numbers({ n }) {
  const cells = [['kcal', r0(n.kcal), ''], ['protein', r1(n.protein), 'g'], ['carbs', r1(n.carbs), 'g'], ['fat', r1(n.fat), 'g'], ['fibre', r1(n.fibre), 'g']]
  return (
    <div className="grid grid-cols-5 gap-1 mt-2">
      {cells.map(([k, v, u]) => (
        <div key={k} className="bg-amber-50 border border-amber-100 rounded-md py-1.5 text-center">
          <p className="text-sm font-black text-gray-900 leading-none">{v}<span className="text-[10px] font-bold text-gray-400">{u}</span></p>
          <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wide mt-0.5">{k}</p>
        </div>
      ))}
    </div>
  )
}

function SourceLine({ s }) {
  if (s.kind === 'indb') {
    return <p className="text-[10px] text-gray-400 mt-1.5">Nutrition: INDB - {s.dishes.map((d) => `${d.name} × ${d.servings} ${d.unit} (~${d.grams} g)`).join(' + ')}</p>
  }
  return (
    <p className="text-[10px] text-gray-400 mt-1.5">
      Nutrition: added up from its ingredients (USDA)
      {s.missing?.length > 0 && <span className="text-amber-700 font-bold"> · no figures yet for {s.missing.join(', ')} - the total is short, limits not checked</span>}
    </p>
  )
}

function RecipeCard({ x, onOpen }) {
  const [open, setOpen] = useState(false)
  const c = x.cost || {}
  // The page opens with this recipe as written - its own ingredients and steps
  const openIt = () => onOpen({
    name: x.name, servings: 1,
    recipe: { name: x.name, ingredients: x.ingredients.map((l) => ({ item: l.item, grams: l.grams })), steps: x.steps,
              time_min: x.time_min, indb: (x.nutrition_source.dishes || []).map((d) => ({ name: d.name, servings: d.servings })) },
  })
  return (
    <div className={`card ${x.fits ? '' : 'opacity-90'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <button onClick={openIt} className="text-sm font-black text-gray-900 text-left underline decoration-amber-300 underline-offset-2">{x.name} ›</button>
          <p className="text-[11px] text-gray-500 mt-0.5">{[x.meal, x.time_min ? `${x.time_min} min` : null].filter(Boolean).join(' · ')}{x.why ? ` · ${x.why}` : ''}</p>
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-sm font-black text-gray-900">{c.total != null ? `₹${c.total}` : '-'}</p>
          <p className="text-[9px] text-gray-400">a serving{c.basis === 'estimate' ? ' · est.' : ' · mandi'}</p>
        </div>
      </div>
      <Numbers n={x.nutrition} />
      {x.misses?.length > 0
        ? <p className="text-[11px] font-bold text-red-600 mt-1.5">✗ {x.misses.join(' · ')}</p>
        : <p className="text-[11px] font-bold text-green-700 mt-1.5">✓ Fits what you asked</p>}
      {x.you_need?.length > 0 && <p className="text-[11px] text-gray-600 mt-0.5">You'd need: {x.you_need.join(', ')}</p>}
      <SourceLine s={x.nutrition_source} />
      <div className="flex gap-4 mt-2">
        <button onClick={openIt} className="text-[11px] font-bold text-brand-600">Photo and full breakdown →</button>
        <button onClick={() => setOpen((o) => !o)} className="text-[11px] font-bold text-gray-500">
          {open ? '▾ Hide' : '▸ Ingredients and method'}
        </button>
      </div>
      {open && (
        <div className="mt-2 space-y-3">
          <table className="w-full text-[11px]">
            <thead><tr className="text-gray-400 text-left"><th className="font-bold py-0.5">Ingredient</th><th className="font-bold text-right">g</th><th className="font-bold text-right">₹/kg</th><th className="font-bold text-right">₹</th></tr></thead>
            <tbody>
              {x.ingredients.map((l, i) => (
                <tr key={i} className="border-t border-amber-100">
                  <td className="py-1 pr-2">{l.item}{l.as && l.as !== l.item.toLowerCase() ? <span className="text-gray-400"> ({l.as})</span> : ''}</td>
                  <td className="text-right tabular-nums">{l.grams}</td>
                  <td className="text-right tabular-nums text-gray-500">{l.per_kg != null ? `${l.per_kg}${l.price_source === 'estimate' ? '*' : ''}` : '-'}</td>
                  <td className="text-right tabular-nums font-bold">{l.cost != null ? l.cost : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {c.basis === 'estimate' && <p className="text-[10px] text-gray-400">* Typical Delhi shop prices, hand-entered - an estimate, not today's price.</p>}
          {c.unpriced?.length > 0 && <p className="text-[10px] text-amber-700">No price for {c.unpriced.join(', ')} - not in the cost.</p>}
          {x.steps?.length > 0 && (
            <ol className="list-decimal list-inside space-y-1 text-xs text-gray-700">
              {x.steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}

function Compare({ a, b }) {
  const rows = [
    ['Calories', 'kcal', (x) => x.nutrition.kcal, 'low', ''],
    ['Protein', 'protein', (x) => x.nutrition.protein, 'high', 'g'],
    ['Carbs', 'carbs', (x) => x.nutrition.carbs, 'low', 'g'],
    ['Fat', 'fat', (x) => x.nutrition.fat, 'low', 'g'],
    ['Fibre', 'fibre', (x) => x.nutrition.fibre, 'high', 'g'],
    ['Cost', 'cost', (x) => x.cost?.total, 'low', '₹'],
  ]
  return (
    <div className="card">
      <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2">Side by side · a serving each</p>
      <table className="w-full text-xs">
        <thead><tr><th /><th className="text-right font-black text-gray-900 pb-1 w-1/3">{a.name}</th><th className="text-right font-black text-gray-900 pb-1 w-1/3">{b.name}</th></tr></thead>
        <tbody>
          {rows.map(([label, k, get, better, unit]) => {
            const va = get(a), vb = get(b)
            const win = va == null || vb == null || va === vb ? null : (better === 'low' ? (va < vb ? 'a' : 'b') : (va > vb ? 'a' : 'b'))
            const fmt = (v) => (v == null ? '-' : unit === '₹' ? `₹${r0(v)}` : `${k === 'kcal' ? r0(v) : r1(v)}${unit}`)
            return (
              <tr key={k} className="border-t border-amber-100">
                <td className="py-1.5 text-gray-500">{label}</td>
                <td className={`text-right tabular-nums ${win === 'a' ? 'font-black text-green-700' : 'text-gray-800'}`}>{fmt(va)}</td>
                <td className={`text-right tabular-nums ${win === 'b' ? 'font-black text-green-700' : 'text-gray-800'}`}>{fmt(vb)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="text-[10px] text-gray-400 mt-1.5">Green: the better of the two (fewer calories, carbs, fat and rupees; more protein and fibre).</p>
    </div>
  )
}

function Plan({ r, onProfile, onOpen }) {
  const [open, setOpen] = useState(0)
  if (r.need_profile) {
    return (
      <div className="card">
        <p className="text-sm font-bold text-gray-900">First, a few numbers about you</p>
        <p className="text-xs text-gray-500 mt-1">{r.message}</p>
        <button onClick={onProfile} className="btn-primary text-xs py-2 px-4 mt-3">Fill them in</button>
      </div>
    )
  }
  const t = r.targets
  return (
    <div className="space-y-2">
      <div className="card">
        <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Your daily target</p>
        <p className="text-lg font-black text-gray-900 mt-0.5">{t.kcal} kcal · {t.protein_g} g protein</p>
        <p className="text-[11px] text-gray-500 mt-0.5">
          You burn about {t.tdee} kcal a day ({t.bmr} at rest); {t.pace_kg_week ? `eating ${t.tdee - t.kcal} less loses about ${t.pace_kg_week} kg a week` : 'eating that keeps your weight'}. BMI {t.bmi}.
          {t.floored && ' Kept at the safe minimum - a slower pace would be gentler.'}
        </p>
        <p className="text-[10px] text-gray-400 mt-1">A guide worked out from your numbers (Mifflin-St Jeor), not medical advice. Portions are scaled to land near the target.</p>
      </div>
      {r.days.map((d, i) => {
        const off = d.totals.kcal - t.kcal
        return (
          <div key={d.day} className="card">
            <button onClick={() => setOpen(open === i ? -1 : i)} className="w-full flex items-center justify-between gap-2 text-left">
              <span className="text-sm font-black text-gray-900">Day {d.day}</span>
              <span className="text-[11px] text-gray-600">
                <b className={Math.abs(off) <= t.kcal * 0.1 ? 'text-green-700' : 'text-amber-700'}>{r0(d.totals.kcal)} kcal</b>
                {' · '}{r0(d.totals.protein)} g protein{d.cost != null ? ` · ₹${d.cost}${d.cost_partial ? '+' : ''}` : ''} {open === i ? '▾' : '▸'}
              </span>
            </button>
            {open === i && (
              <div className="mt-2 space-y-2">
                {Object.entries(d.meals).filter(([, xs]) => xs.length).map(([meal, xs]) => (
                  <div key={meal}>
                    <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{meal}</p>
                    {xs.map((x, j) => (
                      <button key={j} onClick={() => onOpen({ name: x.name, servings: x.servings, unit: x.unit })}
                        className="w-full flex items-baseline justify-between gap-2 text-xs py-1 text-left active:bg-amber-50 rounded">
                        <span className="text-gray-800 min-w-0 underline decoration-amber-300 underline-offset-2">{x.name} <span className="text-gray-400 no-underline">× {x.servings} {x.unit}</span></span>
                        <span className="text-gray-500 tabular-nums flex-shrink-0">{r0(x.kcal)} kcal · {r0(x.protein)} g P{x.cost != null ? ` · ₹${x.cost}` : ''} ›</span>
                      </button>
                    ))}
                  </div>
                ))}
                {d.cost_partial && <p className="text-[10px] text-amber-700">Some dishes couldn't be priced yet - the day's cost is a minimum (+).</p>}
              </div>
            )}
          </div>
        )
      })}
      <p className="text-[10px] text-gray-400">Dishes and their nutrition: INDB. Cost: their ingredients at {r.price_basis === 'mandi' ? 'mandi prices' : 'typical shop prices (estimates)'}.</p>
    </div>
  )
}

function Profile({ me, open, setOpen, save, onPlan, busy }) {
  const [p, setP] = useState(me.profile || {})
  const [saved, setSaved] = useState('')
  useEffect(() => { setP(me.profile || {}) }, [me.profile])
  const t = me.targets
  const set = (k, v) => { setP((x) => ({ ...x, [k]: v })); setSaved('') }
  const num = (k, label, ph) => (
    <label className="block">
      <span className="text-[10px] font-bold text-gray-500">{label}</span>
      <input type="number" inputMode="decimal" className="input text-sm py-2" placeholder={ph} value={p[k] ?? ''} onChange={(e) => set(k, e.target.value)} />
    </label>
  )
  return (
    <div className="card">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between text-left">
        <span>
          <span className="text-sm font-bold text-gray-800">You, for weight-loss plans</span>
          <span className="block text-[11px] text-gray-500">{t ? `Target ${t.kcal} kcal and ${t.protein_g} g protein a day` : 'Age, height, weight - to work out your daily target'}</span>
        </span>
        <span className="text-gray-400 text-xs">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {num('age', 'Age', '30')}
            {num('height_cm', 'Height (cm)', '170')}
            {num('weight_kg', 'Weight (kg)', '75')}
          </div>
          <div>
            <p className="text-[10px] font-bold text-gray-500 mb-1">Sex</p>
            <div className="flex gap-1.5">{[['male', 'Male'], ['female', 'Female']].map(([v, l]) => <button key={v} type="button" onClick={() => set('sex', v)} className={chip(p.sex === v)}>{l}</button>)}</div>
          </div>
          <div>
            <p className="text-[10px] font-bold text-gray-500 mb-1">How active</p>
            <div className="flex flex-wrap gap-1.5">{ACTIVITY.map(([v, l]) => <button key={v} type="button" onClick={() => set('activity', v)} className={chip(p.activity === v)}>{l}</button>)}</div>
          </div>
          <div>
            <p className="text-[10px] font-bold text-gray-500 mb-1">Pace</p>
            <div className="flex flex-wrap gap-1.5">{PACE.map(([v, l]) => <button key={v} type="button" onClick={() => set('pace', v)} className={chip((p.pace || 'steady') === v)}>{l}</button>)}</div>
          </div>
          <div>
            <p className="text-[10px] font-bold text-gray-500 mb-1">Diet</p>
            <div className="flex flex-wrap gap-1.5">{DIETS.map(([v, l]) => <button key={v} type="button" onClick={() => set('diet', v)} className={chip((p.diet || 'any') === v)}>{l}</button>)}</div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" disabled={busy} className="btn-primary text-xs py-2 px-4 disabled:opacity-50"
              onClick={async () => { const d = await save({ profile: p }); setSaved(d.targets ? 'Saved' : 'Saved - add age, height, weight and sex for a target') }}>
              Save
            </button>
            {t && <button type="button" disabled={busy} onClick={onPlan} className="text-xs font-bold text-brand-600 disabled:opacity-50">Plan 7 days →</button>}
            {saved && <span className="text-[11px] text-green-700">{saved}</span>}
          </div>
        </div>
      )}
    </div>
  )
}

function Kitchen({ pantry, save, onUse, busy }) {
  const [add, setAdd] = useState('')
  const put = (list) => save({ pantry: list }).catch(() => {})
  const addIt = () => {
    const items = add.split(',').map((s) => s.trim()).filter(Boolean)
    if (!items.length) return
    put([...pantry, ...items.filter((i) => !pantry.some((p) => p.toLowerCase() === i.toLowerCase()))])
    setAdd('')
  }
  return (
    <div className="card">
      <p className="text-sm font-bold text-gray-800">My kitchen</p>
      <p className="text-[11px] text-gray-500 mt-0.5">What you have in - recipes then say what else you'd need. Salt, oil and spices are taken as there.</p>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {pantry.map((p) => (
          <span key={p} className="flex items-center gap-1 bg-amber-50 border border-amber-200 rounded-md pl-2 pr-1 py-0.5 text-xs font-bold text-gray-700">
            {p}<button onClick={() => put(pantry.filter((x) => x !== p))} className="text-gray-400 hover:text-red-500 px-1" aria-label={`Remove ${p}`}>×</button>
          </span>
        ))}
        {!pantry.length && <span className="text-[11px] text-gray-400">Nothing yet</span>}
      </div>
      <div className="flex gap-2 mt-2">
        <input className="input text-sm py-2 flex-1" placeholder="paneer, curd, onion…" value={add}
          onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addIt())} />
        <button onClick={addIt} disabled={!add.trim()} className="bg-brand-400 text-white px-4 font-bold text-xs rounded-md disabled:opacity-50">Add</button>
      </div>
      {pantry.length > 0 && (
        <button onClick={onUse} disabled={busy} className="text-xs font-bold text-brand-600 mt-2 disabled:opacity-50">Suggest recipes from my kitchen →</button>
      )}
    </div>
  )
}

function Sources({ s }) {
  return (
    <div className="text-[10px] text-gray-400 leading-relaxed">
      <p className="font-bold text-gray-500">Where the numbers come from</p>
      <p>Dishes: <a className="underline" href={s?.indb?.url || 'https://www.anuvaad.org.in/indian-nutrient-databank/'} target="_blank" rel="noreferrer">Indian Nutrient Databank (INDB)</a>, Anuvaad Solutions - {s?.indb?.dishes || '1,014'} Indian recipes, per serving; servings whose figures don't add up are left out.</p>
      <p>Ingredients: <a className="underline" href={s?.usda?.url || 'https://fdc.nal.usda.gov/'} target="_blank" rel="noreferrer">USDA FoodData Central</a>{s?.usda && !s.usda.own_key ? ' (shared demo key - lookups are limited until a key is set)' : ''}.</p>
      <p>Prices: {s?.prices?.mandi ? 'today’s mandi prices from data.gov.in (wholesale - shops charge more), else' : ''} typical Delhi shop prices, hand-entered - estimates.</p>
      <p>The AI suggests dishes and writes the method; it never gives the numbers.</p>
    </div>
  )
}
