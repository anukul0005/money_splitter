import { useEffect, useRef, useState } from 'react'
import { startImportJob, getImportJob, cancelImportJob, listStatementPasswords, forgetStatementPassword,
  revealStatementPassword, setStatementPassword, getMailSyncStatus, startMailSync, getGmailConnectUrl } from '../api'
import StatementImportResult from './StatementImportResult'

// The payment apps (and banks) a statement can come from, and the file types each
// app's statement downloads as. The backend works the format out from the
// file itself - picking the app only narrows the file chooser.
const APPS = [
  { key: 'gpay',    label: 'Google Pay', hint: 'PDF statement',       accept: '.pdf,application/pdf' },
  { key: 'phonepe', label: 'PhonePe',    hint: 'CSV or PDF statement', accept: '.csv,text/csv,.pdf,application/pdf' },
  { key: 'paytm',   label: 'Paytm',      hint: 'PDF or Excel statement', accept: '.pdf,application/pdf,.xlsx,.csv,text/csv' },
  // Any bank's account statement (HDFC, SBI, ICICI, ...) - read by AI on the server
  { key: 'bank',    label: 'Bank',       hint: "Any bank's PDF statement", accept: '.pdf,application/pdf' },
]
// For a single "upload a statement" button with no app picker.
export const ANY_STATEMENT = { key: 'any', label: 'statement', accept: '.csv,text/csv,.pdf,application/pdf,.xlsx' }

// Sending the file is the first slice of the bar; the server's own
// progress (reading pages, matching, AI, saving) fills the rest.
const UPLOAD_SHARE = 0.08
const POLL_MS = 700

function UploadIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m0-12l-4 4m4-4l4 4" />
    </svg>
  )
}

/**
 * The monthly page's "Upload" button: pick the app, pick its statement,
 * and the import fills the month-wise groups (creating any it needs).
 * `onPick` gets the chosen app - see useStatementUpload's `pick`.
 */
