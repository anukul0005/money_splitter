import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getLoans, createLoan, repayLoan, deleteLoan,
  createBill, markChargePaid, stopBill, getFriends,
} from '../api'
import LoadingSpinner from '../components/LoadingSpinner'
import PeoplePicker from '../components/PeoplePicker'
import { useUser } from '../UserContext'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const same = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase()

/**
 * /loans — money lent and borrowed outside any group, and shared bills
 * (Netflix, rent...) billed to everyone on the same day every month.
 * Interest, when a loan has it, only ever appears once it's overdue.
 */
export default function Loans() {
  const nav  = useNavigate()
  const user = useUser()

  const [data, setData]       = useState(null)
  const [people, setPeople]   = useState([])
  const [tab, setTab]         = useState('loans')
  const [error, setError]     = useState('')
  const [showForm, setShowForm] = useState(false)

  const [loan, setLoan] = useState({ role: 'lent', other: '', amount: '', due_date: '', interest: false, note: '' })
  const [bill, setBill] = useState({ title: '', amount: '', members: [], day_of_month: 1 })

  const load = () => getLoans().then((r) => setData(r.data)).catch(() => setError('Could not load.'))

  useEffect(() => {
    load()
    getFriends().then((r) => setPeople(r.data.map((f) => f.name))).catch(() => {})
  }, [])

  const run = async (fn) => {
    setError('')
    try { await fn(); await load() }
    catch (e) { setError(e.response?.data?.detail || 'Something went wrong.') }
  }

  const submitLoan = (e) => {
    e.preventDefault()
    if (!loan.other || !loan.amount || !loan.due_date) return setError('Person, amount and due date are required.')
    run(async () => {
      await createLoan({ ...loan, amount: parseFloat(loan.amount), note: loan.note || null })
      setLoan({ role: 'lent', other: '', amount: '', due_date: '', interest: false, note: '' })
      setShowForm(false)
    })
  }

  const submitBill = (e) => {
    e.preventDefault()
    if (!bill.title || !bill.amount || bill.members.length === 0) return setError('Title, amount and at least one person are required.')
    run(async () => {
      await createBill({ ...bill, amount: parseFloat(bill.amount), day_of_month: Number(bill.day_of_month) || 1 })
      setBill({ title: '', amount: '', members: [], day_of_month: 1 })
      setShowForm(false)
    })
  }

  const repay = (l) => {
    const raw = window.prompt(`Amount paid back (outstanding ${INR(l.total_due)}):`, String(l.total_due))
    const amt = parseFloat(raw)
    if (!raw || isNaN(amt) || amt <= 0) return
    run(() => repayLoan(l.id, { amount: amt }))
  }

  if (!data) return <LoadingSpinner />

  const me = user?.name
  const t = data.totals

  return (
    <div className="pb-24 md:pb-8">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={() => nav('/')} className="text-xs font-bold text-gray-400 mb-2">← Home</button>
        <h1 className="text-xl font-black tracking-tight">Loans & bills</h1>
        <p className="text-xs text-gray-400 mt-1">
          You owe {INR(t.owe)} · You're owed {INR(t.owed)}
        </p>
        <div className="flex gap-1 mt-3">
          {[['loans', 'Loans'], ['bills', 'Recurring bills']].map(([v, l]) => (
            <button key={v} onClick={() => { setTab(v); setShowForm(false) }}
              className={`flex-1 py-2 text-xs font-bold border ${tab === v ? 'bg-brand-400 text-white border-brand-400' : 'text-gray-500 border-transparent hover:bg-amber-50'}`}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <div className="px-5 mt-4 space-y-3 max-w-2xl">
        {error && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>}

        <button onClick={() => setShowForm((v) => !v)} className="btn-primary py-2.5 text-xs w-full">
          {showForm ? 'Cancel' : tab === 'loans' ? '+ New loan' : '+ New recurring bill'}
        </button>

        {/* ── New loan ── */}
        {showForm && tab === 'loans' && (
          <form onSubmit={submitLoan} className="card space-y-3">
            <div className="flex gap-1">
              {[['lent', 'I lent'], ['borrowed', 'I borrowed']].map(([v, l]) => (
                <button type="button" key={v} onClick={() => setLoan((f) => ({ ...f, role: v }))}
                  className={`flex-1 py-2 text-xs font-bold border ${loan.role === v ? 'bg-brand-400 text-white border-brand-400' : 'bg-amber-50 text-gray-600 border-amber-200'}`}>
                  {l}
                </button>
              ))}
            </div>
            <div>
              <label className="label">{loan.role === 'lent' ? 'Lent to' : 'Borrowed from'} *</label>
              {/* Single pick: choosing again replaces the previous one.
                  allowNew - the person needn't be in any group yet. */}
              <PeoplePicker
                options={people.filter((n) => !same(n, me))}
                selected={loan.other ? [loan.other] : []}
                onChange={(list) => setLoan((f) => ({ ...f, other: list.length ? list[list.length - 1] : '' }))}
                placeholder="Type a name"
                allowNew
              />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="label">Amount (₹) *</label>
                <input className="input" type="number" min="1" step="0.01" value={loan.amount}
                  onChange={(e) => setLoan((f) => ({ ...f, amount: e.target.value }))} />
              </div>
              <div className="flex-1">
                <label className="label">Due date *</label>
                <input className="input" type="date" value={loan.due_date}
                  onChange={(e) => setLoan((f) => ({ ...f, due_date: e.target.value }))} />
              </div>
            </div>
            <label className="flex items-start gap-2 text-xs text-gray-600">
              <input type="checkbox" checked={loan.interest} className="mt-0.5"
                onChange={(e) => setLoan((f) => ({ ...f, interest: e.target.checked }))} />
              <span>
                Charge interest if it's late — nothing if it's repaid by the due date,
                then 3.6% a month, compounding, for each month it stays unpaid.
              </span>
            </label>
            <div>
              <label className="label">Note (optional)</label>
              <input className="input" value={loan.note} onChange={(e) => setLoan((f) => ({ ...f, note: e.target.value }))} />
            </div>
            <button type="submit" className="btn-primary py-2.5 text-xs w-full">Save loan</button>
          </form>
        )}

        {/* ── New bill ── */}
        {showForm && tab === 'bills' && (
          <form onSubmit={submitBill} className="card space-y-3">
            <p className="text-xs text-gray-500">
              You pay this bill; everyone you pick below is billed an equal share
              (including you) automatically, every month.
            </p>
            <div>
              <label className="label">Bill *</label>
              <input className="input" placeholder="e.g. Netflix" value={bill.title}
                onChange={(e) => setBill((f) => ({ ...f, title: e.target.value }))} />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="label">Total (₹) *</label>
                <input className="input" type="number" min="1" step="0.01" value={bill.amount}
                  onChange={(e) => setBill((f) => ({ ...f, amount: e.target.value }))} />
              </div>
              <div className="w-28">
                <label className="label">Bill on day</label>
                <input className="input" type="number" min="1" max="28" value={bill.day_of_month}
                  onChange={(e) => setBill((f) => ({ ...f, day_of_month: e.target.value }))} />
              </div>
            </div>
            <div>
              <label className="label">Shared with *</label>
              <PeoplePicker
                options={people.filter((n) => !same(n, me))}
                selected={bill.members}
                onChange={(list) => setBill((f) => ({ ...f, members: list }))}
                placeholder="Type a name"
                allowNew
              />
              {bill.amount && bill.members.length > 0 && (
                <p className="text-xs text-gray-500 mt-2">
                  Each of {bill.members.length + 1} pays {INR(parseFloat(bill.amount) / (bill.members.length + 1))}
                </p>
              )}
            </div>
            <button type="submit" className="btn-primary py-2.5 text-xs w-full">Start billing monthly</button>
          </form>
        )}

        {/* ── Loans list ── */}
        {tab === 'loans' && (
          data.loans.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No loans yet</p>
          ) : data.loans.map((l) => {
            const iOwe = same(l.borrower, me)
            const other = iOwe ? l.lender : l.borrower
            return (
              <div key={l.id} className={`card ${l.paid ? 'opacity-60' : ''}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-gray-900">
                      {iOwe ? `You owe ${other}` : `${other} owes you`}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      Lent {INR(l.principal)} · due {l.due_date}
                      {l.has_interest ? ' · interest if late' : ' · no interest'}
                    </p>
                    {l.note && <p className="text-xs text-gray-500 mt-0.5">{l.note}</p>}
                  </div>
                  <p className={`text-base font-black shrink-0 ${l.paid ? 'text-gray-400' : iOwe ? 'text-red-600' : 'text-green-600'}`}>
                    {l.paid ? 'Paid' : INR(l.total_due)}
                  </p>
                </div>
                {l.interest > 0 && (
                  <p className="text-xs text-amber-700 mt-1">
                    Includes {INR(l.interest)} interest · {l.months_overdue} month{l.months_overdue !== 1 ? 's' : ''} overdue
                  </p>
                )}
                {l.payments.length > 0 && (
                  <p className="text-[11px] text-gray-400 mt-1">
                    Repaid: {l.payments.map((p) => `${INR(p.amount)} on ${p.date}`).join(', ')}
                  </p>
                )}
                <div className="flex gap-2 mt-3">
                  {!l.paid && (
                    <button onClick={() => repay(l)} className="flex-1 py-2 text-xs font-bold bg-amber-100 border border-amber-300 text-amber-800 rounded-md">
                      Record repayment
                    </button>
                  )}
                  <button
                    onClick={() => confirm('Delete this loan?') && run(() => deleteLoan(l.id))}
                    className="px-3 py-2 text-xs font-bold text-gray-400 hover:text-red-500">
                    Delete
                  </button>
                </div>
              </div>
            )
          })
        )}

        {/* ── Bills list ── */}
        {tab === 'bills' && (
          data.bills.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No recurring bills yet</p>
          ) : data.bills.map((b) => {
            const iPay = same(b.payer, me)
            const share = b.amount / b.members.length
            return (
              <div key={b.id} className="card">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold text-gray-900">{b.title}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {INR(b.amount)} split {b.members.length} ways = {INR(share)} each ·
                      billed on the {b.day_of_month}{b.day_of_month === 1 ? 'st' : 'th'} · paid by {iPay ? 'you' : b.payer}
                    </p>
                    <p className="text-[11px] text-gray-400">{b.members.join(', ')}</p>
                  </div>
                  {iPay && (
                    <button onClick={() => confirm('Stop billing this every month?') && run(() => stopBill(b.id))}
                      className="text-xs font-bold text-gray-400 hover:text-red-500 shrink-0">Stop</button>
                  )}
                </div>
                {b.charges.length > 0 && (
                  <div className="mt-3 space-y-1.5 border-t border-amber-100 pt-2">
                    {b.charges.slice(0, 12).map((c) => (
                      <div key={c.id} className="flex items-center justify-between text-xs gap-2">
                        <span className="text-gray-600">{c.period} · {c.member}</span>
                        <span className="flex items-center gap-2">
                          <span className="font-bold text-gray-800">{INR(c.share)}</span>
                          {iPay ? (
                            <button onClick={() => run(() => markChargePaid(c.id))}
                              className={`px-2 py-0.5 font-bold border rounded ${c.paid ? 'bg-green-50 text-green-700 border-green-200' : 'bg-amber-50 text-amber-800 border-amber-300'}`}>
                              {c.paid ? 'Paid ✓' : 'Mark paid'}
                            </button>
                          ) : (
                            <span className={c.paid ? 'text-green-600 font-bold' : 'text-red-500 font-bold'}>
                              {c.paid ? 'Paid' : 'Due'}
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
