import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getFriends } from '../api'
import LoadingSpinner from '../components/LoadingSpinner'
import RecordPaymentModal from '../components/RecordPaymentModal'
import { useUser } from '../UserContext'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

function FriendRow({ friend, nav }) {
  const settled = Math.abs(friend.net) < 0.01
  const owes = friend.net < 0

  return (
    <button
      onClick={() => nav(`/friends/${encodeURIComponent(friend.name)}`)}
      className={`w-full text-left border px-4 py-3 flex items-center gap-3 active:scale-95 transition-all duration-150 ${
        settled
          ? 'bg-white border-amber-100 hover:bg-amber-50'
          : owes
            ? 'bg-red-50 border-red-200 hover:bg-red-100'
            : 'bg-green-50 border-green-200 hover:bg-green-100'
      }`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-gray-900 truncate">{friend.name}</p>
        <p className={`text-xs font-semibold mt-0.5 ${settled ? 'text-gray-400' : owes ? 'text-red-600' : 'text-green-600'}`}>
          {settled ? 'Settled up' : owes ? `You owe ${INR(Math.abs(friend.net))}` : `Owes you ${INR(friend.net)}`}
        </p>
      </div>
      <svg className="w-4 h-4 text-gray-300 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </button>
  )
}

export default function Friends() {
  const nav = useNavigate()
  const user = useUser()

  const [friends, setFriends] = useState([])
  const [loading, setLoading] = useState(true)
  const [payOpen, setPayOpen] = useState(false)

  const load = () => {
    if (!user?.name) { setLoading(false); return }
    return getFriends(user.name).then((r) => setFriends(r.data)).finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [user?.name])

  if (loading) return <LoadingSpinner />

  const unsettled = friends.filter((f) => Math.abs(f.net) > 0.01)
  const settled   = friends.filter((f) => Math.abs(f.net) <= 0.01)

  return (
    <div className="pb-24 md:pb-8">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-black tracking-tight">Friends</h1>
            <p className="text-xs text-gray-400 mt-1">Everyone who's shared a group with you</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => nav('/groups/new')}
            title="New group"
            aria-label="New group"
            className="flex items-center gap-1.5 bg-cream border border-amber-200 text-gray-500 hover:bg-amber-50 rounded-md px-3 py-2 text-xs font-bold active:scale-95 transition-all shadow-sm"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Group
          </button>
          {/* Record a payment for any group, from one place */}
          <button
            onClick={() => setPayOpen(true)}
            title="Record a payment"
            aria-label="Record a payment"
            className="flex-shrink-0 flex items-center gap-1.5 bg-brand-400 hover:bg-brand-500 text-white rounded-md px-3 py-2 text-xs font-bold active:scale-95 transition-all shadow-sm"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 9v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Record
          </button>
          </div>
        </div>
      </div>

      <div className="px-5 mt-4 space-y-2">
        {unsettled.map((f) => <FriendRow key={f.name} friend={f} nav={nav} />)}

        {settled.length > 0 && (
          <>
            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest pt-3 pb-1">Settled up</p>
            {settled.map((f) => <FriendRow key={f.name} friend={f} nav={nav} />)}
          </>
        )}

        {friends.length === 0 && (
          <div className="text-center py-16 text-gray-400">
            <p className="text-sm">No friends yet — add an expense with someone to see them here</p>
          </div>
        )}
      </div>

      {payOpen && (
        <RecordPaymentModal onClose={() => setPayOpen(false)} onSaved={load} />
      )}
    </div>
  )
}
