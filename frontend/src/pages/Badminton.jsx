import { useEffect, useState } from 'react'
import RankingList from '../components/RankingList'
import {
  badmintonH2H, badmintonLive, badmintonMatch, badmintonPlayer, badmintonPlayers, badmintonRankings,
  badmintonStats, badmintonTournament, badmintonTournaments,
} from '../api'

/**
 * Badminton in the sports section (Betting analytics' 🏸 switch): BWF live
 * scores, results from 2018, players and stats (backend routers/badminton.py,
 * read from bwfbadminton.com). A match opens in place - its point flow and
 * numbers - rather than on a page of its own.
 */
export const B_TABS = [['live', 'Live'], ['results', 'Results'], ['players', 'Players'], ['stats', 'Stats']]
const EVENTS = [['MS', "Men's singles"], ['WS', "Women's singles"], ['MD', "Men's doubles"], ['WD', "Women's doubles"], ['XD', 'Mixed']]
const EVENT = Object.fromEntries(EVENTS)
const ROUND = { Final: 'Final', SF: 'Semifinals', QF: 'Quarterfinals', R16: 'Round of 16', R32: 'Round of 32', R64: 'Round of 64' }
const ENDING = { 1: 'W/O', 2: 'Ret.', 3: 'DQ' }
const fmtDate = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '')
const fmtUtc = (s) => {
  if (!s) return ''
  const d = new Date(`${s.replace(' ', 'T')}Z`)
  const today = new Date().toDateString() === d.toDateString()
  return d.toLocaleString('en-IN', today ? { hour: 'numeric', minute: '2-digit', hour12: true }
    : { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true })
}
function Flag({ ioc }) {
  return <span className="inline-block w-8 text-[9px] font-bold text-gray-400 tracking-wider">{ioc || ''}</span>
}
const names = (side) => side.players.map((p) => p.name).join(' / ')
const pct = (w, l) => (w + l ? Math.round((100 * w) / (w + l)) : null)

function Seg({ value, onChange, options }) {
  return (
    <div className="flex rounded-md border border-amber-300 overflow-hidden">
      {options.map(([k, l]) => (
        <button key={k} onClick={() => onChange(k)}
          className={`flex-1 px-2 py-1 text-[11px] font-bold ${value === k ? 'bg-field-950 text-white' : 'bg-white text-gray-600'}`}>{l}</button>
      ))}
    </div>
  )
}

function Side({ side, no, m, onPlayer }) {
  const live = m.state === 'live'
  const won = m.winner === no
  const lost = m.winner && !won
  return (
    <div className={`flex items-center gap-1.5 ${lost ? 'text-gray-400' : 'text-gray-900'}`}>
      <Flag ioc={side.country} />
      <span className={`flex-1 min-w-0 truncate text-[13px] ${won || live || !m.winner ? 'font-bold' : 'font-medium'}`}>
        {side.players.map((p, i) => (
          <span key={i}>
            {i > 0 && ' / '}
            <button onClick={(e) => { e.stopPropagation(); if (p.id && onPlayer) onPlayer(p.id) }} className="hover:text-brand-600">{p.name}</button>
          </span>
        ))}
        {side.seed && <span className="ml-1 text-[10px] font-semibold text-gray-400">({side.seed})</span>}
        {live && m.serve === no && <span title="Serving" className="ml-1.5 inline-block w-2 h-2 rounded-full bg-lime-400 ring-1 ring-lime-600 align-middle" />}
      </span>
      <span className="w-3.5 text-center text-[10px] text-green-600 font-black">{won ? '✓' : ''}</span>
      {m.games.map((g, k) => {
        const mine = g[no - 1], theirs = g[2 - no]
        const now = live && k === m.games.length - 1
        return (
          <span key={k} className={`w-6 text-center text-[13px] tabular-nums ${now ? 'text-red-600 font-black' : mine > theirs ? 'font-black' : 'font-medium text-gray-400'}`}>{mine}</span>
        )
      })}
    </div>
  )
}

