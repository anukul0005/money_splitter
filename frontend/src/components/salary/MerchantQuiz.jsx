import { useEffect, useState } from 'react'
import { cardQuestions, identifyPayee } from '../../api/index.js'
import Dropdown from '../Dropdown'

const INR = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = (iso) => (iso ? `${+iso.slice(8, 10)} ${MON[+iso.slice(5, 7) - 1]}` : '')
const WHOSE = [['mine', 'Mine'], ['group', 'Already in a group'], ['bill', 'In a recurring bill'], ['not_mine', 'Not mine']]

/**
 * Card payees the app can't name - a person's name on a UPI, or spends filed
 * as Other - asked about one at a time: what it is, what kind of spend, and
 * whose. Each answer holds for that payee on every bill from now on
 * (backend salary.py /cards/questions, /cards/identify).
 */
export default function MerchantQuiz({ ym, onDone, onClose }) {
  const [qs, setQs] = useState(null)
  const [cats, setCats] = useState({})
  const [i, setI] = useState(0)
  const [name, setName] = useState('')
  const [cat, setCat] = useState('')
  const [sub, setSub] = useState('')
  const [whose, setWhose] = useState('mine')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [saved, setSaved] = useState(0)

  useEffect(() => {
    cardQuestions(ym).then((r) => { setQs(r.data.questions); setCats(r.data.categories || {}) })
      .catch(() => setErr("Couldn't load the questions."))
  }, [ym])
  const q = qs?.[i]
  // each question starts from what the app has
  useEffect(() => {
    if (!q) return
    setName(q.shown !== q.payee ? q.shown : '')
    setCat(q.category && q.category !== 'Other' ? q.category : '')
    setSub(''); setWhose('mine'); setErr('')
  }, [i, qs])

  const next = () => setI((n) => n + 1)
  const save = async () => {
    setBusy(true); setErr('')
    try {
      await identifyPayee({ payee_key: q.payee_key, payee: q.payee, name: name.trim() || null,
                            category: cat || null, subcategory: sub || null, status: whose })
      setSaved((n) => n + 1); next()
    } catch (e) { setErr(e.response?.data?.detail || "Couldn't save that - try again.") }
    finally { setBusy(false) }
  }
  const finish = () => { if (saved) onDone?.(); onClose() }

  if (err && !qs) return <div className="mt-3 p-3 border border-amber-200 bg-amber-50 text-xs text-red-600">{err}</div>
  if (!qs) return <div className="mt-3 p-3 border border-amber-200 bg-amber-50 text-xs text-gray-500">Finding payees to ask about…</div>

  if (!q) {
    return (
      <div className="mt-3 p-3 border border-amber-200 bg-amber-50 text-xs space-y-2">
        <p className="font-bold text-gray-800">
          {qs.length ? `Done - ${saved} payee${saved === 1 ? '' : 's'} named.` : 'Nothing to ask - every counted spend this month has a name.'}
        </p>
        <button onClick={finish} className="font-bold text-brand-600">Close</button>
      </div>
    )
  }

  const subs = cat ? cats[cat] || [] : []
  return (
    <div className="mt-3 p-3 border border-amber-200 bg-amber-50 text-xs space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Who is this? · {i + 1} of {qs.length}</p>
        <button onClick={finish} className="text-[11px] font-bold text-gray-500">Stop</button>
      </div>
      <div>
        <p className="text-sm font-black text-gray-900 break-words">{q.payee}</p>
        <p className="text-[11px] text-gray-600">{q.lines.length} spend{q.lines.length === 1 ? '' : 's'} · {INR(q.amount)} this month</p>
        <div className="mt-1 space-y-0.5">
          {q.lines.slice(0, 4).map((l) => (
            <p key={l.key} className="text-[10px] text-gray-500 break-words">{day(l.date)} · {INR(l.amount)} · {l.title} · {l.card}</p>
          ))}
          {q.lines.length > 4 && <p className="text-[10px] text-gray-400">and {q.lines.length - 4} more</p>}
        </div>
      </div>

      <label className="block text-[11px] font-bold text-gray-700">What is it?
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120}
          className="input text-xs py-1.5 mt-1" placeholder="e.g. Milkman, Sharma Kirana, Gym, Rent" />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className="text-[11px] font-bold text-gray-700 mb-1">Kind of spend</p>
          <Dropdown size="sm" value={cat} onChange={(v) => { setCat(v); setSub('') }} placeholder="Pick one"
            options={Object.keys(cats).map((c) => ({ value: c, label: c }))} />
        </div>
        {subs.length > 0 && (
          <div>
            <p className="text-[11px] font-bold text-gray-700 mb-1">More exactly</p>
            <Dropdown size="sm" value={sub} onChange={setSub} placeholder="Optional"
              options={[{ value: '', label: '-' }, ...subs.map((s) => ({ value: s, label: s }))]} />
          </div>
        )}
      </div>

      <div>
        <p className="text-[11px] font-bold text-gray-700 mb-1">Whose spend is it?</p>
        <div className="flex flex-wrap gap-1.5">
          {WHOSE.map(([v, label]) => (
            <button key={v} onClick={() => setWhose(v)}
              className={`px-2.5 py-1 text-[11px] font-bold border ${whose === v ? 'border-brand-600 bg-brand-600 text-white' : 'border-amber-300 bg-white text-gray-700'}`}>
              {label}
            </button>
          ))}
        </div>
        {whose !== 'mine' && <p className="text-[10px] text-gray-500 mt-1">Every spend to {q.payee} will be left out from now on.</p>}
      </div>

      {err && <p className="text-red-600">{err}</p>}
      <div className="flex gap-3 items-center">
        <button onClick={save} disabled={busy || (!name.trim() && !cat && whose === 'mine')}
          className="btn-primary !w-auto text-xs px-4 py-2 disabled:opacity-50">{busy ? 'Saving…' : 'Save & next'}</button>
        <button onClick={next} disabled={busy} className="font-bold text-gray-500">Skip</button>
      </div>
    </div>
  )
}
