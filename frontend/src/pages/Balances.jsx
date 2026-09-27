import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getFriends, getGroups, getLoans, paymentsBetween } from '../api'
import { useUser } from '../UserContext'
import { owes, owed } from '../utils/money'
import LoadingSpinner from '../components/LoadingSpinner'
import RecordPaymentModal from '../components/RecordPaymentModal'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const same = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase()

/** "28 Aug 2026, 6:20 pm" — when the payment was actually entered. */
function stamp(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

// Loans and recurring bills also make up what two people owe each other -
// folded into the same per-person net as group balances, so "Vikram" (who
// shares no group, only a loan) shows up here too, and the number matches
// what Loans & bills shows.
function loanContributions(loansData, me) {
  const byPerson = {}
  const add = (name, signed, item) => {
    const row = byPerson[name] || { net: 0, items: [] }
    row.net += signed
    row.items.push(item)
    byPerson[name] = row
  }

  for (const l of loansData.loans) {
    if (l.total_due <= 0.01) continue
    const iOwe = same(l.borrower, me)
    const other = iOwe ? l.lender : l.borrower
    add(other, iOwe ? -l.total_due : l.total_due, {
      key: `loan${l.id}`, tag: 'Loan', label: iOwe ? `You owe ${other}` : `${other} owes you`,
      amount: l.total_due, positive: !iOwe,
    })
  }

  for (const b of loansData.bills) {
    const iPay = same(b.payer, me)
    if (iPay) {
      const debtors = [...new Set(b.charges.map((c) => c.member))]
      for (const m of debtors) {
        const due = b.charges.filter((c) => same(c.member, m) && !c.paid).reduce((s, c) => s + c.share, 0)
        if (due > 0.01) add(m, due, { key: `bill${b.id}`, tag: 'Bill', label: b.title, amount: due, positive: true })
      }
    } else {
      const due = b.charges.filter((c) => same(c.member, me) && !c.paid).reduce((s, c) => s + c.share, 0)
      if (due > 0.01) add(b.payer, -due, { key: `bill${b.id}`, tag: 'Bill', label: b.title, amount: due, positive: false })
    }
  }
  return byPerson
}

function PersonCard({ row, owing, expanded, onToggle, nav, me, groupDates }) {
  const [payments, setPayments] = useState(null)
  const loanOnly = row.groups.length === 0 && row.loanItems.length > 0

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

  const same_ = row.groups.filter((g) => (owing ? g.net < 0 : g.net > 0))
  const opposite = row.groups.filter((g) => (owing ? g.net > 0 : g.net < 0))

  // One dated timeline for the groups pushing the balance this way and the
  // payments that clawed it back - interleaved in the order they actually
  // happened, the same way FriendDetail tells this story, so it's visible
  // which payment offset which group instead of the two feeling unrelated.
  const timeline = [
    ...same_.map((g) => ({ kind: 'group', key: `g${g.group_id}`, at: groupDates[g.group_id] || '', data: g })),
    ...(payments || []).map((p) => ({
      kind: 'payment', key: `p${p.id}`, at: (p.recorded_at || p.date || '').slice(0, 10), data: p,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))

  return (
    <div className={`card ${loanOnly ? 'border-l-4 border-l-orange-400' : ''}`}>
      <button onClick={onToggle} className="w-full flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 min-w-0">
          <svg className={`w-3.5 h-3.5 text-gray-300 flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span
            onClick={(e) => { e.stopPropagation(); nav(`/friends/${encodeURIComponent(row.name)}`) }}
            className="text-[0.862rem] font-bold text-gray-900 hover:text-brand-600 truncate"
          >
            {row.name} →
          </span>
          {loanOnly && (
            <span className="text-[8.87px] font-bold uppercase tracking-widest text-orange-600 bg-orange-50 border border-orange-200 rounded px-1.5 py-0.5 flex-shrink-0">
              Loan only
            </span>
          )}
        </span>
        <span className={`text-[1.108rem] font-black flex-shrink-0 ${owing ? 'text-red-600' : 'text-green-600'}`}>
          {INR(Math.abs(row.net))}
        </span>
      </button>

      {expanded && (
        <div className="space-y-1.5 mt-3">
          {timeline.map((row2) =>
            row2.kind === 'group' ? (
              <button key={row2.key} onClick={() => nav(`/groups/${row2.data.group_id}`)}
                className={`w-full text-left flex items-center gap-2 rounded-md px-3 py-2 border transition-colors ${
                  owing ? 'bg-red-50 border-red-100 hover:bg-red-100' : 'bg-green-50 border-green-200 hover:bg-green-100'
                }`}>
                <span className="text-[0.739rem] font-semibold text-gray-700 flex-1 min-w-0 truncate">{row2.data.name}</span>
                <span className={`text-[0.739rem] font-black flex-shrink-0 ${owing ? 'text-red-700' : 'text-green-700'}`}>
                  {INR(Math.abs(row2.data.net))}
                </span>
              </button>
            ) : (
              // A settlement - a thin rule with the amount on it, not a boxed
              // row, so it reads as "this is what reduced the total above"
              // rather than another debt of its own.
              <div key={row2.key} className="w-full flex items-center gap-2 py-0.5">
                <span className="h-px flex-1 bg-green-200" />
                <span className="flex items-center gap-1.5 text-[10.84px] font-bold text-green-700 whitespace-nowrap">
                  <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  {row2.data.from_member} paid {row2.data.to_member} {INR(row2.data.amount)}
                  <span className="font-normal text-gray-400">· {stamp(row2.data.recorded_at || row2.data.date)}</span>
                </span>
                <span className="h-px flex-1 bg-green-200" />
              </div>
            )
          )}

          {/* Loans & recurring bills are a different kind of debt (no group,
              no expense split) - a dashed orange outline keeps them visually
              apart from group rows instead of blending in as green/red boxes. */}
          {row.loanItems.map((it) => (
            <button key={it.key} onClick={() => nav('/loans')}
              className="w-full text-left flex items-center gap-2 rounded-md px-3 py-2 border-2 border-dashed border-orange-200 bg-orange-50 hover:bg-orange-100 transition-colors">
              <span className="text-[8.87px] font-bold uppercase tracking-widest text-orange-600 flex-shrink-0">{it.tag}</span>
              <span className="text-[0.739rem] font-semibold text-gray-700 flex-1 min-w-0 truncate">{it.label}</span>
              <span className={`text-[0.739rem] font-black flex-shrink-0 ${it.positive ? 'text-green-700' : 'text-red-700'}`}>
                {INR(it.amount)}
              </span>
            </button>
          ))}

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

  if (loading || !loansData) return <LoadingSpinner />

  const me = user?.name
  const loanNet = loanContributions(loansData, me)
  const names = new Set([...friends.map((f) => f.name), ...Object.keys(loanNet)])

  const combined = [...names].map((name) => {
    const f = friends.find((x) => x.name === name)
    const l = loanNet[name]
    return {
      name,
      net: (f?.net ?? 0) + (l?.net ?? 0),
      groups: f?.groups ?? [],
      loanItems: l?.items ?? [],
    }
  })

  const rows = combined
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
          <button onClick={() => nav('/')} className="text-[0.739rem] font-bold text-white/50">← Home</button>
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
          />
        ))}
      </div>

      {payOpen && (
        <RecordPaymentModal onClose={() => setPayOpen(false)} onSaved={load} />
      )}
    </div>
  )
}
