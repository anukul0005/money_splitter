import { useEffect, useState } from 'react'
import { listUsersBasic } from '../api/index.js'

const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i

/**
 * Pick people to plan with: app users by searching their name, and anyone
 * else by email (they get an invite). `exclude` hides names already in.
 */
export default function PeoplePicker({ me, exclude = [], members, setMembers, emails, setEmails, onError }) {
  const [users, setUsers] = useState(null)
  const [q, setQ] = useState('')
  const [emailDraft, setEmailDraft] = useState('')
  useEffect(() => { listUsersBasic().then((r) => setUsers(r.data)).catch(() => setUsers([])) }, [])

  const skip = new Set([me, ...exclude, ...members].map((n) => (n || '').toLowerCase()))
  const term = q.trim().toLowerCase()
  const matches = (users || [])
    .filter((u) => !skip.has(u.name.toLowerCase()))
    .filter((u) => !term || u.name.toLowerCase().includes(term) || (u.full_name || '').toLowerCase().includes(term))
    .slice(0, term ? 8 : 6)
  const label = (n) => {
    const u = users?.find((x) => x.name === n)
    return u?.full_name && u.full_name !== u.name ? `${u.full_name} (${u.name})` : n
  }
  const addEmail = () => {
    const e = emailDraft.trim().toLowerCase()
    if (!e) return
    if (!EMAIL.test(e)) { onError?.(`${e} doesn't look like an email address`); return }
    // An email that belongs to someone already on the app is still fine - the invite link adds them
    if (!emails.includes(e)) setEmails([...emails, e])
    setEmailDraft(''); onError?.('')
  }

  return (
    <div className="space-y-2">
      {(members.length > 0 || emails.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {members.map((n) => (
            <span key={n} className="flex items-center gap-1 text-[11px] font-bold bg-brand-50 border border-brand-200 text-gray-800 pl-2 pr-1 py-0.5">
              👤 {label(n)}
              <button type="button" onClick={() => setMembers(members.filter((x) => x !== n))} className="text-gray-400 hover:text-red-600 px-0.5" aria-label={`Remove ${n}`}>✕</button>
            </span>
          ))}
          {emails.map((e) => (
            <span key={e} className="flex items-center gap-1 text-[11px] font-bold bg-amber-50 border border-amber-200 text-gray-700 pl-2 pr-1 py-0.5">
              ✉ {e}
              <button type="button" onClick={() => setEmails(emails.filter((x) => x !== e))} className="text-gray-400 hover:text-red-600 px-0.5" aria-label={`Remove ${e}`}>✕</button>
            </span>
          ))}
        </div>
      )}

      <div>
        <input value={q} onChange={(e) => setQ(e.target.value)} className="input text-xs py-1.5"
          placeholder="Search people on the app…"
          onKeyDown={(e) => {
            // Enter picks the only match, and never submits the form around it
            if (e.key !== 'Enter') return
            e.preventDefault()
            if (term && matches.length === 1) { setMembers([...members, matches[0].name]); setQ('') }
          }} />
        {users === null ? <p className="text-[10px] text-gray-400 mt-1">Loading people…</p> : (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {matches.map((u) => (
              <button key={u.id} type="button" onClick={() => { setMembers([...members, u.name]); setQ('') }}
                className="text-[11px] font-bold bg-white border border-amber-200 hover:border-brand-300 text-gray-700 px-2 py-0.5">
                + {u.full_name && u.full_name !== u.name ? `${u.full_name} (${u.name})` : u.name}
              </button>
            ))}
            {term && matches.length === 0 && (
              <span className="text-[10px] text-gray-400">No one on the app called "{q.trim()}" - invite them by email below.</span>
            )}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <input value={emailDraft} onChange={(e) => setEmailDraft(e.target.value)} type="email"
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addEmail() } }}
          className="input text-xs py-1.5 flex-1" placeholder="Not on the app? Their email - name@email.com" />
        <button type="button" onClick={addEmail} disabled={!emailDraft.trim()} className="text-xs font-bold text-brand-600 disabled:opacity-40 px-2">Invite</button>
      </div>
      {emails.length > 0 && <p className="text-[10px] text-gray-400">They get an email with a link - once signed up, it adds them to the group.</p>}
    </div>
  )
}
