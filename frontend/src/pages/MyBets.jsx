import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { betsConnectUrl, betsDeletePromo, betsList, betsProgress, betsPromos, betsSavePromo, betsStatus, betsSummary, betsSync } from '../api'

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

/** Profit in 10-day blocks from `start` (bars green / red, the running
 * total as a line); tap a block to see its 10 days one by one. */
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

function ProfitChart({ points, start }) {
  const [block, setBlock] = useState(null)      // index of the 10-day block opened day by day
  const [hover, setHover] = useState(null)
  useEffect(() => { setBlock(null); setHover(null) }, [start, points])
  if (!points?.length) return null
  const first = start || points[0].date
  const byDay = Object.fromEntries(points.map((p) => [p.date, p.profit]))
  const lastDay = points[points.length - 1].date
  // 10-day blocks from `first` up to the last day with a bet
  const blocks = []
  let cum = 0
  for (let i = 0; addDays(first, i * 10) <= lastDay; i += 1) {
    const from = addDays(first, i * 10), to = addDays(from, 9)
    const days = Array.from({ length: 10 }, (_, k) => addDays(from, k))
    let p = 0
    const dayRows = days.map((d) => { const v = byDay[d] || 0; p += v; return { date: d, profit: v, cumulative: cum + p, bet: d in byDay } })
    cum += p
    blocks.push({ from, to, profit: p, cumulative: cum, days: dayRows, betDays: dayRows.filter((r) => r.bet).length })
  }
  const lead = points.filter((p) => p.date < first).reduce((a, p) => a + p.profit, 0)   // anything before `first`
  const inBlock = block != null && blocks[block]
  const bars = inBlock ? blocks[block].days.map((d) => ({ ...d, cumulative: d.cumulative + lead }))
    : blocks.map((b) => ({ date: b.from, to: b.to, profit: b.profit, cumulative: b.cumulative + lead }))
  const end = cum + lead

  // drawn at about phone width so the labels show at real size; taller than wide-screen charts
  const W = 380, H = 300, L = 46, R = 8, T = 18, B = 30
  const vals = [0, ...bars.map((b) => b.profit), ...bars.map((b) => b.cumulative)]
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1
  const y = (v) => T + ((hi - v) * (H - T - B)) / span
  const step = (W - L - R) / bars.length
  const x = (i) => L + step * i + step / 2
  const bw = Math.max(3, step * (inBlock ? 0.6 : 0.72))
  // ₹0 first, so it always keeps its label; a gridline too close to it is dropped
  const ticks = [0, hi, lo, (hi + lo) / 2].filter((v, i, a) => a.findIndex((w) => Math.abs(w - v) < span * 0.1) === i)
  const short = (v) => `${v < 0 ? '−' : ''}₹${Math.abs(v) >= 1000 ? `${(Math.abs(v) / 1000).toFixed(1)}k` : Math.round(Math.abs(v))}`
  const dlab = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  const every = Math.max(1, Math.ceil(bars.length / 5))          // keep the date labels readable
  const line = bars.map((b, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(b.cumulative).toFixed(1)}`).join(' ')
  const best = bars.reduce((a, b) => (b.profit > a.profit ? b : a), bars[0])
  const worst = bars.reduce((a, b) => (b.profit < a.profit ? b : a), bars[0])
  const up = bars.filter((b) => b.profit > 0).length, down = bars.filter((b) => b.profit < 0).length
  const h = hover != null ? bars[hover] : null
  const label = (b) => (inBlock ? dlab(b.date) : `${dlab(b.date)} – ${dlab(b.to)}`)
  const tap = (i) => { if (inBlock) setHover(i); else { setBlock(i); setHover(null) } }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">
          {inBlock ? `${dlab(blocks[block].from)} – ${dlab(blocks[block].to)} · day by day` : 'Profit every 10 days'}
        </p>
        <p className={`text-sm font-black ${pl(end)}`}>{end >= 0 ? '+' : ''}{inr(end)} total</p>
      </div>
      <div className="flex items-center gap-2 min-h-[18px]">
        {inBlock && (
          <button onClick={() => { setBlock(null); setHover(null) }} className="text-[11px] font-bold text-brand-600">‹ 10-day view</button>
        )}
        <p className="text-[10px] text-gray-400 flex-1">
          {h ? (
            <>{label(h)}: <b className={pl(h.profit)}>{h.profit >= 0 ? '+' : ''}{inr(h.profit)}</b> · running total <b className={pl(h.cumulative)}>{inr(h.cumulative)}</b></>
          ) : inBlock ? (
            <>This block <b className={pl(blocks[block].profit)}>{blocks[block].profit >= 0 ? '+' : ''}{inr(blocks[block].profit)}</b> · bets on {blocks[block].betDays} of 10 days · tap a day</>
          ) : 'Bars: each 10 days’ profit or loss · line: running total. Tap a block for its days.'}
        </p>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke={v === 0 ? '#374151' : '#eef0f3'} strokeWidth={v === 0 ? 1.5 : 1}
              strokeDasharray={v === 0 ? '' : '3 3'} />
            <text x={L - 5} y={y(v) + 4} textAnchor="end" fontSize="11" fontWeight={v === 0 ? 800 : 400}
              fill={v === 0 ? '#111827' : '#6b7280'}>{v === 0 ? '₹0' : short(v)}</text>
          </g>
        ))}
        {bars.map((b, i) => (
          <g key={b.date}>
            <rect x={x(i) - bw / 2} width={bw} y={Math.min(y(b.profit), y(0))} height={Math.max(1, Math.abs(y(b.profit) - y(0)))}
              rx="2" fill={b.profit >= 0 ? '#86efac' : '#fca5a5'} opacity={hover == null || hover === i ? 1 : 0.45} />
            {!inBlock && bars.length <= 14 && b.profit !== 0 && (
              <text x={x(i)} y={b.profit >= 0 ? y(b.profit) - 4 : y(b.profit) + 12} textAnchor="middle" fontSize="10" fontWeight="700"
                fill={b.profit >= 0 ? '#15803d' : '#b91c1c'}>{short(b.profit)}</text>
            )}
          </g>
        ))}
        <path d={line} fill="none" stroke={end >= 0 ? '#15803d' : '#b91c1c'} strokeWidth="2" strokeLinejoin="round" />
        {bars.map((b, i) => <circle key={`c${b.date}`} cx={x(i)} cy={y(b.cumulative)} r="2.6" fill={end >= 0 ? '#15803d' : '#b91c1c'} />)}
        {bars.map((b, i) => (i % every === 0 || i === bars.length - 1) && (
          <text key={`t${b.date}`} x={x(i)} y={H - 10} textAnchor="middle" fontSize="10" fill="#6b7280">{dlab(b.date)}</text>
        ))}
        {bars.map((b, i) => (
          <rect key={`h${b.date}`} x={L + step * i} width={step} y={T} height={H - T - B} fill="transparent" style={{ cursor: 'pointer' }}
            onMouseEnter={() => setHover(i)} onClick={() => tap(i)} />
        ))}
      </svg>
      <div className="grid grid-cols-3 gap-2 mt-1 text-center">
        <div>
          <p className="text-[9px] font-bold text-gray-400 uppercase">Best {inBlock ? 'day' : '10 days'}</p>
          <p className="text-xs font-black text-green-700">{inr(best.profit)}</p>
          <p className="text-[10px] text-gray-400">{label(best)}</p>
        </div>
        <div>
          <p className="text-[9px] font-bold text-gray-400 uppercase">Worst {inBlock ? 'day' : '10 days'}</p>
          <p className="text-xs font-black text-red-600">{inr(worst.profit)}</p>
          <p className="text-[10px] text-gray-400">{label(worst)}</p>
        </div>
        <div>
          <p className="text-[9px] font-bold text-gray-400 uppercase">{inBlock ? 'Days' : 'Blocks'} up / down</p>
          <p className="text-xs font-black text-gray-800"><span className="text-green-700">{up}</span> / <span className="text-red-600">{down}</span></p>
          <p className="text-[10px] text-gray-400">of {bars.length} {inBlock ? 'days' : 'blocks of 10 days'}</p>
        </div>
      </div>
    </div>
  )
}

function Breakdown({ title, rows, note, fmt, onRow, bare }) {
  if (!rows?.length) return null
  return (
    <div className={bare ? 'mt-3' : 'card'}>
      <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">{title}</p>
      {note && <p className="text-[10px] text-gray-400">{note}</p>}
      <div className={`overflow-x-auto mt-1 ${bare ? '-mx-1' : '-mx-4'}`}>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[9px] font-black text-gray-500 uppercase tracking-wider">
              <th className="px-2 py-1 text-left"></th><th className="px-1 py-1">Bets</th><th className="px-1 py-1">W–L</th>
              <th className="px-1 py-1">Win %</th><th className="px-1 py-1">Staked</th><th className="px-1 py-1">P/L</th><th className="px-1 py-1">ROI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} onClick={onRow ? () => onRow(r.label) : undefined}
                className={`border-t border-gray-100 ${onRow ? 'cursor-pointer hover:bg-amber-50' : ''}`}>
                <td className="px-2 py-1.5 font-bold text-gray-800 whitespace-nowrap">{fmt ? fmt(r.label) : r.label}{onRow ? ' ›' : ''}</td>
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

function BetList({ period, bare }) {
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [d, setD] = useState(null)
  const timer = useRef(null)
  useEffect(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => betsList({ status, q, page, frm: period?.from || '', to: period?.to || '' })
      .then((r) => setD(r.data)).catch(() => setD({ bets: [], count: 0 })), 250)
    return () => clearTimeout(timer.current)
  }, [status, q, page, period?.from, period?.to])
  useEffect(() => setPage(0), [period?.from, period?.to])
  return (
    <div className={bare ? 'mt-2' : 'card'}>
      {!bare && <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-2">Every bet</p>}
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

const connectGmail = (onErr) => betsConnectUrl().then((r) => { window.location = r.data.url })
  .catch(() => onErr("Couldn't start the Gmail connection."))

/** The small sync icon at the top right: checks Gmail for new 1xbet history
 * (connects it first if it isn't); spins while reading, then says what came in. */
function SyncButton({ st, onSynced }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)          // [text, tone]
  const poll = useRef(null)
  useEffect(() => () => clearInterval(poll.current), [])
  if (!st) return null
  const sync = () => {
    if (busy) return
    if (!st.connected) { connectGmail((e) => setMsg([e, 'err'])); return }
    setMsg(['Checking mail…', '']); setBusy(true)
    betsSync().then(() => {
      poll.current = setInterval(() => betsProgress().then((r) => {
        const p = r.data
        if (p.status === 'running') { setMsg([`Reading ${p.done || 0} of ${p.total || '…'} emails`, '']); return }
        clearInterval(poll.current); setBusy(false)
        if (p.status === 'error') setMsg([p.error || "Couldn't read the mail", 'err'])
        else { setMsg([p.bets_new ? `${p.bets_new} new bet${p.bets_new === 1 ? '' : 's'}` : 'Up to date', 'ok']); onSynced() }
        setTimeout(() => setMsg(null), 6000)
      }).catch(() => { clearInterval(poll.current); setBusy(false); setMsg(["Couldn't check progress", 'err']) }), 1500)
    }).catch((e) => { setBusy(false); setMsg([e.response?.data?.detail || "Couldn't start", 'err']) })
  }
  const title = !st.connected ? 'Connect Gmail to read new bets'
    : `Check Gmail for new bets${st.last_synced_at ? ` · last ${fmtD(st.last_synced_at.slice(0, 16))}` : ''}`
  return (
    <div className="flex flex-col items-end gap-0.5">
      <button onClick={sync} title={title} aria-label={title}
        className={`relative w-9 h-9 rounded-full border flex items-center justify-center bg-white ${st.connected ? 'border-amber-300 text-brand-600' : 'border-brand-400 text-brand-600'}`}>
        <svg viewBox="0 0 24 24" className={`w-[18px] h-[18px] ${busy ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" /><path d="M4 3v5h5" /><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" /><path d="M20 21v-5h-5" />
        </svg>
        {!st.connected && <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-brand-400 border border-white" />}
      </button>
      <p className={`text-[9px] font-bold whitespace-nowrap ${msg?.[1] === 'err' ? 'text-red-600' : msg?.[1] === 'ok' ? 'text-green-700' : 'text-gray-400'}`}>
        {msg ? msg[0] : st.connected ? (st.last_synced_at ? `synced ${fmtD(st.last_synced_at.slice(0, 16))}` : 'sync') : 'connect Gmail'}
      </p>
    </div>
  )
}

/** Every bet of the stretch shown - behind a button, closed until asked for. */
function AllBets({ period, count }) {
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [period?.from, period?.to])
  return (
    <div className="card">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 text-left">
        <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest flex-1">Every bet</span>
        <span className="text-xs font-black text-brand-600">{open ? 'Hide ▴' : `See all${count ? ` ${count}` : ''} bets ▾`}</span>
      </button>
      {open && <BetList period={period} bare />}
    </div>
  )
}

function MailCard({ st }) {
  const [err, setErr] = useState('')
  return (
    <div className="card">
      {!st.connected ? (
        <>
          <p className="text-sm font-black text-gray-900">Read new history from Gmail</p>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Connect the inbox 1xbet sends your betting history to (anukul2597@gmail.com), read-only. Then the sync icon at the
            top checks it whenever you ask 1xbet for your history - it's also checked every day. Bets already here are skipped.
          </p>
          <button onClick={() => connectGmail(setErr)} className="btn-primary mt-2 text-sm">Connect Gmail</button>
        </>
      ) : (
        <p className="text-[11px] text-gray-500">
          Reading from <b className="text-gray-800 break-all">{st.gmail_address}</b> ·{' '}
          {st.last_synced_at ? `last checked ${fmtD(st.last_synced_at.slice(0, 16))}` : 'not checked yet'} · also every day.
          Tap ⟳ at the top to check now.
        </p>
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

/** One Friday waiting for an answer: stake, then won / lost / didn't use it. */
function PromoAsk({ day, max, onSave }) {
  const [stake, setStake] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const save = (result) => {
    setErr('')
    if (result !== 'skipped' && !(+stake > 0 && +stake <= max)) { setErr(`Stake between ₹1 and ₹${max.toLocaleString('en-IN')}`); return }
    setBusy(true)
    onSave(day, +stake || 0, result).catch((e) => setErr(e.response?.data?.detail || "Couldn't save")).finally(() => setBusy(false))
  }
  return (
    <div className="py-2 border-t border-amber-200 first:border-t-0">
      <div className="flex items-center gap-2">
        <span className="w-20 text-xs font-black text-gray-800">{friLabel(day)}</span>
        <input className="flex-1 min-w-0 px-2 py-1.5 rounded-md border border-amber-300 bg-white text-sm" type="number"
          inputMode="decimal" min="1" max={max} placeholder="Stake ₹" value={stake} onChange={(e) => setStake(e.target.value)} />
      </div>
      <div className="flex gap-1.5 mt-1.5 pl-[88px]">
        <button disabled={busy} onClick={() => save('won')} className="flex-1 py-1.5 rounded-md bg-green-600 text-white text-xs font-black disabled:opacity-50">
          Won{+stake > 0 ? ` +${inr(Math.min(+stake, max))}` : ''}
        </button>
        <button disabled={busy} onClick={() => save('lost')} className="flex-1 py-1.5 rounded-md bg-red-500 text-white text-xs font-black disabled:opacity-50">Lost</button>
        <button disabled={busy} onClick={() => save('skipped')} className="px-2 py-1.5 rounded-md border border-amber-300 bg-white text-[10px] font-bold text-gray-600 disabled:opacity-50">Didn't use</button>
      </div>
      {err && <p className="text-[10px] text-red-600 mt-1 pl-[88px]">{err}</p>}
    </div>
  )
}

const friLabel = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : '')

/** 1xbet's Friday no-risk bet: every Friday since the current stretch began
 * is asked for until answered - the stake (up to ₹27k) and whether it won.
 * A win adds the stake as profit; a loss costs nothing. One line until
 * tapped open; a Friday waiting for an answer shows on that line. */
function FridayPromo({ onSaved }) {
  const [d, setD] = useState(null)
  const [open, setOpen] = useState(false)
  const [extra, setExtra] = useState('')        // another Friday to add by hand
  const load = () => betsPromos().then((r) => setD(r.data)).catch(() => setD(null))
  useEffect(() => { load() }, [])
  if (!d) return null
  const save = (day, stake, result) => betsSavePromo({ day, stake, result }).then(() => { setExtra(''); load(); onSaved() })
  const remove = (x) => betsDeletePromo(x).then(() => { load(); onSaved() })
  const asks = [...d.pending, ...(extra && !d.pending.includes(extra) ? [extra] : [])]
  const waiting = d.pending.length
  return (
    <div className={`rounded-md border ${waiting ? 'border-brand-400 bg-amber-50' : 'border-amber-200 bg-cream'}`}>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-3 py-2 text-left">
        <span className="text-xs font-black text-gray-900">Friday no-risk bet</span>
        {waiting > 0 && (
          <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-brand-400 text-white">
            {waiting === 1 ? `${friLabel(d.pending[0])} to fill in` : `${waiting} to fill in`}
          </span>
        )}
        <span className="flex-1" />
        {d.entries.length > 0 && (
          <span className="text-[11px] text-gray-500 whitespace-nowrap">
            <b className={pl(d.profit)}>+{inr(d.profit)}</b> · {d.won}W {d.lost}L
          </span>
        )}
        <span className="text-gray-400 text-xs">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          <p className="text-[10px] text-gray-500">
            Stake up to ₹{d.max.toLocaleString('en-IN')}: a win adds the stake as profit, a loss costs nothing.
          </p>
          {asks.length > 0 && <div className="mt-1">{asks.map((day) => <PromoAsk key={day} day={day} max={d.max} onSave={save} />)}</div>}
          <div className="flex items-center gap-2 mt-2">
            <span className="text-[10px] font-bold text-gray-400">Another Friday:</span>
            <input type="date" value={extra} onChange={(e) => setExtra(e.target.value)}
              className="px-2 py-1 rounded-md border border-amber-300 bg-white text-[11px] font-bold" />
          </div>
          {d.entries.length > 0 && (
            <div className="mt-2 pt-2 border-t border-gray-200">
              {d.entries.map((x) => (
                <div key={x.day} className="flex items-center gap-2 py-0.5 text-[11px]">
                  <span className="w-20 font-bold text-gray-700">{friLabel(x.day)}</span>
                  <span className={`flex-1 ${x.result === 'won' ? 'text-green-700' : x.result === 'lost' ? 'text-red-600' : 'text-gray-500'}`}>
                    {x.result === 'skipped' ? "didn't use it" : `${x.result}${x.stake ? ` · ₹${x.stake.toLocaleString('en-IN')}` : ''}`}
                  </span>
                  <span className={`font-black tabular-nums ${x.profit ? 'text-green-700' : 'text-gray-400'}`}>{x.profit ? `+${inr(x.profit)}` : '₹0'}</span>
                  <button onClick={() => remove(x.day)} className="text-gray-300 hover:text-red-500 px-1" aria-label="Remove">×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const shortDay = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '')
const longDay = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '')
const blockLabel = (lbl) => { const [a, b] = (lbl || '').split('|'); return `${shortDay(a)} – ${shortDay(b)}` }

/** Current stretch (default) · its weeks · the past, in the page. */
function ViewPicker({ views, view, setView }) {
  if (!views?.current) return null
  const same = (v) => v.from === view?.from && v.to === view?.to
  const chip = (v, label, sub, tone) => (
    <button key={`${v.from}|${v.to}`} onClick={() => setView(v)}
      className={`flex-shrink-0 px-3 py-1.5 rounded-md border text-left ${same(v)
        ? (tone === 'past' ? 'bg-gray-700 text-white border-gray-700' : 'bg-brand-400 text-white border-brand-400')
        : 'bg-white text-gray-700 border-amber-300'}`}>
      <p className="text-[11px] font-black whitespace-nowrap">{label}</p>
      {sub && <p className={`text-[9px] whitespace-nowrap ${same(v) ? 'text-white/80' : 'text-gray-400'}`}>{sub}</p>}
    </button>
  )
  return (
    <div className="card space-y-2">
      <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Showing</p>
      <div className="flex gap-2 flex-wrap">
        {chip(views.current, `Since ${shortDay(views.current.from)}`, `${views.current.bets} bets · current`)}
        {views.past && chip(views.past, 'Past', `before ${shortDay(views.current.from)} · ${views.past.bets} bets`, 'past')}
      </div>
      {views.blocks?.length > 0 && (
        <>
          <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Weeks since {shortDay(views.current.from)} · Fri – Thu</p>
          <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
            {views.blocks.map((b) => chip(b, `${shortDay(b.from)} – ${shortDay(b.to)}`))}
          </div>
        </>
      )}
    </div>
  )
}

/** What the numbers say: the odds that won, the odds range that made money,
 * and when betting went best. */
function Insights({ s }) {
  const i = s.insights || {}
  const enough = (r) => r.bets >= 3 && r.roi != null
  const odds = (s.by_odds || []).filter(enough)
  const sweet = odds.length ? odds.reduce((a, b) => (b.roi > a.roi ? b : a)) : null
  const sour = odds.length > 1 ? odds.reduce((a, b) => (b.roi < a.roi ? b : a)) : null
  const times = (s.by_time || []).filter(enough)
  const bestTime = times.length > 1 ? times.reduce((a, b) => (b.profit > a.profit ? b : a)) : null
  const tiles = [
    i.avg_odds_won != null && {
      label: 'Odds you won at', value: `${i.avg_odds_won}`, cls: 'text-green-700',
      sub: <>lost at {i.avg_odds_lost ?? '—'} on average · longest won {i.max_odds_won ?? '—'}</>,
    },
    sweet && {
      label: 'Sweet spot (odds)', value: sweet.label, cls: pl(sweet.roi),
      sub: <>ROI {sweet.roi > 0 ? '+' : ''}{sweet.roi}% over {sweet.bets} bets{sour && sour.label !== sweet.label ? <> · worst {sour.label} ({sour.roi > 0 ? '+' : ''}{sour.roi}%)</> : ''}</>,
    },
    bestTime && {
      label: 'Best time to bet', value: bestTime.label.split(' · ')[0], cls: pl(bestTime.profit),
      sub: <>{bestTime.label.split(' · ')[1]} · {inr(bestTime.profit)} over {bestTime.bets} bets</>,
    },
  ].filter(Boolean)
  if (!tiles.length) return null
  return (
    <div className="grid grid-cols-2 gap-2 mt-3">
      {tiles.map((x) => (
        <div key={x.label} className="rounded-md bg-white border border-amber-100 px-2.5 py-2">
          <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{x.label}</p>
          <p className={`text-sm font-black ${x.cls}`}>{x.value}</p>
          <p className="text-[10px] text-gray-500 leading-snug">{x.sub}</p>
        </div>
      ))}
    </div>
  )
}

function TopBets({ title, rows }) {
  if (!rows?.length) return null
  return (
    <div className="mt-3">
      <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">{title}</p>
      {rows.map((b, k) => (
        <div key={k} className="flex items-start gap-2 py-1 border-t border-gray-100 first:border-t-0 text-[11px]">
          <div className="flex-1 min-w-0">
            <p className="font-bold text-gray-800 truncate">{b.legs > 1 ? `Accumulator · ${b.legs} legs` : b.event}</p>
            <p className="text-gray-400">{fmtD(b.placed_at)} · {b.market ? `${b.market} ` : ''}@ {b.odds} · {inr(b.stake)}</p>
          </div>
          <p className={`font-black tabular-nums ${pl(b.profit)}`}>{b.profit > 0 ? '+' : ''}{inr(b.profit)}</p>
        </div>
      ))}
    </div>
  )
}

/** One day, or 3 or 5 days, ending on a chosen day: net profit, the days'
 * bars (tap one to drill into that day), insights, where it was won and
 * lost, the best and worst bets, and the bets themselves. */
const SPANS = [[1, '1 day'], [3, '3 days'], [5, '5 days']]

function DayDash({ min, max }) {
  const [span, setSpan] = useState(1)
  const [end, setEnd] = useState(max)
  const [d, setD] = useState(null)
  const [showBets, setShowBets] = useState(false)
  useEffect(() => { setEnd(max) }, [min, max])
  const from = addDays(end, 1 - span) < min ? min : addDays(end, 1 - span)
  useEffect(() => {
    setD(null)
    betsSummary({ frm: from, to: end }).then((r) => setD(r.data)).catch(() => setD({ total: null }))
  }, [from, end])
  const go = (n) => setEnd((e) => { const x = addDays(e, n * span); return x > max ? max : x < min ? min : x })
  const t = d?.total
  const days = Array.from({ length: Math.round((new Date(end) - new Date(from)) / 864e5) + 1 }, (_, k) => addDays(from, k))
  const byDay = Object.fromEntries((d?.by_day || []).map((r) => [r.label, r]))
  const peak = Math.max(1, ...days.map((x) => Math.abs(byDay[x]?.profit || 0)))
  const range = span === 1 ? friLabel(end) : `${shortDay(from)} – ${shortDay(end)}`
  return (
    <div className="card">
      <div className="flex items-center gap-2">
        <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest flex-1">Day by day</p>
        <div className="flex rounded-md border border-amber-300 overflow-hidden">
          {SPANS.map(([n, l]) => (
            <button key={n} onClick={() => setSpan(n)}
              className={`px-2 py-1 text-[10px] font-black ${span === n ? 'bg-field-950 text-white' : 'bg-white text-gray-600'}`}>{l}</button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between mt-2">
        <button onClick={() => go(-1)} disabled={end <= min} className="w-8 h-8 rounded-full border border-amber-300 text-brand-600 font-black disabled:opacity-30">‹</button>
        <div className="text-center">
          <p className="text-sm font-black text-gray-900">{range}</p>
          <input type="date" value={end} min={min} max={max} onChange={(e) => e.target.value && setEnd(e.target.value)}
            className="text-[10px] text-gray-400 bg-transparent text-center" />
        </div>
        <button onClick={() => go(1)} disabled={end >= max} className="w-8 h-8 rounded-full border border-amber-300 text-brand-600 font-black disabled:opacity-30">›</button>
      </div>

      {!d && <p className="text-xs text-gray-400 text-center py-6">Loading…</p>}
      {d && !t && <p className="text-sm text-gray-400 text-center py-6">No bets {span === 1 ? 'this day' : 'these days'}.</p>}
      {t && (
        <>
          <div className="text-center mt-2">
            <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Net</p>
            <p className={`text-3xl font-black ${pl(t.profit)}`}>{t.profit >= 0 ? '+' : ''}{inr(t.profit, 2)}</p>
            <p className="text-[11px] text-gray-500">
              {t.bets} bets · <span className="text-green-700 font-bold">{t.won} W</span>–<span className="text-red-600 font-bold">{t.lost} L</span>
              {t.win_rate != null && ` · ${t.win_rate}%`} · staked {inr(t.staked)} · ROI <b className={pl(t.roi)}>{t.roi > 0 ? '+' : ''}{t.roi}%</b>
            </p>
            {t.promo?.profit > 0 && <p className="text-[10px] text-green-700">incl. Friday no-risk +{inr(t.promo.profit)}</p>}
          </div>

          {span > 1 && (
            <div className="mt-3">
              <p className="text-[9px] text-gray-400 mb-1">Tap a day to open it on its own.</p>
              <div className="flex items-stretch gap-1.5">
                {days.map((x) => {
                  const r = byDay[x], p = r?.profit || 0
                  return (
                    <button key={x} onClick={() => { setSpan(1); setEnd(x) }}
                      className="flex-1 min-w-0 rounded-md border border-amber-100 bg-white px-1 py-1.5 flex flex-col items-center hover:bg-amber-50">
                      <div className="h-36 w-full flex flex-col justify-center items-center">
                        <div className="w-3/5 max-w-[44px] flex flex-col justify-end h-1/2">
                          {p > 0 && <div className="bg-green-600" style={{ height: `${(100 * p) / peak}%` }} />}
                        </div>
                        <div className="w-full border-t border-gray-400" />
                        <div className="w-3/5 max-w-[44px] h-1/2">
                          {p < 0 && <div className="bg-red-600" style={{ height: `${(-100 * p) / peak}%` }} />}
                        </div>
                      </div>
                      <p className={`text-[10px] font-black tabular-nums ${r ? pl(p) : 'text-gray-300'}`}>{r ? `${p >= 0 ? '+' : '−'}${Math.abs(p) >= 1000 ? `${(Math.abs(p) / 1000).toFixed(1)}k` : Math.round(Math.abs(p))}` : '—'}</p>
                      <p className="text-[9px] text-gray-500">{new Date(`${x}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' })} {+x.slice(8)}</p>
                      {r && <p className="text-[9px] text-gray-400">{r.won}–{r.lost}</p>}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <Insights s={d} />
          <TopBets title="Best wins" rows={d.insights?.top_wins} />
          <TopBets title="Worst losses" rows={d.insights?.top_losses} />
          <Breakdown bare title="By odds" rows={d.by_odds} />
          <Breakdown bare title="By sport" rows={d.by_sport} />
          <Breakdown bare title="By market" rows={d.by_market} />
          <Breakdown bare title="Time of day" rows={d.by_time} note="When the bet was placed." />
          <button onClick={() => setShowBets(!showBets)} className="mt-3 w-full text-center text-xs font-black text-brand-600 py-1.5 rounded-md border border-amber-200">
            {showBets ? 'Hide the bets ▴' : `See the ${t.bets} bets ▾`}
          </button>
          {showBets && <BetList period={{ from, to: end }} bare />}
        </>
      )}
    </div>
  )
}

export default function MyBets() {
  const nav = useNavigate()
  const loc = useLocation()
  const [st, setSt] = useState(null)
  const [s, setS] = useState(null)
  const [view, setView] = useState(null)        // {from, to}; null = the current stretch
  const [bump, setBump] = useState(0)           // a Friday answer changes the numbers: reload them
  const views = st?.views
  const shown = view || views?.current || null
  const isPast = !!(views?.past && shown && shown.from === views.past.from && shown.to === views.past.to)
  const load = () => betsStatus().then((r) => setSt(r.data)).catch(() => setSt({ connected: false, views: null }))
  useEffect(() => { load() }, [])
  useEffect(() => {
    if (!st) return
    setS(null)
    betsSummary(shown ? { frm: shown.from, to: shown.to } : {}).then((r) => setS(r.data)).catch(() => setS({ total: null }))
  }, [st, shown?.from, shown?.to, bump])
  const pickBlock = (lbl) => { const [from, to] = lbl.split('|'); setView({ from, to }); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  const gmail = new URLSearchParams(loc.search).get('gmail')
  const t = s?.total
  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-3 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-black tracking-tight">My bets</h1>
            <p className="text-[11px] text-gray-400 mt-0.5">
              1xbet · {isPast ? 'Past · ' : ''}{shown ? `${longDay(shown.from)} – ${longDay(shown.to)}` : ''}{t ? ` · ${t.bets} bets` : ''}
            </p>
          </div>
          <SyncButton st={st} onSynced={() => { setView(null); load() }} />
        </div>
      </div>
      <div className="px-5 mt-4 max-w-2xl space-y-3">
        {gmail === 'connected' && <p className="text-xs font-bold text-green-700">Gmail connected - tap "Check mail" to read your history.</p>}
        {gmail === 'error' && <p className="text-xs font-bold text-red-600">Gmail didn't connect - try again.</p>}
        <FridayPromo onSaved={() => setBump((b) => b + 1)} />
        <ViewPicker views={views} view={shown} setView={setView} />
        {isPast && (
          <p className="text-[11px] text-gray-600 bg-gray-100 rounded-md px-3 py-2">
            Past: every bet before {shortDay(views.current.from)} in one view, kept apart from the current numbers.
          </p>
        )}
        {!s && <p className="text-xs text-gray-400 text-center py-6">Loading…</p>}
        {s && !t && <p className="text-sm text-gray-400 text-center py-8">No bets in this stretch.</p>}
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
              {t.promo?.fridays > 0 && (
                <p className="text-[11px] text-gray-600 mt-1">
                  Includes Friday no-risk bets: <b className="text-green-700">+{inr(t.promo.profit)}</b> ({t.promo.won} won, {t.promo.lost} lost)
                </p>
              )}
              <Insights s={s} />
            </div>
            <DayDash min={(t.first || shown.from).slice(0, 10)} max={(t.last || shown.to).slice(0, 10)} />
            <div className="card -mx-3 px-3 py-4"><ProfitChart points={s.curve} start={shown?.from} /></div>
            {!isPast && s.by_block?.length > 1 && (
              <Breakdown title="Week by week" rows={[...s.by_block].reverse()} fmt={blockLabel} onRow={pickBlock}
                note="Friday to Thursday · newest first · tap a week to see just those days." />
            )}
            {isPast && <Breakdown title="By month" rows={s.by_month} />}
            <Breakdown title="By sport" rows={s.by_sport} />
            <Breakdown title="Single vs accumulator" rows={s.by_type} />
            <Breakdown title="By market" rows={s.by_market} note="Singles; accumulators on their own line." />
            <Breakdown title="By odds" rows={s.by_odds} />
            <Breakdown title="By stake" rows={s.by_stake} />
            <Breakdown title="Time of day" rows={s.by_time} note="When the bet was placed." />
            <Breakdown title="Day of the week" rows={s.by_weekday} />
            <Breakdown title="Tennis · by tour" rows={s.tennis_tour} note="Tennis singles." />
            <Breakdown title="Tennis · whole match or set" rows={s.tennis_part} />
            <Breakdown title="Tennis · tournaments" rows={s.tennis_events} note="Most bet on." />
          </>
        )}
        <AllBets period={shown} count={t?.bets} />
        {st && <MailCard st={st} />}
      </div>
    </div>
  )
}
