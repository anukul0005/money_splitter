import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { tennisDay, tennisH2H, tennisPlayer, tennisPlayers, tennisSummary } from '../api'
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
            {[['results', 'Results'], ['players', 'Players']].map(([k, l]) => (
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
        {tab === 'results'
          ? <Results tour={tour} onPlayer={openPlayer} onH2H={setH2H} />
          : <Players tour={tour} sel={sel} setSel={setSel} onH2H={setH2H} />}
      </div>
      {h2h && <H2HSheet m={h2h} onClose={() => setH2H(null)} onPlayer={openPlayer} />}
    </div>
  )
}
