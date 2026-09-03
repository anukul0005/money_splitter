import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { createGroup, getGroups } from '../api'
import { useUser } from '../UserContext'

export default function NewGroup() {
  const nav = useNavigate()
  const user = useUser()
  const [params] = useSearchParams()

  // Members handed over by a supergroup. Coming from one, the people are
  // already decided — that is what the supergroup is — so being asked to pick
  // them again is a question with only one right answer.
  const preset = (params.get('members') || '')
    .split(',').map((x) => x.trim()).filter(Boolean)
  const fromSupergroup = preset.length > 0

  const [form, setForm]             = useState({ name: '', description: '', category: '' })
  const [memberInput, setMInput]    = useState('')
  // You are added by default: the API only shows you groups you're in, so a
  // group created without yourself would vanish the moment it was made.
  const [members, setMembers]       = useState(() =>
    preset.length ? preset : (user?.name ? [user.name] : [])
  )
  const [known, setKnown]           = useState([])   // people you already share groups with
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]           = useState('')

  // Suggest the people you actually split with, commonest first, so the usual
  // handful never has to be typed out.
  useEffect(() => {
    getGroups()
      .then((r) => {
        const freq = new Map()
        r.data.forEach((g) => (g.member_names ?? []).forEach((n) => {
          freq.set(n, (freq.get(n) || 0) + 1)
        }))
        setKnown([...freq.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n))
      })
      .catch(() => setKnown([]))
  }, [])

  const addName = (raw) => {
    const name = (raw || '').trim()
    if (!name) return
    // Case-insensitive: "anjali" and "Anjali" must not become two members
    if (members.some((m) => m.toLowerCase() === name.toLowerCase())) return
    setMembers((m) => [...m, name])
  }

  const addMember = () => { addName(memberInput); setMInput('') }

  const removeMember = (name) => setMembers((m) => m.filter((x) => x !== name))

  const suggestions = known.filter(
    (n) => !members.some((m) => m.toLowerCase() === n.toLowerCase())
  )
  const includesMe = !user?.name || members.some(
    (m) => m.toLowerCase() === user.name.toLowerCase()
  )

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (!form.name.trim()) return setError('Group name is required')
    if (members.length < 1) return setError('Add at least one member')

    setSubmitting(true)
    try {
      const r = await createGroup({ ...form, emoji: '', members, created_by: user?.name })
      nav(`/groups/${r.data.id}`)
    } catch (err) {
      setError(err?.response?.data?.detail || 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream border-b border-amber-100/60 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => nav(-1)} className="btn-ghost">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-bold">New Group</h1>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="px-5 mt-5 space-y-5 max-w-2xl">
        {/* Name */}
        <div>
          <label className="label">Group name *</label>
          <input
            className="input"
            placeholder="e.g. Goa Trip 2025"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </div>

        {/* Description */}
        <div>
          <label className="label">Description (optional)</label>
          <input
            className="input"
            placeholder="Short description…"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </div>

        {/* Category */}
        <div>
          <label className="label">Category</label>
          <div className="flex gap-2 flex-wrap">
            {['trip', 'outing', 'festival', 'personal', 'other'].map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setForm((f) => ({ ...f, category: f.category === c ? '' : c }))}
                className={`px-3 py-1.5 text-xs font-bold border transition-colors capitalize ${
                  form.category === c
                    ? 'bg-brand-400 text-white border-brand-400'
                    : 'bg-cream text-gray-400 border-amber-200 hover:text-gray-700'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        {/* Members. From a supergroup they are already settled, so the card
            just states who is in and gets out of the way. */}
        {fromSupergroup ? (
          <div>
            <label className="label">Members</label>
            <div className="flex flex-wrap gap-2">
              {members.map((m) => (
                <span
                  key={m}
                  className="bg-brand-400/15 text-brand-700 border border-brand-400/30 rounded-md px-3 py-1.5 text-sm font-bold"
                >
                  {m}
                </span>
              ))}
            </div>
            <p className="text-[10px] text-gray-400 mt-1.5">
              Carried over from the group you came from. Add or remove people
              from the group once it exists.
            </p>
          </div>
        ) : (
        <div>
          <label className="label">Add members *</label>
          <div className="flex gap-2">
            <input
              className="input flex-1"
              placeholder="Member name"
              value={memberInput}
              onChange={(e) => setMInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addMember())}
            />
            <button
              type="button"
              onClick={addMember}
              className="bg-brand-400 text-white px-4 font-bold text-sm shadow-sm"
            >
              Add
            </button>
          </div>

          {suggestions.length > 0 && (
            <div className="mt-3">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                Tap to add
              </p>
              <div className="flex flex-wrap gap-1.5">
                {suggestions.slice(0, 12).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => addName(n)}
                    className="bg-cream border border-amber-200 text-gray-600 hover:bg-amber-50 hover:text-gray-900 rounded-md px-2.5 py-1 text-xs font-bold active:scale-95 transition-all"
                  >
                    + {n}
                  </button>
                ))}
              </div>
            </div>
          )}

          {members.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {members.map((m) => (
                <span
                  key={m}
                  className="flex items-center gap-1.5 bg-brand-400/15 text-brand-700 border border-brand-400/30 rounded-md px-3 py-1.5 text-sm font-bold"
                >
                  {m}
                  <button type="button" onClick={() => removeMember(m)} className="text-brand-400 hover:text-brand-700">
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        )}

        {!includesMe && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-4 py-3">
            You're not in this group, so it won't appear anywhere for you once
            it's created — only its members can see it.
          </p>
        )}

        {error && <p className="text-sm text-red-500 bg-red-50 border border-red-100 rounded-md px-4 py-3">{error}</p>}

        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? 'Creating…' : `Create Group with ${members.length} member${members.length !== 1 ? 's' : ''}`}
        </button>
      </form>
    </div>
  )
}
