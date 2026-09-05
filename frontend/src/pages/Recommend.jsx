import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getRecommendMeta, getRecommendation, getFriends, searchRecommend, listBrands } from '../api'

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

// The four base spirits. Wine, brandy, tequila and liqueur are real
// categories in the data but not ones most evenings are planned around, so
// they have no card here - leaving all four off still shows everything,
// same rule as the size picker.
const KINDS = ['whisky', 'rum', 'vodka', 'gin']

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
// Was 6000, picked with no reference to the actual data - 463 real bottles
// across the five states price above that, up to premium single malts and
// cognacs several states publish (a few rare ones run into lakhs). 15000
// covers the 97th percentile of every published price; dragging the slider
// still can't reach the very top of the market, but a bottle priced there is
// always reachable through the search box, which has no budget cap at all.
const BUDGET_MAX = 15000
const BUDGET_STEP = 10
// Dragging the top thumb all the way to BUDGET_MAX means "and up," not "and
// stop at 15000" - a real bottle can run into the lakhs (the priciest on
// record is well past ₹12 lakh), and the slider has no way to dial in an
// exact ceiling that high. Sent to the server as this stand-in for
// "no ceiling" rather than actually being unbounded, so it stays a plain
// number the API and the budget-buys math both already know how to use.
const BUDGET_UNCAPPED = 100_000_000
// How a budget_max is actually shown - "₹15,000+" once it's pinned at the
// slider's top (locally) or come back as the uncapped stand-in (from the
// server), instead of a number nobody dragged to on purpose.
const fmtBudgetMax = (v) => (v >= BUDGET_MAX ? `${INR(BUDGET_MAX)}+` : INR(v))

const pct = (v, known) => `${known ? '' : '~'}${v}% ABV`

/**
 * The same bottle priced across every state we have a list for.
 *
 * Alcohol is taxed per state, so the same bottle genuinely differs by hundreds
 * of rupees across a border people cross anyway. A state that has never heard
 * of the bottle shows a dash — never a price carried over from somewhere else.
 *
 * Shared by the spirit and beer cards. Beer went without one for no better
 * reason than that it was added later, which is where the gap is most worth
 * seeing: a crate is worth a drive in a way one bottle of whisky is not.
 */
