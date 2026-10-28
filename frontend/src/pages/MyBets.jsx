import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { betsConnectUrl, betsList, betsProgress, betsStatus, betsSummary, betsSync } from '../api'

/**
 * /my-bets - your 1xbet bets, read from the history emails 1xbet sends to
 * the Gmail inbox connected here (backend bet_history.py / routers/bets.py).
 * Profit, ROI and win rate overall, by month, sport, market, odds, stake
 * and - for tennis - tour and set; every bet with its legs and results.
 */
const inr = (n, d = 0) => (n == null ? '—' : `${n < 0 ? '−' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: d })}`)
const pl = (n) => (n == null ? 'text-gray-400' : n >= 0 ? 'text-green-700' : 'text-red-600')
const fmtD = (s) => (s ? new Date(s.replace(' ', 'T')).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')
const STATUS = {
  won: ['Won', 'bg-green-100 text-green-800'], lost: ['Lost', 'bg-red-100 text-red-700'],
  returned: ['Refund', 'bg-gray-100 text-gray-700'], partial: ['Part', 'bg-amber-100 text-amber-800'],
  cashout: ['Cash-out', 'bg-sky-100 text-sky-800'], open: ['Open', 'bg-purple-100 text-purple-800'],
}

function Stat({ label, value, sub, cls = 'text-gray-900' }) {
  return (
    <div className="flex-1 min-w-[100px] rounded-md bg-white border border-amber-100 px-3 py-2">
      <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{label}</p>
      <p className={`text-base font-black ${cls}`}>{value}</p>
      {sub && <p className="text-[10px] text-gray-500">{sub}</p>}
    </div>
  )
}

/** Cumulative profit, day by day. */
function Curve({ points }) {
  if (!points?.length) return null
  const W = 600, H = 160, P = 6
  const ys = points.map((p) => p.cumulative)
  const lo = Math.min(0, ...ys), hi = Math.max(0, ...ys)
  const x = (i) => P + (i * (W - 2 * P)) / Math.max(points.length - 1, 1)
  const y = (v) => H - P - ((v - lo) * (H - 2 * P)) / (hi - lo || 1)
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.cumulative).toFixed(1)}`).join(' ')
  const last = points[points.length - 1].cumulative
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-40">
      <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} stroke="#d1d5db" strokeDasharray="4 4" />
      <path d={d} fill="none" stroke={last >= 0 ? '#15803d' : '#dc2626'} strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  )
}

function Breakdown({ title, rows, note }) {
  if (!rows?.length) return null
  return (
    <div className="card">
      <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">{title}</p>
      {note && <p className="text-[10px] text-gray-400">{note}</p>}
      <div className="overflow-x-auto -mx-4 mt-1">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider">
              <th className="px-2 py-1 text-left"></th><th className="px-1 py-1">Bets</th><th className="px-1 py-1">W–L</th>
              <th className="px-1 py-1">Win %</th><th className="px-1 py-1">Staked</th><th className="px-1 py-1">P/L</th><th className="px-1 py-1">ROI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-t border-gray-100">
                <td className="px-2 py-1.5 font-bold text-gray-800">{r.label}</td>
                <td className="px-1 py-1.5 text-center tabular-nums">{r.bets}</td>
                <td className="px-1 py-1.5 text-center tabular-nums text-gray-600">{r.won}–{r.lost}</td>
                <td className="px-1 py-1.5 text-center tabular-nums">{r.win_rate == null ? '—' : `${r.win_rate}%`}</td>
                <td className="px-1 py-1.5 text-center tabular-nums text-gray-600">{inr(r.staked)}</td>
                <td className={`px-1 py-1.5 text-center tabular-nums font-black ${pl(r.profit)}`}>{inr(r.profit)}</td>
                <td className={`px-1 py-1.5 text-center tabular-nums font-bold ${pl(r.roi)}`}>{r.roi == null ? '—' : `${r.roi > 0 ? '+' : ''}${r.roi}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function BetRow({ b }) {
  const [open, setOpen] = useState(false)
  const [label, cls] = STATUS[b.status] || [b.status, 'bg-gray-100 text-gray-700']
  return (
    <div className="py-2 border-t border-gray-100 first:border-t-0">
      <button onClick={() => setOpen(!open)} className="w-full text-left">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-[10px] text-gray-400">{fmtD(b.placed_at)} · {b.sport}{b.legs > 1 ? ` · ${b.legs} legs` : ''}</p>
            <p className="text-[13px] font-bold text-gray-900 truncate">{b.legs > 1 ? `Accumulator: ${b.detail?.legs?.map((l) => l.event).join(' · ')}` : b.event}</p>
            <p className="text-[11px] text-gray-500">{b.market ? `${b.market} @ ` : '@ '}{b.odds} · stake {inr(b.stake)}</p>
          </div>
          <div className="text-right">
            <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${cls}`}>{label}</span>
            <p className={`text-sm font-black tabular-nums mt-0.5 ${pl(b.profit)}`}>{b.profit == null ? '' : `${b.profit > 0 ? '+' : ''}${inr(b.profit, 2)}`}</p>
          </div>
        </div>
      </button>
      {open && (
        <div className="mt-1.5 ml-2 pl-2 border-l-2 border-amber-200 space-y-1.5">
          {(b.detail?.legs || []).map((l, i) => (
            <div key={i} className="text-[11px]">
              <p className="text-gray-400">{l.sport}{l.league ? ` · ${l.league}` : ''} · {fmtD(l.start)}</p>
              <p className="font-bold text-gray-800">{l.event}</p>
              <p className="text-gray-600">{l.pick} @ {l.odds} · <b>{l.status}</b>{l.result ? ` · ${l.result}` : ''}</p>
            </div>
          ))}
          <p className="text-[10px] text-gray-400">Bet slip №{b.id} · returned {inr(b.payout, 2)}{b.detail?.payout_estimated ? ' (cash-out, estimated: stake × odds)' : ''}</p>
        </div>
      )}
    </div>
  )
}

function BetList() {
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [d, setD] = useState(null)
  const timer = useRef(null)
  useEffect(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => betsList({ status, q, page }).then((r) => setD(r.data)).catch(() => setD({ bets: [], count: 0 })), 250)
    return () => clearTimeout(timer.current)
  }, [status, q, page])
  return (
    <div className="card">
      <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-2">Every bet</p>
      <div className="flex gap-2 flex-wrap mb-2">
        <input className="input flex-1 min-w-[160px]" placeholder="Search a match or player" value={q}
          onChange={(e) => { setQ(e.target.value); setPage(0) }} />
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0) }}
          className="px-2 py-1.5 rounded-md border border-amber-300 bg-white text-xs font-bold">
          <option value="">All results</option>
          {Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      {!d ? <p className="text-xs text-gray-400 py-4 text-center">Loading…</p> : (
        <>
          <p className="text-[10px] text-gray-400">{d.count} bets</p>
          {d.bets.map((b) => <BetRow key={b.id} b={b} />)}
          {d.count > 50 && (
            <div className="flex items-center justify-between mt-2">
              <button disabled={page === 0} onClick={() => setPage(page - 1)} className="text-xs font-bold text-brand-600 disabled:opacity-30">‹ Newer</button>
              <span className="text-[10px] text-gray-400">{page * 50 + 1}–{Math.min((page + 1) * 50, d.count)} of {d.count}</span>
              <button disabled={(page + 1) * 50 >= d.count} onClick={() => setPage(page + 1)} className="text-xs font-bold text-brand-600 disabled:opacity-30">Older ›</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function MailCard({ st, onSynced }) {
  const [busy, setBusy] = useState(false)
  const [prog, setProg] = useState(null)
  const [err, setErr] = useState('')
  const poll = useRef(null)
  useEffect(() => () => clearInterval(poll.current), [])
  const connect = () => betsConnectUrl().then((r) => { window.location = r.data.url }).catch(() => setErr("Couldn't start the Gmail connection."))
  const sync = () => {
    setErr(''); setBusy(true)
    betsSync().then(() => {
      poll.current = setInterval(() => betsProgress().then((r) => {
        setProg(r.data)
        if (r.data.status !== 'running') { clearInterval(poll.current); setBusy(false); onSynced() }
      }), 1500)
    }).catch((e) => { setBusy(false); setErr(e.response?.data?.detail || "Couldn't start.") })
  }
  return (
    <div className="card">
      {!st.connected ? (
        <>
          <p className="text-sm font-black text-gray-900">Read new history from Gmail</p>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Connect the inbox 1xbet sends your betting history to (anukul2597@gmail.com), read-only. Each time you ask 1xbet for
            your history, tap "Check mail" here - it's also checked every day. Bets already here are skipped, so overlapping
            periods never count twice.
          </p>
          <button onClick={connect} className="btn-primary mt-2 text-sm">Connect Gmail</button>
        </>
      ) : (
        <>
          <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest">Reading from Gmail</p>
          <p className="text-sm font-black text-gray-900 break-all">{st.gmail_address}</p>
          <p className="text-[11px] text-gray-500">
            {st.last_synced_at ? `Last checked ${fmtD(st.last_synced_at.slice(0, 16))}` : 'Not checked yet'} · also checked every day
          </p>
          <button onClick={sync} disabled={busy} className="btn-primary text-sm mt-2 disabled:opacity-50">
            {busy ? 'Checking…' : 'Check mail now'}
          </button>
          {prog && (
            <p className="text-[11px] text-gray-600 mt-1">
              {prog.status === 'running' ? `Reading ${prog.done || 0} of ${prog.total || '…'} emails` :
                prog.status === 'error' ? <span className="text-red-600">{prog.error}</span> :
                  `${prog.new_emails || 0} new history email${prog.new_emails === 1 ? '' : 's'} · ${prog.bets_new || 0} new bets`}
            </p>
          )}
        </>
      )}
      {err && <p className="text-[11px] text-red-600 mt-1">{err}</p>}
      {st.imports?.length > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-100">
          <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1">History read · newest period first</p>
          {[...st.imports].sort((a, b) => ((b.periods || [])[0]?.[0] || '').localeCompare((a.periods || [])[0]?.[0] || '')).map((i, k) => {
            const p = (i.periods || []).filter(Boolean)[0]
            const day = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '')
            return (
              <div key={k} className="flex items-baseline gap-2 py-0.5 text-[11px]">
                <span className="flex-1 min-w-0 font-bold text-gray-700">{p ? `${day(p[0])} – ${day(p[1])}` : i.subject}</span>
                {i.error ? <span className="text-red-600">{i.error}</span> : (
                  <span className="text-gray-500 tabular-nums whitespace-nowrap">
                    {i.bets_found} bets · {i.bets_new ? <b className="text-green-700">{i.bets_new} new</b> : 'already had'}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function MyBets() {
  const nav = useNavigate()
  const loc = useLocation()
  const [st, setSt] = useState(null)
  const [s, setS] = useState(null)
  const load = () => {
    betsStatus().then((r) => setSt(r.data)).catch(() => setSt({ connected: false }))
    betsSummary().then((r) => setS(r.data)).catch(() => setS({ total: null }))
  }
  useEffect(load, [])
  const gmail = new URLSearchParams(loc.search).get('gmail')
  const t = s?.total
  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-3 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <h1 className="text-xl font-black tracking-tight">My bets</h1>
        <p className="text-[11px] text-gray-400 mt-0.5">
          1xbet{t ? ` · ${t.bets} bets · ${fmtD(t.first)} – ${fmtD(t.last)}` : ''}
        </p>
      </div>
      <div className="px-5 mt-4 max-w-2xl space-y-3">
        {gmail === 'connected' && <p className="text-xs font-bold text-green-700">Gmail connected - tap "Check mail" to read your history.</p>}
        {gmail === 'error' && <p className="text-xs font-bold text-red-600">Gmail didn't connect - try again.</p>}
        {st && <MailCard st={st} onSynced={load} />}
        {!s && <p className="text-xs text-gray-400 text-center py-6">Loading…</p>}
        {s && !t && <p className="text-sm text-gray-400 text-center py-8">No bets yet.</p>}
        {t && (
          <>
            <div className="card">
              <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Overall</p>
              <p className={`text-3xl font-black mt-1 ${pl(t.profit)}`}>{t.profit >= 0 ? '+' : ''}{inr(t.profit, 2)}</p>
              <p className="text-[11px] text-gray-500">
                ROI <b className={pl(t.roi)}>{t.roi > 0 ? '+' : ''}{t.roi}%</b> · staked {inr(t.staked)} · returned {inr(t.returned)}
              </p>
              <div className="flex gap-2 flex-wrap mt-3">
                <Stat label="Won – lost" value={`${t.won} – ${t.lost}`} sub={`${t.win_rate}% of settled`} />
                <Stat label="Average odds" value={t.avg_odds} sub={`avg stake ${inr(t.avg_stake)}`} />
                <Stat label="Streaks" value={`${t.longest_win_streak} W · ${t.longest_loss_streak} L`} sub="longest in a row" />
                <Stat label="Biggest" value={inr(t.best_win)} sub={`worst ${inr(t.worst_loss)}`} cls="text-green-700" />
              </div>
              <p className="text-[10px] text-gray-400 mt-2">
                {Object.entries(t.statuses || {}).map(([k, v]) => `${(STATUS[k] || [k])[0]} ${v}`).join(' · ')}
              </p>
            </div>
            <div className="card">
              <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Profit over time</p>
              <Curve points={s.curve} />
            </div>
            <Breakdown title="By month" rows={s.by_month} />
            <Breakdown title="By sport" rows={s.by_sport} />
            <Breakdown title="Single vs accumulator" rows={s.by_type} />
            <Breakdown title="By market" rows={s.by_market} note="Singles; accumulators on their own line." />
            <Breakdown title="By odds" rows={s.by_odds} />
            <Breakdown title="By stake" rows={s.by_stake} />
            <Breakdown title="Tennis · by tour" rows={s.tennis_tour} note="Tennis singles." />
            <Breakdown title="Tennis · whole match or set" rows={s.tennis_part} />
            <Breakdown title="Tennis · tournaments" rows={s.tennis_events} note="Most bet on." />
          </>
        )}
        <BetList />
      </div>
    </div>
  )
}
