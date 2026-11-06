import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { recipesMe } from '../api'
import { Plan, dayLabel, planDate } from './Recipes'

/**
 * /recipes/day?day=1 - one day of the week's plan on its own page: how the
 * day stands, and its meals (planned, or what you had) - plus "other" for
 * anything had beyond them.
 */
export default function RecipeDay() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const day = parseInt(params.get('day')) || 1
  const [me, setMe] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => { recipesMe().then((r) => setMe(r.data)).catch(() => setErr("Couldn't load the day - try again.")) }, [])

  const plan = me?.plan
  const back = () => (window.history.length > 1 ? nav(-1) : nav('/recommend?tab=recipes'))
  const setLog = (log, weeks) => setMe((m) => ({ ...m, log, weeks: weeks || m.weeks }))

  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <button onClick={back} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <h1 className="text-xl font-black tracking-tight">{plan ? dayLabel(planDate(plan, day)) : `Day ${day}`}</h1>
        <p className="text-xs text-gray-400 mt-1">Day {day} of the week's plan - log each meal as you go</p>
      </div>
      <div className="px-5 mt-4 space-y-3 max-w-2xl">
        {!me && !err && <div className="card text-center py-10"><div className="w-6 h-6 mx-auto border-2 border-brand-400 border-t-transparent rounded-full animate-spin" /></div>}
        {err && <p className="text-sm text-red-600">{err}</p>}
        {me && plan?.days?.length > 0 && <Plan r={plan} log={me.log || {}} setLog={setLog} only={day} onProfile={() => nav('/recommend?tab=recipes')} />}
        {me && !plan?.days?.length && <p className="text-sm text-gray-500">No plan yet - make one on Recipes.</p>}
      </div>
    </div>
  )
}
