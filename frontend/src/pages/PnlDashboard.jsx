import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { pnlBacktest } from '../api'

/** P/L across the sports (backend routers/picks.backtest): my own picks as
 *  recorded, plus a flat stake on the favourite in every other played match
 *  of the period - tennis at the bookmakers' kept price, badminton at our
 *  model's. A combined view, then a section per sport. */
const SPORT = {
  tennis: { name: 'Tennis', icon: '🎾', color: '#2a78d6' },
  badminton: { name: 'Badminton', icon: '🏸', color: '#eb6834' },
  hockey: { name: 'Hockey', icon: '🏑', color: '#1baf7a' },
}
const INK = '#1f2937'
const rupees = (x) => `${x < 0 ? '−' : x > 0 ? '+' : ''}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`
const pct = (x) => (x == null ? '—' : `${x > 0 ? '+' : ''}${(100 * x).toFixed(1)}%`)
const tone = (x) => (x > 0 ? 'text-green-700' : x < 0 ? 'text-red-600' : 'text-gray-900')
const fmtDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

function Tile({ label, value, sub, cls, onClick }) {
  const Box = onClick ? 'button' : 'div'
  return (
    <Box onClick={onClick} className="flex-1 min-w-[90px] text-left rounded-md bg-white border border-amber-100 px-3 py-2">
      <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wider whitespace-nowrap truncate">{label}</p>
      <p className={`text-base font-black tabular-nums ${cls || 'text-gray-900'}`}>{value}</p>
      {sub && <p className="text-[10px] text-gray-400">{sub}</p>}
    </Box>
  )
}

function Split({ s, stake }) {
  const row = (label, x) => (
    <tr className="border-t border-gray-100">
      <td className="py-1.5 pl-1 font-semibold text-gray-800">{label}</td>
      <td className="py-1.5 text-right tabular-nums">{x.bets}</td>
      <td className="py-1.5 pl-2 text-right tabular-nums whitespace-nowrap">{x.bets ? `${Math.round((100 * x.won) / x.bets)}%` : '—'}</td>
      <td className={`py-1.5 pl-2 text-right tabular-nums font-black whitespace-nowrap ${tone(x.pl)}`}>{x.bets ? rupees(x.pl) : '—'}</td>
      <td className={`py-1.5 pl-2 text-right tabular-nums whitespace-nowrap ${tone(x.pl)}`}>{pct(x.roi)}</td>
    </tr>
  )
  return (
    <table className="w-full text-xs mt-2">
      <thead>
        <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider">
          <th className="py-1 text-left">Bets</th><th className="py-1 pl-2 text-right">Count</th><th className="py-1 pl-2 text-right">Won</th>
          <th className="py-1 pl-2 text-right">P/L</th><th className="py-1 pl-2 text-right">Return</th>
        </tr>
      </thead>
      <tbody>
        {row('My picks (as recorded)', s.mine)}
        {row(`₹${stake} on the favourite, every other match`, s.auto)}
      </tbody>
    </table>
  )
}

