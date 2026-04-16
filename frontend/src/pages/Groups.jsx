import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getGroups } from '../api'
import GroupCard from '../components/GroupCard'
import LoadingSpinner from '../components/LoadingSpinner'

export default function Groups() {
  const nav = useNavigate()
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    getGroups().then((r) => setGroups(r.data)).finally(() => setLoading(false))
  }, [])

  const filtered = groups.filter((g) =>
    filter === 'all' ? true : filter === 'historical' ? g.is_historical : !g.is_historical
  )

  if (loading) return <LoadingSpinner />

  return (
    <div className="pb-24 md:pb-8">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream sticky top-0 z-10 border-b border-amber-100/60">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-black tracking-tight">Groups</h1>
          <button className="bg-brand-400 text-gray-900 text-xs font-bold px-3 py-1.5 rounded-lg shadow-sm" onClick={() => nav('/groups/new')}>
            + New
          </button>
        </div>
        <div className="flex gap-2 mt-3">
          {['all','active','historical'].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded-full text-xs font-bold transition-colors capitalize ${
                filter === f ? 'bg-brand-400 text-gray-900' : 'bg-amber-50 border border-amber-200 text-gray-500'
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
    </div>
  )
}
