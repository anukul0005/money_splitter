import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Chart, BarElement, CategoryScale, LinearScale, Tooltip, Legend,
  ArcElement, DoughnutController, BarController,
  LineElement, PointElement, LineController,
} from 'chart.js'
import { Bar, Doughnut, Line } from 'react-chartjs-2'
import { getGroup, getSettlement, getGroupStats, deleteExpense, deleteGroup, settleExpense } from '../api'
import LoadingSpinner from '../components/LoadingSpinner'
import ExpenseEditModal from '../components/ExpenseEditModal'
import { useUser } from '../UserContext'

Chart.register(BarElement, CategoryScale, LinearScale, Tooltip, Legend, ArcElement, DoughnutController, BarController, LineElement, PointElement, LineController)
Chart.defaults.font.family = "'Barlow Condensed', sans-serif"

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const PALETTE = ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6','#8b5cf6','#ec4899']

export default function GroupDetail() {
  const { id } = useParams()
  const nav = useNavigate()

  const currentUser = useUser()

  const [group, setGroup]               = useState(null)
  const [settlement, setSettlement]     = useState(null)
  const [stats, setStats]               = useState(null)
  const [loading, setLoading]           = useState(true)
  const [tab, setTab]                   = useState('expenses')
  const [chartView, setChartView]       = useState('member')
  const [editingExpense, setEditingExp] = useState(null)   // expense being edited

  const fetchData = () =>
    Promise.all([getGroup(id), getSettlement(id), getGroupStats(id)])
      .then(([g, s, st]) => {
        setGroup(g.data)
        setSettlement(s.data)
        setStats(st.data)
      })

  // Silent refresh — no spinner, preserves scroll position
  const reload = () => fetchData()

  useEffect(() => {
    setLoading(true)
    fetchData().finally(() => setLoading(false))
  }, [id])

  const handleDeleteExpense = async (expId) => {
    if (!confirm('Delete this expense?')) return
    await deleteExpense(expId)
    reload()
  }

  const handleSettle = async (expenseId, member, settled) => {
    await settleExpense(expenseId, { member, settled })
    reload()
  }

  const handleDeleteGroup = async () => {
    if (!confirm(`Delete group "${group.name}" and all its expenses? This cannot be undone.`)) return
    await deleteGroup(id)
    nav('/groups')
  }

  if (loading) return <LoadingSpinner />
  if (!group)  return <p className="p-5 text-gray-500">Group not found.</p>

  // Horizontal bar chart (member names on y-axis)
  const memberChartData = {
    labels: stats?.by_member.map((x) => x.member.toUpperCase()) || [],
    datasets: [{
      label: 'Paid',
      data: stats?.by_member.map((x) => x.total_paid) || [],
      backgroundColor: PALETTE,
      borderRadius: 0,
      borderSkipped: false,
    }],
  }

  const rawCats = stats?.by_category || []
  const catMerge = {}
  rawCats.forEach((c) => {
    const key = c.category.trim().toLowerCase()
    if (!catMerge[key]) catMerge[key] = { category: c.category, total: 0 }
    catMerge[key].total += c.total
  })
  const catData = Object.values(catMerge).sort((a, b) => b.total - a.total).slice(0, 8)
  const catChartData = {
    labels: catData.map((c) => c.category.toUpperCase()),
    datasets: [{
      data: catData.map((c) => c.total),
      backgroundColor: PALETTE,
      borderWidth: 0,
      hoverOffset: 6,
    }],
  }

  const hBarOptions = {
    indexAxis: 'y',
    responsive: true,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (c) => ` ${INR(c.parsed.x)}` } },
    },
    scales: {
      x: { ticks: { callback: (v) => `₹${(v/1000).toFixed(0)}k`, font: { size: 11, family: "'Barlow Condensed'" } }, grid: { color: '#f1f5f9' } },
      y: { ticks: { font: { size: 12, family: "'Barlow Condensed'" } }, grid: { display: false } },
    },
  }

  const donutOptions = {
    cutout: '60%',
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${INR(c.parsed)}` } } },
  }

  // Distribution stats for Charts tab
  const expAmounts = [...group.expenses].map((e) => e.amount).sort((a, b) => a - b)
  const distStats = (() => {
    const n = expAmounts.length
    if (n < 2) return null
    const mean = expAmounts.reduce((s, v) => s + v, 0) / n
    const median = n % 2 === 0
      ? (expAmounts[n / 2 - 1] + expAmounts[n / 2]) / 2
      : expAmounts[Math.floor(n / 2)]
    const freq = {}
    expAmounts.forEach((v) => { freq[v] = (freq[v] || 0) + 1 })
    let mode = expAmounts[0], maxF = 0
    Object.entries(freq).forEach(([v, f]) => { if (f > maxF) { maxF = f; mode = parseFloat(v) } })
    const pct = (p) => {
      const idx = (p / 100) * (n - 1)
      const lo = Math.floor(idx), hi = Math.ceil(idx)
      return lo === hi ? expAmounts[lo] : expAmounts[lo] + (expAmounts[hi] - expAmounts[lo]) * (idx - lo)
    }
    return { mean, median, mode, p10: pct(10), p25: pct(25), p75: pct(75), p90: pct(90), min: expAmounts[0], max: expAmounts[n - 1] }
  })()

  // Daily spend line chart (for single-member groups)
  const isSolo = group.members.length === 1
  const dailyMap = {}
  group.expenses.forEach((e) => {
    if (e.date) dailyMap[e.date] = (dailyMap[e.date] || 0) + e.amount
  })
  const dailyEntries = Object.entries(dailyMap).sort(([a], [b]) => a.localeCompare(b))
  const dailyLabels  = dailyEntries.map(([d]) => d)
  const dailyValues  = dailyEntries.map(([, v]) => v)

  const dailyLineData = {
    labels: dailyLabels,
    datasets: [{
      label: 'Daily Spend',
      data: dailyValues,
      borderColor: '#22c55e',
      backgroundColor: 'rgba(34,197,94,0.08)',
      borderWidth: 2,
      pointRadius: 5,
      pointHoverRadius: 7,
      pointBackgroundColor: '#22c55e',
      tension: 0,
      fill: true,
    }],
  }

  const dailyLineOptions = {
    responsive: true,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (c) => ` ${INR(c.parsed.y)}` } },
    },
    scales: {
      x: {
        ticks: {
          font: { size: 11, family: "'Barlow Condensed'" },
          maxTicksLimit: 3,
          maxRotation: 0,
        },
        grid: { display: false },
      },
      y: {
        ticks: {
          callback: (v) => `₹${(v / 1000).toFixed(0)}k`,
          font: { size: 11, family: "'Barlow Condensed'" },
          maxTicksLimit: 4,
        },
        grid: { color: '#f1f5f9' },
      },
    },
  }

  return (
    <div className="pb-24 md:pb-8">
      {/* Header */}
      <div className="bg-cream border-b border-amber-100/60 px-5 pt-10 md:pt-6 pb-3 sticky top-0 z-10">
        <div className="flex items-start gap-3">
          <button onClick={() => nav(-1)} className="btn-ghost mt-1">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold leading-tight">{group.name}</h1>
            <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{group.members.map((m) => m.name).join(' · ')}</p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              className="text-gray-400 hover:text-gray-600 transition-colors p-1"
              onClick={() => nav(`/groups/${id}/edit`)}
              title="Edit group"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            <button
              className="text-gray-400 hover:text-red-500 transition-colors p-1"
              onClick={handleDeleteGroup}
              title="Delete group"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
            <button
              className="bg-brand-400 text-gray-900 text-xs font-bold px-3 py-1.5 shadow-sm ml-1"
              onClick={() => nav(`/add?group=${id}`)}
            >
              + Add
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mt-3">
          {([['expenses','Expenses'],['chart','Charts'],...(isSolo ? [] : [['settle','Settle Up']])]).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setTab(v)}
              className={`flex-1 py-2 text-xs font-bold transition-colors border ${
                tab === v
                  ? 'bg-brand-400 text-gray-900 border-brand-400'
                  : 'text-gray-500 border-transparent hover:bg-amber-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary strip */}
      <div className="px-5 py-3 flex gap-2">
        <div className="card flex-1 text-center py-3">
          <p className="text-xs text-gray-400">Total</p>
          <p className="text-base font-black text-brand-600">{INR(stats?.total || 0)}</p>
        </div>
        <div className="card flex-1 text-center py-3">
          <p className="text-xs text-gray-400">Expenses</p>
          <p className="text-base font-black">{group.expenses.length}</p>
        </div>
        <div className="card flex-1 text-center py-3">
          <p className="text-xs text-gray-400">People</p>
          <p className="text-base font-black">{group.members.length}</p>
        </div>
      </div>

      {/* Expenses tab */}
      {tab === 'expenses' && (
        <div className="px-5 grid grid-cols-1 md:grid-cols-2 gap-2">
          {group.expenses.length === 0 && (
            <div className="col-span-2 text-center py-12 text-gray-400">
              <svg className="w-10 h-10 mx-auto mb-2 text-gray-300" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
              </svg>
              <p className="text-sm mb-4">No expenses yet</p>
              <button
                onClick={() => nav(`/add?group=${id}`)}
                className="btn-primary px-6 py-3 text-sm"
              >
                + Add First Expense
              </button>
            </div>
          )}
          {[...group.expenses]
            .sort((a, b) => {
              if (!a.date && !b.date) return 0
              if (!a.date) return 1
              if (!b.date) return -1
              return b.date.localeCompare(a.date)
            })
            .map((e) => {
            const memberCount   = group.members.length
            const isPartialSplit = !e.split_json && e.divider < memberCount && e.divider > 0

            // Parse split_json
            let splitEntries = null
            let splitLabel   = null
            if (e.split_json) {
              try {
                const obj = JSON.parse(e.split_json)
                splitEntries = Object.entries(obj)
                if (splitEntries.length === 2) {
                  const [, a0] = splitEntries[0]
                  const [, a1] = splitEntries[1]
                  const r0 = Math.round((a0 / e.amount) * 100)
                  const r1 = Math.round((a1 / e.amount) * 100)
                  const lo = Math.min(r0, r1), hi = Math.max(r0, r1)
                  splitLabel = (lo === 35 && hi === 65) ? "Gentleman's 65/35" : `Custom ${r0}/${r1}`
                } else {
                  splitLabel = 'Custom split'
                }
              } catch { /* ignore */ }
            }

            // Settlement helpers
            const actualParticipants = e.participants
              ? e.participants.split(',').map((s) => s.trim()).filter(Boolean)
              : group.members.map((m) => m.name)
            const debtors = actualParticipants.filter(
              (n) => n.toLowerCase() !== e.paid_by?.toLowerCase()
            )
            const settledList = (() => {
              try { return e.settled_by ? JSON.parse(e.settled_by) : [] }
              catch { return [] }
            })()
            const isSettled = (n) => settledList.some((s) => s.toLowerCase() === n.toLowerCase())
            const isPayer = currentUser?.name?.toLowerCase() === e.paid_by?.toLowerCase()
            const getOwed = (name) => {
              if (e.split_json) {
                try { const obj = JSON.parse(e.split_json); return obj[name] ?? 0 }
                catch { return 0 }
              }
              return e.individual_amount || (e.amount / (e.divider || 1))
            }

            return (
              <div key={e.id} className="card">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 bg-amber-50 border border-amber-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <svg className="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
                    </svg>
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-gray-900 leading-tight" style={{ wordBreak: 'break-word' }}>
                      {e.title || e.category || 'Expense'}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {e.paid_by} · {e.date || '—'}
                      {e.payment_mode && (
                        <span className="ml-1.5 inline-block bg-amber-50 border border-amber-200 px-1.5 py-px text-[10px] font-bold text-amber-700 tracking-wide">
                          {e.payment_mode.replace('_', ' ').toUpperCase()}
                        </span>
                      )}
                    </p>

                    {/* Custom / gentleman's split — per-member breakdown */}
                    {splitEntries && (
                      <div className="mt-1.5 border border-amber-300 bg-amber-50/60 px-2 py-1.5 space-y-1">
                        <p className="text-[10px] font-black text-amber-700 tracking-widest mb-0.5">
                          {splitLabel}
                        </p>
                        {splitEntries.map(([name, amt]) => {
                          const pct = Math.round((amt / e.amount) * 100)
                          return (
                            <div key={name} className="flex items-center justify-between gap-2">
                              <span className="text-xs font-bold text-gray-700">{name}</span>
                              <span className="text-xs text-gray-400">{pct}%</span>
                              <span className="text-xs font-black text-gray-900">{INR(amt)}</span>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {/* Partial equal split badge */}
                    {isPartialSplit && (
                      <span className="inline-block mt-1 text-[10px] font-bold text-orange-600 bg-orange-50 border border-orange-200 px-1.5 py-0.5 tracking-wide">
                        {e.divider}/{memberCount} split
                      </span>
                    )}
                  </div>

                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-black text-gray-900">{INR(e.amount)}</p>
                    {!e.split_json && !isSolo && (
                      <p className="text-xs text-brand-600">{INR(e.individual_amount)}/ea</p>
                    )}
                  </div>

                  {/* Action buttons — row layout with generous tap targets for mobile */}
                  <div className="flex items-center ml-1 flex-shrink-0">
                    <button
                      onClick={() => setEditingExp(e)}
                      className="p-2 text-gray-300 hover:text-brand-500 transition-colors"
                      title="Edit expense"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDeleteExpense(e.id)}
                      className="p-2 text-gray-300 hover:text-red-400 transition-colors"
                      title="Delete expense"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Settlement status — shown when there are debtors */}
                {debtors.length > 0 && (
                  <div className="mt-2.5 border-t border-amber-100 pt-2.5 space-y-1.5">
                    {debtors.map((name) => {
                      const settled = isSettled(name)
                      const owed    = getOwed(name)
                      return (
                        <div key={name} className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-gray-600 flex-1 min-w-0 truncate">{name}</span>
                          {settled ? (
                            <span className="text-[10px] font-bold text-green-700 bg-green-50 border border-green-200 px-1.5 py-0.5 flex-shrink-0">✓ Settled</span>
                          ) : (
                            <span className="text-[10px] font-bold text-red-600 bg-red-50 border border-red-100 px-1.5 py-0.5 flex-shrink-0">owes {INR(owed)}</span>
                          )}
                          {isPayer && (
                            <button
                              onClick={() => handleSettle(e.id, name, !settled)}
                              className={`text-[10px] font-bold px-1.5 py-0.5 border transition-colors flex-shrink-0 ${
                                settled
                                  ? 'text-gray-400 border-gray-200 hover:text-red-500 hover:border-red-200'
                                  : 'text-brand-600 border-brand-400/40 hover:bg-brand-400/10'
                              }`}
                            >
                              {settled ? 'Undo' : 'Mark settled'}
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Charts tab */}
      {tab === 'chart' && stats && (
        <div className="px-5 space-y-4 mt-2">

          {/* Solo group: daily spend line + category donut */}
          {isSolo ? (
            <>
              {dailyEntries.length > 0 ? (
                <div className="card">
                  <h3 className="text-xs font-bold text-gray-500 mb-3">Daily Spend</h3>
                  <Line data={dailyLineData} options={dailyLineOptions} />
                </div>
              ) : (
                <p className="text-xs text-gray-400 text-center py-6">No dated expenses yet</p>
              )}

              {catData.length > 0 && (
                <div className="card">
                  <h3 className="text-xs font-bold text-gray-500 mb-3">Spending by category</h3>
                  <div className="flex items-start gap-4">
                    <div className="w-36 h-36 flex-shrink-0">
                      <Doughnut data={catChartData} options={donutOptions} />
                    </div>
                    <ul className="flex-1 space-y-2">
                      {catData.map((c, i) => (
                        <li key={c.category} className="flex items-start gap-2">
                          <span className="w-2 h-2 flex-shrink-0 mt-1.5" style={{ background: PALETTE[i % PALETTE.length] }} />
                          <span className="text-xs text-gray-600 flex-1 leading-tight">{c.category}</span>
                          <span className="text-xs font-black flex-shrink-0">{INR(c.total)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex gap-2">
                {[['member','By Person'],['category','By Category']].map(([v, label]) => (
                  <button
                    key={v}
                    onClick={() => setChartView(v)}
                    className={`px-3 py-1.5 text-xs font-bold transition-colors border ${
                      chartView === v
                        ? 'bg-brand-400 text-gray-900 border-brand-400'
                        : 'bg-amber-50 border-amber-200 text-gray-500'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {chartView === 'member' && (
                <div className="card">
                  <h3 className="text-xs font-bold text-gray-500 mb-3">Who paid how much?</h3>
                  <Bar data={memberChartData} options={hBarOptions} />
                </div>
              )}

              {chartView === 'category' && catData.length > 0 && (
                <div className="card">
                  <h3 className="text-xs font-bold text-gray-500 mb-3">Spending by category</h3>
                  <div className="flex items-start gap-4">
                    <div className="w-36 h-36 flex-shrink-0">
                      <Doughnut data={catChartData} options={donutOptions} />
                    </div>
                    <ul className="flex-1 space-y-2">
                      {catData.map((c, i) => (
                        <li key={c.category} className="flex items-start gap-2">
                          <span className="w-2 h-2 flex-shrink-0 mt-1.5" style={{ background: PALETTE[i % PALETTE.length] }} />
                          <span className="text-xs text-gray-600 flex-1 leading-tight">{c.category}</span>
                          <span className="text-xs font-black flex-shrink-0">{INR(c.total)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </>
          )}

          {distStats && (
            <div className="card">
              <h3 className="text-xs font-bold text-gray-500 mb-3">Expense Distribution ({expAmounts.length} expenses)</h3>
              <table className="w-full">
                <tbody className="divide-y divide-amber-100">
                  {[
                    ['Mean',                 INR(Math.round(distStats.mean))],
                    ['Median',               INR(Math.round(distStats.median))],
                    ['Mode',                 INR(Math.round(distStats.mode))],
                    ['Top 10% (P90–max)',    `${INR(Math.round(distStats.p90))} – ${INR(Math.round(distStats.max))}`],
                    ['P75 – P90',            `${INR(Math.round(distStats.p75))} – ${INR(Math.round(distStats.p90))}`],
                    ['P25 – P75 (IQR)',      `${INR(Math.round(distStats.p25))} – ${INR(Math.round(distStats.p75))}`],
                    ['P10 – P25',            `${INR(Math.round(distStats.p10))} – ${INR(Math.round(distStats.p25))}`],
                    ['Bottom 10% (min–P10)', `${INR(Math.round(distStats.min))} – ${INR(Math.round(distStats.p10))}`],
                  ].map(([label, value]) => (
                    <tr key={label}>
                      <td className="py-2 text-xs text-gray-500 font-semibold pr-3">{label}</td>
                      <td className="py-2 text-xs font-black text-gray-900 text-right">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Settle Up tab */}
      {tab === 'settle' && settlement && (
        <div className="px-5 mt-2 md:grid md:grid-cols-2 md:gap-4 space-y-3 md:space-y-0">
          {/* Balances */}
          <div className="card">
            <h3 className="text-xs font-bold text-gray-500 mb-3">Individual balances</h3>
            <div className="space-y-3">
              {settlement.balances.map((b) => (
                <div key={b.member} className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-gray-100 flex items-center justify-center font-black text-gray-600 text-sm flex-shrink-0">
                    {b.member[0].toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold truncate">{b.member}</p>
                    <p className="text-xs text-gray-400">Paid {INR(b.paid)} · Share {INR(b.share)}</p>
                  </div>
                  <div className={`text-sm font-black flex-shrink-0 ${b.net >= 0 ? 'text-brand-600' : 'text-red-500'}`}>
                    {b.net >= 0 ? `+${INR(b.net)}` : `-${INR(Math.abs(b.net))}`}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Transactions */}
          <div className="card">
            <h3 className="text-xs font-bold text-gray-500 mb-3">Who pays whom?</h3>
            {settlement.transactions.length === 0 ? (
              <p className="text-sm text-brand-600 font-black text-center py-4">All settled</p>
            ) : (
              <div className="space-y-2">
                {settlement.transactions.map((t, i) => (
                  <div key={i} className="flex items-center gap-2 bg-red-50 border border-red-100 px-3 py-2.5">
                    <span className="font-bold text-sm text-red-700 flex-shrink-0">{t.from_member}</span>
                    <svg className="w-4 h-4 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                    </svg>
                    <span className="font-bold text-sm text-red-700 flex-1 min-w-0 truncate">{t.to_member}</span>
                    <span className="font-black text-brand-700 text-sm flex-shrink-0">{INR(t.amount)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Expense Edit Modal */}
      {editingExpense && (
        <ExpenseEditModal
          expense={editingExpense}
          group={group}
          onSave={() => { setEditingExp(null); reload() }}
          onClose={() => setEditingExp(null)}
        />
      )}
    </div>
  )
}
