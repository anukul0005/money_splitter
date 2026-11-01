import { useState } from 'react'

/**
 * A rankings table (tennis ATP / WTA, badminton BWF): the first `first`
 * rows, a button for the rest up to `max`. rows: {rank, change, names:
 * [{name, onClick?}], country, points}.
 */
export default function RankingList({ title, sub, rows, first = 20, max = 100, loading }) {
  const [all, setAll] = useState(false)
  const shown = (rows || []).slice(0, all ? max : first)
  return (
    <div className="card">
      <div className="flex items-baseline gap-2">
        <p className="text-xs font-black text-gray-800 flex-1">{title}</p>
        {sub && <p className="text-[10px] text-gray-400">{sub}</p>}
      </div>
      {loading && <p className="text-xs text-gray-400 py-3">Loading…</p>}
      {!loading && !shown.length && <p className="text-xs text-gray-400 py-3">The rankings didn't load - try again in a bit.</p>}
      {shown.map((r, i) => (
        <div key={`${r.rank}-${i}`} className="flex items-center text-[12px] py-1 border-t border-gray-100 first:border-t-0 mt-0.5">
          <span className="w-7 font-black text-gray-800 tabular-nums">{r.rank}</span>
          <span className={`w-8 text-[10px] font-bold ${r.change > 0 ? 'text-green-600' : r.change < 0 ? 'text-red-500' : 'text-gray-300'}`}>
            {r.change > 0 ? `▲${r.change}` : r.change < 0 ? `▼${-r.change}` : '–'}
          </span>
          <span className="flex-1 min-w-0 truncate">
            {r.names.map((p, k) => (
              <span key={k}>
                {k > 0 && ' / '}
                {p.onClick
                  ? <button onClick={p.onClick} className="font-semibold text-gray-800 hover:text-brand-600">{p.name}</button>
                  : <span className="font-semibold text-gray-800">{p.name}</span>}
              </span>
            ))}
            {r.country && <span className="ml-1 text-[10px] text-gray-400">{r.country}</span>}
          </span>
          <span className="w-16 text-right tabular-nums text-gray-500">{Number(r.points || 0).toLocaleString('en-IN')}</span>
        </div>
      ))}
      {(rows || []).length > first && (
        <button onClick={() => setAll((a) => !a)} className="mt-2 text-[11px] font-bold text-brand-600">
          {all ? `Show top ${first}` : `Show top ${Math.min(max, rows.length)}`}
        </button>
      )}
    </div>
  )
}
