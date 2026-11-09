import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  getFriends, getGroups, getLoans, getStatement, listUpiIdsFor, listMyUpiIds, createPaymentClaim,
  sendNudge, getRecentNudges,
} from '../api'
import { MONEY_CHANGED } from '../components/PaymentClaimsInbox'
import { useUser } from '../UserContext'
import { owes, owed } from '../utils/money'
import { combinedBalances } from '../utils/balances'
import LoadingSpinner from '../components/LoadingSpinner'
import RecordPaymentModal from '../components/RecordPaymentModal'
import PayViaUpi from '../components/PayViaUpi'
import { dn } from '../utils/displayName'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const same = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase()

/** "28 Aug 2026, 6:20 pm" — when the payment was actually entered. */
function stamp(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}


/** "just now", "3 h ago", "2 days ago" */
function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 2) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`
  return `${Math.round(mins / 1440)} days ago`
}

/** "8 Nov 26" from "2026-11-08" */
const shortDate = (iso) => {
  const d = iso ? new Date(`${iso}T00:00:00`) : null
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : iso || ''
}

/** An EMI loan's open instalments, soonest first: each date, that EMI, and the total to be paid by then. */
function DueBy({ emis, positive }) {
  let run = 0
  return (
    <span className="block mt-1.5 space-y-0.5">
      <span className="flex text-[8.87px] font-bold uppercase tracking-widest text-gray-400">
        <span className="flex-1">Due by</span><span className="w-20 text-right">EMI</span><span className="w-20 text-right">Total by then</span>
      </span>
      {emis.map((i, k) => {
        run += i.balance
        return (
          <span key={k} className="flex text-[0.68rem] tabular-nums">
            <span className={`flex-1 font-semibold ${i.overdue ? 'text-red-600' : 'text-gray-600'}`}>
              {shortDate(i.date)}{i.overdue ? ' · overdue' : ''}
            </span>
            <span className="w-20 text-right font-bold text-gray-700">{INR(i.balance)}</span>
            <span className={`w-20 text-right font-black ${positive ? 'text-green-700' : 'text-red-700'}`}>{INR(run)}</span>
          </span>
        )
      })}
    </span>
  )
}

/** The next EMI across someone's loans: {date, amount} (every EMI on that date added up), or null. */
const nextEmi = (items) => {
  const all = items.flatMap((it) => it.emis || [])
  if (!all.length) return null
  const date = all.map((i) => i.date).sort()[0]
  return { date, amount: all.filter((i) => i.date === date).reduce((s, i) => s + i.balance, 0),
           overdue: all.some((i) => i.date === date && i.overdue) }
}

/** A loan or recurring bill in a balance breakdown. */
function LoanItem({ it, nav }) {
  return (
    // Straight to that bill or loan, on its own tab: "bill7" -> /loans?tab=bills&bill=7
    <button onClick={() => {
      const [, kind, id] = it.key.match(/^(bill|loan)(\d+)$/) || []
      nav(kind ? `/loans?tab=${kind === 'bill' ? 'bills' : 'loans'}&${kind}=${id}` : '/loans')
    }}
      className="w-full text-left block rounded-md px-3 py-2 border-2 border-dashed border-orange-200 bg-orange-50 hover:bg-orange-100 transition-colors">
      <span className="flex items-center gap-2">
        <span className="text-[8.87px] font-bold uppercase tracking-widest text-orange-600 flex-shrink-0">{it.emis?.length ? 'EMI loan' : it.tag}</span>
        <span className="text-[0.739rem] font-semibold text-gray-700 flex-1 min-w-0 truncate">{it.label}</span>
        <span className={`text-[0.739rem] font-black flex-shrink-0 ${it.positive ? 'text-green-700' : 'text-red-700'}`}>
          {INR(it.amount)}
        </span>
      </span>
      {it.emis?.length > 0
        ? <DueBy emis={it.emis} positive={it.positive} />
        : it.tag === 'Loan' && it.dueDate && <span className="block text-[9.85px] text-gray-500 mt-0.5">Due by {shortDate(it.dueDate)}</span>}
    </button>
  )
}

/** "you owe ₹X" / "owes you ₹X" / "even" - a running balance, from your side. */
function Standing({ bal, name }) {
  if (Math.abs(bal) < 1) return <span className="text-gray-400">even</span>
  return bal > 0
    ? <span className="text-green-700">{dn(name)} owes {INR(bal)}</span>
    : <span className="text-red-700">you owe {INR(-bal)}</span>
}

/** What one statement line was, in words. */
function describe(x, name, me) {
  const them = dn(name)
  const amt = INR(Math.abs(x.amount))
  const byMe = same(x.payer, me)
  switch (x.kind) {
    case 'group':
      return { title: x.amount > 0 ? `${them} owed you ${amt}` : `You owed ${them} ${amt}`, sub: `Group “${x.label}”`, link: `/groups/${x.group_id}` }
    case 'loan':
      return {
        title: x.amount < 0 ? `Loan: you borrowed ${INR(x.principal)} from ${them}` : `Loan: you lent ${them} ${INR(x.principal)}`,
        sub: [x.label, x.interest >= 1 && `incl. ${INR(x.interest)} interest`, x.open ? (x.due_date && `due ${shortDate(x.due_date)}`) : 'now repaid']
          .filter(Boolean).join(' · '),
        link: `/loans?tab=loans&loan=${x.loan_id}`, loan: true,
      }
    case 'payment':
      return { title: byMe ? `You paid ${them} ${amt}` : `${them} paid you ${amt}`, sub: `in “${x.label}”${x.note ? ` · ${x.note}` : ''}` }
    case 'repay':
      return { title: x.mine ? `You repaid ${amt} of the ${INR(x.principal)} loan` : `${them} repaid ${amt} of the ${INR(x.principal)} loan`, loan: true }
    case 'setoff':
      return { title: `${INR(x.cash)} of one loan set off against the other`, sub: 'loans both ways cancel out', loan: true }
    case 'bill':
      return { title: x.amount > 0 ? `${them}'s share of ${x.label}` : `Your share of ${x.label}`, sub: 'Recurring bill', loan: true }
    case 'bill_paid':
      return { title: x.amount < 0 ? `${them} paid their ${x.label} share` : `You paid your ${x.label} share`, loan: true }
    case 'settle': {
      const c = x.covers || {}
      const loans = (c.loans || []).map((l) => INR(l.principal))
      const parts = [
        c.groups && `${c.groups} group${c.groups > 1 ? 's' : ''}`,
        loans.length && `${loans.length > 1 ? `${loans.length} loans` : 'the loan'} (${loans.join(' + ')})`,
        c.bills && `${c.bills} bill share${c.bills > 1 ? 's' : ''}`,
      ].filter(Boolean)
      return {
        title: `${byMe ? `You paid ${them}` : `${them} paid you`} ${INR(x.cash)} · settled up`,
        sub: [parts.length && `Cleared ${parts.join(', ')}`, x.note].filter(Boolean).join(' · '),
        settle: true,
      }
    }
    default:
      return { title: 'Other adjustments', sub: 'rounding, and group payments routed through other members' }
  }
}

