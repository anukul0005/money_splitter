import { useState } from 'react'
import { changePassword, setRecovery } from '../api'

const RECOVERY_QUESTIONS = [
  'What was the name of your first school?',
  'What city were you born in?',
  "What is your oldest sibling's nickname?",
  'What was the name of your first pet?',
  'What is your favourite dish?',
]

export default function ChangePasswordModal({ user, onClose }) {
  const [view, setView]         = useState('password')   // password | recovery
  const [current, setCurrent]   = useState('')
  const [next, setNext]         = useState('')
  const [confirm, setConfirm]   = useState('')
  const [showPw, setShowPw]     = useState(false)
  const [error, setError]       = useState('')
  const [success, setSuccess]   = useState(false)
  const [loading, setLoading]   = useState(false)

  // Recovery question — what makes self-serve reset possible later
  const [recQuestion, setRecQuestion] = useState(RECOVERY_QUESTIONS[0])
  const [recAnswer, setRecAnswer]     = useState('')

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

  const handleRecovery = async (e) => {
    e.preventDefault()
    setError('')
    if (!current) { setError('Enter your current password to confirm.'); return }
    if (recAnswer.trim().length < 3) { setError('Answer must be at least 3 characters.'); return }
    setLoading(true)
    try {
      await setRecovery(user.id, {
        current_password: current,
        question: recQuestion,
        answer: recAnswer,
      })
      setSuccess(true)
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to save recovery question.')
    } finally {
      setLoading(false)
    }
  }

  const switchView = (v) => { setView(v); setError(''); setSuccess(false) }

  return (
    <div
      className="fixed inset-0 bg-field-950/80 flex items-center justify-center z-50 px-5"
      onClick={onClose}
    >
      <div
        className="bg-cream border border-amber-100 shadow-2xl p-6 w-full max-w-xs"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-gray-800 tracking-wide">Account security</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
        </div>

        {/* Two jobs, one modal: change the password, or set the recovery
            question that makes a self-serve reset possible later. */}
        <div className="flex gap-1 mb-4 bg-amber-100 rounded-md p-1">
          {[['password', 'Password'], ['recovery', 'Recovery']].map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => switchView(v)}
              className={`flex-1 py-1.5 text-xs font-bold rounded transition-colors ${
                view === v ? 'bg-cream text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {success ? (
          <div className="text-center py-4">
            <p className="text-sm font-bold text-brand-600 mb-4">
              {view === 'recovery' ? 'Recovery question saved!' : 'Password updated successfully!'}
            </p>
            <button onClick={onClose} className="btn-primary">Done</button>
          </div>
        ) : view === 'recovery' ? (
          <form onSubmit={handleRecovery} className="space-y-3">
            <p className="text-xs text-gray-500 leading-relaxed">
              Set this once and you can reset your own password from the login screen —
              no need to ask an admin.
            </p>

            <div>
              <label className="label">Question</label>
              <select className="input" value={recQuestion} onChange={e => setRecQuestion(e.target.value)}>
                {RECOVERY_QUESTIONS.map(q => <option key={q} value={q}>{q}</option>)}
              </select>
            </div>

            <div>
              <label className="label">Your answer</label>
              <input
                className="input"
                value={recAnswer}
                onChange={e => setRecAnswer(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>

            <div>
              <label className="label">Current password (to confirm)</label>
              <input
                className="input"
                type="password"
                value={current}
                onChange={e => setCurrent(e.target.value)}
                autoCapitalize="none"
              />
            </div>

            {error && (
              <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>
            )}

            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Saving…' : 'Save recovery question'}
            </button>
          </form>
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
              <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>
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
