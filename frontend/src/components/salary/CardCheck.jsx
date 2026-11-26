import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getSalaryCards, setCardCheck } from '../../api/index.js'

const INR = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = (iso) => (iso ? `${+iso.slice(8, 10)} ${MON[+iso.slice(5, 7) - 1]}` : '')

const LABEL = { mine: 'Counted', group: 'In a group', not_mine: 'Not mine', passed: 'Passed on' }
const FIXES = [['not_mine', 'Not mine'], ['group', 'Already in a group'], ['mine', 'Count it']]

function Line({ l, onFix, busy }) {
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(false)
  const counted = l.status === 'mine'
  const fix = async (st) => { await onFix([l.key], st, remember); setOpen(false); setRemember(false) }
  return (
    <div className="py-2 border-b border-amber-100 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={`text-xs font-bold break-words ${counted ? 'text-gray-900' : 'text-gray-400 line-through decoration-gray-300'}`}>{l.merchant}</p>
          <p className="text-[10px] text-gray-400 break-words">{day(l.date)} · {l.title}</p>
          {l.why && (
            <p className="text-[10px] text-gray-500">
              {LABEL[l.status]} - {l.group_id
                ? <button onClick={() => nav(`/groups/${l.group_id}`)} className="underline">{l.why}</button>
                : l.why}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className={`text-xs font-black ${counted ? 'text-gray-900' : 'text-gray-400'}`}>{INR(l.amount)}</p>
          {l.status !== 'passed' && (
            l.fixed
              ? <button disabled={busy} onClick={() => onFix([l.fixed === 'rule' ? `rule:${l.merchant_key}` : l.key], 'auto', false)}
                  className="text-[10px] font-bold text-gray-400 disabled:opacity-40">Undo fix</button>
              : <button onClick={() => setOpen((o) => !o)} className="text-[10px] font-bold text-brand-600">{open ? 'Close' : 'Fix'}</button>
          )}
        </div>
      </div>
      {open && (
        <div className="mt-1.5 p-2 bg-amber-50 border border-amber-200">
          <div className="flex flex-wrap gap-1.5">
            {FIXES.filter(([st]) => st !== l.status).map(([st, label]) => (
              <button key={st} disabled={busy} onClick={() => fix(st)}
                className="px-2.5 py-1 text-[11px] font-bold border border-amber-300 bg-white text-gray-700 disabled:opacity-40">{label}</button>
            ))}
          </div>
          {!l.whole_bill && (
            <label className="flex items-center gap-1.5 mt-1.5 text-[10px] text-gray-600">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Every {l.merchant} spend, from now on
            </label>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Salary dashboard → Credit cards: the bills made this salary month (a bill
 * made on 23 Nov covers 24 Oct - 23 Nov, so it's November's), every line
 * counted on its own unless it's already entered in a group or passed on as
 * a loan (backend routers/salary.py _card_lines). Lines are folded away -
 * "Fix" on one, optionally for its merchant from now on, is the only work.
 */
export default function CardCheck({ ym, onChanged }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [show, setShow] = useState(null)        // null | 'counted' | 'not'
  const [all, setAll] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = () => getSalaryCards(ym).then((r) => { setData(r.data); setErr('') }).catch(() => setErr("Couldn't load the card spends."))
  useEffect(() => { setData(null); setShow(null); load() }, [ym])

  const fix = async (keys, status, remember) => {
    setBusy(true)
    try { await setCardCheck(keys, status, remember); await load(); onChanged?.() }
    catch { setErr("Couldn't save that - try again") }
    finally { setBusy(false) }
  }

  if (err && !data) return <div className="card"><p className="text-xs text-red-600">{err}</p></div>
  if (!data) return <div className="card"><p className="text-xs text-gray-400">Loading card spends…</p></div>

  const t = data.totals
  const counted = data.lines.filter((l) => l.status === 'mine')
  const notCounted = data.lines.filter((l) => l.status !== 'mine')
  const list = show === 'counted' ? counted : show === 'not' ? notCounted : []
  const shown = all ? list : list.slice(0, 20)
  const mk = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

  return (
    <div className="card" id="sal-cards">
      <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest">Credit cards</h2>
      {!data.lines.length ? (
        <p className="text-xs text-gray-500 mt-2">No card bill made this month yet - each bill counts in the month it's made.</p>
      ) : (
        <>
          <p className="text-2xl font-black text-gray-900 mt-1">{INR(t.mine)}</p>
          <p className="text-[11px] text-gray-500">
            counted from {data.bills.length} bill{data.bills.length === 1 ? '' : 's'}
            {(t.group || t.passed || t.not_mine) ? ' · left out: ' : ''}
            {[t.group && `in groups ${INR(t.group)}`, t.passed && `passed on ${INR(t.passed)}`, t.not_mine && `not mine ${INR(t.not_mine)}`].filter(Boolean).join(' · ')}
          </p>

          <div className="mt-2 space-y-1">
            {data.bills.map((b) => (
              <div key={b.bill_id} className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="min-w-0 text-gray-700">
                  <span className="font-bold">{b.card}</span>
                  <span className="text-gray-400"> · bill {day(b.bill_date)} · {day(b.from)}–{day(b.to)}</span>
                </span>
                <span className="font-black text-gray-900 shrink-0">{INR(b.counted)}</span>
              </div>
            ))}
          </div>

          <div className="flex gap-3 mt-3">
            <button onClick={() => { setShow(show === 'counted' ? null : 'counted'); setAll(false) }}
              className={`text-[11px] font-bold ${show === 'counted' ? 'text-gray-900' : 'text-brand-600'}`}>
              {show === 'counted' ? 'Hide' : 'See'} {counted.length} counted
            </button>
            {notCounted.length > 0 && (
              <button onClick={() => { setShow(show === 'not' ? null : 'not'); setAll(false) }}
                className={`text-[11px] font-bold ${show === 'not' ? 'text-gray-900' : 'text-brand-600'}`}>
                {show === 'not' ? 'Hide' : 'See'} {notCounted.length} left out
              </button>
            )}
          </div>
          {show && (
            <div className="mt-1">
              {shown.map((l) => <Line key={l.key} l={{ ...l, merchant_key: mk(l.merchant) }} onFix={fix} busy={busy} />)}
              {list.length > 20 && (
                <button onClick={() => setAll((a) => !a)} className="text-[11px] font-bold text-brand-600 mt-1">
                  {all ? 'Show fewer' : `Show all ${list.length}`}
                </button>
              )}
            </div>
          )}

          {data.rules.length > 0 && (
            <div className="mt-3 pt-2 border-t border-amber-100">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Your rules</p>
              <div className="flex flex-wrap gap-1.5">
                {data.rules.map((r) => (
                  <span key={r.merchant_key} className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] border border-amber-200 bg-amber-50 text-gray-700">
                    {r.merchant} → {LABEL[r.status]}
                    <button disabled={busy} onClick={() => fix([`rule:${r.merchant_key}`], 'auto', false)} className="text-gray-400 font-bold" aria-label={`Remove rule for ${r.merchant}`}>×</button>
                  </span>
                ))}
              </div>
            </div>
          )}
          {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
          <p className="text-[10px] text-gray-400 mt-2">
            Counted on its own. Left out: spends you already entered in a group or Monthly, and ones passed on as loans. Tap Fix on anything wrong.
          </p>
        </>
      )}
    </div>
  )
}
