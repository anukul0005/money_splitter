import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { footballGrades, footballGradeSet } from '../api'

/**
 * Football › Team grades (/football/grades): every club in this season's
 * five leagues graded 0-100 by the betting model (backend football_ml.grades)
 * - its own edge over the market, its value-bet record and how often it's
 * the favourite - beside my own stars (0-5), blended 60 / 40 where I've
 * graded it. For picking my ₹ shortlist.
 */
const LEAGUES = [['all', 'All'], ['E0', 'EPL'], ['SP1', 'LaLiga'], ['I1', 'Serie A'], ['D1', 'Bund.'], ['F1', 'Ligue 1']]
const SHORT = Object.fromEntries(LEAGUES)
const pct = (x) => (x == null ? '—' : `${x > 0 ? '+' : ''}${(100 * x).toFixed(1)}%`)
const band = (g) => (g >= 75 ? 'bg-green-700 text-white' : g >= 60 ? 'bg-green-100 text-green-800' : g >= 45 ? 'bg-gray-100 text-gray-700' : 'bg-red-50 text-red-700')
const RES = { W: 'bg-green-600', D: 'bg-gray-400', L: 'bg-red-500' }

function Stars({ value, onSet }) {
  return (
    <span className="flex" role="group" aria-label="my grade">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} onClick={(e) => { e.stopPropagation(); onSet(value === n ? -1 : n) }} aria-label={`${n} star${n > 1 ? 's' : ''}`}
          className={`w-5 h-5 text-[14px] leading-none ${value != null && n <= value ? 'text-amber-500' : 'text-gray-300'}`}>★</button>
      ))}
    </span>
  )
}

function Part({ label, score, detail }) {
  return (
    <div className="flex items-center gap-2 text-[11px] py-0.5">
      <span className="w-24 shrink-0 text-gray-500">{label}</span>
      <span className="flex-1 h-1.5 bg-gray-100"><span className="block h-1.5 bg-field-950" style={{ width: `${score}%` }} /></span>
      <span className="w-8 text-right tabular-nums font-bold">{score}</span>
      <span className="w-28 shrink-0 text-right text-[10px] text-gray-500 truncate">{detail}</span>
    </div>
  )
}

