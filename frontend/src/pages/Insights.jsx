import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bar, Chart as MixedChart } from 'react-chartjs-2'
import { getInsights, getInsightsVersion, getPredictions, getRecommendations } from '../api'
import {
  INR, K, mlabel, fmtDay, fmtShort, fmtWhen, BRAND, SLATE, SOFT, UP, FONT, base, bar, RangeBar, CardSpinner, Label,
} from '../components/insights/kit'
import Savings from '../components/insights/Savings'

const POLL_MS = 45 * 1000

// ▲ / ▼ against the usual amount by the same point.
function Delta({ amount, usual }) {
  if (!usual) return null
  const pct = Math.round((amount - usual) / usual * 100)
  if (Math.abs(pct) < 10) return <span className="text-[10px] font-bold text-gray-400">about usual</span>
  return (
    <span className={`text-[10px] font-black ${pct > 0 ? 'text-red-600' : 'text-green-700'}`}>
      {pct > 0 ? '▲' : '▼'} {Math.abs(pct)}% vs usual
    </span>
  )
}

function Tile({ label, sub, t, extra }) {
  return (
    <div className="border border-amber-200 px-3 py-2.5">
      <Label>{label}</Label>
      <p className="text-[10px] text-gray-400">{sub}</p>
      <p className="text-lg font-black text-gray-900 mt-1">{INR(t.amount)}</p>
      <Delta amount={t.amount} usual={t.usual} />
      <p className="text-[10px] text-gray-400 mt-0.5">usual by now {INR(t.usual)}</p>
      {t.amount > 0 && t.amount !== t.personal && (
        <p className="text-[10px] text-gray-400">you {INR(t.personal)} · shared {INR(t.amount - t.personal)}</p>
      )}
      {extra}
    </div>
  )
}

