import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listDiscussions, createDiscussion, suggestQuoteFields, listNotes, createNote } from '../api/index.js'
import NotePeople from '../components/NotePeople'
import LoadingSpinner from '../components/LoadingSpinner'
import PeoplePicker from '../components/DiscussionPeoplePicker'
import { useUser } from '../UserContext'
import { dn as displayName } from '../utils/displayName'

// "only you" / "with Anjali, Shreya" / "by Utkarsh, with you"
const sharedLine = (n, me) => {
  const lower = (me || '').toLowerCase()
  const others = (n.people || []).map((p) => (p.name.toLowerCase() === lower ? 'you' : displayName(p.name)))
  if (n.owner.toLowerCase() !== lower) return `by ${displayName(n.owner)}, with ${others.join(', ') || 'you'}`
  if (others.length) return `with ${others.join(', ')}`
  return n.group ? `shared with ${n.group}` : 'only you'
}

export const ago = (t) => {
  if (!t) return ''
  const s = (Date.now() - new Date(t).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`
  return new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

/**
 * Discussions: every planning thread in the caller's groups - the latest
 * first, with what's waiting on them - and starting a new one.
 */
export default function Discussions() {
  const nav = useNavigate()
  const user = useUser()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [noting, setNoting] = useState(false)
  const [notes, setNotes] = useState(null)

  const load = () => listDiscussions().then((r) => setRows(r.data)).catch(() => setError('Could not reach server - try again in a moment.'))
  useEffect(() => {
    load()
    listNotes().then((r) => setNotes(r.data)).catch(() => setNotes([]))
  }, [])

  if (!rows && !error) return <LoadingSpinner />

  return (
    <div className="pb-24 md:pb-8">
      <div className="bg-gradient-to-br from-field-800 to-field-950 text-white px-5 pt-10 md:pt-8 pb-5 border-b border-field-700">
        <button onClick={() => nav('/')} className="text-slate-300/70 text-xs font-bold">‹ Home</button>
        <h1 className="text-2xl font-black mt-2 tracking-tight">Discussions</h1>
        <p className="text-slate-300/70 text-xs mt-1">
          Plan with your group - direct enquiries, invite others by email, line up quotes. Or keep a note as a table, with your own columns.
        </p>
        {!creating && !noting && (
          <div className="flex flex-wrap gap-2 mt-4">
            <button onClick={() => setCreating(true)} className="btn-primary !w-auto text-sm px-4">+ New discussion</button>
            <button onClick={() => setNoting(true)}
              className="text-sm font-bold px-4 py-2.5 border border-slate-300/50 text-white hover:bg-white/10">+ New note</button>
          </div>
        )}
      </div>

      <div className="px-4 md:px-5 mt-4 space-y-3 max-w-2xl">
        {creating && <NewDiscussion onCancel={() => setCreating(false)} onCreated={(id) => nav(`/discuss/${id}`)} />}
        {noting && <NewNote onCancel={() => setNoting(false)} onCreated={(id) => nav(`/notes/${id}`)} />}
        {error && <p className="text-sm text-red-600">{error}</p>}

        {notes?.length > 0 && (
          <div>
            <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Notes</p>
            <div className="space-y-2">
              {notes.map((n) => (
                <button key={n.id} onClick={() => nav(`/notes/${n.id}`)}
                  className="card w-full text-left hover:border-brand-300 active:scale-[0.99] transition-all">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-black text-gray-900 truncate">{n.title}</p>
                    <span className="text-[10px] text-gray-400 shrink-0">{ago(n.updated_at)}</span>
                  </div>
                  <p className="text-[11px] text-gray-500 truncate">{n.columns.join(' · ')}</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">
                    {n.count} row{n.count === 1 ? '' : 's'} · {sharedLine(n, user?.name)}
                  </p>
                </button>
              ))}
            </div>
          </div>
        )}
        {rows?.length > 0 && notes?.length > 0 && (
          <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest -mb-1">Discussions</p>
        )}

        {rows?.length === 0 && !creating && !noting && (
          <div className="card text-center py-8">
            <p className="text-sm font-bold text-gray-800">No discussions yet</p>
            <p className="text-xs text-gray-500 mt-1">Start one for wedding venues, a trip's hotels, caterers - anything the group is planning.</p>
          </div>
        )}

        {rows?.map((d) => (
          <button key={d.id} onClick={() => nav(`/discuss/${d.id}`)}
            className="card w-full text-left hover:border-brand-300 active:scale-[0.99] transition-all">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-black text-gray-900 truncate">{d.title}</p>
                <p className="text-[11px] text-gray-400 truncate">
                  {d.group.name !== d.title && <>{d.group.name} · </>}
                  {d.members.map((n) => displayName(n, d.members)).join(', ')}
                </p>
              </div>
              <span className="text-[10px] text-gray-400 shrink-0">{ago(d.last?.at || d.updated_at)}</span>
            </div>
            {d.last && (
              <p className="text-xs text-gray-600 mt-1.5 line-clamp-2">
                <span className="font-bold">{displayName(d.last.author)}:</span> {d.last.text.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, '')}
              </p>
            )}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {d.my_open_tasks > 0 && (
                <span className="text-[10px] font-bold bg-red-50 border border-red-200 text-red-700 px-2 py-0.5">
                  {d.my_open_tasks} asked of you
                </span>
              )}
              <span className="text-[10px] font-bold bg-amber-50 border border-amber-200 text-gray-600 px-2 py-0.5">{d.messages} message{d.messages === 1 ? '' : 's'}</span>
              <span className="text-[10px] font-bold bg-green-50 border border-green-200 text-green-800 px-2 py-0.5">{d.quotes} quote{d.quotes === 1 ? '' : 's'}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Pick the people (app users, or emails for anyone else), name it, and set
 * the fields every quote will be noted in. A new group is made for it.
 */
function NewDiscussion({ onCancel, onCreated }) {
  const user = useUser()
  const [members, setMembers] = useState([])
  const [emails, setEmails] = useState([])
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [params, setParams] = useState([])
  const [draft, setDraft] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  const addParam = (label) => {
    const l = label.trim()
    if (l && !params.some((p) => p.label.toLowerCase() === l.toLowerCase())) setParams((ps) => [...ps, { label: l, unit: '' }])
    setDraft('')
  }
  const suggest = async () => {
    setErr(''); setSuggesting(true)
    try {
      const { data } = await suggestQuoteFields({ title, description })
      setParams((ps) => [...ps, ...data.params.filter((p) => !ps.some((q) => q.label.toLowerCase() === p.label.toLowerCase()))])
    } catch (e) {
      setErr(e.response?.data?.detail || "Couldn't get suggestions.")
    } finally { setSuggesting(false) }
  }
  const save = async (e) => {
    e.preventDefault()
    if (!title.trim() || !description.trim() || !(members.length || emails.length)) return
    setSaving(true); setErr('')
    try {
      const { data } = await createDiscussion({ title, description, params, members, invite_emails: emails })
      onCreated(data.id)
    } catch (e2) {
      setErr(e2.response?.data?.detail || "Couldn't create it.")
      setSaving(false)
    }
  }
  return (
    <form onSubmit={save} className="card space-y-3">
      <p className="text-xs font-black text-gray-500 uppercase tracking-widest">New discussion</p>
      <label className="block text-[11px] font-bold text-gray-600">Topic
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className="input text-sm mt-1"
          placeholder="e.g. Wedding banquets in Jaipur" />
      </label>
      <label className="block text-[11px] font-bold text-gray-600">Details <span className="text-red-500">*</span> <span className="font-normal text-gray-400">- what everyone should ask about</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="input text-sm mt-1"
          placeholder="Date, guest count, budget, area, must-haves…" required />
      </label>

      <div>
        <p className="text-[11px] font-bold text-gray-600 mb-1">People <span className="font-normal text-gray-400">- a new group is made with you and them</span></p>
        <PeoplePicker me={user?.name} members={members} setMembers={setMembers} emails={emails} setEmails={setEmails} onError={setErr} />
      </div>

      <div>
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-bold text-gray-600">Quote fields <span className="font-normal text-gray-400">- noted for every quote, to compare</span></p>
          <button type="button" onClick={suggest} disabled={!title.trim() || suggesting}
            className="text-[11px] font-bold text-brand-600 disabled:opacity-40">{suggesting ? 'Thinking…' : 'Suggest'}</button>
        </div>
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {params.map((p, i) => (
            <span key={p.label} className="flex items-center gap-1 text-[11px] font-bold bg-amber-50 border border-amber-200 text-gray-700 pl-2 pr-1 py-0.5">
              {p.label}{p.unit ? <span className="font-normal text-gray-400">({p.unit})</span> : null}
              <button type="button" onClick={() => setParams((ps) => ps.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-600 px-0.5" aria-label={`Remove ${p.label}`}>✕</button>
            </span>
          ))}
        </div>
        <div className="flex gap-2 mt-1.5">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} className="input text-xs py-1.5 flex-1"
            placeholder="Add a field - e.g. Price per plate"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addParam(draft) } }} />
          <button type="button" onClick={() => addParam(draft)} disabled={!draft.trim()} className="text-xs font-bold text-brand-600 disabled:opacity-40 px-2">Add</button>
        </div>
      </div>

      {err && <p className="text-xs text-red-600">{typeof err === 'string' ? err : 'Check the details.'}</p>}
      <div className="flex gap-3">
        <button type="submit" disabled={!title.trim() || !description.trim() || !(members.length || emails.length) || saving} className="btn-primary text-sm disabled:opacity-50">
          {saving ? 'Creating…' : 'Start discussion'}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-bold text-gray-500">Cancel</button>
      </div>
    </form>
  )
}

/**
 * A note: what it's about, the column headers to keep (Name, Phone, Price…),
 * and whether it's just yours or shared with a group.
 */
function NewNote({ onCancel, onCreated }) {
  const user = useUser()
  const [title, setTitle] = useState('')
  const [cols, setCols] = useState([])
  const [draft, setDraft] = useState('')
  const [people, setPeople] = useState([])
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  const add = () => {
    const parts = draft.split(',').map((x) => x.trim()).filter(Boolean)
    setCols((cs) => [...cs, ...parts.filter((p) => !cs.some((c) => c.toLowerCase() === p.toLowerCase()))])
    setDraft('')
  }
  const save = async (e) => {
    e.preventDefault()
    const all = [...cols, ...draft.split(',').map((x) => x.trim()).filter(Boolean)]
    if (!title.trim() || !all.length) return
    setSaving(true); setErr('')
    try {
      const { data } = await createNote({ title, columns: all, people: people.map((p) => p.name) })
      onCreated(data.id)
    } catch (e2) {
      setErr(e2.response?.data?.detail || "Couldn't create it.")
      setSaving(false)
    }
  }
  const ready = title.trim() && (cols.length || draft.trim())
  return (
    <form onSubmit={save} className="card space-y-3">
      <p className="text-xs font-black text-gray-500 uppercase tracking-widest">New note</p>
      <label className="block text-[11px] font-bold text-gray-600">What do you want to keep?
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className="input text-sm mt-1"
          placeholder="e.g. Caterers we called, Books to read, Wi-Fi passwords" />
      </label>
      <div>
        <p className="text-[11px] font-bold text-gray-600">Columns <span className="font-normal text-gray-400">- the headings of the table</span></p>
        {cols.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {cols.map((c, i) => (
              <span key={c} className="flex items-center gap-1 text-[11px] font-bold bg-amber-50 border border-amber-200 text-gray-700 pl-2 pr-1 py-0.5">
                {c}
                <button type="button" onClick={() => setCols((cs) => cs.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-600 px-0.5" aria-label={`Remove ${c}`}>✕</button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2 mt-1.5">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} className="input text-xs py-1.5 flex-1"
            placeholder={cols.length ? 'Another column' : 'e.g. Name, Phone, Price, Notes'}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
          <button type="button" onClick={add} disabled={!draft.trim()} className="text-xs font-bold text-brand-600 disabled:opacity-40 px-2">Add</button>
        </div>
      </div>
      <div>
        <p className="text-[11px] font-bold text-gray-600 mb-1">Who can see it</p>
        <NotePeople me={user?.name} people={people} setPeople={setPeople} />
      </div>
      {err && <p className="text-xs text-red-600">{typeof err === 'string' ? err : 'Check the details.'}</p>}
      <div className="flex gap-3">
        <button type="submit" disabled={!ready || saving} className="btn-primary !w-auto px-4 text-sm disabled:opacity-50">
          {saving ? 'Creating…' : 'Create note'}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-bold text-gray-500">Cancel</button>
      </div>
    </form>
  )
}
