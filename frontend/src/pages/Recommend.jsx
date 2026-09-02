import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getRecommendMeta, getRecommendation, getFriends } from '../api'
import LoadingSpinner from '../components/LoadingSpinner'
import { useUser } from '../UserContext'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

const STRENGTHS = [
  ['light',  'Light',  '~120ml each'],
  ['normal', 'Normal', '~180ml each'],
  ['heavy',  'Heavy',  '~260ml each'],
]

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
  const [people, setPeople]   = useState(2)
  const [budget, setBudget]   = useState(2000)
  const [strength, setStrength] = useState('normal')
  const [withWho, setWithWho] = useState([])
  const [result, setResult]   = useState(null)
  const [error, setError]     = useState('')
  const [busy, setBusy]       = useState(false)

  useEffect(() => {
    Promise.all([getRecommendMeta(), getFriends(user?.name)])
      .then(([m, f]) => {
        setMeta(m.data)
        setState(m.data.states[0] || '')
        setFriends(f.data.map((x) => x.name))
      })
      .catch(() => setError('Could not load the price data.'))
  }, [user?.name])

  // People in the room = you + everyone picked, unless you override the count
  const toggle = (n) => setWithWho((w) => {
    const next = w.includes(n) ? w.filter((x) => x !== n) : [...w, n]
    setPeople(next.length + 1)
    return next
  })

  const run = async () => {
    setError(''); setBusy(true)
    try {
      const r = await getRecommendation({
        state, people, budget, strength, names: withWho.join(','),
      })
      setResult(r.data)
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not work that out.')
      setResult(null)
    } finally { setBusy(false) }
  }

  if (!meta && !error) return <LoadingSpinner />

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
                value={people}
                onChange={(e) => setPeople(parseInt(e.target.value || '1', 10))}
              />
            </div>
            <div>
              <label className="label">Budget (₹)</label>
              <input
                className="input font-bold" type="number" min="100" step="100"
                value={budget}
                onChange={(e) => setBudget(parseFloat(e.target.value || '0'))}
              />
            </div>
          </div>

          <div>
            <label className="label">How heavy a night</label>
            <div className="flex gap-2">
              {STRENGTHS.map(([v, label, hint]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setStrength(v)}
                  className={`flex-1 rounded-md px-2 py-1.5 text-xs font-bold border transition-all ${
                    strength === v
                      ? 'bg-brand-400 border-brand-400 text-white'
                      : 'bg-cream border-amber-200 text-gray-500 hover:bg-amber-50'
                  }`}
                >
                  {label}
                  <span className="block text-[9px] font-normal opacity-70">{hint}</span>
                </button>
              ))}
            </div>
          </div>

          <button onClick={run} className="btn-primary" disabled={busy || !state}>
            {busy ? 'Working it out…' : 'Recommend'}
          </button>
        </div>

        {error && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>
        )}

        {/* What you've actually done before — the part no generic app can do */}
        {hist?.occasions > 0 && (
          <div className="card">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Your history</p>
            <p className="text-sm font-bold text-gray-900 mt-1">
              {hist.occasions} sessions together · {INR(hist.avg_per_occasion)} average
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
              {result.people} people · {INR(result.budget)} · {INR(result.budget_per_head)} a head
            </p>

            {result.picks.length === 0 && (
              <div className="card text-center py-6">
                <p className="text-sm text-gray-400">Nothing in {result.state} fits that budget.</p>
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
                  <p className="text-sm font-black text-brand-600 flex-shrink-0">{INR(p.total)}</p>
                </div>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  {p.qty} × {p.size_ml}ml {p.kind} ·{' '}
                  {p.unit_price_max && p.unit_price_max !== p.unit_price
                    ? `${INR(p.unit_price)}–${INR(p.unit_price_max)}`
                    : INR(p.unit_price)} each
                </p>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  {INR(p.per_head)} a head · {p.total_ml}ml total
                </p>
              </div>
            ))}

            {result.beer_option && (
              <div className="card p-3.5 flex items-baseline gap-2">
                <p className="text-sm font-bold text-gray-700 flex-1">
                  or {result.beer_option.qty} × {result.beer_option.brand}
                  <span className="text-[11px] text-gray-400 font-normal">
                    {' '}({result.beer_option.size_ml}ml)
                  </span>
                </p>
                <p className="text-sm font-black text-gray-700">{INR(result.beer_option.total)}</p>
              </div>
            )}

            {/* Say plainly where the numbers came from and how stale they are */}
            <details className="card">
              <summary className="text-[11px] font-bold text-gray-500 cursor-pointer">
                Where these prices come from
              </summary>
              <p className="text-[10px] text-gray-500 leading-relaxed mt-2">
                Alcohol is a state subject in India, so every state sets its own MRP.
                These are scraped from public listings of state price lists and are
                indicative — shops vary and excise years change them.
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
