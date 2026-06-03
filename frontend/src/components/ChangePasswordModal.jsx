import { useState } from 'react'
import { changePassword } from '../api'

export default function ChangePasswordModal({ user, onClose }) {
  const [current, setCurrent]   = useState('')
  const [next, setNext]         = useState('')
  const [confirm, setConfirm]   = useState('')
  const [showPw, setShowPw]     = useState(false)
  const [error, setError]       = useState('')
  const [success, setSuccess]   = useState(false)
  const [loading, setLoading]   = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (!current || !next || !confirm) { setError('All fields are required.'); return }
    if (next !== confirm) { setError('New passwords do not match.'); return }
    if (next === current) { setError('New password must be different.'); return }
    setLoading(true)
    try {
      await changePassword(user.id, { current_password: current, new_password: next })
      setSuccess(true)
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to change password.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-field-950/80 flex items-center justify-center z-50 px-5"
      onClick={onClose}
    >
      <div
        className="bg-cream border border-amber-100 shadow-2xl p-6 w-full max-w-xs"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-black text-gray-800 tracking-wide">Change Password</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
        </div>

        {success ? (
          <div className="text-center py-4">
            <p className="text-sm font-bold text-brand-600 mb-4">Password updated successfully!</p>
            <button onClick={onClose} className="btn-primary">Done</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="label">Current password</label>
              <div className="relative">
                <input
                  className="input pr-14"
                  type={showPw ? 'text' : 'password'}
                  value={current}
                  onChange={e => setCurrent(e.target.value)}
                  autoFocus
                  autoCapitalize="none"
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-black text-gray-400 hover:text-gray-600 tracking-widest"
                >
                  {showPw ? 'HIDE' : 'SHOW'}
                </button>
              </div>
            </div>

            <div>
              <label className="label">New password</label>
              <input
                className="input"
                type={showPw ? 'text' : 'password'}
                value={next}
                onChange={e => setNext(e.target.value)}
                autoCapitalize="none"
              />
            </div>

            <div>
              <label className="label">Confirm new password</label>
              <input
                className="input"
                type={showPw ? 'text' : 'password'}
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                autoCapitalize="none"
              />
            </div>

            {error && (
              <p className="text-xs text-red-500 bg-red-50 border border-red-100 px-3 py-2">{error}</p>
            )}

            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'UPDATING...' : 'UPDATE PASSWORD →'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
