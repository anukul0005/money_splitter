import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { changePassword, setRecovery, getRecoveryQuestion } from '../api'
import { useUser, isAdmin } from '../UserContext'

export const KEY_QUESTION = 'Enter your 6-digit recovery key'

export const RECOVERY_QUESTIONS = [
  KEY_QUESTION,
  'What was the name of your first school?',
  'What city were you born in?',
  "What is your oldest sibling's nickname?",
  'What was the name of your first pet?',
  'What is your favourite dish?',
]

/** Cryptographically random 6-digit key. */
export function generateKey() {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return String(buf[0] % 1000000).padStart(6, '0')
}

/**
 * /account — everything about your own login, in one place.
 *
 * Two independent things, deliberately kept as separate cards: your security
 * answer (how you get back in if you forget your password) and your password
 * itself. Proving identity for the first accepts either credential, so losing
 * one never locks you out of changing the other.
 */
export default function Account() {
  const nav  = useNavigate()
  const user = useUser()

  const [existing, setExisting] = useState(null)   // current question, or null

  // ── Security answer ──
  const [question, setQuestion] = useState(RECOVERY_QUESTIONS[0])
  const [answer, setAnswer]     = useState('')
  const [proofKind, setProof]   = useState('password')   // password | answer
  const [proof, setProofValue]  = useState('')
  const [secError, setSecError] = useState('')
  const [secDone, setSecDone]   = useState('')
  const [secBusy, setSecBusy]   = useState(false)

  // ── Password ──
  const [current, setCurrent]   = useState('')
  const [next, setNext]         = useState('')
  const [confirm, setConfirm]   = useState('')
  const [showPw, setShowPw]     = useState(false)
  const [pwError, setPwError]   = useState('')
  const [pwDone, setPwDone]     = useState('')
  const [pwBusy, setPwBusy]     = useState(false)

  useEffect(() => {
    if (!user?.name) return
    getRecoveryQuestion(user.name)
      .then((r) => {
        setExisting(r.data.has_recovery ? r.data.question : null)
        if (r.data.has_recovery) setQuestion(r.data.question)
      })
      .catch(() => setExisting(null))
  }, [user?.name])

  const handleSecurity = async (e) => {
    e.preventDefault()
    setSecError(''); setSecDone('')
    if (answer.trim().length < 3) return setSecError('Answer must be at least 3 characters.')
    if (!proof) return setSecError(proofKind === 'password' ? 'Enter your current password.' : 'Enter your current security answer.')
    setSecBusy(true)
    try {
      await setRecovery(user.id, {
        question,
        answer,
        ...(proofKind === 'password' ? { current_password: proof } : { current_answer: proof }),
      })
      setExisting(question)
      setSecDone('Saved. Keep your answer somewhere safe — it can never be shown to you again.')
      setProofValue('')
    } catch (err) {
      setSecError(err.response?.data?.detail || 'Could not save that.')
    } finally {
      setSecBusy(false)
    }
  }

  const handlePassword = async (e) => {
    e.preventDefault()
    setPwError(''); setPwDone('')
    if (!current || !next || !confirm) return setPwError('All fields are required.')
    if (next !== confirm) return setPwError('New passwords do not match.')
    if (next === current) return setPwError('New password must be different.')
    setPwBusy(true)
    try {
      await changePassword(user.id, { current_password: current, new_password: next })
      setPwDone('Password updated.')
      setCurrent(''); setNext(''); setConfirm('')
    } catch (err) {
      setPwError(err.response?.data?.detail || 'Failed to change password.')
    } finally {
      setPwBusy(false)
    }
  }

  return (
    <div className="pb-24 md:pb-8">
      <div className="bg-gradient-to-br from-field-800 to-field-950 text-white px-5 pt-10 md:pt-8 pb-6 md:rounded-b-3xl border-b border-field-700">
        <button onClick={() => nav('/')} className="text-xs font-bold text-white/50 mb-2">← Home</button>
        <h1 className="text-2xl font-bold tracking-tight capitalize">{user?.name}</h1>
        <p className="text-slate-300/40 text-xs mt-1 font-medium">
          {isAdmin(user) ? 'Administrator' : 'Account settings'}
        </p>
      </div>

      <div className="px-5 mt-5 space-y-4 max-w-lg">

        {/* ── Security question ── */}
        <div className="card">
          <h2 className="text-sm font-bold text-gray-800">Security question</h2>
          <p className="text-xs text-gray-500 leading-relaxed mt-1 mb-3">
            This is what lets you reset your own password if you forget it. Without
            one, you'd have to ask an admin for a one-time code.
          </p>

          <div
            className={`text-xs rounded-md px-3 py-2 mb-4 border ${
              existing
                ? 'bg-green-50 border-green-200 text-green-800'
                : 'bg-amber-50 border-amber-300 text-gray-600'
            }`}
          >
            {existing
              ? <>Currently set to: <span className="font-semibold">{existing}</span></>
              : 'Not set yet — set one now so you can recover your own account.'}
          </div>

          <form onSubmit={handleSecurity} className="space-y-3">
            <div>
              <label className="label">Question</label>
              <select className="input" value={question} onChange={(e) => setQuestion(e.target.value)}>
                {RECOVERY_QUESTIONS.map((q) => <option key={q} value={q}>{q}</option>)}
                {existing && !RECOVERY_QUESTIONS.includes(existing) && (
                  <option value={existing}>{existing}</option>
                )}
              </select>
            </div>

            <div>
              <label className="label">{existing ? 'New answer' : 'Your answer'}</label>
              <div className="flex gap-2">
                <input
                  className="input flex-1 tracking-widest font-bold"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => { setQuestion(KEY_QUESTION); setAnswer(generateKey()) }}
                  className="px-3 bg-amber-100 border border-amber-300 rounded-md text-[11px] font-bold text-gray-600 hover:bg-amber-200 flex-shrink-0"
                  title="Generate a random 6-digit passkey"
                >
                  Generate
                </button>
              </div>
              <p className="text-[10px] text-gray-400 mt-1 leading-relaxed">
                Write it down before saving — it's stored hashed, so nobody, including
                you, can read it back later. Capitalisation doesn't matter.
              </p>
            </div>

            {/* Either credential proves it's you */}
            <div className="border-t border-amber-200 pt-3">
              <label className="label">Confirm it's you</label>
              <div className="flex gap-1 mb-2 bg-amber-100 rounded-md p-1">
                {[['password', 'Current password'], ['answer', 'Current answer']].map(([v, l]) => (
                  <button
                    key={v}
                    type="button"
                    disabled={v === 'answer' && !existing}
                    onClick={() => { setProof(v); setProofValue(''); setSecError('') }}
                    className={`flex-1 py-1.5 text-[11px] font-bold rounded transition-colors disabled:opacity-40 ${
                      proofKind === v ? 'bg-cream text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {l}
                  </button>
                ))}
              </div>
              <input
                className="input"
                type={proofKind === 'password' ? 'password' : 'text'}
                placeholder={proofKind === 'password' ? 'Your current password' : 'Your current answer / passkey'}
                value={proof}
                onChange={(e) => setProofValue(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>

            {secError && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{secError}</p>}
            {secDone && <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">{secDone}</p>}

            <button type="submit" className="btn-primary" disabled={secBusy}>
              {secBusy ? 'Saving…' : existing ? 'Update answer' : 'Save answer'}
            </button>
          </form>
        </div>

        {/* ── Change password ── */}
        <div className="card">
          <h2 className="text-sm font-bold text-gray-800">Change password</h2>
          <p className="text-xs text-gray-500 leading-relaxed mt-1 mb-3">
            Requires the password you use today. Forgotten it? Sign out and use
            Forgot password with your security answer.
          </p>

          <form onSubmit={handlePassword} className="space-y-3">
            <div>
              <label className="label">Current password</label>
              <div className="relative">
                <input
                  className="input pr-14"
                  type={showPw ? 'text' : 'password'}
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
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
              <label className="label">New password</label>
              <input
                className="input"
                type={showPw ? 'text' : 'password'}
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoCapitalize="none"
              />
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

            {pwError && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{pwError}</p>}
            {pwDone && <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">{pwDone}</p>}

            <button type="submit" className="btn-primary" disabled={pwBusy}>
              {pwBusy ? 'Updating…' : 'Update password'}
            </button>
          </form>
        </div>

        {/* ── Admin tools ── */}
        {isAdmin(user) && (
          <div className="card">
            <h2 className="text-sm font-bold text-gray-800">Admin</h2>
            <p className="text-xs text-gray-500 leading-relaxed mt-1 mb-3">
              Issue a one-time code so a locked-out user can set a new password and
              their own security question.
            </p>
            <button
              onClick={() => nav('/admin/codes')}
              className="w-full py-2.5 text-xs font-bold text-gray-700 bg-amber-100 border border-amber-300 rounded-md hover:bg-amber-200 active:scale-[0.98] transition-all"
            >
              One-time codes →
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
