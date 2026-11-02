import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { badmintonGame, badmintonLive } from '../api'
import { CardHead, Detail, EVENT, Match, ROUND, Side, Tile, fmtDate } from './Badminton'

/**
 * /betting/badminton-match - one badminton match on a page of its own, as
 * tennis has: the score (refreshed while it's live), its point flow and
 * numbers, the two sides' head-to-head and their last ten going in
 * (routers/badminton.py game).
 */
const short = (side) => side.players.map((p) => p.name.split(' ').slice(-1)[0]).join('/')

function Form({ f, side }) {
  return (
    <div className="card py-2">
      <div className="flex items-center gap-2 mb-1">
        <p className="flex-1 text-xs font-black text-gray-800 truncate">{short(side)} - last {f.results.length}</p>
        <span className="text-xs font-bold tabular-nums">{f.w}–{f.l}</span>
      </div>
      <div className="flex gap-0.5 mb-1">
        {f.results.map((r, i) => (
          <span key={i} className={`w-5 h-5 rounded-sm text-[10px] font-black flex items-center justify-center ${r === 'W' ? 'bg-green-100 text-green-700' : 'bg-red-50 text-red-600'}`}>{r}</span>
        ))}
      </div>
      {f.matches.map((m) => <Match key={m.id} m={m} showWhen showEvent />)}
      {f.matches.length === 0 && <p className="text-xs text-gray-400 py-1">Nothing on file before this.</p>}
    </div>
  )
}

export default function BadmintonMatch() {
  const nav = useNavigate()
  const [q] = useSearchParams()
  const t = q.get('t'), code = q.get('code')
  const [d, setD] = useState(null)
  const [live, setLive] = useState(null)
  useEffect(() => {
    setD(null); setLive(null)
    badmintonGame(t, code).then((r) => setD(r.data)).catch(() => setD({ error: true }))
  }, [t, code])
  // While it's on (or about to be), the score comes from the live feed every 30 seconds
  const on = d?.match && d.match.state !== 'finished'
  useEffect(() => {
    if (!on) return undefined
    let alive = true
    const load = () => badmintonLive().then((r) => {
      const m = r.data.tournaments.flatMap((x) => x.matches).find((x) => String(x.tournament_id) === t && x.code === code)
      if (alive && m) setLive(m)
    }).catch(() => {})
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 30000)
    return () => { alive = false; clearInterval(id) }
  }, [on, t, code])

  const onPlayer = (pid) => nav(`/betting?sport=badminton&btab=players&bp=${pid}`)
  if (!d) return <p className="text-xs text-gray-400 text-center py-16">Loading…</p>
  if (d.error) {
    return (
      <div className="px-5 pt-10">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <p className="text-sm text-red-600 text-center py-10">Couldn't find this match.</p>
      </div>
    )
  }
  const m = live ? { ...d.match, ...live, tournament: d.match.tournament } : d.match
  const tm = d.tournament
  const singles = m.side1.players.length === 1
  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-3 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-field-950 text-white tracking-wider">{m.event}</span>
          <h1 className="text-lg font-black tracking-tight flex-1 min-w-0 truncate">{tm?.name || m.tournament || 'Match'}</h1>
        </div>
        <p className="text-[11px] text-gray-400 mt-0.5">
          {EVENT[m.event] || m.event} · {ROUND[m.round] || m.round || ''}{m.day ? ` · ${fmtDate(m.day)}` : ''}
        </p>
      </div>

      <div className="px-5 pt-4 space-y-3">
        <div className="card p-0 overflow-hidden">
          <CardHead title={m.state === 'live' ? 'Live' : m.state === 'upcoming' ? 'Coming up' : 'Result'}
            sub={tm?.category?.replace('HSBC BWF World Tour ', '')} logo={tm?.logo} />
          <div className="px-4 py-3 space-y-1" onClick={(e) => e.stopPropagation()}>
            <Side side={m.side1} no={1} m={m} onPlayer={onPlayer} />
            <Side side={m.side2} no={2} m={m} onPlayer={onPlayer} />
            {m.state !== 'upcoming' && <Detail m={m} />}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Tile label="Head-to-head" value={`${d.h2h.wins[0]}–${d.h2h.wins[1]}`} sub={`${short(m.side1)} first`} />
          {d.form.map((f, i) => (
            <Tile key={i} label={`${short(i ? m.side2 : m.side1)} last ${f.results.length}`} value={`${f.w}–${f.l}`}
              sub={f.w + f.l ? `${Math.round((100 * f.w) / (f.w + f.l))}% won` : null} />
          ))}
        </div>

        <div className="card py-2">
          <p className="text-xs font-black text-gray-800 mb-1">Head-to-head{singles ? '' : ' (as these pairs)'}</p>
          {d.h2h.matches.map((x) => <Match key={x.id} m={x} onPlayer={onPlayer} showWhen showEvent />)}
          {d.h2h.matches.length === 0 && <p className="text-xs text-gray-400 py-1">They haven't met in BWF matches since 2018.</p>}
        </div>

        {d.form.map((f, i) => <Form key={i} f={f} side={i ? m.side2 : m.side1} />)}
      </div>
    </div>
  )
}
