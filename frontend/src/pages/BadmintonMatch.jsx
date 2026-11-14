import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { badmintonGame, badmintonLive, badmintonModel } from '../api'
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

        {m.model && <OurOdds m={m} />}

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

/** Our own odds for the match (backend badminton_model): each side's chance
 *  and fair price, and whether it goes to 3 games - from before the match
 *  once it's played - with how the model has done on past matches. */
function OurOdds({ m }) {
  const [rec, setRec] = useState(null)
  useEffect(() => { badmintonModel().then((r) => setRec(r.data)).catch(() => {}) }, [])
  const o = m.model
  const name = (s) => s.players.map((p) => p.name.split(' ').slice(-1)[0]).join(' / ')
  const pct = (p) => `${Math.round(100 * p)}%`
  const done = m.state === 'finished'
  const right = done && m.winner ? (o.p1 >= 0.5) === (m.winner === 1) : null
  const three = done && m.games?.length ? m.games.length === 3 : null
  return (
    <div className="card">
      <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">{done ? 'Our odds before the match' : 'Our odds'}</p>
      <table className="w-full text-xs mt-1.5">
        <thead>
          <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider">
            <th className="py-1 text-left">Side</th><th className="py-1 text-right">Chance</th><th className="py-1 text-right">Odds</th>
          </tr>
        </thead>
        <tbody>
          {[m.side1, m.side2].map((s, i) => {
            const p = i ? 1 - o.p1 : o.p1
            return (
              <tr key={i} className="border-t border-gray-100">
                <td className="py-1.5 pl-1 font-bold text-gray-900 truncate max-w-[160px]">
                  {name(s)}{m.winner === i + 1 && <span className="ml-1 text-green-600 font-black">✓</span>}
                </td>
                <td className="py-1.5 text-right tabular-nums text-gray-500">{pct(p)}</td>
                <td className={`py-1.5 text-right tabular-nums ${p >= 0.5 ? 'font-black text-gray-900' : 'font-semibold text-gray-600'}`}>{o.odds[i].toFixed(2)}</td>
              </tr>
            )
          })}
          <tr className="border-t border-gray-100">
            <td className="py-1.5 pl-1 text-gray-800 font-semibold">Goes to 3 games{three != null && <span className={`ml-1 font-black ${three ? 'text-green-600' : 'text-gray-400'}`}>{three ? '✓' : '✗'}</span>}</td>
            <td className="py-1.5 text-right tabular-nums text-gray-500">{pct(o.p3)}</td>
            <td className="py-1.5 text-right tabular-nums font-semibold text-gray-700">{o.three.toFixed(2)} <span className="text-gray-400 font-normal">/ 2 games {o.two.toFixed(2)}</span></td>
          </tr>
        </tbody>
      </table>
      {right != null && (
        <p className={`text-[11px] font-bold mt-2 ${right ? 'text-green-700' : 'text-red-600'}`}>
          {right ? '✓ The favourite won' : '✗ The outsider won'}
        </p>
      )}
      <p className="text-[10px] text-gray-400 mt-2">
        Worked out from every BWF result since 2018: each player's rally strength in this event (a pair as the two together), moved by the share of points won in each match.
        Fair prices - no bookmaker margin, so a bookmaker would offer a little less.
        {o.thin && ' Someone here has under 3 matches on file, so take these with a pinch of salt.'}
        {rec?.matches > 0 && ` Since ${fmtDate(rec.since)} it has picked the winner of ${Math.round(100 * rec.right)}% of ${rec.matches.toLocaleString('en-IN')} matches, and what it calls 75% comes in about ${Math.round(100 * (rec.bands.find((b) => b.from === 70)?.came_in || 0.75))}% of the time.`}
      </p>
    </div>
  )
}
