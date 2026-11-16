import { Fragment, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { footballWatch, footballWatchFeed, footballWatchResults, footballWatchSave } from '../api'

/**
 * Football › My teams (/football/teams): the teams I follow, each one either
 * tracked (its form, next match and last results) or bet on (counted in the
 * P/L - backing it, or the favourite, in each of its matches). Chosen club by
 * club, league by league, and national teams; saved to my account
 * (backend routers/football watch*).
 */
const rupees = (x) => `${x < 0 ? '−' : x > 0 ? '+' : ''}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`
const pct = (x) => (x == null ? '—' : `${x > 0 ? '+' : ''}${(100 * x).toFixed(1)}%`)
const tone = (x) => (x > 0 ? 'text-green-700' : x < 0 ? 'text-red-600' : 'text-gray-900')
const fmtDay = (d) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
const fmtWhen = (iso) => new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })
const RES = { W: 'bg-green-600', D: 'bg-gray-400', L: 'bg-red-500' }
const NEXT = { undefined: 'track', track: 'bet', bet: undefined }        // a tap moves a team on

/** One question: tap a team to track it, again to bet on it, again to drop it. */
function Question({ title, options, chosen, onTap, limit }) {
  const [all, setAll] = useState(false)
  const n = Object.keys(chosen).length
  const shown = all ? options : options.slice(0, limit)
  return (
    <div>
      <p className="text-[11px] font-bold text-gray-700">{title} <span className="font-normal text-gray-400">{n ? `${n} chosen` : ''}</span></p>
      <div className="flex gap-1 flex-wrap mt-1">
        {shown.map((t) => {
          const m = chosen[t]
          return (
            <button key={t} onClick={() => onTap(t)}
              className={`px-2 py-0.5 rounded-none border text-[11px] font-bold ${m === 'bet' ? 'bg-green-700 text-white border-green-700'
                : m === 'track' ? 'bg-sky-100 text-sky-800 border-sky-300' : 'bg-white text-gray-600 border-gray-300'}`}>
              {m === 'bet' ? '₹ ' : ''}{t}
            </button>
          )
        })}
        {options.length > limit && (
          <button onClick={() => setAll((x) => !x)} className="px-2 py-0.5 text-[11px] font-bold text-brand-600">{all ? 'fewer' : `+${options.length - limit} more`}</button>
        )}
      </div>
    </div>
  )
}

function Chooser({ w, onSaved, onCancel }) {
  const [draft, setDraft] = useState(w.teams)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const tap = (comp) => (t) => setDraft((d) => {
    const cur = { ...(d[comp] || {}) }
    const next = NEXT[cur[t]]
    if (next) cur[t] = next
    else delete cur[t]
    return { ...d, [comp]: cur }
  })
  const save = () => {
    setBusy(true); setErr('')
    footballWatchSave(draft).then((r) => onSaved(r.data.teams)).catch(() => setErr('Could not save - try again.')).finally(() => setBusy(false))
  }
  const leagues = Object.entries(w.options.clubs)
  return (
    <div className="card rounded-none space-y-3">
      <div>
        <p className="text-sm font-black text-gray-900">Choose your teams</p>
        <p className="text-[10px] text-gray-500 mt-0.5">
          Tap a team once to <b className="text-sky-800">track</b> it (results only), twice to <b className="text-green-700">₹ bet</b> on it
          (counted in the P/L), a third time to drop it. Clubs are in this season's table order.
        </p>
      </div>
      {leagues.map(([code, l], i) => (
        <Question key={code} title={`${i + 1}. ${l.name}`} options={l.teams} chosen={draft[code] || {}} onTap={tap(code)} limit={8} />
      ))}
      <Question title={`${leagues.length + 1}. National teams`} options={w.options.nations} chosen={draft.INTL || {}} onTap={tap('INTL')} limit={16} />
      <div className="flex gap-2">
        <button disabled={busy} onClick={save} className="btn-primary rounded-none py-2 text-xs flex-1">{busy ? 'Saving…' : 'Save'}</button>
        {onCancel && <button onClick={onCancel} className="px-3 py-2 text-xs font-bold text-gray-500">Cancel</button>}
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}
    </div>
  )
}

