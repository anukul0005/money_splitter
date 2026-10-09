import { useEffect, useState } from 'react'
import { useParams, useLocation, useNavigate } from 'react-router-dom'
import { getGroups, getAggregateStats, createGroup } from '../api'
import { useUser } from '../UserContext'
import GroupCard from '../components/GroupCard'
import LoadingSpinner from '../components/LoadingSpinner'
import StatsPanel from '../components/StatsPanel'
import { buildMasterGroups } from '../utils/masterGroups'
import Dropdown from '../components/Dropdown'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
// "MONTHLY EXPENSES SEP 2026" -> 202609, for newest-first ordering; null for
// any other group, which keeps its place in the plain list below the months.
const monthKey = (name) => {
  const m = /^MONTHLY EXPENSES ([A-Z]{3}) (\d{4})$/.exec((name ?? '').trim().toUpperCase())
  const i = m ? MONTHS.indexOf(m[1]) : -1
  return i < 0 ? null : Number(m[2]) * 100 + i + 1
}
// Today as the day-groups are named: "09 oct 26".
const todayName = () => {
  const d = new Date()
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()].toLowerCase()} ${String(d.getFullYear()).slice(2)}`
}
// The same day however it was typed ("9 Oct 26", "09 oct 26") - for
// spotting that today's group already exists.
const dayKey = (name) => (name ?? '').trim().toLowerCase().replace(/^0(\d)/, '$1')

const RECENT_SHOWN = 6    // visible straight away
const RECENT_WINDOW = 12  // "Show more" reaches this far; older is by year

// Years of statement imports make one monthly group per month - 100+ cards
// in one list. The last 6 months show; the rest of the last 12 sit behind
// "Show more"; anything older is reached through the year picker.
function MonthlyGroups({ groups }) {
  const [year, setYear]       = useState('recent')
  const [showMore, setShowMore] = useState(false)

  const sorted = [...groups].sort((a, b) => monthKey(b.name) - monthKey(a.name))
  const years  = [...new Set(sorted.map((g) => String(Math.floor(monthKey(g.name) / 100))))]
  const shown = year === 'recent'
    ? sorted.slice(0, showMore ? RECENT_WINDOW : RECENT_SHOWN)
    : sorted.filter((g) => String(Math.floor(monthKey(g.name) / 100)) === year)
  const moreCount = Math.min(sorted.length, RECENT_WINDOW) - RECENT_SHOWN

  return (
    <div className="px-5 mt-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">
          {year === 'recent' ? 'Recent months' : year}
        </p>
        <Dropdown
          size="sm"
          value={year}
          onChange={(v) => { setYear(v); setShowMore(false) }}
          options={[{ value: 'recent', label: 'Last 12 months' }, ...years.map((y) => ({ value: y, label: y }))]}
        />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {shown.map((g) => <GroupCard key={g.id} group={g} />)}
      </div>
      {year === 'recent' && moreCount > 0 && (
        <button
          onClick={() => setShowMore((v) => !v)}
          className="mt-3 text-xs font-bold text-brand-500"
        >
          {showMore ? 'Show fewer' : `Show ${moreCount} more`}
        </button>
      )}
    </div>
  )
}

export default function MasterGroupDetail() {
  const { key } = useParams()
  const location = useLocation()
  const nav = useNavigate()

  const [master,  setMaster]  = useState(location.state?.master ?? null)
  const [loading, setLoading] = useState(!location.state?.master)
  const [showStats, setShowStats] = useState(false)
  const [stats, setStats]         = useState(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [picking, setPicking]     = useState(false)
  const [adding, setAdding]       = useState(false)
  const [addError, setAddError]   = useState('')
  const user = useUser()

  // "+ Add" makes today's group with no form: the members are this
  // master's own and the name is the date, so the only choice left is the
  // category - one tap on a chip creates the group and opens it. If today's
  // group already exists here, "+ Add" opens that one instead.
  const todays = master?.groups.find((g) => dayKey(g.name) === dayKey(todayName()))
  const usualCategory = (() => {
    const counts = {}
    master?.groups.forEach((g) => { if (g.category) counts[g.category] = (counts[g.category] || 0) + 1 })
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || ''
  })()
  const onAdd = () => (todays ? nav(`/groups/${todays.id}`) : setPicking((v) => !v))

  const addToday = async (category) => {
    if (adding || !master) return
    const name = todayName()
    setAdding(true); setAddError('')
    try {
      const r = await createGroup({
        name, description: '', emoji: '', category,
        members: master.names ?? [], created_by: user?.name,
      })
      nav(`/groups/${r.data.id}`)
    } catch (err) {
      setAddError(err.response?.data?.detail || 'Could not create today\'s group.')
      setAdding(false)
    }
  }

  // Stats are consolidated across every group in the master, so they're
  // fetched once the user actually asks for them rather than on page load.
  useEffect(() => {
    if (!showStats || stats || !master) return
    setStatsLoading(true)
    getAggregateStats(master.groups.map((g) => g.id))
      .then((r) => setStats(r.data))
      .catch(() => setStats(null))
      .finally(() => setStatsLoading(false))
  }, [showStats, master])

  useEffect(() => {
    if (location.state?.master) return
    setLoading(true)
    getGroups()
      .then((r) => {
        // minGroups=1 so a direct link still resolves even if this member
        // set currently has only one group.
        const { masters } = buildMasterGroups(r.data, 1)
        setMaster(masters.find((m) => m.key === decodeURIComponent(key)) ?? null)
      })
      .finally(() => setLoading(false))
  }, [key])

  if (loading) return <LoadingSpinner />

  if (!master) {
    return (
      <div className="text-center py-16 text-gray-400">
        <p className="text-sm">Master group not found</p>
      </div>
    )
  }

  const monthly = master.groups.filter((g) => monthKey(g.name) !== null)
  const others  = master.groups.filter((g) => monthKey(g.name) === null)

  return (
    <div className="pb-24 md:pb-8">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <div className="flex items-start justify-between gap-3">
          <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
          <div className="flex items-center gap-2">
          {/* "+ Add" creates today's group in this master - see onAdd / addToday. */}
          <button
            onClick={onAdd}
            disabled={adding}
            title={todays ? `Open today's group (${todays.name})` : `Today's group with ${master.name}`}
            className="flex-shrink-0 flex items-center gap-1.5 bg-cream border border-amber-200 text-gray-500 hover:bg-amber-50 rounded-md px-3 py-1.5 text-xs font-bold active:scale-95 transition-all shadow-sm disabled:opacity-50"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            {adding ? 'Adding…' : 'Add'}
          </button>
          <button
            onClick={() => setShowStats((v) => !v)}
            title={showStats ? 'Back to groups' : 'Stats across all these groups'}
            aria-label="Stats"
            aria-pressed={showStats}
            className={`flex-shrink-0 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold active:scale-95 transition-all shadow-sm border ${
              showStats
                ? 'bg-brand-400 border-brand-400 text-white'
                : 'bg-cream border-amber-200 text-gray-500 hover:bg-amber-50'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6m4 6V5m4 14v-9M4 21h16" />
            </svg>
            Stats
          </button>
          </div>
        </div>
        <h1 className="text-xl font-black tracking-tight">{master.name}</h1>
        <p className="text-xs text-gray-400 mt-1">{master.groups.length} groups · {INR(master.totalAmount)} total</p>
        {picking && !todays && (
          <div className="mt-3 border border-amber-200 bg-amber-50 px-3 py-2.5">
            <p className="text-[11px] text-gray-600 mb-2">
              New group <span className="font-bold">{todayName()}</span> — tap a category to create it:
            </p>
            <div className="flex gap-1.5 flex-wrap">
              {['trip', 'outing', 'festival', 'personal', 'other'].map((c) => (
                <button
                  key={c}
                  onClick={() => addToday(c)}
                  disabled={adding}
                  className={`px-3 py-1.5 text-xs font-bold border capitalize transition-colors disabled:opacity-50 ${
                    c === usualCategory
                      ? 'bg-brand-400 text-white border-brand-400'
                      : 'bg-cream text-gray-600 border-amber-200 hover:text-gray-900'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
            {usualCategory && <p className="text-[10px] text-gray-400 mt-1.5">Highlighted: what these groups usually are</p>}
          </div>
        )}
        {addError && <p className="text-xs text-red-600 mt-1">{addError}</p>}
      </div>

      {showStats ? (
        statsLoading ? <LoadingSpinner /> : (
          <StatsPanel
            stats={stats}
            expenses={stats?.expenses ?? []}
            isSolo={(master.names ?? []).length === 1}
          />
        )
      ) : (
        <>
          {monthly.length > 0 && <MonthlyGroups groups={monthly} />}
          {others.length > 0 && (
            <div className="px-5 mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              {others.map((g) => <GroupCard key={g.id} group={g} />)}
            </div>
          )}
        </>
      )}
    </div>
  )
}
