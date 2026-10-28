import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { tennisDay, tennisH2H, tennisPlayer, tennisPlayers, tennisSets, tennisSetsTourney, tennisSummary } from '../api'
import DatePicker from '../components/DatePicker'

/**
 * /betting - ATP and WTA tour-level results, 2000 to today, laid out like a
 * scores app (backend routers/tennis.py; Anukul's alone). Results: a day at
 * a time, tournaments biggest first, rounds final first, each match two
 * lines with set columns. Players: record, surfaces, years, recent matches,
 * head-to-head.
 */
const ROUND_NAME = { F: 'Final', SF: 'Semifinals', QF: 'Quarterfinals', R16: 'Round of 16', R32: 'Round of 32',
  R64: 'Round of 64', R128: 'Round of 128', RR: 'Round robin', BR: 'Bronze medal', ER: 'Early rounds' }
const SURFACE = { Hard: 'bg-sky-100 text-sky-800', Clay: 'bg-orange-100 text-orange-800', Grass: 'bg-green-100 text-green-800',
  Carpet: 'bg-purple-100 text-purple-800' }
const TOURS = [['all', 'All'], ['ATP', 'ATP'], ['WTA', 'WTA']]

const fmtDay = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN',
  { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '')
const fmtShort = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN',
  { day: 'numeric', month: 'short', year: '2-digit' }) : '')

/** "6-4 6-7(4) 7-6(5) RET" -> sets from the winner's side: [{w, l, tb, tbOn}], and the ending. */
function parseScore(score) {
  const s = (score || '').trim()
  const end = /\bRET\b/i.test(s) ? 'Ret.' : /W\/O/i.test(s) ? 'W/O' : /\bDEF\b/i.test(s) ? 'Def.' : null
  const sets = []
  for (const m of s.matchAll(/(\d+)-(\d+)(?:\((\d+)\))?/g)) {
    const w = +m[1], l = +m[2], tb = m[3] != null ? +m[3] : null
    // The bracket is the loser's tie-break points, shown beside the side that lost the set.
    sets.push({ w, l, tb, tbOn: tb == null ? null : w > l ? 'l' : 'w' })
  }
  return { sets, end }
}

function Flag({ ioc }) {
  return <span className="inline-block w-8 text-[9px] font-bold text-gray-400 tracking-wider">{ioc || ''}</span>
}

function PlayerLine({ p, won, sets, side, onPlayer, tour }) {
  return (
    <div className={`flex items-center gap-1.5 ${won ? 'text-gray-900' : 'text-gray-400'}`}>
      <Flag ioc={p.ioc} />
      <button onClick={() => p.id && onPlayer(tour, p.id)}
        className={`flex-1 min-w-0 text-left truncate text-[13px] ${won ? 'font-bold' : 'font-medium'} hover:text-brand-600`}>
        {p.name}
        {p.seed && <span className="ml-1 text-[10px] font-semibold text-gray-400">({p.seed})</span>}
        {p.rank && <span className="ml-1 text-[9px] font-normal text-gray-300">#{p.rank}</span>}
      </button>
      <span className="w-3.5 text-center text-[10px] text-green-600 font-black">{won ? '✓' : ''}</span>
      {sets.map((st, i) => {
        const games = side === 'w' ? st.w : st.l
        const tookSet = side === 'w' ? st.w > st.l : st.l > st.w
        return (
          <span key={i} className={`w-6 text-center text-[13px] tabular-nums ${tookSet ? 'font-black' : 'font-medium'}`}>
            {games}{st.tbOn === side && <sup className="text-[8px] font-semibold ml-px">{st.tb}</sup>}
          </span>
        )
      })}
    </div>
  )
}

function MatchRow({ m, onPlayer, onH2H }) {
  const { sets, end } = parseScore(m.score)
  return (
    <div className="py-2 border-t border-gray-100 first:border-t-0">
      <PlayerLine p={m.winner} won sets={sets} side="w" onPlayer={onPlayer} tour={m.tour} />
      <PlayerLine p={m.loser} won={false} sets={sets} side="l" onPlayer={onPlayer} tour={m.tour} />
      {(end || m.minutes || onH2H) && (
        <div className="flex items-center gap-2 mt-0.5 pl-9 text-[10px] text-gray-400">
          {end && <span className="font-bold text-amber-600">{end}</span>}
          {m.minutes ? <span>{Math.floor(m.minutes / 60)}h {String(m.minutes % 60).padStart(2, '0')}m</span> : null}
          {onH2H && m.winner.id && m.loser.id && (
            <button onClick={() => onH2H(m)} className="font-bold text-brand-600 hover:underline">H2H</button>
          )}
        </div>
      )}
    </div>
  )
}

function TournamentCard({ t, onPlayer, onH2H }) {
  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-4 py-2.5 bg-field-950 text-white flex items-center gap-2">
        <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-white/15 tracking-wider">{t.tour}</span>
        <p className="text-sm font-bold flex-1 min-w-0 truncate">{t.name}</p>
        {t.surface && <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${SURFACE[t.surface] || 'bg-gray-100 text-gray-700'}`}>{t.surface}</span>}
      </div>
      {(t.level_name || t.whole_week) && (
        <p className="px-4 pt-2 text-[10px] text-gray-400">
          {t.level_name}{t.whole_week && `${t.level_name ? ' · ' : ''}whole tournament - day-by-day dates weren't recorded before 2025`}
        </p>
      )}
      <div className="px-4 pb-2">
        {t.rounds.map((r) => (
          <div key={r.round} className="mt-2">
            <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">{ROUND_NAME[r.round] || r.round}</p>
            {r.matches.map((m) => <MatchRow key={m.id} m={m} onPlayer={onPlayer} onH2H={onH2H} />)}
          </div>
        ))}
      </div>
    </div>
  )
}

