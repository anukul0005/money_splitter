import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  getCardBillDetails, readCardBillDetails, listCards, fetchCardMonth,
  getCardPassword, setCardPassword, listCardBanks, setCardBankPassword, deleteCardBank, revealBankPassword,
} from '../api'
import Dropdown from '../components/Dropdown'
import { PassOnSheet, emiOf, passable } from '../components/PassOn'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const day = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '')
const longDay = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : 'No date')
const monthName = (period) => (period ? new Date(`${period}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) : '')
const Label = ({ children }) => <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">{children}</p>

const FILTERS = [['all', 'All'], ['spends', 'Spends'], ['credits', 'Payments & refunds'], ['fees', 'Fees']]

const isSpend = (x) => x.type === 'debit' && x.category !== 'Card fees & interest'
const addDays = (iso, n) => {
  const t = new Date(`${iso}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() + n)
  return t.toISOString().slice(0, 10)
}
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000)

/**
 * The bill period cut into its first 10 days, middle 10 and the rest
 * (a 30-day bill: 10/10/10, a 31-day one: 10/10/11), with what was spent
 * in each. Spends only - payments, refunds and fees don't count. A
 * transaction dated a day outside the period (banks post a few that way)
 * goes in the nearest window.
 */
function billWindows(summary, transactions) {
  const dated = transactions.filter((x) => x.date)
  let from = summary.period_from, to = summary.period_to
  if (!from || !to) {
    if (!dated.length) return null
    const ds = dated.map((x) => x.date).sort()
    from = from || ds[0]
    to = to || ds[ds.length - 1]
  }
  const length = daysBetween(from, to) + 1
  if (length < 15) return null      // too short a period to split in three
  const bounds = [[0, 9], [10, 19], [20, length - 1]]
  const names = ['First 10 days', 'Middle 10 days', `Last ${length - 20} days`]
  const wins = bounds.map(([a, b], i) => ({
    key: i, name: names[i], from: addDays(from, a), to: addDays(from, b),
    days: b - a + 1, amount: 0, count: 0,
  }))
  for (const x of dated) {
    if (!isSpend(x)) continue
    const off = daysBetween(from, x.date)
    const w = wins[off < 10 ? 0 : off < 20 ? 1 : 2]
    w.amount += x.amount
    w.count += 1
  }
  const total = wins.reduce((t, w) => t + w.amount, 0)
  return total > 0 ? { wins, total } : null
}

function windowOf(win, x) {
  if (!win || !x.date) return false
  const { key, from, to } = win
  // the outer windows also take the stray day or two outside the period
  return (key === 0 || x.date >= from) && (key === 2 || x.date <= to)
}

function SpendWindows({ data, selected, onSelect }) {
  const { wins, total } = data
  const max = Math.max(...wins.map((w) => w.amount), 1)
  const top = wins.reduce((a, b) => (b.amount > a.amount ? b : a))
  const share = (w) => Math.round((w.amount / total) * 100)
  return (
    <div className="card space-y-3">
      <div className="flex items-baseline justify-between">
        <Label>When in the bill</Label>
        <span className="text-[11px] text-gray-500">{INR(total)} spent</span>
      </div>
      <p className="text-xs text-gray-700">
        <b>{share(top)}%</b> of this bill was spent in the <b>{top.name.toLowerCase()}</b>
        {` (${day(top.from)} – ${day(top.to)}).`}
      </p>
      <div className="grid grid-cols-3 gap-3 pt-1" role="list">
        {wins.map((w) => {
          const on = selected === w.key
          const dim = selected != null && !on
          return (
            <button
              key={w.key}
              role="listitem"
              onClick={() => onSelect(on ? null : w.key)}
              aria-pressed={on}
              title={`${w.name}: ${INR(w.amount)} over ${w.count} transaction${w.count === 1 ? '' : 's'}, ${INR(Math.round(w.amount / w.days))} a day`}
              className={`text-left transition-opacity ${dim ? 'opacity-40' : ''}`}
            >
              <p className="text-sm font-black text-gray-900 tabular-nums">{INR(Math.round(w.amount))}</p>
              <p className="text-[10px] text-gray-500 tabular-nums">{share(w)}%</p>
              {/* bar area: a fixed-height track, the bar anchored to its floor */}
              <div className="h-28 mt-1.5 flex items-end border-b border-amber-200">
                <div
                  className={`w-full rounded-t ${on ? 'bg-brand-500' : 'bg-brand-400'}`}
                  style={{ height: `${Math.max((w.amount / max) * 100, w.amount > 0 ? 3 : 0)}%` }}
                />
              </div>
              <p className="text-[11px] font-bold text-gray-800 mt-1.5 leading-tight">{w.name}</p>
              <p className="text-[10px] text-gray-500">{day(w.from)} – {day(w.to)}</p>
              <p className="text-[10px] text-gray-400 mt-0.5 tabular-nums">
                {w.count} txn{w.count === 1 ? '' : 's'} · {INR(Math.round(w.amount / w.days))}/day
              </p>
            </button>
          )
        })}
      </div>
      {selected != null && (
        <p className="text-[11px] text-brand-500 font-bold">
          Showing {wins[selected].name.toLowerCase()} below · tap it again for all
        </p>
      )}
    </div>
  )
}

