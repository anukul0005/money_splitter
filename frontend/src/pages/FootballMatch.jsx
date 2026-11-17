import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { footballMatch, peek } from '../api'

/**
 * Football › one match (/football/match?c=PL&d=2026-11-08&h=...&a=...): the
 * match centre, for a match played or to come - the score, our odds and the
 * bookmakers', whether it's one of my ₹ bets or a skip by my rules, line-ups
 * with how much each side has rotated, key events, stats, form,
 * head-to-head, the table and the latest news. Backend: routers/football
 * /match + football_match.py (ESPN, our results, our model).
 */
const RES = { W: 'bg-green-600', D: 'bg-gray-400', L: 'bg-red-500' }
const pc = (x) => `${Math.round(100 * x)}%`
const fmtWhen = (iso) => new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
const fmtDay = (d) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
const ago = (iso) => {
  const h = Math.round((Date.now() - new Date(iso)) / 36e5)
  return h < 1 ? 'just now' : h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}
const ICON = { goal: '⚽', 'own-goal': '⚽', 'penalty---scored': '⚽', 'penalty---missed': '✗', 'yellow-card': '🟨', 'red-card': '🟥', substitution: '⇄' }

/** The match centre's link for a match from the Matches tab or My teams. */
export const fMatchLink = ({ comp, start, home, away, homeShort, awayShort, id }) => {
  const q = new URLSearchParams({ c: comp, d: (start || '').slice(0, 10), h: home || '', a: away || '' })
  if (homeShort) q.set('hs', homeShort)
  if (awayShort) q.set('as', awayShort)
  if (String(id || '').startsWith('espn')) q.set('e', String(id))
  return `/football/match?${q.toString()}`
}

function Card({ title, sub, children }) {
  return (
    <div className="card rounded-none">
      <div className="flex items-baseline gap-2 mb-2">
        <p className="text-sm font-black text-gray-900 flex-1">{title}</p>
        {sub && <span className="text-[10px] text-gray-400">{sub}</span>}
      </div>
      {children}
    </div>
  )
}

function Crest({ t, size = 'w-10 h-10' }) {
  return t?.crest ? <img src={t.crest} alt="" className={`${size} object-contain`} /> : <span className={`${size} bg-gray-100 inline-block`} />
}

const Tag = ({ mode }) => (mode ? (
  <span className={`text-[9px] font-black rounded-none px-1 py-0.5 ${mode === 'bet' ? 'bg-green-700 text-white' : 'bg-sky-100 text-sky-800'}`}>{mode === 'bet' ? '₹ BET' : 'TRACK'}</span>
) : null)

function Header({ m }) {
  const live = m.state === 'live'
  const done = m.state === 'finished'
  const hw = done && m.home.goals > m.away.goals
  const aw = done && m.away.goals > m.home.goals
  const side = (t, mode, won, lost) => (
    <div className="flex-1 min-w-0 flex flex-col items-center text-center gap-1">
      <Crest t={t} />
      <span className={`text-[13px] leading-tight ${won ? 'font-black' : 'font-bold'} ${lost ? 'text-gray-400' : 'text-gray-900'}`}>{t.short || t.name}</span>
      <span className="flex items-center gap-1">
        <Tag mode={mode} />
        {t.record && <span className="text-[9px] text-gray-400">{t.record}</span>}
      </span>
    </div>
  )
  return (
    <div className="card rounded-none">
      <p className="text-[10px] font-bold text-gray-500 text-center">{m.comp_name}</p>
      <div className="flex items-start gap-2 mt-2">
        {side(m.home, m.mine.home, hw, aw)}
        <div className="shrink-0 w-24 text-center pt-1">
          {m.state === 'upcoming' ? (
            <>
              <p className="text-lg font-black text-gray-900">{new Date(m.start).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })}</p>
              <p className="text-[10px] text-gray-500">{new Date(m.start).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</p>
            </>
          ) : (
            <>
              <p className={`text-3xl font-black tabular-nums ${live ? 'text-red-600' : 'text-gray-900'}`}>{m.home.goals ?? '–'}<span className="text-gray-300 mx-1">-</span>{m.away.goals ?? '–'}</p>
              <p className={`text-[10px] font-bold ${live ? 'text-red-600' : 'text-gray-500'}`}>
                {live && <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-600 animate-pulse mr-1 align-middle" />}{m.status}
              </p>
              {m.home.half != null && m.state === 'finished' && <p className="text-[9px] text-gray-400">HT {m.home.half}-{m.away.half}</p>}
            </>
          )}
        </div>
        {side(m.away, m.mine.away, aw, hw)}
      </div>
      <p className="text-[10px] text-gray-400 text-center mt-2">
        {fmtWhen(m.start)}{m.venue ? ` · ${m.venue}` : ''}{m.city ? `, ${m.city}` : ''}{m.attendance ? ` · ${m.attendance.toLocaleString('en-IN')} crowd` : ''}
      </p>
    </div>
  )
}

