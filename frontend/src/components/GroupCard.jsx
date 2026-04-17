import { useNavigate } from 'react-router-dom'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

export default function GroupCard({ group }) {
  const nav = useNavigate()

  return (
    <div
      className="card flex items-center gap-3 cursor-pointer active:scale-[0.98] transition-transform"
      onClick={() => nav(`/groups/${group.id}`)}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <p className="font-bold text-gray-900 min-w-0 flex-1 leading-snug">{group.name}</p>
          <span className="font-black text-brand-600 whitespace-nowrap text-sm flex-shrink-0">{INR(group.total_amount)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
          <span className="text-xs text-gray-400">{group.member_count} people</span>
          <span className="text-amber-200">·</span>
          <span className="text-xs text-gray-400">{group.expense_count} expenses</span>
          {group.is_historical && (
            <>
              <span className="text-amber-200">·</span>
              <span className="badge bg-amber-100 text-amber-700">Historical</span>
            </>
          )}
        </div>
      </div>
      <svg className="w-4 h-4 text-gray-300 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </div>
  )
}
