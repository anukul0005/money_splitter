import { Fragment, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { footballTop, pnlBacktest } from '../api'
import { EDGES, useEdge } from '../components/Suggest'

/** P/L across the sports (backend routers/picks.backtest): my own picks as
 *  recorded, plus a flat stake on the favourite in every other played match
 *  of the period - tennis at the bookmakers' kept price, badminton at our
 *  model's. A combined view, then a section per sport. */
const SPORT = {
  tennis: { name: 'Tennis', icon: '🎾', color: '#2a78d6' },
  badminton: { name: 'Badminton', icon: '🏸', color: '#eb6834' },
  hockey: { name: 'Hockey', icon: '🏑', color: '#1baf7a' },
  football: { name: 'Football', icon: '⚽', color: '#8b5cf6' },
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

function Split({ s, stake, edge }) {
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
        {s.suggested && row(`Suggested: ${Math.round(100 * edge)}%+ expected`, s.suggested)}
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

function Bets({ bets, suggested }) {
  const [kind, setKind] = useState('all')
  const [more, setMore] = useState(false)
  const shown = kind === 'suggested' ? suggested : bets.filter((b) => kind === 'all' || b.kind === kind)
  return (
    <div className="mt-3">
      <div className="flex gap-1.5 text-[11px]">
        {[['all', 'All'], ['mine', 'My picks'], ['auto', 'Favourite'], ['suggested', `Suggested (${suggested.length})`]].map(([k, l]) => (
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
                  {b.expected != null && <span className="ml-1 text-[9px] font-black text-green-700">+{Math.round(100 * b.expected)}% EXP</span>}
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

/** Badminton has no bookmakers' prices, so: our favourite in every played
 *  match, by how sure we were - at our own fair price and at a bookmaker-like
 *  price (ours less ~8% margin). Backend picks._chance_stats. */
function Chance({ c, stake }) {
  const [by, setBy] = useState('bands')
  if (!c.all?.bets) return null
  const rows = by === 'bands' ? c.bands.map((b) => [`${b.from}-${Math.min(b.to, 100)}%`, b])
    : by === 'min' ? c.at_least.map((b) => [`${b.from}%+`, b])
      : c.events.map((b) => [b.name, b])
  const long = Object.fromEntries((c.long || []).map((b) => [b.from, b]))
  const m = Math.round(100 * c.margin)
  return (
    <div className="mt-3 border-t border-gray-100 pt-2">
      <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Our chance analysis · every played match</p>
      <p className="text-[11px] text-gray-600 mt-1">
        ₹{stake} on our favourite in all {c.all.bets.toLocaleString('en-IN')} matches: we said {Math.round(100 * c.all.said)}% on average, it won {Math.round(100 * c.all.came_in)}%.
        {' '}At our own prices <b className={tone(c.all.pl_fair)}>{rupees(c.all.pl_fair)}</b>; at a bookmaker's price (ours less {m}%) <b className={tone(c.all.pl_book)}>{rupees(c.all.pl_book)}</b>.
      </p>
      <div className="flex gap-1 mt-2">
        {[['bands', 'By how sure'], ['min', 'Only when ≥'], ['events', 'By event']].map(([k, l]) => (
          <button key={k} onClick={() => setBy(k)}
            className={`px-2 py-0.5 rounded-full border text-[11px] font-bold ${by === k ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-600 border-gray-300'}`}>{l}</button>
        ))}
      </div>
      <table className="w-full text-[11px] mt-1.5">
        <thead>
          <tr className="text-[9px] text-gray-400 uppercase tracking-wider">
            <th className="text-left font-black py-1">We said</th>
            <th className="text-right font-black">Bets</th>
            <th className="text-right font-black">Won</th>
            <th className="text-right font-black">P/L ours</th>
            <th className="text-right font-black">P/L −{m}%</th>
            <th className="text-right font-black">Pays at ≥</th>
          </tr>
        </thead>
        <tbody>
          {rows.filter(([, b]) => b.bets).map(([l, b]) => (
            <tr key={l} className="border-t border-gray-100">
              <td className="py-1.5 font-semibold text-gray-700">{l}<span className="font-normal text-gray-400"> · {Math.round(100 * b.said)}%</span></td>
              <td className="text-right tabular-nums">{b.bets}</td>
              <td className="text-right tabular-nums">{Math.round(100 * b.came_in)}%</td>
              <td className={`text-right tabular-nums font-bold whitespace-nowrap ${tone(b.pl_fair)}`}>{rupees(b.pl_fair)}</td>
              <td className={`text-right tabular-nums font-bold whitespace-nowrap ${tone(b.pl_book)}`}>{rupees(b.pl_book)}</td>
              <td className="text-right tabular-nums font-black text-gray-900">{b.break_even ? b.break_even.toFixed(2) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {by === 'bands' && c.long && (
        <p className="text-[10px] text-gray-500 mt-1.5">
          Over a longer run ({c.long_matches?.toLocaleString('en-IN')} matches since {fmtDay(c.long_since)}), what came in: {c.bands.map((b) => long[b.from] && `${b.from}s ${Math.round(100 * long[b.from].came_in)}% (pays at ≥ ${(1 / long[b.from].came_in).toFixed(2)})`).filter(Boolean).join(' · ')}.
        </p>
      )}
      <p className="text-[10px] text-gray-400 mt-1">
        "Pays at ≥" is the lowest price at which that group would have made money - if a bookmaker offers more than that on our favourite, it's worth a look.
        One month is a small sample; the longer run is the steadier guide. The −{m}% column assumes a bookmaker that agrees with us; real ones differ match to match.
      </p>
    </div>
  )
}

/** Football: Rs stake on the bookmakers' favourite in every top-five league
 *  match over the last 30, 60 and 90 days, at the market's closing average
 *  (backend routers/football.favourites). Tap a period for its leagues. */
function FavWindows({ s, stake }) {
  const [open, setOpen] = useState(null)
  return (
    <div className="mt-3 border-t border-gray-100 pt-2">
      <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Backing the favourite · ₹{stake} a match</p>
      <table className="w-full text-[11px] mt-1">
        <thead>
          <tr className="text-[9px] text-gray-400 uppercase tracking-wider">
            <th className="text-left font-black py-1">Last</th>
            <th className="text-right font-black">Bets</th>
            <th className="text-right font-black">Won</th>
            <th className="text-right font-black">Avg odds</th>
            <th className="text-right font-black">P/L</th>
            <th className="text-right font-black">Return</th>
          </tr>
        </thead>
        <tbody>
          {s.windows.map((w) => (
            <Fragment key={w.days}>
              <tr onClick={() => setOpen(open === w.days ? null : w.days)} className="border-t border-gray-100 cursor-pointer">
                <td className="py-1.5 font-bold text-gray-800">{w.days} days <span className="text-brand-600">{open === w.days ? '▴' : '▾'}</span></td>
                <td className="text-right tabular-nums">{w.bets}</td>
                <td className="text-right tabular-nums">{w.bets ? Math.round((100 * w.won) / w.bets) : 0}%</td>
                <td className="text-right tabular-nums">{w.avg_odds?.toFixed(2) ?? '—'}</td>
                <td className={`text-right tabular-nums font-bold whitespace-nowrap ${tone(w.pl)}`}>{rupees(w.pl)}</td>
                <td className={`text-right tabular-nums font-bold ${tone(w.pl)}`}>{pct(w.roi)}</td>
              </tr>
              {open === w.days && w.leagues.filter((l) => l.bets).map((l) => (
                <tr key={l.comp} className="text-gray-500">
                  <td className="py-1 pl-3">{l.name}</td>
                  <td className="text-right tabular-nums">{l.bets}</td>
                  <td className="text-right tabular-nums">{Math.round((100 * l.won) / l.bets)}%</td>
                  <td className="text-right tabular-nums">{l.avg_odds?.toFixed(2)}</td>
                  <td className={`text-right tabular-nums whitespace-nowrap ${tone(l.pl)}`}>{rupees(l.pl)}</td>
                  <td className={`text-right tabular-nums ${tone(l.pl)}`}>{pct(l.roi)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-gray-500 mt-1.5">
        Every Premier League, La Liga, Serie A, Bundesliga and Ligue 1 match, the bookmakers' favourite at the market's closing
        average (football-data.co.uk) - draws count as lost. Results on file up to {fmtDay(s.results_to)}; the source updates weekly.
        No model suggestions for football for now.
      </p>
    </div>
  )
}

/** Football, top teams only: a few questions narrow the record to each
 *  league's top sides (by place on the match day, never today's table) -
 *  backend routers/football.top_teams. Answers kept on this device. */
const TOP_KEY = 'fb.top'
const TOP_DEFAULT = { n: 5, leagues: ['E0', 'SP1', 'I1', 'D1', 'F1'], matches: 'any', venue: 'home', back: 'fav' }   // the steadiest over 2023/24 on
const LEAGUE_NAMES = [['E0', 'Premier League'], ['SP1', 'La Liga'], ['I1', 'Serie A'], ['D1', 'Bundesliga'], ['F1', 'Ligue 1']]

function Question({ q, value, onChange, options, multi }) {
  const on = (k) => (multi ? value.includes(k) : value === k)
  const flip = (k) => (multi ? onChange(on(k) ? (value.length > 1 ? value.filter((x) => x !== k) : value) : [...value, k]) : onChange(k))
  return (
    <div>
      <p className="text-[11px] font-bold text-gray-700">{q}</p>
      <div className="flex gap-1 flex-wrap mt-1">
        {options.map(([k, l]) => (
          <button key={k} onClick={() => flip(k)}
            className={`px-2.5 py-1 rounded-full border text-[11px] font-bold ${on(k) ? 'bg-field-950 text-white border-field-950' : 'bg-white text-gray-600 border-gray-300'}`}>{l}</button>
        ))}
      </div>
    </div>
  )
}

function TopTeams({ stake }) {
  const [a, setA] = useState(() => { try { return { ...TOP_DEFAULT, ...JSON.parse(localStorage.getItem(TOP_KEY) || '{}') } } catch { return TOP_DEFAULT } })
  const [d, setD] = useState(null)
  const [err, setErr] = useState(false)
  const [open, setOpen] = useState(null)
  const [more, setMore] = useState(false)
  const set = (k) => (v) => setA((x) => {
    const y = { ...x, [k]: v }
    try { localStorage.setItem(TOP_KEY, JSON.stringify(y)) } catch { /* private mode */ }
    return y
  })
  useEffect(() => {
    let alive = true
    setErr(false)
    const t = setTimeout(() => footballTop({ n: a.n, leagues: a.leagues.join(','), matches: a.matches, venue: a.venue, back: a.back, stake })
      .then((r) => { if (alive) setD(r.data) }).catch(() => { if (alive) setErr(true) }), 250)
    return () => { alive = false; clearTimeout(t) }
  }, [a, stake])
  const shown = (d?.recent || []).slice(0, more ? 150 : 15)
  return (
    <div className="card">
      <p className="text-sm font-black text-gray-900">⚽ Top teams only</p>
      <p className="text-[10px] text-gray-500 mt-0.5">
        Narrow the record to each league's best sides. A side's place is its league position on the match day - never today's
        table, which already knows who won.
      </p>
      <div className="mt-3 space-y-2.5">
        <Question q="1. How many top teams per league?" value={a.n} onChange={set('n')} options={[[3, 'Top 3'], [5, 'Top 5'], [7, 'Top 7']]} />
        <Question q="2. Which leagues?" value={a.leagues} onChange={set('leagues')} options={LEAGUE_NAMES} multi />
        <Question q="3. Which of their matches?" value={a.matches} onChange={set('matches')}
          options={[['any', 'Against anyone'], ['rest', 'Only against the rest'], ['both', 'Only top v top']]} />
        <Question q="4. Where does the top team play?" value={a.venue} onChange={set('venue')}
          options={[['all', 'Home & away'], ['home', 'At home'], ['away', 'Away']]} />
        <Question q="5. Who do you back?" value={a.back} onChange={set('back')}
          options={[['top', 'The top team'], ['fav', "The bookmakers' favourite"]]} />
      </div>
      {err && <p className="text-xs text-red-600 mt-3">Couldn't work it out - try again.</p>}
      {!d && !err && <p className="text-xs text-gray-400 mt-3">Settling…</p>}
      {d && (
        <>
          <table className="w-full text-[11px] mt-3">
            <thead>
              <tr className="text-[9px] text-gray-400 uppercase tracking-wider">
                <th className="text-left font-black py-1">Last</th>
                <th className="text-right font-black">Bets</th>
                <th className="text-right font-black">Won</th>
                <th className="text-right font-black">Avg odds</th>
                <th className="text-right font-black">P/L</th>
                <th className="text-right font-black">Return</th>
              </tr>
            </thead>
            <tbody>
              {d.periods.map((w) => (
                <Fragment key={w.label}>
                  <tr onClick={() => setOpen(open === w.label ? null : w.label)}
                    className={`border-t border-gray-100 cursor-pointer ${w.days ? '' : 'bg-amber-50/60'}`}>
                    <td className="py-1.5 font-bold text-gray-800 whitespace-nowrap">{w.label} <span className="text-brand-600">{open === w.label ? '▴' : '▾'}</span></td>
                    <td className="text-right tabular-nums">{w.bets.toLocaleString('en-IN')}</td>
                    <td className="text-right tabular-nums">{w.bets ? Math.round((100 * w.won) / w.bets) : 0}%</td>
                    <td className="text-right tabular-nums">{w.avg_odds?.toFixed(2) ?? '—'}</td>
                    <td className={`text-right tabular-nums font-bold whitespace-nowrap ${tone(w.pl)}`}>{rupees(w.pl)}</td>
                    <td className={`text-right tabular-nums font-bold ${tone(w.pl)}`}>{pct(w.roi)}</td>
                  </tr>
                  {open === w.label && w.leagues.filter((l) => l.bets).map((l) => (
                    <tr key={l.comp} className="text-gray-500">
                      <td className="py-1 pl-3">{l.name}</td>
                      <td className="text-right tabular-nums">{l.bets}</td>
                      <td className="text-right tabular-nums">{Math.round((100 * l.won) / l.bets)}%</td>
                      <td className="text-right tabular-nums">{l.avg_odds?.toFixed(2)}</td>
                      <td className={`text-right tabular-nums whitespace-nowrap ${tone(l.pl)}`}>{rupees(l.pl)}</td>
                      <td className={`text-right tabular-nums ${tone(l.pl)}`}>{pct(l.roi)}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
          <p className="text-[10px] text-gray-500 mt-1.5">
            ₹{stake} a match at the market's closing average; draws count as lost. Trust the "Since 2023/24" row more than the
            short ones - a month is a few dozen matches, and the setting that looks best over a month is often just luck.
          </p>
          {shown.length > 0 && (
            <div className="mt-3">
              <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">The bets · last 90 days</p>
              {shown.map((b, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px] py-1 border-t border-gray-100">
                  <span className="w-12 text-gray-400 shrink-0">{fmtDay(b.day)}</span>
                  <span className="flex-1 min-w-0 truncate">
                    <b className="text-gray-800">{b.pick}</b>{b.place ? <span className="text-gray-400"> #{b.place}</span> : ''}
                    <span className="text-gray-400"> · {b.match}</span>
                  </span>
                  <span className="tabular-nums text-gray-500">{b.odds.toFixed(2)}</span>
                  <span className={`w-14 text-right tabular-nums font-bold ${tone(b.pl)}`}>{rupees(b.pl)}</span>
                </div>
              ))}
              {d.recent.length > 15 && (
                <button onClick={() => setMore((m) => !m)} className="text-[11px] font-bold text-brand-600 mt-1">
                  {more ? 'Show fewer' : `Show all ${d.recent.length}`}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SportCard({ k, s, stake, edge }) {
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
          <Split s={s} stake={stake} edge={edge} />
          <p className="text-[10px] text-gray-400 mt-2">
            {s.auto_rule && `Every other played match: ₹${stake} on ${s.auto_rule}. `}
            {k === 'tennis' && s.no_price > 0 && `${s.no_price} matches had no kept pre-match price${s.priced_from ? ` (prices are kept from ${fmtDay(s.priced_from)} on - older days fill in as they're read back)` : ''} and aren't counted. `}
            {k === 'badminton' && s.auto?.bets > 0 && `Our prices carry no margin; at a bookmaker's ~8% margin those ${s.auto.bets} favourite bets would have made ${rupees(s.at_book_margin)} instead of ${rupees(s.auto.pl)}. `}
            {s.pending > 0 && `${s.pending} still to play. `}
            {s.unsettled > 0 && `${s.unsettled} without a price (not counted).`}
          </p>
          {s.chance && <Chance c={s.chance} stake={stake} />}
          {s.windows && <FavWindows s={s} stake={stake} />}
          <Bets bets={s.recent} suggested={s.suggested?.recent || []} />
        </>
      )}
    </div>
  )
}

export default function PnlDashboard() {
  const nav = useNavigate()
  const [days, setDays] = useState(30)
  const [stake, setStake] = useState(100)
  const [edge, setEdge] = useEdge()
  const [view, setView] = useState(() => { try { return sessionStorage.getItem('pnl.view') || 'all' } catch { return 'all' } })
  const pick = (v) => { setView(v); try { sessionStorage.setItem('pnl.view', v) } catch { /* private mode */ } }
  const [d, setD] = useState(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let alive = true
    setErr(false)
    const t = setTimeout(() => pnlBacktest(days, stake, edge).then((r) => { if (alive) setD(r.data) }).catch(() => { if (alive) setErr(true) }), 300)
    return () => { alive = false; clearTimeout(t) }
  }, [days, stake, edge])
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
        <div className="flex items-center gap-2 mt-2 text-[11px] font-semibold text-gray-600">
          Suggest when expected return ≥
          <div className="flex rounded-md border border-amber-300 overflow-hidden">
            {EDGES.map((e) => (
              <button key={e} onClick={() => setEdge(e)}
                className={`px-2 py-0.5 text-[11px] font-bold ${edge === e ? 'bg-green-700 text-white' : 'bg-white text-gray-600'}`}>{Math.round(100 * e)}%</button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-5 mt-2.5 rounded-md border border-amber-300 overflow-hidden">
          {[['all', 'All', ''], ...Object.entries(SPORT).map(([k, m]) => [k, m.icon, m.name])].map(([k, l, name]) => (
            <button key={k} onClick={() => pick(k)} title={name || 'All'}
              className={`py-1.5 text-[11px] font-bold whitespace-nowrap ${view === k ? 'bg-brand-400 text-white' : 'bg-white text-gray-600'}`}>
              {l}{name && <span className="hidden sm:inline"> {name}</span>}
            </button>
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
              <Split s={t} stake={stake} edge={d.edge} />
            </div>
            )}

            {series.some((x) => x.curve.length) && (
              <div className="card">
                <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Running P/L by day{view !== 'all' ? ` · ${SPORT[view].name}` : ''}</p>
                <Curve series={series} />
              </div>
            )}

            {view !== 'all' && <SportCard k={view} s={d.sports[view]} stake={stake} edge={d.edge} />}
            {view === 'football' && <TopTeams stake={stake} />}

            <p className="text-[10px] text-gray-400 text-center">
              Decimal odds: a win pays stake × (odds − 1), a loss costs the stake; walkovers and draws are void.
              My picks settle at the prices My picks uses; every other played match is a ₹{stake} bet on the favourite.
              Suggested bets are a separate line (not in the totals above): the matches where our chance × the price cleared {Math.round(100 * d.edge)}% expected return - tennis at the bookmakers' kept price, badminton and hockey where you entered one before the start. A threshold is a filter, not a promise: big apparent edges are often the model missing news.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
