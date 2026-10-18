import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createGroup, getGroups, listUsersBasic } from '../api'
import { useUser } from '../UserContext'
import { buildMasterGroups, pairKey } from '../utils/masterGroups'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
// Today as every dated group is named ("18 oct 26") - the same pattern a
// supergroup's "+ Add" uses, so this group sits in its timeline like any other.
const todayName = () => {
  const d = new Date()
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`
}
const lc = (s) => (s || '').trim().toLowerCase()

/**
 * "+ New Group": pick who it's with, nothing else. The group is named for
 * today and lands in a new supergroup named after those people. Someone on
 * the app is matched to their exact username (two "Ajay"s are told apart by
 * their full names); anyone else is added by the name typed.
 */
export default function NewGroup() {
  const nav = useNavigate()
  const user = useUser()
  const me = user?.name || ''

  const [appUsers, setAppUsers]   = useState([])   // [{ name, full_name }]
  const [known, setKnown]         = useState([])   // names from your own groups, commonest first
  const [allGroups, setAllGroups] = useState([])
  const [members, setMembers]     = useState([])   // everyone but you
  const [query, setQuery]         = useState('')
  const [choosing, setChoosing]   = useState(null) // { typed, options } when a name is ambiguous
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]         = useState('')

  useEffect(() => {
    listUsersBasic().then((r) => setAppUsers(r.data)).catch(() => setAppUsers([]))
    getGroups()
      .then((r) => {
        setAllGroups(r.data)
        const freq = new Map()
        r.data.forEach((g) => (g.member_names ?? []).forEach((n) => freq.set(n, (freq.get(n) || 0) + 1)))
        setKnown([...freq.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n))
      })
      .catch(() => setKnown([]))
  }, [])

  const appByName = useMemo(() => new Map(appUsers.map((u) => [lc(u.name), u])), [appUsers])
  const taken = (name) => lc(name) === lc(me) || members.some((m) => lc(m) === lc(name))
  const onApp = (name) => appByName.has(lc(name))

  // App users a typed name could mean: its username, or any word of their
  // full name, starting with what was typed.
  const appMatches = (q) => {
    const t = lc(q)
    if (!t) return []
    return appUsers.filter((u) => !taken(u.name) && (
      lc(u.name).startsWith(t) || lc(u.full_name).split(/\s+/).some((w) => w && w.startsWith(t))
    ))
  }

  const add = (name) => {
    const n = (name || '').trim()
    if (!n) return
    if (lc(n) === lc(me)) { setQuery(''); return setError("You're in the group already.") }
    if (taken(n)) return setQuery('')
    setMembers((m) => [...m, n])
    setQuery(''); setChoosing(null); setError('')
  }

  // Add/Enter with just a typed name: one app user it can mean -> them;
  // several -> ask which; none -> add the name as someone not on the app.
  const addTyped = () => {
    const typed = query.trim()
    if (!typed) return
    const exact = appUsers.filter((u) => lc(u.name) === lc(typed))
    const options = appMatches(typed)
    if (options.length > 1) return setChoosing({ typed, options })
    if (options.length === 1) return add(options[0].name)
    if (exact.length && taken(exact[0].name)) return setQuery('')
    add(typed)
  }

  const t = lc(query)
  const typedSuggestions = t ? appMatches(query) : []
  const knownOffApp = t
    ? known.filter((n) => !onApp(n) && !taken(n) && lc(n).includes(t)).slice(0, 4)
    : []
  const exactAppUser = appUsers.some((u) => lc(u.name) === t)
  const quick = known.filter((n) => !taken(n)).slice(0, 10)

  const everyone = [me, ...members].filter(Boolean)
  const existing = members.length > 0
    ? buildMasterGroups(allGroups, 1, me).masters.find((m) => m.key === pairKey(everyone))
    : null

  const create = async () => {
    setError('')
    if (!members.length) return setError('Add at least one person.')
    if (existing) return
    setSubmitting(true)
    try {
      const r = await createGroup({
        name: todayName(), description: '', category: 'other', emoji: '',
        members: everyone, created_by: me,
      })
      nav(`/groups/${r.data.id}`)
    } catch (err) {
      setError(err?.response?.data?.detail || 'Something went wrong')
      setSubmitting(false)
    }
  }

  const fullName = (name) => appByName.get(lc(name))?.full_name

  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream border-b border-amber-100/60 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => nav(-1)} className="btn-ghost" aria-label="Back">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div>
            <h1 className="text-xl font-bold">New Group</h1>
            <p className="text-[11px] text-gray-400 mt-0.5">Who's it with? It's named for today, <b>{todayName()}</b>.</p>
          </div>
        </div>
      </div>

      <div className="px-5 mt-5 space-y-5 max-w-2xl">
        {/* Who's in */}
        <div>
          <p className="label">Members</p>
          <div className="flex flex-wrap gap-2">
            <span className="bg-gray-100 text-gray-600 border border-gray-200 rounded-md px-3 py-1.5 text-sm font-bold">
              You
            </span>
            {members.map((m) => (
              <span key={m} className="flex items-center gap-1.5 bg-brand-400/15 text-brand-700 border border-brand-400/30 rounded-md pl-3 pr-2 py-1.5 text-sm font-bold">
                <span>
                  {m}
                  <span className="block text-[10px] font-semibold text-brand-700/60 leading-tight">
                    {onApp(m) ? (fullName(m) || 'on the app') : 'not on the app'}
                  </span>
                </span>
                <button type="button" onClick={() => setMembers((x) => x.filter((y) => y !== m))}
                  className="text-brand-400 hover:text-brand-700 px-1" aria-label={`Remove ${m}`}>×</button>
              </span>
            ))}
          </div>
        </div>

        {/* Add someone */}
        <div>
          <label htmlFor="member-search" className="label">Add a person</label>
          <div className="flex gap-2">
            <input
              id="member-search"
              className="input flex-1"
              placeholder="Name or username"
              value={query}
              autoComplete="off"
              autoCapitalize="words"
              onChange={(e) => { setQuery(e.target.value); setChoosing(null); setError('') }}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTyped())}
            />
            <button type="button" onClick={addTyped} disabled={!query.trim()}
              className="bg-brand-400 text-white px-4 font-bold text-sm shadow-sm rounded-md disabled:opacity-50">
              Add
            </button>
          </div>

          {/* Two or more people the typed name could be */}
          {choosing && (
            <div className="mt-2 border border-amber-300 bg-amber-50 rounded-md p-3">
              <p className="text-xs font-bold text-gray-800 mb-2">
                {choosing.options.length} people on the app match "{choosing.typed}" - which one?
              </p>
              <div className="space-y-1.5">
                {choosing.options.map((u) => (
                  <button key={u.name} type="button" onClick={() => add(u.name)}
                    className="w-full text-left bg-white border border-amber-200 rounded-md px-3 py-2 hover:bg-amber-100">
                    <span className="text-sm font-bold text-gray-800">{u.name}</span>
                    <span className="block text-[11px] text-gray-500">{u.full_name || 'no full name set'}</span>
                  </button>
                ))}
                {!onApp(choosing.typed) && (
                  <button type="button" onClick={() => add(choosing.typed)}
                    className="w-full text-left text-xs font-bold text-gray-600 px-3 py-1.5">
                    Neither - add "{choosing.typed}" (not on the app)
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Live matches while typing */}
          {!choosing && t && (typedSuggestions.length > 0 || knownOffApp.length > 0 || !exactAppUser) && (
            <div className="mt-2 border border-amber-200 bg-white rounded-md divide-y divide-amber-100">
              {typedSuggestions.slice(0, 6).map((u) => (
                <button key={u.name} type="button" onClick={() => add(u.name)}
                  className="w-full text-left px-3 py-2 hover:bg-amber-50 flex items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="text-sm font-bold text-gray-800">{u.name}</span>
                    {u.full_name && <span className="text-xs text-gray-500"> · {u.full_name}</span>}
                  </span>
                  <span className="text-[10px] font-bold text-green-700 flex-shrink-0">ON THE APP</span>
                </button>
              ))}
              {knownOffApp.map((n) => (
                <button key={n} type="button" onClick={() => add(n)}
                  className="w-full text-left px-3 py-2 hover:bg-amber-50 flex items-center justify-between gap-3">
                  <span className="text-sm font-bold text-gray-800">{n}</span>
                  <span className="text-[10px] font-bold text-gray-400 flex-shrink-0">FROM YOUR GROUPS</span>
                </button>
              ))}
              {!exactAppUser && !taken(query) && !knownOffApp.some((n) => lc(n) === t) && (
                <button type="button" onClick={() => add(query)}
                  className="w-full text-left px-3 py-2 hover:bg-amber-50 text-sm text-gray-600">
                  + Add "<b>{query.trim()}</b>" <span className="text-xs text-gray-400">(not on the app)</span>
                </button>
              )}
            </div>
          )}

          {!t && quick.length > 0 && (
            <div className="mt-3">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">People you split with</p>
              <div className="flex flex-wrap gap-1.5">
                {quick.map((n) => (
                  <button key={n} type="button" onClick={() => add(n)}
                    className="bg-cream border border-amber-200 text-gray-600 hover:bg-amber-50 hover:text-gray-900 rounded-md px-2.5 py-1 text-xs font-bold active:scale-95 transition-all">
                    + {n}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {existing && (
          <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-md px-4 py-3 space-y-2">
            <p>
              You already have <b>{existing.name}</b> ({existing.groups.length} group{existing.groups.length === 1 ? '' : 's'}) with
              exactly these people. New groups with them go there - open it and tap <b>+ Add</b>.
            </p>
            <button type="button" onClick={() => nav(`/master/${encodeURIComponent(existing.key)}`, { state: { master: existing } })}
              className="font-bold text-brand-600">Open {existing.name} ›</button>
          </div>
        )}

        {error && <p className="text-sm text-red-500 bg-red-50 border border-red-100 rounded-md px-4 py-3">{error}</p>}

        <button type="button" onClick={create} className="btn-primary disabled:opacity-50"
          disabled={submitting || !!existing || members.length === 0}>
          {submitting
            ? 'Creating…'
            : members.length === 0
              ? 'Add someone to start'
              : `Create group with ${members.length} ${members.length === 1 ? 'person' : 'people'}`}
        </button>
      </div>
    </div>
  )
}
