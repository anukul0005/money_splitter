import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { loginUser, signupUser } from '../api'
import { RECOVERY_QUESTIONS } from '../utils/security'

const SESSION_KEY = 'splitter_session_v2'

const FEATURES = [
  { icon: '💸', text: 'Track who paid what in groups' },
  { icon: '⚖️', text: 'Auto-calculate who owes whom' },
  { icon: '✅', text: 'Record payments to settle up' },
  { icon: '📊', text: 'View full spending history' },
]

export default function Login({ onLogin }) {
  const nav = useNavigate()
  const [mode, setMode]         = useState('login') // 'login' | 'signup'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [showPw, setShowPw]     = useState(false)
  // Recovery question captured at signup so the user can reset without an admin
  const [recQuestion, setRecQuestion] = useState(RECOVERY_QUESTIONS[0])
  const [recAnswer, setRecAnswer]     = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)

  const switchMode = (m) => {
    setMode(m); setError(''); setUsername(''); setPassword(''); setConfirmPw(''); setRecAnswer('')
  }

  const handleLogin = async (e) => {
    e.preventDefault()
    setError('')
    if (!username.trim() || !password) { setError('Enter username and password.'); return }
    setLoading(true)
    try {
      const res = await loginUser({ name: username.trim(), password })
      const u = res.data
      // The token is what every later request is authorised with
      const s = { name: u.name, isAdmin: u.is_admin, id: u.id, token: u.token }
      localStorage.setItem(SESSION_KEY, JSON.stringify(s))
      onLogin(s)
      window.location.reload()
    } catch (err) {
      setError(err.response?.data?.detail || 'Incorrect username or password.')
    } finally {
      setLoading(false)
    }
  }

  const handleSignup = async (e) => {
    e.preventDefault()
    setError('')
    const name = username.trim()
    if (!name || !password) { setError('Please fill in all fields.'); return }
    if (password !== confirmPw) { setError('Passwords do not match.'); return }
    if (recAnswer.trim().length < 3) {
      setError('Set a recovery answer (3+ characters) so you can reset your own password later.')
      return
    }
    setLoading(true)
    try {
      const res = await signupUser({
        name, password,
        recovery_question: recQuestion,
        recovery_answer: recAnswer,
      })
      const u = res.data
      // Signup doesn't issue a token, so sign in straight away to get one
      const li = await loginUser({ name, password })
      const s = { name: u.name, isAdmin: u.is_admin, id: u.id, token: li.data.token }
      localStorage.setItem(SESSION_KEY, JSON.stringify(s))
      onLogin(s)
      window.location.reload()
    } catch (err) {
      const detail = err.response?.data?.detail || 'Signup failed.'
      setError(detail === 'Username already taken' ? 'Username already taken. Please choose a different one.' : detail)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-field-900 flex items-stretch">

      {/* ── Left branding panel (desktop only) ── */}
      <div className="hidden md:flex md:w-[46%] bg-field-950 flex-col justify-center px-14 py-16 relative overflow-hidden">
        <div className="absolute -top-24 -left-24 w-80 h-80 rounded-full bg-brand-600/10 pointer-events-none" />
        <div className="absolute -bottom-20 -right-20 w-64 h-64 rounded-full bg-brand-600/10 pointer-events-none" />

        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-10">
            <div className="w-11 h-11 bg-brand-400 rounded-lg flex items-center justify-center shadow-lg shadow-brand-400/30">
              <span className="text-white font-bold text-xl">S</span>
            </div>
            <h1 className="text-3xl font-bold text-brand-400 tracking-tight">SplitEasy</h1>
          </div>

          <p className="text-2xl font-black text-slate-100/80 leading-tight mb-3">
            Split expenses.<br />Stay friends.
          </p>
          <p className="text-sm text-slate-300/40 font-semibold mb-10 leading-relaxed">
            The simplest way to track shared expenses<br />and settle up with your group.
          </p>

          <div className="space-y-4">
            {FEATURES.map(({ icon, text }) => (
              <div key={text} className="flex items-center gap-3.5">
                <span className="text-xl w-7 flex-shrink-0">{icon}</span>
                <span className="text-slate-100/55 text-sm font-semibold">{text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Right auth panel ── */}
      <div className="flex-1 flex flex-col items-center justify-center px-5 py-12">

        {/* Mobile logo */}
        <div className="md:hidden mb-8 text-center">
          <div className="flex items-center justify-center gap-2.5 mb-2">
            <div className="w-9 h-9 bg-brand-400 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-base">S</span>
            </div>
            <h1 className="text-3xl font-bold text-brand-400 tracking-tight">SplitEasy</h1>
          </div>
          <p className="text-slate-300/35 text-[10px] font-bold tracking-widest uppercase">
            Split expenses, stay friends
          </p>
        </div>

        {/* Auth card */}
        <div className="bg-cream shadow-2xl w-full max-w-sm border border-amber-200 rounded-xl overflow-hidden">

          {/* Tabs */}
          <div className="flex border-b border-amber-200">
            <button
              onClick={() => switchMode('login')}
              className={`flex-1 py-3.5 rounded-none text-xs font-bold tracking-widest transition-colors ${
                mode === 'login'
                  ? 'bg-brand-400 text-white'
                  : 'bg-cream text-gray-400 hover:text-gray-600'
              }`}
            >
              LOG IN
            </button>
            <button
              onClick={() => switchMode('signup')}
              className={`flex-1 py-3.5 rounded-none text-xs font-bold tracking-widest transition-colors border-l border-amber-200 ${
                mode === 'signup'
                  ? 'bg-brand-400 text-white'
                  : 'bg-cream text-gray-400 hover:text-gray-600'
              }`}
            >
              SIGN UP
            </button>
          </div>

          <div className="p-6">
            {mode === 'login' ? (
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="label">Username</label>
                  <input
                    className="input"
                    placeholder="Your username"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>

                <div>
                  <label className="label">Password</label>
                  <div className="relative">
                    <input
                      className="input pr-16"
                      type={showPw ? 'text' : 'password'}
                      placeholder="Your password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
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

                {error && (
                  <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-md px-3 py-2">
                    {error}
                  </p>
                )}

                <button type="submit" className="btn-primary" disabled={loading}>
                  {loading ? 'LOGGING IN...' : 'LOG IN →'}
                </button>

                <div className="text-center pt-1">
                  <button
                    type="button"
                    onClick={() => nav('/reset-password')}
                    className="text-[11px] font-bold text-brand-600 hover:text-brand-700 tracking-wide underline-offset-2 hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
              </form>

            ) : (
              <form onSubmit={handleSignup} className="space-y-4">
                <div>
                  <label className="label">Choose a username</label>
                  <input
                    className="input"
                    placeholder="e.g. Priya"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    autoFocus
                    autoCapitalize="words"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>

                <div>
                  <label className="label">
                    Password{' '}
                    <span className="text-gray-400 font-normal normal-case tracking-normal">
                      (max 6 characters)
                    </span>
                  </label>
                  <div className="relative">
                    <input
                      className="input pr-16"
                      type={showPw ? 'text' : 'password'}
                      placeholder="Up to 6 characters"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      maxLength={6}
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
                  {password.length > 0 && (
                    <p className={`text-[10px] mt-1 font-bold ${password.length <= 6 ? 'text-brand-600' : 'text-red-500'}`}>
                      {password.length}/6 characters
                    </p>
                  )}
                </div>

                <div>
                  <label className="label">Confirm password</label>
                  <input
                    className="input"
                    type={showPw ? 'text' : 'password'}
                    placeholder="Repeat your password"
                    value={confirmPw}
                    onChange={e => setConfirmPw(e.target.value)}
                    maxLength={6}
                    autoCapitalize="none"
                  />
                </div>

                {/* Recovery question — the only way to reset without an admin */}
                <div className="border-t border-amber-200 pt-4">
                  <label className="label">Recovery question</label>
                  <select
                    className="input"
                    value={recQuestion}
                    onChange={e => setRecQuestion(e.target.value)}
                  >
                    {RECOVERY_QUESTIONS.map(q => <option key={q} value={q}>{q}</option>)}
                  </select>
                  <input
                    className="input mt-2"
                    placeholder="Type your answer"
                    value={recAnswer}
                    onChange={e => setRecAnswer(e.target.value)}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <p className="text-[10px] text-gray-400 mt-1 leading-relaxed">
                    Lets you reset your own password if you forget it. Capitalisation doesn't matter.
                  </p>
                </div>

                {error && (
                  <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-md px-3 py-2">
                    {error}
                  </p>
                )}

                <button type="submit" className="btn-primary" disabled={loading}>
                  {loading ? 'CREATING...' : 'CREATE ACCOUNT →'}
                </button>
              </form>
            )}
          </div>
        </div>

        {/* Footer hint */}
        <p className="mt-6 text-[10px] text-slate-300/20 font-semibold tracking-widest text-center">
          SPLITEASY · SHARED EXPENSES MADE SIMPLE
        </p>
      </div>

    </div>
  )
}
