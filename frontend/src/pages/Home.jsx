import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getGroups, getOverview, getUserSummary } from '../api'
import GroupCard from '../components/GroupCard'
import LoadingSpinner from '../components/LoadingSpinner'
import { useUser, isAdmin } from '../UserContext'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

export default function Home() {
  const nav = useNavigate()
  const user = useUser()
  const admin = isAdmin(user)

  const [groups, setGroups]       = useState([])
  const [overview, setOverview]   = useState([])
  const [userStats, setUserStats] = useState(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')

  const load = () => {
    setLoading(true)
    setError('')
    const calls = [getGroups(), getOverview()]
    if (user?.name) calls.push(getUserSummary(user.name))
    Promise.all(calls)
      .then(([g, o, u]) => {
        setGroups(g.data)
        setOverview(o.data)
        if (u) setUserStats(u.data)
      })
      .catch(() => setError('Could not reach server. The API may be waking up — please try again in 30 seconds.'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const filterForUser = (list) => {
    if (admin) return list
    return list.filter((g) =>
      (g.member_names ?? []).some((n) => n.toLowerCase() === user?.name?.toLowerCase())
    )
  }

  const visibleGroups   = filterForUser(groups)
  const visibleIds      = new Set(visibleGroups.map((g) => g.id))
  const visibleOverview = overview.filter((g) => visibleIds.has(g.id))
  const totalSpend      = visibleOverview.reduce((s, g) => s + g.total, 0)

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

  const net = userStats?.net ?? 0
  const netPositive = net >= 0

  return (
    <div className="pb-24 md:pb-8">
      {/* Header */}
      <div className="bg-gradient-to-br from-field-800 to-field-950 text-white px-5 pt-10 md:pt-8 pb-6 md:rounded-b-3xl border-b border-field-700">
        <p className="text-brand-400/70 text-xs font-bold uppercase tracking-widest">Total spent across all groups</p>
        <h1 className="text-4xl font-black mt-1 tracking-tight">{INR(totalSpend)}</h1>
        <p className="text-green-200/40 text-xs mt-1 font-medium">{visibleGroups.length} groups</p>
      </div>

      <div className="px-5 mt-5">

        {/* Personal KPI cards */}
        {userStats && userStats.groups_count > 0 && (
          <div className="mb-5">
            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">
              {user?.name}'s Overview
            </p>
            <div className="grid grid-cols-3 gap-2">
              <div className="card text-center py-3">
                <p className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide leading-tight">Total Paid</p>
                <p className="text-sm font-black text-gray-900 mt-1">{INR(userStats.total_paid)}</p>
              </div>
              <div className="card text-center py-3">
                <p className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide leading-tight">My Share</p>
                <p className="text-sm font-black text-gray-900 mt-1">{INR(userStats.total_share)}</p>
              </div>
              <div className="card text-center py-3">
                <p className={`text-[10px] font-semibold uppercase tracking-wide leading-tight ${netPositive ? 'text-brand-600' : 'text-red-500'}`}>
                  {netPositive ? 'Owed to me' : 'I owe'}
                </p>
                <p className={`text-sm font-black mt-1 ${netPositive ? 'text-brand-600' : 'text-red-500'}`}>
                  {INR(Math.abs(net))}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Admin quick actions */}
        {admin && (
          <div className="grid grid-cols-2 gap-3 mb-5">
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

        {/* All groups list */}
        <div>
          <h2 className="text-sm font-semibold text-gray-500 mb-3 uppercase tracking-wide">All Groups</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {visibleGroups.map((g) => (
              <GroupCard key={g.id} group={g} />
            ))}
          </div>
          {visibleGroups.length === 0 && (
            <div className="text-center py-12 text-gray-400">
              <svg className="w-10 h-10 mx-auto mb-2 text-gray-300" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m9-4.13a4 4 0 11-8 0 4 4 0 018 0zm6 0a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              <p className="text-sm">No groups yet.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
