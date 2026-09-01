import { useNavigate } from 'react-router-dom'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

// Clicking opens the master group's own page listing all its sub-groups.
export default function MasterGroupCard({ master }) {
  const nav = useNavigate()

  return (
    <button
      onClick={() => nav(`/master/${encodeURIComponent(master.key)}`, { state: { master } })}
      className="col-span-1 md:col-span-2 card p-3.5 w-full flex items-center gap-2.5 active:scale-[0.98] transition-transform border-brand-300 bg-brand-50/40 text-left"
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-gray-900 leading-snug">{master.name}</p>
        <p className="text-xs text-gray-400 mt-0.5">{master.groups.length} groups · {INR(master.totalAmount)} total</p>
      </div>
      <svg className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </button>
  )
}
