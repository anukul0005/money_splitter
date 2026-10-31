import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getGroups, getOverview, getUserSummary, getUserGroupBalances, getFriends, getLoans, betsPromos } from '../api'
import LoadingSpinner from '../components/LoadingSpinner'
import { useUser, isAdmin, isAnalyticsUser } from '../UserContext'
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

  // 1xbet's Friday no-risk bet: nudge until that Friday's result is in (My bets asks for it)
  const [fridayAsk, setFridayAsk] = useState(false)
  useEffect(() => {
    if (!isAnalyticsUser(user)) return
    betsPromos().then((r) => setFridayAsk(r.data.pending.length > 0)).catch(() => {})
  }, [user?.name])

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
  // sharing that same group of friends.
  // Historical groups are included here (unlike activeOverview above) so they
  // still show up inside their super group on Home, each carrying its own
  // "Historical" badge via GroupCard.
  const { masters: everyMaster, solo: soloGroups } = buildMasterGroups(myGroups, 1, user?.name)
  // A single-member master (personal tracking - Monthly Expenses) has its
  // own always-visible section instead of competing with the list below.
  const personalMasters = everyMaster.filter((m) => m.names.length === 1)
  const allMasters      = everyMaster.filter((m) => m.names.length > 1)

  // The four most recently used show straight away, settled or not; the
  // rest sit behind "Show more". "Used" is a group's latest expense (else
  // when it was made - the server's last_activity); a master counts its
  // most recent group.
  const lastUsed = (gs) => gs.reduce((d, g) => ((g.last_activity || '') > d ? g.last_activity || '' : d), '')
  const ordered = [
    ...allMasters.map((m) => ({ key: `m-${m.key}`, used: lastUsed(m.groups), node: <MasterGroupCard key={m.key} master={m} /> })),
    ...soloGroups.map((g) => ({ key: `g-${g.id}`, used: lastUsed([g]), node: <GroupCard key={g.id} group={g} /> })),
  ].sort((a, b) => b.used.localeCompare(a.used))
  const SHOWN = 4
  const shownEntries  = ordered.slice(0, SHOWN)
  const hiddenEntries = ordered.slice(SHOWN)
  const hiddenCount   = hiddenEntries.length

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
          <div className="flex items-center gap-1 flex-shrink-0">
            {isAnalyticsUser(user) && (
              <button onClick={() => nav('/tennis/news')} title="Tennis news" aria-label="Tennis news"
                className="p-2 text-white/70 hover:text-white active:scale-95 transition-all">
                {/* newspaper */}
                <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path d="M4 5h13v14H6a2 2 0 0 1-2-2V5z" /><path d="M17 9h3v8a2 2 0 0 1-2 2" />
                  <path d="M7.5 9h6M7.5 12.5h6M7.5 16h4" />
                </svg>
              </button>
            )}
            {isAnalyticsUser(user) && (
              <button onClick={() => nav('/betting')} title="Betting analytics" aria-label="Betting analytics"
                className="p-2 text-white/70 hover:text-white active:scale-95 transition-all">
                {/* tennis ball */}
                <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M5.6 5.6a9 9 0 0 1 0 12.8M18.4 5.6a9 9 0 0 0 0 12.8" />
                </svg>
              </button>
            )}
            <NotificationBell user={user} />
          </div>
        </div>
      </div>

      <div className="px-5 mt-5 space-y-5">
        {fridayAsk && (
          <button onClick={() => nav('/my-bets')}
            className="w-full card text-left bg-amber-50 border-brand-400 flex items-center gap-3 active:scale-[0.99] transition-transform">
            <span className="text-xl">🎾</span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-black text-gray-900">Friday no-risk bet</span>
              <span className="block text-[11px] text-gray-600">How much did you stake, and did it win? Tap to add it.</span>
            </span>
            <span className="text-brand-600 font-black">›</span>
          </button>
        )}

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
              + New Expense
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

        {/* Groups (every group linked to a master group by members; the four most recently used first, the rest behind a toggle) */}
        {(allMasters.length > 0 || soloGroups.length > 0) && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                Recent groups
              </p>
              <button
                className="text-xs font-bold text-brand-500"
                onClick={() => nav('/groups')}
              >
                See all &rsaquo;
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {shownEntries.map((e) => e.node)}
            </div>

            {hiddenCount > 0 && (
              showSettled ? (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                    {hiddenEntries.map((e) => e.node)}
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