/** Our chances and the prices, and what my rules say about betting on it. */
function OurView({ m }) {
  const skip = useMemo(() => {
    try { const x = JSON.parse(localStorage.getItem('fb.skip.v4') || '{}'); return { on: x.skip1 ?? true, close: [0.3, 0.5, 0.6].includes(x.close) ? x.close : 0.6 } } catch { return { on: true, close: 0.6 } }
  }, [])
  const p = m.model?.probs
  const book = m.book?.avg            // home, draw, away
  const espn = m.espn_odds
  const price = book ? { h: book[0], d: book[1], a: book[2], src: m.book.kind === 'closing' ? 'closing average' : 'market average' }
    : espn ? { h: espn.home, d: espn.draw, a: espn.away, src: espn.book } : null
  const bets = ['home', 'away'].filter((s) => m.mine[s] === 'bet')
  let verdict = null
  if (bets.length) {
    const both = bets.length === 2
    const s = both ? (price && price.a < price.h ? 'away' : 'home') : bets[0]
    const team = m[s].short || m[s].name
    const odds = price ? (s === 'home' ? price.h : price.a) : null
    const gap = price ? Math.abs(price.h - price.a) : null
    const reasons = []
    if (both) reasons.push('both sides are your ₹ teams')
    if (skip.on && gap != null && gap <= skip.close + 1e-9) reasons.push(`close match - the win prices ${price.h.toFixed(2)} v ${price.a.toFixed(2)} are within ${skip.close}`)
    const rot = m.rotation?.[s]
    const rested = rot?.missing?.length >= 3 ? rot.missing.length : 0
    verdict = { team, odds, reasons, rested, src: price?.src, res: m.state === 'finished' ? (m[s].goals > m[s === 'home' ? 'away' : 'home'].goals ? 'won' : 'lost') : null }
  }
  const row = (label, xs, note) => (
    <div className="grid grid-cols-[1fr_repeat(3,3.25rem)] gap-1 items-baseline text-[11px] py-0.5">
      <span className="text-gray-500 truncate">{label}{note && <span className="text-[9px] text-gray-400"> {note}</span>}</span>
      {xs.map((x, i) => <span key={i} className="text-right tabular-nums font-bold text-gray-800">{x ?? '—'}</span>)}
    </div>
  )
  return (
    <Card title="Our view & prices" sub={m.model?.thin ? 'few matches on file' : null}>
      <div className="grid grid-cols-[1fr_repeat(3,3.25rem)] gap-1 text-[9px] font-black text-gray-400 border-b border-gray-100 pb-1">
        <span />
        <span className="text-right">1</span><span className="text-right">X</span><span className="text-right">2</span>
      </div>
      {p && row('Our chance', [pc(p[0]), pc(p[2]), pc(p[1])])}
      {p && row('Our fair price', [m.model.odds[0].toFixed(2), m.model.odds[2].toFixed(2), m.model.odds[1].toFixed(2)])}
      {book && row(m.book.kind === 'closing' ? 'Closing average' : 'Market average', book.map((x) => x?.toFixed(2)), 'football-data')}
      {m.book?.pin && row('Pinnacle closing', m.book.pin.map((x) => x?.toFixed(2)))}
      {espn && row(espn.book, [espn.home, espn.draw, espn.away].map((x) => x.toFixed(2)), 'via ESPN')}
      {espn?.ou && <p className="text-[10px] text-gray-500 mt-1">Goals {espn.ou}: over {espn.over?.toFixed(2) ?? '—'} · under {espn.under?.toFixed(2) ?? '—'} ({espn.book})</p>}
      {!p && !book && !espn && <p className="text-[11px] text-gray-400">No odds for this match.</p>}
      {verdict && (
        <div className={`mt-2 border px-2 py-1.5 text-[11px] ${verdict.reasons.length ? 'border-amber-300 bg-amber-50' : 'border-green-300 bg-green-50'}`}>
          {verdict.reasons.length ? (
            <p><b className="text-amber-800">Skip by your rules</b> · {verdict.reasons.join('; ')}.</p>
          ) : (
            <p><b className="text-green-800">Back {verdict.team}</b>{verdict.odds ? ` @ ${verdict.odds.toFixed(2)}` : ''} <span className="text-gray-500">({verdict.src || 'no price yet'})</span>
              {verdict.res && <b className={verdict.res === 'won' ? 'text-green-700' : 'text-red-600'}> · {verdict.res}</b>}</p>
          )}
          {verdict.rested > 0 && <p className="text-amber-800 mt-0.5">⚠ {verdict.rested} of {verdict.team}'s regulars aren't starting - see the line-ups.</p>}
        </div>
      )}
    </Card>
  )
}

