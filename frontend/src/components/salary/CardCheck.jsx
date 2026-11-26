import { useEffect, useState } from 'react'
import { getSalaryCards, setCardCheck } from '../../api/index.js'

const INR = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = (iso) => `${+iso.slice(8, 10)} ${MON[+iso.slice(5, 7) - 1]}`

const STATUS = {
  mine:     { label: 'Mine',        chip: 'bg-brand-50 text-brand-600 border-brand-300' },
  group:    { label: 'In a group',  chip: 'bg-blue-50 text-blue-700 border-blue-200' },
  not_mine: { label: 'Not mine',    chip: 'bg-gray-100 text-gray-500 border-gray-200' },
  passed:   { label: 'Passed on',   chip: 'bg-purple-50 text-purple-700 border-purple-200' },
}
const TABS = [
  { k: 'todo',    label: 'To check', has: (l) => l.status === 'todo' },
  { k: 'mine',    label: 'Mine',     has: (l) => l.status === 'mine' },
  { k: 'skipped', label: 'Not counted', has: (l) => ['group', 'not_mine', 'passed'].includes(l.status) },
]

function Line({ l, onSet, busy }) {
  const todo = l.status === 'todo'
  const hint = l.suggest?.status
  return (
    <div className="py-2 border-b border-amber-100 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-gray-900 break-words">{l.merchant}</p>
          <p className="text-[10px] text-gray-400 break-words">{day(l.date)} · {l.card} · {l.title}</p>
          {l.passed_to && <p className="text-[10px] text-purple-700">Passed on to {l.passed_to} as a loan</p>}
          {todo && l.suggest && <p className="text-[10px] text-blue-700">Looks already entered: {l.suggest.why}</p>}
        </div>
        <p className="text-sm font-black text-gray-900 shrink-0">{INR(l.amount)}</p>
      </div>
      {l.status !== 'passed' && (
        <div className="flex items-center gap-1.5 mt-1.5">
          {todo ? (
            <>
              {[['mine', 'Mine'], ['group', 'In a group'], ['not_mine', 'Not mine']].map(([st, label]) => (
                <button key={st} disabled={busy} onClick={() => onSet([l.key], st)}
                  className={`px-2.5 py-1 text-[11px] font-bold border disabled:opacity-40 ${
                    st === 'mine' ? 'bg-brand-400 text-white border-brand-400'
                      : hint === st ? 'bg-blue-600 text-white border-blue-600' : 'bg-amber-50 text-gray-600 border-amber-200'}`}>
                  {label}
                </button>
              ))}
            </>
          ) : (
            <>
              <span className={`px-2 py-0.5 text-[10px] font-bold border ${STATUS[l.status].chip}`}>{STATUS[l.status].label}</span>
              <button disabled={busy} onClick={() => onSet([l.key], 'todo')} className="text-[11px] font-bold text-gray-400 disabled:opacity-40">Undo</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Salary dashboard → Credit cards: every card spend of the month, counted
 * only once ticked "Mine" (backend routers/salary.py _card_lines). "In a
 * group" and "Not mine" leave it out; lines passed on as loans are known
 * already. `onChanged` reloads the dashboard's totals.
 */
export default function CardCheck({ ym, onChanged }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState('todo')
  const [busy, setBusy] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const load = () => getSalaryCards(ym).then((r) => { setData(r.data); setErr('') }).catch(() => setErr("Couldn't load the card spends."))
  useEffect(() => { setData(null); setShowAll(false); load() }, [ym])
  useEffect(() => { if (data && tab === 'todo' && !data.lines.some((l) => l.status === 'todo')) setTab('mine') }, [data])

  const set = async (keys, status) => {
    setBusy(true)
    // At once on screen; the server's answer follows
    setData((d) => ({ ...d, lines: d.lines.map((l) => (keys.includes(l.key) ? { ...l, status } : l)) }))
    try { await setCardCheck(keys, status); onChanged?.() }
    catch { setErr("Couldn't save that - try again"); load() }
    finally { setBusy(false) }
  }

  if (err && !data) return <div className="card"><p className="text-xs text-red-600">{err}</p></div>
  if (!data) return <div className="card"><p className="text-xs text-gray-400">Loading card spends…</p></div>

  const sum = (f) => data.lines.filter(f).reduce((s, l) => s + l.amount, 0)
  const todo = data.lines.filter((l) => l.status === 'todo')
  const mine = sum((l) => l.status === 'mine')
  const shown = data.lines.filter(TABS.find((t) => t.k === tab).has)
  const list = showAll ? shown : shown.slice(0, 15)

  return (
    <div className="card">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest">Credit cards</h2>
        <span className="text-[10px] text-gray-400">counted once you tick Mine</span>
      </div>
      {!data.lines.length ? (
        <p className="text-xs text-gray-500 mt-2">No card spends this month - bills appear here once read on Credit Cards.</p>
      ) : (
        <>
          <p className="text-2xl font-black text-gray-900 mt-1">{INR(mine)} <span className="text-xs font-bold text-gray-400">counted</span></p>
          <p className="text-[11px] mt-0.5">
            {todo.length
              ? <span className="font-bold text-orange-600">{todo.length} to check · {INR(sum((l) => l.status === 'todo'))} not counted yet</span>
              : <span className="font-bold text-green-700">✓ All checked</span>}
            <span className="text-gray-400">
              {sum((l) => l.status === 'group') > 0 && ` · in groups ${INR(sum((l) => l.status === 'group'))}`}
              {sum((l) => l.status === 'passed') > 0 && ` · passed on ${INR(sum((l) => l.status === 'passed'))}`}
              {sum((l) => l.status === 'not_mine') > 0 && ` · not mine ${INR(sum((l) => l.status === 'not_mine'))}`}
            </span>
          </p>

          <div className="flex gap-1 mt-3 bg-amber-100/60 p-0.5">
            {TABS.map((t) => {
              const n = data.lines.filter(t.has).length
              return (
                <button key={t.k} onClick={() => { setTab(t.k); setShowAll(false) }}
                  className={`flex-1 py-1.5 text-[11px] font-bold ${tab === t.k ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
                  {t.label} {n > 0 && <span className="text-gray-400">{n}</span>}
                </button>
              )
            })}
          </div>

          {tab === 'todo' && todo.length > 1 && (
            <button disabled={busy}
              onClick={() => { if (confirm(`Mark all ${todo.length} remaining lines (${INR(sum((l) => l.status === 'todo'))}) as yours?`)) set(todo.map((l) => l.key), 'mine') }}
              className="mt-2 text-[11px] font-bold text-brand-600 disabled:opacity-40">
              Mark all {todo.length} as mine
            </button>
          )}

          <div className="mt-1">
            {list.map((l) => <Line key={l.key} l={l} onSet={set} busy={busy} />)}
            {!shown.length && <p className="text-xs text-gray-400 py-3 text-center">Nothing here.</p>}
          </div>
          {shown.length > 15 && (
            <button onClick={() => setShowAll((s) => !s)} className="text-[11px] font-bold text-brand-600 mt-1">
              {showAll ? 'Show fewer' : `Show all ${shown.length}`}
            </button>
          )}
          {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
        </>
      )}
    </div>
  )
}
