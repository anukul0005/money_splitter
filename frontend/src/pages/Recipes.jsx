import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { askRecipes, fixMealItem, logMeal, planRecipes, recipeDish, recipesMe, reworkMeal, saveRecipesMe, unlogMeal } from '../api'
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

// Kept on this device: the last answer (plan or recipes) and your details,
// so Recipes opens straight onto them - the server keeps both too
const LAST_KEY = 'recipes_last'
const PLAN_KEY = 'recipes_week_plan'
const ME_KEY = 'recipes_me'
const load = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null') } catch { return null } }
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* storage full or blocked */ } }

// The plan's week runs Friday to Thursday - day 1 is the Friday it starts on
// (older plans: the Friday on or before the day they were made)
export const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export function planDate(plan, day) {
  let start
  if (plan?.starts) start = new Date(`${plan.starts}T00:00:00`)
  else {
    const made = plan?.made_at ? new Date(plan.made_at) : new Date()
    start = new Date(made.getFullYear(), made.getMonth(), made.getDate())
    start.setDate(start.getDate() - ((start.getDay() - 5 + 7) % 7))
  }
  const d = new Date(start)
  d.setDate(d.getDate() + (day - 1))
  return d
}
export const dayLabel = (d) => d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
export const isToday = (d) => isoDay(d) === isoDay(new Date())

// Dish pages kept on this device: opened instantly (and offline), refreshed when online
const DISH_KEY = (name, r) => `recipe_dish_${name}|${r || ''}`
export const cachedDish = (name, r) => load(DISH_KEY(name, r))
export const keepDish = (name, r, data) => keep(DISH_KEY(name, r), data)

// A recipe the AI wrote travels to its own page by a key, kept on this device
export function readRecipe(key) { return key ? load(`recipe_r_${key}`) : null }
function dishHref({ name, servings = 1, unit, recipe, day, meal }) {
  const p = new URLSearchParams({ name, s: String(servings) })
  if (unit) p.set('u', unit)
  if (day && meal) { p.set('day', String(day)); p.set('meal', meal) }
  if (recipe) {
    const key = [...JSON.stringify(recipe)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)
    keep(`recipe_r_${key}`, recipe)
    p.set('r', key)
  }
  return `/recipes/dish?${p}`
}

