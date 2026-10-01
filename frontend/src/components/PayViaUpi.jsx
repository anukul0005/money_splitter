import { useState } from 'react'

/**
 * A QR code + "Pay via UPI App" button for one UPI ID, pre-filled with an
 * amount and a note where given. Two ways to actually pay: scan the QR
 * with any UPI app, or (on the same phone the app is open on) tap the
 * button to jump straight into whichever UPI app is installed.
 *
 * The QR is rendered by a public QR-image API rather than a bundled JS QR
 * library - the string it encodes (a UPI ID + an amount) is exactly what
 * you'd hand someone to pay you anyway, same as reading it off a QR taped
 * to a shop counter, so there's nothing sensitive going out in that
 * request.
 *
 * The generic `upi://pay?...` scheme reliably pops Android's "open with"
 * chooser across every installed UPI app - but on iOS there's no chooser:
 * whichever app registered that same scheme first just gets it, and apps
 * with their own UPI payment feature (WhatsApp included) often do too, so
 * a bare upi:// link can silently open the wrong one. Each app's own
 * scheme (phonepe://, tez://, paytmmp://) is unambiguous instead, so the
 * primary button targets PhonePe directly and the row below offers the
 * others + a generic fallback for anything else.
 */
// gpay:// and paytmmp://upi/pay are each app's current iOS scheme - tez://
// was Google Pay's old (pre-rebrand, Android-only) scheme and paytmmp://pay
// was missing the /upi/ segment Paytm's own iOS docs use, so both were
// silently doing nothing on iPhone even when the app was installed.
const APP_SCHEMES = [
  { key: 'phonepe', label: 'PhonePe', scheme: 'phonepe://pay' },
  { key: 'gpay', label: 'Google Pay', scheme: 'gpay://upi/pay' },
  { key: 'paytm', label: 'Paytm', scheme: 'paytmmp://upi/pay' },
  { key: 'other', label: 'Other UPI app', scheme: 'upi://pay' },
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

  const params = new URLSearchParams({
    pa: upiId,
    pn: payeeName || '',
    cu: 'INR',
    ...(effectiveAmount ? { am: String(effectiveAmount) } : {}),
    ...(note ? { tn: note } : {}),
  })
  const qs = params.toString()
  const linkFor = (scheme) => `${scheme}?${qs}`
  const upiLink = linkFor('upi://pay')   // what the QR encodes - scanning app decides itself, no ambiguity there
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=10&data=${encodeURIComponent(upiLink)}`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(upiId)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard denied - nothing to do about it */ }
  }

  return (
    <div className={`card space-y-3 text-center ${className}`}>
      <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">
        {effectiveAmount ? `Scan & Pay ₹${Number(effectiveAmount).toLocaleString('en-IN')}` : 'Scan to pay'}
      </p>

      <div className="flex justify-center">
        <img
          src={qrSrc} alt={`UPI QR code for ${upiId}`} width={200} height={200}
          className="rounded-md border border-amber-200 bg-white p-2"
        />
      </div>

      <p className="text-[11px] text-gray-400">
        Scan with any UPI app: GPay · PhonePe · Paytm · BHIM
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
          <a href={linkFor(APP_SCHEMES[0].scheme)} className="btn-primary block py-2.5 text-sm">
            Pay{effectiveAmount ? ` ₹${Number(effectiveAmount).toLocaleString('en-IN')}` : ''} via {APP_SCHEMES[0].label}
          </a>

          <div className="flex flex-wrap justify-center gap-1.5">
            {APP_SCHEMES.slice(1).map((app) => (
              <a
                key={app.key} href={linkFor(app.scheme)}
                className="text-[11px] px-2.5 py-1.5 rounded-full border border-amber-300 text-gray-600 hover:border-brand-300 hover:text-brand-600"
              >
                {app.label}
              </a>
            ))}
          </div>

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
