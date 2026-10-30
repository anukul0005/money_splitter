import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { tennisLive, tennisMatchup } from '../api'
import { LiveRow, MatchRow, ROUND_NAME, SURFACE, Safe, ScoreText, fmtShort, matchLink, startTime } from './BettingAnalytics'

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
              {!m && live && !live.gone && <LiveRow m={live} onOpen={() => {}} plain />}
              {!m && (!live || live.gone) && (
                <div className="py-2 text-sm font-bold text-gray-900">
                  {nameA} <span className="text-gray-400 font-medium">vs</span> {nameB}
                  {live?.gone && <p className="text-[10px] font-normal text-gray-400 mt-1">Finished or no longer listed - its result shows in Results once it's in.</p>}
                </div>
              )}
            </div>

            {/* head to head */}
            {d.h2h && (
              <div className="card">
                <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Head to head</p>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-sm font-bold flex-1 min-w-0 truncate">{nameA}</span>
                  <span className="text-2xl font-black text-brand-600 px-3 tabular-nums">{d.h2h.a_wins} – {d.h2h.b_wins}</span>
                  <span className="text-sm font-bold flex-1 min-w-0 truncate text-right">{nameB}</span>
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
