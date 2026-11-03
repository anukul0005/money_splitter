import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Chart, BarElement, BarController, LineElement, LineController, PointElement,
  CategoryScale, LinearScale, Tooltip,
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import { getSalaryDashboard, addInvestment, editInvestment, deleteInvestment, getSalaryItems, setCardSkip } from '../api/index.js'
import LoadingSpinner from '../components/LoadingSpinner'

Chart.register(BarElement, BarController, LineElement, LineController, PointElement, CategoryScale, LinearScale, Tooltip)

const INR = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const compactINR = (v) =>
  Math.abs(v) >= 100000 ? `₹${(v / 100000).toFixed(1).replace(/\.0$/, '')}L`
    : Math.abs(v) >= 1000 ? `₹${Math.round(v / 1000)}k` : `₹${Math.round(v)}`
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ymLabel = (ym) => `${MON[+ym.slice(5, 7) - 1]} '${ym.slice(2, 4)}`
const ymLong = (ym) => `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`
const pct = (v, of) => (of > 0 ? Math.round((v / of) * 100) : 0)
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`

// routers/salary.py's NEEDS, for a server that doesn't send its list yet.
const NEEDS_FALLBACK = ['Bills & Utilities', 'Education', 'Groceries', 'Health', 'Housing', 'Loan repayments', 'Transport']
const SPENT = '#f97316'
const INVEST = '#16a34a'
const LEFT = '#cbd5e1'
const OVER = '#ef4444'
const TICK_FONT = { size: 10, family: "Num, 'IBM Plex Sans', system-ui, sans-serif" }

const SOURCES = [
  { key: 'monthly',    label: 'Monthly expenses',    note: 'your own spending', to: '/groups/monthly', color: '#f97316' },
  { key: 'groups',     label: 'Groups',              note: 'your share',        to: '/history',        color: '#3b82f6' },
  { key: 'cards',      label: 'Credit cards',        note: 'not already in the app', to: '/loans?tab=cards', color: '#a855f7' },
  { key: 'recurring',  label: 'Recurring bills',     note: 'your share',        to: '/loans',          color: '#0ea5e9' },
  { key: 'repayments', label: 'Loan repayments',     note: 'you paid back',     to: '/loans',          color: '#64748b' },
]

/** The day this month's salary lands, from the Account page's setting. */
function payday(year, month0, day) {
  const last = new Date(year, month0 + 1, 0)
  if (day === 'last') return last
  if (day === 'last_working') {
    const d = new Date(last)
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1)
    return d
  }
  const n = parseInt(day, 10)
  if (!n) return null
  return new Date(year, month0, Math.min(n, last.getDate()))
}

/**
 * Salary dashboard: a month's pay against where it went - spent (monthly
 * expenses, group shares, card spends not entered already, recurring bills,
 * loan repayments), invested (from statements, plus what's added by hand
 * here), and what's left. Opened from History's ₹ icon.
 */
export default function SalaryDashboard() {
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [noSalary, setNoSalary] = useState(false)
  const [editing, setEditing] = useState(null)   // a manual investment being edited, or {} for a new one

  const load = async () => {
    setError('')
    try {
      setData((await getSalaryDashboard(12)).data)
    } catch (err) {
      if (err.response?.data?.detail?.code === 'no_salary') setNoSalary(true)
      else setError('Could not reach server. The API may be waking up — please try again in 30 seconds.')
    }
  }
  useEffect(() => { load() }, [])

  const ym = params.get('m') && data?.months.includes(params.get('m')) ? params.get('m') : data?.months[data.months.length - 1]
  const setYm = (m) => setParams((p) => { const n = new URLSearchParams(p); n.set('m', m); return n }, { replace: true })

  const view = useMemo(() => {
    if (!data || !ym) return null
    const salary = data.salary
    const mo = data.by_month[ym]
    const left = salary - mo.spent - mo.invested
    const done = data.months.filter((m) => m !== data.months[data.months.length - 1])
    const avg = (f) => (done.length ? done.reduce((s, m) => s + f(data.by_month[m]), 0) / done.length : null)
    return {
      salary, mo, left,
      wants: Math.max(0, mo.spent - mo.needs),
      avgSpent: avg((x) => x.spent),
      avgInvested: avg((x) => x.invested),
      isCurrent: ym === data.months[data.months.length - 1],
    }
  }, [data, ym])

  if (noSalary) return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center">
      <p className="text-4xl mb-3">💼</p>
      <p className="text-sm font-bold text-gray-800">Add your salary to see this dashboard</p>
      <p className="text-xs text-gray-500 mt-1 mb-4">Your monthly pay and the day it lands - on the Account page.</p>
      <button onClick={() => nav('/account')} className="btn-primary text-sm">Go to Account</button>
    </div>
  )
  if (error) return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-5 text-center">
      <p className="text-4xl mb-3">😴</p>
      <p className="text-sm text-gray-600 mb-4">{error}</p>
      <button onClick={load} className="bg-brand-400 text-white px-5 py-2 text-sm font-bold shadow-md">Retry</button>
    </div>
  )
  if (!view) return <LoadingSpinner />

  const { salary, mo, left } = view
  const i = data.months.indexOf(ym)
  const over = left < 0

  // ── this month so far: what's left per day, and when pay comes ──
  let today = null
  if (view.isCurrent) {
    const t = new Date(data.today)
    const end = new Date(t.getFullYear(), t.getMonth() + 1, 0)
    const daysLeft = end.getDate() - t.getDate() + 1
    let next = payday(t.getFullYear(), t.getMonth(), data.salary_day)
    if (next && next < new Date(t.getFullYear(), t.getMonth(), t.getDate())) next = payday(t.getFullYear(), t.getMonth() + 1, data.salary_day)
    const toPay = next ? Math.round((next - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000) : null
    today = { daysLeft, perDay: left / daysLeft, next, toPay }
  }

  // ── trend ──
  const trend = data.months.map((m) => {
    const x = data.by_month[m]
    return { m, spent: x.spent, invested: x.invested, left: Math.max(0, salary - x.spent - x.invested) }
  })
  const chartData = {
    labels: trend.map((x) => ymLabel(x.m)),
    datasets: [
      { type: 'bar', label: 'Spent', data: trend.map((x) => x.spent), backgroundColor: trend.map((x) => (x.m === ym ? SPENT : `${SPENT}99`)), stack: 's' },
      { type: 'bar', label: 'Invested', data: trend.map((x) => x.invested), backgroundColor: trend.map((x) => (x.m === ym ? INVEST : `${INVEST}99`)), stack: 's' },
      { type: 'bar', label: 'Left', data: trend.map((x) => x.left), backgroundColor: LEFT, stack: 's' },
      { type: 'line', label: 'Salary', data: trend.map(() => salary), borderColor: '#334155', borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, stack: 'line' },
    ],
  }
  const chartOptions = {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (c) => ` ${c.dataset.label}: ${INR(c.raw)}${c.dataset.type === 'bar' ? ` (${pct(c.raw, salary)}%)` : ''}`,
        },
      },
    },
    scales: {
      x: { stacked: true, grid: { display: false }, ticks: { font: TICK_FONT, maxRotation: 0, autoSkip: true } },
      y: { stacked: true, beginAtZero: true, ticks: { font: TICK_FONT, maxTicksLimit: 5, callback: (v) => compactINR(v) }, grid: { color: '#f1f5f9' }, border: { display: false } },
    },
    onClick: (_, els) => { if (els.length) setYm(trend[els[0].index].m) },
    onHover: (evt, els) => { if (evt.native) evt.native.target.style.cursor = els.length ? 'pointer' : 'default' },
  }
  const savingRates = trend.slice(0, -1).filter((x) => x.spent + x.invested > 0).map((x) => pct(x.invested, salary))
  const avgRate = savingRates.length ? Math.round(savingRates.reduce((a, b) => a + b, 0) / savingRates.length) : null

  // ── investments in this month ──
  const autoInv = data.investments.auto.filter((x) => x.date.slice(0, 7) === ym)
  const manualInv = data.investments.manual.filter((r) => (r.recurring ? r.month <= ym && (!r.end_month || ym <= r.end_month) : r.month === ym))
  const maxCat = Math.max(1, ...Object.values(mo.cats))

  const sum = mo.spent + mo.invested
  const bar = over
    ? [{ k: 'Spent', v: mo.spent, c: SPENT }, { k: 'Invested', v: mo.invested, c: INVEST }]
    : [{ k: 'Spent', v: mo.spent, c: SPENT }, { k: 'Invested', v: mo.invested, c: INVEST }, { k: 'Left', v: left, c: LEFT }]
  const barTotal = over ? sum : salary

  return (
    <div className="pb-24 md:pb-8">
      {/* Header: the month, the pay */}
      <div className="bg-gradient-to-br from-field-800 to-field-950 text-white px-5 pt-10 md:pt-8 pb-5 border-b border-field-700">
        <div className="flex items-center justify-between gap-3">
          <button onClick={() => nav('/history')} className="text-slate-300/70 text-xs font-bold">‹ History</button>
          <p className="text-brand-400/70 text-xs font-bold uppercase tracking-widest">Salary dashboard</p>
        </div>
        <div className="flex items-center justify-between mt-4">
          <button disabled={i <= 0} onClick={() => setYm(data.months[i - 1])}
            className="w-8 h-8 border border-field-700 text-lg disabled:opacity-30" aria-label="Previous month">‹</button>
          <div className="text-center">
            <p className="text-sm font-bold">{ymLong(ym)}{view.isCurrent ? ' · so far' : ''}</p>
            <p className="text-3xl font-black tracking-tight mt-0.5">{INR(salary)}</p>
            <p className="text-slate-300/60 text-[11px]">monthly salary
              {data.salary_day && <> · credited {data.salary_day === 'last' ? 'on the last day' : data.salary_day === 'last_working' ? 'on the last working day' : `on the ${ordinal(+data.salary_day)}`}</>}
            </p>
          </div>
          <button disabled={i >= data.months.length - 1} onClick={() => setYm(data.months[i + 1])}
            className="w-8 h-8 border border-field-700 text-lg disabled:opacity-30" aria-label="Next month">›</button>
        </div>

        {/* The pay, split three ways */}
        <div className="flex h-3 w-full overflow-hidden mt-4 bg-field-700">
          {bar.filter((b) => b.v > 0).map((b) => (
            <div key={b.k} style={{ width: `${(b.v / barTotal) * 100}%`, background: b.k === 'Left' ? '#475569' : b.c }} title={`${b.k}: ${INR(b.v)}`} />
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2 mt-3 text-center">
          <HeadStat label="Utilised" value={INR(mo.spent)} sub={`${pct(mo.spent, salary)}% of pay`} color="text-orange-300" />
          <HeadStat label="Invested" value={INR(mo.invested)} sub={`${pct(mo.invested, salary)}% of pay`} color="text-green-300" />
          {over
            ? <HeadStat label="Over by" value={INR(-left)} sub="more than the salary" color="text-red-300" />
            : <HeadStat label={view.isCurrent ? 'Left so far' : 'Left over'} value={INR(left)} sub={`${pct(left, salary)}% of pay`} color="text-white" />}
        </div>
      </div>

      <div className="px-4 md:px-5 mt-4 space-y-4 max-w-3xl">

        {/* ── This month: a daily allowance till the month ends ── */}
        {today && (
          <div className={`card ${over ? 'border-red-200 bg-red-50' : ''}`}>
            {over ? (
              <p className="text-sm font-bold text-red-700">This month has already gone {INR(-left)} past the salary.</p>
            ) : (
              <>
                <p className="text-sm font-bold text-gray-800">
                  {INR(left)} left for the {today.daysLeft} day{today.daysLeft === 1 ? '' : 's'} to month-end
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  About <span className="font-bold text-gray-800">{INR(today.perDay)} a day</span>
                  {view.avgSpent != null && <> · your usual month spends {INR(view.avgSpent)}</>}
                </p>
              </>
            )}
            {today.next && (
              <p className="text-[11px] text-gray-400 mt-1">
                Next salary {today.toPay === 0 ? 'today' : `in ${today.toPay} day${today.toPay === 1 ? '' : 's'}`} · {today.next.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
              </p>
            )}
          </div>
        )}

        {/* ── 50 / 30 / 20 ── */}
        <div className="card">
          <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest">The 50 / 30 / 20 check</h2>
          <p className="text-[10px] text-gray-400 mb-3">A common rule of thumb: about half the pay on needs, a third at most on wants, a fifth or more saved.</p>
          {(() => {
            // The same split the totals were made from: needs are the server's
            // list, every other category is a want.
            const needSet = new Set(data.needs_categories || NEEDS_FALLBACK)
            const rows = Object.entries(mo.cats)
            const needs = rows.filter(([c]) => needSet.has(c))
            const wants = rows.filter(([c]) => !needSet.has(c))
            return (
              <>
                <RuleBar label="Needs" sub="groceries, rent, bills, transport, health, EMIs" value={view.mo.needs} salary={salary} target={50} max
                  items={needs} empty="No spending on needs this month." />
                <RuleBar label="Wants" sub="everything that isn't a need" value={view.wants} salary={salary} target={30} max
                  items={wants} empty="No spending on wants this month." />
                <RuleBar label="Invested" sub="from statements + added by you" value={mo.invested} salary={salary} target={20}
                  items={Object.entries(mo.invest.by_kind)} empty="Nothing invested this month." />
              </>
            )
          })()}
          <p className="text-[10px] text-gray-300 mt-1 text-center">tap a line to see what's in it</p>
        </div>

        {/* ── Where it went ── */}
        <div className="card">
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest">Where the money went</h2>
            <span className="text-[10px] text-gray-400">% of salary</span>
          </div>
          {SOURCES.map((s) => {
            const v = mo.spend[s.key] || 0
            if (v < 1 && s.key !== 'monthly') return null
            return <SourceRow key={`${s.key}-${ym}`} s={s} v={v} salary={salary} ym={ym} onOpen={() => nav(s.to)} onChanged={load} />
          })}
          <div className="flex justify-between pt-2 text-xs font-black">
            <span>Total utilised</span><span>{INR(mo.spent)} · {pct(mo.spent, salary)}%</span>
          </div>
          {mo.cards.gross > 0 && (mo.cards.already_entered > 0 || mo.cards.passed_on > 0) && (
            <p className="text-[10px] text-gray-400 mt-2">
              Cards had {INR(mo.cards.gross)} of spends this month:
              {mo.cards.already_entered > 0 && <> {INR(mo.cards.already_entered)} you'd already entered as card expenses</>}
              {mo.cards.already_entered > 0 && mo.cards.passed_on > 0 && ' and'}
              {mo.cards.passed_on > 0 && <> {INR(mo.cards.passed_on)} passed on to others as loans</>}
              {' '}- not counted twice.
            </p>
          )}
          {mo.cards.bills_without_breakup > 0 && (
            <p className="text-[10px] text-gray-400 mt-1">A card bill with no breakup yet is counted at its full amount - open it on Credit Cards to read it.</p>
          )}
          {mo.groups.length > 0 && (
            <div className="mt-3 pt-2 border-t border-amber-100">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Groups this month · your share</p>
              {mo.groups.map((g) => (
                <button key={g.id} onClick={() => nav(`/groups/${g.id}`)} className="w-full flex items-center justify-between py-1 text-left hover:bg-amber-50 -mx-2 px-2">
                  <span className="text-xs text-gray-700 truncate pr-2">{g.emoji} {g.name}</span>
                  <span className="text-xs font-bold text-gray-900 shrink-0">{INR(g.value)} ›</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ── Categories, across all of it ── */}
        {Object.keys(mo.cats).length > 0 && (
          <div className="card">
            <div className="flex items-baseline justify-between mb-2">
              <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest">What it went on</h2>
              <span className="text-[10px] text-gray-400">expenses, groups & cards together</span>
            </div>
            {Object.entries(mo.cats).slice(0, 10).map(([c, v]) => (
              <div key={c} className="py-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-bold text-gray-800 truncate">{c}</span>
                  <span className="text-xs font-black text-gray-900 shrink-0">{INR(v)} <span className="text-[10px] font-bold text-gray-400">{pct(v, salary)}%</span></span>
                </div>
                <div className="h-1.5 bg-amber-100 mt-1">
                  <div className="h-full" style={{ width: `${(v / maxCat) * 100}%`, background: SPENT }} />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Investments ── */}
        <div className="card">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest">Investments · {ymLabel(ym)}</h2>
            {!editing && (
              <button onClick={() => setEditing({})} className="text-[11px] font-bold text-brand-600">+ Add</button>
            )}
          </div>
          <p className="text-2xl font-black text-green-700">{INR(mo.invested)}
            <span className="text-xs font-bold text-gray-400 ml-1.5">{pct(mo.invested, salary)}% of salary</span>
          </p>
          {Object.keys(mo.invest.by_kind).length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {Object.entries(mo.invest.by_kind).map(([k, v]) => (
                <span key={k} className="text-[10px] font-bold bg-green-50 border border-green-200 text-green-800 px-2 py-0.5">{k} {compactINR(v)}</span>
              ))}
            </div>
          )}
          <p className="text-[10px] text-gray-400 mt-2">
            Statements only show what was paid through PhonePe / Google Pay / Paytm. Add the rest by hand - a SIP from your bank, EPF, PPF, an FD, a policy premium.
          </p>

          {editing && (
            <InvestmentForm
              kinds={data.kinds} month={ym} initial={editing}
              onCancel={() => setEditing(null)}
              onSaved={async () => { setEditing(null); await load() }}
            />
          )}

          {manualInv.length > 0 && (
            <div className="mt-3">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Added by you</p>
              {manualInv.map((r) => (
                <div key={r.id} className="flex items-center gap-2 py-1.5 border-b border-amber-100 last:border-0">
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-bold text-gray-800 truncate">{r.kind}{r.note ? ` · ${r.note}` : ''}</span>
                    <span className="block text-[10px] text-gray-400">
                      {r.recurring ? `Every month from ${ymLabel(r.month)}${r.end_month ? ` to ${ymLabel(r.end_month)}` : ''}` : 'One-off'}
                    </span>
                  </span>
                  <span className="text-xs font-black text-gray-900">{INR(r.amount)}</span>
                  <button onClick={() => setEditing(r)} className="text-[11px] font-bold text-brand-600">Edit</button>
                  <button
                    onClick={async () => {
                      if (!confirm(r.recurring ? 'Delete this monthly investment from every month?' : 'Delete this investment?')) return
                      await deleteInvestment(r.id).catch(() => {})
                      load()
                    }}
                    className="text-[11px] font-bold text-red-600">Delete</button>
                </div>
              ))}
            </div>
          )}
          {autoInv.length > 0 && (
            <div className="mt-3">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">From your statements</p>
              {autoInv.map((x) => (
                <div key={x.id} className="flex items-center gap-2 py-1.5 border-b border-amber-100 last:border-0">
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-bold text-gray-800 truncate">{x.merchant}</span>
                    <span className="block text-[10px] text-gray-400">{x.kind} · {x.date.slice(8, 10)} {MON[+x.date.slice(5, 7) - 1]}{x.source ? ` · ${x.source}` : ''}</span>
                  </span>
                  <span className="text-xs font-black text-gray-900">{INR(x.amount)}</span>
                </div>
              ))}
            </div>
          )}
          {!manualInv.length && !autoInv.length && !editing && (
            <p className="text-xs text-gray-500 mt-3">Nothing invested in {ymLabel(ym)} yet that the app knows of.</p>
          )}
        </div>

        {/* ── 12 months ── */}
        <div className="card">
          <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest mb-1">Last 12 months</h2>
          <p className="text-[11px] text-gray-600 mb-2">
            {view.avgSpent != null && <>Usual month: <span className="font-bold">{INR(view.avgSpent)}</span> spent ({pct(view.avgSpent, salary)}%)</>}
            {avgRate != null && <> · <span className={`font-bold ${avgRate >= 20 ? 'text-green-600' : 'text-amber-600'}`}>{avgRate}%</span> invested on average</>}
          </p>
          <div className="flex items-center gap-3 mb-2 text-[10px] text-gray-500 flex-wrap">
            <Legend color={SPENT} label="Spent" />
            <Legend color={INVEST} label="Invested" />
            <Legend color={LEFT} label="Left" />
            <span className="flex items-center gap-1"><span className="inline-block w-3 border-t-2 border-dashed border-slate-700" />Salary</span>
          </div>
          <div className="relative h-60">
            <Bar data={chartData} options={chartOptions} />
          </div>
          <p className="text-[10px] text-gray-300 mt-2 text-center">tap a month to open it</p>
        </div>

        <p className="text-[10px] text-gray-400 px-1">
          Months are calendar months, and the salary you entered is used for each of them. Money sent to friends, transfers between your own accounts and credit card bill payments aren't counted as spending.
        </p>
      </div>
    </div>
  )
}

/**
 * One "where the money went" line; tapped, it lists the expenses that make up
 * its amount (fetched then - the same rules as the dashboard, so they add up),
 * biggest first, with what was taken off for cards.
 */
function SourceRow({ s, v, salary, ym, onOpen, onChanged }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [all, setAll] = useState(false)
  const [busyKey, setBusyKey] = useState('')
  const fetchItems = () => getSalaryItems(ym, s.key).then((r) => setData(r.data)).catch(() => setErr("Couldn't load them."))
  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && !data) { setErr(''); fetchItems() }
  }
  // Card spends: "already counted" (in a group, say) takes one out of the
  // dashboard's sums; "count again" puts it back - the totals update at once
  const marked = new Set((data?.less || []).filter((x) => x.marked).map((x) => x.key))
  const mark = async (key, counted) => {
    setBusyKey(key); setErr('')
    try { await setCardSkip(key, counted); await Promise.all([fetchItems(), onChanged?.()]) }
    catch { setErr("Couldn't change that.") } finally { setBusyKey('') }
  }
  const list = data ? (all ? data.items : data.items.slice(0, 15)) : []
  const day = (d) => (d && d.length >= 10 ? `${+d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]}` : '')
  return (
    <div className="border-b border-amber-100 last:border-0">
      <button onClick={toggle} aria-expanded={open} className="w-full text-left py-2 hover:bg-amber-50 -mx-2 px-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-bold text-gray-800">
            <span className="inline-block w-3 text-gray-400">{open ? '▾' : '▸'}</span>{s.label} <span className="text-[10px] font-normal text-gray-400">{s.note}</span>
          </span>
          <span className="text-xs font-black text-gray-900 shrink-0">{INR(v)} <span className="text-[10px] font-bold text-gray-400">{pct(v, salary)}%</span></span>
        </div>
        <div className="h-1.5 bg-amber-100 mt-1 ml-3">
          <div className="h-full" style={{ width: `${Math.min(100, (v / salary) * 100)}%`, background: s.color }} />
        </div>
      </button>
      {open && (
        <div className="ml-3 mb-2 bg-amber-50/50 border border-amber-100 px-3 py-2">
          {!data && !err && <p className="text-[11px] text-gray-400">Loading…</p>}
          {err && <p className="text-[11px] text-red-600">{err}</p>}
          {data && data.items.length === 0 && <p className="text-[11px] text-gray-400">Nothing this month.</p>}
          {s.key === 'cards' && data?.items.length > 0 && (
            <p className="text-[10px] text-gray-400 mb-1">Tap <b>Already counted</b> on a spend you've put into a group (or elsewhere) - it's left out of the totals.</p>
          )}
          {list.map((x, i) => {
            const off = x.key && marked.has(x.key)
            return (
              <div key={x.key || i} className={`flex items-baseline gap-2 py-1 border-b border-amber-100/70 last:border-0 ${off ? 'opacity-50' : ''}`}>
                <span className="text-[10px] text-gray-400 w-11 shrink-0 tabular-nums">{day(x.date)}</span>
                <span className="flex-1 min-w-0">
                  <span className={`block text-[11px] font-semibold text-gray-800 truncate ${off ? 'line-through' : ''}`}>{x.title}</span>
                  {x.detail && <span className="block text-[10px] text-gray-400 truncate">{x.detail}</span>}
                  {x.key && (
                    <button onClick={() => mark(x.key, !off)} disabled={busyKey === x.key}
                      className={`text-[10px] font-bold mt-0.5 disabled:opacity-50 ${off ? 'text-brand-600' : 'text-gray-500 hover:text-red-600'}`}>
                      {busyKey === x.key ? 'Saving…' : off ? 'Count again' : 'Already counted'}
                    </button>
                  )}
                </span>
                <span className={`text-[11px] font-black text-gray-900 tabular-nums shrink-0 ${off ? 'line-through' : ''}`}>{INR(x.amount)}</span>
              </div>
            )
          })}
          {data && data.items.length > 15 && (
            <button onClick={() => setAll((a) => !a)} className="text-[10px] font-bold text-brand-600 mt-1">
              {all ? 'Show fewer' : `Show all ${data.items.length}`}
            </button>
          )}
          {data && data.less.length > 0 && (
            <>
              <div className="flex justify-between pt-1.5 mt-1 border-t border-amber-200 text-[11px] font-bold text-gray-700">
                <span>Card spends</span><span className="tabular-nums">{INR(data.gross)}</span>
              </div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mt-1.5">Taken off - not counted twice</p>
              {data.less.map((x, i) => (
                <div key={`l${i}`} className="flex items-baseline gap-2 py-1">
                  <span className="text-[10px] text-gray-400 w-11 shrink-0 tabular-nums">{day(x.date)}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[11px] text-gray-700 truncate">{x.title}</span>
                    <span className="block text-[10px] text-gray-400 truncate">{x.detail}</span>
                    {x.marked && (
                      <button onClick={() => mark(x.key, false)} disabled={busyKey === x.key}
                        className="text-[10px] font-bold text-brand-600 mt-0.5 disabled:opacity-50">
                        {busyKey === x.key ? 'Saving…' : 'Count again'}
                      </button>
                    )}
                  </span>
                  <span className="text-[11px] font-bold text-green-700 tabular-nums shrink-0">−{INR(x.amount)}</span>
                </div>
              ))}
            </>
          )}
          {data && data.items.length > 0 && (
            <div className="flex justify-between pt-1.5 mt-1 border-t border-amber-200 text-[11px] font-black text-gray-900">
              <span>{data.items.length} item{data.items.length === 1 ? '' : 's'} · total</span><span className="tabular-nums">{INR(data.total)}</span>
            </div>
          )}
          <button onClick={onOpen} className="text-[10px] font-bold text-brand-600 mt-1.5">Open {s.label.toLowerCase()} ›</button>
        </div>
      )}
    </div>
  )
}

function HeadStat({ label, value, sub, color }) {
  return (
    <div>
      <p className="text-[9px] font-bold text-slate-300/60 uppercase tracking-widest">{label}</p>
      <p className={`text-base font-black tracking-tight ${color}`}>{value}</p>
      <p className="text-[10px] text-slate-300/50">{sub}</p>
    </div>
  )
}

function Legend({ color, label }) {
  return <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5" style={{ background: color }} />{label}</span>
}

/**
 * One part of the 50/30/20 rule: its share of the pay against the target.
 * Tapping it lists what makes up the amount - `items` as [name, amount].
 */
function RuleBar({ label, sub, value, salary, target, max, items = [], empty }) {
  const [open, setOpen] = useState(false)
  const p = pct(value, salary)
  const good = max ? p <= target : p >= target
  const shown = items.filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1])
  return (
    <div className="py-1.5 border-b border-amber-100 last:border-0">
      <button onClick={() => setOpen((v) => !v)} className="w-full text-left" aria-expanded={open}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-bold text-gray-800">
            <span className="text-gray-400 mr-1">{open ? '▾' : '▸'}</span>
            {label} <span className="text-[10px] font-normal text-gray-400">{sub}</span>
          </span>
          <span className={`text-xs font-black shrink-0 ${good ? 'text-green-600' : 'text-red-500'}`}>
            {p}% <span className="text-[10px] font-bold text-gray-400">{max ? '≤' : '≥'} {target}%</span>
          </span>
        </div>
        <div className="relative h-2 bg-amber-100 mt-1">
          <div className="h-full" style={{ width: `${Math.min(100, p)}%`, background: good ? INVEST : OVER }} />
          <div className="absolute top-[-2px] h-3 w-0.5 bg-gray-700" style={{ left: `${target}%` }} />
        </div>
        <p className="text-[10px] text-gray-400 mt-0.5">{INR(value)}</p>
      </button>
      {open && (
        <div className="mt-1.5 mb-1 bg-amber-50/60 border border-amber-100 px-3 py-1.5">
          {shown.length === 0 && <p className="text-[11px] text-gray-400 py-1">{empty}</p>}
          {shown.map(([name, v]) => (
            <div key={name} className="flex items-baseline justify-between gap-2 py-1 border-b border-amber-100/70 last:border-0">
              <span className="text-[11px] text-gray-700 truncate">{name}</span>
              <span className="text-[11px] font-bold text-gray-900 shrink-0">
                {INR(v)}
                <span className="text-[10px] font-bold text-gray-400 ml-1">{value > 0 ? pct(v, value) : 0}% of {label.toLowerCase()} · {pct(v, salary)}% of pay</span>
              </span>
            </div>
          ))}
          {shown.length > 0 && (
            <div className="flex justify-between pt-1 text-[11px] font-black text-gray-800">
              <span>Total</span><span>{INR(shown.reduce((s, [, v]) => s + v, 0))}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Add or change a hand-entered investment; a monthly one repeats till its last month (or for good). */
function InvestmentForm({ kinds, month, initial, onCancel, onSaved }) {
  const [kind, setKind] = useState(initial.kind || kinds[0])
  const [amount, setAmount] = useState(initial.amount ? String(initial.amount) : '')
  const [from, setFrom] = useState(initial.month || month)
  const [recurring, setRecurring] = useState(!!initial.recurring)
  const [until, setUntil] = useState(initial.end_month || '')
  const [note, setNote] = useState(initial.note || '')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async (e) => {
    e.preventDefault()
    setErr(''); setSaving(true)
    const body = { kind, amount: parseFloat(amount), month: from, recurring, end_month: recurring && until ? until : null, note }
    try {
      await (initial.id ? editInvestment(initial.id, body) : addInvestment(body))
      onSaved()
    } catch (e2) {
      setErr(e2.response?.data?.detail || "Couldn't save it.")
      setSaving(false)
    }
  }
  return (
    <form onSubmit={save} className="mt-3 bg-green-50 border border-green-200 px-3 py-3 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[10px] font-bold text-gray-500">Kind
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="input text-xs py-1.5 mt-0.5">
            {kinds.map((k) => <option key={k}>{k}</option>)}
          </select>
        </label>
        <label className="text-[10px] font-bold text-gray-500">Amount (₹)
          <input type="number" inputMode="decimal" min="1" value={amount} onChange={(e) => setAmount(e.target.value)}
            className="input text-xs py-1.5 mt-0.5" placeholder="5000" autoFocus />
        </label>
        <label className="text-[10px] font-bold text-gray-500">{recurring ? 'From' : 'Month'}
          <input type="month" value={from} onChange={(e) => setFrom(e.target.value)} className="input text-xs py-1.5 mt-0.5" />
        </label>
        {recurring && (
          <label className="text-[10px] font-bold text-gray-500">Until <span className="font-normal">(optional)</span>
            <input type="month" value={until} min={from} onChange={(e) => setUntil(e.target.value)} className="input text-xs py-1.5 mt-0.5" />
          </label>
        )}
      </div>
      <label className="flex items-center gap-2 text-xs text-gray-700">
        <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} className="w-4 h-4 accent-brand-400" />
        Every month (a SIP, EPF…)
      </label>
      <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Note (optional) - e.g. HDFC Flexi Cap SIP"
        className="input text-xs py-1.5" />
      {err && <p className="text-[11px] text-red-600">{typeof err === 'string' ? err : 'Check the details.'}</p>}
      <div className="flex gap-3">
        <button type="submit" disabled={!amount || saving} className="btn-primary text-xs py-1.5 px-4 disabled:opacity-50">
          {saving ? 'Saving…' : initial.id ? 'Save' : 'Add investment'}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-bold text-gray-500">Cancel</button>
      </div>
    </form>
  )
}
