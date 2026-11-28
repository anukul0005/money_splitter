import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { createLoan, getFriends } from '../api'
import PeoplePicker from './PeoplePicker'
import DatePicker from './DatePicker'

// "Split / pass on": shared by card bills (pages/CardBill) and monthly groups
// (pages/GroupDetail). Each share becomes a loan from you to that person, tied
// to what it came from (loans.card_ref: "bill:<id>:<line>" or "exp:<id>").

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const day = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '')
const addDays = (iso, n) => {
  const t = new Date(`${iso}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() + n)
  return t.toISOString().slice(0, 10)
}

const r2 = (n) => Math.round(n * 100) / 100
const todayIso = () => new Date().toISOString().slice(0, 10)
// "FP EMI 01/03 ..." - an EMI booked on the card: [this instalment, how many]
export const emiOf = (x) => {
  const m = /\bEMI\b\D{0,3}0*(\d{1,2})\s*\/\s*0*(\d{1,2})/i.exec(x.description || '')
  return m && +m[2] > 1 ? { at: +m[1], of: +m[2] } : null
}
// The same day n months on (31 Jan + 1 -> 28/29 Feb)
const addMonths = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1 + n, 1))
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()
  t.setUTCDate(Math.min(d, last))
  return t.toISOString().slice(0, 10)
}
// What a line can pass on in all: an EMI line its instalments still to come, else its amount
export const passable = (x) => { const e = emiOf(x); return e ? r2(x.amount * (e.of - e.at + 1)) : x.amount }   // interest aside: an EMI passed on in full has at least this

/**
 * Pass a spend (a card bill's line, a monthly expense) on to people - all of it to one, or split (equally,
 * you in it or not, or by amounts typed). Each person's share becomes a
 * loan from you to them (tied to this line), so it shows in your Owed to
 * you, in their You owe, and in both Loans sections; anyone not on the app
 * is simply named.
 */
export function PassOnSheet({ x, all = [], refKey, source, dueDate, already = 0, booking, onGroup, onDone, onClose }) {
  // A card line can go, whole, into the group for its date instead (onGroup)
  const [mode, setMode] = useState(onGroup && !already ? 'group' : 'loan')
  const grouping = mode === 'group'
  const e = emiOf(x)
  // The bank turned this purchase into an EMI (backend card_emi.plan): passed
  // on with its instalments, interest, GST and fee - each due a few days
  // before the card's own due date
  const [withBank, setWithBank] = useState(!!booking)
  const bank = booking && withBank ? booking : null
  const [asEmi, setAsEmi] = useState(!!e)
  const [count, setCount] = useState(e ? String(e.of - e.at + 1) : '3')       // instalments still to pay
  const [inst, setInst] = useState(String(x.amount))
  const [first, setFirst] = useState(() => dueDate || addDays(todayIso(), 30))
  const nInst = Math.max(1, parseInt(count) || 1)
  const emiDates = Array.from({ length: nInst }, (_, k) => addMonths(first, k))
  // Interest + GST each instalment carries, from this bill's own lines: the
  // biggest "INTEREST ON EMI" goes with the biggest EMI, and so on; the GST
  // line is shared out in proportion to the interest
  const [extra, setExtra] = useState(() => {
    if (!e) return '0'
    const emis = all.filter((t) => emiOf(t)).sort((a, b) => b.amount - a.amount)
    const ints = all.filter((t) => /interest/i.test(t.description || '') && /\bemi\b/i.test(t.description || '') && t.type === 'debit')
      .sort((a, b) => b.amount - a.amount)
    const gst = all.filter((t) => /\bgst\b|igst|cgst|sgst/i.test(t.description || '') && t.type === 'debit')
      .reduce((s, t) => s + t.amount, 0)
    const mine = ints[emis.indexOf(x)]?.amount || 0
    const intTotal = ints.reduce((s, t) => s + t.amount, 0)
    return String(r2(mine + (intTotal ? (gst * mine) / intTotal : 0)))
  })
  const perInst = r2((parseFloat(inst) || 0) + (parseFloat(extra) || 0))
  const [people, setPeople] = useState([])
  const [friends, setFriends] = useState([])
  const [withMe, setWithMe] = useState(false)
  useEffect(() => { setWithMe(grouping); setAmts({}) }, [grouping])
  const [amts, setAmts] = useState({})              // name -> amount typed (others follow the even share)
  const [due, setDue] = useState(() => addDays(todayIso(), 30))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { getFriends().then((r) => setFriends(r.data.map((f) => f.name))).catch(() => {}) }, [])
  const left = grouping ? r2(x.amount) : r2((bank ? bank.total : asEmi ? perInst * nInst : x.amount) - already)
  const even = people.length ? r2(left / (people.length + (withMe ? 1 : 0))) : 0
  const share = (n) => (amts[n] !== undefined && amts[n] !== '' ? parseFloat(amts[n]) || 0 : even)
  const total = r2(people.reduce((s, n) => s + share(n), 0))
  const save = async () => {
    setErr('')
    if (grouping) {
      if (!people.length) return setErr('Pick who it was with.')
      const typed = Object.keys(amts).some((n) => amts[n] !== '')
      if (total > left + 0.5) return setErr(`That's ${INR(total)} - more than the ${INR(left)} spent.`)
      setBusy(true)
      try {
        await onGroup({ people, with_me: withMe, shares: typed ? Object.fromEntries(people.map((n) => [n, share(n)])) : null })
        onDone()
      } catch (e) { setErr(e.response?.data?.detail || 'Could not put it in a group.'); setBusy(false) }
      return
    }
    if (!people.length) return setErr('Pick who to pass it on to.')
    if (total <= 0) return setErr('Enter the amounts.')
    if (total > left + 0.5) return setErr(`That's ${INR(total)} - more than the ${INR(left)} left on this spend.`)
    setBusy(true)
    try {
      for (const person of people) {
        if (share(person) <= 0) continue
        let plan
        if (bank) {
          // the bank's instalments, each the same share of this person's part
          const ps = bank.instalments.map((t) => Math.round((t.amount / bank.total) * 100 * 10000) / 10000)
          ps[ps.length - 1] = Math.round((100 - ps.slice(0, -1).reduce((s, p) => s + p, 0)) * 10000) / 10000
          plan = { emi: bank.instalments.map((t, k) => ({ pct: ps[k], date: t.due })) }
        } else if (asEmi) {
          // An EMI: the share paid back in equal monthly instalments (the last takes the rounding)
          const each = Math.floor((100 / emiDates.length) * 10000) / 10000
          const pcts = emiDates.map((_, k) => (k < emiDates.length - 1 ? each : Math.round((100 - each * (emiDates.length - 1)) * 10000) / 10000))
          plan = { emi: emiDates.map((date, k) => ({ pct: pcts[k], date })) }
        } else plan = { due_date: due }
        const what = bank
          ? ` · ${bank.bank || 'Bank'} EMI ${bank.tenure} months${bank.rate_pct != null ? ` @ ${bank.rate_pct}% p.a.` : ''}: ${INR(bank.amount)} + interest ${INR(bank.interest)} + GST ${INR(bank.tax)}${bank.fee ? ` + processing fee ${INR(bank.fee)}` : ''}${bank.outside ? ` + ${INR(bank.outside)} not converted` : ''}`
          : asEmi ? ` · ${emiDates.length} monthly EMIs` : ''
        await createLoan({
          role: 'lent', other: person, amount: share(person), start_date: x.date || todayIso(), ...plan,
          note: `${x.description}${source ? ` · ${source}` : ''}${x.date ? ` · ${day(x.date)}` : ''}${what}`,
          card_ref: refKey,
        })
      }
      onDone()
    } catch (e) {
      setErr(e.response?.data?.detail || 'Could not save.'); setBusy(false)
    }
  }
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-cream rounded-xl p-5 space-y-3 shadow-xl max-h-[85dvh] overflow-y-auto">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-base font-black">Split / pass on</p>
            <p className="text-[11px] text-gray-500 truncate">{x.description} · {INR(x.amount)}{already > 0 ? ` · ${INR(already)} passed on already` : ''}</p>
          </div>
          <button type="button" onClick={onClose} className="text-xs font-bold text-gray-400">Close</button>
        </div>
        {onGroup && (
          <div className="flex gap-1.5">
            {[['group', 'Put it in a group'], ['loan', 'Pass on as a loan']].map(([v, label]) => (
              <button key={v} type="button" disabled={v === 'group' && already > 0} onClick={() => setMode(v)}
                className={`flex-1 py-1.5 text-xs font-bold border rounded-md disabled:opacity-40 ${mode === v ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-300 bg-white text-gray-700'}`}>
                {label}
              </button>
            ))}
          </div>
        )}
        {grouping && (
          <p className="text-[11px] text-gray-600 bg-amber-50 border border-amber-200 rounded-md p-2">
            The whole {INR(x.amount)} goes into your group for <b>{day(x.date)}</b> - or a new one of that name if there isn't one -
            paid by your card and split with the people you pick. Anyone not in that group is added to it.
          </p>
        )}
        {!grouping && booking && (
          <div className="bg-amber-50 border border-amber-200 rounded-md p-3 space-y-2">
            <label className="flex items-start gap-2 text-xs font-bold text-gray-800">
              <input type="checkbox" className="mt-0.5" checked={withBank} onChange={(ev) => { setWithBank(ev.target.checked); setAmts({}) }} />
              <span>
                Pass on with the EMI - {booking.tenure} months{booking.rate_pct != null ? ` at ${booking.rate_pct}% a year` : ''}
                <span className="block font-normal text-[10px] text-gray-500">
                  {booking.source === 'schedule' ? `${booking.bank || 'The bank'}'s own repayment schedule` : 'Worked out from the booking email (no schedule attached) - may be a few rupees off'}
                </span>
              </span>
            </label>
            {withBank && (
              <>
                <div className="text-[11px] text-gray-700 space-y-0.5">
                  {booking.instalments.map((t) => (
                    <div key={t.n} className="flex justify-between gap-2 tabular-nums">
                      <span className="text-gray-500">{t.n}. due {day(t.due)}</span>
                      <span>{INR(t.amount)}</span>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-gray-500 leading-snug">
                  {INR(booking.amount)} + interest {INR(booking.interest)} + GST on it {INR(booking.tax)}
                  {booking.fee ? ` + processing fee ${INR(booking.fee)} (in the 1st)` : ''}
                  {booking.outside ? ` + ${INR(booking.outside)} not converted (in the 1st)` : ''} = <b>{INR(booking.total)}</b>.
                  Each due a few days before your card's due date (set on the card's page).
                </p>
              </>
            )}
          </div>
        )}
        {!grouping && e && !bank && (
          <div className="bg-amber-50 border border-amber-200 rounded-md p-3 space-y-2">
            <label className="flex items-center gap-2 text-xs font-bold text-gray-800">
              <input type="checkbox" checked={asEmi} onChange={(ev) => { setAsEmi(ev.target.checked); setAmts({}) }} />
              Paid back as an EMI (EMI {e.at} of {e.of} on this bill)
            </label>
            {asEmi && (
              <>
                <div className="flex items-center gap-2">
                  <input className="input w-16 text-center" inputMode="numeric" value={count}
                    onChange={(ev) => { setCount(ev.target.value.replace(/\D/g, '')); setAmts({}) }} />
                  <span className="text-xs text-gray-600">instalments of</span>
                  <div className="relative flex-1">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 font-bold pointer-events-none">₹</span>
                    <input className="input w-full text-right pl-6" inputMode="decimal" value={inst}
                      onChange={(ev) => { setInst(ev.target.value.replace(/[^\d.]/g, '')); setAmts({}) }} />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-600 flex-1">+ interest & GST each</span>
                  <div className="relative w-28">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 font-bold pointer-events-none">₹</span>
                    <input className="input w-full text-right pl-6" inputMode="decimal" value={extra}
                      onChange={(ev) => { setExtra(ev.target.value.replace(/[^\d.]/g, '')); setAmts({}) }} />
                  </div>
                </div>
                <p className="text-[10px] text-gray-400 -mt-1">From this bill's INTEREST ON EMI and GST lines - change it if it's off.</p>
                <div>
                  <p className="text-[10px] font-bold text-gray-500 mb-1">First instalment due</p>
                  <DatePicker value={first} onChange={setFirst} />
                </div>
                <p className="text-[11px] text-gray-600">
                  {nInst} × {INR(perInst)} = <b>{INR(r2(perInst * nInst))}</b> · {emiDates.map((dt) => day(dt)).join(', ')}
                </p>
              </>
            )}
          </div>
        )}
        <PeoplePicker options={friends} selected={people} onChange={(v) => { setPeople(v); setAmts({}) }}
          placeholder={grouping ? 'Who was it with? (on the app or not)' : 'Who pays you back? (on the app or not)'} allowNew />
        {people.length > 0 && (
          <>
            <label className="flex items-center gap-2 text-xs text-gray-700">
              <input type="checkbox" checked={withMe} onChange={(e) => { setWithMe(e.target.checked); setAmts({}) }} />
              {grouping ? "I'm in the split too" : "I'm in the split too (my share stays mine)"}
            </label>
            <div className="space-y-1.5">
              {people.map((n) => (
                <div key={n} className="flex items-center gap-2">
                  <span className="flex-1 min-w-0 truncate text-sm font-bold text-gray-800">{n}</span>
                  <div className="relative w-28">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 font-bold pointer-events-none">₹</span>
                    <input className="input w-full text-right pl-6" inputMode="decimal"
                      value={amts[n] ?? String(even)} onChange={(e) => setAmts((a) => ({ ...a, [n]: e.target.value.replace(/[^\d.]/g, '') }))} />
                  </div>
                </div>
              ))}
              <p className="text-[11px] text-gray-500">
                {withMe ? `Your share: ${INR(r2(left - total))} · ` : ''}{grouping ? 'Theirs' : 'Passing on'} {INR(total)} of {INR(left)}
              </p>
            </div>
            {!grouping && !asEmi && !bank && (
              <div>
                <p className="text-[10px] font-bold text-gray-500 mb-1">Pay back by</p>
                <DatePicker value={due} onChange={setDue} />
              </div>
            )}
          </>
        )}
        {err && <p className="text-xs text-red-600">{err}</p>}
        <button type="button" onClick={save} disabled={busy || !people.length} className="btn-primary py-2.5 text-sm w-full disabled:opacity-50">
          {busy ? 'Saving…' : grouping ? `Put ${INR(x.amount)} in the ${day(x.date)} group` : people.length ? `Pass on ${INR(total)}` : 'Pass on'}
        </button>
        <p className="text-[10px] text-gray-400">{grouping
          ? 'It settles like any group expense, and your card total counts it in the group instead.'
          : 'Each share becomes money they owe you - in your Owed to you, their You owe, and Loans.'}</p>
      </div>
    </div>,
    document.body,
  )
}
