import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getGroups, createGroup } from '../api'
import { useUser } from '../UserContext'
import LoadingSpinner from '../components/LoadingSpinner'

const MONTH_NAMES = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
const MONTH_FULL  = ['January','February','March','April','May','June','July','August','September','October','November','December']
const START_YEAR  = 2020

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

  const yearOptions = Array.from({ length: now.getFullYear() + 1 - START_YEAR + 1 }, (_, i) => START_YEAR + i)
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

  // Only exact name match — no fuzzy rename logic that caused wrong groups to be renamed
  const exactMatch = visibleGroups.find((g) => g.name === targetName)

  const handleSubmit = async () => {
    if (!monthYear || !user?.name) return
    setError('')
    setSubmitting(true)
    try {
      if (exactMatch) {
        nav(`/groups/${exactMatch.id}`)
        return
      }
      const r = await createGroup({
        name:        targetName,
        description: '',
        category:    'personal',
        emoji:       '💰',
        members:     [user.name],
      })
      nav(`/groups/${r.data.id}`)
    } catch (err) {
      setError(err?.response?.data?.detail || 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  if (loading) return <LoadingSpinner />

  const btnLabel = submitting
    ? (exactMatch ? 'Opening…' : 'Creating…')
    : (exactMatch ? 'Open Group' : 'Create Group')

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

        {/* Month + Year pickers */}
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="label">Month</label>
            <select
              value={monthMonth}
              onChange={(e) => setMonthMonth(Number(e.target.value))}
              className="mt-2 w-full border border-amber-200 bg-cream text-gray-800 font-bold text-sm px-3 py-3 appearance-none focus:outline-none focus:border-brand-400"
            >
              {MONTH_FULL.map((name, i) => (
                <option key={i} value={i + 1}>{name}</option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="label">Year</label>
            <select
              value={monthYearNum}
              onChange={(e) => setMonthYearNum(Number(e.target.value))}
              className="mt-2 w-full border border-amber-200 bg-cream text-gray-800 font-bold text-sm px-3 py-3 appearance-none focus:outline-none focus:border-brand-400"
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Status card */}
        <div className="border border-amber-200 bg-amber-50/60 px-4 py-3 space-y-1">
          <p className="text-[10px] font-black text-amber-700 tracking-widest">GROUP NAME</p>
          <p className="text-sm font-bold text-gray-800">{targetName}</p>
          {exactMatch
            ? <p className="text-xs text-brand-700 font-semibold mt-1">✓ Already exists — will open it</p>
            : <p className="text-xs text-gray-400 mt-1">A new group will be created for you</p>
          }
        </div>

        {error && (
          <p className="text-sm text-red-500 bg-red-50 border border-red-100 px-4 py-3">{error}</p>
        )}
      </div>

      {/* Sticky footer — fixed on mobile, inline on desktop */}
      <div
        className="fixed bottom-16 left-0 right-0 md:static md:bottom-auto md:mt-6 md:px-5 md:max-w-lg px-5 pt-3 pb-5 bg-cream border-t border-amber-100/60 md:border-0 md:bg-transparent z-20"
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
