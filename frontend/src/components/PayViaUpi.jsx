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
 * `upi://pay?...` reliably pops Android's "open with" chooser across every
 * installed UPI app. iOS support is inconsistent - some apps only answer
 * their own scheme (phonepe://, paytmmp://) - so the button is still worth
 * having, but the QR is the part guaranteed to work everywhere.
 */
export default function PayViaUpi({ upiId, payeeName, amount, note = '', className = '' }) {
  const [copied, setCopied] = useState(false)

  const params = new URLSearchParams({
    pa: upiId,
    pn: payeeName || '',
    cu: 'INR',
    ...(amount ? { am: String(amount) } : {}),
    ...(note ? { tn: note } : {}),
  })
  const upiLink = `upi://pay?${params.toString()}`
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
        {amount ? `Scan & Pay ₹${Number(amount).toLocaleString('en-IN')}` : 'Scan to pay'}
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

      <a href={upiLink} className="btn-primary block py-2.5 text-sm">
        Pay{amount ? ` ₹${Number(amount).toLocaleString('en-IN')}` : ''} via UPI App
      </a>
    </div>
  )
}
