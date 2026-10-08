import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Chart,
  BarElement, BarController, LineElement, LineController, PointElement,
  CategoryScale, LinearScale, Tooltip,
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import { getHistory } from '../api/index.js'
import LoadingSpinner from '../components/LoadingSpinner'
import { useUser } from '../UserContext'
import { pairKey, nameList } from '../utils/masterGroups'

Chart.register(BarElement, BarController, LineElement, LineController, PointElement, CategoryScale, LinearScale, Tooltip)
Chart.defaults.font.family = "'Space Grotesk', system-ui, sans-serif"

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
// ₹2.5L / ₹40k / ₹600 - axis labels that stay short at any scale.
const compactINR = (v) =>
  v >= 100000 ? `₹${(v / 100000).toFixed(v % 100000 ? 1 : 0)}L`
    : v >= 1000 ? `₹${Math.round(v / 1000)}k`
    : `₹${Math.round(v)}`
const shade = (hex, alpha) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`
}

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const pad = (n) => String(n).padStart(2, '0')
const ymLabel = (ym) => `${MON[+ym.slice(5, 7) - 1]} '${ym.slice(2, 4)}`
const addMonths = (ym, n) => {
  const [y, m] = ym.split('-').map(Number)
  const t = y * 12 + (m - 1) + n
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`
}
const monthRange = (from, to) => {
  const out = []
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m)
  return out
}
const currentYM = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}
const change = (now, before) => (before > 0 ? Math.round(((now - before) / before) * 100) : null)

const SOLO   = '#f97316'
const SHARED = '#3b82f6'
const AVG    = '#64748b'
const TICK_FONT = { size: 10, family: "'Space Grotesk', system-ui, sans-serif" }
// A leading year with fewer days of spending than this is a stray entry or
// two, not a year - charting it squeezes the real years and drags averages.
const MIN_DAYS = 12
const LIST_LIMIT = 6

/**
 * History & Stats, built from one /stats/history response: (group, month,
 * category) rows with both the group's total and the caller's share. Every
 * section reads the same period, measure and filter, so tapping a supergroup
 * or a category narrows the whole page to it.
 */
export default function History() {
  const nav  = useNavigate()
  const user = useUser()

  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  const [measure, setMeasure] = useState('share')   // 'share' (mine) | 'total' (whole group)
  const [period,  setPeriod]  = useState('recent')  // 'recent' | 'all' | 'YYYY'
  const [focus,   setFocus]   = useState(null)      // { kind: 'side'|'super'|'cat', key, label }
  const [picked,  setPicked]  = useState(null)      // a month tapped on the chart
  const [allSupers, setAllSupers] = useState(false)
  const [allCats,   setAllCats]   = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      setData((await getHistory()).data)
    } catch {
      setError('Could not reach server. The API may be waking up — please try again in 30 seconds.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])
  useEffect(() => { setPicked(null) }, [period, focus, measure])

  // Rows tagged with their supergroup (groups with the exact same members).
  const base = useMemo(() => {
    if (!data) return null
    const me = (user?.name || '').trim().toLowerCase()
    const supers = {}
    const groups = {}
    data.groups.forEach((g) => {
      const key = pairKey(g.members)
      const others = g.members.filter((n) => n.trim().toLowerCase() !== me)
      if (!supers[key]) {
        supers[key] = {
          key, names: g.members, solo: others.length === 0,
          label: others.length ? `With ${nameList(others)}` : 'Just you',
        }
      }
      groups[g.id] = { ...g, superKey: key, monthly: /^MONTHLY EXPENSES/i.test(g.name) }
    })

    const realYears = Object.keys(data.days).filter((y) => data.days[y] >= MIN_DAYS).sort()
    const firstYear = realYears[0] || currentYM().slice(0, 4)
    const all = data.rows.map(([gid, ym, cat, total, share]) => ({
      gid, ym, cat, total, share,
      sk: groups[gid]?.superKey,
      solo: supers[groups[gid]?.superKey]?.solo ?? true,
    }))
    const earliest = all.reduce((m, r) => (r.ym.slice(0, 4) < m ? r.ym.slice(0, 4) : m), firstYear)
    const dropped = earliest < firstYear
      ? (+earliest === +firstYear - 1 ? earliest : `${earliest}–${+firstYear - 1}`)
      : null
    return { supers, groups, firstYear, dropped, rows: all.filter((r) => r.ym.slice(0, 4) >= firstYear) }
  }, [data, user?.name])

  const view = useMemo(() => {
    if (!base) return null
    const { rows, supers, groups, firstYear } = base
    const cur = currentYM()
    const curYear = cur.slice(0, 4)
    const val = (r) => r[measure]
    const sum = (rs) => rs.reduce((s, r) => s + val(r), 0)
    const isAll  = period === 'all'
    const isYear = /^\d{4}$/.test(period)

    let months, compareLabel = null
    if (isAll) {
      months = monthRange(`${firstYear}-01`, cur)
    } else if (isYear) {
      months = monthRange(`${period}-01`, period === curYear ? cur : `${period}-12`)
      if (+period - 1 >= +firstYear) compareLabel = `vs ${+period - 1}${period === curYear ? ', same months' : ''}`
    } else {
      months = monthRange(addMonths(cur, -11), cur)
      compareLabel = 'vs a year earlier'
    }
    // Comparisons use complete months only, so a month still under way
    // never reads as a drop.
    const complete = months.filter((m) => m !== cur)
    const completeSet = new Set(complete)
    const prevSet = new Set(complete.map((m) => addMonths(m, -12)))
    const inPeriod = new Set(months)

    const bySide = (r) => !focus || focus.kind === 'cat'
      || (focus.kind === 'super' ? r.sk === focus.key : r.solo === (focus.key === 'solo'))
    const byCat = (r) => !focus || focus.kind !== 'cat' || r.cat === focus.key

    const P    = rows.filter((r) => inPeriod.has(r.ym))
    const Prev = compareLabel ? rows.filter((r) => prevSet.has(r.ym)) : []
    const main = P.filter((r) => bySide(r) && byCat(r))
    const total = sum(main)

    // ── Trend: months, or years for "All" ──
    const bucketOf = isAll ? (ym) => ym.slice(0, 4) : (ym) => ym
    const keys = isAll
      ? Array.from({ length: +curYear - +firstYear + 1 }, (_, i) => String(+firstYear + i))
      : months
    const soloBy = {}, sharedBy = {}
    main.forEach((r) => {
      const into = r.solo ? soloBy : sharedBy
      const b = bucketOf(r.ym)
      into[b] = (into[b] || 0) + val(r)
    })
    const partialKey = isAll ? curYear : cur
    const buckets = keys.map((k) => {
      const solo = soloBy[k] || 0, shared = sharedBy[k] || 0
      return { key: k, solo, shared, total: solo + shared, partial: k === partialKey }
    })
    const done = buckets.filter((b) => !b.partial)
    const avg = done.length ? done.reduce((s, b) => s + b.total, 0) / done.length : null
    const peak = done.reduce((a, b) => (!a || b.total > a.total ? b : a), null)

    let compare = null
    if (compareLabel) {
      const now = sum(main.filter((r) => completeSet.has(r.ym)))
      const before = sum(Prev.filter((r) => bySide(r) && byCat(r)))
      compare = { pct: change(now, before), label: compareLabel }
    }

    // ── Supergroups: everything but a supergroup filter applies ──
    const sideRows = P.filter(byCat)
    const soloTotal = sum(sideRows.filter((r) => r.solo))
    const sharedTotal = sum(sideRows.filter((r) => !r.solo))
    const sg = {}
    sideRows.filter((r) => !r.solo).forEach((r) => {
      const s = sg[r.sk] || (sg[r.sk] = { ...supers[r.sk], value: 0, groups: new Set() })
      s.value += val(r)
      s.groups.add(r.gid)
    })
    const superList = Object.values(sg).filter((s) => s.value >= 1).sort((a, b) => b.value - a.value)

    // ── Categories: everything but a category filter applies ──
    const catRows = P.filter(bySide)
    const catTotal = sum(catRows)
    const cats = {}, catNow = {}, catBefore = {}
    catRows.forEach((r) => {
      cats[r.cat] = (cats[r.cat] || 0) + val(r)
      if (completeSet.has(r.ym)) catNow[r.cat] = (catNow[r.cat] || 0) + val(r)
    })
    Prev.filter(bySide).forEach((r) => { catBefore[r.cat] = (catBefore[r.cat] || 0) + val(r) })
    const catList = Object.entries(cats)
      .filter(([, v]) => v >= 1)
      .map(([cat, value]) => ({ cat, value, change: compareLabel ? change(catNow[cat] || 0, catBefore[cat] || 0) : null }))
      .sort((a, b) => b.value - a.value)

    // ── Trips & shared groups: monthly groups are just the months again ──
    const gs = {}
    main.filter((r) => !groups[r.gid]?.monthly).forEach((r) => {
      const g = gs[r.gid] || (gs[r.gid] = { ...groups[r.gid], value: 0, from: r.ym, to: r.ym })
      g.value += val(r)
      if (r.ym < g.from) g.from = r.ym
      if (r.ym > g.to) g.to = r.ym
    })
    const topGroups = Object.values(gs).filter((g) => g.value >= 1).sort((a, b) => b.value - a.value).slice(0, 5)

    // ── How months compare: complete months that had any spending ──
    const perMonth = {}
    main.forEach((r) => { perMonth[r.ym] = (perMonth[r.ym] || 0) + val(r) })
    const spent = complete.filter((m) => perMonth[m] > 0).map((m) => ({ m, v: perMonth[m] }))
    let spread = null
    if (spent.length >= 3) {
      const sorted = [...spent].sort((a, b) => a.v - b.v)
      const n = sorted.length
      const median = n % 2 ? sorted[(n - 1) / 2].v : (sorted[n / 2 - 1].v + sorted[n / 2].v) / 2
      spread = { n, low: sorted[0], high: sorted[n - 1], median, latest: spent[spent.length - 1] }
    }

    // ── A month (or, in "All", a year) tapped on the chart ──
    let pick = null
    const pickedBucket = picked && buckets.find((b) => b.key === picked)
    if (pickedBucket) {
      const rs = main.filter((r) => bucketOf(r.ym) === picked)
      const byC = {}, byG = {}
      rs.forEach((r) => {
        byC[r.cat] = (byC[r.cat] || 0) + val(r)
        byG[r.gid] = (byG[r.gid] || 0) + val(r)
      })
      const spentMonths = new Set(rs.map((r) => r.ym)).size
      pick = {
        key: picked,
        isYear: isAll,
        partial: pickedBucket.partial,
        solo: pickedBucket.solo,
        shared: pickedBucket.shared,
        vsAvg: avg ? change(pickedBucket.total, avg) : null,
        perMonth: isAll && spentMonths ? pickedBucket.total / spentMonths : null,
        spentMonths,
        total: sum(rs),
        cats: Object.entries(byC).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1]).slice(0, 6),
        groups: Object.entries(byG).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([id, v]) => ({ ...groups[id], value: v })),
      }
    }

    return {
      cur, curYear, isAll, isYear, total, buckets, avg, peak, compare,
      completeCount: complete.length,
      soloTotal, sharedTotal, superList, catTotal, catList, topGroups, spread, pick,
      years: Array.from({ length: +curYear - +firstYear + 1 }, (_, i) => String(+curYear - i)),
    }
  }, [base, measure, period, focus, picked])

  if (loading) return <LoadingSpinner />

  if (error || !view) return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-5 text-center">
      <p className="text-4xl mb-3">😴</p>
      <p className="text-sm text-gray-600 mb-4">{error || 'Nothing to show yet.'}</p>
      <button onClick={load} className="bg-brand-400 text-white px-5 py-2 text-sm font-bold shadow-md">Retry</button>
    </div>
  )

  const { buckets, isAll } = view
  const periodLabel = isAll ? `${base.firstYear}–${view.curYear}` : view.isYear ? period : 'Last 12 months'
  const toggleFocus = (f) => setFocus((cur) => (cur && cur.kind === f.kind && cur.key === f.key ? null : f))
  const isFocused = (kind, key) => focus && focus.kind === kind && focus.key === key

  // ── Trend chart ──
  const hasShared = buckets.some((b) => b.shared > 0)
  const chartData = {
    labels: buckets.map((b) => (isAll ? b.key : ymLabel(b.key))),
    datasets: [
      {
        type: 'bar', label: 'Just you', stack: 'spend', order: 2,
        data: buckets.map((b) => b.solo),
        backgroundColor: buckets.map((b) => (b.partial ? shade(SOLO, 0.35) : SOLO)),
        borderRadius: 0, borderSkipped: false,
      },
      {
        type: 'bar', label: 'Shared', stack: 'spend', order: 2,
        data: buckets.map((b) => b.shared),
        backgroundColor: buckets.map((b) => (b.partial ? shade(SHARED, 0.35) : SHARED)),
        borderRadius: 0, borderSkipped: false,
      },
      ...(view.avg ? [{
        type: 'line', label: 'Average', stack: 'avg', order: 1,
        data: buckets.map(() => view.avg),
        borderColor: AVG, borderWidth: 1.5, borderDash: [5, 4],
        pointRadius: 0, pointHoverRadius: 0, fill: false,
      }] : []),
    ],
  }
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        filter: (item) => item.dataset.type === 'line' || item.raw > 0,
        callbacks: {
          title: (items) => {
            const b = buckets[items[0].dataIndex]
            return `${isAll ? b.key : ymLabel(b.key)}${b.partial ? ' (so far)' : ''}`
          },
          label: (c) => ` ${c.dataset.label}: ${INR(c.raw)}`,
          footer: (items) => {
            const b = buckets[items[0].dataIndex]
            return b.solo > 0 && b.shared > 0 ? `Total: ${INR(b.total)}` : ''
          },
        },
      },
    },
    scales: {
      x: {
        stacked: true,
        grid: { display: false },
        ticks: {
          font: TICK_FONT, maxRotation: 0, autoSkip: false,
          callback: (_, i) => {
            const b = buckets[i]
            if (!b) return ''
            if (isAll) return b.key
            const m = +b.key.slice(5, 7)
            return m === 1 || i === 0 ? [MON[m - 1], b.key.slice(0, 4)] : MON[m - 1]
          },
        },
      },
      // No max: the scale always runs to the biggest bar.
      y: {
        stacked: true, beginAtZero: true,
        ticks: { font: TICK_FONT, maxTicksLimit: 5, callback: (v) => compactINR(v) },
        grid: { color: '#f1f5f9' },
        border: { display: false },
      },
    },
    onClick: (_, els) => {
      if (!els.length) return
      // A tap shows that bar's breakdown - for a year too, so its own
      // numbers are readable; "See months" in the panel opens the year.
      const b = buckets[els[0].index]
      setPicked((p) => (p === b.key ? null : b.key))
    },
    onHover: (evt, els) => {
      if (evt.native) evt.native.target.style.cursor = els.length ? 'pointer' : 'default'
    },
  }

  const avgLabel = isAll ? 'Avg / year' : 'Avg / month'
  const sideTotal = view.soloTotal + view.sharedTotal
  const maxShared = view.superList[0]?.value || 1
  const maxCat = view.catList[0]?.value || 1
  const supers = allSupers ? view.superList : view.superList.slice(0, LIST_LIMIT)
  const cats = allCats ? view.catList : view.catList.slice(0, LIST_LIMIT + 2)

  return (
    <div className="pb-24 md:pb-8">

      {/* Header: the period's total, and what "spend" means */}
      <div className="bg-gradient-to-br from-field-800 to-field-950 text-white px-5 pt-10 md:pt-8 pb-5 border-b border-field-700">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-brand-400/70 text-xs font-bold uppercase tracking-widest">History & Stats</p>
            <h1 className="text-3xl font-black mt-1 tracking-tight">{INR(view.total)}</h1>
            <p className="text-slate-300/60 text-xs mt-1">
              {measure === 'share' ? 'Your share' : 'Group totals'} · {periodLabel}
              {focus && <> · {focus.label}</>}
            </p>
          </div>
          <div className="flex shrink-0 border border-field-700">
            {[['share', 'My share'], ['total', 'Group totals']].map(([v, lbl]) => (
              <button
                key={v}
                onClick={() => setMeasure(v)}
                className={`px-2 py-1 text-[10px] font-bold transition-colors ${
                  measure === v ? 'bg-brand-400 text-white' : 'text-slate-300/70 hover:text-white'
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

        {/* Period - every section below follows it */}
        <div className="flex gap-1 mt-4 overflow-x-auto pb-1 -mx-1 px-1">
          {[['recent', '12M'], ...view.years.map((y) => [y, y]), ['all', 'All']].map(([v, lbl]) => (
            <button
              key={v}
              onClick={() => setPeriod(v)}
              className={`shrink-0 px-2.5 py-1 text-[11px] font-bold border transition-colors ${
                period === v
                  ? 'bg-brand-400 text-white border-brand-400'
                  : 'text-slate-300/70 border-field-700 hover:text-white'
              }`}
            >
              {lbl}
            </button>
          ))}
        </div>
        {base.dropped && (
          <p className="text-[10px] text-slate-300/40 mt-1.5">
            {base.dropped} left out (too few payments to count as a year)
          </p>
        )}
      </div>

      <div className="px-4 md:px-5 mt-4 space-y-4">

        {focus && (
          <button
            onClick={() => setFocus(null)}
            className="w-full flex items-center justify-between bg-brand-50 border border-brand-300 px-3 py-2 text-xs font-bold text-brand-700"
          >
            <span>Showing only: {focus.label}</span>
            <span className="text-brand-500">Clear ✕</span>
          </button>
        )}

        {/* ── Numbers at a glance ── */}
        <div className="grid grid-cols-3 gap-2">
          <Tile
            label={avgLabel}
            value={view.avg != null ? INR(Math.round(view.avg)) : '—'}
            note={isAll ? 'complete years' : `${view.completeCount} complete months`}
          />
          <Tile
            label={isAll ? 'Biggest year' : 'Biggest month'}
            value={view.peak ? INR(Math.round(view.peak.total)) : '—'}
            note={view.peak ? (isAll ? view.peak.key : ymLabel(view.peak.key)) : ''}
          />
          {view.compare && view.compare.pct != null ? (
            <Tile
              label="Change"
              value={`${view.compare.pct > 0 ? '+' : ''}${view.compare.pct}%`}
              tone={view.compare.pct > 0 ? 'up' : 'down'}
              note={view.compare.label}
            />
          ) : (
            <Tile label="Since" value={base.firstYear} note="first full year" />
          )}
        </div>

        {/* ── 1. Spend over time ── */}
        <div className="card">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest">
              {isAll ? 'Spend by year' : 'Spend by month'}
            </h2>
            {view.isYear && (
              <button onClick={() => setPeriod('all')} className="text-[10px] font-bold text-brand-500">‹ All years</button>
            )}
          </div>
          <div className="flex items-center gap-3 mb-3 text-[10px] text-gray-500 flex-wrap">
            <Legend color={SOLO} label="Just you" />
            {hasShared && <Legend color={SHARED} label="Shared groups" />}
            {view.avg != null && <Legend color={AVG} label={`Average ${compactINR(view.avg)}`} dashed />}
            {buckets.some((b) => b.partial) && <span className="text-gray-400">lighter = still under way</span>}
          </div>
          <div className="relative h-64">
            <Bar data={chartData} options={chartOptions} />
          </div>
          <p className="text-[10px] text-gray-300 mt-2 text-center">
            {isAll ? 'tap a year for its numbers' : 'tap a month to see where it went'}
          </p>

          {view.pick && (
            <div className="mt-3 pt-3 border-t border-amber-100">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">
                  {view.pick.isYear ? view.pick.key : ymLabel(view.pick.key)}
                  {view.pick.partial ? ' (so far)' : ''} · {INR(view.pick.total)}
                </p>
                <button onClick={() => setPicked(null)} className="text-gray-300 hover:text-gray-500 text-sm leading-none">✕</button>
              </div>
              <div className="grid grid-cols-3 gap-2 mb-3 text-center">
                <div className="bg-amber-50 py-1.5">
                  <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Just you</p>
                  <p className="text-xs font-black text-gray-900">{INR(view.pick.solo)}</p>
                </div>
                <div className="bg-amber-50 py-1.5">
                  <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Shared</p>
                  <p className="text-xs font-black text-gray-900">{INR(view.pick.shared)}</p>
                </div>
                <div className="bg-amber-50 py-1.5">
                  {view.pick.isYear ? (
                    <>
                      <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Per month</p>
                      <p className="text-xs font-black text-gray-900">{view.pick.perMonth ? INR(Math.round(view.pick.perMonth)) : '—'}</p>
                    </>
                  ) : (
                    <>
                      <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">vs average</p>
                      <p className={`text-xs font-black ${view.pick.vsAvg > 0 ? 'text-red-500' : 'text-green-600'}`}>
                        {view.pick.vsAvg == null ? '—' : `${view.pick.vsAvg > 0 ? '+' : ''}${view.pick.vsAvg}%`}
                      </p>
                    </>
                  )}
                </div>
              </div>
              {view.pick.isYear && (
                <p className="text-[10px] text-gray-500 mb-2">
                  {view.pick.spentMonths} month{view.pick.spentMonths === 1 ? '' : 's'} with spending
                  {view.pick.vsAvg != null && !view.pick.partial && (
                    <> · <span className={`font-bold ${view.pick.vsAvg > 0 ? 'text-red-500' : 'text-green-600'}`}>
                      {Math.abs(view.pick.vsAvg)}% {view.pick.vsAvg > 0 ? 'above' : 'below'}
                    </span> the average year</>
                  )}
                </p>
              )}
              <div className="flex flex-wrap gap-1.5 mb-2">
                {view.pick.cats.map(([c, v]) => (
                  <span key={c} className="text-[10px] font-bold bg-amber-50 border border-amber-200 px-2 py-0.5 text-gray-600">
                    {c} {compactINR(v)}
                  </span>
                ))}
              </div>
              {view.pick.groups.map((g) => (
                <button
                  key={g.id}
                  onClick={() => nav(`/groups/${g.id}`)}
                  className="w-full flex items-center justify-between py-1.5 text-left hover:bg-amber-50 -mx-2 px-2"
                >
                  <span className="text-xs font-bold text-gray-700 truncate pr-2">{g.emoji} {g.name}</span>
                  <span className="text-xs font-black text-gray-900 shrink-0">{INR(g.value)} ›</span>
                </button>
              ))}
              {view.pick.isYear && (
                <button
                  onClick={() => setPeriod(view.pick.key)}
                  className="w-full mt-2 bg-brand-400 text-white text-xs font-bold py-2"
                >
                  See {view.pick.key} month by month ›
                </button>
              )}
            </div>
          )}
        </div>

        {/* ── 2. Supergroups: who the spending was with ── */}
        {sideTotal > 0 && (
          <div className="card">
            <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest mb-3">Who it was with</h2>

            {/* Solo vs shared, as one split bar */}
            <div className="flex h-8 w-full overflow-hidden">
              {[
                { key: 'solo', label: 'Just you', value: view.soloTotal, color: SOLO },
                { key: 'shared', label: 'Shared groups', value: view.sharedTotal, color: SHARED },
              ].filter((s) => s.value > 0).map((s) => {
                const pct = Math.round((s.value / sideTotal) * 100)
                const dim = focus && focus.kind === 'side' && focus.key !== s.key
                return (
                  <button
                    key={s.key}
                    onClick={() => toggleFocus({ kind: 'side', key: s.key, label: s.label })}
                    style={{ width: `${Math.max(pct, 3)}%`, background: s.color, opacity: dim ? 0.35 : 1 }}
                    className="h-full rounded-none text-[10px] font-black text-white overflow-hidden whitespace-nowrap"
                    title={`${s.label}: ${INR(s.value)}`}
                  >
                    {pct >= 12 ? `${pct}%` : ''}
                  </button>
                )
              })}
            </div>
            <div className="flex justify-between mt-1.5 text-[11px]">
              <span className="font-bold text-gray-700"><Dot color={SOLO} />Just you {INR(view.soloTotal)}</span>
              <span className="font-bold text-gray-700"><Dot color={SHARED} />Shared {INR(view.sharedTotal)}</span>
            </div>

            {view.superList.length > 0 && (
              <>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mt-4 mb-1">
                  Shared groups, by who {measure === 'share' ? '· your share' : '· whole group'}
                </p>
                {supers.map((s) => (
                  <Row
                    key={s.key}
                    label={s.label}
                    sub={`${s.groups.size} group${s.groups.size > 1 ? 's' : ''}`}
                    value={s.value}
                    pctOf={sideTotal}
                    width={s.value / maxShared}
                    color={SHARED}
                    active={isFocused('super', s.key)}
                    dim={focus?.kind === 'super' && !isFocused('super', s.key)}
                    onClick={() => toggleFocus({ kind: 'super', key: s.key, label: s.label })}
                    onOpen={() => nav(`/master/${encodeURIComponent(s.key)}`)}
                  />
                ))}
                {view.superList.length > LIST_LIMIT && (
                  <button onClick={() => setAllSupers((v) => !v)} className="w-full text-[11px] font-bold text-brand-500 pt-2">
                    {allSupers ? 'Show fewer' : `Show all ${view.superList.length}`}
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* ── 3. Categories ── */}
        {view.catList.length > 0 && (
          <div className="card">
            <div className="flex items-baseline justify-between mb-2">
              <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest">What it went on</h2>
              {view.compare && <span className="text-[10px] text-gray-400">change {view.compare.label}</span>}
            </div>
            {cats.map((c) => (
              <Row
                key={c.cat}
                label={c.cat}
                value={c.value}
                pctOf={view.catTotal}
                width={c.value / maxCat}
                color={SOLO}
                change={c.change}
                active={isFocused('cat', c.cat)}
                dim={focus?.kind === 'cat' && !isFocused('cat', c.cat)}
                onClick={() => toggleFocus({ kind: 'cat', key: c.cat, label: c.cat })}
              />
            ))}
            {view.catList.length > LIST_LIMIT + 2 && (
              <button onClick={() => setAllCats((v) => !v)} className="w-full text-[11px] font-bold text-brand-500 pt-2">
                {allCats ? 'Show fewer' : `Show all ${view.catList.length}`}
              </button>
            )}
          </div>
        )}

        {/* ── 4. Biggest trips & shared groups ── */}
        {view.topGroups.length > 0 && (
          <div className="card">
            <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest mb-2">Biggest trips & groups</h2>
            {view.topGroups.map((g, i) => (
              <button
                key={g.id}
                onClick={() => nav(`/groups/${g.id}`)}
                className="w-full flex items-center gap-3 py-2 text-left hover:bg-amber-50 -mx-2 px-2 border-b border-amber-100 last:border-0"
              >
                <span className="text-[11px] font-black text-gray-300 w-3">{i + 1}</span>
                <span className="text-lg leading-none">{g.emoji}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-xs font-bold text-gray-800 truncate">{g.name}</span>
                  <span className="block text-[10px] text-gray-400 truncate">
                    {base.supers[g.superKey]?.label} · {g.from === g.to ? ymLabel(g.from) : `${ymLabel(g.from)} – ${ymLabel(g.to)}`}
                  </span>
                </span>
                <span className="text-xs font-black text-gray-900 shrink-0">{INR(g.value)}</span>
              </button>
            ))}
          </div>
        )}

        {/* ── 5. How the months compare ── */}
        {view.spread && (
          <div className="card">
            <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest mb-3">
              How your months compare <span className="text-gray-300 normal-case tracking-normal font-bold">({view.spread.n} months)</span>
            </h2>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Lowest</p>
                <p className="text-sm font-black text-gray-900 mt-0.5">{INR(Math.round(view.spread.low.v))}</p>
                <p className="text-[10px] text-gray-400">{ymLabel(view.spread.low.m)}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Typical</p>
                <p className="text-sm font-black text-brand-600 mt-0.5">{INR(Math.round(view.spread.median))}</p>
                <p className="text-[10px] text-gray-400">median</p>
              </div>
              <div>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Highest</p>
                <p className="text-sm font-black text-gray-900 mt-0.5">{INR(Math.round(view.spread.high.v))}</p>
                <p className="text-[10px] text-gray-400">{ymLabel(view.spread.high.m)}</p>
              </div>
            </div>
            <SpreadBar spread={view.spread} />
          </div>
        )}
      </div>
    </div>
  )
}

function Tile({ label, value, note, tone }) {
  const color = tone === 'up' ? 'text-red-500' : tone === 'down' ? 'text-green-600' : 'text-gray-900'
  return (
    <div className="card !p-3 text-center">
      <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{label}</p>
      <p className={`text-base font-black mt-0.5 tracking-tight ${color}`}>{value}</p>
      <p className="text-[9px] text-gray-400 mt-0.5 leading-tight">{note}</p>
    </div>
  )
}

function Legend({ color, label, dashed }) {
  return (
    <span className="flex items-center gap-1">
      {dashed
        ? <span className="inline-block w-3 border-t-2 border-dashed" style={{ borderColor: color }} />
        : <span className="inline-block w-2.5 h-2.5" style={{ background: color }} />}
      {label}
    </span>
  )
}

function Dot({ color }) {
  return <span className="inline-block w-2 h-2 mr-1 align-middle" style={{ background: color }} />
}

// One ranked line: name, amount, share of the whole, and a bar scaled to the
// list's biggest entry. Tapping it filters the page to that entry.
function Row({ label, sub, value, pctOf, width, color, change, active, dim, onClick, onOpen }) {
  const pct = pctOf > 0 ? (value / pctOf) * 100 : 0
  return (
    <div className={`py-2 border-b border-amber-100 last:border-0 ${dim ? 'opacity-40' : ''}`}>
      <div className="flex items-center gap-2">
        <button onClick={onClick} className="flex-1 min-w-0 text-left">
          <div className="flex items-baseline justify-between gap-2">
            <span className={`text-xs font-bold truncate ${active ? 'text-brand-600' : 'text-gray-800'}`}>
              {label}
              {sub && <span className="text-[10px] font-normal text-gray-400 ml-1.5">{sub}</span>}
            </span>
            <span className="text-xs font-black text-gray-900 shrink-0">
              {INR(value)}
              <span className="text-[10px] font-bold text-gray-400 ml-1">{pct < 1 ? '<1' : Math.round(pct)}%</span>
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <div className="flex-1 h-1.5 bg-amber-100">
              <div className="h-full" style={{ width: `${Math.max(width * 100, 1)}%`, background: color }} />
            </div>
            {change != null && (
              <span className={`text-[10px] font-bold w-12 text-right ${change > 0 ? 'text-red-500' : change < 0 ? 'text-green-600' : 'text-gray-400'}`}>
                {change > 0 ? '▲' : change < 0 ? '▼' : ''}{Math.abs(change) > 999 ? '999+' : Math.abs(change)}%
              </span>
            )}
          </div>
        </button>
        {onOpen && (
          <button onClick={onOpen} className="text-gray-300 hover:text-brand-500 text-sm px-1 shrink-0" title="Open">›</button>
        )}
      </div>
    </div>
  )
}

// Lowest to highest month on one line: the typical month and the latest
// complete one marked where they fall.
function SpreadBar({ spread }) {
  const { low, high, median, latest } = spread
  const span = high.v - low.v || 1
  const at = (v) => `${((v - low.v) / span) * 100}%`
  const vsTypical = median > 0 ? Math.round(((latest.v - median) / median) * 100) : 0
  return (
    <div className="mt-4">
      <div className="relative h-2 bg-amber-100">
        <div className="absolute top-[-3px] h-[14px] w-0.5 bg-brand-500" style={{ left: at(median) }} />
        <div className="absolute top-[-4px] h-4 w-1.5 bg-gray-900" style={{ left: `calc(${at(latest.v)} - 3px)` }} />
      </div>
      <p className="text-[11px] text-gray-600 mt-3">
        <span className="font-bold">{ymLabel(latest.m)}</span>, your latest complete month, was{' '}
        <span className="font-bold">{INR(Math.round(latest.v))}</span> —{' '}
        {Math.abs(vsTypical) < 5
          ? 'about a typical month.'
          : <><span className={`font-bold ${vsTypical > 0 ? 'text-red-500' : 'text-green-600'}`}>{Math.abs(vsTypical)}% {vsTypical > 0 ? 'above' : 'below'}</span> a typical month.</>}
      </p>
    </div>
  )
}