function Results({ tour, onPlayer, onH2H }) {
  const [day, setDay] = useState(null)
  const [date, setDate] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setBusy(true)
    tennisDay(date, tour).then((r) => { setDay(r.data); if (!date && r.data.date) setDate(r.data.date) })
      .catch(() => setDay({ tournaments: [] })).finally(() => setBusy(false))
  }, [date, tour])
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button disabled={!day?.prev} onClick={() => setDate(day.prev)}
          className="px-3 py-2 rounded-md border border-amber-300 bg-white text-sm font-black disabled:opacity-30">‹</button>
        <DatePicker value={date} onChange={(v) => v && setDate(v)} className="flex-1" />
        <button disabled={!day?.next} onClick={() => setDate(day.next)}
          className="px-3 py-2 rounded-md border border-amber-300 bg-white text-sm font-black disabled:opacity-30">›</button>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold text-gray-500">
          {day?.date ? fmtDay(day.date) : ''}{day?.count ? ` · ${day.count} matches` : ''}
        </p>
        <button onClick={() => setDate('')} className="text-[11px] font-bold text-brand-600">Latest ›</button>
      </div>
      {busy && <p className="text-xs text-gray-400 text-center py-6">Loading…</p>}
      {!busy && day && day.tournaments.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-10">No matches on this day - use ‹ › to jump to the nearest day with results.</p>
      )}
      {!busy && day?.tournaments.map((t) => <TournamentCard key={`${t.tour}|${t.name}`} t={t} onPlayer={onPlayer} onH2H={onH2H} />)}
    </div>
  )
}

function Record({ label, r }) {
  if (!r || r.won == null) return null
  return (
    <div className="flex-1 min-w-[90px] rounded-md bg-white border border-amber-100 px-3 py-2">
      <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{label}</p>
      <p className="text-base font-black text-gray-900">{r.won}–{r.lost}</p>
      <p className="text-[10px] text-gray-500">{r.pct != null ? `${r.pct}% won` : '—'}</p>
    </div>
  )
}

