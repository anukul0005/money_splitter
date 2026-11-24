import { useEffect, useState } from 'react'
import { getGroups } from '../api'

// Everyone in the viewer's groups - offered as guests, so a guest who is
// someone you know keeps their spelling ("Nandani", not "Nandini")
let knownCache = null

// People at an expense who aren't in its group (backend expense_guests).
// Each one is a note unless charged; a charged guest's share comes off what
// the members split, and they owe it to whoever paid, as a loan.
// guests: [{ name, charge, amount, pct, unit }] - unit '₹' (amount) or '%'
// (pct, of the whole expense `total`); left blank it's an equal share,
// worked out from `perHead` until typed over.

const r2 = (n) => Math.round(n * 100) / 100

// What each guest is charged, with blanks filled in as an equal share.
const blank = (v) => v === '' || v == null
export const guestShares = (guests, perHead, total = 0) =>
  guests.map((g) => {
    if (!g.charge) return { ...g, amount: 0 }
    if (g.unit === '%') return { ...g, amount: r2(blank(g.pct) ? perHead : total * (parseFloat(g.pct) || 0) / 100) }
    return { ...g, amount: r2(blank(g.amount) ? perHead : parseFloat(g.amount) || 0) }
  })

export const chargedTotal = (guests, perHead, total = 0) =>
  r2(guestShares(guests, perHead, total).reduce((t, g) => t + (g.charge ? g.amount : 0), 0))

// For the server: [{name, charge, amount}]
export const guestsJson = (guests, perHead, total = 0) =>
  guests.length ? JSON.stringify(guestShares(guests, perHead, total).map(({ name, charge, amount }) => ({ name, charge, amount: charge ? amount : null }))) : null

// An expense's stored guests, back into editor rows
export const parseGuests = (raw) => {
  try {
    return (JSON.parse(raw || '[]') || []).map((g) => ({ name: g.name, charge: !!g.charge, unit: '₹', pct: '', amount: g.charge ? String(g.amount ?? '') : '' }))
  } catch { return [] }
}

export default function GuestsEditor({ guests, setGuests, perHead, total = 0, memberNames = [], payer }) {
  const [name, setName] = useState('')
  const [err, setErr] = useState('')
  const [known, setKnown] = useState(knownCache || [])
  useEffect(() => {
    if (knownCache) return
    getGroups().then((r) => {
      const all = {}
      for (const g of r.data || []) for (const n of g.member_names || []) all[n.toLowerCase()] = all[n.toLowerCase()] || n
      knownCache = Object.values(all).sort((a, b) => a.localeCompare(b))
      setKnown(knownCache)
    }).catch(() => {})
  }, [])
  const add = () => {
    let n = name.trim().replace(/\s+/g, ' ')
    if (!n) return
    n = known.find((k) => k.toLowerCase() === n.toLowerCase()) || n
    if (memberNames.some((m) => m.toLowerCase() === n.toLowerCase())) return setErr(`${n} is already in this group`)
    if (guests.some((g) => g.name.toLowerCase() === n.toLowerCase())) return setErr(`${n} is already added`)
    setGuests([...guests, { name: n, charge: false, amount: '', pct: '', unit: '₹' }])
    setName(''); setErr('')
  }
  const update = (i, patch) => setGuests(guests.map((g, k) => (k === i ? { ...g, ...patch } : g)))
  const shares = guestShares(guests, perHead, total)

  return (
    <div>
      <label className="label">Guests (not in the group, optional)</label>
      {guests.length > 0 && (
        <div className="space-y-1.5 mb-2">
          {guests.map((g, i) => (
            <div key={g.name}>
            <div className="flex items-center gap-2 border border-amber-200 bg-amber-50/60 px-2.5 py-1.5">
              <span className="text-sm font-bold text-gray-800 flex-1 min-w-0 truncate">{g.name}</span>
              <div className="flex border border-amber-200 flex-shrink-0">
                <button type="button" onClick={() => update(i, { charge: false })}
                  className={`px-2 py-1 text-[11px] font-bold ${!g.charge ? 'bg-gray-700 text-white' : 'bg-cream text-gray-500'}`}>Note only</button>
                <button type="button" onClick={() => update(i, { charge: true })}
                  className={`px-2 py-1 text-[11px] font-bold border-l border-amber-200 ${g.charge ? 'bg-brand-400 text-white' : 'bg-cream text-gray-500'}`}>Charge</button>
              </div>
              {g.charge && (
                <div className="flex items-center gap-1 flex-shrink-0">
                  <input type="number" inputMode="decimal" min="0" step="any"
                    className="input w-20 text-right py-1 text-sm"
                    placeholder={g.unit === '%'
                      ? (perHead && total ? String(r2(perHead / total * 100)) : '0')
                      : (perHead ? String(r2(perHead)) : '0')}
                    value={g.unit === '%' ? g.pct : g.amount}
                    onChange={(e) => update(i, g.unit === '%' ? { pct: e.target.value } : { amount: e.target.value })} />
                  <div className="flex border border-amber-200">
                    {['₹', '%'].map((u) => (
                      <button key={u} type="button" onClick={() => update(i, { unit: u })}
                        className={`px-1.5 py-1 text-[11px] font-bold ${u === '%' ? 'border-l border-amber-200' : ''} ${(g.unit || '₹') === u ? 'bg-brand-400 text-white' : 'bg-cream text-gray-500'}`}>{u}</button>
                    ))}
                  </div>
                </div>
              )}
              <button type="button" onClick={() => setGuests(guests.filter((_, k) => k !== i))}
                className="text-gray-400 hover:text-red-500 px-1 text-lg leading-none flex-shrink-0" aria-label={`Remove ${g.name}`}>×</button>
            </div>
            {g.charge && g.unit === '%' && total > 0 && (
              <p className="text-[10px] text-gray-500 text-right mt-0.5">{g.name} pays ₹{shares[i].amount}</p>
            )}
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input className="input flex-1" placeholder="Add a name, e.g. Anjali" value={name} list="guest-known-people" autoComplete="off"
          onChange={(e) => { setName(e.target.value); setErr('') }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
        <button type="button" onClick={add} className="px-4 text-xs font-bold border border-amber-200 bg-amber-50 text-gray-700">Add</button>
      </div>
      <datalist id="guest-known-people">
        {known.filter((k) => !memberNames.some((m) => m.toLowerCase() === k.toLowerCase())
          && !guests.some((g) => g.name.toLowerCase() === k.toLowerCase())).map((k) => <option key={k} value={k} />)}
      </datalist>
      {err && <p className="text-xs text-red-500 mt-1">{err}</p>}
      {guests.length > 0 && (
        <p className="text-[10px] text-gray-400 mt-1">
          {shares.some((g) => g.charge)
            ? <>Charged guests' shares come off what the group splits; each owes {payer || 'the payer'} theirs, on the Loans page (due in a week). A blank share is an equal one; a % is of the whole bill.</>
            : <>Just a note - the group still splits the whole amount. Tap Charge to have someone pay their share.</>}
        </p>
      )}
    </div>
  )
}
