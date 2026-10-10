const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

/**
 * What a receipt scan read for an expense (backend Expense.receipt_json):
 * the items with prices, tax and the receipt's total, in small type under
 * the expense. Renders nothing for an expense entered without a scan.
 */
export default function ReceiptInfo({ json, className = '' }) {
  let r = null
  try { r = json ? JSON.parse(json) : null } catch { r = null }
  const items = (r?.items ?? []).filter((i) => i && i.label)
  if (!r || (!items.length && r.total == null)) return null

  const extras = [
    r.tax != null && `tax ${INR(r.tax)}`,
    r.total != null && `total ${INR(r.total)}`,
  ].filter(Boolean)

  return (
    <div className={`text-[10px] leading-snug text-gray-400 ${className}`}>
      <span className="font-bold uppercase tracking-wider text-gray-400">Receipt</span>
      {r.merchant && <span> · {r.merchant}</span>}
      {items.length > 0 && (
        <ul className="mt-0.5">
          {items.map((i, n) => (
            <li key={n} className="flex justify-between gap-2">
              <span className="truncate">{i.label}</span>
              {i.amount != null && <span className="shrink-0">{INR(i.amount)}</span>}
            </li>
          ))}
        </ul>
      )}
      {extras.length > 0 && <p className="mt-0.5">{extras.join(' · ')}</p>}
    </div>
  )
}
