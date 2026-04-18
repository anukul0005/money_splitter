import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getGroups, createGroup } from '../api'
import GroupCard from '../components/GroupCard'
import LoadingSpinner from '../components/LoadingSpinner'
import { useUser, isAdmin } from '../UserContext'

const MONTH_NAMES = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']

export default function Groups() {
  const nav = useNavigate()
  const user = useUser()
  const admin = isAdmin(user)

  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [showMonthlyModal, setShowMonthlyModal] = useState(false)
  const [monthYear, setMonthYear] = useState(() => new Date().toISOString().slice(0, 7))
  const [monthlyCreating, setMonthlyCreating] = useState(false)

  useEffect(() => {
    getGroups().then((r) => setGroups(r.data)).finally(() => setLoading(false))
  }, [])

  const handleCreateMonthly = async () => {
    if (!monthYear || !user?.name) return
    const [y, m] = monthYear.split('-')
    const name = `MONTHLY EXPENSES ${MONTH_NAMES[parseInt(m) - 1]} ${y}`
    setMonthlyCreating(true)
    try {
      const r = await createGroup({ name, description: '', category: 'personal', emoji: '', members: [user.name] })
      setShowMonthlyModal(false)
      getGroups().then((res) => setGroups(res.data))
      nav(`/groups/${r.data.id}`)
    } finally {
      setMonthlyCreating(false)
    }
  }

  // All users only see groups they belong to (case-insensitive)
  const visibleGroups = groups.filter((g) =>
    (g.member_names ?? []).some((n) => n.toLowerCase() === user?.name?.toLowerCase())
  )

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
          onClick={(e) => { if (e.target === e.currentTarget) setShowMonthlyModal(false) }}
        >
          <div className="bg-cream w-full md:max-w-sm border-t border-x border-amber-100/60 md:border shadow-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-black text-sm tracking-widest">Track Monthly Expenses</h2>
              <button onClick={() => setShowMonthlyModal(false)} className="text-gray-400 hover:text-gray-700 p-1">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div>
              <label className="label">Month &amp; Year</label>
              <input
                type="month"
                className="input"
                value={monthYear}
                onChange={(e) => setMonthYear(e.target.value)}
              />
            </div>
            {monthYear && (
              <p className="text-xs text-gray-400">
                Creates: <span className="font-bold text-gray-700">
                  MONTHLY EXPENSES {MONTH_NAMES[parseInt(monthYear.split('-')[1]) - 1]} {monthYear.split('-')[0]}
                </span>
              </p>
            )}
            <div className="flex gap-3 pt-1">
              <button
                className="flex-1 py-3 text-xs font-bold text-gray-500 border border-amber-200 hover:bg-amber-50"
                onClick={() => setShowMonthlyModal(false)}
              >
                Cancel
              </button>
              <button
                className="flex-1 btn-primary py-3 text-xs"
                onClick={handleCreateMonthly}
                disabled={monthlyCreating || !monthYear}
              >
                {monthlyCreating ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