// 1. Daily / weekly / monthly totals, and the last 30 days.
function SummaryCard({ d }) {
  const s = d.summary
  const over = (x) => x.amount > d.threshold
  return (
    <div className="card space-y-3">
      <div>
        <Label>Spending summary</Label>
        <p className="text-[10px] text-gray-400 mt-0.5">Personal plus your share of shared · each compared with the usual amount by the same point</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Tile label="Today" sub={fmtDay(s.today.date)} t={s.today} />
        <Tile label="Yesterday" sub={fmtDay(s.yesterday.date)} t={s.yesterday} />
        <Tile label="This week" sub={`since ${fmtShort(s.week.from)}`} t={s.week} />
        <Tile label="This month" sub={`day ${s.month.day} of ${s.month.days}`} t={s.month}
          extra={<p className="text-[10px] font-bold text-gray-600 mt-0.5">on pace for {INR(s.month.projected)}</p>} />
      </div>
      <div>
        <Label className="mb-1">Last 30 days</Label>
        <div className="relative h-40">
          <MixedChart type="bar" data={{
            labels: d.daily.map((x) => fmtShort(x.d)),
            datasets: [
              bar({ label: 'You', data: d.daily.map((x) => x.personal), backgroundColor: d.daily.map((x) => (over(x) ? UP : BRAND)), stack: 's' }),
              bar({ label: 'Shared', data: d.daily.map((x) => x.amount - x.personal), backgroundColor: d.daily.map((x) => (over(x) ? '#7f1d1d' : SLATE)), stack: 's' }),
              { type: 'line', label: `Unusual above ${K(d.threshold)}`, data: d.daily.map(() => d.threshold),
                borderColor: UP, borderWidth: 1, borderDash: [4, 3], pointRadius: 0 },
            ],
          }} options={base({
            x: { stacked: true, ticks: { font: FONT, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 } },
            y: { stacked: true, beginAtZero: true },
            plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${INR(c.raw)}` } } },
          })} />
        </div>
        <p className="text-[10px] text-gray-400 mt-1">Red: days above your usual top 10% ({INR(d.threshold)}+).</p>
      </div>
    </div>
  )
}

// 2. What's likely next (Step 5 forecast, personal spending).
function ForecastCard({ p, err, onRetrain, retraining }) {
  const [showCats, setShowCats] = useState(false)
  if (err) return <div className="card text-xs text-red-600">{err}</div>
  if (!p) return <CardSpinner text="Training the forecast on your spending…" />
  const usable = p.categories.filter((c) => !c.unpredictable)
  const catMax = Math.max(...usable.map((c) => c.high), 1)
  const vsTypical = Math.round((p.next_7_days.likely - p.typical_week) / p.typical_week * 100)
  return (
    <div className="card space-y-3">
      <div>
        <Label>Predictions</Label>
        <p className="text-[10px] text-gray-400 mt-0.5">Personal spending · bar = {p.coverage}% likely range, black line = most likely</p>
      </div>
      {p.days_since_data > 2 && (
        <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 px-2.5 py-2">
          Your personal spending runs to <b>{fmtDay(p.data_until)}</b>, so the forecast starts the day after.
          Import your latest PhonePe or Google Pay statement for an up-to-date one.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {[['Next day', fmtDay(p.next_day.date), p.next_day],
          ['Next 7 days', `${fmtShort(p.next_7_days.from)} – ${fmtShort(p.next_7_days.to)}`, p.next_7_days]]
          .map(([label, when, f]) => (
            <div key={label} className="border border-amber-200 px-3 py-2.5">
              <Label>{label}</Label>
              <p className="text-[10px] text-gray-400">{when}</p>
              <p className="text-lg font-black text-gray-900 mt-1">{INR(f.likely)}</p>
              <RangeBar low={f.low} likely={f.likely} high={f.high} max={Math.max(f.high, 1)} />
              <p className="text-[10px] text-gray-500 mt-1">{INR(f.low)} – {INR(f.high)}</p>
            </div>
          ))}
      </div>
      <p className="text-[11px] text-gray-600">
        A typical week lately: {INR(p.typical_week)}; the next 7 days look
        {Math.abs(vsTypical) < 10 ? ' about the same.' : vsTypical > 0 ? ` ${vsTypical}% higher.` : ` ${Math.abs(vsTypical)}% lower.`}
      </p>
      <button onClick={() => setShowCats((v) => !v)} className="text-[11px] font-bold text-brand-500">
        {showCats ? 'Hide categories' : 'Next 7 days by category ›'}
      </button>
      {showCats && p.categories.map((c) => (
        <div key={c.category} className="py-1.5 border-b border-amber-100 last:border-0">
          <div className="flex justify-between gap-2 text-xs">
            <span className="font-bold text-gray-800">{c.category}</span>
            <span className="font-black text-gray-900">{INR(c.likely)}</span>
          </div>
          {c.unpredictable ? (
            <p className="text-[10px] text-gray-400 mt-0.5">Usually around {INR(c.likely)}, but occasional big purchases make it hard to predict.</p>
          ) : (
            <>
              <RangeBar low={c.low} likely={c.likely} high={c.high} max={catMax} />
              <p className="text-[10px] text-gray-400 mt-1">{INR(c.low)} – {INR(c.high)}</p>
            </>
          )}
        </div>
      ))}
      <p className="text-[10px] text-gray-400 border-t border-dashed border-amber-200 pt-2">
        Best model per forecast from testing on your past months (gradient boosting, random forest or a recent-weeks baseline).
        {p.computed_at && <> Trained {fmtWhen(p.computed_at)}; retrains after {p.refresh_after} new expenses ({p.changes_since} so far). </>}
        <button disabled={retraining} onClick={onRetrain} className="font-bold text-brand-500 disabled:opacity-50">
          {retraining ? 'Retraining…' : 'Retrain now'}
        </button>
      </p>
    </div>
  )
}

// 3. By category, time of day and weekday, over a chosen window.
const WINDOWS = [['30', '30 days'], ['90', '90 days'], ['365', '12 months']]
function PatternsCard({ patterns }) {
  const [win, setWin] = useState('90')
  const pt = patterns[win]
  const cats = pt.categories
  const maxWd = Math.max(...pt.weekdays.map((w) => w.per_day))
  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <Label>Spending patterns</Label>
          <p className="text-[11px] text-gray-600 mt-0.5">{INR(pt.total)} in {WINDOWS.find((w) => w[0] === win)[1]} · {INR(pt.per_day)} a day</p>
        </div>
        <div className="flex border border-amber-200 shrink-0">
          {WINDOWS.map(([k, l]) => (
            <button key={k} onClick={() => setWin(k)}
              className={`px-2 py-1 text-[10px] font-bold ${win === k ? 'bg-brand-400 text-white' : 'text-gray-500'}`}>{l}</button>
          ))}
        </div>
      </div>

      <div>
        <Label className="mb-1">By category</Label>
        <div className="relative" style={{ height: `${cats.length * 26 + 20}px` }}>
          <Bar data={{ labels: cats.map((c) => `${c.name}  ${c.share}%`), datasets: [
            bar({ data: cats.map((c) => c.amount), backgroundColor: cats.map((c) => (c.name === 'Everything else' ? SOFT : BRAND)) }),
          ] }} options={base({ top: { indexAxis: 'y' },
            x: { grid: { color: '#f1f5f9' }, beginAtZero: true, ticks: { font: FONT, callback: (v) => K(v) } },
            y: { grid: { display: false }, ticks: { font: { ...FONT, size: 10.5 }, callback: function (v) { return this.getLabelForValue(v) } } },
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${INR(c.raw)}` } } } })} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label className="mb-1">Time of day · per day</Label>
          <div className="relative h-36">
            <Bar data={{ labels: pt.periods.map((x) => `${x.name} ${x.share}%`), datasets: [
              bar({ data: pt.periods.map((x) => x.per_day), backgroundColor: [SOFT, BRAND, SLATE] }),
            ] }} options={base({ y: { beginAtZero: true }, plugins: { legend: { display: false },
              tooltip: { callbacks: { label: (c) => ` ${INR(c.raw)} a day` } } } })} />
          </div>
          <p className="text-[10px] text-gray-400">Early 1–11 am · Day 11 am–6 pm · Night 6 pm–1 am{pt.untimed > 0 && ` · ${INR(pt.untimed)} has no time`}</p>
        </div>
        <div>
          <Label className="mb-1">Weekday · average day</Label>
          <div className="relative h-36">
            <Bar data={{ labels: pt.weekdays.map((w) => w.day), datasets: [
              bar({ data: pt.weekdays.map((w) => w.per_day), backgroundColor: pt.weekdays.map((w) => (w.per_day === maxWd ? BRAND : SOFT)) }),
            ] }} options={base({ y: { beginAtZero: true }, plugins: { legend: { display: false },
              tooltip: { callbacks: { label: (c) => ` ${INR(c.raw)} on an average ${c.label}` } } } })} />
          </div>
        </div>
      </div>
    </div>
  )
}

