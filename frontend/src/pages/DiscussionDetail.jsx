import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  getDiscussion, postDiscussionMessage, deleteDiscussionMessage, setDiscussionTask, addDiscussionQuote,
  editDiscussionQuote, deleteDiscussionQuote, acceptDiscussionInvite, polishMessage, editDiscussion,
  deleteDiscussion, suggestQuoteFields, createDiscussionPoll, voteDiscussionPoll, setDiscussionPollState,
  deleteDiscussionPoll, getDiscussionActivity, addDiscussionPeople, summariseDiscussion, setDiscussionNotify, editDiscussionMessage, attachDiscussionFile, setQuoteOpinion, reactInDiscussion,
} from '../api/index.js'
import LoadingSpinner from '../components/LoadingSpinner'
import PeoplePicker from '../components/DiscussionPeoplePicker'
import TripPlanner from '../components/TripPlanner'
import { dn } from '../utils/displayName'
import { ago } from './Discussions'

const POLL_MS = 15000
const NL = String.fromCharCode(10)
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i
// Fields that hold money - typed with a number keypad.
const PRICE = /price|cost|rate|₹|\brs\b|fee|charge|budget|rent|tariff|amount|total/i
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[,₹\s]/g, '').replace(/rs\.?/i, ''))
  return Number.isFinite(n) ? n : null
}
const errText = (e, fallback) => {
  const d = e?.response?.data?.detail
  return typeof d === 'string' ? d : d?.message || fallback
}

// Money in a text: Rs / ₹ / INR amounts, with lakh/crore/k and "per plate"-style tails
const AMOUNT = /((?:₹|\bRs\.?|\bINR)\s?\d+(?:,\d+)*(?:\.\d+)?(?:\s?(?:lakhs?|lacs?|k|cr|crores?)\b)?(?:\s?(?:\/|per)\s?(?:plate|person|head|pax|night|day|guest|hour)s?\b)?(?:\s?\/-)?)/gi

/** Text with **bold** marks shown bold, and any amount of money bolded too. */
function Rich({ text }) {
  const out = []
  String(text || '').split(/(\*\*[^*]+\*\*)/g).forEach((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) { out.push(<strong key={i} className="font-black text-gray-900">{part.slice(2, -2)}</strong>); return }
    part.split(AMOUNT).forEach((bit, j) => {
      if (!bit) return
      out.push(j % 2 ? <strong key={`${i}-${j}`} className="font-black text-gray-900">{bit}</strong> : <span key={`${i}-${j}`}>{bit}</span>)
    })
  })
  return out
}

/**
 * A shared photo / PDF, as the AI read it: its brief summary (amounts in
 * bold), what it filled of the quote fields, and "Add as quote" to note it
 * in the comparison. The file itself was never kept.
 */
