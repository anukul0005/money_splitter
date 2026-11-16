import { useEffect, useMemo, useState } from 'react'
import { CardHead, Tile } from './Badminton'
import { BookOdds, useBookOdds } from '../components/SportPick'
import DatePicker from '../components/DatePicker'
import { peek, footballDay, footballLive, footballModel, footballTable } from '../api'

/**
 * Football in the sports section (Betting analytics' ⚽ switch): the top five
 * leagues, the Champions League, the World Cup and the Euros - fixtures, live
 * scores and results from football-data.org, each match with our odds
 * (backend football_model.py), the bookmakers' average where
 * football-data.co.uk has it; league tables; how the model has done. (No
 * consider / skip here for now - the backers'-favourite record is on the P/L
 * dashboard.)
 */
export const F_TABS = [['matches', 'Matches'], ['tables', 'Tables'], ['model', 'Model']]
const COMPS = [['all', 'All'], ['mine', '★'], ['PL', 'EPL'], ['PD', 'LaLiga'], ['SA', 'Serie A'], ['BL1', 'Bund.'], ['FL1', 'Ligue 1'], ['CL', 'UCL'], ['ISL', 'ISL'], ['NT', 'Nations'], ['WC', 'WC'], ['EC', 'Euro']]
const SHORT = Object.fromEntries(COMPS)

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }) : '')
const dayKey = (iso) => new Date(iso).toDateString()
const dayLabel = (iso) => {
  const d = new Date(iso)
  const t = new Date()
  const diff = Math.round((new Date(d.toDateString()) - new Date(t.toDateString())) / 864e5)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
}
const pc = (x) => `${Math.round(100 * x)}%`
const iso = (d) => d.toLocaleDateString('en-CA')                       // YYYY-MM-DD, local
const shift = (s, n) => { const d = new Date(`${s}T00:00:00`); d.setDate(d.getDate() + n); return iso(d) }
const longDay = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })

function Chips({ value, onChange, options }) {
  return (
    <div className="flex gap-1 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
      {options.map(([k, l]) => (
        k === 'mine' ? (            /* my teams: a star alone, in amber */
          <button key={k} onClick={() => onChange(k)} title="My teams" aria-label="My teams"
            className={`shrink-0 w-8 py-1 rounded-full border text-[13px] leading-none font-black ${value === k ? 'bg-amber-500 text-white border-amber-500' : 'bg-amber-50 text-amber-500 border-amber-300'}`}>{l}</button>
        ) : (
          <button key={k} onClick={() => onChange(k)}
            className={`shrink-0 px-2.5 py-1 rounded-full border text-[11px] font-bold ${value === k ? 'bg-field-950 text-white border-field-950' : 'bg-white text-gray-600 border-gray-300'}`}>{l}</button>
        )
      ))}
    </div>
  )
}

function Side({ t, won, live }) {
  return (
    <div className={`flex items-center gap-2 ${won === false ? 'text-gray-400' : 'text-gray-900'}`}>
      {t.crest ? <img src={t.crest} alt="" className="w-4 h-4 object-contain" loading="lazy" /> : <span className="w-4" />}
      <span className={`flex-1 min-w-0 truncate text-[13px] ${won ? 'font-black' : 'font-semibold'}`}>{t.name}</span>
      <span className={`w-6 text-center text-[14px] tabular-nums ${live ? 'text-red-600 font-black' : 'font-bold'}`}>{t.goals ?? ''}</span>
    </div>
  )
}

/** Our chances (home / draw / away) with fair prices, and the bookmakers' average beside them. */
function Odds({ m }) {
  const p = m.model?.probs
  if (!p) return null
  const cells = [['1', p[0], m.model.odds[0], m.book?.avg?.[0]], ['X', p[2], m.model.odds[2], m.book?.avg?.[2]], ['2', p[1], m.model.odds[1], m.book?.avg?.[1]]]
  const fav = Math.max(p[0], p[1], p[2])
  return (
    <div className="mt-1 grid grid-cols-3 gap-1 text-[10px]">
      {cells.map(([k, q, o, b]) => (
        <div key={k} className={`rounded border px-1.5 py-0.5 flex items-baseline gap-1 ${q === fav ? 'border-brand-300 bg-brand-50' : 'border-gray-200'}`}>
          <span className="font-black text-gray-400">{k}</span>
          <span className="font-bold text-gray-800 tabular-nums">{pc(q)}</span>
          <span className="text-gray-400 tabular-nums">{o.toFixed(2)}</span>
          {b && <span className="ml-auto text-gray-600 tabular-nums" title="bookmakers' average">b {b.toFixed(2)}</span>}
        </div>
      ))}
    </div>
  )
}

