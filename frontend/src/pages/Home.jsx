import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getGroups, getOverview, getUserSummary, getGlobalAnalytics, getUserGroupBalances } from '../api'
import LoadingSpinner from '../components/LoadingSpinner'
import { useUser, isAdmin } from '../UserContext'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

const PALETTE = [
  '#f97316','#eab308','#22c55e','#06b6d4','#3b82f6',
  '#8b5cf6','#ec4899','#ef4444','#14b8a6','#f59e0b',
]

function BalanceGroupCard({ group, nav }) {
  const owes = group.net < 0
  return (
    <button
      onClick={() => nav(`/groups/${group.group_id}`)}
      className={`w-full text-left border px-4 py-3 flex items-center gap-3 active:scale-95 transition-all duration-150 ${
        owes
          ? 'bg-red-50 border-red-200 hover:bg-red-100'
          : 'bg-green-50 border-green-200 hover:bg-green-100'
      }`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-gray-900 truncate">{group.name}</p>
        <p className={`text-xs font-semibold mt-0.5 ${owes ? 'text-red-600' : 'text-green-600'}`}>
          {owes ? `You owe ${INR(Math.abs(group.net))}` : `You're owed ${INR(group.net)}`}
        </p>
      </div>
      <div className={`shrink-0 w-8 h-8 flex items-center justify-center text-sm font-black ${
        owes ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'
      }`}>
        {owes ? '↑' : '↓'}
      </div>
    </button>
  )
}

function CategoryBar({ category, total, maxTotal, color, count }) {
  const pct = maxTotal > 0 ? Math.max(4, (total / maxTotal) * 100) : 4
  return (
    <div className="mb-2">
      <div className="flex justify-between items-center mb-0.5">
        <span className="text-xs font-semibold text-gray-700 truncate max-w-[55%]">{category}</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-400">{count} exp</span>
          <span className="text-xs font-bold text-gray-900">{INR(total)}</span>
        </div>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-2 rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  )
}

function PersonCategoryCard({ person, cats }) {
  const top = cats[0]
  const maxAmt = cats[0]?.total ?? 1

  return (
    <div className="card p-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-7 h-7 rounded-full bg-amber-100 border border-amber-300 flex items-center justify-center text-xs font-black text-amber-700 uppercase shrink-0">
          {person[0]}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-bold text-gray-900 truncate capitalize">{person}</p>
          {top && <p className="text-[10px] text-gray-400 truncate">Top: {top.category}</p>}
        </div>
        {top && <span className="ml-auto text-xs font-black text-gray-800 shrink-0">{INR(top.total)}</span>}
      </div>
      <div className="space-y-1.5">
        {cats.slice(0, 4).map((c, i) => (
          <div key={c.category}>
            <div className="flex justify-between items-baseline mb-0.5">
              <span className="text-[10px] font-semibold text-gray-600 uppercase tracking-wide leading-tight">{c.category}</span>
              <span className="text-[10px] font-bold text-gray-700 ml-1 shrink-0">{INR(c.total)}</span>
            </div>
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-1.5 rounded-full"
                style={{ width: `${Math.max(8, (c.total / maxAmt) * 100)}%`, backgroundColor: PALETTE[i % PALETTE.length] }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function Home() {
  const nav  = useNavigate()
  const user = useUser()
  const admin = isAdmin(user)

  const [groups,      setGroups]      = useState([])
  const [overview,    setOverview]    = useState([])
  const [userStats,   setUserStats]   = useState(null)
  const [analytics,   setAnalytics]   = useState(null)
  const [balances,    setBalances]    = useState([])
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const coreCalls = [getOverview(), getGroups()]
      if (user?.name) coreCalls.push(getUserSummary(user.name))
      const [o, g, u] = await Promise.all(coreCalls)
      setOverview(o.data)
      setGroups(g.data)
      if (u) setUserStats(u.data)

      // These load independently — failures don't break the page
      if (user?.name) {
        getUserGroupBalances(user.name)
          .then((r) => setBalances(r.data))
          .catch(() => {})
      }
      getGlobalAnalytics(user?.name ?? '')
        .then((a) => setAnalytics(a.data))
        .catch(() => {})
    } catch {
      setError('Could not reach server. The API may be waking up — please try again in 30 seconds.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const myGroups = admin
    ? groups
    : groups.filter((g) =>
        (g.member_names ?? []).some((n) => n.toLowerCase() === user?.name?.toLowerCase())
      )
  const myGroupIds     = new Set(myGroups.map((g) => g.id))
  const activeOverview = overview.filter((g) => !g.is_historical && myGroupIds.has(g.id))
  const totalSpend     = activeOverview.reduce((s, g) => s + g.total, 0)

  if (loading) return <LoadingSpinner />

  if (error) return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-5 text-center">
      <p className="text-4xl mb-3">😴</p>
      <p className="text-sm text-gray-600 mb-4">{error}</p>
      <button onClick={load} className="bg-brand-400 text-gray-900 px-5 py-2 rounded-xl text-sm font-bold shadow-md">
        Retry
      </button>
    </div>
  )

  const oweGroups  = balances.filter((g) => g.net < 0)
  const owedGroups = balances.filter((g) => g.net > 0)
  const totalOwe   = oweGroups.reduce((s, g) => s + Math.abs(g.net), 0)
  const totalOwed  = owedGroups.reduce((s, g) => s + g.net, 0)

  const byCategory    = analytics?.by_category ?? []
  const byPersonCat   = analytics?.by_person_category ?? {}
  const maxCatTotal   = byCategory[0]?.total ?? 1
  const personEntries = Object.entries(byPersonCat).sort((a, b) => {
    const aTotal = a[1].reduce((s, c) => s + c.total, 0)
    const bTotal = b[1].reduce((s, c) => s + c.total, 0)
    return bTotal - aTotal
  })

  return (
    <div className="pb-24 md:pb-8">
      {/* Header */}
      <div className="bg-gradient-to-br from-field-800 to-field-950 text-white px-5 pt-10 md:pt-8 pb-6 md:rounded-b-3xl border-b border-field-700">
        <p className="text-brand-400/70 text-xs font-bold uppercase tracking-widest">Total spent (active groups)</p>
        <h1 className="text-4xl font-black mt-1 tracking-tight">{INR(totalSpend)}</h1>
        <p className="text-green-200/40 text-xs mt-1 font-medium">{activeOverview.length} active groups</p>
      </div>

      <div className="px-5 mt-5 space-y-5">

        {/* Personal KPI cards */}
        {userStats && userStats.groups_count > 0 && (
          <div>
            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">
              {user?.name}'s Overview
            </p>
            <div className="grid grid-cols-3 gap-2">
              <div className="card text-center py-3">
                <p className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide leading-tight">Unsettled Groups</p>
                <p className="text-sm font-black text-gray-900 mt-1">{balances.length}</p>
              </div>
              <div className="card text-center py-3 bg-red-50 border-red-200">
                <p className="text-[10px] text-red-500 font-semibold uppercase tracking-wide leading-tight">You Owe</p>
                <p className="text-sm font-black text-red-600 mt-1">{INR(totalOwe)}</p>
              </div>
              <div className="card text-center py-3 bg-green-50 border-green-200">
                <p className="text-[10px] text-green-600 font-semibold uppercase tracking-wide leading-tight">Owed to You</p>
                <p className="text-sm font-black text-green-600 mt-1">{INR(totalOwed)}</p>
              </div>
            </div>
          </div>
        )}

        {/* Admin quick actions */}
        {admin && (
          <div className="grid grid-cols-2 gap-3">
            <button className="btn-primary py-3 text-sm" onClick={() => nav('/groups/new')}>
              + New Group
            </button>
            <button
              className="bg-cream border border-amber-200 hover:bg-cream-200 active:scale-95 text-gray-800 font-bold px-4 py-3 transition-all duration-150 w-full text-center text-sm"
              onClick={() => nav('/add')}
            >
              + Add Expense
            </button>
          </div>
        )}

        {/* You Owe */}
        {oweGroups.length > 0 && (
          <div>
            <p className="text-xs font-bold text-red-400 uppercase tracking-widest mb-2">You Owe</p>
            <div className="space-y-2">
              {oweGroups.map((g) => <BalanceGroupCard key={g.group_id} group={g} nav={nav} />)}
            </div>
          </div>
        )}

        {/* Owed to You */}
        {owedGroups.length > 0 && (
          <div>
            <p className="text-xs font-bold text-green-500 uppercase tracking-widest mb-2">Owed to You</p>
            <div className="space-y-2">
              {owedGroups.map((g) => <BalanceGroupCard key={g.group_id} group={g} nav={nav} />)}
            </div>
          </div>
        )}

        {/* All settled */}
        {balances.length === 0 && userStats && userStats.groups_count > 0 && (
          <div className="text-center py-6">
            <p className="text-2xl mb-1">✅</p>
            <p className="text-sm font-semibold text-gray-500">All settled up!</p>
          </div>
        )}

        {/* Spend by Category */}
        {byCategory.length > 0 && (
          <div>
            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">Spend by Category</p>
            <div className="card p-4">
              {byCategory.slice(0, 10).map((c, i) => (
                <CategoryBar
                  key={c.category}
                  category={c.category}
                  total={c.total}
                  count={c.count}
                  maxTotal={maxCatTotal}
                  color={PALETTE[i % PALETTE.length]}
                />
              ))}
            </div>
          </div>
        )}

        {/* By Person */}
        {personEntries.length > 0 && (
          <div>
            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">Category by Person</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {personEntries.map(([person, cats]) => (
                <PersonCategoryCard key={person} person={person} cats={cats} />
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
