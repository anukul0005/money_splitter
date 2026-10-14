import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getCardBillDetails, readCardBillDetails } from '../api'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const day = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '')
const longDay = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : 'No date')
const monthName = (period) => (period ? new Date(`${period}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) : '')
const Label = ({ children }) => <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">{children}</p>

const FILTERS = [['all', 'All'], ['spends', 'Spends'], ['credits', 'Payments & refunds'], ['fees', 'Fees']]

/**
 * One credit card bill's detailed breakup, read from its statement PDF
 * (backend card_details.py): the summary, spending by category, the
 * biggest merchants and every transaction. Read once in the background,
 * then saved - this polls while it's being read.
 */
export default function CardBill() {
  const { id } = useParams()
  const nav = useNavigate()
  const [d, setD] = useState(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const [category, setCategory] = useState(null)
  const started = useRef(false)

  const poll = async () => {
    try {
      let r = (await getCardBillDetails(id)).data
      if (r.status === 'none' && !started.current) {
        started.current = true
        await readCardBillDetails(id)
        r = { ...r, status: 'reading', step: 'Opening the statement email…' }
      }
      setD(r)
      if (r.status === 'reading') setTimeout(poll, 2000)
    } catch (e) {
      setError(e.response?.data?.detail || 'Could not load this bill.')
    }
  }
  useEffect(() => { poll() }, [id])

  const readAgain = async () => {
    setError('')
    try {
      await readCardBillDetails(id)
      setD((x) => ({ ...x, status: 'reading', step: 'Opening the statement email…' }))
      setTimeout(poll, 2000)
    } catch (e) { setError(e.response?.data?.detail || 'Could not start reading.') }
  }

  const b = d?.bill
  const header = (
    <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream border-b border-amber-100/60">
      <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Credit cards</button>
      <h1 className="text-xl font-black tracking-tight">{b?.card || 'Card bill'}</h1>
      {b && (
        <p className="text-xs text-gray-500 mt-1">
          {monthName(b.period)} bill · <b className="text-gray-900">{b.total_due != null ? INR(b.total_due) : '—'}</b>
          {b.due_date ? ` · due ${day(b.due_date)}` : ''}
        </p>
      )}
    </div>
  )

  if (error && !d) return <div className="pb-24">{header}<p className="px-5 mt-6 text-sm text-red-600">{error}</p></div>
  if (!d || d.status === 'reading') return (
    <div className="pb-24">{header}
      <div className="flex flex-col items-center py-16 gap-3 px-8 text-center">
        <div className="w-8 h-8 border-[3px] border-brand-400/30 border-t-brand-400 rounded-full animate-spin" />
        <p className="text-xs text-gray-600">{d?.step || 'Loading…'}</p>
        <p className="text-[11px] text-gray-400">The first read of a statement takes up to a minute. After that it opens instantly.</p>
      </div>
    </div>
  )
  if (d.status === 'error') return (
    <div className="pb-24">{header}
      <div className="px-5 mt-6 space-y-3">
        <p className="text-sm text-red-600">{d.error}</p>
        <button onClick={readAgain} className="btn-primary py-2.5 text-xs w-full">Try again</button>
      </div>
    </div>
  )

  const s = d.summary || {}
  const t = d.totals
  const txns = d.transactions.filter((x) => {
    if (category) return x.category === category && x.type === 'debit'
    if (filter === 'spends') return x.type === 'debit' && x.category !== 'Card fees & interest'
    if (filter === 'credits') return x.type === 'credit'
    if (filter === 'fees') return x.category === 'Card fees & interest'
    return true
  })
  const byDate = []
  for (const x of txns) {
    const last = byDate[byDate.length - 1]
    if (last && last.date === x.date) last.items.push(x)
    else byDate.push({ date: x.date, items: [x] })
  }
  const maxCat = Math.max(...d.by_category.map((c) => c.amount), 1)
  const rows = [
    ['Previous balance', s.previous_balance, ''],
    ['Payments & credits', s.payments_credits, '−'],
    ['Purchases & debits', s.purchases_debits, '+'],
    ['Fees & charges', s.fees_charges, '+'],
    ['Interest', s.interest, '+'],
    ['Taxes', s.taxes, '+'],
  ].filter((r) => r[1] != null)

  return (
    <div className="pb-24 md:pb-8">
      {header}
      <div className="px-4 md:px-5 mt-4 space-y-4 max-w-2xl">

        {/* Summary */}
        <div className="card space-y-2">
          <Label>Statement summary</Label>
          {s.period_from && s.period_to && (
            <p className="text-[11px] text-gray-400">{day(s.period_from)} – {day(s.period_to)}</p>
          )}
          <div className="space-y-1.5 pt-1">
            {rows.map(([label, v, sign]) => (
              <div key={label} className="flex items-center justify-between text-xs">
                <span className="text-gray-600">{label}</span>
                <span className={`font-bold ${sign === '−' ? 'text-green-700' : 'text-gray-800'}`}>{sign}{INR(v)}</span>
              </div>
            ))}
            <div className="flex items-center justify-between text-sm pt-1.5 border-t border-dashed border-amber-200">
              <span className="font-bold text-gray-900">Total due</span>
              <span className="font-black text-gray-900">{INR(s.total_due ?? b.total_due ?? 0)}</span>
            </div>
            {s.minimum_due != null && (
              <div className="flex items-center justify-between text-[11px] text-gray-500">
                <span>Minimum due</span><span>{INR(s.minimum_due)}</span>
              </div>
            )}
          </div>
          {d.check && (
            <p className={`text-[11px] font-bold pt-1 ${d.check.ok ? 'text-green-700' : 'text-amber-700'}`}>
              {d.check.ok
                ? '✓ The transactions below add up to this bill'
                : `The transactions add up to ${INR(d.check.expected)}, the bill says ${INR(d.check.total_due)} - a line or two may not have been read`}
            </p>
          )}
          {(s.credit_limit != null || s.reward_points != null) && (
            <p className="text-[11px] text-gray-400">
              {s.credit_limit != null ? `Limit ${INR(s.credit_limit)}` : ''}
              {s.available_limit != null ? ` · available ${INR(s.available_limit)}` : ''}
              {s.reward_points != null ? ` · ${Number(s.reward_points).toLocaleString('en-IN')} reward points` : ''}
            </p>
          )}
        </div>

        {/* By category */}
        <div className="card space-y-2.5">
          <div className="flex items-baseline justify-between">
            <Label>Where it went</Label>
            <span className="text-[11px] text-gray-500">{INR(t.spent)} spent{t.fees > 0 ? ` + ${INR(t.fees)} fees` : ''}</span>
          </div>
          {d.by_category.length === 0 && <p className="text-xs text-gray-500">No spends on this bill.</p>}
          {d.by_category.map((c) => (
            <button key={c.category} onClick={() => { setCategory(category === c.category ? null : c.category); setFilter('all') }}
              className={`w-full text-left ${category && category !== c.category ? 'opacity-40' : ''}`}>
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-gray-800">{c.category}</span>
                <span className="text-gray-600"><b className="text-gray-900">{INR(c.amount)}</b> · {c.share}%</span>
              </div>
              <div className="h-1.5 bg-amber-100 mt-1">
                <div className="h-1.5 bg-brand-400" style={{ width: `${(c.amount / maxCat) * 100}%` }} />
              </div>
              <p className="text-[10px] text-gray-400 mt-0.5">{c.count} transaction{c.count === 1 ? '' : 's'}</p>
            </button>
          ))}
          {category && <p className="text-[11px] text-brand-500 font-bold">Showing {category} below · tap it again for all</p>}
        </div>

        {/* Merchants */}
        {d.top_merchants.length > 0 && (
          <div className="card space-y-1.5">
            <Label>Biggest merchants</Label>
            {d.top_merchants.map((m, i) => (
              <div key={m.name} className="flex items-center justify-between text-xs py-0.5">
                <span className="text-gray-700"><span className="text-gray-300 mr-1.5">{i + 1}</span>{m.name}
                  {m.count > 1 && <span className="text-gray-400"> · {m.count}×</span>}</span>
                <span className="font-bold text-gray-900">{INR(m.amount)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Transactions */}
        <div className="card space-y-3">
          <div className="flex items-baseline justify-between">
            <Label>Transactions</Label>
            <span className="text-[11px] text-gray-400">{txns.length} of {t.count}</span>
          </div>
          {!category && (
            <div className="flex gap-1.5 flex-wrap">
              {FILTERS.map(([k, l]) => (
                <button key={k} onClick={() => setFilter(k)}
                  className={`px-2.5 py-1 text-[11px] font-bold border rounded-md ${filter === k ? 'bg-brand-400 border-brand-400 text-white' : 'border-amber-200 text-gray-600'}`}>
                  {l}
                </button>
              ))}
            </div>
          )}
          {byDate.map((g) => (
            <div key={g.date || 'none'}>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">{longDay(g.date)}</p>
              {g.items.map((x, i) => (
                <div key={i} className="flex items-start justify-between gap-3 py-1.5 border-b border-amber-100 last:border-0">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-gray-800 leading-snug">{x.description}</p>
                    <p className="text-[10px] text-gray-400">
                      {x.category}{x.subcategory ? ` · ${x.subcategory}` : ''}
                      {x.kind === 'refund' ? ' · refund' : x.kind === 'cashback' ? ' · cashback' : ''}
                    </p>
                  </div>
                  <span className={`text-xs font-bold shrink-0 ${x.type === 'credit' ? 'text-green-700' : 'text-gray-900'}`}>
                    {x.type === 'credit' ? '−' : ''}{INR(x.amount)}
                  </span>
                </div>
              ))}
            </div>
          ))}
          {txns.length === 0 && <p className="text-xs text-gray-500">Nothing here.</p>}
        </div>

        <p className="text-[10px] text-gray-400 text-center">
          Read from the statement PDF{d.read_at ? ` on ${new Date(d.read_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ''} ·{' '}
          <button onClick={readAgain} className="font-bold text-brand-500">Read again</button>
        </p>
        {error && <p className="text-xs text-red-600 text-center">{error}</p>}
      </div>
    </div>
  )
}
