import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Chart, BarElement, CategoryScale, LinearScale, Tooltip, Legend, BarController,
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import { getGroups, getOverview } from '../api'
import LoadingSpinner from '../components/LoadingSpinner'

Chart.register(BarElement, CategoryScale, LinearScale, Tooltip, Legend, BarController)
Chart.defaults.font.family = "'Barlow Condensed', sans-serif"

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const PALETTE = ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6','#8b5cf6','#ec4899']

export default function History() {
  const nav = useNavigate()
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

  const historical = groups.filter((g) => g.is_historical)

  const barData = {
    labels: overview.map((g) => g.name.split(' ').slice(0, 2).join(' ')),
    datasets: [{
      label: 'Total Spent (₹)',
      data: overview.map((g) => g.total),
      backgroundColor: PALETTE,
      borderRadius: 8,
      borderSkipped: false,
    }],
  }

  const barOptions = {
    indexAxis: 'y',
    responsive: true,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (c) => ` ${INR(c.parsed.x)}` } },
    },
    scales: {
      x: { ticks: { callback: (v) => `₹${(v/1000).toFixed(0)}k`, font: { size: 10 } }, grid: { color: '#f1f5f9' } },
      y: { ticks: { font: { size: 10 } }, grid: { display: false } },
    },
    onClick: (_, elements) => {
      if (elements.length > 0) nav(`/groups/${overview[elements[0].index]?.id}`)
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
        <p className="text-xs text-gray-400 mt-0.5 font-medium">Tap a bar to drill into that group</p>
      </div>

      <div className="px-5 mt-4 md:grid md:grid-cols-2 md:gap-6 md:items-start">
        {/* Overall bar chart */}
        {overview.length > 0 && (
          <div className="card mb-4 md:mb-0">
            <h2 className="text-sm font-semibold text-gray-600 mb-3">Spending across all groups</h2>
            <Bar data={barData} options={barOptions} />
          </div>
        )}

        {/* Historical groups */}
        <div>
          <h2 className="text-sm font-semibold text-gray-500 mb-3 uppercase tracking-wide">Historical trips</h2>
          <div className="space-y-3">
            {historical.map((g) => (
              <div
                key={g.id}
                className="card flex items-center gap-4 cursor-pointer active:scale-[0.98] transition-transform"
                onClick={() => nav(`/groups/${g.id}`)}
              >
                <div className="w-12 h-12 bg-brand-400/10 flex items-center justify-center font-black text-brand-600 text-lg border border-brand-400/20">
                  {g.name[0]?.toUpperCase() || 'G'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm truncate">{g.name}</p>
                  <p className="text-xs text-gray-400">{g.expense_count} expenses · {g.member_count} people</p>
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
