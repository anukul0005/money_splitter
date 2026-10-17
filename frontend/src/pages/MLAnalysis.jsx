import { useEffect, useState } from 'react'
import { hasFullAccess, useUser } from '../UserContext'
import { useNavigate } from 'react-router-dom'
import { Bar, Chart as MixedChart } from 'react-chartjs-2'
import { getMLAnalysis } from '../api'
import { INR, K, mlabel, P, BRAND, SLATE, SOFT, UP, DOWN, FONT, base, bar } from '../components/insights/kit'

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
  const user = useUser()
  const nav = useNavigate()
  const [d, setD] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
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
        <button onClick={() => nav('/insights')}
          className="w-full text-left text-[11px] text-gray-600 border border-amber-200 bg-amber-50/60 px-3 py-2">
          Totals, forecasts, unusual spending and ways to save are on <b className="text-brand-500">Spending insights ›</b>
        </button>

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
          how={`Unnecessary = discretionary wants: eating out and delivery, ${hasFullAccess(user) ? 'alcohol, ' : ''}tobacco, entertainment, non-essential shopping. Trend: last 6 months vs the 6 before.`}>
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
