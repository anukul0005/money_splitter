import { useEffect, useState } from 'react'
import { useParams, useLocation, useNavigate } from 'react-router-dom'
import { getGroups, getAggregateStats } from '../api'
import GroupCard from '../components/GroupCard'
import LoadingSpinner from '../components/LoadingSpinner'
import StatsPanel from '../components/StatsPanel'
import { buildMasterGroups } from '../utils/masterGroups'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

export default function MasterGroupDetail() {
  const { key } = useParams()
  const location = useLocation()
  const nav = useNavigate()

  const [master,  setMaster]  = useState(location.state?.master ?? null)
  const [loading, setLoading] = useState(!location.state?.master)
  const [showStats, setShowStats] = useState(false)
  const [stats, setStats]         = useState(null)
  const [statsLoading, setStatsLoading] = useState(false)

  // Stats are consolidated across every group in the master, so they're
  // fetched once the user actually asks for them rather than on page load.
  useEffect(() => {
    if (!showStats || stats || !master) return
    setStatsLoading(true)
    getAggregateStats(master.groups.map((g) => g.id))
      .then((r) => setStats(r.data))
      .catch(() => setStats(null))
      .finally(() => setStatsLoading(false))
  }, [showStats, master])

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
        <div className="flex items-start justify-between gap-3">
          <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
          <div className="flex items-center gap-2">
          {/* A master group is one fixed member set, so a new group inside it
              is almost always those same people — prefill them. */}
          <button
            onClick={() => nav(`/groups/new?members=${encodeURIComponent((master.names ?? []).join(','))}`)}
            title={`New group with ${master.name}`}
            className="flex-shrink-0 flex items-center gap-1.5 bg-cream border border-amber-200 text-gray-500 hover:bg-amber-50 rounded-md px-3 py-1.5 text-xs font-bold active:scale-95 transition-all shadow-sm"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            New
          </button>
          <button
            onClick={() => setShowStats((v) => !v)}
            title={showStats ? 'Back to groups' : 'Stats across all these groups'}
            aria-label="Stats"
            aria-pressed={showStats}
            className={`flex-shrink-0 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold active:scale-95 transition-all shadow-sm border ${
              showStats
                ? 'bg-brand-400 border-brand-400 text-white'
                : 'bg-cream border-amber-200 text-gray-500 hover:bg-amber-50'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6m4 6V5m4 14v-9M4 21h16" />
            </svg>
            Stats
          </button>
          </div>
        </div>
        <h1 className="text-xl font-black tracking-tight">{master.name}</h1>
        <p className="text-xs text-gray-400 mt-1">{master.groups.length} groups · {INR(master.totalAmount)} total</p>
      </div>

      {showStats ? (
        statsLoading ? <LoadingSpinner /> : (
          <StatsPanel
            stats={stats}
            expenses={stats?.expenses ?? []}
            isSolo={(master.names ?? []).length === 1}
          />
        )
      ) : (
        <div className="px-5 mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          {master.groups.map((g) => <GroupCard key={g.id} group={g} />)}
        </div>
      )}
    </div>
  )
}
