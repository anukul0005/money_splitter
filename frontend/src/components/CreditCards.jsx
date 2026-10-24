import { useEffect, useState } from 'react'
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
function CardBlock({ card: c, banks, results, busy, run, editing, setEditing, saveCard }) {
  const nav = useNavigate()
  const [paying, setPaying] = useState(false)
  const [amount, setAmount] = useState('')
  const [paidOn, setPaidOn] = useState(today())
  const periods = lastPeriods(c.last_bill, MONTHS_BACK)
  const latest = c.bills.find((b) => b.can_pay)
  const settled = latest && latest.total_due != null && latest.remaining <= 0.01

  const save = async (e) => {
    e.preventDefault()
    const amt = parseFloat(amount)
    if (!amt || amt <= 0) return
    if (await run(() => recordCardPayment(latest.id, { amount: amt, paid_on: paidOn }))) {
      setPaying(false); setAmount(''); setPaidOn(today())
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <p className="text-xs font-bold text-gray-500">
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

      <div className={`card ${settled ? 'opacity-60' : ''} ${editing || paying ? '' : 'cursor-pointer active:scale-[0.99] transition-transform'}`}
        onClick={editing || paying ? undefined : () => nav(`/credit-cards/card/${c.id}`)}>
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
                      ) : b.remaining <= 0.01 ? (
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

            {paying ? (
              <form onSubmit={save} className="mt-3 space-y-2">
                <div className="flex gap-2">
                  <input className="input text-sm flex-1 min-w-0" placeholder="Amount paid" inputMode="decimal" autoFocus
                    value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
                  <DatePicker value={paidOn} onChange={setPaidOn} className="flex-1" />
                </div>
                {latest.remaining > 0 && (
                  <button type="button" onClick={() => setAmount(String(latest.remaining))}
                    className="text-[11px] font-bold text-brand-500">Pay in full ({INR(latest.remaining)})</button>
                )}
                <div className="flex gap-2">
                  <button type="submit" disabled={busy || !parseFloat(amount)} className="btn-primary py-2 text-xs flex-1 disabled:opacity-50">
                    {busy ? 'Saving…' : 'Save payment'}
                  </button>
                  <button type="button" onClick={() => setPaying(false)} className="text-xs font-bold text-gray-500 px-3">Cancel</button>
                </div>
              </form>
            ) : (
              <div className="flex gap-2 mt-3" onClick={(e) => e.stopPropagation()}>
                <button onClick={(e) => { e.stopPropagation(); setPaying(true) }} disabled={!latest || settled || latest.total_due == null}
                  className="flex-1 py-2 text-xs font-bold bg-amber-100 border border-amber-300 text-amber-800 rounded-md disabled:opacity-40 disabled:cursor-not-allowed">
                  {settled ? 'Paid in full' : 'Record payment'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
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
      {msg && <p className="text-xs text-green-700 bg-green-50 border border-green-100 rounded-md px-3 py-2">{msg}</p>}
      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>}

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

      {cards === null && <p className="text-xs text-gray-400 text-center py-4">Loading…</p>}
      {cards?.length === 0 && !adding && <p className="text-sm text-gray-400 text-center py-8">No cards yet</p>}

      {cards?.map((c) => (
        <CardBlock key={c.id} card={c} banks={bankOptions} results={results} busy={busy} run={run}
          editing={editing === c.id} setEditing={setEditing} saveCard={saveCard} />
      ))}
    </div>
  )
}
