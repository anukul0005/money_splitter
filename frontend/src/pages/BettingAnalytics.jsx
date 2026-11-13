import { Component, memo, useEffect, useRef, useState, useTransition } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { badmintonLive, badmintonSummary, hockeyLive, peek, tennisDay, tennisEarlyBreak, tennisLive, tennisLivePoints, tennisMyPicks, tennisOddsDays, tennisPatterns, tennisPickHistory, sportPickHistory, tennisPlayer, tennisPlayers, tennisPressure, tennisRankings, onBackInView, tennisSets, tennisSetsTourney, tennisSummary } from '../api'
import RankingList, { RankingSwitch } from '../components/RankingList'
import Badminton, { B_TABS } from './Badminton'
import Hockey, { H_TABS } from './Hockey'
import DatePicker from '../components/DatePicker'

/**
 * /betting - ATP and WTA tour-level results, 2000 to today, laid out like a
 * scores app (backend routers/tennis.py; Anukul's alone). Results: a day at
 * a time, tournaments biggest first, rounds final first, each match two
 * lines with set columns. Players: record, surfaces, years, recent matches,
 * head-to-head.
 */
export const ROUND_NAME = { F: 'Final', SF: 'Semifinals', QF: 'Quarterfinals', R16: 'Round of 16', R32: 'Round of 32',
  R64: 'Round of 64', R128: 'Round of 128', RR: 'Round robin', BR: 'Bronze medal', ER: 'Early rounds' }
export const SURFACE = { Hard: 'bg-sky-100 text-sky-800', Clay: 'bg-orange-100 text-orange-800', Grass: 'bg-green-100 text-green-800',
  Carpet: 'bg-purple-100 text-purple-800' }
const TOURS = [['all', 'All'], ['ATP', 'ATP'], ['WTA', 'WTA']]

const fmtDay = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN',
  { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '')
export const fmtShort = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN',
  { day: 'numeric', month: 'short', year: '2-digit' }) : '')

/** "6-4 6-7(4) 7-6(5) RET" -> sets from the winner's side: [{w, l, tb, tbOn}], and the ending. */
export function parseScore(score) {
  const s = (score || '').trim()
  const end = /\bRET\b/i.test(s) ? 'Ret.' : /W\/O/i.test(s) ? 'W/O' : /\bDEF\b/i.test(s) ? 'Def.' : null
  const sets = []
  for (const m of s.matchAll(/(\d+)-(\d+)(?:\((\d+)\))?/g)) {
    const w = +m[1], l = +m[2], tb = m[3] != null ? +m[3] : null
    // The bracket is the loser's tie-break points, shown beside the side that lost the set.
    // The bracket is the set loser's tie-break points; the winner's follow: 7, or two past them from 6 up.
    const tbLost = tb, tbWon = tb == null ? null : Math.max(7, tb + 2)
    sets.push({ w, l, tb, tbOn: tb == null ? null : w > l ? 'l' : 'w',
      tbW: tb == null ? null : w > l ? tbWon : tbLost, tbL: tb == null ? null : w > l ? tbLost : tbWon })
  }
  return { sets, end }
}

/** A stored score as text from one player's side ("7⁷-6⁴ 5-7"): won = that player won the match. */
export function ScoreText({ score, won = true }) {
  const { sets, end } = parseScore(score)
  if (!sets.length) return <>{score}</>
  return (
    <>
      {sets.map((st, i) => {
        const [a, b, ta, tb] = won ? [st.w, st.l, st.tbW, st.tbL] : [st.l, st.w, st.tbL, st.tbW]
        return (
          <span key={i} className="ml-1 first:ml-0">
            {a}{st.tb != null && <sup className="text-[8px]">{ta}</sup>}-{b}{st.tb != null && <sup className="text-[8px]">{tb}</sup>}
          </span>
        )
      })}
      {end && <span className="ml-1 text-amber-600 font-bold">{end}</span>}
    </>
  )
}

/** A crash inside shows a line, not a blank white page. */
export class Safe extends Component {
  constructor(props) { super(props); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  render() {
    if (this.state.err) {
      return (
        <div className="card text-sm text-red-600">
          Couldn't show {this.props.what}.{' '}
          <button className="font-bold underline" onClick={() => this.setState({ err: null })}>Try again</button>
        </div>
      )
    }
    return this.props.children
  }
}

// ── kept pre-match odds (backend tennis_odds) ──
const nm = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[-'’.]/g, ' ').split(/\s+/).filter(Boolean)
export const surname = (n) => nm(n).slice(-1)[0] || ''
const isoDay = (d) => new Date(d).toISOString().slice(0, 10)
const addDays = (iso, n) => isoDay(new Date(`${iso.slice(0, 10)}T12:00:00Z`).getTime() + n * 86400000)

/** The kept odds between two days (ISO), reloaded when `tick` changes. */
export function useKeptOdds(start, end, tick) {
  const [list, setList] = useState(null)
  useEffect(() => {
    if (!start || !end) return
    tennisOddsDays(start, end).then((r) => setList(r.data.odds)).catch(() => {})
  }, [start, end, tick])
  return list
}

/** A match's kept prices {surname: {median, best, books}}, a day either side of `day`. */
export function findOdds(list, tour, a, b, day) {
  if (!list || !a || !b) return null
  const pair = [surname(a), surname(b)].sort().join('|')
  const d = day ? new Date(`${String(day).slice(0, 10)}T12:00:00Z`).getTime() : Date.now()
  let best = null
  for (const o of list) {
    if (o.pair !== pair || (tour && o.tour !== tour)) continue
    const gap = Math.abs(new Date(`${o.day}T12:00:00Z`).getTime() - d) / 86400000
    if (gap <= 1.01 && (!best || gap < best.gap)) best = { gap, o }
  }
  return best?.o.prices || null
}

/** A player's pre-match price beside their name - the favourite's darker. */
export function OddsTag({ prices, name }) {
  const p = prices?.[surname(name)]
  if (!p) return <span className="w-9" />
  const fav = Math.min(...Object.values(prices).map((x) => x.median)) === p.median
  return <span className={`w-9 text-right text-[11px] tabular-nums ${fav ? 'font-black text-gray-700' : 'font-semibold text-gray-400'}`}>{p.median.toFixed(2)}</span>
}

export function Flag({ ioc }) {
  return <span className="inline-block w-8 text-[9px] font-bold text-gray-400 tracking-wider">{ioc || ''}</span>
}

function PlayerLine({ p, won, sets, side, onPlayer, tour, odds }) {
  return (
    <div className={`flex items-center gap-1.5 ${won ? 'text-gray-900' : 'text-gray-400'}`}>
      <Flag ioc={p.ioc} />
      {/* the name opens the player; the rest of the row opens the match */}
      <button onClick={(e) => { e.stopPropagation(); if (p.id && onPlayer) onPlayer(tour, p.id) }}
        className={`flex-1 min-w-0 text-left truncate text-[13px] ${won ? 'font-bold' : 'font-medium'} hover:text-brand-600`}>
        {p.name}
        {p.seed && <span className="ml-1 text-[10px] font-semibold text-gray-400">({p.seed})</span>}
        {p.rank && <span className="ml-1 text-[9px] font-normal text-gray-300">#{p.rank}</span>}
      </button>
      {odds && <OddsTag prices={odds} name={p.name} />}
      <span className="w-3.5 text-center text-[10px] text-green-600 font-black">{won ? '✓' : ''}</span>
      {sets.map((st, i) => {
        const games = side === 'w' ? st.w : st.l
        const tookSet = side === 'w' ? st.w > st.l : st.l > st.w
        return (
          <span key={i} className={`w-6 text-center text-[13px] tabular-nums ${tookSet ? 'font-black' : 'font-medium'}`}>
            {games}{st.tb != null && <sup className="text-[8px] font-semibold ml-px">{side === 'w' ? st.tbW : st.tbL}</sup>}
          </span>
        )
      })}
    </div>
  )
}

/** A match: tap it for its own page (form, head-to-head, set habits); tap a name for that player. */
export function MatchRow({ m, onPlayer, onOpen, odds }) {
  const { sets, end } = parseScore(m.score)
  return (
    <div onClick={onOpen ? () => onOpen(m) : undefined}
      className={`py-2 border-t border-gray-100 first:border-t-0 ${onOpen ? 'cursor-pointer active:bg-amber-50 hover:bg-amber-50/50 -mx-2 px-2 rounded' : ''}`}>
      <PlayerLine p={m.winner} won sets={sets} side="w" onPlayer={onPlayer} tour={m.tour} odds={odds} />
      <PlayerLine p={m.loser} won={false} sets={sets} side="l" onPlayer={onPlayer} tour={m.tour} odds={odds} />
      {(end || m.minutes || onOpen) && (
        <div className="flex items-center gap-2 mt-0.5 pl-9 text-[10px] text-gray-400">
          {end && <span className="font-bold text-amber-600">{end}</span>}
          {m.minutes ? <span>{Math.floor(m.minutes / 60)}h {String(m.minutes % 60).padStart(2, '0')}m</span> : null}
          {onOpen && <span className="ml-auto font-bold text-brand-600">Match ›</span>}
        </div>
      )}
    </div>
  )
}

function TournamentCard({ t, onPlayer, onOpen, odds }) {
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
            {r.matches.map((m) => <MatchRow key={m.id} m={m} onPlayer={onPlayer} onOpen={onOpen}
              odds={findOdds(odds, m.tour, m.winner.name, m.loser.name, m.date)} />)}
          </div>
        ))}
      </div>
    </div>
  )
}

