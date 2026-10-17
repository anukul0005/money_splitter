import { useState } from 'react'
import { requestFullAccess, unlockFullAccess } from '../api'
import { useRefreshUser } from '../UserContext'

/**
 * "To unlock full access, request code from admin" - for anyone without
 * full access (see backend models.User.full_access). Deliberately never
 * says what full access unlocks.
 */
export default function UnlockAccess({ className = 'card' }) {
  const refreshUser = useRefreshUser()
  const [open, setOpen]         = useState(false)
  const [requested, setRequested] = useState(false)
  const [code, setCode]         = useState('')
  const [busy, setBusy]         = useState(false)
  const [error, setError]       = useState('')
  const [done, setDone]         = useState(false)

  const request = async () => {
    setError(''); setBusy(true)
    try {
      await requestFullAccess()
      setRequested(true)
    } catch (err) {
      setError(err.response?.data?.detail || "Couldn't send the request - try again.")
    } finally {
      setBusy(false)
    }
  }

  const unlock = async (e) => {
    e.preventDefault()
    if (code.length !== 6) return setError('Enter the 6-digit code.')
    setError(''); setBusy(true)
    try {
      await unlockFullAccess(code)
      setDone(true)
      await refreshUser()
    } catch (err) {
      setError(err.response?.data?.detail || "That code didn't work.")
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className={className}>
        <p className="text-sm font-bold text-green-700">✓ Full access unlocked</p>
      </div>
    )
  }

  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-gray-800">Full access</p>
          <p className="text-xs text-gray-500">To unlock full access, request a code from admin.</p>
        </div>
        {!open && (
          <button onClick={() => setOpen(true)} className="flex-shrink-0 text-xs font-bold text-brand-600 border border-amber-200 rounded-md px-3 py-1.5">
            Unlock
          </button>
        )}
      </div>

      {open && (
        <div className="mt-3 pt-3 border-t border-amber-100 space-y-3">
          <div>
            <p className="text-[11px] font-semibold text-gray-600">1. Ask the admin for a code</p>
            {requested ? (
              <p className="text-xs text-green-700 mt-1">✓ Request sent - the admin will send you a 6-digit code.</p>
            ) : (
              <button onClick={request} disabled={busy}
                className="mt-1 text-xs font-bold text-gray-700 bg-white border border-amber-300 rounded-md px-3 py-1.5 disabled:opacity-50">
                Request code from admin
              </button>
            )}
          </div>
          <form onSubmit={unlock}>
            <label htmlFor="full-access-code" className="block text-[11px] font-semibold text-gray-600 mb-1">
              2. Enter the code you received
            </label>
            <input
              id="full-access-code"
              className="input tracking-[0.3em] font-bold"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) => { setCode(e.target.value.replace(/\D/g, '')); setError('') }}
            />
            {error && <p className="text-xs text-red-600 mt-1.5">{error}</p>}
            <button type="submit" disabled={busy || code.length !== 6} className="btn-primary text-sm mt-2.5 disabled:opacity-50">
              {busy ? 'Checking…' : 'Unlock full access'}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
