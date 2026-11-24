import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getSettlement, getGroup } from '../api'
import RecordPaymentModal from './RecordPaymentModal'
import LoadingSpinner from './LoadingSpinner'
import { isSettled } from '../utils/money'
import { dn } from '../utils/displayName'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const day = (iso) => {
  if (!iso) return ''
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}
const monthOf = (iso) => {
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  return Number.isNaN(d.getTime()) ? 'Undated' : d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}

/** Person to person: each group's "who pays whom", added up across the
 *  groups and netted within each pair only - a debt is never moved onto
 *  someone else (A owes B, B owes C stays two payments, not A paying C). */
function pairwise(groupTx) {
  const pair = {}                              // "a|b" (a < b) -> what a owes b, net
  for (const tx of groupTx) {
    for (const t of tx) {
      const [a, b] = [t.from_member, t.to_member]
      const k = a < b ? `${a}|${b}` : `${b}|${a}`
      pair[k] = (pair[k] || 0) + (a < b ? t.amount : -t.amount)
    }
  }
  return Object.entries(pair)
    .map(([k, v]) => { const [a, b] = k.split('|'); return v > 0 ? { from: a, to: b, amount: v } : { from: b, to: a, amount: -v } })
    .filter((t) => t.amount >= 1)
    .sort((x, y) => y.amount - x.amount)
}

/**
 * Settle up across every group of a master ("With Anubhav"): what each
 * person owes each other person across all its groups (pairwise), a Record
 * button, and every payment made in these groups as one timeline by month.
 * Recording uses the app's "Record a payment" (payments/auto), which pays
 * down what's owed between the two wherever it sits.
 */
