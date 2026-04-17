import { useState } from 'react'
import { updateExpense } from '../api'

const INR  = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const r2   = (n) => Math.round(n * 100) / 100

/**
 * Modal for editing an existing expense.
 *
 * Props:
 *   expense  – full ExpenseOut object
 *   group    – full GroupOut object (has .members[].name and .id)
 *   onSave   – called after successful save (triggers parent reload)
 *   onClose  – called to dismiss without saving
 */
export default function ExpenseEditModal({ expense, group, onSave, onClose }) {
  const members = group.members.map((m) => m.name)

  /* ── Initialise state from existing expense ── */
  const parsedSplit = (() => {
    try { return expense.split_json ? JSON.parse(expense.split_json) : null }
    catch { return null }
  })()

  const initCustom = () => {
    if (parsedSplit) {
      // Fill in any missing members with 0
      const base = Object.fromEntries(members.map((m) => [m, 0]))
      return { ...base, ...parsedSplit }
    }
    const ea = r2(expense.amount / members.length)
    return Object.fromEntries(members.map((m) => [m, ea]))
  }

  const [title,      setTitle]      = useState(expense.title || '')
  const [amount,     setAmount]     = useState(expense.amount.toString())
  const [paidBy,     setPaidBy]     = useState(expense.paid_by)
  const [splitMode,  setSplitMode]  = useState(parsedSplit ? 'custom' : 'equal')
  const [customAmts, setCustomAmts] = useState(initCustom)
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState('')

  const amt          = parseFloat(amount) || 0
  const customTotal  = r2(Object.values(customAmts).reduce((s, v) => s + (parseFloat(v) || 0), 0))
  const remaining    = r2(amt - customTotal)

  /* ── Amount change – scale custom amounts proportionally ── */
  const handleAmountChange = (val) => {
    setAmount(val)
    if (splitMode !== 'custom') return
    const newAmt = parseFloat(val) || 0
    if (amt > 0 && newAmt > 0) {
      const scale = newAmt / amt
      setCustomAmts((prev) =>
        Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, r2((parseFloat(v) || 0) * scale)]))
      )
    }
  }

  /* ── Split mode switch ── */
  const handleSplitModeChange = (mode) => {
    setSplitMode(mode)
    if (mode === 'custom') {
      const ea = r2((parseFloat(amount) || 0) / members.length)
      setCustomAmts(Object.fromEntries(members.map((m) => [m, ea])))
    }
  }

  /* ── Split label shown in card (same logic as GroupDetail) ── */
  const getSplitLabel = () => {
    if (splitMode === 'equal') return `Equal · ${INR(r2(amt / members.length))} each`
    const vals = members.map((m) => parseFloat(customAmts[m]) || 0)
    if (members.length === 2 && amt > 0) {
      const r0 = Math.round((vals[0] / amt) * 100)
      const r1 = Math.round((vals[1] / amt) * 100)
      const lo = Math.min(r0, r1), hi = Math.max(r0, r1)
      if (lo === 35 && hi === 65) return "Gentleman's 65/35"
      return `Custom ${r0}/${r1}`
    }
    return 'Custom split'
  }

  /* ── Save ── */
  const handleSave = async () => {
    setError('')
    if (amt <= 0) { setError('Enter a valid amount'); return }

    let payload
    if (splitMode === 'equal') {
      payload = {
        group_id:          group.id,
        date:              expense.date,
        category:          expense.category,
        title:             title.trim() || null,
        amount:            amt,
        paid_by:           paidBy,
        divider:           members.length,
        individual_amount: r2(amt / members.length),
        split_json:        null,
        participants:      expense.participants,
        notes:             expense.notes,
      }
    } else {
      if (Math.abs(remaining) > 0.02) {
        setError(`Amounts must add up to ${INR(amt)}. Difference: ${remaining >= 0 ? '+' : ''}${INR(remaining)}`)
        return
      }
      payload = {
        group_id:          group.id,
        date:              expense.date,
        category:          expense.category,
        title:             title.trim() || null,
        amount:            amt,
        paid_by:           paidBy,
        divider:           members.length,
        individual_amount: null,
        split_json:        JSON.stringify(
          Object.fromEntries(members.map((m) => [m, r2(parseFloat(customAmts[m]) || 0)]))
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

        {/* ── Header ── */}
        <div className="px-5 py-4 border-b border-amber-100/60 flex items-center justify-between flex-shrink-0 bg-cream">
          <h2 className="font-black text-sm tracking-widest">Edit Expense</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 p-1">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* ── Body (scrollable) ── */}
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">

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

          {/* Amount */}
          <div>
            <label className="label">Total Amount (₹)</label>
            <input
              className="input"
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => handleAmountChange(e.target.value)}
              min="0"
              step="0.01"
            />
          </div>

          {/* Paid by */}
          <div>
            <label className="label">Paid By</label>
            <select
              className="input"
              value={paidBy}
              onChange={(e) => setPaidBy(e.target.value)}
            >
              {members.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
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
                  {mode === 'equal' ? 'Equal' : 'Custom'}
                </button>
              ))}
            </div>
          </div>

          {/* ── Equal split preview ── */}
          {splitMode === 'equal' && amt > 0 && (
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

          {/* ── Custom split inputs ── */}
          {splitMode === 'custom' && (
            <div className="border border-amber-200 bg-amber-50/50 px-3 py-3 space-y-2">
              <p className="text-[10px] font-black text-amber-700 tracking-widest mb-1">
                {getSplitLabel()}
              </p>
              {members.map((m) => (
                <div key={m} className="flex items-center gap-3">
                  <span className="text-xs font-bold text-gray-700 flex-1">{m}</span>
                  <span className="text-xs text-gray-400">
                    {amt > 0 ? Math.round(((parseFloat(customAmts[m]) || 0) / amt) * 100) : 0}%
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    className="input w-28 text-right py-1.5"
                    value={customAmts[m] ?? ''}
                    onChange={(e) =>
                      setCustomAmts((prev) => ({ ...prev, [m]: e.target.value }))
                    }
                    min="0"
                    step="0.01"
                  />
                </div>
              ))}
              {/* Running total / remaining */}
              <div
                className={`flex items-center justify-between pt-2 border-t border-amber-200 text-xs font-black ${
                  Math.abs(remaining) <= 0.02 ? 'text-green-600' : 'text-red-500'
                }`}
              >
                <span>{Math.abs(remaining) <= 0.02 ? 'Balanced' : 'Remaining'}</span>
                <span>
                  {Math.abs(remaining) <= 0.02
                    ? '✓'
                    : `${remaining >= 0 ? '' : '-'}${INR(Math.abs(remaining))}`}
                </span>
              </div>
            </div>
          )}

          {error && (
            <p className="text-xs text-red-500 bg-red-50 border border-red-100 px-3 py-2">{error}</p>
          )}
        </div>

        {/* ── Footer ── */}
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