/** One game's rallies as a strip - a bar per point, up for side 1, down for side 2 (from badmintonscore-web's point flow). */
function Flow({ g, labels }) {
  const pts = []
  let pa = 0, pb = 0
  g.flow.forEach(([a, b]) => { pts.push(a > pa ? 1 : b > pb ? 2 : 0); pa = a; pb = b })
  let run = 0, best = [0, 0], last = 0
  pts.forEach((w) => { run = w === last ? run + 1 : 1; last = w; if (w) best[w - 1] = Math.max(best[w - 1], run) })
  return (
    <div>
      <div className="flex items-center justify-between text-[10px] font-bold text-gray-500">
        <span>{g.a}–{g.b}</span><span className="font-medium text-gray-400">longest run {best[0]} · {best[1]}</span>
      </div>
      <div className="flex items-center gap-px h-8 mt-0.5">
        {pts.map((w, i) => (
          <div key={i} className="flex-1 h-full flex flex-col" title={labels[w - 1] || ''}>
            <div className={`h-1/2 rounded-sm ${w === 1 ? 'bg-brand-400' : ''}`} />
            <div className={`h-1/2 rounded-sm ${w === 2 ? 'bg-field-700' : ''}`} />
          </div>
        ))}
      </div>
    </div>
  )
}

const STAT_NAME = { rallies_won: 'Rallies won', consecutive_points: 'Most points in a row', game_points: 'Game points',
  smash_winner: 'Smash winners', net_winner: 'Net winners', clear_winner: 'Clear winners',
  challenge_used: 'Challenges', challenge_won: 'Challenges won' }

