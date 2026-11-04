import { useCallback, useEffect, useState } from 'react'
import { listTripPlans, createTripPlan, getTripPlan, deleteTripPlan } from '../api/index.js'

/**
 * A discussion's Plan tab: the AI trip planner (backend trip_planner.py).
 * Ask in plain words; the plan runs on the server and its steps show here
 * live. A finished plan: the money (worked out in code), the weather and
 * road times, then day by day - every price marked Source (with its link)
 * or Estimate (with how it was worked out). "Change something" revises it.
 */
const POLL_MS = 2500
const INR = (n) => `₹${Math.round(n || 0).toLocaleString('en-IN')}`
// A price in the currency it was found in - "£24", "€8.50", "THB 350"
function money(n, cur) {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n)
  } catch { return `${cur} ${n}` }
}
const CAT = { transport: 'Getting there & between', stay: 'Stays', food: 'Food', activity: 'Sights & activities', local: 'Local transport', other: 'Other' }
const PER = { person: 'each', group: 'for the group', room: 'a room' }
const EXAMPLE = 'Plan a 4-day Jodhpur and Jaisalmer trip for 5 friends from Delhi, 20–24 December. Under ₹12,000 per person, with transport, stays, sightseeing, food and activities.'
const errText = (e, fallback) => (typeof e?.response?.data?.detail === 'string' ? e.response.data.detail : fallback)

function day(iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', opts)
}

export default function TripPlanner({ d, name, onChanged }) {
  const [plans, setPlans] = useState(null)       // the saved plans, as cards
  const [webSearch, setWebSearch] = useState(true)
  const [open, setOpen] = useState(null)         // the expanded card's id
  const [full, setFull] = useState({})           // id -> the plan in full, once opened
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const loadList = useCallback(async () => {
    try {
      const { data } = await listTripPlans(d.id)
      setPlans(data.plans)
      setWebSearch(data.web_search)
      return data.plans
    } catch { setErr("Couldn't load the plans.") }
  }, [d.id])
  const loadFull = useCallback(async (id) => {
    try {
      const { data } = await getTripPlan(d.id, id)
      setFull((f) => ({ ...f, [id]: data }))
      return data
    } catch { setErr("Couldn't open that plan.") }
  }, [d.id])

  // A plan still being made opens by itself, to show its steps
  useEffect(() => {
    loadList().then((ps) => {
      const live = ps?.find((p) => p.status === 'running')
      if (live) { setOpen(live.id); loadFull(live.id) }
    })
  }, [loadList, loadFull])

  const toggle = (id) => {
    if (open === id) { setOpen(null); return }
    setOpen(id)
    if (!full[id] || full[id].status === 'running') loadFull(id)
  }

  // While a plan is being made, follow its steps; done, refresh its card
  const runningId = (plans || []).find((p) => p.status === 'running')?.id
  useEffect(() => {
    if (!runningId) return
    const t = setInterval(async () => {
      const data = await loadFull(runningId)
      if (data && data.status !== 'running') { loadList(); onChanged?.() }
    }, POLL_MS)
    return () => clearInterval(t)
  }, [runningId, loadFull, loadList, onChanged])

  const run = async (text, parentId) => {
    setBusy(true); setErr('')
    try {
      const { data } = await createTripPlan(d.id, text, parentId)
      setPrompt('')
      setFull((f) => ({ ...f, [data.id]: data }))
      setOpen(data.id)
      await loadList()
    } catch (e) { setErr(errText(e, "Couldn't start the plan.")) } finally { setBusy(false) }
  }

  const remove = async (id) => {
    if (!confirm('Delete this plan?')) return
    try { await deleteTripPlan(d.id, id); setOpen(null); await loadList() } catch (e) { setErr(errText(e, "Couldn't delete it.")) }
  }

  const running = Boolean(runningId)
  return (
    <div className="px-4 pt-3 pb-6 max-w-2xl w-full space-y-3">
      <div className="bg-white border border-amber-200 p-3">
        <p className="text-sm font-black text-gray-900">✨ Plan a trip with AI</p>
        <p className="text-[11px] text-gray-500 mt-0.5">Say where, when, how many people and the budget - it finds places, weather, road times and prices, and works out the cost.</p>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder={EXAMPLE}
          className="input text-xs mt-2" />
        <div className="flex items-center gap-3 mt-2">
          <button onClick={() => run(prompt.trim())} disabled={busy || running || prompt.trim().length < 8}
            className="btn-primary text-xs py-1.5 px-4 disabled:opacity-50">{busy ? 'Starting…' : 'Plan it'}</button>
          {!prompt && <button onClick={() => setPrompt(EXAMPLE)} className="text-[11px] font-bold text-gray-500">Use the example</button>}
          {running && <span className="text-[11px] text-gray-500">A plan is being made…</span>}
        </div>
        {!webSearch && (
          <p className="text-[10px] text-gray-400 mt-2">Live web search is off: prices come from Wikivoyage where it lists them, the rest are marked as estimates.</p>
        )}
        {err && <p className="text-[11px] text-red-600 mt-2">{err}</p>}
      </div>

      {plans && !plans.length && (
        <p className="text-xs text-gray-400 text-center py-6">No plans yet - describe the trip above.</p>
      )}
      {plans?.length > 0 && (
        <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide pt-1">Saved plans · {plans.length}</p>
      )}
      {(plans || []).map((p) => {
        const f = full[p.id]
        return (
          <div key={p.id} className="space-y-3">
            <PlanCard p={p} isOpen={open === p.id} onToggle={() => toggle(p.id)}
              onDelete={p.created_by.toLowerCase() === (d.me || '').toLowerCase() && p.status !== 'running'
                ? () => remove(p.id) : null} />
            {open === p.id && (f
              ? <PlanView p={f} me={d.me} name={name} onRevise={(t) => run(t, p.id)} onRetry={() => run(p.prompt, p.parent_id)}
                  onDelete={() => remove(p.id)} busy={busy || running} />
              : <p className="text-[11px] text-gray-400 px-1">Opening…</p>)}
          </div>
        )
      })}
    </div>
  )
}

