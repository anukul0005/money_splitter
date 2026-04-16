import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Chart, BarElement, CategoryScale, LinearScale, Tooltip, Legend,
  ArcElement, DoughnutController, BarController,
} from 'chart.js'
import { Bar, Doughnut } from 'react-chartjs-2'
import { getGroup, getSettlement, getGroupStats, deleteExpense } from '../api'
import LoadingSpinner from '../components/LoadingSpinner'

Chart.register(BarElement, CategoryScale, LinearScale, Tooltip, Legend, ArcElement, DoughnutController, BarController)

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const PALETTE = ['#16a34a','#22c55e','#4ade80','#f59e0b','#f97316','#8b5cf6','#06b6d4','#ef4444']

export default function GroupDetail() {
  const { id } = useParams()
  const nav = useNavigate()

  const [group, setGroup]           = useState(null)
  const [settlement, setSettlement] = useState(null)
  const [stats, setStats]           = useState(null)
  const [loading, setLoading]       = useState(true)
  const [tab, setTab]               = useState('expenses')
  const [chartView, setChartView]   = useState('member')

  const reload = () => {
    setLoading(true)
    Promise.all([getGroup(id), getSettlement(id), getGroupStats(id)])
      .then(([g, s, st]) => {
        setGroup(g.data)
        setSettlement(s.data)
        setStats(st.data)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => { reload() }, [id])

  const handleDeleteExpense = async (expId) => {
    if (!confirm('Delete this expense?')) return
    await deleteExpense(expId)
    reload()
  }

  if (loading) return <LoadingSpinner />
  if (!group)  return <p className="p-5 text-gray-500">Group not found.</p>

  const memberChartData = {
    labels: stats?.by_member.map((x) => x.member) || [],
    datasets: [{
      label: 'Paid (₹)',
      data: stats?.by_member.map((x) => x.total_paid) || [],
      backgroundColor: PALETTE,
      borderRadius: 8,
      borderSkipped: false,
    }],
  }

  const catData = stats?.by_category.slice(0, 8) || []
  const catChartData = {
    labels: catData.map((c) => c.category),
    datasets: [{
      data: catData.map((c) => c.total),
      backgroundColor: PALETTE,
      borderWidth: 0,
      hoverOffset: 6,
    }],
  }

  const barOptions = {
    responsive: true,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${INR(c.parsed.y)}` } } },
    scales: {
      y: { ticks: { callback: (v) => `₹${(v/1000).toFixed(0)}k`, font: { size: 11 } }, grid: { color: '#f1f5f9' } },
      x: { ticks: { font: { size: 11 } }, grid: { display: false } },
    },
  }

  const donutOptions = {
    cutout: '60%',
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${INR(c.parsed)}` } } },
  }

  return (
    <div className="pb-24 md:pb-8">
      {/* Header */}
      <div className="bg-cream border-b border-amber-100/60 px-5 pt-10 md:pt-6 pb-3 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => nav(-1)} className="btn-ghost">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="text-2xl">{group.emoji}</span>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold truncate">{group.name}</h1>
            <p className="text-xs text-gray-400">{group.members.map((m) => m.name).join(' · ')}</p>
          </div>
          <button
            className="bg-brand-400 text-gray-900 text-xs font-bold px-3 py-1.5 rounded-lg shadow-sm"
            onClick={() => nav(`/add?group=${id}`)}
          >
            + Add
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mt-3">
          {[['expenses','Expenses'],['chart','Charts'],['settle','Settle Up']].map(([v, label]) => (
            <button
              key={v}
              onClick={() => setTab(v)}
              className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-colors ${
                tab === v ? 'bg-brand-400 text-gray-900 font-bold' : 'text-gray-500 hover:bg-amber-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary strip */}
      <div className="px-5 py-3 flex gap-3">
        <div className="card flex-1 text-center py-3">
          <p className="text-xs text-gray-400">Total</p>
          <p className="text-lg font-bold text-brand-600">{INR(stats?.total || 0)}</p>
        </div>
        <div className="card flex-1 text-center py-3">
          <p className="text-xs text-gray-400">Expenses</p>
          <p className="text-lg font-bold">{group.expenses.length}</p>
        </div>
        <div className="card flex-1 text-center py-3">
          <p className="text-xs text-gray-400">People</p>
          <p className="text-lg font-bold">{group.members.length}</p>
        </div>
      </div>

      {/* Expenses tab */}
      {tab === 'expenses' && (
        <div className="px-5 grid grid-cols-1 md:grid-cols-2 gap-2">
          {group.expenses.length === 0 && (
            <div className="col-span-2 text-center py-12 text-gray-400">
              <p className="text-4xl mb-2">🧾</p>
              <p className="text-sm">No expenses yet</p>
            </div>
          )}
          {[...group.expenses].reverse().map((e) => (
            <div key={e.id} className="card flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center text-lg flex-shrink-0">
                {categoryEmoji(e.category)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-900 truncate">{e.title || e.category || 'Expense'}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {e.paid_by} paid ·{' '}
                  {e.split_json ? (
                    <span className="text-purple-500 font-medium">custom split</span>
                  ) : (
                    `${e.divider} people`
                  )}{' '}
                  · {e.date || '—'}
                </p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="text-sm font-bold text-gray-900">{INR(e.amount)}</p>
                {e.split_json ? (
                  <p className="text-xs text-purple-500">split</p>
                ) : (
                  <p className="text-xs text-brand-600">{INR(e.individual_amount)}/ea</p>
                )}
              </div>
              {!group.is_historical && (
                <button
                  onClick={() => handleDeleteExpense(e.id)}
                  className="text-gray-300 hover:text-red-400 transition-colors ml-1 mt-0.5"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Charts tab */}
      {tab === 'chart' && stats && (
        <div className="px-5 space-y-4">
          <div className="flex gap-2">
            {[['member','By Person'],['category','By Category']].map(([v, label]) => (
              <button
                key={v}
                onClick={() => setChartView(v)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  chartView === v ? 'bg-brand-400 text-gray-900 font-bold' : 'bg-amber-50 border border-amber-200 text-gray-500'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {chartView === 'member' && (
            <div className="card">
              <h3 className="text-sm font-semibold text-gray-600 mb-3">Who paid how much?</h3>
              <Bar data={memberChartData} options={barOptions} />
            </div>
          )}

          {chartView === 'category' && catData.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-gray-600 mb-3">Spending by category</h3>
              <div className="flex items-center gap-4">
                <div className="w-40 h-40 flex-shrink-0">
                  <Doughnut data={catChartData} options={donutOptions} />
                </div>
                <ul className="flex-1 space-y-1.5 overflow-hidden">
                  {catData.map((c, i) => (
                    <li key={c.category} className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: PALETTE[i % PALETTE.length] }} />
                      <span className="text-xs text-gray-600 truncate flex-1">{c.category}</span>
                      <span className="text-xs font-semibold">{INR(c.total)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Settle Up tab */}
      {tab === 'settle' && settlement && (
        <div className="px-5 md:grid md:grid-cols-2 md:gap-4 space-y-4 md:space-y-0">
          {/* Balances */}
          <div className="card">
            <h3 className="text-sm font-semibold text-gray-600 mb-3">Individual balances</h3>
            <div className="space-y-3">
              {settlement.balances.map((b) => (
                <div key={b.member} className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center font-semibold text-gray-600 text-sm flex-shrink-0">
                    {b.member[0].toUpperCase()}
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold">{b.member}</p>
                    <p className="text-xs text-gray-400">Paid {INR(b.paid)} · Share {INR(b.share)}</p>
                  </div>
                  <div className={`text-sm font-bold ${b.net >= 0 ? 'text-brand-600' : 'text-red-500'}`}>
                    {b.net >= 0 ? `+${INR(b.net)}` : `-${INR(Math.abs(b.net))}`}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Transactions */}
          <div className="card">
            <h3 className="text-sm font-semibold text-gray-600 mb-3">Who pays whom?</h3>
            {settlement.transactions.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">✅ All settled!</p>
            ) : (
              <div className="space-y-2">
                {settlement.transactions.map((t, i) => (
                  <div key={i} className="flex items-center gap-2 bg-red-50 rounded-xl px-3 py-2.5">
                    <span className="font-semibold text-sm text-red-700">{t.from_member}</span>
                    <svg className="w-4 h-4 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                    </svg>
                    <span className="font-semibold text-sm text-red-700 flex-1">{t.to_member}</span>
                    <span className="font-bold text-brand-700 text-sm">{INR(t.amount)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function categoryEmoji(cat) {
  if (!cat) return '💸'
  const c = cat.toLowerCase()
  if (c.includes('food') || c.includes('snack') || c.includes('meal') || c.includes('bf')) return '🍽️'
  if (c.includes('drink') || c.includes('beer') || c.includes('whiskey') || c.includes('vodka') || c.includes('monk')) return '🍺'
  if (c.includes('cab') || c.includes('auto') || c.includes('taxi') || c.includes('rapido') || c.includes('ola')) return '🚕'
  if (c.includes('train') || c.includes('rail') || c.includes('irctc')) return '🚆'
  if (c.includes('hotel') || c.includes('stay')) return '🏨'
  if (c.includes('movie') || c.includes('cinema') || c.includes('pvr')) return '🎬'
  if (c.includes('shop') || c.includes('market') || c.includes('amazon') || c.includes('swiggy')) return '🛒'
  if (c.includes('diwali') || c.includes('patakhe')) return '🪔'
  return '💸'
}