function AttachmentCard({ a, caption, d, onQuote }) {
  const label = (k) => d.params.find((p) => p.key === k)?.label || k
  const plain = (a.summary || '').replace(/\*\*/g, '')
  const fields = Object.entries(a.values || {})
  return (
    <div className="mt-1">
      {caption && <p className="text-sm text-gray-800 whitespace-pre-line break-words mb-1.5"><Rich text={caption} /></p>}
      <div className="border border-amber-200 bg-amber-50/50 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-black text-gray-700 truncate">📎 {a.name}</span>
          <span className="flex items-center gap-2 shrink-0">
            <span className="text-[9px] font-bold text-brand-600 uppercase tracking-widest">✨ AI read</span>
            <CopyButton text={(a.vendor ? `${a.vendor}\n` : '') + plain} />
          </span>
        </div>
        {(a.vendor || a.price) && (
          <p className="text-xs font-bold text-gray-900 mt-1">{a.vendor}{a.vendor && a.price ? ' · ' : ''}{a.price && <Rich text={a.price} />}</p>
        )}
        <p className="text-xs text-gray-700 whitespace-pre-line mt-1 break-words"><Rich text={a.summary} /></p>
        {fields.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {fields.map(([k, v]) => (
              <span key={k} className="text-[10px] bg-white border border-amber-200 px-1.5 py-0.5 text-gray-600">
                {label(k)}: <Rich text={v} />
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-3 mt-2">
          {onQuote && (a.vendor || fields.length > 0) && (
            <button onClick={() => onQuote({ prefill: { vendor: a.vendor || '', price: a.price || '', values: a.values || {}, note: plain } })}
              className="text-[11px] font-bold text-brand-600">+ Add as quote</button>
          )}
          <span className="text-[9px] text-gray-400 ml-auto">file not kept - only this summary{a.pages > 1 ? ` · ${a.pages} pages` : ''}</span>
        </div>
      </div>
    </div>
  )
}

/**
 * A price however it was typed ("Overall budget 20 to 30 lakh", "12 - 14 lacs",
 * "1350 per plate") in one format: { text: "≈ ₹20–30 lacs", value: rupees to
 * compare by (a range's middle), extra: what was typed, when it said more }.
 */
// a unit may sit right against the number ("30L", "85k") - so no \b before it, only "not inside a word"
const UNITS = [[/(?<![a-z])(crores?|cr)\b/, 'cr', 1e7], [/(?<![a-z])(lakhs?|lacs?|lac|l)\b/, 'lacs', 1e5], [/(?<![a-z])(thousand|k)\b/, 'k', 1e3]]
const PER = /(?:\/|\bper\b|\ba\b)\s*(plate|person|head|pax|night|day|guest|hour|room)s?\b/
const APPROX = /\b(approx\w*|around|about|roughly|estimated|overall|budget|upto|up to|nearly|apx)\b|~|≈/
function priceInfo(raw) {
  const str = String(raw || '').trim()
  const low = str.toLowerCase()
  const nums = (low.match(/\d+(?:,\d+)*(?:\.\d+)?/g) || []).map((n) => parseFloat(n.replace(/,/g, '')))
  if (!nums.length) return { text: str, value: null, extra: '' }
  const unit = UNITS.find(([rx]) => rx.test(low))
  const per = low.match(PER)
  const approx = APPROX.test(low)
  const [a, b] = nums.length > 1 && nums[1] > nums[0] ? [nums[0], nums[1]] : [nums[0], null]
  const fmt = (n) => (unit ? String(+n.toFixed(2)) : n.toLocaleString('en-IN', { maximumFractionDigits: 2 }))
  const text = `${approx ? '≈ ' : ''}₹${fmt(a)}${b != null ? `–${fmt(b)}` : ''}${unit ? (unit[1] === 'k' ? 'k' : ` ${unit[1]}`) : ''}${per ? ` / ${per[1]}` : ''}`
  const mult = unit ? unit[2] : 1
  // Anything typed beyond the number, unit and range words ("overall budget ...including everything")
  const rest = low.replace(PER, ' ').replace(unit ? unit[0] : /$^/, ' ').replace(/\d+(?:,\d+)*(?:\.\d+)?/g, ' ')
    .replace(/₹|\brs\.?|\binr\b|\bto\b|-|–|\/-?/g, ' ').replace(/\s+/g, ' ').trim()
  return { text, value: b != null ? ((a + b) / 2) * mult : a * mult, extra: rest ? str : '' }
}

/** A small copy-to-clipboard icon that says "Copied" for a moment. */
function CopyButton({ text, className = '' }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Older browsers / no permission: the textarea trick
      const ta = document.createElement('textarea')
      ta.value = text; document.body.appendChild(ta); ta.select()
      try { document.execCommand('copy') } catch { /* nothing more to try */ }
      ta.remove()
    }
    setDone(true)
    setTimeout(() => setDone(false), 1500)
  }
  return (
    <button onClick={copy} title="Copy" aria-label="Copy" className={`text-gray-300 hover:text-brand-600 inline-flex items-center gap-0.5 ${className}`}>
      {done ? <span className="text-[10px] font-bold text-green-600">Copied</span> : (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path strokeLinecap="round" d="M5 15V6a2 2 0 012-2h9" />
        </svg>
      )}
    </button>
  )
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
  const pollsWaiting = d.polls.filter((p) => !p.closed && p.mine.length === 0).length
  const name = (n) => dn(n, d.members)

  return (
    <div className="pb-6 md:pb-8 flex flex-col min-h-[100dvh] md:min-h-0">
      <Header d={d} name={name} onChanged={load} onDeleted={() => nav('/discuss')} />

      {notice && <p className="mx-4 mt-3 text-xs bg-green-50 border border-green-200 text-green-800 px-3 py-2">{notice}</p>}

      <div className="flex border-b border-amber-200 px-4 mt-2 sticky top-0 bg-cream z-10 overflow-x-auto">
        {[['chat', 'Chat', d.messages.length + d.polls.length], ['quotes', 'Quotes', d.quotes.length],
          ['asks', 'Enquiries', tasks.length], ['plan', 'Plan', null], ['activity', 'Activity', null]].map(([k, label, n]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-2.5 py-2.5 text-xs font-bold border-b-2 -mb-px whitespace-nowrap ${tab === k ? 'border-brand-400 text-gray-900' : 'border-transparent text-gray-400'}`}>
            {label} {n != null && <span className="text-[10px] text-gray-400">{n}</span>}
            {k === 'asks' && mineOpen.length > 0 && <span className="ml-1 text-[9px] font-black bg-red-500 text-white px-1">{mineOpen.length}</span>}
            {k === 'chat' && pollsWaiting > 0 && <span className="ml-1 text-[9px] font-black bg-brand-400 text-white px-1">{pollsWaiting} 📊</span>}
          </button>
        ))}
      </div>

      {tab === 'chat' && d.ai && (
        <div className="px-4 pt-3 max-w-2xl w-full"><Summary d={d} onChanged={load} /></div>
      )}
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
      {tab === 'plan' && <TripPlanner d={d} name={name} onChanged={load} />}
      {tab === 'activity' && <ActivityTab d={d} name={name} />}
    </div>
  )
}

// ── header: topic, group, the quote fields ─────────────────────────────────

function Header({ d, name, onChanged, onDeleted }) {
  const nav = useNavigate()
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  return (
    <div className="bg-gradient-to-br from-field-800 to-field-950 text-white px-5 pt-10 md:pt-8 pb-4 border-b border-field-700">
      <div className="flex items-center justify-between">
        <button onClick={() => nav('/discuss')} className="text-slate-300/70 text-xs font-bold">‹ Discussions</button>
        <span className="flex items-center gap-4">
          <NotifyBell d={d} onChanged={onChanged} />
          <button onClick={() => { setAdding((v) => !v); setEditing(false) }} className="text-slate-300/70 text-xs font-bold">{adding ? 'Close' : '+ People'}</button>
          <button onClick={() => { setEditing((v) => !v); setAdding(false) }} className="text-slate-300/70 text-xs font-bold">{editing ? 'Close' : 'Edit'}</button>
        </span>
      </div>
      <h1 className="text-xl font-black mt-2 tracking-tight">{d.title}</h1>
      <p className="text-slate-300/60 text-[11px] mt-0.5">
        {d.group.name !== d.title && <>{d.group.emoji} {d.group.name} · </>}
        {d.members.map((m) => (m.toLowerCase() === d.me.toLowerCase() ? 'You' : name(m))).join(', ')}
        {d.invites.some((i) => !i.accepted_by) && <> · {d.invites.filter((i) => !i.accepted_by).length} invited by email</>}
      </p>
      {adding && <AddPeople d={d} onDone={() => { setAdding(false); onChanged() }} />}
      <DetailsBlock d={d} onChanged={onChanged} />
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

const NOTIFY = [
  ['all', '🔔', 'All activity', "Messages, polls and quotes - push; email when you're asked"],
  ['mine', '📨', "Only when I'm asked", 'Just enquiries directed at you (and quotes for yours)'],
  ['off', '🔕', 'Off', 'No notifications from this discussion'],
]

/** The caller's own notifications for this discussion: all / only mine / off. */
function NotifyBell({ d, onChanged }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const cur = NOTIFY.find(([k]) => k === (d.notify || 'all')) || NOTIFY[0]
  const pick = async (k) => {
    setSaving(true)
    try { await setDiscussionNotify(d.id, k); await onChanged() } catch { /* stays as it was */ }
    finally { setSaving(false); setOpen(false) }
  }
  return (
    <span className="relative">
      <button onClick={() => setOpen((v) => !v)} title={`Notifications: ${cur[2]}`} aria-label={`Notifications: ${cur[2]}`}
        className="text-sm leading-none text-slate-300/80 hover:text-white">{cur[1]}</button>
      {open && (
        <>
          <span className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <span className="absolute right-0 mt-2 w-64 bg-white text-gray-800 border border-amber-200 shadow-lg z-30 py-1 block">
            <span className="block px-3 pt-1 pb-1.5 text-[10px] font-black text-gray-400 tracking-widest">NOTIFY ME</span>
            {NOTIFY.map(([k, icon, label, sub]) => (
              <button key={k} onClick={() => pick(k)} disabled={saving}
                className={`w-full text-left px-3 py-2 hover:bg-amber-50 flex gap-2 ${k === cur[0] ? 'bg-brand-50' : ''}`}>
                <span className="text-sm">{icon}</span>
                <span>
                  <span className="block text-xs font-bold">{label}{k === cur[0] ? ' ✓' : ''}</span>
                  <span className="block text-[10px] text-gray-400">{sub}</span>
                </span>
              </button>
            ))}
            <span className="block px-3 pt-1 pb-1.5 text-[10px] text-gray-400">Just for you, just this discussion. Push needs notifications turned on for the app.</span>
          </span>
        </>
      )}
    </span>
  )
}

/** Re-run the AI summary once something it was written from has changed. */
async function resummarise(d) {
  if (!d.ai) return
  try { await summariseDiscussion(d.id) } catch { /* the card says it's out of date; Refresh retries */ }
}

/**
 * The details, editable right where they're read; saving them re-writes the
 * AI summary from the new text.
 */
function DetailsBlock({ d, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [show, setShow] = useState(false)          // folded away by default - the AI summary is what's read
  const [text, setText] = useState(d.description || '')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const save = async () => {
    if (!text.trim()) { setErr("The details can't be empty."); return }
    setErr(''); setBusy('save')
    try {
      await editDiscussion(d.id, { description: text })
      setEditing(false)
      setBusy('summary')
      await resummarise(d)
      await onChanged()
    } catch (e) { setErr(errText(e, "Couldn't save the details.")) }
    finally { setBusy('') }
  }
  if (!editing) return (
    <div className="mt-2">
      <span className="flex items-center gap-3">
        <button onClick={() => setShow((v) => !v)} aria-expanded={show}
          className="text-[11px] font-bold text-slate-300/80 hover:text-white">
          <span className="inline-block w-3">{show ? '▾' : '▸'}</span>Details
        </button>
        {busy === 'summary' && <span className="text-[10px] text-slate-300/70">✨ Re-summarising…</span>}
      </span>
      {show && (
        <>
          {d.description && <p className="text-slate-200/80 text-xs whitespace-pre-line mt-1 pl-3">{d.description}</p>}
          <span className="flex items-center gap-3 mt-1 pl-3">
            <button onClick={() => { setText(d.description || ''); setEditing(true) }} className="text-[10px] font-bold text-brand-300 hover:text-white">✎ Edit details</button>
            {d.description && <CopyButton text={d.description} className="!text-slate-400 hover:!text-white" />}
          </span>
        </>
      )}
    </div>
  )
  return (
    <div className="mt-2 bg-white text-gray-800 px-3 py-2.5">
      <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Details</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(10, Math.max(3, text.split(NL).length + 1))}
        className="input text-xs mt-1" autoFocus placeholder="Date, guests, budget, area, must-haves…" />
      {err && <p className="text-[11px] text-red-600 mt-1">{err}</p>}
      <div className="flex items-center gap-3 mt-2">
        <button onClick={save} disabled={!!busy || !text.trim()} className="btn-primary text-xs py-1.5 px-4 disabled:opacity-50">
          {busy ? 'Saving…' : d.ai ? 'Save & re-summarise' : 'Save'}
        </button>
        <button onClick={() => { setEditing(false); setErr('') }} className="text-xs font-bold text-gray-500">Cancel</button>
      </div>
    </div>
  )
}

/** A message's text; its author can edit it (the summary is re-written after) or delete it. */
function MessageText({ m, d, mine, onChanged, onQuote }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(m.text)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const save = async () => {
    setBusy(true); setErr('')
    try {
      await editDiscussionMessage(d.id, m.id, text)
      setEditing(false)
      if (d.summary) await resummarise(d)     // keep an existing summary in step
      await onChanged()
    } catch (e) { setErr(errText(e, "Couldn't save it.")) }
    finally { setBusy(false) }
  }
  if (editing) return (
    <div className="mt-1">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(10, Math.max(2, text.split(NL).length + 1))}
        className="input text-sm" autoFocus />
      {err && <p className="text-[11px] text-red-600 mt-1">{err}</p>}
      <div className="flex gap-3 mt-1.5">
        <button onClick={save} disabled={busy || !text.trim()} className="text-[11px] font-bold text-brand-600 disabled:opacity-50">
          {busy ? (d.summary ? 'Saving & re-summarising…' : 'Saving…') : 'Save'}
        </button>
        <button onClick={() => { setEditing(false); setText(m.text); setErr('') }} className="text-[11px] font-bold text-gray-500">Cancel</button>
      </div>
    </div>
  )
  return (
    <>
      {m.attachment ? (
        <AttachmentCard a={m.attachment} caption={m.text.split('📎')[0].trim()} d={d} onQuote={onQuote} />
      ) : (
        <p className="text-sm text-gray-800 whitespace-pre-line mt-1 break-words"><Rich text={m.text} /></p>
      )}
      {mine && (
        <span className="flex gap-3 mt-1">
          {!m.attachment && <button onClick={() => { setText(m.text); setEditing(true) }} className="text-[10px] text-gray-400 hover:text-brand-600">Edit</button>}
          <button
            onClick={async () => { if (confirm('Delete this message?')) { await deleteDiscussionMessage(d.id, m.id).catch(() => {}); onChanged() } }}
            className="text-[10px] text-gray-300 hover:text-red-500">Delete</button>
        </span>
      )}
    </>
  )
}

/** More people: app users go straight into the group, others get an email invite. */
function AddPeople({ d, onDone }) {
  const [members, setMembers] = useState([])
  const [emails, setEmails] = useState([])
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const pending = d.invites.filter((i) => !i.accepted_by)
  const save = async () => {
    setSaving(true); setErr('')
    try { await addDiscussionPeople(d.id, { members, invite_emails: emails }); onDone() }
    catch (e) { setErr(errText(e, "Couldn't add them.")); setSaving(false) }
  }
  return (
    <div className="mt-3 bg-white text-gray-800 px-3 py-3 space-y-2">
      <p className="text-[11px] font-bold text-gray-600">Add people to {d.group.name}</p>
      <PeoplePicker me={d.me} exclude={d.members} members={members} setMembers={setMembers}
        emails={emails} setEmails={setEmails} onError={setErr} />
      {pending.length > 0 && (
        <p className="text-[10px] text-gray-400">Invited, not joined yet: {pending.map((i) => i.email).join(', ')}</p>
      )}
      {err && <p className="text-[11px] text-red-600">{err}</p>}
      <button onClick={save} disabled={saving || !(members.length || emails.length)} className="btn-primary text-xs py-1.5 px-4 disabled:opacity-50">
        {saving ? 'Adding…' : 'Add'}
      </button>
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
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="input text-xs" placeholder="Details (needed) - date, guests, budget, area" />
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
        <button onClick={save} disabled={busy || !title.trim() || !description.trim()} className="btn-primary text-xs py-1.5 px-4 disabled:opacity-50">Save</button>
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
  const count = d.messages.length + d.polls.length
  const me = d.me.toLowerCase()
  // Open polls this member hasn't answered: pinned on top, newest first
  const pinned = d.polls.filter((p) => !p.closed && p.mine.length === 0)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id)
  const pinnedIds = new Set(pinned.map((p) => p.id))
  // Mandatory ones (not their own) must be answered before the chat opens
  const gate = pinned.filter((p) => p.mandatory && p.author.toLowerCase() !== me)
  // With something pinned, stay at the top where it is; otherwise the latest message
  useEffect(() => { if (!pinned.length) endRef.current?.scrollIntoView({ block: 'end' }) }, [count, pinned.length])
  // Messages and polls in one timeline, oldest first
  const items = [
    ...d.messages.map((m) => ({ kind: 'm', at: m.created_at, id: m.id, m })),
    ...d.polls.filter((p) => !pinnedIds.has(p.id)).map((p) => ({ kind: 'p', at: p.created_at, id: p.id, p })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id - b.id)

  if (gate.length) return (
    <div className="flex-1 px-4 py-4 space-y-3 max-w-2xl w-full">
      <div className="border border-brand-300 bg-brand-50 px-4 py-3">
        <p className="text-sm font-black text-gray-900">🔒 Answer {gate.length === 1 ? 'this poll' : `these ${gate.length} polls`} to enter the chat</p>
        <p className="text-xs text-gray-600 mt-0.5">
          {gate.length === 1 ? `${name(gate[0].author)} needs` : 'The group needs'} everyone's answer before going on.
          The chat opens as soon as you vote.
        </p>
      </div>
      {gate.map((p) => <PollCard key={p.id} p={p} d={d} name={name} onChanged={onChanged} />)}
    </div>
  )

  return (
    <>
      <div className="flex-1 px-4 py-3 space-y-3 max-w-2xl w-full">
        {pinned.length > 0 && (
          <div className="space-y-2 pb-3 border-b border-dashed border-brand-200">
            <p className="text-[10px] font-black text-brand-600 uppercase tracking-widest">
              📌 Waiting for your answer{pinned.length > 1 ? ` · ${pinned.length}` : ''}
            </p>
            {pinned.map((p) => <PollCard key={`pin${p.id}`} p={p} d={d} name={name} onChanged={onChanged} />)}
          </div>
        )}
        {count === 0 && (
          <div className="text-center py-8">
            <p className="text-sm font-bold text-gray-700">Start the discussion</p>
            <p className="text-xs text-gray-500 mt-1">Write what you're looking for. Direct it to members to have them enquire, invite others by email, or ask everyone with a 📊 poll.</p>
          </div>
        )}
        {items.map((it) => {
          if (it.kind === 'p') return <PollCard key={`p${it.id}`} p={it.p} d={d} name={name} onChanged={onChanged} />
          const m = it.m
          const mine = m.author.toLowerCase() === me
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[88%] px-3 py-2 border ${mine ? 'bg-brand-50 border-brand-200' : 'bg-white border-amber-200'}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[11px] font-black text-gray-700">{mine ? 'You' : name(m.author)}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-400">{ago(m.created_at)}{m.polished ? ' · ✨' : ''}{m.edited_at ? ' · edited' : ''}</span>
                    <CopyButton text={m.text} />
                  </span>
                </div>
                {m.assignees.length > 0 && (
                  <p className="text-[10px] font-bold text-brand-700 mt-0.5">→ {m.assignees.map((a) => (a.toLowerCase() === me ? 'you' : name(a))).join(', ')}</p>
                )}
                <MessageText m={m} d={d} mine={mine} onChanged={onChanged} onQuote={onQuote} />
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

/**
 * A poll in the chat: tap an option to vote (again to take it back; a
 * multi-choice poll takes several), results live for everyone - counts,
 * share of voters, who picked what, who hasn't voted yet.
 */
function PollCard({ p, d, name, onChanged }) {
  const me = d.me.toLowerCase()
  const mineAuthor = p.author.toLowerCase() === me
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const total = p.voters.length
  const top = Math.max(0, ...p.options.map((o) => o.voters.length))
  const notes = p.notes || {}
  const noteOf = (v) => notes[v] || Object.entries(notes).find(([k]) => k.toLowerCase() === v.toLowerCase())?.[1] || ''
  const myNote = noteOf(d.me)
  const [writing, setWriting] = useState(false)
  const [note, setNote] = useState(myNote)
  useEffect(() => { if (!writing) setNote(myNote) }, [myNote])
  // "Any other", "write in", "specify"... - an option that wants words
  const wantsWords = (i) => /other|write|specify|suggest|comment|else/i.test(p.options[i]?.text || '')

  const send = async (choices, withNote) => {
    setBusy(true); setErr('')
    try { await voteDiscussionPoll(d.id, p.id, choices, choices.length ? withNote : ''); await onChanged(); return true }
    catch (e) { setErr(errText(e, "Couldn't record the vote.")); return false } finally { setBusy(false) }
  }
  const pick = async (i) => {
    if (p.closed || busy) return
    const had = p.mine.includes(i)
    const choices = p.multi ? (had ? p.mine.filter((x) => x !== i) : [...p.mine, i]) : (had ? [] : [i])
    if (await send(choices, myNote) && choices.includes(i) && wantsWords(i) && !myNote) setWriting(true)
  }
  const saveNote = async () => { if (await send(p.mine, note.trim())) setWriting(false) }
  const resultsText = `📊 ${p.question}\n` + p.options.map((o) =>
    `- ${o.text}: ${o.voters.length} vote${o.voters.length === 1 ? '' : 's'}${o.voters.length
      ? ` (${o.voters.map((v) => name(v) + (noteOf(v) ? ` - "${noteOf(v)}"` : '')).join(', ')})` : ''}`).join('\n')

  return (
    <div className="border border-brand-200 bg-white px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[10px] font-black text-brand-600 uppercase tracking-widest">
          📊 Poll · {mineAuthor ? 'you asked' : `${name(p.author)} asks`}{p.closed ? ' · closed' : ''}
          {p.mandatory && <span className="ml-1.5 text-[9px] bg-red-500 text-white px-1 py-px normal-case tracking-normal">must answer</span>}
        </span>
        <span className="flex items-center gap-2">
          <span className="text-[10px] text-gray-400">{ago(p.created_at)}</span>
          <CopyButton text={resultsText} />
        </span>
      </div>
      <p className="text-sm font-bold text-gray-900 mt-1">{p.question}</p>
      <p className="text-[10px] text-gray-400">{p.multi ? 'Pick any that suit' : 'Pick one'} · {total} of {total + p.waiting.length} voted</p>
      <div className="mt-2 space-y-1.5">
        {p.options.map((o, i) => {
          const n = o.voters.length
          const pct = total ? Math.round((n / total) * 100) : 0
          const chosen = p.mine.includes(i)
          const leading = n > 0 && n === top
          return (
            <button key={i} onClick={() => pick(i)} disabled={p.closed || busy}
              className={`relative w-full text-left border px-2.5 py-1.5 overflow-hidden ${chosen ? 'border-brand-400' : 'border-amber-200'} ${p.closed ? 'cursor-default' : 'hover:border-brand-300'}`}>
              <span className={`absolute inset-y-0 left-0 ${leading ? 'bg-brand-100' : 'bg-amber-50'}`} style={{ width: `${pct}%` }} />
              <span className="relative flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-gray-800">
                  {p.multi ? (chosen ? '☑' : '☐') : (chosen ? '◉' : '○')} {o.text}
                </span>
                <span className="text-xs font-black text-gray-900 shrink-0">{n} <span className="text-[10px] font-bold text-gray-400">{pct}%</span></span>
              </span>
              {n > 0 && (
                <span className="relative block text-[10px] text-gray-500 mt-0.5">
                  {o.voters.filter((v) => !noteOf(v)).map((v) => (v.toLowerCase() === me ? 'you' : name(v))).join(', ')}
                  {o.voters.filter((v) => noteOf(v)).map((v) => (
                    <span key={v} className="block text-[11px] text-gray-700 whitespace-pre-line break-words">
                      <span className="font-bold">{v.toLowerCase() === me ? 'You' : name(v)}:</span> “<Rich text={noteOf(v)} />”
                    </span>
                  ))}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {p.mine.length > 0 && !p.closed && !writing && (
        <button onClick={() => { setNote(myNote); setWriting(true) }} className="text-[10px] font-bold text-brand-600 mt-1.5">
          {myNote ? '✎ Edit what you wrote' : '✎ Write something with your vote'}
        </button>
      )}
      {writing && !p.closed && (
        <div className="mt-1.5 bg-amber-50 border border-amber-200 p-2">
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveNote() } }}
            className="input text-xs py-1.5" placeholder="e.g. Udaipur - lakes, and flights are cheaper" />
          <p className="text-[10px] text-gray-400 mt-1">Everyone in the group sees this next to your vote.</p>
          <div className="flex gap-3 mt-1.5">
            <button onClick={saveNote} disabled={busy} className="text-[11px] font-bold text-brand-600 disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
            <button onClick={() => { setWriting(false); setNote(myNote) }} className="text-[11px] font-bold text-gray-500">Cancel</button>
            {myNote && <button onClick={async () => { setNote(''); if (await send(p.mine, '')) setWriting(false) }}
              className="text-[11px] font-bold text-red-600 ml-auto">Remove</button>}
          </div>
        </div>
      )}
      {p.waiting.length > 0 && !p.closed && (
        <p className="text-[10px] text-gray-400 mt-1.5">Waiting on {p.waiting.map((v) => (v.toLowerCase() === me ? 'you' : name(v))).join(', ')}</p>
      )}
      {err && <p className="text-[11px] text-red-600 mt-1">{err}</p>}
      {mineAuthor && (
        <div className="flex gap-3 mt-2">
          <button onClick={async () => { await setDiscussionPollState(d.id, p.id, !p.closed).catch(() => {}); onChanged() }}
            className="text-[10px] font-bold text-gray-500">{p.closed ? 'Reopen voting' : 'Close voting'}</button>
          <button onClick={async () => { if (confirm('Delete this poll and its votes?')) { await deleteDiscussionPoll(d.id, p.id).catch(() => {}); onChanged() } }}
            className="text-[10px] font-bold text-red-600">Delete</button>
        </div>
      )}
    </div>
  )
}

/** Asking the whole group: a question and its options. */
function PollForm({ d, onDone, onCancel }) {
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState(['', ''])
  const [multi, setMulti] = useState(false)
  const [mandatory, setMandatory] = useState(false)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const filled = options.map((o) => o.trim()).filter(Boolean)
  const save = async () => {
    setSaving(true); setErr('')
    try { await createDiscussionPoll(d.id, { question, options: filled, multi, mandatory }); onDone() }
    catch (e) { setErr(errText(e, "Couldn't create the poll.")); setSaving(false) }
  }
  return (
    <div className="mb-2 bg-white border border-brand-200 px-3 py-2.5 space-y-1.5">
      <p className="text-[10px] font-black text-brand-600 uppercase tracking-widest">📊 New poll - everyone in {d.group.name} can vote</p>
      <input value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={300} autoFocus
        className="input text-sm" placeholder="e.g. Which venue should we book?" />
      {options.map((o, i) => (
        <div key={i} className="flex gap-2">
          <input value={o} maxLength={120} onChange={(e) => setOptions((os) => os.map((x, j) => (j === i ? e.target.value : x)))}
            className="input text-xs py-1.5 flex-1" placeholder={`Option ${i + 1}`} />
          {options.length > 2 && (
            <button onClick={() => setOptions((os) => os.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-600 px-1" aria-label="Remove option">✕</button>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        {options.length < 10 && <button onClick={() => setOptions((os) => [...os, ''])} className="text-[11px] font-bold text-brand-600">+ Option</button>}
        {d.quotes.length > 1 && (
          <button onClick={() => setOptions([...new Set(d.quotes.map((q) => q.vendor))].slice(0, 10))}
            className="text-[11px] font-bold text-brand-600">Use the quotes as options</button>
        )}
        <label className="flex items-center gap-1.5 text-[11px] text-gray-600">
          <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} className="w-3.5 h-3.5 accent-brand-400" />
          Allow more than one pick
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-gray-600" title="Members can't use the chat until they've answered">
          <input type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} className="w-3.5 h-3.5 accent-red-500" />
          Mandatory - everyone answers before using the chat
        </label>
      </div>
      {err && <p className="text-[11px] text-red-600">{err}</p>}
      <div className="flex gap-3">
        <button onClick={save} disabled={!question.trim() || filled.length < 2 || saving} className="btn-primary text-xs py-1.5 px-4 disabled:opacity-50">
          {saving ? 'Creating…' : 'Ask everyone'}
        </button>
        <button onClick={onCancel} className="text-xs font-bold text-gray-500">Cancel</button>
      </div>
    </div>
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
  const [polling, setPolling] = useState(false)
  const [busy, setBusy] = useState('')
  const [reading, setReading] = useState('')         // the file the AI is reading
  const fileRef = useRef(null)
  const attach = async (f) => {
    if (!f) return
    if (f.size > 12 * 1024 * 1024) { setErr('That file is over 12 MB - share a smaller one or a screenshot.'); return }
    setReading(f.name); setBusy('attach'); setErr('')
    try {
      await attachDiscussionFile(d.id, f, text.trim())
      setText(''); setOriginal(null); setSuggestion(null)
      onSent()
    } catch (e) {
      setErr(e.response?.status === 404 && !e.response?.data?.detail?.includes?.('discussion')
        ? 'The server is still updating - try again in a minute.'
        : errText(e, "The AI couldn't read that file."))
    }
    finally { setBusy(''); setReading(''); if (fileRef.current) fileRef.current.value = '' }
  }
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
    <div className="sticky bottom-0 z-20 bg-cream border-t border-amber-200 px-4 py-3 max-w-2xl w-full shadow-[0_-4px_12px_rgba(0,0,0,0.04)]">
      {polling && <PollForm d={d} onCancel={() => setPolling(false)} onDone={() => { setPolling(false); onSent() }} />}
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
      {reading && (
        <p className="text-[11px] text-brand-700 mt-1">
          <span className="inline-block w-2 h-2 mr-1.5 rounded-full bg-brand-400 animate-pulse align-middle" />
          📎 Reading {reading} with AI - this can take up to a minute. Only the summary is kept, not the file.
        </p>
      )}
      <input ref={fileRef} type="file" accept="image/*,application/pdf,.pdf" className="hidden" onChange={(e) => attach(e.target.files?.[0])} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-2">
        <button onClick={() => setShowDirect((v) => !v)} className={`text-[11px] font-bold ${showDirect || to.length ? 'text-brand-600' : 'text-gray-500'}`}>
          👥 Direct / invite{to.length + emails.length ? ` (${to.length + emails.length})` : ''}
        </button>
        <button onClick={() => setPolling((v) => !v)} className={`text-[11px] font-bold ${polling ? 'text-brand-600' : 'text-gray-500'}`}>
          📊 Poll
        </button>
        {d.ai && (
          <button onClick={() => fileRef.current?.click()} disabled={!!busy} title="Attach a quotation, menu or brochure (photo or PDF) - the AI summarises it for everyone"
            className="text-[11px] font-bold text-gray-500 disabled:opacity-40">📎 Attach</button>
        )}
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
  const [form, setForm] = useState(quoteFor ? (quoteFor.prefill || { task_id: quoteFor.id }) : null)
  const [sortKey, setSortKey] = useState('')
  const [who, setWho] = useState('')
  useEffect(() => { if (quoteFor) { setForm(quoteFor.prefill || { task_id: quoteFor.id }); clearQuoteFor() } }, [quoteFor])

  const people = [...new Set(d.quotes.map((q) => q.entered_by))]
  const shown = useMemo(() => {
    let qs = who ? d.quotes.filter((q) => q.entered_by === who) : [...d.quotes]
    if (sortKey) {
      const pick = (q) => (sortKey === '__price' ? priceInfo(q.price).value : num(q.values[sortKey]))
      qs.sort((a, b) => {
        const x = pick(a), y = pick(b)
        if (x == null && y == null) return 0
        if (x == null) return 1
        if (y == null) return -1
        return x - y
      })
    }
    return qs
  }, [d.quotes, sortKey, who])
  const taskLabel = (tid) => {
    const t = tasks.find((x) => x.id === tid)
    return t ? `for ${name(t.message.author)}'s enquiry` : ''
  }

  return (
    <div className="px-4 py-3 space-y-3 max-w-4xl w-full">
      <QuotesSummary d={d} onChanged={onChanged} />
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
            <label className="text-[11px] font-bold text-gray-500">Sort by
              <select value={sortKey} onChange={(e) => setSortKey(e.target.value)} className="ml-1.5 text-[11px] border border-amber-200 bg-white px-1.5 py-1">
                <option value="">Newest</option>
                <option value="__price">Price (low → high)</option>
                {d.params.map((p) => <option key={p.key} value={p.key}>{p.label} (low → high)</option>)}
              </select>
            </label>
            {people.length > 1 && (
              <label className="text-[11px] font-bold text-gray-500">From
                <select value={who} onChange={(e) => setWho(e.target.value)} className="ml-1.5 text-[11px] border border-amber-200 bg-white px-1.5 py-1">
                  <option value="">Everyone</option>
                  {people.map((p) => <option key={p} value={p}>{name(p)}</option>)}
                </select>
              </label>
            )}
          </div>

          {/* One card per quote, stacked - nothing to scroll sideways */}
          <div className="space-y-3">
            {shown.map((q) => {
              const pi = priceInfo(q.price)
              const filled = d.params.filter((p) => q.values[p.key])
              return (
                <div key={q.id} className="card !p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-black text-gray-900 break-words">{q.vendor}</p>
                      <p className="text-[10px] text-gray-400 mt-0.5">
                        noted by {q.entered_by.toLowerCase() === d.me.toLowerCase() ? 'you' : name(q.entered_by)} · {ago(q.created_at)} {taskLabel(q.task_id)}
                      </p>
                    </div>
                    <div className="text-right shrink-0 max-w-[50%]">
                      {q.price
                        ? <>
                            <p className="text-sm font-black break-words text-gray-900">{pi.text}</p>
                            {pi.extra && <p className="text-[10px] text-gray-400 break-words">{pi.extra}</p>}
                          </>
                        : <p className="text-[11px] text-gray-300">no price yet</p>}
                    </div>
                  </div>

                  <Reactions target="quote" id={q.id} r={q.reactions} d={d} name={name} onChanged={onChanged} />

                  {filled.length > 0 && (
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-2 pt-2 border-t border-amber-100">
                      {filled.map((p) => {
                        const v = q.values[p.key]
                        return (
                          <div key={p.key} className="min-w-0">
                            <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wide truncate">{p.label}{p.unit ? ` (${p.unit})` : ''}</p>
                            <p className="text-xs break-words text-gray-800">{v}</p>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {(() => {
                    // The AI's read of this whole card - price, details, note, opinions, reactions
                    const card = (d.summary?.data?.notes?.quotes || [])
                      .find((x) => Number(String(x.id).replace(/[^0-9]/g, '')) === q.id)
                    if (!card?.points?.length) return null
                    return (
                      <div className="bg-brand-50/60 border border-brand-100 px-2 py-1.5 mt-2">
                        <p className="text-[9px] font-black text-brand-600 uppercase tracking-widest">✨ AI summary of this quote{d.summary.stale ? ' · updating…' : ''}</p>
                        <ul className="mt-0.5 space-y-0.5">
                          {card.points.map((x, i) => (
                            <li key={i} className="text-[11px] text-gray-700 pl-3 relative"><span className="absolute left-0">·</span><Rich text={x} /></li>
                          ))}
                        </ul>
                      </div>
                    )
                  })()}

                  <QuoteNotes q={q} d={d} name={name} onChanged={onChanged} />

                  {q.entered_by.toLowerCase() === d.me.toLowerCase() && (
                    <div className="flex gap-3 mt-2">
                      <button onClick={() => setForm(q)} className="text-[10px] font-bold text-brand-600">Edit quote</button>
                      <button onClick={async () => { if (confirm(`Delete the quote from ${q.vendor}?`)) { await deleteDiscussionQuote(d.id, q.id).catch(() => {}); onChanged() } }}
                        className="text-[10px] font-bold text-red-600">Delete</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * The AI's comparison of the quotes, here on the Quotes tab (the summary
 * above the chat covers the discussion itself): how they compare, best value
 * and per quote its pros and cons and what's still missing - no ranking.
 * Written with the rest of the summary - refreshed from here too.
 */
function QuotesSummary({ d, onChanged }) {
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // Missing, or older than the latest quote / opinion / reaction: written again on its own a few
  // seconds after the last change (so a run of edits costs one AI call), and only while this tab is open
  const running = useRef(false)
  const sm0 = d.summary
  const due = d.ai && d.quotes.length > 0 && (!sm0 || sm0.stale || !sm0.data?.quotes)
  useEffect(() => {
    if (!due || running.current) return undefined
    const t = setTimeout(() => {
      running.current = true
      setBusy(true)
      summariseDiscussion(d.id).then(onChanged).catch(() => {})
        .finally(() => { running.current = false; setBusy(false) })
    }, 4000)
    return () => clearTimeout(t)
  }, [d.id, due, sm0?.at, d.quotes.length])
  const s = d.summary
  const q = s?.data?.quotes
  if (!d.ai || d.quotes.length === 0) return null
  const run = async () => {
    setBusy(true); setErr('')
    try { await summariseDiscussion(d.id); await onChanged() }
    catch (e) { setErr(errText(e, "The AI couldn't compare them just now.")) } finally { setBusy(false) }
  }
  if (!q) return (
    <div className="card !p-3">
      <p className="text-[10px] font-black text-brand-600 uppercase tracking-widest">✨ AI on the quotes</p>
      <p className="text-xs text-gray-500 mt-1">
        {s?.data?.quotes_error ? "The quotes couldn't be compared last time." : 'Not compared yet.'}
      </p>
      <button onClick={run} disabled={busy} className="text-[11px] font-bold text-brand-600 mt-1.5 disabled:opacity-50">
        {busy ? 'Comparing…' : '✨ Compare the quotes'}
      </button>
      {err && <p className="text-[11px] text-red-600 mt-1">{err}</p>}
    </div>
  )
  const copyText = ['Quotes:', q.summary.replace(/\*\*/g, ''),
    ...(q.per_quote || []).map((x) => `- ${x.vendor}: ${x.note}${x.missing ? ` (missing: ${x.missing})` : ''}`)].join('\n')
  return (
    <div className="card !p-0 border-brand-200">
      <button onClick={() => setOpen((v) => !v)} className="w-full text-left px-3 py-2">
        <span className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-black text-brand-600 uppercase tracking-widest">✨ AI on the quotes</span>
          <span className="text-[10px] text-gray-400">
            {busy ? <span className="text-brand-600 font-bold">updating… · </span>
              : s.stale ? <span className="text-amber-600 font-bold">new activity since · </span> : null}{ago(s.at)} {open ? '▴' : '▾'}
          </span>
        </span>
        <span className={`block text-xs text-gray-700 mt-1 ${open ? '' : 'line-clamp-2'}`}><Rich text={q.summary} /></span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          {q.per_quote?.map((x, i) => (
            <p key={i} className="text-[11px] text-gray-600 mt-1.5">
              <span className="font-bold text-gray-800">{x.vendor}</span> - <Rich text={x.note} />
              {x.missing && <span className="block text-[10px] text-amber-700">Missing: {x.missing}</span>}
            </p>
          ))}
          <div className="flex items-center gap-3 mt-3">
            <button onClick={run} disabled={busy} className="text-[11px] font-bold text-brand-600 disabled:opacity-50">
              {busy ? 'Comparing…' : s.stale ? '↻ Update with the latest' : '↻ Refresh'}
            </button>
            <CopyButton text={copyText} />
            <span className="text-[10px] text-gray-400 ml-auto">AI-written - check before deciding</span>
          </div>
          {err && <p className="text-[11px] text-red-600 mt-1">{err}</p>}
        </div>
      )}
    </div>
  )
}

const REACTS = [['like', 'Like'], ['dislike', 'Dislike'], ['neutral', 'Neutral']]

/**
 * Like / dislike / neutral on a quote or an opinion: one each, tap again to
 * take it back; the counts and who reacted are there for everyone.
 */
function Reactions({ target, id, r, d, name, onChanged, small }) {
  const me = d.me.toLowerCase()
  const base = r || { like: [], dislike: [], neutral: [] }
  const [local, setLocal] = useState(null)          // shown at once, before the reload confirms it
  const cur = local || base
  useEffect(() => { setLocal(null) }, [JSON.stringify(base)])
  const mine = REACTS.find(([k]) => (cur[k] || []).some((n) => n.toLowerCase() === me))?.[0] || null
  const tap = async (k) => {
    const kind = mine === k ? null : k
    const next = Object.fromEntries(REACTS.map(([x]) => [x, (cur[x] || []).filter((n) => n.toLowerCase() !== me)]))
    if (kind) next[kind] = [...next[kind], d.me]
    setLocal(next)
    try { await reactInDiscussion(d.id, target, id, kind); await onChanged() } catch { setLocal(null) }
  }
  const who = REACTS.filter(([k]) => cur[k]?.length)
    .map(([k, label]) => `${label}: ${cur[k].map((n) => (n.toLowerCase() === me ? 'you' : name(n))).join(', ')}`).join('  ·  ')
  return (
    <div className={small ? 'mt-0.5 mb-1' : 'mt-2'}>
      <div className="flex items-center gap-1.5">
        {REACTS.map(([k, label]) => {
          const n = cur[k]?.length || 0
          const on = mine === k
          return (
            <button key={k} onClick={() => tap(k)} title={label} aria-label={`${label}${n ? ` (${n})` : ''}`} aria-pressed={on}
              className={`flex items-center justify-center gap-1 border rounded-none tabular-nums transition-colors ${small ? 'min-w-[3.75rem] px-1.5 py-0.5 text-[10px]' : 'min-w-[4.75rem] px-2 py-1 text-[11px]'} ${
                on ? 'bg-brand-50 border-brand-400 text-brand-700 font-black' : 'bg-white border-amber-200 text-gray-600 hover:border-brand-300'}`}>
              <span className="font-semibold">{label}</span>{n > 0 && <span className="font-black">{n}</span>}
            </button>
          )
        })}
      </div>
      {who && <p className={`${small ? 'text-[9px]' : 'text-[10px]'} text-gray-400 mt-0.5`}>{who}</p>}
    </div>
  )
}

/**
 * A quote's Note (what whoever noted it wrote) and, below it, the Opinions -
 * each member's on its own card, with who and when. Everyone can add theirs,
 * edit it, or tidy it with the AI first.
 */
function QuoteNotes({ q, d, name, onChanged }) {
  const me = d.me.toLowerCase()
  const mine = (q.opinions || []).find((o) => o.author.toLowerCase() === me)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [polished, setPolished] = useState(false)
  const [suggestion, setSuggestion] = useState(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const start = () => { setText(mine?.text || ''); setPolished(!!mine?.polished); setSuggestion(null); setErr(''); setEditing(true) }
  const improve = async () => {
    setBusy('ai'); setErr('')
    try { setSuggestion((await polishMessage({ text, discussion_id: d.id, quote_id: q.id })).data.text) }
    catch (e) { setErr(errText(e, "The AI couldn't help just now.")) } finally { setBusy('') }
  }
  const save = async (value = text) => {
    setBusy('save'); setErr('')
    try { await setQuoteOpinion(d.id, q.id, value, polished); setEditing(false); await onChanged() }
    catch (e) { setErr(errText(e, "Couldn't save it.")) } finally { setBusy('') }
  }
  const [noteOpen, setNoteOpen] = useState(false)
  const who = (n) => (n.toLowerCase() === me ? 'You' : name(n))
  const opinions = (q.opinions || []).filter((o) => !(o.author.toLowerCase() === me && editing))
  return (
    <div className="whitespace-normal">
      {q.note && (
        <div className="mt-2 pt-2 border-t border-amber-100">
          {/* folded - the AI summary above already covers it */}
          <button onClick={() => setNoteOpen((v) => !v)} aria-expanded={noteOpen}
            className="block text-[9px] font-bold text-gray-400 hover:text-gray-700 uppercase tracking-wide">
            {noteOpen ? '▾' : '▸'} Note
          </button>
          {noteOpen && <div className="bg-gray-50 border-l-2 border-gray-300 px-2 py-1.5 mt-1">
            <p className="text-[11px] text-gray-700 whitespace-pre-line"><Rich text={q.note} /></p>
            <p className="text-[9px] text-gray-400 mt-0.5">{who(q.entered_by)}, with the quote</p>
          </div>}
        </div>
      )}
      <div className="mt-2 pt-2 border-t border-amber-100 space-y-1.5">
        <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wide">
          Opinions{opinions.length ? ` (${opinions.length})` : ''}
        </p>
        {opinions.map((o) => (
          <div key={o.author} className="bg-white border border-amber-200 px-2 py-1.5">
            <p className="text-[10px] font-bold text-gray-800">
              {who(o.author)}
              <span className="font-normal text-[9px] text-gray-400"> · {ago(o.at)}{o.edited ? ' · edited' : ''}{o.polished ? ' · ✨' : ''}</span>
            </p>
            <p className="text-[11px] text-gray-700 whitespace-pre-line mt-0.5"><Rich text={o.text} /></p>
            {o.id && <Reactions target="opinion" id={o.id} r={o.reactions} d={d} name={name} onChanged={onChanged} small />}
          </div>
        ))}
      {!editing && (
        <button onClick={start} className="block text-[10px] font-bold text-brand-600">{mine ? '✎ Edit your opinion' : '+ Your opinion'}</button>
      )}
      {editing && (
        <div className="bg-amber-50 border border-amber-200 p-2 space-y-1.5">
          {suggestion && (
            <div className="bg-white border border-brand-200 px-2 py-1.5">
              <p className="text-[9px] font-black text-brand-600 uppercase tracking-widest">✨ AI version</p>
              <p className="text-[11px] text-gray-800 whitespace-pre-line mt-0.5">{suggestion}</p>
              <div className="flex gap-3 mt-1">
                <button onClick={() => { setText(suggestion); setPolished(true); setSuggestion(null) }} className="text-[10px] font-bold text-brand-600">Use this</button>
                <button onClick={() => setSuggestion(null)} className="text-[10px] font-bold text-gray-500">Keep mine</button>
              </div>
            </div>
          )}
          <textarea value={text} onChange={(e) => { setText(e.target.value); setPolished(false) }} rows={3} autoFocus
            className="input text-xs" placeholder={`What do you think of ${q.vendor}? Food, location, price, how they were to deal with…`} />
          {err && <p className="text-[10px] text-red-600">{err}</p>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button onClick={() => save()} disabled={!!busy || !text.trim()} className="btn-primary text-[11px] py-1 px-3 disabled:opacity-50">
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
            {d.ai && (
              <button onClick={improve} disabled={!!busy || !text.trim()} className="text-[10px] font-bold text-gray-500 disabled:opacity-40">
                {busy === 'ai' ? 'Improving…' : '✨ Improve with AI'}
              </button>
            )}
            <button onClick={() => { setEditing(false); setErr('') }} className="text-[10px] font-bold text-gray-500">Cancel</button>
            {mine && (
              <button onClick={() => { if (confirm('Remove your opinion on this quote?')) save('') }} disabled={!!busy}
                className="text-[10px] font-bold text-red-600 ml-auto">Remove</button>
            )}
          </div>
        </div>
      )}
      </div>
    </div>
  )
}

function QuoteForm({ d, tasks, name, initial, onCancel, onSaved }) {
  const [vendor, setVendor] = useState(initial.vendor || '')
  const [price, setPrice] = useState(initial.price || '')
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
    const body = { vendor, price, values, note, task_id: taskId ? +taskId : null }
    try {
      await (initial.id ? editDiscussionQuote(d.id, initial.id, body) : addDiscussionQuote(d.id, body))
      onSaved()
    } catch (e2) { setErr(errText(e2, "Couldn't save it.")); setSaving(false) }
  }
  return (
    <form onSubmit={save} className="card space-y-2">
      <p className="text-xs font-black text-gray-500 uppercase tracking-widest">{initial.id ? 'Edit quote' : 'New quote'}</p>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[11px] font-bold text-gray-600 min-w-0">Quote from
          <input value={vendor} onChange={(e) => setVendor(e.target.value)} className="input !px-2.5 !py-2 text-xs mt-0.5" placeholder="e.g. Royal Orchid" autoFocus />
        </label>
        <label className="block text-[11px] font-bold text-gray-600 min-w-0">Price
          <input value={price} onChange={(e) => setPrice(e.target.value)} className="input !px-2.5 !py-2 text-xs mt-0.5" placeholder="₹1,350 / plate" />
        </label>
      </div>
      {d.params.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {d.params.map((p) => (
            <label key={p.key} className="block text-[11px] font-bold text-gray-600">
              {p.label}{p.unit ? <span className="font-normal text-gray-400"> ({p.unit})</span> : null}
              <input value={values[p.key] || ''} onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}
                className="input !px-2.5 !py-2 text-xs mt-0.5" inputMode={PRICE.test(`${p.label} ${p.unit}`) ? 'decimal' : 'text'} />
            </label>
          ))}
        </div>
      )}
      <label className="block text-[11px] font-bold text-gray-600">Notes <span className="font-normal text-gray-400">(optional)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="input !px-2.5 !py-2 text-xs mt-0.5"
          placeholder="What's included, contact person, conditions…" />
      </label>
      {!initial.id && myTasks.length > 0 && (
        <label className="block text-[11px] font-bold text-gray-600">Answers an enquiry
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)} className="input !px-2.5 !py-2 text-xs mt-0.5">
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

/** The AI on the enquiries: who was asked what, what's done, what's still pending. */
function EnquiriesSummary({ d, onChanged }) {
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const s = d.summary
  const e = s?.data?.enquiries
  if (!d.ai) return null
  const run = async () => {
    setBusy(true); setErr('')
    try { await summariseDiscussion(d.id); await onChanged() }
    catch (x) { setErr(errText(x, "The AI couldn't summarise them just now.")) } finally { setBusy(false) }
  }
  if (!e) return (
    <div className="card !p-3">
      <p className="text-[10px] font-black text-brand-600 uppercase tracking-widest">✨ AI on the enquiries</p>
      <p className="text-xs text-gray-500 mt-1">{s?.data?.enquiries_error ? "Couldn't be summarised last time." : 'Not summarised yet.'}</p>
      <button onClick={run} disabled={busy} className="text-[11px] font-bold text-brand-600 mt-1.5 disabled:opacity-50">
        {busy ? 'Summarising…' : '✨ Summarise the enquiries'}
      </button>
      {err && <p className="text-[11px] text-red-600 mt-1">{err}</p>}
    </div>
  )
  const List = ({ title, items, tone }) => (items?.length ? (
    <div className="mt-2">
      <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{title}</p>
      <ul className="mt-0.5 space-y-0.5">
        {items.map((x, i) => <li key={i} className={`text-xs ${tone} pl-3 relative`}><span className="absolute left-0">·</span><Rich text={x} /></li>)}
      </ul>
    </div>
  ) : null)
  const copyText = ['Enquiries:', e.overview, ...(e.pending?.length ? ['Pending:', ...e.pending.map((x) => `- ${x}`)] : []),
    ...(e.done?.length ? ['Found out:', ...e.done.map((x) => `- ${x}`)] : [])].filter(Boolean).join('\n')
  return (
    <div className="card !p-0 border-brand-200">
      <button onClick={() => setOpen((v) => !v)} className="w-full text-left px-3 py-2">
        <span className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-black text-brand-600 uppercase tracking-widest">✨ AI on the enquiries</span>
          <span className="text-[10px] text-gray-400">
            {busy ? <span className="text-brand-600 font-bold">updating… · </span>
              : s.stale ? <span className="text-amber-600 font-bold">new activity since · </span> : null}{ago(s.at)} {open ? '▴' : '▾'}
          </span>
        </span>
        <span className={`block text-xs text-gray-700 mt-1 ${open ? '' : 'line-clamp-2'}`}><Rich text={e.overview} /></span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          {e.people?.length > 0 && (
            <div className="mt-1">
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Who's on what</p>
              {e.people.map((p, i) => (
                <p key={i} className="text-xs text-gray-700 mt-0.5"><span className="font-bold">{p.name}:</span> <Rich text={p.summary} /></p>
              ))}
            </div>
          )}
          <List title="Still pending" items={e.pending} tone="text-amber-700" />
          <List title="Found out" items={e.done} tone="text-green-700" />
          <div className="flex items-center gap-3 mt-3">
            <button onClick={run} disabled={busy} className="text-[11px] font-bold text-brand-600 disabled:opacity-50">
              {busy ? 'Summarising…' : s.stale ? '↻ Update with the latest' : '↻ Refresh'}
            </button>
            <CopyButton text={copyText} />
            <span className="text-[10px] text-gray-400 ml-auto">AI-written - check before deciding</span>
          </div>
          {err && <p className="text-[11px] text-red-600 mt-1">{err}</p>}
        </div>
      )}
    </div>
  )
}

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
      <EnquiriesSummary d={d} onChanged={onChanged} />
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

// ── activity: everything that happened ─────────────────────────────────────

const ACT_ICON = { start: '🆕', message: '💬', enquiry: '📨', invite: '✉️', done: '✅', quote: '🧾', poll: '📊', vote: '🗳️', join: '👋', group: '•' }

/**
 * This discussion's history (every message, enquiry, quote, poll, vote,
 * join), or the whole group's activity feed - expenses and payments too.
 */
function ActivityTab({ d, name }) {
  const [scope, setScope] = useState('discussion')
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  const me = d.me.toLowerCase()
  useEffect(() => {
    setRows(null); setErr('')
    getDiscussionActivity(d.id, scope).then((r) => setRows(r.data.items)).catch(() => setErr("Couldn't load the activity."))
  }, [scope, d.id, d.messages.length, d.quotes.length, d.polls.length])

  // One heading per day
  const days = []
  ;(rows || []).forEach((r) => {
    const day = r.at ? new Date(r.at).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : ''
    if (!days.length || days[days.length - 1].day !== day) days.push({ day, items: [] })
    days[days.length - 1].items.push(r)
  })

  return (
    <div className="px-4 py-3 max-w-2xl w-full">
      <div className="flex border border-amber-200 w-fit mb-3">
        {[['discussion', 'This discussion'], ['group', `All of ${d.group.name}`]].map(([k, label]) => (
          <button key={k} onClick={() => setScope(k)}
            className={`px-3 py-1.5 text-[11px] font-bold ${scope === k ? 'bg-gray-800 text-white' : 'text-gray-500 bg-white'}`}>{label}</button>
        ))}
      </div>
      {scope === 'group' && <p className="text-[10px] text-gray-400 -mt-1.5 mb-2">Expenses, payments and settle-ups in the group, and its discussions' milestones.</p>}
      {err && <p className="text-xs text-red-600">{err}</p>}
      {!rows && !err && <p className="text-xs text-gray-400">Loading…</p>}
      {rows?.length === 0 && <p className="text-xs text-gray-500">Nothing yet.</p>}
      {days.map((g) => (
        <div key={g.day} className="mb-3">
          <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">{g.day}</p>
          <div className="card !p-0">
            {g.items.map((r, i) => (
              <div key={i} className="flex gap-2.5 px-3 py-2 border-b border-amber-100 last:border-0">
                <span className="text-sm leading-5 w-5 text-center shrink-0">{ACT_ICON[r.kind] || '•'}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-xs text-gray-800">
                    <span className="font-bold">{r.actor ? (r.actor.toLowerCase() === me ? 'You' : name(r.actor)) : 'Someone'}</span> {r.text}
                  </span>
                  {r.detail && <span className="block text-[11px] text-gray-500 truncate">{r.detail}</span>}
                </span>
                <span className="text-[10px] text-gray-400 shrink-0">
                  {r.at ? new Date(r.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── AI summary of the details, the talk and the quotes ─────────────────────

/**
 * What the discussion comes to, for anyone catching up: the AI reads the
 * details, messages, enquiries and polls on one key and compares the
 * quotes on the other, at once. Kept until asked again; marked out of date
 * once anything new happens.
 */
function Summary({ d, onChanged }) {
  const s = d.summary
  const [open, setOpen] = useState(true)            // read first, so open from the start
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const run = async () => {
    setBusy(true); setErr('')
    try { await summariseDiscussion(d.id); setOpen(true); await onChanged() }
    catch (e) { setErr(errText(e, "The AI couldn't summarise it just now.")) }
    finally { setBusy(false) }
  }
  // Missing or out of date when the page opens: written / brought up to date once, on its own
  const auto = useRef(false)
  useEffect(() => {
    if (auto.current || !d.ai || !d.description) return
    if (!s || s.stale) { auto.current = true; run() }
  }, [d.id])

  if (!s) return (
    <div>
      {busy && (
        <div className="bg-white text-gray-800 border border-brand-200 px-3 py-3 mb-1">
          <p className="text-[10px] font-black text-brand-600 uppercase tracking-widest">✨ AI summary</p>
          <p className="text-xs text-gray-500 mt-1">
            <span className="inline-block w-2 h-2 mr-1.5 rounded-full bg-brand-400 animate-pulse align-middle" />
            Writing it from the details, the chat and the quotes…
          </p>
        </div>
      )}
      {!busy && <button onClick={run} disabled={busy}
        className="text-[11px] font-bold border border-brand-300 text-brand-600 bg-white px-2.5 py-1 hover:bg-brand-50 disabled:opacity-50">
        ✨ Summarise with AI
      </button>}
      {!busy && <span className="text-[10px] text-gray-400 ml-2">the details and everyone's thoughts, in one read</span>}
      {err && <p className="text-[11px] text-red-600 mt-1">{err}</p>}
    </div>
  )

  const t = s.data.talk || {}
  const List = ({ title, items, tone = 'text-gray-700' }) => (items?.length ? (
    <div className="mt-2">
      <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{title}</p>
      <ul className="mt-0.5 space-y-0.5">
        {items.map((x, i) => <li key={i} className={`text-xs ${tone} pl-3 relative`}><span className="absolute left-0">·</span>{x}</li>)}
      </ul>
    </div>
  ) : null)
  const copyText = [
    `${d.title} - summary`, t.overview,
    ...(t.decided?.length ? ['Decided:', ...t.decided.map((x) => `- ${x}`)] : []),
    ...(t.open?.length ? ['Still open:', ...t.open.map((x) => `- ${x}`)] : []),
    ...(t.next?.length ? ['Next:', ...t.next.map((x) => `- ${x}`)] : []),
  ].filter(Boolean).join('\n')

  return (
    <div className="bg-white text-gray-800 border border-brand-200">
      <button onClick={() => setOpen((v) => !v)} className="w-full text-left px-3 py-2">
        <span className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-black text-brand-600 uppercase tracking-widest">✨ AI summary</span>
          <span className="text-[10px] text-gray-400">
            {busy ? <span className="text-brand-600 font-bold">updating… · </span>
              : s.stale ? <span className="text-amber-600 font-bold">new activity since · </span> : null}{ago(s.at)} {open ? '▴' : '▾'}
          </span>
        </span>
        <span className={`block text-xs text-gray-700 mt-1 ${open ? '' : 'line-clamp-2'}`}><Rich text={t.overview} /></span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          {t.people?.length > 0 && (
            <div className="mt-1">
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">What each person thinks</p>
              {t.people.map((p, i) => (
                <p key={i} className="text-xs text-gray-700 mt-0.5"><span className="font-bold">{p.name}:</span> {p.summary}</p>
              ))}
            </div>
          )}
          <List title="Decided" items={t.decided} tone="text-green-700" />
          <List title="Still open" items={t.open} tone="text-amber-700" />
          <List title="Next steps" items={t.next} />
          <div className="flex items-center gap-3 mt-3">
            <button onClick={run} disabled={busy} className="text-[11px] font-bold text-brand-600 disabled:opacity-50">
              {busy ? 'Summarising…' : s.stale ? '↻ Update with the latest' : '↻ Refresh'}
            </button>
            <CopyButton text={copyText} />
            <span className="text-[10px] text-gray-400 ml-auto">AI-written from the chat - check before deciding</span>
          </div>
          {err && <p className="text-[11px] text-red-600 mt-1">{err}</p>}
        </div>
      )}
    </div>
  )
}
