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

  const blankLoan = { role: 'lent', other: '', amount: '', start_date: '', due_date: '', interest: false, note: '',
                      emi: false, emiCount: 3, emiFirst: '', emiRows: [] }
  const [loan, setLoan] = useState(blankLoan)
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

  // "N equal EMIs, one a month from <first date>" - a starting point the
  // rows below stay editable from (shares are % of the principal).
  const addMonthsIso = (iso, n) => {
    const d = new Date(iso + 'T00:00:00')
    const day = d.getDate()
    d.setDate(1); d.setMonth(d.getMonth() + n)
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()))
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const buildRows = (count, first) => {
    const n = Math.max(1, Math.min(60, Number(count) || 1))
    const each = Math.floor((100 / n) * 100) / 100
    return Array.from({ length: n }, (_, i) => ({
      pct: i === n - 1 ? String(Math.round((100 - each * (n - 1)) * 100) / 100) : String(each),
      date: first ? addMonthsIso(first, i) : '',
    }))
  }
  const emiSum = loan.emiRows.reduce((s, r) => s + (parseFloat(r.pct) || 0), 0)

  const submitLoan = (e) => {
    e.preventDefault()
    if (!loan.other || !loan.amount) return setError('Person and amount are required.')
    if (!loan.emi && !loan.due_date) return setError('Give a due date, or convert it to EMIs.')
    if (loan.emi) {
      if (loan.emiRows.length === 0 || loan.emiRows.some((r) => !r.date || !(parseFloat(r.pct) > 0)))
        return setError('Each EMI needs a share and a date.')
      if (Math.abs(emiSum - 100) > 0.01) return setError('EMI shares must add up to 100%.')
    }
    run(async () => {
      await createLoan({
        role: loan.role, other: loan.other, amount: parseFloat(loan.amount),
        start_date: loan.start_date || null,
        due_date: loan.emi ? null : loan.due_date,
        interest: loan.interest, note: loan.note || null,
        emi: loan.emi ? loan.emiRows.map((r) => ({ pct: parseFloat(r.pct), date: r.date })) : null,
      })
      setLoan(blankLoan)
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
                <label className="label">Loan taken on (optional)</label>
                <input className="input" type="date" value={loan.start_date}
                  onChange={(e) => setLoan((f) => ({ ...f, start_date: e.target.value }))} />
              </div>
            </div>

            {!loan.emi && (
              <div>
                <label className="label">Due date *</label>
                <input className="input" type="date" value={loan.due_date}
                  onChange={(e) => setLoan((f) => ({ ...f, due_date: e.target.value }))} />
              </div>
            )}

            <label className="flex items-start gap-2 text-xs text-gray-600">
              <input type="checkbox" checked={loan.emi} className="mt-0.5"
                onChange={(e) => setLoan((f) => ({ ...f, emi: e.target.checked, emiRows: e.target.checked ? buildRows(f.emiCount, f.emiFirst) : [] }))} />
              <span>Convert to EMIs — repay in instalments, each a share of the principal</span>
            </label>

            {loan.emi && (
              <div className="bg-amber-50 border border-amber-200 rounded-md p-3 space-y-2">
                <div className="flex gap-2">
                  <div className="w-24">
                    <label className="label">No. of EMIs</label>
                    <input className="input" type="number" min="1" max="60" value={loan.emiCount}
                      onChange={(e) => setLoan((f) => ({ ...f, emiCount: e.target.value, emiRows: buildRows(e.target.value, f.emiFirst) }))} />
                  </div>
                  <div className="flex-1">
                    <label className="label">First EMI date</label>
                    <input className="input" type="date" value={loan.emiFirst}
                      onChange={(e) => setLoan((f) => ({ ...f, emiFirst: e.target.value, emiRows: buildRows(f.emiCount, e.target.value) }))} />
                  </div>
                </div>
                {loan.emiRows.map((r, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-xs font-bold text-gray-500 w-8">#{i + 1}</span>
                    <div className="relative w-24">
                      <input className="input pr-6 text-right" type="number" min="0" step="any" value={r.pct}
                        onChange={(e) => setLoan((f) => ({ ...f, emiRows: f.emiRows.map((x, j) => j === i ? { ...x, pct: e.target.value } : x) }))} />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">%</span>
                    </div>
                    <input className="input flex-1" type="date" value={r.date}
                      onChange={(e) => setLoan((f) => ({ ...f, emiRows: f.emiRows.map((x, j) => j === i ? { ...x, date: e.target.value } : x) }))} />
                  </div>
                ))}
                <p className={`text-xs font-bold ${Math.abs(emiSum - 100) <= 0.01 ? 'text-green-700' : 'text-red-600'}`}>
                  Total {Math.round(emiSum * 100) / 100}% {Math.abs(emiSum - 100) <= 0.01 ? '✓' : '— must be 100%'}
                </p>
              </div>
            )}

            <label className="flex items-start gap-2 text-xs text-gray-600">
              <input type="checkbox" checked={loan.interest} className="mt-0.5"
                onChange={(e) => setLoan((f) => ({ ...f, interest: e.target.checked }))} />
              <span>
                {loan.emi
                  ? 'Charge interest on any EMI left unpaid after its date: 3.6% a month (x1.036), compounding, for every full month since that EMI date.'
                  : 'Charge interest if it is late: nothing if repaid by the due date, then 3.6% a month, compounding, for each month it stays unpaid.'}
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
                      Lent {INR(l.principal)}{l.start_date ? ` on ${l.start_date}` : ''} · {l.emi ? `last EMI ${l.due_date}` : `due ${l.due_date}`}
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
                {l.installments?.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {l.installments.map((i, k) => (
                      <div key={k} className="flex items-center justify-between text-[11px]">
                        <span className="text-gray-500">EMI {k + 1} · {i.pct}% · {i.date}</span>
                        <span className={i.paid ? 'text-green-600 font-bold' : i.overdue ? 'text-red-600 font-bold' : 'text-gray-700 font-bold'}>
                          {i.paid ? 'Paid ✓' : `${INR(i.balance)}${i.overdue ? ' overdue' : ''}`}
                        </span>
                      </div>
                    ))}
                  </div>
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