export function StatementUploadButton({ busy, onPick }) {
  const [open, setOpen]   = useState(false)
  return (
    <div className="relative flex-shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Upload a payment app statement"
        className="flex items-center gap-1.5 bg-cream border border-amber-200 text-gray-500 hover:bg-amber-50 rounded-md px-3 py-1.5 text-xs font-bold active:scale-95 transition-all shadow-sm disabled:opacity-50"
      >
        <UploadIcon />
        {busy ? 'Importing…' : 'Upload'}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute right-0 mt-1 w-64 bg-white border border-amber-200 rounded-md shadow-lg z-30 py-1">
            <p className="px-3 pt-1 pb-1.5 text-[10px] font-black text-gray-400 tracking-widest">STATEMENT FROM</p>
            {APPS.map((a) => (
              <button
                key={a.key}
                role="menuitem"
                disabled={!a.accept}
                onClick={() => { setOpen(false); onPick(a) }}
                className="w-full text-left px-3 py-2 hover:bg-amber-50 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <span className="block text-sm font-bold text-gray-800">{a.label}</span>
                <span className="block text-[11px] text-gray-400">{a.hint}</span>
              </button>
            ))}
            <div className="border-t border-amber-100 mt-1 pt-1.5 pb-1 px-3">
              <SavedPasswords />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

const PASSWORD_APPS = ['PhonePe', 'Paytm', 'Google Pay']

/**
 * The remembered statement passwords (one per app): Show reveals one,
 * Edit changes it, Forget deletes it, and "+ Add" saves one ahead of the
 * first locked statement. Used in the Upload and Sync menus.
 */
export function SavedPasswords() {
  const [rows, setRows]       = useState(null)
  const [shown, setShown]     = useState({})     // app -> its revealed password
  const [editing, setEditing] = useState(null)   // the app being edited, or '' while adding one
  const [draftApp, setDraftApp] = useState('')
  const [draft, setDraft]     = useState('')
  const [showDraft, setShowDraft] = useState(false)
  const [err, setErr]         = useState('')
  const [saving, setSaving]   = useState(false)

  const load = () => listStatementPasswords().then((r) => setRows(r.data)).catch(() => setRows([]))
  useEffect(() => { load() }, [])

  const reveal = async (app) => {
    const { data } = await revealStatementPassword(app)
    setShown((s) => ({ ...s, [app]: data.password }))
    return data.password
  }
  const toggleShow = async (app) => {
    setErr('')
    if (app in shown) { setShown(({ [app]: _, ...rest }) => rest); return }
    try { await reveal(app) } catch { setErr("Couldn't load that password.") }
  }
  const startEdit = async (app) => {
    setErr(''); setShowDraft(false); setEditing(app)
    setDraftApp(app || PASSWORD_APPS.find((a) => !rows?.some((r) => r.app === a)) || PASSWORD_APPS[0])
    setDraft('')
    if (app) { try { setDraft(app in shown ? shown[app] : await reveal(app)) } catch { /* type a new one */ } }
  }
  const save = async (e) => {
    e.preventDefault()
    if (!draft || !draftApp.trim()) return
    setSaving(true); setErr('')
    try {
      await setStatementPassword(draftApp.trim(), draft)
      setShown(({ [draftApp.trim()]: _, ...rest }) => rest)
      setEditing(null); await load()
    } catch (e2) {
      setErr(e2.response?.data?.detail || "Couldn't save it.")
    } finally { setSaving(false) }
  }
  const forget = async (app) => {
    if (!confirm(`Forget your saved ${app} statement password?`)) return
    await forgetStatementPassword(app).catch(() => {})
    setRows((rs) => rs.filter((r) => r.app !== app))
  }

  const form = (
    <form onSubmit={save} className="mt-1 mb-1.5 space-y-1.5">
      {editing === '' && (
        <select value={draftApp} onChange={(e) => setDraftApp(e.target.value)} className="input text-xs py-1.5">
          {PASSWORD_APPS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      )}
      <div className="relative">
        <input
          type={showDraft ? 'text' : 'password'} value={draft} onChange={(e) => setDraft(e.target.value)}
          placeholder={`${draftApp} statement password`} autoFocus autoComplete="off" autoCapitalize="none"
          autoCorrect="off" spellCheck={false} className="input text-xs py-1.5 pr-12"
        />
        <button type="button" onClick={() => setShowDraft((v) => !v)}
          className="absolute inset-y-0 right-0 px-2 text-[10px] font-bold text-brand-600">
          {showDraft ? 'Hide' : 'Show'}
        </button>
      </div>
      <div className="flex gap-3">
        <button type="submit" disabled={!draft || saving} className="text-[11px] font-bold text-brand-600 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={() => setEditing(null)} className="text-[11px] font-bold text-gray-400">Cancel</button>
      </div>
    </form>
  )

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-black text-gray-400 tracking-widest">SAVED PASSWORDS</p>
        {editing === null && rows && (
          <button onClick={() => startEdit('')} className="text-[11px] font-bold text-brand-600">+ Add</button>
        )}
      </div>
      {rows === null && <p className="text-[11px] text-gray-400 py-1">Loading…</p>}
      {rows?.length === 0 && editing === null && (
        <p className="text-[11px] text-gray-400 py-1">None yet - saved when a locked statement opens, or add one.</p>
      )}
      {rows?.map(({ app }) => (
        <div key={app} className="py-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-700 flex-1 min-w-0 truncate">
              🔒 {app}
              {app in shown && <span className="ml-1.5 font-mono text-gray-900 select-all">{shown[app]}</span>}
            </span>
            {editing !== app && <>
              <button onClick={() => toggleShow(app)} className="text-[11px] font-bold text-gray-500">{app in shown ? 'Hide' : 'Show'}</button>
              <button onClick={() => startEdit(app)} className="text-[11px] font-bold text-brand-600">Edit</button>
              <button onClick={() => forget(app)} className="text-[11px] font-bold text-red-600">Forget</button>
            </>}
          </div>
          {editing === app && form}
        </div>
      ))}
      {editing === '' && form}
      {err && <p className="text-[11px] text-red-600">{err}</p>}
    </div>
  )
}

const ago = (t) => {
  if (!t) return null
  const s = (Date.now() - new Date(t).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86400)
  if (d < 7) return `${d} day${d > 1 ? 's' : ''} ago`
  return `on ${new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`
}

/** The sync's Gmail - fetched (and its access checked) whenever `active` turns on. */
function useMailStatus(active) {
  const [st, setSt] = useState(null)
  useEffect(() => {
    if (active) getMailSyncStatus().then((r) => setSt(r.data)).catch(() => setSt({ error: true }))
  }, [active])
  return st
}

function MailStatusLine({ st }) {
  if (!st) return <span className="text-gray-400">Checking Gmail…</span>
  if (st.error) return <span className="text-gray-400">Couldn't check Gmail</span>
  if (!st.connected) return <span className="text-gray-500">Gmail not connected yet</span>
  if (st.expired) return <span className="text-red-600 font-semibold">Gmail access expired - reconnect to sync</span>
  return (
    <span className="text-gray-500">
      {st.mail_synced_at ? `Last synced ${ago(st.mail_synced_at)}` : 'Not synced yet'}
      <span className="text-gray-400"> · {st.gmail_address}</span>
    </span>
  )
}

// How far back the sync looks: a few days by default - quick, and the
// everyday case; older statements only when asked for.
const LOOK_BACK = [[4, '4 days'], [14, '2 weeks'], [30, '1 month'], [365, 'All']]

function LookBack({ days, onChange }) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <span className="text-[10px] font-bold text-gray-400 mr-0.5">Look back</span>
      {LOOK_BACK.map(([d, label]) => (
        <button key={d} type="button" onClick={() => onChange(d)}
          className={`px-2 py-0.5 rounded-full text-[11px] font-bold border transition-colors ${
            days === d ? 'bg-brand-400 border-brand-400 text-white' : 'bg-white border-amber-200 text-gray-600 hover:bg-amber-50'}`}>
          {label}
        </button>
      ))}
    </div>
  )
}

const SyncIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.3} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M5.6 15A7 7 0 0018 17.4M18.4 9A7 7 0 006 6.6" />
  </svg>
)

/**
 * The monthly page's small "Sync" button - statements from Gmail. It opens
 * a menu: the inbox and its last sync (or that access has expired, with
 * Reconnect), Sync now, and the saved statement passwords.
 */
export function MailSyncButton({ busy, onSync, onConnect }) {
  const [open, setOpen] = useState(false)
  const [days, setDays] = useState(4)
  const st = useMailStatus(open && !busy)
  const reconnect = st?.connected && st.expired
  return (
    <div className="relative flex-shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Import PhonePe, Paytm and Google Pay statements from your Gmail"
        className="flex items-center gap-1 bg-cream border border-amber-200 text-gray-500 hover:bg-amber-50 rounded-md px-2.5 py-1.5 text-xs font-bold active:scale-95 transition-all shadow-sm disabled:opacity-50"
      >
        <SyncIcon />
        {busy ? 'Syncing…' : 'Sync'}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute right-0 mt-1 w-72 max-w-[calc(100vw-2rem)] bg-white border border-amber-200 rounded-md shadow-lg z-30 py-2 px-3">
            <p className="text-[10px] font-black text-gray-400 tracking-widest">STATEMENTS FROM GMAIL</p>
            <p className="text-[11px] mt-1 leading-snug"><MailStatusLine st={st} /></p>
            <div className="mt-2"><LookBack days={days} onChange={setDays} /></div>
            <button
              onClick={() => { setOpen(false); reconnect ? onConnect() : onSync(days) }}
              className="btn-primary text-xs w-full mt-2 py-2"
            >
              {reconnect ? 'Reconnect Gmail' : st && !st.error && !st.connected ? 'Connect Gmail & sync' : 'Sync now'}
            </button>
            <p className="text-[10px] text-gray-400 mt-1">
              PhonePe, Paytm and Google Pay statement emails{days >= 365 ? ' from the last year' : ` from the last ${LOOK_BACK.find(([d]) => d === days)[1]}`}.
            </p>
            <div className="border-t border-amber-100 mt-2 pt-1.5">
              <SavedPasswords />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * The full-width "Sync statements from Gmail" button (New expense, Add
 * expense's monthly section), with the last sync under it and the saved
 * passwords one tap away.
 */
export function MailSyncWide({ busy, onSync, onConnect, className = '' }) {
  const st = useMailStatus(!busy)
  const [pw, setPw] = useState(false)
  const [days, setDays] = useState(4)
  const reconnect = st?.connected && st.expired
  return (
    <div className={className}>
      {!reconnect && <div className="mb-1.5"><LookBack days={days} onChange={setDays} /></div>}
      <button type="button" disabled={busy} onClick={() => (reconnect ? onConnect() : onSync(days))}
        className="w-full py-2.5 text-xs font-bold text-gray-700 bg-white border border-amber-300 rounded-md hover:bg-amber-100 active:scale-[0.98] transition-all disabled:opacity-50">
        📧 {reconnect ? 'Reconnect Gmail to sync statements' : 'Sync statements from Gmail'}
      </button>
      <div className="flex items-start justify-between gap-2 mt-1 text-[11px]">
        <span className="min-w-0 truncate"><MailStatusLine st={st} /></span>
        <button type="button" onClick={() => setPw((v) => !v)} className="flex-shrink-0 font-bold text-brand-600">
          🔒 Passwords {pw ? '▴' : '▾'}
        </button>
      </div>
      {pw && (
        <div className="mt-1.5 bg-white border border-amber-200 rounded-md px-3 py-2">
          <SavedPasswords />
        </div>
      )}
    </div>
  )
}

/** What the mail sync found, above the usual import result. */
function MailSummary({ mail }) {
  return (
    <div className="text-xs text-gray-700 pr-5 mb-2 space-y-0.5">
      <p className="font-bold">📧 {mail.emails} statement email{mail.emails === 1 ? '' : 's'} in your Gmail</p>
      {mail.imported.map((x, i) => (
        <p key={i} className="text-gray-500 truncate">✓ {x.source}: {x.subject} · {x.created} new</p>
      ))}
      {mail.already > 0 && <p className="text-gray-400">{mail.already} already imported before</p>}
      {mail.locked.length > 0 && <p className="text-amber-700">🔒 {mail.locked.length} still locked - sync again with its password</p>}
      {mail.unreadable > 0 && <p className="text-gray-400">{mail.unreadable} email{mail.unreadable > 1 ? 's' : ''} had no statement the app could read</p>}
      {mail.password_saved && <p className="text-gray-500">🔒 Password saved for next time</p>}
      {mail.emails === 0 && (
        <p className="text-gray-500">
          No PhonePe, Paytm or Google Pay statement emails in the last {mail.days || 4} day{mail.days === 1 ? '' : 's'}
          {(mail.days || 4) < 365 && ' - pick a longer look-back for older ones'}.
        </p>
      )}
    </div>
  )
}

function ProgressBar({ stage, fraction }) {
  const pct = Math.max(2, Math.min(100, Math.round(fraction * 100)))
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="font-semibold text-gray-700">{stage}…</span>
        <span className="font-bold text-brand-600 tabular-nums">{pct}%</span>
      </div>
      <div
        className="h-2 bg-amber-100 rounded-full overflow-hidden"
        role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={stage}
      >
        <div className="h-full bg-brand-400 rounded-full transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/**
 * The import's activity log, from the server: each step as it started
 * (minutes into the import), the current one with how long it has been
 * running - so a slow AI step reads as working, not frozen.
 */
function ActivityLog({ activity, live }) {
  const log = activity?.log || []
  if (!log.length) return null
  const now = (Date.now() + activity.skew) / 1000      // the server's clock
  const start = log[0].at
  const lines = live ? log.slice(-6) : log
  const current = lines[lines.length - 1]
  const stuckFor = live ? now - current.at : 0
  return (
    <div className="mt-2">
      <ul className="space-y-0.5 text-[11px]">
        {lines.map((l, i) => {
          const isNow = live && i === lines.length - 1
          return (
            <li key={`${l.at}-${i}`} className={`flex gap-2 ${isNow ? 'text-gray-800 font-semibold' : 'text-gray-400'}`}>
              <span className="w-8 flex-shrink-0 tabular-nums">{clock(l.at - start)}</span>
              <span className="min-w-0 break-words">
                {isNow && <span className="inline-block w-2 h-2 mr-1.5 rounded-full bg-brand-400 animate-pulse align-middle" />}
                {l.text}
                {isNow && <span className="font-normal text-gray-400"> · {Math.max(0, Math.round(stuckFor))}s</span>}
              </span>
            </li>
          )
        })}
      </ul>
      {stuckFor > 25 && (
        <p className="text-[11px] text-amber-700 mt-1.5">
          Still working on this step - the AI and long statements can take a minute or two. It carries on on the server even if you leave this page.
        </p>
      )}
    </div>
  )
}

/**
 * Everything behind a statement upload: the hidden file input, the import
 * job with its progress bar, a password box when the PDF is locked, and
 * the result. `onImported` runs after a successful import so the page can
 * reload. Returns { busy, pick(app), input, panel } - render `input` and
 * `panel` where they belong; `pick` opens the file chooser for that app.
 */
export function useStatementUpload(onImported, { panelClassName = 'mx-5 mt-3' } = {}) {
  const inputRef = useRef(null)
  const pollRef  = useRef(null)
  const jobRef   = useRef(null)    // the running import's id, for Cancel
  const abortRef = useRef(null)    // stops the file upload itself
  const [app, setApp]           = useState(null)
  const [file, setFile]         = useState(null)    // kept so a locked PDF can be retried with its password
  const [progress, setProgress] = useState(null)    // { stage, fraction } while importing
  const [error, setError]       = useState('')
  const [locked, setLocked]     = useState(false)   // the file needs a password
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [remember, setRemember] = useState(true)   // statements keep one fixed password
  const [result, setResult]     = useState(null)
  const [cancelling, setCancelling] = useState(false)
  const [notice, setNotice]     = useState('')
  const [fromMail, setFromMail] = useState(false)   // this run is the mail sync, not a picked file
  const [noGmail, setNoGmail]   = useState(false)   // the mail sync needs Gmail connected first
  const [mailLocked, setMailLocked] = useState(null) // the locked statements the mail sync found
  const [activity, setActivity] = useState(null)     // { log, skew } - the server's step-by-step log
  const [, setTick] = useState(0)

  useEffect(() => () => clearTimeout(pollRef.current), [])
  const busy = progress !== null
  // A once-a-second redraw while importing, for the current step's timer.
  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [busy])
  const track = (data) => data.log && setActivity({ log: data.log, skew: data.now * 1000 - Date.now() })

  const reset = () => { setNotice(''); setError(''); setResult(null); setLocked(false); setPassword(''); setShowPassword(false); setNoGmail(false); setMailLocked(null); setActivity(null) }

  const pick = (a) => {
    setApp(a); reset(); setFile(null); setFromMail(false)
    // The input's accept list has to be in place before the chooser opens.
    if (inputRef.current) {
      inputRef.current.accept = a.accept
      inputRef.current.click()
    }
  }

  const finish = () => {
    clearTimeout(pollRef.current); setProgress(null); setCancelling(false)
    jobRef.current = null; abortRef.current = null
  }

  const cancel = async () => {
    setCancelling(true)
    if (!jobRef.current) {   // still sending the file - just stop sending it
      abortRef.current?.abort()
      return
    }
    try { await cancelImportJob(jobRef.current) } catch { /* the next poll says how it ended */ }
  }

  const fail = (detail) => {
    finish()
    if (detail?.code === 'gmail_not_connected' || detail?.code === 'gmail_expired') {
      setNoGmail(detail.code === 'gmail_expired' ? 'expired' : true)
    } else if (detail?.code === 'password_required' || detail?.code === 'password_wrong') {
      setLocked(true)
      if (detail.mail) setMailLocked(detail.mail.locked)
      setError(detail.code === 'password_wrong' ? detail.message : '')
    } else {
      setError((typeof detail === 'string' ? detail : detail?.message) || 'Could not import that file.')
    }
  }

  const poll = (jobId, misses = 0) => {
    pollRef.current = setTimeout(async () => {
      try {
        const { data } = await getImportJob(jobId)
        track(data)
        if (data.status === 'done') {
          finish(); setResult(data.result); setLocked(false); setPassword('')
          // some mail statements imported, some still locked: ask for the password too
          if (data.result?.mail?.locked?.length) { setLocked(true); setMailLocked(data.result.mail.locked) }
          onImported?.()
        } else if (data.status === 'cancelled') {
          finish(); setNotice('Import cancelled - nothing from that statement was saved.')
        } else if (data.status === 'error') {
          fail(data.error)
        } else {
          setProgress({ stage: data.stage, fraction: UPLOAD_SHARE + (1 - UPLOAD_SHARE) * data.progress })
          poll(jobId)
        }
      } catch (err) {
        // A dropped poll (flaky mobile data) isn't a failed import - retry a few times.
        if (misses < 5 && err.response?.status !== 404) poll(jobId, misses + 1)
        else fail(err.response?.data?.detail || 'Lost track of the import - check your monthly groups, then try again.')
      }
    }, POLL_MS)
  }

  const upload = async (f, pw = '', keep = false) => {
    if (!f) return
    setFile(f); setError(''); setResult(null); setNotice(''); setActivity(null)
    setProgress({ stage: 'Uploading', fraction: 0 })
    abortRef.current = new AbortController()
    try {
      const { data } = await startImportJob(f, pw, (e) => {
        if (e.total) setProgress({ stage: 'Uploading', fraction: UPLOAD_SHARE * (e.loaded / e.total) })
      }, abortRef.current.signal, keep)
      jobRef.current = data.job_id
      setProgress({ stage: 'Starting', fraction: UPLOAD_SHARE })
      poll(data.job_id)
    } catch (err) {
      if (err.code === 'ERR_CANCELED') {
        finish(); setNotice('Upload cancelled.')
        return
      }
      fail(err.response?.data?.detail)
    } finally {
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  // PhonePe / Paytm / Google Pay statements in Gmail, imported like uploads
  // (the backend's mail-sync job); a password only when one is still locked.
  const daysRef = useRef(4)        // the look-back picked - a password retry reuses it
  const mailSync = async (pw = '', keep = false, days) => {
    if (busy) return
    if (days) daysRef.current = days
    if (!pw) { reset(); setFile(null) }
    setFromMail(true); setApp({ label: 'mail' }); setError(''); setResult(null); setNotice(''); setActivity(null)
    setProgress({ stage: 'Searching your mail', fraction: 0.02 })
    try {
      const { data } = await startMailSync(pw, keep, daysRef.current)
      jobRef.current = data.job_id
      poll(data.job_id)
    } catch (err) {
      fail(err.response?.data?.detail)
    }
  }
  const connectGmail = async () => {
    try { window.location.href = (await getGmailConnectUrl('expenses')).data.url }
    catch (err) { setError(err.response?.data?.detail || "Couldn't start connecting Gmail.") }
  }

  const input = (
    <input ref={inputRef} type="file" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
  )

  const panel = (busy || error || result || locked || notice || noGmail) && (
    <div className={`${panelClassName} card px-4 py-3 relative`}>
      {!busy && (
        <button
          onClick={() => { reset(); setFile(null) }}
          className="absolute top-2 right-3 text-gray-400 hover:text-gray-600 text-sm"
          aria-label="Close"
        >
          ✕
        </button>
      )}
      {/* With the log listing the steps, the bar just says what's running. */}
      {busy && <ProgressBar fraction={progress.fraction}
        stage={activity?.log?.length ? (fromMail ? 'Syncing statements' : 'Importing') : progress.stage} />}
      {busy && <ActivityLog activity={activity} live />}
      {busy && (
        <div className="flex items-center justify-between gap-3 mt-1.5">
          <p className="text-[11px] text-gray-400">
            {fromMail ? 'PhonePe, Paytm and Google Pay statements in your Gmail' : `Your ${app?.label} statement`} - this can take a minute.
          </p>
          <button
            onClick={cancel}
            disabled={cancelling}
            className="flex-shrink-0 text-xs font-bold text-red-600 hover:text-red-700 disabled:opacity-50"
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        </div>
      )}
      {notice && !busy && <p className="text-xs text-gray-600 pr-5">{notice}</p>}
      {noGmail && !busy && (
        <div className="pr-6">
          <p className="text-sm font-bold text-gray-800">
            {noGmail === 'expired' ? 'Gmail access has expired' : 'Connect Gmail to sync statements'}
          </p>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {noGmail === 'expired'
              ? "Google stopped accepting the app's access to your inbox (it lapses after a while, or was revoked). Connect again and the sync carries on from where it left off."
              : 'Read-only: the app looks for PhonePe, Paytm and Google Pay statement emails and imports their PDF, CSV or Excel files. The same connection as Credit Cards.'}
          </p>
          <button onClick={connectGmail} className="btn-primary text-sm mt-3">
            {noGmail === 'expired' ? 'Reconnect Gmail' : 'Connect Gmail'}
          </button>
        </div>
      )}
      {locked && !busy && (
        <form onSubmit={(e) => { e.preventDefault(); if (password) (fromMail ? mailSync(password, remember) : upload(file, password, remember)) }}>
          <div className="flex items-center gap-3 pr-6">
            <span className="flex-shrink-0 w-9 h-9 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
                <rect x="5" y="11" width="14" height="10" rx="2" />
                <path strokeLinecap="round" d="M8 11V7a4 4 0 018 0v4" />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-gray-800">Password needed</p>
              <p className="text-[11px] text-gray-500 truncate">
                {fromMail ? (mailLocked || []).map((x) => x.subject).join(' · ') || 'A statement in your mail' : file?.name}
              </p>
            </div>
          </div>

          <label htmlFor="statement-pdf-password" className="block text-[11px] font-semibold text-gray-600 mt-3 mb-1">
            Statement password
          </label>
          <div className="relative">
            <input
              id="statement-pdf-password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter the PDF's password"
              autoFocus
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              name="statement-pdf-password"
              className="input pr-16"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute inset-y-0 right-0 px-3 text-[11px] font-bold text-brand-600"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
          {error && <p className="text-xs text-red-600 mt-1.5">{error}</p>}
          <label className="flex items-start gap-2 mt-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-brand-400 flex-shrink-0"
            />
            <span className="text-xs text-gray-700">
              Remember this password
              <span className="block text-[11px] text-gray-400">
                {remember
                  ? 'Saved encrypted, so your next statement opens on its own. View, change or forget it from the Upload or Sync menu.'
                  : 'Only used to open this file - not saved.'}
              </span>
            </span>
          </label>
          <button type="submit" disabled={!password} className="btn-primary text-sm mt-3 disabled:opacity-50">
            Unlock & import
          </button>
        </form>
      )}
      {error && !busy && !locked && <p className="text-xs text-red-600 pr-5 mt-1">{error}</p>}
      {result?.mail && !busy && <MailSummary mail={result.mail} />}
      {result && !busy && (!result.mail || result.mail.imported.length > 0) && <StatementImportResult result={result} />}
      {!busy && activity?.log?.length > 1 && (result || error || locked) && (
        <details className="mt-2">
          <summary className="text-[11px] font-bold text-gray-500 cursor-pointer">
            What happened ({clock(activity.log[activity.log.length - 1].at - activity.log[0].at)})
          </summary>
          <ActivityLog activity={activity} />
        </details>
      )}
    </div>
  )

  return { busy, pick, mailSync, connectGmail, input, panel }
}
