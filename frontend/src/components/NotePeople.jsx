import { useEffect, useState } from 'react'
import { dn } from '../utils/displayName'
import { listUsersBasic } from '../api/index.js'

/**
 * Who a note is shared with: people on the app (found by name - they can
 * open and edit it) or any name typed for someone who isn't (just noted).
 * people: [{ name, on_app }]
 */
export default function NotePeople({ me, people, setPeople }) {
  const [users, setUsers] = useState(null)
  const [q, setQ] = useState('')
  useEffect(() => { listUsersBasic().then((r) => setUsers(r.data)).catch(() => setUsers([])) }, [])

  const has = new Set([me, ...people.map((p) => p.name)].map((n) => (n || '').toLowerCase()))
  const term = q.trim().toLowerCase()
  const matches = term
    ? (users || []).filter((u) => !has.has(u.name.toLowerCase())
        && (u.name.toLowerCase().includes(term) || (u.full_name || '').toLowerCase().includes(term))).slice(0, 8)
    : []
  const exact = (users || []).find((u) => u.name.toLowerCase() === term)
  const label = (u) => (u.full_name && u.full_name !== u.name ? `${u.full_name} (${u.name})` : u.name)
  const add = (name, onApp) => { if (!has.has(name.toLowerCase())) setPeople([...people, { name, on_app: onApp }]); setQ('') }
  const addTyped = () => {
    const n = q.trim().replace(/\s+/g, ' ')
    if (!n) return
    if (exact) return add(exact.name, true)
    if (matches.length === 1) return add(matches[0].name, true)
    add(n, false)
  }

  return (
    <div className="space-y-1.5">
      {people.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {people.map((p) => (
            <span key={p.name} className={`flex items-center gap-1 text-[11px] font-bold pl-2 pr-1 py-0.5 border ${
              p.on_app ? 'bg-brand-50 border-brand-200 text-gray-800' : 'bg-amber-50 border-amber-200 text-gray-700'}`}>
              {p.on_app ? dn(p.name) : p.name}{!p.on_app && <span className="font-normal text-gray-400"> · not on app</span>}
              <button type="button" onClick={() => setPeople(people.filter((x) => x.name !== p.name))}
                className="text-gray-400 hover:text-red-600 px-0.5" aria-label={`Remove ${p.name}`}>✕</button>
            </span>
          ))}
        </div>
      )}
      <input value={q} onChange={(e) => setQ(e.target.value)} className="input text-xs py-1.5"
        placeholder="Search people on the app, or type any name"
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTyped() } }} />
      {term && (
        <div className="flex flex-wrap gap-1.5">
          {matches.map((u) => (
            <button key={u.id} type="button" onClick={() => add(u.name, true)}
              className="text-[11px] font-bold bg-white border border-amber-200 hover:border-brand-300 text-gray-700 px-2 py-0.5">
              + {label(u)}
            </button>
          ))}
          {!exact && users !== null && (
            <button type="button" onClick={() => add(q.trim().replace(/\s+/g, ' '), false)}
              className="text-[11px] font-bold bg-white border border-dashed border-amber-300 text-gray-600 px-2 py-0.5">
              + Add "{q.trim()}" - not on the app
            </button>
          )}
        </div>
      )}
      <p className="text-[10px] text-gray-400">
        {people.length ? 'People on the app can open and edit it. Names not on the app are just noted.' : 'No one picked - only you can see it.'}
      </p>
    </div>
  )
}
