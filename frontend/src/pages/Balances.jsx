import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  getFriends, getGroups, getLoans, paymentsBetween, listUpiIdsFor, listMyUpiIds, createPaymentClaim,
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

/** A loan or recurring bill in a balance breakdown. */
function LoanItem({ it, nav }) {
  return (
    // Straight to that bill or loan, on its own tab: "bill7" -> /loans?tab=bills&bill=7
    <button onClick={() => {
      const [, kind, id] = it.key.match(/^(bill|loan)(\d+)$/) || []
      nav(kind ? `/loans?tab=${kind === 'bill' ? 'bills' : 'loans'}&${kind}=${id}` : '/loans')
    }}
      className="w-full text-left flex items-center gap-2 rounded-md px-3 py-2 border-2 border-dashed border-orange-200 bg-orange-50 hover:bg-orange-100 transition-colors">
      <span className="text-[8.87px] font-bold uppercase tracking-widest text-orange-600 flex-shrink-0">{it.tag}</span>
      <span className="text-[0.739rem] font-semibold text-gray-700 flex-1 min-w-0 truncate">{it.label}</span>
      <span className={`text-[0.739rem] font-black flex-shrink-0 ${it.positive ? 'text-green-700' : 'text-red-700'}`}>
        {INR(it.amount)}
      </span>
    </button>
  )
}

function PersonCard({ row, owing, expanded, onToggle, nav, me, groupDates, lastNudge, onNudged }) {
  const [payments, setPayments] = useState(null)

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
    if (expanded && payments === null) {
      // paymentsBetween also returns payments elsewhere in a shared group
      // that don't touch me at all (it explains group-wide settlement
      // context on the friend page) - here it's specifically "how did I
      // get to this number with them", so keep only the ones I'm actually
      // a side of.
      paymentsBetween(me, row.name)
        .then((r) => setPayments(r.data.filter((p) => same(p.from_member, me) || same(p.to_member, me))))
        .catch(() => setPayments([]))
    }
  }, [expanded])

  // What makes up the figure now: what's still owed in each group after
  // payments (liveGroups), newest group first. A group a payment has
  // cleared drops out, so these rows plus the loans & bills below add up
  // to the number on the card. Payments are listed after, as history.
  const groups = (row.liveGroups ?? row.groups).filter((g) => Math.abs(g.net) >= 1)   // paisa residue isn't a debt
  // Oldest group first - the order a payment pays them in (settle_up.py).
  const since = (g) => g.since || groupDates[g.group_id] || ''
  const byDate = (a, b) => (since(a) > since(b) ? 1 : -1)
  const same_ = groups.filter((g) => (owing ? g.net < 0 : g.net > 0)).sort(byDate)
  const opposite = groups.filter((g) => (owing ? g.net > 0 : g.net < 0)).sort(byDate)
  const timeline = same_.map((g) => ({ kind: 'group', key: `g${g.group_id}`, data: g }))
  // What each group came to from its expenses alone - against what's left
  // now, the part already paid in it.
  const originally = Object.fromEntries((row.groups || []).map((g) => [g.group_id, g.net]))
  const paid = [...(payments || [])].sort((a, b) =>
    ((b.recorded_at || b.date || '') > (a.recorded_at || a.date || '') ? 1 : -1))

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
            What makes up {INR(Math.abs(row.net))}
          </p>
          {/* In the order a payment pays them: bills, then groups oldest
              first, then loans. Loans & bills are a different kind of debt
              (no group, no expense split) - a dashed orange outline keeps
              them apart from the group rows. */}
          {row.loanItems.filter((it) => it.tag === 'Bill').map((it) => <LoanItem key={it.key} it={it} nav={nav} />)}
          {timeline.map((row2) => {
            const now = Math.abs(row2.data.net)
            const signed = originally[row2.data.group_id]
            // Same direction as it started, and less of it: part-paid. (A
            // group that flipped the other way isn't "owed minus paid".)
            const was = signed != null && Math.sign(signed) === Math.sign(row2.data.net) ? Math.abs(signed) : null
            const partPaid = was != null && was - now >= 1
            return (
              <button key={row2.key} onClick={() => nav(`/groups/${row2.data.group_id}`)}
                className={`w-full text-left rounded-md px-3 py-2 border transition-colors ${
                  owing ? 'bg-red-50 border-red-100 hover:bg-red-100' : 'bg-green-50 border-green-200 hover:bg-green-100'
                }`}>
                <span className="flex items-center gap-2">
                  <span className="text-[0.739rem] font-semibold text-gray-700 flex-1 min-w-0 truncate">{row2.data.name}</span>
                  <span className={`text-[0.739rem] font-black flex-shrink-0 ${owing ? 'text-red-700' : 'text-green-700'}`}>
                    {INR(now)}
                  </span>
                </span>
                {partPaid && (
                  <span className="block text-[9.85px] text-gray-500 mt-0.5">
                    {INR(was)} owed − {INR(was - now)} paid = {INR(now)} now
                  </span>
                )}
              </button>
            )
          })}
          {row.loanItems.filter((it) => it.tag !== 'Bill').map((it) => <LoanItem key={it.key} it={it} nav={nav} />)}

          {opposite.length > 0 && (
            <>
              <p className="text-[9.85px] font-bold text-gray-400 uppercase tracking-widest pt-2">Cancelled out by</p>
              {opposite.map((g) => (
                <button key={g.group_id} onClick={() => nav(`/groups/${g.group_id}`)}
                  className="w-full text-left flex items-center gap-2 rounded-md px-3 py-2 border border-amber-200 bg-amber-50 hover:bg-amber-100 transition-colors">
                  <span className="text-[0.739rem] font-semibold text-gray-600 flex-1 min-w-0 truncate">{g.name}</span>
                  <span className="text-[0.739rem] font-bold text-gray-500 flex-shrink-0">−{INR(Math.abs(g.net))}</span>
                </button>
              ))}
            </>
          )}

          {/* Payments already made - each a thin rule rather than a boxed
              row, so it reads as money that has moved, not another debt. */}
          {paid.length > 0 && (
            <>
              <p className="text-[9.85px] font-bold text-gray-400 uppercase tracking-widest pt-2">Paid so far</p>
              {paid.map((p) => (
                <div key={`p${p.id}`} className="w-full flex items-center gap-2 py-0.5">
                  <span className="h-px flex-1 bg-green-200" />
                  <span className="flex items-center gap-1.5 text-[10.84px] font-bold text-green-700 whitespace-nowrap">
                    <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    {dn(p.from_member)} paid {dn(p.to_member)} {INR(p.amount)}
                    <span className="font-normal text-gray-400">· {stamp(p.recorded_at || p.date)}</span>
                  </span>
                  <span className="h-px flex-1 bg-green-200" />
                </div>
              ))}
            </>
          )}

          {payments === null && <p className="text-[10.84px] text-gray-300 pt-2">Loading payment history…</p>}

          {timeline.length === 0 && opposite.length === 0 && row.loanItems.length === 0 && payments?.length === 0 && (
            <p className="text-[0.739rem] text-gray-400 text-center py-2">No shared groups — only Loans & bills</p>
          )}
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
