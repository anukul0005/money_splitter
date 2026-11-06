import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createExpense, createGroup, deleteExpense, deleteGroup, getGroup, getGroups, listUsersBasic, scanReceipt, understandExpense, updateExpense } from '../api'
import ExpenseChat from '../components/ExpenseChat'
import { useUser } from '../UserContext'
import { buildMasterGroups, pairKey } from '../utils/masterGroups'
import { compressImage } from '../utils/compressImage'
import { dn } from '../utils/displayName'
import ReceiptCropper from '../components/ReceiptCropper'
import DatePicker from '../components/DatePicker'
import { useStatementUpload, ANY_STATEMENT, MailSyncWide } from '../components/StatementUpload'
import Dropdown from '../components/Dropdown'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
// Today as every dated group is named ("18 oct 26") - the same pattern a
// supergroup's "+ Add" uses, so this group sits in its timeline like any other.
const todayName = () => {
  const d = new Date()
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`
}
const lc = (s) => (s || '').trim().toLowerCase()
// The same day however it was typed ("9 Oct 26", "09 oct 26")
const dayKey = (name) => lc(name).replace(/^0(\d)/, '$1')
const r2 = (n) => Math.round(n * 100) / 100
// Your own spending sits in one group a month: "MONTHLY EXPENSES OCT 2026"
const monthlyName = (iso) => {
  const d = iso ? new Date(`${iso}T00:00:00`) : new Date()
  return `MONTHLY EXPENSES ${MONTHS[d.getMonth()].toUpperCase()} ${d.getFullYear()}`
}
const monthLabel = (iso) => (iso ? new Date(`${iso}T00:00:00`) : new Date())
  .toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
const PAYMENT_MODES = [['upi', 'UPI'], ['cash', 'Cash'], ['credit_card', 'Credit card'], ['debit_card', 'Debit card']]
const PAYMENT_KEY = 'splitter_last_payment_mode'
const inr = (n) => `₹${r2(n).toLocaleString('en-IN')}`

/**
 * "+ New Expense" (Home) - a quick expense. First the expense: read from a photo, a
 * gallery image or a PDF bill, or typed by hand (a bank statement imports a
 * month's worth into the monthly groups by itself). Then whose it is:
 *  - yours alone (the default): into that month's personal group,
 *    "MONTHLY EXPENSES OCT 2026", made if it isn't there yet;
 *  - split with people, picked or added new: into today's group with exactly
 *    them ("30 oct 26") - opened if it exists, made if not, inside their
 *    existing set of groups when there is one - with who paid, and the split
 *    equal among whoever shares it or custom %. With no amount, only the
 *    group is made.
 * Someone on the app is matched to their exact username (two "Ajay"s are
 * told apart by their full names); anyone else is added by the name typed.
 */
export default function NewGroup() {
  const nav = useNavigate()
  const user = useUser()
  const me = user?.name || ''

  const [appUsers, setAppUsers]   = useState([])   // [{ name, full_name }]
  const [known, setKnown]         = useState([])   // names from your own groups, commonest first
  const [allGroups, setAllGroups] = useState([])
  const [members, setMembers]     = useState([])   // everyone but you
  const [query, setQuery]         = useState('')
  const [choosing, setChoosing]   = useState(null) // { typed, options } when a name is ambiguous
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]         = useState('')

  const [whose, setWhose]         = useState('me')      // me (monthly) | split
  const [picked, setPicked]       = useState('')        // a previous group with these people, chosen to add to ('' = today's)
  const [payMode, setPayMode]     = useState(() => { try { return localStorage.getItem(PAYMENT_KEY) || 'upi' } catch { return 'upi' } })
  const statement = useStatementUpload(null, { panelClassName: 'mt-2' })
  // Back from connecting Gmail for the sync: start it straight away
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    if (q.get('gmail') === 'connected') {
      window.history.replaceState(null, '', window.location.pathname)
      statement.mailSync()
    }
  }, [])

  // The expense
  const [amount, setAmount]       = useState('')
  const [title, setTitle]         = useState('')
  const [notes, setNotes]         = useState('')
  const [date, setDate]           = useState(() => new Date().toISOString().split('T')[0])
  const [paidBy, setPaidBy]       = useState(me)
  const [splitMode, setSplitMode] = useState('equal')   // equal | custom
  const [left, setLeft]           = useState([])        // left out of an equal split
  const [pcts, setPcts]           = useState({})        // custom: name -> %
  const [typed, setTyped]         = useState([])        // custom: names whose % was typed, oldest first - the rest share what's left
  const [receipt, setReceipt]     = useState(null)
  const [scan, setScan]           = useState({ busy: false, error: '', note: '' })
  const [cropFile, setCropFile]   = useState(null)
  // What the chat saved by itself: { gid, id, name, created } - a follow-up
  // updates it, Discard takes it back out
  const [saved, setSaved]         = useState(null)
  const savedRef                  = useRef(null)
  const pendingSave               = useRef(null)
  const [saveTick, setSaveTick]   = useState(0)
  const [chatKey, setChatKey]     = useState(0)
  const cameraRef = useRef(null)
  const galleryRef = useRef(null)
  const pdfRef = useRef(null)

  useEffect(() => {
    listUsersBasic().then((r) => setAppUsers(r.data)).catch(() => setAppUsers([]))
    getGroups()
      .then((r) => {
        setAllGroups(r.data)
        const freq = new Map()
        r.data.forEach((g) => (g.member_names ?? []).forEach((n) => freq.set(n, (freq.get(n) || 0) + 1)))
        setKnown([...freq.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n))
      })
      .catch(() => setKnown([]))
  }, [])
  useEffect(() => { if (!paidBy && me) setPaidBy(me) }, [me])

  const appByName = useMemo(() => new Map(appUsers.map((u) => [lc(u.name), u])), [appUsers])
  const taken = (name) => lc(name) === lc(me) || members.some((m) => lc(m) === lc(name))
  const onApp = (name) => appByName.has(lc(name))

  // App users a typed name could mean: its username, or any word of their
  // full name, starting with what was typed.
  const appMatches = (q) => {
    const t = lc(q)
    if (!t) return []
    return appUsers.filter((u) => !taken(u.name) && (
      lc(u.name).startsWith(t) || lc(u.full_name).split(/\s+/).some((w) => w && w.startsWith(t))
    ))
  }

  const add = (name) => {
    const n = (name || '').trim()
    if (!n) return
    if (lc(n) === lc(me)) { setQuery(''); return setError("You're in the group already.") }
    if (taken(n)) return setQuery('')
    setMembers((m) => [...m, n])
    setQuery(''); setChoosing(null); setError('')
    setSplitMode('equal')
  }
  useEffect(() => { setPicked('') }, [members.join('|')])
  const remove = (name) => {
    setMembers((x) => x.filter((y) => y !== name))
    setLeft((x) => x.filter((y) => y !== name))
    if (lc(paidBy) === lc(name)) setPaidBy(me)
    setSplitMode('equal')
  }

  // Add/Enter with just a typed name: one app user it can mean -> them;
  // several -> ask which; none -> add the name as someone not on the app.
  const addTyped = () => {
    const typedName = query.trim()
    if (!typedName) return
    const exact = appUsers.filter((u) => lc(u.name) === lc(typedName))
    const options = appMatches(typedName)
    if (options.length > 1) return setChoosing({ typed: typedName, options })
    if (options.length === 1) return add(options[0].name)
    if (exact.length && taken(exact[0].name)) return setQuery('')
    add(typedName)
  }

  const t = lc(query)
  const typedSuggestions = t ? appMatches(query) : []
  const knownOffApp = t
    ? known.filter((n) => !onApp(n) && !taken(n) && lc(n).includes(t)).slice(0, 4)
    : []
  const exactAppUser = appUsers.some((u) => lc(u.name) === t)
  const quick = known.filter((n) => !taken(n)).slice(0, 10)

  const everyone = [me, ...members].filter(Boolean)
  const existing = members.length > 0
    ? buildMasterGroups(allGroups, 1, me).masters.find((m) => m.key === pairKey(everyone))
    : null
  // Today's group with exactly these people, if it's there already
  const todays = existing?.groups.find((g) => dayKey(g.name) === dayKey(todayName()))
  // Where it goes: a previous group picked from theirs, else today's (made if not there)
  const target = (picked && existing?.groups.find((g) => String(g.id) === String(picked))) || todays
  const pastGroups = (existing?.groups || []).filter((g) => g.id !== todays?.id).sort((a, b) => b.id - a.id)
  const usualCategory = (() => {
    const counts = {}
    existing?.groups.forEach((g) => { if (g.category) counts[g.category] = (counts[g.category] || 0) + 1 })
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'other'
  })()
  const monthly = allGroups.find((g) => g.name === monthlyName(date)
    && (g.member_names ?? []).some((n) => lc(n) === lc(me)))
  // Names as the group keeps them (an existing group's spelling wins)
  const groupNames = existing?.names?.length ? existing.names : everyone
  const label = (n) => (lc(n) === lc(me) ? 'You' : dn(n, everyone))
  const fullName = (name) => appByName.get(lc(name))?.full_name

  // ── the split ──
  const amt = parseFloat(amount) || 0
  const sharing = everyone.filter((n) => !left.includes(n))
  const pctOf = (n) => parseFloat(pcts[n]) || 0
  const pctTotal = everyone.reduce((s, n) => s + pctOf(n), 0)
  const onPct = (name, v) => {
    if (v !== '' && parseFloat(v) > 100) v = '100'
    if (v !== '' && parseFloat(v) < 0) v = '0'
    let nowTyped = typed.filter((n) => n !== name && everyone.includes(n))
    if (v !== '') nowTyped.push(name)
    // Everyone typed: the one typed longest ago gives way and takes what's left
    if (!everyone.some((n) => !nowTyped.includes(n))) nowTyped = nowTyped.slice(1)
    const next = { ...pcts, [name]: v }
    const free = everyone.filter((n) => !nowTyped.includes(n) && n !== name)
    const fixed = nowTyped.reduce((s, n) => s + (parseFloat(next[n]) || 0), 0)
    free.forEach((n) => { next[n] = String(r2(Math.max(0, 100 - fixed) / free.length)) })
    setTyped(nowTyped); setPcts(next)
  }
  const startCustom = () => {
    setSplitMode('custom')
    const even = String(r2(100 / everyone.length))
    setPcts(Object.fromEntries(everyone.map((n) => [n, even]))); setTyped([])
  }
  // name -> rupees, for those with a share; canon gives each name as the group spells it
  const shares = (canon) => Object.fromEntries(
    (splitMode === 'custom'
      ? everyone.map((n) => [canon(n), r2(amt * pctOf(n) / 100)])
      : sharing.map((n) => [canon(n), r2(amt / sharing.length)]))
      .filter(([, v]) => v > 0))

  // ── a bill: a photo (cropped first), a gallery image, or a PDF ──
  const resetInputs = () => [cameraRef, galleryRef, pdfRef].forEach((r) => { if (r.current) r.current.value = '' })
  const readBill = async (file, isPdf) => {
    setCropFile(null)
    setScan({ busy: true, error: '', note: '' })
    setReceipt(null)
    try {
      const res = await scanReceipt(isPdf ? file : await compressImage(file))
      const { merchant, date: d, items, subtotal, tax, total, provider, confidence, extraction_method } = res.data
      if (merchant) setTitle(merchant)
      if (total != null) setAmount(String(total))
      if (d) setDate(d)
      const itemNote = (items || []).map((i) => i.label).filter(Boolean).join(', ')
      if (itemNote) setNotes(itemNote)
      setReceipt({ merchant, items: items || [], subtotal, tax, total, provider, method: extraction_method })
      setScan({
        busy: false, error: '',
        note: total == null && !merchant
          ? "Couldn't find a total or a name in it - fill them in below."
          : `Filled in from ${provider} (${confidence}% sure) - check it before saving.`,
      })
    } catch (err) {
      setScan({ busy: false, error: err?.response?.data?.detail || "Couldn't read that - try a clearer photo, or fill it in below.", note: '' })
    } finally {
      resetInputs()
    }
  }

  const pickPayMode = (v) => {
    setPayMode(v)
    try { localStorage.setItem(PAYMENT_KEY, v) } catch { /* private mode */ }
  }

  // A name the chat heard, as this page adds people: someone from your
  // groups, else the one app user it can mean, else the name as said.
  const resolve = (said) => {
    const s = lc(said)
    const first = s.split(/\s+/)[0]
    const knownHit = known.find((n) => lc(n) === s) || (() => {
      const f = known.filter((n) => lc(n).split(/\s+/)[0] === first)
      return f.length === 1 ? f[0] : null
    })()
    if (knownHit) return knownHit
    const exact = appUsers.find((u) => lc(u.name) === s)
    if (exact) return exact.name
    const fits = appUsers.filter((u) => lc(u.name).startsWith(s) || lc(u.full_name).split(/\s+/).some((w) => w && w === first))
    return fits.length === 1 ? fits[0].name : said
  }

  // The chat box: a message read into the form - the people named make it a
  // split with them (the group is then worked out as usual), nobody named
  // leaves it as it is. Resolves to the line shown back.
  const askChat = async (text) => {
    const { data } = await understandExpense({
      text,
      draft: {
        amount: amount || null, title: title || null, notes: notes || null, date: date || null,
        payment_mode: payMode || null, people: members,
        paid_by: !paidBy || lc(paidBy) === lc(me) ? 'me' : paidBy,
      },
    })
    if (data.amount != null) setAmount(String(data.amount))
    if (data.title != null) setTitle(data.title)
    if (data.notes != null) setNotes(data.notes)
    if (data.date) setDate(data.date)
    if (data.payment_mode) setPayMode(data.payment_mode)
    const people = [...new Set((data.people || []).map(resolve))].filter((n) => lc(n) !== lc(me))
    if (people.length) {
      const changed = people.map(lc).sort().join('|') !== members.map(lc).sort().join('|')
      if (changed) { setMembers(people); setLeft([]); setSplitMode('equal') }
      setWhose('split')
      const payer = data.payer ? people.find((p) => lc(p) === lc(resolve(data.payer))) : null
      setPaidBy(payer || me)
    } else if (data.payer === null && !members.length) {
      setPaidBy(me)
    }
    setError('')

    const total = data.amount != null ? data.amount : parseFloat(amount)
    if (!(total > 0)) return data.reply
    // An amount is all it takes: saved straight away (the save runs after
    // this render - see the effect by persist)
    const result = await new Promise((resolve) => { pendingSave.current = resolve; setSaveTick((t) => t + 1) })
    if (result.err) {
      return { error: true, text: `${data.reply || ''}\nCouldn't save it: ${result.err?.response?.data?.detail || 'something went wrong'} - check the form and tap Save.`.trim() }
    }
    const s = result.saved
    const what = data.title || title
    return {
      text: `${data.reply || ''}\n✓ Saved to ${s.name}${what ? '' : ' - with no description yet, so it stays highlighted there until you add one'}.`.trim(),
      actions: [
        { label: 'Discard', danger: true, run: async () => { await discard(); return 'reset' } },
        { label: `Open ${s.name}`, run: async () => { nav(`/groups/${s.gid}`) } },
        { label: '+ Another', run: async () => { savedRef.current = null; setSaved(null); clearForm(); return 'reset' } },
      ],
    }
  }

  // A group made here goes straight into the list, so the next save (a chat
  // follow-up) finds it instead of making another
  const makeGroup = async (data) => {
    const r = await createGroup(data)
    setAllGroups((gs) => [...gs, { ...r.data, member_names: data.members }])
    return r.data.id
  }

  // The expense as the form holds it, into its group: yours into the month's
  // personal group, split into the group with those people - either made if
  // it isn't there. Already saved (by the chat) -> that one is updated, or
  // moved when it now belongs in another group. No description is fine -
  // saved, and highlighted in the group until it gets one.
  const persist = async () => {
    const prev = savedRef.current
    let gid, name, created = false, payload
    if (whose === 'me') {
      gid = monthly?.id; name = monthlyName(date)
      if (!gid) {
        gid = await makeGroup({ name, description: '', category: 'personal', emoji: '💰', members: [me], created_by: me })
        created = true
      }
      payload = {
        group_id: Number(gid), date: date || null, title: title.trim() || null, amount: amt,
        paid_by: me, divider: 1, notes: notes || null, split_json: null,
        payment_mode: payMode, receipt_json: receipt ? JSON.stringify(receipt) : null,
        recorded_by: me || null,
      }
    } else {
      gid = target?.id; name = target?.name || todayName()
      if (!gid) {
        gid = await makeGroup({ name, description: '', category: usualCategory, emoji: '', members: groupNames, created_by: me })
        created = true
      }
      // Balances match names exactly: use the group's own spelling of each
      const names = ((await getGroup(gid)).data.members || []).map((m) => m.name)
      const canon = (n) => names.find((x) => lc(x) === lc(n)) || n
      const plainEqual = splitMode === 'equal' && sharing.length === everyone.length
      const split = shares(canon)
      payload = {
        group_id: Number(gid), date: date || null, title: title.trim() || null, amount: amt,
        paid_by: canon(paidBy || me),
        divider: plainEqual ? everyone.length : Math.max(1, Object.keys(split).length),
        notes: notes || null,
        split_json: plainEqual ? null : JSON.stringify(split),
        payment_mode: payMode,
        receipt_json: receipt ? JSON.stringify(receipt) : null,
        recorded_by: me || null,
      }
    }
    let id
    if (prev && prev.gid === gid) {
      await updateExpense(prev.id, payload)
      id = prev.id; created = prev.created
    } else {
      if (prev) await unsave(prev)
      id = (await createExpense(payload)).data.id
    }
    const s = { gid, id, name, created }
    savedRef.current = s; setSaved(s)
    return s
  }

  // Take a saved expense back out - and the group, when it was made just for it
  const unsave = async (s) => {
    await deleteExpense(s.id)
    if (s.created) {
      await deleteGroup(s.gid).catch(() => {})
      setAllGroups((gs) => gs.filter((g) => g.id !== s.gid))
    }
    if (savedRef.current?.id === s.id) { savedRef.current = null; setSaved(null) }
  }

  const clearForm = () => {
    setAmount(''); setTitle(''); setNotes(''); setReceipt(null); setScan({ busy: false, error: '', note: '' })
    setMembers([]); setLeft([]); setSplitMode('equal'); setWhose('me'); setPaidBy(me); setPicked('')
    setDate(new Date().toISOString().split('T')[0]); setError('')
  }

  const discard = async () => {
    if (savedRef.current) await unsave(savedRef.current)
    clearForm()
    setChatKey((k) => k + 1)
  }

  const save = async () => {
    setError('')
    if (whose === 'split' && !members.length) return setError('Add at least one person to split it with.')
    const withExpense = whose === 'me' || amount !== ''
    if (withExpense) {
      if (!(amt > 0)) return setError(whose === 'me' ? 'Enter the amount.' : 'Enter a valid amount.')
      if (whose === 'split' && splitMode === 'equal' && !sharing.length) return setError('Pick at least one person to share it.')
      if (whose === 'split' && splitMode === 'custom' && Math.abs(pctTotal - 100) > 0.5) return setError(`The split adds up to ${r2(pctTotal)}% - it needs to be 100%.`)
    } else if (target) {
      return nav(`/groups/${target.id}`)
    }
    setSubmitting(true)
    try {
      if (withExpense) {
        const s = await persist()
        return nav(`/groups/${s.gid}`)
      }
      const gid = await makeGroup({ name: todayName(), description: '', category: usualCategory, emoji: '', members: groupNames, created_by: me })
      nav(`/groups/${gid}`)
    } catch (err) {
      setError(err?.response?.data?.detail || 'Something went wrong')
      setSubmitting(false)
    }
  }

  // The chat saves by itself: askChat fills the form, then asks for a save
  // here - after the render, so the save sees the form as just filled in
  useEffect(() => {
    const done = pendingSave.current
    if (!done) return
    pendingSave.current = null
    persist().then((s) => done({ saved: s }), (err) => done({ err }))
  }, [saveTick])

  const chip = (on) => `px-3 py-1.5 text-xs font-bold border rounded-md ${on ? 'bg-brand-400 text-white border-brand-400' : 'bg-amber-50 text-gray-600 border-amber-200'}`

  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream border-b border-amber-100/60 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => nav(-1)} className="btn-ghost" aria-label="Back">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div>
            <h1 className="text-xl font-bold">New expense</h1>
            <p className="text-[11px] text-gray-400 mt-0.5">Yours goes to the month's personal expenses; split, it goes to the group with those people.</p>
          </div>
        </div>
      </div>

      <div className="px-5 mt-5 space-y-5 max-w-2xl">
            {/* Say it or type it - fills everything below, people included */}
            <ExpenseChat key={chatKey} ask={askChat} />

            {/* Read it from a bill */}
            <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3">
              <p className="text-xs font-bold text-gray-700 mb-2">Upload it <span className="font-normal text-gray-400">- or type it in below</span></p>
              <div className="grid grid-cols-2 gap-2">
                {[['📷', 'Take photo', cameraRef], ['🖼️', 'Gallery', galleryRef], ['📄', 'PDF bill', pdfRef]].map(([icon, text, ref]) => (
                  <button key={text} type="button" disabled={scan.busy} onClick={() => ref.current?.click()}
                    className="py-2.5 text-xs font-bold text-gray-700 bg-white border border-amber-300 rounded-md hover:bg-amber-100 active:scale-[0.98] transition-all disabled:opacity-50">
                    {icon} {text}
                  </button>
                ))}
                <button type="button" disabled={statement.busy} onClick={() => statement.pick(ANY_STATEMENT)}
                  className="py-2.5 text-xs font-bold text-gray-700 bg-white border border-amber-300 rounded-md hover:bg-amber-100 active:scale-[0.98] transition-all disabled:opacity-50">
                  🏦 Bank statement
                </button>
                <MailSyncWide className="col-span-2" busy={statement.busy}
                  onSync={(d) => statement.mailSync('', false, d)} onConnect={statement.connectGmail} />
              </div>
              <p className="text-[10px] text-gray-500 mt-1.5">Any bank's PDF statement (HDFC, SBI, ICICI, …) or a PhonePe, Google Pay or Paytm one: each payment is read and filed into its month's personal expenses by itself. Gmail sync finds PhonePe, Paytm and Google Pay statement emails (PDF, CSV or Excel, password-protected too) and imports them the same way.</p>
              {statement.input}
              {statement.panel}
              <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden"
                onChange={(e) => e.target.files?.[0] && setCropFile(e.target.files[0])} />
              <input ref={galleryRef} type="file" accept="image/*" className="hidden"
                onChange={(e) => e.target.files?.[0] && setCropFile(e.target.files[0])} />
              <input ref={pdfRef} type="file" accept="application/pdf,.pdf" className="hidden"
                onChange={(e) => e.target.files?.[0] && readBill(e.target.files[0], true)} />
              {scan.busy && <p className="text-xs text-gray-500 mt-2">Reading it…</p>}
              {scan.error && <p className="text-xs text-red-600 mt-2">{scan.error}</p>}
              {scan.note && <p className="text-xs text-brand-700 mt-2">{scan.note}</p>}
            </div>

            {/* The expense */}
            <div>
              <label className="label">Amount (₹)</label>
              <input className="input text-2xl font-bold" type="number" inputMode="decimal" placeholder="0" min="1" step="0.01"
                value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div>
              <label className="label">Description</label>
              <input className="input" placeholder="e.g. dinner at Punjab Grill" value={title}
                onChange={(e) => setTitle(e.target.value)} autoComplete="off" />
              {!title.trim() && amt > 0 && (
                <p className="text-[10px] text-gray-400 mt-1">No description yet? Save it anyway - it stays highlighted in the group until you add one.</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Date</label>
                <DatePicker value={date} onChange={setDate} />
              </div>
              <div>
                <label className="label">Notes</label>
                <input className="input" placeholder="optional" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
            </div>
            <div>
              <label className="label">Payment mode</label>
              <div className="flex flex-wrap gap-2">
                {PAYMENT_MODES.map(([v, t]) => (
                  <button key={v} type="button" onClick={() => pickPayMode(v)} className={chip(payMode === v)}>{t}</button>
                ))}
              </div>
            </div>
            {/* Whose is it */}
            <div>
              <span className="label">Whose is it?</span>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setWhose('me')}
                  className={`text-left px-3 py-2.5 border rounded-md ${whose === 'me' ? 'bg-brand-400 text-white border-brand-400' : 'bg-amber-50 text-gray-700 border-amber-200'}`}>
                  <span className="block text-sm font-bold">Just me</span>
                  <span className={`block text-[10px] ${whose === 'me' ? 'text-white/80' : 'text-gray-400'}`}>Monthly · {monthLabel(date)}</span>
                </button>
                <button type="button" onClick={() => setWhose('split')}
                  className={`text-left px-3 py-2.5 border rounded-md ${whose === 'split' ? 'bg-brand-400 text-white border-brand-400' : 'bg-amber-50 text-gray-700 border-amber-200'}`}>
                  <span className="block text-sm font-bold">Split with people</span>
                  <span className={`block text-[10px] ${whose === 'split' ? 'text-white/80' : 'text-gray-400'}`}>Friends, or someone new</span>
                </button>
              </div>
              {whose === 'me' && (
                <p className="text-[11px] text-gray-500 mt-1.5">
                  Goes to <b>{monthlyName(date)}</b>{monthly ? '' : ' (made now - first one this month)'}
                </p>
              )}
            </div>
        {whose === 'split' && (
          <>
        {/* Who's in */}
        <div>
          <p className="label">Members</p>
          <div className="flex flex-wrap gap-2">
            <span className="bg-gray-100 text-gray-600 border border-gray-200 rounded-md px-3 py-1.5 text-sm font-bold">
              You
            </span>
            {members.map((m) => (
              <span key={m} className="flex items-center gap-1.5 bg-brand-400/15 text-brand-700 border border-brand-400/30 rounded-md pl-3 pr-2 py-1.5 text-sm font-bold">
                <span>
                  {m}
                  <span className="block text-[10px] font-semibold text-brand-700/60 leading-tight">
                    {onApp(m) ? (fullName(m) || 'on the app') : 'not on the app'}
                  </span>
                </span>
                <button type="button" onClick={() => remove(m)}
                  className="text-brand-400 hover:text-brand-700 px-1" aria-label={`Remove ${m}`}>×</button>
              </span>
            ))}
          </div>
        </div>

        {/* Add someone */}
        <div>
          <label htmlFor="member-search" className="label">Add a person</label>
          <div className="flex gap-2">
            <input
              id="member-search"
              className="input flex-1"
              placeholder="Name or username"
              value={query}
              autoComplete="off"
              autoCapitalize="words"
              onChange={(e) => { setQuery(e.target.value); setChoosing(null); setError('') }}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTyped())}
            />
            <button type="button" onClick={addTyped} disabled={!query.trim()}
              className="bg-brand-400 text-white px-4 font-bold text-sm shadow-sm rounded-md disabled:opacity-50">
              Add
            </button>
          </div>

          {/* Two or more people the typed name could be (this and the live
              matches below are set 15% smaller than the page's usual sizes) */}
          {choosing && (
            <div className="mt-2 border border-amber-300 bg-amber-50 rounded-md p-3">
              <p className="text-[10.2px] font-bold text-gray-800 mb-2">
                {choosing.options.length} people on the app match "{choosing.typed}" - which one?
              </p>
              <div className="space-y-1.5">
                {choosing.options.map((u) => (
                  <button key={u.name} type="button" onClick={() => add(u.name)}
                    className="w-full text-left bg-white border border-amber-200 rounded-md px-3 py-2 hover:bg-amber-100">
                    <span className="text-[11.9px] font-bold text-gray-800">{u.name}</span>
                    <span className="block text-[9.35px] text-gray-500">{u.full_name || 'no full name set'}</span>
                  </button>
                ))}
                {!onApp(choosing.typed) && (
                  <button type="button" onClick={() => add(choosing.typed)}
                    className="w-full text-left text-[10.2px] font-bold text-gray-600 px-3 py-1.5">
                    Neither - add "{choosing.typed}" (not on the app)
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Live matches while typing */}
          {!choosing && t && (typedSuggestions.length > 0 || knownOffApp.length > 0 || !exactAppUser) && (
            <div className="mt-2 border border-amber-200 bg-white rounded-md divide-y divide-amber-100">
              {typedSuggestions.slice(0, 6).map((u) => (
                <button key={u.name} type="button" onClick={() => add(u.name)}
                  className="w-full text-left px-3 py-2 hover:bg-amber-50 flex items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="text-[11.9px] font-bold text-gray-800">{u.name}</span>
                    {u.full_name && <span className="text-[10.2px] text-gray-500"> · {u.full_name}</span>}
                  </span>
                  <span className="text-[8.5px] font-bold text-green-700 flex-shrink-0">ON THE APP</span>
                </button>
              ))}
              {knownOffApp.map((n) => (
                <button key={n} type="button" onClick={() => add(n)}
                  className="w-full text-left px-3 py-2 hover:bg-amber-50 flex items-center justify-between gap-3">
                  <span className="text-[11.9px] font-bold text-gray-800">{n}</span>
                  <span className="text-[8.5px] font-bold text-gray-400 flex-shrink-0">FROM YOUR GROUPS</span>
                </button>
              ))}
              {!exactAppUser && !taken(query) && !knownOffApp.some((n) => lc(n) === t) && (
                <button type="button" onClick={() => add(query)}
                  className="w-full text-left px-3 py-2 hover:bg-amber-50 text-[11.9px] text-gray-600">
                  + Add "<b>{query.trim()}</b>" <span className="text-[10.2px] text-gray-400">(not on the app)</span>
                </button>
              )}
            </div>
          )}

          {!t && quick.length > 0 && (
            <div className="mt-3">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">People you split with</p>
              <div className="flex flex-wrap gap-1.5">
                {quick.map((n) => (
                  <button key={n} type="button" onClick={() => add(n)}
                    className="bg-cream border border-amber-200 text-gray-600 hover:bg-amber-50 hover:text-gray-900 rounded-md px-2.5 py-1 text-xs font-bold active:scale-95 transition-all">
                    + {n}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Where it goes - worked out from the people */}
        {members.length > 0 && (
          <div className="text-[12px] text-gray-700 bg-white border border-amber-200 rounded-md px-3 py-2.5">
            <span className="block text-[9px] font-black text-gray-400 uppercase tracking-widest mb-0.5">Goes to</span>
            {existing ? (
              <>
                <p className="mb-1.5"><b>{existing.name}</b> <span className="text-gray-400">({existing.groups.length} group{existing.groups.length === 1 ? '' : 's'})</span></p>
                {/* today's group (made if it isn't there), or one of the earlier ones with them */}
                <Dropdown size="sm" value={picked} onChange={(v) => setPicked(String(v))}
                  options={[
                    { value: '', label: todays ? `Today's group · ${todays.name}` : `New group for today · ${todayName()}` },
                    ...pastGroups.map((g) => ({ value: String(g.id), label: g.name })),
                  ]} />
              </>
            ) : <>A new group with {everyone.map(label).join(', ')}, named <b>{todayName()}</b></>}
          </div>
        )}

        {members.length > 0 && (
          <>
            <div>
              <label className="label">Paid by</label>
              <div className="flex flex-wrap gap-2">
                {everyone.map((n) => (
                  <button key={n} type="button" onClick={() => setPaidBy(n)} className={chip(lc(paidBy) === lc(n))}>
                    {label(n)}
                  </button>
                ))}
              </div>
            </div>

            {/* The split: equal among whoever shares it, or custom % */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="label mb-0 flex-1">Split</span>
                <button type="button" onClick={() => setSplitMode('equal')} className={chip(splitMode === 'equal')}>Equal</button>
                <button type="button" onClick={startCustom} className={chip(splitMode === 'custom')}>Custom %</button>
              </div>
              {splitMode === 'equal' ? (
                <>
                  <div className="flex flex-wrap gap-2">
                    {everyone.map((n) => {
                      const on = !left.includes(n)
                      return (
                        <button key={n} type="button" onClick={() => setLeft((o) => (on ? [...o, n] : o.filter((x) => x !== n)))}
                          className={`px-3 py-1.5 text-xs font-bold border rounded-md ${on ? 'bg-brand-400/15 text-brand-700 border-brand-400/40' : 'bg-white text-gray-400 border-gray-200 line-through'}`}>
                          {on ? '✓ ' : ''}{label(n)}
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-[11px] text-gray-500 mt-1.5">
                    {sharing.length
                      ? <>Split between {sharing.length}{amt > 0 && <> · <b className="text-brand-600">{inr(amt / sharing.length)}</b> each</>} · tap a name to leave them out</>
                      : 'Pick who shares it.'}
                  </p>
                </>
              ) : (
                <div className="space-y-2">
                  {everyone.map((n) => (
                    <div key={n} className="flex items-center gap-2">
                      <span className="text-sm font-bold text-gray-700 w-24 truncate">{label(n)}</span>
                      <div className="relative w-24">
                        <input type="number" inputMode="decimal" min="0" max="100" step="any" className="input w-full text-right pr-6"
                          value={pcts[n] ?? ''} onChange={(e) => onPct(n, e.target.value)} />
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 font-bold pointer-events-none">%</span>
                      </div>
                      <span className="flex-1 text-right text-sm font-bold text-gray-900 tabular-nums">{amt > 0 ? inr(amt * pctOf(n) / 100) : ''}</span>
                    </div>
                  ))}
                  <p className={`text-xs font-bold ${Math.abs(pctTotal - 100) <= 0.5 ? 'text-brand-600' : 'text-red-500'}`}>
                    {Math.abs(pctTotal - 100) <= 0.5 ? '✓ Adds up to 100%' : `Adds up to ${r2(pctTotal)}% - needs 100%`}
                    <span className="font-normal text-gray-400"> · type some, the rest share what's left</span>
                  </p>
                </div>
              )}
            </div>

          </>
        )}
          </>
        )}

        {error && <p className="text-sm text-red-500 bg-red-50 border border-red-100 rounded-md px-4 py-3">{error}</p>}

        {saved && (
          <div className="flex items-center gap-2 text-xs bg-green-50 border border-green-200 rounded-md px-3 py-2">
            <span className="flex-1 text-green-800 font-bold">✓ Saved to {saved.name} - changes here update it</span>
            <button type="button" onClick={() => discard().catch((err) => setError(err?.response?.data?.detail || "Couldn't discard it"))}
              className="font-bold text-red-600 bg-white border border-red-200 rounded-md px-2.5 py-1">
              Discard
            </button>
          </div>
        )}

        <button type="button" onClick={save} className="btn-primary disabled:opacity-50"
          disabled={submitting || (whose === 'split' && members.length === 0)}>
          {submitting
            ? 'Saving…'
            : saved
              ? `Done - open ${saved.name}`
            : whose === 'me'
              ? `Save ${amt > 0 ? inr(amt) : 'expense'} to ${monthLabel(date)}`
              : members.length === 0
                ? 'Add someone to split with'
                : amount !== ''
                  ? `Save ${inr(amt)} expense`
                  : target ? `Open ${target.name}` : 'Just create the group'}
        </button>
      </div>

      {cropFile && (
        <ReceiptCropper file={cropFile} onCancel={() => { setCropFile(null); resetInputs() }} onConfirm={(f) => readBill(f, false)} />
      )}
    </div>
  )
}