function PlayerView({ sel, onPlayer, onH2H }) {
  const [p, setP] = useState(null)
  useEffect(() => {
    setP(null)
    tennisPlayer(sel.tour, sel.id).then((r) => setP(r.data)).catch(() => setP({ error: true }))
  }, [sel.tour, sel.id])
  if (!p) return <p className="text-xs text-gray-400 text-center py-6">Loading…</p>
  if (p.error) return <p className="text-sm text-red-600">Couldn't load this player.</p>
  const info = p.player
  const age = info.dob ? Math.floor((Date.now() - new Date(`${String(info.dob).slice(0, 4)}-${String(info.dob).slice(4, 6)}-${String(info.dob).slice(6, 8)}`)) / 31557600000) : null
  return (
    <div className="space-y-3">
      <div className="card">
        <p className="text-lg font-black text-gray-900">{info.name}</p>
        <p className="text-xs text-gray-500">
          {[info.tour, info.ioc, age && `${age} yrs`, info.hand && ({ R: 'right-handed', L: 'left-handed' }[info.hand] || null),
            info.height && `${info.height} cm`].filter(Boolean).join(' · ')}
          {p.titles ? ` · ${p.titles} title${p.titles === 1 ? '' : 's'}` : ''}
        </p>
        <div className="flex gap-2 mt-3 flex-wrap">
          <Record label="Career" r={p.record} />
          <Record label="Last 12 months" r={p.last_12_months} />
        </div>
        <div className="flex gap-2 mt-2 flex-wrap">
          {Object.entries(p.by_surface).map(([s, r]) => <Record key={s} label={s} r={r} />)}
        </div>
      </div>
      <div className="card">
        <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1">By year</p>
        {p.by_year.map((y) => (
          <div key={y.year} className="flex items-center gap-2 py-1 text-xs">
            <span className="w-10 font-bold text-gray-700">{y.year}</span>
            <div className="flex-1 h-2 bg-gray-100 rounded overflow-hidden">
              <div className="h-full bg-brand-400" style={{ width: `${y.pct || 0}%` }} />
            </div>
            <span className="w-20 text-right text-gray-600">{y.won}–{y.lost} · {y.pct}%</span>
          </div>
        ))}
      </div>
      <div className="card">
        <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Recent matches</p>
        {p.matches.map((m) => (
          <div key={m.id}>
            <p className="text-[10px] text-gray-400 mt-2">{fmtShort(m.date)} · {m.tournament} · {ROUND_NAME[m.round] || m.round}</p>
            <MatchRow m={m} onPlayer={onPlayer} onH2H={onH2H} />
          </div>
        ))}
      </div>
    </div>
  )
}

function Players({ tour, sel, setSel, onH2H }) {
  const [q, setQ] = useState('')
  const [found, setFound] = useState(null)
  const timer = useRef(null)
  useEffect(() => {
    clearTimeout(timer.current)
    if (q.trim().length < 2) { setFound(null); return }
    timer.current = setTimeout(() => tennisPlayers(q.trim(), tour).then((r) => setFound(r.data)).catch(() => setFound([])), 300)
    return () => clearTimeout(timer.current)
  }, [q, tour])
  return (
    <div className="space-y-3">
      <input className="input" placeholder="Search a player - e.g. Sinner, Swiatek" value={q}
        onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {found && !sel && (
        <div className="card p-0">
          {found.length === 0 && <p className="text-sm text-gray-400 px-4 py-3">No player matches “{q}”.</p>}
          {found.map((f) => (
            <button key={`${f.tour}|${f.player_id}`} onClick={() => setSel({ tour: f.tour, id: f.player_id })}
              className="w-full text-left px-4 py-2.5 border-t border-gray-100 first:border-t-0 flex items-center gap-2 hover:bg-amber-50">
              <span className="text-[9px] font-black text-gray-400 w-8">{f.tour}</span>
              <span className="flex-1 text-sm font-bold text-gray-900">{f.name}</span>
              <span className="text-[10px] text-gray-400">{f.ioc} · {f.n} matches · last {fmtShort(f.last)}</span>
            </button>
          ))}
        </div>
      )}
      {sel && (
        <>
          <button onClick={() => setSel(null)} className="text-xs font-bold text-gray-400">← Search results</button>
          <PlayerView sel={sel} onPlayer={(t, id) => setSel({ tour: t, id })} onH2H={onH2H} />
        </>
      )}
    </div>
  )
}

/* ---- Sets: how often a set goes over a games line (backend tennis_stats.py) ---- */
const LINES = [6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5]
const SET_ROWS = [['1', 'Set 1'], ['2', 'Set 2'], ['3', 'Set 3'], ['4', 'Set 4'], ['5', 'Set 5'],
  ['every', 'Every set'], ['any', 'Any set']]
const SURFACES = ['Hard', 'Clay', 'Grass', 'Carpet']
const fmtN = (n) => Number(n).toLocaleString('en-IN')

/** Adds histograms {games: count} into {n, over} for the line. */
function tally(hists, line) {
  let n = 0, over = 0
  for (const h of hists) for (const [g, c] of Object.entries(h)) { n += c; if (+g > line) over += c }
  return { n, over, pct: n ? (100 * over) / n : null }
}

const heat = (pct) => (pct == null ? '' : pct >= 75 ? 'bg-green-100' : pct >= 60 ? 'bg-green-50' : pct >= 45 ? 'bg-amber-50' : 'bg-red-50')