/** A saved plan at a glance: the trip, how many people, what it all costs -
 * and, for whoever made it, a bin to delete it (its research goes with it). */
function PlanCard({ p, isOpen, onToggle, onDelete }) {
  const dates = p.start_date
    ? `${day(p.start_date, { day: 'numeric', month: 'short' })} – ${day(p.end_date, { day: 'numeric', month: 'short' })}` : null
  const route = [p.origin, ...(p.destinations || [])].filter(Boolean).join(' → ')
  const facts = [p.travellers && `${p.travellers} people`, p.days && `${p.days} days`, dates].filter(Boolean).join(' · ')
  return (
    <div className={`relative bg-white border ${isOpen ? 'border-gray-900' : 'border-amber-200'}`}>
    {onDelete && (
      <button onClick={onDelete} aria-label="Delete this plan" title="Delete this plan"
        className="absolute left-2 bottom-2 p-1 text-gray-300 hover:text-red-600">
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
        </svg>
      </button>
    )}
    <button onClick={onToggle} aria-expanded={isOpen}
      className={`w-full text-left p-3 flex gap-3 items-start ${onDelete ? 'pb-8' : ''}`}>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-black text-gray-900 leading-snug">
          {p.title || (p.status === 'running' ? 'Planning…' : p.status === 'failed' ? "Didn't finish" : 'Trip plan')}
          {p.parent_id && <span className="ml-1.5 align-middle text-[9px] font-bold border border-gray-300 text-gray-500 px-1">REVISED</span>}
        </p>
        {facts && <p className="text-[11px] text-gray-600 mt-0.5">{facts}</p>}
        {route && <p className="text-[10px] text-gray-400 truncate">{route}</p>}
        {!p.title && <p className="text-[10px] text-gray-400 italic truncate">“{p.prompt}”</p>}
      </div>
      <div className="text-right shrink-0">
        {p.status === 'done' && p.group_total != null ? (
          <>
            <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wide">Whole trip</p>
            <p className="text-lg font-black text-gray-900 tabular-nums leading-tight">{INR(p.group_total)}</p>
            <p className="text-[10px] text-gray-500 tabular-nums">{INR(p.per_person)} each</p>
            {p.budget_per_person ? (
              <p className={`text-[10px] font-bold ${p.over_by ? 'text-red-600' : 'text-green-700'}`}>
                {p.over_by ? `${INR(p.over_by)} over budget` : 'within budget'}
              </p>
            ) : null}
          </>
        ) : p.status === 'running' ? (
          <p className="text-[11px] font-bold text-brand-600 animate-pulse">making…</p>
        ) : (
          <p className="text-[11px] font-bold text-red-600">failed</p>
        )}
        <p className="text-[10px] text-gray-400 mt-1">{isOpen ? '▾ Hide' : '▸ Details'}</p>
      </div>
    </button>
    </div>
  )
}