export default function Recipes({ tab, setTab }) {
  const nav = useNavigate()
  const last = load(LAST_KEY)
  const [me, setMe]         = useState(() => load(ME_KEY))     // { profile, pantry, targets, sources, plan }
  const [q, setQ]           = useState('')
  const [focused, setFocused] = useState(false)
  const [busy, setBusy]     = useState('')        // what's being worked out
  const [err, setErr]       = useState('')
  // The latest answer to a question (recipes, a comparison) - the week's plan
  // has its own place below it, so asking something never hides the plan
  const [result, setResult] = useState(last?.result?.mode === 'plan' ? null : last?.result || null)
  const [asked, setAsked]   = useState(last?.asked || '')
  const [weekPlan, setWeekPlanRaw] = useState(() => load(PLAN_KEY) || (last?.result?.mode === 'plan' ? last.result : null))
  const setWeekPlan = (p) => { setWeekPlanRaw(p); keep(PLAN_KEY, p) }
  const [showMe, setShowMe] = useState(false)

  useEffect(() => {
    recipesMe().then((r) => {
      const data = { ...r.data, plan_made_at: r.data.plan?.made_at || null }
      setMe(data); keep(ME_KEY, { ...data, plan: undefined })
      // The plan saved on your account, unless this device has a newer one
      const saved = r.data.plan
      setWeekPlanRaw((cur) => {
        const next = saved && (!cur || (cur.made_at || '') <= saved.made_at) ? saved : cur
        keep(PLAN_KEY, next)
        return next
      })
    }).catch(() => setMe((m) => m || { profile: {}, pantry: [] }))
  }, [])

  // The latest answer kept, so coming back shows it again
  useEffect(() => { if (result && !result.need_profile) keep(LAST_KEY, { result, asked }) }, [result])

  // An answer that's a plan becomes the week's plan
  const took = (data) => {
    if (data.mode === 'plan' && !data.need_profile) {
      setWeekPlan(data); setResult(null)
      if (data.made_at) fresh(data.made_at)
      if (data.starts) nav(`/recipes/week?w=${data.starts}`)
      // The same week planned again keeps what's logged - and the weeks change
      recipesMe().then((r) => setMe((m) => {
        const next = { ...m, log: r.data.log || {}, weeks: r.data.weeks, plan_made_at: r.data.plan?.made_at || m.plan_made_at }
        keep(ME_KEY, { ...next, plan: undefined })
        return next
      })).catch(() => {})
    } else setResult(data)
    if (data.need_profile) setShowMe(true)
  }

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
      took(data)
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't work that out just now - try again.")
    } finally { setBusy('') }
  }

  const plan = async () => {
    setErr('')
    setBusy('Planning the week - picking dishes and working out each day…')
    try {
      const { data } = await planRecipes(7, me?.profile?.diet || 'any')
      took(data)
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't make the plan just now - try again.")
    } finally { setBusy('') }
  }

  // What's been eaten against the plan - kept with your details on this device too
  const setLog = (log, weeks) => setMe((m) => { const next = { ...m, log, weeks: weeks || m.weeks }; keep(ME_KEY, { ...next, plan: undefined }); return next })
  // A new plan: its log starts empty
  const fresh = (madeAt) => setMe((m) => { const next = { ...m, plan_made_at: madeAt, log: {} }; keep(ME_KEY, { ...next, plan: undefined }); return next })

  const save = async (patch) => {
    const { data } = await saveRecipesMe(patch)
    setMe((m) => { const next = { ...m, ...data }; keep(ME_KEY, { ...next, plan: undefined }); return next })
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
        {/* Every week so far against its target - each opens its own page of 7 day cards */}
        {(weekPlan?.days?.length > 0 || me?.weeks?.length > 0) && (
          <div className="space-y-2">
            <Weeks weeks={me?.weeks || []} />
            <button onClick={plan} disabled={!!busy} className="text-[11px] font-bold text-brand-600 disabled:opacity-50">＋ Make a new plan</button>
          </div>
        )}

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

        {result && !busy && (
          <div className="relative">
            <button onClick={() => { setResult(null); keep(LAST_KEY, null) }} className="absolute -top-1 right-0 text-[11px] font-bold text-gray-400">Clear ×</button>
            <Result r={result} asked={asked} onPlan={plan} onProfile={() => setShowMe(true)} />
          </div>
        )}

        {/* You, and your kitchen */}
        {me && <Profile me={me} open={showMe} setOpen={setShowMe} save={save} onPlan={plan} busy={!!busy} />}
        {me && <Kitchen pantry={me.pantry || []} save={save} onUse={() => ask(EXAMPLES[4])} busy={!!busy} />}

        <Sources s={me?.sources} />
      </div>
    </div>
  )
}

/**
 * Every week so far, one row each (6 – 12 Nov, 13 – 19 Nov…): the week's
 * calorie target, what was eaten (logged meals only - nothing assumed), and
 * how far off the target it came out on the days fully logged.
 */