function PctCell({ t, showCount = true }) {
  if (!t || !t.n) return <td className="px-2 py-1.5 text-center text-gray-300">—</td>
  return (
    <td className={`px-2 py-1.5 text-center ${heat(t.pct)}`}>
      <p className="text-[13px] font-black text-gray-900 tabular-nums">{t.pct.toFixed(1)}%</p>
      {showCount && <p className="text-[9px] text-gray-500 tabular-nums">{fmtN(t.over)}/{fmtN(t.n)}</p>}
    </td>
  )
}

function Seg({ value, onChange, options }) {
  return (
    <div className="flex rounded-md border border-amber-300 overflow-hidden">
      {options.map(([k, l]) => (
        <button key={k} onClick={() => onChange(k)}
          className={`px-2.5 py-1.5 text-[11px] font-bold ${value === k ? 'bg-field-950 text-white' : 'bg-white text-gray-600'}`}>{l}</button>
      ))}
    </div>
  )
}

function TourneyYoY({ t, line }) {
  const [rows, setRows] = useState(null)
  useEffect(() => {
    setRows(null)
    tennisSetsTourney(t.tour, t.name).then((r) => setRows(r.data.rows)).catch(() => setRows([]))
  }, [t.tour, t.name])
  if (!rows) return <p className="text-xs text-gray-400 text-center py-4">Loading…</p>
  const years = [...new Set(rows.map((r) => r[0]))].sort().reverse()
  const cols = SET_ROWS.filter(([k]) => rows.some((r) => r[1] === k))
  const cell = (y, k) => tally(rows.filter((r) => (y == null || r[0] === y) && r[1] === k).map((r) => r[2]), line)
  const allYears = Object.fromEntries(cols.map(([k]) => [k, cell(null, k)]))
  return (
    <div className="overflow-x-auto -mx-4">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider">
            <th className="px-2 py-1 text-left">Year</th>
            {cols.map(([k, l]) => <th key={k} className="px-2 py-1">{l}</th>)}
          </tr>
        </thead>
        <tbody>
          <tr className="border-t-2 border-gray-200">
            <td className="px-2 py-1.5 font-black text-gray-900">All</td>
            {cols.map(([k]) => <PctCell key={k} t={allYears[k]} />)}
          </tr>
          {years.map((y) => {
            const prev = String(+y - 1)
            return (
              <tr key={y} className="border-t border-gray-100">
                <td className="px-2 py-1.5 font-bold text-gray-700">{y}</td>
                {cols.map(([k]) => {
                  const c = cell(y, k), p = years.includes(prev) ? cell(prev, k) : null
                  const d = c.n && p?.n ? c.pct - p.pct : null
                  return (
                    <td key={k} className={`px-2 py-1.5 text-center ${heat(c.n ? c.pct : null)}`}>
                      {c.n ? (
                        <>
                          <p className="text-[13px] font-black text-gray-900 tabular-nums">{c.pct.toFixed(0)}%</p>
                          <p className="text-[9px] text-gray-500 tabular-nums">
                            {c.over}/{c.n}
                            {d != null && <span className={`ml-1 font-bold ${d >= 0 ? 'text-green-700' : 'text-red-600'}`}>{d >= 0 ? '▲' : '▼'}{Math.abs(d).toFixed(0)}</span>}
                          </p>
                        </>
                      ) : <span className="text-gray-300">—</span>}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function SetStats({ tour }) {
  const [d, setD] = useState(null)
  const [line, setLine] = useState(8.5)
  const [bo, setBo] = useState('all')
  const [q, setQ] = useState('')
  const [pick, setPick] = useState(null)
  useEffect(() => { tennisSets().then((r) => setD(r.data)).catch(() => setD({ error: true })) }, [])
  if (!d) return <p className="text-xs text-gray-400 text-center py-6">Working out every set since 2000…</p>
  if (d.error) return <p className="text-sm text-red-600">Couldn't load the set statistics.</p>

  const rowsFor = (f) => d.rows.filter(([t, s, b]) => (bo === 'all' || String(b) === bo) && f(t, s))
  const pick1 = (tours, surface, set) => tally(rowsFor((t, s) => tours.includes(t) && (!surface || s === surface))
    .filter((r) => r[3] === set).map((r) => r[4]), line)
  const tours = tour === 'all' ? ['ATP', 'WTA'] : [tour]
  const label = tour === 'all' ? 'ATP + WTA' : tour
  const setRows = SET_ROWS.filter(([k]) => pick1(tours, null, k).n)
  const tlist = d.tournaments.filter((t) => tours.includes(t.tour) && (!q || t.name.toLowerCase().includes(q.toLowerCase())))

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-[11px] font-bold text-gray-500">Line</label>
        <select value={line} onChange={(e) => setLine(+e.target.value)}
          className="px-2 py-1.5 rounded-md border border-amber-300 bg-white text-xs font-bold">
          {LINES.map((l) => <option key={l} value={l}>Over {l} games</option>)}
        </select>
        <div className="ml-auto"><Seg value={bo} onChange={setBo} options={[['all', 'All'], ['3', 'Best of 3'], ['5', 'Best of 5']]} /></div>
      </div>

      <div className="card">
        <p className="text-sm font-black text-gray-900">{label} · over {line} games, set by set</p>
        <p className="text-[10px] text-gray-400 mb-2">
          A set over {line} has {Math.ceil(line)}+ games{line === 8.5 ? ' (6-3, 6-4, 7-5, 7-6 - not 6-0, 6-1, 6-2)' : ''}.
          Completed sets only. Every set / Any set: matches played out in full.
        </p>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider">
              <th className="py-1 text-left">Set</th><th className="py-1">Over</th><th className="py-1">Under</th><th className="py-1">Over %</th>
            </tr>
          </thead>
          <tbody>
            {setRows.map(([k, l]) => {
              const t = pick1(tours, null, k)
              return (
                <tr key={k} className={`border-t ${k === 'every' ? 'border-gray-300' : 'border-gray-100'}`}>
                  <td className="py-1.5 font-bold text-gray-800">{l}</td>
                  <td className="py-1.5 text-center tabular-nums font-bold text-green-700">{fmtN(t.over)}</td>
                  <td className="py-1.5 text-center tabular-nums text-gray-500">{fmtN(t.n - t.over)}</td>
                  <PctCell t={t} showCount={false} />
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="card">
        <p className="text-sm font-black text-gray-900">By surface · ATP vs WTA</p>
        <p className="text-[10px] text-gray-400 mb-2">Share of sets over {line}; difference in percentage points (ATP − WTA).</p>
        <div className="space-y-3">
          {SURFACES.map((s) => {
            const keys = SET_ROWS.filter(([k]) => pick1(['ATP', 'WTA'], s, k).n)
            if (!keys.length) return null
            return (
              <div key={s}>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${SURFACE[s]}`}>{s}</span>
                <table className="w-full text-xs mt-1">
                  <thead>
                    <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider">
                      <th className="py-1 text-left w-20">Set</th><th className="py-1">ATP</th><th className="py-1">WTA</th><th className="py-1">Diff</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map(([k, l]) => {
                      const a = pick1(['ATP'], s, k), w = pick1(['WTA'], s, k)
                      const diff = a.n && w.n ? a.pct - w.pct : null
                      return (
                        <tr key={k} className="border-t border-gray-100">
                          <td className="py-1 font-bold text-gray-800">{l}</td>
                          <PctCell t={a} /><PctCell t={w} />
                          <td className={`py-1 text-center font-black tabular-nums ${diff == null ? 'text-gray-300' : diff >= 0 ? 'text-sky-700' : 'text-pink-700'}`}>
                            {diff == null ? '—' : `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}`}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
          })}
        </div>
      </div>

      <div className="card">
        <p className="text-sm font-black text-gray-900">Tournament · year on year</p>
        <p className="text-[10px] text-gray-400 mb-2">Over {line} by set, each year; ▲▼ = change on the year before (points). Sponsor names are merged (BNP Paribas Open = Indian Wells).</p>
        {pick ? (
          <>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[9px] font-black text-gray-400">{pick.tour}</span>
              <p className="text-sm font-bold text-gray-900 flex-1">{pick.name}</p>
              <button onClick={() => setPick(null)} className="text-[11px] font-bold text-brand-600">Change ›</button>
            </div>
            <TourneyYoY t={pick} line={line} />
          </>
        ) : (
          <>
            <input className="input" placeholder="Search a tournament - e.g. Wimbledon, Indian Wells" value={q}
              onChange={(e) => setQ(e.target.value)} autoComplete="off" />
            <div className="mt-2 max-h-72 overflow-y-auto">
              {tlist.slice(0, 60).map((t) => (
                <button key={`${t.tour}|${t.name}`} onClick={() => setPick(t)}
                  className="w-full text-left px-2 py-2 border-t border-gray-100 first:border-t-0 flex items-center gap-2 hover:bg-amber-50">
                  <span className="text-[9px] font-black text-gray-400 w-8">{t.tour}</span>
                  <span className="flex-1 text-sm font-bold text-gray-900 truncate">{t.name}</span>
                  <span className="text-[10px] text-gray-400">{t.surface} · {t.first}–{t.last} · {fmtN(t.matches)}</span>
                </button>
              ))}
              {tlist.length === 0 && <p className="text-sm text-gray-400 px-2 py-3">No tournament matches “{q}”.</p>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function H2HSheet({ m, onClose, onPlayer }) {
  const [d, setD] = useState(null)
  useEffect(() => { tennisH2H(m.tour, m.winner.id, m.loser.id).then((r) => setD(r.data)).catch(() => setD({ matches: [] })) }, [m])
  return (
    <div className="fixed inset-0 bg-field-950/80 z-50 flex items-end md:items-center justify-center" onClick={onClose}>
      <div className="bg-cream w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-t-xl md:rounded-xl p-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-black text-gray-900">Head to head</p>
          <button onClick={onClose} className="text-gray-400 text-lg leading-none">×</button>
        </div>
        {!d ? <p className="text-xs text-gray-400 py-4 text-center">Loading…</p> : (
          <>
            <div className="flex items-center justify-between card mb-3">
              <span className="text-sm font-bold flex-1 truncate">{m.winner.name}</span>
              <span className="text-2xl font-black text-brand-600 px-3">{d.a_wins} – {d.b_wins}</span>
              <span className="text-sm font-bold flex-1 truncate text-right">{m.loser.name}</span>
            </div>
            <div className="card">
              {d.matches.map((x) => (
                <div key={x.id}>
                  <p className="text-[10px] text-gray-400 mt-2">{fmtShort(x.date)} · {x.tournament} · {ROUND_NAME[x.round] || x.round}{x.surface ? ` · ${x.surface}` : ''}</p>
                  <MatchRow m={x} onPlayer={(t, id) => { onClose(); onPlayer(t, id) }} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function BettingAnalytics() {
  const nav = useNavigate()
  const [tab, setTab] = useState('results')
  const [tour, setTour] = useState('all')
  const [sum, setSum] = useState(null)
  const [sel, setSel] = useState(null)       // the player open on the Players tab
  const [h2h, setH2H] = useState(null)
  useEffect(() => { tennisSummary().then((r) => setSum(r.data)).catch(() => {}) }, [])
  const openPlayer = (t, id) => { setSel({ tour: t, id }); setTab('players') }

  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-3 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <h1 className="text-xl font-black tracking-tight">Betting analytics</h1>
        <p className="text-[11px] text-gray-400 mt-0.5">
          {sum ? `ATP & WTA tour · ${Number(sum.n).toLocaleString('en-IN')} matches · ${fmtShort(sum.first)} – ${fmtShort(sum.last)}` : 'ATP & WTA tour results'}
          {sum?.last_update ? ` · updated ${fmtShort(sum.last_update.slice(0, 10))}` : ''}
        </p>
        <div className="flex items-center gap-2 mt-3">
          <div className="flex rounded-md border border-amber-300 overflow-hidden">
            {[['results', 'Results'], ['players', 'Players'], ['sets', 'Sets']].map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)}
                className={`px-3 py-1.5 text-xs font-bold ${tab === k ? 'bg-brand-400 text-white' : 'bg-white text-gray-600'}`}>{l}</button>
            ))}
          </div>
          <div className="flex rounded-md border border-amber-300 overflow-hidden ml-auto">
            {TOURS.map(([k, l]) => (
              <button key={k} onClick={() => setTour(k)}
                className={`px-2.5 py-1.5 text-xs font-bold ${tour === k ? 'bg-field-950 text-white' : 'bg-white text-gray-600'}`}>{l}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="px-5 mt-4 max-w-2xl">
        {tab === 'results' && <Results tour={tour} onPlayer={openPlayer} onH2H={setH2H} />}
        {tab === 'players' && <Players tour={tour} sel={sel} setSel={setSel} onH2H={setH2H} />}
        {tab === 'sets' && <SetStats tour={tour} />}
      </div>
      {h2h && <H2HSheet m={h2h} onClose={() => setH2H(null)} onPlayer={openPlayer} />}
    </div>
  )
}
