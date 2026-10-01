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
 * "Did ₹X from Y arrive?" - a full-screen prompt that blocks the whole app
 * until every pending claim on you has its own Yes or No. Two claims means
 * two answers, oldest first; there is no close button and no tapping the
 * backdrop away, on purpose - a payer's balance can't move until the payee
 * answers, so the payee isn't allowed to put it off.
 *
 * Polls rather than waiting on a push: push is opt-in per device, and this
 * has to show up whether or not it's on.
 */
export default function PaymentClaimsInbox() {
  const [claims, setClaims] = useState([])
  const [answered, setAnswered] = useState(0)   // answered this session - for "2 of 3"
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = () => listIncomingClaims().then((r) => setClaims(r.data)).catch(() => {})

  useEffect(() => {
    load()
    const timer = setInterval(load, 30000)
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [])

  const blocking = claims.length > 0

  // The page behind must not scroll (or be scrolled to) while this is up.
  useEffect(() => {
    if (!blocking) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [blocking])

  useEffect(() => { if (!blocking) setAnswered(0) }, [blocking])

  if (!blocking) return null

  const c = claims[0]
  const total = answered + claims.length

  const answer = async (yes) => {
    setBusy(true)
    setError('')
    try {
      await (yes ? confirmClaim(c.id) : rejectClaim(c.id))
      setClaims((list) => list.filter((x) => x.id !== c.id))
      setAnswered((n) => n + 1)
      if (yes) window.dispatchEvent(new Event(MONEY_CHANGED))
    } catch (e) {
      // Already answered elsewhere (another device) - just drop it.
      if (e.response?.status === 409 || e.response?.status === 404) {
        setClaims((list) => list.filter((x) => x.id !== c.id))
      } else {
        setError(e.response?.data?.detail || 'Something went wrong - try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[1000] bg-field-950/80 backdrop-blur-sm flex items-center justify-center p-5"
      role="dialog" aria-modal="true" aria-labelledby="claim-title"
    >
      <div className="card w-full max-w-sm space-y-3 border-2 border-green-300">
        <div className="flex items-center justify-between">
          <p id="claim-title" className="text-[10px] font-bold text-green-700 uppercase tracking-widest">
            Confirm payment
          </p>
          {total > 1 && (
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest tabular-nums">
              {answered + 1} of {total}
            </p>
          )}
        </div>

        <p className="text-base text-gray-800 leading-snug">
          <span className="font-bold">{c.payer}</span> says they paid you
        </p>
        <p className="text-3xl font-black text-gray-900 tabular-nums">{INR(c.amount)}</p>
        <p className="text-xs text-gray-500">{c.what}</p>

        {when(c.created_at) && (
          <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Marked paid</p>
            <p className="text-sm font-bold text-gray-800 tabular-nums">{when(c.created_at)}</p>
          </div>
        )}

        <p className="text-[11px] text-gray-500 leading-relaxed">
          Look for a payment around that time in your UPI app. <b>Yes</b> records it and updates
          balances; <b>No</b> records nothing and tells {c.payer}. The app opens once you've
          answered{total > 1 ? ' every payment' : ''}.
        </p>

        {error && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>
        )}

        <div className="flex gap-2 pt-1">
          <button
            onClick={() => answer(false)} disabled={busy}
            className="flex-1 py-3 text-sm font-bold rounded-md bg-white border border-amber-300 text-gray-700 hover:bg-amber-50 disabled:opacity-50"
          >
            No, not received
          </button>
          <button
            onClick={() => answer(true)} disabled={busy}
            className="flex-1 py-3 text-sm font-bold rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Yes, received'}
          </button>
        </div>
      </div>
    </div>
  )
}
