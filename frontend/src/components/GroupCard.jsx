import { useNavigate } from 'react-router-dom'
import { isSettled } from '../utils/money'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

/**
 * `friendBalance` — optional { name, net } describing what this group
 * contributes to the running balance with one specific friend. Shown when the
 * card is reached from that friend's page, so the overall figure is traceable
 * back to the individual groups that make it up. net < 0 means you owe them.
 */
export default function GroupCard({ group, friendBalance }) {
  const nav = useNavigate()

  const fb = friendBalance && !isSettled(friendBalance.net) ? friendBalance : null

  return (
    <div
      className="card p-3.5 flex items-center gap-2.5 cursor-pointer active:scale-[0.98] transition-transform"
      onClick={() => nav(`/groups/${group.id}`)}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-bold text-gray-900 min-w-0 flex-1 leading-snug">{group.name}</p>
          <span className="font-black text-brand-600 whitespace-nowrap text-sm flex-shrink-0">{INR(group.total_amount)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
          <span className="text-xs text-gray-400">{group.member_count} people</span>
          <span className="text-amber-200">·</span>
          <span className="text-xs text-gray-400">{group.expense_count} expenses</span>
          {group.category && (
            <>
              <span className="text-amber-200">·</span>
              <span className="badge bg-brand-400/15 text-brand-700 capitalize">{group.category}</span>
            </>
          )}
          {group.is_historical && (
            <>
              <span className="text-amber-200">·</span>
              <span className="badge bg-amber-100 text-amber-700">Historical</span>
            </>
          )}
        </div>

        {fb && (
          <p
            className={`text-xs font-semibold mt-1.5 ${
              fb.net < 0 ? 'text-red-600' : 'text-green-600'
            }`}
          >
            {fb.net < 0
              ? `You owe ${fb.name} ${INR(Math.abs(fb.net))} here`
              : `${fb.name} owes you ${INR(fb.net)} here`}
          </p>
        )}
      </div>
      <svg className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </div>
  )
}
