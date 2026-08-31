import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getRecoveryQuestion, resetPassword, adminResetPassword } from '../api'

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

  // Admin fallback
  const [adminOpen, setAdminOpen] = useState(false)
  const [adminForm, setAdminForm] = useState({
    admin_name: '', admin_password: '', target_name: '', new_password: '',
  })
  const [adminError, setAdminError]     = useState('')
  const [adminLoading, setAdminLoading] = useState(false)
  const [adminDone, setAdminDone]       = useState('')

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
        setAdminForm((f) => ({ ...f, target_name: username.trim() }))
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

  const handleAdminReset = async (e) => {
    e.preventDefault()
    setAdminError('')
    setAdminDone('')
    const f = adminForm
    if (!f.admin_name || !f.admin_password || !f.target_name || !f.new_password) {
      return setAdminError('All fields are required.')
    }
    if (f.new_password.length < 4) return setAdminError('New password must be at least 4 characters.')
    setAdminLoading(true)
    try {
      await adminResetPassword(f)
      setAdminDone(`Password reset for ${f.target_name}. Share it with them and ask them to set a recovery question.`)
      setAdminForm((x) => ({ ...x, admin_password: '', new_password: '' }))
    } catch (err) {
      setAdminError(err.response?.data?.detail || 'Could not reset that password.')
    } finally {
      setAdminLoading(false)
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
                    This account has no recovery question set, so it can't be reset here.
                    An admin can set a new password for you below.
                  </p>
                  <p className="text-gray-500 leading-relaxed">
                    Once you're back in, set a recovery question from
                    <span className="font-semibold text-gray-700"> Account → Change password</span> so
                    next time you can do this yourself.
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

      {/* ── Admin fallback ── */}
      <div className="w-full max-w-sm mt-4">
        <button
          onClick={() => setAdminOpen((v) => !v)}
          className="w-full text-center text-[11px] font-semibold text-slate-300/50 hover:text-slate-100 py-2"
        >
          {adminOpen ? 'Hide admin reset' : "Admin? Reset someone else's password"}
        </button>

        {adminOpen && (
          <form
            onSubmit={handleAdminReset}
            className="bg-cream border border-amber-200 rounded-xl shadow-xl p-5 space-y-3 mt-1"
          >
            <p className="text-xs text-gray-500 leading-relaxed">
              For users who never set a recovery question. Confirm with your own admin login.
            </p>

            <div>
              <label className="label">Your admin username</label>
              <input
                className="input"
                value={adminForm.admin_name}
                onChange={(e) => setAdminForm((f) => ({ ...f, admin_name: e.target.value }))}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            <div>
              <label className="label">Your admin password</label>
              <input
                className="input"
                type="password"
                value={adminForm.admin_password}
                onChange={(e) => setAdminForm((f) => ({ ...f, admin_password: e.target.value }))}
                autoCapitalize="none"
              />
            </div>
            <div>
              <label className="label">Reset password for</label>
              <input
                className="input"
                placeholder="Their username"
                value={adminForm.target_name}
                onChange={(e) => setAdminForm((f) => ({ ...f, target_name: e.target.value }))}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            <div>
              <label className="label">Their new password</label>
              <input
                className="input"
                value={adminForm.new_password}
                onChange={(e) => setAdminForm((f) => ({ ...f, new_password: e.target.value }))}
                autoCapitalize="none"
              />
            </div>

            {adminError && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{adminError}</p>
            )}
            {adminDone && (
              <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">{adminDone}</p>
            )}

            <button type="submit" className="btn-primary" disabled={adminLoading}>
              {adminLoading ? 'Resetting…' : 'Reset their password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
