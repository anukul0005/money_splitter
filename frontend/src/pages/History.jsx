import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Chart,
  LineElement, PointElement, LineController, Filler,
  BarElement, BarController,
  CategoryScale, LinearScale,
  Tooltip, Legend,
} from 'chart.js'
import { Line, Bar } from 'react-chartjs-2'
import { getGroups, getOverview, getGroupStats } from '../api/index.js'
import LoadingSpinner from '../components/LoadingSpinner'
import { useUser } from '../UserContext'

Chart.register(
  LineElement, PointElement, LineController, Filler,
  BarElement, BarController,
  CategoryScale, LinearScale,
  Tooltip, Legend,
)
Chart.defaults.font.family = "'Barlow Condensed', sans-serif"

const INR  = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const fmtMonth = (yyyymm) => {
  const [y, m] = yyyymm.split('-')
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(m, 10) - 1]
  return `${mon} '${y.slice(2)}`
}

const CAT_OPTIONS = ['trip','outing','festival','personal','other']
const CAT_COLORS  = {
  trip:      '#3b82f6',
  outing:    '#22c55e',
  festival:  '#f97316',
  personal:  '#8b5cf6',
  other:     '#94a3b8',
}
const PALETTE = ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6','#8b5cf6','#ec4899','#14b8a6','#f59e0b']

const CHART_FONT = { size: 11, family: "'Barlow Condensed', sans-serif" }

