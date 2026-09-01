import { useEffect, useMemo, useState } from 'react'
import { getGroups, createPayment } from '../api'
import { useUser } from '../UserContext'

/**
 * Record a payment from anywhere — pick the group, then who paid whom.
 *
 * Payments belong to a group (that's what they settle), so the group comes
 * first and the member dropdowns follow from it. Only groups the current user
 * belongs to are offered, and `prefillFriend` preselects the group list down
 * to ones shared with that person.
 */
export default function RecordPaymentModal({ onClose, onSaved, prefillFriend }) {
  const user = useUser()

  const [groups, setGroups]   = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({
    group_id: '', from_member: '', to_member: '', amount: '', note: '',
    date: new Date().toISOString().slice(0, 10),
  })
  const [error, setError] = useState('')
  const [busy, setBusy]   = useState(false)

  useEffect(() => {
    getGroups()
      .then((r) => {
        const mine = r.data.filter((g) =>
          !g.is_historical &&
          (g.member_names ?? []).some((n) => n.toLowerCase() === user?.name?.toLowerCase()) &&
          (!prefillFriend || (g.member_names ?? []).some((n) => n.toLowerCase() === prefillFriend.toLowerCase()))
        )
        setGroups(mine)
        if (mine.length === 1) setForm((f) => ({ ...f, group_id: String(mine[0].id) }))
      })
      .catch(() => setGroups([]))
      .finally(() => setLoading(false))
  }, [user?.name, prefillFriend])

  const selected = useMemo(
    () => groups.find((g) => String(g.id) === String(form.group_id)),
    [groups, form.group_id]
  )

  // Sensible default once a group is chosen: you paying the friend
  useEffect(() => {
    if (!selected) return
    const names = selected.member_names ?? []
    const me = names.find((n) => n.toLowerCase() === user?.name?.toLowerCase()) || ''
    const them = prefillFriend
      ? names.find((n) => n.toLowerCase() === prefillFriend.toLowerCase()) || ''
      : ''
    setForm((f) => ({ ...f, from_member: f.from_member || me, to_member: f.to_member || them }))
  }, [selected, user?.name, prefillFriend])

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!form.group_id) return setError('Pick the group this payment settles.')
    if (!form.from_member || !form.to_member) return setError('Pick who paid whom.')
    if (form.from_member === form.to_member) return setError('A payment needs two different people.')
    const amt = parseFloat(form.amount)
    if (!amt || amt <= 0) return setError('Enter an amount greater than zero.')

    setBusy(true)
    try {
      await createPayment({
        group_id: Number(form.group_id),
        from_member: form.from_member,
        to_member: form.to_member,
        amount: amt,
        date: form.date,
        note: form.note || null,
        recorded_by: user?.name || null,
      })
      onSaved?.()
      onClose?.()
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not record that payment.')
    } finally {
      setBusy(false)
    }
  }

  const members = selected?.member_names ?? []

  return (
    <div
      className="fixed inset-0 bg-field-950/80 flex items-center justify-center z-50 px-5"
      onClick={onClose}
    >
      <div
        className="bg-cream border border-amber-200 rounded-xl shadow-2xl w-full max-w-sm max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-amber-200">
          <h3 className="text-sm font-bold text-gray-800">Record a payment</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
        </div>

        <form onSubmit={submit} className="p-5 space-y-3">
          <p className="text-xs text-gray-500 leading-relaxed">
            Logging a real transfer reduces what one person owes the other — or clears it.
          </p>

          <div>
            <label className="label">Group</label>
            <select
              className="input"
              value={form.group_id}
              onChange={(e) => setForm((f) => ({ ...f, group_id: e.target.value, from_member: '', to_member: '' }))}
            >
              <option value="">{loading ? 'Loading…' : 'Select a group…'}</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            {!loading && groups.length === 0 && (
              <p className="text-[10px] text-gray-400 mt-1">
                No shared groups{prefillFriend ? ` with ${prefillFriend}` : ''}.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Who paid</label>
              <select
                className="input"
                value={form.from_member}
                disabled={!selected}
                onChange={(e) => setForm((f) => ({ ...f, from_member: e.target.value }))}
              >
                <option value="">Select…</option>
                {members.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Paid to</label>
              <select
                className="input"
                value={form.to_member}
                disabled={!selected}
                onChange={(e) => setForm((f) => ({ ...f, to_member: e.target.value }))}
              >
                <option value="">Select…</option>
                {members.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Amount (₹)</label>
              <input
                className="input font-bold"
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              />
            </div>
            <div>
              <label className="label">Date</label>
              <input
                className="input"
                type="date"
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              />
            </div>
          </div>

          <div>
            <label className="label">Note (optional)</label>
            <input
              className="input"
              placeholder="e.g. UPI, cash"
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            />
          </div>

          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>
          )}

          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Recording…' : 'Record payment'}
          </button>
        </form>
      </div>
    </div>
  )
}
