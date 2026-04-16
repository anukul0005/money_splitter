import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Chart, BarElement, CategoryScale, LinearScale, Tooltip, Legend, BarController,
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import { getGroups, getOverview } from '../api'
import LoadingSpinner from '../components/LoadingSpinner'

Chart.register(BarElement, CategoryScale, LinearScale, Tooltip, Legend, BarController)

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const PALETTE = ['#16a34a','#22c55e','#4ade80','#f59e0b','#f97316','#8b5cf6','#06b6d4','#ef4444']

export default function History() {
  const nav = useNavigate()
  const [groups, setGroups]     = useState([])
  const [overview, setOverview] = useState([])
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    Promise.all([getGroups(), getOverview()])
      .then(([g, o]) => { setGroups(g.data); setOverview(o.data) })
      .finally(() => setLoading(false))
  }, [])

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

  return (
    <div className="pb-24 md:pb-8">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-white border-b border-gray-100 sticky top-0 z-10">
        <h1 className="text-xl font-bold">History & Stats</h1>
        <p className="text-xs text-gray-400 mt-0.5">Tap a bar to drill into that group</p>
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
                <div className="w-12 h-12 rounded-xl bg-amber-50 flex items-center justify-center text-2xl">
                  {g.emoji}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm truncate">{g.name}</p>
                  <p className="text-xs text-gray-400">{g.expense_count} expenses · {g.member_count} people</p>
                </div>
                <span className="font-bold text-gray-900 text-sm whitespace-nowrap">{INR(g.total_amount)}</span>
              </div>
            ))}
            {historical.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-8">No historical data yet</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
