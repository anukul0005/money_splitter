import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import RankingList, { RankingSwitch } from '../components/RankingList'
import { CardHead, Tile, fmtDate } from './Badminton'
import { hockeyEvent, hockeyEvents, hockeyH2H, hockeyLive, hockeyRankings, hockeyStats } from '../api'

/**
 * Field hockey in the sports section (Betting analytics' 🏑 switch): FIH live
 * scores, tournaments and results, standings, stats and world rankings
 * (backend routers/hockey.py, read from fih.hockey). A match opens in place
 * with the two teams' head-to-head.
 */
export const H_TABS = [['live', 'Live'], ['results', 'Results'], ['rankings', 'Rankings'], ['stats', 'Stats']]
const GENDER = { M: "Men's", F: "Women's" }

const fmtTime = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date().toDateString() === d.toDateString()
  return d.toLocaleString('en-IN', today ? { hour: 'numeric', minute: '2-digit', hour12: true }
    : { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })
}
const fmtDay = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN',
  { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '')

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

function Team({ t, no, m }) {
  const won = m.winner === no
  const lost = m.winner && !won
  const live = m.state === 'live'
  return (
    <div className={`flex items-center gap-1.5 ${lost ? 'text-gray-400' : 'text-gray-900'}`}>
      <span className="inline-block w-8 text-[9px] font-bold text-gray-400 tracking-wider">{t.code || ''}</span>
      <span className={`flex-1 min-w-0 truncate text-[13px] ${won || live || !m.winner ? 'font-bold' : 'font-medium'}`}>{t.name}</span>
      <span className="w-3.5 text-center text-[10px] text-green-600 font-black">{won ? '✓' : ''}</span>
      {t.so != null && <span className="text-[10px] text-gray-400 tabular-nums">({t.so})</span>}
      <span className={`w-6 text-center text-[14px] tabular-nums ${live ? 'text-red-600 font-black' : won ? 'font-black' : 'font-medium'}`}>
        {t.goals ?? ''}
      </span>
    </div>
  )
}