/** The betting model (backend football_ml): each side's chance against the market's, and whether it's worth a bet. */
function ModelCard({ m }) {
  const ml = m.ml
  if (!ml) return null
  const row = (s) => {
    const x = ml.sides[s]
    const fav = x.odds <= ml.sides[s === 'home' ? 'away' : 'home'].odds
    const value = x.bet && fav
    return (
      <div key={s} className="py-1.5 border-t border-gray-100 first:border-t-0">
        <div className="flex items-baseline gap-2 text-[12px]">
          <span className="font-black flex-1 min-w-0 truncate">{(m[s].short || x.team)} <span className="font-normal text-gray-400">@ {x.odds.toFixed(2)}</span></span>
          <span className="tabular-nums text-gray-500">market {pc(x.market)}</span>
          <span className="tabular-nums font-black">model {(100 * x.p).toFixed(1)}%</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={`text-[9px] font-black px-1 py-0.5 rounded-none ${value ? 'bg-green-700 text-white' : x.bet ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-500'}`}>
            {value ? 'VALUE' : x.bet ? 'UNDERDOG - NOT BACKED' : 'NO VALUE'}
          </span>
          <span className={`text-[10px] tabular-nums ${x.ev > 0 ? 'text-green-700' : 'text-gray-500'}`}>expected {x.ev > 0 ? '+' : ''}{(100 * x.ev).toFixed(1)}% a bet</span>
        </div>
        <p className="text-[10px] text-gray-500 mt-0.5 leading-snug">
          {x.pushes.filter((d) => Math.abs(d.push) >= 0.005).map((d) => `${d.label} ${d.push > 0 ? '▲' : '▼'}`).join(' · ') || 'Close to the market on every feature.'}
        </p>
      </div>
    )
  }
  return (
    <Card title="Betting model" sub={ml.model}>
      {row('home')}
      {row('away')}
      <p className="text-[9px] text-gray-400 mt-1 leading-snug">
        Logistic regression starting from the market's chance ({ml.prices}); value = chance × price above 1. Only favourites are backed:
        underdog value has lost in testing. ▲▼ the features pushing hardest. Rebuilt daily ({ml.fit_at}).
      </p>
    </Card>
  )
}

