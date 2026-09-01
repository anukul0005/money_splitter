import { useState } from 'react'
import {
  Chart, BarElement, CategoryScale, LinearScale, Tooltip, Legend,
  ArcElement, DoughnutController, BarController,
  LineElement, PointElement, LineController, Filler,
} from 'chart.js'
import { Bar, Doughnut, Line } from 'react-chartjs-2'

Chart.register(BarElement, CategoryScale, LinearScale, Tooltip, Legend, ArcElement, DoughnutController, BarController, LineElement, PointElement, LineController, Filler)
Chart.defaults.font.family = "'Space Grotesk', system-ui, sans-serif"

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const PALETTE = ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6','#8b5cf6','#ec4899']

// Inline plugin: draws % labels on doughnut slices (registered after definition)
const donutPctPlugin = {
  id: 'donutPct',
  afterDatasetsDraw(chart) {
    if (chart.config.type !== 'doughnut') return
    const { ctx } = chart
    chart.data.datasets.forEach((dataset, di) => {
      const meta = chart.getDatasetMeta(di)
      if (meta.hidden) return
      const total = dataset.data.reduce((s, v) => s + v, 0)
      if (total === 0) return
      meta.data.forEach((el, idx) => {
        const pct = Math.round((dataset.data[idx] / total) * 100)
        if (pct < 5) return
        const pos = el.tooltipPosition()
        ctx.save()
        ctx.fillStyle = '#fff'
        ctx.font = "bold 11px 'Space Grotesk', system-ui, sans-serif"
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(`${pct}%`, pos.x, pos.y)
        ctx.restore()
      })
    })
  },
}
Chart.register(donutPctPlugin)

/**
 * The charts that used to live in a group's "Charts" tab.
 *
 * Nothing about the visuals changed — it just takes its numbers as props so
 * the same panel can render one group or a whole master group's worth of
 * groups combined.
 *
 *   stats    — { total, by_member: [{member,total_paid}], by_category: [{category,total}] }
 *   expenses — [{ date, amount }] across whatever scope is being shown
 *   isSolo   — single-person scope: leads with the daily line instead of by-person
 */