function Weeks({ weeks }) {
  if (!weeks.length) return null
  const range = (w) => {
    const a = new Date(`${w.starts}T00:00:00`), b = new Date(`${w.ends}T00:00:00`)
    const m = (d) => d.toLocaleDateString('en-IN', { month: 'short' })
    return a.getMonth() === b.getMonth() ? `${a.getDate()} – ${b.getDate()} ${m(b)}` : `${a.getDate()} ${m(a)} – ${b.getDate()} ${m(b)}`
  }
  const today = isoDay(new Date())
  return (
    <div className="card">
      <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">Week by week</p>
      {weeks.map((w) => {
        const now = w.starts <= today && today <= w.ends
        const fullTarget = w.target_day * w.off_days
        return (
          <Link key={w.starts} to={`/recipes/week?w=${w.starts}`} className={`block border-t border-amber-100 first:border-0 py-2 active:bg-amber-50 ${now ? '' : 'opacity-80'}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-black text-gray-900">{range(w)}{now && <span className="ml-1.5 text-[9px] font-black text-white bg-brand-400 rounded px-1.5 py-0.5 align-middle">THIS WEEK</span>}</span>
              <span className="text-[11px] text-gray-500">{w.meals_logged} of {w.meals_planned} meals logged</span>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-1.5">
              <div className="bg-amber-50 rounded-md px-2 py-1.5">
                <p className="text-sm font-black text-gray-900 tabular-nums">{w.target_week.toLocaleString('en-IN')}</p>
                <p className="text-[9px] text-gray-500">kcal target ({w.target_day.toLocaleString('en-IN')} a day)</p>
              </div>
              <div className="bg-amber-50 rounded-md px-2 py-1.5">
                <p className="text-sm font-black text-gray-900 tabular-nums">{w.eaten.toLocaleString('en-IN')}</p>
                <p className="text-[9px] text-gray-500">kcal you had (logged)</p>
              </div>
              <div className={`rounded-md px-2 py-1.5 ${!w.off_days ? 'bg-gray-50' : Math.abs(w.off) <= fullTarget * 0.05 ? 'bg-green-50' : w.off > 0 ? 'bg-red-50' : 'bg-amber-50'}`}>
                {w.off_days ? (
                  <>
                    <p className={`text-sm font-black tabular-nums ${Math.abs(w.off) <= fullTarget * 0.05 ? 'text-green-700' : w.off > 0 ? 'text-red-600' : 'text-amber-700'}`}>
                      {w.off === 0 ? 'On target' : `${Math.abs(w.off).toLocaleString('en-IN')} ${w.off > 0 ? 'over' : 'under'}`}
                    </p>
                    <p className="text-[9px] text-gray-500">on {w.off_days} fully logged day{w.off_days === 1 ? '' : 's'}</p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-black text-gray-400">-</p>
                    <p className="text-[9px] text-gray-500">log every meal of a day to see</p>
                  </>
                )}
              </div>
            </div>
            <p className="text-[10px] font-bold text-brand-600 mt-1.5">Day by day, and how each went →</p>
          </Link>
        )
      })}
    </div>
  )
}

/**
 * Something you had that couldn't be worked out: have another go (from its
 * ingredients, or the closest dish INDB has - learnt for next time), or put
 * in your own figure, which is remembered for that food too.
 */
function UnknownItem({ day, meal, index, item, onLog }) {
  const [busy, setBusy] = useState(false)
  const [own, setOwn] = useState(false)
  const [kcal, setKcal] = useState('')
  const [protein, setProtein] = useState('')
  const [err, setErr] = useState('')
  const run = async (f) => {
    setBusy(true); setErr('')
    try { const { data } = await f(); onLog(data.log, data.weeks); if (!data.entry?.items?.[index]?.nutrition) setErr("Still couldn't - put in your own figure") }
    catch (e) { setErr(e?.response?.data?.detail || "Couldn't - try again") }
    finally { setBusy(false) }
  }
  return (
    <div className="bg-white border border-amber-200 rounded-md px-2.5 py-1.5 mt-0.5 mb-1">
      <p className="text-[10px] text-amber-800 font-bold">Couldn't work out {item.said || item.name} - not in the totals yet</p>
      {!own ? (
        <div className="flex gap-3 mt-1">
          <button disabled={busy} onClick={() => run(() => reworkMeal(day, meal))} className="text-[11px] font-bold text-brand-600 disabled:opacity-50">
            {busy ? 'Working it out…' : 'Work it out'}
          </button>
          <button disabled={busy} onClick={() => setOwn(true)} className="text-[11px] font-bold text-gray-600">Enter calories myself</button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <input type="number" inputMode="decimal" placeholder="kcal" value={kcal} onChange={(e) => setKcal(e.target.value)}
            className="w-20 border border-amber-200 rounded-md px-2 py-1 text-xs" />
          <input type="number" inputMode="decimal" placeholder="protein g" value={protein} onChange={(e) => setProtein(e.target.value)}
            className="w-24 border border-amber-200 rounded-md px-2 py-1 text-xs" />
          <button disabled={busy || !(parseFloat(kcal) > 0)} className="btn-primary text-[11px] py-1 px-2.5 disabled:opacity-50"
            onClick={() => run(() => fixMealItem(day, meal, index, parseFloat(kcal), protein === '' ? null : parseFloat(protein)))}>Save</button>
          <button onClick={() => setOwn(false)} className="text-[11px] font-bold text-gray-400">Cancel</button>
        </div>
      )}
      {err && <p className="text-[10px] text-red-600 mt-0.5">{err}</p>}
    </div>
  )
}

/**
 * One meal of the plan as actually eaten: "had it as planned" in a tap, or
 * typed / said in any words - English, Hindi, Hinglish ("2 besan chilla
 * aur chai", "दो रोटी और दाल"). The server reads which foods and how much;
 * the numbers are worked out there like everything else. `add`: the quick
 * button adds to the meal (a dish's own page) rather than replacing it.
 */
export function MealLog({ day, meal, planned, entry, onLog, add = false, quickLabel, links = false }) {
  const [text, setText] = useState('')
  const [editing, setEditing] = useState(!entry)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const voice = useVoice({
    onText: (said) => { setErr(''); setText((p) => (p.trim() ? `${p.trim()} ${said}` : said)) },
    onError: setErr,
  })
  useEffect(() => { if (!entry) setEditing(true) }, [entry])

  const send = async (payload) => {
    setBusy(true); setErr('')
    try {
      const { data } = await logMeal({ day, meal, ...payload })
      onLog(data.log, data.weeks); setText(''); setEditing(false)
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't log that - try again.")
    } finally { setBusy(false) }
  }
  const remove = async () => {
    setBusy(true)
    try { const { data } = await unlogMeal(day, meal); onLog(data.log, data.weeks) } catch { setErr("Couldn't remove it.") } finally { setBusy(false) }
  }
  const plannedKcal = (planned || []).reduce((t, x) => t + (x.kcal || 0), 0)

  return (
    <div className="mt-1.5 bg-amber-50/70 border border-amber-200 rounded-md px-3 py-2">
      {entry && !editing && (
        <>
          <p className="text-[10px] font-black text-green-700 uppercase tracking-widest">✓ What you had</p>
          {entry.items.map((i, k) => {
            const label = <span className="text-gray-800 min-w-0">{i.name}{i.servings ? <span className="text-gray-400"> × {i.servings} {i.unit}</span> : i.grams ? <span className="text-gray-400"> · {i.grams} g</span> : ''}</span>
            const nums = <span className="text-gray-500 tabular-nums flex-shrink-0">{i.nutrition ? `${r0(i.nutrition.kcal)} kcal · ${r0(i.nutrition.protein)} g P` : '-'}{links ? ' ›' : ''}</span>
            // How a food not known by name was worked out - an estimate, said so
            const how = { ingredients: `≈ added up from ${i.basis || 'its ingredients'}`, similar: `≈ estimated from ${(i.basis || '').replace('the closest dish INDB has: ', 'a similar dish, ')}`, you: 'your own figure' }[i.source]
            return (
              <div key={k}>
                {links && i.nutrition ? (
                  <Link to={dishHref({ name: i.name, servings: i.servings || 1, unit: i.unit, day, meal })}
                    className="flex items-baseline justify-between gap-2 text-xs py-1 active:bg-amber-100 rounded [&>span:first-child]:underline [&>span:first-child]:decoration-amber-300 [&>span:first-child]:underline-offset-2">
                    {label}{nums}
                  </Link>
                ) : <div className="flex items-baseline justify-between gap-2 text-xs py-0.5">{label}{nums}</div>}
                {how && <p className="text-[10px] text-gray-400 -mt-0.5 mb-0.5">{how}</p>}
                {!i.nutrition && <UnknownItem day={day} meal={meal} index={k} item={i} onLog={onLog} />}
              </div>
            )
          })}
          <p className="text-[11px] font-bold text-gray-800 mt-1">
            {r0(entry.totals.kcal)} kcal · {r0(entry.totals.protein)} g protein{entry.cost != null ? ` · ₹${entry.cost}` : ''}
            {plannedKcal > 0 && (() => {
              const diff = r0(entry.totals.kcal - plannedKcal)
              return <span className={`font-normal ${Math.abs(diff) <= plannedKcal * 0.1 ? 'text-green-700' : diff > 0 ? 'text-red-600' : 'text-amber-700'}`}> · {diff === 0 ? 'as planned' : `${diff > 0 ? '+' : ''}${diff} vs plan`}</span>
            })()}
          </p>
          {entry.text && <p className="text-[10px] text-gray-400 mt-0.5">“{entry.text}”</p>}
          <div className="flex gap-3 mt-1">
            {/* What you wrote last time, ready to correct - not typed again from scratch */}
            <button onClick={() => {
              setText(entry.text || entry.items.map((i) => (i.servings ? `${i.servings} ${i.unit} ${i.name}` : i.said || i.name)).join(', '))
              setEditing(true)
            }} disabled={busy} className="text-[11px] font-bold text-brand-600">Change</button>
            <button onClick={remove} disabled={busy} className="text-[11px] font-bold text-gray-400">Remove</button>
          </div>
        </>
      )}
      {editing && (
        <>
          {planned?.length > 0 && (
            <button onClick={() => send({ planned: planned.map((x) => ({ name: x.name, servings: x.servings })), add })} disabled={busy}
              className="w-full text-left text-[11px] font-bold text-green-800 bg-white border border-green-200 rounded-md px-2.5 py-1.5 mb-1.5 disabled:opacity-50">
              ✓ {quickLabel || 'Had it as planned'}
            </button>
          )}
          <div className="relative">
            <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} disabled={busy}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (text.trim()) send({ text }) } }}
              placeholder={voice.recording ? `Listening… ${voice.seconds}s` : 'Or what you actually had - “2 besan chilla aur chai”, “दो रोटी और दाल”'}
              className="w-full bg-white border border-amber-200 rounded-md px-2.5 py-1.5 text-xs outline-none focus:border-brand-400 resize-none" />
          </div>
          <div className="flex items-center gap-2 mt-1">
            <button onClick={() => send({ text })} disabled={busy || !text.trim()} className="btn-primary text-[11px] py-1.5 px-3 disabled:opacity-50">
              {busy ? 'Working it out…' : entry ? 'Save changes' : 'Log it'}
            </button>
            {micWorks() && (
              <button type="button" onClick={voice.recording ? voice.stop : voice.start} disabled={voice.hearing || busy}
                aria-label={voice.recording ? 'Stop' : 'Say it'}
                className={`w-8 h-8 rounded-md flex items-center justify-center disabled:opacity-50 ${voice.recording ? 'bg-red-500' : 'bg-white border border-amber-300'}`}>
                {voice.recording ? <span className="w-2.5 h-2.5 rounded-sm bg-white" /> : (
                  <svg className="w-4 h-4 text-gray-700" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" viewBox="0 0 24 24"><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" /></svg>
                )}
              </button>
            )}
            {voice.hearing && <span className="text-[10px] text-gray-400">Writing it down…</span>}
            {entry && <button onClick={() => { setEditing(false); setText('') }} className="text-[11px] font-bold text-gray-400 ml-auto">Cancel</button>}
          </div>
        </>
      )}
      {err && <p className="text-[10px] text-red-600 mt-1">{err}</p>}
    </div>
  )
}

function Result({ r, asked, onPlan, onProfile, log, setLog }) {
  if (r.mode === 'plan') return <Plan r={r} asked={asked} onProfile={onProfile} log={log} setLog={setLog} />
  const recs = r.recipes || []
  if (!recs.length) return <div className="card text-xs text-gray-500">Nothing came back for “{asked}” - try asking another way.</div>
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-gray-500">For “{asked}”{r.want?.max_kcal ? ` · up to ${r.want.max_kcal} kcal` : ''}{r.want?.min_protein_g ? ` · at least ${r.want.min_protein_g} g protein` : ''}{r.want?.max_cost_inr ? ` · up to ₹${r.want.max_cost_inr}` : ''}</p>
      {r.mode === 'compare' && recs.length >= 2 && <Compare a={recs[0]} b={recs[1]} />}
      {recs.map((x, i) => <RecipeCard key={i} x={x} />)}
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

export function SourceLine({ s }) {
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

function RecipeCard({ x }) {
  const [open, setOpen] = useState(false)
  const c = x.cost || {}
  // Its own page, with this recipe as written - its own ingredients and steps
  const href = dishHref({
    name: x.name, servings: 1,
    recipe: { name: x.name, ingredients: x.ingredients.map((l) => ({ item: l.item, grams: l.grams })), steps: x.steps,
              time_min: x.time_min, indb: (x.nutrition_source.dishes || []).map((d) => ({ name: d.name, servings: d.servings })) },
  })
  return (
    <div className={`card ${x.fits ? '' : 'opacity-90'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link to={href} className="text-sm font-black text-gray-900 underline decoration-amber-300 underline-offset-2">{x.name} ›</Link>
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
        <Link to={href} className="text-[11px] font-bold text-brand-600">Photo and full breakdown →</Link>
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

export function Plan({ r, onProfile, log = {}, setLog }) {
  const [logging, setLogging] = useState(null)     // "day:meal" whose log box is open
  // Which day is open survives a visit to a dish's page and back
  // Today's day opens by itself; one opened by hand stays open (that day, this plan)
  const todayAt = (r.days || []).findIndex((d) => isToday(planDate(r, d.day)))
  const [open, setOpenRaw] = useState(() => {
    const s = load('recipes_plan_day')
    return s && s.plan === r.made_at && s.on === isoDay(new Date()) ? s.i : Math.max(0, todayAt)
  })
  const setOpen = (i) => { setOpenRaw(i); keep('recipes_plan_day', { i, plan: r.made_at, on: isoDay(new Date()) }) }

  // Every dish of the week saved on this device in the background, a couple
  // at a time - so each card opens straight away, even offline
  useEffect(() => {
    if (!r.days?.length) return
    const names = [...new Set(r.days.flatMap((d) => Object.values(d.meals || {}).flat().map((x) => x.name)))]
      .filter((n) => !cachedDish(n))
    let stop = false
    const next = async () => {
      while (!stop && names.length) {
        const n = names.shift()
        try { keepDish(n, null, (await recipeDish(n, 1)).data) } catch { /* tried again next visit */ }
      }
    }
    next(); next()
    return () => { stop = true }
  }, [r.made_at])
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
        {r.days?.length > 0 && (() => {
          const first = planDate(r, 1), last = planDate(r, r.days.length)
          const over = isoDay(new Date()) > isoDay(last)
          return (
            <p className={`text-[11px] font-bold mb-1 ${over ? 'text-amber-700' : 'text-gray-700'}`}>
              Week of {dayLabel(first)} – {dayLabel(last)}{over ? ' · over - make next week’s plan' : ''}
              {r.made_at && <span className="font-normal text-gray-400"> · saved {new Date(r.made_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>}
            </p>
          )
        })()}
        <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Your daily target</p>
        <p className="text-lg font-black text-gray-900 mt-0.5">{t.kcal} kcal · {t.protein_g} g protein</p>
        <p className="text-[11px] text-gray-500 mt-0.5">
          You burn about {t.tdee} kcal a day ({t.bmr} at rest); {t.pace_kg_week ? `eating ${t.tdee - t.kcal} less loses about ${t.pace_kg_week} kg a week` : 'eating that keeps your weight'}. BMI {t.bmi}.
          {t.floored && ' Kept at the safe minimum - a slower pace would be gentler.'}
        </p>
        <p className="text-[10px] text-gray-400 mt-1">A guide worked out from your numbers (Mifflin-St Jeor), not medical advice. Portions are scaled to land near the target.</p>
      </div>
      {r.days.map((d, i) => {
        const eaten = log[String(d.day)] || {}
        const logged = Object.keys(eaten).filter((m) => d.meals[m]?.length || eaten[m])
        const sumMeal = (xs, k) => xs.reduce((s, x) => s + (x[k] || 0), 0)
        // The day as logged: what was had, against the plan and the target
        const date = planDate(r, d.day)
        const mealsPlanned = Object.values(d.meals).filter((xs) => xs.length).length
        const hadK = Object.values(eaten).reduce((s, e) => s + e.totals.kcal, 0)
        const hadP = Object.values(eaten).reduce((s, e) => s + e.totals.protein, 0)
        const plannedForLogged = Object.entries(d.meals).reduce((s, [m, xs]) => s + (eaten[m] ? sumMeal(xs, 'kcal') : 0), 0)
        const complete = mealsPlanned > 0 && logged.length >= mealsPlanned
        const future = isoDay(date) > isoDay(new Date())
        const tone = (v, ref) => (Math.abs(v - ref) <= ref * 0.1 ? 'text-green-700' : v > ref ? 'text-red-600' : 'text-amber-700')
        const verdict = complete
          ? { text: hadK > t.kcal ? `${r0(hadK - t.kcal)} kcal over target` : hadK < t.kcal ? `${r0(t.kcal - hadK)} kcal under target` : 'On target', cls: tone(hadK, t.kcal) }
          : logged.length
            ? { text: `${logged.length} of ${mealsPlanned} meals logged - ${r0(hadK - plannedForLogged) === 0 ? 'as planned so far' : `${r0(Math.abs(hadK - plannedForLogged))} kcal ${hadK > plannedForLogged ? 'more' : 'less'} than planned so far`}`, cls: tone(hadK, plannedForLogged) }
            : { text: future ? 'Coming up' : 'Nothing logged', cls: 'text-gray-400' }
        return (
          <div key={d.day} className={`card ${isToday(date) ? 'border-brand-400/60' : ''}`}>
            <button onClick={() => setOpen(open === i ? -1 : i)} className="w-full flex items-center justify-between gap-2 text-left">
              <span className="text-sm font-black text-gray-900">
                {dayLabel(date)}
                {isToday(date) && <span className="ml-1.5 text-[9px] font-black text-white bg-brand-400 rounded px-1.5 py-0.5 align-middle">TODAY</span>}
                <span className="block text-[10px] font-bold text-gray-400">Day {d.day}</span>
              </span>
              <span className="text-[11px] font-bold text-brand-600">{open === i ? 'Hide meals ▾' : 'Meals ▸'}</span>
            </button>
            <div className="grid grid-cols-3 gap-1.5 mt-2">
              <div className="bg-amber-50 rounded-md px-2 py-1.5">
                <p className="text-sm font-black text-gray-900 tabular-nums">{r0(d.totals.kcal)}</p>
                <p className="text-[9px] text-gray-500">kcal planned{d.cost != null ? ` · ₹${d.cost}${d.cost_partial ? '+' : ''}` : ''}</p>
              </div>
              <div className="bg-amber-50 rounded-md px-2 py-1.5">
                <p className={`text-sm font-black tabular-nums ${logged.length ? 'text-gray-900' : 'text-gray-300'}`}>{logged.length ? r0(hadK) : '-'}</p>
                <p className="text-[9px] text-gray-500">kcal you had ({logged.length}/{mealsPlanned} meals)</p>
              </div>
              <div className="bg-amber-50 rounded-md px-2 py-1.5">
                <p className={`text-sm font-black tabular-nums ${logged.length ? tone(hadP, t.protein_g * (complete ? 1 : logged.length / mealsPlanned)) : 'text-gray-300'}`}>{logged.length ? `${r0(hadP)} g` : '-'}</p>
                <p className="text-[9px] text-gray-500">protein of {t.protein_g} g</p>
              </div>
            </div>
            <p className={`text-[11px] font-bold mt-1.5 ${verdict.cls}`}>{verdict.text}{complete ? ` · target ${t.kcal}` : ''}</p>
            {open === i && (
              <div className="mt-2 space-y-2">
                {Object.entries(d.meals).filter(([, xs]) => xs.length).map(([meal, xs]) => (
                  <div key={meal}>
                    <div className="flex items-center justify-between">
                      <Link to={`/recipes/meal?day=${d.day}&meal=${meal}`}
                        className="text-[11px] font-black text-brand-600 uppercase tracking-widest underline decoration-amber-300 underline-offset-2">{meal} ›</Link>
                      {!eaten[meal] && (
                        <button onClick={() => setLogging(logging === `${d.day}:${meal}` ? null : `${d.day}:${meal}`)}
                          className="text-[10px] font-bold text-brand-600">{logging === `${d.day}:${meal}` ? 'Close' : '＋ What I had'}</button>
                      )}
                    </div>
                    {/* Logged: only what you had shows - the plan is on each dish's page, compared */}
                    {!eaten[meal] && xs.map((x, j) => (
                      <div key={j} className="flex items-baseline justify-between gap-2 text-xs py-1">
                        <span className="text-gray-800 min-w-0">{x.name} <span className="text-gray-400">× {x.servings} {x.unit}</span></span>
                        <span className="text-gray-500 tabular-nums flex-shrink-0">{r0(x.kcal)} kcal · {r0(x.protein)} g P{x.cost != null ? ` · ₹${x.cost}` : ''}</span>
                      </div>
                    ))}
                    {(eaten[meal] || logging === `${d.day}:${meal}`) && (
                      <MealLog day={d.day} meal={meal} planned={xs} entry={eaten[meal]}
                        onLog={(l, w) => { setLog(l, w); setLogging(null) }} />
                    )}
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
  const timer = useRef(null)
  const edited = useRef(false)
  useEffect(() => { if (!edited.current) setP(me.profile || {}) }, [me.profile])
  const t = me.targets
  // Saved as you go (a moment after the last change) - no button to forget
  const set = (k, v) => {
    edited.current = true
    const next = { ...p, [k]: v }
    setP(next)
    setSaved('Saving…')
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      try {
        const d = await save({ profile: next })
        setSaved(d.targets ? '✓ Saved' : '✓ Saved - add age, height, weight and sex for a target')
      } catch { setSaved("Couldn't save - check your connection") }
    }, 700)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  const num = (k, label, ph) => (
    <label className="block">
      <span className="text-[10px] font-bold text-gray-500">{label}</span>
      <input type="number" inputMode="decimal" className="input text-sm py-2" placeholder={ph} value={p[k] ?? ''} onChange={(e) => set(k, e.target.value)} />
    </label>
  )
  // A fortnight since the numbers were last checked: time to ask again
  const since = me.profile?.updated_at ? (Date.now() - new Date(me.profile.updated_at).getTime()) / 86400000 : null
  const due = t && since != null && since >= 14
  const still = async () => {
    setSaved('Saving…')
    try { await save({ profile: me.profile, confirm: true }); setSaved('✓ Thanks - asked again in two weeks') } catch { setSaved("Couldn't save") }
  }
  return (
    <div className={`card ${due ? 'border-amber-300 bg-amber-50/40' : ''}`}>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between text-left">
        <span>
          <span className="text-sm font-bold text-gray-800">Your details</span>
          <span className="block text-[11px] text-gray-500">
            {t ? `${me.profile.weight_kg} kg · ${me.profile.height_cm} cm · target ${t.kcal} kcal and ${t.protein_g} g protein a day`
               : 'Age, height, weight - to work out your daily target'}
          </span>
        </span>
        <span className="text-gray-400 text-xs">{open ? '▾ Hide' : '▸ Edit'}</span>
      </button>
      {due && !open && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <p className="text-[11px] font-bold text-amber-800 flex-1 min-w-[160px]">It's been {Math.floor(since / 7)} weeks - still {me.profile.weight_kg} kg? An up-to-date weight keeps the target right.</p>
          <button onClick={() => setOpen(true)} className="text-[11px] font-bold text-white bg-brand-400 rounded-md px-2.5 py-1">Update</button>
          <button onClick={still} className="text-[11px] font-bold text-gray-600 bg-white border border-amber-200 rounded-md px-2.5 py-1">Still the same</button>
        </div>
      )}
      {!open && saved && <p className="text-[11px] text-green-700 mt-1">{saved}</p>}
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
          <div className="flex items-center gap-3">
            {t && <button type="button" disabled={busy} onClick={() => { setOpen(false); onPlan() }} className="btn-primary text-xs py-2 px-4 disabled:opacity-50">Plan 7 days</button>}
            <button type="button" onClick={() => setOpen(false)} className="text-xs font-bold text-gray-500">Done</button>
            <span className="text-[11px] text-green-700">{saved || 'Saved as you type'}</span>
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
