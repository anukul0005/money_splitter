import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getFoodMeta, getFoodRecommendation, getFriends } from '../api'

import LoadingSpinner from '../components/LoadingSpinner'
import RecommendTabs from '../components/RecommendTabs'
import { useUser } from '../UserContext'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

// Shown if /food/meta can't be reached, so the form is never dead. The server
// is still the authority — a city with no real prices 404s on submit.
const FALLBACK_CITIES = ['Delhi', 'Gurugram', 'Noida']

// A restaurant bill moves in hundreds, so the drinks slider's ₹60 minimum span
// would let through a range that matches nothing. Mirrors the server's rule.
const MIN_SPAN   = 200
const BUDGET_MAX = 10000
const BUDGET_STEP = 50

/**
 * Where to eat, for this many people, on this budget.
 *
 * The sister page to the drink recommender and grounded the same way: a cited
 * Delhi NCR price table plus what this exact set of people has actually spent
 * eating out together.
 *
 * Restaurants are priced in "cost for two" because that is the only food
 * number published consistently enough to tabulate — so every total here is
 * called an estimate, and the page says so rather than implying a quote.
 */
export default function RecommendFood({ tab, setTab }) {
  const nav  = useNavigate()
  const user = useUser()

  const [meta, setMeta]       = useState(null)
  const [friends, setFriends] = useState([])
  const [city, setCity]       = useState('')
  // Held as a string while typing: as a number, clearing the field gave
  // parseInt('') -> 0 and the box refilled itself with a 0 you had to delete.
  const [people, setPeople]   = useState('2')
  const [budgetMin, setBudgetMin] = useState(800)
  const [budgetMax, setBudgetMax] = useState(2000)
  const [cuisine, setCuisine] = useState('any')
  const [kind, setKind]       = useState('any')
  const [veg, setVeg]         = useState(false)
  const [withWho, setWithWho] = useState([])
  const [result, setResult]   = useState(null)
  const [error, setError]     = useState('')
  const [busy, setBusy]       = useState(false)

  // Two independent calls, loaded independently, so a failure in either says
  // which one broke instead of leaving an empty form with a generic message.
  useEffect(() => {
    getFoodMeta()
      .then((m) => {
        // A misrouted /api can return the SPA's index.html with a 200, which
        // axios hands over as a string. Anything not shaped like meta is a
        // failure, not an empty form.
        const cities = m.data?.cities
        if (!Array.isArray(cities) || cities.length === 0) {
          throw Object.assign(new Error('bad meta'), { badShape: true })
        }
        setMeta(m.data)
        setCity((cur) => cur || cities[0])
      })
      .catch((err) => {
        const code = err.response?.status
        setMeta({ cities: FALLBACK_CITIES, cuisines: [], kinds: [], sources: {} })
        setCity((cur) => cur || FALLBACK_CITIES[0])
        setError(
          err.badShape
            ? 'The API returned the web page instead of data — VITE_API_URL is probably not pointing at the backend.'
            : code === 404
              ? 'The backend is running an older build without the food recommender — redeploy it.'
              : `Could not load restaurant prices (${code || 'network error'}).`
        )
      })

    getFriends(user?.name)
      .then((f) => setFriends(f.data.map((x) => x.name)))
      .catch(() => setFriends([]))
  }, [user?.name])

  const peopleN = Math.max(1, parseInt(people, 10) || 0)
  const loN = budgetMin
  const hiN = budgetMax
  const canRun = city && peopleN >= 1 && hiN - loN >= MIN_SPAN

  // Dragging either thumb pushes the other rather than crossing it, so the
  // minimum span holds without ever refusing the drag.
  const dragLo = (v) => {
    const lo = Math.min(v, BUDGET_MAX - MIN_SPAN)
    setBudgetMin(lo)
    setBudgetMax((hi) => Math.max(hi, lo + MIN_SPAN))
  }
  const dragHi = (v) => {
    const hi = Math.max(v, MIN_SPAN)
    setBudgetMax(hi)
    setBudgetMin((lo) => Math.min(lo, hi - MIN_SPAN))
  }
  const asPct = (v) => (v / BUDGET_MAX) * 100

  // People at the table = you + everyone picked, unless you override the count
  const toggle = (n) => setWithWho((w) => {
    const next = w.includes(n) ? w.filter((x) => x !== n) : [...w, n]
    setPeople(String(next.length + 1))
    return next
  })

  // Only cuisines this city actually has rows for. Offering "Seafood" in a
  // city with no seafood row is a filter that can only return nothing.
  const cuisineList = meta?.cuisines_by_city?.[city] ?? meta?.cuisines ?? []

  // Changing city can strip the cuisine out from under the filter, which
  // otherwise silently returns nothing for a choice no longer on offer.
  useEffect(() => {
    if (cuisine !== 'any' && cuisineList.length && !cuisineList.includes(cuisine)) {
      setCuisine('any')
    }
  }, [city, cuisine, cuisineList])

  const run = async () => {
    setError(''); setBusy(true)
    try {
      const r = await getFoodRecommendation({
        city, people: peopleN, budget_min: loN, budget_max: hiN,
        cuisine, kind, veg, names: withWho.join(','),
      })
      setResult(r.data)
    } catch (err) {
      const code = err.response?.status
      setError(
        err.response?.data?.detail ||
        (code === 404
          ? 'The server does not have the food recommender yet — redeploy the backend.'
          : `Could not work that out (${code || 'network error'}).`)
      )
      setResult(null)
    } finally { setBusy(false) }
  }

  if (!meta) return <LoadingSpinner />

  const hist = result?.history

  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <h1 className="text-xl font-black tracking-tight">Where to eat</h1>
        <p className="text-xs text-gray-400 mt-1">
          Delhi NCR, priced for your table and what you actually order
        </p>
        <RecommendTabs tab={tab} setTab={setTab} />
      </div>

      <div className="px-5 mt-4 space-y-4 max-w-2xl">
        <div className="card space-y-3">
          <div>
            <label className="label">City</label>
            <select className="input" value={city} onChange={(e) => setCity(e.target.value)}>
              {(meta?.cities ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <p className="text-[10px] text-gray-400 mt-1">
              Only cities with published prices we could source are listed.
              Restaurant prices are per city and are never borrowed from the
              city next door.
            </p>
          </div>

          <div>
            <label className="label">Eating with</label>
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
          </div>

          <div>
            <label className="label">People</label>
            <input
              className="input font-bold" type="number" min="1" max="30"
              inputMode="numeric"
              value={people}
              onChange={(e) => setPeople(e.target.value)}
              onBlur={() => setPeople((v) => (parseInt(v, 10) > 0 ? String(parseInt(v, 10)) : '1'))}
            />
          </div>

          {/* A range, not a ceiling — "around 1500" is what people mean. */}
          <div>
            <label className="label">Budget for the table</label>
            <div className="rangepair">
              <span className="track" />
              <span
                className="fill"
                style={{ left: `${asPct(loN)}%`, right: `${100 - asPct(hiN)}%` }}
              />
              <input
                type="range" min={0} max={BUDGET_MAX} step={BUDGET_STEP}
                value={loN}
                aria-label="Minimum budget"
                onChange={(e) => dragLo(Number(e.target.value))}
              />
              <input
                type="range" min={0} max={BUDGET_MAX} step={BUDGET_STEP}
                value={hiN}
                aria-label="Maximum budget"
                onChange={(e) => dragHi(Number(e.target.value))}
              />
            </div>
            <div className="flex items-baseline justify-between mt-1">
              <p className="text-sm font-black text-gray-900">
                {INR(loN)} – {INR(hiN)}
              </p>
              <p className="text-[10px] text-gray-400">
                {INR(Math.round(loN / peopleN))}–{INR(Math.round(hiN / peopleN))} a head
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">Cuisine</label>
              <select className="input" value={cuisine} onChange={(e) => setCuisine(e.target.value)}>
                <option value="any">Anything</option>
                {cuisineList.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Kind of place</label>
              <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="any">Anywhere</option>
                {(meta?.kinds ?? []).map((k) => (
                  <option key={k.value} value={k.value}>{k.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Pure-veg is a property of the restaurant, not the diner: this
              narrows to places with no meat on the menu at all, which is a
              much stronger claim than "has veg options". */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox" className="accent-brand-400"
              checked={veg} onChange={(e) => setVeg(e.target.checked)}
            />
            <span className="text-xs font-bold text-gray-600">Pure veg places only</span>
          </label>

          <button onClick={run} className="btn-primary" disabled={busy || !canRun}>
            {busy ? 'Working it out…' : 'Recommend'}
          </button>
        </div>

        {error && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>
        )}

        {/* Only shown once somebody is named. Without that it is the caller's
            own eating across every group, which would read as "meals
            together" with nobody to have had them with. */}
        {hist?.scoped && (
          <div className="card">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
              With {hist.with_names.join(', ')}
            </p>
            <p className="text-sm font-bold text-gray-900 mt-1">
              {hist.occasions === 0
                ? 'No meals recorded together yet'
                : `${hist.occasions} meals together · ${INR(hist.avg_per_occasion)} average`}
            </p>
            {hist.favourites.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {hist.favourites.map((c) => (
                  <span key={c} className="badge bg-amber-100 text-gray-700 border border-amber-200">
                    {c} ×{hist.cuisine_counts[c]}
                  </span>
                ))}
              </div>
            )}
            {hist.occasions > 0 && (
              <p className="text-[10px] text-gray-400 mt-2">
                Counted from expenses that name food. Grocery runs are left out —
                they say nothing about where you like to eat.
              </p>
            )}
          </div>
        )}

        {result && (
          <div className="space-y-2">
            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">
              {result.city} · {result.people} people · {INR(result.budget_min)}–{INR(result.budget_max)}
              {result.cuisine !== 'any' && ` · ${result.cuisine}`}
            </p>

            {result.picks.length === 0 && (
              <div className="card text-center py-6">
                <p className="text-sm text-gray-400">
                  {!result.cuisine_available
                    ? `No ${result.cuisine} places priced in ${result.city} yet.`
                    : `Nothing in ${result.city} works out between ${INR(result.budget_min)} and ${INR(result.budget_max)} for ${result.people}.`}
                </p>
                {/* Dead ends are the common case with a narrow range, so say
                    what a table this size actually costs here. */}
                {result.price_band && (
                  <p className="text-xs text-gray-500 mt-1.5">
                    A table for {result.people} runs{' '}
                    <span className="font-bold">
                      {INR(result.price_band.min)}–{INR(result.price_band.max)}
                    </span> here.
                  </p>
                )}
              </div>
            )}

            {result.picks.map((p, i) => (
              <div key={`${p.name}-${p.area}-${i}`} className="card p-3.5">
                <div className="flex items-baseline gap-2">
                  <p className="text-sm font-black text-gray-900 flex-1 min-w-0">
                    {p.name}
                    {p.been_before && (
                      <span className="ml-1.5 text-[9px] font-bold text-brand-600 uppercase tracking-wider">
                        you&apos;ve been
                      </span>
                    )}
                  </p>
                  {p.veg_only && (
                    <span className="badge bg-green-50 text-green-700 border border-green-200 flex-shrink-0">
                      pure veg
                    </span>
                  )}
                  <p className="text-sm font-black text-brand-600 flex-shrink-0">
                    {/* A restaurant bill is never exact, so it is never
                        presented as one. */}
                    ~{INR(p.total)}
                  </p>
                </div>

                <p className="text-[11px] font-bold text-gray-700 mt-0.5">
                  {p.area}
                  <span className="font-normal text-gray-400">
                    {' '}· {p.cuisines.join(', ')}
                    {p.kind !== 'dine-in' && ` · ${p.kind_name}`}
                  </span>
                </p>

                <p className="text-[10px] text-gray-400 mt-0.5">
                  {INR(p.per_head)} a head ·{' '}
                  <span className="text-gray-500 font-semibold">
                    {p.for_two_max
                      ? `${INR(p.for_two)}–${INR(p.for_two_max)} for two`
                      : `${INR(p.for_two)} for two`}
                  </span>
                  {p.matched_cuisines.length > 0 &&
                    ` · you eat ${p.matched_cuisines.join(' & ')}`}
                </p>

                {/* Real menu prices where we have them, so a pick is more than
                    a number. A sample, never a bill — we don't hold full
                    menus and a part-guessed total would read as a real one. */}
                {p.menu.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-amber-100 space-y-0.5">
                    {p.menu.map((d) => (
                      <div key={d.name} className="flex items-baseline gap-2">
                        <span className="text-[10px] text-gray-500 flex-1 min-w-0 truncate">
                          {d.name}
                        </span>
                        <span className="text-[10px] font-bold text-gray-600 flex-shrink-0">
                          {d.price_max ? `${INR(d.price)}–${INR(d.price_max)}` : INR(d.price)}
                        </span>
                      </div>
                    ))}
                    <p className="text-[9px] text-gray-400 pt-0.5">
                      A few things off the menu — not the whole bill
                    </p>
                  </div>
                )}
              </div>
            ))}

            {/* The small-budget answer. Street staples genuinely have no one
                address, so they are priced by the plate rather than by place. */}
            {result.street?.length > 0 && (
              <>
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest pt-2">
                  Or eat on the street
                </p>
                {result.street.map((s) => (
                  <div key={s.name} className="card p-3.5">
                    <div className="flex items-baseline gap-2">
                      <p className="text-sm font-black text-gray-900 flex-1 min-w-0">{s.name}</p>
                      {s.veg && (
                        <span className="badge bg-green-50 text-green-700 border border-green-200 flex-shrink-0">
                          veg
                        </span>
                      )}
                      <p className="text-sm font-black text-brand-600 flex-shrink-0">~{INR(s.total)}</p>
                    </div>
                    <p className="text-[11px] font-bold text-gray-700 mt-0.5">
                      {s.plates} plates · two each
                      <span className="font-normal text-gray-400">
                        {' '}·{' '}
                        {s.price_max ? `${INR(s.price)}–${INR(s.price_max)}` : INR(s.price)} a plate
                      </span>
                    </p>
                    <p className="text-[10px] text-gray-400 mt-0.5">{INR(s.per_head)} a head</p>
                  </div>
                ))}
              </>
            )}

            {/* Say plainly where the numbers came from and how stale they are */}
            <details className="card">
              <summary className="text-[11px] font-bold text-gray-500 cursor-pointer">
                Where these prices come from
              </summary>
              <p className="text-[10px] text-gray-500 leading-relaxed mt-2">
                Unlike alcohol, food has no legal price — a restaurant sets its
                own menu and changes it whenever it likes. So these are “cost
                for two”, the figure listing sites publish and diners already
                think in, scaled to your head count. It is a typical bill for a
                normal order and excludes alcohol. Where two sources disagreed
                the row keeps both ends as a range rather than picking one and
                calling it the price. Every total is an estimate, which is why
                each is shown with a ~. Nothing is scraped from Zomato or
                Swiggy: their prices are per-outlet and change weekly, and
                mirroring their menus here would be a licensing problem rather
                than a technical one.
              </p>
              <ul className="mt-2 space-y-1">
                {Object.entries(result.sources).map(([k, v]) => (
                  <li key={k} className="text-[10px] text-gray-400 break-all">
                    {v.as_of} · <a className="underline" href={v.url} target="_blank" rel="noreferrer">{v.url}</a>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
      </div>
    </div>
  )
}
