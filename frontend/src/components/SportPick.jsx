import { useEffect, useState } from 'react'
import { sportPick, sportPicks } from '../api'

/** My picks for a sport's Live tab (backend routers/picks): {key: pick},
 *  reloaded with `tick`, and a setter for after a pick is saved. */
export function useSportPicks(sport, active) {
  const [picks, setPicks] = useState(null)
  useEffect(() => {
    if (active) sportPicks(sport).then((r) => setPicks(r.data.picks)).catch(() => setPicks({}))
  }, [sport, active])
  return [picks, (p) => setPicks((x) => ({ ...(x || {}), [p.key]: p }))]
}

/** Under a badminton / hockey match on the Live tab: pick the winner before
 *  it starts and, if I like, the price I got - My picks settles mock bets at
 *  it (no bookmaker feed covers these sports). After the start: my pick. */
export default function SportPick({ sport, mkey, names, upcoming, pick, onSaved }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [odds, setOdds] = useState(pick?.odds ? String(pick.odds) : '')
  useEffect(() => { setOdds(pick?.odds ? String(pick.odds) : '') }, [pick?.odds])
  const last = (n) => (n || '').split(' / ').map((x) => x.split(' ').slice(-1)[0]).join(' / ')
  if (!upcoming) {
    return pick ? (
      <p className="text-[10px] font-bold text-green-700 pl-9 mt-0.5">
        ✓ My pick {last(pick.pick)}{pick.odds ? ` @ ${pick.odds.toFixed(2)}` : ''}
      </p>
    ) : null
  }
  const save = (body) => {
    setBusy(true); setErr('')
    sportPick({ sport, key: mkey, ...body }).then((r) => onSaved(r.data))
      .catch((e) => setErr(e?.response?.data?.detail || "Couldn't save"))
      .finally(() => setBusy(false))
  }
  const saveOdds = () => {
    const v = Number(odds)
    if (!pick || !odds || v === pick.odds) return
    if (!(v >= 1.01)) { setErr('Decimal odds, like 1.85'); return }
    save({ odds: v })
  }
  return (
    <div className="pl-9 mt-1 flex items-center gap-1.5 flex-wrap" onClick={(e) => e.stopPropagation()}>
      <span className="text-[9px] font-black text-gray-400 uppercase tracking-wider">Pick</span>
      {names.map((n, i) => {
        const mine = pick?.side === i + 1
        return (
          <button key={i} disabled={busy} onClick={() => save({ side: i + 1 })}
            className={`rounded border px-1.5 py-0.5 text-[10px] font-black truncate max-w-[110px] ${mine ? 'bg-brand-600 border-brand-600 text-white' : 'border-dashed border-gray-300 text-gray-500'}`}>
            {mine ? '✓ ' : ''}{last(n)}
          </button>
        )
      })}
      {pick && (
        <label className="flex items-center gap-1 text-[10px] text-gray-400">
          @
          <input value={odds} onChange={(e) => setOdds(e.target.value)} onBlur={saveOdds}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            inputMode="decimal" placeholder="odds"
            className="w-14 rounded border border-gray-300 px-1 py-0.5 text-[11px] font-bold tabular-nums text-gray-800" />
        </label>
      )}
      {err && <span className="text-[10px] text-red-600">{err}</span>}
    </div>
  )
}
