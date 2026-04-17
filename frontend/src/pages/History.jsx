import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Chart, BarElement, CategoryScale, LinearScale, Tooltip, Legend, BarController,
  ArcElement, DoughnutController,
} from 'chart.js'
import { Bar, Doughnut } from 'react-chartjs-2'
import { getGroups, getOverview } from '../api'
import LoadingSpinner from '../components/LoadingSpinner'
import { useUser, isAdmin } from '../UserContext'

Chart.register(BarElement, CategoryScale, LinearScale, Tooltip, Legend, BarController, ArcElement, DoughnutController)
Chart.defaults.font.family = "'Barlow Condensed', sans-serif"

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const PALETTE = ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6','#8b5cf6','#ec4899','#14b8a6','#f59e0b','#84cc16','#6366f1']

export default function History() {
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
      .then(([g, o]) => { setGroups(g.data); setOverview(o.data) })
      .catch(() => setError('Could not reach server. The API may be waking up — please try again in 30 seconds.'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  // Non-admins only see groups they are a member of
  const filterForUser = (list) => {
    if (admin) return list
    return list.filter((g) =>
      (g.member_names ?? []).some((n) => n.toLowerCase() === user?.name?.toLowerCase())
    )
  }

  const historical = filterForUser(groups).filter((g) => g.is_historical)

  const visibleIds = new Set(filterForUser(groups).map((g) => g.id))
  const visibleOverview = overview.filter((g) => visibleIds.has(g.id))

  // Wrap long group names into 2-word lines for bar chart
  const wrapLabel = (name) => {
    const words = name.split(' ')
    const lines = []
    for (let i = 0; i < words.length; i += 2) lines.push(words.slice(i, i + 2).join(' '))
    return lines
  }

  const barData = {
    labels: visibleOverview.map((g) => wrapLabel(g.name.toUpperCase())),
    datasets: [{
      label: 'Total Spent',
      data: visibleOverview.map((g) => g.total),
      backgroundColor: PALETTE,
      borderRadius: 0,
      borderSkipped: false,
    }],
  }

  const barOptions = {
    responsive: true,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (c) => ` ${INR(c.parsed.y)}` } },
    },
    scales: {
      x: {
        ticks: {
          font: { size: 9, family: "'Barlow Condensed', sans-serif" },
          maxRotation: 0,
          autoSkip: false,
        },
        grid: { display: false },
      },
      y: {
        ticks: {
          callback: (v) => `₹${(v / 1000).toFixed(0)}k`,
          font: { size: 10, family: "'Barlow Condensed', sans-serif" },
        },
        grid: { color: '#f1f5f9' },
      },
    },
    onClick: (_, elements) => {
      if (elements.length > 0) nav(`/groups/${visibleOverview[elements[0].index]?.id}`)
    },
  }

  const doughnutData = {
    labels: visibleOverview.map((g) => g.name),
    datasets: [{
      data: visibleOverview.map((g) => g.total),
      backgroundColor: PALETTE,
      borderWidth: 0,
      hoverOffset: 8,
    }],
  }

  const doughnutOptions = {
    cutout: '68%',
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (ctx) => ` ${INR(ctx.parsed)}` } },
    },
    onClick: (_, elements) => {
      if (elements.length > 0) nav(`/groups/${visibleOverview[elements[0].index]?.id}`)
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
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream border-b border-amber-100/60 sticky top-0 z-10">
        <h1 className="text-xl font-black tracking-tight">History & Stats</h1>
        <p className="text-xs text-gray-400 mt-0.5 font-medium">Tap a bar or slice to drill into that group</p>
      </div>

      <div className="px-5 mt-4 space-y-4">

        {visibleOverview.length > 0 && (
          <div className="md:grid md:grid-cols-2 md:gap-4">
            {/* Bar chart */}
            <div className="card mb-4 md:mb-0">
              <h2 className="text-sm font-semibold text-gray-600 mb-3">Spending across all groups</h2>
              <Bar data={barData} options={barOptions} />
            </div>

            {/* Doughnut / pie chart */}
            <div className="card">
              <h2 className="text-sm font-semibold text-gray-600 mb-3">Share by group</h2>
              <div className="flex items-center gap-4">
                <div className="w-36 h-36 flex-shrink-0">
                  <Doughnut data={doughnutData} options={doughnutOptions} />
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
          </div>
        )}

        {/* Historical groups */}
        <div>
          <h2 className="text-sm font-semibold text-gray-500 mb-3 uppercase tracking-wide">Historical trips</h2>
          <div className="space-y-3">
            {historical.map((g) => (
              <div
                key={g.id}
                className="card flex items-center gap-3 cursor-pointer active:scale-[0.98] transition-transform"
                onClick={() => nav(`/groups/${g.id}`)}
              >
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm leading-snug">{g.name}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{g.expense_count} expenses · {g.member_count} people</p>
                </div>
                <span className="font-bold text-gray-900 text-sm whitespace-nowrap">{INR(g.total_amount)}</span>
              </div>
            ))}
            {historical.length === 0 && (
              <div className="text-center py-8 text-gray-400">
                <svg className="w-8 h-8 mx-auto mb-2 text-gray-300" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-sm">No historical data yet</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
