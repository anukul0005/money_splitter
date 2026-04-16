import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createGroup } from '../api'

export default function NewGroup() {
  const nav = useNavigate()
  const [form, setForm]             = useState({ name: '', description: '' })
  const [memberInput, setMInput]    = useState('')
  const [members, setMembers]       = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]           = useState('')

  const addMember = () => {
    const name = memberInput.trim()
    if (!name || members.includes(name)) return
    setMembers((m) => [...m, name])
    setMInput('')
  }

  const removeMember = (name) => setMembers((m) => m.filter((x) => x !== name))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (!form.name.trim()) return setError('Group name is required')
    if (members.length < 1) return setError('Add at least one member')

    setSubmitting(true)
    try {
      const r = await createGroup({ ...form, emoji: '', members })
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

        {/* Members */}
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
              className="bg-brand-400 text-gray-900 px-4 rounded-xl font-bold text-sm shadow-sm"
            >
              Add
            </button>
          </div>

          {members.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {members.map((m) => (
                <span
                  key={m}
                  className="flex items-center gap-1.5 bg-brand-400/15 text-brand-700 border border-brand-400/30 px-3 py-1.5 rounded-full text-sm font-semibold"
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

        {error && <p className="text-sm text-red-500 bg-red-50 rounded-xl px-4 py-3">{error}</p>}

        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? 'Creating…' : `Create Group with ${members.length} member${members.length !== 1 ? 's' : ''}`}
        </button>
      </form>
    </div>
  )
}
