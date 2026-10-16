import { useEffect, useRef, useState } from 'react'
import { startImportJob, getImportJob, cancelImportJob, listStatementPasswords, forgetStatementPassword } from '../api'
import StatementImportResult from './StatementImportResult'

// The payment apps a statement can come from, and the file types each
// app's statement downloads as. The backend works the format out from the
// file itself - picking the app only narrows the file chooser.
const APPS = [
  { key: 'gpay',    label: 'Google Pay', hint: 'PDF statement',       accept: '.pdf,application/pdf' },
  { key: 'phonepe', label: 'PhonePe',    hint: 'CSV or PDF statement', accept: '.csv,text/csv,.pdf,application/pdf' },
  { key: 'paytm',   label: 'Paytm',      hint: 'Coming soon',          accept: null },
]
// For a single "upload a statement" button with no app picker.
export const ANY_STATEMENT = { key: 'any', label: 'statement', accept: '.csv,text/csv,.pdf,application/pdf' }

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
  const [saved, setSaved] = useState([])   // apps with a remembered password
  useEffect(() => {
    if (open) listStatementPasswords().then((r) => setSaved(r.data)).catch(() => setSaved([]))
  }, [open])
  const forget = async (app) => {
    if (!confirm(`Forget your saved ${app} statement password?`)) return
    await forgetStatementPassword(app).catch(() => {})
    setSaved((s) => s.filter((a) => a !== app))
  }
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
          <div role="menu" className="absolute right-0 mt-1 w-52 bg-white border border-amber-200 rounded-md shadow-lg z-30 py-1">
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
            {saved.length > 0 && (
              <div className="border-t border-amber-100 mt-1 pt-1.5 pb-1 px-3">
                <p className="text-[10px] font-black text-gray-400 tracking-widest">SAVED PASSWORDS</p>
                {saved.map((app) => (
                  <div key={app} className="flex items-center justify-between py-1">
                    <span className="text-xs text-gray-700">🔒 {app}</span>
                    <button onClick={() => forget(app)} className="text-[11px] font-bold text-red-600">Forget</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
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

  useEffect(() => () => clearTimeout(pollRef.current), [])
  const busy = progress !== null

  const reset = () => { setNotice(''); setError(''); setResult(null); setLocked(false); setPassword(''); setShowPassword(false) }

  const pick = (a) => {
    setApp(a); reset(); setFile(null)
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
    if (detail?.code === 'password_required' || detail?.code === 'password_wrong') {
      setLocked(true)
      setError(detail.code === 'password_wrong' ? detail.message : '')
    } else {
      setError((typeof detail === 'string' ? detail : detail?.message) || 'Could not import that file.')
    }
  }

  const poll = (jobId, misses = 0) => {
    pollRef.current = setTimeout(async () => {
      try {
        const { data } = await getImportJob(jobId)
        if (data.status === 'done') {
          finish(); setResult(data.result); setLocked(false); setPassword('')
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
    setFile(f); setError(''); setResult(null); setNotice('')
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

  const input = (
    <input ref={inputRef} type="file" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
  )

  const panel = (busy || error || result || locked || notice) && (
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
      {busy && <ProgressBar stage={progress.stage} fraction={progress.fraction} />}
      {busy && (
        <div className="flex items-center justify-between gap-3 mt-1.5">
          <p className="text-[11px] text-gray-400">Your {app?.label} statement - this can take a minute.</p>
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
      {locked && !busy && (
        <form onSubmit={(e) => { e.preventDefault(); if (password) upload(file, password, remember) }}>
          <div className="flex items-center gap-3 pr-6">
            <span className="flex-shrink-0 w-9 h-9 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
                <rect x="5" y="11" width="14" height="10" rx="2" />
                <path strokeLinecap="round" d="M8 11V7a4 4 0 018 0v4" />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-gray-800">Password needed</p>
              <p className="text-[11px] text-gray-500 truncate">{file?.name}</p>
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
                  ? 'Saved encrypted, so your next statement opens on its own. Forget it any time from the Upload menu.'
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
      {result && !busy && <StatementImportResult result={result} />}
    </div>
  )

  return { busy, pick, input, panel }
}
