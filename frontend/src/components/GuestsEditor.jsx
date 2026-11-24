import { useState } from 'react'

// People at an expense who aren't in its group (backend expense_guests).
// Each one is a note unless charged; a charged guest's share comes off what
// the members split, and they owe it to whoever paid, as a loan.
// guests: [{ name, charge, amount }] - amount '' means "an equal share",
// worked out from `perHead` until typed over.

const r2 = (n) => Math.round(n * 100) / 100

// What each guest is charged, with blanks filled in as an equal share.
export const guestShares = (guests, perHead) =>
  guests.map((g) => ({ ...g, amount: g.charge ? r2(g.amount === '' || g.amount == null ? perHead : parseFloat(g.amount) || 0) : 0 }))

export const chargedTotal = (guests, perHead) =>
  r2(guestShares(guests, perHead).reduce((t, g) => t + (g.charge ? g.amount : 0), 0))

// For the server: [{name, charge, amount}]
export const guestsJson = (guests, perHead) =>
  guests.length ? JSON.stringify(guestShares(guests, perHead).map(({ name, charge, amount }) => ({ name, charge, amount: charge ? amount : null }))) : null

// An expense's stored guests, back into editor rows
export const parseGuests = (raw) => {
  try {
    return (JSON.parse(raw || '[]') || []).map((g) => ({ name: g.name, charge: !!g.charge, amount: g.charge ? String(g.amount ?? '') : '' }))
  } catch { return [] }
}

export default function GuestsEditor({ guests, setGuests, perHead, memberNames = [], payer }) {
  const [name, setName] = useState('')
  const [err, setErr] = useState('')
  const add = () => {
    const n = name.trim().replace(/\s+/g, ' ')
    if (!n) return
    if (memberNames.some((m) => m.toLowerCase() === n.toLowerCase())) return setErr(`${n} is already in this group`)
    if (guests.some((g) => g.name.toLowerCase() === n.toLowerCase())) return setErr(`${n} is already added`)
    setGuests([...guests, { name: n, charge: false, amount: '' }])
    setName(''); setErr('')
  }
  const update = (i, patch) => setGuests(guests.map((g, k) => (k === i ? { ...g, ...patch } : g)))
  const shares = guestShares(guests, perHead)

  return (
    <div>
      <label className="label">Guests (not in the group, optional)</label>
      {guests.length > 0 && (
        <div className="space-y-1.5 mb-2">
          {guests.map((g, i) => (
            <div key={g.name} className="flex items-center gap-2 border border-amber-200 bg-amber-50/60 px-2.5 py-1.5">
              <span className="text-sm font-bold text-gray-800 flex-1 min-w-0 truncate">{g.name}</span>
              <div className="flex border border-amber-200 flex-shrink-0">
                <button type="button" onClick={() => update(i, { charge: false })}
                  className={`px-2 py-1 text-[11px] font-bold ${!g.charge ? 'bg-gray-700 text-white' : 'bg-cream text-gray-500'}`}>Note only</button>
                <button type="button" onClick={() => update(i, { charge: true })}
                  className={`px-2 py-1 text-[11px] font-bold border-l border-amber-200 ${g.charge ? 'bg-brand-400 text-white' : 'bg-cream text-gray-500'}`}>Charge</button>
              </div>
              {g.charge && (
                <div className="relative w-24 flex-shrink-0">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 font-bold pointer-events-none">₹</span>
                  <input type="number" inputMode="decimal" min="0" step="any"
                    className="input w-full text-right pl-5 py-1 text-sm"
                    placeholder={perHead ? String(r2(perHead)) : '0'}
                    value={g.amount} onChange={(e) => update(i, { amount: e.target.value })} />
                </div>
              )}
              <button type="button" onClick={() => setGuests(guests.filter((_, k) => k !== i))}
                className="text-gray-400 hover:text-red-500 px-1 text-lg leading-none flex-shrink-0" aria-label={`Remove ${g.name}`}>×</button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input className="input flex-1" placeholder="Add a name, e.g. Anjali" value={name}
          onChange={(e) => { setName(e.target.value); setErr('') }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
        <button type="button" onClick={add} className="px-4 text-xs font-bold border border-amber-200 bg-amber-50 text-gray-700">Add</button>
      </div>
      {err && <p className="text-xs text-red-500 mt-1">{err}</p>}
      {guests.length > 0 && (
        <p className="text-[10px] text-gray-400 mt-1">
          {shares.some((g) => g.charge)
            ? <>Charged guests' shares come off what the group splits; each owes {payer || 'the payer'} theirs, on the Loans page (due in a week). A blank share is an equal one.</>
            : <>Just a note - the group still splits the whole amount. Tap Charge to have someone pay their share.</>}
        </p>
      )}
    </div>
  )
}