function PriceStrip({ compare, cheapest }) {
  if (!compare?.some((c) => c.total !== null)) return null
  return (
    <div
      className="grid gap-1 mt-2 pt-2 border-t border-amber-100"
      style={{ gridTemplateColumns: `repeat(${compare.length}, minmax(0, 1fr))` }}
    >
      {compare.map((c) => {
        const best = c.region === cheapest && c.total !== null
        return (
          <div
            key={c.region}
            title={c.region}
            className={`rounded px-1 py-1 text-center ${
              best ? 'bg-green-50 border border-green-200' : 'bg-amber-50/60'
            }`}
          >
            <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wide truncate">
              {c.label || c.region.replace(' (Haryana)', '')}
            </p>
            <p className={`text-[11px] font-black ${best ? 'text-green-700' : 'text-gray-500'}`}>
              {c.total === null ? '—' : INR(c.total)}
            </p>
          </div>
        )
      })}
    </div>
  )
}

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
  // Any combination of the four cards. An empty list is the default and is
  // sent as "any": a filter that is simply off says "everything" with one less
  // button than an Any card would. Tapping a chosen card turns it back off.
  //
  // This was a single value, which made "a couple of quarters or some beer" —
  // an ordinary way to plan an evening — impossible to ask for.
  const [bottles, setBottles] = useState([])
  // Same "off means everything" rule as bottles: any of whisky/rum/vodka/gin,
  // none picked shows every kind the state has.
  const [kinds, setKinds] = useState([])
  const [showAllPicks, setShowAllPicks] = useState(false)
  const [showAllBeers, setShowAllBeers] = useState(false)
  const [withWho, setWithWho] = useState([])
  const [result, setResult]   = useState(null)
  const [error, setError]     = useState('')
  const [busy, setBusy]       = useState(false)
  // Finding a specific bottle is a different question from being recommended
  // one, so it has its own box and its own result list rather than trying to
  // fold "search" into the budget-ranked picks above.
  const [query, setQuery]         = useState('')
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [searchResult, setSearchResult] = useState(null)
  // Independent of the main State field above. That one has to be one
  // specific state, because alcohol pricing genuinely is state-specific and
  // "what should I buy" has no sane answer without knowing where. "Does
  // anyone sell this at all" has no such natural default, so this starts on
  // every state at once - '' means all, matching what the server does with
  // an empty state.
  const [searchState, setSearchState] = useState('')
  // Every brand the searched state(s) already know, so typing "j" offers
  // Johnnie Walker before you finish the word rather than after you search
  // for it and get nothing back.
  const [brandOptions, setBrandOptions] = useState([])
  // Whether the suggestion dropdown is open. Closed on blur and on picking
  // one; reopened by typing, so it doesn't linger over the results below it.
  const [showSuggestions, setShowSuggestions] = useState(false)
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

  // Re-fetched whenever the searched state changes, since Delhi's list and
  // Gurugram's are entirely different catalogues - and the server already
  // treats an empty state as "every brand, every state", so this needs no
  // special case for the default "All states" setting. A failed fetch just
  // leaves search without suggestions rather than breaking it - typing and
  // pressing Search still works either way.
  useEffect(() => {
    listBrands(searchState).then((r) => setBrandOptions(r.data)).catch(() => setBrandOptions([]))
  }, [searchState])

  const peopleN = Math.max(1, parseInt(people, 10) || 0)
  // The bottle sizes among the picked cards, beer excluded — beer has no one
  // size to divide between people.
  const sizesPicked = bottles.filter((b) => b !== 'beer').map(Number)
  const loN = budgetMin
  const hiN = budgetMax
  const canRun = state && peopleN >= 1 && hiN - loN >= MIN_SPAN
  const canSearch = query.trim().length >= 2

  // Suggestions as you type, from the same brand list the price-edit form
  // already fetches per state - filtered here, in the app, rather than left
  // to a browser's native <datalist>. That looked right on a desktop
  // browser and was actually the phone's own keyboard predictive-text bar on
  // iOS, not a dropdown - "S" produced three keyboard-bar guesses and no way
  // to tap one into the box. A name starting with what was typed comes
  // first, then anywhere it appears, both case-insensitive; capped at eight
  // so the list never grows past a thumb's reach.
  const qLower = query.trim().toLowerCase()
  const suggestions = qLower.length === 0 ? [] : brandOptions
    .filter((b) => b.brand.toLowerCase().includes(qLower))
    .sort((a, b) => {
      const aStarts = a.brand.toLowerCase().startsWith(qLower)
      const bStarts = b.brand.toLowerCase().startsWith(qLower)
      if (aStarts !== bStarts) return aStarts ? -1 : 1
      return a.brand.length - b.brand.length
    })
    .slice(0, 8)

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
        people: peopleN, budget_min: loN,
        budget_max: hiN >= BUDGET_MAX ? BUDGET_UNCAPPED : hiN,
        bottle: bottles.length ? bottles.join(',') : 'any',
        kind: kinds.join(','),
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

  // The size and kind cards are shared with the recommender, but the state
  // is search's own - see searchState above - and defaults to every state
  // rather than whatever the recommender's dropdown happens to show.
  // Budget is left out on purpose: "what does Vat 69 cost" has no budget
  // attached to it, unlike "what should I buy".
  const runSearch = async (over = {}) => {
    // Picking a suggestion passes the brand straight through rather than
    // relying on the query box's state, which setQuery() just started
    // updating but hasn't actually applied yet in this same tick.
    const q = (over.q ?? query).trim()
    if (q.length < 2) { setSearchError('Type at least 2 letters to search'); return }
    setSearchError(''); setSearchBusy(true)
    try {
      const r = await searchRecommend({
        state: over.state ?? searchState, q,
        bottle: bottles.length ? bottles.join(',') : 'any',
        kind: kinds.join(','),
      })
      setSearchResult(r.data)
    } catch (err) {
      setSearchError(
        err.response?.data?.detail || `Could not search (${err.response?.status || 'network error'}).`
      )
      setSearchResult(null)
    } finally { setSearchBusy(false) }
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
              Every pick also shows what the same bottle costs in the other
              states we have lists for.
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
                {INR(loN)} – {fmtBudgetMax(hiN)}
              </p>
              <p className="text-[10px] text-gray-400">
                {INR(Math.round(loN / peopleN))}–{INR(Math.round(hiN / peopleN))}{hiN >= BUDGET_MAX && '+'} a head
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
                  aria-pressed={bottles.includes(v)}
                  onClick={() => setBottles((cur) => (
                    cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]
                  ))}
                  className={`rounded-md px-2 py-1.5 text-xs font-bold border transition-all ${
                    bottles.includes(v)
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
                each once it's shared out. Only said for a single size, since
                two sizes at once have no one answer. */}
            <p className="text-[10px] text-gray-400 mt-1">
              {bottles.length === 0
                ? 'Nothing picked — every size and beer, whatever the budget covers. Tap any you fancy, tap again to clear.'
                : sizesPicked.length === 1 && bottles.length === 1
                  ? `${sizesPicked[0]}ml between ${peopleN} ${peopleN === 1 ? 'person' : 'people'} · ${Math.round(sizesPicked[0] / peopleN)}ml each.`
                  : `Showing ${bottles.length} at once — ${bottles.length} of the four, whatever the budget covers.`}
            </p>
          </div>

          <div>
            <label className="label">What kind (optional)</label>
            <div className="grid grid-cols-4 gap-2">
              {KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kinds.includes(k)}
                  onClick={() => setKinds((cur) => (
                    cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]
                  ))}
                  className={`rounded-md px-2 py-1.5 text-xs font-bold border capitalize transition-all ${
                    kinds.includes(k)
                      ? 'bg-brand-400 border-brand-400 text-white'
                      : 'bg-cream border-amber-200 text-gray-500 hover:bg-amber-50'
                  }`}
                >
                  {k}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-gray-400 mt-1">
              {kinds.length === 0
                ? 'Nothing picked — whisky, rum, vodka and gin all show. Tap any you fancy, tap again to clear.'
                : `Only ${kinds.join(', ')} — beer is unaffected by this.`}
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
              initial={{ state, size_ml: sizesPicked[0] || 750 }}
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

        {/* Checking a specific brand rather than browsing for one - a
            different question from the budget-ranked picks below, so it gets
            its own box and its own results rather than being folded in. */}
        <div className="card space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label className="label mb-0">Search a bottle</label>
            {/* Its own state, defaulting to every state at once - see
                searchState. Independent of the State field above, which has
                to pick one specific state for the recommender to make sense
                at all. */}
            <select
              className="input text-xs py-1 w-auto max-w-[45%]"
              value={searchState}
              onChange={(e) => setSearchState(e.target.value)}
            >
              <option value="">All states</option>
              {(meta?.states ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          {/* A magnifying glass inside the field rather than a label above it
              plus a button beside it - one large, obvious box to type into,
              the same shape a phone's own search fields use. The icon is
              also the submit button, so there's nothing else to tap. */}
          <div className="relative">
            <button
              type="button" onClick={runSearch}
              disabled={searchBusy || !canSearch}
              aria-label="Search"
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 disabled:opacity-40"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.2" y2="16.2" />
              </svg>
            </button>
            <input
              // Text stays small, matching the suggestion rows below it - a
              // large placeholder read as a heading, not a field to type
              // into. The box itself stays large and tappable (padding, not
              // font size, is what makes a search field feel roomy).
              className="input text-sm pl-10 py-3" value={query}
              placeholder="Search a bottle — e.g. Vat 69, Old Monk, Kingfisher"
              onChange={(e) => { setQuery(e.target.value); setShowSuggestions(true) }}
              onFocus={() => setShowSuggestions(true)}
              // A plain onBlur would fire before a click on a suggestion
              // registers, closing the list out from under the tap. Delayed
              // just long enough for that click to land first.
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              onKeyDown={(e) => { if (e.key === 'Enter') { setShowSuggestions(false); runSearch() } }}
            />

            {/* An in-app dropdown, not the browser's own <datalist> - that
                rendered as the phone's keyboard predictive-text bar on iOS
                instead of a list under the field, with no way to tap an
                option into the box. This is styled and positioned like the
                rest of the page, and sits right under the field the way a
                search suggestion list does on any site with a lot of things
                to search through. */}
            {showSuggestions && suggestions.length > 0 && (
              <ul className="absolute left-0 right-0 top-full mt-1 z-20 bg-white border border-amber-200 rounded-md shadow-lg overflow-hidden">
                {suggestions.map((b) => (
                  <li key={b.brand}>
                    <button
                      type="button"
                      // Fires before the input's onBlur, so the tap lands
                      // before the dropdown has a chance to close itself.
                      onMouseDown={() => {
                        setQuery(b.brand)
                        setShowSuggestions(false)
                        runSearch({ q: b.brand })
                      }}
                      className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-amber-50 border-b border-amber-50 last:border-0"
                    >
                      {b.brand}
                      <span className="text-gray-400 font-normal"> · {b.kind}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-[10px] text-gray-400 pl-1">
            {searchState ? `Searches ${searchState}` : 'Searches every state'} with whatever kind cards are ticked above, any size — budget is not applied here.
          </p>

          {searchError && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{searchError}</p>
          )}

          {searchResult && (
            <div className="space-y-2 pt-1">
              {searchResult.results.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-3">
                  Nothing called &quot;{searchResult.q}&quot; found{' '}
                  {searchResult.is_all ? 'in any state' : `in ${searchResult.state}`} with these filters.
                </p>
              ) : (
                <>
                  {searchResult.results.map((r, i) => (
                    <div key={`${r.brand}-${r.size_ml}-${r.state}-${i}`} className="rounded-md border border-amber-100 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-black text-gray-900 flex-1 min-w-0 break-words">{r.brand}</p>
                        <p className="text-sm font-black text-brand-600 flex-shrink-0">{INR(r.price)}</p>
                      </div>
                      <p className="text-[11px] font-bold text-gray-700 mt-0.5">
                        {r.size_name ? `1 ${r.size_name} · ` : ''}{r.size_ml}ml
                        <span className="font-normal text-gray-400">
                          {' '}· {r.kind} · {pct(r.abv, r.abv_known)}
                          {/* Only worth saying in "All states" mode, where the
                              same search can turn up several states at once
                              and the price on the card is otherwise ambiguous
                              about where it applies. */}
                          {searchResult.is_all && <> · <span className="font-bold">{r.state}</span></>}
                        </span>
                      </p>
                      <PriceStrip compare={r.compare} cheapest={r.cheapest_region} />

                      <button
                        type="button"
                        onClick={() => setEditing(editing === `s${i}` ? null : `s${i}`)}
                        className="text-[10px] font-bold text-gray-400 hover:text-brand-600 mt-1"
                      >
                        {editing === `s${i}` ? 'Close' : 'Wrong price? Fix it'}
                      </button>

                      {editing === `s${i}` && (
                        <PriceEditForm
                          state={r.state}
                          states={meta?.states ?? []}
                          initial={{
                            brand: r.brand, kind: r.kind, state: r.state,
                            size_ml: r.size_ml, price: r.price,
                            abv: r.abv, abv_known: r.abv_known,
                          }}
                          onCancel={() => setEditing(null)}
                          onDone={() => {
                            setEditing(null)
                            loadMeta()
                            // Re-run with whatever searchState already is,
                            // "All states" included - narrowing to just the
                            // edited row's state would silently drop out of
                            // All mode every time a price got fixed.
                            runSearch()
                          }}
                        />
                      )}
                    </div>
                  ))}
                  {searchResult.truncated && (
                    <p className="text-[10px] text-gray-400 text-center">
                      Showing the closest {searchResult.results.length} matches — narrow the search to see more precisely.
                    </p>
                  )}
                </>
              )}
            </div>
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
                  bottles, when it means one 375ml bottle. The server names
                  what was asked for, which with several cards picked is more
                  than one thing. */}
              {result.bottle_name || 'any size'} · {result.people} people ·{' '}
              {INR(result.budget_min)}–{fmtBudgetMax(result.budget_max)}
            </p>

            {result.picks.length === 0 && result.beers.length === 0 && (
              <div className="card text-center py-6">
                <p className="text-sm text-gray-400">
                  {!result.size_available
                    ? `No ${result.bottle_name} prices published for ${result.state} yet.`
                    : `Nothing in ${result.bottle_name} in ${result.state} falls between ${INR(result.budget_min)} and ${fmtBudgetMax(result.budget_max)}.`}
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

                <PriceStrip compare={p.compare} cheapest={p.cheapest_region} />
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
                        {fmtBudgetMax(result.budget_max)} buys{' '}
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

                    {/* Beer now gets the same side-by-side the spirits have. */}
                    <PriceStrip compare={b.compare} cheapest={b.cheapest_region} />
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
