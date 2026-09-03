import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getRecommendMeta, getRecommendation, getFriends } from '../api'

import LoadingSpinner from '../components/LoadingSpinner'
import { useUser } from '../UserContext'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

// Shown if /recommend/meta can't be reached, so the form is never dead. The
// server is still the authority — a state missing real prices 404s on submit.
const FALLBACK_STATES = ['Delhi', 'Maharashtra', 'Uttar Pradesh']

// The bottle you intend to buy — not a per-person amount.
const BOTTLES = [
  [180, 'Quarter', '180ml'],
  [375, 'Half',    '375ml'],
  [750, 'Full',    '750ml'],
]

const pct = (v, known) => `${known ? '' : '~'}${v}% ABV`

/**
 * What to drink, for this many people, on this budget.
 *
 * Grounded in two real things: published state price lists (alcohol is a state
 * subject in India, so the state matters more than anything else) and what
 * this exact set of people has actually bought together before.
 */
export default function Recommend() {
  const nav  = useNavigate()
  const user = useUser()

  const [meta, setMeta]       = useState(null)
  const [friends, setFriends] = useState([])
  const [state, setState]     = useState('')
  // Held as strings while typing. As numbers, clearing the field produced
  // parseFloat('') -> 0, so the box refilled itself with a "0" you had to
  // delete before every edit, and a budget of 0 got sent to the server.
  const [people, setPeople]   = useState('2')
  const [budget, setBudget]   = useState('2000')
  const [bottle, setBottle] = useState(750)
  const [withWho, setWithWho] = useState([])
  const [result, setResult]   = useState(null)
  const [error, setError]     = useState('')
  const [busy, setBusy]       = useState(false)

  // Two independent calls, loaded independently. They used to share a
  // Promise.all, so a failure in either left the state dropdown empty with a
  // generic message and no way to tell which one broke.
  useEffect(() => {
    getRecommendMeta()
      .then((m) => {
        // A misrouted /api can return the SPA's index.html with a 200, which
        // axios hands over as a string. Treat anything that isn't the shape we
        // expect as a failure instead of silently rendering an empty form.
        const states = m.data?.states
        if (!Array.isArray(states) || states.length === 0) {
          throw Object.assign(new Error('bad meta'), { badShape: true })
        }
        setMeta(m.data)
        setState((cur) => cur || states[0])
      })
      .catch((err) => {
        const code = err.response?.status
        setMeta({ states: FALLBACK_STATES, sources: {} })
        setState((cur) => cur || FALLBACK_STATES[0])
        setError(
          err.badShape
            ? 'The API returned the web page instead of data — VITE_API_URL is probably not pointing at the backend.'
            : code === 404
              ? 'The backend is running an older build without the recommender — redeploy it.'
              : `Could not load prices (${code || 'network error'}).`
        )
      })

    getFriends(user?.name)
      .then((f) => setFriends(f.data.map((x) => x.name)))
      .catch(() => setFriends([]))
  }, [user?.name])

  const peopleN = Math.max(1, parseInt(people, 10) || 0)
  const budgetN = Math.max(0, parseFloat(budget) || 0)
  const canRun = state && peopleN >= 1 && budgetN > 0

  // People in the room = you + everyone picked, unless you override the count
  const toggle = (n) => setWithWho((w) => {
    const next = w.includes(n) ? w.filter((x) => x !== n) : [...w, n]
    setPeople(String(next.length + 1))
    return next
  })

  const run = async () => {
    setError(''); setBusy(true)
    try {
      const r = await getRecommendation({
        state, people: peopleN, budget: budgetN, bottle_ml: bottle,
        names: withWho.join(','),
      })
      setResult(r.data)
    } catch (err) {
      const code = err.response?.status
      setError(
        err.response?.data?.detail ||
        (code === 404
          ? 'The server does not have the recommender yet — redeploy the backend.'
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
        <h1 className="text-xl font-black tracking-tight">What to drink</h1>
        <p className="text-xs text-gray-400 mt-1">
          Priced for your state, ranked by what you actually buy
        </p>
      </div>

      <div className="px-5 mt-4 space-y-4 max-w-2xl">
        <div className="card space-y-3">
          {/* State first: alcohol is taxed per state, so it drives every price */}
          <div>
            <label className="label">State</label>
            <select className="input" value={state} onChange={(e) => setState(e.target.value)}>
              {(meta?.states ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <p className="text-[10px] text-gray-400 mt-1">
              Only states with published prices we could source are listed.
              Picks also show what the same bottle costs across the NCR.
            </p>
          </div>

          <div>
            <label className="label">Drinking with</label>
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

          <div className="grid grid-cols-2 gap-3">
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
            <div>
              <label className="label">Budget (₹)</label>
              <input
                className="input font-bold" type="number" min="0" step="100"
                inputMode="numeric"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                onBlur={() => setBudget((v) => (parseFloat(v) > 0 ? String(parseFloat(v)) : ''))}
              />
            </div>
          </div>

          <div>
            <label className="label">Bottle size</label>
            <div className="flex gap-2">
              {BOTTLES.map(([v, label, hint]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setBottle(v)}
                  className={`flex-1 rounded-md px-2 py-1.5 text-xs font-bold border transition-all ${
                    bottle === v
                      ? 'bg-brand-400 border-brand-400 text-white'
                      : 'bg-cream border-amber-200 text-gray-500 hover:bg-amber-50'
                  }`}
                >
                  {label}
                  <span className="block text-[9px] font-normal opacity-70">{hint}</span>
                </button>
              ))}
            </div>
            <p className="text-[10px] text-gray-400 mt-1">
              The size you want to buy. Best bottles within budget come first.
            </p>
          </div>

          <button onClick={run} className="btn-primary" disabled={busy || !canRun}>
            {busy ? 'Working it out…' : 'Recommend'}
          </button>
        </div>

        {error && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>
        )}

        {/* Only shown once somebody is named. Without that it was the
            caller's own drinking across every group, presented as "sessions
            together" with nobody to have had them with. */}
        {hist?.scoped && (
          <div className="card">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
              With {hist.with_names.join(', ')}
            </p>
            <p className="text-sm font-bold text-gray-900 mt-1">
              {hist.occasions === 0
                ? 'No drinks recorded together yet'
                : `${hist.occasions} sessions together · ${INR(hist.avg_per_occasion)} average`}
            </p>
            {hist.favourites.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {hist.favourites.map((b) => (
                  <span key={b} className="badge bg-amber-100 text-gray-700 border border-amber-200">
                    {b} ×{hist.brand_counts[b]}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {result && (
          <div className="space-y-2">
            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">
              {result.bottle_name} bottles · {result.people} people · {INR(result.budget)}
            </p>

            {result.picks.length === 0 && (
              <div className="card text-center py-6">
                <p className="text-sm text-gray-400">
                  {result.size_available
                    ? `No ${result.bottle_ml}ml bottle in ${result.state} comes in under ${INR(result.budget)}.`
                    : `No ${result.bottle_ml}ml prices published for ${result.state} yet.`}
                </p>
              </div>
            )}

            {result.picks.map((p, i) => (
              <div key={`${p.brand}-${p.size_ml}-${i}`} className="card p-3.5">
                <div className="flex items-baseline gap-2">
                  <p className="text-sm font-black text-gray-900 flex-1 min-w-0">
                    {p.brand}
                    {p.is_favourite && (
                      <span className="ml-1.5 text-[9px] font-bold text-brand-600 uppercase tracking-wider">
                        you buy this
                      </span>
                    )}
                  </p>
                  <span className="badge bg-amber-100 text-gray-600 border border-amber-200 flex-shrink-0">
                    {pct(p.abv, p.abv_known)}
                  </span>
                  <p className="text-sm font-black text-brand-600 flex-shrink-0">{INR(p.total)}</p>
                </div>
                {/* What you actually ask for at the counter */}
                <p className="text-[11px] font-bold text-gray-700 mt-0.5">
                  1 {p.size_name} · {p.size_ml}ml
                  <span className="font-normal text-gray-400">
                    {' '}· {p.kind}
                    {p.unit_price_max && p.unit_price_max !== p.unit_price
                      ? ` · ${INR(p.unit_price)}–${INR(p.unit_price_max)}`
                      : ''}
                  </span>
                </p>
                {/* Split across the group, and what the budget would stretch to */}
                <p className="text-[10px] text-gray-400 mt-0.5">
                  {INR(p.per_head)} a head ·{' '}
                  <span className="text-gray-500 font-semibold">
                    {p.ml_per_head}ml each ({p.alcohol_ml_per_head}ml pure alcohol)
                  </span>
                  {p.budget_buys > 1 && ` · budget buys ${p.budget_buys}`}
                </p>

                {/* Same bottle across the NCR — these are a drive apart, and
                    the gap is often worth more than the drive. */}
                {p.compare?.some((c) => c.total !== null) && (
                  <div className="grid grid-cols-3 gap-1 mt-2 pt-2 border-t border-amber-100">
                    {p.compare.map((c) => {
                      const best = c.region === p.cheapest_region && c.total !== null
                      return (
                        <div
                          key={c.region}
                          className={`rounded px-1.5 py-1 text-center ${
                            best ? 'bg-green-50 border border-green-200' : 'bg-amber-50/60'
                          }`}
                        >
                          <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wide truncate">
                            {c.region.replace(' (Haryana)', '')}
                          </p>
                          <p className={`text-[11px] font-black ${best ? 'text-green-700' : 'text-gray-500'}`}>
                            {c.total === null ? '—' : INR(c.total)}
                          </p>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ))}

            {result.beers?.length > 0 && (
              <>
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest pt-3">
                  Beer · strongest first
                </p>
                {result.beers.map((b, i) => (
                  <div key={`${b.brand}-${b.size_ml}-${i}`} className="card p-3.5">
                    <div className="flex items-baseline gap-2">
                      <p className="text-sm font-black text-gray-900 flex-1 min-w-0 truncate">
                        {b.brand}
                      </p>
                      <span className="badge bg-amber-100 text-gray-600 border border-amber-200 flex-shrink-0">
                        {pct(b.abv, b.abv_known)}
                      </span>
                      <p className="text-sm font-black text-brand-600 flex-shrink-0">{INR(b.total)}</p>
                    </div>
                    <p className="text-[11px] font-bold text-gray-700 mt-0.5">
                      {b.qty} × {b.size_ml}ml
                      <span className="font-normal text-gray-400">
                        {' '}·{' '}
                        {b.unit_price_max && b.unit_price_max !== b.unit_price
                          ? `${INR(b.unit_price)}–${INR(b.unit_price_max)}`
                          : INR(b.unit_price)} each
                      </span>
                    </p>
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      {INR(b.per_head)} a head ·{' '}
                      <span className="text-gray-500 font-semibold">
                        {b.bottles_per_head} bottles each ({b.alcohol_ml_per_head}ml pure alcohol)
                      </span>
                    </p>
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
                Alcohol is a state subject in India, so every state sets its own MRP.
                These are scraped from public listings of state price lists and are
                indicative — shops vary and excise years change them. Haryana sets a
                minimum selling price rather than a fixed MRP, so its rows are ranges
                and shops can legally charge above them. A dash means that region has
                no published price for that exact bottle and size — never a guess
                carried over from another state.
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
