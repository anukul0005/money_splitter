import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getGroups, createExpense } from '../api'
import LoadingSpinner from '../components/LoadingSpinner'

const CATEGORIES = [
  'Food','Drinks','Snacks','Travel - Cab','Travel - Train',
  'Hotel','Movie','Shopping','Groceries','Other',
]

const STORED_GROUP_KEY = 'splitter_last_group'

export default function AddExpense() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const urlGroup   = params.get('group') || ''
  const defaultGroup = urlGroup || localStorage.getItem(STORED_GROUP_KEY) || ''

  const [groups, setGroups]               = useState([])
  const [loading, setLoading]             = useState(true)
  const [submitting, setSubmitting]       = useState(false)
  const [error, setError]                 = useState('')
  const [successCount, setSuccessCount]   = useState(0)
  const [members, setMembers]             = useState([])

  // Split mode state
  const [splitMode, setSplitMode]               = useState('equal')
  const [gentlemanFlipped, setGentlemanFlipped] = useState(false)
  const [customPcts, setCustomPcts]             = useState({})

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

  const amountRef = useRef(null)

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
        const ms = r.data.members || []
        setMembers(ms)
        setForm((f) => ({ ...f, divider: String(ms.length || 2) }))
        setSplitMode('equal')
        setGentlemanFlipped(false)
        setCustomPcts(Object.fromEntries(ms.map((m) => [m.name, ''])))
      })
    )
  }, [form.group_id, groups])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const buildSplitJson = () => {
    const amt = parseFloat(form.amount)
    if (!amt) return null

    if (splitMode === 'gentleman' && members.length === 2) {
      const [pct0, pct1] = gentlemanFlipped ? [35, 65] : [65, 35]
      return JSON.stringify({
        [members[0].name]: Math.round(amt * pct0) / 100,
        [members[1].name]: Math.round(amt * pct1) / 100,
      })
    }

    if (splitMode === 'custom') {
      const obj = {}
      members.forEach((m) => {
        obj[m.name] = Math.round(amt * Number(customPcts[m.name] || 0)) / 100
      })
      return JSON.stringify(obj)
    }

    return null
  }

  const customTotal = members.reduce((s, m) => s + Number(customPcts[m.name] || 0), 0)

  const resetExpenseFields = (gid) => {
    setForm({
      group_id: gid,
      date: new Date().toISOString().split('T')[0],
      category: '',
      title: '',
      amount: '',
      paid_by: '',
      divider: String(members.length || 2),
      notes: '',
    })
    setSplitMode('equal')
    setGentlemanFlipped(false)
    setCustomPcts(Object.fromEntries(members.map((m) => [m.name, ''])))
    setTimeout(() => amountRef.current?.focus(), 50)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (!form.group_id) return setError('Please select a group')
    if (!form.amount || isNaN(form.amount)) return setError('Enter a valid amount')
    if (!form.paid_by) return setError('Select who paid')
    if (splitMode === 'custom' && Math.abs(customTotal - 100) > 0.1)
      return setError('Custom percentages must add up to 100%')

    setSubmitting(true)
    try {
      await createExpense({
        group_id:   Number(form.group_id),
        date:       form.date || null,
        category:   form.category || null,
        title:      form.title || null,
        amount:     parseFloat(form.amount),
        paid_by:    form.paid_by,
        divider:    splitMode === 'equal' ? (Number(form.divider) || members.length || 2) : members.length,
        notes:      form.notes || null,
        split_json: buildSplitJson(),
      })
      localStorage.setItem(STORED_GROUP_KEY, form.group_id)
      setSuccessCount((n) => n + 1)
      resetExpenseFields(form.group_id)
    } catch (err) {
      setError(err?.response?.data?.detail || 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <LoadingSpinner text="Loading groups…" />

  const selectedGroup = groups.find((g) => String(g.id) === String(form.group_id))

  return (
    <div className="pb-28 md:pb-10">
      {/* Header */}
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream border-b border-amber-100/60 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => nav(form.group_id ? `/groups/${form.group_id}` : -1)} className="btn-ghost">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold">Add Expense</h1>
            {selectedGroup && (
              <p className="text-xs text-brand-600 font-semibold mt-0.5">{selectedGroup.name}</p>
            )}
          </div>
          {successCount > 0 && (
            <span className="text-xs font-black text-brand-600 bg-brand-400/10 border border-brand-400/20 px-2.5 py-1">
              {successCount} added
            </span>
          )}
        </div>
      </div>

      {/* Success banner */}
      {successCount > 0 && (
        <div className="mx-5 mt-4 bg-brand-400/10 border border-brand-400/30 px-4 py-2.5 flex items-center justify-between">
          <p className="text-sm font-bold text-brand-700">Expense saved. Add another below.</p>
          <button
            className="text-xs font-black text-brand-600 underline"
            onClick={() => nav(`/groups/${form.group_id}`)}
          >
            Done
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="px-5 mt-5 space-y-4 max-w-2xl">
        {/* Group */}
        <div>
          <label className="label">Group *</label>
          <select className="input" value={form.group_id} onChange={set('group_id')}>
            <option value="">Select a group…</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </div>

        {/* Amount */}
        <div>
          <label className="label">Amount (₹) *</label>
          <input
            ref={amountRef}
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
                  className={`px-4 py-2 text-sm font-bold transition-colors border ${
                    form.paid_by === m.name
                      ? 'bg-brand-400 text-gray-900 border-brand-400'
                      : 'bg-amber-50 text-gray-700 border-amber-200'
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

        {/* Split section */}
        <div>
          <label className="label">Split</label>

          {members.length > 0 && (
            <div className="flex gap-2 flex-wrap mb-3">
              <button
                type="button"
                onClick={() => setSplitMode('equal')}
                className={`px-3 py-1.5 text-xs font-bold transition-colors border ${
                  splitMode === 'equal' ? 'bg-brand-400 text-gray-900 border-brand-400' : 'bg-amber-50 text-gray-600 border-amber-200'
                }`}
              >
                Equal
              </button>
              {members.length === 2 && (
                <button
                  type="button"
                  onClick={() => setSplitMode('gentleman')}
                  className={`px-3 py-1.5 text-xs font-bold transition-colors border ${
                    splitMode === 'gentleman' ? 'bg-amber-400 text-white border-amber-400' : 'bg-amber-50 text-gray-600 border-amber-200'
                  }`}
                >
                  Gentleman's (65/35)
                </button>
              )}
              <button
                type="button"
                onClick={() => setSplitMode('custom')}
                className={`px-3 py-1.5 text-xs font-bold transition-colors border ${
                  splitMode === 'custom' ? 'bg-purple-500 text-white border-purple-500' : 'bg-amber-50 text-gray-600 border-amber-200'
                }`}
              >
                Custom %
              </button>
            </div>
          )}

          {/* Equal mode */}
          {splitMode === 'equal' && (
            <>
              <div className="flex gap-2 flex-wrap">
                {[2,3,4,5].map((n) => (
                  <button
                    type="button"
                    key={n}
                    onClick={() => setForm((f) => ({ ...f, divider: String(n) }))}
                    className={`w-12 h-12 text-sm font-bold transition-colors border ${
                      String(form.divider) === String(n)
                        ? 'bg-brand-400 text-gray-900 border-brand-400'
                        : 'bg-amber-50 text-gray-700 border-amber-200'
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
                <p className="text-xs text-gray-500 mt-1.5">
                  Each pays: <span className="font-black text-brand-600">₹{(parseFloat(form.amount) / parseInt(form.divider)).toFixed(2)}</span>
                </p>
              )}
            </>
          )}

          {/* Gentleman's mode */}
          {splitMode === 'gentleman' && members.length === 2 && (
            <div className="space-y-2">
              {members.map((m, i) => {
                const pct = gentlemanFlipped ? (i === 0 ? 35 : 65) : (i === 0 ? 65 : 35)
                const amt = form.amount ? (Math.round(parseFloat(form.amount) * pct) / 100).toFixed(2) : null
                return (
                  <div key={m.id} className="flex items-center gap-3 bg-amber-50 border border-amber-200 px-3 py-2.5">
                    <span className="text-sm font-bold text-gray-800 flex-1">{m.name}</span>
                    <span className="text-xs font-black text-amber-700 bg-amber-100 px-2 py-0.5">{pct}%</span>
                    {amt && <span className="text-sm font-black text-gray-900">₹{amt}</span>}
                  </div>
                )
              })}
              <button
                type="button"
                onClick={() => setGentlemanFlipped((f) => !f)}
                className="text-xs text-amber-600 font-bold flex items-center gap-1 mt-1"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" /></svg>
                Swap ratios
              </button>
            </div>
          )}

          {/* Custom % mode */}
          {splitMode === 'custom' && (
            <div className="space-y-2">
              {members.map((m) => {
                const pct = customPcts[m.name] ?? ''
                const amt = form.amount && pct ? (Math.round(parseFloat(form.amount) * Number(pct)) / 100).toFixed(2) : null
                return (
                  <div key={m.id} className="flex items-center gap-2">
                    <span className="text-sm font-bold text-gray-700 w-24 truncate">{m.name}</span>
                    <input
                      type="number" min="0" max="100" step="0.1"
                      className="input w-20 text-center"
                      placeholder="0"
                      value={pct}
                      onChange={(e) => setCustomPcts((p) => ({ ...p, [m.name]: e.target.value }))}
                    />
                    <span className="text-xs text-gray-400 font-bold">%</span>
                    {amt && <span className="text-xs text-gray-600 font-black">₹{amt}</span>}
                  </div>
                )
              })}
              <p className={`text-xs font-black mt-1 ${Math.abs(customTotal - 100) < 0.1 ? 'text-brand-600' : 'text-red-500'}`}>
                Total: {customTotal.toFixed(1)}%{' '}
                {Math.abs(customTotal - 100) < 0.1 ? 'OK' : '— must equal 100%'}
              </p>
            </div>
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
                className={`px-3 py-1.5 text-xs font-bold transition-colors border ${
                  form.category === c
                    ? 'bg-brand-400 text-gray-900 border-brand-400'
                    : 'bg-amber-50 text-gray-600 border-amber-200'
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

        {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 px-4 py-3">{error}</p>}

        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? 'Saving…' : 'Add Expense'}
        </button>
      </form>
    </div>
  )
}
