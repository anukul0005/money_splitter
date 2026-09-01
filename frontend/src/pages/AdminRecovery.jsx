import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getRecoveryQuestion, adminResetPassword, adminSetRecovery, listUsersBasic,
} from '../api'
import { KEY_QUESTION, generateKey } from '../utils/security'


/**
 * /admin-recovery — an admin unlocks with their own recovery key, then can
 * reset anyone's password or issue them a security question.
 *
 * The admin's own key (not their password) is the gate, so an admin who has
 * forgotten their password can still get in here and fix it.
 */
export default function AdminRecovery() {
  const nav = useNavigate()

  const [adminName, setAdminName]   = useState('')
  const [adminAnswer, setAdminKey]  = useState('')
  const [unlocked, setUnlocked]     = useState(false)
  const [question, setQuestion]     = useState('')
  const [error, setError]           = useState('')
  const [loading, setLoading]       = useState(false)
  const [users, setUsers]           = useState([])

  const [tab, setTab] = useState('password')   // password | question

  // Reset someone's password
  const [target, setTarget]         = useState('')
  const [newPw, setNewPw]           = useState('')

  // Issue someone a security question
  const [qTarget, setQTarget]       = useState('')
  const [qText, setQText]           = useState(KEY_QUESTION)
  const [qAnswer, setQAnswer]       = useState('')

  const [busy, setBusy]             = useState(false)
  const [done, setDone]             = useState('')

  useEffect(() => {
    if (!unlocked) return
    listUsersBasic().then((r) => setUsers(r.data)).catch(() => setUsers([]))
  }, [unlocked])

  // Show the admin their own question once they've typed a name
  const lookup = async (name) => {
    setQuestion('')
    if (!name.trim()) return
    try {
      const r = await getRecoveryQuestion(name.trim())
      setQuestion(r.data.has_recovery ? r.data.question : '')
    } catch { /* leave blank */ }
  }

  // "Unlock" is proven by the first real call — we verify with a harmless
  // no-op reset of the admin's own recovery question to the same values? No:
  // instead we simply move to the panel and let the server reject a bad key
  // on the actual action, so a wrong key can never look like success.
  const handleUnlock = (e) => {
    e.preventDefault()
    setError('')
    if (!adminName.trim()) return setError('Enter your admin username.')
    if (!adminAnswer.trim()) return setError('Enter your recovery answer.')
    setUnlocked(true)
    setTarget(adminName.trim())
    setQTarget('')
  }

  const handleResetPassword = async (e) => {
    e.preventDefault()
    setError(''); setDone('')
    if (!target.trim()) return setError('Pick whose password to reset.')
    if (newPw.length < 4) return setError('New password must be at least 4 characters.')
    setBusy(true)
    try {
      await adminResetPassword({
        admin_name: adminName.trim(),
        admin_answer: adminAnswer,
        target_name: target.trim(),
        new_password: newPw,
      })
      setDone(`Password updated for ${target.trim()}.`)
      setNewPw('')
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not reset that password.')
    } finally {
      setBusy(false)
    }
  }

  const handleSetQuestion = async (e) => {
    e.preventDefault()
    setError(''); setDone('')
    if (!qTarget.trim()) return setError('Pick who this security question is for.')
    if (qAnswer.trim().length < 3) return setError('Answer must be at least 3 characters.')
    setBusy(true)
    try {
      await adminSetRecovery({
        admin_name: adminName.trim(),
        admin_answer: adminAnswer,
        target_name: qTarget.trim(),
        question: qText,
        answer: qAnswer,
      })
      setDone(`Security question set for ${qTarget.trim()}. Give them the answer below — it can't be read back later.`)
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not set that security question.')
    } finally {
      setBusy(false)
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
          <h2 className="text-sm font-bold text-gray-800">Admin recovery</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            {unlocked ? `Signed in as ${adminName}` : 'Unlock with your own recovery answer'}
          </p>
        </div>

        <div className="p-6">
          {!unlocked ? (
            <form onSubmit={handleUnlock} className="space-y-4">
              <div>
                <label className="label">Admin username</label>
                <input
                  className="input"
                  placeholder="Anukul or Anubhav"
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                  onBlur={(e) => lookup(e.target.value)}
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {question && (
                  <p className="text-[11px] text-gray-500 mt-1">{question}</p>
                )}
              </div>

              {/* An admin whose recovery is an ordinary question, not a passkey,
                  could never type their answer here: the field stripped every
                  non-digit and capped at six characters. */}
              <div>
                <label className="label">
                  {question && question !== KEY_QUESTION ? question : 'Your 6-digit recovery key'}
                </label>
                <input
                  className={question && question !== KEY_QUESTION ? 'input' : 'input tracking-[0.3em] font-bold'}
                  inputMode={question && question !== KEY_QUESTION ? 'text' : 'numeric'}
                  maxLength={question && question !== KEY_QUESTION ? 100 : 6}
                  placeholder={question && question !== KEY_QUESTION ? 'Your answer' : '000000'}
                  value={adminAnswer}
                  onChange={(e) =>
                    setAdminKey(
                      question && question !== KEY_QUESTION
                        ? e.target.value
                        : e.target.value.replace(/\D/g, '')
                    )
                  }
                />
              </div>

              {error && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>
              )}

              <button type="submit" className="btn-primary">Continue</button>
            </form>
          ) : (
            <>
              <div className="flex gap-1 mb-4 bg-amber-100 rounded-md p-1">
                {[['password', 'Reset password'], ['question', 'Security question']].map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => { setTab(v); setError(''); setDone('') }}
                    className={`flex-1 py-1.5 text-[11px] font-bold rounded transition-colors ${
                      tab === v ? 'bg-cream text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {tab === 'password' ? (
                <form onSubmit={handleResetPassword} className="space-y-3">
                  <p className="text-xs text-gray-500 leading-relaxed">
                    Set a new password for anyone — including yourself.
                  </p>
                  <div>
                    <label className="label">Reset password for</label>
                    <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
                      <option value="">Select a user…</option>
                      {users.map((u) => <option key={u.id} value={u.name}>{u.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">New password</label>
                    <input
                      className="input"
                      value={newPw}
                      onChange={(e) => setNewPw(e.target.value)}
                      autoCapitalize="none"
                    />
                  </div>

                  {error && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>}
                  {done && <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">{done}</p>}

                  <button type="submit" className="btn-primary" disabled={busy}>
                    {busy ? 'Saving…' : 'Reset password'}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleSetQuestion} className="space-y-3">
                  <p className="text-xs text-gray-500 leading-relaxed">
                    Issue a security question so they can reset their own password from
                    the login screen.
                  </p>
                  <div>
                    <label className="label">Security question for</label>
                    <select className="input" value={qTarget} onChange={(e) => setQTarget(e.target.value)}>
                      <option value="">Select a user…</option>
                      {users.map((u) => <option key={u.id} value={u.name}>{u.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">Question</label>
                    <input className="input" value={qText} onChange={(e) => setQText(e.target.value)} />
                  </div>
                  <div>
                    <label className="label">Answer / key</label>
                    <div className="flex gap-2">
                      <input
                        className="input flex-1 tracking-widest font-bold"
                        value={qAnswer}
                        onChange={(e) => setQAnswer(e.target.value)}
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        onClick={() => { setQAnswer(generateKey()); setQText(KEY_QUESTION) }}
                        className="px-3 bg-amber-100 border border-amber-300 rounded-md text-[11px] font-bold text-gray-600 hover:bg-amber-200 flex-shrink-0"
                      >
                        Generate
                      </button>
                    </div>
                    <p className="text-[10px] text-gray-400 mt-1">
                      Save this before submitting — it's stored hashed and can't be shown again.
                    </p>
                  </div>

                  {error && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>}
                  {done && <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">{done}</p>}

                  <button type="submit" className="btn-primary" disabled={busy}>
                    {busy ? 'Saving…' : 'Set security question'}
                  </button>
                </form>
              )}
            </>
          )}
        </div>

        <div className="border-t border-amber-200 px-6 py-3 flex items-center justify-between">
          <button onClick={() => nav('/')} className="text-[11px] font-semibold text-gray-400 hover:text-gray-600">
            ← Back to login
          </button>
          {unlocked && (
            <button
              onClick={() => { setUnlocked(false); setAdminKey(''); setError(''); setDone('') }}
              className="text-[11px] font-semibold text-gray-400 hover:text-gray-600"
            >
              Lock
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