function Detail({ m }) {
  const [d, setD] = useState(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    badmintonMatch(m.tournament_id, m.code, m.state === 'finished').then((r) => setD(r.data)).catch(() => setErr(true))
  }, [m.tournament_id, m.code, m.state])
  if (err) return <p className="text-[11px] text-gray-400 py-2">BWF has no point-by-point numbers for this one.</p>
  if (!d) return <p className="text-[11px] text-gray-400 py-2">Loading…</p>
  const labels = [names(m.side1), names(m.side2)]
  return (
    <div className="mt-2 mb-1 rounded-md bg-amber-50/60 border border-amber-100 p-3 space-y-3" onClick={(e) => e.stopPropagation()}>
      <div className="flex gap-3 text-[10px] font-bold">
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-brand-400" />{m.side1.players.map((p) => p.name.split(' ').slice(-1)[0]).join('/')}</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-field-700" />{m.side2.players.map((p) => p.name.split(' ').slice(-1)[0]).join('/')}</span>
        {d.minutes ? <span className="ml-auto text-gray-400">{d.minutes} min</span> : null}
      </div>
      {d.games.filter((g) => g.flow.length).map((g, i) => <Flow key={i} g={g} labels={labels} />)}
      {Object.keys(d.stats).length > 0 && (
        <table className="w-full text-[11px]">
          <tbody>
            {Object.entries(d.stats).map(([k, [a, b]]) => (
              <tr key={k} className="border-t border-amber-100">
                <td className={`py-1 w-10 tabular-nums ${a > b ? 'font-black' : ''}`}>{a ?? '–'}</td>
                <td className="py-1 text-center text-gray-500">{STAT_NAME[k] || k}</td>
                <td className={`py-1 w-10 text-right tabular-nums ${b > a ? 'font-black' : ''}`}>{b ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** A match: tap to open its point flow and numbers in place; tap a name for that player. */
function Match({ m, onPlayer, showWhen, showEvent }) {
  const [open, setOpen] = useState(false)
  const live = m.state === 'live'
  return (
    <div onClick={() => m.state !== 'upcoming' && setOpen((o) => !o)}
      className="py-2 border-t border-gray-100 first:border-t-0 cursor-pointer hover:bg-amber-50/50 -mx-2 px-2 rounded">
      <div className="flex items-center gap-2 mb-0.5 text-[10px]">
        {live && <span className="font-black text-red-600 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-600 animate-pulse" />LIVE</span>}
        {m.state === 'upcoming' && <span className="font-bold text-gray-500">{fmtUtc(m.time_utc)}</span>}
        {showEvent && <span className="font-bold text-gray-500">{m.event}</span>}
        {m.round && <span className="text-gray-400">{ROUND[m.round] || m.round}</span>}
        {showWhen && m.tournament && <span className="text-gray-400 truncate">{m.tournament} · {fmtDate(m.day)}</span>}
        {m.court && m.state !== 'finished' && <span className="text-gray-400">{m.court}</span>}
        <span className="ml-auto flex items-center gap-2 text-gray-400">
          {ENDING[m.score_status] && <span className="font-bold text-amber-600">{ENDING[m.score_status]}</span>}
          {m.minutes ? <span>{m.minutes}m</span> : null}
          {m.state !== 'upcoming' && <span className="font-bold text-brand-600">{open ? '▴' : '▾'}</span>}
        </span>
      </div>
      <Side side={m.side1} no={1} m={m} onPlayer={onPlayer} />
      <Side side={m.side2} no={2} m={m} onPlayer={onPlayer} />
      {open && <Detail m={m} />}
    </div>
  )
}

function CardHead({ title, sub, logo }) {
  return (
    <div className="px-4 py-2.5 bg-field-950 text-white flex items-center gap-2">
      {logo && <img src={logo} alt="" className="w-6 h-6 rounded bg-white object-contain" onError={(e) => { e.currentTarget.style.display = 'none' }} />}
      <p className="text-sm font-bold flex-1 min-w-0 truncate">{title}</p>
      {sub && <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-white/15 tracking-wider">{sub}</span>}
    </div>
  )
}

// ── Live ────────────────────────────────────────────────────────────────────

function Live({ active, onPlayer }) {
  const [d, setD] = useState(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    if (!active) return undefined
    let alive = true
    const load = () => badmintonLive().then((r) => { if (alive) { setD(r.data); setErr(false) } }).catch(() => { if (alive) setErr(true) })
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, 30000)
    return () => { alive = false; clearInterval(t) }
  }, [active])
  if (!d && !err) return <p className="text-xs text-gray-400 text-center py-6">Loading live matches…</p>
  if (!d) return <p className="text-sm text-red-600 text-center py-6">Couldn't reach BWF's live scores - try again in a minute.</p>
  if (!d.tournaments.length) return <p className="text-sm text-gray-400 text-center py-10">No BWF tournament on right now - see Results for the latest.</p>
  return (
    <div className="space-y-4">
      {d.tournaments.map((t) => (
        <div key={t.id} className="card p-0 overflow-hidden">
          <CardHead title={t.name} sub={t.category} logo={t.logo} />
          <p className="px-4 pt-2 text-[10px] text-gray-400">{t.dates}{t.venue ? ` · ${t.venue}` : ''}</p>
          {[['live', 'Live now'], ['upcoming', 'Coming up'], ['finished', 'Finished']].map(([k, label]) => {
            const ms = t.matches.filter((m) => m.state === k)
            if (!ms.length && k !== 'live') return null
            return (
              <div key={k} className="px-4 pb-2 mt-2">
                <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">{label} · {ms.length}</p>
                {ms.length === 0 && <p className="text-xs text-gray-400 py-1">Nothing on court right now.</p>}
                {ms.map((m) => <Match key={m.id} m={m} onPlayer={onPlayer} showEvent />)}
              </div>
            )
          })}
        </div>
      ))}
      <p className="text-[10px] text-gray-400 text-center">
        From bwfbadminton.com · updates every 30 seconds · {new Date(d.updated).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}
      </p>
    </div>
  )
}

// ── Results ─────────────────────────────────────────────────────────────────

function Tournament({ id, onBack, onPlayer }) {
  const [d, setD] = useState(null)
  const [ev, setEv] = useState('MS')
  useEffect(() => { setD(null); badmintonTournament(id).then((r) => setD(r.data)).catch(() => setD({ error: true })) }, [id])
  if (!d) return <p className="text-xs text-gray-400 text-center py-6">Loading…</p>
  if (d.error) return <p className="text-sm text-red-600 text-center py-6">Couldn't load this tournament.</p>
  const rounds = d.events[ev] || []
  return (
    <div className="space-y-3">
      <button onClick={onBack} className="text-xs font-bold text-gray-400">← All tournaments</button>
      <div className="card p-0 overflow-hidden">
        <CardHead title={d.tournament.name} sub={d.tournament.category?.replace('HSBC BWF World Tour ', '')} logo={d.tournament.logo} />
        <p className="px-4 py-2 text-[10px] text-gray-400">{fmtDate(d.tournament.start)} – {fmtDate(d.tournament.end)}{d.tournament.location ? ` · ${d.tournament.location}` : ''}</p>
      </div>
      <Seg value={ev} onChange={setEv} options={EVENTS.map(([k]) => [k, k])} />
      {rounds.length === 0 && <p className="text-sm text-gray-400 text-center py-8">No {EVENT[ev].toLowerCase()} matches read yet.</p>}
      {rounds.map((r) => (
        <div key={r.round} className="card py-2">
          <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">{ROUND[r.round] || r.round}</p>
          {r.matches.map((m) => <Match key={m.id} m={m} onPlayer={onPlayer} />)}
        </div>
      ))}
    </div>
  )
}

function Results({ onPlayer, sum }) {
  const [year, setYear] = useState(0)
  const [d, setD] = useState(null)
  const [open, setOpen] = useState(null)
  useEffect(() => { setD(null); badmintonTournaments(year).then((r) => setD(r.data)).catch(() => setD({ tournaments: [], years: [] })) }, [year])
  if (open) return <Tournament id={open} onBack={() => setOpen(null)} onPlayer={onPlayer} />
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <select value={d?.year || year} onChange={(e) => setYear(+e.target.value)}
          className="rounded-md border border-amber-300 bg-white px-2 py-1.5 text-sm font-bold">
          {(d?.years?.length ? d.years : [new Date().getFullYear()]).map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <p className="flex-1 text-[11px] text-gray-400 text-right">
          {sum?.sync?.running ? (sum.sync.todo ? `reading BWF's archive… ${sum.sync.done}/${sum.sync.todo} tournaments` : "reading BWF's calendars…") : ''}
        </p>
      </div>
      {!d && <p className="text-xs text-gray-400 text-center py-6">Loading…</p>}
      {d && d.tournaments.length === 0 && <p className="text-sm text-gray-400 text-center py-10">Nothing on file for this year yet - BWF's archive is still being read in.</p>}
      {d?.tournaments.map((t) => (
        <button key={t.id} onClick={() => setOpen(t.id)} className="card w-full text-left block hover:bg-amber-50/50">
          <div className="flex items-center gap-2">
            {t.logo && <img src={t.logo} alt="" className="w-7 h-7 object-contain" onError={(e) => { e.currentTarget.style.display = 'none' }} />}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-gray-900 truncate">{t.name}</p>
              <p className="text-[10px] text-gray-400">{fmtDate(t.start)} – {fmtDate(t.end)} · {t.category?.replace('HSBC BWF World Tour ', '')}{t.matches ? '' : ' · not read yet'}</p>
            </div>
            <span className="text-brand-600 font-bold text-xs">›</span>
          </div>
          {Object.keys(t.champions).length > 0 && (
            <div className="mt-2 grid grid-cols-1 gap-0.5">
              {Object.entries(t.champions).map(([e, ps]) => (
                <p key={e} className="text-[11px] text-gray-600 truncate"><span className="inline-block w-7 font-black text-gray-400">{e}</span>🏆 {ps.map((p) => p.name).join(' / ')}</p>
              ))}
            </div>
          )}
        </button>
      ))}
    </div>
  )
}

// ── Players ─────────────────────────────────────────────────────────────────

function Tile({ label, value, sub }) {
  return (
    <div className="flex-1 min-w-[90px] rounded-md bg-white border border-amber-100 px-3 py-2">
      <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{label}</p>
      <p className="text-base font-black text-gray-900">{value}</p>
      {sub != null && <p className="text-[10px] text-gray-500">{sub}</p>}
    </div>
  )
}

function H2H({ a, b, onPlayer, onClose }) {
  const [d, setD] = useState(null)
  useEffect(() => { badmintonH2H(a, b).then((r) => setD(r.data)).catch(() => setD({ matches: [], wins: [0, 0] })) }, [a, b])
  if (!d) return <p className="text-xs text-gray-400 py-2">Loading…</p>
  return (
    <div className="mt-2 rounded-md border border-amber-200 bg-white p-3">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-xs font-black text-gray-800">Head-to-head {d.wins[0]}–{d.wins[1]}</p>
        <button onClick={onClose} className="text-[11px] font-bold text-gray-400">Close</button>
      </div>
      {d.matches.map((m) => <Match key={m.id} m={m} onPlayer={onPlayer} showWhen showEvent />)}
    </div>
  )
}

function PlayerView({ id, onPlayer, onBack }) {
  const [d, setD] = useState(null)
  const [vs, setVs] = useState(null)
  useEffect(() => { setD(null); setVs(null); badmintonPlayer(id).then((r) => setD(r.data)).catch(() => setD({ error: true })) }, [id])
  if (!d) return <p className="text-xs text-gray-400 text-center py-6">Loading…</p>
  if (d.error) return <p className="text-sm text-red-600 text-center py-6">Couldn't load this player.</p>
  const [w, l] = d.record
  return (
    <div className="space-y-3">
      <button onClick={onBack} className="text-xs font-bold text-gray-400">← Search</button>
      <div className="card flex items-center gap-3">
        {d.player.avatar && <img src={d.player.avatar} alt="" className="w-14 h-14 rounded-full object-cover bg-amber-50" onError={(e) => { e.currentTarget.style.display = 'none' }} />}
        <div>
          <p className="text-lg font-black text-gray-900 leading-tight">{d.player.name}</p>
          <p className="text-[11px] text-gray-500">{d.player.country} · BWF matches since 2018</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Tile label="Matches" value={`${w}–${l}`} sub={pct(w, l) != null ? `${pct(w, l)}% won` : null} />
        <Tile label="Games" value={`${d.games[0]}–${d.games[1]}`} sub={pct(...d.games) != null ? `${pct(...d.games)}% won` : null} />
        <Tile label="Deciders" value={`${d.deciders[0]}–${d.deciders[1] - d.deciders[0]}`} sub="3-game matches" />
        <Tile label="Titles" value={d.titles.length} sub={`${d.finals_lost} final${d.finals_lost === 1 ? '' : 's'} lost`} />
      </div>
      <div className="card">
        <p className="text-xs font-black text-gray-800 mb-1">By event</p>
        {d.events.map((e) => (
          <div key={e.event} className="flex text-[12px] py-0.5"><span className="flex-1 text-gray-600">{EVENT[e.event]}</span><span className="font-bold tabular-nums">{e.w}–{e.l}</span><span className="w-12 text-right text-gray-400">{pct(e.w, e.l)}%</span></div>
        ))}
        <p className="text-xs font-black text-gray-800 mt-3 mb-1">By year</p>
        {d.years.map((y) => (
          <div key={y.year} className="flex text-[12px] py-0.5"><span className="flex-1 text-gray-600">{y.year}</span><span className="font-bold tabular-nums">{y.w}–{y.l}</span><span className="w-12 text-right text-gray-400">{pct(y.w, y.l)}%</span></div>
        ))}
      </div>
      {d.titles.length > 0 && (
        <div className="card">
          <p className="text-xs font-black text-gray-800 mb-1">Titles</p>
          {d.titles.map((t, i) => <p key={i} className="text-[12px] text-gray-600 py-0.5">🏆 {t.tournament} <span className="text-gray-400">· {t.event}</span></p>)}
        </div>
      )}
      <div className="card">
        <p className="text-xs font-black text-gray-800 mb-1">Most played opponents <span className="font-medium text-gray-400">- tap for head-to-head</span></p>
        {d.opponents.map((o, i) => (
          <div key={i}>
            <button onClick={() => setVs(vs === i ? null : i)} className="w-full flex items-center text-[12px] py-1 hover:bg-amber-50/50 rounded">
              <span className="flex-1 text-left text-gray-700 truncate">{o.players.map((p) => p.name).join(' / ')} <span className="text-gray-400">{o.players[0]?.country}</span></span>
              <span className={`font-bold tabular-nums ${o.w >= o.l ? 'text-green-700' : 'text-red-600'}`}>{o.w}–{o.l}</span>
            </button>
            {vs === i && o.players.length === 1 && <H2H a={id} b={o.players[0].id} onPlayer={onPlayer} onClose={() => setVs(null)} />}
          </div>
        ))}
        {d.partners.length > 0 && <p className="text-xs font-black text-gray-800 mt-3 mb-1">Partners</p>}
        {d.partners.map((p, i) => (
          <button key={i} onClick={() => p.player && onPlayer(p.player.id)} className="w-full flex text-[12px] py-0.5">
            <span className="flex-1 text-left text-gray-700">{p.player?.name}</span><span className="font-bold tabular-nums">{p.w}–{p.l}</span>
          </button>
        ))}
      </div>
      <div className="card py-2">
        <p className="text-xs font-black text-gray-800 mb-1">Recent matches</p>
        {d.recent.map((m) => <Match key={m.id} m={m} onPlayer={onPlayer} showWhen showEvent />)}
      </div>
    </div>
  )
}

/** BWF's men's / women's singles top 20, a tap away from the top 50. */
function BwfRankings({ event, onPlayer }) {
  const [rk, setRk] = useState(null)
  useEffect(() => { badmintonRankings(event).then((r) => setRk(r.data)).catch(() => setRk({ rows: [] })) }, [event])
  const rows = (rk?.rows || []).map((r) => ({
    rank: r.rank, change: r.change, points: r.points, country: r.players[0]?.country,
    names: r.players.map((p) => ({ name: p.name, onClick: p.id ? () => onPlayer(p.id) : null })),
  }))
  return <RankingList title={`${EVENT[event]} rankings`} sub={rk?.week || ''} rows={rows} first={20} max={50} loading={!rk} />
}

function Players({ sel, onPlayer }) {
  const [q, setQ] = useState('')
  const [list, setList] = useState([])
  useEffect(() => {
    if (q.trim().length < 2) { setList([]); return undefined }
    const t = setTimeout(() => badmintonPlayers(q.trim()).then((r) => setList(r.data)).catch(() => setList([])), 300)
    return () => clearTimeout(t)
  }, [q])
  if (sel) return <PlayerView id={sel} onPlayer={onPlayer} onBack={() => onPlayer(null)} />
  return (
    <div className="space-y-2">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a player - Sindhu, Axelsen, An Se Young…"
        className="w-full rounded-md border border-amber-300 bg-white px-3 py-2 text-sm" />
      {list.map((p) => (
        <button key={p.id} onClick={() => onPlayer(p.id)} className="card w-full flex items-center gap-3 text-left py-2 hover:bg-amber-50/50">
          {p.avatar ? <img src={p.avatar} alt="" className="w-9 h-9 rounded-full object-cover bg-amber-50" onError={(e) => { e.currentTarget.style.display = 'none' }} /> : <span className="w-9 h-9 rounded-full bg-amber-50" />}
          <span className="flex-1 min-w-0"><span className="block text-sm font-bold text-gray-900 truncate">{p.name}</span><span className="text-[10px] text-gray-400">{p.country} · {p.matches} matches</span></span>
          <span className="text-brand-600 font-bold text-xs">›</span>
        </button>
      ))}
      {q.trim().length >= 2 && list.length === 0 && <p className="text-xs text-gray-400 text-center py-6">No player by that name on file.</p>}
      {q.trim().length < 2 && ['MS', 'WS'].map((e) => <BwfRankings key={e} event={e} onPlayer={onPlayer} />)}
    </div>
  )
}

// ── Stats ───────────────────────────────────────────────────────────────────

function Stats({ onPlayer }) {
  const [ev, setEv] = useState('MS')
  const [since, setSince] = useState(new Date().getFullYear() - 1)
  const [d, setD] = useState(null)
  useEffect(() => { setD(null); badmintonStats(ev, since).then((r) => setD(r.data)).catch(() => setD({ error: true })) }, [ev, since])
  const years = []
  for (let y = new Date().getFullYear(); y >= 2018; y -= 1) years.push(y)
  return (
    <div className="space-y-3">
      <Seg value={ev} onChange={setEv} options={EVENTS.map(([k]) => [k, k])} />
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-bold text-gray-500">Since</span>
        <select value={since} onChange={(e) => setSince(+e.target.value)} className="rounded-md border border-amber-300 bg-white px-2 py-1 text-sm font-bold">
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <span className="flex-1 text-right text-[11px] text-gray-400">{EVENT[ev]}{d?.matches ? ` · ${d.matches.toLocaleString('en-IN')} matches` : ''}</span>
      </div>
      {!d && <p className="text-xs text-gray-400 text-center py-6">Loading…</p>}
      {d && !d.error && d.matches === 0 && <p className="text-sm text-gray-400 text-center py-6">No matches on file for this yet - BWF's archive is still being read in.</p>}
      {d && !d.error && d.matches > 0 && (
        <>
          <div className="flex flex-wrap gap-2">
            <Tile label="Go to 3 games" value={`${d.three_games}%`} />
            <Tile label="Game 1 winner wins" value={`${d.first_game_winner_wins}%`} />
            <Tile label="Games to 20-all" value={`${d.deuce_games}%`} />
            <Tile label="Avg length" value={d.avg_minutes ? `${d.avg_minutes} min` : '–'} />
            <Tile label="Seed beats unseeded" value={d.seeded_beat_unseeded != null ? `${d.seeded_beat_unseeded}%` : '–'} />
            <Tile label="Retired / W/O" value={d.retired_or_walkover} />
          </div>
          <div className="card">
            <p className="text-xs font-black text-gray-800 mb-1">Most titles</p>
            {d.top.map((t, i) => (
              <div key={i} className="flex items-center text-[12px] py-0.5">
                <span className="w-5 text-gray-400">{i + 1}</span>
                <span className="flex-1 min-w-0 truncate">
                  {t.players.map((p, k) => <span key={p.id}>{k > 0 && ' / '}<button onClick={() => onPlayer(p.id)} className="font-semibold text-gray-800 hover:text-brand-600">{p.name}</button></span>)}
                  <span className="ml-1 text-gray-400">{t.players[0]?.country}</span>
                </span>
                <span className="w-10 text-right font-black">{t.titles}🏆</span>
                <span className="w-16 text-right tabular-nums text-gray-500">{t.w}–{t.l}</span>
              </div>
            ))}
          </div>
          {d.countries.length > 0 && (
            <div className="card">
              <p className="text-xs font-black text-gray-800 mb-1">Titles by country</p>
              <div className="flex flex-wrap gap-1.5">
                {d.countries.map((c) => <span key={c.country} className="px-2 py-0.5 rounded bg-amber-50 border border-amber-100 text-[11px] font-bold">{c.country} {c.titles}</span>)}
              </div>
            </div>
          )}
          <div className="card py-2">
            <p className="text-xs font-black text-gray-800 mb-1">Longest matches</p>
            {d.longest.map((m) => <Match key={m.id} m={m} onPlayer={onPlayer} showWhen />)}
          </div>
        </>
      )}
      <BwfRankings event={ev} onPlayer={onPlayer} />
    </div>
  )
}

/** The badminton tab shown (`tab`), with `player` the one open on Players. */
export default function Badminton({ tab, active, player, setPlayer, sum }) {
  const onPlayer = (id) => setPlayer(id)
  return (
    <>
      {tab === 'live' && <Live active={active} onPlayer={onPlayer} />}
      {tab === 'results' && <Results onPlayer={onPlayer} sum={sum} />}
      {tab === 'players' && <Players sel={player} onPlayer={onPlayer} />}
      {tab === 'stats' && <Stats onPlayer={onPlayer} />}
    </>
  )
}
