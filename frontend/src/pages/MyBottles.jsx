import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getMyBottles, getBottlePurchases } from '../api'
import Dropdown from '../components/Dropdown'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const fmtDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '')
const SORTS = [
  { value: 'times', label: 'Most bought' },
  { value: 'recent', label: 'Most recent' },
  { value: 'dear', label: 'Costliest' },
  { value: 'cheap', label: 'Cheapest' },
]
// "half · 375 ml" - whichever of the two the expense gave.
const sizeText = (b) => [b.size, b.size_ml && !(b.size || '').includes('ml') ? `${b.size_ml} ml` : null].filter(Boolean).join(' · ')
// What the purchases endpoint groups by - the same as the list's own key.
const sizeKey = (b) => String(b.size_ml || b.size || '')

/** One size of a brand ("half · 375 ml"): times, average price; tap for each purchase. */
function SizeRow({ s, nav, single }) {
  const [open, setOpen] = useState(single)
  const [buys, setBuys] = useState(null)
  useEffect(() => {
    if (open && buys === null) getBottlePurchases(s.name, sizeKey(s)).then((r) => setBuys(r.data)).catch(() => setBuys([]))
  }, [open])
  return (
    <div className={single ? '' : 'py-1.5 border-t border-amber-100 first:border-t-0'}>
      {!single && (
        <button onClick={() => setOpen((o) => !o)} className="w-full text-left flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold text-gray-800">{sizeText(s) || 'Size not noted'}</p>
            <p className="text-[10px] text-gray-500">
              {s.times} time{s.times === 1 ? '' : 's'}{s.bottles !== s.times && ` · ${s.bottles} bottles`}{s.last ? ` · last ${fmtDate(s.last)}` : ''}
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xs font-black text-brand-600">{s.avg_price != null ? INR(s.avg_price) : '—'}</p>
            <p className="text-[9px] text-gray-400">{s.avg_price == null ? 'price not noted' : s.priced > 1 ? `avg of ${s.priced}` : 'a bottle'}</p>
          </div>
        </button>
      )}
      {open && (
        <div className={`space-y-1.5 ${single ? '' : 'mt-1.5 ml-2 pl-2 border-l-2 border-amber-200'}`}>
          {buys === null && <p className="text-[11px] text-gray-400">Loading…</p>}
          {buys?.map((p) => (
            <button key={p.expense_id} onClick={() => nav(`/groups/${p.group_id}`)} className="w-full text-left flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-gray-800 break-words">{p.title || 'No description'}</p>
                <p className="text-[10px] text-gray-400">{fmtDate(p.date)} · {p.group}</p>
              </div>
              <p className="text-xs font-bold text-gray-900 shrink-0">
                {p.qty > 1 && <span className="font-normal text-gray-400">{p.qty} × </span>}
                {p.price_each != null ? INR(p.price_each) : <span className="font-normal text-gray-400">in {INR(p.amount)}</span>}
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// A brand's sizes under each variety ("Minty Jamun"), the plain brand first.
const groupByVariety = (b) => {
  const m = new Map()
  for (const s of b.sizes) { const k = s.variety || ''; if (!m.has(k)) m.set(k, []); m.get(k).push(s) }
  return [...m.entries()]
}

/** A brand, once: its varieties and sizes inside. */
function Brand({ b, nav }) {
  const [open, setOpen] = useState(false)
  const one = b.sizes.length === 1 ? b.sizes[0] : null
  const price = b.price_low == null ? '—' : b.price_low === b.price_high ? INR(b.price_low) : `${INR(b.price_low)} – ${INR(b.price_high)}`
  return (
    <div className="card">
      <button onClick={() => setOpen((o) => !o)} className="w-full text-left flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-gray-900 break-words">
            {b.name}
            {one && one.variety && <span className="ml-1.5 text-[11px] font-bold text-brand-600">{one.variety}</span>}
            {one && sizeText(one) && <span className="ml-1.5 text-[11px] font-semibold text-gray-400">{sizeText(one)}</span>}
          </p>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {b.times} time{b.times === 1 ? '' : 's'}
            {b.bottles !== b.times && ` · ${b.bottles} bottles`}
            {!one && (b.varieties?.length ? ` · ${b.varieties.length + (b.sizes.some((x) => !x.variety) ? 1 : 0)} kinds` : ` · ${b.sizes.length} sizes`)}
            {b.last ? ` · last ${fmtDate(b.last)}` : ''}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-black text-brand-600">{price}</p>
          <p className="text-[10px] text-gray-400">
            {one ? (one.avg_price == null ? 'price not noted' : one.priced > 1 ? `avg of ${one.priced}` : 'a bottle') : 'by size ▾'}
          </p>
        </div>
      </button>
      {open && (
        <div className="mt-3 pt-2 border-t border-amber-100">
          {one ? <SizeRow s={one} nav={nav} single /> : groupByVariety(b).map(([variety, rows]) => (
            <div key={variety || '-'} className="mb-1 last:mb-0">
              {b.varieties?.length > 0 && (
                <p className="text-[10px] font-black uppercase tracking-widest text-brand-600 mt-1">{variety || b.name}</p>
              )}
              {rows.map((s) => <SizeRow key={`${variety}|${sizeKey(s)}`} s={s} nav={nav} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * /drinks/bottles - every bottle and can you've had, read from your drink
 * expenses' descriptions, notes and receipts (backend bottles.py): times
 * bought, average price of one, last time; tap one for each purchase.
 * Opened from the Drinks tab. Expenses not read yet are read on the way in.
 */
export default function MyBottles() {
  const nav = useNavigate()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('times')

  useEffect(() => {
    let timer
    const load = () => getMyBottles()
      .then((r) => {
        setData(r.data)
        // Still reading older expenses: check back until it's done.
        if (r.data.reading || r.data.unread > 0) timer = setTimeout(load, 5000)
      })
      .catch(() => setError('Could not load your bottles.'))
    load()
    return () => clearTimeout(timer)
  }, [])

  // one entry per brand (older servers: one per size)
  const list = data?.brands || (data?.bottles || []).map((x) => ({ ...x, sizes: [x], price_low: x.avg_price, price_high: x.avg_price }))
  const shown = list
    .filter((b) => !q.trim() || b.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => sort === 'recent' ? (b.last || '').localeCompare(a.last || '')
      : sort === 'dear' ? (b.price_high ?? -1) - (a.price_high ?? -1)
      : sort === 'cheap' ? (a.price_low ?? 1e9) - (b.price_low ?? 1e9)
      : b.times - a.times)
  const reading = data && (data.reading || data.unread > 0)

  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← What to drink</button>
        <h1 className="text-xl font-black tracking-tight">Bottles I've had</h1>
        <p className="text-xs text-gray-400 mt-1">
          {data ? `${list.length} bottles, from your drink expenses` : 'From your drink expenses'}
        </p>
        {list.length > 0 && (
          <div className="flex gap-2 mt-3">
            <input className="input text-sm flex-1 min-w-0" placeholder="Search a bottle" value={q}
              onChange={(e) => setQ(e.target.value)} autoComplete="off" />
            <Dropdown className="w-40" size="sm" value={sort} onChange={setSort} options={SORTS} />
          </div>
        )}
      </div>

      <div className="px-5 mt-4 space-y-3 max-w-2xl">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!data && !error && <p className="text-xs text-gray-400 text-center py-10">Loading…</p>}
        {reading && (
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
            Reading {data.unread} drink expense{data.unread === 1 ? '' : 's'} for bottles… this list fills in as it goes.
          </p>
        )}
        {data && !reading && list.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-10">
            No bottles yet. Write the bottle in a drink expense's description or notes - "Old Monk half", "2 KF strong" - and it shows up here.
          </p>
        )}
        {list.length > 0 && shown.length === 0 && <p className="text-sm text-gray-400 text-center py-6">No bottle matches “{q}”.</p>}
        {shown.map((b) => <Brand key={b.name} b={b} nav={nav} />)}
        {list.length > 0 && (
          <p className="text-[10px] text-gray-400 text-center pt-2">
            Read from what you wrote on each drink expense. A price is the cost of one bottle, averaged over the
            times it was noted; "price not noted" means it was bought together with other things for one total.
          </p>
        )}
      </div>
    </div>
  )
}
