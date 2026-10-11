import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Chart, BarElement, BarController, LineElement, LineController, PointElement, ScatterController,
  CategoryScale, LinearScale, Tooltip, Legend,
} from 'chart.js'
import { Bar, Chart as MixedChart } from 'react-chartjs-2'
import { getMLAnalysis, getPredictions, getRecommendations, setSavingsPlan } from '../api'

Chart.register(BarElement, BarController, LineElement, LineController, PointElement, ScatterController,
  CategoryScale, LinearScale, Tooltip, Legend)

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const K = (v) => (Math.abs(v) >= 1000 ? `${v < 0 ? '−' : ''}₹${(Math.abs(v) / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1)}k` : INR(v))
const mlabel = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
const P = ['Early', 'Day', 'Night']
const BRAND = '#f97316', SLATE = '#334155', SOFT = '#cbd5e1', UP = '#dc2626', DOWN = '#16a34a'
const FONT = { family: "'Space Grotesk', system-ui, sans-serif", size: 10 }

const base = (extra = {}) => ({
  responsive: true, maintainAspectRatio: false, animation: false,
  plugins: { legend: { labels: { boxWidth: 10, font: FONT } }, ...(extra.plugins || {}) },
  scales: {
    x: { grid: { display: false }, ticks: { font: FONT }, ...(extra.x || {}) },
    y: { grid: { color: '#f1f5f9' }, border: { display: false }, ticks: { font: FONT, callback: (v) => K(v) }, ...(extra.y || {}) },
  },
  ...(extra.top || {}),
})
const bar = (o) => ({ borderRadius: 0, borderSkipped: false, ...o })

const fmtDay = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })

// Low-to-high bar with the likely value marked, on a shared scale.
function RangeBar({ low, likely, high, max }) {
  const pos = (v) => `${Math.min(v / max, 1) * 100}%`
  return (
    <div className="relative h-2 bg-amber-100 mt-1.5">
      <div className="absolute top-0 h-2 bg-brand-300" style={{ left: pos(low), width: `calc(${pos(high)} - ${pos(low)})` }} />
      <div className="absolute -top-1 h-4 w-0.5 bg-gray-900" style={{ left: pos(likely) }} />
    </div>
  )
}

// Forecasts from /stats/predictions - the next day, the next 7 days and the
// main categories, each a calibrated 80% range from the backtest's best model.
// One request per few minutes, shared by every place the section renders -
// it's started as the page opens, alongside the pattern analysis.
let predCache = null
const loadPredictions = () => {
  if (!predCache || Date.now() - predCache.at > 5 * 60 * 1000) {
    predCache = { at: Date.now(), promise: getPredictions().then((r) => r.data) }
    predCache.promise.catch(() => { predCache = null })
  }
  return predCache.promise
}

