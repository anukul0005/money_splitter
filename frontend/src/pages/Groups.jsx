import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getGroups, createGroup, updateGroup } from '../api'
import GroupCard from '../components/GroupCard'
import LoadingSpinner from '../components/LoadingSpinner'
import { useUser, isAdmin } from '../UserContext'

const MONTH_NAMES = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']

const getTargetName = (my) => {
  if (!my) return ''
  const [y, m] = my.split('-')
  return `MONTHLY EXPENSES ${MONTH_NAMES[parseInt(m) - 1]} ${y}`
}

export default function Groups() {
  const nav = useNavigate()
  const user = useUser()
  const admin = isAdmin(user)

  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [showMonthlyModal, setShowMonthlyModal] = useState(false)
  const [monthMonth, setMonthMonth] = useState(() => new Date().getMonth() + 1)
  const [monthYearNum, setMonthYearNum] = useState(() => new Date().getFullYear())
  const [monthlyCreating, setMonthlyCreating] = useState(false)
  const [monthlyError, setMonthlyError] = useState('')

  const monthYear = `${monthYearNum}-${String(monthMonth).padStart(2, '0')}`
  const now = new Date()
  const yearOptions = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]

  useEffect(() => {
    getGroups().then((r) => setGroups(r.data)).finally(() => setLoading(false))
  }, [])

  // All users only see groups they belong to (case-insensitive)
  const visibleGroups = groups.filter((g) =>
    (g.member_names ?? []).some((n) => n.toLowerCase() === user?.name?.toLowerCase())
  )

  // Derived from current monthYear selection
  const targetName  = getTargetName(monthYear)
  const exactMatch  = visibleGroups.find((g) => g.name === targetName)
  const fuzzyMatch  = !exactMatch && monthYear ? (() => {
    const [y, m] = monthYear.split('-')
    const mon = MONTH_NAMES[parseInt(m) - 1].toLowerCase()
    return visibleGroups.find((g) => {
      const lower = g.name.toLowerCase()
      return (lower.includes(mon) || lower.includes(y)) &&
             (g.member_names ?? []).length === 1
    })
  })() : null

  const handleCreateMonthly = async () => {
    if (!monthYear || !user?.name) return
    if (exactMatch) { setShowMonthlyModal(false); nav(`/groups/${exactMatch.id}`); return }
    setMonthlyCreating(true)
    setMonthlyError('')
    try {
      const r = await createGroup({ name: targetName, description: '', category: 'personal', emoji: '💰', members: [user.name] })
      setShowMonthlyModal(false)
      nav(`/groups/${r.data.id}`)
    } catch (err) {
      setMonthlyError(err?.response?.data?.detail || 'Failed to create group. Please try again.')
    } finally {
      setMonthlyCreating(false)
    }
  }

  const handleRenameAndUse = async () => {
    if (!fuzzyMatch || !targetName) return
    setMonthlyCreating(true)
    setMonthlyError('')
    try {
      await updateGroup(fuzzyMatch.id, { name: targetName, description: null, category: 'personal', members_add: [], members_remove: [] })
      setShowMonthlyModal(false)
      nav(`/groups/${fuzzyMatch.id}`)
    } catch (err) {
      setMonthlyError(err?.response?.data?.detail || 'Failed to rename group. Please try again.')
    } finally {
      setMonthlyCreating(false)
    }
  }

  const filtered = visibleGroups.filter((g) =>
    filter === 'all' ? true : filter === 'historical' ? g.is_historical : !g.is_historical
  )

  if (loading) return <LoadingSpinner />

  return (
    <div className="pb-24 md:pb-8">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-black tracking-tight">Groups</h1>
          <div className="flex items-center gap-2">
            <button
              className="bg-amber-100 text-amber-800 text-xs font-bold px-3 py-1.5 border border-amber-300"
              onClick={() => setShowMonthlyModal(true)}
            >
              + Monthly
            </button>
            {admin && (
              <button className="bg-brand-400 text-gray-900 text-xs font-bold px-3 py-1.5 shadow-sm" onClick={() => nav('/groups/new')}>
                + New
              </button>
            )}
          </div>
        </div>
        <div className="flex gap-2 mt-3">
          {['all','active','historical'].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 text-xs font-bold transition-colors border ${
                filter === f ? 'bg-brand-400 text-gray-900 border-brand-400' : 'bg-amber-50 border-amber-200 text-gray-500'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="px-5 mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
        {filtered.map((g) => <GroupCard key={g.id} group={g} />)}
        {filtered.length === 0 && (
          <div className="col-span-2 text-center py-16 text-gray-400">
            <svg className="w-10 h-10 mx-auto mb-2 text-gray-300" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
            </svg>
            <p className="text-sm">No groups in this category</p>
          </div>
        )}
      </div>

      {/* Monthly expense tracker modal */}
      {showMonthlyModal && (
        <div
          className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50"
          style={{ touchAction: 'none', paddingBottom: 'env(safe-area-inset-bottom, 16px)' }}
          onClick={(e) => { if (e.target === e.currentTarget) { setShowMonthlyModal(false); setMonthlyError('') } }}
        >
          <div className="bg-cream w-full md:max-w-sm border-t border-x border-amber-100/60 md:border shadow-2xl flex flex-col max-h-[85dvh]">

            {/* Header */}
            <div className="px-5 pt-5 pb-4 flex items-center justify-between border-b border-amber-100/60 flex-shrink-0">
              <h2 className="font-black text-sm tracking-widest">Track Monthly Expenses</h2>
              <button onClick={() => { setShowMonthlyModal(false); setMonthlyError('') }} className="text-gray-400 hover:text-gray-700 p-1">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-4 space-y-4 flex-1 overflow-y-auto">
              <div>
                <label className="label">Month &amp; Year</label>
                <div className="flex gap-2">
                  <select
                    className="input flex-1"
                    value={monthMonth}
                    onChange={(e) => setMonthMonth(Number(e.target.value))}
                  >
                    {MONTH_NAMES.map((name, i) => (
                      <option key={i} value={i + 1}>{name}</option>
                    ))}
                  </select>
                  <select
                    className="input w-28"
                    value={monthYearNum}
                    onChange={(e) => setMonthYearNum(Number(e.target.value))}
                  >
                    {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>
              </div>

              {/* Status feedback */}
              {exactMatch && (
                <div className="bg-brand-400/10 border border-brand-400/30 px-3 py-2.5">
                  <p className="text-xs font-bold text-brand-700">Group already exists — will open it.</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">{exactMatch.name}</p>
                </div>
              )}
              {fuzzyMatch && (
                <div className="bg-amber-50 border border-amber-300 px-3 py-2.5 space-y-1.5">
                  <p className="text-xs font-bold text-amber-800">Found a similar group:</p>
                  <p className="text-[10px] text-gray-600 font-semibold">"{fuzzyMatch.name}"</p>
                  <p className="text-[10px] text-gray-500">Rename it to <span className="font-bold text-gray-700">{targetName}</span> and open?</p>
                </div>
              )}
              {!exactMatch && !fuzzyMatch && targetName && (
                <p className="text-xs text-gray-400">
                  Will create: <span className="font-bold text-gray-700">{targetName}</span>
                </p>
              )}
              {monthlyError && (
                <p className="text-xs text-red-500 bg-red-50 border border-red-100 px-3 py-2">{monthlyError}</p>
              )}
            </div>

            {/* Footer — always visible, safe-area aware */}
            <div
              className="px-5 pt-3 flex gap-3 border-t border-amber-100/60 bg-cream flex-shrink-0"
              style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.25rem)' }}
            >
              <button
                className="flex-1 py-3 text-xs font-bold text-gray-500 border border-amber-200 hover:bg-amber-50 active:scale-95 transition-all"
                onClick={() => { setShowMonthlyModal(false); setMonthlyError('') }}
              >
                Cancel
              </button>
              {fuzzyMatch ? (
                <button
                  className="flex-1 btn-primary py-3 text-xs"
                  onClick={handleRenameAndUse}
                  disabled={monthlyCreating}
                >
                  {monthlyCreating ? 'Renaming…' : 'Rename & Open'}
                </button>
              ) : (
                <button
                  className="flex-1 btn-primary py-3 text-xs"
                  onClick={handleCreateMonthly}
                  disabled={monthlyCreating || !monthYear}
                >
                  {monthlyCreating ? (exactMatch ? 'Opening…' : 'Creating…') : (exactMatch ? 'Open' : 'Create')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
