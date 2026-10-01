import { useEffect, useState } from 'react'
import { listIncomingClaims, confirmClaim, rejectClaim } from '../api'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

// "2 Oct 2026, 3:12 pm" in this phone's own time zone - the same clock the
// payee's UPI app history is shown in, so the two can be lined up.
const when = (iso) => {
  const d = iso ? new Date(iso) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

// Fired after a confirm so any page showing balances can reload itself
// instead of the person refreshing by hand - see Loans / Balances / Home.
export const MONEY_CHANGED = 'splitter:money-changed'

/**
 * "Did ₹X from Y arrive?" - one card per pending claim on you, pinned above
 * every page until you answer. Yes records the payment (against the loan,
 * bill or group balance the payer picked); No records nothing.
 *
 * Polls rather than waiting on a push: push is opt-in per device, and this
 * card has to show up whether or not it's on.
 */
export default function PaymentClaimsInbox() {
  const [claims, setClaims] = useState([])
  const [busy, setBusy] = useState(null)       // claim id being answered
  const [errors, setErrors] = useState({})     // claim id -> message

  const load = () => listIncomingClaims().then((r) => setClaims(r.data)).catch(() => {})

  useEffect(() => {
    load()
    const timer = setInterval(load, 30000)
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [])

  const answer = async (c, yes) => {
    setBusy(c.id)
    setErrors((e) => ({ ...e, [c.id]: '' }))
    try {
      await (yes ? confirmClaim(c.id) : rejectClaim(c.id))
      setClaims((list) => list.filter((x) => x.id !== c.id))
      if (yes) window.dispatchEvent(new Event(MONEY_CHANGED))
    } catch (e) {
      setErrors((x) => ({ ...x, [c.id]: e.response?.data?.detail || 'Something went wrong - try again.' }))
    } finally {
      setBusy(null)
    }
  }

  if (claims.length === 0) return null

  return (
    <div className="px-5 pt-10 md:pt-4 space-y-2 max-w-2xl">
      {claims.map((c) => (
        <div key={c.id} className="card border-2 border-green-300 bg-green-50/60 space-y-2">
          <p className="text-[10px] font-bold text-green-700 uppercase tracking-widest">Confirm payment</p>
          <p className="text-sm text-gray-800">
            <span className="font-bold">{c.payer}</span> says they paid you{' '}
            <span className="font-black">{INR(c.amount)}</span>
            <span className="text-gray-500"> · {c.what}</span>
          </p>
          {when(c.created_at) && (
            <p className="text-xs text-gray-700">
              Marked paid: <span className="font-bold tabular-nums">{when(c.created_at)}</span>
            </p>
          )}
          <p className="text-[11px] text-gray-500">
            Look for a payment around that time in your UPI app first. Yes records it and updates your balances; No records nothing.
          </p>
          {errors[c.id] && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{errors[c.id]}</p>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => answer(c, true)} disabled={busy === c.id}
              className="flex-1 py-2 text-xs font-bold rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
            >
              {busy === c.id ? 'Saving…' : 'Yes, received'}
            </button>
            <button
              onClick={() => answer(c, false)} disabled={busy === c.id}
              className="flex-1 py-2 text-xs font-bold rounded-md bg-white border border-amber-300 text-gray-700 hover:bg-amber-50 disabled:opacity-50"
            >
              No, not received
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
