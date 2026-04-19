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

const INR      = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const fmtMonth = (yyyymm) => {
  const [y, m] = yyyymm.split('-')
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(m, 10) - 1]
  return `${mon} '${y.slice(2)}`
}
const advanceMonth = (yyyymm, n) => {
  const [y, m] = yyyymm.split('-').map(Number)
  const d = new Date(y, m - 1 + n, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const CAT_OPTIONS = ['trip','outing','festival','personal','other']
const CAT_COLORS  = {
  trip:     '#3b82f6',
  outing:   '#22c55e',
  festival: '#f97316',
  personal: '#8b5cf6',
  other:    '#94a3b8',
}
const PALETTE    = ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6','#8b5cf6','#ec4899','#14b8a6','#f59e0b']
const CHART_FONT = { size: 11, family: "'Barlow Condensed', sans-serif" }

export default function History() {
  const nav  = useNavigate()
  const user = useUser()

  const [groups,     setGroups]     = useState([])
  const [overview,   setOverview]   = useState([])
  const [groupStats, setGroupStats] = useState([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState('')

  const [selectedYear,      setSelectedYear]      = useState('')
  const [topN,              setTopN]              = useState(10)
  const [timeFilter,        setTimeFilter]        = useState('all')
  const [selectedDrillMonth, setSelectedDrillMonth] = useState(null)

  const filterForUser = (list) =>
    list.filter((g) =>
      (g.member_names ?? []).some((n) => n.toLowerCase() === user?.name?.toLowerCase())
    )

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [gRes, oRes] = await Promise.all([getGroups(), getOverview()])
      const allGroups   = gRes.data
      const allOverview = oRes.data
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

  // ── Derived data ──────────────────────────────────────────────────────────────

  const visibleGroups = filterForUser(groups)
  const visibleIds    = new Set(visibleGroups.map((g) => g.id))
  const visibleOv     = overview.filter((g) => visibleIds.has(g.id))

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

  const filteredMonthly = useMemo(() => {
    if (timeFilter === 'all') return monthlyTotals
    return monthlyTotals.slice(-parseInt(timeFilter))
  }, [monthlyTotals, timeFilter])

  const availableYears = useMemo(() => {
    const yrs = new Set(monthlyTotals.map(([d]) => d.slice(0, 4)))
    return [...yrs].sort((a, b) => b - a)
  }, [monthlyTotals])

  useEffect(() => {
    if (availableYears.length > 0 && !selectedYear) setSelectedYear(availableYears[0])
  }, [availableYears])

  // Clear drill selection when filter changes
  useEffect(() => { setSelectedDrillMonth(null) }, [timeFilter])

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

  const categoryMonthly = useMemo(() => {
    const map = {}
    CAT_OPTIONS.forEach((c) => { map[c] = {} })
    groupStats.forEach((gs) => {
      if (!visibleIds.has(gs.group_id)) return
      const grp    = visibleGroups.find((g) => g.id === gs.group_id)
      const cat    = (grp?.category || 'other').toLowerCase()
      const bucket = CAT_OPTIONS.includes(cat) ? cat : 'other'
      gs.by_date.forEach(({ date, total }) => {
        map[bucket][date] = (map[bucket][date] || 0) + total
      })
    })
    return map
  }, [groupStats, visibleGroups, visibleIds])

  const allMonths  = useMemo(() => monthlyTotals.map(([d]) => d), [monthlyTotals])
  const activeCats = useMemo(
    () => CAT_OPTIONS.filter((c) => Object.keys(categoryMonthly[c] || {}).length > 0),
    [categoryMonthly],
  )

  // Groups that contributed to each month (for drill-down)
  const monthlyByGroup = useMemo(() => {
    const map = {}
    groupStats.forEach((gs) => {
      if (!visibleIds.has(gs.group_id)) return
      const grp = visibleGroups.find((g) => g.id === gs.group_id)
      gs.by_date.forEach(({ date, total }) => {
        if (!map[date]) map[date] = []
        map[date].push({ id: gs.group_id, name: grp?.name || '', total })
      })
    })
    Object.values(map).forEach((arr) => arr.sort((a, b) => b.total - a.total))
    return map
  }, [groupStats, visibleGroups, visibleIds])

  // ── Analytics ─────────────────────────────────────────────────────────────────

  const totalSpend  = visibleOv.reduce((s, g) => s + g.total, 0)
  const avgMonthly  = monthlyTotals.length > 0 ? totalSpend / monthlyTotals.length : 0

  const monthlyValues = filteredMonthly.map(([, v]) => v)
  const N             = filteredMonthly.length
  const monthlyMax    = N > 0 ? Math.max(...monthlyValues) : 0
  const monthlyMin    = N > 0 ? Math.min(...monthlyValues) : 0
  const maxMonthIdx   = monthlyValues.indexOf(monthlyMax)
  const minMonthIdx   = monthlyValues.indexOf(monthlyMin)
  const maxMonthLbl   = filteredMonthly[maxMonthIdx] ? fmtMonth(filteredMonthly[maxMonthIdx][0]) : ''
  const minMonthLbl   = filteredMonthly[minMonthIdx] ? fmtMonth(filteredMonthly[minMonthIdx][0]) : ''

  const movingAvg = useMemo(() =>
    filteredMonthly.map((_, i) => {
      const w = filteredMonthly.slice(Math.max(0, i - 2), i + 1)
      return w.reduce((s, [, x]) => s + x, 0) / w.length
    }),
    [filteredMonthly],
  )

  const { anomalyMonths, anomalySpike } = useMemo(() => {
    if (N < 3) return { anomalyMonths: [], anomalySpike: null }
    const mean      = monthlyValues.reduce((s, v) => s + v, 0) / N
    const stddev    = Math.sqrt(monthlyValues.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / N)
    const threshold = mean + 1.5 * stddev
    const flagged   = filteredMonthly.filter(([, v]) => v > threshold)
    if (flagged.length === 0) return { anomalyMonths: [], anomalySpike: null }
    const spike = flagged.reduce((a, b) => a[1] > b[1] ? a : b)
    return {
      anomalyMonths: flagged.map(([d]) => d),
      anomalySpike: { label: fmtMonth(spike[0]), pct: Math.round(((spike[1] - mean) / mean) * 100) },
    }
  }, [filteredMonthly])

  const forecastData = useMemo(() => {
    if (N < 2) return []
    const lastN     = filteredMonthly.slice(-Math.min(3, N)).map(([, v]) => v)
    const avg       = lastN.reduce((s, v) => s + v, 0) / lastN.length
    const lastMonth = filteredMonthly[N - 1][0]
    return Array.from({ length: 3 }, (_, i) => [advanceMonth(lastMonth, i + 1), avg])
  }, [filteredMonthly])

  const histDistStats = useMemo(() => {
    const vals = monthlyTotals.map(([, v]) => v).sort((a, b) => a - b)
    const n    = vals.length
    if (n < 2) return null
    const mean   = vals.reduce((s, v) => s + v, 0) / n
    const median = n % 2 === 0
      ? (vals[n / 2 - 1] + vals[n / 2]) / 2
      : vals[Math.floor(n / 2)]
    const freq = {}
    vals.forEach((v) => { freq[v] = (freq[v] || 0) + 1 })
    let mode = vals[0], maxF = 0
    Object.entries(freq).forEach(([v, f]) => { if (f > maxF) { maxF = f; mode = parseFloat(v) } })
    const pct = (p) => {
      const idx = (p / 100) * (n - 1)
      const lo = Math.floor(idx), hi = Math.ceil(idx)
      return lo === hi ? vals[lo] : vals[lo] + (vals[hi] - vals[lo]) * (idx - lo)
    }
    return { mean, median, mode, p10: pct(10), p25: pct(25), p75: pct(75), p90: pct(90), min: vals[0], max: vals[n - 1] }
  }, [monthlyTotals])

  const topCategory = useMemo(() => {
    const catTotals = {}
    groupStats.forEach((gs) => {
      if (!visibleIds.has(gs.group_id)) return
      gs.by_category?.forEach(({ category, total }) => {
        const k = (category || 'Other').trim()
        catTotals[k] = (catTotals[k] || 0) + total
      })
    })
    const entries = Object.entries(catTotals)
    if (entries.length === 0) return null
    return entries.sort((a, b) => b[1] - a[1])[0][0]
  }, [groupStats, visibleIds])

  // ── Chart configs ──────────────────────────────────────────────────────────────

  const combinedLabels  = [...filteredMonthly.map(([d]) => fmtMonth(d)), ...forecastData.map(([d]) => fmtMonth(d))]
  const actualPadded    = [...monthlyValues, ...forecastData.map(() => null)]
  const movingAvgPadded = [...movingAvg,     ...forecastData.map(() => null)]
  const forecastPadded  = [
    ...filteredMonthly.map((_, i) => (i === N - 1 ? monthlyValues[i] : null)),
    ...forecastData.map(([, v]) => v),
  ]

  const pointColors = combinedLabels.map((_, i) => {
    if (i >= N) return '#22c55e'
    if (i === maxMonthIdx) return '#22c55e'
    if (i === minMonthIdx) return '#ef4444'
    if (anomalyMonths.includes(filteredMonthly[i]?.[0])) return '#f97316'
    return '#22c55e'
  })
  const pointRadii = combinedLabels.map((_, i) => {
    if (i >= N) return 0
    if (i === maxMonthIdx) return 7
    if (i === minMonthIdx) return 5
    if (anomalyMonths.includes(filteredMonthly[i]?.[0])) return 6
    return 4
  })

  const lineData = {
    labels: combinedLabels,
    datasets: [
      {
        label: 'Actual',
        data: actualPadded,
        borderColor: '#22c55e',
        backgroundColor: (context) => {
          const chart = context.chart
          const { ctx, chartArea } = chart
          if (!chartArea) return 'rgba(34,197,94,0.15)'
          const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
          gradient.addColorStop(0, 'rgba(34,197,94,0.28)')
          gradient.addColorStop(1, 'rgba(34,197,94,0.00)')
          return gradient
        },
        borderWidth: 2.5,
        pointRadius: pointRadii,
        pointHoverRadius: pointRadii.map((r) => r + 3),
        pointBackgroundColor: pointColors,
        tension: 0.3,
        fill: true,
        spanGaps: false,
      },
      {
        label: '3M Avg',
        data: movingAvgPadded,
        borderColor: '#94a3b8',
        borderWidth: 1.5,
        borderDash: [4, 4],
        pointRadius: 0,
        tension: 0,
        fill: false,
        spanGaps: false,
      },
      ...(forecastData.length > 0 ? [{
        label: 'Forecast',
        data: forecastPadded,
        borderColor: '#3b82f6',
        borderWidth: 2,
        borderDash: [6, 4],
        pointRadius: forecastPadded.map((v) => v !== null ? 4 : 0),
        pointBackgroundColor: '#3b82f6',
        tension: 0,
        fill: false,
        spanGaps: false,
      }] : []),
    ],
  }

  const lineOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        display: true,
        position: 'bottom',
        labels: { font: CHART_FONT, boxWidth: 8, padding: 12 },
      },
      tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${INR(c.parsed.y)}` } },
    },
    scales: {
      x: {
        ticks: { font: CHART_FONT, maxTicksLimit: 6, maxRotation: 0 },
        grid: { display: false },
      },
      y: { display: false },
    },
    onClick: (_, elements) => {
      if (elements.length > 0) {
        const idx = elements[0].index
        if (idx < N) {
          const month = filteredMonthly[idx][0]
          setSelectedDrillMonth((prev) => prev === month ? null : month)
        }
      }
    },
    onHover: (evt, chartElement) => {
      if (evt.native) evt.native.target.style.cursor = chartElement[0] ? 'pointer' : 'default'
    },
  }

  const yearTotal = topGroups.reduce((s, g) => s + g.yearTotal, 0)
  const barHeight = Math.max(200, topGroups.length * 44)

  const barData = {
    labels: topGroups.map((g) => g.name),
    datasets: [{
      label: 'Total Spent',
      data: topGroups.map((g) => g.yearTotal),
      backgroundColor: PALETTE,
      borderRadius: 2,
      borderSkipped: false,
    }],
  }

  const barOptions = {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (c) => {
            const pct = yearTotal > 0 ? ` (${Math.round((c.parsed.x / yearTotal) * 100)}%)` : ''
            return ` ${INR(c.parsed.x)}${pct}`
          },
        },
      },
    },
    scales: {
      x: {
        ticks: { callback: (v) => `₹${(v / 1000).toFixed(0)}k`, font: CHART_FONT, maxTicksLimit: 4 },
        grid: { color: '#f1f5f9' },
      },
      y: {
        ticks: { font: { size: 10, family: "'Barlow Condensed', sans-serif" }, autoSkip: false },
        grid: { display: false },
      },
    },
    onClick: (_, elements) => {
      if (elements.length > 0) nav(`/groups/${topGroups[elements[0].index]?.id}`)
    },
    onHover: (evt, chartElement) => {
      if (evt.native) evt.native.target.style.cursor = chartElement[0] ? 'pointer' : 'default'
    },
  }

  const areaData = {
    labels: allMonths.map(fmtMonth),
    datasets: activeCats.map((cat) => ({
      label: cat.charAt(0).toUpperCase() + cat.slice(1),
      data: allMonths.map((m) => categoryMonthly[cat][m] || 0),
      borderColor: CAT_COLORS[cat],
      backgroundColor: CAT_COLORS[cat] + '33',
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0,
      fill: true,
    })),
  }

  const areaOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        display: true,
        position: 'bottom',
        labels: { font: { size: 10, family: "'Barlow Condensed', sans-serif" }, boxWidth: 8, padding: 10 },
      },
      tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${INR(c.parsed.y)}` } },
    },
    scales: {
      x: {
        stacked: true,
        ticks: { font: CHART_FONT, maxTicksLimit: 5, maxRotation: 0 },
        grid: { display: false },
      },
      y: { display: false, stacked: true },
    },
  }

  // ──────────────────────────────────────────────────────────────────────────────

  if (loading) return <LoadingSpinner />

  if (error) return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-5 text-center">
      <p className="text-4xl mb-3">😴</p>
      <p className="text-sm text-gray-600 mb-4">{error}</p>
      <button onClick={load} className="bg-brand-400 text-gray-900 px-5 py-2 text-sm font-bold shadow-md">Retry</button>
    </div>
  )

  return (
    <div className="pb-24 md:pb-8">

      {/* Header */}
      <div className="bg-gradient-to-br from-field-800 to-field-950 text-white px-5 pt-10 md:pt-8 pb-6 border-b border-field-700">
        <p className="text-brand-400/70 text-xs font-bold uppercase tracking-widest">History & Stats</p>
        <h1 className="text-3xl font-black mt-1 tracking-tight">{INR(totalSpend)}</h1>
        <div className="flex gap-4 mt-2 flex-wrap">
          <div>
            <p className="text-green-200/40 text-[10px] font-bold uppercase tracking-widest">Groups</p>
            <p className="text-white font-black text-sm">{visibleGroups.length}</p>
          </div>
          <div>
            <p className="text-green-200/40 text-[10px] font-bold uppercase tracking-widest">Avg / Month</p>
            <p className="text-white font-black text-sm">{INR(Math.round(avgMonthly))}</p>
          </div>
          <div>
            <p className="text-green-200/40 text-[10px] font-bold uppercase tracking-widest">Peak Month</p>
            <p className="text-white font-black text-sm">{maxMonthLbl || '—'}</p>
          </div>
          {topCategory && (
            <div>
              <p className="text-green-200/40 text-[10px] font-bold uppercase tracking-widest">Top Category</p>
              <p className="text-white font-black text-sm">{topCategory}</p>
            </div>
          )}
        </div>
      </div>

      <div className="px-5 mt-5 space-y-5">

        {/* ── 1. Monthly Trend ── */}
        {filteredMonthly.length > 0 && (
          <div className="card">
            <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
              <div>
                <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest">Monthly Spend</h2>
                <div className="mt-1 space-y-0.5">
                  <p className="text-[11px] text-gray-500">
                    <span className="text-green-600 font-bold">Highest</span>{' '}
                    {INR(monthlyMax)} in {maxMonthLbl}
                    {' · '}
                    <span className="text-red-500 font-bold">Lowest</span>{' '}
                    {INR(monthlyMin)} in {minMonthLbl}
                  </p>
                  <p className="text-[11px] text-gray-500">
                    Avg {INR(Math.round(monthlyValues.reduce((s, v) => s + v, 0) / (monthlyValues.length || 1)))} /month
                    {forecastData.length > 0 && (
                      <> · <span className="text-blue-500 font-bold">Forecast</span>{' '}
                      ~{INR(Math.round(forecastData[0][1]))} next 3M</>
                    )}
                  </p>
                  {anomalySpike && (
                    <p className="text-[11px] text-orange-500 font-bold">
                      ⚠️ Spike in {anomalySpike.label} (+{anomalySpike.pct}% above avg)
                    </p>
                  )}
                </div>
              </div>
              {/* Time filter */}
              <div className="flex gap-1 flex-wrap">
                {[['3', '3M'], ['6', '6M'], ['12', '1Y'], ['all', 'All']].map(([v, lbl]) => (
                  <button
                    key={v}
                    onClick={() => setTimeFilter(v)}
                    className={`px-2 py-1 text-[10px] font-bold border transition-colors ${
                      timeFilter === v
                        ? 'bg-brand-400 text-gray-900 border-brand-400'
                        : 'bg-cream text-gray-400 border-amber-200 hover:text-gray-700'
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            {/* Chart — fixed height so it fills properly */}
            <div className="relative h-80">
              <Line data={lineData} options={lineOptions} />
            </div>

            {/* Drill-down panel — tap a month to expand */}
            {selectedDrillMonth && monthlyByGroup[selectedDrillMonth] && (
              <div className="mt-4 pt-3 border-t border-amber-100">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">
                    {fmtMonth(selectedDrillMonth)} — breakdown
                  </p>
                  <button
                    onClick={() => setSelectedDrillMonth(null)}
                    className="text-gray-300 hover:text-gray-500 text-sm leading-none"
                  >
                    ✕
                  </button>
                </div>
                {monthlyByGroup[selectedDrillMonth].map(({ id, name, total }) => (
                  <div
                    key={id}
                    className="flex items-center justify-between py-2 cursor-pointer hover:bg-amber-50 -mx-2 px-2 transition-colors"
                    onClick={() => nav(`/groups/${id}`)}
                  >
                    <span className="text-xs font-bold text-gray-700">{name}</span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-black text-gray-900">{INR(total)}</span>
                      <span className="text-gray-300 text-xs">›</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!selectedDrillMonth && filteredMonthly.length > 0 && (
              <p className="text-[10px] text-gray-300 mt-2 text-center">tap a month to see breakdown</p>
            )}
          </div>
        )}

        {/* ── 2. Top Groups (Horizontal Bar) ── */}
        {groupStats.length > 0 && (
          <div className="card">
            <div className="flex items-start justify-between mb-3 flex-wrap gap-2">
              <div>
                <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest">Top Groups</h2>
                {topGroups.length > 0 && yearTotal > 0 && (
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    {topGroups[0].name} = {Math.round((topGroups[0].yearTotal / yearTotal) * 100)}% of {selectedYear} spend
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
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
            {topGroups.length > 0 ? (
              <div className="relative" style={{ height: `${barHeight}px` }}>
                <Bar data={barData} options={barOptions} />
              </div>
            ) : (
              <p className="text-xs text-gray-400 text-center py-4">No expenses in {selectedYear}</p>
            )}
          </div>
        )}

        {/* ── 3. Stacked Area by Category ── */}
        {activeCats.length > 1 && (
          <div className="card">
            <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest mb-3">Spend by Category</h2>
            <div className="relative h-72">
              <Line data={areaData} options={areaOptions} />
            </div>
          </div>
        )}

        {/* ── 4. Monthly Spend Distribution ── */}
        {histDistStats && (
          <div className="card">
            <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest mb-3">
              Monthly Spend Distribution ({monthlyTotals.length} months)
            </h2>
            <table className="w-full">
              <tbody className="divide-y divide-amber-100">
                {[
                  ['Mean',                 INR(Math.round(histDistStats.mean))],
                  ['Median',               INR(Math.round(histDistStats.median))],
                  ['Mode',                 INR(Math.round(histDistStats.mode))],
                  ['Top 10% (P90–max)',    `${INR(Math.round(histDistStats.p90))} – ${INR(Math.round(histDistStats.max))}`],
                  ['P75 – P90',            `${INR(Math.round(histDistStats.p75))} – ${INR(Math.round(histDistStats.p90))}`],
                  ['P25 – P75 (IQR)',      `${INR(Math.round(histDistStats.p25))} – ${INR(Math.round(histDistStats.p75))}`],
                  ['P10 – P25',            `${INR(Math.round(histDistStats.p10))} – ${INR(Math.round(histDistStats.p25))}`],
                  ['Bottom 10% (min–P10)', `${INR(Math.round(histDistStats.min))} – ${INR(Math.round(histDistStats.p10))}`],
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
    </div>
  )
}
