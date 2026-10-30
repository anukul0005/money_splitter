import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createExpense, createGroup, getGroup, getGroups, listUsersBasic, scanReceipt } from '../api'
import { useUser } from '../UserContext'
import { buildMasterGroups, pairKey } from '../utils/masterGroups'
import { compressImage } from '../utils/compressImage'
import { dn } from '../utils/displayName'
import ReceiptCropper from '../components/ReceiptCropper'
import DatePicker from '../components/DatePicker'

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
const inr = (n) => `₹${r2(n).toLocaleString('en-IN')}`

/**
 * "+ New Group" - a quick expense: who it's with, then (optionally) the
 * expense itself - read from a receipt photo, a gallery image or a PDF bill,
 * or typed - who paid, and the split (equal among whoever shares it, or
 * custom %). Where it goes follows from the people: today's group with
 * exactly them ("30 oct 26") - opened if it exists, made if not, inside
 * their existing set of groups when there is one. With no amount, only the
 * group is made. Someone on the app is matched to their exact username (two
 * "Ajay"s are told apart by their full names); anyone else is added by the
 * name typed.
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

  // The expense - all optional
  const [amount, setAmount]       = useState('')
  const [title, setTitle]         = useState('')
  const [notes, setNotes]         = useState('')
  const [date, setDate]           = useState(() => new Date().toISOString().split('T')[0])
  const [paidBy, setPaidBy]       = useState(me)
  const [splitMode, setSplitMode] = useState('equal')   // equal | custom
  const [left, setLeft]           = useState([])        // left out of an equal split
  const [pcts, setPcts]           = useState({})        // custom: name -> %
  const [typed, setTyped]         = useState({})        // custom: the %s typed by hand - the rest share what's left
  const [receipt, setReceipt]     = useState(null)
  const [scan, setScan]           = useState({ busy: false, error: '', note: '' })
  const [cropFile, setCropFile]   = useState(null)
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
  const usualCategory = (() => {
    const counts = {}
    existing?.groups.forEach((g) => { if (g.category) counts[g.category] = (counts[g.category] || 0) + 1 })
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'other'
  })()
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
    const nowTyped = { ...typed, [name]: v !== '' }
    const next = { ...pcts, [name]: v }
    const free = everyone.filter((n) => !nowTyped[n])
    const fixed = everyone.filter((n) => nowTyped[n]).reduce((s, n) => s + (parseFloat(next[n]) || 0), 0)
    free.forEach((n) => { next[n] = String(r2(Math.max(0, 100 - fixed) / free.length)) })
    setTyped(nowTyped); setPcts(next)
  }
  const startCustom = () => {
    setSplitMode('custom')
    const even = String(r2(100 / everyone.length))
    setPcts(Object.fromEntries(everyone.map((n) => [n, even]))); setTyped({})
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

  const save = async () => {
    setError('')
    if (!members.length) return setError('Add at least one person.')
    const withExpense = amount !== ''
    if (withExpense) {
      if (!(amt > 0)) return setError('Enter a valid amount.')
      if (!title.trim()) return setError('Add a description - the category is worked out from it.')
      if (splitMode === 'equal' && !sharing.length) return setError('Pick at least one person to share it.')
      if (splitMode === 'custom' && Math.abs(pctTotal - 100) > 0.5) return setError(`The split adds up to ${r2(pctTotal)}% - it needs to be 100%.`)
    } else if (todays) {
      return nav(`/groups/${todays.id}`)
    }
    setSubmitting(true)
    try {
      let gid = todays?.id
      if (!gid) {
        const r = await createGroup({
          name: todayName(), description: '', category: usualCategory, emoji: '',
          members: groupNames, created_by: me,
        })
        gid = r.data.id
      }
      if (withExpense) {
        // Balances match names exactly: use the group's own spelling of each
        const names = ((await getGroup(gid)).data.members || []).map((m) => m.name)
        const canon = (n) => names.find((x) => lc(x) === lc(n)) || n
        const plainEqual = splitMode === 'equal' && sharing.length === everyone.length
        const split = shares(canon)
        await createExpense({
          group_id: Number(gid), date: date || null, title: title.trim(), amount: amt,
          paid_by: canon(paidBy || me),
          divider: plainEqual ? everyone.length : Math.max(1, Object.keys(split).length),
          notes: notes || null,
          split_json: plainEqual ? null : JSON.stringify(split),
          payment_mode: localStorage.getItem('splitter_last_payment_mode') || 'upi',
          receipt_json: receipt ? JSON.stringify(receipt) : null,
          recorded_by: me || null,
        })
      }
      nav(`/groups/${gid}`)
    } catch (err) {
      setError(err?.response?.data?.detail || 'Something went wrong')
      setSubmitting(false)
    }
  }

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
            <p className="text-[11px] text-gray-400 mt-0.5">Who it's with, what it was, how it's split - filed under <b>{todayName()}</b>.</p>
          </div>
        </div>
      </div>

      <div className="px-5 mt-5 space-y-5 max-w-2xl">
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
            {todays
              ? <><b>{existing.name}</b> › today's group, <b>{todays.name}</b></>
              : existing
                ? <><b>{existing.name}</b> ({existing.groups.length} group{existing.groups.length === 1 ? '' : 's'}) › a new group for today, <b>{todayName()}</b></>
                : <>A new group with {everyone.map(label).join(', ')}, named <b>{todayName()}</b></>}
          </div>
        )}

        {members.length > 0 && (
          <>
            {/* Read it from a bill */}
            <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3">
              <p className="text-xs font-bold text-gray-700 mb-2">Fill it in from a bill <span className="font-normal text-gray-400">(optional)</span></p>
              <div className="grid grid-cols-3 gap-2">
                {[['📷', 'Take photo', cameraRef], ['🖼️', 'Gallery', galleryRef], ['📄', 'PDF', pdfRef]].map(([icon, text, ref]) => (
                  <button key={text} type="button" disabled={scan.busy} onClick={() => ref.current?.click()}
                    className="py-2.5 text-xs font-bold text-gray-700 bg-white border border-amber-300 rounded-md hover:bg-amber-100 active:scale-[0.98] transition-all disabled:opacity-50">
                    {icon} {text}
                  </button>
                ))}
              </div>
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
            </div>

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
          </>
        )}

        {error && <p className="text-sm text-red-500 bg-red-50 border border-red-100 rounded-md px-4 py-3">{error}</p>}

        <button type="button" onClick={save} className="btn-primary disabled:opacity-50"
          disabled={submitting || members.length === 0}>
          {submitting
            ? 'Saving…'
            : members.length === 0
              ? 'Add someone to start'
              : amount !== ''
                ? `Save ${inr(amt)} expense`
                : todays ? `Open ${todays.name}` : 'Just create the group'}
        </button>
      </div>

      {cropFile && (
        <ReceiptCropper file={cropFile} onCancel={() => { setCropFile(null); resetInputs() }} onConfirm={(f) => readBill(f, false)} />
      )}
    </div>
  )
}
