import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getGroups, getOverview, getUserSummary, getGlobalAnalytics, getUserGroupBalances, getFriends } from '../api'
import LoadingSpinner from '../components/LoadingSpinner'
import { useUser, isAdmin } from '../UserContext'
import { buildMasterGroups } from '../utils/masterGroups'
import { owes, owed } from '../utils/money'
import MasterGroupCard from '../components/MasterGroupCard'
import GroupCard from '../components/GroupCard'
import NotificationBell from '../components/NotificationBell'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

const PALETTE = [
  '#f97316','#eab308','#22c55e','#06b6d4','#3b82f6',
  '#8b5cf6','#ec4899','#ef4444','#14b8a6','#f59e0b',
]

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
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-sm font-bold text-gray-900 capitalize">{person}</p>
        {top && <span className="text-xs font-black text-gray-800 shrink-0">{INR(top.total)}</span>}
      </div>
      <div className="space-y-1.5">
        {cats.slice(0, 4).map((c, i) => (
          <div key={c.category}>
            <div className="flex justify-between items-baseline mb-0.5 gap-2">
              <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide leading-tight">{c.category}</span>
              <span className="text-xs font-bold text-gray-700 shrink-0">{INR(c.total)}</span>
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
  const [balances,    setBalances]    = useState([])   // per-group, ranks the group list
  const [friends,     setFriends]     = useState([])   // per-person netted, drives the headline
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')
  const [showSettled, setShowSettled] = useState(false)

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
        getFriends(user.name)
          .then((r) => setFriends(r.data))
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

  if (loading) return <LoadingSpinner />

  if (error) return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-5 text-center">
      <p className="text-4xl mb-3">😴</p>
      <p className="text-sm text-gray-600 mb-4">{error}</p>
      <button onClick={load} className="bg-brand-400 text-white px-5 py-2 rounded-xl text-sm font-bold shadow-md">
        Retry
      </button>
    </div>
  )

  // Netted per person across every group: what you'd actually settle up.
  // Summing groups in isolation double-counts debts that cancel each other —
  // owing Divyank in one group while he owes you more in two others.
  // Same threshold as the Friends list, so the headline total and the rows
  // that explain it can never disagree.
  const totalOwe  = friends.filter((f) => owes(f.net)).reduce((s, f) => s + Math.abs(f.net), 0)
  const totalOwed = friends.filter((f) => owed(f.net)).reduce((s, f) => s + f.net, 0)
  const owePeople  = friends.filter((f) => owes(f.net)).length
  const owedPeople = friends.filter((f) => owed(f.net)).length

  // Every group (2+ members) is linked to a master group named after its
  // members — even if it's the only group with that exact member set, so no
  // group ever shows under its own custom name on Home. Groups with a single
  // member (nothing to link) fall through to the solo list. Unsettled
  // entries show first; settled ones are tucked behind a "show settled" toggle.
  const unsettledGroupIds = new Set(balances.map((b) => b.group_id))
  // group_id -> unsettled amount, used to rank what the user sees first
  const netByGroup = Object.fromEntries(balances.map((b) => [b.group_id, Math.abs(b.net)]))
  // Historical groups are included here (unlike activeOverview above) so they
  // still show up inside their super group on Home, each carrying its own
  // "Historical" badge via GroupCard — they're just always settled, so they
  // land behind "Show settled" rather than among the top unsettled cards.
  const { masters: allMasters, solo: soloGroups } = buildMasterGroups(myGroups, 1)
  const unsettledMasters = allMasters.filter((m) => m.groups.some((g) => unsettledGroupIds.has(g.id)))
  const settledMasters   = allMasters.filter((m) => !m.groups.some((g) => unsettledGroupIds.has(g.id)))
  const unsettledSolo    = soloGroups.filter((g) => unsettledGroupIds.has(g.id))
  const settledSolo      = soloGroups.filter((g) => !unsettledGroupIds.has(g.id))

  // Only the three biggest unsettled entries show by default; the rest sit
  // behind "Show all". A master's weight is everything unsettled inside it.
  const unsettledEntries = [
    ...unsettledMasters.map((m) => ({
      key: `m-${m.key}`,
      amount: m.groups.reduce((s, g) => s + (netByGroup[g.id] ?? 0), 0),
      node: <MasterGroupCard key={m.key} master={m} />,
    })),
    ...unsettledSolo.map((g) => ({
      key: `g-${g.id}`,
      amount: netByGroup[g.id] ?? 0,
      node: <GroupCard key={g.id} group={g} />,
    })),
  ].sort((a, b) => b.amount - a.amount)

  const TOP_N = 3
  const topUnsettled  = unsettledEntries.slice(0, TOP_N)
  const restUnsettled = unsettledEntries.slice(TOP_N)
  const hiddenCount   = restUnsettled.length + settledMasters.length + settledSolo.length

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
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {user?.name && (
              <p className="text-white/60 text-sm font-bold capitalize">{user.name}</p>
            )}
            <h1 className="text-2xl font-bold mt-0.5 tracking-tight">Your balances</h1>
            <p className="text-slate-300/40 text-xs mt-1 font-medium">{activeOverview.length} active groups</p>
          </div>
          <NotificationBell user={user} />
        </div>
      </div>

      <div className="px-5 mt-5 space-y-5">

        {/* Personal KPI cards */}
        {userStats && userStats.groups_count > 0 && (
          <div>
            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">
              Overview
            </p>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => nav('/balances/owe')}
                className="card text-center py-3 px-3 bg-red-50 border-red-200 active:scale-[0.98] transition-transform"
              >
                <p className="text-[10px] text-red-500 font-semibold uppercase tracking-wide leading-tight">You Owe</p>
                <p className="text-base font-black text-red-600 mt-0.5">{INR(totalOwe)}</p>
                <p className="text-[10px] text-red-400 mt-0.5">
                  {owePeople ? `${owePeople} ${owePeople === 1 ? 'person' : 'people'} →` : 'all settled'}
                </p>
              </button>
              <button
                onClick={() => nav('/balances/owed')}
                className="card text-center py-3 px-3 bg-green-50 border-green-200 active:scale-[0.98] transition-transform"
              >
                <p className="text-[10px] text-green-600 font-semibold uppercase tracking-wide leading-tight">Owed to You</p>
                <p className="text-base font-black text-green-600 mt-0.5">{INR(totalOwed)}</p>
                <p className="text-[10px] text-green-500 mt-0.5">
                  {owedPeople ? `${owedPeople} ${owedPeople === 1 ? 'person' : 'people'} →` : 'all settled'}
                </p>
              </button>
            </div>
          </div>
        )}

        {/* Quick actions — available to everyone, not just admins: anyone can
            start a group, and they're a member of whatever they create. */}
        <div className="grid grid-cols-3 gap-3">
            <button className="btn-primary py-2.5 px-3 text-xs" onClick={() => nav('/groups/new')}>
              + New Group
            </button>
            <button
              className="bg-cream border border-amber-200 rounded-md hover:bg-cream-200 active:scale-95 text-gray-800 font-bold px-3 py-2.5 transition-all duration-150 w-full text-center text-xs"
              onClick={() => nav('/add')}
            >
              + Add Expense
            </button>
            <button
              className="bg-amber-100 border border-amber-300 rounded-md text-amber-800 hover:bg-amber-200 active:scale-95 font-bold px-3 py-2.5 transition-all duration-150 w-full text-center text-xs"
              onClick={() => nav('/groups/monthly')}
            >
              + Monthly
          </button>
        </div>

        {/* Groups (every group linked to a master group by members; unsettled first, settled behind a toggle) */}
        {(allMasters.length > 0 || soloGroups.length > 0) && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                {topUnsettled.length > 0 ? 'Top unsettled groups' : 'Groups'}
              </p>
              <button
                className="text-xs font-bold text-brand-500"
                onClick={() => nav('/groups')}
              >
                See all &rsaquo;
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {topUnsettled.map((e) => e.node)}
            </div>

            {hiddenCount > 0 && (
              showSettled ? (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                    {restUnsettled.map((e) => e.node)}
                    {settledMasters.map((m) => <MasterGroupCard key={m.key} master={m} />)}
                    {settledSolo.map((g) => <GroupCard key={g.id} group={g} />)}
                  </div>
                  <button
                    onClick={() => setShowSettled(false)}
                    className="w-full mt-3 py-2 text-xs font-bold text-gray-500 bg-amber-50 border border-amber-200 rounded-md hover:bg-amber-100 active:scale-[0.98] transition-all"
                  >
                    Show less
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setShowSettled(true)}
                  className="w-full mt-3 py-2 text-xs font-bold text-gray-500 bg-amber-50 border border-amber-200 rounded-md hover:bg-amber-100 active:scale-[0.98] transition-all"
                >
                  Show {hiddenCount} more group{hiddenCount > 1 ? 's' : ''}
                </button>
              )
            )}
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
