import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getGroups, getFriends, paymentsBetween } from '../api'
import RecordPaymentModal from '../components/RecordPaymentModal'
import GroupCard from '../components/GroupCard'
import LoadingSpinner from '../components/LoadingSpinner'
import { useUser } from '../UserContext'
import { isSettled } from '../utils/money'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

/** "28 Aug 2026, 6:20 pm" — when the payment was actually entered. */
function stamp(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

export default function FriendDetail() {
  const { name: rawName } = useParams()
  const friendName = decodeURIComponent(rawName)
  const nav = useNavigate()
  const user = useUser()

  const [groups,  setGroups]  = useState([])
  const [net,     setNet]     = useState(0)
  // group_id -> what that group contributes to the balance with this friend
  const [byGroup, setByGroup] = useState({})
  const [payments, setPayments] = useState([])
  const [payOpen, setPayOpen]   = useState(false)
  const [editingPayment, setEditingPayment] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    Promise.all([
      getGroups(),
      user?.name ? getFriends(user.name) : Promise.resolve({ data: [] }),
    ])
      .then(([g, f]) => {
        setGroups(g.data)
        const match = f.data.find((x) => x.name.toLowerCase() === friendName.toLowerCase())
        setNet(match?.net ?? 0)
        setByGroup(
          Object.fromEntries((match?.groups ?? []).map((x) => [x.group_id, x.net]))
        )
      })
      .finally(() => setLoading(false))
    if (user?.name) {
      paymentsBetween(user.name, friendName)
        .then((r) => setPayments(r.data))
        .catch(() => setPayments([]))
    }
  }

  useEffect(() => { load() }, [friendName, user?.name])

  if (loading) return <LoadingSpinner />

  const shared = groups.filter((g) =>
    (g.member_names ?? []).some((n) => n.toLowerCase() === user?.name?.toLowerCase()) &&
    (g.member_names ?? []).some((n) => n.toLowerCase() === friendName.toLowerCase())
  )

  // One timeline: the date-named groups, with each payment slotted in at the
  // point it was recorded, rather than a separate payments list at the bottom.
  const timeline = [
    ...shared.map((g) => ({
      kind: 'group', key: `g${g.id}`, at: g.last_activity || '', data: g,
    })),
    ...payments.map((p) => ({
      kind: 'payment', key: `p${p.id}`,
      at: (p.recorded_at || p.date || '').slice(0, 10), data: p,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))

  const settled = isSettled(net)
  const owes = net < 0

  return (
    <div className="pb-24 md:pb-8">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <div className="flex items-start justify-between gap-3">
          <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
          <button
            onClick={() => setPayOpen(true)}
            className="flex-shrink-0 flex items-center gap-1.5 bg-brand-400 hover:bg-brand-500 text-white rounded-md px-3 py-1.5 text-xs font-bold active:scale-95 transition-all shadow-sm"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 9v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Record
          </button>
        </div>
        <h1 className="text-xl font-black tracking-tight">{friendName}</h1>
        <p className={`text-sm font-bold mt-1 ${settled ? 'text-gray-400' : owes ? 'text-red-500' : 'text-green-600'}`}>
          {settled ? 'Settled up' : owes ? `You owe ${INR(Math.abs(net))}` : `Owes you ${INR(net)}`}
        </p>
        <p className="text-xs text-gray-400 mt-0.5">{shared.length} shared group{shared.length !== 1 ? 's' : ''}</p>
      </div>

      <div className="px-5 mt-4 space-y-3">
        {timeline.map((row) =>
          row.kind === 'group' ? (
            <GroupCard
              key={row.key}
              group={row.data}
              friendBalance={{ name: friendName, net: byGroup[row.data.id] ?? 0 }}
            />
          ) : (
            /* A settlement, sitting between the groups at the time it happened.
               Tap it to correct an amount, a date or who paid whom. */
            <button
              key={row.key}
              onClick={() => setEditingPayment(row.data)}
              title="Edit this payment"
              className="w-full flex items-center gap-2 py-0.5 group"
            >
              <span className="h-px flex-1 bg-green-200" />
              <span className="flex items-center gap-1.5 text-[11px] font-bold text-green-700 whitespace-nowrap group-hover:text-green-800">
                <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                {row.data.from_member} paid {row.data.to_member} {INR(row.data.amount)}
                <span className="font-normal text-gray-400">· {stamp(row.data.recorded_at)}</span>
                <svg className="w-2.5 h-2.5 text-gray-300 group-hover:text-gray-500" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </span>
              <span className="h-px flex-1 bg-green-200" />
            </button>
          )
        )}
        {timeline.length === 0 && (
          <div className="text-center py-16 text-gray-400">
            <p className="text-sm">No shared groups</p>
          </div>
        )}
      </div>

      {payOpen && (
        <RecordPaymentModal
          prefillFriend={friendName}
          onClose={() => setPayOpen(false)}
          onSaved={load}
        />
      )}

      {editingPayment && (
        <RecordPaymentModal
          payment={editingPayment}
          onClose={() => setEditingPayment(null)}
          onSaved={load}
        />
      )}
    </div>
  )
}
