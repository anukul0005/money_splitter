import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Chart, BarElement, BarController, CategoryScale, LinearScale, Tooltip } from 'chart.js'
import { Bar } from 'react-chartjs-2'
import { useNavigate } from 'react-router-dom'
import {
  getGmailStatus, getGmailConnectUrl, disconnectGmail,
  getCardBankOptions, listCards, addCard, updateCard, deleteCard, deleteCardBill,
  fetchCardBills, getScanProgress, recordCardPayment, deleteCardPayment,
} from '../api'
import Dropdown from './Dropdown'
import DatePicker from './DatePicker'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const ord = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`
const day = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '')
const DAYS = Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: ord(i + 1) }))
const MONTHS_BACK = 2

Chart.register(BarElement, BarController, CategoryScale, LinearScale, Tooltip)
const TICK_FONT = { size: 10, family: "Num, 'IBM Plex Sans', system-ui, sans-serif" }
const PAID = 1        // less than ₹1 left on a bill: paid (rounding, not a debt)
const BLANK = { bank: '', label: '', last4: '', bill_day: '' }

// The last n bill periods ("YYYY-MM") for a card whose latest bill was on `lastBill`.
function lastPeriods(lastBill, n) {
  const [y, m] = lastBill.split('-').map(Number)
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(y, m - 1 - i, 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
}

function CardForm({ banks, initial, onSave, onCancel, busy }) {
  const [f, setF] = useState(initial)
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); onSave(f) }}>
      <Dropdown value={f.bank} onChange={set('bank')} placeholder="Bank"
        options={banks.map((b) => ({ value: b, label: b }))} />
      <div className="flex gap-2">
        <input className="input text-sm flex-1 min-w-0" placeholder="Card name (optional, e.g. Amazon Pay)"
          value={f.label} onChange={(e) => set('label')(e.target.value)} autoComplete="off" maxLength={60} />
        <input className="input text-sm w-24" placeholder="Last 4" inputMode="numeric" maxLength={4}
          value={f.last4} onChange={(e) => set('last4')(e.target.value.replace(/\D/g, ''))} autoComplete="off" />
      </div>
      <Dropdown value={f.bill_day} onChange={set('bill_day')} placeholder="Day the bill is generated"
        options={DAYS.map((d) => ({ ...d, label: `Bill generated on the ${d.label}` }))} />
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !f.bank || !f.bill_day} className="btn-primary py-2.5 text-xs flex-1 disabled:opacity-50">
          {busy ? 'Saving…' : 'Save card'}
        </button>
        {onCancel && <button type="button" onClick={onCancel} className="text-xs font-bold text-gray-500 px-3">Cancel</button>}
      </div>
    </form>
  )
}

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const shortMonth = (period) => new Date(`${period}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })

// One credit card, laid out like a recurring bill: a title line above, then
// a plain card with the latest bill's amount on the right, one row per
// month underneath, the payments made, and "Record payment". Only the
// latest bill takes payments (bill.can_pay) - past months are closed.
function CardBlock({ card: c, banks, results, busy, run, editing, setEditing, saveCard, onPay, color }) {
  const nav = useNavigate()
  const periods = lastPeriods(c.last_bill, MONTHS_BACK)
  const latest = c.bills.find((b) => b.can_pay)
  const settled = latest && latest.total_due != null && latest.remaining < PAID

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <p className="text-xs font-bold text-gray-500 flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: color }} />
          {c.bank}{c.label ? ` ${c.label}` : ''} · billed on the {ord(c.bill_day)}
        </p>
        <div className="flex gap-3 shrink-0 text-xs font-bold">
          <button onClick={() => setEditing(editing ? null : c.id)} className="text-gray-400 hover:text-brand-500">
            {editing ? 'Close' : 'Edit'}
          </button>
          <button onClick={() => confirm(`Remove ${c.bank}${c.last4 ? ` •••• ${c.last4}` : ''} and its saved bills?`) && run(() => deleteCard(c.id))}
            className="text-gray-400 hover:text-red-500">Remove</button>
        </div>
      </div>

      <div className={`card ${settled ? 'opacity-60' : ''} ${editing ? "" : "cursor-pointer active:scale-[0.99] transition-transform"}`}
        onClick={editing ? undefined : () => nav(`/credit-cards/card/${c.id}`)}>
        {editing ? (
          <CardForm banks={banks} busy={busy} onCancel={() => setEditing(null)}
            initial={{ bank: c.bank, label: c.label || '', last4: c.last4 || '', bill_day: c.bill_day }}
            onSave={(f) => saveCard(f, c.id)} />
        ) : (
          <>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-bold text-gray-900">
                  {c.bank}{c.label ? ` ${c.label}` : ''}{c.last4 ? ` •••• ${c.last4}` : ''}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {latest?.due_date ? `Due ${day(latest.due_date)}` : `Next bill ${day(c.next_bill)}`}
                  {latest?.minimum_due != null ? ` · minimum ${INR(latest.minimum_due)}` : ''}
                </p>
              </div>
              <p className={`text-base font-black shrink-0 ${!latest || latest.total_due == null ? 'text-gray-400' : settled ? 'text-gray-400' : 'text-red-600'}`}>
                {!latest ? 'Not fetched' : latest.total_due == null ? '—' : settled ? 'Paid' : INR(latest.remaining)}
              </p>
            </div>

            <div className="mt-2 space-y-1">
              {periods.map((period) => {
                const b = c.bills.find((x) => x.period === period)
                const r = results[`${c.id}:${period}`]
                return (
                  <div key={period}>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-gray-500">{shortMonth(period)}</span>
                      {!b ? (
                        <span className="text-gray-400">{r?.status === 'not_found' ? 'Not found' : 'Not fetched yet'}</span>
                      ) : b.total_due == null ? (
                        <span className="text-gray-400">Amount not found</span>
                      ) : b.remaining < PAID ? (
                        <span className="text-green-600 font-bold">{INR(b.total_due)} · Paid ✓</span>
                      ) : (
                        <span className={b.can_pay ? 'text-red-600 font-bold' : 'text-gray-600 font-bold'}>
                          {INR(b.total_due)}{b.can_pay ? ' due' : ''}
                        </span>
                      )}
                    </div>
                    {!b && r?.why && <p className="text-[10px] text-gray-400 leading-snug">{r.why}</p>}
                    {b?.payments.map((p) => (
                      <div key={p.id} className="flex items-center justify-between text-[11px] pl-3">
                        <span className="text-gray-400">paid {day(p.paid_on)}</span>
                        <span className="flex items-center gap-2">
                          <span className="text-green-600 font-bold">{INR(p.amount)}</span>
                          {b.can_pay && (
                            <button onClick={(e) => { e.stopPropagation(); confirm(`Remove the ${INR(p.amount)} payment?`) && run(() => deleteCardPayment(p.id)) }}
                              className="text-gray-300 hover:text-red-500 font-bold" aria-label="Remove payment">×</button>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>

            {latest && (
              <p className="text-[10px] text-gray-400 mt-2 truncate">
                From {latest.source === 'pdf' ? 'the PDF of ' : ''}“{latest.email_subject || 'statement email'}” ·{' '}
                <button onClick={(e) => { e.stopPropagation(); confirm('Remove this bill? The next search looks for this month again.') && run(() => deleteCardBill(latest.id)) }}
                  className="font-bold hover:text-red-500">wrong?</button>
              </p>
            )}

            <div className="flex gap-2 mt-3" onClick={(e) => e.stopPropagation()}>
              <button onClick={(e) => { e.stopPropagation(); onPay(c.id) }} disabled={!latest || settled || latest.total_due == null}
                className="flex-1 py-2 text-xs font-bold bg-amber-100 border border-amber-300 text-amber-800 rounded-md disabled:opacity-40 disabled:cursor-not-allowed">
                {settled ? 'Paid in full' : 'Record payment'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// One colour per card, the same in the charts and beside its name below
const CARD_COLORS = ['#f97316', '#2563eb', '#16a34a', '#9333ea', '#db2777', '#0891b2', '#ca8a04', '#64748b']
const kInr = (n) => (n >= 100000 ? `₹${(n / 100000).toFixed(1)}L` : n >= 1000 ? `₹${Math.round(n / 1000)}k` : `₹${Math.round(n)}`)
const cardName = (c) => `${c.bank}${c.label ? ` ${c.label}` : ''}${c.last4 ? ` ••${c.last4}` : ''}`
// A legend's few letters: the bank alone ("ICICI", "Jupiter", "SBI"), with
// the last 4 digits only when two cards share a bank
const bankWord = (c) => (/american express|amex/i.test(c.bank || '') ? 'Amex' : null) || (c.bank || '').replace(/\(.*?\)/g, ' ').split(/\s+/).filter((w) => w && !/^(bank|card|cards|of|the|ltd)$/i.test(w))[0] || c.bank
const shortName = (c, all) => (all.filter((x) => bankWord(x) === bankWord(c)).length > 1 && c.last4 ? `${bankWord(c)} ${c.last4}` : bankWord(c))
// "Oct", or "Oct 25" when it isn't this year
const monthTag = (p) => {
  const d = new Date(`${p}-01T00:00:00`)
  const m = d.toLocaleDateString('en-IN', { month: 'short' })
  return d.getFullYear() === new Date().getFullYear() ? m : `${m} ${String(d.getFullYear()).slice(2)}`
}
const daysTo = (iso) => Math.round((new Date(`${iso}T00:00:00`) - new Date(`${today()}T00:00:00`)) / 864e5)

/** All the cards together: what's owed now, when it's due, and the bills month by month. */
function CardsDashboard({ cards, colorOf, onPay }) {
  const open = cards.map((c) => ({ c, b: c.bills.find((x) => x.can_pay) }))
    .filter(({ b }) => b && b.total_due != null)
  const owed = open.filter(({ b }) => b.remaining >= PAID).reduce((s, { b }) => s + b.remaining, 0)
  const billed = open.reduce((s, { b }) => s + (b.total_due || 0), 0)
  const paid = open.reduce((s, { b }) => s + Math.min(b.paid || 0, b.total_due || 0), 0)
  const minimum = open.filter(({ b }) => b.remaining >= PAID)
    .reduce((s, { b }) => s + Math.min(b.minimum_due ?? 0, b.remaining), 0)
  const dues = open.filter(({ b }) => b.remaining >= PAID && b.due_date)
    .sort((x, y) => x.b.due_date.localeCompare(y.b.due_date))

  // Bills by month, stacked by card - the last 6 months any card has
  // The last 2 calendar months up to the latest bill, in order - a month with no
  // bill is an empty row, and older bills (a year-old one a fetch turned up)
  // stay out instead of jumping the chart back a year. Leading empties go.
  const latestP = cards.flatMap((c) => c.bills.map((b) => b.period)).filter(Boolean).sort().pop()
  const window6 = latestP ? lastPeriods(`${latestP}-01`, MONTHS_BACK).reverse() : []
  const firstWith = window6.findIndex((p) => cards.some((c) => c.bills.some((b) => b.period === p && b.total_due)))
  const periods = firstWith < 0 ? [] : window6.slice(firstWith)
  const months = periods.map((p) => ({
    p, parts: cards.map((c) => ({ c, v: c.bills.find((b) => b.period === p)?.total_due || 0 })).filter((x) => x.v > 0),
  }))
  const top = Math.max(1, ...months.map((m) => m.parts.reduce((s, x) => s + x.v, 0)))

  return (
    <div className="card space-y-4">
      {/* the headline */}
      <div className="grid grid-cols-3 gap-2">
        <div>
          <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest">To pay</p>
          <p className={`text-lg font-black tabular-nums ${owed >= PAID ? 'text-red-600' : 'text-green-600'}`}>{owed >= PAID ? INR(Math.round(owed)) : 'All paid'}</p>
        </div>
        <div>
          <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest">Minimum</p>
          <p className="text-lg font-black tabular-nums text-gray-900">{INR(Math.round(minimum))}</p>
        </div>
        <div>
          <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest">Next due</p>
          {dues[0] ? (
            <p className={`text-lg font-black ${daysTo(dues[0].b.due_date) <= 3 ? 'text-red-600' : 'text-gray-900'}`}>
              {daysTo(dues[0].b.due_date) < 0 ? 'Overdue' : daysTo(dues[0].b.due_date) === 0 ? 'Today' : `${daysTo(dues[0].b.due_date)}d`}
            </p>
          ) : <p className="text-lg font-black text-gray-300">—</p>}
        </div>
      </div>

      {/* this cycle: paid of billed */}
      {billed > 0 && (
        <div>
          <div className="flex justify-between text-[10px] text-gray-500 mb-1">
            <span>This cycle: <b className="text-gray-800">{INR(Math.round(paid))}</b> paid of {INR(Math.round(billed))}</span>
            <span className="font-bold">{Math.round((paid / billed) * 100)}%</span>
          </div>
          <div className="h-2.5 bg-red-100 overflow-hidden flex">
            <div className="bg-green-600 h-full" style={{ width: `${(paid / billed) * 100}%` }} />
          </div>
        </div>
      )}

      {/* due dates, soonest first */}
      {dues.length > 0 && (
        <div>
          <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1">Due</p>
          {dues.map(({ c, b }) => {
            const d = daysTo(b.due_date)
            return (
              <button key={c.id} onClick={() => onPay(c.id)} className="w-full flex items-center gap-2 py-1 text-[11px] text-left">
                <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: colorOf(c.id) }} />
                <span className="flex-1 min-w-0 truncate font-semibold text-gray-700">{cardName(c)}</span>
                <span className={`shrink-0 ${d < 0 ? 'text-red-600 font-bold' : d <= 3 ? 'text-amber-700 font-bold' : 'text-gray-400'}`}>
                  {day(b.due_date)}{d < 0 ? ' · overdue' : d === 0 ? ' · today' : ` · ${d}d`}
                </span>
                <span className="w-20 text-right shrink-0 font-black text-red-600 tabular-nums">{INR(Math.round(b.remaining))}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* bills by month: one bar a month, across, split by card - drawn like History's charts
          (square edges, the amounts in the tooltip a tap brings up) */}
      {months.length > 0 && (
        <div>
          <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-2">Bills by month</p>
          <div className="relative" style={{ height: `${months.length * 52 + 36}px` }}>
            <Bar
              data={{
                labels: months.map(({ p }) => monthTag(p)),
                datasets: cards.filter((c) => months.some(({ parts }) => parts.some((x) => x.c.id === c.id))).map((c) => ({
                  label: shortName(c, cards),
                  data: months.map(({ parts }) => parts.find((x) => x.c.id === c.id)?.v || 0),
                  backgroundColor: colorOf(c.id),
                  borderRadius: 0, borderSkipped: false, barPercentage: 0.8, categoryPercentage: 0.85,
                })),
              }}
              options={{
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false, axis: 'y' },
                plugins: {
                  legend: { display: false },
                  tooltip: {
                    filter: (item) => item.raw > 0,
                    callbacks: {
                      label: (c) => ` ${c.dataset.label}: ${INR(c.raw)}`,
                      footer: (items) => `Total: ${INR(items.reduce((s, x) => s + x.raw, 0))}`,
                    },
                  },
                },
                scales: {
                  x: {
                    stacked: true, beginAtZero: true,
                    ticks: { font: TICK_FONT, maxTicksLimit: 5, callback: (v) => kInr(v) },
                    grid: { color: '#f1f5f9' }, border: { display: false },
                  },
                  y: { stacked: true, grid: { display: false }, ticks: { font: { ...TICK_FONT, size: 11, weight: 'bold' } } },
                },
              }}
            />
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2.5">
            {cards.filter((c) => c.bills.some((b) => periods.includes(b.period) && b.total_due)).map((c) => (
              <span key={c.id} className="flex items-center gap-1 text-[10px] font-semibold text-gray-500">
                <span className="w-2 h-2 rounded-sm" style={{ background: colorOf(c.id) }} />{shortName(c, cards)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** "Record payment": pick a card, the amount (full / minimum in a tap) and the day - set against its latest bill. */
function PayForm({ cards, cardId, setCardId, busy, onSave, onClose }) {
  const [amount, setAmount] = useState('')
  const [paidOn, setPaidOn] = useState(today())
  const payable = cards.filter((c) => { const b = c.bills.find((x) => x.can_pay); return b && b.total_due != null })
  const card = payable.find((c) => c.id === cardId)
  const bill = card?.bills.find((x) => x.can_pay)
  useEffect(() => { setAmount('') }, [cardId])
  const amt = parseFloat(amount) || 0
  // A portal to <body>: inside the page it sat under the bottom bar, its Save button hidden
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (bill && amt > 0) onSave(bill.id, amt, paidOn) }}
        className="w-full max-w-md bg-cream rounded-xl p-5 space-y-3 shadow-xl max-h-[85dvh] overflow-y-auto">
        <div className="flex items-center">
          <p className="text-base font-black flex-1">Record payment</p>
          <button type="button" onClick={onClose} className="text-xs font-bold text-gray-400">Close</button>
        </div>
        {payable.length === 0 ? (
          <p className="text-xs text-gray-500">No card has a bill to pay yet - fetch the bills first.</p>
        ) : (
          <>
            <Dropdown value={cardId ?? ''} onChange={(v) => setCardId(Number(v))} placeholder="Which card?"
              options={payable.map((c) => {
                const b = c.bills.find((x) => x.can_pay)
                return { value: c.id, label: `${cardName(c)} · ${b.remaining >= PAID ? `${INR(b.remaining)} due` : 'paid'}` }
              })} />
            {bill && (
              <p className="text-[11px] text-gray-500">
                {shortMonth(bill.period)} bill {INR(bill.total_due)}{bill.paid > 0 ? ` · ${INR(bill.paid)} paid` : ''}
                {bill.due_date ? ` · due ${day(bill.due_date)}` : ''}
              </p>
            )}
            <input className="input text-xl font-bold" placeholder="Amount paid" inputMode="decimal"
              value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
            {bill && bill.remaining >= PAID && (
              <div className="flex gap-2">
                <button type="button" onClick={() => setAmount(String(bill.remaining))}
                  className="px-3 py-1.5 text-xs font-bold border rounded-md bg-amber-50 border-amber-200 text-gray-700">Full {INR(bill.remaining)}</button>
                {bill.minimum_due != null && bill.minimum_due < bill.remaining && (
                  <button type="button" onClick={() => setAmount(String(bill.minimum_due))}
                    className="px-3 py-1.5 text-xs font-bold border rounded-md bg-amber-50 border-amber-200 text-gray-700">Minimum {INR(bill.minimum_due)}</button>
                )}
              </div>
            )}
            <DatePicker value={paidOn} onChange={setPaidOn} />
            {bill && amt > 0 && (
              <p className="text-[11px] text-gray-600">
                {amt > bill.remaining - PAID ? 'Settles this bill in full.' : `Leaves ${INR(Math.round((bill.remaining - amt) * 100) / 100)} to pay.`}
              </p>
            )}
            <button type="submit" disabled={busy || !bill || !(amt > 0)} className="btn-primary py-2.5 text-sm w-full disabled:opacity-50">
              {busy ? 'Saving…' : amt > 0 ? `Save ${INR(amt)} payment` : 'Save payment'}
            </button>
          </>
        )}
      </form>
    </div>,
    document.body,
  )
}

/**
 * Credit cards (on the Loans page): the user's cards with the day each
 * bill is generated, and each card's bill amount read from Gmail on that
 * day - see backend/card_bills.py. Saved statement PDF passwords (from
 * before) are still used on the server when a bill is only in a PDF.
 */
export default function CreditCards({ initialMsg = '' }) {
  const [gmail, setGmail] = useState(null)
  const [bankOptions, setBankOptions] = useState([])
  const [cards, setCards] = useState(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(null)       // card id
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  const [results, setResults] = useState({})         // `${card_id}:${period}` -> last fetch's result
  const [msg, setMsg] = useState(initialMsg)
  const [error, setError] = useState('')
  const [payFor, setPayFor] = useState(undefined)    // the card the payment form is open for (null: none picked yet)
  const colorOf = (id) => CARD_COLORS[Math.max(0, (cards || []).findIndex((c) => c.id === id)) % CARD_COLORS.length]
  const openPay = (id = null) => {
    if (id == null) {          // the card with the soonest unpaid bill, if any
      const next = (cards || []).map((c) => ({ c, b: c.bills.find((x) => x.can_pay) }))
        .filter(({ b }) => b && b.remaining >= PAID).sort((x, y) => (x.b.due_date || '9').localeCompare(y.b.due_date || '9'))[0]
      id = next?.c.id ?? null
    }
    setPayFor(id)
  }
  const savePayment = async (billId, amount, paidOn) => {
    if (await run(() => recordCardPayment(billId, { amount, paid_on: paidOn }))) {
      setPayFor(undefined); setMsg('Payment saved.')
    }
  }

  const load = () => {
    getGmailStatus().then((r) => setGmail(r.data)).catch(() => {})
    listCards().then((r) => setCards(r.data)).catch(() => setCards([]))
  }
  useEffect(() => {
    load()
    getCardBankOptions().then((r) => setBankOptions(r.data)).catch(() => {})
  }, [])

  const run = async (fn) => {
    setError(''); setBusy(true)
    try { await fn(); load(); return true }
    catch (e) { setError(e.response?.data?.detail || 'Something went wrong.'); return false }
    finally { setBusy(false) }
  }

  const connectGmail = async () => {
    setError('')
    try { window.location.href = (await getGmailConnectUrl()).data.url }
    catch (e) { setError(e.response?.data?.detail || 'Could not start Gmail connect.') }
  }

  const saveCard = async (f, id) => {
    const body = { bank: f.bank, label: f.label || null, last4: f.last4 || null, bill_day: Number(f.bill_day) }
    if (await run(() => (id ? updateCard(id, body) : addCard(body)))) { setAdding(false); setEditing(null) }
  }

  // Runs on the server in the background (a Gmail search plus an AI read
  // per card per month); this polls for progress and each card's outcome.
  const fetchBills = async () => {
    setError(''); setMsg(''); setBusy(true); setProgress({ status: 'running', total: 0, done: 0 })
    try { await fetchCardBills(MONTHS_BACK) } catch (e) {
      setError(e.response?.data?.detail || 'Could not start the search.'); setBusy(false); setProgress(null); return
    }
    let p
    do {
      await new Promise((r) => setTimeout(r, 1200))
      try { p = (await getScanProgress()).data } catch { p = { status: 'error', error: 'Lost track of the search - check again in a moment.' } }
      setProgress(p)
    } while (p.status === 'running')
    const byKey = {}
    for (const r of p.results || []) byKey[`${r.card_id}:${r.period}`] = r
    setResults(byKey)
    if (p.status === 'error') setError(p.error || 'The search failed.')
    else setMsg(`Done - ${p.found || 0} bill${p.found === 1 ? '' : 's'} found${p.skipped ? `, ${p.skipped} already saved` : ''}${p.failed ? `, ${p.failed} not found` : ''}.`)
    setProgress(null); setBusy(false); load()
  }

  return (
    <div className="space-y-4">
      {/* Record payment - for any card, from the top */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-black text-gray-500 uppercase tracking-widest">Your cards</p>
        {cards?.length > 0 && (
          <button onClick={() => openPay()} className="btn-primary !w-auto px-4 py-2 text-xs">+ Record payment</button>
        )}
      </div>

      {msg && <p className="text-xs text-green-700 bg-green-50 border border-green-100 rounded-md px-3 py-2">{msg}</p>}
      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>}

      {cards?.length > 0 && <CardsDashboard cards={cards} colorOf={colorOf} onPay={openPay} />}

      {cards === null && <p className="text-xs text-gray-400 text-center py-4">Loading…</p>}
      {cards?.length === 0 && !adding && <p className="text-sm text-gray-400 text-center py-8">No cards yet</p>}

      {cards?.map((c) => (
        <CardBlock key={c.id} card={c} banks={bankOptions} results={results} busy={busy} run={run}
          editing={editing === c.id} setEditing={setEditing} saveCard={saveCard} onPay={openPay} color={colorOf(c.id)} />
      ))}

      {/* Fetch + add */}
      <div className="card space-y-3">
        <p className="text-[11px] text-gray-400 leading-relaxed">
          Each card's bill is read from Gmail on the day it's generated - only that bank's emails, from that day to a week after.
        </p>
        {gmail?.connected && cards?.length > 0 && (
          <button onClick={fetchBills} disabled={busy} className="btn-primary py-2.5 text-xs w-full disabled:opacity-50">
            {progress ? 'Searching Gmail…' : `Fetch the last ${MONTHS_BACK} months' bills`}
          </button>
        )}
        {progress?.status === 'running' && (
          <div className="space-y-1">
            <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
              <div className="h-full bg-orange-500 transition-all duration-300"
                style={{ width: progress.total > 0 ? `${Math.min(100, (progress.done / progress.total) * 100)}%` : '10%' }} />
            </div>
            <p className="text-[11px] text-gray-400 text-center">
              {progress.total > 0 ? `Bill ${progress.done} of ${progress.total} · ${progress.found || 0} found` : 'Starting…'}
            </p>
          </div>
        )}
        {adding ? (
          <CardForm banks={bankOptions} busy={busy} initial={BLANK} onCancel={() => setAdding(false)} onSave={(f) => saveCard(f)} />
        ) : (
          <button onClick={() => setAdding(true)} className="w-full text-xs font-bold text-brand-500 py-1">+ Add a card</button>
        )}
      </div>


      {/* Gmail connection */}
      <div className="card space-y-2">
        <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Gmail</p>
        {gmail?.connected ? (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-bold text-gray-900 truncate">{gmail.gmail_address}</p>
              <p className="text-[11px] text-gray-400 mt-0.5">
                {gmail.last_synced_at ? `Last searched ${new Date(gmail.last_synced_at).toLocaleString('en-IN')}` : 'Not searched yet'}
              </p>
              <p className="text-[11px] text-green-700 font-semibold mt-0.5">
                Auto-sync on · each bill is fetched, unlocked and read daily after its bill date
              </p>
            </div>
            <button onClick={() => confirm('Disconnect Gmail? Bills already found stay saved.') && run(() => disconnectGmail())}
              className="text-xs font-bold text-gray-400 hover:text-red-500 shrink-0">Disconnect</button>
          </div>
        ) : (
          <button onClick={connectGmail} disabled={busy} className="btn-primary py-2.5 text-xs w-full">Connect Gmail</button>
        )}
      </div>


      {payFor !== undefined && (
        <PayForm cards={cards || []} cardId={payFor} setCardId={setPayFor} busy={busy}
          onSave={savePayment} onClose={() => setPayFor(undefined)} />
      )}
    </div>
  )
}