/** The two teams' record against each other and their last meetings. */
function H2H({ m }) {
  const [d, setD] = useState(null)
  useEffect(() => { hockeyH2H(m.id).then((r) => setD(r.data)).catch(() => setD({ teams: [], matches: [] })) }, [m.id])
  if (!d) return <p className="text-[11px] text-gray-400 py-2">Loading…</p>
  if (!d.teams.length && !d.matches.length) return <p className="text-[11px] text-gray-400 py-2">FIH has no head-to-head for these two.</p>
  const [a, b] = d.teams
  return (
    <div className="mt-2 mb-1 rounded-md bg-amber-50/60 border border-amber-100 p-3 space-y-2" onClick={(e) => e.stopPropagation()}>
      {a && b && (
        <>
          <p className="text-xs font-black text-gray-800">Head-to-head · {a.played} matches</p>
          <div className="flex text-[12px] font-bold tabular-nums">
            <span className="flex-1">{a.code} {a.won}</span>
            <span className="text-gray-400">{a.drawn} drawn</span>
            <span className="flex-1 text-right">{b.won} {b.code}</span>
          </div>
          <div className="flex h-1.5 rounded overflow-hidden bg-gray-200">
            <div className="bg-brand-400" style={{ width: `${(100 * a.won) / Math.max(1, a.played)}%` }} />
            <div className="bg-gray-300" style={{ width: `${(100 * a.drawn) / Math.max(1, a.played)}%` }} />
            <div className="bg-field-700" style={{ width: `${(100 * b.won) / Math.max(1, a.played)}%` }} />
          </div>
        </>
      )}
      {d.matches.length > 0 && <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest pt-1">Last meetings</p>}
      {d.matches.map((x) => (
        <div key={x.id} className="flex items-center gap-2 text-[11px]">
          <span className="w-16 text-gray-400">{fmtDate(x.day)}</span>
          <span className="flex-1 min-w-0 truncate">
            <b className={x.winner === 1 ? 'text-gray-900' : 'text-gray-500'}>{x.home.code}</b>
            <span className="tabular-nums font-bold mx-1">{x.home.goals}–{x.away.goals}</span>
            <b className={x.winner === 2 ? 'text-gray-900' : 'text-gray-500'}>{x.away.code}</b>
            <span className="text-gray-400"> · {x.series}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

/** A match: tap to see the head-to-head. */
function Match({ m, showWhen }) {
  const [open, setOpen] = useState(false)
  const live = m.state === 'live'
  const known = m.home.id && m.away.id
  return (
    <div onClick={() => known && setOpen((o) => !o)}
      className="py-2 border-t border-gray-100 first:border-t-0 cursor-pointer hover:bg-amber-50/50 -mx-2 px-2 rounded">
      <div className="flex items-center gap-2 mb-0.5 text-[10px]">
        {live && <span className="font-black text-red-600 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-600 animate-pulse" />LIVE</span>}
        {m.state === 'upcoming' && <span className="font-bold text-gray-500">{fmtTime(m.start)}</span>}
        {m.state === 'finished' && showWhen && <span className="font-bold text-gray-500">{fmtDate(m.day)}</span>}
        {m.gender && <span className="font-bold text-gray-500">{m.gender === 'F' ? 'W' : 'M'}</span>}
        {m.round && <span className="text-gray-400">{m.round}{m.pool && m.pool !== 'RR' ? ` · Pool ${m.pool}` : ''}</span>}
        {live && m.status && <span className="text-red-500">{m.status}</span>}
        <span className="ml-auto flex items-center gap-2 text-gray-400">
          {m.home.so != null && <span className="font-bold text-amber-600">Shoot-out</span>}
          {known && <span className="font-bold text-brand-600">{open ? '▴' : '▾'}</span>}
        </span>
      </div>
      <Team t={m.home} no={1} m={m} />
      <Team t={m.away} no={2} m={m} />
      {open && <H2H m={m} />}
    </div>
  )
}

function EventLine({ e, onOpen, right }) {
  return (
    <button onClick={() => onOpen(e.id)} className="w-full text-left px-4 py-2 border-t border-gray-100 first:border-t-0 flex items-center gap-2 hover:bg-amber-50/50">
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-bold text-gray-900 truncate">{e.name}</p>
        <p className="text-[10px] text-gray-400 truncate">
          {fmtDate(e.start)} – {fmtDate(e.end)}{e.discipline ? ` · ${e.discipline}` : ''}{e.teams?.length ? ` · ${e.teams.length} teams` : ''}
        </p>
      </div>
      {right}
      <span className="text-brand-600 font-bold text-xs">›</span>
    </button>
  )
}

// ── Live ────────────────────────────────────────────────────────────────────

function ComingUp({ list, onOpen }) {
  if (!list?.length) return null
  const today = new Date(new Date().toDateString())
  const inDays = (iso) => Math.round((new Date(`${iso}T00:00:00`) - today) / 86400000)
  return (
    <div className="card p-0 overflow-hidden">
      <CardHead title="Coming up" sub={`${list.length}`} />
      {list.map((e) => {
        const n = inDays(e.start)
        return <EventLine key={e.id} e={e} onOpen={onOpen}
          right={<span className="text-[10px] font-bold text-brand-600 whitespace-nowrap">{n <= 1 ? (n === 1 ? 'tomorrow' : 'today') : `in ${n} days`}</span>} />
      })}
    </div>
  )
}

function Live({ active, onOpen }) {
  const [d, setD] = useState(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    if (!active) return undefined
    let alive = true
    const load = () => hockeyLive().then((r) => { if (alive) { setD(r.data); setErr(false) } }).catch(() => { if (alive) setErr(true) })
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, 30000)
    return () => { alive = false; clearInterval(t) }
  }, [active])
  if (!d && !err) return <p className="text-xs text-gray-400 text-center py-6">Loading live matches…</p>
  if (!d) return <p className="text-sm text-red-600 text-center py-6">Couldn't reach FIH's live scores - try again in a minute.</p>
  return (
    <div className="space-y-4">
      {!d.tournaments.length && <p className="text-sm text-gray-400 text-center py-8">No FIH tournament on right now - see Results for the latest.</p>}
      {d.tournaments.map((t) => (
        <div key={t.id} className="card p-0 overflow-hidden">
          <button onClick={() => onOpen(t.id)} className="w-full text-left"><CardHead title={`${t.name} ›`} sub={GENDER[t.gender]} /></button>
          <p className="px-4 pt-2 text-[10px] text-gray-400">{fmtDate(t.start)} – {fmtDate(t.end)}{t.venue ? ` · ${t.venue}` : ''}</p>
          {[['live', 'Live now'], ['upcoming', 'Coming up'], ['finished', 'Finished']].map(([k, label]) => {
            const ms = t.matches.filter((m) => m.state === k)
            if (!ms.length && k !== 'live') return null
            return (
              <div key={k} className="px-4 pb-2 mt-2">
                <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">{label} · {ms.length}</p>
                {ms.length === 0 && <p className="text-xs text-gray-400 py-1">Nothing on the pitch right now.</p>}
                {(k === 'finished' ? [...ms].reverse() : ms).map((m) => <Match key={m.id} m={m} />)}
              </div>
            )
          })}
        </div>
      ))}
      <ComingUp list={d.upcoming} onOpen={onOpen} />
      <p className="text-[10px] text-gray-400 text-center">
        From fih.hockey · updates every 30 seconds · {new Date(d.updated).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}
      </p>
    </div>
  )
}

// ── A tournament ────────────────────────────────────────────────────────────

function Table({ groups }) {
  if (!groups?.length) return <p className="text-sm text-gray-400 text-center py-8">No table for this tournament.</p>
  return (
    <div className="space-y-3">
      {groups.map((g, i) => (
        <div key={i} className="card py-2 overflow-x-auto">
          {g.name && <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1">{g.name}</p>}
          <table className="w-full text-[12px] tabular-nums">
            <thead>
              <tr className="text-[10px] text-gray-400">
                <th className="text-left font-bold py-1 w-6">#</th><th className="text-left font-bold">Team</th>
                <th className="font-bold w-7">P</th><th className="font-bold w-7">W</th><th className="font-bold w-7">D</th>
                <th className="font-bold w-7">L</th><th className="font-bold w-9">GD</th><th className="font-bold w-8">Pts</th>
              </tr>
            </thead>
            <tbody>
              {g.teams.map((t) => (
                <tr key={t.id} className="border-t border-gray-100">
                  <td className="py-1 font-black text-gray-800">{t.pos}</td>
                  <td className="py-1 font-semibold text-gray-800 truncate max-w-[9rem]">
                    {t.name}
                    {t.form && <span className="ml-1.5 text-[9px] tracking-wider">
                      {t.form.split('').map((c, k) => <span key={k} className={c === 'W' ? 'text-green-600' : c === 'L' ? 'text-red-500' : 'text-gray-400'}>{c}</span>)}
                    </span>}
                  </td>
                  <td className="text-center">{t.p}</td><td className="text-center">{t.w}</td>
                  <td className="text-center">{t.d}{t.so_w || t.so_l ? <span className="text-[9px] text-gray-400"> ({t.so_w}-{t.so_l})</span> : ''}</td>
                  <td className="text-center">{t.l}</td>
                  <td className="text-center">{t.gd > 0 ? `+${t.gd}` : t.gd}</td>
                  <td className="text-center font-black">{t.pts}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {g.teams.some((t) => t.so_w || t.so_l) && <p className="text-[10px] text-gray-400 mt-1">D (a-b): drawn matches, shoot-outs won–lost.</p>}
        </div>
      ))}
    </div>
  )
}

function EventStats({ id }) {
  const [d, setD] = useState(null)
  useEffect(() => { setD(null); hockeyStats(id).then((r) => setD(r.data)).catch(() => setD({ teams: [], players: {} })) }, [id])
  if (!d) return <p className="text-xs text-gray-400 text-center py-6">Loading…</p>
  if (!d.teams.length && !Object.keys(d.players).length) return <p className="text-sm text-gray-400 text-center py-8">FIH has no stats for this tournament yet.</p>
  const goals = d.teams.reduce((s, t) => s + (t.goals || 0), 0)
  const pcs = d.teams.reduce((s, t) => s + (t.pc_goals || 0), 0)
  const fgs = d.teams.reduce((s, t) => s + (t.field_goals || 0), 0)
  const cards = d.teams.reduce((s, t) => s + (t.green || 0) + (t.yellow || 0) + (t.red || 0), 0)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Tile label="Goals" value={goals} />
        <Tile label="Field goals" value={fgs} sub={goals ? `${Math.round((100 * fgs) / goals)}%` : null} />
        <Tile label="From corners" value={pcs} sub={goals ? `${Math.round((100 * pcs) / goals)}%` : null} />
        <Tile label="Cards" value={cards} />
      </div>
      {(d.players.goals || []).length > 0 && (
        <div className="card">
          <p className="text-xs font-black text-gray-800 mb-1">Top scorers</p>
          {d.players.goals.map((p, i) => (
            <div key={p.id || i} className="flex items-center text-[12px] py-0.5">
              <span className="w-5 text-gray-400">{i + 1}</span>
              <span className="flex-1 min-w-0 truncate font-semibold text-gray-800">{p.name} <span className="font-medium text-gray-400">{p.team}</span></span>
              <span className="w-14 text-right text-[10px] text-gray-400">{p.played} played</span>
              <span className="w-8 text-right font-black tabular-nums">{p.value}</span>
            </div>
          ))}
        </div>
      )}
      <div className="card py-2 overflow-x-auto">
        <p className="text-xs font-black text-gray-800 mb-1">Teams</p>
        <table className="w-full text-[12px] tabular-nums">
          <thead>
            <tr className="text-[10px] text-gray-400">
              <th className="text-left font-bold py-1">Team</th><th className="font-bold w-9" title="Goals">G</th>
              <th className="font-bold w-9" title="Field goals">FG</th><th className="font-bold w-9" title="Penalty corner goals">PC</th>
              <th className="font-bold w-9" title="Penalty stroke goals">PS</th><th className="font-bold w-14" title="Green / yellow / red cards">Cards</th>
            </tr>
          </thead>
          <tbody>
            {d.teams.map((t) => (
              <tr key={t.id} className="border-t border-gray-100">
                <td className="py-1 font-semibold text-gray-800">{t.name}</td>
                <td className="text-center font-black">{t.goals ?? 0}</td><td className="text-center">{t.field_goals ?? 0}</td>
                <td className="text-center">{t.pc_goals ?? 0}</td><td className="text-center">{t.ps_goals ?? 0}</td>
                <td className="text-center text-[11px]">
                  <span className="text-green-600">{t.green ?? 0}</span>·<span className="text-amber-500">{t.yellow ?? 0}</span>·<span className="text-red-600">{t.red ?? 0}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[10px] text-gray-400 mt-1">FG field goals · PC from penalty corners · PS penalty strokes · cards green·yellow·red</p>
      </div>
    </div>
  )
}

function EventView({ id, onBack }) {
  const [d, setD] = useState(null)
  const [view, setView] = useState('matches')
  useEffect(() => {
    let alive = true
    setD(null)
    const load = () => hockeyEvent(id).then((r) => alive && setD(r.data)).catch(() => alive && setD((x) => x || { error: true }))
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, 30000)
    return () => { alive = false; clearInterval(t) }
  }, [id])
  if (!d) return <p className="text-xs text-gray-400 text-center py-6">Loading…</p>
  if (d.error) return <p className="text-sm text-red-600 text-center py-6">Couldn't load this tournament.</p>
  const e = d.event
  const days = []
  d.matches.forEach((m) => {
    const last = days[days.length - 1]
    if (last && last.day === m.day) last.matches.push(m)
    else days.push({ day: m.day, matches: [m] })
  })
  const done = d.matches.filter((m) => m.state === 'finished').length
  return (
    <div className="space-y-3">
      <button onClick={onBack} className="text-xs font-bold text-gray-400">← Back</button>
      <div className="card p-0 overflow-hidden">
        <CardHead title={e.name} sub={GENDER[e.gender]} />
        <p className="px-4 py-2 text-[10px] text-gray-400">
          {fmtDate(e.start)} – {fmtDate(e.end)}{e.venue ? ` · ${e.venue}` : ''} · {done} of {d.matches.length} matches played
        </p>
      </div>
      <Seg value={view} onChange={setView} options={[['matches', 'Matches'], ['table', 'Table'], ['stats', 'Stats']]} />
      {view === 'matches' && (
        <>
          {days.length === 0 && <p className="text-sm text-gray-400 text-center py-8">No fixtures out yet.</p>}
          {days.map((g) => (
            <div key={g.day} className="card py-2">
              <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">{fmtDay(g.day)}</p>
              {g.matches.map((m) => <Match key={m.id} m={m} />)}
            </div>
          ))}
        </>
      )}
      {view === 'table' && <Table groups={d.standings} />}
      {view === 'stats' && <EventStats id={id} />}
    </div>
  )
}

// ── Results ─────────────────────────────────────────────────────────────────

function Results({ onOpen }) {
  const [g, setG] = useState('')
  const [pages, setPages] = useState([])
  const [more, setMore] = useState(1)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    setBusy(true)
    hockeyEvents('r', more).then((r) => alive && setPages((p) => [...p.slice(0, more - 1), r.data]))
      .catch(() => {}).finally(() => alive && setBusy(false))
    return () => { alive = false }
  }, [more])
  const list = pages.flatMap((p) => p.events).filter((e) => !g || e.gender === g)
  const last = pages[pages.length - 1]
  return (
    <div className="space-y-3">
      <Seg value={g} onChange={setG} options={[['', 'All'], ['M', 'Men'], ['F', 'Women']]} />
      <div className="card p-0 overflow-hidden">
        <CardHead title="Finished tournaments" />
        {list.map((e) => <EventLine key={e.id} e={e} onOpen={onOpen} />)}
        {!busy && list.length === 0 && <p className="text-sm text-gray-400 text-center py-8">Nothing here.</p>}
      </div>
      {busy && <p className="text-xs text-gray-400 text-center py-3">Loading…</p>}
      {!busy && last && last.page < last.pages && (
        <button onClick={() => setMore((n) => n + 1)} className="w-full text-[12px] font-bold text-brand-600 py-2">Older tournaments ›</button>
      )}
    </div>
  )
}

// ── Rankings ────────────────────────────────────────────────────────────────

function FihRankings({ gender }) {
  const [rk, setRk] = useState(null)
  useEffect(() => { hockeyRankings(gender).then((r) => setRk(r.data)).catch(() => setRk({ rows: [] })) }, [gender])
  const rows = (rk?.rows || []).map((r) => ({ rank: r.rank, change: 0, points: Math.round(r.points), country: r.cf, names: [{ name: r.name }] }))
  const when = rk?.updated ? new Date(rk.updated).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
  return <RankingList title={`FIH ${gender === 'f' ? "women's" : "men's"} world rankings`} sub={when ? `updated ${when}` : ''}
    rows={rows} first={20} max={100} loading={!rk} />
}

function Rankings() {
  const [g, setG] = useState('m')
  return (
    <RankingSwitch value={g} onChange={setG} options={[['m', 'Men'], ['f', 'Women']]}>
      <FihRankings key={g} gender={g} />
    </RankingSwitch>
  )
}

// ── Stats ───────────────────────────────────────────────────────────────────

function Stats() {
  const [list, setList] = useState(null)
  const [id, setId] = useState(null)
  useEffect(() => {
    Promise.all([hockeyEvents('l,u', 1).catch(() => null), hockeyEvents('r', 1).catch(() => null)]).then(([on, done]) => {
      const today = new Date().toISOString().slice(0, 10)
      const started = (on?.data.events || []).filter((e) => e.start <= today)
      const all = [...started, ...(done?.data.events || [])]
      setList(all)
      setId((x) => x || all[0]?.id || null)
    })
  }, [])
  if (!list) return <p className="text-xs text-gray-400 text-center py-6">Loading…</p>
  return (
    <div className="space-y-3">
      <select value={id || ''} onChange={(e) => setId(+e.target.value)}
        className="w-full rounded-md border border-amber-300 bg-white px-2 py-1.5 text-sm font-bold">
        {list.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select>
      {id && <EventStats id={id} />}
    </div>
  )
}

/** The hockey tab shown (`tab`); an open tournament lives in the address (he=). */
export default function Hockey({ tab, active }) {
  const [params, setParams] = useSearchParams()
  const open = params.get('he') ? +params.get('he') : null
  const setOpen = (id) => setParams((p) => { const q = new URLSearchParams(p); id ? q.set('he', id) : q.delete('he'); return q }, { replace: true })
  if (open && (tab === 'live' || tab === 'results')) return <EventView id={open} onBack={() => setOpen(null)} />
  return (
    <>
      {tab === 'live' && <Live active={active} onOpen={setOpen} />}
      {tab === 'results' && <Results onOpen={setOpen} />}
      {tab === 'rankings' && <Rankings />}
      {tab === 'stats' && <Stats />}
    </>
  )
}
