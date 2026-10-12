import { useState } from 'react'
import { setSavingsPlan } from '../../api'
import { INR, fmtDay, fmtWhen, Label } from './kit'

const EASE_TONE = { Easy: 'bg-green-50 text-green-700', Medium: 'bg-amber-50 text-amber-700', Hard: 'bg-red-50 text-red-600' }

// Personalized savings (/stats/recommendations): realistic cuts ranked by
// saving x ease with an AI-written tip each, and the plan switch. What's
// rising and progress against the plan live in the dashboard's own sections.
export default function Savings({ r, onChange }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [showAll, setShowAll] = useState(false)
  const togglePlan = async (active) => {
    setBusy(true); setErr('')
    try {
      onChange((await setSavingsPlan(active)).data)
    } catch { setErr('Could not update the plan.') } finally { setBusy(false) }
  }
  if (r.empty) return null
  const recs = showAll ? r.recommendations : r.recommendations.slice(0, 5)
  const t = r.tracking
  return (
    <div className="card space-y-3">
      <div>
        <Label>Ways to save · AI recommendations</Label>
        <p className="text-2xl font-black text-gray-900 mt-0.5">{INR(r.save_month)}<span className="text-sm font-bold text-gray-500"> a month</span></p>
        <p className="text-[11px] text-gray-500">about {INR(r.save_year)} a year, from realistic cuts to wants only</p>
      </div>
      <p className="text-xs text-gray-700 leading-relaxed bg-amber-50/60 border border-amber-100 px-3 py-2">{r.summary}</p>

      <div>
        <Label className="mb-1">Ranked by saving and how easy it is</Label>
        {recs.map((x, i) => (
          <div key={x.key} className="py-2 border-b border-amber-100 last:border-0">
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs font-bold text-gray-900">
                <span className="text-gray-300 mr-1">{i + 1}</span>{x.title}
                <span className={`ml-1.5 text-[9px] font-black uppercase px-1.5 py-0.5 ${EASE_TONE[x.ease_label]}`}>{x.ease_label}</span>
              </p>
              <p className="text-xs font-black text-green-700 shrink-0">save {INR(x.save_month)}/mo</p>
            </div>
            <p className="text-[11px] text-gray-600 mt-0.5 leading-snug">{x.tip}</p>
            <p className="text-[10px] text-gray-400 mt-0.5">
              Now {INR(x.monthly_now)}/mo → budget {INR(x.budget)}/mo (−{x.cut_pct}%) · {INR(x.save_year)} a year
            </p>
          </div>
        ))}
        {r.recommendations.length > 5 && (
          <button onClick={() => setShowAll((v) => !v)} className="w-full text-[11px] font-bold text-brand-500 pt-2">
            {showAll ? 'Show fewer' : `Show all ${r.recommendations.length}`}
          </button>
        )}
      </div>

      {t ? (
        <div className="border border-green-200 bg-green-50/50 px-3 py-2.5">
          <p className="text-[10px] font-bold text-green-700 uppercase tracking-widest">Your plan · since {fmtDay(t.started)}</p>
          {t.too_early ? (
            <p className="text-[11px] text-gray-600 mt-1">Started {t.days} day{t.days > 1 ? 's' : ''} ago - give it two weeks before judging.</p>
          ) : (
            <p className="text-sm font-black text-gray-900 mt-1">
              {t.saved_month >= 0 ? `Saving ${INR(t.saved_month)}/mo` : `Spending ${INR(-t.saved_month)}/mo more`}
              <span className="text-[11px] font-bold text-gray-500"> · target {INR(t.target_month)}/mo</span>
            </p>
          )}
          {!t.too_early && t.items.slice(0, 6).map((i) => (
            <p key={i.key} className="text-[11px] text-gray-600">
              {i.title}: {INR(i.actual)}/mo vs {INR(i.baseline)} before
              <span className={i.saved_month >= 0 ? ' text-green-700 font-bold' : ' text-red-600 font-bold'}>
                {' '}{i.saved_month >= 0 ? '−' : '+'}{INR(Math.abs(i.saved_month))}
              </span>
            </p>
          ))}
          <button disabled={busy} onClick={() => togglePlan(false)} className="text-[11px] font-bold text-gray-500 mt-2 disabled:opacity-50">
            {busy ? 'Working…' : 'Stop tracking'}
          </button>
        </div>
      ) : (
        <button disabled={busy || !r.recommendations.length} onClick={() => togglePlan(true)}
          className="btn-primary text-xs py-2.5 disabled:opacity-50">
          {busy ? 'Starting…' : 'Start this plan and track my savings'}
        </button>
      )}
      {err && <p className="text-xs text-red-600">{err}</p>}
      <p className="text-[10px] text-gray-400 border-t border-dashed border-amber-200 pt-2">
        From your last 12 months - personal spending plus your share of shared. Needs (groceries, rent, bills, health,
        transport) aren't cut, only wants, by an amount that's realistic for each. Advice by {r.advice_by === 'llm' ? 'AI, from category totals only' : 'built-in tips'}.
        {r.computed_at && <> Made {fmtWhen(r.computed_at)}, refreshes after {r.refresh_after} new expenses ({r.changes_since} so far).</>}
      </p>
    </div>
  )
}
