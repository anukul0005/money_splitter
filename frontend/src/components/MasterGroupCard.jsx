import { useState } from 'react'
import GroupCard from './GroupCard'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

// When collapsible=false (e.g. Home dashboard), renders a static summary
// card with key metrics only — no expand/collapse, no sub-group list.
export default function MasterGroupCard({ master, collapsible = true }) {
  const [open, setOpen] = useState(false)

  const info = (
    <div className="flex-1 min-w-0 text-left">
      <p className="font-bold text-gray-900 leading-snug">{master.name}</p>
      <p className="text-xs text-gray-400 mt-0.5">{master.groups.length} groups · {INR(master.totalAmount)} total</p>
    </div>
  )

  if (!collapsible) {
    return (
      <div className="col-span-1 md:col-span-2 card w-full flex items-center gap-3 border-brand-300 bg-brand-50/40">
        {info}
      </div>
    )
  }

  return (
    <div className="col-span-1 md:col-span-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="card w-full flex items-center gap-3 active:scale-[0.98] transition-transform border-brand-300 bg-brand-50/40"
      >
        {info}
        <svg
          className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {open && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3 pl-3 border-l-2 border-brand-200">
          {master.groups.map((g) => <GroupCard key={g.id} group={g} />)}
        </div>
      )}
    </div>
  )
}
