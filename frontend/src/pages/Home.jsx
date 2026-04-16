import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Chart, ArcElement, Tooltip, Legend, DoughnutController } from 'chart.js'
import { Doughnut } from 'react-chartjs-2'
import { getGroups, getOverview } from '../api'
import GroupCard from '../components/GroupCard'
import LoadingSpinner from '../components/LoadingSpinner'

Chart.register(ArcElement, Tooltip, Legend, DoughnutController)

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

const PALETTE = [
  '#16a34a','#22c55e','#4ade80','#86efac',
  '#f59e0b','#f97316','#ef4444','#8b5cf6',
  '#06b6d4','#0ea5e9','#ec4899','#64748b',
]

export default function Home() {
  const nav = useNavigate()
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

  const totalSpend = overview.reduce((s, g) => s + g.total, 0)

  const chartData = {
    labels: overview.map((g) => g.name),
    datasets: [{
      data: overview.map((g) => g.total),
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
        const gId = overview[idx]?.id
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
        <p className="text-green-200/40 text-xs mt-1 font-medium">{groups.length} groups · tap a slice to explore</p>
      </div>

      <div className="px-5 mt-4 md:mt-6">
        {/* Chart + groups grid on desktop */}
        <div className="md:grid md:grid-cols-2 md:gap-6">

          {/* Doughnut chart */}
          {overview.length > 0 && (
            <div className="card mb-4 md:mb-0">
              <h2 className="text-sm font-semibold text-gray-500 mb-3">Spending by group</h2>
              <div className="flex items-center gap-4">
                <div className="w-36 h-36 flex-shrink-0">
                  <Doughnut data={chartData} options={chartOptions} />
                </div>
                <ul className="flex-1 space-y-2 overflow-hidden">
                  {overview.map((g, i) => (
                    <li
                      key={g.id}
                      className="flex items-center gap-2 cursor-pointer"
                      onClick={() => nav(`/groups/${g.id}`)}
                    >
                      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: PALETTE[i % PALETTE.length] }} />
                      <span className="text-xs text-gray-600 truncate flex-1">{g.emoji} {g.name}</span>
                      <span className="text-xs font-semibold text-gray-800 whitespace-nowrap">{INR(g.total)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* Quick actions */}
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <button className="btn-primary py-3 text-sm" onClick={() => nav('/groups/new')}>
                + New Group
              </button>
              <button
                className="bg-cream border border-amber-200 hover:bg-cream-200 active:scale-95 text-gray-800 font-bold px-4 py-3 rounded-xl transition-all duration-150 w-full text-center text-sm"
                onClick={() => nav('/add')}
              >
                + Add Expense
              </button>
            </div>

            {/* Recent groups on desktop (shown next to chart) */}
            <div className="hidden md:block card">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Recent groups</p>
              <div className="space-y-2">
                {groups.slice(0, 3).map((g) => (
                  <div
                    key={g.id}
                    className="flex items-center gap-2 cursor-pointer hover:bg-amber-50 rounded-lg px-1 py-1 transition-colors"
                    onClick={() => nav(`/groups/${g.id}`)}
                  >
                    <span className="text-xl">{g.emoji}</span>
                    <span className="text-sm font-medium text-gray-700 flex-1 truncate">{g.name}</span>
                    <span className="text-sm font-bold text-brand-600 whitespace-nowrap">
                      {INR(g.total_amount)}
                    </span>
                  </div>
                ))}
                {groups.length > 3 && (
                  <button
                    className="text-xs text-brand-600 font-medium pt-1"
                    onClick={() => nav('/groups')}
                  >
                    View all {groups.length} groups →
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
            {groups.map((g) => (
              <GroupCard key={g.id} group={g} />
            ))}
          </div>
          {groups.length === 0 && (
            <div className="text-center py-12 text-gray-400">
              <p className="text-4xl mb-2">🪹</p>
              <p className="text-sm">No groups yet. Create one!</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
