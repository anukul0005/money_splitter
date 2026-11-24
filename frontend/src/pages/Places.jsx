import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getRecentGPlaces, searchGPlaces } from '../api'
import RecommendTabs from '../components/RecommendTabs'
import PlacesUsage from '../components/PlacesUsage'

const PRICE = (n) => (n == null ? '' : n === 0 ? 'Free' : '₹'.repeat(n))

// The last search, kept for coming back from a place's page
let lastSearch = null

/**
 * Recommend → Places: find any restaurant on Google (backend
 * routers/gplaces.py), with how often you've been. A search runs only on
 * Search / Enter - every one is a counted Google call, shown in the counter
 * on top, which everyone sees.
 */
export default function Places({ tab, setTab }) {
  const nav = useNavigate()
  const [q, setQ] = useState(lastSearch?.q || '')
  const [near, setNear] = useState(lastSearch?.near || null)
  const [nearBusy, setNearBusy] = useState(false)
  const [results, setResults] = useState(lastSearch?.results || null)
  const [fromCache, setFromCache] = useState(false)
  const [usage, setUsage] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [recent, setRecent] = useState(null)

  useEffect(() => { getRecentGPlaces().then((r) => setRecent(r.data)).catch(() => setRecent([])) }, [])

  const toggleNear = () => {
    if (near) return setNear(null)
    if (!navigator.geolocation) return setError("This browser can't share your location")
    setNearBusy(true)
    navigator.geolocation.getCurrentPosition(
      (p) => { setNear({ lat: p.coords.latitude, lon: p.coords.longitude }); setNearBusy(false); setError('') },
      () => { setNearBusy(false); setError('Location not shared - searching without it') },
      { timeout: 10000, maximumAge: 600000 })
  }

  const run = async (e) => {
    e?.preventDefault()
    const text = q.trim()
    if (text.length < 2) return setError('Type at least 2 letters')
    setBusy(true); setError('')
    try {
      const r = await searchGPlaces(text, near)
      setResults(r.data.results); setFromCache(r.data.from_cache); setUsage(r.data.usage)
      lastSearch = { q: text, near, results: r.data.results }
    } catch (err) {
      setError(err.response?.data?.detail || 'Search failed - try again')
    } finally { setBusy(false) }
  }

  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <h1 className="text-xl font-black tracking-tight">Places</h1>
        <p className="text-xs text-gray-400 mt-1">Any restaurant on Google, and what you've had there</p>
        <RecommendTabs tab={tab} setTab={setTab} />
      </div>

      <div className="px-5 mt-4 space-y-4 max-w-2xl">
        <PlacesUsage usage={usage} />

        <form onSubmit={run} className="space-y-2">
          <div className="flex gap-2">
            <input className="input flex-1 min-w-0" placeholder="e.g. Haldiram's Sector 18 Noida" value={q}
              onChange={(e) => setQ(e.target.value)} autoComplete="off" enterKeyHint="search" />
            <button type="submit" disabled={busy} className="btn-primary !w-auto px-5 shrink-0">{busy ? '…' : 'Search'}</button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={toggleNear}
              className={`px-2.5 py-1 text-[11px] font-bold border ${near ? 'bg-brand-500 text-white border-brand-500' : 'bg-amber-50 text-gray-600 border-amber-200'}`}>
              {nearBusy ? 'Finding you…' : near ? '✓ Near me' : 'Near me'}
            </button>
            <p className="text-[10px] text-gray-400 text-right">Add the area or city for a sharper match</p>
          </div>
        </form>

        {error && <p className="text-sm text-red-600">{error}</p>}

        {results && (
          <div className="space-y-2">
            <p className="text-[11px] text-gray-400">
              {results.length ? `${results.length} found` : 'Nothing found - try adding the area or city'}
              {fromCache && results.length ? ' · saved result, no Google call' : ''}
            </p>
            {results.map((p) => (
              <button key={p.place_id} onClick={() => nav(`/places/${encodeURIComponent(p.place_id)}`)}
                className="card w-full text-left flex items-start justify-between gap-3 active:scale-[0.99] transition-transform">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-gray-900 break-words">{p.name}</p>
                  <p className="text-[11px] text-gray-500 mt-0.5 break-words">{p.address}</p>
                  {p.type && <p className="text-[10px] text-gray-400 mt-0.5">{p.type}</p>}
                </div>
                <div className="text-right shrink-0">
                  {p.my_visits > 0
                    ? <span className="inline-block px-2 py-0.5 text-[10px] font-black bg-brand-50 text-brand-600 border border-brand-300">Been {p.my_visits}×</span>
                    : <span className="text-[10px] text-gray-400">New to you</span>}
                  <p className="text-brand-500 text-lg font-bold leading-none mt-1">›</p>
                </div>
              </button>
            ))}
          </div>
        )}

        {!results && recent?.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Looked up lately</p>
            {recent.map((p) => (
              <button key={p.place_id} onClick={() => nav(`/places/${encodeURIComponent(p.place_id)}`)}
                className="card w-full text-left flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-gray-900 break-words">{p.name}</p>
                  <p className="text-[11px] text-gray-500 mt-0.5 truncate">{p.address}</p>
                </div>
                <p className="text-xs text-gray-600 shrink-0">
                  {p.rating ? `★ ${p.rating}` : ''}{p.price_level != null ? ` · ${PRICE(p.price_level)}` : ''}
                </p>
              </button>
            ))}
            <p className="text-[10px] text-gray-400">Opening these again is free - they're saved.</p>
          </div>
        )}

        <button onClick={() => nav('/food/places')} className="card w-full text-left flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Places I've eaten at</p>
            <p className="text-[11px] text-gray-500 mt-0.5">Every place from your expenses, no Google needed</p>
          </div>
          <span className="text-brand-500 text-lg font-bold">›</span>
        </button>
      </div>
    </div>
  )
}
