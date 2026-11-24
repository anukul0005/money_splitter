import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getGPlace } from '../api'
import LoadingSpinner from '../components/LoadingSpinner'
import PlacesUsage from '../components/PlacesUsage'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const fmtDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '')
const PRICE = ['Free', 'Inexpensive', 'Moderate', 'Expensive', 'Very expensive']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * /places/:pid - one Google place (backend routers/gplaces.py /place):
 * rating, price, hours, contact, and your own visits there - how often,
 * what it cost you, what you ordered. Details are saved for two weeks, so
 * opening a place again costs no Google call.
 */
export default function PlaceDetail() {
  const { pid } = useParams()
  const nav = useNavigate()
  const [p, setP] = useState(null)
  const [error, setError] = useState('')
  const [showHours, setShowHours] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const load = (refresh) => getGPlace(pid, refresh).then((r) => setP(r.data))
    .catch((e) => setError(e.response?.data?.detail || 'Could not load this place'))
  useEffect(() => { load(false) }, [pid])

  if (error && !p) return (
    <div className="px-5 pt-10">
      <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Places</button>
      <p className="text-sm text-red-600">{error}</p>
    </div>
  )
  if (!p) return <LoadingSpinner />

  const h = p.history || { visits: 0 }
  const today = DAYS[new Date().getDay()]
  const todayHours = (p.hours || []).find((x) => x.startsWith(today))
  const visits = showAll ? h.list || [] : (h.list || []).slice(0, 5)
  const fetched = p.fetched_at ? new Date(p.fetched_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : ''

  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Places</button>
        <h1 className="text-xl font-black tracking-tight break-words">{p.name}</h1>
        <p className="text-xs text-gray-500 mt-1 break-words">{p.address}</p>
      </div>

      <div className="px-5 mt-4 space-y-4 max-w-2xl">
        {/* Google's side */}
        <div className="card space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {p.rating != null && (
              <span className="text-lg font-black text-gray-900">★ {p.rating}
                <span className="text-[11px] font-normal text-gray-500"> ({Number(p.ratings || 0).toLocaleString('en-IN')} ratings)</span>
              </span>
            )}
            {p.price_level != null && <span className="text-xs font-bold text-gray-600">{'₹'.repeat(Math.max(p.price_level, 1))} · {PRICE[p.price_level]}</span>}
            {p.type && <span className="text-xs text-gray-500">{p.type}</span>}
          </div>
          {(p.open_now != null || todayHours) && (
            <p className="text-xs">
              {p.open_now === true && <span className="font-bold text-green-700">Open now · </span>}
              {p.open_now === false && <span className="font-bold text-red-600">Closed now · </span>}
              <span className="text-gray-600">{todayHours ? `Today ${todayHours.slice(today.length + 1).trim()}` : ''}</span>
            </p>
          )}
          {p.hours?.length > 0 && (
            <div>
              <button onClick={() => setShowHours((s) => !s)} className="text-[11px] font-bold text-brand-600">
                {showHours ? 'Hide hours' : 'All hours'}
              </button>
              {showHours && (
                <ul className="mt-1 space-y-0.5">
                  {p.hours.map((x) => <li key={x} className={`text-[11px] ${x.startsWith(today) ? 'font-bold text-gray-900' : 'text-gray-600'}`}>{x}</li>)}
                </ul>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            {p.maps_url && <a href={p.maps_url} target="_blank" rel="noreferrer" className="px-3 py-1.5 text-xs font-bold bg-brand-500 text-white">Open in Maps</a>}
            {p.phone && <a href={`tel:${p.phone.replace(/\s/g, '')}`} className="px-3 py-1.5 text-xs font-bold border border-amber-200 bg-amber-50 text-gray-700">Call {p.phone}</a>}
            {p.website && <a href={p.website} target="_blank" rel="noreferrer" className="px-3 py-1.5 text-xs font-bold border border-amber-200 bg-amber-50 text-gray-700">Website</a>}
          </div>
          <p className="text-[10px] text-gray-400">
            From Google{fetched ? `, ${fetched}` : ''}{p.from_cache ? ' · saved copy, no Google call' : ''}
            {' · '}
            <button disabled={refreshing} onClick={() => { setRefreshing(true); load(true).finally(() => setRefreshing(false)) }}
              className="font-bold text-brand-600">{refreshing ? 'Refreshing…' : 'Refresh'}</button>
          </p>
        </div>

        {/* Yours */}
        <div className="card">
          <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">You here</p>
          {h.visits === 0 ? (
            <p className="text-sm text-gray-500 mt-1">No visits in your expenses yet. Add one with the place's name in the description and it shows here.</p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2 mt-2">
                <div><p className="text-lg font-black text-gray-900">{h.visits}×</p><p className="text-[10px] text-gray-500">visits</p></div>
                <div><p className="text-lg font-black text-brand-600">{INR(h.avg_per_head)}</p><p className="text-[10px] text-gray-500">avg per person</p></div>
                <div><p className="text-lg font-black text-gray-900">{INR(h.spent_share)}</p><p className="text-[10px] text-gray-500">your share, all visits</p></div>
              </div>
              <p className="text-[11px] text-gray-500 mt-2">
                Last {fmtDate(h.last_visit)}{h.first_visit && h.first_visit !== h.last_visit ? ` · first ${fmtDate(h.first_visit)}` : ''} · avg bill {INR(h.avg_bill)}
              </p>

              {h.ordered?.length > 0 && (
                <div className="mt-3">
                  <p className="text-[11px] font-bold text-gray-700">What you've ordered</p>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {h.ordered.map((o) => (
                      <span key={o.item} className="px-2 py-0.5 text-[11px] bg-amber-50 border border-amber-200 text-gray-700">
                        {o.item}{o.times > 1 ? <b className="text-gray-900"> ×{o.times}</b> : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-3 pt-2 border-t border-amber-100 space-y-1.5">
                {visits.map((v) => (
                  <button key={v.id} onClick={() => nav(`/groups/${v.group_id}`)} className="w-full text-left flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs text-gray-800 break-words">{v.title || 'No description'}</p>
                      <p className="text-[10px] text-gray-400">{fmtDate(v.date)} · {v.group}</p>
                    </div>
                    <p className="text-xs font-bold text-gray-900 shrink-0">
                      {INR(v.amount)}{v.per_head !== v.amount && <span className="font-normal text-gray-400"> · {INR(v.per_head)} each</span>}
                    </p>
                  </button>
                ))}
                {(h.list?.length || 0) > 5 && (
                  <button onClick={() => setShowAll((s) => !s)} className="text-[11px] font-bold text-brand-600">
                    {showAll ? 'Show fewer' : `All ${h.list.length} visits`}
                  </button>
                )}
              </div>
              <p className="text-[10px] text-gray-400 mt-2">Matched by name across your expenses, so it covers every branch.</p>
            </>
          )}
        </div>

        <PlacesUsage usage={p.usage} />
      </div>
    </div>
  )
}
