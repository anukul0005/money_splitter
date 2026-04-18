import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getGroups, createGroup, updateGroup } from '../api'
import { useUser } from '../UserContext'
import LoadingSpinner from '../components/LoadingSpinner'

const MONTH_NAMES = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
const MONTH_FULL  = ['January','February','March','April','May','June','July','August','September','October','November','December']

const getTargetName = (my) => {
  if (!my) return ''
  const [y, m] = my.split('-')
  return `MONTHLY EXPENSES ${MONTH_NAMES[parseInt(m) - 1]} ${y}`
}

export default function MonthlyGroup() {
  const nav  = useNavigate()
  const user = useUser()

  const now = new Date()
  const [monthMonth,   setMonthMonth]   = useState(() => now.getMonth() + 1)
  const [monthYearNum, setMonthYearNum] = useState(() => now.getFullYear())
  const [groups,       setGroups]       = useState([])
  const [loading,      setLoading]      = useState(true)
  const [submitting,   setSubmitting]   = useState(false)
  const [error,        setError]        = useState('')

  const yearOptions = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]
  const monthYear   = `${monthYearNum}-${String(monthMonth).padStart(2, '0')}`
  const targetName  = getTargetName(monthYear)

  useEffect(() => {
    getGroups()
      .then((r) => setGroups(r.data))
      .finally(() => setLoading(false))
  }, [])

  const visibleGroups = groups.filter((g) =>
    (g.member_names ?? []).some((n) => n.toLowerCase() === user?.name?.toLowerCase())
  )

  const exactMatch = visibleGroups.find((g) => g.name === targetName)
  const fuzzyMatch = !exactMatch && monthYear ? (() => {
    const [y, m] = monthYear.split('-')
    const mon = MONTH_NAMES[parseInt(m) - 1].toLowerCase()
    return visibleGroups.find((g) => {
      const lower = g.name.toLowerCase()
      return (lower.includes(mon) || lower.includes(y)) &&
             (g.member_names ?? []).length === 1
    })
  })() : null

  const handleSubmit = async () => {
    if (!monthYear || !user?.name) return
    setError('')
    setSubmitting(true)
    try {
      if (exactMatch) {
        nav(`/groups/${exactMatch.id}`)
        return
      }
      if (fuzzyMatch) {
        await updateGroup(fuzzyMatch.id, { name: targetName, description: null, category: 'personal', members_add: [], members_remove: [] })
        nav(`/groups/${fuzzyMatch.id}`)
        return
      }
      const r = await createGroup({ name: targetName, description: '', category: 'personal', emoji: '💰', members: [user.name] })
      nav(`/groups/${r.data.id}`)
    } catch (err) {
      setError(err?.response?.data?.detail || 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  if (loading) return <LoadingSpinner />

  const btnLabel = submitting
    ? (exactMatch ? 'Opening…' : fuzzyMatch ? 'Renaming…' : 'Creating…')
    : (exactMatch ? 'Open Group' : fuzzyMatch ? 'Rename & Open' : 'Create Group')

  return (
    <div className="pb-32 md:pb-10">
      {/* Header */}
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream border-b border-amber-100/60 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => nav(-1)} className="btn-ghost">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div>
            <h1 className="text-xl font-black tracking-tight">Monthly Tracker</h1>
            <p className="text-xs text-gray-400 font-medium mt-0.5">Track personal expenses by month</p>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="px-5 mt-6 space-y-6 max-w-lg">

        {/* Month picker */}
        <div>
          <label className="label">Select Month</label>
          <div className="grid grid-cols-3 gap-2 mt-2">
            {MONTH_FULL.map((name, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setMonthMonth(i + 1)}
                className={`py-3 text-xs font-bold border transition-colors ${
                  monthMonth === i + 1
                    ? 'bg-brand-400 text-gray-900 border-brand-400'
                    : 'bg-cream text-gray-500 border-amber-200 hover:text-gray-700 hover:border-amber-300'
                }`}
              >
                {MONTH_NAMES[i]}
              </button>
            ))}
          </div>
        </div>

        {/* Year picker */}
        <div>
          <label className="label">Select Year</label>
          <div className="flex gap-2 mt-2">
            {yearOptions.map((y) => (
              <button
                key={y}
                type="button"
                onClick={() => setMonthYearNum(y)}
                className={`flex-1 py-3 text-sm font-bold border transition-colors ${
                  monthYearNum === y
                    ? 'bg-brand-400 text-gray-900 border-brand-400'
                    : 'bg-cream text-gray-500 border-amber-200 hover:text-gray-700'
                }`}
              >
                {y}
              </button>
            ))}
          </div>
        </div>

        {/* Status card */}
        <div className="border border-amber-200 bg-amber-50/60 px-4 py-3 space-y-1">
          <p className="text-[10px] font-black text-amber-700 tracking-widest">GROUP NAME</p>
          <p className="text-sm font-bold text-gray-800">{targetName}</p>
          {exactMatch && (
            <p className="text-xs text-brand-700 font-semibold mt-1">✓ Group already exists — will open it</p>
          )}
          {fuzzyMatch && !exactMatch && (
            <p className="text-xs text-amber-700 font-semibold mt-1">Similar group found — will rename "{fuzzyMatch.name}"</p>
          )}
          {!exactMatch && !fuzzyMatch && (
            <p className="text-xs text-gray-400 mt-1">A new group will be created for you</p>
          )}
        </div>

        {error && (
          <p className="text-sm text-red-500 bg-red-50 border border-red-100 px-4 py-3">{error}</p>
        )}
      </div>

      {/* Sticky footer button — always visible, safe-area aware */}
      <div
        className="fixed bottom-0 left-0 right-0 md:static md:mt-6 md:px-5 md:max-w-lg px-5 pt-3 bg-cream border-t border-amber-100/60 md:border-0 md:bg-transparent z-20"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.25rem)' }}
      >
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className="btn-primary w-full py-4 text-sm"
        >
          {btnLabel}
        </button>
      </div>
    </div>
  )
}
