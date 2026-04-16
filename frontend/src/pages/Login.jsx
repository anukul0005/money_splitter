import { useState } from 'react'

const USERS_KEY   = 'splitter_users'
const SESSION_KEY = 'splitter_session'

/** Key = first-4-chars-of-name (lowercase) + total-char-length, spaces stripped */
function deriveKey(name) {
  const clean = name.trim().toLowerCase().replace(/\s+/g, '')
  if (!clean) return ''
  return clean.slice(0, 4) + clean.length
}

export default function Login({ onLogin }) {
  const [mode, setMode]             = useState('login') // 'login' | 'create'
  const [keyInput, setKeyInput]     = useState('')
  const [nameInput, setNameInput]   = useState('')
  const [generatedKey, setGenKey]   = useState('')
  const [error, setError]           = useState('')

  /* ── Login ── */
  const handleLogin = () => {
    setError('')
    const users = JSON.parse(localStorage.getItem(USERS_KEY) || '[]')
    const user  = users.find((u) => u.key === keyInput.trim().toLowerCase())
    if (!user) {
      setError('Invalid key. Check your key or create a new user.')
      return
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify(user))
    onLogin(user)
  }

  /* ── Create: step 1 – generate key ── */
  const handleGenerate = () => {
    setError('')
    const key = deriveKey(nameInput)
    if (!key) { setError('Enter a name first'); return }
    setGenKey(key)
  }

  /* ── Create: step 2 – save & enter ── */
  const handleSaveAndEnter = () => {
    const users = JSON.parse(localStorage.getItem(USERS_KEY) || '[]')
    const name  = nameInput.trim()
    const user  = { name, key: generatedKey }
    if (!users.find((u) => u.key === generatedKey)) {
      localStorage.setItem(USERS_KEY, JSON.stringify([...users, user]))
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify(user))
    onLogin(user)
  }

  const switchMode = (m) => {
    setMode(m)
    setError('')
    setKeyInput('')
    setNameInput('')
    setGenKey('')
  }

  return (
    <div className="min-h-screen bg-field-900 flex flex-col items-center justify-center px-5">
      {/* App title */}
      <div className="mb-8 text-center">
        <h1 className="text-4xl font-black text-brand-400 tracking-widest">SplitEasy</h1>
        <p className="text-green-200/40 text-xs font-semibold mt-1 tracking-widest">Split expenses, stay friends</p>
      </div>

      {/* Card */}
      <div className="bg-cream border border-amber-100/60 shadow-xl p-6 w-full max-w-sm">
        {/* Mode tabs */}
        <div className="flex mb-6 border border-amber-200">
          <button
            onClick={() => switchMode('login')}
            className={`flex-1 py-2.5 text-xs font-bold tracking-widest transition-colors ${
              mode === 'login' ? 'bg-brand-400 text-gray-900' : 'bg-cream text-gray-400 hover:text-gray-700'
            }`}
          >
            Enter Key
          </button>
          <button
            onClick={() => switchMode('create')}
            className={`flex-1 py-2.5 text-xs font-bold tracking-widest transition-colors border-l border-amber-200 ${
              mode === 'create' ? 'bg-brand-400 text-gray-900' : 'bg-cream text-gray-400 hover:text-gray-700'
            }`}
          >
            Create User
          </button>
        </div>

        {mode === 'login' ? (
          <div className="space-y-4">
            <div>
              <label className="label">Your key</label>
              <input
                className="input"
                placeholder="e.g. anuk6"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            {error && <p className="text-xs text-red-500 bg-red-50 border border-red-100 px-3 py-2">{error}</p>}
            <button className="btn-primary" onClick={handleLogin}>
              Enter App
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="label">Your name</label>
              <input
                className="input"
                placeholder="e.g. Anukul"
                value={nameInput}
                onChange={(e) => { setNameInput(e.target.value); setGenKey('') }}
                onKeyDown={(e) => e.key === 'Enter' && !generatedKey && handleGenerate()}
                autoFocus
                autoCapitalize="words"
              />
            </div>

            {!generatedKey ? (
              <button className="btn-primary" onClick={handleGenerate}>
                Generate My Key
              </button>
            ) : (
              <>
                <div className="bg-field-950 border border-field-700 px-4 py-3 text-center">
                  <p className="text-xs text-green-200/50 font-semibold mb-1 tracking-widest">Your key</p>
                  <p className="text-3xl font-black text-brand-400 tracking-widest">{generatedKey}</p>
                  <p className="text-xs text-green-200/30 mt-1">Save this — you'll need it to log in</p>
                </div>
                <button className="btn-primary" onClick={handleSaveAndEnter}>
                  Save & Enter App
                </button>
              </>
            )}

            {error && <p className="text-xs text-red-500 bg-red-50 border border-red-100 px-3 py-2">{error}</p>}

            <p className="text-center text-xs text-gray-400 leading-relaxed">
              Key formula: first 4 letters of name + name length<br />
              <span className="text-brand-600 font-semibold">Anukul → anuk6 &nbsp;·&nbsp; Anubhav → anub7</span>
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