/**
 * One credit card bill's detailed breakup, read from its statement PDF
 * (backend card_details.py): the summary, spending by category, the
 * biggest merchants and every transaction. Read once in the background,
 * then saved - this polls while it's being read.
 */
function BillBreakup({ billId: id }) {
  const nav = useNavigate()
  const [passing, setPassing] = useState(null)     // { x, line } - the spend being passed on
  const [d, setD] = useState(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const [category, setCategory] = useState(null)
  const [windowKey, setWindowKey] = useState(null)   // a "When in the bill" column, tapped
  const started = useRef(false)

  // Each bill shown gets a generation number; a poll from a bill the
  // month picker has since moved away from (or a closed page) is dropped.
  const gen = useRef(0)
  const poll = async (g) => {
    if (g !== gen.current) return
    try {
      let r = (await getCardBillDetails(id)).data
      if (g !== gen.current) return
      if (r.status === 'none' && !started.current) {
        started.current = true
        await readCardBillDetails(id)
        r = { ...r, status: 'reading', step: 'Opening the statement email…' }
      }
      setD(r)
      if (r.status === 'reading') setTimeout(() => poll(g), 2000)
    } catch (e) {
      if (g === gen.current) setError(e.response?.data?.detail || 'Could not load this bill.')
    }
  }
  useEffect(() => {
    const g = ++gen.current
    started.current = false
    setD(null); setError(''); setFilter('all'); setCategory(null)
    poll(g)
    return () => { gen.current++ }
  }, [id])

  const readAgain = async () => {
    setError('')
    try {
      await readCardBillDetails(id)
      setD((x) => ({ ...x, status: 'reading', step: 'Opening the statement email…' }))
      const g = gen.current
      setTimeout(() => poll(g), 2000)
    } catch (e) { setError(e.response?.data?.detail || 'Could not start reading.') }
  }

  const b = d?.bill
  if (error && !d) return <p className="text-sm text-red-600">{error}</p>
  if (!d || d.status === 'reading') return (
    <div>
      <div className="flex flex-col items-center py-14 gap-3 px-8 text-center">
        <div className="w-8 h-8 border-[3px] border-brand-400/30 border-t-brand-400 rounded-full animate-spin" />
        <p className="text-xs text-gray-600">{d?.step || 'Loading…'}</p>
        <p className="text-[11px] text-gray-400">The first read of a statement takes up to a minute. After that it opens instantly.</p>
      </div>
    </div>
  )
  if (d.status === 'error') return (
    <div>
      <div className="space-y-3">
        <p className="text-sm text-red-600">{d.error}</p>
        {/password/i.test(d.error || '') && (
          <p className="text-[11px] text-gray-500">Set this card's PDF password in the section below, then try again.</p>
        )}
        <button onClick={readAgain} className="btn-primary py-2.5 text-xs w-full">Try again</button>
      </div>
    </div>
  )

  const s = d.summary || {}
  const t = d.totals
  const windows = billWindows(s, d.transactions)
  const win = windows && windowKey != null ? windows.wins[windowKey] : null
  const txns = d.transactions.filter((x) => {
    if (win) return isSpend(x) && windowOf(win, x)
    if (category) return x.category === category && x.type === 'debit'
    if (filter === 'spends') return x.type === 'debit' && x.category !== 'Card fees & interest'
    if (filter === 'credits') return x.type === 'credit'
    if (filter === 'fees') return x.category === 'Card fees & interest'
    return true
  })
  const byDate = []
  for (const x of txns) {
    const last = byDate[byDate.length - 1]
    if (last && last.date === x.date) last.items.push(x)
    else byDate.push({ date: x.date, items: [x] })
  }
  const maxCat = Math.max(...d.by_category.map((c) => c.amount), 1)
  const rows = [
    ['Previous balance', s.previous_balance, ''],
    ['Payments & credits', s.payments_credits, '−'],
    ['Purchases & debits', s.purchases_debits, '+'],
    ['Fees & charges', s.fees_charges, '+'],
    ['Interest', s.interest, '+'],
    ['Taxes', s.taxes, '+'],
  ].filter((r) => r[1] != null)

  return (
    <div>
      <div className="space-y-4">

        {/* Summary */}
        <div className="card space-y-2">
          <Label>Statement summary</Label>
          {s.period_from && s.period_to && (
            <p className="text-[11px] text-gray-400">{day(s.period_from)} – {day(s.period_to)}</p>
          )}
          <div className="space-y-1.5 pt-1">
            {rows.map(([label, v, sign]) => (
              <div key={label} className="flex items-center justify-between text-xs">
                <span className="text-gray-600">{label}</span>
                <span className={`font-bold ${sign === '−' ? 'text-green-700' : 'text-gray-800'}`}>{sign}{INR(v)}</span>
              </div>
            ))}
            <div className="flex items-center justify-between text-sm pt-1.5 border-t border-dashed border-amber-200">
              <span className="font-bold text-gray-900">Total due</span>
              <span className="font-black text-gray-900">{INR(s.total_due ?? b.total_due ?? 0)}</span>
            </div>
            {s.minimum_due != null && (
              <div className="flex items-center justify-between text-[11px] text-gray-500">
                <span>Minimum due</span><span>{INR(s.minimum_due)}</span>
              </div>
            )}
          </div>
          {d.check && (
            <p className={`text-[11px] font-bold pt-1 ${d.check.ok ? 'text-green-700' : 'text-amber-700'}`}>
              {d.check.ok
                ? '✓ The transactions below add up to this bill'
                : `The transactions add up to ${INR(d.check.expected)}, the bill says ${INR(d.check.total_due)} - a line or two may not have been read`}
            </p>
          )}
          {(s.credit_limit != null || s.reward_points != null) && (
            <p className="text-[11px] text-gray-400">
              {s.credit_limit != null ? `Limit ${INR(s.credit_limit)}` : ''}
              {s.available_limit != null ? ` · available ${INR(s.available_limit)}` : ''}
              {s.reward_points != null ? ` · ${Number(s.reward_points).toLocaleString('en-IN')} reward points` : ''}
            </p>
          )}
        </div>

        {/* By category */}
        <div className="card space-y-2.5">
          <div className="flex items-baseline justify-between">
            <Label>Where it went</Label>
            <span className="text-[11px] text-gray-500">{INR(t.spent)} spent{t.fees > 0 ? ` + ${INR(t.fees)} fees` : ''}</span>
          </div>
          {d.by_category.length === 0 && <p className="text-xs text-gray-500">No spends on this bill.</p>}
          {d.by_category.map((c) => (
            <button key={c.category} onClick={() => { setCategory(category === c.category ? null : c.category); setFilter('all'); setWindowKey(null) }}
              className={`w-full text-left ${category && category !== c.category ? 'opacity-40' : ''}`}>
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-gray-800">{c.category}</span>
                <span className="text-gray-600"><b className="text-gray-900">{INR(c.amount)}</b> · {c.share}%</span>
              </div>
              <div className="h-1.5 bg-amber-100 mt-1">
                <div className="h-1.5 bg-brand-400" style={{ width: `${(c.amount / maxCat) * 100}%` }} />
              </div>
              <p className="text-[10px] text-gray-400 mt-0.5">{c.count} transaction{c.count === 1 ? '' : 's'}</p>
            </button>
          ))}
          {category && <p className="text-[11px] text-brand-500 font-bold">Showing {category} below · tap it again for all</p>}
        </div>

        {/* First / middle / last 10 days */}
        {windows && (
          <SpendWindows
            data={windows}
            selected={windowKey}
            onSelect={(k) => { setWindowKey(k); setCategory(null); setFilter('all') }}
          />
        )}

        {/* Merchants */}
        {d.top_merchants.length > 0 && (
          <div className="card space-y-1.5">
            <Label>Biggest merchants</Label>
            {d.top_merchants.map((m, i) => (
              <div key={m.name} className="flex items-center justify-between text-xs py-0.5">
                <span className="text-gray-700"><span className="text-gray-300 mr-1.5">{i + 1}</span>{m.name}
                  {m.count > 1 && <span className="text-gray-400"> · {m.count}×</span>}</span>
                <span className="font-bold text-gray-900">{INR(m.amount)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Transactions */}
        <div className="card space-y-3">
          <div className="flex items-baseline justify-between">
            <Label>Transactions</Label>
            <span className="text-[11px] text-gray-400">{txns.length} of {t.count}</span>
          </div>
          {!category && !win && (
            <div className="flex gap-1.5 flex-wrap">
              {FILTERS.map(([k, l]) => (
                <button key={k} onClick={() => setFilter(k)}
                  className={`px-2.5 py-1 text-[11px] font-bold border rounded-md ${filter === k ? 'bg-brand-400 border-brand-400 text-white' : 'border-amber-200 text-gray-600'}`}>
                  {l}
                </button>
              ))}
            </div>
          )}
          {byDate.map((g) => (
            <div key={g.date || 'none'}>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">{longDay(g.date)}</p>
              {g.items.map((x, i) => {
                const line = d.transactions.indexOf(x)
                const sent = d.transfers?.[String(line)] || []
                const sentTotal = sent.reduce((s, t) => s + t.amount, 0)
                const covered = d.emi_covered?.[String(line)]   // a later instalment of an EMI already passed on
                return (
                <div key={i} className="flex items-start justify-between gap-3 py-1.5 border-b border-amber-100 last:border-0">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-gray-800 leading-snug">{x.description}</p>
                    <p className="text-[10px] text-gray-400">
                      {x.time ? `${x.time} · ` : ''}{x.category}{x.subcategory ? ` · ${x.subcategory}` : ''}
                      {x.kind === 'refund' ? ' · refund' : x.kind === 'cashback' ? ' · cashback' : ''}
                      {x.foreign_amount ? ` · ${x.currency} ${Number(x.foreign_amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : ''}
                    </p>
                    {sent.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {sent.map((t) => (
                          <button key={t.loan_id} onClick={() => nav(`/loans?tab=loans&loan=${t.loan_id}`)}
                            className="text-[10px] font-bold text-green-700 bg-green-50 border border-green-200 rounded px-1.5 py-px">
                            → {t.to} {INR(t.amount)}
                          </button>
                        ))}
                      </div>
                    )}
                    {covered && (
                      <button onClick={() => nav(`/loans?tab=loans&loan=${covered.loan_id}`)}
                        className="text-[10px] font-bold text-green-700 bg-green-50 border border-green-200 rounded px-1.5 py-px mt-0.5">
                        → {covered.to} · EMI {covered.at} of {covered.of}, in the loan already
                      </button>
                    )}
                    {!covered && x.category !== 'Card fees & interest' && (x.type === 'debit' || emiOf(x)) && sentTotal < passable(x) - 0.5 && (
                      <button onClick={() => setPassing({ x, line, already: sentTotal })}
                        className="text-[10px] font-bold text-brand-500 mt-0.5">{sent.length ? '+ pass on more' : 'Split / pass on'}</button>
                    )}
                  </div>
                  <span className={`text-xs font-bold shrink-0 ${x.type === 'credit' ? 'text-green-700' : 'text-gray-900'}`}>
                    {x.type === 'credit' ? '−' : ''}{INR(x.amount)}
                  </span>
                </div>
                )
              })}
            </div>
          ))}
          {txns.length === 0 && <p className="text-xs text-gray-500">Nothing here.</p>}
        </div>

        <p className="text-[10px] text-gray-400 text-center">
          Read from the statement PDF
          {d.pages ? ` (pages 1–${d.pages.read} of ${d.pages.total}${d.pages.read < d.pages.total ? ' - the rest are terms and offers' : ''})` : ''}
          {d.read_at ? ` on ${new Date(d.read_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}
          {t.categorised ? ` · ${t.categorised_by_ai} of ${t.categorised} spends categorised by AI` : ''} ·{' '}
          <button onClick={readAgain} className="font-bold text-brand-500">Read again</button>
        </p>
        {error && <p className="text-xs text-red-600 text-center">{error}</p>}
      </div>
      {passing && (
        <PassOnSheet x={passing.x} all={d.transactions} refKey={`bill:${id}:${passing.line}`} already={passing.already} source={b?.card || ''} dueDate={b?.due_date}
          onClose={() => setPassing(null)}
          onDone={() => { setPassing(null); getCardBillDetails(id).then((r) => setD(r.data)).catch(() => {}) }} />
      )}
    </div>
  )
}

// One saved password: hidden until "Show" (fetched then, never kept in
// the card list), editable in place, removable.
function PasswordRow({ name, reveal, save, remove, empty }) {
  const [shown, setShown] = useState(null)       // the password, while shown
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const act = async (fn) => {
    setBusy(true); setErr('')
    try { await fn() } catch (e) { setErr(e.response?.data?.detail || 'Something went wrong.') } finally { setBusy(false) }
  }
  const toggleShow = () => (shown != null ? setShown(null) : act(async () => setShown((await reveal()) || '')))
  return (
    <div className="py-2 border-b border-amber-100 last:border-0">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-bold text-gray-800 truncate">{name}</p>
          {!editing && (
            <p className="text-xs text-gray-500 mt-0.5 font-mono break-all">
              {empty ? <span className="font-sans text-gray-400">No password set</span> : shown != null ? (shown || '(empty)') : '••••••••'}
            </p>
          )}
        </div>
        {!editing && (
          <div className="flex gap-3 shrink-0 text-[11px] font-bold">
            {!empty && <button onClick={toggleShow} disabled={busy} className="text-gray-400 hover:text-brand-500">{shown != null ? 'Hide' : 'Show'}</button>}
            <button onClick={() => { setEditing(true); setValue(shown || ''); setShown(null) }} className="text-gray-400 hover:text-brand-500">
              {empty ? 'Set' : 'Edit'}
            </button>
            {!empty && remove && (
              <button onClick={() => confirm(`Remove the saved password for ${name}?`) && act(remove)} disabled={busy}
                className="text-gray-400 hover:text-red-500">Remove</button>
            )}
          </div>
        )}
      </div>
      {editing && (
        <form className="flex gap-2 mt-2" onSubmit={(e) => { e.preventDefault(); act(async () => { await save(value); setEditing(false) }) }}>
          <input className="input text-sm flex-1 min-w-0" value={value} onChange={(e) => setValue(e.target.value)} autoFocus
            placeholder="PDF password" autoComplete="off" autoCapitalize="none" spellCheck={false} name="statement-pdf-password" />
          <button type="submit" disabled={busy || !value} className="btn-primary text-xs py-2 px-3 w-auto disabled:opacity-50">Save</button>
          <button type="button" onClick={() => setEditing(false)} className="text-xs font-bold text-gray-500 px-1">Cancel</button>
        </form>
      )}
      {err && <p className="text-[11px] text-red-600 mt-1">{err}</p>}
    </div>
  )
}

/**
 * The passwords that open statement PDFs: this card's own (tried first),
 * and the older ones saved by bank name, which are still tried on every
 * card. Shown only on request; the server decrypts for the owner alone.
 */
function PasswordsPanel({ card, onChanged }) {
  const [others, setOthers] = useState([])
  const loadOthers = () => listCardBanks().then((r) => setOthers(r.data)).catch(() => {})
  useEffect(() => { loadOthers() }, [])
  return (
    <div className="card space-y-1">
      <Label>Statement PDF password</Label>
      <p className="text-[11px] text-gray-400 leading-relaxed">
        Opens this card's statement PDF for the breakup. Usually a fixed formula from the bank - e.g. part of your name and date of birth.
      </p>
      <PasswordRow name={`This card${card.last4 ? ` (•••• ${card.last4})` : ''}`} empty={!card.has_password}
        reveal={async () => (await getCardPassword(card.id)).data.password}
        save={async (v) => { await setCardPassword(card.id, v); onChanged() }}
        remove={async () => { await setCardPassword(card.id, ''); onChanged() }} />
      {others.length > 0 && (
        <>
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pt-3">Saved earlier · tried on every card</p>
          {others.map((b) => (
            <PasswordRow key={b.bank} name={b.bank}
              reveal={async () => (await revealBankPassword(b.bank)).data.password}
              save={async (v) => { await setCardBankPassword({ bank: b.bank, password: v }); loadOthers() }}
              remove={async () => { await deleteCardBank(b.bank); loadOthers() }} />
          ))}
        </>
      )}
    </div>
  )
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const pad = (n) => String(n).padStart(2, '0')

/**
 * /credit-cards/card/:id - one credit card, opened by tapping it on the
 * Credit Cards tab. Month and year pickers choose the bill; a month with a
 * saved bill shows its breakup, one without can be looked up in Gmail.
 */
export default function CardPage() {
  const { id } = useParams()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const [card, setCard] = useState(null)
  const [error, setError] = useState('')
  const [finding, setFinding] = useState(false)
  const [notFound, setNotFound] = useState('')

  const load = () => listCards().then((r) => {
    const c = r.data.find((x) => String(x.id) === String(id))
    if (!c) setError('Card not found.')
    setCard(c || null)
    return c
  }).catch(() => setError('Could not load this card.'))

  useEffect(() => { load() }, [id])

  const period = params.get('period') || card?.bills[0]?.period || card?.last_bill?.slice(0, 7) || ''
  const [year, month] = period ? period.split('-').map(Number) : [new Date().getFullYear(), new Date().getMonth() + 1]
  const setPeriod = (y, m) => { setNotFound(''); setParams({ period: `${y}-${pad(m)}` }, { replace: true }) }
  const bill = card?.bills.find((b) => b.period === period)

  const now = new Date()
  const firstYear = Math.min(now.getFullYear() - 1, ...(card?.bills || []).map((b) => Number(b.period.slice(0, 4))))
  const years = []
  for (let y = now.getFullYear(); y >= firstYear; y--) years.push({ value: y, label: String(y) })
  const saved = Object.fromEntries((card?.bills || []).map((b) => [b.period, b]))
  const monthOptions = MONTHS.map((name, i) => {
    const b = saved[`${year}-${pad(i + 1)}`]
    return { value: i + 1, label: b && b.total_due != null ? `${name} · ${INR(b.total_due)}` : name }
  })

  const findInGmail = async () => {
    setFinding(true); setNotFound('')
    try {
      const r = (await fetchCardMonth(id, period)).data
      if (r.status === 'not_found') setNotFound(r.why || 'No bill found for this month.')
      await load()
    } catch (e) {
      setNotFound(e.response?.data?.detail || 'Could not search Gmail just now.')
    } finally { setFinding(false) }
  }

  return (
    <div className="pb-24 md:pb-8">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Credit cards</button>
        <h1 className="text-xl font-black tracking-tight">
          {card ? `${card.bank}${card.label ? ` ${card.label}` : ''}` : 'Credit card'}
        </h1>
        {card && (
          <p className="text-xs text-gray-500 mt-1">
            {card.last4 ? `•••• ${card.last4} · ` : ''}bill generated on the {card.bill_day}{[1, 21, 31].includes(card.bill_day) ? 'st' : [2, 22].includes(card.bill_day) ? 'nd' : [3, 23].includes(card.bill_day) ? 'rd' : 'th'}
          </p>
        )}
        {card && (
          <div className="flex gap-2 mt-3">
            <Dropdown className="flex-1" value={month} onChange={(m) => setPeriod(year, Number(m))} options={monthOptions} />
            <Dropdown className="w-28" value={year} onChange={(y) => setPeriod(Number(y), month)} options={years} />
          </div>
        )}
      </div>

      <div className="px-4 md:px-5 mt-4 max-w-2xl">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!card && !error && <p className="text-xs text-gray-400 text-center py-10">Loading…</p>}

        {card && bill && (
          <>
            <div className="card mb-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-gray-900">{MONTHS[month - 1]} {year} bill</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {bill.due_date ? `Due ${day(bill.due_date)}` : ''}{bill.minimum_due != null ? ` · minimum ${INR(bill.minimum_due)}` : ''}
                  </p>
                </div>
                <p className="text-base font-black text-gray-900 shrink-0">{bill.total_due != null ? INR(bill.total_due) : '—'}</p>
              </div>
              {bill.paid > 0 && (
                <p className={`text-[11px] font-bold mt-1.5 ${bill.remaining <= 0.01 ? 'text-green-700' : 'text-red-600'}`}>
                  Paid {INR(bill.paid)}{bill.remaining <= 0.01 ? ' · paid in full ✓' : ` · ${INR(bill.remaining)} left`}
                </p>
              )}
            </div>
            <BillBreakup billId={bill.id} />
          </>
        )}

        {card && !bill && period && (
          <div className="card text-center space-y-3 py-6">
            <p className="text-sm text-gray-600">No {MONTHS[month - 1]} {year} bill saved for this card.</p>
            {notFound && <p className="text-[11px] text-gray-400 leading-relaxed">{notFound}</p>}
            <button onClick={findInGmail} disabled={finding} className="btn-primary py-2.5 text-xs w-full disabled:opacity-50">
              {finding ? 'Searching Gmail…' : `Find the ${MONTHS[month - 1]} bill in Gmail`}
            </button>
          </div>
        )}

        {card && <div className="mt-4"><PasswordsPanel card={card} onChanged={load} /></div>}
      </div>
    </div>
  )
}
