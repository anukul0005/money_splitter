import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getGroups, getFriends, paymentsBetween } from '../api'
import RecordPaymentModal from '../components/RecordPaymentModal'
import GroupCard from '../components/GroupCard'
import LoadingSpinner from '../components/LoadingSpinner'
import { useUser } from '../UserContext'

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

  const shared = groups
    .filter((g) =>
      (g.member_names ?? []).some((n) => n.toLowerCase() === user?.name?.toLowerCase()) &&
      (g.member_names ?? []).some((n) => n.toLowerCase() === friendName.toLowerCase())
    )
    // groups that actually contribute to the balance first, largest first
    .sort((a, b) => Math.abs(byGroup[b.id] ?? 0) - Math.abs(byGroup[a.id] ?? 0))

  const settled = Math.abs(net) < 0.01
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

      <div className="px-5 mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
        {shared.map((g) => (
          <GroupCard
            key={g.id}
            group={g}
            friendBalance={{ name: friendName, net: byGroup[g.id] ?? 0 }}
          />
        ))}
        {shared.length === 0 && (
          <div className="col-span-2 text-center py-16 text-gray-400">
            <p className="text-sm">No shared groups</p>
          </div>
        )}
      </div>

      {/* Payments already settled between the two of you */}
      <div className="px-5 mt-6">
        <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">
          Payments with {friendName}
        </p>
        {payments.length === 0 ? (
          <div className="card text-center py-6">
            <p className="text-sm text-gray-400">No payments recorded yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {payments.map((p) => (
              <div key={p.id} className="card p-3.5 flex items-center gap-2.5">
                <svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-gray-900 truncate">
                    {p.from_member} <span className="font-normal text-gray-500">paid</span> {p.to_member}
                  </p>
                  <p className="text-[11px] text-gray-400 mt-0.5">
                    {p.group_name}
                    {p.note ? ` · ${p.note}` : ''}
                  </p>
                  <p className="text-[10px] text-gray-400 mt-0.5">
                    recorded {stamp(p.recorded_at)}
                  </p>
                </div>
                <span className="text-sm font-black text-green-700 flex-shrink-0">{INR(p.amount)}</span>
              </div>
            ))}
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
    </div>
  )
}
