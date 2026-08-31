import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminIssueCode, listUsersBasic, getRecoveryQuestion } from '../api'
import { useUser, isAdmin } from '../UserContext'

/**
 * Admin-only: mint a one-time 6-digit code for another user.
 *
 * The admin authorises with their own 6-digit passkey. The code lets that user
 * set a new password AND their own security question, after which they never
 * need an admin again. Codes last 24 hours and are single-use.
 *
 * Route is registered only when the logged-in user is an admin, so a common
 * user has nothing to navigate to.
 */
export default function AdminCodes() {
  const nav  = useNavigate()
  const user = useUser()

  const [users, setUsers]     = useState([])
  const [target, setTarget]   = useState('')
  const [passkey, setPasskey] = useState('')
  const [issued, setIssued]   = useState(null)   // { target, code, expires_in_hours }
  const [error, setError]     = useState('')
  const [busy, setBusy]       = useState(false)
  const [needs, setNeeds]     = useState({})     // name -> has_recovery

  useEffect(() => {
    listUsersBasic()
      .then(async (r) => {
        const rows = r.data.filter((u) => u.name.toLowerCase() !== user?.name?.toLowerCase())
        setUsers(rows)
        // Flag who still can't self-serve, so you know who to prioritise
        const flags = {}
        await Promise.all(rows.map(async (u) => {
          try {
            const q = await getRecoveryQuestion(u.name)
            flags[u.name] = q.data.has_recovery
          } catch { flags[u.name] = null }
        }))
        setNeeds(flags)
      })
      .catch(() => setUsers([]))
  }, [user?.name])

  const handleIssue = async (e) => {
    e.preventDefault()
    setError(''); setIssued(null)
    if (!target) return setError('Pick who the code is for.')
    if (passkey.length !== 6) return setError('Enter your own 6-digit passkey.')
    setBusy(true)
    try {
      const r = await adminIssueCode({
        admin_name: user.name,
        admin_answer: passkey,
        target_name: target,
      })
      setIssued(r.data)
      setPasskey('')
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not issue a code.')
    } finally {
      setBusy(false)
    }
  }

  if (!isAdmin(user)) {
    return <p className="p-5 text-gray-500">Not found.</p>
  }

  const withoutRecovery = users.filter((u) => needs[u.name] === false)

  return (
    <div className="pb-24 md:pb-8">
      <div className="bg-gradient-to-br from-field-800 to-field-950 text-white px-5 pt-10 md:pt-8 pb-6 md:rounded-b-3xl border-b border-field-700">
        <button onClick={() => nav('/')} className="text-xs font-bold text-white/50 mb-2">← Home</button>
        <h1 className="text-2xl font-bold tracking-tight">One-time codes</h1>
        <p className="text-slate-300/40 text-xs mt-1 font-medium">
          Give a locked-out user a way back in
        </p>
      </div>

      <div className="px-5 mt-5 space-y-4 max-w-lg">
        <div className="card">
          <p className="text-xs text-gray-500 leading-relaxed mb-4">
            The code lets them set a new password and choose their own security
            question — after that they can reset themselves without you. It works
            once and expires in 24 hours.
          </p>

          <form onSubmit={handleIssue} className="space-y-3">
            <div>
              <label className="label">Issue a code to</label>
              <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Select a user…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.name}>
                    {u.name}{needs[u.name] === false ? '  · no security question' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Your 6-digit passkey</label>
              <input
                className="input tracking-[0.3em] font-bold"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={passkey}
                onChange={(e) => setPasskey(e.target.value.replace(/\D/g, ''))}
              />
              <p className="text-[10px] text-gray-400 mt-1">
                The recovery key on your own account — confirms it's really you.
              </p>
            </div>

            {error && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>
            )}

            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Generating…' : 'Generate code'}
            </button>
          </form>

          {issued && (
            <div className="mt-4 border border-green-200 bg-green-50 rounded-md p-4 text-center">
              <p className="text-[10px] font-bold text-green-700 uppercase tracking-widest">
                Code for {issued.target}
              </p>
              <p className="text-3xl font-black text-green-800 tracking-[0.3em] my-2">{issued.code}</p>
              <p className="text-[11px] text-green-700 leading-relaxed">
                Send this to {issued.target}. They enter it at
                <span className="font-bold"> Forgot password → I have a one-time code</span>.
              </p>
              <p className="text-[10px] text-gray-500 mt-2">
                Single use · expires in {issued.expires_in_hours} hours · shown only now
              </p>
            </div>
          )}
        </div>

        {withoutRecovery.length > 0 && (
          <div className="card">
            <h3 className="text-xs font-bold text-gray-500 mb-2">
              Can't reset themselves yet ({withoutRecovery.length})
            </h3>
            <p className="text-[11px] text-gray-400 leading-relaxed mb-3">
              These users have no security question. If any is already logged in, the
              quickest fix is for them to set one from Account security → Recovery —
              no code needed.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {withoutRecovery.map((u) => (
                <span key={u.id} className="badge bg-amber-100 text-gray-600 border border-amber-200">
                  {u.name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
