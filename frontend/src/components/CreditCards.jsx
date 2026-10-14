import { useEffect, useState } from 'react'
import {
  getGmailStatus, getGmailConnectUrl, disconnectGmail,
  listCardBanks, setCardBankPassword, deleteCardBank,
  getCardBankOptions, listCards, addCard, updateCard, deleteCard, deleteCardBill,
  fetchCardBills, getScanProgress,
} from '../api'
import Dropdown from './Dropdown'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const ord = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`
const day = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '')
const monthName = (period) => new Date(`${period}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
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

/**
 * Credit cards (on the Loans page): the user's cards with the day each
 * bill is generated, and each card's bill amount read from Gmail on that
 * day - see backend/card_bills.py. Also the Gmail connection and the
 * bank passwords that open statement PDFs.
 */
export default function CreditCards({ initialMsg = '' }) {
  const [gmail, setGmail] = useState(null)
  const [banks, setBanks] = useState([])            // saved PDF passwords
  const [bankOptions, setBankOptions] = useState([])
  const [cards, setCards] = useState(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(null)       // card id
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  const [results, setResults] = useState({})         // `${card_id}:${period}` -> last fetch's result
  const [msg, setMsg] = useState(initialMsg)
  const [error, setError] = useState('')
  const [bankName, setBankName] = useState('')
  const [bankPw, setBankPw] = useState('')

  const load = () => {
    getGmailStatus().then((r) => setGmail(r.data)).catch(() => {})
    listCardBanks().then((r) => setBanks(r.data)).catch(() => {})
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
    <div className="space-y-3">
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
            </div>
            <button onClick={() => confirm('Disconnect Gmail? Bills already found stay saved.') && run(() => disconnectGmail())}
              className="text-xs font-bold text-gray-400 hover:text-red-500 shrink-0">Disconnect</button>
          </div>
        ) : (
          <button onClick={connectGmail} disabled={busy} className="btn-primary py-2.5 text-xs w-full">Connect Gmail</button>
        )}
      </div>

      {/* Cards and their bills */}
      <div className="card space-y-3">
        <div>
          <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Your cards</p>
          <p className="text-[11px] text-gray-400 mt-0.5">
            Add each card and the day its bill is generated. The app looks in Gmail from that day to a week after,
            only at that bank's emails, and saves the bill amount for each month.
          </p>
        </div>

        {cards === null && <p className="text-xs text-gray-400">Loading…</p>}
        {cards?.length === 0 && !adding && <p className="text-xs text-gray-500">No cards yet - add your first one below.</p>}

        {cards?.map((c) => (
          <div key={c.id} className="border border-amber-200 rounded-md px-3 py-2.5">
            {editing === c.id ? (
              <CardForm banks={bankOptions} busy={busy} onCancel={() => setEditing(null)}
                initial={{ bank: c.bank, label: c.label || '', last4: c.last4 || '', bill_day: c.bill_day }}
                onSave={(f) => saveCard(f, c.id)} />
            ) : (
              <>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-gray-900">{c.bank}{c.label ? ` ${c.label}` : ''}{c.last4 ? ` •••• ${c.last4}` : ''}</p>
                    <p className="text-[11px] text-gray-400">Bill on the {ord(c.bill_day)} · next {day(c.next_bill)}</p>
                  </div>
                  <div className="flex gap-3 shrink-0 text-[11px] font-bold">
                    <button onClick={() => setEditing(c.id)} className="text-gray-400 hover:text-brand-500">Edit</button>
                    <button onClick={() => confirm(`Remove ${c.bank}${c.last4 ? ` •••• ${c.last4}` : ''} and its saved bills?`) && run(() => deleteCard(c.id))}
                      className="text-gray-400 hover:text-red-500">Remove</button>
                  </div>
                </div>
                <div className="mt-2 space-y-1.5">
                  {lastPeriods(c.last_bill, MONTHS_BACK).map((period) => {
                    const b = c.bills.find((x) => x.period === period)
                    const r = results[`${c.id}:${period}`]
                    return (
                      <div key={period} className="bg-amber-50/60 border border-amber-100 rounded-md px-2.5 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-bold text-gray-600">{monthName(period)}</span>
                          {b ? <span className="text-sm font-black text-gray-900">{b.total_due != null ? INR(b.total_due) : '—'}</span>
                            : <span className="text-[11px] text-gray-400">{r?.status === 'not_found' ? 'Not found' : 'Not fetched yet'}</span>}
                        </div>
                        {b && (
                          <>
                            <p className="text-[10px] text-gray-500">
                              {b.due_date ? `Due ${day(b.due_date)}` : 'Due date not in the email'}
                              {b.minimum_due != null ? ` · minimum ${INR(b.minimum_due)}` : ''}
                              {b.statement_date ? ` · billed ${day(b.statement_date)}` : ''}
                            </p>
                            <p className="text-[10px] text-gray-400 truncate">
                              From {b.source === 'pdf' ? 'the PDF of' : ''} “{b.email_subject || 'statement email'}” ·{' '}
                              <button onClick={() => confirm('Remove this bill? The next search looks for this month again.') && run(() => deleteCardBill(b.id))}
                                className="font-bold text-gray-400 hover:text-red-500">Wrong? Remove</button>
                            </p>
                          </>
                        )}
                        {!b && r?.why && <p className="text-[10px] text-gray-400 leading-snug">{r.why}</p>}
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        ))}

        {adding ? (
          <CardForm banks={bankOptions} busy={busy} initial={BLANK} onCancel={() => setAdding(false)} onSave={(f) => saveCard(f)} />
        ) : (
          <button onClick={() => setAdding(true)} className="w-full text-xs font-bold text-brand-500 border border-dashed border-amber-300 rounded-md py-2">
            + Add a card
          </button>
        )}

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
      </div>

      {/* Bank passwords */}
      <div className="card space-y-2">
        <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Statement PDF passwords</p>
        <p className="text-[11px] text-gray-400">
          Only needed when a bank puts the amount in a locked PDF instead of the email itself. Entered once, reused every month.
        </p>
        {banks.length > 0 && (
          <div className="space-y-1">
            {banks.map((b) => (
              <div key={b.bank} className="flex items-center justify-between text-xs">
                <span className="font-semibold text-gray-700">{b.bank}</span>
                <button onClick={() => confirm(`Remove the saved password for ${b.bank}?`) && run(() => deleteCardBank(b.bank))}
                  className="text-gray-400 hover:text-red-500 font-bold">Remove</button>
              </div>
            ))}
          </div>
        )}
        <form className="flex flex-col gap-2 pt-1" onSubmit={(e) => {
          e.preventDefault()
          if (!bankName.trim() || !bankPw) return setError('Bank name and password are required.')
          run(() => setCardBankPassword({ bank: bankName.trim(), password: bankPw }))
          setBankName(''); setBankPw('')
        }}>
          <input className="input text-sm" placeholder="Bank name (e.g. HDFC)" value={bankName}
            onChange={(e) => setBankName(e.target.value)} autoComplete="off" name="bank-name" />
          <input className="input text-sm" placeholder="PDF password" type="password" value={bankPw}
            onChange={(e) => setBankPw(e.target.value)} autoComplete="current-password" name="bank-pdf-password" />
          <button type="submit" disabled={busy} className="btn-primary py-2.5 text-xs w-full">Save</button>
        </form>
      </div>
    </div>
  )
}