function Lineup({ t, lu, rot, mode }) {
  const [subs, setSubs] = useState(false)
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 mb-1">
        <Crest t={t} size="w-4 h-4" />
        <span className="text-[11px] font-black truncate flex-1">{t.short || t.name}</span>
        <Tag mode={mode} />
      </div>
      {lu ? (
        <>
          <p className="text-[10px] text-gray-400 mb-0.5">{lu.formation}</p>
          {lu.starters.map((pl) => (
            <p key={pl.id} className="text-[11px] flex gap-1 py-px">
              <span className="w-5 text-right text-gray-400 tabular-nums shrink-0">{pl.jersey}</span>
              <span className="truncate flex-1">{pl.short}</span>
              {pl.off && <span className="text-red-500 text-[10px] shrink-0">↓</span>}
            </p>
          ))}
          {lu.subs.length > 0 && <button onClick={() => setSubs((x) => !x)} className="text-[10px] font-bold text-brand-600 mt-0.5">{subs ? 'hide subs' : `${lu.subs.length} subs`}</button>}
          {subs && lu.subs.map((pl) => (
            <p key={pl.id} className={`text-[11px] flex gap-1 py-px ${pl.on ? 'text-gray-900' : 'text-gray-400'}`}>
              <span className="w-5 text-right tabular-nums shrink-0">{pl.jersey}</span>
              <span className="truncate flex-1">{pl.short}</span>
              {pl.on && <span className="text-green-600 text-[10px] shrink-0">↑</span>}
            </p>
          ))}
        </>
      ) : rot?.regulars?.length ? (
        <>
          <p className="text-[10px] text-gray-400 mb-0.5">Usual starters (of {rot.games})</p>
          {rot.regulars.map((pl) => (
            <p key={pl.id} className="text-[11px] flex gap-1 py-px">
              <span className="truncate flex-1">{pl.short}</span>
              <span className="text-[10px] text-gray-400 tabular-nums">{pl.starts}/{rot.games}</span>
            </p>
          ))}
        </>
      ) : <p className="text-[11px] text-gray-400">Not out yet.</p>}
    </div>
  )
}

function Rotation({ name, rot }) {
  if (!rot || rot.kept == null) return null
  const n = rot.regulars.length
  const heavy = rot.missing.length >= 3
  return (
    <p className={`text-[10px] leading-snug ${heavy ? 'text-amber-800' : 'text-gray-500'}`}>
      <b>{name}</b>: {rot.kept} of {n} regulars start
      {rot.missing.length > 0 && <> · out: {rot.missing.join(', ')}</>}
      {rot.new.length > 0 && <> · in (no start in the last {rot.games}): {rot.new.join(', ')}</>}
    </p>
  )
}

function Events({ m }) {
  if (!m.events.length) return null
  return (
    <Card title="Key events">
      {m.events.map((e, i) => {
        const what = (
          <span className={`text-[11px] ${e.kind === 'goal' || e.kind === 'own-goal' || e.kind === 'penalty---scored' ? 'font-black text-gray-900' : 'text-gray-600'}`}>
            {e.kind === 'substitution' ? <>{e.players[0]}{e.players[1] && <span className="text-gray-400"> for {e.players[1]}</span>}</>
              : <>{e.players.join(e.kind === 'goal' ? ' · assist ' : ', ')}{e.kind === 'own-goal' && ' (o.g.)'}{e.kind.startsWith('penalty') && ' (pen)'}</>}
          </span>
        )
        return (
          <div key={i} className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center py-0.5 border-t border-gray-50 first:border-t-0">
            <div className="text-right min-w-0 truncate">{e.home && <>{what} <span>{ICON[e.kind]}</span></>}</div>
            <span className="w-9 text-center text-[10px] font-bold text-gray-500 tabular-nums">{e.minute}</span>
            <div className="min-w-0 truncate">{!e.home && <><span>{ICON[e.kind]}</span> {what}</>}</div>
          </div>
        )
      })}
    </Card>
  )
}

function Stats({ m }) {
  if (!m.stats.length) return null
  return (
    <Card title="Stats">
      {m.stats.map((s) => {
        const [a, b] = s.values.map((v) => parseFloat(v) || 0)
        const tot = a + b || 1
        return (
          <div key={s.key} className="py-1">
            <div className="flex text-[11px]">
              <span className="w-12 font-black tabular-nums">{s.values[0]}</span>
              <span className="flex-1 text-center text-gray-500">{s.label}</span>
              <span className="w-12 text-right font-black tabular-nums">{s.values[1]}</span>
            </div>
            <div className="flex gap-0.5 h-1.5 mt-0.5">
              <div className="bg-gray-800" style={{ width: `${(100 * a) / tot}%` }} />
              <div className="bg-amber-400" style={{ width: `${(100 * b) / tot}%` }} />
            </div>
          </div>
        )
      })}
      <p className="text-[9px] text-gray-400 mt-1">Dark: {m.home.short} · amber: {m.away.short}</p>
    </Card>
  )
}

