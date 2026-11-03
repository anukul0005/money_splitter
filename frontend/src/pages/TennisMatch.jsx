import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { tennisEarlyBreak, tennisLive, tennisLiveFeed, tennisMatchup } from '../api'
import { LiveRow, MatchRow, ROUND_NAME, SURFACE, Safe, ScoreText, fmtShort, matchLink, startTime, useLivePoints, withPoints } from './BettingAnalytics'

/**
 * /betting/match - one match: the result (or the live score, refreshed),
 * then the head-to-head, the two players side by side - records, and how
 * their sets go (over 8.5 games, tie-breaks) on this surface - and each
 * one's last ten matches. ?id= for a match in the results; ?espn= with the
 * players' ids (a, b) and names (an, bn) for a live or upcoming one.
 */
const pct = (n, d) => (d ? Math.round((100 * n) / d) : null)
const THIN = 20                                     // fewer tour-level matches than this: the numbers are thin

function Side({ label, a, b, fmt = (v) => v, better = 'high' }) {
  const na = typeof a === 'number' ? a : null, nb = typeof b === 'number' ? b : null
  const lead = na != null && nb != null && na !== nb ? ((na > nb) === (better === 'high') ? 'a' : 'b') : null
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 py-1.5 border-t border-gray-100 first:border-t-0">
      <p className={`text-sm tabular-nums ${lead === 'a' ? 'font-black text-gray-900' : 'font-semibold text-gray-500'}`}>{a == null ? '—' : fmt(a, 'a')}</p>
      <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest text-center max-w-[120px] leading-tight">{label}</p>
      <p className={`text-sm tabular-nums text-right ${lead === 'b' ? 'font-black text-gray-900' : 'font-semibold text-gray-500'}`}>{b == null ? '—' : fmt(b, 'b')}</p>
    </div>
  )
}

