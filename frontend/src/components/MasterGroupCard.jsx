import { useState } from 'react'
import GroupCard from './GroupCard'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

export default function MasterGroupCard({ master }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="col-span-1 md:col-span-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="card w-full flex items-center gap-3 active:scale-[0.98] transition-transform border-brand-300 bg-brand-50/40"
      >
        <div className="shrink-0 w-10 h-10 rounded-full bg-brand-400 text-gray-900 flex items-center justify-center text-xs font-black">
          {master.label}
        </div>
        <div className="flex-1 min-w-0 text-left">
          <p className="font-bold text-gray-900 leading-snug">{master.names.join(' & ')}</p>
          <p className="text-xs text-gray-400 mt-0.5">{master.groups.length} groups · {INR(master.totalAmount)} total</p>
        </div>
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
