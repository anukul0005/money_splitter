import { useEffect, useState } from 'react'
import { bookOddsSave, bookOdds as fetchBooks, sportPick, sportPicks } from '../api'

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
export default function SportPick({ sport, mkey, names, upcoming, pick, onSaved, model }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [odds, setOdds] = useState(pick?.odds ? String(pick.odds) : '')
  useEffect(() => { setOdds(pick?.odds ? String(pick.odds) : '') }, [pick?.odds])
  const last = (n) => (n || '').split(' / ').map((x) => x.split(' ').slice(-1)[0]).join(' / ')
  if (!upcoming) {
    return pick ? (
      <p className="text-[10px] font-bold text-green-700 pl-9 mt-0.5">
        ✓ My pick {last(pick.pick)}{pick.odds ? ` @ ${pick.odds.toFixed(2)}` : model && pick.side ? ` @ ${model[pick.side - 1].toFixed(2)} (ours)` : ''}
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
            inputMode="decimal" placeholder={model && pick?.side ? model[pick.side - 1].toFixed(2) : 'odds'}
            className="w-14 rounded border border-gray-300 px-1 py-0.5 text-[11px] font-bold tabular-nums text-gray-800" />
        </label>
      )}
      {err && <span className="text-[10px] text-red-600">{err}</span>}
    </div>
  )
}

/** The bookmaker prices I've typed in for a sport's matches: {key: entry}. */
export function useBookOdds(sport, active) {
  const [books, setBooks] = useState(null)
  useEffect(() => {
    if (active) fetchBooks(sport).then((r) => setBooks(r.data.books)).catch(() => setBooks({}))
  }, [sport, active])
  return [books, (b) => setBooks((x) => ({ ...(x || {}), [b.key]: b }))]
}

const BOOK_KEY = 'sports.bookName'

/** A bookmaker's prices for a match, typed in by hand (no feed covers
 *  badminton or hockey): both sides, and which bookmaker. Shown beside our
 *  own odds; picks settle at them; My picks compares the two once played. */
export function BookOdds({ sport, mkey, names, entry, onSaved, ours, open }) {
  const [edit, setEdit] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [o1, setO1] = useState('')
  const [o2, setO2] = useState('')
  const [book, setBook] = useState(() => { try { return localStorage.getItem(BOOK_KEY) || '1xBet' } catch { return '1xBet' } })
  const last = (n) => (n || '').split(' / ').map((x) => x.split(' ').slice(-1)[0]).join(' / ')
  const start = () => { setO1(entry ? String(entry.odds[0]) : ''); setO2(entry ? String(entry.odds[1]) : ''); setErr(''); setEdit(true) }
  const save = () => {
    const a = Number(o1), b = Number(o2)
    if (!(a >= 1.01 && b >= 1.01)) { setErr('Both prices, decimal - like 1.73 and 2.00'); return }
    setBusy(true); setErr('')
    try { localStorage.setItem(BOOK_KEY, book) } catch { /* private mode */ }
    bookOddsSave({ sport, key: mkey, odds1: a, odds2: b, book }).then((r) => { onSaved(r.data); setEdit(false) })
      .catch((e) => setErr(e?.response?.data?.detail || "Couldn't save"))
      .finally(() => setBusy(false))
  }
  const stop = (e) => e.stopPropagation()
  if (edit) {
    return (
      <div className="pl-9 mt-1 flex items-center gap-1.5 flex-wrap text-[10px]" onClick={stop}>
        <input value={book} onChange={(e) => setBook(e.target.value)} placeholder="Bookmaker"
          className="w-16 rounded border border-gray-300 px-1 py-0.5 text-[11px] font-bold text-gray-800" />
        {[[o1, setO1, 0], [o2, setO2, 1]].map(([v, set, i]) => (
          <label key={i} className="flex items-center gap-1 text-gray-500">
            {last(names[i])}
            <input value={v} onChange={(e) => set(e.target.value)} inputMode="decimal" placeholder={ours ? ours[i].toFixed(2) : 'odds'}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              className="w-12 rounded border border-gray-300 px-1 py-0.5 text-[11px] font-bold tabular-nums text-gray-800" />
          </label>
        ))}
        <button disabled={busy} onClick={save} className="rounded bg-brand-600 text-white px-2 py-0.5 font-black">Save</button>
        <button onClick={() => setEdit(false)} className="text-gray-400 font-bold">Cancel</button>
        {err && <span className="text-red-600">{err}</span>}
      </div>
    )
  }
  if (!entry) {
    return open ? (
      <div className="pl-9 mt-0.5" onClick={stop}>
        <button onClick={start} className="text-[10px] font-bold text-brand-600">+ Bookmaker odds</button>
      </div>
    ) : null
  }
  const i1 = 1 / entry.odds[0], i2 = 1 / entry.odds[1]
  return (
    <div className="pl-9 mt-0.5 text-[10px] text-gray-500 flex items-center gap-1.5 flex-wrap" onClick={stop}>
      <span className="font-black text-gray-700">{entry.book || 'Bookmaker'}</span>
      <span className="tabular-nums font-bold text-gray-800">{entry.odds[0].toFixed(2)} / {entry.odds[1].toFixed(2)}</span>
      <span className="tabular-nums">({Math.round((100 * i1) / (i1 + i2))}% / {Math.round((100 * i2) / (i1 + i2))}%, {(100 * entry.margin).toFixed(1)}% margin)</span>
      {ours && <span className="tabular-nums">· ours {ours[0].toFixed(2)} / {ours[1].toFixed(2)}</span>}
      {entry.late && <span className="text-amber-600 font-bold">entered after the start</span>}
      {open && <button onClick={start} className="font-bold text-brand-600">edit</button>}
    </div>
  )
}
