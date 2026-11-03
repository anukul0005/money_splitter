import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  getDiscussion, postDiscussionMessage, deleteDiscussionMessage, setDiscussionTask, addDiscussionQuote,
  editDiscussionQuote, deleteDiscussionQuote, acceptDiscussionInvite, polishMessage, editDiscussion,
  deleteDiscussion, suggestQuoteFields,
} from '../api/index.js'
import LoadingSpinner from '../components/LoadingSpinner'
import { dn } from '../utils/displayName'
import { ago } from './Discussions'

const POLL_MS = 15000
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i
// Fields where the lowest figure is the best one, marked in the comparison.
const PRICE = /price|cost|rate|₹|\brs\b|fee|charge|budget|rent|tariff|amount|total/i
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[,₹\s]/g, '').replace(/rs\.?/i, ''))
  return Number.isFinite(n) ? n : null
}
const errText = (e, fallback) => {
  const d = e?.response?.data?.detail
  return typeof d === 'string' ? d : fallback
}

/**
 * One discussion: the chat (messages can be directed at members as
 * enquiries, or invite people by email; the AI can tidy a draft), the
 * quotes noted against the discussion's fields, side by side, and who has
 * been asked what.
 */
export default function DiscussionDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const [d, setD] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const tab = params.get('tab') || 'chat'
  const setTab = (t) => setParams((p) => { const n = new URLSearchParams(p); n.set('tab', t); return n }, { replace: true })
  const [quoteFor, setQuoteFor] = useState(null)   // a task a new quote answers

  const load = async () => {
    try {
      setD((await getDiscussion(id)).data)
      setError('')
    } catch (e) {
      setError(e.response?.status === 404 ? "This discussion doesn't exist, or you're not in its group." : 'Could not reach server - try again in a moment.')
    }
  }

  useEffect(() => {
    let timer
    const start = async () => {
      // An email invite's link: join the group first, then show it.
      const invite = params.get('invite')
      if (invite) {
        try {
          const { data } = await acceptDiscussionInvite(invite)
          setNotice(`You've joined ${data.group}.`)
        } catch (e) {
          if (e.response?.status !== 410) setNotice(errText(e, "That invite link didn't work."))
        }
        setParams((p) => { const n = new URLSearchParams(p); n.delete('invite'); return n }, { replace: true })
      }
      await load()
      timer = setInterval(load, POLL_MS)
    }
    start()
    return () => clearInterval(timer)
  }, [id])

  if (error) return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center">
      <p className="text-4xl mb-3">💬</p>
      <p className="text-sm text-gray-600 mb-4">{error}</p>
      <button onClick={() => nav('/discuss')} className="btn-primary text-sm">All discussions</button>
    </div>
  )
  if (!d) return <LoadingSpinner />

  const me = d.me.toLowerCase()
  const tasks = d.messages.flatMap((m) => m.tasks.map((t) => ({ ...t, message: m })))
  const mineOpen = tasks.filter((t) => t.assignee.toLowerCase() === me && t.status === 'open')
  const name = (n) => dn(n, d.members)

  return (
    <div className="pb-6 md:pb-8 flex flex-col min-h-[100dvh] md:min-h-0">
      <Header d={d} name={name} onChanged={load} onDeleted={() => nav('/discuss')} />

      {notice && <p className="mx-4 mt-3 text-xs bg-green-50 border border-green-200 text-green-800 px-3 py-2">{notice}</p>}

      <div className="flex border-b border-amber-200 px-4 mt-2 sticky top-0 bg-cream z-10">
        {[['chat', 'Chat', d.messages.length], ['quotes', 'Quotes', d.quotes.length], ['asks', 'Enquiries', tasks.length]].map(([k, label, n]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-3 py-2.5 text-xs font-bold border-b-2 -mb-px ${tab === k ? 'border-brand-400 text-gray-900' : 'border-transparent text-gray-400'}`}>
            {label} <span className="text-[10px] text-gray-400">{n}</span>
            {k === 'asks' && mineOpen.length > 0 && <span className="ml-1 text-[9px] font-black bg-red-500 text-white px-1">{mineOpen.length}</span>}
          </button>
        ))}
      </div>

      {tab === 'chat' && (
        <Chat d={d} name={name} onChanged={load}
          onQuote={(t) => { setQuoteFor(t); setTab('quotes') }} />
      )}
      {tab === 'quotes' && (
        <Quotes d={d} name={name} tasks={tasks} onChanged={load} quoteFor={quoteFor} clearQuoteFor={() => setQuoteFor(null)} />
      )}
      {tab === 'asks' && (
        <Asks d={d} name={name} tasks={tasks} onChanged={load} onQuote={(t) => { setQuoteFor(t); setTab('quotes') }} />
      )}
    </div>
  )
}

// ── header: topic, group, the quote fields ─────────────────────────────────

function Header({ d, name, onChanged, onDeleted }) {
  const nav = useNavigate()
  const [editing, setEditing] = useState(false)
  return (
    <div className="bg-gradient-to-br from-field-800 to-field-950 text-white px-5 pt-10 md:pt-8 pb-4 border-b border-field-700">
      <div className="flex items-center justify-between">
        <button onClick={() => nav('/discuss')} className="text-slate-300/70 text-xs font-bold">‹ Discussions</button>
        <button onClick={() => setEditing((v) => !v)} className="text-slate-300/70 text-xs font-bold">{editing ? 'Close' : 'Edit'}</button>
      </div>
      <h1 className="text-xl font-black mt-2 tracking-tight">{d.title}</h1>
      <p className="text-slate-300/60 text-[11px] mt-0.5">
        {d.group.emoji} {d.group.name} · {d.members.map(name).join(', ')}
      </p>
      {d.description && <p className="text-slate-200/80 text-xs mt-2 whitespace-pre-line">{d.description}</p>}
      {!editing && d.params.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {d.params.map((p) => (
            <span key={p.key} className="text-[10px] font-bold border border-field-700 text-slate-300 px-1.5 py-0.5">
              {p.label}{p.unit ? ` (${p.unit})` : ''}
            </span>
          ))}
        </div>
      )}
      {editing && <EditDiscussion d={d} onSaved={() => { setEditing(false); onChanged() }} onDeleted={onDeleted} />}
    </div>
  )
}

function EditDiscussion({ d, onSaved, onDeleted }) {
  const [title, setTitle] = useState(d.title)
  const [description, setDescription] = useState(d.description || '')
  const [fields, setFields] = useState(d.params)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const add = () => {
    const l = draft.trim()
    if (l && !fields.some((f) => f.label.toLowerCase() === l.toLowerCase())) setFields((fs) => [...fs, { label: l, unit: '' }])
    setDraft('')
  }
  const suggest = async () => {
    setBusy(true); setErr('')
    try {
      const { data } = await suggestQuoteFields({ title, description })
      setFields((fs) => [...fs, ...data.params.filter((p) => !fs.some((f) => f.label.toLowerCase() === p.label.toLowerCase()))])
    } catch (e) { setErr(errText(e, "Couldn't get suggestions.")) } finally { setBusy(false) }
  }
  const save = async () => {
    setBusy(true); setErr('')
    try { await editDiscussion(d.id, { title, description, params: fields }); onSaved() }
    catch (e) { setErr(errText(e, "Couldn't save.")); setBusy(false) }
  }
  const remove = async () => {
    if (!confirm('Delete this discussion with all its messages and quotes?')) return
    try { await deleteDiscussion(d.id); onDeleted() } catch (e) { setErr(errText(e, "Couldn't delete it.")) }
  }
  return (
    <div className="mt-3 bg-white text-gray-800 px-3 py-3 space-y-2">
      <input value={title} onChange={(e) => setTitle(e.target.value)} className="input text-sm" />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="input text-xs" placeholder="Details" />
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold text-gray-600">Quote fields</p>
        <button onClick={suggest} disabled={busy} className="text-[11px] font-bold text-brand-600 disabled:opacity-40">✨ Suggest</button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {fields.map((f, i) => (
          <span key={`${f.label}-${i}`} className="flex items-center gap-1 text-[11px] font-bold bg-amber-50 border border-amber-200 pl-2 pr-1 py-0.5">
            {f.label}
            <button onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-600 px-0.5">✕</button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()}
          className="input text-xs py-1.5 flex-1" placeholder="Add a field" />
        <button onClick={add} className="text-xs font-bold text-brand-600 px-2">Add</button>
      </div>
      <p className="text-[10px] text-gray-400">Removing a field hides it from the quotes; adding one leaves earlier quotes blank there.</p>
      {err && <p className="text-[11px] text-red-600">{err}</p>}
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={busy} className="btn-primary text-xs py-1.5 px-4 disabled:opacity-50">Save</button>
        {d.created_by.toLowerCase() === d.me.toLowerCase() && (
          <button onClick={remove} className="text-xs font-bold text-red-600 ml-auto">Delete discussion</button>
        )}
      </div>
    </div>
  )
}

// ── chat ───────────────────────────────────────────────────────────────────

function Chat({ d, name, onChanged, onQuote }) {
  const endRef = useRef(null)
  const count = d.messages.length
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [count])
  const me = d.me.toLowerCase()

  return (
    <>
      <div className="flex-1 px-4 py-3 space-y-3 max-w-2xl w-full">
        {count === 0 && (
          <div className="text-center py-8">
            <p className="text-sm font-bold text-gray-700">Start the discussion</p>
            <p className="text-xs text-gray-500 mt-1">Write what you're looking for. Direct it to members to have them enquire, or invite others by email.</p>
          </div>
        )}
        {d.messages.map((m) => {
          const mine = m.author.toLowerCase() === me
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[88%] px-3 py-2 border ${mine ? 'bg-brand-50 border-brand-200' : 'bg-white border-amber-200'}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[11px] font-black text-gray-700">{mine ? 'You' : name(m.author)}</span>
                  <span className="text-[10px] text-gray-400">{ago(m.created_at)}{m.polished ? ' · ✨' : ''}</span>
                </div>
                {m.assignees.length > 0 && (
                  <p className="text-[10px] font-bold text-brand-700 mt-0.5">→ {m.assignees.map((a) => (a.toLowerCase() === me ? 'you' : name(a))).join(', ')}</p>
                )}
                <p className="text-sm text-gray-800 whitespace-pre-line mt-1 break-words">{m.text}</p>
                {m.tasks.length > 0 && (
                  <div className="mt-2 pt-1.5 border-t border-amber-100 space-y-1">
                    {m.tasks.map((t) => (
                      <TaskLine key={t.id} t={{ ...t, message: m }} d={d} name={name} onChanged={onChanged} onQuote={onQuote} compact />
                    ))}
                  </div>
                )}
                {m.invites.length > 0 && (
                  <p className="text-[10px] text-gray-400 mt-1.5">✉ Invited {m.invites.join(', ')}</p>
                )}
                {mine && (
                  <button
                    onClick={async () => { if (confirm('Delete this message?')) { await deleteDiscussionMessage(d.id, m.id).catch(() => {}); onChanged() } }}
                    className="text-[10px] text-gray-300 hover:text-red-500 mt-1">Delete</button>
                )}
              </div>
            </div>
          )
        })}
        <div ref={endRef} />
      </div>
      <Composer d={d} name={name} onSent={onChanged} />
    </>
  )
}

/** Writing a message: direct it at members, invite emails, let the AI tidy it. */
function Composer({ d, name, onSent }) {
  const [text, setText] = useState('')
  const [original, setOriginal] = useState(null)      // what was typed, once the AI's version is in
  const [suggestion, setSuggestion] = useState(null)
  const [to, setTo] = useState([])
  const [emails, setEmails] = useState([])
  const [emailDraft, setEmailDraft] = useState('')
  const [showDirect, setShowDirect] = useState(false)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const others = d.members.filter((m) => m.toLowerCase() !== d.me.toLowerCase())

  const toggle = (n) => setTo((t) => (t.includes(n) ? t.filter((x) => x !== n) : [...t, n]))
  const addEmail = () => {
    const e = emailDraft.trim().toLowerCase()
    if (!e) return
    if (!EMAIL.test(e)) { setErr(`${e} doesn't look like an email address`); return }
    if (!emails.includes(e)) setEmails((es) => [...es, e])
    setEmailDraft(''); setErr('')
  }
  const polish = async () => {
    setBusy('polish'); setErr('')
    try {
      const { data } = await polishMessage({ text, discussion_id: d.id, assignees: to })
      setSuggestion(data.text)
    } catch (e) { setErr(errText(e, "The AI couldn't help just now.")) } finally { setBusy('') }
  }
  const send = async () => {
    if (!text.trim()) return
    const pending = emailDraft.trim() ? [...emails, emailDraft.trim().toLowerCase()] : emails
    if (pending.some((e) => !EMAIL.test(e))) { setErr('Check the email addresses'); return }
    setBusy('send'); setErr('')
    try {
      await postDiscussionMessage(d.id, { text, original_text: original, assignees: to, invite_emails: pending })
      setText(''); setOriginal(null); setSuggestion(null); setTo([]); setEmails([]); setEmailDraft(''); setShowDirect(false)
      onSent()
    } catch (e) { setErr(errText(e, "Couldn't send it.")) } finally { setBusy('') }
  }

  return (
    <div className="sticky bottom-16 md:bottom-0 bg-cream border-t border-amber-200 px-4 py-3 max-w-2xl w-full">
      {suggestion && (
        <div className="mb-2 bg-white border border-brand-200 px-3 py-2">
          <p className="text-[10px] font-black text-brand-600 uppercase tracking-widest">✨ AI version</p>
          <p className="text-sm text-gray-800 whitespace-pre-line mt-1">{suggestion}</p>
          <div className="flex gap-3 mt-2">
            <button onClick={() => { setOriginal(original ?? text); setText(suggestion); setSuggestion(null) }} className="text-xs font-bold text-brand-600">Use this</button>
            <button onClick={() => setSuggestion(null)} className="text-xs font-bold text-gray-500">Keep mine</button>
          </div>
        </div>
      )}
      {(showDirect || to.length > 0 || emails.length > 0) && (
        <div className="mb-2 space-y-1.5">
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-[10px] font-bold text-gray-400">Direct to</span>
            {others.length === 0 && <span className="text-[10px] text-gray-400">no one else in the group yet - invite by email</span>}
            {others.map((n) => (
              <button key={n} onClick={() => toggle(n)}
                className={`text-[11px] font-bold px-2 py-0.5 border ${to.includes(n) ? 'bg-brand-400 border-brand-400 text-white' : 'bg-white border-amber-200 text-gray-600'}`}>
                {name(n)}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-[10px] font-bold text-gray-400">Invite</span>
            {emails.map((e) => (
              <span key={e} className="text-[11px] bg-white border border-amber-200 pl-2 pr-1 py-0.5">
                {e} <button onClick={() => setEmails((es) => es.filter((x) => x !== e))} className="text-gray-400 hover:text-red-600 px-0.5">✕</button>
              </span>
            ))}
            <input value={emailDraft} onChange={(e) => setEmailDraft(e.target.value)} type="email" placeholder="name@email.com"
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addEmail() } }}
              className="input text-xs py-1 flex-1 min-w-[10rem]" />
          </div>
          {emails.length > 0 && <p className="text-[10px] text-gray-400">They get this message by email with a link to join {d.group.name}.</p>}
        </div>
      )}
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={text.split('\n').length > 2 ? 5 : 2}
        placeholder={to.length ? `Ask ${to.map(name).join(', ')}…` : 'Write a message…'} className="input text-sm" />
      {err && <p className="text-[11px] text-red-600 mt-1">{err}</p>}
      <div className="flex items-center gap-3 mt-2">
        <button onClick={() => setShowDirect((v) => !v)} className={`text-[11px] font-bold ${showDirect || to.length ? 'text-brand-600' : 'text-gray-500'}`}>
          👥 Direct / invite{to.length + emails.length ? ` (${to.length + emails.length})` : ''}
        </button>
        {d.ai && (
          <button onClick={polish} disabled={!text.trim() || !!busy} className="text-[11px] font-bold text-gray-500 disabled:opacity-40">
            {busy === 'polish' ? 'Improving…' : '✨ Improve with AI'}
          </button>
        )}
        <button onClick={send} disabled={!text.trim() || !!busy} className="btn-primary text-xs py-1.5 px-4 ml-auto disabled:opacity-50">
          {busy === 'send' ? 'Sending…' : to.length ? 'Send enquiry' : 'Send'}
        </button>
      </div>
    </div>
  )
}

/** One person's part of an enquiry: who, open or done, and what they can do about it. */
function TaskLine({ t, d, name, onChanged, onQuote, compact }) {
  const me = d.me.toLowerCase()
  const isMine = t.assignee.toLowerCase() === me
  const canToggle = isMine || t.message.author.toLowerCase() === me
  const quotes = d.quotes.filter((q) => q.task_id === t.id)
  const toggle = async () => {
    await setDiscussionTask(d.id, t.id, t.status === 'open' ? 'done' : 'open').catch(() => {})
    onChanged()
  }
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className={`text-[11px] font-bold ${t.status === 'done' ? 'text-green-700' : 'text-amber-700'}`}>
        {t.status === 'done' ? '✓' : '○'} {isMine ? 'You' : name(t.assignee)}
      </span>
      <span className="text-[10px] text-gray-400">
        {t.status === 'done' ? 'done' : 'to enquire'}{quotes.length ? ` · ${quotes.length} quote${quotes.length > 1 ? 's' : ''}` : ''}
      </span>
      {!compact && <span className="text-[10px] text-gray-400">· asked by {t.message.author.toLowerCase() === me ? 'you' : name(t.message.author)} · {ago(t.created_at)}</span>}
      <span className="ml-auto flex gap-2">
        {isMine && <button onClick={() => onQuote(t)} className="text-[10px] font-bold text-brand-600">+ Quote</button>}
        {canToggle && (
          <button onClick={toggle} className="text-[10px] font-bold text-gray-500">{t.status === 'open' ? 'Mark done' : 'Reopen'}</button>
        )}
      </span>
    </div>
  )
}

// ── quotes ─────────────────────────────────────────────────────────────────

function Quotes({ d, name, tasks, onChanged, quoteFor, clearQuoteFor }) {
  const [form, setForm] = useState(quoteFor ? { task_id: quoteFor.id } : null)
  const [sortKey, setSortKey] = useState('')
  const [who, setWho] = useState('')
  useEffect(() => { if (quoteFor) { setForm({ task_id: quoteFor.id }); clearQuoteFor() } }, [quoteFor])

  const people = [...new Set(d.quotes.map((q) => q.entered_by))]
  const shown = useMemo(() => {
    let qs = who ? d.quotes.filter((q) => q.entered_by === who) : [...d.quotes]
    if (sortKey) {
      qs.sort((a, b) => {
        const x = num(a.values[sortKey]), y = num(b.values[sortKey])
        if (x == null && y == null) return 0
        if (x == null) return 1
        if (y == null) return -1
        return x - y
      })
    }
    return qs
  }, [d.quotes, sortKey, who])
  // The lowest figure in each price-like column
  const best = {}
  d.params.filter((p) => PRICE.test(`${p.label} ${p.unit}`)).forEach((p) => {
    const vals = shown.map((q) => num(q.values[p.key])).filter((v) => v != null)
    if (vals.length > 1) best[p.key] = Math.min(...vals)
  })
  const taskLabel = (tid) => {
    const t = tasks.find((x) => x.id === tid)
    return t ? `for ${name(t.message.author)}'s enquiry` : ''
  }

  return (
    <div className="px-4 py-3 space-y-3 max-w-4xl w-full">
      {!form && (
        <button onClick={() => setForm({})} className="btn-primary text-sm">+ Add a quote</button>
      )}
      {form && (
        <QuoteForm d={d} tasks={tasks} name={name} initial={form}
          onCancel={() => setForm(null)} onSaved={() => { setForm(null); onChanged() }} />
      )}

      {d.quotes.length === 0 && !form && (
        <p className="text-xs text-gray-500">No quotes yet. Each one is noted in the same fields{d.params.length ? ` (${d.params.map((p) => p.label).join(', ')})` : ''}, so they compare side by side.</p>
      )}

      {d.quotes.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {d.params.length > 0 && (
              <label className="text-[11px] font-bold text-gray-500">Sort by
                <select value={sortKey} onChange={(e) => setSortKey(e.target.value)} className="ml-1.5 text-[11px] border border-amber-200 bg-white px-1.5 py-1">
                  <option value="">Newest</option>
                  {d.params.map((p) => <option key={p.key} value={p.key}>{p.label} (low → high)</option>)}
                </select>
              </label>
            )}
            {people.length > 1 && (
              <label className="text-[11px] font-bold text-gray-500">From
                <select value={who} onChange={(e) => setWho(e.target.value)} className="ml-1.5 text-[11px] border border-amber-200 bg-white px-1.5 py-1">
                  <option value="">Everyone</option>
                  {people.map((p) => <option key={p} value={p}>{name(p)}</option>)}
                </select>
              </label>
            )}
          </div>

          <div className="card !p-0 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-amber-50 text-left">
                  <th className="px-3 py-2 font-black text-gray-600 whitespace-nowrap sticky left-0 bg-amber-50">Quote from</th>
                  {d.params.map((p) => (
                    <th key={p.key} className="px-3 py-2 font-black text-gray-600 whitespace-nowrap">
                      {p.label}{p.unit ? <span className="font-normal text-gray-400"> ({p.unit})</span> : null}
                    </th>
                  ))}
                  <th className="px-3 py-2 font-black text-gray-600">Noted by</th>
                  <th className="px-3 py-2 font-black text-gray-600">Notes</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((q) => (
                  <tr key={q.id} className="border-t border-amber-100 align-top">
                    <td className="px-3 py-2 font-bold text-gray-900 sticky left-0 bg-white min-w-[8rem]">{q.vendor}</td>
                    {d.params.map((p) => {
                      const v = q.values[p.key]
                      const isBest = best[p.key] != null && num(v) === best[p.key]
                      return (
                        <td key={p.key} className={`px-3 py-2 whitespace-nowrap ${isBest ? 'text-green-700 font-black' : 'text-gray-700'}`}>
                          {v || <span className="text-gray-300">—</span>}{isBest ? ' ★' : ''}
                        </td>
                      )
                    })}
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                      {name(q.entered_by)}
                      <span className="block text-[10px] text-gray-400">{ago(q.created_at)} {taskLabel(q.task_id)}</span>
                    </td>
                    <td className="px-3 py-2 text-gray-600 min-w-[10rem] whitespace-pre-line">{q.note}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {q.entered_by.toLowerCase() === d.me.toLowerCase() && (
                        <span className="flex gap-2">
                          <button onClick={() => setForm(q)} className="text-[10px] font-bold text-brand-600">Edit</button>
                          <button onClick={async () => { if (confirm(`Delete the quote from ${q.vendor}?`)) { await deleteDiscussionQuote(d.id, q.id).catch(() => {}); onChanged() } }}
                            className="text-[10px] font-bold text-red-600">Delete</button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {Object.keys(best).length > 0 && <p className="text-[10px] text-gray-400">★ the lowest in a price column</p>}
        </>
      )}
    </div>
  )
}

function QuoteForm({ d, tasks, name, initial, onCancel, onSaved }) {
  const [vendor, setVendor] = useState(initial.vendor || '')
  const [values, setValues] = useState(initial.values || {})
  const [note, setNote] = useState(initial.note || '')
  const [taskId, setTaskId] = useState(initial.task_id ? String(initial.task_id) : '')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const me = d.me.toLowerCase()
  const myTasks = tasks.filter((t) => t.assignee.toLowerCase() === me)

  const save = async (e) => {
    e.preventDefault()
    setSaving(true); setErr('')
    const body = { vendor, values, note, task_id: taskId ? +taskId : null }
    try {
      await (initial.id ? editDiscussionQuote(d.id, initial.id, body) : addDiscussionQuote(d.id, body))
      onSaved()
    } catch (e2) { setErr(errText(e2, "Couldn't save it.")); setSaving(false) }
  }
  return (
    <form onSubmit={save} className="card space-y-2">
      <p className="text-xs font-black text-gray-500 uppercase tracking-widest">{initial.id ? 'Edit quote' : 'New quote'}</p>
      <label className="block text-[11px] font-bold text-gray-600">Quote from
        <input value={vendor} onChange={(e) => setVendor(e.target.value)} className="input text-sm mt-0.5" placeholder="e.g. Royal Orchid Banquet" autoFocus />
      </label>
      {d.params.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {d.params.map((p) => (
            <label key={p.key} className="block text-[11px] font-bold text-gray-600">
              {p.label}{p.unit ? <span className="font-normal text-gray-400"> ({p.unit})</span> : null}
              <input value={values[p.key] || ''} onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}
                className="input text-xs py-1.5 mt-0.5" inputMode={PRICE.test(`${p.label} ${p.unit}`) ? 'decimal' : 'text'} />
            </label>
          ))}
        </div>
      )}
      <label className="block text-[11px] font-bold text-gray-600">Notes <span className="font-normal text-gray-400">(optional)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="input text-xs mt-0.5"
          placeholder="What's included, contact person, conditions…" />
      </label>
      {!initial.id && myTasks.length > 0 && (
        <label className="block text-[11px] font-bold text-gray-600">Answers an enquiry
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)} className="input text-xs py-1.5 mt-0.5">
            <option value="">— none —</option>
            {myTasks.map((t) => (
              <option key={t.id} value={t.id}>{name(t.message.author)}: {t.message.text.slice(0, 60)}{t.message.text.length > 60 ? '…' : ''}</option>
            ))}
          </select>
          <span className="block text-[10px] font-normal text-gray-400 mt-0.5">Adding a quote marks that enquiry done.</span>
        </label>
      )}
      {err && <p className="text-[11px] text-red-600">{err}</p>}
      <div className="flex gap-3">
        <button type="submit" disabled={!vendor.trim() || saving} className="btn-primary text-xs py-1.5 px-4 disabled:opacity-50">
          {saving ? 'Saving…' : initial.id ? 'Save' : 'Add quote'}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-bold text-gray-500">Cancel</button>
      </div>
    </form>
  )
}