export default function History() {
  const nav  = useNavigate()
  const user = useUser()

  const [groups,      setGroups]      = useState([])
  const [overview,    setOverview]    = useState([])
  const [groupStats,  setGroupStats]  = useState([])   // [{group_id, total, by_date, by_category, by_member}]
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')

  // Bar-chart controls
  const [selectedYear, setSelectedYear] = useState('')
  const [topN,         setTopN]         = useState(10)

  // All users only see groups they are a member of (case-insensitive)
  const filterForUser = (list) =>
    list.filter((g) =>
      (g.member_names ?? []).some((n) => n.toLowerCase() === user?.name?.toLowerCase())
    )

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [gRes, oRes] = await Promise.all([getGroups(), getOverview()])
      const allGroups    = gRes.data
      const allOverview  = oRes.data
      setGroups(allGroups)
      setOverview(allOverview)

      const visible = filterForUser(allGroups)
      if (visible.length > 0) {
        const statsResults = await Promise.all(visible.map((g) => getGroupStats(g.id)))
        setGroupStats(statsResults.map((r) => r.data))
      }
    } catch {
      setError('Could not reach server. The API may be waking up — please try again in 30 seconds.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // ── Derived data ─────────────────────────────────────────────────────────────

  const visibleGroups = filterForUser(groups)
  const visibleIds    = new Set(visibleGroups.map((g) => g.id))
  const visibleOv     = overview.filter((g) => visibleIds.has(g.id))

  // Monthly aggregated totals across all visible groups
  const monthlyTotals = useMemo(() => {
    const map = {}
    groupStats.forEach((gs) => {
      if (!visibleIds.has(gs.group_id)) return
      gs.by_date.forEach(({ date, total }) => {
        map[date] = (map[date] || 0) + total
      })
    })
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
  }, [groupStats, visibleIds])

  // Available years for the bar-chart year filter
  const availableYears = useMemo(() => {
    const yrs = new Set(monthlyTotals.map(([d]) => d.slice(0, 4)))
    return [...yrs].sort((a, b) => b - a)
  }, [monthlyTotals])

  // Default to most recent year once data loads
  useEffect(() => {
    if (availableYears.length > 0 && !selectedYear) setSelectedYear(availableYears[0])
  }, [availableYears])

  // Per-group totals for the selected year (top-N bar chart)
  const topGroups = useMemo(() => {
    if (!selectedYear) return []
    return groupStats
      .filter((gs) => visibleIds.has(gs.group_id))
      .map((gs) => {
        const grp = visibleGroups.find((g) => g.id === gs.group_id)
        const yearTotal = gs.by_date
          .filter((d) => d.date.startsWith(selectedYear))
          .reduce((s, d) => s + d.total, 0)
        return { id: gs.group_id, name: grp?.name || '', yearTotal }
      })
      .filter((g) => g.yearTotal > 0)
      .sort((a, b) => b.yearTotal - a.yearTotal)
      .slice(0, topN)
  }, [groupStats, visibleGroups, visibleIds, selectedYear, topN])

  // Monthly-by-category (stacked area)
  const categoryMonthly = useMemo(() => {
    const map = {}   // category → { month → total }
    CAT_OPTIONS.forEach((c) => { map[c] = {} })

    groupStats.forEach((gs) => {
      if (!visibleIds.has(gs.group_id)) return
      const grp = visibleGroups.find((g) => g.id === gs.group_id)
      const cat = (grp?.category || 'other').toLowerCase()
      const bucket = CAT_OPTIONS.includes(cat) ? cat : 'other'
      gs.by_date.forEach(({ date, total }) => {
        map[bucket][date] = (map[bucket][date] || 0) + total
      })
    })
    return map
  }, [groupStats, visibleGroups, visibleIds])

  const allMonths = useMemo(
    () => monthlyTotals.map(([d]) => d),
    [monthlyTotals],
  )

  const activeCats = useMemo(
    () => CAT_OPTIONS.filter((c) => Object.keys(categoryMonthly[c] || {}).length > 0),
    [categoryMonthly],
  )

  // ── Overall KPIs ─────────────────────────────────────────────────────────────
  const totalSpend  = visibleOv.reduce((s, g) => s + g.total, 0)
  const avgMonthly  = monthlyTotals.length > 0
    ? totalSpend / monthlyTotals.length
    : 0

  // ── Chart configs ─────────────────────────────────────────────────────────────

  const lineData = {
    labels: monthlyTotals.map(([d]) => fmtMonth(d)),
    datasets: [{
      label: 'Total Spend',
      data: monthlyTotals.map(([, v]) => v),
      borderColor: '#22c55e',
      backgroundColor: 'rgba(34,197,94,0.08)',
      borderWidth: 2,
      pointRadius: 4,
      pointBackgroundColor: '#22c55e',
      tension: 0.35,
      fill: true,
    }],
  }

  const lineOptions = {
    responsive: true,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (c) => ` ${INR(c.parsed.y)}` } },
    },
    scales: {
      x: { ticks: { font: CHART_FONT }, grid: { display: false } },
      y: {
        ticks: { callback: (v) => `₹${(v / 1000).toFixed(0)}k`, font: CHART_FONT },
        grid: { color: '#f1f5f9' },
      },
    },
  }

  const barData = {
    labels: topGroups.map((g) => {
      const words = g.name.split(' ')
      const lines = []
      for (let i = 0; i < words.length; i += 2) lines.push(words.slice(i, i + 2).join(' '))
      return lines
    }),
    datasets: [{
      label: 'Total Spent',
      data: topGroups.map((g) => g.yearTotal),
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
        ticks: { font: { size: 9, family: "'Barlow Condensed', sans-serif" }, maxRotation: 0, autoSkip: false },
        grid: { display: false },
      },
      y: {
        ticks: { callback: (v) => `₹${(v / 1000).toFixed(0)}k`, font: CHART_FONT },
        grid: { color: '#f1f5f9' },
      },
    },
    onClick: (_, elements) => {
      if (elements.length > 0) nav(`/groups/${topGroups[elements[0].index]?.id}`)
    },
  }

  const areaData = {
    labels: allMonths.map(fmtMonth),
    datasets: activeCats.map((cat) => ({
      label: cat.charAt(0).toUpperCase() + cat.slice(1),
      data: allMonths.map((m) => categoryMonthly[cat][m] || 0),
      borderColor: CAT_COLORS[cat],
      backgroundColor: CAT_COLORS[cat] + '33',
      borderWidth: 2,
      pointRadius: 3,
      tension: 0.35,
      fill: true,
    })),
  }

  const areaOptions = {
    responsive: true,
    plugins: {
      legend: {
        display: true,
        position: 'bottom',
        labels: { font: CHART_FONT, boxWidth: 10, padding: 12 },
      },
      tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${INR(c.parsed.y)}` } },
    },
    scales: {
      x: { stacked: true, ticks: { font: CHART_FONT }, grid: { display: false } },
      y: {
        stacked: true,
        ticks: { callback: (v) => `₹${(v / 1000).toFixed(0)}k`, font: CHART_FONT },
        grid: { color: '#f1f5f9' },
      },
    },
  }

  // ─────────────────────────────────────────────────────────────────────────────

  if (loading) return <LoadingSpinner />

  if (error) return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-5 text-center">
      <p className="text-4xl mb-3">😴</p>
      <p className="text-sm text-gray-600 mb-4">{error}</p>
      <button onClick={load} className="bg-brand-400 text-gray-900 px-5 py-2 text-sm font-bold shadow-md">
        Retry
      </button>
    </div>
  )

  return (
    <div className="pb-24 md:pb-8">

      {/* Header */}
      <div className="bg-gradient-to-br from-field-800 to-field-950 text-white px-5 pt-10 md:pt-8 pb-6 border-b border-field-700">
        <p className="text-brand-400/70 text-xs font-bold uppercase tracking-widest">History & Stats</p>
        <h1 className="text-3xl font-black mt-1 tracking-tight">{INR(totalSpend)}</h1>
        <div className="flex gap-4 mt-2">
          <div>
            <p className="text-green-200/40 text-[10px] font-bold uppercase tracking-widest">Groups</p>
            <p className="text-white font-black text-sm">{visibleGroups.length}</p>
          </div>
          <div>
            <p className="text-green-200/40 text-[10px] font-bold uppercase tracking-widest">Avg / Month</p>
            <p className="text-white font-black text-sm">{INR(Math.round(avgMonthly))}</p>
          </div>
          <div>
            <p className="text-green-200/40 text-[10px] font-bold uppercase tracking-widest">Months Active</p>
            <p className="text-white font-black text-sm">{monthlyTotals.length}</p>
          </div>
        </div>
      </div>

      <div className="px-5 mt-5 space-y-5">

        {/* ── 1. Monthly Trend (Line Chart) ── */}
        {monthlyTotals.length > 0 && (
          <div className="card">
            <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest mb-3">Monthly Spend</h2>
            <Line data={lineData} options={lineOptions} />
          </div>
        )}

        {/* ── 2. Top Trips (Bar Chart + Year Filter) ── */}
        {groupStats.length > 0 && (
          <div className="card">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest">Top Groups</h2>
              <div className="flex items-center gap-2 flex-wrap">
                {/* Year filter */}
                <div className="flex gap-1">
                  {availableYears.map((y) => (
                    <button
                      key={y}
                      onClick={() => setSelectedYear(y)}
                      className={`px-2 py-1 text-[10px] font-bold border transition-colors ${
                        selectedYear === y
                          ? 'bg-brand-400 text-gray-900 border-brand-400'
                          : 'bg-cream text-gray-400 border-amber-200 hover:text-gray-700'
                      }`}
                    >
                      {y}
                    </button>
                  ))}
                </div>
                {/* Top-N toggle */}
                <div className="flex gap-1">
                  {[5, 10].map((n) => (
                    <button
                      key={n}
                      onClick={() => setTopN(n)}
                      className={`px-2 py-1 text-[10px] font-bold border transition-colors ${
                        topN === n
                          ? 'bg-gray-800 text-white border-gray-800'
                          : 'bg-cream text-gray-400 border-amber-200 hover:text-gray-700'
                      }`}
                    >
                      Top {n}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {topGroups.length > 0
              ? <Bar data={barData} options={barOptions} />
              : <p className="text-xs text-gray-400 text-center py-4">No expenses in {selectedYear}</p>
            }
          </div>
        )}

        {/* ── 3. Stacked Area by Category ── */}
        {activeCats.length > 1 && (
          <div className="card">
            <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest mb-3">Spend by Category</h2>
            <Line data={areaData} options={areaOptions} />
          </div>
        )}

        {/* ── 4. All Groups Table ── */}
        <div>
          <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest mb-3">All Groups</h2>
          <div className="space-y-2">
            {[...visibleGroups]
              .sort((a, b) => b.total_amount - a.total_amount)
              .map((g) => (
                <div
                  key={g.id}
                  className="card flex items-center gap-3 cursor-pointer active:scale-[0.98] transition-transform"
                  onClick={() => nav(`/groups/${g.id}`)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="font-bold text-sm leading-snug">{g.name}</p>
                      {g.category && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 bg-brand-400/15 text-brand-700 capitalize">
                          {g.category}
                        </span>
                      )}
                      {g.is_historical && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 bg-amber-100 text-amber-700">
                          Historical
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {g.expense_count} expenses · {g.member_count} people
                    </p>
                  </div>
                  <span className="font-black text-brand-600 text-sm whitespace-nowrap">{INR(g.total_amount)}</span>
                </div>
              ))}
            {visibleGroups.length === 0 && (
              <div className="text-center py-8 text-gray-400">
                <p className="text-sm">No groups yet</p>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  )
}
