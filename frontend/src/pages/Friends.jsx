import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getFriends } from '../api'
import LoadingSpinner from '../components/LoadingSpinner'
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

  useEffect(() => {
    if (!user?.name) { setLoading(false); return }
    getFriends(user.name).then((r) => setFriends(r.data)).finally(() => setLoading(false))
  }, [user?.name])

  if (loading) return <LoadingSpinner />

  const unsettled = friends.filter((f) => Math.abs(f.net) > 0.01)
  const settled   = friends.filter((f) => Math.abs(f.net) <= 0.01)

  return (
    <div className="pb-24 md:pb-8">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <h1 className="text-xl font-black tracking-tight">Friends</h1>
        <p className="text-xs text-gray-400 mt-1">Everyone who's shared a group with you</p>
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
    </div>
  )
}
