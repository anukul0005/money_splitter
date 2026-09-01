import { useEffect, useMemo, useState } from 'react'
import { getGroups, createPaymentAuto, updatePayment, deletePayment } from '../api'
import { useUser } from '../UserContext'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

/**
 * Record a payment from anywhere — just who paid whom, and how much.
 *
 * No group picker: a payment settles a debt, and the debt already lives in
 * specific groups, so the server places the amount against the outstanding
 * balance (largest first, split across groups if one doesn't cover it).
 * `prefillFriend` preselects the other side.
 *
 * Pass `payment` to correct an existing one instead. Balances are derived from
 * payments rather than stored, so amending the row is enough — every group
 * total and friend balance it touches recomputes on the next read.
 */
export default function RecordPaymentModal({ onClose, onSaved, prefillFriend, payment }) {
  const user = useUser()
  const editing = !!payment

  const [people, setPeople]   = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({
    from_member: payment?.from_member || '',
    to_member:   payment?.to_member || prefillFriend || '',
    amount:      payment ? String(payment.amount) : '',
    note:        payment?.note || '',
    date:        payment?.date || new Date().toISOString().slice(0, 10),
  })
  const [error, setError] = useState('')
  const [busy, setBusy]   = useState(false)

  // Everyone who shares an active group with the current user, plus the user
  useEffect(() => {
    getGroups()
      .then((r) => {
        const mine = r.data.filter((g) =>
          !g.is_historical &&
          (g.member_names ?? []).some((n) => n.toLowerCase() === user?.name?.toLowerCase())
        )
        const seen = new Map()
        mine.forEach((g) => (g.member_names ?? []).forEach((n) => {
          if (!seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n)
        }))
        const names = [...seen.values()].sort((a, b) => a.localeCompare(b))
        setPeople(names)
        setForm((f) => ({
          ...f,
          from_member: f.from_member || names.find((n) => n.toLowerCase() === user?.name?.toLowerCase()) || '',
          to_member: f.to_member || (prefillFriend
            ? names.find((n) => n.toLowerCase() === prefillFriend.toLowerCase()) || ''
            : ''),
        }))
      })
      .catch(() => setPeople([]))
      .finally(() => setLoading(false))
  }, [user?.name, prefillFriend])

  const preview = useMemo(() => {
    const amt = parseFloat(form.amount)
    if (!form.from_member || !form.to_member || !amt || amt <= 0) return ''
    return `${form.from_member} paid ${form.to_member} ${INR(amt)}`
  }, [form.from_member, form.to_member, form.amount])

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!form.from_member || !form.to_member) return setError('Pick who paid whom.')
    if (form.from_member === form.to_member) return setError('A payment needs two different people.')
    const amt = parseFloat(form.amount)
    if (!amt || amt <= 0) return setError('Enter an amount greater than zero.')

    const body = {
      from_member: form.from_member,
      to_member: form.to_member,
      amount: amt,
      date: form.date,
      note: form.note || null,
      recorded_by: user?.name || null,
    }

    setBusy(true)
    try {
      if (editing) await updatePayment(payment.id, body)
      else await createPaymentAuto(body)
      onSaved?.()
      onClose?.()
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not save that payment.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!confirm('Delete this payment? The balances it settled will go back up.')) return
    setBusy(true)
    try {
      await deletePayment(payment.id, user?.name)
      onSaved?.()
      onClose?.()
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not delete that payment.')
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-field-950/80 flex items-center justify-center z-50 px-5"
      onClick={onClose}
    >
      <div
        className="bg-cream border border-amber-200 rounded-xl shadow-2xl w-full max-w-sm max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-amber-200">
          <h3 className="text-xs font-bold text-gray-800">{editing ? 'Edit payment' : 'Record a payment'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-base leading-none">×</button>
        </div>

        <form onSubmit={submit} className="p-4 space-y-2.5">
          <p className="text-[11px] text-gray-500 leading-snug">
            {editing
              ? 'Correcting this updates every balance it affected — the old amount is undone first.'
              : "Logging a real transfer reduces what one person owes the other — or clears it. It's applied to whichever group that debt sits in."}
          </p>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="label text-[10px] mb-1">Who paid</label>
              <select
                className="input py-2.5"
                value={form.from_member}
                onChange={(e) => setForm((f) => ({ ...f, from_member: e.target.value }))}
              >
                <option value="">{loading ? 'Loading…' : 'Select…'}</option>
                {people.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="label text-[10px] mb-1">Paid to</label>
              <select
                className="input py-2.5"
                value={form.to_member}
                onChange={(e) => setForm((f) => ({ ...f, to_member: e.target.value }))}
              >
                <option value="">{loading ? 'Loading…' : 'Select…'}</option>
                {people.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="label text-[10px] mb-1">Amount (₹)</label>
              <input
                className="input py-2.5 font-bold"
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              />
            </div>
            <div>
              <label className="label text-[10px] mb-1">Date</label>
              <input
                className="input py-2.5"
                type="date"
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              />
            </div>
          </div>

          <div>
            <label className="label text-[10px] mb-1">Note (optional)</label>
            <input
              className="input py-2.5"
              placeholder="e.g. UPI, cash"
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            />
          </div>

          {preview && (
            <p className="text-[11px] font-bold text-gray-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
              {preview}
            </p>
          )}

          {error && (
            <p className="text-[11px] text-red-600 bg-red-50 border border-red-100 rounded-md px-2.5 py-1.5">{error}</p>
          )}

          <button type="submit" className="btn-primary text-sm py-2.5" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Record payment'}
          </button>

          {editing && (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="w-full text-center text-[11px] font-bold text-red-500 hover:text-red-600 py-1"
            >
              Delete this payment
            </button>
          )}
        </form>
      </div>
    </div>
  )
}
