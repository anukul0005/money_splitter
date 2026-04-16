import { useEffect, useState, useRef } from 'react'
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
  const [drillGroup, setDrill]  = useState(null)  // clicked group id for chart drill

  useEffect(() => {
    Promise.all([getGroups(), getOverview()])
      .then(([g, o]) => {
        setGroups(g.data)
        setOverview(o.data)
      })
      .finally(() => setLoading(false))
  }, [])

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
      tooltip: {
        callbacks: {
          label: (ctx) => ` ${INR(ctx.parsed)}`,
        },
      },
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

  return (
    <div className="pb-24">
      {/* ── Header ── */}
      <div className="bg-gradient-to-br from-brand-600 to-brand-700 text-white px-5 pt-12 pb-6 rounded-b-3xl">
        <p className="text-brand-100 text-sm font-medium">Total spent across all groups</p>
        <h1 className="text-4xl font-bold mt-1">{INR(totalSpend)}</h1>
        <p className="text-brand-200 text-xs mt-1">{groups.length} groups · tap a slice to explore</p>
      </div>

      {/* ── Doughnut chart ── */}
      {overview.length > 0 && (
        <div className="px-5 -mt-2">
          <div className="card">
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
        </div>
      )}

      {/* ── Quick actions ── */}
      <div className="px-5 mt-4 grid grid-cols-2 gap-3">
        <button
          className="btn-primary py-3 text-sm"
          onClick={() => nav('/groups/new')}
        >
          + New Group
        </button>
        <button
          className="bg-gray-100 hover:bg-gray-200 active:scale-95 text-gray-800 font-semibold px-4 py-3 rounded-xl transition-all duration-150 w-full text-center text-sm"
          onClick={() => nav('/add')}
        >
          + Add Expense
        </button>
      </div>

      {/* ── Groups list ── */}
      <div className="px-5 mt-5">
        <h2 className="text-sm font-semibold text-gray-500 mb-3 uppercase tracking-wide">All Groups</h2>
        <div className="space-y-3">
          {groups.map((g) => (
            <GroupCard key={g.id} group={g} />
          ))}
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