function PlanView({ p, me, name, onRevise, onRetry, onDelete, busy }) {
  const [change, setChange] = useState('')
  // `name` turns a username into the name to show (DiscussionDetail's dn); `me` is the caller's username
  const mine = (p.created_by || '').toLowerCase() === (me || '').toLowerCase()
  const shown = (u) => (typeof name === 'function' ? name(u) : u)
  const asked = (
    <p className="text-[11px] text-gray-500 italic border-l-2 border-gray-200 pl-2">“{p.prompt}” <span className="not-italic text-gray-400">- {mine ? 'you' : shown(p.created_by)}</span></p>
  )

  if (p.status === 'running' || p.status === 'failed') {
    return (
      <div className="bg-white border border-amber-200 p-3 space-y-2">
        {asked}
        <ul className="space-y-1">
          {(p.steps || []).map((s, i) => {
            const last = i === p.steps.length - 1 && p.status === 'running'
            return (
              <li key={i} className="text-[11px] flex gap-2 text-gray-700">
                <span className={last ? 'animate-pulse text-brand-600' : 'text-green-600'}>{last ? '●' : '✓'}</span>{s.text}
              </li>
            )
          })}
          {p.status === 'running' && !p.steps?.length && <li className="text-[11px] text-gray-500 animate-pulse">Starting…</li>}
        </ul>
        {p.status === 'failed' && (
          <div className="flex items-center gap-3">
            <p className="text-[11px] text-red-600 flex-1">{p.error || "It didn't finish."}</p>
            <button onClick={onRetry} disabled={busy} className="text-[11px] font-bold text-brand-600 disabled:opacity-50">Try again</button>
            {mine && <button onClick={onDelete} className="text-[11px] font-bold text-gray-400">Delete</button>}
          </div>
        )}
      </div>
    )
  }

  const { plan, budget: b, spec } = p
  const src = Object.fromEntries((p.sources || []).map((s) => [s.id, s]))
  const cats = Object.entries(b.by_category || {}).sort((x, y) => y[1] - x[1])
  const top = cats[0]?.[1] || 1
  return (
    <div className="space-y-3">
      {/* the card above says what and how much; this is the why */}
      <div className="bg-white border border-amber-200 p-3">
        {plan.summary && <p className="text-xs text-gray-700">{plan.summary}</p>}
        <p className="text-[10px] text-gray-400 mt-1">{b.rooms} room{b.rooms > 1 ? 's' : ''} for {b.travellers} people{spec.origin ? ` · from ${spec.origin}` : ''}</p>
        <div className="mt-2">{asked}</div>
      </div>

      <div className="bg-white border border-amber-200 p-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wide">
              Whole trip · {b.travellers} {b.travellers === 1 ? 'person' : 'people'}
            </p>
            <p className="text-2xl font-black text-gray-900 tabular-nums">{INR(b.group_total)}</p>
            {b.travellers > 1 && <p className="text-[11px] text-gray-500 tabular-nums">{INR(b.per_person)} per person</p>}
          </div>
          {b.budget_per_person && (
            <p className={`text-[11px] font-bold text-right ${b.over_by ? 'text-red-600' : 'text-green-700'}`}>
              {b.over_by ? `${INR(b.over_by * b.travellers)} over` : `${INR((b.budget_per_person - b.per_person) * b.travellers)} under`}
              <span className="block font-normal text-gray-500">budget {INR(b.budget_per_person * b.travellers)}</span>
              {b.travellers > 1 && <span className="block font-normal text-[10px] text-gray-400">{INR(b.budget_per_person)} per person</span>}
            </p>
          )}
        </div>
        {b.budget_per_person && (
          <div className="h-1.5 bg-gray-100 mt-2">
            <div className={`h-full ${b.over_by ? 'bg-red-500' : 'bg-green-600'}`}
              style={{ width: `${Math.min(100, (100 * b.per_person) / b.budget_per_person)}%` }} />
          </div>
        )}
        <div className="mt-3 space-y-1">
          {cats.map(([c, v]) => (
            <div key={c} className="flex items-center gap-2 text-[11px]">
              <span className="w-32 shrink-0 text-gray-600">{CAT[c] || c}</span>
              <span className="flex-1 h-1.5 bg-gray-100"><span className="block h-full bg-brand-400" style={{ width: `${(100 * v) / top}%` }} /></span>
              <span className="w-20 text-right shrink-0">
                <span className="block font-bold tabular-nums text-gray-800">{INR(v * b.travellers)}</span>
                {b.travellers > 1 && <span className="block text-[9px] text-gray-400 tabular-nums">{INR(v)} each</span>}
              </span>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-gray-400 mt-2">
          {plan.fx && Object.keys(plan.fx).length > 0 && (
            <span className="block text-gray-500 mb-0.5">
              Prices abroad converted at {Object.entries(plan.fx).map(([c, r]) => `${money(1, c)} = ₹${r}`).join(', ')}
              {plan.fx_date ? ` (rate of ${day(plan.fx_date, { day: 'numeric', month: 'short' })})` : ''}.
            </span>
          )}
          {b.travellers > 1 ? `Amounts are for all ${b.travellers}, with each person's share under each. ` : ''} {b.found_share}% of this cost comes from a source; the rest are estimates. Totals are added up by the app, not the AI. Stays are shared {b.rooms} room{b.rooms > 1 ? 's' : ''}.
        </p>
      </div>

      {(p.weather?.length > 0 || p.legs?.length > 0) && (
        <div className="bg-white border border-amber-200 p-3 space-y-2">
          {p.weather.map((w) => (
            <div key={w.place}>
              <p className="text-[10px] font-bold text-gray-500">
                {w.place} - {w.kind === 'forecast' ? 'forecast' : 'same dates last year (a guide)'}
              </p>
              <div className="flex gap-1.5 overflow-x-auto mt-1">
                {w.days.map((x) => (
                  <span key={x.date} className="shrink-0 text-[10px] bg-amber-50 border border-amber-100 px-1.5 py-1 text-gray-700">
                    {day(x.date, { day: 'numeric', month: 'short' })} · {Math.round(x.min)}–{Math.round(x.max)}°
                    {x.rain_chance != null && x.rain_chance > 20 ? ` · ${x.rain_chance}% rain` : ''}
                    {x.rain_mm ? ` · ${x.rain_mm} mm` : ''}
                  </span>
                ))}
              </div>
            </div>
          ))}
          {p.legs?.length > 0 && (
            <p className="text-[10px] text-gray-500">
              By road: {p.legs.map((l) => `${l.from} → ${l.to} ${l.km} km (~${l.hours} h)`).join(' · ')}
            </p>
          )}
        </div>
      )}

      {plan.days.map((dd) => (
        <div key={dd.day} className="bg-white border border-amber-200">
          <div className="px-3 py-2 border-b border-amber-100 bg-amber-50/50">
            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">
              Day {dd.day}{dd.date ? ` · ${day(dd.date)}` : ''}{dd.city ? ` · ${dd.city}` : ''}
            </p>
            <p className="text-sm font-black text-gray-900">{dd.title}</p>
          </div>
          <div className="divide-y divide-amber-100/70">
            {dd.items.map((it, i) => {
              const s = it.source === 'found' ? src[it.source_ids[0]] : null
              return (
                <div key={i} className="px-3 py-2 flex gap-2">
                  <span className="w-10 shrink-0 text-[10px] text-gray-400 tabular-nums pt-0.5">{it.time}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-gray-900">{it.title}</p>
                    {it.detail && <p className="text-[11px] text-gray-600">{it.detail}</p>}
                    {it.source === 'estimate' && it.cost > 0 && it.basis && (
                      <p className="text-[10px] text-gray-400 mt-0.5">Estimate: {it.basis}</p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    {it.cost > 0 ? (
                      <>
                        <p className="text-xs font-black text-gray-900 tabular-nums">{INR(it.cost)}</p>
                        {it.currency && it.currency !== 'INR' && it.cost_local != null && (
                          <p className="text-[10px] font-bold text-gray-600 tabular-nums">{money(it.cost_local, it.currency)}</p>
                        )}
                        <p className="text-[9px] text-gray-400">{PER[it.per]}{it.per !== 'person' ? ` · ${INR(it.per_person)} each` : ''}</p>
                      </>
                    ) : <p className="text-[10px] text-gray-400">free</p>}
                    {it.cost > 0 && (s
                      ? <a href={s.url} target="_blank" rel="noreferrer" title={`${s.title}${s.checked ? ` - checked ${s.checked}` : ''}`}
                          className="inline-block mt-0.5 text-[9px] font-bold border border-green-300 text-green-700 px-1">Source ↗</a>
                      : <span className="inline-block mt-0.5 text-[9px] font-bold border border-gray-200 text-gray-400 px-1">Estimate</span>)}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {(plan.tips?.length > 0 || plan.assumptions?.length > 0) && (
        <div className="bg-white border border-amber-200 p-3 space-y-2">
          {plan.tips?.length > 0 && (
            <div>
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">Tips</p>
              <ul className="mt-1 space-y-0.5">{plan.tips.map((t, i) => <li key={i} className="text-[11px] text-gray-700">· {t}</li>)}</ul>
            </div>
          )}
          {plan.assumptions?.length > 0 && (
            <div>
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">Assumed</p>
              <ul className="mt-1 space-y-0.5">{plan.assumptions.map((t, i) => <li key={i} className="text-[11px] text-gray-600">· {t}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {p.sources?.length > 0 && (
        <div className="bg-white border border-amber-200 p-3">
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">Sources</p>
          <ul className="mt-1 space-y-0.5">
            {p.sources.map((s) => (
              <li key={s.id} className="text-[11px] truncate">
                <a href={s.url} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">{s.title}</a>
                {s.checked && <span className="text-gray-400"> · checked {day(s.checked, { day: 'numeric', month: 'short', year: 'numeric' })}</span>}
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-gray-400 mt-1">Places: OpenStreetMap · Roads: OSRM · Weather: Open-Meteo. Web prices are what each page showed when it was checked - often for other dates; fares rise near holidays. Check before booking.</p>
        </div>
      )}

      <div className="bg-white border border-amber-200 p-3">
        <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">Change something</p>
        <div className="flex gap-2 mt-1">
          <input value={change} onChange={(e) => setChange(e.target.value)} placeholder="e.g. make day 2 cheaper, add a desert camp night"
            className="input text-xs flex-1" />
          <button onClick={() => { onRevise(change.trim()); setChange('') }} disabled={busy || change.trim().length < 4}
            className="btn-primary text-xs py-1.5 px-3 disabled:opacity-50">Revise</button>
        </div>
        {mine && <button onClick={onDelete} className="text-[10px] font-bold text-gray-400 mt-2">Delete this plan</button>}
      </div>
    </div>
  )
}