function Row({ m, books, setBook }) {
  const live = m.state === 'live'
  const done = m.state === 'finished'
  const w = m.winner === 'HOME_TEAM' ? 1 : m.winner === 'AWAY_TEAM' ? 2 : m.winner === 'DRAW' ? 0 : null
  const [open, setOpen] = useState(false)
  return (
    <div className="py-2 border-t border-gray-100 first:border-t-0">
      <div className="flex items-center gap-2 text-[10px] mb-0.5">
        {live ? <span className="font-black text-red-600 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-600 animate-pulse" />LIVE</span>
          : <span className="font-bold text-gray-500">{done ? 'FT' : fmtTime(m.start)}</span>}
        <span className="font-bold text-gray-500">{SHORT[m.comp] || m.comp_name}</span>
        {m.matchday && <span className="text-gray-400">MD {m.matchday}</span>}
        {m.model?.thin && <span className="text-amber-600">few matches on file</span>}
        {m.state === 'upcoming' && books && !m.book && (
          <button onClick={() => setOpen((o) => !o)} className="ml-auto font-bold text-brand-600">{open ? 'hide' : 'bookmaker odds'}</button>
        )}
      </div>
      <Side t={m.home} won={w == null ? null : w === 1} live={live} />
      <Side t={m.away} won={w == null ? null : w === 2} live={live} />
      <Odds m={m} />
      {open && books && (
        <BookOdds sport="football" mkey={String(m.id)} entry={books[String(m.id)]} onSaved={setBook} open names={[m.home.name, m.away.name]} />
      )}
    </div>
  )
}

function Matches({ active }) {
  // '' = this week (two days back to a week on); a date = that one day, any day (the date bar, as in tennis)
  const [date, setDate] = useState(() => { try { return sessionStorage.getItem('fb.date') || '' } catch { return '' } })
  const [d, setD] = useState(() => (date ? peek('/football/day', { date }) : peek('/football/live')) || null)   // the last list at once
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [comp, setComp] = useState(() => { try { return sessionStorage.getItem('fb.comp') || 'all' } catch { return 'all' } })
  const [books, setBook] = useBookOdds('football', active)
  const go = (v) => { setDate(v); try { sessionStorage.setItem('fb.date', v) } catch { /* private mode */ } }
  useEffect(() => {
    if (!active) return undefined
    let alive = true
    setBusy(!!date && !peek('/football/day', { date }))
    const load = () => (date ? footballDay(date) : footballLive()).then((r) => { if (alive) { setD(r.data); setErr('') } })
      .catch((e) => { if (alive) setErr(e?.response?.data?.detail || 'Could not load the matches.') })
      .finally(() => { if (alive) setBusy(false) })
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, 60000)
    return () => { alive = false; clearInterval(t) }
  }, [active, books, date])
  const pick = (k) => { setComp(k); try { sessionStorage.setItem('fb.comp', k) } catch { /* private mode */ } }
  const days = useMemo(() => {
    const ms = (d?.matches || []).filter((m) => comp === 'all' || (comp === 'mine' ? m.mine : m.comp === comp))
    const live = ms.filter((m) => m.state === 'live')
    const rest = ms.filter((m) => m.state !== 'live')
    const by = []
    for (const m of rest) {
      const k = dayKey(m.start)
      if (!by.length || by[by.length - 1].k !== k) by.push({ k, label: dayLabel(m.start), list: [] })
      by[by.length - 1].list.push(m)
    }
    return { live, by }
  }, [d, comp])
  const today = iso(new Date())
  const count = days.live.length + days.by.reduce((s, g) => s + g.list.length, 0)
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={() => go(shift(date || today, -1))}
          className="px-3 py-2 rounded-none border border-amber-300 bg-white text-sm font-black">‹</button>
        <DatePicker value={date || today} onChange={(v) => v && go(v)} className="flex-1" />
        <button onClick={() => go(shift(date || today, 1))}
          className="px-3 py-2 rounded-none border border-amber-300 bg-white text-sm font-black">›</button>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold text-gray-500">{date ? longDay(date) : 'This week'}{d ? ` · ${count} match${count === 1 ? '' : 'es'}` : ''}</p>
        {date && <button onClick={() => go('')} className="text-[11px] font-bold text-brand-600">This week ›</button>}
      </div>
      <Chips value={comp} onChange={pick} options={COMPS} />
      {(busy || (!d && !err)) && <p className="text-xs text-gray-400 py-6 text-center">Loading…</p>}
      {err && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{err}</p>}
      {days.live.length > 0 && (
        <div className="card">
          <CardHead title="Live now" sub={`${days.live.length}`} />
          {days.live.map((m) => <Row key={m.id} m={m} books={books} setBook={setBook} />)}
        </div>
      )}
      {days.by.map((g) => (
        <div key={g.k} className="card">
          <CardHead title={g.label} sub={`${g.list.length}`} />
          {g.list.map((m) => <Row key={m.id} m={m} books={books} setBook={setBook} />)}
        </div>
      ))}
      {d && !busy && !days.live.length && !days.by.length && (
        <p className="text-xs text-gray-400 py-6 text-center">
          {comp === 'mine' ? `None of your teams play ${date ? 'on this day' : 'this week'}.` : `No matches ${comp === 'all' ? '' : 'in this competition '}${date ? 'on this day' : 'this week'}.`}
        </p>
      )}
      <p className="text-[10px] text-gray-400 leading-snug">
        1 / X / 2: our chance and fair price for a home win, draw and away win; "b" the bookmakers' average
        (football-data.co.uk, top five leagues only - type a bookmaker's for the rest). Fixtures and scores: football-data.org; ISL and national teams: ESPN.
      </p>
    </div>
  )
}

