import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getMyPlaces, getMyPlaceVisits } from '../api'
import Dropdown from '../components/Dropdown'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const fmtDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '')
const SORTS = [
  { value: 'visits', label: 'Most visited' },
  { value: 'recent', label: 'Most recent' },
  { value: 'dear', label: 'Costliest per person' },
  { value: 'cheap', label: 'Cheapest per person' },
]

function Place({ p, nav }) {
  const [open, setOpen] = useState(false)
  const [visits, setVisits] = useState(null)
  const toggle = () => {
    setOpen((o) => !o)
    if (!visits) getMyPlaceVisits(p.name).then((r) => setVisits(r.data)).catch(() => setVisits([]))
  }
  return (
    <div className="card">
      <button onClick={toggle} className="w-full text-left flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-gray-900 break-words">
            {p.name}
            {p.in_price_list && <span className="ml-1.5 text-[9px] font-bold text-brand-600 uppercase tracking-wider">in the price list</span>}
          </p>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {p.visits} visit{p.visits === 1 ? '' : 's'}{p.last_visit ? ` · last ${fmtDate(p.last_visit)}` : ''}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-black text-brand-600">{INR(p.avg_per_head)}</p>
          <p className="text-[10px] text-gray-400">per person{p.avg_bill !== p.avg_per_head ? ` · bill ${INR(p.avg_bill)}` : ''}</p>
        </div>
      </button>
      {open && (
        <div className="mt-3 pt-2 border-t border-amber-100 space-y-1.5">
          {visits === null && <p className="text-[11px] text-gray-400">Loading visits…</p>}
          {visits?.map((v) => (
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
        </div>
      )}
    </div>
  )
}

/**
 * /food/places - every restaurant, stall and cafe you've paid at, read from
 * your expenses (backend /food/my-places): visits, average per person and
 * per bill, last visit; tap one for each visit. Opened from Where to eat.
 */
export default function MyPlaces() {
  const nav = useNavigate()
  const [places, setPlaces] = useState(null)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('visits')
  useEffect(() => { getMyPlaces().then((r) => setPlaces(r.data)).catch(() => setError('Could not load your places.')) }, [])

  const shown = (places || [])
    .filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => sort === 'recent' ? (b.last_visit || '').localeCompare(a.last_visit || '')
      : sort === 'dear' ? b.avg_per_head - a.avg_per_head
      : sort === 'cheap' ? a.avg_per_head - b.avg_per_head
      : b.visits - a.visits)
  const totalVisits = (places || []).reduce((s, p) => s + p.visits, 0)

  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Where to eat</button>
        <h1 className="text-xl font-black tracking-tight">Places I've eaten at</h1>
        <p className="text-xs text-gray-400 mt-1">
          {places ? `${places.length} places · ${totalVisits} visits, from your expenses` : 'From your expenses'}
        </p>
        {places && places.length > 0 && (
          <div className="flex gap-2 mt-3">
            <input className="input text-sm flex-1 min-w-0" placeholder="Search a place" value={q}
              onChange={(e) => setQ(e.target.value)} autoComplete="off" />
            <Dropdown className="w-44" size="sm" value={sort} onChange={setSort} options={SORTS} />
          </div>
        )}
      </div>

      <div className="px-5 mt-4 space-y-3 max-w-2xl">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!places && !error && <p className="text-xs text-gray-400 text-center py-10">Loading…</p>}
        {places?.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-10">
            No places yet. Add a food expense with the restaurant's name in its description and it shows up here.
          </p>
        )}
        {places?.length > 0 && shown.length === 0 && <p className="text-sm text-gray-400 text-center py-6">No place matches “{q}”.</p>}
        {shown.map((p) => <Place key={p.name} p={p} nav={nav} />)}
        {places?.length > 0 && (
          <p className="text-[10px] text-gray-400 text-center pt-2">
            Averages from what you actually paid. Names are read from your expense descriptions, and new food expenses add to this on their own.
          </p>
        )}
      </div>
    </div>
  )
}
