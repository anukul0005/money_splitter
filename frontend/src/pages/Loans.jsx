import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  getLoans, createLoan, repayLoan, deleteLoan,
  createBill, stopBill, repayBill, updateBillDay, getFriends,
  getGmailStatus, getGmailConnectUrl, disconnectGmail,
  listCardBanks, setCardBankPassword, deleteCardBank,
  listCardStatements, scanCardStatements, getScanProgress,
  listUpiIdsFor, createPaymentClaim,
} from '../api'
import { MONEY_CHANGED } from '../components/PaymentClaimsInbox'
import LoadingSpinner from '../components/LoadingSpinner'
import PeoplePicker from '../components/PeoplePicker'
import Dropdown from '../components/Dropdown'
import DatePicker from '../components/DatePicker'
import PayViaUpi from '../components/PayViaUpi'
import { useUser } from '../UserContext'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const same = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase()

const pad2 = (n) => String(n).padStart(2, '0')

// "YYYY-MM" for the current month, and the 11 before it - current one
// first, so the picker defaults to it.
const recentMonths = (count = 12) => {
  const now = new Date()
  const out = []
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    out.push({
      value: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`,
      label: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
    })
  }
  return out
}

// Each bank bills on its own predictable few days of the month - searching
// just that window (with a couple of days' cushion either side, since the
// email doesn't always land the same day the bill was cut) finds a bill far
// faster than scanning everything back 9 months. `monthValue` is "YYYY-MM",
// so the same presets work for "last month's ICICI bill" too, not just this
// month's.
const bankDatePresets = (monthValue) => {
  const [y, m1] = monthValue.split('-').map(Number)
  const y0 = y, m = m1 - 1
  const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  const range = (startDay, endDay, cushion = 2) => ({
    from: fmt(new Date(y0, m, startDay - cushion)),
    to: fmt(new Date(y0, m, endDay + cushion)),
  })
  return [
    { label: 'ICICI (~6th)', ...range(6, 6) },
    { label: 'Kotak / SBI / Axis (20-22)', ...range(20, 22) },
    { label: 'Jupiter (15-16)', ...range(15, 16) },
  ]
}

/**
 * /loans — money lent and borrowed outside any group, and shared bills
 * (Netflix, rent...) billed to everyone on the same day every month.
 * Interest, when a loan has it, only ever appears once it's overdue.
 */
export default function Loans() {
  const nav  = useNavigate()
  const user = useUser()
  const [params, setParams] = useSearchParams()

  const [data, setData]       = useState(null)
  const [people, setPeople]   = useState([])
  const [tab, setTab]         = useState(params.get('tab') === 'cards' ? 'cards' : 'loans')
  const [error, setError]     = useState('')
  const [showForm, setShowForm] = useState(false)

  // ── Credit Cards (Gmail-connected statement scanning) ──
  const [gmail, setGmail]           = useState(null)   // { connected, gmail_address, ... }
  const [banks, setBanks]           = useState([])
  const [statements, setStatements] = useState([])
  const [bankName, setBankName]     = useState('')
  const [bankPw, setBankPw]         = useState('')
  const [cardBusy, setCardBusy]     = useState(false)
  const [cardProgress, setCardProgress] = useState(null)   // { status, total, done, found, skipped, failed, error }
  const [cardFrom, setCardFrom]     = useState('')
  const [cardTo, setCardTo]         = useState('')
  const [cardMonth, setCardMonth]   = useState(recentMonths(1)[0].value)
  const [cardError, setCardError]   = useState('')
  const [cardMsg, setCardMsg]       = useState(
    params.get('gmail') === 'connected' ? 'Gmail connected.'
      : params.get('gmail') === 'error' ? `Couldn't connect Gmail (${params.get('reason') || 'unknown error'}).`
      : ''
  )

  const loadCards = () => {
    getGmailStatus().then((r) => setGmail(r.data)).catch(() => {})
    listCardBanks().then((r) => setBanks(r.data)).catch(() => {})
    listCardStatements().then((r) => setStatements(r.data)).catch(() => {})
  }

  const blankLoan = { role: 'lent', other: '', amount: '', start_date: '', due_date: '', interest: false, note: '',
                      emi: false, emiCount: 3, emiFirst: '', emiRows: [] }
  const [loan, setLoan] = useState(blankLoan)
  const [bill, setBill] = useState({ title: '', amount: '', members: [], day_of_month: 1 })

  const load = () => getLoans().then((r) => setData(r.data)).catch(() => setError('Could not load.'))

  useEffect(() => {
    load()
    loadCards()
    getFriends().then((r) => setPeople(r.data.map((f) => f.name))).catch(() => {})
    // The query string only matters for the one redirect back from Google -
    // clearing it keeps a later manual refresh from re-showing "Gmail
    // connected." as if it had just happened again.
    if (params.get('gmail')) setParams({ tab: 'cards' }, { replace: true })
  }, [])

  useEffect(() => {
    const onChanged = () => load()
    window.addEventListener(MONEY_CHANGED, onChanged)
    return () => window.removeEventListener(MONEY_CHANGED, onChanged)
  }, [])

  const connectGmail = async () => {
    setCardError('')
    try {
      const r = await getGmailConnectUrl()
      window.location.href = r.data.url
    } catch (e) {
      setCardError(e.response?.data?.detail || 'Could not start Gmail connect.')
    }
  }

  const runCards = async (fn) => {
    setCardError(''); setCardBusy(true)
    try { await fn(); loadCards() }
    catch (e) { setCardError(e.response?.data?.detail || 'Something went wrong.') }
    finally { setCardBusy(false) }
  }

  const addBank = (e) => {
    e.preventDefault()
    if (!bankName.trim() || !bankPw) return setCardError('Bank name and password are required.')
    runCards(() => setCardBankPassword({ bank: bankName.trim(), password: bankPw }))
    setBankName(''); setBankPw('')
  }

  // A real scan (Gmail search + unlocking each PDF + an LLM call per email)
  // can run well past a single request's lifetime, so /credit-cards/scan
  // just starts it in the background and this polls /scan/progress for
  // what's happening, instead of the button sitting on "Scanning…" with no
  // sense of whether it's stuck or on email 1 of 20.
  const doScan = async () => {
    setCardError(''); setCardMsg(''); setCardBusy(true); setCardProgress(null)
    try {
      await scanCardStatements(cardFrom, cardTo)
    } catch (e) {
      setCardError(e.response?.data?.detail || 'Could not scan Gmail.')
      setCardBusy(false)
      return
    }

    let p
    do {
      await new Promise((r) => setTimeout(r, 900))
      try { p = (await getScanProgress()).data }
      catch { p = { status: 'error', error: 'Lost track of the scan - check again in a moment.' } }
      setCardProgress(p)
    } while (p.status === 'running')

    if (p.status === 'error') {
      setCardError(p.error || 'Could not scan Gmail.')
    } else {
      const { total = 0, found = 0, skipped = 0, failed = 0 } = p
      setCardMsg(
        found > 0
          ? `Found ${found} new statement${found === 1 ? '' : 's'} (checked ${total} email${total === 1 ? '' : 's'}).`
          : `No new statements (checked ${total}, ${skipped} already known, ${failed} couldn't be read).`
      )
    }
    setCardProgress(null)
    setCardBusy(false)
    loadCards()
  }

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

  // "Pay via UPI" panel, toggled open per loan/bill-debtor row - keyed by a
  // string unique to that row so a loan and a bill owed to the same person
  // don't fight over one open/closed state. UPI IDs are fetched once per
  // person and cached, since the same friend can show up in several rows.
  const [openPayKey, setOpenPayKey] = useState(null)
  const [upiCache, setUpiCache] = useState({})   // { [personName]: 'loading' | 'none' | [{id, upi_id, label}] }

  const togglePay = async (key, personName) => {
    if (openPayKey === key) { setOpenPayKey(null); return }
    setOpenPayKey(key)
    if (upiCache[personName]) return
    setUpiCache((c) => ({ ...c, [personName]: 'loading' }))
    try {
      const r = await listUpiIdsFor(personName)
      setUpiCache((c) => ({ ...c, [personName]: r.data.length > 0 ? r.data : 'none' }))
    } catch {
      setUpiCache((c) => ({ ...c, [personName]: 'none' }))
    }
  }

  const PayPanel = ({ personName, amount, note, kind, refId }) => {
    const entry = upiCache[personName]
    if (entry === 'loading') return <p className="text-xs text-gray-400 text-center py-3">Loading…</p>
    if (entry === 'none' || !entry) {
      return <p className="text-xs text-gray-400 text-center py-3">{personName} hasn't added a UPI ID yet.</p>
    }
    return (
      <PayViaUpi
        upiId={entry[0].upi_id} payeeName={personName} amount={amount} note={note} className="mt-3"
        onClaim={(amt) => createPaymentClaim({ payee: personName, amount: amt, kind, ref_id: refId, note })}
      />
    )
  }

  const repayBillMember = (billId, member, due) => {
    const raw = window.prompt(`Amount paid back by ${member} (outstanding ${INR(due)}):`, String(due))
    const amt = parseFloat(raw)
    if (!raw || isNaN(amt) || amt <= 0) return
    run(() => repayBill(billId, { member, amount: amt }))
  }

  const editBillDay = (bill) => {
    const raw = window.prompt('Bill on which day of the month? (1-28)', String(bill.day_of_month))
    const day = parseInt(raw, 10)
    if (!raw || isNaN(day) || day < 1 || day > 28) return
    run(() => updateBillDay(bill.id, { day_of_month: day }))
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
          {[['loans', 'Loans'], ['bills', 'Recurring bills'], ['cards', 'Credit Cards']].map(([v, l]) => (
            <button key={v} onClick={() => { setTab(v); setShowForm(false) }}
              className={`flex-1 py-2 text-xs font-bold border ${tab === v ? 'bg-brand-400 text-white border-brand-400' : 'text-gray-500 border-transparent hover:bg-amber-50'}`}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <div className="px-5 mt-4 space-y-3 max-w-2xl">
        {error && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>}

        {tab !== 'cards' && (
          <button onClick={() => setShowForm((v) => !v)} className="btn-primary py-2.5 text-xs w-full">
            {showForm ? 'Cancel' : tab === 'loans' ? '+ New loan' : '+ New recurring bill'}
          </button>
        )}

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
                  {!l.paid && iOwe && (
                    <button onClick={() => togglePay(`loan-${l.id}`, other)} className="flex-1 py-2 text-xs font-bold bg-brand-50 border border-brand-300 text-brand-700 rounded-md">
                      {openPayKey === `loan-${l.id}` ? 'Hide UPI' : 'Pay via UPI'}
                    </button>
                  )}
                  <button
                    onClick={() => confirm('Delete this loan?') && run(() => deleteLoan(l.id))}
                    className="px-3 py-2 text-xs font-bold text-gray-400 hover:text-red-500">
                    Delete
                  </button>
                </div>
                {openPayKey === `loan-${l.id}` && (
                  <PayPanel personName={other} amount={l.total_due} note={`Loan repayment to ${other}`} kind="loan" refId={l.id} />
                )}
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
            // One card per debtor (like a loan card) - each owes their own
            // running total across every unpaid period of this bill. Every
            // other member gets a card even before their first charge
            // exists (e.g. a bill day that hasn't come around yet).
            const debtors = iPay
              ? [...new Set([...b.members.filter((m) => !same(m, me)), ...b.charges.map((c) => c.member)])]
              : [me]
            return (
              <div key={b.id} className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <p className="text-xs font-bold text-gray-500">
                    {b.title} · {INR(share)} each · billed on the{' '}
                    {iPay ? (
                      <button onClick={() => editBillDay(b)} className="underline decoration-dotted">
                        {b.day_of_month}{b.day_of_month === 1 ? 'st' : 'th'}
                      </button>
                    ) : (
                      <>{b.day_of_month}{b.day_of_month === 1 ? 'st' : 'th'}</>
                    )}
                  </p>
                  {iPay && (
                    <button onClick={() => confirm('Stop billing this every month?') && run(() => stopBill(b.id))}
                      className="text-xs font-bold text-gray-400 hover:text-red-500 shrink-0">Stop</button>
                  )}
                </div>
                {debtors.map((m) => {
                  const charges = b.charges.filter((c) => same(c.member, m))
                  const due = charges.filter((c) => !c.paid).reduce((s, c) => s + c.share, 0)
                  const notBilledYet = charges.length === 0
                  const paidOff = !notBilledYet && due <= 0.01
                  return (
                    <div key={m} className={`card ${paidOff ? 'opacity-60' : ''}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-gray-900">
                            {iPay ? `${m} owes you` : `You owe ${b.payer}`}
                          </p>
                          <p className="text-xs text-gray-400 mt-0.5">{b.title} · {INR(share)}/month</p>
                        </div>
                        <p className={`text-base font-black shrink-0 ${notBilledYet ? 'text-gray-400' : paidOff ? 'text-gray-400' : iPay ? 'text-green-600' : 'text-red-600'}`}>
                          {notBilledYet ? 'Not billed yet' : paidOff ? 'Paid' : INR(due)}
                        </p>
                      </div>
                      {charges.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {charges.slice(0, 12).map((c) => (
                            <div key={c.id} className="flex items-center justify-between text-[11px]">
                              <span className="text-gray-500">{c.period}</span>
                              <span className={c.paid ? 'text-green-600 font-bold' : 'text-red-600 font-bold'}>
                                {c.paid ? 'Paid ✓' : `${INR(c.share)} due`}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      {!notBilledYet && !paidOff && (
                        <div className="flex gap-2 mt-3">
                          <button onClick={() => repayBillMember(b.id, m, due)}
                            className="flex-1 py-2 text-xs font-bold bg-amber-100 border border-amber-300 text-amber-800 rounded-md">
                            Record repayment
                          </button>
                          {!iPay && (
                            <button onClick={() => togglePay(`bill-${b.id}-${m}`, b.payer)} className="flex-1 py-2 text-xs font-bold bg-brand-50 border border-brand-300 text-brand-700 rounded-md">
                              {openPayKey === `bill-${b.id}-${m}` ? 'Hide UPI' : 'Pay via UPI'}
                            </button>
                          )}
                        </div>
                      )}
                      {openPayKey === `bill-${b.id}-${m}` && (
                        <PayPanel personName={b.payer} amount={due} note={`${b.title} - ${m}`} kind="bill" refId={b.id} />
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })
        )}

        {/* ── Credit Cards ── */}
        {tab === 'cards' && (
          <div className="space-y-3">
            {cardMsg && <p className="text-xs text-green-700 bg-green-50 border border-green-100 rounded-md px-3 py-2">{cardMsg}</p>}
            {cardError && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{cardError}</p>}

            {/* Gmail connection */}
            <div className="card space-y-2">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Gmail</p>
              {gmail?.connected ? (
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-gray-900 truncate">{gmail.gmail_address}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      {gmail.last_synced_at ? `Last scanned ${new Date(gmail.last_synced_at).toLocaleString('en-IN')}` : 'Never scanned yet'}
                    </p>
                  </div>
                  <button
                    onClick={() => confirm('Disconnect Gmail? Statements already found stay saved.') && runCards(() => disconnectGmail())}
                    className="text-xs font-bold text-gray-400 hover:text-red-500 shrink-0"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <button onClick={connectGmail} disabled={cardBusy} className="btn-primary py-2.5 text-xs w-full">
                  Connect Gmail
                </button>
              )}
            </div>

            {/* Bank passwords */}
            <div className="card space-y-2">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Bank statement passwords</p>
              <p className="text-[11px] text-gray-400">
                The password that opens each bank's statement PDF - entered once, reused every month.
              </p>
              {banks.length > 0 && (
                <div className="space-y-1">
                  {banks.map((b) => (
                    <div key={b.bank} className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-gray-700">{b.bank}</span>
                      <button
                        onClick={() => confirm(`Remove the saved password for ${b.bank}?`) && runCards(() => deleteCardBank(b.bank))}
                        className="text-gray-400 hover:text-red-500 font-bold"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <form onSubmit={addBank} className="flex flex-col gap-2 pt-1">
                <input
                  className="input text-sm" placeholder="Bank name (e.g. HDFC)"
                  value={bankName} onChange={(e) => setBankName(e.target.value)}
                  autoComplete="off" name="bank-name"
                />
                <input
                  className="input text-sm" placeholder="PDF password" type="password"
                  value={bankPw} onChange={(e) => setBankPw(e.target.value)}
                  autoComplete="current-password" name="bank-pdf-password"
                />
                <button type="submit" disabled={cardBusy} className="btn-primary py-2.5 text-xs w-full">Save</button>
              </form>
            </div>

            {/* Scan + statements */}
            {gmail?.connected && (
              <div className="card space-y-2">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Search window</p>
                <p className="text-[11px] text-gray-400">
                  Leave blank to check the last 9 months, or narrow it to when a bank actually bills.
                </p>
                <Dropdown
                  value={cardMonth}
                  onChange={setCardMonth}
                  options={recentMonths().map((m, i) => ({
                    value: m.value,
                    label: i === 0 ? `${m.label} (current)` : m.label,
                  }))}
                />
                <div className="flex flex-wrap gap-1.5">
                  {bankDatePresets(cardMonth).map((p) => (
                    <button
                      key={p.label} type="button"
                      onClick={() => { setCardFrom(p.from); setCardTo(p.to) }}
                      className="text-[11px] px-2 py-1 rounded-full border border-gray-200 text-gray-600 hover:border-orange-300 hover:text-orange-600"
                    >
                      {p.label}
                    </button>
                  ))}
                  {(cardFrom || cardTo) && (
                    <button
                      type="button"
                      onClick={() => { setCardFrom(''); setCardTo('') }}
                      className="text-[11px] px-2 py-1 rounded-full text-gray-400 hover:text-red-500"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div className="flex gap-2">
                  <DatePicker value={cardFrom} onChange={setCardFrom} placeholder="From" className="flex-1" />
                  <DatePicker value={cardTo} onChange={setCardTo} placeholder="To" className="flex-1" />
                </div>
                <button onClick={doScan} disabled={cardBusy || banks.length === 0} className="btn-primary py-2.5 text-xs w-full">
                  {cardBusy ? 'Scanning…' : 'Scan for new statements'}
                </button>
              </div>
            )}
            {cardProgress?.status === 'running' && (
              <div className="space-y-1">
                <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className="h-full bg-orange-500 transition-all duration-300"
                    style={{
                      width: cardProgress.total > 0
                        ? `${Math.min(100, (cardProgress.done / cardProgress.total) * 100)}%`
                        : '15%',
                    }}
                  />
                </div>
                <p className="text-[11px] text-gray-400 text-center">
                  {cardProgress.total > 0
                    ? `Scanning email ${cardProgress.done} of ${cardProgress.total} — ${cardProgress.found} found so far`
                    : 'Searching Gmail…'}
                </p>
              </div>
            )}
            {gmail?.connected && banks.length === 0 && (
              <p className="text-[11px] text-gray-400 text-center">Add at least one bank's password before scanning.</p>
            )}

            {statements.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">No statements found yet</p>
            ) : (
              statements.map((s) => (
                <div key={s.id} className="card">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-gray-900">
                        {s.bank}{s.card_last4 ? ` •••• ${s.card_last4}` : ''}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {s.due_date ? `Due ${s.due_date}` : 'Due date not found'}
                        {s.statement_date ? ` · statement ${s.statement_date}` : ''}
                      </p>
                    </div>
                    <p className="text-base font-black text-gray-900 shrink-0">
                      {s.total_due != null ? INR(s.total_due) : '—'}
                    </p>
                  </div>
                  {s.minimum_due != null && (
                    <p className="text-[11px] text-gray-400 mt-1">Minimum due: {INR(s.minimum_due)}</p>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