/** Everything between you and one person, oldest first, with where it left
 *  you after each line - ending at the figure on the card. */
function Statement({ data, name, me, nav }) {
  const [all, setAll] = useState(false)
  const lines = data.lines
  const SHOW = 8
  const from = all ? 0 : Math.max(0, lines.length - SHOW)
  const forward = from > 0 ? lines[from - 1].balance : null
  return (
    <div className="pt-3">
      <p className="text-[9.85px] font-bold text-gray-400 uppercase tracking-widest">How you got here</p>
      <p className="text-[9.85px] text-gray-400 mb-1.5">Every group, loan and payment with {dn(name)}, oldest first - the right column is where it left you.</p>
      <div className="rounded-md border border-gray-200 divide-y divide-gray-100 overflow-hidden">
        {forward !== null && (
          <button onClick={() => setAll(true)} className="w-full flex items-center gap-2 px-3 py-2 bg-gray-50 text-left">
            <span className="flex-1 text-[10.84px] text-gray-500">
              {from} earlier entr{from > 1 ? 'ies' : 'y'} · <span className="font-bold text-brand-600">show all</span>
            </span>
            <span className="text-[10.84px] font-bold tabular-nums"><Standing bal={forward} name={name} /></span>
          </button>
        )}
        {lines.slice(from).map((x, i) => {
          const d = describe(x, name, me)
          const Tag = d.link ? 'button' : 'div'
          return (
            <Tag key={i} onClick={d.link ? () => nav(d.link) : undefined}
              className={`w-full text-left flex gap-2 px-3 py-2 ${d.settle ? 'bg-green-50' : d.loan ? 'bg-orange-50/60' : 'bg-white'} ${d.link ? 'hover:bg-amber-50' : ''}`}>
              <span className="w-11 flex-shrink-0 text-[9.85px] text-gray-400 pt-0.5 tabular-nums">{x.date ? shortDate(x.date).replace(/ \d+$/, '') : ''}</span>
              <span className="flex-1 min-w-0">
                <span className={`block text-[0.739rem] ${d.settle ? 'font-bold text-green-800' : 'font-semibold text-gray-800'}`}>{d.title}</span>
                {d.sub && <span className="block text-[9.85px] text-gray-500">{d.sub}</span>}
              </span>
              <span className="flex-shrink-0 text-right">
                <span className={`block text-[0.739rem] font-black tabular-nums ${x.amount > 0 ? 'text-green-700' : x.amount < 0 ? 'text-red-700' : 'text-gray-400'}`}>
                  {Math.abs(x.amount) < 0.01 ? '±0' : `${x.amount > 0 ? '+' : '−'}${INR(Math.abs(x.amount))}`}
                </span>
                <span className="block text-[9.85px] font-bold tabular-nums"><Standing bal={x.balance} name={name} /></span>
              </span>
            </Tag>
          )
        })}
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-50">
          <span className="flex-1 text-[0.739rem] font-bold text-gray-700">Now</span>
          <span className="text-[0.789rem] font-black tabular-nums"><Standing bal={data.now} name={name} /></span>
        </div>
      </div>
      <p className="text-[9.85px] text-gray-400 mt-1">+ means {dn(name)} owes you more, − means less (or you owe more).</p>
    </div>
  )
}

