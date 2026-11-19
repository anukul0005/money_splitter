import { useState } from 'react'

/**
 * How to pay one UPI ID, with the amount (and a note) where given.
 *
 * UPI apps treat a pre-filled pay link from another app to a personal UPI
 * ID like a QR picked from the gallery: PhonePe caps it at ₹2,000 and often
 * declines it (only registered merchants' signed links get through). So
 * every app gets the way that always works: tap it, the UPI ID is copied
 * and the app opens - then Pay -> To UPI ID, paste, type the amount. Each
 * app is opened by its own scheme (on iPhone a bare upi:// link opens
 * whichever app claimed it first). Any other app: copy and open it by hand.
 */
// each app's own scheme with nothing after it just opens the app
const APPS = [
  { key: 'phonepe', label: 'PhonePe', href: 'phonepe://' },
  { key: 'gpay', label: 'Google Pay', href: 'gpay://' },
  { key: 'paytm', label: 'Paytm', href: 'paytmmp://' },
  { key: 'bhim', label: 'BHIM', href: 'bhim://' },
  { key: 'other', label: 'Any other app', href: null },
]

export default function PayViaUpi({ upiId, payeeName, amount, note = '', className = '', showAppButtons = true, onClaim }) {
  const [copied, setCopied] = useState(false)
  // The UPI app never tells us whether the money went - `onClaim` files a
  // "I've paid" claim that the payee then confirms or rejects (see
  // PaymentClaimsInbox). Nothing is recorded until they do.
  const [claim, setClaim] = useState({ state: 'idle', error: '' })   // idle | sending | sent | error

  const sendClaim = async () => {
    const amt = parseFloat(effectiveAmount)
    if (!amt || amt <= 0) return setClaim({ state: 'error', error: 'Enter the amount you paid first.' })
    setClaim({ state: 'sending', error: '' })
    try {
      await onClaim(Math.round(amt * 100) / 100)
      setClaim({ state: 'sent', error: '' })
    } catch (e) {
      setClaim({ state: 'error', error: e.response?.data?.detail || 'Could not send that - try again.' })
    }
  }
  // "Pay a different amount" - leaving the custom field blank omits `am`
  // entirely, which every UPI app treats as "ask the payer what to send"
  // rather than refusing to open.
  const [editingAmount, setEditingAmount] = useState(false)
  const [customAmount, setCustomAmount] = useState(amount ? String(amount) : '')

  const effectiveAmount = editingAmount ? customAmount : amount

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(upiId)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard denied - nothing to do about it */ }
  }
  // copy the UPI ID (inside the tap, so iPhone allows it), then open the app
  const copyAndOpen = (href) => (e) => {
    e.preventDefault()
    try { navigator.clipboard.writeText(upiId).catch(() => {}) } catch { /* clipboard blocked */ }
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
    if (href) setTimeout(() => { window.location.href = href }, 150)
  }
  const amtText = effectiveAmount ? `₹${Number(effectiveAmount).toLocaleString('en-IN')}` : ''

  return (
    <div className={`card space-y-3 text-center ${className}`}>
      <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">
        {amtText ? `Pay ${amtText}` : 'Pay'}{payeeName ? ` to ${payeeName}` : ''}
      </p>

      <div className="flex items-center justify-center gap-2 text-xs">
        <span className="text-gray-400">UPI:</span>
        <span className="font-bold text-gray-700">{upiId}</span>
        <button
          type="button" onClick={copy}
          className="px-2 py-0.5 rounded border border-amber-300 text-[11px] font-bold text-gray-600 hover:bg-amber-50"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {editingAmount ? (
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-gray-500">₹</span>
          <input
            type="number" inputMode="decimal" min="0" step="0.01"
            className="input text-sm flex-1" placeholder="Leave blank to enter it in the app"
            value={customAmount} onChange={(e) => setCustomAmount(e.target.value)}
            autoFocus
          />
          <button
            type="button" onClick={() => { setEditingAmount(false); setCustomAmount(amount ? String(amount) : '') }}
            className="text-[11px] font-bold text-gray-400 hover:text-red-500 shrink-0"
          >
            Cancel
          </button>
        </div>
      ) : (
        amount != null && (
          <button
            type="button" onClick={() => setEditingAmount(true)}
            className="text-[11px] text-gray-400 underline decoration-dotted hover:text-brand-600"
          >
            Pay a different amount
          </button>
        )
      )}

      {showAppButtons && (
        <>
          <p className="text-[11px] text-gray-500">Tap your app - the UPI ID is copied and the app opens</p>
          <div className="grid grid-cols-2 gap-2">
            {APPS.map((app) => (
              <a key={app.key} href={app.href || '#'} onClick={copyAndOpen(app.href)}
                className={`py-2.5 text-sm font-bold rounded-md border border-amber-300 text-gray-700 bg-white hover:border-brand-300 hover:text-brand-600 active:scale-[0.98] ${app.key === 'other' ? 'col-span-2' : ''}`}>
                {app.href ? app.label : (copied ? 'UPI ID copied - open your app' : 'Any other app: copy UPI ID')}
              </a>
            ))}
          </div>
          <p className="text-[11px] text-gray-500 leading-snug">
            Then in the app: <b>Pay → To UPI ID</b>, paste <b>{upiId}</b>{amtText ? <>, enter <b>{amtText}</b></> : ''}. Works for any amount.
          </p>

          {onClaim && (
            <div className="border-t border-amber-200 pt-3 space-y-1.5">
              {claim.state === 'sent' ? (
                <p className="text-xs font-bold text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">
                  Sent - waiting for {payeeName} to confirm. Your balance updates once they tap Yes.
                </p>
              ) : (
                <>
                  <p className="text-[11px] text-gray-400">Paid already? Let {payeeName} confirm it arrived.</p>
                  <button
                    type="button" onClick={sendClaim} disabled={claim.state === 'sending'}
                    className="w-full py-2 text-xs font-bold bg-green-50 border border-green-300 text-green-800 rounded-md hover:bg-green-100 disabled:opacity-50"
                  >
                    {claim.state === 'sending'
                      ? 'Sending…'
                      : `I've paid${effectiveAmount ? ` ₹${Number(effectiveAmount).toLocaleString('en-IN')}` : ''} - ask ${payeeName} to confirm`}
                  </button>
                  {claim.state === 'error' && (
                    <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{claim.error}</p>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
