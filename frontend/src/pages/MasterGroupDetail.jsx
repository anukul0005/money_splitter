import { useEffect, useState } from 'react'
import { useParams, useLocation, useNavigate } from 'react-router-dom'
import { getGroups } from '../api'
import GroupCard from '../components/GroupCard'
import LoadingSpinner from '../components/LoadingSpinner'
import { buildMasterGroups } from '../utils/masterGroups'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

export default function MasterGroupDetail() {
  const { key } = useParams()
  const location = useLocation()
  const nav = useNavigate()

  const [master,  setMaster]  = useState(location.state?.master ?? null)
  const [loading, setLoading] = useState(!location.state?.master)

  useEffect(() => {
    if (location.state?.master) return
    setLoading(true)
    getGroups()
      .then((r) => {
        // minGroups=1 so a direct link still resolves even if this member
        // set currently has only one group.
        const { masters } = buildMasterGroups(r.data, 1)
        setMaster(masters.find((m) => m.key === decodeURIComponent(key)) ?? null)
      })
      .finally(() => setLoading(false))
  }, [key])

  if (loading) return <LoadingSpinner />

  if (!master) {
    return (
      <div className="text-center py-16 text-gray-400">
        <p className="text-sm">Master group not found</p>
      </div>
    )
  }

  return (
    <div className="pb-24 md:pb-8">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <h1 className="text-xl font-black tracking-tight">{master.name}</h1>
        <p className="text-xs text-gray-400 mt-1">{master.groups.length} groups · {INR(master.totalAmount)} total</p>
      </div>

      <div className="px-5 mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
        {master.groups.map((g) => <GroupCard key={g.id} group={g} />)}
      </div>
    </div>
  )
}
