import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getSalaryMerchants } from '../../api/index.js'

const INR = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MON = MONTHS.map((m) => m.slice(0, 3))
const mon = (ym) => MONTHS[+ym.slice(5, 7) - 1]
const day = (iso) => `${+iso.slice(8, 10)} ${MON[+iso.slice(5, 7) - 1]}`

function Delta({ now, before }) {
  if (!before) return <span className="text-[10px] font-bold text-gray-400">new</span>
  const d = now - before
  if (Math.abs(d) < 1) return <span className="text-[10px] font-bold text-gray-400">same</span>
  return (
    <span className={`text-[10px] font-bold ${d > 0 ? 'text-red-600' : 'text-green-700'}`}>
      {d > 0 ? '▲' : '▼'} {INR(Math.abs(d))}
    </span>
  )
}

function Row({ m, max, nav }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="py-1.5 border-b border-amber-100 last:border-0">
      <button onClick={() => setOpen((o) => !o)} className="w-full text-left">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-bold text-gray-800 break-words min-w-0">{m.name}</span>
          <span className="shrink-0 text-right">
            <span className="text-xs font-black text-gray-900">{INR(m.amount)}</span>
            <span className="text-[10px] text-gray-400"> · {m.count}×</span>
          </span>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <div className="h-1.5 bg-amber-100 flex-1">
            <div className="h-full bg-brand-400" style={{ width: `${(m.amount / max) * 100}%` }} />
          </div>
          <span className="w-20 text-right shrink-0"><Delta now={m.amount} before={m.prev_amount} /></span>
        </div>
      </button>
      {open && (
        <div className="mt-1.5 pl-2 border-l-2 border-amber-200 space-y-1">
          {m.items.map((it, i) => (
            <button key={i} disabled={!it.group_id} onClick={() => it.group_id && nav(`/groups/${it.group_id}`)}
              className="w-full text-left flex items-start justify-between gap-2">
              <span className="min-w-0">
                <span className="block text-[11px] text-gray-700 break-words">{it.title}</span>
                <span className="block text-[10px] text-gray-400">{day(it.date)} · {it.source}</span>
              </span>
              <span className="text-[11px] font-bold text-gray-900 shrink-0">{INR(it.amount)}</span>
            </button>
          ))}
          {m.prev_count > 0 && <p className="text-[10px] text-gray-400">Last month: {INR(m.prev_amount)} over {m.prev_count}×</p>}
        </div>
      )}
    </div>
  )
}

/**
 * Salary dashboard → how the month fared, by merchant (backend
 * routers/salary.py /merchants): card lines ticked Mine, monthly expenses
 * and your share of group ones, under one name per payee, each against the
 * month before.
 */
export default function MerchantBreakdown({ ym, version = 0 }) {
  const nav = useNavigate()
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [all, setAll] = useState(false)
  useEffect(() => { setAll(false) }, [ym])
  useEffect(() => {
    setErr('')
    getSalaryMerchants(ym).then((r) => setData(r.data)).catch(() => setErr("Couldn't load the merchant breakdown."))
  }, [ym, version])

  if (err) return <div className="card"><p className="text-xs text-red-600">{err}</p></div>
  if (!data) return <div className="card"><p className="text-xs text-gray-400">Loading merchants…</p></div>

  const list = all ? data.merchants : data.merchants.slice(0, 15)
  const max = Math.max(1, ...data.merchants.map((m) => m.amount))
  const d = data.total - data.prev_total

  return (
    <div className="card">
      <h2 className="text-xs font-black text-gray-500 uppercase tracking-widest">How {mon(data.month)} fared · by merchant</h2>
      {!data.merchants.length ? (
        <p className="text-xs text-gray-500 mt-2">Nothing spent yet this month.</p>
      ) : (
        <>
          <p className="text-[11px] text-gray-600 mt-1">
            <span className="font-black text-gray-900">{INR(data.total)}</span> across {data.merchants.length} merchants
            {data.prev_total > 0 && (
              <> · {mon(data.prev)} was {INR(data.prev_total)}{' '}
                <span className={`font-bold ${d > 0 ? 'text-red-600' : 'text-green-700'}`}>({d > 0 ? '+' : '−'}{INR(Math.abs(d))})</span></>
            )}
          </p>
          <div className="flex justify-end text-[10px] text-gray-400 mt-2 pr-0.5">vs {mon(data.prev).slice(0, 3)}</div>
          {list.map((m) => <Row key={m.name} m={m} max={max} nav={nav} />)}
          {data.merchants.length > 15 && (
            <button onClick={() => setAll((a) => !a)} className="text-[11px] font-bold text-brand-600 mt-1">
              {all ? 'Show fewer' : `All ${data.merchants.length} merchants`}
            </button>
          )}
          {data.gone.count > 0 && (
            <p className="text-[10px] text-gray-400 mt-2">
              Not this month: {data.gone.count} from {mon(data.prev)} ({INR(data.gone.amount)}) - {data.gone.top.map((g) => g.name).join(', ')}
            </p>
          )}
        </>
      )}
      <p className="text-[10px] text-gray-400 mt-2">Card spends show here once ticked Mine. Group expenses count at your share.</p>
    </div>
  )
}