function PersonCard({ row, owing, expanded, onToggle, nav, me, groupDates, lastNudge, onNudged }) {
  const [stmt, setStmt] = useState(null)

  // The bell: a "settle up" reminder by email + app push. A confirm step
  // first - it reaches a real person - then the server works out the
  // amount itself (routers/nudges.py) and says how it was delivered.
  const [bellOpen, setBellOpen] = useState(false)
  const [nudge, setNudge] = useState({ busy: false, msg: '', err: '' })
  const remind = async (e) => {
    e.stopPropagation()
    setNudge({ busy: true, msg: '', err: '' })
    try {
      const r = (await sendNudge(row.name)).data
      const via = r.channels.map((c) => (c === 'push' ? 'app notification' : 'email')).join(' and ')
      setNudge({ busy: false, msg: `Sent to ${dn(r.name)} by ${via}.`, err: '' })
      setBellOpen(false)
      onNudged(row.name, r.sent_at)
    } catch (err) {
      setNudge({ busy: false, msg: '', err: err.response?.data?.detail || 'Could not send the reminder.' })
    }
  }
  const loanOnly = row.groups.length === 0 && row.loanItems.length > 0
  const next = nextEmi(row.loanItems)

  // "Pay via UPI" - on a "you owe" row this is their saved UPI ID, to
  // actually pay them; on an "owed to you" row there's nothing of theirs to
  // pay into, so it shows your own saved UPI ID/QR instead, to hand to them
  // so they can pay you. Fetched once per card, on first expand.
  const [upiOpen, setUpiOpen] = useState(false)
  const [upiEntry, setUpiEntry] = useState(null)   // null (not fetched) | 'loading' | 'none' | [{upi_id, ...}]

  const toggleUpi = async (e) => {
    e.stopPropagation()
    setUpiOpen((o) => !o)
    if (upiEntry) return
    setUpiEntry('loading')
    try {
      const r = owing ? await listUpiIdsFor(row.name) : await listMyUpiIds()
      setUpiEntry(r.data.length > 0 ? r.data : 'none')
    } catch {
      setUpiEntry('none')
    }
  }

  useEffect(() => {
    if (expanded && stmt === null) {
      setStmt('loading')
      getStatement(row.name).then((r) => setStmt(r.data)).catch(() => setStmt('error'))
    }
  }, [expanded, stmt])
  // A payment recorded meanwhile moves the figure: read the statement again
  useEffect(() => { setStmt((s) => (s && typeof s === 'object' && Math.abs(s.now - row.net) >= 1 ? null : s)) }, [row.net])

  // What makes up the figure now: what's still owed in each group after
  // payments (liveGroups) - this way round and the other - plus open loans
  // & bills; together they add up to the number on the card. How it got
  // there is the statement below.
  const groups = (row.liveGroups ?? row.groups).filter((g) => Math.abs(g.net) >= 1)   // paisa residue isn't a debt
  const since = (g) => g.since || groupDates[g.group_id] || ''
  const byDate = (a, b) => (since(a) > since(b) ? 1 : -1)
  const same_ = groups.filter((g) => (owing ? g.net < 0 : g.net > 0)).sort(byDate)
  const opposite = groups.filter((g) => (owing ? g.net > 0 : g.net < 0)).sort(byDate)

  return (
    <div className={`card ${loanOnly ? 'border-l-4 border-l-orange-400' : ''}`}>
      <div className="w-full flex items-center justify-between gap-3">
        <button onClick={onToggle} className="flex items-center gap-2 min-w-0 flex-1 text-left">
          <svg className={`w-3.5 h-3.5 text-gray-300 flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span
            onClick={(e) => { e.stopPropagation(); nav(`/friends/${encodeURIComponent(row.name)}`) }}
            className="text-[0.764rem] font-bold text-gray-900 hover:text-brand-600 truncate"
          >
            {dn(row.name)} →
          </span>
          {loanOnly && (
            <span className="text-[7.87px] font-bold uppercase tracking-widest text-orange-600 bg-orange-50 border border-orange-200 rounded px-1.5 py-0.5 flex-shrink-0">
              Loan only
            </span>
          )}
        </button>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); setBellOpen((o) => !o); setNudge({ busy: false, msg: '', err: '' }) }}
            title={owing ? `Let ${dn(row.name)} know` : `Remind ${dn(row.name)}`} aria-label="Send a reminder"
            className={`flex items-center justify-center w-6 h-6 rounded-md border transition-all active:scale-95 ${
              bellOpen ? 'bg-brand-400 border-brand-400 text-white' : 'bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
          </button>
          <button
            onClick={toggleUpi}
            title="Pay via UPI" aria-label="Pay via UPI"
            className={`flex items-center justify-center w-6 h-6 rounded-md border text-[10px] font-black transition-all active:scale-95 ${
              upiOpen ? 'bg-brand-400 border-brand-400 text-white' : 'bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100'
            }`}
          >
            ₹
          </button>
          <span className={`text-[0.982rem] font-black ${owing ? 'text-red-600' : 'text-green-600'}`}>
            {INR(Math.abs(row.net))}
          </span>
        </div>
      </div>

      {next && (
        <button onClick={onToggle} className={`block text-left text-[10.84px] font-bold mt-1 pl-5 ${next.overdue ? 'text-red-600' : 'text-gray-600'}`}>
          {next.overdue ? 'EMI overdue' : 'Next EMI'}: {INR(next.amount)} by {shortDate(next.date)}
          <span className="font-normal text-gray-400"> · tap for the schedule</span>
        </button>
      )}
      {lastNudge && !bellOpen && !nudge.msg && (
        <p className="text-[10px] text-gray-400 mt-1 pl-5">Reminded {ago(lastNudge)}</p>
      )}
      {nudge.msg && <p className="text-[10.84px] font-bold text-green-700 mt-2 pl-5">✓ {nudge.msg}</p>}
      {bellOpen && (
        <div className="mt-3 border border-amber-200 bg-amber-50 rounded-md px-3 py-2.5">
          <p className="text-[0.739rem] text-gray-700">
            {owing
              ? <>Let <b>{dn(row.name)}</b> know you owe {INR(Math.abs(row.net))} and will settle it?</>
              : <>Remind <b>{dn(row.name)}</b> to pay you {INR(Math.abs(row.net))}?</>}
          </p>
          <p className="text-[10px] text-gray-500 mt-0.5">
            Sent by email and app notification, with the breakdown{owing ? '' : ' and your UPI ID'}.
            {lastNudge && ` Last reminded ${ago(lastNudge)}.`}
          </p>
          {nudge.err && <p className="text-[10.84px] text-red-600 mt-1">{nudge.err}</p>}
          <div className="flex gap-2 mt-2">
            <button onClick={remind} disabled={nudge.busy}
              className="btn-primary text-[0.739rem] py-1.5 px-3 w-auto disabled:opacity-50">
              {nudge.busy ? 'Sending…' : 'Send reminder'}
            </button>
            <button onClick={(e) => { e.stopPropagation(); setBellOpen(false) }}
              className="text-[0.739rem] font-bold text-gray-500 px-2">Cancel</button>
          </div>
        </div>
      )}

      {upiOpen && (
        <div className="mt-3">
          {upiEntry === 'loading' && <p className="text-xs text-gray-400 text-center py-2">Loading…</p>}
          {upiEntry === 'none' && (
            <p className="text-xs text-gray-400 text-center py-2">
              {owing ? `${dn(row.name)} hasn't added a UPI ID yet.` : "You haven't added a UPI ID yet - add one in Account."}
            </p>
          )}
          {Array.isArray(upiEntry) && (
            <PayViaUpi
              upiId={upiEntry[0].upi_id}
              payeeName={owing ? row.name : me}
              amount={Math.abs(row.net)}
              note={owing ? `Settling up with ${dn(row.name)}` : `${dn(row.name)} paying ${dn(me)}`}
              showAppButtons={owing}
              onClaim={owing
                ? (amt) => createPaymentClaim({ payee: row.name, amount: amt, kind: 'balance', note: `Settling up with ${row.name}` })
                : undefined}
            />
          )}
        </div>
      )}

      {expanded && (
        <div className="space-y-1.5 mt-3">
          <p className="text-[9.85px] font-bold text-gray-400 uppercase tracking-widest">
            What makes up {INR(Math.abs(row.net))} now
          </p>
          {/* Everything still open, each way - these add up to the figure:
              what's owed in each group after payments, then loans & bills
              (dashed orange). */}
          {[...same_].reverse().map((g) => (
            <button key={g.group_id} onClick={() => nav(`/groups/${g.group_id}`)}
              className={`w-full text-left rounded-md px-3 py-2 border transition-colors ${
                owing ? 'bg-red-50 border-red-100 hover:bg-red-100' : 'bg-green-50 border-green-200 hover:bg-green-100'
              }`}>
              <span className="flex items-center gap-2">
                <span className="text-[8.87px] font-bold uppercase tracking-widest text-gray-400 flex-shrink-0">Group</span>
                <span className="text-[0.739rem] font-semibold text-gray-700 flex-1 min-w-0 truncate">{g.name}</span>
                <span className={`text-[0.739rem] font-black flex-shrink-0 ${owing ? 'text-red-700' : 'text-green-700'}`}>
                  {INR(Math.abs(g.net))}
                </span>
              </span>
              <span className="block text-[9.85px] text-gray-500 mt-0.5">
                {owing ? `you owe ${dn(row.name)} here` : `${dn(row.name)} owes you here`}
              </span>
            </button>
          ))}
          {[...opposite].reverse().map((g) => (
            <button key={g.group_id} onClick={() => nav(`/groups/${g.group_id}`)}
              className="w-full text-left rounded-md px-3 py-2 border border-gray-200 bg-gray-50 hover:bg-gray-100 transition-colors">
              <span className="flex items-center gap-2">
                <span className="text-[8.87px] font-bold uppercase tracking-widest text-gray-400 flex-shrink-0">Group</span>
                <span className="text-[0.739rem] font-semibold text-gray-600 flex-1 min-w-0 truncate">{g.name}</span>
                <span className="text-[0.739rem] font-black flex-shrink-0 text-gray-500">−{INR(Math.abs(g.net))}</span>
              </span>
              <span className="block text-[9.85px] text-gray-500 mt-0.5">
                {owing ? `${dn(row.name)} owes you here - takes it down` : `you owe ${dn(row.name)} here - takes it down`}
              </span>
            </button>
          ))}
          {row.loanItems.map((it) => <LoanItem key={it.key} it={it} nav={nav} />)}
          {same_.length === 0 && opposite.length === 0 && row.loanItems.length === 0 && (
            <p className="text-[0.739rem] text-gray-400 text-center py-2">Nothing open</p>
          )}

          {stmt === 'loading' && <p className="text-[10.84px] text-gray-300 pt-3">Loading the statement…</p>}
          {stmt === 'error' && <p className="text-[10.84px] text-gray-400 pt-3">Couldn't load the statement.</p>}
          {stmt && typeof stmt === 'object' && <Statement data={stmt} name={row.name} me={me} nav={nav} />}
        </div>
      )}
    </div>
  )
}

/**
 * /balances/owe and /balances/owed — what makes up the two Home figures.
 *
 * Balances are netted per person across every group AND every loan/recurring
 * bill with them, which is what you'd actually hand over - so a loan-only
 * relationship (someone you've never shared a group with) still shows up
 * here. Each person is collapsed to just their net by default; tap it to see
 * the groups, loans/bills and payment record behind that number.
 */
export default function Balances() {
  const nav  = useNavigate()
  const user = useUser()
  const { kind } = useParams()             // 'owe' | 'owed'
  const owing = kind !== 'owed'

  const [friends, setFriends] = useState([])
  const [loansData, setLoansData] = useState(null)
  const [groupDates, setGroupDates] = useState({})
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(new Set())
  const [payOpen, setPayOpen] = useState(false)
  const [nudges, setNudges] = useState({})        // lower-cased name -> last reminder sent

  const load = () => {
    if (!user?.name) { setLoading(false); return }
    return Promise.all([getFriends(user.name), getLoans(), getGroups()])
      .then(([f, l, g]) => {
        setFriends(f.data)
        setLoansData(l.data)
        setGroupDates(Object.fromEntries(g.data.map((x) => [x.id, x.last_activity])))
      })
      .catch(() => { setFriends([]); setLoansData({ loans: [], bills: [] }) })
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [user?.name])
  useEffect(() => { getRecentNudges().then((r) => setNudges(r.data)).catch(() => {}) }, [user?.name])

  useEffect(() => {
    const onChanged = () => load()
    window.addEventListener(MONEY_CHANGED, onChanged)
    return () => window.removeEventListener(MONEY_CHANGED, onChanged)
  }, [user?.name])

  if (loading || !loansData) return <LoadingSpinner />

  const me = user?.name
  // Same helper Home's headline uses - see utils/balances.js.
  const rows = combinedBalances(friends, loansData, me)
    .filter((r) => (owing ? owes(r.net) : owed(r.net)))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))

  const total = rows.reduce((s, r) => s + Math.abs(r.net), 0)

  const toggle = (name) => setExpanded((s) => {
    const next = new Set(s)
    next.has(name) ? next.delete(name) : next.add(name)
    return next
  })

  return (
    <div className="pb-24 md:pb-8">
      <div
        className={`px-5 pt-10 md:pt-8 pb-6 md:rounded-b-3xl border-b text-white ${
          owing
            ? 'bg-gradient-to-br from-red-700 to-field-950 border-red-900'
            : 'bg-gradient-to-br from-green-700 to-field-950 border-green-900'
        }`}
      >
        <div className="flex items-center justify-between mb-2">
          <button onClick={() => nav('/')} className="text-[0.887rem] font-bold text-white/50">← Home</button>
          <button
            onClick={() => setPayOpen(true)}
            title="Record a payment"
            aria-label="Record a payment"
            className="flex items-center justify-center w-7 h-7 rounded-md bg-white/10 hover:bg-white/20 text-white font-black text-sm active:scale-95 transition-all"
          >
            ₹
          </button>
        </div>
        <p className="text-white/60 text-[0.739rem] font-bold uppercase tracking-widest">
          {owing ? 'You owe' : 'Owed to you'}
        </p>
        <h1 className="text-[2.216rem] font-black mt-1 tracking-tight">{INR(total)}</h1>
        <p className="text-white/50 text-[0.739rem] mt-1 font-medium">
          across {rows.length} {rows.length === 1 ? 'person' : 'people'} · groups + loans & bills
        </p>
      </div>

      <div className="px-5 mt-5 space-y-3 max-w-2xl">
        {rows.length === 0 && (
          <div className="text-center py-20">
            <p className="text-3xl mb-2">✅</p>
            <p className="text-[0.862rem] text-gray-400">
              {owing ? "You don't owe anyone right now." : 'Nobody owes you right now.'}
            </p>
          </div>
        )}

        {rows.map((row) => (
          <PersonCard
            key={row.name}
            row={row}
            owing={owing}
            expanded={expanded.has(row.name)}
            onToggle={() => toggle(row.name)}
            nav={nav}
            me={me}
            groupDates={groupDates}
            lastNudge={nudges[row.name.trim().toLowerCase()]}
            onNudged={(name, at) => setNudges((n) => ({ ...n, [name.trim().toLowerCase()]: at }))}
          />
        ))}
      </div>

      {payOpen && (
        <RecordPaymentModal onClose={() => setPayOpen(false)} onSaved={load} />
      )}
    </div>
  )
}