function Form({ m }) {
  const team = (t, xs) => (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 mb-1">
        <Crest t={t} size="w-4 h-4" />
        <span className="text-[11px] font-black truncate flex-1">{t.short}</span>
        <span className="flex gap-0.5">{xs.map((x, i) => <span key={i} className={`w-4 h-4 text-[9px] font-black text-white flex items-center justify-center ${RES[x.res] || 'bg-gray-300'}`}>{x.res}</span>)}</span>
      </div>
      {xs.map((x, i) => (
        <p key={i} className="text-[10px] flex gap-1 py-px">
          <span className="w-12 text-gray-400 shrink-0">{fmtDay(x.day)}</span>
          <span className="truncate flex-1">{x.at === 'away' ? '@' : 'v'} {x.opp} <span className="text-gray-400">· {x.comp}</span></span>
          <span className="tabular-nums font-bold shrink-0">{x.score}</span>
        </p>
      ))}
    </div>
  )
  if (!m.form.home.length && !m.form.away.length) return null
  return (
    <Card title="Form" sub="last five, any competition, newest first">
      <div className="space-y-3">
        {team(m.home, m.form.home)}
        {team(m.away, m.form.away)}
      </div>
    </Card>
  )
}

function H2H({ m }) {
  if (!m.h2h.length) return m.series ? <Card title="Head-to-head"><p className="text-[11px] text-gray-500">{m.series} (ESPN)</p></Card> : null
  const h = m.ours.home
  let w = 0; let d = 0; let l = 0
  for (const x of m.h2h) {
    const gf = x.home === h ? x.hg : x.ag
    const ga = x.home === h ? x.ag : x.hg
    if (gf > ga) w += 1; else if (gf === ga) d += 1; else l += 1
  }
  return (
    <Card title="Head-to-head" sub={`last ${m.h2h.length} on file`}>
      <div className="flex text-center text-[11px] mb-2">
        <div className="flex-1"><p className="text-lg font-black">{w}</p><p className="text-gray-500">{m.home.short}</p></div>
        <div className="flex-1"><p className="text-lg font-black text-gray-400">{d}</p><p className="text-gray-500">draws</p></div>
        <div className="flex-1"><p className="text-lg font-black">{l}</p><p className="text-gray-500">{m.away.short}</p></div>
      </div>
      {m.h2h.map((x, i) => (
        <p key={i} className="text-[11px] flex gap-1 py-0.5 border-t border-gray-50">
          <span className="w-14 text-gray-400 shrink-0">{fmtDay(x.day)}</span>
          <span className="truncate flex-1">{x.home} <b className="tabular-nums">{x.hg}-{x.ag}</b> {x.away} <span className="text-gray-400">· {x.comp}</span></span>
        </p>
      ))}
    </Card>
  )
}

function Table({ m }) {
  const [all, setAll] = useState(false)
  if (!m.table.length) return null
  const ids = [m.home.id, m.away.id]
  const at = m.table.map((r, i) => (ids.includes(r.id) ? i : -1)).filter((i) => i >= 0)
  const near = (i) => at.some((j) => Math.abs(i - j) <= 2)
  const rows = all ? m.table : m.table.filter((_, i) => near(i))
  return (
    <Card title="Table" sub={`${m.table.length} teams`}>
      <div className="grid grid-cols-[1.5rem_1fr_repeat(3,2rem)] text-[9px] font-black text-gray-400 pb-1 border-b border-gray-100">
        <span>#</span><span>Team</span><span className="text-right">P</span><span className="text-right">GD</span><span className="text-right">Pts</span>
      </div>
      {rows.map((r) => (
        <div key={r.id} className={`grid grid-cols-[1.5rem_1fr_repeat(3,2rem)] text-[11px] py-0.5 ${ids.includes(r.id) ? 'bg-amber-50 font-black' : ''}`}>
          <span className="text-gray-500 tabular-nums">{r.pos}</span>
          <span className="truncate">{r.team}</span>
          <span className="text-right tabular-nums">{r.p}</span>
          <span className="text-right tabular-nums">{r.gd > 0 ? `+${r.gd}` : r.gd}</span>
          <span className="text-right tabular-nums font-bold">{r.pts}</span>
        </div>
      ))}
      {m.table.length > rows.length || all ? (
        <button onClick={() => setAll((x) => !x)} className="text-[10px] font-bold text-brand-600 mt-1">{all ? 'show less' : 'full table'}</button>
      ) : null}
    </Card>
  )
}