function Predictions() {
  const [p, setP] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    loadPredictions().then(setP).catch((e) => setErr(e.response?.data?.detail || 'Could not make a forecast just now.'))
  }, [])

  if (err) return <div className="card text-xs text-red-600">{err}</div>
  if (!p) return (
    <div className="card flex items-center gap-3">
      <div className="w-5 h-5 border-2 border-brand-400/30 border-t-brand-400 rounded-full animate-spin" />
      <p className="text-xs text-gray-500">Training the forecast on your spending…</p>
    </div>
  )
  const usable = p.categories.filter((c) => !c.unpredictable)
  const catMax = Math.max(...usable.map((c) => c.high), 1)
  const vsTypical = Math.round((p.next_7_days.likely - p.typical_week) / p.typical_week * 100)
  return (
    <div className="card space-y-3">
      <div>
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Forecast</p>
        <h2 className="text-sm font-bold text-gray-900">What you're likely to spend next</h2>
        <p className="text-[10px] text-gray-400 mt-0.5">
          Personal spending · each bar is the {p.coverage}% likely range, the line the most likely amount
        </p>
        {p.computed_at && (
          <p className="text-[10px] text-gray-400 mt-0.5">
            Made {new Date(p.computed_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
            {' · '}refreshes after {p.refresh_after} new expenses ({p.changes_since} so far)
          </p>
        )}
      </div>
      {p.days_since_data > 2 && (
        <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 px-2.5 py-2">
          Your spending data runs to <b>{fmtDay(p.data_until)}</b> ({p.days_since_data} days ago), so the forecast starts
          from there. Upload your latest PhonePe statement for an up-to-date one.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        {[['Next day', fmtDay(p.next_day.date), p.next_day, Math.max(p.next_day.high, 1)],
          ['Next 7 days', `${fmtDay(p.next_7_days.from)} – ${fmtDay(p.next_7_days.to)}`, p.next_7_days, Math.max(p.next_7_days.high, 1)]]
          .map(([label, when, f, max]) => (
            <div key={label} className="border border-amber-200 px-3 py-2.5">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{label}</p>
              <p className="text-[10px] text-gray-400">{when}</p>
              <p className="text-lg font-black text-gray-900 mt-1">{INR(f.likely)}</p>
              <RangeBar low={f.low} likely={f.likely} high={f.high} max={max} />
              <p className="text-[10px] text-gray-500 mt-1">{INR(f.low)} – {INR(f.high)}</p>
            </div>
          ))}
      </div>
      <p className="text-[11px] text-gray-600">
        A typical week lately has been {INR(p.typical_week)}; the next 7 days look
        {Math.abs(vsTypical) < 10 ? ' about the same.' : vsTypical > 0 ? ` ${vsTypical}% higher.` : ` ${Math.abs(vsTypical)}% lower.`}
      </p>
      <div>
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Next 7 days by category</p>
        {p.categories.map((c) => (
          <div key={c.category} className="py-1.5 border-b border-amber-100 last:border-0">
            <div className="flex justify-between gap-2 text-xs">
              <span className="font-bold text-gray-800">{c.category}</span>
              <span className="font-black text-gray-900">{INR(c.likely)}</span>
            </div>
            {c.unpredictable ? (
              <p className="text-[10px] text-gray-400 mt-0.5">
                Usually around {INR(c.likely)}, but occasional big purchases make this one hard to predict.
              </p>
            ) : (
              <>
                <RangeBar low={c.low} likely={c.likely} high={c.high} max={catMax} />
                <p className="text-[10px] text-gray-400 mt-1">{INR(c.low)} – {INR(c.high)}</p>
              </>
            )}
          </div>
        ))}
      </div>
      <p className="text-[10px] text-gray-400 border-t border-dashed border-amber-200 pt-2">
        Each forecast uses whichever model did best when tested on your past months (gradient boosting, random forest or
        a recent-weeks baseline), and its range was checked to hold the real amount about {p.coverage}% of the time.
        Exact daily amounts are hard to predict; the 7-day range is the most reliable.
      </p>
    </div>
  )
}

let recCache = null
const loadRecs = () => {
  if (!recCache || Date.now() - recCache.at > 5 * 60 * 1000) {
    recCache = { at: Date.now(), promise: getRecommendations().then((r) => r.data) }
    recCache.promise.catch(() => { recCache = null })
  }
  return recCache.promise
}

const EASE_TONE = { Easy: 'bg-green-50 text-green-700', Medium: 'bg-amber-50 text-amber-700', Hard: 'bg-red-50 text-red-600' }

// Personalized savings (/stats/recommendations): where the money goes, what's
// rising, realistic cuts ranked by saving x ease with an AI-written tip each,
// and - once a plan is started - actual savings against the starting point.
function Savings() {
  const [r, setR] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [showAll, setShowAll] = useState(false)
  useEffect(() => {
    loadRecs().then(setR).catch(() => setErr('Could not work out savings just now.'))
  }, [])
  const togglePlan = async (active) => {
    setBusy(true)
    try {
      const res = await setSavingsPlan(active)
      recCache = { at: Date.now(), promise: Promise.resolve(res.data) }
      setR(res.data)
    } catch { setErr('Could not update the plan.') } finally { setBusy(false) }
  }

  if (err) return <div className="card text-xs text-red-600">{err}</div>
  if (!r) return (
    <div className="card flex items-center gap-3">
      <div className="w-5 h-5 border-2 border-brand-400/30 border-t-brand-400 rounded-full animate-spin" />
      <p className="text-xs text-gray-500">Finding ways to save…</p>
    </div>
  )
  if (r.empty) return null
  const recs = showAll ? r.recommendations : r.recommendations.slice(0, 5)
  const t = r.tracking
  return (
    <div className="card space-y-3">
      <div>
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Ways to save</p>
        <p className="text-2xl font-black text-gray-900 mt-0.5">{INR(r.save_month)}<span className="text-sm font-bold text-gray-500"> a month</span></p>
        <p className="text-[11px] text-gray-500">about {INR(r.save_year)} a year, from realistic cuts to wants only</p>
      </div>
      <p className="text-xs text-gray-700 leading-relaxed bg-amber-50/60 border border-amber-100 px-3 py-2">{r.summary}</p>

      {(r.flags.length > 0 || r.day_flag.days > r.day_flag.expected) && (
        <div>
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Rising lately (last 30 days vs your normal)</p>
          {r.flags.map((f) => (
            <p key={f.key} className="text-[11px] text-gray-700 py-0.5">
              <span className="font-bold text-red-600">▲ {f.up_pct != null ? `${f.up_pct}%` : 'new'}</span> {f.title}: {INR(f.recent_30)} vs usual {INR(f.normal_30)}
            </p>
          ))}
          {r.day_flag.days > r.day_flag.expected && (
            <p className="text-[11px] text-gray-700 py-0.5">
              <span className="font-bold text-red-600">▲</span> {r.day_flag.days} days over {INR(r.day_flag.threshold)} - usually about {r.day_flag.expected} a month
            </p>
          )}
        </div>
      )}

      <div>
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Ranked by saving and how easy it is</p>
        {recs.map((x, i) => (
          <div key={x.key} className="py-2 border-b border-amber-100 last:border-0">
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs font-bold text-gray-900">
                <span className="text-gray-300 mr-1">{i + 1}</span>{x.title}
                <span className={`ml-1.5 text-[9px] font-black uppercase px-1.5 py-0.5 ${EASE_TONE[x.ease_label]}`}>{x.ease_label}</span>
              </p>
              <p className="text-xs font-black text-green-700 shrink-0">save {INR(x.save_month)}/mo</p>
            </div>
            <p className="text-[11px] text-gray-600 mt-0.5 leading-snug">{x.tip}</p>
            <p className="text-[10px] text-gray-400 mt-0.5">
              Now {INR(x.monthly_now)}/mo → budget {INR(x.budget)}/mo (−{x.cut_pct}%) · {INR(x.save_year)} a year
            </p>
          </div>
        ))}
        {r.recommendations.length > 5 && (
          <button onClick={() => setShowAll((v) => !v)} className="w-full text-[11px] font-bold text-brand-500 pt-2">
            {showAll ? 'Show fewer' : `Show all ${r.recommendations.length}`}
          </button>
        )}
      </div>

      {t ? (
        <div className="border border-green-200 bg-green-50/50 px-3 py-2.5">
          <p className="text-[10px] font-bold text-green-700 uppercase tracking-widest">Your plan · since {fmtDay(t.started)}</p>
          {t.too_early ? (
            <p className="text-[11px] text-gray-600 mt-1">Started {t.days} day{t.days > 1 ? 's' : ''} ago - give it two weeks before judging.</p>
          ) : (
            <p className="text-sm font-black text-gray-900 mt-1">
              {t.saved_month >= 0 ? `Saving ${INR(t.saved_month)}/mo` : `Spending ${INR(-t.saved_month)}/mo more`}
              <span className="text-[11px] font-bold text-gray-500"> · target {INR(t.target_month)}/mo</span>
            </p>
          )}
          {!t.too_early && t.items.slice(0, 6).map((i) => (
            <p key={i.key} className="text-[11px] text-gray-600">
              {i.title}: {INR(i.actual)}/mo vs {INR(i.baseline)} before
              <span className={i.saved_month >= 0 ? ' text-green-700 font-bold' : ' text-red-600 font-bold'}>
                {' '}{i.saved_month >= 0 ? '−' : '+'}{INR(Math.abs(i.saved_month))}
              </span>
            </p>
          ))}
          <button disabled={busy} onClick={() => togglePlan(false)} className="text-[11px] font-bold text-gray-500 mt-2 disabled:opacity-50">
            {busy ? 'Working…' : 'Stop tracking'}
          </button>
        </div>
      ) : (
        <button disabled={busy || !r.recommendations.length} onClick={() => togglePlan(true)}
          className="btn-primary text-xs py-2.5 disabled:opacity-50">
          {busy ? 'Starting…' : 'Start this plan and track my savings'}
        </button>
      )}
      <p className="text-[10px] text-gray-400 border-t border-dashed border-amber-200 pt-2">
        From your last 12 months - personal spending plus your share of shared. Needs (groceries, rent, bills, health,
        transport) aren't cut, only wants, by an amount that's realistic for each. Advice by {r.advice_by === 'llm' ? 'AI, from category totals only' : 'built-in tips'}.
        {r.computed_at && <> Made {new Date(r.computed_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}, refreshes after {r.refresh_after} new expenses ({r.changes_since} so far).</>}
      </p>
    </div>
  )
}

function Section({ n, tag, q, verdict, tone, children, how }) {
  const tones = { yes: 'bg-brand-50 text-brand-600', no: 'bg-green-50 text-green-700', mixed: 'bg-slate-100 text-slate-600' }
  return (
    <div className="card space-y-2.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Q{n} · {tag}</p>
          <h2 className="text-sm font-bold text-gray-900 leading-snug">{q}</h2>
        </div>
        <span className={`shrink-0 text-[10px] font-black uppercase tracking-wider px-2 py-1 ${tones[tone]}`}>{verdict}</span>
      </div>
      {children}
      <p className="text-[10px] text-gray-400 border-t border-dashed border-amber-200 pt-2">{how}</p>
    </div>
  )
}

/**
 * ML analysis: the Step 4 spending-pattern questions answered on demand
 * from the caller's live data (backend /stats/ml-analysis). Like-for-like:
 * per calendar day, how often x how much, within the same day or month,
 * category mix held equal; ranges are 95% bootstrap intervals. Patterns,
 * not causes. Salary is never used.
 */
export default function MLAnalysis() {
  const nav = useNavigate()
  const [d, setD] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    loadPredictions().catch(() => {})       // start the forecast now, in parallel
    loadRecs().catch(() => {})
    getMLAnalysis().then((r) => setD(r.data)).catch(() => setError('Could not run the analysis. Try again in a moment.'))
  }, [])

  const header = (
    <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream border-b border-amber-100/60">
      <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
      <h1 className="text-xl font-black tracking-tight">ML analysis</h1>
      <p className="text-xs text-gray-500 mt-1 leading-relaxed">
        Your spending patterns, worked out now from your latest data - compared like-for-like, so a time or day
        isn't "worse" just because it has more days or pricier categories. Patterns, not causes. Salary isn't used.
      </p>
    </div>
  )

  if (error) return <div className="pb-24">{header}<p className="px-5 mt-6 text-sm text-red-600">{error}</p></div>
  if (!d) return (
    <div className="pb-24">{header}
      <div className="flex flex-col items-center py-16 gap-3">
        <div className="w-8 h-8 border-[3px] border-brand-400/30 border-t-brand-400 rounded-full animate-spin" />
        <p className="text-xs text-gray-500">Running the analysis on your spending…</p>
      </div>
    </div>
  )
  if (d.empty) return <div className="pb-24">{header}<p className="px-5 mt-6 text-sm text-gray-500">Not enough spending yet.</p></div>

  const tp = d.time_of_day.personal, ts = d.time_of_day.shared
  const wp = d.weekend.personal, ws = d.weekend.shared, wser = d.weekend.series
  const ln = d.late_night_food, ap = d.avg_payment.personal, w = d.wants
  const xmax = Math.max(...ln.months.map((p) => p.x), 1)
  const mx = ln.months.reduce((s, p) => s + p.x, 0) / ln.months.length
  const my = ln.months.reduce((s, p) => s + p.y, 0) / ln.months.length
  const adjTop = [...P].sort((a, b) => ap[b].adjusted - ap[a].adjusted)[0]
  const rawTop = [...P].sort((a, b) => ap[b].raw - ap[a].raw)[0]
  const growers = w.items.filter((x) => x.trend !== null && x.trend > 0).sort((a, b) => b.trend - a.trend).slice(0, 2)

  return (
    <div className="pb-24 md:pb-8">
      {header}
      <div className="px-4 md:px-5 mt-4 space-y-4">
        <Savings />
        <Predictions />

        <p className="text-[10px] text-gray-400">
          Patterns · {d.window[0]} → {d.window[1]} · {d.counts.personal} personal payments, {d.counts.shared} shared (your share)
          {d.computed_at && <> · made {new Date(d.computed_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })},
            refreshes after {d.refresh_after} new expenses ({d.changes_since} so far)</>}
        </p>

        <Section n={1} tag="Time of day" q="Do I spend more at night than early in the day?"
          verdict={tp.Night.per_day > tp.Early.per_day ? 'Yes' : 'No'} tone={tp.Night.per_day > tp.Early.per_day ? 'yes' : 'no'}
          how="Spend per calendar day in each period (Early 1am–11am, Day 11am–6pm, Night 6pm–1am). The gap is measured on the same days.">
          <p className="text-xs text-gray-700 leading-relaxed">
            An average day: <b>{INR(tp.Night.per_day)}</b> at night, <b>{INR(tp.Early.per_day)}</b> early. Same days, Night is
            <b> {INR(d.time_of_day.night_minus_early)}</b> more (range {INR(d.time_of_day.ci[0])}–{INR(d.time_of_day.ci[1])}).
            {' '}It's <b>how often</b>: {(tp.Night.freq / tp.Early.freq).toFixed(1)}× the payments, about the same size each.
          </p>
          <div className="relative h-52">
            <Bar data={{ labels: ['Early', 'Day', 'Night'], datasets: [
              bar({ label: 'Personal, per day', data: P.map((p) => tp[p].per_day), backgroundColor: BRAND }),
              ...(ts ? [bar({ label: 'Shared, per day', data: P.map((p) => ts[p].per_day), backgroundColor: SLATE })] : []),
            ] }} options={base({ plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${INR(c.raw)}` } } } })} />
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            {P.map((p) => (
              <div key={p} className="border border-amber-200 py-1.5">
                <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{p}</p>
                <p className="text-xs font-black text-gray-900">{tp[p].freq.toFixed(2)}/day</p>
                <p className="text-[9px] text-gray-400">avg {INR(tp[p].avg)}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section n={2} tag="Weekends" q="Do weekend days cost more than weekdays?"
          verdict={wp.ci[0] > 0 ? 'Yes' : wp.ci[1] < 0 ? 'No' : 'Not clearly'} tone={wp.ci[0] > 0 ? 'yes' : wp.ci[1] < 0 ? 'no' : 'mixed'}
          how="Each bar is a month: an average weekend day minus an average weekday, that same month. Above zero, weekends were dearer.">
          <p className="text-xs text-gray-700 leading-relaxed">
            Weekend day <b>{INR(wp.weekend_per_day)}</b> vs weekday <b>{INR(wp.weekday_per_day)}</b>, but within each month weekends were dearer in
            only <b>{wp.months_weekend_higher} of {wp.months}</b> (range {INR(wp.ci[0])} to {INR(wp.ci[1])} a day).
            {ws && <> Shared spending: <b>{ws.ci[0] > 0 ? `+${INR(ws.within_month_diff)} a weekend day` : 'no clear difference'}</b>.</>}
          </p>
          <div className="relative h-48">
            <Bar data={{ labels: wser.map((x) => mlabel(x.m)), datasets: [
              bar({ label: 'Weekend minus weekday', data: wser.map((x) => x.diff), backgroundColor: wser.map((x) => (x.diff > 0 ? UP : DOWN)) }),
            ] }} options={base({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.raw >= 0 ? '+' : '−'}${INR(Math.abs(c.raw))} a day` } } },
              x: { ticks: { font: FONT, maxRotation: 0, autoSkip: true, maxTicksLimit: 7 } } })} />
          </div>
        </Section>

        <Section n={3} tag="Late-night food" q="Do late-night food orders raise my food bill?"
          verdict={ln.ci[0] > 0 ? 'Yes' : 'Not clearly'} tone={ln.ci[0] > 0 ? 'yes' : 'mixed'}
          how="Each dot is a month: food payments between 10 pm and 1 am (across) against all food spending that month (up). Dashed line: the fitted trend.">
          <p className="text-xs text-gray-700 leading-relaxed">
            Each extra late-night order in a month goes with <b>{INR(ln.per_order)}</b> more food spending (range {INR(ln.ci[0])}–{INR(ln.ci[1])}).
            {ln.other_per_order > 0 ? ' Other food rises too, so they come on top of regular meals.' : ' Other food dips a little, so they partly replace meals.'}
            {' '}{ln.orders} orders, {INR(ln.amount)}.
          </p>
          <div className="relative h-52">
            <MixedChart type="scatter" data={{ datasets: [
              { type: 'scatter', label: 'Month', data: ln.months.map((p) => ({ x: p.x, y: p.y, m: p.m })), backgroundColor: BRAND, pointRadius: 4 },
              { type: 'line', label: 'Trend', data: [{ x: 0, y: my - ln.per_order * mx }, { x: xmax, y: my + ln.per_order * (xmax - mx) }],
                borderColor: SLATE, borderWidth: 2, borderDash: [5, 4], pointRadius: 0 },
            ] }} options={base({
              x: { type: 'linear', grid: { color: '#f1f5f9' }, ticks: { font: FONT, precision: 0 }, title: { display: true, text: 'late-night food orders', font: FONT } },
              y: { title: { display: true, text: 'food spending that month', font: FONT } },
              plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => (c.raw.m ? ` ${mlabel(c.raw.m)}: ${c.raw.x} orders, ${INR(c.raw.y)}` : '') } } },
            })} />
          </div>
        </Section>

        <Section n={4} tag="Payment size" q="Which time of day has the biggest average payment?"
          verdict={adjTop} tone="mixed"
          how="'Same category mix' holds the mix of categories equal across periods, so a period isn't expensive only because of what's bought then.">
          <p className="text-xs text-gray-700 leading-relaxed">
            Raw, <b>{rawTop}</b> payments are biggest ({INR(ap[rawTop].raw)}). Like-for-like, <b>{adjTop}</b> is ({INR(ap[adjTop].adjusted)})
            {rawTop !== adjTop ? `; ${rawTop}'s raw lead comes from what gets bought then.` : '.'}
          </p>
          <div className="relative h-48">
            <Bar data={{ labels: P, datasets: [
              bar({ label: 'Raw average', data: P.map((p) => ap[p].raw), backgroundColor: SOFT }),
              bar({ label: 'Same category mix', data: P.map((p) => ap[p].adjusted), backgroundColor: BRAND }),
            ] }} options={base({ y: { beginAtZero: true }, plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${INR(c.raw)}` } } } })} />
          </div>
        </Section>

        <Section n={5} tag="Wants" q="Which categories make up most of the unnecessary spending?"
          verdict={w.items[0]?.k || '—'} tone="yes"
          how="Unnecessary = discretionary wants: eating out and delivery, alcohol, tobacco, entertainment, non-essential shopping. Trend: last 6 months vs the 6 before.">
          <p className="text-xs text-gray-700 leading-relaxed">
            Wants came to <b>{INR(w.total)}</b>, <b>{w.share}%</b> of your personal spending. <b>{w.items[0]?.k}</b> is the largest
            {growers.length > 0 && <>; growing fastest: {growers.map((x) => `${x.k} (+${x.trend}%)`).join(', ')}</>}.
          </p>
          <div className="relative h-72">
            <Bar data={{ labels: w.items.map((x) => `${x.k}${x.trend === null ? '' : `  ${x.trend > 0 ? '▲' : '▼'}${Math.abs(x.trend)}%`}`), datasets: [
              bar({ label: 'Since 2024', data: w.items.map((x) => x.amt), backgroundColor: w.items.map((x) => (x.trend > 0 ? BRAND : SOFT)) }),
            ] }} options={base({ top: { indexAxis: 'y' },
              x: { grid: { color: '#f1f5f9' }, ticks: { font: FONT, callback: (v) => K(v) } },
              y: { grid: { display: false }, ticks: { font: { ...FONT, size: 10.5 }, callback: function (v) { return this.getLabelForValue(v) } } },
              plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${INR(c.raw)} · ${w.items[c.dataIndex].n} payments` } } } })} />
          </div>
        </Section>
      </div>
    </div>
  )
}
