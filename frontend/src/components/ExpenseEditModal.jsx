import { useState } from 'react'
import { updateExpense } from '../api'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const r2  = (n) => Math.round(n * 100) / 100

const PAYMENT_MODES = [
  { value: 'cash',        label: 'Cash' },
  { value: 'upi',         label: 'UPI' },
  { value: 'credit_card', label: 'Credit Card' },
  { value: 'debit_card',  label: 'Debit Card' },
]

/**
 * Modal for editing an existing expense.
 * Amount is locked. Custom split uses % inputs; amounts are derived.
 */
export default function ExpenseEditModal({ expense, group, onSave, onClose }) {
  const members = group.members.map((m) => m.name)
  const amt = expense.amount   // locked — never editable

  // Parse existing split_json to derive initial percentages
  const parsedSplit = (() => {
    try { return expense.split_json ? JSON.parse(expense.split_json) : null }
    catch { return null }
  })()

  const initPcts = () => {
    if (parsedSplit && amt > 0) {
      const base = Object.fromEntries(members.map((m) => [m, '0']))
      Object.entries(parsedSplit).forEach(([k, v]) => {
        if (Object.prototype.hasOwnProperty.call(base, k)) {
          base[k] = String(r2((parseFloat(v) / amt) * 100))
        }
      })
      return base
    }
    // Default: equal percentages
    const ea = r2(100 / members.length)
    return Object.fromEntries(members.map((m) => [m, String(ea)]))
  }

  const [title,       setTitle]       = useState(expense.title || '')
  const [paidBy,      setPaidBy]      = useState(expense.paid_by)
  const [paymentMode, setPaymentMode] = useState(expense.payment_mode || 'cash')
  const [splitMode,   setSplitMode]   = useState(parsedSplit ? 'custom' : 'equal')
  const [customPcts,  setCustomPcts]  = useState(initPcts)
  const [saving,      setSaving]      = useState(false)
  const [error,       setError]       = useState('')

  const pctTotal    = members.reduce((s, m) => s + parseFloat(customPcts[m] || 0), 0)
  const pctBalanced = Math.abs(pctTotal - 100) <= 0.5

  const getSplitLabel = () => {
    if (splitMode === 'equal') return `Equal · ${INR(r2(amt / members.length))} each`
    if (members.length === 2) {
      const p0 = parseFloat(customPcts[members[0]] || 0)
      const p1 = parseFloat(customPcts[members[1]] || 0)
      const lo = Math.min(Math.round(p0), Math.round(p1))
      const hi = Math.max(Math.round(p0), Math.round(p1))
      if (lo === 35 && hi === 65) return "Gentleman's 65/35"
      return `Custom ${Math.round(p0)}/${Math.round(p1)}`
    }
    return 'Custom split'
  }

  const handleSplitModeChange = (mode) => {
    setSplitMode(mode)
    // customPcts are already initialised correctly from the expense's split_json
    // (or as equal % if no custom split existed). Don't reset them here.
  }

  const handleSave = async () => {
    setError('')

    let payload
    if (splitMode === 'equal') {
      payload = {
        group_id:          group.id,
        date:              expense.date,
        category:          expense.category,
        title:             title.trim() || null,
        amount:            amt,
        paid_by:           paidBy,
        payment_mode:      paymentMode || null,
        divider:           members.length,
        individual_amount: r2(amt / members.length),
        split_json:        null,
        participants:      expense.participants,
        notes:             expense.notes,
      }
    } else {
      if (!pctBalanced) {
        setError(`Percentages must add up to 100%. Current total: ${pctTotal.toFixed(2)}%`)
        return
      }
      payload = {
        group_id:          group.id,
        date:              expense.date,
        category:          expense.category,
        title:             title.trim() || null,
        amount:            amt,
        paid_by:           paidBy,
        payment_mode:      paymentMode || null,
        divider:           members.length,
        individual_amount: null,
        split_json:        JSON.stringify(
          Object.fromEntries(
            members.map((m) => [m, r2(amt * parseFloat(customPcts[m] || 0) / 100)])
          )
        ),
        participants:      expense.participants,
        notes:             expense.notes,
      }
    }

    setSaving(true)
    try {
      await updateExpense(expense.id, payload)
      onSave()
    } catch {
      setError('Failed to save. Please try again.')
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-cream w-full md:max-w-lg max-h-[92vh] flex flex-col border-t border-x border-amber-100/60 md:border shadow-2xl">

        {/* Header */}
        <div className="px-5 py-4 border-b border-amber-100/60 flex items-center justify-between flex-shrink-0 bg-cream">
          <h2 className="font-black text-sm tracking-widest">Edit Expense</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 p-1">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body — min-h-0 overrides flex's implicit min-height:auto so the
             body can actually shrink and scroll, keeping the footer on-screen */}
        <div className="overflow-y-auto flex-1 min-h-0 px-5 py-4 space-y-4">

          {/* Amount — locked, display only */}
          <div className="bg-amber-50 border border-amber-200 px-4 py-3 flex items-center justify-between">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-widest">Total Amount</span>
            <span className="text-xl font-black text-gray-900">{INR(amt)}</span>
          </div>

          {/* Title */}
          <div>
            <label className="label">Title</label>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Dinner, Taxi"
            />
          </div>

          {/* Paid by */}
          <div>
            <label className="label">Paid By</label>
            <select className="input" value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
              {members.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>

          {/* Payment mode */}
          <div>
            <label className="label">Payment Mode</label>
            <div className="flex gap-2 flex-wrap">
              {PAYMENT_MODES.map((pm) => (
                <button
                  key={pm.value}
                  type="button"
                  onClick={() => setPaymentMode(pm.value)}
                  className={`px-3 py-1.5 text-xs font-bold transition-colors border ${
                    paymentMode === pm.value
                      ? 'bg-brand-400 text-gray-900 border-brand-400'
                      : 'bg-cream text-gray-400 border-amber-200 hover:text-gray-700'
                  }`}
                >
                  {pm.label}
                </button>
              ))}
            </div>
          </div>

          {/* Split type toggle */}
          <div>
            <label className="label">Split</label>
            <div className="flex border border-amber-200">
              {['equal', 'custom'].map((mode) => (
                <button
                  key={mode}
                  onClick={() => handleSplitModeChange(mode)}
                  className={`flex-1 py-2.5 text-xs font-bold tracking-widest transition-colors border-r last:border-r-0 border-amber-200 ${
                    splitMode === mode
                      ? 'bg-brand-400 text-gray-900'
                      : 'bg-cream text-gray-400 hover:text-gray-700'
                  }`}
                >
                  {mode === 'equal' ? 'Equal' : 'Custom %'}
                </button>
              ))}
            </div>
          </div>

          {/* Equal split preview */}
          {splitMode === 'equal' && (
            <div className="border border-amber-200 bg-amber-50/50 px-3 py-2.5 space-y-1.5">
              <p className="text-[10px] font-black text-amber-700 tracking-widest mb-1">Equal split</p>
              {members.map((m) => (
                <div key={m} className="flex items-center justify-between">
                  <span className="text-xs font-bold text-gray-700">{m}</span>
                  <span className="text-xs font-black text-gray-900">{INR(r2(amt / members.length))}</span>
                </div>
              ))}
            </div>
          )}

          {/* Custom % split */}
          {splitMode === 'custom' && (
            <div className="border border-amber-200 bg-amber-50/50 px-3 py-3 space-y-2">
              <p className="text-[10px] font-black text-amber-700 tracking-widest mb-1">
                {getSplitLabel()}
              </p>
              {members.map((m) => {
                const pct     = customPcts[m] ?? ''
                const calcAmt = pct !== '' ? r2(amt * parseFloat(pct) / 100) : null
                return (
                  <div key={m} className="flex items-center gap-2">
                    <span className="text-xs font-bold text-gray-700 flex-1">{m}</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      className="input w-24 text-right py-1.5"
                      placeholder="0"
                      min="0"
                      max="100"
                      step="any"
                      value={pct}
                      onChange={(e) =>
                        setCustomPcts((prev) => ({ ...prev, [m]: e.target.value }))
                      }
                    />
                    <span className="text-xs text-gray-400 font-bold">%</span>
                    {calcAmt !== null && (
                      <span className="text-xs font-black text-gray-900 w-16 text-right">{INR(calcAmt)}</span>
                    )}
                  </div>
                )
              })}
              {/* Running total */}
              <div
                className={`flex items-center justify-between pt-2 border-t border-amber-200 text-xs font-black ${
                  pctBalanced ? 'text-green-600' : 'text-red-500'
                }`}
              >
                <span>{pctBalanced ? 'Balanced' : 'Total'}</span>
                <span>{pctBalanced ? '✓ 100%' : `${pctTotal.toFixed(2)}%`}</span>
              </div>
            </div>
          )}

          {error && (
            <p className="text-xs text-red-500 bg-red-50 border border-red-100 px-3 py-2">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 pt-3 pb-6 flex gap-3 border-t border-amber-100/60 flex-shrink-0 bg-cream">
          <button
            className="flex-1 py-3 text-xs font-bold text-gray-500 border border-amber-200 hover:bg-amber-50 active:scale-95 transition-all"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="flex-1 btn-primary py-3 text-xs"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