function News({ m }) {
  const [all, setAll] = useState(false)
  if (!m.news.length) return null
  const crest = { [m.home.id]: m.home, [m.away.id]: m.away }
  const xs = all ? m.news : m.news.slice(0, 5)
  return (
    <Card title="News" sub="ESPN">
      {xs.map((n, i) => (
        <a key={i} href={n.link || undefined} target="_blank" rel="noreferrer" className="flex gap-2 py-1.5 border-t border-gray-50 first:border-t-0">
          {crest[n.team] ? <Crest t={crest[n.team]} size="w-4 h-4 mt-0.5 shrink-0" /> : <span className="w-4 shrink-0" />}
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-bold text-gray-900 leading-snug">{n.headline}</span>
            {n.description && <span className="block text-[10px] text-gray-500 leading-snug line-clamp-2">{n.description}</span>}
            {n.published && <span className="block text-[9px] text-gray-400 mt-0.5">{ago(n.published)}</span>}
          </span>
        </a>
      ))}
      {m.news.length > 5 && <button onClick={() => setAll((x) => !x)} className="text-[10px] font-bold text-brand-600 mt-1">{all ? 'fewer' : `${m.news.length - 5} more`}</button>}
    </Card>
  )
}

export default function FootballMatch() {
  const nav = useNavigate()
  const [q] = useSearchParams()
  const params = useMemo(() => ({
    comp: q.get('c') || '', date: q.get('d') || '', home: q.get('h') || '', away: q.get('a') || '',
    home_short: q.get('hs') || '', away_short: q.get('as') || '', espn: q.get('e') || '',
  }), [q])
  const [m, setM] = useState(() => peek('/football/match', params) || null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true
    let t = null
    const load = () => footballMatch(params).then((r) => {
      if (!alive) return
      setM(r.data); setErr('')
      if (r.data.state === 'live') t = setTimeout(load, 30000)
    }).catch((e) => { if (alive) setErr(e?.response?.data?.detail || 'Could not load this match.') })
    load()
    return () => { alive = false; clearTimeout(t) }
  }, [params])
  return (
    <div className="pb-28 md:pb-10 overflow-x-hidden">
      <div className="px-5 pt-10 md:pt-6 pb-3 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-1">← Back</button>
        <h1 className="text-xl font-black tracking-tight truncate">{m ? `${m.home.short} v ${m.away.short}` : 'Match centre'}</h1>
      </div>
      <div className="px-5 pt-4 space-y-3 max-w-2xl">
        {err && <p className="text-xs text-red-600 bg-red-50 border border-red-100 px-3 py-2">{err}</p>}
        {!m && !err && <p className="text-xs text-gray-400 text-center py-10">Loading the match…</p>}
        {m && (
          <>
            <Header m={m} />
            <OurView m={m} />
            <ModelCard m={m} />
            <Card title="Line-ups" sub={m.lineups.home || m.lineups.away ? null : 'usually out an hour before kick-off'}>
              <div className="grid grid-cols-2 gap-3">
                <Lineup t={m.home} lu={m.lineups.home} rot={m.rotation.home} mode={m.mine.home} />
                <Lineup t={m.away} lu={m.lineups.away} rot={m.rotation.away} mode={m.mine.away} />
              </div>
              {(m.rotation.home?.kept != null || m.rotation.away?.kept != null) && (
                <div className="mt-2 pt-2 border-t border-gray-100 space-y-1">
                  <p className="text-[10px] font-black text-gray-500">Rotation · regulars = started 3+ of the last 5</p>
                  <Rotation name={m.home.short} rot={m.rotation.home} />
                  <Rotation name={m.away.short} rot={m.rotation.away} />
                </div>
              )}
            </Card>
            <Events m={m} />
            <Stats m={m} />
            <Form m={m} />
            <H2H m={m} />
            <Table m={m} />
            <News m={m} />
            <p className="text-[10px] text-gray-400 leading-snug">
              Line-ups, events, stats, form, table and news: ESPN. Our chances: our model. Prices: football-data.co.uk
              (top five leagues) and ESPN's sportsbook. Head-to-head: our results on file.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
