import { useState } from 'react'
import { setFullName } from '../api'
import { useRefreshUser, useUser } from '../UserContext'

/** Account: the person's full name, shown on their home page in place of
 *  the username (which stays the login and the name in every group). */
export default function FullNameCard() {
  const user = useUser()
  const refreshUser = useRefreshUser()
  const saved = user?.full_name || ''
  const [value, setValue] = useState(saved)
  const [busy, setBusy]   = useState(false)
  const [error, setError] = useState('')
  const [done, setDone]   = useState(false)
  const changed = value.trim().replace(/\s+/g, ' ') !== saved

  const save = async (e) => {
    e.preventDefault()
    setError(''); setDone(false); setBusy(true)
    try {
      await setFullName(value)
      await refreshUser()
      setDone(true)
    } catch (err) {
      setError(err.response?.data?.detail || "Couldn't save your name.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <label htmlFor="full-name" className="text-sm font-bold text-gray-800">Full name</label>
      <p className="text-xs text-gray-500 mt-0.5 mb-2.5">
        Shown on your home page. You still log in as <b>{user?.name}</b>.
      </p>
      <input
        id="full-name"
        className="input"
        placeholder="e.g. Ajay Kumar Singh"
        value={value}
        maxLength={60}
        autoComplete="name"
        autoCapitalize="words"
        onChange={(e) => { setValue(e.target.value); setDone(false); setError('') }}
      />
      {error && <p className="text-xs text-red-600 mt-1.5">{error}</p>}
      {done && !changed && <p className="text-xs text-green-700 mt-1.5">✓ Saved</p>}
      {changed && (
        <button type="submit" disabled={busy} className="btn-primary text-sm mt-2.5 disabled:opacity-50">
          {busy ? 'Saving…' : value.trim() ? 'Save name' : 'Remove name'}
        </button>
      )}
    </form>
  )
}
