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
const CAT = { transport: 'Getting there & between', stay: 'Stays', food: 'Food', activity: 'Sights & activities', local: 'Local transport', other: 'Other' }
const PER = { person: 'each', group: 'for the group', room: 'a room' }
const EXAMPLE = 'Plan a 4-day Jodhpur and Jaisalmer trip for 5 friends from Delhi, 20–24 December. Under ₹12,000 per person, with transport, stays, sightseeing, food and activities.'
const errText = (e, fallback) => (typeof e?.response?.data?.detail === 'string' ? e.response.data.detail : fallback)

function day(iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', opts)
}

export default function TripPlanner({ d, name, onChanged }) {
  const [plans, setPlans] = useState(null)
  const [webSearch, setWebSearch] = useState(true)
  const [sel, setSel] = useState(null)          // the open plan, in full
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const loadList = useCallback(async (pick) => {
    try {
      const { data } = await listTripPlans(d.id)
      setPlans(data.plans)
      setWebSearch(data.web_search)
      const id = pick ?? data.plans[0]?.id
      if (id) setSel((await getTripPlan(d.id, id)).data)
      else setSel(null)
    } catch { setErr("Couldn't load the plans.") }
  }, [d.id])
  useEffect(() => { loadList() }, [loadList])

  // While a plan is being made, follow its steps
  useEffect(() => {
    if (sel?.status !== 'running') return
    const t = setInterval(async () => {
      try {
        const { data } = await getTripPlan(d.id, sel.id)
        setSel(data)
        if (data.status !== 'running') { loadList(data.id); onChanged?.() }
      } catch { /* the next poll */ }
    }, POLL_MS)
    return () => clearInterval(t)
  }, [sel?.id, sel?.status, d.id, loadList, onChanged])

  const run = async (text, parentId) => {
    setBusy(true); setErr('')
    try {
      const { data } = await createTripPlan(d.id, text, parentId)
      setSel(data); setPrompt('')
      setPlans((ps) => [{ ...data }, ...(ps || [])])
    } catch (e) { setErr(errText(e, "Couldn't start the plan.")) } finally { setBusy(false) }
  }

  const remove = async () => {
    if (!confirm('Delete this plan?')) return
    try { await deleteTripPlan(d.id, sel.id); await loadList() } catch (e) { setErr(errText(e, "Couldn't delete it.")) }
  }

  const running = (plans || []).some((p) => p.status === 'running')
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

      {plans?.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {plans.map((p, i) => (
            <button key={p.id} onClick={() => loadList(p.id)}
              className={`shrink-0 text-[11px] font-bold px-2.5 py-1.5 border ${sel?.id === p.id ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200'}`}>
              {p.parent_id ? 'Revised' : 'Plan'} {plans.length - i}
              {p.status === 'done' && p.per_person != null && <span className="font-normal"> · {INR(p.per_person)}</span>}
              {p.status === 'running' && <span className="font-normal"> · making…</span>}
              {p.status === 'failed' && <span className="font-normal"> · failed</span>}
            </button>
          ))}
        </div>
      )}

      {plans && !plans.length && (
        <p className="text-xs text-gray-400 text-center py-6">No plans yet - describe the trip above.</p>
      )}
      {sel && <PlanView p={sel} name={name} onRevise={(t) => run(t, sel.id)} onRetry={() => run(sel.prompt, sel.parent_id)}
        onDelete={remove} busy={busy || running} />}
    </div>
  )
}

function PlanView({ p, name, onRevise, onRetry, onDelete, busy }) {
  const [change, setChange] = useState('')
  const mine = p.created_by.toLowerCase() === name.toLowerCase()
  const asked = (
    <p className="text-[11px] text-gray-500 italic border-l-2 border-gray-200 pl-2">“{p.prompt}” <span className="not-italic text-gray-400">- {p.created_by}</span></p>
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
      <div className="bg-white border border-amber-200 p-3">
        <p className="text-base font-black text-gray-900 leading-snug">{plan.title}</p>
        <p className="text-[11px] text-gray-500 mt-0.5">
          {spec.days} days{spec.start_date ? ` · ${day(spec.start_date, { day: 'numeric', month: 'short' })} – ${day(spec.end_date, { day: 'numeric', month: 'short' })}` : ''}
          {' · '}{b.travellers} people · {b.rooms} room{b.rooms > 1 ? 's' : ''}
          {spec.origin ? ` · from ${spec.origin}` : ''}
        </p>
        {plan.summary && <p className="text-xs text-gray-700 mt-2">{plan.summary}</p>}
        <div className="mt-2">{asked}</div>
      </div>

      <div className="bg-white border border-amber-200 p-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wide">Per person</p>
            <p className="text-2xl font-black text-gray-900 tabular-nums">{INR(b.per_person)}</p>
            <p className="text-[11px] text-gray-500">Group total {INR(b.group_total)}</p>
          </div>
          {b.budget_per_person && (
            <p className={`text-[11px] font-bold text-right ${b.over_by ? 'text-red-600' : 'text-green-700'}`}>
              {b.over_by ? `${INR(b.over_by)} over` : `${INR(b.budget_per_person - b.per_person)} under`}
              <span className="block font-normal text-gray-500">budget {INR(b.budget_per_person)}</span>
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
              <span className="w-16 text-right font-bold tabular-nums text-gray-800">{INR(v)}</span>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-gray-400 mt-2">
          {b.found_share}% of this cost comes from a source; the rest are estimates. Totals are added up by the app, not the AI. Stays are shared {b.rooms} room{b.rooms > 1 ? 's' : ''}.
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
                        <p className="text-[9px] text-gray-400">{PER[it.per]}{it.per !== 'person' ? ` · ${INR(it.per_person)} each` : ''}</p>
                      </>
                    ) : <p className="text-[10px] text-gray-400">free</p>}
                    {it.cost > 0 && (s
                      ? <a href={s.url} target="_blank" rel="noreferrer" title={s.title}
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
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-gray-400 mt-1">Places: OpenStreetMap · Roads: OSRM · Weather: Open-Meteo. Check prices before booking.</p>
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