function Tables({ active }) {
  const [comp, setComp] = useState('PL')
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    if (!active) return
    setD(null); setErr('')
    footballTable(comp).then((r) => setD(r.data)).catch(() => setErr('Could not load the table.'))
  }, [active, comp])
  return (
    <div className="space-y-3">
      <Chips value={comp} onChange={setComp} options={COMPS.filter(([k]) => !['all', 'mine', 'NT'].includes(k))} />
      {err && <p className="text-xs text-red-600">{err}</p>}
      {!d && !err && <p className="text-xs text-gray-400 py-6 text-center">Loading…</p>}
      {d?.tables?.length === 0 && <p className="text-xs text-gray-400 py-6 text-center">No table for this one now.</p>}
      {d?.tables?.map((t) => (
        <div key={t.group || 'one'} className="card p-0 overflow-hidden">
          {t.group && <p className="px-3 pt-2 text-[10px] font-black text-gray-500 uppercase tracking-widest">{t.group.replace('_', ' ')}</p>}
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-[9px] text-gray-400 uppercase">
                <th className="text-left py-1.5 pl-3">#</th><th className="text-left">Team</th>
                <th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th className="pr-3 text-right">Pts</th>
              </tr>
            </thead>
            <tbody>
              {t.rows.map((r) => (
                <tr key={r.pos} className="border-t border-gray-100 text-center tabular-nums">
                  <td className="text-left py-1.5 pl-3 text-gray-400">{r.pos}</td>
                  <td className="text-left font-semibold text-gray-800 truncate max-w-[9rem]">
                    <span className="inline-flex items-center gap-1.5">{r.crest && <img src={r.crest} alt="" className="w-3.5 h-3.5 object-contain" loading="lazy" />}{r.team}</span>
                  </td>
                  <td>{r.played}</td><td>{r.won}</td><td>{r.draw}</td><td>{r.lost}</td>
                  <td>{r.gd > 0 ? `+${r.gd}` : r.gd}</td><td className="pr-3 text-right font-black">{r.pts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

function Model({ active }) {
  const [d, setD] = useState(null)
  useEffect(() => { if (active) footballModel().then((r) => setD(r.data)).catch(() => setD({})) }, [active])
  if (!d) return <p className="text-xs text-gray-400 py-6 text-center">Loading…</p>
  const c = d.record?.clubs
  const n = d.record?.nations
  const total = Object.values(d.matches || {}).reduce((s, x) => s + x, 0)
  return (
    <div className="space-y-3">
      <div className="card">
        <CardHead title="Clubs" sub={c ? `tested since ${c.since.slice(0, 4)}` : ''} />
        {c ? (
          <>
            <div className="flex gap-2 mt-2 flex-wrap">
              <Tile label="Picked right" value={pc(c.right)} sub={`${c.matches.toLocaleString('en-IN')} matches`} />
              <Tile label="Our score" value={c.ours_there?.toFixed(3)} sub="log-loss, lower is better" />
              <Tile label="Pinnacle" value={c.pinnacle?.toFixed(3)} sub="closing prices, margin out" />
            </div>
            <p className="text-[11px] text-gray-500 mt-2">
              Same matches, scored the same way: a sharp bookmaker's closing price is better than our model, as it is in every sport -
              so our odds are a guide, not bets to follow. Guessing from how often home / draw / away
              happen scores {c.base_log_loss?.toFixed(3)}.
            </p>
          </>
        ) : <p className="text-xs text-gray-400">Building…</p>}
      </div>
      <div className="card">
        <CardHead title="National teams" sub={n ? `tested since ${n.since.slice(0, 4)}` : ''} />
        {n ? (
          <div className="flex gap-2 mt-2 flex-wrap">
            <Tile label="Picked right" value={pc(n.right)} sub={`${n.matches.toLocaleString('en-IN')} matches`} />
            <Tile label="Our score" value={n.log_loss?.toFixed(3)} sub={`base rates ${n.base_log_loss?.toFixed(3)}`} />
          </div>
        ) : <p className="text-xs text-gray-400">Building…</p>}
      </div>
      <p className="text-[10px] text-gray-400 leading-snug">
        Learnt from {total.toLocaleString('en-IN')} results: the top five leagues since 2012/13 with closing odds (football-data.co.uk),
        the Champions League since 2023/24 (football-data.org) and national teams since 2000 (the public international results set).
        Each team has an attack and a defence strength; goals are taken as Poisson, which gives home / draw / away.
      </p>
    </div>
  )
}

export default function Football({ tab, active }) {
  if (tab === 'tables') return <Tables active={active} />
  if (tab === 'model') return <Model active={active} />
  return <Matches active={active} />
}