// 4. Unusual: categories well above their normal, and expensive days.
function UnusualCard({ u, threshold }) {
  const fewer = u.days.length <= u.expected_days
  return (
    <div className="card space-y-3">
      <div>
        <Label>Unusual spending · last 30 days</Label>
        <p className="text-[10px] text-gray-400 mt-0.5">Against your own normal over the 11 months before</p>
      </div>
      {u.categories.length === 0 ? (
        <p className="text-[11px] text-gray-600">No category is running unusually high.</p>
      ) : u.categories.map((c) => (
        <div key={c.category} className="border-l-2 border-red-500 pl-2.5 py-0.5">
          <p className="text-xs font-bold text-gray-900">
            <span className="text-red-600 font-black">▲ {c.up_pct != null ? `${c.up_pct}%` : 'new'}</span> {c.category}
            {c.driver && <span className="font-normal text-gray-500"> · mostly {c.driver}</span>}
          </p>
          <p className="text-[11px] text-gray-600">{INR(c.recent_30)} vs usual {INR(c.normal_30)} for 30 days</p>
          <p className="text-[10px] text-gray-400">Biggest: {c.biggest.title} {INR(c.biggest.amount)} on {fmtShort(c.biggest.date)}</p>
        </div>
      ))}
      <div>
        <Label className="mb-1">
          Expensive days · {u.days.length} above {INR(threshold)} {fewer ? `(about ${u.expected_days} is normal)` : `(usually about ${u.expected_days})`}
        </Label>
        {u.days.length === 0 && <p className="text-[11px] text-gray-600">None in the last 30 days.</p>}
        {u.days.map((d) => (
          <div key={d.date} className="py-1.5 border-b border-amber-100 last:border-0">
            <div className="flex justify-between text-xs">
              <span className="font-bold text-gray-800">{fmtDay(d.date)}</span>
              <span className="font-black text-red-600">{INR(d.amount)} <span className="text-[10px] text-gray-400 font-bold">{d.times}×</span></span>
            </div>
            <p className="text-[10px] text-gray-500 leading-snug">
              {d.top.map((x) => `${x.title} ${INR(x.amount)}${x.shared ? ' (shared)' : ''}`).join(' · ')}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

// 6. Progress: against previous months, budgets and the forecast.
function ProgressCard({ d }) {
  const { months, budgets, forecast } = d.progress
  const m = d.summary.month
  const cur = months[months.length - 1]
  const checks = forecast?.checks ?? []
  const hits = checks.filter((c) => c.actual >= c.low && c.actual <= c.high).length
  const checkMax = Math.max(...checks.map((c) => Math.max(c.high, c.actual)), 1)
  const wk = forecast?.week
  return (
    <div className="card space-y-4">
      <Label>Your progress</Label>

      <div>
        <p className="text-xs font-bold text-gray-900">Against previous months</p>
        <p className="text-[11px] text-gray-600 mt-0.5">
          By day {m.day}: <b>{INR(m.amount)}</b> vs <b>{INR(m.last_month)}</b> last month and <b>{INR(m.usual)}</b> usually
          (6-month average) - <span className={m.amount <= m.usual ? 'text-green-700 font-bold' : 'text-red-600 font-bold'}>
            {m.amount <= m.usual ? `${INR(m.usual - m.amount)} under` : `${INR(m.amount - m.usual)} over`}</span>.
        </p>
        <div className="relative h-40 mt-1">
          <Bar data={{ labels: months.map((x) => mlabel(x.m)), datasets: [
            bar({ label: 'Spent', data: months.map((x) => x.amount), backgroundColor: months.map((x) => (x.current ? BRAND : SLATE)), stack: 's' }),
            bar({ label: 'Rest of month, at your recent pace', data: months.map((x) => (x.current ? Math.max(x.projected - x.amount, 0) : 0)),
              backgroundColor: '#fed7aa', stack: 's' }),
          ] }} options={base({ x: { stacked: true }, y: { stacked: true, beginAtZero: true },
            plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${INR(c.raw)}` } } } })} />
        </div>
        <p className="text-[10px] text-gray-400">This month on pace for {INR(cur.projected)}.</p>
      </div>

      {budgets && (
        <div>
          <p className="text-xs font-bold text-gray-900">
            Against {budgets.source === 'plan' ? 'your savings plan' : 'the suggested budgets'}
          </p>
          <p className="text-[11px] text-gray-600 mt-0.5">
            Month so far <b>{INR(budgets.overall.so_far)}</b>; by day {m.day} a {INR(budgets.overall.budget)} month allows
            <b> {INR(budgets.overall.pace)}</b> - <span className={budgets.overall.so_far <= budgets.overall.pace ? 'text-green-700 font-bold' : 'text-red-600 font-bold'}>
              {budgets.overall.so_far <= budgets.overall.pace ? 'on track' : 'ahead of budget'}</span>.
          </p>
          <div className="mt-1.5">
            {budgets.items.map((b) => {
              const over = b.so_far > b.pace
              const max = Math.max(b.budget, b.so_far, 1)
              return (
                <div key={b.key} className="py-1">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-gray-700">{b.title}</span>
                    <span className={over ? 'text-red-600 font-bold' : 'text-gray-600'}>{INR(b.so_far)} <span className="text-gray-400 font-normal">/ {INR(b.budget)}</span></span>
                  </div>
                  <div className="relative h-1.5 bg-amber-100 mt-0.5">
                    <div className={`absolute top-0 h-1.5 ${over ? 'bg-red-500' : 'bg-green-600'}`} style={{ width: `${Math.min(b.so_far / max, 1) * 100}%` }} />
                    <div className="absolute -top-0.5 h-2.5 w-0.5 bg-gray-900" style={{ left: `${Math.min(b.pace / max, 1) * 100}%` }} title="Where the budget should be by today" />
                  </div>
                </div>
              )
            })}
          </div>
          <p className="text-[10px] text-gray-400 mt-1">Black tick: where each budget should be by today. {budgets.source === 'suggested' && 'Start the savings plan above to make these your own.'}</p>
        </div>
      )}

      {forecast && (
        <div>
          <p className="text-xs font-bold text-gray-900">Against the predictions</p>
          {wk && (
            wk.days_in > 0 ? (
              <p className="text-[11px] text-gray-600 mt-0.5">
                {fmtShort(wk.from)} – {fmtShort(wk.to)}: <b>{INR(wk.spent)}</b> in {wk.days_in} of 7 days, against a likely
                <b> {INR(wk.likely)}</b> for the week ({INR(wk.low)}–{INR(wk.high)}).
              </p>
            ) : (
              <p className="text-[11px] text-gray-600 mt-0.5">
                Current forecast week {fmtShort(wk.from)} – {fmtShort(wk.to)}: waiting for your spending from {fmtShort(wk.from)} to come in.
              </p>
            )
          )}
          {checks.length > 0 && (
            <>
              <p className="text-[11px] text-gray-600 mt-1.5">
                The last {checks.length} weeks, each predicted using only the weeks before it:
                <b> {hits} of {checks.length}</b> landed inside the range.
              </p>
              {checks.map((c) => {
                const inside = c.actual >= c.low && c.actual <= c.high
                return (
                  <div key={c.from} className="py-1">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-gray-700">{fmtShort(c.from)} – {fmtShort(c.to)}</span>
                      <span>
                        <span className="text-gray-500">expected {INR(c.likely)} · </span>
                        <b className={inside ? 'text-green-700' : 'text-red-600'}>spent {INR(c.actual)}</b>
                      </span>
                    </div>
                    <RangeBar low={c.low} likely={c.likely} high={c.high} max={checkMax} actual={c.actual} />
                  </div>
                )
              })}
              <p className="text-[10px] text-gray-400 mt-1">Bar: predicted range · black: expected · green: actually spent. Personal spending.</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Spending insights dashboard (Step 7). The summary, patterns, unusual
 * spending and progress are worked out live (/stats/insights); the forecast
 * and savings come from their saved results, which retrain after 5 new
 * expenses. While the page is open it checks every 45s (and whenever the
 * app comes back to the front) whether any transaction changed, and
 * refreshes when one has.
 */
export default function Insights() {
  const nav = useNavigate()
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  const [preds, setPreds] = useState(null)
  const [predErr, setPredErr] = useState('')
  const [recs, setRecs] = useState(null)
  const [retraining, setRetraining] = useState(false)
  const [status, setStatus] = useState('')
  const sig = useRef(null)

  const loadModels = useCallback((force = false) => {
    getPredictions(force).then((r) => { setPreds(r.data); setPredErr('') })
      .catch((e) => setPredErr(e.response?.data?.detail || 'Could not make a forecast just now.'))
    getRecommendations(force).then((r) => setRecs(r.data)).catch(() => setRecs({ error: true }))
  }, [])

  const loadInsights = useCallback(async (why) => {
    try {
      const r = await getInsights()
      setD(r.data); setErr('')
      sig.current = r.data.signature
      setStatus(why || '')
      return r.data
    } catch {
      setErr('Could not load your insights. Try again in a moment.')
    }
  }, [])

  useEffect(() => {
    loadInsights()
    loadModels()
  }, [loadInsights, loadModels])

  // New transactions: a cheap signature check, then a full refresh.
  useEffect(() => {
    let busy = false
    const check = async () => {
      if (busy || document.visibilityState !== 'visible' || sig.current == null) return
      busy = true
      try {
        const r = await getInsightsVersion()
        if (r.data.signature !== sig.current) {
          await loadInsights('New transactions picked up')
          loadModels()
        }
      } catch { /* offline - try again next time */ } finally { busy = false }
    }
    const t = setInterval(check, POLL_MS)
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check) }
  }, [loadInsights, loadModels])

  const retrain = async () => {
    setRetraining(true)
    try { setPreds((await getPredictions(true)).data) } catch { setPredErr('Could not retrain just now.') }
    await loadInsights('Forecast retrained')
    setRetraining(false)
  }

  const lag = d && !d.empty && d.personal_until < d.summary.yesterday.date
  const header = (
    <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream border-b border-amber-100/60">
      <div className="flex items-start justify-between gap-3">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <button onClick={() => nav('/ml-analysis')} className="text-[11px] font-bold text-brand-500">Pattern deep-dive ›</button>
      </div>
      <h1 className="text-xl font-black tracking-tight">Spending insights</h1>
      {d && !d.empty && (
        <p className="text-[11px] text-gray-500 mt-1">
          Live · updated {fmtWhen(d.built_at)}{status && <span className="text-green-700 font-bold"> · {status}</span>}
          {' · '}<button onClick={() => { loadInsights('Refreshed'); loadModels() }} className="font-bold text-brand-500">Refresh</button>
        </p>
      )}
    </div>
  )

  if (err && !d) return <div className="pb-24">{header}<p className="px-5 mt-6 text-sm text-red-600">{err}</p></div>
  if (!d) return (
    <div className="pb-24">{header}
      <div className="flex flex-col items-center py-16 gap-3">
        <div className="w-8 h-8 border-[3px] border-brand-400/30 border-t-brand-400 rounded-full animate-spin" />
        <p className="text-xs text-gray-500">Adding up your spending…</p>
      </div>
    </div>
  )
  if (d.empty) return <div className="pb-24">{header}<p className="px-5 mt-6 text-sm text-gray-500">Not enough spending yet.</p></div>

  return (
    <div className="pb-24 md:pb-8">
      {header}
      <div className="px-4 md:px-5 mt-4 space-y-4">
        {lag && (
          <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2">
            Your personal spending runs to <b>{fmtDay(d.personal_until)}</b>. Import your latest PhonePe or Google Pay statement to bring
            today and this week up to date - everything here updates on its own once it's in.
          </p>
        )}
        <SummaryCard d={d} />
        <ForecastCard p={preds} err={predErr} onRetrain={retrain} retraining={retraining} />
        <PatternsCard patterns={d.patterns} />
        <UnusualCard u={d.unusual} threshold={d.threshold} />
        {!recs ? <CardSpinner text="Finding ways to save…" />
          : recs.error ? <div className="card text-xs text-red-600">Could not work out savings just now.</div>
          : <Savings r={recs} onChange={(r) => { setRecs(r); loadInsights('Plan updated') }} />}
        <ProgressCard d={d} />
      </div>
    </div>
  )
}
