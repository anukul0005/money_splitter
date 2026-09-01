import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getFriends } from '../api'
import { useUser } from '../UserContext'
import LoadingSpinner from '../components/LoadingSpinner'

const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

/**
 * /balances/owe and /balances/owed — what makes up the two Home figures.
 *
 * Balances are netted per person across every group, which is what you'd
 * actually hand over. A person's total can therefore be smaller than any one
 * group suggests, so each person lists the groups on both sides of their
 * balance — the ones you owe in and the ones that cancel them out.
 */
export default function Balances() {
  const nav  = useNavigate()
  const user = useUser()
  const { kind } = useParams()             // 'owe' | 'owed'
  const owing = kind !== 'owed'

  const [friends, setFriends] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user?.name) { setLoading(false); return }
    getFriends(user.name)
      .then((r) => setFriends(r.data))
      .catch(() => setFriends([]))
      .finally(() => setLoading(false))
  }, [user?.name])

  if (loading) return <LoadingSpinner />

  const rows = friends
    .filter((f) => (owing ? f.net < -0.01 : f.net > 0.01))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))

  const total = rows.reduce((s, f) => s + Math.abs(f.net), 0)

  return (
    <div className="pb-24 md:pb-8">
      <div
        className={`px-5 pt-10 md:pt-8 pb-6 md:rounded-b-3xl border-b text-white ${
          owing
            ? 'bg-gradient-to-br from-red-700 to-field-950 border-red-900'
            : 'bg-gradient-to-br from-green-700 to-field-950 border-green-900'
        }`}
      >
        <button onClick={() => nav('/')} className="text-xs font-bold text-white/50 mb-2">← Home</button>
        <p className="text-white/60 text-xs font-bold uppercase tracking-widest">
          {owing ? 'You owe' : 'Owed to you'}
        </p>
        <h1 className="text-4xl font-black mt-1 tracking-tight">{INR(total)}</h1>
        <p className="text-white/50 text-xs mt-1 font-medium">
          across {rows.length} {rows.length === 1 ? 'person' : 'people'}
        </p>
      </div>

      <div className="px-5 mt-5 space-y-3 max-w-2xl">
        {rows.length === 0 && (
          <div className="text-center py-20">
            <p className="text-3xl mb-2">✅</p>
            <p className="text-sm text-gray-400">
              {owing ? "You don't owe anyone right now." : 'Nobody owes you right now.'}
            </p>
          </div>
        )}

        {rows.map((f) => {
          // Groups that push this balance the way the page is showing, and the
          // ones pulling the other way — together they explain the net.
          const same = f.groups.filter((g) => (owing ? g.net < 0 : g.net > 0))
          const opposite = f.groups.filter((g) => (owing ? g.net > 0 : g.net < 0))

          return (
            <div key={f.name} className="card">
              <div className="flex items-center justify-between gap-3 mb-3">
                <button
                  onClick={() => nav(`/friends/${encodeURIComponent(f.name)}`)}
                  className="text-sm font-bold text-gray-900 hover:text-brand-600 truncate"
                >
                  {f.name} →
                </button>
                <span className={`text-lg font-black flex-shrink-0 ${owing ? 'text-red-600' : 'text-green-600'}`}>
                  {INR(Math.abs(f.net))}
                </span>
              </div>

              <div className="space-y-1.5">
                {same.map((g) => (
                  <button
                    key={g.group_id}
                    onClick={() => nav(`/groups/${g.group_id}`)}
                    className={`w-full text-left flex items-center gap-2 rounded-md px-3 py-2 border transition-colors ${
                      owing
                        ? 'bg-red-50 border-red-100 hover:bg-red-100'
                        : 'bg-green-50 border-green-200 hover:bg-green-100'
                    }`}
                  >
                    <span className="text-xs font-semibold text-gray-700 flex-1 min-w-0 truncate">{g.name}</span>
                    <span className={`text-xs font-black flex-shrink-0 ${owing ? 'text-red-700' : 'text-green-700'}`}>
                      {INR(Math.abs(g.net))}
                    </span>
                  </button>
                ))}

                {opposite.length > 0 && (
                  <>
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pt-2">
                      Cancelled out by
                    </p>
                    {opposite.map((g) => (
                      <button
                        key={g.group_id}
                        onClick={() => nav(`/groups/${g.group_id}`)}
                        className="w-full text-left flex items-center gap-2 rounded-md px-3 py-2 border border-amber-200 bg-amber-50 hover:bg-amber-100 transition-colors"
                      >
                        <span className="text-xs font-semibold text-gray-600 flex-1 min-w-0 truncate">{g.name}</span>
                        <span className="text-xs font-bold text-gray-500 flex-shrink-0">
                          −{INR(Math.abs(g.net))}
                        </span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
