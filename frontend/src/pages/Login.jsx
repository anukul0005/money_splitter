import { useState } from 'react'

const ADMIN_USERS = [
  { name: 'Anukul',  password: 'anuk25', isAdmin: true },
  { name: 'Anubhav', password: 'anub10', isAdmin: true },
]
const USERS_KEY   = 'splitter_users_v3'
const SESSION_KEY = 'splitter_session'

function getUsers() {
  try { return JSON.parse(localStorage.getItem(USERS_KEY) || '[]') } catch { return [] }
}

const FEATURES = [
  { icon: '💸', text: 'Track who paid what in groups' },
  { icon: '⚖️', text: 'Auto-calculate who owes whom' },
  { icon: '✅', text: 'Mark debts settled when paid' },
  { icon: '📊', text: 'View full spending history' },
]

export default function Login({ onLogin }) {
  const [mode, setMode]         = useState('login') // 'login' | 'signup'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [showPw, setShowPw]     = useState(false)
  const [error, setError]       = useState('')
  const [forgotOpen, setForgotOpen] = useState(false)

  const switchMode = (m) => {
    setMode(m); setError(''); setUsername(''); setPassword(''); setConfirmPw('')
  }

  const handleLogin = (e) => {
    e.preventDefault()
    setError('')
    if (!username.trim() || !password) { setError('Enter username and password.'); return }

    const admin = ADMIN_USERS.find(
      u => u.name.toLowerCase() === username.trim().toLowerCase() && u.password === password
    )
    if (admin) {
      const s = { name: admin.name, isAdmin: true }
      localStorage.setItem(SESSION_KEY, JSON.stringify(s))
      onLogin(s)
      return
    }

    const user = getUsers().find(
      u => u.name.toLowerCase() === username.trim().toLowerCase() && u.password === password
    )
    if (user) {
      const s = { name: user.name, isAdmin: false }
      localStorage.setItem(SESSION_KEY, JSON.stringify(s))
      onLogin(s)
      return
    }

    setError('Incorrect username or password.')
  }

  const handleSignup = (e) => {
    e.preventDefault()
    setError('')
    const name = username.trim()
    if (!name || !password) { setError('Please fill in all fields.'); return }
    if (password.length > 6) { setError('Password must be 6 characters or less.'); return }
    if (password !== confirmPw) { setError('Passwords do not match.'); return }

    const taken =
      ADMIN_USERS.some(u => u.name.toLowerCase() === name.toLowerCase()) ||
      getUsers().some(u => u.name.toLowerCase() === name.toLowerCase())
    if (taken) { setError('Username already taken. Please choose a different one.'); return }

    const users = getUsers()
    localStorage.setItem(USERS_KEY, JSON.stringify([...users, { name, password, isAdmin: false }]))
    const s = { name, isAdmin: false }
    localStorage.setItem(SESSION_KEY, JSON.stringify(s))
    onLogin(s)
  }

  return (
    <div className="min-h-screen bg-field-900 flex items-stretch">

      {/* ── Left branding panel (desktop only) ── */}
      <div className="hidden md:flex md:w-[46%] bg-field-950 flex-col justify-center px-14 py-16 relative overflow-hidden">
        <div className="absolute -top-24 -left-24 w-80 h-80 rounded-full bg-brand-600/10 pointer-events-none" />
        <div className="absolute -bottom-20 -right-20 w-64 h-64 rounded-full bg-brand-600/10 pointer-events-none" />

        <div className="relative z-10">
          {/* Logo */}
          <div className="flex items-center gap-3 mb-10">
            <div className="w-11 h-11 bg-brand-400 flex items-center justify-center shadow-lg shadow-brand-400/30">
              <span className="text-field-950 font-black text-xl">S</span>
            </div>
            <h1 className="text-3xl font-black text-brand-400 tracking-widest">SplitEasy</h1>
          </div>

          <p className="text-2xl font-black text-green-100/80 leading-tight mb-3">
            Split expenses.<br />Stay friends.
          </p>
          <p className="text-sm text-green-200/40 font-semibold mb-10 leading-relaxed">
            The simplest way to track shared expenses<br />and settle up with your group.
          </p>

          <div className="space-y-4">
            {FEATURES.map(({ icon, text }) => (
              <div key={text} className="flex items-center gap-3.5">
                <span className="text-xl w-7 flex-shrink-0">{icon}</span>
                <span className="text-green-100/55 text-sm font-semibold">{text}</span>
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
            <div className="w-9 h-9 bg-brand-400 flex items-center justify-center">
              <span className="text-field-950 font-black text-base">S</span>
            </div>
            <h1 className="text-3xl font-black text-brand-400 tracking-widest">SplitEasy</h1>
          </div>
          <p className="text-green-200/35 text-[10px] font-bold tracking-widest uppercase">
            Split expenses, stay friends
          </p>
        </div>

        {/* Auth card */}
        <div className="bg-cream shadow-2xl w-full max-w-sm border border-amber-100/50">

          {/* Tabs */}
          <div className="flex border-b border-amber-200">
            <button
              onClick={() => switchMode('login')}
              className={`flex-1 py-3.5 text-xs font-black tracking-widest transition-colors ${
                mode === 'login'
                  ? 'bg-brand-400 text-field-950'
                  : 'bg-cream text-gray-400 hover:text-gray-600'
              }`}
            >
              LOG IN
            </button>
            <button
              onClick={() => switchMode('signup')}
              className={`flex-1 py-3.5 text-xs font-black tracking-widest transition-colors border-l border-amber-200 ${
                mode === 'signup'
                  ? 'bg-brand-400 text-field-950'
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
                  <p className="text-xs text-red-500 bg-red-50 border border-red-100 px-3 py-2">
                    {error}
                  </p>
                )}

                <button type="submit" className="btn-primary">
                  LOG IN →
                </button>

                <div className="text-center pt-1">
                  <button
                    type="button"
                    onClick={() => setForgotOpen(true)}
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

                {error && (
                  <p className="text-xs text-red-500 bg-red-50 border border-red-100 px-3 py-2">
                    {error}
                  </p>
                )}

                <button type="submit" className="btn-primary">
                  CREATE ACCOUNT →
                </button>
              </form>
            )}
          </div>
        </div>

        {/* Footer hint */}
        <p className="mt-6 text-[10px] text-green-200/20 font-semibold tracking-widest text-center">
          SPLITEASY · SHARED EXPENSES MADE SIMPLE
        </p>
      </div>

      {/* ── Forgot password modal ── */}
      {forgotOpen && (
        <div
          className="fixed inset-0 bg-field-950/85 flex items-center justify-center z-50 px-5"
          onClick={() => setForgotOpen(false)}
        >
          <div
            className="bg-cream border border-amber-100 shadow-2xl p-6 max-w-xs w-full"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xl">🔑</span>
              <h3 className="text-sm font-black text-gray-800 tracking-wide">Forgot Password?</h3>
            </div>
            <p className="text-xs text-gray-500 leading-relaxed mb-5">
              Password resets are managed by the admins. Please contact{' '}
              <span className="font-black text-gray-700">Anukul</span> or{' '}
              <span className="font-black text-gray-700">Anubhav</span> to reset your account password.
            </p>
            <button
              onClick={() => setForgotOpen(false)}
              className="btn-primary"
            >
              GOT IT
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