/** The teams I bet on: their matches at the market's closing average. Also on the P/L dashboard. */
export function BetRecord({ stake = 100, compact = false }) {
  const [r, setR] = useState(null)
  const [err, setErr] = useState(false)
  const [open, setOpen] = useState(null)
  const [more, setMore] = useState(false)
  useEffect(() => {
    let alive = true
    setErr(false)
    footballWatchResults('mine', stake).then((x) => { if (alive) setR(x.data) }).catch(() => { if (alive) setErr(true) })
    return () => { alive = false }
  }, [stake])
  if (err) return <p className="text-xs text-red-600">Couldn't work it out - try again.</p>
  if (!r) return <p className="text-xs text-gray-400">Settling…</p>
  const bet = Object.values(r.teams || {}).reduce((s, v) => s + v.length, 0)
  if (!bet) return <p className="text-xs text-gray-500">No teams to bet on yet - mark some ₹ on the My teams page.</p>
  return (
    <div>
      {r.clubs.some((c) => c.bets) ? (
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-[9px] text-gray-400 uppercase tracking-wider">
              <th className="text-left font-black py-1">Last</th>
              <th className="text-right font-black">Bets</th>
              <th className="text-right font-black">Won</th>
              <th className="text-right font-black">Odds</th>
              <th className="text-right font-black">P/L</th>
              <th className="text-right font-black">Return</th>
            </tr>
          </thead>
          <tbody>
            {r.clubs.map((p) => (
              <Fragment key={p.label}>
                <tr onClick={() => setOpen(open === p.label ? null : p.label)} className={`border-t border-gray-100 cursor-pointer ${p.days ? '' : 'bg-amber-50/60'}`}>
                  <td className="py-1.5 font-bold text-gray-800 whitespace-nowrap">{p.label} <span className="text-brand-600">{open === p.label ? '▴' : '▾'}</span></td>
                  <td className="text-right tabular-nums">{p.bets}</td>
                  <td className="text-right tabular-nums">{p.bets ? Math.round((100 * p.won) / p.bets) : 0}%</td>
                  <td className="text-right tabular-nums">{p.avg_odds?.toFixed(2) ?? '—'}</td>
                  <td className={`text-right tabular-nums font-bold whitespace-nowrap ${tone(p.pl)}`}>{rupees(p.pl)}</td>
                  <td className={`text-right tabular-nums font-bold ${tone(p.pl)}`}>{pct(p.roi)}</td>
                </tr>
                {open === p.label && p.teams.map((t) => (
                  <tr key={t.team} className="text-gray-500">
                    <td className="py-1 pl-3 truncate max-w-[7rem]">{t.team}</td>
                    <td className="text-right tabular-nums">{t.bets}</td>
                    <td className="text-right tabular-nums">{Math.round((100 * t.won) / t.bets)}%</td>
                    <td className="text-right tabular-nums">{t.avg_odds?.toFixed(2)}</td>
                    <td className={`text-right tabular-nums whitespace-nowrap ${tone(t.pl)}`}>{rupees(t.pl)}</td>
                    <td className={`text-right tabular-nums ${tone(t.pl)}`}>{pct(t.roi)}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      ) : <p className="text-[11px] text-gray-500 mt-2">No priced club matches for your ₹ teams yet.</p>}
      {(r.teams.INTL || []).length > 0 && (
        <p className="text-[11px] text-gray-600 mt-2">
          National teams ({r.teams.INTL.join(', ')}): {r.nations.map((n) => `${n.label} ${n.won}-${n.drawn}-${n.lost}`).join(' · ')}
          <span className="text-gray-400"> (won-drawn-lost; no free prices, so no P/L)</span>
        </p>
      )}
      <p className="text-[10px] text-gray-500 mt-1.5">
        ₹{stake} on your team in each of its matches, at the market's closing average (football-data.co.uk); draws count as lost. Two of your teams playing each other: the better priced one.
      </p>
      {!compact && r.club_bets.length > 0 && (
        <div className="mt-2">
          {r.club_bets.slice(0, more ? 150 : 5).map((b, i) => (
            <div key={i} className="flex items-center gap-2 text-[11px] py-1 border-t border-gray-100">
              <span className="w-12 text-gray-400 shrink-0">{fmtDay(b.day)}</span>
              <span className="flex-1 min-w-0 truncate"><b className="text-gray-800">{b.pick}</b><span className="text-gray-400"> · {b.match}</span></span>
              <span className="w-10 text-right tabular-nums text-gray-500 shrink-0">{b.odds.toFixed(2)}</span>
              <span className={`w-14 text-right tabular-nums font-bold shrink-0 ${tone(b.pl)}`}>{rupees(b.pl)}</span>
            </div>
          ))}
          {r.club_bets.length > 5 && (
            <button onClick={() => setMore((m) => !m)} className="text-[11px] font-bold text-brand-600 mt-1">{more ? 'Show fewer' : `Show all ${r.club_bets.length}`}</button>
          )}
        </div>
      )}
    </div>
  )
}

/** A team I follow: form, next match, last results. */
function TeamCard({ t }) {
  const [open, setOpen] = useState(false)
  const n = t.next
  return (
    <div className="py-2 border-t border-gray-100 first:border-t-0">
      <div className="flex items-center gap-2">
        <span className={`text-[10px] font-black rounded-none px-1.5 py-0.5 ${t.mode === 'bet' ? 'bg-green-700 text-white' : 'bg-sky-100 text-sky-800'}`}>{t.mode === 'bet' ? '₹ BET' : 'TRACK'}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-[13px] font-black text-gray-900 truncate">{t.team}</span>
          <span className="block text-[10px] text-gray-400">{t.league}</span>
        </span>
        <span className="flex gap-0.5" title="last five, newest first">
          {t.form.map((x, i) => <span key={i} className={`w-4 h-4 rounded-none text-[9px] font-black text-white flex items-center justify-center ${RES[x]}`}>{x}</span>)}
        </span>
      </div>
      {n ? (
        <p className="text-[11px] text-gray-700 mt-1">
          {n.state === 'live' ? <b className="text-red-600">LIVE · </b> : <span className="text-gray-500">{fmtWhen(n.start)} · </span>}
          {n.home ? 'v' : '@'} <b>{n.opp}</b> <span className="text-gray-400">· {n.comp}</span>
          {n.probs && (
            <span className="block text-[10px] text-gray-500">
              We say {t.team} {Math.round(100 * (n.home ? n.probs[0] : n.probs[1]))}% · draw {Math.round(100 * n.probs[2])}%
              {n.book && ` · bookmakers ${(n.home ? n.book[0] : n.book[1]).toFixed(2)}`}
            </span>
          )}
        </p>
      ) : <p className="text-[11px] text-gray-400 mt-1">No match in the next week.</p>}
      {t.last.length > 0 && (
        <button onClick={() => setOpen((o) => !o)} className="text-[10px] font-bold text-brand-600 mt-0.5">{open ? 'hide results' : 'last results'}</button>
      )}
      {open && t.last.map((g, i) => (
        <div key={i} className="flex items-center gap-2 text-[11px] py-0.5">
          <span className="w-12 text-gray-400 shrink-0">{fmtDay(g.day)}</span>
          <span className="flex-1 min-w-0 truncate">{g.home ? 'v' : '@'} {g.opp} <span className="text-gray-400">· {g.comp}</span></span>
          <span className="tabular-nums font-bold">{g.gf}–{g.ga}</span>
          <span className={`w-4 h-4 rounded-none text-[9px] font-black text-white flex items-center justify-center ${RES[g.res]}`}>{g.res}</span>
        </div>
      ))}
    </div>
  )
}

export default function FootballTeams() {
  const nav = useNavigate()
  const [w, setW] = useState(null)
  const [feed, setFeed] = useState(null)
  const [editing, setEditing] = useState(false)
  const [err, setErr] = useState('')
  const [tick, setTick] = useState(0)
  useEffect(() => {
    footballWatch().then((r) => {
      setW(r.data)
      if (!Object.values(r.data.teams).some((v) => Object.keys(v).length)) setEditing(true)
    }).catch(() => setErr('Could not load your teams.'))
  }, [])
  useEffect(() => { footballWatchFeed().then((r) => setFeed(r.data.teams)).catch(() => setFeed([])) }, [tick])
  const bets = (feed || []).filter((t) => t.mode === 'bet')
  const tracks = (feed || []).filter((t) => t.mode === 'track')
  return (
    <div className="pb-28 md:pb-10 overflow-x-hidden">
      <div className="px-5 pt-10 md:pt-6 pb-3 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-black tracking-tight flex-1">My teams</h1>
          {w && !editing && <button onClick={() => setEditing(true)} className="px-2 py-1 rounded-none border border-amber-300 bg-white text-[11px] font-bold text-brand-600">Edit teams</button>}
        </div>
        <p className="mt-1 text-[11px] text-gray-400">Tracked for results · ₹ bet on, counted in the P/L</p>
      </div>
      <div className="px-5 pt-4 space-y-3 max-w-2xl">
        {err && <p className="text-xs text-red-600">{err}</p>}
        {!w && !err && <p className="text-xs text-gray-400 text-center py-8">Loading…</p>}
        {w && editing && (
          <Chooser w={w} onCancel={Object.values(w.teams).some((v) => Object.keys(v).length) ? () => setEditing(false) : null}
            onSaved={(teams) => { setW((o) => ({ ...o, teams })); setEditing(false); setTick((x) => x + 1) }} />
        )}
        {w && !editing && (
          <>
            {bets.length > 0 && (
              <div className="card rounded-none">
                <p className="text-sm font-black text-gray-900">₹ Teams I bet on</p>
                <div className="mt-1">{bets.map((t) => <TeamCard key={`${t.comp}:${t.team}`} t={t} />)}</div>
                <div className="mt-3 border-t border-gray-100 pt-2" key={tick}><BetRecord /></div>
              </div>
            )}
            {tracks.length > 0 && (
              <div className="card rounded-none">
                <p className="text-sm font-black text-gray-900">Teams I track</p>
                <div className="mt-1">{tracks.map((t) => <TeamCard key={`${t.comp}:${t.team}`} t={t} />)}</div>
              </div>
            )}
            {feed && !feed.length && <p className="text-xs text-gray-400 text-center py-6">No teams yet - tap Edit teams.</p>}
            {!feed && <p className="text-xs text-gray-400 text-center py-6">Loading their matches…</p>}
          </>
        )}
      </div>
    </div>
  )
}
