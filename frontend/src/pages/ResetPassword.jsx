import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getRecoveryQuestion, resetPassword } from '../api'

/**
 * Standalone /reset-password route.
 *
 * Step 1 asks for the username and looks up that account's recovery question.
 * Step 2 takes the answer plus the new password. Accounts with no recovery
 * question set can't self-serve — there is nothing to check them against — so
 * they're pointed at the admin panel on this same page.
 */
export default function ResetPassword() {
  const nav = useNavigate()

  const [step, setStep]         = useState('lookup')   // lookup | answer | done
  const [username, setUsername] = useState('')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer]     = useState('')
  const [next, setNext]         = useState('')
  const [confirm, setConfirm]   = useState('')
  const [showPw, setShowPw]     = useState(false)
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [noRecovery, setNoRecovery] = useState(false)

  const handleLookup = async (e) => {
    e.preventDefault()
    setError('')
    setNoRecovery(false)
    if (!username.trim()) return setError('Enter your username.')
    setLoading(true)
    try {
      const r = await getRecoveryQuestion(username.trim())
      if (!r.data.has_recovery) {
        setNoRecovery(true)
      } else {
        setQuestion(r.data.question)
        setStep('answer')
      }
    } catch {
      setError('Could not reach the server. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleReset = async (e) => {
    e.preventDefault()
    setError('')
    if (!answer.trim()) return setError('Enter your answer.')
    if (next.length < 4) return setError('New password must be at least 4 characters.')
    if (next !== confirm) return setError('New passwords do not match.')
    setLoading(true)
    try {
      await resetPassword({ name: username.trim(), answer, new_password: next })
      setStep('done')
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not reset your password.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-field-900 flex flex-col items-center justify-center px-5 py-12">
      <div className="flex items-center justify-center gap-2.5 mb-6">
        <div className="w-9 h-9 bg-brand-400 rounded-lg flex items-center justify-center">
          <span className="text-white font-bold text-base">S</span>
        </div>
        <h1 className="text-3xl font-bold text-brand-400 tracking-tight">SplitEasy</h1>
      </div>

      <div className="bg-cream shadow-2xl w-full max-w-sm border border-amber-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-amber-200">
          <h2 className="text-sm font-bold text-gray-800">Reset your password</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            {step === 'done' ? 'All set' : 'Answer your recovery question to set a new one'}
          </p>
        </div>

        <div className="p-6">
          {/* ── Step 1: who are you ── */}
          {step === 'lookup' && (
            <form onSubmit={handleLookup} className="space-y-4">
              <div>
                <label className="label">Username</label>
                <input
                  className="input"
                  placeholder="Your username"
                  value={username}
                  onChange={(e) => { setUsername(e.target.value); setNoRecovery(false) }}
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>

              {error && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>
              )}

              {noRecovery && (
                <div className="text-xs bg-amber-50 border border-amber-300 rounded-md px-3 py-2.5 space-y-2">
                  <p className="text-gray-600 leading-relaxed">
                    This account has no security question set, so it can't be reset here.
                    Ask an admin to issue you one, or to set a new password for you.
                  </p>
                  <p className="text-gray-500 leading-relaxed">
                    Once you're back in, set your own from
                    <span className="font-semibold text-gray-700"> Account security → Recovery</span>.
                  </p>
                </div>
              )}

              <button type="submit" className="btn-primary" disabled={loading}>
                {loading ? 'Checking…' : 'Continue'}
              </button>
            </form>
          )}

          {/* ── Step 2: answer + new password ── */}
          {step === 'answer' && (
            <form onSubmit={handleReset} className="space-y-4">
              <div>
                <p className="label">Your recovery question</p>
                <p className="text-sm font-semibold text-gray-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2.5">
                  {question}
                </p>
              </div>

              <div>
                <label className="label">Your answer</label>
                <input
                  className="input"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <p className="text-[10px] text-gray-400 mt-1">Capitalisation and extra spaces don't matter.</p>
              </div>

              <div>
                <label className="label">New password</label>
                <div className="relative">
                  <input
                    className="input pr-16"
                    type={showPw ? 'text' : 'password'}
                    value={next}
                    onChange={(e) => setNext(e.target.value)}
                    autoCapitalize="none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold text-gray-400 hover:text-gray-600 tracking-widest"
                  >
                    {showPw ? 'HIDE' : 'SHOW'}
                  </button>
                </div>
              </div>

              <div>
                <label className="label">Confirm new password</label>
                <input
                  className="input"
                  type={showPw ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoCapitalize="none"
                />
              </div>

              {error && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>
              )}

              <button type="submit" className="btn-primary" disabled={loading}>
                {loading ? 'Resetting…' : 'Reset password'}
              </button>
              <button
                type="button"
                onClick={() => { setStep('lookup'); setError(''); setAnswer('') }}
                className="w-full text-[11px] font-semibold text-gray-400 hover:text-gray-600"
              >
                ← Use a different username
              </button>
            </form>
          )}

          {/* ── Done ── */}
          {step === 'done' && (
            <div className="text-center py-2">
              <p className="text-3xl mb-2">🔓</p>
              <p className="text-sm font-bold text-brand-600 mb-1">Password updated</p>
              <p className="text-xs text-gray-500 mb-5">You can log in with your new password now.</p>
              <button onClick={() => nav('/')} className="btn-primary">Back to login</button>
            </div>
          )}
        </div>

        {step !== 'done' && (
          <div className="border-t border-amber-200 px-6 py-3">
            <button
              onClick={() => nav('/')}
              className="text-[11px] font-semibold text-gray-400 hover:text-gray-600"
            >
              ← Back to login
            </button>
          </div>
        )}
      </div>

      <div className="w-full max-w-sm mt-4 text-center">
        <button
          onClick={() => nav('/admin-recovery')}
          className="text-[11px] font-semibold text-slate-300/50 hover:text-slate-100 py-2"
        >
          Admin? Reset a password or issue a security question
        </button>
      </div>

    </div>
  )
}
