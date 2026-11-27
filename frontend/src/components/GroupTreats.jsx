import { useEffect, useState } from 'react'
import { getTreats, setTreatReturned, deleteTreat } from '../api'
import { dn } from '../utils/displayName'

const INR = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = (iso) => (iso ? `${+iso.slice(8, 10)} ${MON[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}` : '')

function Treat({ t, names, onChange }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const done = !!t.returned_on
  const who = t.members.map((n) => dn(n, names))
  const run = async (fn) => { setBusy(true); try { await fn(); await onChange() } finally { setBusy(false) } }
  return (
    <div className="py-2 border-b border-amber-100 last:border-0">
      <button onClick={() => setOpen((o) => !o)} className="w-full text-left flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className={`block text-sm font-bold break-words ${done ? 'text-gray-400' : 'text-gray-900'}`}>
            {t.by_name} treated {who.length === names.length ? 'everyone' : who.join(', ')}
          </span>
          <span className="block text-[11px] text-gray-500 break-words">
            {t.title || 'A treat'} · {day(t.date)}{t.split && t.share ? ` · ${INR(t.share)} each` : ''}
          </span>
          {done && <span className="block text-[11px] text-green-700">Returned {day(t.returned_on)}{t.returned_note ? ` - ${t.returned_note}` : ''}</span>}
        </span>
        <span className={`text-sm font-black shrink-0 ${done ? 'text-gray-400' : 'text-gray-900'}`}>{INR(t.amount)}</span>
      </button>
      {open && (
        <div className="mt-2 p-2 bg-amber-50 border border-amber-200 space-y-2">
          {t.notes && <p className="text-[11px] text-gray-600">{t.notes}</p>}
          {t.split && t.share && (
            <p className="text-[11px] text-gray-600">{t.members.map((n) => `${dn(n, names)} ${INR(t.share)}`).join(' · ')}</p>
          )}
          {!done ? (
            <div className="flex flex-wrap items-center gap-2">
              <input className="input !py-1.5 text-xs flex-1 min-w-[10rem]" placeholder="How? e.g. dinner at her place (optional)"
                value={note} onChange={(e) => setNote(e.target.value)} />
              <button disabled={busy} onClick={() => run(() => setTreatReturned(t.id, true, note))}
                className="px-3 py-1.5 text-xs font-bold bg-brand-400 text-white border border-brand-400 disabled:opacity-40">We returned it</button>
            </div>
          ) : (
            <button disabled={busy} onClick={() => run(() => setTreatReturned(t.id, false))}
              className="text-[11px] font-bold text-gray-500 disabled:opacity-40">Not returned yet</button>
          )}
          <button disabled={busy} onClick={() => window.confirm('Remove this treat?') && run(() => deleteTreat(t.id))}
            className="block text-[11px] font-bold text-red-500 disabled:opacity-40">Remove</button>
        </div>
      )}
    </div>
  )
}

/**
 * Group → treats: someone not in the group paid (backend routers/treats.py).
 * Never in balances - a reminder of who to treat back, until marked returned.
 */
export default function GroupTreats({ groupId, members, version = 0 }) {
  const [rows, setRows] = useState(null)
  const [showDone, setShowDone] = useState(false)
  const load = () => getTreats(groupId).then((r) => setRows(r.data)).catch(() => setRows([]))
  useEffect(() => { load() }, [groupId, version])   // eslint-disable-line react-hooks/exhaustive-deps

  if (!rows?.length) return null
  const names = members.map((m) => m.name)
  const owed = rows.filter((t) => !t.returned_on)
  const done = rows.filter((t) => t.returned_on)
  return (
    <div className="card md:col-span-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest">Treats to return</h2>
        {owed.length > 0 && <span className="text-xs font-black text-gray-900">{INR(owed.reduce((s, t) => s + t.amount, 0))}</span>}
      </div>
      <p className="text-[10px] text-gray-400">Paid by someone outside the group - not in anyone's balance.</p>
      {owed.length === 0 && <p className="text-xs text-gray-500 mt-2">All returned.</p>}
      <div className="mt-1">
        {owed.map((t) => <Treat key={t.id} t={t} names={names} onChange={load} />)}
        {showDone && done.map((t) => <Treat key={t.id} t={t} names={names} onChange={load} />)}
      </div>
      {done.length > 0 && (
        <button onClick={() => setShowDone((s) => !s)} className="text-[11px] font-bold text-brand-600 mt-1">
          {showDone ? 'Hide returned' : `${done.length} returned`}
        </button>
      )}
    </div>
  )
}
