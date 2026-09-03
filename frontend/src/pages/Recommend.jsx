import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getRecommendMeta, getRecommendation, getFriends } from '../api'

import LoadingSpinner from '../components/LoadingSpinner'
import PriceEditForm from '../components/PriceEditForm'
import RecommendTabs from '../components/RecommendTabs'
import RecommendFood from './RecommendFood'
import { useUser } from '../UserContext'

// A missing number renders as a dash, never as "₹NaN". Number(undefined) is
// NaN, so any field the server stops sending — or hasn't started sending yet,
// mid-rollout — used to print "₹NaN" straight onto the card.
const INR = (n) => {
  const v = Number(n)
  return Number.isFinite(v)
    ? `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
    : '—'
}

// Shown if /recommend/meta can't be reached, so the form is never dead. The
// server is still the authority — a state missing real prices 404s on submit.
const FALLBACK_STATES = ['Delhi', 'Maharashtra', 'Uttar Pradesh']

// How much the group is drinking between them. 180ml across two people is
// 90ml each, so the hint is computed from the head count rather than fixed.
const BOTTLES = [
  ['180',  'Quarter', 180],
  ['375',  'Half',    375],
  ['750',  'Full',    750],
  ['beer', 'Beer',    null],
]

// Long lists are shown seven deep and the rest folded away, so the page opens
// on a real shortlist instead of a wall of bottles.
const TOP_N = 7

// dd-mm-yy. Dates arrive ISO from the server, which sorts correctly but is not
// how anybody here reads a date.
const fmtDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '')
  return m ? `${m[3]}-${m[2]}-${m[1].slice(2)}` : ''
}

const MIN_SPAN  = 60      // narrower than this matches nothing on a real price list
const BUDGET_MAX = 6000
const BUDGET_STEP = 10

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

  // Drinks and food are two tables answering the same question, so they share
  // a route and a tab rather than being two entries in the nav.
  const [tab, setTab]         = useState('drinks')
  const [meta, setMeta]       = useState(null)
  const [friends, setFriends] = useState([])
  const [state, setState]     = useState('')
  // Held as strings while typing. As numbers, clearing the field produced
  // parseFloat('') -> 0, so the box refilled itself with a "0" you had to
  // delete before every edit, and a budget of 0 got sent to the server.
  const [people, setPeople]   = useState('2')
  // Numbers, not strings: the slider can't be left empty, so the
  // clear-the-field problem the text inputs had doesn't arise.
  const [budgetMin, setBudgetMin] = useState(500)
  const [budgetMax, setBudgetMax] = useState(1000)
  // Empty means no size chosen, which is the default and is sent as "any".
  // There is no "Any" card: a filter that is simply off says the same thing
  // with one less button, and tapping the chosen one again turns it back off.
  const [bottle, setBottle] = useState('')
  const [showAllPicks, setShowAllPicks] = useState(false)
  const [showAllBeers, setShowAllBeers] = useState(false)
  const [withWho, setWithWho] = useState([])
  const [result, setResult]   = useState(null)
  const [error, setError]     = useState('')
  const [busy, setBusy]       = useState(false)
  // Which card's price form is open, keyed by the card's own key. `'new'`
  // opens the standalone add form. Only one is ever open at a time.
  const [editing, setEditing] = useState(null)

  // Two independent calls, loaded independently. They used to share a
  // Promise.all, so a failure in either left the state dropdown empty with a
  // generic message and no way to tell which one broke.
  // Pulled out of the effect so it can be called again after somebody adds a
  // price: a brand-new state has to appear in the selector straight away, not
  // after a reload.
  const loadMeta = () =>
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

  useEffect(() => {
    loadMeta()
    getFriends(user?.name)
      .then((f) => setFriends(f.data.map((x) => x.name)))
      .catch(() => setFriends([]))
  }, [user?.name])

  const peopleN = Math.max(1, parseInt(people, 10) || 0)
  const loN = budgetMin
  const hiN = budgetMax
  const canRun = state && peopleN >= 1 && hiN - loN >= MIN_SPAN

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

  // People in the room = you + everyone picked, unless you override the count
  const toggle = (n) => setWithWho((w) => {
    const next = w.includes(n) ? w.filter((x) => x !== n) : [...w, n]
    setPeople(String(next.length + 1))
    return next
  })

  const run = async (over = {}) => {
    setError(''); setBusy(true)
    setShowAllPicks(false); setShowAllBeers(false)
    try {
      const r = await getRecommendation({
        state: over.state || state,
        people: peopleN, budget_min: loN, budget_max: hiN,
        bottle: bottle || 'any',
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

  // Below every hook, so switching tabs never changes the hook order. Food
  // returns before the drinks meta check because it loads its own table and
  // shouldn't sit behind a spinner waiting for prices it doesn't use.
  if (tab === 'food') return <RecommendFood tab={tab} setTab={setTab} />

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
        <RecommendTabs tab={tab} setTab={setTab} />
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

          {/* A range, not a ceiling — "around 500" is what people mean. */}
          <div>
            <label className="label">Budget</label>
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

          <div>
            <label className="label">How much between you (optional)</label>
            <div className="grid grid-cols-4 gap-2">
              {BOTTLES.map(([v, label, hint]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setBottle((cur) => (cur === v ? '' : v))}
                  className={`rounded-md px-2 py-1.5 text-xs font-bold border transition-all ${
                    bottle === v
                      ? 'bg-brand-400 border-brand-400 text-white'
                      : 'bg-cream border-amber-200 text-gray-500 hover:bg-amber-50'
                  }`}
                >
                  {label}
                  <span className="block text-[9px] font-normal opacity-70">
                    {hint === null ? 'bottles' : `${hint}ml`}
                  </span>
                </button>
              ))}
            </div>
            {/* The number people actually care about: what that works out to
                each once it's shared out. */}
            <p className="text-[10px] text-gray-400 mt-1">
              {bottle === ''
                ? 'Nothing picked — every size and beer, whatever the budget covers. Tap one to narrow it, tap again to clear.'
                : bottle === 'beer'
                  ? 'Total for the group, split between you.'
                  : `${bottle}ml between ${peopleN} ${peopleN === 1 ? 'person' : 'people'} · ${Math.round(Number(bottle) / peopleN)}ml each.`}
            </p>
          </div>

          <button onClick={run} className="btn-primary" disabled={busy || !canRun}>
            {busy ? 'Working it out…' : 'Recommend'}
          </button>

          {/* Adding a bottle should not require running a search first. If you
              already know the price list is missing something, the moment to
              say so is now, not after being shown eight things that are not it. */}
          {editing === 'new-pre' ? (
            <PriceEditForm
              state={state}
              states={meta?.states ?? []}
              initial={{ state, size_ml: bottle && bottle !== 'beer' ? Number(bottle) : 750 }}
              onCancel={() => setEditing(null)}
              onDone={(saved) => {
                setEditing(null)
                loadMeta()
                if (saved?.state && saved.state !== state) setState(saved.state)
                if (result) run({ state: saved?.state })
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing('new-pre')}
              className="text-[11px] font-bold text-gray-400 hover:text-brand-600"
            >
              + Add a bottle or price we don&apos;t have
            </button>
          )}
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
              {/* Not "{name} bottles": "Half bottles" reads as half of the
                  bottles, when it means one 375ml bottle. */}
              {result.is_beer ? 'Beer' : `${result.bottle_ml}ml (${result.bottle_name})`} ·{' '}
              {result.people} people · {INR(result.budget_min)}–{INR(result.budget_max)}
            </p>

            {result.picks.length === 0 && result.beers.length === 0 && (
              <div className="card text-center py-6">
                <p className="text-sm text-gray-400">
                  {!result.size_available
                    ? `No ${result.is_beer ? 'beer' : `${result.bottle_ml}ml`} prices published for ${result.state} yet.`
                    : `Nothing ${result.is_beer ? 'in beer' : `at ${result.bottle_ml}ml`} in ${result.state} falls between ${INR(result.budget_min)} and ${INR(result.budget_max)}.`}
                </p>
                {/* Dead ends are the common case with a narrow range, so say
                    what the size actually costs instead of leaving them to guess */}
                {result.size_available && result.price_band && (
                  <p className="text-xs text-gray-500 mt-1.5">
                    They run <span className="font-bold">{INR(result.price_band.min)}–{INR(result.price_band.max)}</span> here.
                  </p>
                )}
              </div>
            )}

            {(showAllPicks ? result.picks : result.picks.slice(0, TOP_N)).map((p, i) => (
              <div key={`${p.brand}-${p.size_ml}-${i}`} className="card p-3.5">
                {/* The brand gets the full width and is allowed to wrap. The
                    official state lists print the whole registered label —
                    "SEAGRAMS 100 PIPERS EXCEPTIONAL BLENDED SCOTCH WHISKY" —
                    and squeezing that onto one line beside a badge and a
                    price cut it off exactly where the brand stops being
                    identifiable. */}
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-black text-gray-900 flex-1 min-w-0 break-words">
                    {p.brand}
                    {p.is_favourite && (
                      <span className="ml-1.5 text-[9px] font-bold text-brand-600 uppercase tracking-wider">
                        you buy this
                      </span>
                    )}
                  </p>
                  <p className="text-sm font-black text-brand-600 flex-shrink-0">{INR(p.total)}</p>
                </div>
                {/* What you actually ask for at the counter */}
                <p className="text-[11px] font-bold text-gray-700 mt-0.5">
                  1 {p.size_name} · {p.size_ml}ml
                  <span className="font-normal text-gray-400">
                    {' '}· {p.kind} · {pct(p.abv, p.abv_known)}
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

                {/* What was actually spent on nights this came up. Worded as
                    spend rather than as this bottle's price, because an
                    expense can be a round of Breezers or a split bill — it is
                    not the same number as the shelf price above. */}
                {(p.your_avg != null || p.last_had) && (
                  <p className="text-[10px] text-gray-400 mt-0.5">
                    {p.last_had && (
                      <>
                        Had on <span className="font-bold text-gray-500">{fmtDate(p.last_had)}</span>
                      </>
                    )}
                    {p.last_had && p.your_avg != null && ' · '}
                    {p.your_avg != null && (
                      <>
                        your {p.matched_favourite} nights average{' '}
                        <span className="font-bold text-gray-500">{INR(p.your_avg)}</span>
                      </>
                    )}
                  </p>
                )}

                <button
                  type="button"
                  onClick={() => setEditing(editing === `p${i}` ? null : `p${i}`)}
                  className="text-[10px] font-bold text-gray-400 hover:text-brand-600 mt-1"
                >
                  {editing === `p${i}` ? 'Close' : 'Wrong price? Fix it'}
                </button>

                {editing === `p${i}` && (
                  <PriceEditForm
                    state={result.state}
                    states={meta?.states ?? []}
                    initial={{
                      brand: p.brand, kind: p.kind, state: result.state,
                      size_ml: p.size_ml, price: p.total,
                      abv: p.abv, abv_known: p.abv_known,
                    }}
                    onCancel={() => setEditing(null)}
                    onDone={(saved) => {
                        setEditing(null)
                        loadMeta()
                        if (saved?.state && saved.state !== state) setState(saved.state)
                        run({ state: saved?.state })
                      }}
                  />
                )}

                {/* Same bottle across the NCR — these are a drive apart, and
                    the gap is often worth more than the drive. A hand-entered
                    price sits here like any other, and a region that has never
                    heard of the bottle shows a dash rather than the whole
                    strip vanishing. */}
                {p.compare?.some((c) => c.total !== null) && (
                  <div
                    className="grid gap-1 mt-2 pt-2 border-t border-amber-100"
                    style={{ gridTemplateColumns: `repeat(${p.compare.length}, minmax(0, 1fr))` }}
                  >
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

            {result.picks.length > TOP_N && (
              <button
                type="button"
                onClick={() => setShowAllPicks((v) => !v)}
                className="w-full card py-2 text-xs font-bold text-gray-500 hover:text-brand-600"
              >
                {showAllPicks
                  ? 'Show fewer'
                  : `Show ${result.picks.length - TOP_N} more in this range`}
              </button>
            )}

            {result.beers?.length > 0 && (
              <>
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                  Strongest first
                </p>
                {(showAllBeers ? result.beers : result.beers.slice(0, TOP_N)).map((b, i) => {
                  // The frontend and the API deploy separately, so there is
                  // always a window where one is ahead of the other. Beer used
                  // to be priced as a round (`total` for `qty` bottles) and is
                  // now priced per bottle, so both shapes are read here — an
                  // older API served a card full of "₹NaN" otherwise.
                  const unit = b.price ?? b.unit_price ??
                    (b.total != null && b.qty ? Math.round(b.total / b.qty) : null)
                  const buys = b.budget_buys ?? b.qty ?? null
                  const perHead = b.bottles_per_head ?? null
                  const roundCost = b.round_for_group ??
                    (unit != null ? Math.round(unit * (result.people || 1)) : null)
                  const pureAlcohol = b.alcohol_ml_per_bottle ?? null
                  return (
                  <div key={`${b.brand}-${b.size_ml}-${i}`} className="card p-3.5">
                    {/* The brand gets its own line and is allowed to wrap.
                        Sharing a row with the price and the ABV badge meant
                        the long names off the state lists were cut off mid
                        word, which is no use for telling two apart. */}
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-black text-gray-900 flex-1 min-w-0 break-words">
                        {b.brand}
                        {b.is_favourite && (
                          <span className="ml-1.5 text-[9px] font-bold text-brand-600 uppercase tracking-wider">
                            you buy this
                          </span>
                        )}
                      </p>
                      {/* One bottle. Leading with the price of a round was a
                          number nobody recognises. */}
                      <p className="text-sm font-black text-brand-600 flex-shrink-0">{INR(unit)}</p>
                    </div>

                    <p className="text-[11px] font-bold text-gray-700 mt-0.5">
                      1 bottle · {b.size_ml}ml
                      <span className="font-normal text-gray-400">
                        {' '}· {pct(b.abv, b.abv_known)}
                        {pureAlcohol != null && ` · ${pureAlcohol}ml pure alcohol`}
                      </span>
                    </p>

                    {/* What the budget does with that — a consequence of the
                        budget, not a property of the beer, so it sits apart. */}
                    {buys != null && (
                      <p className="text-[10px] text-gray-400 mt-0.5">
                        {INR(result.budget_max)} buys{' '}
                        <span className="font-bold text-gray-500">
                          {buys} {buys === 1 ? 'bottle' : 'bottles'}
                        </span>
                        {result.people > 1 && perHead != null && ` · ${perHead} each`}
                        {roundCost != null && <> · one each is {INR(roundCost)}</>}
                      </p>
                    )}

                    <button
                      type="button"
                      onClick={() => setEditing(editing === `b${i}` ? null : `b${i}`)}
                      className="text-[10px] font-bold text-gray-400 hover:text-brand-600 mt-1"
                    >
                      {editing === `b${i}` ? 'Close' : 'Wrong price? Fix it'}
                    </button>

                    {editing === `b${i}` && (
                      <PriceEditForm
                        state={result.state}
                        states={meta?.states ?? []}
                        initial={{
                          brand: b.brand, kind: 'beer', state: result.state,
                          size_ml: b.size_ml, price: unit,
                          abv: b.abv, abv_known: b.abv_known,
                        }}
                        onCancel={() => setEditing(null)}
                        onDone={(saved) => {
                        setEditing(null)
                        loadMeta()
                        if (saved?.state && saved.state !== state) setState(saved.state)
                        run({ state: saved?.state })
                      }}
                      />
                    )}
                  </div>
                  )
                })}

                {result.beers.length > TOP_N && (
                  <button
                    type="button"
                    onClick={() => setShowAllBeers((v) => !v)}
                    className="w-full card py-2 text-xs font-bold text-gray-500 hover:text-brand-600"
                  >
                    {showAllBeers
                      ? 'Show fewer'
                      : `Show ${result.beers.length - TOP_N} more beers`}
                  </button>
                )}
              </>
            )}

            {result.learned?.length > 0 && (
              <>
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest pt-2">
                  From what you actually buy
                </p>
                {/* Straight out of the knowledge base: every food and drink
                    expense is embedded, and these are the ones whose typical
                    spend lands in this budget. The figure is spend, not a
                    shelf price — one expense can be a round for six or a
                    single bottle, and nothing here can tell which. */}
                {result.learned.map((x) => (
                  <div key={x.label} className="card p-3.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-black text-gray-900 flex-1 min-w-0 break-words">
                        {x.label}
                        {x.matched_brand && (
                          <span className="ml-1.5 text-[9px] font-bold text-brand-600 uppercase tracking-wider">
                            in the price list
                          </span>
                        )}
                      </p>
                      <p className="text-sm font-black text-brand-600 flex-shrink-0">
                        {INR(x.avg_spend)}
                      </p>
                    </div>
                    <p className="text-[11px] font-bold text-gray-700 mt-0.5">
                      bought {x.times}{x.times === 1 ? ' time' : ' times'}
                      <span className="font-normal text-gray-400">
                        {' '}· you spent {INR(x.min_spend)}–{INR(x.max_spend)}
                      </span>
                    </p>
                    {x.last_had && (
                      <p className="text-[10px] text-gray-400 mt-0.5">
                        Last on <span className="font-bold text-gray-500">{fmtDate(x.last_had)}</span>
                      </p>
                    )}
                  </div>
                ))}
                <p className="text-[10px] text-gray-400 px-1">
                  Average spend on the occasions this came up — not a bottle
                  price, since an expense can cover a round.
                </p>
              </>
            )}

            {/* Everything typed in for this state. A price you entered and
                then couldn't find is the fastest way to stop trusting the
                feature, and there are honest reasons it can be filtered out —
                wrong size selected, outside the budget, saved as beer. Each
                one says which, rather than just not being there. */}
            {result.your_entries?.length > 0 && (
              <details className="card">
                {/* Folded away by default. It exists so a price you entered is
                    never silently missing, not to sit between you and the
                    recommendations on every search. */}
                <summary className="text-[10px] font-bold text-gray-400 uppercase tracking-widest cursor-pointer">
                  Prices you added · {result.state} ({result.your_entries.length})
                </summary>
                <div className="mt-1.5 space-y-1">
                  {result.your_entries.map((e) => (
                    <div key={e.id} className="flex items-baseline gap-2">
                      <span className={`text-[11px] flex-1 min-w-0 break-words ${
                        e.shown ? 'font-bold text-gray-700' : 'text-gray-500'
                      }`}>
                        {e.brand}
                        <span className="font-normal text-gray-400">
                          {' '}· {e.size_ml}ml · {e.kind}
                          {e.abv ? ` · ${e.abv}% ABV` : ''}
                          {e.added_on ? ` · added ${fmtDate(e.added_on)}` : ''}
                        </span>
                        {!e.shown && (
                          <span className="block text-[10px] text-amber-700">
                            {e.reason}
                          </span>
                        )}
                      </span>
                      <span className="text-[11px] font-black text-brand-600 flex-shrink-0">
                        {INR(e.price)}
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {/* A bottle we simply don't have. Offered next to the results
                rather than buried, because the moment you notice something is
                missing is the moment you're willing to type it in. */}
            <div className="card">
              {editing === 'new' ? (
                <PriceEditForm
                  state={result.state}
                  states={meta?.states ?? []}
                  initial={{ state: result.state, size_ml: result.bottle_ml || 750 }}
                  onCancel={() => setEditing(null)}
                  onDone={(saved) => {
                        setEditing(null)
                        loadMeta()
                        if (saved?.state && saved.state !== state) setState(saved.state)
                        run({ state: saved?.state })
                      }}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setEditing('new')}
                  className="text-xs font-bold text-gray-500 hover:text-brand-600"
                >
                  + Add a bottle or price we don&apos;t have
                </button>
              )}
            </div>

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