function Results({ tour, fresh, onPlayer, onOpen }) {
  const [day, setDay] = useState(() => peek('/tennis/day', { date: '', tour }) || null)
  const [date, setDate] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setBusy(!fresh && !peek('/tennis/day', { date, tour }))   // a refresh, or a day seen before, reloads quietly
    tennisDay(date, tour).then((r) => { setDay(r.data); if (!date && r.data.date) setDate(r.data.date) })
      .catch(() => setDay({ tournaments: [] })).finally(() => setBusy(false))
  }, [date, tour, fresh])
  const kept = useKeptOdds(day?.date && addDays(day.date, -1), day?.date && addDays(day.date, 1), fresh)
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
        <p className="text-sm text-gray-400 text-center py-10">
          {day.date >= new Date().toLocaleDateString('en-CA')
            // today or later: not "no tennis" - just none finished yet
            ? "No match has finished yet on this day - each one shows here within 15 minutes of ending. What's coming up is on the Live tab."
            : 'No matches on this day - use ‹ › to jump to the nearest day with results.'}
        </p>
      )}
      {!busy && day?.tournaments.map((t) => <TournamentCard key={`${t.tour}|${t.name}`} t={t} onPlayer={onPlayer} onOpen={onOpen} odds={kept} />)}
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

function PlayerView({ sel, onPlayer, onOpen }) {
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
      {p.early_break && <Safe what="the early-break pattern"><PlayerEarlyBreak d={p.early_break} name={info.name} /></Safe>}
      {p.pressure && <Safe what="the pressure pattern"><PlayerPressure d={p.pressure} name={info.name} /></Safe>}
      {p.sets?.length > 0 && p.sets[0].length === 5 && (
        <Safe what="set statistics"><PlayerSets rows={p.sets} vs={p.sets_vs} name={info.name} /></Safe>
      )}
      <div className="card">
        <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1">
          By year{p.by_year.length > 1 && <span className="normal-case tracking-normal font-semibold text-gray-400"> · {p.by_year[p.by_year.length - 1].year} – {p.by_year[0].year}</span>}
        </p>
        {p.by_year.map((y) => (
          <div key={y.year} className="flex items-center gap-2 py-1 text-xs">
            <span className="w-10 font-bold text-gray-700">{y.year}</span>
            <div className="flex-1 h-2 bg-gray-100 rounded overflow-hidden">
              <div className="h-full bg-brand-400" style={{ width: `${y.pct || 0}%` }} />
            </div>
            <span className="w-20 text-right text-gray-600">
              {y.won + y.lost ? `${y.won}–${y.lost} · ${y.pct}%` : <span className="text-gray-400">no matches</span>}
            </span>
          </div>
        ))}
      </div>
      <div className="card">
        <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Recent matches</p>
        {p.matches.map((m) => (
          <div key={m.id}>
            <p className="text-[10px] text-gray-400 mt-2">{fmtShort(m.date)} · {m.tournament} · {ROUND_NAME[m.round] || m.round}</p>
            <MatchRow m={m} onPlayer={onPlayer} onOpen={onOpen} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** The ATP / WTA top 20 (ESPN, now), a tap away from the top 100; a ranked name opens that player. */
function TourRankings({ tour, onPick }) {
  const [rk, setRk] = useState(null)
  useEffect(() => { tennisRankings(tour).then((r) => setRk(r.data)).catch(() => setRk({ rows: [] })) }, [tour])
  const rows = (rk?.rows || []).map((r) => ({
    rank: r.rank, change: r.previous && r.rank ? r.previous - r.rank : 0, country: r.ioc, points: r.points,
    names: [{ name: r.name, onClick: r.player_id ? () => onPick({ tour, id: r.player_id }) : null }],
  }))
  return (
    <RankingList title={`${tour} rankings`} sub={rk?.updated ? `as of ${fmtShort(rk.updated.slice(0, 10))}` : ''}
      rows={rows} first={20} max={100} loading={!rk} />
  )
}

function Players({ tour, sel, setSel, onOpen }) {
  const [q, setQ] = useState('')
  const [rt, setRt] = useState(tour === 'WTA' ? 'WTA' : 'ATP')       // the rankings shown: men's or women's
  useEffect(() => { if (tour !== 'all') setRt(tour) }, [tour])
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
      {!sel && !found && (
        <RankingSwitch value={rt} onChange={setRt} options={[['ATP', "Men's singles · ATP"], ['WTA', "Women's singles · WTA"]]}>
          <TourRankings key={rt} tour={rt} onPick={setSel} />
        </RankingSwitch>
      )}
      {sel && (
        <>
          <button onClick={() => setSel(null)} className="text-xs font-bold text-gray-400">← Search results</button>
          <PlayerView sel={sel} onPlayer={(t, id) => setSel({ tour: t, id })} onOpen={onOpen} />
        </>
      )}
    </div>
  )
}

/* ---- Sets: how often a set goes over a games line (backend tennis_stats.py) ---- */
const LINES = [6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5]
const SET_ROWS = [['1', 'Set 1'], ['2', 'Set 2'], ['3', 'Set 3'], ['4', 'Set 4'], ['5', 'Set 5'],
  ['every', 'Every set'], ['any', 'Any set']]
const SURFACES = ['Hard', 'Clay', 'Grass']
const fmtN = (n) => Number(n).toLocaleString('en-IN')

/** Adds histograms {games: count} into {n, over} for the line. */
function tally(hists, line) {
  let n = 0, over = 0
  for (const h of hists) {
    if (!h || typeof h !== 'object') continue          // a reply in another shape (mid-deploy) - skip, don't crash
    for (const [g, c] of Object.entries(h)) { n += +c || 0; if (+g > line) over += +c || 0 }
  }
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
          Completed sets only; best-of-five only at the Grand Slams; no carpet. Every set / Any set: matches played out in full.
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

/** A player's sets over a games line: set 1-5 / every / any, career, last 12 months, by surface. */
function PlayerSets({ rows, vs, name }) {
  const [line, setLine] = useState(8.5)
  const [scope, setScope] = useState('Career')
  // rows: [period, surface, set, outcome W/L/M, {games: count}]
  const cols = [['all', null, 'Career'], ['12m', null, '12 months'],
    ...SURFACES.filter((s) => rows.some((r) => r[0] === 'all' && r[1] === s)).map((s) => ['all', s, s])]
  const pick = (period, surface, set, outcome) => rows.filter((r) => r[0] === period && (!surface || r[1] === surface)
    && (set === 'sets' ? /^\d$/.test(r[2]) : r[2] === set) && (!outcome || r[3] === outcome)).map((r) => r[4])
  const cell = (period, surface, set) => tally(pick(period, surface, set), line)
  const setRows = SET_ROWS.filter(([k]) => cell('all', null, k).n)
  const [sp, ss] = cols.find((c) => c[2] === scope) || cols[0]
  const bySet = [...setRows.filter(([k]) => /^\d$/.test(k)), ['sets', 'All sets']]
  const firstName = (name || '').split(' ').slice(-1)[0]
  return (
    <>
    <div className="card">
      <div className="flex items-center gap-2 mb-1">
        <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest flex-1">Sets over {line} games</p>
        <select value={line} onChange={(e) => setLine(+e.target.value)}
          className="px-2 py-1 rounded-md border border-amber-300 bg-white text-[11px] font-bold">
          {LINES.map((l) => <option key={l} value={l}>Over {l}</option>)}
        </select>
      </div>
      <div className="overflow-x-auto -mx-4">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider">
              <th className="px-2 py-1 text-left">Set</th>
              {cols.map(([, , l]) => <th key={l} className="px-2 py-1">{l}</th>)}
            </tr>
          </thead>
          <tbody>
            {setRows.map(([k, l]) => (
              <tr key={k} className={`border-t ${k === 'every' ? 'border-gray-300' : 'border-gray-100'}`}>
                <td className="px-2 py-1.5 font-bold text-gray-800 whitespace-nowrap">{l}</td>
                {cols.map(([pd, s, cl]) => <PctCell key={cl} t={cell(pd, s, k)} />)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-gray-400 mt-1">Completed sets only; best-of-five only at the Grand Slams; no carpet.</p>
    </div>

    <div className="card">
      <div className="flex flex-wrap gap-1 mb-2">
        {cols.map(([, , cl]) => (
          <button key={cl} onClick={() => setScope(cl)}
            className={`px-2 py-1 rounded text-[10px] font-bold border ${scope === cl ? 'bg-field-950 text-white border-field-950' : 'bg-white text-gray-600 border-amber-300'}`}>{cl}</button>
        ))}
      </div>

      <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Over {line} sets · who took them</p>
      <p className="text-[10px] text-gray-400 mb-1">Of the sets that went over {line} games, how many {firstName} won.</p>
      <table className="w-full text-xs mb-4">
        <thead>
          <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider">
            <th className="py-1 text-left">Set</th><th className="py-1">Over sets</th><th className="py-1">Won</th><th className="py-1">Lost</th><th className="py-1">Won %</th>
          </tr>
        </thead>
        <tbody>
          {bySet.map(([k, l]) => {
            const w = tally(pick(sp, ss, k, 'W'), line), lo = tally(pick(sp, ss, k, 'L'), line)
            const over = w.over + lo.over
            const t = { n: over, over: w.over, pct: over ? (100 * w.over) / over : null }
            return (
              <tr key={k} className={`border-t ${k === 'sets' ? 'border-gray-300' : 'border-gray-100'}`}>
                <td className="py-1.5 font-bold text-gray-800">{l}</td>
                <td className="py-1.5 text-center tabular-nums">{fmtN(over)}</td>
                <td className="py-1.5 text-center tabular-nums font-bold text-green-700">{fmtN(w.over)}</td>
                <td className="py-1.5 text-center tabular-nums text-red-600">{fmtN(lo.over)}</td>
                <PctCell t={t} showCount={false} />
              </tr>
            )
          })}
        </tbody>
      </table>

      <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Dominant set wins · under the line</p>
      <p className="text-[10px] text-gray-400 mb-1">Sets that ended with that scoreline, either way: how many {firstName} won of them, and that share.</p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider">
            <th className="py-1 text-left">Set</th>
            <th className="py-1">Under 8.5<br /><span className="normal-case font-semibold">6-2 or better</span></th>
            <th className="py-1">Under 7.5<br /><span className="normal-case font-semibold">6-1 or better</span></th>
            <th className="py-1">Under 6.5<br /><span className="normal-case font-semibold">6-0</span></th>
          </tr>
        </thead>
        <tbody>
          {bySet.map(([k, l]) => {
            const won = pick(sp, ss, k, 'W'), lost = pick(sp, ss, k, 'L')
            return (
              <tr key={k} className={`border-t ${k === 'sets' ? 'border-gray-300' : 'border-gray-100'}`}>
                <td className="py-1.5 font-bold text-gray-800">{l}</td>
                {[8.5, 7.5, 6.5].map((u) => {
                  const w = tally(won, u), lo = tally(lost, u)
                  const under = w.n - w.over, lUnder = lo.n - lo.over, all = under + lUnder
                  const t = { n: all, over: under, pct: all ? (100 * under) / all : null }
                  return (
                    <td key={u} className={`py-1.5 text-center ${heat(t.pct)}`}>
                      {all ? (
                        <>
                          <p className="text-[13px] font-black text-gray-900 tabular-nums">{t.pct.toFixed(0)}%</p>
                          <p className="text-[9px] text-gray-500 tabular-nums">won {fmtN(under)} of {fmtN(all)}</p>
                          <p className="text-[9px] text-red-500 tabular-nums">lost {fmtN(lUnder)}</p>
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

      {vs?.length > 0 && vs[0].length === 5 && (
        <>
          <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mt-4">Sets against stronger players</p>
          <p className="text-[10px] text-gray-400 mb-1">
            Every set against players ranked higher / in the top 5, 10, 20 at the time (ranking; the tournament
            seed for 2026, where ESPN gives only seeds), split by how the set ended. Each box: the share of those
            sets {firstName} <b>won</b>, how many sets there were, then <span className="text-green-700 font-bold">won</span> · <span className="text-red-600 font-bold">lost</span>.
            The columns don't overlap, so they add up to the total; under 8.5 = 6-2 + 6-1 + 6-0.
          </p>
          <div className="overflow-x-auto -mx-4">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider">
                <th className="px-2 py-1 text-left">Opponent</th>
                <th className="px-1 py-1">Over 8.5<br /><span className="normal-case font-semibold">6-3 or closer</span></th>
                <th className="px-1 py-1">6-2</th><th className="px-1 py-1">6-1</th><th className="px-1 py-1">6-0</th>
                <th className="px-1 py-1">Total</th>
              </tr>
            </thead>
            <tbody>
              {[['above', 'Ranked higher'], ['top5', 'Top 5'], ['top10', 'Top 10'], ['top20', 'Top 20']].map(([tag, l]) => {
                const get = (o) => vs.filter((r) => r[0] === sp && (!ss || r[1] === ss) && r[2] === tag && r[3] === o).map((r) => r[4])
                const L = get('L'), W = get('W')
                const mW = tally(get('MW'), -1).n, mL = tally(get('ML'), -1).n
                // games in the set: 9+ = over 8.5; 8 = 6-2; 7 = 6-1; 6 = 6-0
                const span = (hs, lo, hi) => hs.reduce((s, h) => s + Object.entries(h || {})
                  .reduce((a, [g, c]) => a + (+g >= lo && +g <= hi ? +c : 0), 0), 0)
                const buckets = [[9, 99], [8, 8], [7, 7], [6, 6], [0, 99]]
                return (
                  <tr key={tag} className="border-t border-gray-100">
                    <td className="px-2 py-1.5 font-bold text-gray-800">{l}
                      {(mW + mL) > 0 && (
                        <p className="text-[9px] font-normal text-gray-400 whitespace-nowrap">
                          {fmtN(mW + mL)} matches · <span className="text-green-700">{mW} W</span>–<span className="text-red-600">{mL} L</span>
                        </p>
                      )}
                    </td>
                    {buckets.map(([lo, hi], i) => {
                      const w = span(W, lo, hi), l = span(L, lo, hi), n = w + l
                      const pct = n ? (100 * w) / n : null
                      return (
                        <td key={i} className={`px-1 py-1.5 text-center ${heat(pct)} ${i === 4 ? 'border-l-2 border-gray-300' : ''}`}>
                          {n ? (
                            <>
                              <p className="text-[13px] font-black text-gray-900 tabular-nums">{pct.toFixed(0)}%</p>
                              <p className="text-[9px] font-bold text-gray-600 tabular-nums whitespace-nowrap">{fmtN(n)} set{n === 1 ? '' : 's'}</p>
                              <p className="text-[9px] tabular-nums whitespace-nowrap">
                                <span className="text-green-700">{fmtN(w)}</span><span className="text-gray-400"> · </span><span className="text-red-600">{fmtN(l)}</span>
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
        </>
      )}
    </div>
    </>
  )
}

/* ---- Early break: a break in a set's first 4 games -> the set under 8.5 games (backend tennis_early_break) ---- */
const useEarlyBreak = (on = true) => {
  const [d, setD] = useState(null)
  useEffect(() => { if (on) tennisEarlyBreak().then((r) => setD(r.data)).catch(() => {}) }, [on])
  return d
}
const ebPct = (c) => (c?.n ? (100 * c.under) / c.n : null)
// The scores worth a look: still open, the under not a near-certainty (4-0, 5-0, 5-1 and 3-0 two
// breaks up are left out); 3-0 only with the leader one break up ("/1")
const EB_SCORES = [['2-0', '2-0'], ['3-0/1', '3-0 (1 break)'], ['3-1', '3-1'], ['4-1', '4-1'], ['4-2', '4-2'], ['5-2', '5-2']]
// a set being played at one of them, past game 4
const ebScore = (a, b) => {
  const k = `${Math.max(a, b)}-${Math.min(a, b)}`
  return a + b >= 4 && EB_SCORES.some(([s]) => s === k) ? k : null
}

function EarlyBreakPattern() {
  const d = useEarlyBreak()
  if (!d) return <p className="text-xs text-gray-400 text-center py-4">Loading the early-break pattern…</p>
  const T = d.tours || {}
  if (!T.ATP) return null
  const row = (t, k) => T[t].rows.find((r) => r.key === k)
  const Cell = ({ c, strong }) => {
    const p = ebPct(c)
    return (
      <td className="px-1 py-1.5 text-center">
        <p className={`tabular-nums ${strong ? 'text-[14px] font-black text-gray-900' : 'text-[13px] font-bold text-gray-800'}`}>{p == null ? '—' : `${p.toFixed(1)}%`}</p>
        <p className="text-[9px] text-gray-500 tabular-nums">{c?.n ? `${fmtN(c.under)} of ${fmtN(c.n)}` : ''}</p>
      </td>
    )
  }
  const odds = (c) => { const p = ebPct(c); return p ? (100 / p).toFixed(2) : '—' }
  return (
    <div className="space-y-3">
      <div className="card space-y-1">
        <p className="text-sm font-black text-gray-900">Early break → set under 8.5</p>
        <p className="text-[10px] text-gray-400">
          A break of serve in a set's first 4 games, and how often that set then ended 6-0, 6-1 or 6-2 (8 games or
          fewer). Point-by-point logs of {fmtN(T.ALL?.rows?.[0]?.n || 0)} sets from {d.from_year} on (the Match Charting
          Project - it leans to the bigger matches).
        </p>
      </div>
      <div className="card">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider">
              <th className="py-1 text-left">Set under 8.5</th><th className="py-1">ATP</th><th className="py-1">WTA</th>
            </tr>
          </thead>
          <tbody>
            {/* 4-0 left out: a double break is under 8.5 almost by itself, it tells nothing */}
            {T.ATP.rows.filter((r) => r.key !== '40').map((r) => {
              const strong = r.key === 'early'
              return (
                <tr key={r.key} className={`border-t ${strong ? 'border-gray-300 bg-amber-50' : 'border-gray-100'}`}>
                  <td className={`py-1.5 ${['22', '31', 'g12', 'g34'].includes(r.key) ? 'pl-3 text-gray-700' : 'font-bold text-gray-900'}`}>{r.label}</td>
                  <Cell c={row('ATP', r.key)} strong={strong} />
                  <Cell c={row('WTA', r.key)} strong={strong} />
                </tr>
              )
            })}
            <tr className="border-t border-gray-100">
              <td className="py-1.5 text-gray-500">Early breaker (not broken back by game 4) wins the set</td>
              {['ATP', 'WTA'].map((t) => {
                const b = T[t].breaker_wins
                return <td key={t} className="py-1.5 text-center text-[12px] font-bold text-gray-500 tabular-nums">{b.n ? `${((100 * b.won) / b.n).toFixed(1)}%` : '—'}</td>
              })}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="card">
        <p className="text-xs font-black text-gray-800 mb-1">From the score in the set</p>
        <p className="text-[10px] text-gray-400 mb-1">
          Every set that was ever at this score (either player ahead), how often it ended under 8.5. Break-even
          odds are worked out from that rate (100 ÷ the %), not taken from a bookmaker: a price above them
          pays over the long run if the rate holds, below them it loses.
        </p>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider">
              <th className="py-1 text-left">Score</th><th className="py-1">ATP</th><th className="py-1">WTA</th><th className="py-1">Break-even odds</th>
            </tr>
          </thead>
          <tbody>
            {EB_SCORES.map(([k, label]) => (
              <tr key={k} className="border-t border-gray-100">
                <td className="py-1.5 font-bold text-gray-900 tabular-nums">{label}</td>
                <Cell c={T.ATP.by_score[k]} />
                <Cell c={T.WTA.by_score[k]} />
                <td className="py-1.5 text-center text-[11px] font-bold text-gray-500 tabular-nums">{odds(T.ATP.by_score[k])} / {odds(T.WTA.by_score[k])}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[10px] text-gray-400 mt-2">
          How sets with an early break finished: {(T.ALL?.finals || []).map(([s, n]) => `${s} ${((100 * n) / T.ALL.early_n).toFixed(0)}%`).join(' · ')}
        </p>
      </div>
    </div>
  )
}

/** A player's early-break pattern from their side, next to the tour's average (backend tennis_early_break.player). */
const PEB_ROWS = [
  ['head', 'When they break early (not broken back by game 4)'],
  ['broke', 1, 'Set ends under 8.5'],
  ['broke', 2, 'They win the set'],
  ['broke', 3, 'They close it 6-2 or better'],
  ['up40', 1, 'Up 4-0 after 4 → under 8.5'],
  ['up31', 1, 'Up 3-1 after 4 → under 8.5'],
  ['head', 'When they are broken early'],
  ['broken', 1, 'Set ends under 8.5'],
  ['broken', 2, 'They still win the set'],
  ['down13', 1, 'Down 1-3 after 4 → under 8.5'],
  ['head', 'Other sets'],
  ['level', 1, 'Early break, level by game 4 → under 8.5'],
  ['none', 1, 'No break in games 1-4 → under 8.5'],
  ['all', 1, 'Every set → under 8.5'],
]
function PlayerEarlyBreak({ d, name }) {
  const me = d.player, avg = d.avg || {}
  const pct = (c, i) => (c?.[0] ? (100 * c[i]) / c[0] : null)
  return (
    <div className="card">
      <p className="text-sm font-black text-gray-900">Early break → set under 8.5</p>
      <p className="text-[10px] text-gray-400 mb-1">
        {name}'s sets from {d.from_year} on with a break in the first 4 games - {fmtN(me.all[0])} charted sets from {fmtN(me.matches)} matches
        (Match Charting Project), against every player on the tour.
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider">
            <th className="py-1 text-left" /><th className="py-1">{name.split(' ').slice(-1)[0]}</th><th className="py-1">Tour</th><th className="py-1">±</th>
          </tr>
        </thead>
        <tbody>
          {PEB_ROWS.map((r) => {
            if (r[0] === 'head') return <tr key={r[1]}><td colSpan={4} className="pt-3 pb-1 text-[10px] font-black text-gray-500 uppercase tracking-widest">{r[1]}</td></tr>
            const [k, i, label] = r
            const c = me[k], p = pct(c, i), t = pct(avg[k], i)
            const few = !c?.[0] || c[0] < 5
            const diff = p != null && t != null && !few ? p - t : null
            return (
              <tr key={`${k}${i}`} className="border-t border-gray-100">
                <td className="py-1.5 pl-1 text-gray-700">{label}</td>
                <td className="px-1 py-1.5 text-center">
                  <p className={`text-[13px] font-black tabular-nums ${few ? 'text-gray-300' : 'text-gray-900'}`}>{p == null ? '—' : `${p.toFixed(0)}%`}</p>
                  <p className="text-[9px] text-gray-500 tabular-nums">{c?.[0] ? `${c[i]} of ${c[0]}` : ''}</p>
                </td>
                <td className="px-1 py-1.5 text-center text-[12px] font-bold text-gray-500 tabular-nums">{t == null ? '—' : `${t.toFixed(0)}%`}</td>
                <td className={`px-1 py-1.5 text-center text-[11px] font-black tabular-nums ${diff == null ? 'text-gray-300' : diff >= 5 ? 'text-green-600' : diff <= -5 ? 'text-red-500' : 'text-gray-400'}`}>
                  {diff == null ? '' : `${diff > 0 ? '+' : ''}${diff.toFixed(0)}`}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="text-[10px] text-gray-400 mt-2">± is percentage points against the tour; fewer than 5 sets is greyed out.</p>
    </div>
  )
}

/* ---- Pressure: serving at 4-5 to stay in the set, broken = set lost (backend tennis_pressure) ---- */
const brokePct = (c) => (c?.n ? (100 * (c.n - c.held)) / c.n : null)
const PR_ROWS = [
  ['s45', 'Serving at 4-5 to stay in the set', 'broken = set lost 4-6', true],
  ['s45_set1', 'in set 1', '', false, true],
  ['s45_middle', 'in a middle set', '', false, true],
  ['s45_decider', 'in the deciding set', '', false, true],
  ['s56', 'Serving at 5-6 to reach the tie-break', 'broken = set lost 5-7'],
  ['s54', 'Serving for the set at 5-4', 'broken = back to 5-5'],
  ['s65', 'Serving for the set at 6-5', 'broken = tie-break'],
  ['hold', 'Any service game (the baseline)', ''],
]

function PressurePattern() {
  const [d, setD] = useState(null)
  useEffect(() => { tennisPressure().then((r) => setD(r.data)).catch(() => {}) }, [])
  const T = d?.tours || {}
  if (!T.ATP) return null
  const Cell = ({ c, strong }) => {
    const p = brokePct(c)
    return (
      <td className="px-1 py-1.5 text-center">
        <p className={`tabular-nums ${strong ? 'text-[14px] font-black text-gray-900' : 'text-[13px] font-bold text-gray-800'}`}>{p == null ? '—' : `${p.toFixed(1)}%`}</p>
        <p className="text-[9px] text-gray-500 tabular-nums">{c?.n ? `${fmtN(c.n - c.held)} of ${fmtN(c.n)}` : ''}</p>
      </td>
    )
  }
  const gap = (t) => brokePct(T[t].s45) - brokePct(T[t].hold)
  const after = T.ALL?.after_hold || []
  const afterN = after.reduce((s, [, n]) => s + n, 0)
  return (
    <div className="space-y-3">
      <div className="card space-y-1">
        <p className="text-sm font-black text-gray-900">Pressure: serving at 4-5 → set lost</p>
        <p className="text-[10px] text-gray-400">
          A player serving at 4-5 to stay in the set: broken there, the set is gone 4-6. How often that happens, next to
          the other service games that decide a set and an ordinary service game. {fmtN(T.ALL?.sets || 0)} charted sets
          from {d.from_year} on (Match Charting Project - it leans to the bigger matches).
        </p>
      </div>
      <div className="card">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider">
              <th className="py-1 text-left">Server broken</th><th className="py-1">ATP</th><th className="py-1">WTA</th>
            </tr>
          </thead>
          <tbody>
            {PR_ROWS.map(([k, label, sub, strong, indent]) => (
              <tr key={k} className={`border-t ${strong ? 'border-gray-300 bg-amber-50' : 'border-gray-100'}`}>
                <td className={`py-1.5 ${indent ? 'pl-3 text-gray-700' : 'font-bold text-gray-900'}`}>
                  {label}{sub && <span className="block text-[9px] font-normal text-gray-400">{sub}</span>}
                </td>
                <Cell c={T.ATP[k]} strong={strong} />
                <Cell c={T.WTA[k]} strong={strong} />
              </tr>
            ))}
            <tr className="border-t border-gray-100">
              <td className="py-1.5 text-gray-500">Pressure effect at 4-5 (points over the baseline)</td>
              {['ATP', 'WTA'].map((t) => (
                <td key={t} className={`py-1.5 text-center text-[12px] font-black tabular-nums ${gap(t) >= 1 ? 'text-red-500' : gap(t) <= -1 ? 'text-green-600' : 'text-gray-500'}`}>
                  {gap(t) > 0 ? '+' : ''}{gap(t).toFixed(1)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
        {afterN > 0 && (
          <p className="text-[10px] text-gray-400 mt-2">
            When the server held at 4-5, the set went on to: {after.map(([k, n]) => `${k} ${((100 * n) / afterN).toFixed(0)}%`).join(' · ')}
            {' '}(from the 4-5 server's side).
          </p>
        )}
      </div>
    </div>
  )
}

/** A player's record in the games that decide a set, next to the tour's (backend tennis_pressure.player). */
const PP_ROWS = [
  ['head', 'Serving under pressure - broken'],
  ['s45', 'At 4-5 to stay in the set (set lost 4-6)', 'broke'],
  ['s56', 'At 5-6 to reach the tie-break (set lost 5-7)', 'broke'],
  ['head', 'Serving for the set - broken'],
  ['s54', 'At 5-4', 'broke'],
  ['s65', 'At 6-5', 'broke'],
  ['head', 'Returning - they break and take the set'],
  ['r45', 'Opponent serving at 4-5', 'held'],
  ['r56', 'Opponent serving at 5-6', 'held'],
  ['head', 'Baseline'],
  ['hold', 'Any service game - broken', 'broke'],
]
function PlayerPressure({ d, name }) {
  const me = d.player, avg = d.avg || {}
  // [games, held] for serving keys (show broken), [games, broke] for returning keys (show broke)
  const pct = (c, serving) => (c?.[0] ? (100 * (serving ? c[0] - c[1] : c[1])) / c[0] : null)
  const short = name.split(' ').slice(-1)[0]
  const p45 = pct(me.s45, true), base = pct(me.hold, true)
  return (
    <div className="card">
      <p className="text-sm font-black text-gray-900">Pressure: serving at 4-5 → set lost</p>
      <p className="text-[10px] text-gray-400 mb-1">
        {name}'s set-deciding service games from {d.from_year} on - {fmtN(me.sets)} charted sets from {fmtN(me.matches)} matches
        (Match Charting Project), against every player on the tour.
      </p>
      {p45 != null && base != null && me.s45[0] >= 5 && (
        <p className={`text-[11px] font-bold mb-1 ${p45 - base >= 5 ? 'text-red-600' : p45 - base <= -5 ? 'text-green-700' : 'text-gray-600'}`}>
          {short} is broken at 4-5 in {p45.toFixed(0)}% against {base.toFixed(0)}% of all service games
          {p45 - base >= 5 ? ' - tightens up under pressure' : p45 - base <= -5 ? ' - steps up under pressure' : ' - about the same under pressure'}.
        </p>
      )}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider">
            <th className="py-1 text-left" /><th className="py-1">{short}</th><th className="py-1">Tour</th><th className="py-1">±</th>
          </tr>
        </thead>
        <tbody>
          {PP_ROWS.map((r) => {
            if (r[0] === 'head') return <tr key={r[1]}><td colSpan={4} className="pt-3 pb-1 text-[10px] font-black text-gray-500 uppercase tracking-widest">{r[1]}</td></tr>
            const [k, label] = r
            const serving = !k.startsWith('r')
            const c = me[k], p = pct(c, serving), t = pct(avg[k], serving)
            const few = !c?.[0] || c[0] < 5
            const diff = p != null && t != null && !few ? p - t : null
            // broken more than the tour is bad for them; breaking more is good
            const good = diff != null && (serving ? diff <= -5 : diff >= 5)
            const bad = diff != null && (serving ? diff >= 5 : diff <= -5)
            return (
              <tr key={k} className="border-t border-gray-100">
                <td className="py-1.5 pl-1 text-gray-700">{label}</td>
                <td className="px-1 py-1.5 text-center">
                  <p className={`text-[13px] font-black tabular-nums ${few ? 'text-gray-300' : 'text-gray-900'}`}>{p == null ? '—' : `${p.toFixed(0)}%`}</p>
                  <p className="text-[9px] text-gray-500 tabular-nums">{c?.[0] ? `${serving ? c[0] - c[1] : c[1]} of ${c[0]}` : ''}</p>
                </td>
                <td className="px-1 py-1.5 text-center text-[12px] font-bold text-gray-500 tabular-nums">{t == null ? '—' : `${t.toFixed(0)}%`}</td>
                <td className={`px-1 py-1.5 text-center text-[11px] font-black tabular-nums ${good ? 'text-green-600' : bad ? 'text-red-500' : 'text-gray-300'}`}>
                  {diff == null ? '' : `${diff > 0 ? '+' : ''}${diff.toFixed(0)}`}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="text-[10px] text-gray-400 mt-2">± is percentage points against the tour (green good for {short}, red bad); fewer than 5 games is greyed out.</p>
    </div>
  )
}

/** A live set past game 4 that can still end under 8.5: how often sets at this score did. */
function EarlyBreakFlag({ m, eb }) {
  const T = eb?.tours?.[m.tour]
  const [a, b] = m.players.map((p) => p.games[p.games.length - 1] ?? 0)
  const k = ebScore(a, b)
  const c = k && T?.by_score?.[k]
  const p = ebPct(c)
  if (p == null || c.n < 100) return null
  const lead = m.players[a > b ? 0 : 1].name.split(' ').slice(-1)[0]
  return (
    <p className={`mt-1 text-[10px] font-bold ${p >= 70 ? 'text-green-700' : p >= 45 ? 'text-amber-700' : 'text-gray-400'}`}>
      {lead} {k} → set under 8.5 in {p.toFixed(0)}% of {fmtN(c.n)} sets · break-even odds {(100 / p).toFixed(2)}
    </p>
  )
}

/* ---- Pattern explorer: any condition on set 1 -> outcome for set 2 (backend tennis_stats pairs) ---- */
const SET_SCORES = [[6, '6-0'], [7, '6-1'], [8, '6-2'], [9, '6-3'], [10, '6-4'], [12, '7-5'], [13, '7-6'], [14, 'Long (8-6+)']]
const COND_LINES = [[8.5, 'Over 8.5 (6-3 or closer)'], [9.5, 'Over 9.5 (6-4 or closer)'], [10.5, 'Over 10.5 (7-5 / 7-6)'],
  [12.5, 'Over 12.5 (7-6 only)'], [-8.5, 'Under 8.5 (6-2 or wider)'], [-7.5, 'Under 7.5 (6-1 / 6-0)']]
const OUT_LINES = [[-6.5, 'Under 6.5'], [-7.5, 'Under 7.5'], [-8.5, 'Under 8.5'], [-9.5, 'Under 9.5'], [8.5, 'Over 8.5'], [10.5, 'Over 10.5']]
const lineFits = (ln, g) => (ln < 0 ? g < -ln : g > ln)
const lineName = (ln) => `${ln < 0 ? 'under' : 'over'} ${Math.abs(ln)}`

function PatternExplorer({ rows }) {
  const first = 1                              // set 1 -> set 2
  const since = 2016                           // matches from 2016 on
  const [cond, setCond] = useState(10.5)
  const [out, setOut] = useState(-8.5)
  const [surface, setSurface] = useState('all')
  const [bo, setBo] = useState('all')

  // row: [tour, surface, best_of, first set, games in it, games in the next, same winner, matches]
  const base = rows.filter((r) => r[3] === first && (surface === 'all' || r[1] === surface) && (bo === 'all' || String(r[2]) === bo))
  const stat = (tour, keep) => {
    let n = 0, hit = 0, hitSame = 0
    for (const r of base) {
      if (r[0] !== tour || !keep(r[4])) continue
      n += r[7]
      if (lineFits(out, r[5])) { hit += r[7]; if (r[6]) hitSame += r[7] }
    }
    return { n, hit, hitSame, pct: n ? (100 * hit) / n : null }
  }
  const A = first === 1 ? 'Set 1' : 'Set 2', B = first === 1 ? 'Set 2' : 'Set 3'
  const pc = (t) => (t.pct == null ? '—' : `${t.pct.toFixed(1)}%`)
  const Diff = ({ a, b }) => {
    if (a.pct == null || b.pct == null) return <span className="text-gray-300">—</span>
    const d = a.pct - b.pct
    return <span className={`font-black ${d >= 0 ? 'text-green-700' : 'text-red-600'}`}>{d >= 0 ? '+' : ''}{d.toFixed(1)} pts</span>
  }

  return (
    <div className="space-y-3">
      <div className="card space-y-2">
        <div className="flex gap-2 flex-wrap">
          {[[10.5, -8.5, 'Close set 1 → set 2 under 8.5'], [-8.5, 8.5, 'Set 1 under 8.5 → set 2 over 8.5']].map(([c, o, l]) => (
            <button key={l} onClick={() => { setCond(c); setOut(o) }}
              className={`px-2.5 py-1.5 rounded-md text-[11px] font-bold border ${cond === c && out === o
                ? 'bg-brand-400 text-white border-brand-400' : 'bg-white text-gray-700 border-amber-300'}`}>{l}</button>
          ))}
        </div>
        <p className="text-[11px] font-bold text-gray-500">Matches from 2016 on</p>
        <div className="grid grid-cols-[auto_1fr] items-center gap-2 text-xs">
          <span className="font-bold text-gray-500">If {A} is</span>
          <select value={cond} onChange={(e) => setCond(+e.target.value)} className="px-2 py-1.5 rounded-md border border-amber-300 bg-white font-bold">
            {COND_LINES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <span className="font-bold text-gray-500">how often is {B}</span>
          <select value={out} onChange={(e) => setOut(+e.target.value)} className="px-2 py-1.5 rounded-md border border-amber-300 bg-white font-bold">
            {OUT_LINES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Seg value={surface} onChange={setSurface} options={[['all', 'All'], ['Hard', 'Hard'], ['Clay', 'Clay'], ['Grass', 'Grass']]} />
          <Seg value={bo} onChange={setBo} options={[['all', 'All'], ['3', 'Bo3'], ['5', 'Bo5']]} />
        </div>
      </div>

      <div className="card">
        <p className="text-sm font-black text-gray-900">{A} {lineName(cond)} → {B} {lineName(out)}</p>
        <p className="text-[10px] font-bold text-brand-600">{since ? `Matches from ${since} on` : 'All matches since 2000'}
          {surface !== 'all' ? ` · ${surface}` : ''}{bo !== 'all' ? ` · best of ${bo}` : ''}</p>
        <p className="text-[10px] text-gray-400 mb-2">
          Compared with every match ("all matches") and with the opposite {A}. Positive points = the pattern
          is more likely than usual. {B} {lineName(out)} = {out < 0 ? `${Math.ceil(-out) - 1} games or fewer` : `${Math.ceil(out)} games or more`} in the set.
        </p>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider">
              <th className="py-1 text-left"></th><th className="py-1">ATP</th><th className="py-1">WTA</th>
            </tr>
          </thead>
          <tbody>
            {[
              [`${A} ${lineName(cond)}`, (g) => lineFits(cond, g), true],
              ['All matches', () => true],
              [`${A} not ${lineName(cond)}`, (g) => !lineFits(cond, g)],
            ].map(([l, keep, main]) => {
              const a = stat('ATP', keep), w = stat('WTA', keep)
              return (
                <tr key={l} className={`border-t border-gray-100 ${main ? 'bg-amber-50' : ''}`}>
                  <td className="py-1.5 font-bold text-gray-800">{l}</td>
                  {[a, w].map((t, i) => (
                    <td key={i} className="py-1.5 text-center">
                      <p className="text-[14px] font-black text-gray-900 tabular-nums">{pc(t)}</p>
                      <p className="text-[9px] text-gray-500 tabular-nums">{fmtN(t.hit)} of {fmtN(t.n)}</p>
                    </td>
                  ))}
                </tr>
              )
            })}
            <tr className="border-t-2 border-gray-200">
              <td className="py-1.5 font-bold text-gray-800">vs all matches</td>
              {['ATP', 'WTA'].map((t) => (
                <td key={t} className="py-1.5 text-center text-[12px]"><Diff a={stat(t, (g) => lineFits(cond, g))} b={stat(t, () => true)} /></td>
              ))}
            </tr>
          </tbody>
        </table>
        {['ATP', 'WTA'].map((t) => {
          const s = stat(t, (g) => lineFits(cond, g))
          return s.hit ? (
            <p key={t} className="text-[10px] text-gray-500 mt-1">
              <b>{t}</b>: of those {fmtN(s.hit)} {B}s, the {A} winner took {((100 * s.hitSame) / s.hit).toFixed(0)}%, the {A} loser {((100 * (s.hit - s.hitSame)) / s.hit).toFixed(0)}%.
            </p>
          ) : null
        })}
      </div>

      <div className="card">
        <p className="text-sm font-black text-gray-900">{B} {lineName(out)}, by {A} score</p>
        <p className="text-[10px] text-gray-400 mb-2">Every {A} scoreline, either player winning it.</p>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider">
              <th className="py-1 text-left">{A}</th><th className="py-1">ATP</th><th className="py-1">WTA</th>
            </tr>
          </thead>
          <tbody>
            {SET_SCORES.map(([g, l]) => {
              const keep = (x) => (g === 14 ? x >= 14 : x === g)
              const a = stat('ATP', keep), w = stat('WTA', keep)
              if (!a.n && !w.n) return null
              const all = { ATP: stat('ATP', () => true), WTA: stat('WTA', () => true) }
              return (
                <tr key={g} className="border-t border-gray-100">
                  <td className="py-1.5 font-bold text-gray-800">{l}</td>
                  {[['ATP', a], ['WTA', w]].map(([t, s]) => (
                    <td key={t} className={`py-1.5 text-center ${s.pct != null && all[t].pct != null ? (s.pct - all[t].pct >= 2 ? 'bg-green-50' : s.pct - all[t].pct <= -2 ? 'bg-red-50' : '') : ''}`}>
                      <p className="text-[13px] font-black text-gray-900 tabular-nums">{pc(s)}</p>
                      <p className="text-[9px] text-gray-500 tabular-nums">{fmtN(s.hit)} of {fmtN(s.n)}</p>
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="text-[10px] text-gray-400 mt-1">Green / red: 2+ points above / below all matches.</p>
      </div>
    </div>
  )
}

/** Both patterns, from one load of the 2016-on set pairs. */
function Patterns() {
  const [rows, setRows] = useState(null)
  useEffect(() => { tennisPatterns(2016).then((r) => setRows(r.data.rows)).catch(() => setRows([])) }, [])
  if (!rows) return <p className="text-xs text-gray-400 text-center py-6">Working out every match since 2016…</p>
  return (
    <div className="space-y-6">
      <EarlyBreakPattern />
      <PressurePattern />
      <div>
        <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-2">Pattern explorer</p>
        <PatternExplorer rows={rows} />
      </div>
    </div>
  )
}

/** The match page for a match in the results: /betting/match?id=... */
export const matchLink = (m) => `/betting/match?id=${encodeURIComponent(m.id)}`
/** ...and for a live or upcoming one: ESPN's id, both players (ids where known), the surface. */
export const liveLink = (m) => {
  const q = new URLSearchParams({ tour: m.tour, espn: m.espn, surface: m.surface || '' })
  m.players.forEach((p, i) => { if (p.id) q.set(i ? 'b' : 'a', p.id); q.set(i ? 'bn' : 'an', p.name) })
  return `/betting/match?${q}`
}
export const startTime = (iso) => {
  const d = iso ? new Date(iso) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  const today = new Date().toDateString() === d.toDateString()
  const tmw = new Date(Date.now() + 864e5).toDateString() === d.toDateString()
  const day = today ? 'Today' : tmw ? 'Tomorrow' : d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
  return `${day}, ${d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`
}

/** The game score of live WTA matches, asked for every 3 seconds while one is on screen
 * (the WTA's feed only answers when asked - this is the nearest to "as it happens").
 * Returns {espn id: {detail, players: [{games, point, serving}]}}. */
export function useLivePoints(on) {
  const [pts, setPts] = useState({})
  useEffect(() => {
    if (!on) return undefined
    let alive = true, busy = false
    const load = () => {
      if (busy || document.hidden) return
      busy = true
      tennisLivePoints().then((r) => { if (alive) setPts(r.data.matches || {}) }).catch(() => {}).finally(() => { busy = false })
    }
    load()
    const t = setInterval(load, 3000)
    const off = onBackInView(() => load())
    return () => { alive = false; clearInterval(t); off() }
  }, [on])
  return pts
}

/** A live match with the latest game score laid over it. */
export const withPoints = (m, pts) => {
  const x = m && pts?.[m.espn]
  return x ? { ...m, detail: x.detail, players: m.players.map((p, i) => ({ ...p, ...x.players[i] })) } : m
}

/** A score that changed lights up for a moment (the point just played, a game just won). */
function Flash({ v, className = '', children }) {
  const prev = useRef(v)
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (prev.current === v) return undefined
    prev.current = v
    setOn(true)
    const t = setTimeout(() => setOn(false), 1800)
    return () => clearTimeout(t)
  }, [v])
  return <span className={`${className} rounded-sm transition-colors duration-700 ${on ? 'bg-amber-200' : ''}`}>{children}</span>
}

/** One live / upcoming match: the players with their games so far, the set or the start time. */
export function LiveRow({ m, onOpen, plain, eb, picks, odds }) {
  const live = m.state === 'live'
  // the fans' vote: my pick, or a nudge on a match still open to picking (both players known)
  const pick = picks?.[m.espn]
  const canPick = picks && !live && !pick && new Date(m.start) > new Date() && !m.players.some((p) => p.name === 'TBD')
  return (
    <button onClick={() => onOpen(m)} className="w-full text-left py-2 border-t border-gray-100 first:border-t-0 hover:bg-amber-50/50 active:bg-amber-50 -mx-2 px-2 rounded block">
      <div className="flex items-center gap-2 mb-0.5 text-[10px]">
        {live
          ? <span className="font-black text-red-600 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-600 animate-pulse" />LIVE · {m.detail}
            {m.players.some((p) => p.serving) && <span className="font-semibold text-gray-400">· <span className="inline-block w-1.5 h-1.5 rounded-full bg-lime-400 ring-1 ring-lime-600 align-middle" /> serving</span>}</span>
          : <span className="font-bold text-gray-500">{startTime(m.start)}</span>}
        {!plain && <span className="text-gray-400">{ROUND_NAME[m.round] || m.round}</span>}
        {pick && <span className="ml-auto font-bold text-green-700 bg-green-50 rounded px-1.5 truncate max-w-[110px]">✓ {pick.split(' ').slice(-1)[0]}</span>}
        {canPick && <span className="ml-auto font-bold text-gray-400 border border-dashed border-gray-300 rounded px-1.5">Pick</span>}
        {!plain && <span className={`${pick || canPick ? '' : 'ml-auto '}font-bold text-brand-600`}>Match ›</span>}
      </div>
      {m.players.map((p, i) => {
        const o = m.players[1 - i]
        return (
          <div key={i} className="flex items-center gap-1.5 text-gray-900">
            <Flag ioc={p.ioc} />
            <span className="flex-1 min-w-0 truncate text-[13px] font-bold">
              {p.name}{p.seed && <span className="ml-1 text-[10px] font-semibold text-gray-400">({p.seed})</span>}
              {p.rank && <span className="ml-1 text-[9px] font-normal text-gray-300">#{p.rank}</span>}
              {live && p.serving && (
                <span title="Serving" aria-label="serving"
                  className="ml-1.5 inline-block w-2 h-2 rounded-full bg-lime-400 ring-1 ring-lime-600 align-middle" />
              )}
            </span>
            {odds && <OddsTag prices={odds} name={p.name} />}
            {p.games.map((g, k) => {
              const done = k < p.games.length - 1 || !live          // the set being played is red
              const took = done && g > (o.games[k] ?? 0)
              return (
                <Flash key={k} v={g} className={`w-6 text-center text-[13px] tabular-nums ${!done ? 'text-red-600 font-black' : took ? 'font-black' : 'font-medium text-gray-400'}`}>
                  {/* both players' tie-break points, as ESPN gives them: 7⁷ over 6⁴ */}
                  {g}{done && (p.tiebreaks?.[k] != null || o.tiebreaks?.[k] != null) && (
                    <sup className="text-[8px] font-semibold ml-px">{p.tiebreaks?.[k] ?? (o.tiebreaks?.[k] != null ? (took ? Math.max(7, o.tiebreaks[k] + 2) : '') : '')}</sup>
                  )}
                </Flash>
              )
            })}
            {/* the game being played (WTA only - the ATP's points aren't open) */}
            {live && m.players.some((x) => x.point != null) && (
              <span className="ml-1 pl-1 border-l border-gray-200">
                <Flash v={p.point} className="inline-block w-7 text-center text-[13px] font-black tabular-nums text-brand-600">{p.point ?? ''}</Flash>
              </span>
            )}
          </div>
        )
      })}
      {live && eb && <EarlyBreakFlag m={m} eb={eb} />}
    </button>
  )
}

/** My picks as mock bets: one stake (mine to set) on every pick, settled at
 *  the kept pre-match price of the player I picked (backend
 *  /tennis/fans/mine/history). A pick with no kept price isn't counted. */
const STAKE_KEY = 'tennis.mockStake'
function MyPicks({ active, sport = 'tennis' }) {
  const [d, setD] = useState(null)
  const [stake, setStake] = useState(() => { try { return Number(localStorage.getItem(STAKE_KEY)) || 100 } catch { return 100 } })
  useEffect(() => {
    if (active) (sport === 'tennis' ? tennisPickHistory() : sportPickHistory(sport)).then((r) => setD(r.data.picks)).catch(() => setD([]))
  }, [active, sport])
  const save = (v) => { setStake(v); try { localStorage.setItem(STAKE_KEY, String(v)) } catch { /* private mode */ } }
  if (!d) return <p className="text-xs text-gray-400 text-center py-6">Loading your picks…</p>
  const rupees = (x) => `${x < 0 ? '−' : x > 0 ? '+' : ''}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`
  const pl = (p) => (p.status === 'won' && p.odds ? stake * (p.odds - 1) : p.status === 'lost' && p.odds ? -stake : null)
  const settled = d.filter((p) => pl(p) != null)
  const won = settled.filter((p) => p.status === 'won')
  const total = settled.reduce((a, p) => a + pl(p), 0)
  const staked = stake * settled.length
  const favs = settled.filter((p) => p.other_odds && p.odds < p.other_odds)
  const Stat = ({ label, v, tone }) => (
    <div className="flex-1 min-w-[80px] rounded-md bg-white border border-amber-100 px-3 py-2">
      <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{label}</p>
      <p className={`text-base font-black tabular-nums ${tone || 'text-gray-900'}`}>{v}</p>
    </div>
  )
  return (
    <div className="space-y-3">
      <div className="card">
        <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Mock betting · my picks</p>
        <label className="flex items-center gap-2 mt-2 text-sm font-semibold text-gray-700">
          Stake on every pick ₹
          <input type="number" min="1" inputMode="numeric" value={stake} onChange={(e) => save(Math.max(0, Number(e.target.value) || 0))}
            className="w-24 rounded-md border border-amber-300 px-2 py-1 text-sm font-black tabular-nums" />
        </label>
        <div className="flex gap-2 mt-3 flex-wrap">
          <Stat label="Profit / loss" v={rupees(total)} tone={total > 0 ? 'text-green-700' : total < 0 ? 'text-red-600' : ''} />
          <Stat label="Return" v={staked ? `${total >= 0 ? '+' : ''}${Math.round((100 * total) / staked)}%` : '—'} tone={total > 0 ? 'text-green-700' : total < 0 ? 'text-red-600' : ''} />
          <Stat label="Won" v={`${won.length} of ${settled.length}`} />
          <Stat label="Staked" v={`₹${staked.toLocaleString('en-IN')}`} />
        </div>
        <p className="text-[10px] text-gray-400 mt-2">
          {sport === 'tennis' ? "Settled at the bookmakers' pre-match price for the player picked" : 'Settled at the odds you typed in beside each pick on the Live tab (no bookmaker feed covers this sport)'} - decimal: a win pays stake × (odds − 1), a loss costs the stake.
          {favs.length > 0 && ` Backed the favourite ${favs.length} time${favs.length === 1 ? '' : 's'}, the outsider ${settled.length - favs.length}.`}
          {d.length - settled.length > 0 && ` ${d.filter((p) => p.status === 'pending').length} still to play`}
          {d.filter((p) => p.status !== 'pending' && !p.odds).length > 0 && ` · ${d.filter((p) => p.status !== 'pending' && !p.odds).length} ${sport === 'tennis' ? 'without a kept price' : 'with no odds typed in'} (not counted)`}
        </p>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider text-left">
              <th className="py-1">Date</th><th className="py-1">My pick</th><th className="py-1 text-right">Odds</th>
              <th className="py-1 text-right">Other</th><th className="py-1 text-center">Result</th><th className="py-1 text-right">P / L</th>
            </tr>
          </thead>
          <tbody>
            {d.length === 0 && <tr><td colSpan={6} className="py-4 text-center text-gray-400">No picks yet - {sport === 'tennis' ? "pick a winner on any upcoming match's page." : 'pick a winner under any upcoming match on the Live tab.'}</td></tr>}
            {d.map((p) => {
              const x = pl(p)
              return (
                <tr key={p.espn || p.key} className="border-t border-gray-100 align-top">
                  <td className="py-1.5 pr-1 text-gray-500 whitespace-nowrap">{fmtShort(p.start.slice(0, 10))}</td>
                  <td className="py-1.5 pr-1">
                    <span className="font-bold text-gray-900">{p.pick}</span>
                    <span className="block text-[10px] text-gray-400 truncate max-w-[150px]">v {p.other}{p.tournament ? ` · ${p.tournament}` : ''}</span>
                  </td>
                  <td className={`py-1.5 text-right tabular-nums font-black ${p.other_odds && p.odds < p.other_odds ? 'text-gray-900' : 'text-gray-600'}`}>{p.odds ? p.odds.toFixed(2) : '—'}</td>
                  <td className="py-1.5 text-right tabular-nums text-gray-400">{p.other_odds ? p.other_odds.toFixed(2) : '—'}</td>
                  <td className="py-1.5 text-center">
                    {p.status === 'won' ? <span className="font-black text-green-700">Won</span>
                      : p.status === 'lost' ? <span className="font-black text-red-600">Lost</span>
                        : p.status === 'void' ? <span className="text-gray-400">Void</span> : <span className="text-gray-400">To play</span>}
                    {p.score && <span className="block text-[9px] text-gray-400">{p.score}</span>}
                  </td>
                  <td className={`py-1.5 text-right tabular-nums font-black ${x > 0 ? 'text-green-700' : x < 0 ? 'text-red-600' : 'text-gray-300'}`}>{x == null ? '—' : rupees(x)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Live now, then what starts in the next day and a half, by tournament: the list refreshed every 10 seconds, a WTA game's points every 3. */
function Live({ tour, onOpen, active = true }) {
  const [d, setD] = useState(() => peek('/tennis/live', { tour }) || null)   // the last list at once, then fresh
  const [picks, setPicks] = useState(null)        // my fan picks, by ESPN id
  const today = isoDay(Date.now())
  const kept = useKeptOdds(addDays(today, -1), addDays(today, 2), picks)
  const [err, setErr] = useState(false)
  useEffect(() => {
    if (!active) return undefined          // kept but hidden behind another tab: no polling
    let alive = true
    const load = (fresh) => tennisLive(tour, fresh).then((r) => { if (alive) { setD(r.data); setErr(false) } }).catch(() => { if (alive) setErr(true) })
    const loadPicks = () => tennisMyPicks().then((r) => { if (alive) setPicks(r.data.picks) }).catch(() => {})
    load()
    loadPicks()
    const t = setInterval(() => { if (!document.hidden) load() }, 10000)
    const off = onBackInView((fresh) => { load(fresh); loadPicks() })
    return () => { alive = false; clearInterval(t); off() }
  }, [tour, active])
  const pts = useLivePoints(active && !!d?.matches?.some((m) => m.tour === 'WTA' && m.state === 'live'))
  const eb = useEarlyBreak(active)
  if (!d && !err) return <p className="text-xs text-gray-400 text-center py-6">Loading live matches…</p>
  if (!d) return <p className="text-sm text-red-600 text-center py-6">Couldn't reach the live scores - try again in a minute.</p>
  const groups = (state) => {
    const by = {}
    d.matches.filter((m) => m.state === state).forEach((m) => {
      const k = `${m.tour}|${m.tournament}`
      if (!by[k]) by[k] = { tour: m.tour, name: m.tournament, surface: m.surface, matches: [] }
      by[k].matches.push(m)
    })
    return Object.values(by)
  }
  const section = (state, title) => {
    const gs = groups(state)
    return (
      <div className="space-y-2">
        <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest px-1">
          {title} · {gs.reduce((a, g) => a + g.matches.length, 0)}
          {state === 'upcoming' && picks && (() => {
            const open = gs.flatMap((g) => g.matches).filter((m) => new Date(m.start) > new Date() && !m.players.some((p) => p.name === 'TBD'))
            const done = open.filter((m) => picks[m.espn]).length
            return open.length > 0 && (
              <span className={`ml-2 normal-case tracking-normal font-bold ${done === open.length ? 'text-green-700' : 'text-gray-400'}`}>
                {done === open.length ? `✓ all ${open.length} picked` : `picked ${done} of ${open.length}`}
              </span>
            )
          })()}
        </p>
        {gs.length === 0 && <p className="text-xs text-gray-400 px-1">{state === 'live' ? 'Nothing on court right now.' : 'Nothing scheduled in the next day and a half.'}</p>}
        {gs.map((g) => (
          <div key={`${g.tour}|${g.name}`} className="card p-0 overflow-hidden">
            <div className="px-4 py-2 bg-field-950 text-white flex items-center gap-2">
              <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-white/15 tracking-wider">{g.tour}</span>
              <p className="text-sm font-bold flex-1 min-w-0 truncate">{g.name}</p>
              {g.surface && <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${SURFACE[g.surface] || 'bg-gray-100 text-gray-700'}`}>{g.surface}</span>}
            </div>
            <div className="px-4 pb-1">{g.matches.map((m) => <LiveRow key={m.espn} m={withPoints(m, pts)} onOpen={onOpen} eb={eb} picks={picks}
              odds={findOdds(kept, m.tour, m.players[0].name, m.players[1].name, m.start)} />)}</div>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="space-y-4">
      {section('live', 'Live now')}
      {section('upcoming', 'Upcoming')}
      <p className="text-[10px] text-gray-400 text-center">
        From ESPN · updates every 30 seconds · {new Date(d.updated).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}
      </p>
    </div>
  )
}

/** One tab, kept mounted: redrawn only when it's shown/hidden or what it
 *  shows changes (`deps`) - not every time the page around it re-renders,
 *  which for Sets and Patterns means re-counting thousands of matches. */
const Pane = memo(function Pane({ hidden, children }) {
  return <div hidden={hidden}>{children}</div>
}, (a, b) => a.hidden === b.hidden && a.deps === b.deps)

export default function BettingAnalytics() {
  const nav = useNavigate()
  // the tab and the open player live in the address, so Back from a match page returns to them
  const [params, setParams] = useSearchParams()
  // 🎾 tennis, 🏸 badminton (pages/Badminton.jsx) or 🏑 hockey (pages/Hockey.jsx), each with its own tabs
  const sport = ['badminton', 'hockey'].includes(params.get('sport')) ? params.get('sport') : 'tennis'
  const tab = params.get('tab') || 'results'
  const btab = params.get('btab') || 'live'
  const htab = params.get('htab') || 'live'
  const setHtab = (t) => startTransition(() => go({ htab: t, he: null }))
  const [hOpened, setHOpened] = useState(() => new Set([htab]))
  useEffect(() => { setHOpened((s) => (s.has(htab) ? s : new Set([...s, htab]))) }, [htab])
  const bp = params.get('bp') ? +params.get('bp') : null
  const pl = params.get('player')
  const sel = pl && pl.includes(':') ? { tour: pl.split(':')[0], id: +pl.split(':')[1] } : null
  const go = (next) => setParams((p) => {
    const q = new URLSearchParams(p)
    Object.entries(next).forEach(([k, v]) => (v ? q.set(k, v) : q.delete(k)))
    return q
  }, { replace: true })
  // The button lights up at once; a heavy tab's first build happens after
  const [, startTransition] = useTransition()
  const setTab = (t) => startTransition(() => go({ tab: t }))
  const setSel = (x) => go({ player: x ? `${x.tour}:${x.id}` : null })
  const setSport = (k) => startTransition(() => go({ sport: k === 'tennis' ? null : k, he: null }))
  const setBtab = (t) => startTransition(() => go({ btab: t }))
  const setBp = (id) => go({ btab: id ? 'players' : btab, bp: id || null })
  const [bOpened, setBOpened] = useState(() => new Set([btab]))
  useEffect(() => { setBOpened((s) => (s.has(btab) ? s : new Set([...s, btab]))) }, [btab])
  const [bsum, setBsum] = useState(null)
  useEffect(() => {
    if (sport !== 'badminton') return undefined
    const load = () => badmintonSummary().then((r) => setBsum(r.data)).catch(() => {})
    load()
    const t = setInterval(load, 60000)        // the archive read-in's progress
    return () => clearInterval(t)
  }, [sport])
  const [tour, setTour] = useState('all')
  const [opened, setOpened] = useState(() => new Set([tab]))
  useEffect(() => { setOpened((s) => (s.has(tab) ? s : new Set([...s, tab]))) }, [tab])
  // Every tab's data asked for while this one is read, so the first switch
  // to any of them finds it waiting (api.remembered keeps the answers)
  useEffect(() => {
    const t = setTimeout(() => {
      // all three sports, so switching to badminton or hockey is instant too
      [() => tennisLive('all'), () => tennisDay('', 'all'), () => tennisSets(), () => tennisPatterns(2016),
        () => badmintonLive(), () => badmintonSummary(), () => hockeyLive()]
        .forEach((f) => f().catch(() => {}))
    }, 800)
    return () => clearTimeout(t)
  }, [])
  const [sum, setSum] = useState(null)
  const [fresh, setFresh] = useState(0)      // bumped when a background refresh has had time to land
  useEffect(() => {
    tennisSummary().then((r) => {
      setSum(r.data)
      // Results over an hour old: the server is fetching new ones - look again shortly.
      if (r.data.refreshing && fresh < 1) setTimeout(() => setFresh((f) => f + 1), 30000)
    }).catch(() => {})
  }, [fresh])
  const openPlayer = (t, id) => go({ tab: 'players', player: `${t}:${id}` })
  const openMatch = (m) => nav(matchLink(m))
  const openLive = (m) => nav(liveLink(m))

  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-3 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-black tracking-tight flex-1">{{ badminton: 'Badminton', hockey: 'Hockey' }[sport] || 'Betting analytics'}</h1>
          <div className="flex rounded-md border border-amber-300 overflow-hidden">
            {[['tennis', '🎾'], ['badminton', '🏸'], ['hockey', '🏑']].map(([k, l]) => (
              <button key={k} onClick={() => setSport(k)} aria-label={k} title={k[0].toUpperCase() + k.slice(1)}
                className={`px-2.5 py-1 text-sm ${sport === k ? 'bg-field-950' : 'bg-white'}`}>{l}</button>
            ))}
          </div>
          <button onClick={() => nav('/my-bets')} className="px-2.5 py-1 rounded-md border border-amber-300 bg-white text-[11px] font-bold text-brand-600">
            My bets ›
          </button>
        </div>
        {sport === 'hockey' ? (
          <>
            <p className="mt-1 text-[11px] leading-snug text-gray-400">
              FIH tournaments, Pro League, World Cup & Olympics
              <br />
              live scores, tables and world rankings from fih.hockey
            </p>
            <div className="grid grid-cols-5 mt-2.5 rounded-md border border-amber-300 overflow-hidden">
              {H_TABS.map(([k, l]) => (
                <button key={k} onClick={() => setHtab(k)}
                  className={`py-1.5 text-[11px] font-bold ${htab === k ? 'bg-brand-400 text-white' : 'bg-white text-gray-600'}`}>
                  {k === 'live' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 mr-1 align-middle" />}{l}
                </button>
              ))}
            </div>
          </>
        ) : sport === 'badminton' ? (
          <>
            <p className="mt-1 text-[11px] leading-snug text-gray-400">
              {bsum?.matches ? `${Number(bsum.matches).toLocaleString('en-IN')} BWF matches · ${fmtShort(bsum.first)} – ${fmtShort(bsum.last)}` : 'BWF World Tour, Worlds & Olympics from 2018'}
              <br />
              {bsum?.sync?.running ? (bsum.sync.todo ? `reading BWF's archive - ${bsum.sync.done} of ${bsum.sync.todo} tournaments` : "reading BWF's calendars, 2018 to now…") : 'live scores from bwfbadminton.com'}
            </p>
            <div className="grid grid-cols-5 mt-2.5 rounded-md border border-amber-300 overflow-hidden">
              {B_TABS.map(([k, l]) => (
                <button key={k} onClick={() => setBtab(k)}
                  className={`py-1.5 text-[11px] font-bold ${btab === k ? 'bg-brand-400 text-white' : 'bg-white text-gray-600'}`}>
                  {k === 'live' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 mr-1 align-middle" />}{l}
                </button>
              ))}
            </div>
          </>
        ) : (<>
        <div className="flex items-center gap-2 mt-1">
          <p className="flex-1 min-w-0 text-[11px] leading-snug text-gray-400">
            {sum ? `${Number(sum.n).toLocaleString('en-IN')} matches · 2000 – ${fmtShort(sum.last)}` : 'ATP & WTA tour results'}
            <br />
            {sum?.refreshing && !fresh ? 'fetching the latest results…'
              : sum?.last_update ? `updated ${new Date(`${sum.last_update.slice(0, 19)}Z`).toLocaleString('en-IN',
                { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
          </p>
          <div className="flex flex-shrink-0 rounded-md border border-amber-300 overflow-hidden">
            {TOURS.map(([k, l]) => (
              <button key={k} onClick={() => setTour(k)}
                className={`px-2 py-1 text-[11px] font-bold ${tour === k ? 'bg-field-950 text-white' : 'bg-white text-gray-600'}`}>{l}</button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-6 mt-2.5 rounded-md border border-amber-300 overflow-hidden">
          {[['live', 'Live'], ['results', 'Results'], ['picks', 'My picks'], ['players', 'Players'], ['sets', 'Sets'], ['patterns', 'Patterns']].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`py-1.5 text-[11px] font-bold ${tab === k ? 'bg-brand-400 text-white' : 'bg-white text-gray-600'}`}>
              {k === 'live' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 mr-1 align-middle" />}{l}
            </button>
          ))}
        </div>
        </>)}
      </div>
      <div className="px-5 mt-4 max-w-2xl">
        {sport === 'hockey' && [...hOpened].map((k) => (
          <Pane key={`h-${k}`} hidden={k !== htab} deps={`${k === htab}|${params.get('he') || ''}`}>
            <Safe what="this tab">
              {k === 'picks' ? <MyPicks sport="hockey" active={k === htab} /> : <Hockey tab={k} active={k === htab} />}
            </Safe>
          </Pane>
        ))}
        {sport === 'badminton' && [...bOpened].map((k) => (
          <Pane key={`b-${k}`} hidden={k !== btab} deps={`${k === btab}|${k === 'players' ? bp : ''}|${k === 'results' ? bsum?.matches : ''}`}>
            <Safe what="this tab">
              {k === 'picks' ? <MyPicks sport="badminton" active={k === btab} />
                : <Badminton tab={k} active={k === btab} player={bp} setPlayer={setBp} sum={bsum} />}
            </Safe>
          </Pane>
        ))}
        {/* A tab once opened stays mounted, just hidden - going back to it
            is instant, with its scroll, filters and data as they were */}
        {sport === 'tennis' && [...opened].map((k) => (
          <Pane key={k} hidden={k !== tab}
            deps={`${tour}|${k === 'live' || k === 'picks' ? tab === k : ''}|${k === 'results' ? fresh : ''}|${k === 'players' ? pl : ''}`}>
            <Safe what="this tab">
              {k === 'live' && <Live tour={tour} onOpen={openLive} active={tab === 'live'} />}
              {k === 'results' && <Results tour={tour} fresh={fresh} onPlayer={openPlayer} onOpen={openMatch} />}
              {k === 'players' && <Players tour={tour} sel={sel} setSel={setSel} onOpen={openMatch} />}
              {k === 'sets' && <SetStats tour={tour} />}
              {k === 'patterns' && <Patterns />}
              {k === 'picks' && <MyPicks active={tab === 'picks'} />}
            </Safe>
          </Pane>
        ))}
      </div>
    </div>
  )
}