/** Cumulative P/L by day - one line per sport and the total, a crosshair and tooltip on hover. */
function Curve({ series }) {
  const [hover, setHover] = useState(null)
  const days = useMemo(() => [...new Set(series.flatMap((s) => s.curve.map((p) => p.date)))].sort(), [series])
  if (days.length < 2) return <p className="text-xs text-gray-400 py-4 text-center">Not enough days with settled bets for a curve yet.</p>
  // each series carried forward day by day, so every line spans the period
  const lines = series.map((s) => {
    const at = Object.fromEntries(s.curve.map((p) => [p.date, p.cum]))
    let run = 0
    return { ...s, pts: days.map((d) => (run = at[d] ?? run)) }
  })
  const all = lines.flatMap((l) => l.pts).concat(0)
  const lo = Math.min(...all), hi = Math.max(...all)
  const W = 640, H = 220, L = 52, R = 74, T = 10, B = 24
  const x = (i) => L + (i * (W - L - R)) / (days.length - 1)
  const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo || 1)
  const ticks = [lo, (lo + hi) / 2, hi]
  const move = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    setHover(Math.max(0, Math.min(days.length - 1, Math.round(((px - L) / (W - L - R)) * (days.length - 1)))))
  }
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" onMouseMove={move} onMouseLeave={() => setHover(null)}
        onTouchStart={(e) => move(e.touches[0] ? { currentTarget: e.currentTarget, clientX: e.touches[0].clientX } : e)}
        role="img" aria-label="Cumulative profit and loss by day">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="#e5e7eb" strokeWidth="1" />
            <text x={L - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="#9ca3af">{rupees(t)}</text>
          </g>
        ))}
        <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="#9ca3af" strokeWidth="1" />
        <text x={L} y={H - 6} fontSize="10" fill="#9ca3af">{fmtDay(days[0])}</text>
        <text x={W - R} y={H - 6} fontSize="10" fill="#9ca3af" textAnchor="end">{fmtDay(days[days.length - 1])}</text>
        {lines.map((l) => (
          <g key={l.key}>
            <polyline fill="none" stroke={l.color} strokeWidth={l.key === 'total' ? 2.5 : 2} strokeLinejoin="round" strokeLinecap="round"
              points={l.pts.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
            <text x={W - R + 6} y={y(l.pts[l.pts.length - 1]) + 3} fontSize="10" fill="#374151" fontWeight={l.key === 'total' ? 700 : 500}>{l.name}</text>
          </g>
        ))}
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="#9ca3af" strokeWidth="1" strokeDasharray="3 3" />
            {lines.map((l) => <circle key={l.key} cx={x(hover)} cy={y(l.pts[hover])} r="4" fill={l.color} stroke="#fff" strokeWidth="2" />)}
          </g>
        )}
      </svg>
      {hover != null && (
        <div className="absolute top-1 left-14 rounded-md bg-white/95 border border-gray-200 shadow-sm px-2 py-1 text-[11px] pointer-events-none">
          <p className="font-bold text-gray-700">{fmtDay(days[hover])} · so far</p>
          {lines.map((l) => (
            <p key={l.key} className="flex items-center gap-1.5 tabular-nums">
              <span className="inline-block w-2.5 h-0.5" style={{ background: l.color }} />
              <span className="text-gray-500 w-20">{l.name}</span><span className={`font-bold ${tone(l.pts[hover])}`}>{rupees(l.pts[hover])}</span>
            </p>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-3 mt-1 text-[11px] text-gray-600">
        {lines.map((l) => (
          <span key={l.key} className="flex items-center gap-1.5"><span className="inline-block w-4 h-0.5" style={{ background: l.color, height: l.key === 'total' ? 3 : 2 }} />{l.name}</span>
        ))}
      </div>
    </div>
  )
}

function Bets({ bets }) {
  const [kind, setKind] = useState('all')
  const [more, setMore] = useState(false)
  const shown = bets.filter((b) => kind === 'all' || b.kind === kind)
  return (
    <div className="mt-3">
      <div className="flex gap-1.5 text-[11px]">
        {[['all', 'All'], ['mine', 'My picks'], ['auto', 'Favourite']].map(([k, l]) => (
          <button key={k} onClick={() => setKind(k)}
            className={`rounded-full border px-2 py-0.5 font-bold ${kind === k ? 'bg-brand-600 border-brand-600 text-white' : 'border-gray-300 text-gray-500'}`}>{l}</button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs mt-1.5 min-w-[420px]">
          <thead>
            <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider">
              <th className="py-1 text-left">Day</th><th className="py-1 text-left">Backed</th><th className="py-1 text-right">Odds</th><th className="py-1 text-right">P/L</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, more ? 400 : 25).map((b, i) => (
              <tr key={i} className="border-t border-gray-100">
                <td className="py-1.5 pl-1 text-gray-500 whitespace-nowrap">{fmtDay(b.date)}</td>
                <td className="py-1.5">
                  <span className="font-bold text-gray-900">{b.pick}</span>
                  {b.kind === 'mine' && <span className="ml-1 text-[9px] font-black text-brand-600">MY PICK</span>}
                  <span className="block text-[10px] text-gray-400 truncate max-w-[240px]">v {b.other} · {b.label}</span>
                </td>
                <td className="py-1.5 text-right tabular-nums">{b.odds ? b.odds.toFixed(2) : '—'}</td>
                <td className={`py-1.5 text-right tabular-nums font-bold ${tone(b.pl)}`}>{rupees(b.pl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length > 25 && (
        <button onClick={() => setMore((m) => !m)} className="text-[11px] font-bold text-brand-600 mt-1">
          {more ? 'Show fewer' : `Show all ${Math.min(shown.length, 400)}`}
        </button>
      )}
    </div>
  )
}

function SportCard({ k, s, stake }) {
  const meta = SPORT[k]
  return (
    <div className="card">
      <p className="text-sm font-black text-gray-900 flex items-center gap-1.5">
        <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: meta.color }} />{meta.icon} {meta.name}
      </p>
      {s.bets === 0 ? (
        <p className="text-xs text-gray-500 mt-2">
          {k === 'hockey'
            ? 'No hockey picks in this period. No feed has hockey prices, so only matches you pick (or type a bookmaker\'s odds for) can be counted.'
            : 'No settled bets in this period.'}
        </p>
      ) : (
        <>
          <div className="flex gap-2 mt-2 flex-wrap">
            <Tile label="P/L" value={rupees(s.pl)} cls={tone(s.pl)} />
            <Tile label="Return" value={pct(s.roi)} cls={tone(s.pl)} />
            <Tile label="Bets" value={s.bets} sub={`${Math.round((100 * s.won) / s.bets)}% won`} />
          </div>
          <Split s={s} stake={stake} />
          <p className="text-[10px] text-gray-400 mt-2">
            {s.auto_rule && `Every other played match: ₹${stake} on ${s.auto_rule}. `}
            {k === 'tennis' && s.no_price > 0 && `${s.no_price} matches had no kept pre-match price${s.priced_from ? ` (prices are kept from ${fmtDay(s.priced_from)} on - older days fill in as they're read back)` : ''} and aren't counted. `}
            {k === 'badminton' && s.auto?.bets > 0 && `Our prices carry no margin; at a bookmaker's ~8% margin those ${s.auto.bets} favourite bets would have made ${rupees(s.at_book_margin)} instead of ${rupees(s.auto.pl)}. `}
            {s.pending > 0 && `${s.pending} still to play. `}
            {s.unsettled > 0 && `${s.unsettled} without a price (not counted).`}
          </p>
          <Bets bets={s.recent} />
        </>
      )}
    </div>
  )
}

export default function PnlDashboard() {
  const nav = useNavigate()
  const [days, setDays] = useState(30)
  const [stake, setStake] = useState(100)
  const [view, setView] = useState(() => { try { return sessionStorage.getItem('pnl.view') || 'all' } catch { return 'all' } })
  const pick = (v) => { setView(v); try { sessionStorage.setItem('pnl.view', v) } catch { /* private mode */ } }
  const [d, setD] = useState(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let alive = true
    setErr(false)
    const t = setTimeout(() => pnlBacktest(days, stake).then((r) => { if (alive) setD(r.data) }).catch(() => { if (alive) setErr(true) }), 300)
    return () => { alive = false; clearTimeout(t) }
  }, [days, stake])
  const series = !d ? [] : view === 'all' ? [
    { key: 'total', name: 'All sports', color: INK, curve: d.total.curve },
    ...Object.entries(d.sports).filter(([, s]) => s.bets > 0).map(([k, s]) => ({ key: k, name: SPORT[k].name, color: SPORT[k].color, curve: s.curve })),
  ] : [{ key: view, name: SPORT[view].name, color: SPORT[view].color, curve: d.sports[view].curve }]
  const t = d?.total
  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-3 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <h1 className="text-xl font-black tracking-tight">P/L across sports</h1>
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <div className="flex rounded-md border border-amber-300 overflow-hidden">
            {[7, 14, 30, 60].map((n) => (
              <button key={n} onClick={() => setDays(n)}
                className={`px-2.5 py-1 text-[11px] font-bold ${days === n ? 'bg-brand-400 text-white' : 'bg-white text-gray-600'}`}>{n}d</button>
            ))}
          </div>
          <label className="flex items-center gap-1 text-[11px] font-semibold text-gray-600">
            Stake ₹
            <input type="number" min="1" inputMode="numeric" value={stake} onChange={(e) => setStake(Math.max(1, Number(e.target.value) || 1))}
              className="w-20 rounded-md border border-amber-300 px-2 py-0.5 text-[12px] font-black tabular-nums" />
          </label>
        </div>
        <div className="grid grid-cols-4 mt-2.5 rounded-md border border-amber-300 overflow-hidden">
          {[['all', 'All'], ...Object.entries(SPORT).map(([k, m]) => [k, `${m.icon} ${m.name}`])].map(([k, l]) => (
            <button key={k} onClick={() => pick(k)}
              className={`py-1.5 text-[11px] font-bold whitespace-nowrap ${view === k ? 'bg-brand-400 text-white' : 'bg-white text-gray-600'}`}>{l}</button>
          ))}
        </div>
      </div>

      <div className="px-5 pt-4 space-y-3">
        {!d && !err && <p className="text-xs text-gray-400 text-center py-8">Settling the last {days} days…</p>}
        {err && <p className="text-sm text-red-600 text-center py-8">Couldn't work it out - try again in a moment.</p>}
        {d && (
          <>
            {view === 'all' && (
            <div className="card">
              <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">All sports · {fmtDay(d.since)} to today</p>
              <p className={`text-3xl font-black tabular-nums mt-1 ${tone(t.pl)}`}>{rupees(t.pl)}</p>
              <p className="text-[11px] text-gray-500">{pct(t.roi)} on ₹{Math.round(t.staked).toLocaleString('en-IN')} staked over {t.bets.toLocaleString('en-IN')} bets · {t.bets ? Math.round((100 * t.won) / t.bets) : 0}% won</p>
              <div className="flex gap-2 mt-3 flex-wrap">
                {Object.entries(d.sports).map(([k, s]) => (
                  <Tile key={k} onClick={() => pick(k)} label={`${SPORT[k].icon} ${SPORT[k].name}`} value={s.bets ? rupees(s.pl) : '—'} cls={tone(s.pl)}
                    sub={s.bets ? `${s.bets} bets · ${pct(s.roi)}` : 'no bets'} />
                ))}
              </div>
              <Split s={t} stake={stake} />
            </div>
            )}

            {series.some((x) => x.curve.length) && (
              <div className="card">
                <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Running P/L by day{view !== 'all' ? ` · ${SPORT[view].name}` : ''}</p>
                <Curve series={series} />
              </div>
            )}

            {view !== 'all' && <SportCard k={view} s={d.sports[view]} stake={stake} />}

            <p className="text-[10px] text-gray-400 text-center">
              Decimal odds: a win pays stake × (odds − 1), a loss costs the stake; walkovers and draws are void.
              My picks settle at the prices My picks uses; every other played match is a ₹{stake} bet on the favourite.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
