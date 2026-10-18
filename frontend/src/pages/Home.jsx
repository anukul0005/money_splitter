import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getGroups, getOverview, getUserSummary, getUserGroupBalances, getFriends, getLoans } from '../api'
import LoadingSpinner from '../components/LoadingSpinner'
import { useUser, isAdmin } from '../UserContext'
import { buildMasterGroups } from '../utils/masterGroups'
import { owes, owed } from '../utils/money'
import { combinedBalances } from '../utils/balances'
import MasterGroupCard from '../components/MasterGroupCard'
import SpendingPatterns from '../components/SpendingPatterns'
import GroupCard from '../components/GroupCard'
import NotificationBell from '../components/NotificationBell'
import { MONEY_CHANGED } from '../components/PaymentClaimsInbox'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

export default function Home() {
  const nav  = useNavigate()
  const user = useUser()
  const admin = isAdmin(user)

  const [groups,      setGroups]      = useState([])
  const [overview,    setOverview]    = useState([])
  const [userStats,   setUserStats]   = useState(null)
  const [balances,    setBalances]    = useState([])   // per-group, ranks the group list
  const [friends,     setFriends]     = useState([])   // per-person netted, drives the headline
  const [loans,       setLoans]       = useState(null) // loans + shared bills, see /loans
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
      getLoans().then((r) => setLoans(r.data)).catch(() => {})
    } catch {
      setError('Could not reach server. The API may be waking up — please try again in 30 seconds.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    const onChanged = () => load()
    window.addEventListener(MONEY_CHANGED, onChanged)
    return () => window.removeEventListener(MONEY_CHANGED, onChanged)
  }, [])

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

  // One net per person - every shared group AND every loan / bill share with
  // them, netted together before deciding which column they're in - using
  // the exact helper /balances/owe and /balances/owed list from, so the
  // headline always equals the sum of the rows behind it. Adding loan totals
  // on top of group totals (as this used to) counted anyone with both - e.g.
  // a loan you owe Anjali vs. what she owes you in groups - in both columns.
  const people    = combinedBalances(friends, loans, user?.name)
  const oweRows   = people.filter((p) => owes(p.net))
  const owedRows  = people.filter((p) => owed(p.net))
  const totalOwe  = oweRows.reduce((s, p) => s + Math.abs(p.net), 0)
  const totalOwed = owedRows.reduce((s, p) => s + p.net, 0)
  const owePeople  = oweRows.length
  const owedPeople = owedRows.length

  // Every group is linked to a master group named after its members — even
  // a single-member one, so every one of a person's own personal trackers
  // (Monthly Expenses Aug, Sep, ...) combines into the one master sharing
  // their own name, exactly like a recurring trip combines into one master
  // sharing that same group of friends. Unsettled entries show first;
  // settled ones are tucked behind a "show settled" toggle.
  const unsettledGroupIds = new Set(balances.map((b) => b.group_id))
  // group_id -> unsettled amount, used to rank what the user sees first
  const netByGroup = Object.fromEntries(balances.map((b) => [b.group_id, Math.abs(b.net)]))
  // Historical groups are included here (unlike activeOverview above) so they
  // still show up inside their super group on Home, each carrying its own
  // "Historical" badge via GroupCard — they're just always settled, so they
  // land behind "Show settled" rather than among the top unsettled cards.
  const { masters: everyMaster, solo: soloGroups } = buildMasterGroups(myGroups, 1, user?.name)
  // A single-member master can never carry a real balance - nothing to
  // settle with just yourself - so it would otherwise always sink to
  // "settled" and sit hidden behind "Show more" no matter how many months
  // of personal tracking are in it. Pulled out into its own always-visible
  // section instead of competing with the debt-ranked list below.
  const personalMasters = everyMaster.filter((m) => m.names.length === 1)
  const allMasters       = everyMaster.filter((m) => m.names.length > 1)
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

  return (
    <div className="pb-24 md:pb-8">
      {/* Header */}
      <div className="bg-gradient-to-br from-field-800 to-field-950 text-white px-5 pt-10 md:pt-8 pb-6 md:rounded-b-3xl border-b border-field-700">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {user?.full_name ? (
              <p className="text-white/60 text-sm font-bold">{user.full_name}</p>
            ) : user?.name && (
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
              className="bg-amber-100 border border-amber-300 rounded-md text-amber-800 hover:bg-amber-200 active:scale-95 font-bold px-3 py-2.5 transition-all duration-150 w-full text-center text-xs"
              onClick={() => {
                // Every user's own personal trackers combine into one
                // master sharing their own name (see buildMasterGroups) -
                // straight there if it already exists, so this button is
                // "my monthly tracking" for whoever's logged in. Nothing
                // created yet for this person falls back to the picker
                // that starts a first one.
                const mine = personalMasters[0]
                if (mine) nav(`/master/${encodeURIComponent(mine.key)}`, { state: { master: mine } })
                else nav('/groups/monthly')
              }}
            >
              Monthly
          </button>
            <button
              className="bg-amber-100 border border-amber-300 rounded-md text-amber-800 hover:bg-amber-200 active:scale-95 font-bold px-3 py-2.5 transition-all duration-150 w-full text-center text-xs"
              onClick={() => nav('/loans')}
            >
              Loans
            </button>
        </div>

        {/* The insights dashboard (pages/Insights.jsx) and the on-demand
            pattern analysis (pages/MLAnalysis.jsx) */}
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => nav('/insights')}
            className="flex items-center justify-between bg-field-800 hover:bg-field-700 text-white px-3 py-3 rounded-md active:scale-[0.99] transition-all"
          >
            <span className="text-left">
              <span className="block text-sm font-bold">Insights</span>
              <span className="block text-[10px] text-slate-300 leading-snug">Totals, forecast, unusual spends, savings</span>
            </span>
            <span className="text-brand-400 text-lg font-bold">›</span>
          </button>
          <button
            onClick={() => nav('/ml-analysis')}
            className="flex items-center justify-between bg-field-800 hover:bg-field-700 text-white px-3 py-3 rounded-md active:scale-[0.99] transition-all"
          >
            <span className="text-left">
              <span className="block text-sm font-bold">ML analysis</span>
              <span className="block text-[10px] text-slate-300 leading-snug">When, how and on what your money goes</span>
            </span>
            <span className="text-brand-400 text-lg font-bold">›</span>
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

        {/* When the money goes - replaces the old category charts */}
        <SpendingPatterns />

      </div>
    </div>
  )
}