function Row({ t, i, onStars }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="py-2 border-t border-gray-100 first:border-t-0">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 text-left">
        <span className="w-5 text-[10px] text-gray-400 tabular-nums shrink-0">{i + 1}</span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="text-[13px] font-black truncate">{t.team}</span>
            {t.mode && <span className={`text-[9px] font-black px-1 py-0.5 rounded-none ${t.mode === 'bet' ? 'bg-green-700 text-white' : 'bg-sky-100 text-sky-800'}`}>{t.mode === 'bet' ? '₹ BET' : 'TRACK'}</span>}
          </span>
          <span className="block text-[10px] text-gray-400">{SHORT[t.comp]} · {t.rank ? `${t.rank}${['st', 'nd', 'rd'][t.rank - 1] || 'th'} now` : ''}{t.elite ? ' · elite' : ''}</span>
        </span>
        <Stars value={t.stars} onSet={(n) => onStars(t, n)} />
        <span className="w-9 text-right">
          <span className={`inline-block w-9 text-center text-[13px] font-black py-0.5 rounded-none ${band(t.blend)}`}>{t.blend}</span>
        </span>
      </button>
      {open && (
        <div className="mt-2 ml-7 border-l-2 border-gray-100 pl-2">
          <Part label="Own edge · 50%" score={t.edge_score} detail={`${pct(t.edge)} a match`} />
          <Part label="Value record · 20%" score={t.record_score} detail={t.value_bets ? `${t.value_bets} bets · ${pct(t.value_roi)}` : 'no value bets'} />
          <Part label="Backable · 30%" score={t.fav_score} detail={`favourite ${Math.round(100 * t.fav_share)}%`} />
          <p className="text-[10px] text-gray-500 mt-1">
            Model grade <b>{t.grade}</b>{t.stars != null ? <> · your {t.stars}★ = {t.stars * 20} · blend 60/40 = <b>{t.blend}</b></> : ' · tap the stars to add yours'}
          </p>
          {t.form && (
            <p className="flex gap-0.5 mt-1" title="last 12 league games, newest first">
              {t.form.split('').map((x, k) => <span key={k} className={`w-3.5 h-3.5 text-[8px] font-black text-white flex items-center justify-center ${RES[x]}`}>{x}</span>)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export default function FootballGrades() {
  const nav = useNavigate()
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  const [lg, setLg] = useState(() => { try { return sessionStorage.getItem('fb.grades.lg') || 'all' } catch { return 'all' } })
  const [mineOnly, setMineOnly] = useState(false)
  useEffect(() => { footballGrades().then((r) => setD(r.data)).catch(() => setErr('Could not load the grades.')) }, [])
  const pick = (k) => { setLg(k); try { sessionStorage.setItem('fb.grades.lg', k) } catch { /* private mode */ } }
  const onStars = (t, n) => {
    setD((o) => ({ ...o, teams: o.teams.map((x) => (x.comp === t.comp && x.team === t.team
      ? { ...x, stars: n < 0 ? null : n, blend: n < 0 ? x.grade : Math.round(0.6 * x.grade + 0.4 * 20 * n) } : x)) }))
    footballGradeSet(t.comp, t.team, n).catch(() => setErr('Could not save your grade - try again.'))
  }
  const list = useMemo(() => (d?.teams || [])
    .filter((t) => (lg === 'all' || t.comp === lg) && (!mineOnly || t.mode))
    .sort((a, b) => b.blend - a.blend), [d, lg, mineOnly])
  return (
    <div className="pb-28 md:pb-10 overflow-x-hidden">
      <div className="px-5 pt-10 md:pt-6 pb-3 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <h1 className="text-xl font-black tracking-tight">Team grades</h1>
        <p className="mt-1 text-[11px] text-gray-400">The model's 0–100 for backing each club · your stars · the blend</p>
        <div className="flex gap-1 mt-2 overflow-x-auto no-scrollbar">
          {LEAGUES.map(([k, l]) => (
            <button key={k} onClick={() => pick(k)}
              className={`shrink-0 px-2.5 py-1 rounded-none border text-[11px] font-bold ${lg === k ? 'bg-field-950 text-white border-field-950' : 'bg-white text-gray-600 border-gray-300'}`}>{l}</button>
          ))}
          <button onClick={() => setMineOnly((v) => !v)}
            className={`shrink-0 px-2.5 py-1 rounded-none border text-[11px] font-bold ${mineOnly ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-amber-600 border-amber-300'}`}>My teams</button>
        </div>
      </div>
      <div className="px-5 pt-4 space-y-3 max-w-2xl">
        {err && <p className="text-xs text-red-600">{err}</p>}
        {!d && !err && <p className="text-xs text-gray-400 text-center py-8">Loading…</p>}
        {d && (
          <div className="card rounded-none">
            {list.length ? list.map((t, i) => <Row key={`${t.comp}:${t.team}`} t={t} i={i} onStars={onStars} />)
              : <p className="text-xs text-gray-400 py-4 text-center">{d.teams.length ? 'No clubs here.' : 'The model is still building - try again in a few minutes.'}</p>}
          </div>
        )}
        <p className="text-[10px] text-gray-400 leading-snug">
          Own edge: how far the model's chance sat above the market's over the club's last 20 league matches, beyond the lift it gives
          any favourite at that price - from walk-forward chances, never fitted on the matches graded. Value record: its value bets as
          favourite over two seasons, shrunk when there are few. Backable: how often it's the favourite (the model backs only favourites).
          Tap a club for the parts; tap a star to grade it yourself (again to clear). {d?.built_at ? `Model built ${d.built_at}.` : ''}
        </p>
      </div>
    </div>
  )
}
