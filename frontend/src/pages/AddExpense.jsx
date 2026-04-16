import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getGroups, createExpense } from '../api'
import LoadingSpinner from '../components/LoadingSpinner'

const CATEGORIES = [
  'Food','Drinks','Snacks','Travel - Cab','Travel - Train',
  'Hotel','Movie','Shopping','Groceries','Other',
]

export default function AddExpense() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const defaultGroup = params.get('group') || ''

  const [groups, setGroups]         = useState([])
  const [loading, setLoading]       = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]           = useState('')
  const [members, setMembers]       = useState([])

  const [form, setForm] = useState({
    group_id: defaultGroup,
    date: new Date().toISOString().split('T')[0],
    category: '',
    title: '',
    amount: '',
    paid_by: '',
    divider: '',
    notes: '',
  })

  useEffect(() => {
    getGroups()
      .then((r) => setGroups(r.data))
      .catch(() => setError('Could not reach server. Please try again.'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!form.group_id) { setMembers([]); return }
    import('../api').then(({ getGroup }) =>
      getGroup(form.group_id).then((r) => {
        setMembers(r.data.members || [])
        const n = r.data.members?.length || 2
        setForm((f) => ({ ...f, divider: String(n) }))
      })
    )
  }, [form.group_id, groups])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (!form.group_id) return setError('Please select a group')
    if (!form.amount || isNaN(form.amount)) return setError('Enter a valid amount')
    if (!form.paid_by) return setError('Select who paid')

    setSubmitting(true)
    try {
      await createExpense({
        group_id: Number(form.group_id),
        date: form.date || null,
        category: form.category || null,
        title: form.title || null,
        amount: parseFloat(form.amount),
        paid_by: form.paid_by,
        divider: Number(form.divider) || members.length || 2,
        notes: form.notes || null,
      })
      nav(`/groups/${form.group_id}`)
    } catch (err) {
      setError(err?.response?.data?.detail || 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <LoadingSpinner text="Loading groups…" />

  return (
    <div className="pb-28 md:pb-10">
      {/* Header */}
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-white border-b border-gray-100 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => nav(-1)} className="btn-ghost">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-bold">Add Expense</h1>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="px-5 mt-5 space-y-4 max-w-2xl">
        {/* Group */}
        <div>
          <label className="label">Group *</label>
          <select className="input" value={form.group_id} onChange={set('group_id')}>
            <option value="">Select a group…</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.emoji} {g.name}</option>
            ))}
          </select>
        </div>

        {/* Amount */}
        <div>
          <label className="label">Amount (₹) *</label>
          <input
            className="input text-2xl font-bold"
            type="number"
            placeholder="0"
            min="1"
            step="0.01"
            value={form.amount}
            onChange={set('amount')}
          />
        </div>

        {/* Paid by */}
        <div>
          <label className="label">Paid by *</label>
          {members.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {members.map((m) => (
                <button
                  type="button"
                  key={m.id}
                  onClick={() => setForm((f) => ({ ...f, paid_by: m.name }))}
                  className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                    form.paid_by === m.name ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {m.name}
                </button>
              ))}
            </div>
          ) : (
            <input className="input" placeholder="Name of person who paid" value={form.paid_by} onChange={set('paid_by')} />
          )}
        </div>

        {/* Split between */}
        <div>
          <label className="label">Split between (# people)</label>
          <div className="flex gap-2 flex-wrap">
            {[2,3,4,5].map((n) => (
              <button
                type="button"
                key={n}
                onClick={() => setForm((f) => ({ ...f, divider: String(n) }))}
                className={`w-12 h-12 rounded-xl text-sm font-bold transition-colors ${
                  String(form.divider) === String(n) ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-700'
                }`}
              >
                {n}
              </button>
            ))}
            <input
              className="input w-20"
              type="number"
              min="1"
              placeholder="Other"
              value={[2,3,4,5].includes(Number(form.divider)) ? '' : form.divider}
              onChange={set('divider')}
            />
          </div>
          {form.amount && form.divider && (
            <p className="text-xs text-gray-400 mt-1">
              Each person pays: <span className="font-semibold text-brand-600">
                ₹{(parseFloat(form.amount) / parseInt(form.divider)).toFixed(2)}
              </span>
            </p>
          )}
        </div>

        {/* Category */}
        <div>
          <label className="label">Category</label>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <button
                type="button"
                key={c}
                onClick={() => setForm((f) => ({ ...f, category: f.category === c ? '' : c }))}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  form.category === c ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        {/* Title */}
        <div>
          <label className="label">Description (optional)</label>
          <input className="input" placeholder="e.g. dinner at Punjab Grill" value={form.title} onChange={set('title')} />
        </div>

        {/* Date */}
        <div>
          <label className="label">Date</label>
          <input className="input" type="date" value={form.date} onChange={set('date')} />
        </div>

        {/* Notes */}
        <div>
          <label className="label">Notes (optional)</label>
          <textarea className="input resize-none" rows={2} placeholder="Any extra notes…" value={form.notes} onChange={set('notes')} />
        </div>

        {error && <p className="text-sm text-red-500 bg-red-50 rounded-xl px-4 py-3">{error}</p>}

        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? 'Saving…' : 'Add Expense'}
        </button>
      </form>
    </div>
  )
}