/** A player's ranking now, beside their name. */
const Rank = ({ r }) => (r ? <span className="ml-1 text-[10px] font-semibold text-gray-400">#{r}</span> : null)

const rec = (r) => (r && r.won + r.lost ? `${r.won}–${r.lost}` : null)
const recPct = (r) => (r && r.won + r.lost ? r.pct : null)

function Form({ p, name, nav }) {
  if (!p?.last?.length) return null
  return (
    <div className="card">
      <div className="flex items-center gap-2">
        <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest flex-1">{name} · last {p.last.length}</p>
        <div className="flex gap-0.5">
          {[...p.last].reverse().map((x) => (
            <span key={x.id} className={`w-4 h-4 rounded-sm text-[9px] font-black text-white flex items-center justify-center ${x.won ? 'bg-green-600' : 'bg-red-500'}`}>{x.won ? 'W' : 'L'}</span>
          ))}
        </div>
      </div>
      {p.last.map((x) => (
        <button key={x.id} onClick={() => nav(matchLink(x))} className="w-full text-left flex items-baseline gap-2 py-1 border-t border-gray-100 first:border-t-0 mt-1 text-[11px]">
          <span className={`w-3 font-black ${x.won ? 'text-green-700' : 'text-red-600'}`}>{x.won ? 'W' : 'L'}</span>
          <span className="flex-1 min-w-0">
            <span className="font-bold text-gray-800">{x.opponent}</span>
            {x.opp_rank && <span className="text-[9px] text-gray-400"> #{x.opp_rank}</span>}
            <span className="block text-[10px] text-gray-400 truncate">{fmtShort(x.date)} · {x.tournament} · {ROUND_NAME[x.round] || x.round}</span>
          </span>
          <span className="tabular-nums text-gray-600 whitespace-nowrap"><ScoreText score={x.score} won={x.won} /></span>
        </button>
      ))}
    </div>
  )
}

const LINE = {
  break: 'text-red-600 font-black', set: 'text-gray-900 font-black bg-amber-50 -mx-2 px-2 rounded',
  end: 'text-gray-900 font-black bg-amber-50 -mx-2 px-2 rounded', game: 'text-gray-900 font-bold',
  bp: 'text-amber-700 font-bold', ace: 'text-green-700 font-bold', df: 'text-red-500 font-semibold',
  point: 'text-gray-600', info: 'text-gray-400 italic',
}

/** Live text commentary, point by point (WTA only: built from the WTA's live scoring), every 5 seconds. */
function Commentary({ espn, tour, names }) {
  const [f, setF] = useState(null)
  const [all, setAll] = useState(false)
  useEffect(() => {
    if (tour !== 'WTA') return undefined
    let alive = true
    const load = () => tennisLiveFeed(espn).then((r) => { if (alive) setF(r.data) }).catch(() => {})
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [espn, tour])
  const head = <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Commentary</p>
  if (tour !== 'WTA') {
    return <div className="card">{head}<p className="text-[11px] text-gray-400 mt-1">Point-by-point commentary is for WTA matches only - no open source carries the ATP's points.</p></div>
  }
  if (!f) return <div className="card">{head}<p className="text-[11px] text-gray-400 mt-1">Loading…</p></div>
  const st = f.stats || {}
  const lines = all ? f.lines : f.lines.slice(0, 25)
  const stat = (label, k, fmt = (v) => v) => st[k] && (
    <div className="grid grid-cols-[1fr_auto_1fr] text-[11px] tabular-nums">
      <span className="font-bold text-gray-900">{st[k][0] != null ? fmt(st[k][0]) : '–'}</span>
      <span className="text-gray-400 text-center px-2">{label}</span>
      <span className="font-bold text-gray-900 text-right">{st[k][1] != null ? fmt(st[k][1]) : '–'}</span>
    </div>
  )
  return (
    <div className="card">
      <div className="flex items-center">{head}{f.live !== false && f.found && <span className="ml-auto flex items-center gap-1 text-[9px] font-black text-red-600"><span className="w-1.5 h-1.5 rounded-full bg-red-600 animate-pulse" />LIVE</span>}</div>
      {f.found && Object.keys(st).length > 0 && (
        <div className="mt-2 mb-2 pb-2 border-b border-gray-100 space-y-0.5">
          <div className="grid grid-cols-[1fr_auto_1fr] text-[10px] font-black text-gray-500"><span className="truncate">{names[0]}</span><span /><span className="truncate text-right">{names[1]}</span></div>
          {stat('Aces', 'aces')}
          {stat('Double faults', 'dfs')}
          {stat('1st-serve points won', 'first_won', (v) => `${v}%`)}
          {stat('Break points won', 'bp', (v) => `${v[0]}/${v[1]}`)}
        </div>
      )}
      {!f.found && <p className="text-[11px] text-gray-400 mt-1">Commentary starts with the first point the WTA's live scoring shows for this match.</p>}
      {lines.map((l, i) => (
        <div key={f.lines.length - i} className={`flex gap-2 py-1 border-t border-gray-50 first:border-t-0 text-[12px] ${LINE[l.kind] || 'text-gray-600'}`}>
          <span className="w-12 shrink-0 text-[10px] font-normal text-gray-400 tabular-nums pt-px">
            {new Date(l.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).replace(/\s?[ap]m$/i, '')}
          </span>
          <span className="flex-1">{l.text}</span>
        </div>
      ))}
      {f.lines.length > 25 && !all && (
        <button onClick={() => setAll(true)} className="mt-2 text-[11px] font-bold text-brand-600">Show all {f.lines.length} lines</button>
      )}
    </div>
  )
}

/**
 * Where the set being played stands: the games, the leader, and how many breaks
 * up they are - worked out from who serves now (players alternate serve, so the
 * games each has served are known; every break moves the gap by two from that).
 */
function setState(live) {
  const [p0, p1] = live.players
  const g0 = p0.games?.[p0.games.length - 1] ?? 0, g1 = p1.games?.[p1.games.length - 1] ?? 0
  const hi = Math.max(g0, g1), lo = Math.min(g0, g1)
  const setNo = Math.max(p0.games?.length || 0, 1)
  if ((hi >= 6 && hi - lo >= 2) || (hi === 7 && lo === 6)) return { done: true, setNo }
  const g = g0 + g1
  const srv = p0.serving ? 0 : p1.serving ? 1 : null
  let net = null                                    // breaks player 0 is up in this set
  if (srv != null && !(g0 === 6 && g1 === 6)) {
    const first = g % 2 === 0 ? srv : 1 - srv       // who served the set's first game
    const served = [0, 0]
    served[first] = Math.ceil(g / 2); served[1 - first] = Math.floor(g / 2)
    const x = (g0 - g1 - (served[0] - served[1])) / 2
    if (Number.isInteger(x)) net = x
  }
  const leader = g0 > g1 ? 0 : g1 > g0 ? 1 : null
  const breaks = net == null || leader == null ? null : Math.abs(net) * (Math.sign(net) === (leader === 0 ? 1 : -1) ? 1 : -1)
  return { g0, g1, hi, lo, g, setNo, leader, breaks, tiebreak: g0 === 6 && g1 === 6 }
}

const P = (n, d) => (d ? (100 * n) / d : null)
const fmtPct = (v) => (v == null ? '—' : `${Math.round(v)}%`)

/** One line of a player's side: theirs, the tour's, and the gap. */
function PSide({ label, mine, avg, i }) {
  const p = mine ? P(mine[i], mine[0]) : null, t = avg ? P(avg[i], avg[0]) : null
  const few = !mine?.[0] || mine[0] < 5
  const diff = p != null && t != null && !few ? p - t : null
  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-baseline gap-2 py-1 border-t border-gray-100 first:border-t-0">
      <span className="text-[11px] text-gray-700">{label}</span>
      <span className={`text-sm font-black tabular-nums text-right ${few ? 'text-gray-300' : 'text-gray-900'}`}>
        {fmtPct(p)}<span className="text-[9px] font-semibold text-gray-400"> {mine?.[0] ? `${mine[i]}/${mine[0]}` : ''}</span>
      </span>
      <span className="text-[10px] font-bold tabular-nums text-gray-500 w-20 text-right">
        tour {fmtPct(t)}{diff != null && <span className={diff >= 5 ? ' text-green-600' : diff <= -5 ? ' text-red-500' : ' text-gray-400'}> {diff > 0 ? '+' : ''}{Math.round(diff)}</span>}
      </span>
    </div>
  )
}

/**
 * The live set's score, read against the stats: how often sets at this exact
 * score (and breaks up) ended under / over 8.5 games, and the leader's and the
 * trailer's own early-break record from their side (Match Charting Project).
 */
function ScoreStats({ live, eb, players, names }) {
  const st = setState(live)
  const T = eb?.tours?.[live.tour]
  if (!T) return null
  const head = <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">At this score · set {st.setNo}</p>
  if (st.done) return null
  const last = (n) => n.split(' ').slice(-1)[0]
  const avg = players.find((x) => x?.early_break?.avg)?.early_break?.avg
  const surfaceOver = (pl) => {
    const x = pl?.sets_surface_12_months?.sets ? pl.sets_surface_12_months : pl?.sets_12_months
    return x?.sets ? { p: P(x.over, x.sets), n: x.sets, surface: x === pl?.sets_surface_12_months } : null
  }

  if (st.leader == null) {
    return (
      <div className="card">
        {head}
        <p className="text-sm font-bold text-gray-900 mt-1">Level at {st.g0}-{st.g1}{st.tiebreak ? ' - tie-break' : ''}</p>
        <p className="text-[11px] text-gray-500 mt-0.5">
          {st.g >= 9 || st.tiebreak ? 'The set is already over 8.5 games.' : 'No one is ahead yet - the scoreline stats start once a player leads.'}
        </p>
        {[0, 1].map((i) => {
          const o = surfaceOver(players[i])
          return o && <p key={i} className="text-[11px] text-gray-600 mt-1"><b>{last(names[i])}</b>: {Math.round(o.p)}% of their sets over 8.5 ({o.n} sets, 12 months{o.surface ? ', this surface' : ''})</p>
        })}
      </div>
    )
  }

  const L = st.leader, Tr = 1 - L
  const k = `${st.hi}-${st.lo}`
  const kb = st.breaks != null && st.breaks >= 0 ? `${k}/${st.breaks}` : null
  const exact = (kb && T.by_score?.[kb]?.n >= 30) ? T.by_score[kb] : null
  const any = T.by_score?.[k]
  const c = exact || any
  const under = c?.n ? P(c.under, c.n) : null
  const overDone = st.g >= 9
  const lead = players[L]?.early_break?.player, trail = players[Tr]?.early_break?.player
  const breakUp = st.breaks != null && st.breaks > 0
  const odds = (v) => (v ? (100 / v).toFixed(2) : '—')
  return (
    <div className="card">
      {head}
      <p className="text-sm font-black text-gray-900 mt-1">
        {last(names[L])} leads {st.hi}-{st.lo}
        <span className="text-[11px] font-bold text-gray-500">
          {' · '}{st.breaks == null ? 'breaks not known' : st.breaks === 0 ? 'on serve' : `${st.breaks} break${st.breaks > 1 ? 's' : ''} up`}
        </span>
      </p>

      {/* the set at this score, on the whole tour */}
      {overDone ? (
        <p className="text-[11px] text-gray-500 mt-1">{st.g} games played - the set is already over 8.5.</p>
      ) : c?.n ? (
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div className="bg-green-50 border border-green-200 px-2.5 py-2">
            <p className="text-[9px] font-black text-green-800 uppercase tracking-widest">Set under 8.5</p>
            <p className="text-xl font-black text-green-800 tabular-nums">{fmtPct(under)}</p>
            <p className="text-[10px] text-green-900/70">break-even odds {odds(under)}</p>
          </div>
          <div className="bg-amber-50 border border-amber-200 px-2.5 py-2">
            <p className="text-[9px] font-black text-amber-800 uppercase tracking-widest">Set over 8.5</p>
            <p className="text-xl font-black text-amber-800 tabular-nums">{fmtPct(under == null ? null : 100 - under)}</p>
            <p className="text-[10px] text-amber-900/70">break-even odds {odds(under == null ? null : 100 - under)}</p>
          </div>
          <p className="col-span-2 text-[10px] text-gray-400">
            {live.tour} sets that were at {k}{exact ? ` with the leader ${st.breaks === 0 ? 'on serve' : `${st.breaks} break${st.breaks > 1 ? 's' : ''} up`}` : ''}: {c.n.toLocaleString('en-IN')} charted sets
            {exact && any && any.n !== c.n ? ` (any ${k}: ${fmtPct(P(any.under, any.n))} under)` : ''}.
          </p>
        </div>
      ) : (
        <p className="text-[11px] text-gray-400 mt-1">Too few charted sets at {k} to say.</p>
      )}

      {/* the leader, from their side */}
      <div className="mt-3">
        <p className="text-[10px] font-black text-green-700 uppercase tracking-widest">▲ {names[L]} - ahead</p>
        {lead ? (
          breakUp ? (
            <>
              <p className="text-[10px] text-gray-400">Sets where they broke early ({lead.broke[0]} charted):</p>
              <PSide label="Set ends under 8.5" mine={lead.broke} avg={avg?.broke} i={1} />
              <PSide label="They win the set" mine={lead.broke} avg={avg?.broke} i={2} />
              <PSide label="They close it 6-2 or better" mine={lead.broke} avg={avg?.broke} i={3} />
            </>
          ) : (
            <>
              <p className="text-[10px] text-gray-400">All their charted sets ({lead.all[0]}):</p>
              <PSide label="Set ends under 8.5" mine={lead.all} avg={avg?.all} i={1} />
              <PSide label="They win the set" mine={lead.all} avg={avg?.all} i={2} />
            </>
          )
        ) : <p className="text-[11px] text-gray-400">Too few of their sets are charted - the tour's figure above stands for them.</p>}
        {(() => { const o = surfaceOver(players[L]); return o && <p className="text-[10px] text-gray-500 mt-1">Their sets over 8.5: {Math.round(o.p)}% of {o.n} (12 months{o.surface ? ', this surface' : ''})</p> })()}
      </div>

      {/* the one behind */}
      <div className="mt-3">
        <p className="text-[10px] font-black text-red-600 uppercase tracking-widest">▼ {names[Tr]} - behind</p>
        {trail ? (
          breakUp ? (
            <>
              <p className="text-[10px] text-gray-400">Sets where they were broken early ({trail.broken[0]} charted):</p>
              <PSide label="Set ends under 8.5" mine={trail.broken} avg={avg?.broken} i={1} />
              <PSide label="They still win the set" mine={trail.broken} avg={avg?.broken} i={2} />
            </>
          ) : (
            <>
              <p className="text-[10px] text-gray-400">All their charted sets ({trail.all[0]}):</p>
              <PSide label="Set ends under 8.5" mine={trail.all} avg={avg?.all} i={1} />
              <PSide label="They win the set" mine={trail.all} avg={avg?.all} i={2} />
            </>
          )
        ) : <p className="text-[11px] text-gray-400">Too few of their sets are charted - the tour's figure above stands for them.</p>}
        {(() => { const o = surfaceOver(players[Tr]); return o && <p className="text-[10px] text-gray-500 mt-1">Their sets over 8.5: {Math.round(o.p)}% of {o.n} (12 months{o.surface ? ', this surface' : ''})</p> })()}
      </div>

      <p className="text-[10px] text-gray-400 mt-2">
        Under 8.5 = the set ends 6-2 or wider. "Broke early" = a break in the set's first 4 games. Match Charting Project, {eb.from_year} on;
        break-even odds are 100 ÷ the % - a price above them pays if the rate holds. Updates with the score.
      </p>
    </div>
  )
}

export default function TennisMatch() {
  const nav = useNavigate()
  const [q] = useSearchParams()
  const id = q.get('id'), espn = q.get('espn')
  const [d, setD] = useState(null)
  const [live, setLive] = useState(null)          // the live / upcoming match from ESPN, refreshed
  useEffect(() => {
    setD(null)
    const params = id ? { tour: 'ATP', match_id: id } : { tour: q.get('tour'), a: q.get('a') || undefined, b: q.get('b') || undefined, surface: q.get('surface') || '' }
    tennisMatchup(params).then((r) => setD(r.data)).catch(() => setD({ error: true }))
  }, [id, espn])
  useEffect(() => {
    if (!espn) return undefined
    let alive = true
    const load = () => tennisLive(q.get('tour')).then((r) => {
      if (alive) setLive(r.data.matches.find((m) => m.espn === espn) || { gone: true })
    }).catch(() => {})
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, 10000)
    return () => { alive = false; clearInterval(t) }
  }, [espn])

  const pts = useLivePoints(live?.tour === 'WTA' && live?.state === 'live')
  const [eb, setEb] = useState(null)               // the scoreline stats (tennis_early_break)
  useEffect(() => { if (live?.state === 'live' && !eb) tennisEarlyBreak().then((r) => setEb(r.data)).catch(() => {}) }, [live?.state])
  const m = d?.match
  const A = d?.players?.a, B = d?.players?.b
  const nameA = m?.winner.name || A?.info?.name || q.get('an') || 'Player 1'
  const nameB = m?.loser.name || B?.info?.name || q.get('bn') || 'Player 2'
  const surface = d?.surface || m?.surface || q.get('surface')
  const title = m ? m.tournament : live?.tournament
  const round = m ? m.round : live?.round
  const s = (p) => p?.sets_surface_12_months
  const sAll = (p) => p?.sets_12_months
  const openPlayer = (tour, pid) => nav(`/betting?tab=players&player=${tour}:${pid}`)
  const tour = m?.tour || d?.tour || q.get('tour')

  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-3 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-field-950 text-white tracking-wider">{tour}</span>
          <h1 className="text-lg font-black tracking-tight flex-1 min-w-0 truncate">{title || 'Match'}</h1>
          {surface && <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${SURFACE[surface] || 'bg-gray-100 text-gray-700'}`}>{surface}</span>}
        </div>
        <p className="text-[11px] text-gray-400 mt-0.5">
          {ROUND_NAME[round] || round || ''}
          {m ? ` · ${fmtShort(m.date)}` : live?.state === 'upcoming' ? ` · ${startTime(live.start)}` : ''}
        </p>
      </div>

      <div className="px-5 mt-4 max-w-2xl space-y-3">
        {!d && <p className="text-xs text-gray-400 text-center py-8">Loading…</p>}
        {d?.error && <p className="text-sm text-red-600 text-center py-8">Couldn't load this match.</p>}
        {d && !d.error && (
          <Safe what="this match">
            {/* the match: final score, or live / upcoming from ESPN */}
            <div className="card">
              {m && <MatchRow m={m} onPlayer={openPlayer} />}
              {!m && live && !live.gone && <LiveRow m={withPoints(live, pts)} onOpen={() => {}} plain />}
              {!m && (!live || live.gone) && (
                <div className="py-2 text-sm font-bold text-gray-900">
                  {nameA} <span className="text-gray-400 font-medium">vs</span> {nameB}
                  {live?.gone && <p className="text-[10px] font-normal text-gray-400 mt-1">Finished or no longer listed - its result shows in Results once it's in.</p>}
                </div>
              )}
            </div>

            {!m && live && !live.gone && live.state === 'live' && eb && (
              <Safe what="the stats at this score">
                <ScoreStats live={withPoints(live, pts)} eb={eb} players={[A, B]} names={live.players.map((p) => p.name)} />
              </Safe>
            )}

            {!m && live && !live.gone && live.state === 'live' && (
              <Commentary espn={espn} tour={live.tour} names={live.players.map((p) => p.name)} />
            )}

            {/* head to head */}
            {d.h2h && (
              <div className="card">
                <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Head to head</p>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-sm font-bold flex-1 min-w-0 truncate">{nameA}<Rank r={A?.rank} /></span>
                  <span className="text-2xl font-black text-brand-600 px-3 tabular-nums">{d.h2h.a_wins} – {d.h2h.b_wins}</span>
                  <span className="text-sm font-bold flex-1 min-w-0 truncate text-right">{nameB}<Rank r={B?.rank} /></span>
                </div>
                {d.h2h.matches.length === 0 && <p className="text-[11px] text-gray-400 mt-1">They haven't met at tour level.</p>}
                {d.h2h.matches.filter((x) => x.id !== m?.id).map((x) => (
                  <div key={x.id}>
                    <p className="text-[10px] text-gray-400 mt-2">{fmtShort(x.date)} · {x.tournament} · {ROUND_NAME[x.round] || x.round}{x.surface ? ` · ${x.surface}` : ''}</p>
                    <MatchRow m={x} onPlayer={openPlayer} onOpen={(y) => nav(matchLink(y))} />
                  </div>
                ))}
              </div>
            )}

            {/* side by side */}
            {(A || B) && (
              <div className="card">
                <div className="grid grid-cols-[1fr_auto_1fr] gap-2 pb-1">
                  <button disabled={!A} onClick={() => A && openPlayer(tour, A.info.player_id)} className="text-left text-xs font-black text-brand-600 truncate">{nameA} ›</button>
                  <span />
                  <button disabled={!B} onClick={() => B && openPlayer(tour, B.info.player_id)} className="text-right text-xs font-black text-brand-600 truncate">{nameB} ›</button>
                </div>
                <Side label={`${tour} ranking now`} a={A?.rank ?? null} b={B?.rank ?? null} fmt={(v) => `#${v}`} better="low" />
                <Side label="Career" a={rec(A?.career)} b={rec(B?.career)} />
                <Side label="Win % · 12 months" a={recPct(A?.last_12_months)} b={recPct(B?.last_12_months)} fmt={(v) => `${v}%`} />
                {surface && <Side label={`${surface} · 12 months`} a={recPct(A?.surface_12_months)} b={recPct(B?.surface_12_months)}
                  fmt={(v, k) => `${v}% (${rec((k === 'a' ? A : B).surface_12_months)})`} />}
                {surface && <Side label={`${surface} · career`} a={recPct(A?.surface)} b={recPct(B?.surface)} fmt={(v) => `${v}%`} />}
                <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mt-3 mb-1">
                  Their sets · last 12 months{surface ? ` on ${surface.toLowerCase()}` : ''}
                </p>
                <Side label="Sets over 8.5 games" a={pct(s(A)?.over, s(A)?.sets)} b={pct(s(B)?.over, s(B)?.sets)}
                  fmt={(v, k) => `${v}% of ${s(k === 'a' ? A : B).sets}`} />
                <Side label="1st set over 8.5" a={pct(s(A)?.first_over, s(A)?.matches)} b={pct(s(B)?.first_over, s(B)?.matches)} fmt={(v) => `${v}%`} />
                <Side label="Tie-break sets" a={pct(s(A)?.tb, s(A)?.sets)} b={pct(s(B)?.tb, s(B)?.sets)} fmt={(v) => `${v}%`} />
                <Side label="Over 8.5 · all surfaces" a={pct(sAll(A)?.over, sAll(A)?.sets)} b={pct(sAll(B)?.over, sAll(B)?.sets)} fmt={(v) => `${v}%`} />
                <p className="text-[10px] text-gray-400 mt-2">Bold = the better of the two. Sets over 8.5 = 6-3 or closer.</p>
              </div>
            )}
            {/* a player new to the tour: most of their tennis is below it (WTA 125, Challengers, ITF,
                qualifying), which the results don't hold - say how thin the numbers are */}
            {[[A, nameA], [B, nameB]].filter(([p]) => p && p.career.won + p.career.lost < THIN).map(([p, n]) => (
              <p key={n} className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                <b>{n}</b> has played only <b>{p.career.won + p.career.lost}</b> tour-level match{p.career.won + p.career.lost === 1 ? '' : 'es'}.
                Most of their tennis is probably below tour level (WTA 125, Challengers, ITF, qualifying), which isn't in this data,
                so their numbers here rest on very few matches.
              </p>
            ))}
            {!A && !B && !m && (
              <p className="text-[11px] text-gray-500 bg-gray-100 rounded-md px-3 py-2">
                Neither player is in the results yet (a qualifier or a newcomer), so there's no form or head-to-head to show.
              </p>
            )}

            <Form p={A} name={nameA} nav={nav} />
            <Form p={B} name={nameB} nav={nav} />
          </Safe>
        )}
      </div>
    </div>
  )
}
