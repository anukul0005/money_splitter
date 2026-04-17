import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Chart, ArcElement, Tooltip, Legend, DoughnutController } from 'chart.js'
import { Doughnut } from 'react-chartjs-2'
import { getGroups, getOverview } from '../api'
import GroupCard from '../components/GroupCard'
import LoadingSpinner from '../components/LoadingSpinner'
import { useUser, isAdmin } from '../UserContext'

Chart.register(ArcElement, Tooltip, Legend, DoughnutController)
Chart.defaults.font.family = "'Barlow Condensed', sans-serif"

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

const PALETTE = [
  '#ef4444','#f97316','#eab308','#22c55e',
  '#06b6d4','#3b82f6','#8b5cf6','#ec4899',
  '#14b8a6','#f59e0b','#84cc16','#6366f1',
]

export default function Home() {
  const nav = useNavigate()
  const user = useUser()
  const admin = isAdmin(user)

  const [groups, setGroups]     = useState([])
  const [overview, setOverview] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')

  const load = () => {
    setLoading(true)
    setError('')
    Promise.all([getGroups(), getOverview()])
      .then(([g, o]) => {
        setGroups(g.data)
        setOverview(o.data)
      })
      .catch(() => setError('Could not reach server. The API may be waking up — please try again in 30 seconds.'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  // Non-admins only see groups they belong to
  const filterForUser = (list) => {
    if (admin) return list
    return list.filter((g) =>
      (g.member_names ?? []).some((n) => n.toLowerCase() === user?.name?.toLowerCase())
    )
  }

  const visibleGroups = filterForUser(groups)
  const visibleIds    = new Set(visibleGroups.map((g) => g.id))
  const visibleOverview = overview.filter((g) => visibleIds.has(g.id))

  const totalSpend = visibleOverview.reduce((s, g) => s + g.total, 0)

  const chartData = {
    labels: visibleOverview.map((g) => g.name),
    datasets: [{
      data: visibleOverview.map((g) => g.total),
      backgroundColor: PALETTE,
      borderWidth: 0,
      hoverOffset: 8,
    }],
  }

  const chartOptions = {
    cutout: '68%',
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (ctx) => ` ${INR(ctx.parsed)}` } },
    },
    onClick: (_, elements) => {
      if (elements.length > 0) {
        const idx = elements[0].index
        const gId = visibleOverview[idx]?.id
        if (gId) nav(`/groups/${gId}`)
      }
    },
  }

  if (loading) return <LoadingSpinner />

  if (error) return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-5 text-center">
      <p className="text-4xl mb-3">😴</p>
      <p className="text-sm text-gray-600 mb-4">{error}</p>
      <button onClick={load} className="bg-brand-400 text-gray-900 px-5 py-2 rounded-xl text-sm font-bold shadow-md">
        Retry
      </button>
    </div>
  )

  return (
    <div className="pb-24 md:pb-8">
      {/* Header */}
      <div className="bg-gradient-to-br from-field-800 to-field-950 text-white px-5 pt-10 md:pt-8 pb-6 md:rounded-b-3xl border-b border-field-700">
        <p className="text-brand-400/70 text-xs font-bold uppercase tracking-widest">Total spent across all groups</p>
        <h1 className="text-4xl font-black mt-1 tracking-tight">{INR(totalSpend)}</h1>
        <p className="text-green-200/40 text-xs mt-1 font-medium">{visibleGroups.length} groups · tap a slice to explore</p>
      </div>

      <div className="px-5 mt-4 md:mt-6">
        {/* Chart + groups grid on desktop */}
        <div className="md:grid md:grid-cols-2 md:gap-6">

          {/* Doughnut chart */}
          {visibleOverview.length > 0 && (
            <div className="card mb-4 md:mb-0">
              <h2 className="text-sm font-semibold text-gray-500 mb-3">Spending by group</h2>
              <div className="flex items-center gap-4">
                <div className="w-36 h-36 flex-shrink-0">
                  <Doughnut data={chartData} options={chartOptions} />
                </div>
                <ul className="flex-1 space-y-2">
                  {visibleOverview.map((g, i) => (
                    <li
                      key={g.id}
                      className="flex items-start gap-2 cursor-pointer"
                      onClick={() => nav(`/groups/${g.id}`)}
                    >
                      <span className="w-2 h-2 flex-shrink-0 mt-1.5" style={{ background: PALETTE[i % PALETTE.length] }} />
                      <span className="text-xs text-gray-600 flex-1 leading-tight">{g.name}</span>
                      <span className="text-xs font-black text-gray-800 whitespace-nowrap">{INR(g.total)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* Quick actions */}
          <div className="space-y-3">
            {admin && (
              <div className="grid grid-cols-2 gap-3">
                <button className="btn-primary py-3 text-sm" onClick={() => nav('/groups/new')}>
                  + New Group
                </button>
                <button
                  className="bg-cream border border-amber-200 hover:bg-cream-200 active:scale-95 text-gray-800 font-bold px-4 py-3 transition-all duration-150 w-full text-center text-sm"
                  onClick={() => nav('/add')}
                >
                  + Add Expense
                </button>
              </div>
            )}

            {/* Recent groups on desktop (shown next to chart) */}
            <div className="hidden md:block card">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Recent groups</p>
              <div className="space-y-2">
                {visibleGroups.slice(0, 3).map((g) => (
                  <div
                    key={g.id}
                    className="flex items-center gap-2 cursor-pointer hover:bg-amber-50 rounded-lg px-1 py-1 transition-colors"
                    onClick={() => nav(`/groups/${g.id}`)}
                  >
                    <span className="text-sm font-medium text-gray-700 flex-1 leading-tight">{g.name}</span>
                    <span className="text-sm font-bold text-brand-600 whitespace-nowrap">
                      {INR(g.total_amount)}
                    </span>
                  </div>
                ))}
                {visibleGroups.length > 3 && (
                  <button
                    className="text-xs text-brand-600 font-medium pt-1"
                    onClick={() => nav('/groups')}
                  >
                    View all {visibleGroups.length} groups →
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* All groups list */}
        <div className="mt-5">
          <h2 className="text-sm font-semibold text-gray-500 mb-3 uppercase tracking-wide">All Groups</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {visibleGroups.map((g) => (
              <GroupCard key={g.id} group={g} />
            ))}
          </div>
          {visibleGroups.length === 0 && (
            <div className="text-center py-12 text-gray-400">
              <svg className="w-10 h-10 mx-auto mb-2 text-gray-300" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m9-4.13a4 4 0 11-8 0 4 4 0 018 0zm6 0a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              <p className="text-sm">No groups yet.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
