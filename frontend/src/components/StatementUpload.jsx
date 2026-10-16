import { useRef, useState } from 'react'
import { importStatement } from '../api'
import StatementImportResult from './StatementImportResult'

// The payment apps a statement can come from, and the file types each
// app's statement downloads as. The backend works the format out from the
// file itself - picking the app only narrows the file chooser.
const APPS = [
  { key: 'gpay',    label: 'Google Pay', hint: 'PDF statement',       accept: '.pdf,application/pdf' },
  { key: 'phonepe', label: 'PhonePe',    hint: 'CSV or PDF statement', accept: '.csv,text/csv,.pdf,application/pdf' },
  { key: 'paytm',   label: 'Paytm',      hint: 'Coming soon',          accept: null },
]

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
  const [open, setOpen] = useState(false)
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
          </div>
        </>
      )}
    </div>
  )
}

/** State and file input behind StatementUploadButton, plus the result panel.
 * `onImported` runs after a successful import so the page can reload. */
export function useStatementUpload(onImported) {
  const inputRef = useRef(null)
  const [app, setApp]       = useState(null)
  const [busy, setBusy]     = useState(false)
  const [error, setError]   = useState('')
  const [result, setResult] = useState(null)

  const pick = (a) => {
    setApp(a)
    setError(''); setResult(null)
    // The input's accept list has to be in place before the chooser opens.
    if (inputRef.current) {
      inputRef.current.accept = a.accept
      inputRef.current.click()
    }
  }

  const upload = async (file) => {
    if (!file) return
    setBusy(true); setError(''); setResult(null)
    try {
      const r = await importStatement(file)
      setResult(r.data)
      onImported?.()
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not import that file.')
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const input = (
    <input ref={inputRef} type="file" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
  )

  const panel = (busy || error || result) && (
    <div className="mx-5 mt-3 card px-4 py-3 relative">
      {!busy && (
        <button
          onClick={() => { setError(''); setResult(null) }}
          className="absolute top-2 right-3 text-gray-400 hover:text-gray-600 text-sm"
          aria-label="Close"
        >
          ✕
        </button>
      )}
      {busy && <p className="text-xs text-gray-500">Importing your {app?.label} statement… this can take a minute.</p>}
      {error && <p className="text-xs text-red-600 pr-5">{error}</p>}
      {result && !busy && <StatementImportResult result={result} />}
    </div>
  )

  return { busy, pick, input, panel }
}