// ── enquiries: who's been asked what ───────────────────────────────────────

function Asks({ d, name, tasks, onChanged, onQuote }) {
  const me = d.me.toLowerCase()
  if (!tasks.length) return (
    <div className="px-4 py-6 max-w-2xl">
      <p className="text-xs text-gray-500">Nobody has been asked anything yet. In the chat, tap 👥 Direct / invite to pick who should enquire.</p>
    </div>
  )
  const order = (t) => (t.assignee.toLowerCase() === me && t.status === 'open' ? 0 : t.status === 'open' ? 1 : 2)
  const sorted = [...tasks].sort((a, b) => order(a) - order(b) || b.id - a.id)
  const open = tasks.filter((t) => t.status === 'open').length
  return (
    <div className="px-4 py-3 space-y-2 max-w-2xl w-full">
      <p className="text-[11px] text-gray-500">{open} open · {tasks.length - open} done</p>
      {sorted.map((t) => (
        <div key={t.id} className={`card !py-2.5 ${t.assignee.toLowerCase() === me && t.status === 'open' ? 'border-red-200 bg-red-50/40' : ''}`}>
          <TaskLine t={t} d={d} name={name} onChanged={onChanged} onQuote={onQuote} />
          <p className="text-xs text-gray-700 mt-1 line-clamp-3 whitespace-pre-line">{t.message.text}</p>
        </div>
      ))}
    </div>
  )
}
