import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getGroup, updateGroup } from '../api/index.js'
import LoadingSpinner from '../components/LoadingSpinner'

export default function EditGroup() {
  const { id } = useParams()
  const nav = useNavigate()

  const [loading, setLoading]       = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]           = useState('')
  const [name, setName]             = useState('')
  const [description, setDescription] = useState('')
  const [members, setMembers]       = useState([])   // existing { id, name }
  const [newInput, setNewInput]     = useState('')
  const [toRemove, setToRemove]     = useState([])   // ids to remove

  useEffect(() => {
    getGroup(id)
      .then((r) => {
        setName(r.data.name)
        setDescription(r.data.description || '')
        setMembers(r.data.members)
      })
      .catch(() => setError('Could not load group'))
      .finally(() => setLoading(false))
  }, [id])

  const addNew = () => {
    const trimmed = newInput.trim()
    if (!trimmed) return
    const alreadyExists = members.some((m) => m.name.toLowerCase() === trimmed.toLowerCase())
    if (alreadyExists) return
    // Optimistically show as a "pending" new member (id = null)
    setMembers((m) => [...m, { id: null, name: trimmed }])
    setNewInput('')
  }

  const toggleRemove = (memberId) => {
    if (memberId === null) {
      // pending new member — just remove from list
      setMembers((m) => m.filter((x) => x.id !== null || x.name !== members.find((x) => x.id === null)?.name))
      return
    }
    setToRemove((r) => r.includes(memberId) ? r.filter((x) => x !== memberId) : [...r, memberId])
  }

  const removePending = (name) => {
    setMembers((m) => m.filter((x) => !(x.id === null && x.name === name)))
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (!name.trim()) return setError('Group name is required')

    const membersAdd = members.filter((m) => m.id === null).map((m) => m.name)
    const remainingExisting = members.filter((m) => m.id !== null && !toRemove.includes(m.id))
    if (remainingExisting.length + membersAdd.length < 1)
      return setError('Group must have at least one member')

    setSubmitting(true)
    try {
      await updateGroup(id, {
        name: name.trim(),
        description: description.trim() || null,
        members_add: membersAdd,
        members_remove: toRemove,
      })
      nav(`/groups/${id}`)
    } catch (err) {
      setError(err?.response?.data?.detail || 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <LoadingSpinner />

  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream border-b border-amber-100/60 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => nav(-1)} className="btn-ghost">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-bold">Edit Group</h1>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="px-5 mt-5 space-y-5 max-w-2xl">
        {/* Name */}
        <div>
          <label className="label">Group name *</label>
          <input
            className="input"
            placeholder="e.g. Goa Trip 2025"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        {/* Description */}
        <div>
          <label className="label">Description (optional)</label>
          <input
            className="input"
            placeholder="Short description…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {/* Members */}
        <div>
          <label className="label">Members</label>
          <div className="space-y-2 mb-3">
            {members.map((m) => {
              const markedForRemoval = m.id !== null && toRemove.includes(m.id)
              const isPending = m.id === null
              return (
                <div
                  key={m.id ?? `new-${m.name}`}
                  className={`flex items-center justify-between px-4 py-2.5 rounded-xl border transition-colors ${
                    markedForRemoval
                      ? 'bg-red-50 border-red-200 text-red-400 line-through'
                      : isPending
                      ? 'bg-brand-400/10 border-brand-400/30 text-brand-700'
                      : 'bg-cream border-amber-200 text-gray-800'
                  }`}
                >
                  <span className="text-sm font-semibold">{m.name}</span>
                  <div className="flex items-center gap-2">
                    {isPending && (
                      <span className="text-xs text-brand-600 font-medium bg-brand-400/10 px-2 py-0.5 rounded-full">new</span>
                    )}
                    <button
                      type="button"
                      onClick={() => isPending ? removePending(m.name) : toggleRemove(m.id)}
                      className={`text-xs font-semibold transition-colors ${
                        markedForRemoval ? 'text-brand-600' : 'text-red-400 hover:text-red-600'
                      }`}
                    >
                      {markedForRemoval ? 'Undo' : 'Remove'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="flex gap-2">
            <input
              className="input flex-1"
              placeholder="Add a new member"
              value={newInput}
              onChange={(e) => setNewInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addNew())}
            />
            <button
              type="button"
              onClick={addNew}
              className="bg-brand-400 text-gray-900 px-4 rounded-xl font-bold text-sm shadow-sm"
            >
              Add
            </button>
          </div>
        </div>

        {error && <p className="text-sm text-red-500 bg-red-50 rounded-xl px-4 py-3">{error}</p>}

        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save Changes'}
        </button>
      </form>
    </div>
  )
}