export default function StatsPanel({ stats, expenses = [], isSolo = false }) {
  const [chartView, setChartView] = useState('member')
  const [hoveredDayIdx, setHoveredDayIdx] = useState(null)

  if (!stats) return null

  // Horizontal bar chart (member names on y-axis)
  const memberChartData = {
    labels: stats.by_member?.map((x) => x.member.toUpperCase()) || [],
    datasets: [{
      label: 'Paid',
      data: stats.by_member?.map((x) => x.total_paid) || [],
      backgroundColor: PALETTE,
      borderRadius: 0,
      borderSkipped: false,
    }],
  }

  const rawCats = stats.by_category || []
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
      x: { ticks: { callback: (v) => `₹${(v/1000).toFixed(0)}k`, font: { size: 11, family: "'Space Grotesk'" } }, grid: { color: '#f1f5f9' } },
      y: { ticks: { font: { size: 12, family: "'Space Grotesk'" } }, grid: { display: false } },
    },
  }

  const donutOptions = {
    cutout: '60%',
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (c) => ` ${INR(c.parsed)}` } },
      donutPct: {},
    },
  }

  // Distribution stats
  const expAmounts = expenses.map((e) => e.amount).sort((a, b) => a - b)
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

  // Daily spend line chart
  const dailyMap = {}
  expenses.forEach((e) => {
    if (e.date) dailyMap[e.date] = (dailyMap[e.date] || 0) + e.amount
  })
  const dailyEntries = Object.entries(dailyMap).sort(([a], [b]) => a.localeCompare(b))
  const dailyLabels  = dailyEntries.map(([d]) => d)
  const dailyValues  = dailyEntries.map(([, v]) => v)

  const isWeekend = (dateStr) => {
    if (!dateStr) return false
    const d = new Date(dateStr + 'T00:00:00')
    return d.getDay() === 0 || d.getDay() === 6
  }
  const fmtDayLabel = (dateStr) => {
    const [, m, d] = dateStr.split('-')
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(m) - 1]
    return `${mon} ${parseInt(d)}`
  }

  const calcMeanWO = (values) => {
    if (values.length < 3) return values.reduce((s, v) => s + v, 0) / Math.max(values.length, 1)
    const sorted = [...values].sort((a, b) => a - b)
    const n  = sorted.length
    const q1 = sorted[Math.floor(n * 0.25)]
    const q3 = sorted[Math.floor(n * 0.75)]
    const iqr = q3 - q1
    const filtered = sorted.filter((v) => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr)
    return filtered.length > 0 ? filtered.reduce((s, v) => s + v, 0) / filtered.length : 0
  }
  const dailyMeanWO = calcMeanWO(dailyValues)

  const dailyPointColors = dailyLabels.map((d) => isWeekend(d) ? '#f97316' : '#22c55e')
  const dailyPointSizes  = dailyLabels.map((d) => isWeekend(d) ? 7 : 5)

  const dailyLineData = {
    labels: dailyLabels.map(fmtDayLabel),
    datasets: [{
      label: 'Daily Spend',
      data: dailyValues,
      borderColor: '#22c55e',
      backgroundColor: (context) => {
        const chart = context.chart
        const { ctx, chartArea } = chart
        if (!chartArea) return 'rgba(34,197,94,0.15)'
        const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
        gradient.addColorStop(0, 'rgba(34,197,94,0.30)')
        gradient.addColorStop(1, 'rgba(34,197,94,0.00)')
        return gradient
      },
      borderWidth: 2.5,
      pointRadius: dailyPointSizes,
      pointHoverRadius: dailyPointSizes.map((r) => r + 3),
      pointBackgroundColor: dailyPointColors,
      pointBorderColor: dailyPointColors,
      tension: 0.3,
      fill: true,
    }],
  }

  const dailyLineOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        displayColors: false,
        callbacks: {
          title: (items) => {
            const i = items[0].dataIndex
            return fmtDayLabel(dailyLabels[i]) + (isWeekend(dailyLabels[i]) ? ' · Weekend' : '')
          },
          label: () => '',
        },
      },
    },
    onHover: (evt, elements) => {
      if (evt.native) evt.native.target.style.cursor = elements.length ? 'crosshair' : 'default'
      setHoveredDayIdx(elements.length > 0 ? elements[0].index : null)
    },
    scales: {
      x: {
        ticks: {
          font: { size: 11, family: "'Space Grotesk'" },
          maxRotation: 0,
          callback: (val, i) => {
            const raw = dailyLabels[i]
            if (!raw) return null
            const day = parseInt(raw.split('-')[2])
            return (day === 1 || (day - 1) % 5 === 0) ? fmtDayLabel(raw) : null
          },
        },
        grid: { display: false },
      },
      y: { display: false },
    },
  }

  const DailyCard = ({ title }) => (
    <div className="card">
      {(() => {
        const ai = hoveredDayIdx !== null ? hoveredDayIdx : dailyLabels.length - 1
        const av = dailyValues[ai] ?? 0
        return (
          <div className="flex items-stretch mb-4 pb-4 border-b border-amber-100">
            <div className="flex-1 pr-4">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{title}</p>
              <p className="text-2xl font-black text-gray-900 mt-1 tracking-tight">{INR(av)}</p>
              <p className="text-[11px] text-gray-300 mt-0.5">
                {hoveredDayIdx === null ? 'slide chart to explore' : fmtDayLabel(dailyLabels[ai])}
              </p>
            </div>
            <div className="w-px bg-amber-100" />
            <div className="flex-1 pl-4">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Mean (WO)</p>
              <p className="text-2xl font-black text-brand-600 mt-1 tracking-tight">{INR(Math.round(dailyMeanWO))}</p>
              <p className="text-[11px] text-gray-300 mt-0.5">avg excl. outliers</p>
            </div>
          </div>
        )
      })()}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-bold text-gray-500">{isSolo ? 'Daily Spend' : 'Spend by Day'}</h3>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[10px] text-gray-400">
            <span className="w-2 h-2 rounded-full bg-green-500 inline-block" /> Weekday
          </span>
          <span className="flex items-center gap-1.5 text-[10px] text-gray-400">
            <span className="w-2 h-2 rounded-full bg-orange-500 inline-block" /> Weekend
          </span>
        </div>
      </div>
      <div className="relative h-56 md:h-72">
        <Line data={dailyLineData} options={dailyLineOptions} />
      </div>
    </div>
  )

  const CategoryCard = () => (
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
  )

  return (
    <div className="px-5 space-y-4 mt-2">
      {isSolo ? (
        <>
          {dailyEntries.length > 0 ? (
            <DailyCard title="Daily Spend" />
          ) : (
            <p className="text-xs text-gray-400 text-center py-6">No dated expenses yet</p>
          )}
          {catData.length > 0 && <CategoryCard />}
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
                    ? 'bg-brand-400 text-white border-brand-400'
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

          {chartView === 'category' && catData.length > 0 && <CategoryCard />}

          {dailyEntries.length > 0 && <DailyCard title="Spend" />}
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
  )
}
