import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getGroups, getFriends } from '../api'
import GroupCard from '../components/GroupCard'
import LoadingSpinner from '../components/LoadingSpinner'
import { useUser } from '../UserContext'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

export default function FriendDetail() {
  const { name: rawName } = useParams()
  const friendName = decodeURIComponent(rawName)
  const nav = useNavigate()
  const user = useUser()

  const [groups,  setGroups]  = useState([])
  const [net,     setNet]     = useState(0)
  // group_id -> what that group contributes to the balance with this friend
  const [byGroup, setByGroup] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
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
  }, [friendName])

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
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
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
    </div>
  )
}