export default function MasterSettleUp({ master, me }) {
  const nav = useNavigate()
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [record, setRecord] = useState(null)      // { friend } - the Record form open
  const [editing, setEditing] = useState(null)    // a payment being corrected
  const load = () => {
    setErr('')
    Promise.all(master.groups.map((g) => Promise.all([getSettlement(g.id), getGroup(g.id).catch(() => null)])
      .then(([r, full]) => ({ g, s: r.data, exps: full?.data?.expenses || [] })).catch(() => null)))
      .then((rows) => setData(rows.filter(Boolean)))
      .catch(() => setErr("Couldn't load the balances."))
  }
  useEffect(() => { setData(null); load() }, [master.key])

  if (err) return <p className="text-xs text-red-600 px-5 mt-4">{err}</p>
  if (!data) return <LoadingSpinner />

  const lower = (me || '').toLowerCase()
  // A group in a line: how many expenses, what they came to, when, who paid, the biggest ones
  const summary = (exps) => {
    const total = exps.reduce((t, e) => t + e.amount, 0)
    const days = exps.map((e) => (e.date || '').slice(0, 10)).filter(Boolean).sort()
    const fmt = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
    const when = days.length ? (days[0] === days[days.length - 1] ? fmt(days[0]) : `${fmt(days[0])} – ${fmt(days[days.length - 1])}`) : ''
    const paid = {}
    for (const e of exps) paid[e.paid_by] = (paid[e.paid_by] || 0) + e.amount
    const payers = Object.entries(paid).sort((a, b) => b[1] - a[1])
      .map(([n, v]) => `${n.toLowerCase() === lower ? 'You' : dn(n)} ${INR(v)}`).join(', ')
    const top = [...exps].sort((a, b) => b.amount - a.amount).slice(0, 2)
      .map((e) => `${(e.title || e.category || 'Expense').replace(/^\W+/, '').slice(0, 24)} ${INR(e.amount)}`).join(', ')
    return { line1: [`${exps.length} expense${exps.length === 1 ? '' : 's'} · ${INR(total)}`, when].filter(Boolean).join(' · '),
             line2: payers ? `Paid: ${payers}` : '', line3: top ? `Biggest: ${top}` : '' }
  }
  const perGroup = []
  for (const { g, s, exps } of data) {
    if (s.balances.some((b) => !isSettled(b.net))) perGroup.push({ g, tx: s.transactions, sum: summary(exps) })
  }
  const plan = pairwise(data.map(({ s }) => s.transactions || []))
  const others = (master.names || []).filter((n) => n.toLowerCase() !== lower)

  const payments = data.flatMap(({ g, s }) => (s.payments || []).map((p) => ({ ...p, groupName: g.name, groupId: g.id })))
    .map((p) => ({ ...p, when: p.date || (p.created_at || '').slice(0, 10) }))
    .sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : b.id - a.id))
  const totalPaid = payments.reduce((n, p) => n + p.amount, 0)
  const months = []
  for (const p of payments) {
    const m = p.when ? monthOf(p.when) : 'Undated'
    if (!months.length || months[months.length - 1].m !== m) months.push({ m, list: [] })
    months[months.length - 1].list.push(p)
  }
  const reload = () => { setData(null); load() }

  return (
    <div className="px-5 mt-4 space-y-4">
      {/* where things stand, all groups together */}
      <div className="card">
        <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Combined balance · {master.groups.length} groups</p>
        {plan.length === 0 ? (
          <p className="text-sm font-bold text-green-700 mt-2">All settled up ✓</p>
        ) : (
          <div className="mt-2 space-y-2">
            {plan.map((t) => {
              const mine = t.from.toLowerCase() === lower || t.to.toLowerCase() === lower
              const friend = t.from.toLowerCase() === lower ? t.to : t.from
              return (
                <div key={`${t.from}>${t.to}`} className="flex items-center gap-2">
                  <p className="flex-1 min-w-0 text-sm">
                    <b>{t.from.toLowerCase() === lower ? 'You' : dn(t.from)}</b>
                    <span className="text-gray-400"> pay{t.from.toLowerCase() === lower ? '' : 's'} </span>
                    <b>{t.to.toLowerCase() === lower ? 'you' : dn(t.to)}</b>
                  </p>
                  <span className={`text-base font-black tabular-nums ${t.from.toLowerCase() === lower ? 'text-red-600' : t.to.toLowerCase() === lower ? 'text-green-700' : 'text-gray-800'}`}>{INR(t.amount)}</span>
                  {mine && (
                    <button onClick={() => setRecord({ friend, prefill: { from: t.from, to: t.to, amount: t.amount } })}
                      className="px-2.5 py-1 rounded-md bg-brand-400 text-white text-[11px] font-bold active:scale-95">Record</button>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {plan.length === 0 && others.length > 0 && (
          <button onClick={() => setRecord({ friend: others.length === 1 ? others[0] : '' })}
            className="mt-2 text-[11px] font-bold text-brand-600">Record a payment anyway ›</button>
        )}
      </div>

      {/* which groups still hold an open balance */}
      {perGroup.length > 0 && (
        <div className="card py-2">
          <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1">Open in {perGroup.length} group{perGroup.length > 1 ? 's' : ''}</p>
          {perGroup.map(({ g, tx, sum }) => (
            <button key={g.id} onClick={() => nav(`/groups/${g.id}`)} className="w-full flex items-start gap-2 py-1.5 border-b border-amber-100 last:border-0 text-left">
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] font-bold text-gray-800 truncate">{g.name}</span>
                <span className="block text-[11px] text-gray-600">{sum.line1}</span>
                {sum.line2 && <span className="block text-[10px] text-gray-400 truncate">{sum.line2}</span>}
                {sum.line3 && <span className="block text-[10px] text-gray-400 truncate">{sum.line3}</span>}
                <span className="block text-[11px] text-gray-500 mt-0.5">
                  {tx.map((t) => `${dn(t.from_member)} → ${dn(t.to_member)} ${INR(t.amount)}`).join(' · ')}
                </span>
              </span>
              <span className="text-brand-600 font-bold text-xs">›</span>
            </button>
          ))}
        </div>
      )}

      {/* every payment, newest first, by month */}
      <div>
        <div className="flex items-baseline justify-between">
          <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Payment history</p>
          {payments.length > 0 && <p className="text-[11px] text-gray-400">{payments.length} payment{payments.length > 1 ? 's' : ''} · {INR(totalPaid)}</p>}
        </div>
        {payments.length === 0 && <p className="text-sm text-gray-400 text-center py-8">No payments recorded in these groups yet.</p>}
        {months.map(({ m, list }) => (
          <div key={m} className="mt-3">
            <p className="text-[11px] font-bold text-gray-500 mb-1">{m}</p>
            <div className="border-l-2 border-green-200 ml-1.5 pl-3 space-y-2">
              {list.map((p) => (
                <button key={p.id} onClick={() => setEditing(p)} title="Edit this payment"
                  className="relative w-full text-left card py-2 hover:bg-amber-50/50">
                  <span className="absolute -left-[19px] top-3 w-2.5 h-2.5 rounded-full bg-green-500 ring-2 ring-white" />
                  <span className="flex items-baseline gap-2">
                    <span className="flex-1 min-w-0 text-[13px]">
                      <b>{p.from_member.toLowerCase() === lower ? 'You' : dn(p.from_member)}</b>
                      <span className="text-gray-400"> paid </span>
                      <b>{p.to_member.toLowerCase() === lower ? 'you' : dn(p.to_member)}</b>
                    </span>
                    <span className="text-sm font-black tabular-nums text-green-700">{INR(p.amount)}</span>
                  </span>
                  <span className="block text-[10px] text-gray-400 mt-0.5 truncate">
                    {day(p.when)} · {p.groupName}{p.note ? ` · ${p.note}` : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {record && (
        <RecordPaymentModal prefillFriend={record.friend || undefined} prefill={record.prefill} onClose={() => setRecord(null)} onSaved={reload} />
      )}
      {editing && (
        <RecordPaymentModal payment={editing} onClose={() => setEditing(null)} onSaved={reload} />
      )}
    </div>
  )
}
