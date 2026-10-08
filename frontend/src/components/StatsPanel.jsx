import { useState } from 'react'
import {
  Chart, BarElement, CategoryScale, LinearScale, Tooltip, Legend,
  ArcElement, DoughnutController, BarController,
  LineElement, PointElement, LineController, Filler,
} from 'chart.js'
import { Bar, Doughnut } from 'react-chartjs-2'

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
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
// A daily view only reads as days up to about three months; past that the
// bars are thinner than a pixel and only the spikes show.
const MAX_DAILY_SPAN = 90
const RECENT_MONTHS = 12

// Date arithmetic on "YYYY-MM-DD" strings, in UTC so no timezone can shift a day.
const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000)
const nextMonth = (key) => {
  const [y, m] = key.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}
// ₹2.5L / ₹40k / ₹600 - axis labels that stay short at any scale.
const compactINR = (v) =>
  v >= 100000 ? `₹${(v / 100000).toFixed(v % 100000 ? 1 : 0)}L`
    : v >= 1000 ? `₹${Math.round(v / 1000)}k`
    : `₹${Math.round(v)}`
const shade = (hex, alpha) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`
}

export default function StatsPanel({ stats, expenses = [], isSolo = false }) {
  const [chartView, setChartView] = useState('member')
  const [hoveredDayIdx, setHoveredDayIdx] = useState(null)
  const [dayRange, setDayRange] = useState(30)
  // 'recent' (last 12 months), 'years', or a year ("2024") drilled into from 'years'.
  const [monthView, setMonthView] = useState('recent')

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

  // ── Daily spend ────────────────────────────────────────────────────────
  const dailyMap = {}
  expenses.forEach((e) => {
    const d = (e.date || '').slice(0, 10)
    if (d.length === 10) dailyMap[d] = (dailyMap[d] || 0) + e.amount
  })
  const dailyEntries = Object.entries(dailyMap).sort(([a], [b]) => a.localeCompare(b))
  const firstDay = dailyEntries[0]?.[0]
  const lastDay  = dailyEntries[dailyEntries.length - 1]?.[0]
  const spanDays = firstDay ? daysBetween(firstDay, lastDay) + 1 : 0
  // Years of history: a recent window, picked with chips. A trip: all of it.
  const longSpan   = spanDays > MAX_DAILY_SPAN
  const windowDays = longSpan ? dayRange : spanDays
  // Every day in the window, ₹0 ones included - a day without spending is
  // information, and leaving it out made busy weeks look evenly spread.
  const dayKeys = lastDay ? Array.from({ length: windowDays }, (_, i) => addDays(lastDay, i - windowDays + 1)) : []
  const dayVals = dayKeys.map((k) => dailyMap[k] || 0)
  const windowTotal = dayVals.reduce((s, v) => s + v, 0)
  const activeDays  = dayVals.filter((v) => v > 0).length

  const isWeekend = (dateStr) => {
    const d = new Date(dateStr + 'T00:00:00Z').getUTCDay()
    return d === 0 || d === 6
  }
  const fmtDayLabel = (dateStr) => {
    const [, m, d] = dateStr.split('-')
    return `${MONTH_ABBR[parseInt(m) - 1]} ${parseInt(d)}`
  }
  const dayColors = dayKeys.map((k) => (isWeekend(k) ? '#f97316' : '#22c55e'))

  // A bar for every day of the window - ₹0 days as gaps - on an axis that
  // runs to the biggest day in it, so no amount is cut off.
  const dailyBarData = {
    labels: dayKeys.map(fmtDayLabel),
    datasets: [{
      label: 'Daily Spend',
      data: dayVals,
      backgroundColor: dayColors,
      borderRadius: 0,
      borderSkipped: false,
      barPercentage: 0.9,
      categoryPercentage: 0.95,
    }],
  }
  const dailyBarOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        displayColors: false,
        callbacks: {
          title: (items) => {
            const k = dayKeys[items[0].dataIndex]
            return fmtDayLabel(k) + (isWeekend(k) ? ' · Weekend' : '')
          },
          label: (c) => ` ${INR(dayVals[c.dataIndex])}`,
        },
      },
    },
    onHover: (evt, elements) => {
      setHoveredDayIdx(elements.length > 0 ? elements[0].index : null)
    },
    scales: {
      x: {
        ticks: { font: { size: 11, family: "'Space Grotesk'" }, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 },
        grid: { display: false },
      },
      y: {
        beginAtZero: true,
        ticks: { maxTicksLimit: 5, callback: compactINR, font: { size: 10, family: "'Space Grotesk'" } },
        grid: { color: '#f1f5f9' },
      },
    },
  }

  // ── Monthly / yearly spend ─────────────────────────────────────────────
  const monthlyMap = {}
  expenses.forEach((e) => {
    if (e.date && e.date.length >= 7) {
      const key = e.date.slice(0, 7)
      monthlyMap[key] = (monthlyMap[key] || 0) + e.amount
    }
  })
  const monthsWithData = Object.keys(monthlyMap).sort()
  // Every calendar month from the first to the last, empty ones as ₹0, so
  // a gap reads as a gap instead of two far-apart months sitting side by side.
  const allMonthKeys = []
  if (monthsWithData.length) {
    for (let k = monthsWithData[0]; k <= monthsWithData[monthsWithData.length - 1]; k = nextMonth(k)) allMonthKeys.push(k)
  }
  const years = [...new Set(allMonthKeys.map((k) => k.slice(0, 4)))]
  const today = new Date()
  const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
  const thisYear = String(today.getFullYear())

  // [label, total, partial?, key] for whatever the chips select.
  let periods
  if (monthView === 'years') {
    periods = years.map((y) => [y, allMonthKeys.filter((k) => k.startsWith(y)).reduce((s, k) => s + (monthlyMap[k] || 0), 0), y === thisYear, y])
  } else {
    const keys = monthView === 'recent'
      ? allMonthKeys.slice(-RECENT_MONTHS)
      : allMonthKeys.filter((k) => k.startsWith(monthView))
    const withYear = monthView === 'recent' && new Set(keys.map((k) => k.slice(0, 4))).size > 1
    periods = keys.map((k) => {
      const [y, m] = k.split('-')
      return [`${MONTH_ABBR[parseInt(m) - 1]}${withYear ? ` '${y.slice(2)}` : ''}`, monthlyMap[k] || 0, k === thisMonth, k]
    })
  }
  // The period still under way would drag the average down - leave it out.
  const complete = periods.filter(([, , partial]) => !partial)
  const periodAvg = complete.length ? complete.reduce((s, [, v]) => s + v, 0) / complete.length : 0
  const periodWord = monthView === 'years' ? 'year' : 'month'

  const monthlyBarData = {
    labels: periods.map(([l]) => l),
    datasets: [
      {
        type: 'line',
        label: `Average per ${periodWord}`,
        data: periods.map(() => periodAvg),
        borderColor: '#64748b',
        borderWidth: 1.5,
        borderDash: [5, 4],
        pointRadius: 0,
        pointHitRadius: 0,
        fill: false,
        order: 0,
      },
      {
        label: 'Spend',
        data: periods.map(([, v]) => v),
        backgroundColor: periods.map(([, , partial]) => (partial ? shade('#f97316', 0.35) : '#f97316')),
        borderRadius: 0,
        borderSkipped: false,
        order: 1,
      },
    ],
  }
  const monthlyBarOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        filter: (item) => item.dataset.type !== 'line',
        callbacks: {
          title: (items) => {
            const p = periods[items[0].dataIndex]
            return monthView === 'years' ? p[0] : `${MONTH_ABBR[parseInt(p[3].slice(5)) - 1]} ${p[3].slice(0, 4)}`
          },
          label: (c) => {
            const [, v, partial] = periods[c.dataIndex]
            return ` ${INR(v)}${partial ? ' so far' : ''}`
          },
          footer: () => (monthView === 'years' ? 'Tap to see its months' : `Average ${INR(periodAvg)}`),
        },
      },
    },
    // In the yearly view a bar opens that year's months.
    onClick: (evt, elements) => {
      if (monthView === 'years' && elements.length) setMonthView(periods[elements[0].index][3])
    },
    scales: {
      x: { ticks: { font: { size: 11, family: "'Space Grotesk'" }, maxRotation: 0, autoSkip: true }, grid: { display: false } },
      y: {
        beginAtZero: true,
        ticks: { maxTicksLimit: 5, callback: compactINR, font: { size: 11, family: "'Space Grotesk'" } },
        grid: { color: '#f1f5f9' },
      },
    },
  }

  const Chip = ({ active, onClick, children }) => (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-0.5 text-[11px] font-bold border transition-colors ${
        active ? 'bg-brand-400 text-white border-brand-400' : 'bg-amber-50 border-amber-200 text-gray-500'
      }`}
    >
      {children}
    </button>
  )

  const DailyCard = ({ title }) => {
    const hovered = hoveredDayIdx !== null && hoveredDayIdx < dayKeys.length ? hoveredDayIdx : null
    return (
      <div className="card">
        <div className="flex items-stretch mb-4 pb-4 border-b border-amber-100">
          <div className="flex-1 pr-4">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
              {hovered === null ? 'Average per day' : fmtDayLabel(dayKeys[hovered])}
            </p>
            <p className="text-2xl font-black text-gray-900 mt-1 tracking-tight">
              {INR(hovered === null ? windowTotal / Math.max(windowDays, 1) : dayVals[hovered])}
            </p>
            <p className="text-[11px] text-gray-400 mt-0.5">
              {hovered === null ? `over ${windowDays} days, ₹0 days included` : isWeekend(dayKeys[hovered]) ? 'Weekend' : 'Weekday'}
            </p>
          </div>
          <div className="w-px bg-amber-100" />
          <div className="flex-1 pl-4">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Days with spending</p>
            <p className="text-2xl font-black text-brand-600 mt-1 tracking-tight">{activeDays} / {windowDays}</p>
            <p className="text-[11px] text-gray-400 mt-0.5">{INR(windowTotal)} in total</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h3 className="text-xs font-bold text-gray-500">
            {title}{longSpan ? ` · last ${windowDays} days` : ''}
          </h3>
          {longSpan ? (
            <div className="flex gap-1">
              {[30, 90].map((n) => (
                <Chip key={n} active={dayRange === n} onClick={() => { setDayRange(n); setHoveredDayIdx(null) }}>{n}D</Chip>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-[10px] text-gray-400">
                <span className="w-2 h-2 rounded-full bg-green-500 inline-block" /> Weekday
              </span>
              <span className="flex items-center gap-1.5 text-[10px] text-gray-400">
                <span className="w-2 h-2 rounded-full bg-orange-500 inline-block" /> Weekend
              </span>
            </div>
          )}
        </div>
        <div className="relative h-56 md:h-72">
          <Bar data={dailyBarData} options={dailyBarOptions} />
        </div>
        {longSpan && (
          <p className="text-[10px] text-gray-400 mt-2">
            Green bars are weekdays, orange weekends. Tap a bar for its day; month and year totals are below.
          </p>
        )}
      </div>
    )
  }

  const MonthlyCard = () => {
    const manyMonths = allMonthKeys.length > RECENT_MONTHS
    return (
      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h3 className="text-xs font-bold text-gray-500">
            {monthView === 'years' ? 'Spend by year' : monthView === 'recent' ? 'Spend by month' : `Spend by month · ${monthView}`}
          </h3>
          {manyMonths && (
            <div className="flex gap-1">
              <Chip active={monthView === 'recent'} onClick={() => setMonthView('recent')}>12 months</Chip>
              <Chip active={monthView !== 'recent'} onClick={() => setMonthView('years')}>By year</Chip>
            </div>
          )}
        </div>
        <p className="text-[11px] text-gray-400 mb-3">
          Dashed line: average per {periodWord}, {INR(periodAvg)}
          {periods.some(([, , partial]) => partial) && ` · the lighter bar is the ${periodWord} so far`}
          {monthView === 'years' && ' · tap a year for its months'}
          {monthView !== 'recent' && monthView !== 'years' && (
            <button type="button" className="ml-2 font-bold text-brand-600" onClick={() => setMonthView('years')}>← All years</button>
          )}
        </p>
        <div className="relative h-56 md:h-72">
          <Bar data={monthlyBarData} options={monthlyBarOptions} />
        </div>
      </div>
    )
  }

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

  // More than one calendar month of data - a master group's combined
  // history, most often - reads far better as a month-on-month bar chart
  // than a daily line stretched thin across mostly-empty gaps. A single
  // month's worth (one trip, one personal-tracker month) stays daily,
  // where day-to-day is still the useful resolution.
  const hasMultipleMonths = allMonthKeys.length > 1

  return (
    <div className="px-5 space-y-4 mt-2">
      {isSolo ? (
        <>
          {dailyEntries.length > 0 ? (
            <DailyCard title="Daily Spend" />
          ) : (
            <p className="text-xs text-gray-400 text-center py-6">No dated expenses yet</p>
          )}
          {hasMultipleMonths && <MonthlyCard />}
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
            <>
              <div className="card">
                <h3 className="text-xs font-bold text-gray-500 mb-3">Who paid how much?</h3>
                <Bar data={memberChartData} options={hBarOptions} />
              </div>
              {hasMultipleMonths && <MonthlyCard />}
            </>
          )}

          {chartView === 'category' && (
            <>
              {catData.length > 0 && <CategoryCard />}
              {dailyEntries.length > 0 && <DailyCard title="Spend" />}
            </>
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
  )
}
