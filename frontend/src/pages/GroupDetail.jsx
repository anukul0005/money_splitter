import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getGroup, getSettlement, getGroupStats, deleteExpense, deleteGroup } from '../api'
import LoadingSpinner from '../components/LoadingSpinner'
import ExpenseEditModal from '../components/ExpenseEditModal'
import { useUser } from '../UserContext'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

export default function GroupDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const currentUser = useUser()

  const [group, setGroup]               = useState(null)
  const [settlement, setSettlement]     = useState(null)
  const [stats, setStats]               = useState(null)
  const [loading, setLoading]           = useState(true)
  const [tab, setTab]                   = useState('expenses')
  const [editingExpense, setEditingExp] = useState(null)   // expense being edited


  const fetchData = () =>
    Promise.all([getGroup(id), getSettlement(id), getGroupStats(id)])
      .then(([g, s, st]) => {
        setGroup(g.data)
        setSettlement(s.data)
        setStats(st.data)
      })

  // Silent refresh — no spinner, preserves scroll position
  const reload = () => fetchData()

  useEffect(() => {
    setLoading(true)
    fetchData().finally(() => setLoading(false))
  }, [id])

  const handleDeleteExpense = async (expId) => {
    if (!confirm('Delete this expense?')) return
    await deleteExpense(expId, currentUser?.name)
    reload()
  }

  const handleDeleteGroup = async () => {
    if (!confirm(`Delete group "${group.name}" and all its expenses? This cannot be undone.`)) return
    await deleteGroup(id)
    nav('/')
  }

  if (loading) return <LoadingSpinner />
  if (!group)  return <p className="p-5 text-gray-500">Group not found.</p>

  // A one-person group has nothing to settle and no per-person split to edit
  const isSolo = group.members.length === 1



  return (
    <div className="pb-24 md:pb-8">
      {/* Header */}
      <div className="bg-cream border-b border-amber-100/60 px-5 pt-10 md:pt-6 pb-3 sticky top-0 z-10">
        <div className="flex items-start gap-3">
          <button onClick={() => nav(-1)} className="btn-ghost mt-1">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold leading-tight">{group.name}</h1>
            <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{group.members.map((m) => m.name).join(' · ')}</p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              className="text-gray-400 hover:text-gray-600 transition-colors p-1"
              onClick={() => nav(`/groups/${id}/edit`)}
              title="Edit group"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            <button
              className="text-gray-400 hover:text-red-500 transition-colors p-1"
              onClick={handleDeleteGroup}
              title="Delete group"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
            <button
              className="bg-brand-400 text-white text-xs font-bold px-3 py-1.5 shadow-sm ml-1"
              onClick={() => nav(`/add?group=${id}`)}
            >
              + Add
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mt-3">
          {/* Charts moved to the master group, where they cover the whole member set */}
          {([['expenses','Expenses'],...(isSolo ? [] : [['settle','Settle Up']])]).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setTab(v)}
              className={`flex-1 py-2 text-xs font-bold transition-colors border ${
                tab === v
                  ? 'bg-brand-400 text-white border-brand-400'
                  : 'text-gray-500 border-transparent hover:bg-amber-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary strip */}
      <div className="px-5 py-3 flex gap-2">
        <div className="card flex-1 text-center py-3">
          <p className="text-xs text-gray-400">Total</p>
          <p className="text-base font-black text-brand-600">{INR(stats?.total || 0)}</p>
        </div>
        <div className="card flex-1 text-center py-3">
          <p className="text-xs text-gray-400">Expenses</p>
          <p className="text-base font-black">{group.expenses.length}</p>
        </div>
        <div className="card flex-1 text-center py-3">
          <p className="text-xs text-gray-400">People</p>
          <p className="text-base font-black">{group.members.length}</p>
        </div>
      </div>

      {/* Expenses tab */}
      {tab === 'expenses' && (
        <div className="px-5 grid grid-cols-1 md:grid-cols-2 gap-2">
          {group.expenses.length === 0 && (
            <div className="col-span-2 text-center py-12 text-gray-400">
              <svg className="w-10 h-10 mx-auto mb-2 text-gray-300" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
              </svg>
              <p className="text-sm mb-4">No expenses yet</p>
              <button
                onClick={() => nav(`/add?group=${id}`)}
                className="btn-primary px-6 py-3 text-sm"
              >
                + Add First Expense
              </button>
            </div>
          )}
          {[...group.expenses]
            .sort((a, b) => {
              if (!a.date && !b.date) return 0
              if (!a.date) return 1
              if (!b.date) return -1
              return b.date.localeCompare(a.date)
            })
            .map((e) => {
            const memberCount   = group.members.length
            const isPartialSplit = !e.split_json && e.divider < memberCount && e.divider > 0

            // Parse split_json
            let splitEntries = null
            let splitLabel   = null
            if (e.split_json) {
              try {
                const obj = JSON.parse(e.split_json)
                splitEntries = Object.entries(obj)
                if (splitEntries.length === 2) {
                  const [, a0] = splitEntries[0]
                  const [, a1] = splitEntries[1]
                  const r0 = Math.round((a0 / e.amount) * 100)
                  const r1 = Math.round((a1 / e.amount) * 100)
                  const lo = Math.min(r0, r1), hi = Math.max(r0, r1)
                  splitLabel = (lo === 35 && hi === 65) ? "Gentleman's 65/35" : `Custom ${r0}/${r1}`
                } else {
                  splitLabel = 'Custom split'
                }
              } catch { /* ignore */ }
            }

            // Settlement helpers
            const actualParticipants = e.participants
              ? e.participants.split(',').map((s) => s.trim()).filter(Boolean)
              : group.members.map((m) => m.name)
            const debtors = actualParticipants.filter(
              (n) => n.toLowerCase() !== e.paid_by?.toLowerCase()
            )
            const getOwed = (name) => {
              if (e.split_json) {
                try { const obj = JSON.parse(e.split_json); return obj[name] ?? 0 }
                catch { return 0 }
              }
              return e.individual_amount || (e.amount / (e.divider || 1))
            }

            return (
              <div key={e.id} className="card">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 bg-amber-50 border border-amber-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <svg className="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
                    </svg>
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-gray-900 leading-tight" style={{ wordBreak: 'break-word' }}>
                      {e.title || e.category || 'Expense'}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {e.paid_by} · {e.date || '—'}
                      {e.payment_mode && (
                        <span className="ml-1.5 inline-block bg-amber-50 border border-amber-200 rounded-md px-1.5 py-px text-[10px] font-bold text-amber-700 tracking-wide">
                          {e.payment_mode.replace('_', ' ').toUpperCase()}
                        </span>
                      )}
                    </p>

                    {/* Custom / gentleman's split — per-member breakdown */}
                    {splitEntries && (
                      <div className="mt-1.5 border border-amber-300 rounded-md bg-amber-50/60 px-2 py-1.5 space-y-1">
                        <p className="text-[10px] font-black text-amber-700 tracking-widest mb-0.5">
                          {splitLabel}
                        </p>
                        {splitEntries.map(([name, amt]) => {
                          const pct = Math.round((amt / e.amount) * 100)
                          return (
                            <div key={name} className="flex items-center justify-between gap-2">
                              <span className="text-xs font-bold text-gray-700">{name}</span>
                              <span className="text-xs text-gray-400">{pct}%</span>
                              <span className="text-xs font-black text-gray-900">{INR(amt)}</span>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {/* Partial equal split badge */}
                    {isPartialSplit && (
                      <span className="inline-block mt-1 text-[10px] font-bold text-orange-600 bg-orange-50 border border-orange-200 px-1.5 py-0.5 tracking-wide">
                        {e.divider}/{memberCount} split
                      </span>
                    )}
                  </div>

                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-black text-gray-900">{INR(e.amount)}</p>
                    {!e.split_json && !isSolo && (
                      <p className="text-xs text-brand-600">{INR(e.individual_amount)}/ea</p>
                    )}
                  </div>

                  {/* Action buttons — row layout with generous tap targets for mobile */}
                  <div className="flex items-center ml-1 flex-shrink-0">
                    <button
                      onClick={() => setEditingExp(e)}
                      className="p-2 text-gray-300 hover:text-brand-500 transition-colors"
                      title="Edit expense"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDeleteExpense(e.id)}
                      className="p-2 text-gray-300 hover:text-red-400 transition-colors"
                      title="Delete expense"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Who owes what for this expense. Clearing a debt happens in
                    the Settle Up tab by recording a payment, not per expense. */}
                {debtors.length > 0 && (
                  <div className="mt-2.5 border-t border-amber-100 pt-2.5 space-y-1.5">
                    {debtors.map((name) => (
                      <div key={name} className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-gray-600 flex-1 min-w-0 truncate">{name}</span>
                        <span className="text-[10px] font-bold text-gray-500 bg-amber-50 border border-amber-200 rounded-md px-1.5 py-0.5 flex-shrink-0">
                          share {INR(getOwed(name))}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}


      {/* Settle Up tab */}
      {tab === 'settle' && settlement && (
        <div className="px-5 mt-2 md:grid md:grid-cols-2 md:gap-4 space-y-3 md:space-y-0">
          {/* Balances */}
          <div className="card">
            <h3 className="text-xs font-bold text-gray-500 mb-3">Individual balances</h3>
            <div className="space-y-3">
              {settlement.balances.map((b) => (
                <div key={b.member} className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-gray-100 flex items-center justify-center font-black text-gray-600 text-sm flex-shrink-0">
                    {b.member[0].toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold truncate">{b.member}</p>
                    <p className="text-xs text-gray-400">Paid {INR(b.paid)} · Share {INR(b.share)}</p>
                  </div>
                  <div className={`text-sm font-black flex-shrink-0 ${b.net >= 0 ? 'text-brand-600' : 'text-red-500'}`}>
                    {b.net >= 0 ? `+${INR(b.net)}` : `-${INR(Math.abs(b.net))}`}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Transactions */}
          <div className="card">
            <h3 className="text-xs font-bold text-gray-500 mb-3">Who pays whom?</h3>
            {settlement.transactions.length === 0 && (!settlement.past_payments || settlement.past_payments.length === 0) ? (
              <p className="text-sm text-brand-600 font-black text-center py-4">All settled</p>
            ) : (
              <div className="space-y-2">
                {/* Past (settled) payments */}
                {settlement.past_payments && settlement.past_payments.map((p, i) => (
                  <div key={`past-${i}`} className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-md px-3 py-2.5">
                    <svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    <span className="font-bold text-sm text-green-700 flex-shrink-0">{p.from_member}</span>
                    <span className="text-xs text-green-600 flex-shrink-0">paid</span>
                    <span className="font-bold text-sm text-green-700 flex-1 min-w-0 truncate">{p.to_member}</span>
                    <div className="text-right flex-shrink-0">
                      <span className="font-black text-green-700 text-sm">{INR(p.settled_amount)}</span>
                      {p.total_owed > p.settled_amount + 0.5 && (
                        <p className="text-xs text-gray-400">of {INR(p.total_owed)}</p>
                      )}
                    </div>
                  </div>
                ))}
                {/* Still outstanding — tap one to pre-fill the payment form */}
                {settlement.transactions.map((t, i) => (
                  <div
                    key={`pending-${i}`}
                    className="w-full text-left flex items-center gap-2 bg-red-50 border border-red-100 rounded-md px-3 py-2.5"
                  >
                    <span className="font-bold text-sm text-red-700 flex-shrink-0">{t.from_member}</span>
                    <svg className="w-4 h-4 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                    </svg>
                    <span className="font-bold text-sm text-red-700 flex-1 min-w-0 truncate">{t.to_member}</span>
                    <span className="font-black text-brand-700 text-sm flex-shrink-0">{INR(t.amount)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recorded payments — read only. Recording now happens from the
              Friends page, which covers every group in one place. */}
          {settlement.payments?.length > 0 && (
          <div className="card md:col-span-2">
            <h4 className="text-xs font-bold text-gray-500 mb-2">Recorded payments</h4>
              <div>
                <div className="space-y-2">
                  {settlement.payments.map((p) => (
                    <div key={p.id} className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-md px-3 py-2">
                      <svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                      <span className="text-sm text-green-800 flex-1 min-w-0 truncate">
                        <span className="font-bold">{p.from_member}</span>
                        <span className="text-green-600"> paid </span>
                        <span className="font-bold">{p.to_member}</span>
                        {p.note && <span className="text-xs text-green-600"> · {p.note}</span>}
                      </span>
                      <span className="text-xs text-gray-400 flex-shrink-0 hidden sm:inline">{p.date || ''}</span>
                      <span className="font-black text-green-700 text-sm flex-shrink-0">{INR(p.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          )}
        </div>
      )}

      {/* Expense Edit Modal */}
      {editingExpense && (
        <ExpenseEditModal
          expense={editingExpense}
          group={group}
          onSave={() => { setEditingExp(null); reload() }}
          onClose={() => setEditingExp(null)}
        />
      )}
    </div>
  )
}
