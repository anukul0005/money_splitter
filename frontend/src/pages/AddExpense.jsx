import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getGroups, createExpense, scanReceipt, importStatement } from '../api'
import LoadingSpinner from '../components/LoadingSpinner'
import ReceiptCropper from '../components/ReceiptCropper'
import { useUser } from '../UserContext'

const CATEGORIES = [
  'Food','Drinks','Snacks','Travel - Cab','Travel - Train',
  'Hotel','Movie','Shopping','Groceries','Other',
]

const PAYMENT_MODES = [
  { value: 'cash',        label: 'Cash' },
  { value: 'upi',         label: 'UPI' },
  { value: 'credit_card', label: 'Credit Card' },
  { value: 'debit_card',  label: 'Debit Card' },
]

const STORED_GROUP_KEY   = 'splitter_last_group'
const STORED_PAYMENT_KEY = 'splitter_last_payment_mode'

export default function AddExpense() {
  const nav = useNavigate()
  const user = useUser()
  const [params] = useSearchParams()
  const urlGroup     = params.get('group') || ''
  // Arriving from a master group's "+ Add": the title is asked for up front
  const askTitle     = params.get('ask') === 'title'
  const defaultGroup = urlGroup || localStorage.getItem(STORED_GROUP_KEY) || ''
  const defaultPayment = localStorage.getItem(STORED_PAYMENT_KEY) || 'cash'

  const [groups, setGroups]               = useState([])
  const [loading, setLoading]             = useState(true)
  const [submitting, setSubmitting]       = useState(false)
  const [error, setError]                 = useState('')
  const [successCount, setSuccessCount]   = useState(0)
  const [members, setMembers]             = useState([])
  const [existingTitles, setExistingTitles] = useState([])

  // ── Receipt scan ──
  const [scanBusy, setScanBusy]   = useState(false)
  const [scanError, setScanError] = useState('')
  const [scanInfo, setScanInfo]   = useState(null)   // { provider, confidence } of the last successful scan
  const [cropFile, setCropFile]   = useState(null)   // photo awaiting the crop step, before it's sent to OCR
  const [csvBusy, setCsvBusy]     = useState(false)
  const [csvError, setCsvError]   = useState('')
  const [csvResult, setCsvResult] = useState(null)
  const csvInputRef     = useRef(null)
  const cameraInputRef  = useRef(null)
  const galleryInputRef = useRef(null)

  // Split mode state
  const [splitMode, setSplitMode]               = useState('equal')
  const [gentlemanFlipped, setGentlemanFlipped] = useState(false)
  const [customPcts, setCustomPcts]             = useState({})
  const [customAmts, setCustomAmts]             = useState({})
  const [touchedPcts, setTouchedPcts]           = useState({})

  const [form, setForm] = useState({
    group_id:     defaultGroup,
    date:         new Date().toISOString().split('T')[0],
    category:     '',
    title:        '',
    amount:       '',
    paid_by:      '',
    divider:      '',
    notes:        '',
    payment_mode: defaultPayment,
    txn_time:     '',
  })

  const amountRef = useRef(null)

  useEffect(() => {
    getGroups()
      .then((r) => setGroups(r.data))
      .catch(() => setError('Could not reach server. Please try again.'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!form.group_id) { setMembers([]); setExistingTitles([]); return }
    import('../api').then(({ getGroup }) =>
      getGroup(form.group_id).then((r) => {
        const ms = r.data.members || []
        setMembers(ms)
        const autoPaidBy = ms.length === 1 ? ms[0].name : ''
        setForm((f) => ({ ...f, divider: String(ms.length || 2), paid_by: autoPaidBy }))
        setSplitMode('equal')
        setGentlemanFlipped(false)
        setCustomPcts(Object.fromEntries(ms.map((m) => [m.name, ''])))
        setCustomAmts(Object.fromEntries(ms.map((m) => [m.name, ''])))
        setTouchedPcts({})
        const titles = [...new Set((r.data.expenses || []).map((e) => e.title).filter(Boolean))]
        setExistingTitles(titles)
      })
    )
  }, [form.group_id, groups])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const setPaymentMode = (val) => {
    setForm((f) => ({ ...f, payment_mode: val }))
    localStorage.setItem(STORED_PAYMENT_KEY, val)
  }

  const buildSplitJson = () => {
    const amt = parseFloat(form.amount)
    if (!amt) return null

    if (splitMode === 'gentleman' && members.length === 2) {
      const [pct0, pct1] = gentlemanFlipped ? [35, 65] : [65, 35]
      return JSON.stringify({
        [members[0].name]: Math.round(amt * pct0 * 100) / 10000,
        [members[1].name]: Math.round(amt * pct1 * 100) / 10000,
      })
    }

    if (splitMode === 'custom') {
      const obj = {}
      members.forEach((m) => {
        obj[m.name] = Math.round(amt * parseFloat(customPcts[m.name] || 0) * 100) / 10000
      })
      return JSON.stringify(obj)
    }

    return null
  }

  const customTotal = members.reduce((s, m) => s + parseFloat(customPcts[m.name] || 0), 0)

  const r2 = (n) => Math.round(n * 100) / 100

  const onPctChange = (name, pctStr) => {
    const pctNum = parseFloat(pctStr)
    const isEmpty = pctStr === ''
    const newTouched = { ...touchedPcts, [name]: !isEmpty }
    setTouchedPcts(newTouched)

    const memberNames = members.map((m) => m.name)
    const newPcts = { ...customPcts, [name]: pctStr }

    if (!isEmpty && !isNaN(pctNum)) {
      const unlockedNames = memberNames.filter((n) => n !== name && !newTouched[n])
      if (unlockedNames.length > 0) {
        const lockedSum = memberNames
          .filter((n) => n === name || newTouched[n])
          .reduce((s, n) => s + parseFloat(n === name ? pctStr : (customPcts[n] || 0)), 0)
        const share = r2(Math.max(0, (100 - lockedSum) / unlockedNames.length))
        unlockedNames.forEach((n) => { newPcts[n] = String(share) })
      }
    }

    setCustomPcts(newPcts)
    const total = parseFloat(form.amount)
    if (!isNaN(total) && total > 0) {
      const newAmts = { ...customAmts }
      memberNames.forEach((n) => {
        const p = parseFloat(newPcts[n])
        if (!isNaN(p)) newAmts[n] = String(r2(total * p / 100))
      })
      setCustomAmts(newAmts)
    }
  }

  const onAmtChange = (name, amtStr) => {
    const total = parseFloat(form.amount)
    const amtNum = parseFloat(amtStr)
    const isEmpty = amtStr === ''
    const pctNum = (!isEmpty && !isNaN(amtNum) && !isNaN(total) && total > 0)
      ? r2(amtNum / total * 100)
      : NaN
    const pctStr = isNaN(pctNum) ? '' : String(pctNum)

    const newTouched = { ...touchedPcts, [name]: !isEmpty }
    setTouchedPcts(newTouched)

    const memberNames = members.map((m) => m.name)
    const newPcts = { ...customPcts, [name]: pctStr }
    const newAmts = { ...customAmts, [name]: amtStr }

    if (!isEmpty && !isNaN(pctNum) && !isNaN(total) && total > 0) {
      const unlockedNames = memberNames.filter((n) => n !== name && !newTouched[n])
      if (unlockedNames.length > 0) {
        const lockedSum = memberNames
          .filter((n) => n === name || newTouched[n])
          .reduce((s, n) => s + parseFloat(n === name ? pctStr : (customPcts[n] || 0)), 0)
        const share = r2(Math.max(0, (100 - lockedSum) / unlockedNames.length))
        unlockedNames.forEach((n) => {
          newPcts[n] = String(share)
          newAmts[n] = String(r2(total * share / 100))
        })
      }
    }

    setCustomPcts(newPcts)
    setCustomAmts(newAmts)
  }

  // Keyword → category. Deliberately just a guess the person can change -
  // nowhere near as reliable as the confidence-scored merchant/total/items
  // themselves, so it only ever pre-selects a category button rather than
  // silently deciding one.
  //
  // Checked against the merchant name ALONE first, item labels only as a
  // fallback when the merchant gives no match - a merchant line is what
  // OCR usually reads most cleanly (biggest text, top of the receipt), and
  // folding every item label into the same search let one garbled word in
  // a noisy line item ("...st0re..." from a misread character) outrank an
  // otherwise-clear merchant name. Word-boundaried (\b...\b) for the same
  // reason: "store" and "mall" are short enough to turn up as a substring
  // of unrelated OCR noise if left unanchored.
  const CATEGORY_RULES = [
    [/\b(uber|ola|cab|taxi)\b/, 'Travel - Cab'],
    [/\b(irctc|railway|train)\b/, 'Travel - Train'],
    [/\b(hotel|resort|inn|lodge)\b/, 'Hotel'],
    [/\b(cinema|pvr|inox|multiplex|movie)\b/, 'Movie'],
    [/\b(mart|supermarket|grocery|grocer|bigbasket|dmart|kirana)\b/, 'Groceries'],
    [/\b(bar|pub|wine|liquor|beer|brewery)\b/, 'Drinks'],
    [/\b(mall|store|showroom|boutique|apparel)\b/, 'Shopping'],
    [/\b(cafe|restaurant|grill|kitchen|dhaba|biryani|pizza|diner|food)\b/, 'Food'],
  ]
  const guessCategory = (merchant, items) => {
    const fromText = (text) => {
      const lower = (text || '').toLowerCase()
      const hit = CATEGORY_RULES.find(([re]) => re.test(lower))
      return hit ? hit[1] : ''
    }
    return fromText(merchant) || fromText((items || []).map((i) => i.label).join(' '))
  }

  // A phone camera photo is routinely 3-8 MB; OCR.space's free tier
  // rejects anything over 1 MB with a 413. Downscaled and re-encoded as
  // JPEG here rather than sent as-is - a receipt is flat text on a plain
  // background, so 1600px on the long edge loses nothing OCR needs while
  // getting comfortably under every provider's limit. Quality steps down
  // further only if the first pass still isn't small enough.
  const compressImage = (file) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const maxDim = 1600
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)

      const tryQuality = (quality) => {
        canvas.toBlob((blob) => {
          if (!blob) return reject(new Error('Could not process that image'))
          if (blob.size > 900_000 && quality > 0.3) {
            tryQuality(quality - 0.15)
          } else {
            resolve(new File([blob], 'receipt.jpg', { type: 'image/jpeg' }))
          }
        }, 'image/jpeg', quality)
      }
      tryQuality(0.75)
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')) }
    img.src = url
  })

  const resetFileInputs = () => {
    if (cameraInputRef.current) cameraInputRef.current.value = ''
    if (galleryInputRef.current) galleryInputRef.current.value = ''
  }

  // A photo picked from the camera or gallery goes through the crop step
  // first (ReceiptCropper) - only the cropped result is ever sent to OCR.
  const onFilePicked = (file) => { if (file) setCropFile(file) }

  const handleCropCancel = () => { setCropFile(null); resetFileInputs() }

  const handleCsv = async (file) => {
    if (!file) return
    setCsvError(''); setCsvResult(null); setCsvBusy(true)
    try {
      const res = await importStatement(file)
      setCsvResult(res.data)
    } catch (err) {
      setCsvError(err.response?.data?.detail || 'Could not import that file.')
    } finally {
      setCsvBusy(false)
      if (csvInputRef.current) csvInputRef.current.value = ''
    }
  }

  const handleScan = async (file) => {
    setCropFile(null)
    setScanError(''); setScanInfo(null)
    setScanBusy(true)
    try {
      const compressed = await compressImage(file)
      const res = await scanReceipt(compressed)
      const { merchant, date, items, total, category: llmCategory, confidence, provider, raw_text, extraction_method } = res.data
      // Below the threshold /receipts/scan itself uses to accept a read
      // (see CONFIDENCE_THRESHOLD in routers/receipts.py), the merchant
      // name is exactly as unreliable as everything else in the OCR text -
      // a category guessed from it is compounding one shaky read on top of
      // another, so it's better left blank for a manual pick than silently
      // wrong. The LLM path (extraction_method "llm") judges the category
      // itself, from the merchant AND the actual items - "Spicy Tokyo
      // Ramen" reads as Food to it even when the merchant's own name has
      // a word like "store" in it, which the keyword-only guessCategory
      // below can't tell apart. Preferred over the keyword guess whenever
      // it's present.
      const category = confidence < 85 ? '' : (llmCategory || guessCategory(merchant, items))
      // The title is just who the money went to - what was actually
      // bought reads better as a note alongside it than crowding the
      // same field.
      const itemNote = (items || []).map((i) => i.label).filter(Boolean).join(', ')
      setForm((f) => ({
        ...f,
        title:    merchant || f.title,
        amount:   total != null ? String(total) : f.amount,
        date:     date || f.date,
        category: category || f.category,
        notes:    itemNote || f.notes,
      }))
      setScanInfo({
        provider, confidence, rawText: raw_text, extractionMethod: extraction_method,
        extracted: { merchant, date, items, total, category: llmCategory },
      })
    } catch (err) {
      setScanError(err.response?.data?.detail || 'Could not read that receipt. Try a clearer photo, or enter it manually.')
    } finally {
      setScanBusy(false)
      resetFileInputs()
    }
  }

  const resetExpenseFields = (gid) => {
    setForm((prev) => ({
      group_id:     gid,
      date:         prev.date,          // persist the selected date
      category:     '',
      title:        '',
      amount:       '',
      paid_by:      members.length === 1 ? members[0].name : '',
      divider:      String(members.length || 2),
      notes:        '',
      payment_mode: prev.payment_mode,  // persist the payment mode
      txn_time:     '',
    }))
    setSplitMode('equal')
    setGentlemanFlipped(false)
    setCustomPcts(Object.fromEntries(members.map((m) => [m.name, ''])))
    setCustomAmts(Object.fromEntries(members.map((m) => [m.name, ''])))
    setTouchedPcts({})
    setTimeout(() => amountRef.current?.focus(), 50)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (!form.group_id) return setError('Please select a group')
    if (askTitle && !form.title.trim()) return setError('Enter a title for this expense')
    if (!form.amount || isNaN(form.amount)) return setError('Enter a valid amount')
    if (!form.paid_by) return setError('Select who paid')
    if (splitMode === 'custom' && Math.abs(customTotal - 100) > 0.5)
      return setError('Custom percentages must add up to 100%')

    setSubmitting(true)
    try {
      await createExpense({
        group_id:     Number(form.group_id),
        date:         form.date || null,
        category:     form.category || null,
        title:        form.title || null,
        amount:       parseFloat(form.amount),
        paid_by:      form.paid_by,
        divider:      splitMode === 'equal' ? (Number(form.divider) || members.length || 2) : members.length,
        notes:        form.notes || null,
        split_json:   buildSplitJson(),
        payment_mode: form.payment_mode || null,
        txn_time:     form.txn_time || null,
        recorded_by:  user?.name || null,
      })
      localStorage.setItem(STORED_GROUP_KEY, form.group_id)
      setSuccessCount((n) => n + 1)
      resetExpenseFields(form.group_id)
    } catch (err) {
      setError(err?.response?.data?.detail || 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <LoadingSpinner text="Loading groups…" />

  const userGroups = groups.filter((g) =>
    (g.member_names ?? []).some((n) => n.toLowerCase() === user?.name?.toLowerCase())
  )
  const selectedGroup = groups.find((g) => String(g.id) === String(form.group_id))
  const isMonthly = !!selectedGroup?.name?.toUpperCase().startsWith('MONTHLY EXPENSES')

  return (
    <div className="pb-28 md:pb-10">
      {/* Header */}
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream border-b border-amber-100/60 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => nav(form.group_id ? `/groups/${form.group_id}` : -1)} className="btn-ghost">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold">Add Expense</h1>
            {selectedGroup && (
              <p className="text-xs text-brand-600 font-semibold mt-0.5">{selectedGroup.name}</p>
            )}
          </div>
          {successCount > 0 && (
            <span className="text-xs font-black text-brand-600 bg-brand-400/10 border border-brand-400/20 rounded-md px-2.5 py-1">
              {successCount} added
            </span>
          )}
        </div>
      </div>

      {/* Success banner */}
      {successCount > 0 && (
        <div className="mx-5 mt-4 bg-brand-400/10 border border-brand-400/30 rounded-md px-4 py-2.5 flex items-center justify-between">
          <p className="text-sm font-bold text-brand-700">Expense saved. Add another below.</p>
          <button
            className="text-xs font-black text-brand-600 underline"
            onClick={() => nav(`/groups/${form.group_id}`)}
          >
            Done
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="px-5 mt-5 space-y-4 max-w-2xl">
        {/* Group */}
        <div>
          <div className="flex items-center justify-between">
            <label className="label">Group *</label>
            {/* The expense you're entering may not have a group yet */}
            <button
              type="button"
              onClick={() => nav('/groups/new')}
              className="text-[11px] font-bold text-brand-600 hover:text-brand-700 mb-1.5"
            >
              + New group
            </button>
          </div>
          <select className="input" value={form.group_id} onChange={set('group_id')}>
            <option value="">Select a group…</option>
            {userGroups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </div>

        {/* Scan a receipt — pre-fills amount/title/date/category below,
            nothing here is saved until "Add Expense" is pressed. */}
        {form.group_id && (
          <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3">
            <p className="text-xs font-bold text-gray-700 mb-2">Scan a receipt</p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={scanBusy}
                onClick={() => cameraInputRef.current?.click()}
                className="flex-1 py-2.5 text-xs font-bold text-gray-700 bg-white border border-amber-300 rounded-md hover:bg-amber-100 active:scale-[0.98] transition-all disabled:opacity-50"
              >
                📷 Take photo
              </button>
              <button
                type="button"
                disabled={scanBusy}
                onClick={() => galleryInputRef.current?.click()}
                className="flex-1 py-2.5 text-xs font-bold text-gray-700 bg-white border border-amber-300 rounded-md hover:bg-amber-100 active:scale-[0.98] transition-all disabled:opacity-50"
              >
                🖼️ Choose from gallery
              </button>
            </div>
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => onFilePicked(e.target.files?.[0])}
            />
            <input
              ref={galleryInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => onFilePicked(e.target.files?.[0])}
            />

            {isMonthly && (
              <>
                <button
                  type="button"
                  disabled={csvBusy}
                  onClick={() => csvInputRef.current?.click()}
                  className="w-full mt-2 py-2.5 text-xs font-bold text-gray-700 bg-white border border-amber-300 rounded-md hover:bg-amber-100 active:scale-[0.98] transition-all disabled:opacity-50"
                >
                  📄 Upload PhonePe statement (.csv)
                </button>
                <input
                  ref={csvInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => handleCsv(e.target.files?.[0])}
                />
                {csvBusy && <p className="text-xs text-gray-500 mt-2">Importing statement…</p>}
                {csvError && <p className="text-xs text-red-600 mt-2">{csvError}</p>}
                {csvResult && !csvBusy && (
                  <div className="text-xs text-brand-700 mt-2 space-y-0.5">
                    <p className="font-bold">✓ Statement imported into your monthly groups</p>
                    <p>{csvResult.created} added · {csvResult.merged} merged with existing entries</p>
                    <p className="text-gray-500">
                      {csvResult.skipped_transactions_on_accounted_dates} skipped (dates already in your groups)
                      {csvResult.skipped_already_imported > 0 && ` · ${csvResult.skipped_already_imported} already imported`}
                      {` · ${csvResult.credits_ignored} received payments ignored`}
                    </p>
                    {csvResult.groups_created?.length > 0 && (
                      <p className="text-gray-500">New groups: {csvResult.groups_created.join(', ')}</p>
                    )}
                  </div>
                )}
              </>
            )}

            {scanBusy && <p className="text-xs text-gray-500 mt-2">Reading the receipt…</p>}
            {scanError && <p className="text-xs text-red-600 mt-2">{scanError}</p>}
            {scanInfo && !scanBusy && (
              <>
                <p className={`text-xs mt-2 ${scanInfo.confidence >= 85 ? 'text-brand-700' : 'text-amber-700 font-bold'}`}>
                  {scanInfo.confidence >= 85 ? '✓' : '⚠️'} Filled in below from {scanInfo.provider}
                  {scanInfo.extractionMethod === 'llm' ? ' + AI parsing' : ''} ({scanInfo.confidence}% confidence)
                  {scanInfo.confidence >= 85 ? ' — check it before saving.' : ' — this read is shaky, double-check every field before saving.'}
                </p>
                {/* The LLM path already turned the noisy raw text into a
                    structured guess - showing that guess is more useful
                    for checking the scan than the raw text it came from.
                    The regex path has no such summary, so it falls back
                    to showing what OCR actually read. */}
                {scanInfo.extractionMethod === 'llm' && scanInfo.extracted ? (
                  <details className="mt-1.5">
                    <summary className="text-[11px] text-gray-500 font-bold cursor-pointer">What was extracted</summary>
                    <div className="text-[10px] text-gray-600 bg-white border border-amber-200 rounded-md p-2 mt-1 space-y-1">
                      <p><span className="font-bold">Merchant:</span> {scanInfo.extracted.merchant || '—'}</p>
                      <p><span className="font-bold">Date:</span> {scanInfo.extracted.date || '—'}</p>
                      <p><span className="font-bold">Category:</span> {scanInfo.extracted.category || '—'}</p>
                      {scanInfo.extracted.items?.length > 0 && (
                        <div>
                          <span className="font-bold">Items:</span>
                          <ul className="list-disc list-inside">
                            {scanInfo.extracted.items.map((it, i) => (
                              <li key={i}>{it.label} — ₹{it.amount}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <p><span className="font-bold">Total:</span> {scanInfo.extracted.total != null ? `₹${scanInfo.extracted.total}` : '—'}</p>
                    </div>
                  </details>
                ) : scanInfo.rawText && (
                  <details className="mt-1.5">
                    <summary className="text-[11px] text-gray-500 font-bold cursor-pointer">What OCR actually read</summary>
                    <pre className="text-[10px] text-gray-600 bg-white border border-amber-200 rounded-md p-2 mt-1 whitespace-pre-wrap max-h-40 overflow-y-auto">{scanInfo.rawText}</pre>
                  </details>
                )}
              </>
            )}
          </div>
        )}

        {/* Amount */}
        <div>
          <label className="label">Amount (₹) *</label>
          <input
            ref={amountRef}
            className="input text-2xl font-bold"
            type="number"
            placeholder="0"
            min="1"
            step="0.01"
            value={form.amount}
            onChange={set('amount')}
          />
        </div>

        {/* Paid by — hidden for single-member groups (auto-filled) */}
        {members.length !== 1 && (
          <div>
            <label className="label">Paid by *</label>
            {members.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {members.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    onClick={() => setForm((f) => ({ ...f, paid_by: m.name }))}
                    className={`px-4 py-2 text-sm font-bold transition-colors border ${
                      form.paid_by === m.name
                        ? 'bg-brand-400 text-white border-brand-400'
                        : 'bg-amber-50 text-gray-700 border-amber-200'
                    }`}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            ) : (
              <input className="input" placeholder="Name of person who paid" value={form.paid_by} onChange={set('paid_by')} />
            )}
          </div>
        )}

        {/* Payment mode */}
        <div>
          <label className="label">Payment Mode</label>
          <div className="flex gap-2 flex-wrap">
            {PAYMENT_MODES.map((pm) => (
              <button
                type="button"
                key={pm.value}
                onClick={() => setPaymentMode(pm.value)}
                className={`px-3 py-1.5 text-xs font-bold transition-colors border ${
                  form.payment_mode === pm.value
                    ? 'bg-brand-400 text-white border-brand-400'
                    : 'bg-amber-50 text-gray-600 border-amber-200'
                }`}
              >
                {pm.label}
              </button>
            ))}
          </div>
        </div>

        {/* Split section — hidden for single-member groups */}
        {members.length !== 1 && (
        <div>
          <label className="label">Split</label>

          {members.length > 0 && (
            <div className="flex gap-2 flex-wrap mb-3">
              <button
                type="button"
                onClick={() => setSplitMode('equal')}
                className={`px-3 py-1.5 text-xs font-bold transition-colors border ${
                  splitMode === 'equal' ? 'bg-brand-400 text-white border-brand-400' : 'bg-amber-50 text-gray-600 border-amber-200'
                }`}
              >
                Equal
              </button>
              {members.length === 2 && (
                <button
                  type="button"
                  onClick={() => setSplitMode('gentleman')}
                  className={`px-3 py-1.5 text-xs font-bold transition-colors border ${
                    splitMode === 'gentleman' ? 'bg-amber-400 text-white border-amber-400' : 'bg-amber-50 text-gray-600 border-amber-200'
                  }`}
                >
                  Gentleman's (65/35)
                </button>
              )}
              <button
                type="button"
                onClick={() => setSplitMode('custom')}
                className={`px-3 py-1.5 text-xs font-bold transition-colors border ${
                  splitMode === 'custom' ? 'bg-purple-500 text-white border-purple-500' : 'bg-amber-50 text-gray-600 border-amber-200'
                }`}
              >
                Custom %
              </button>
            </div>
          )}

          {/* Equal mode */}
          {splitMode === 'equal' && (
            <>
              <div className="flex gap-2 flex-wrap">
                {[2,3,4,5].map((n) => (
                  <button
                    type="button"
                    key={n}
                    onClick={() => setForm((f) => ({ ...f, divider: String(n) }))}
                    className={`w-12 h-12 text-sm font-bold transition-colors border ${
                      String(form.divider) === String(n)
                        ? 'bg-brand-400 text-white border-brand-400'
                        : 'bg-amber-50 text-gray-700 border-amber-200'
                    }`}
                  >
                    {n}
                  </button>
                ))}
                <input
                  className="input w-20"
                  type="number"
                  min="1"
                  placeholder="Other"
                  value={[2,3,4,5].includes(Number(form.divider)) ? '' : form.divider}
                  onChange={set('divider')}
                />
              </div>
              {form.amount && form.divider && (
                <p className="text-xs text-gray-500 mt-1.5">
                  Each pays: <span className="font-black text-brand-600">₹{(parseFloat(form.amount) / parseInt(form.divider)).toFixed(2)}</span>
                </p>
              )}
            </>
          )}

          {/* Gentleman's mode */}
          {splitMode === 'gentleman' && members.length === 2 && (
            <div className="space-y-2">
              {members.map((m, i) => {
                const pct = gentlemanFlipped ? (i === 0 ? 35 : 65) : (i === 0 ? 65 : 35)
                const amt = form.amount ? (parseFloat(form.amount) * pct / 100).toFixed(2) : null
                return (
                  <div key={m.id} className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-md px-3 py-2.5">
                    <span className="text-sm font-bold text-gray-800 flex-1">{m.name}</span>
                    <span className="text-xs font-black text-amber-700 bg-amber-100 px-2 py-0.5">{pct}%</span>
                    {amt && <span className="text-sm font-black text-gray-900">₹{amt}</span>}
                  </div>
                )
              })}
              <button
                type="button"
                onClick={() => setGentlemanFlipped((f) => !f)}
                className="text-xs text-amber-600 font-bold flex items-center gap-1 mt-1"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" /></svg>
                Swap ratios
              </button>
            </div>
          )}

          {/* Custom split — % and ₹ linked bidirectionally */}
          {splitMode === 'custom' && (
            <div className="space-y-2">
              {members.map((m) => {
                const pct = customPcts[m.name] ?? ''
                const amt = customAmts[m.name] ?? ''
                return (
                  <div key={m.id} className="flex items-center gap-2">
                    <span className="text-sm font-bold text-gray-700 w-20 truncate">{m.name}</span>
                    <div className="relative flex-1">
                      <input
                        type="number" min="0" max="100" step="any"
                        className="input w-full text-right pr-6"
                        placeholder="0"
                        value={pct}
                        onChange={(e) => onPctChange(m.name, e.target.value)}
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 font-bold pointer-events-none">%</span>
                    </div>
                    <div className="relative flex-1">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 font-bold pointer-events-none">₹</span>
                      <input
                        type="number" min="0" step="any"
                        className="input w-full text-right pl-6"
                        placeholder="0"
                        value={amt}
                        onChange={(e) => onAmtChange(m.name, e.target.value)}
                      />
                    </div>
                  </div>
                )
              })}
              <div className={`flex items-center justify-between text-xs font-black pt-1 ${Math.abs(customTotal - 100) <= 0.5 ? 'text-brand-600' : 'text-red-500'}`}>
                <span>{Math.abs(customTotal - 100) <= 0.5 ? '✓ Balanced' : `Total: ${customTotal.toFixed(1)}% — must equal 100%`}</span>
              </div>
            </div>
          )}
        </div>
        )}

        {/* Category */}
        <div>
          <label className="label">Category</label>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <button
                type="button"
                key={c}
                onClick={() => setForm((f) => ({ ...f, category: f.category === c ? '' : c }))}
                className={`px-3 py-1.5 text-xs font-bold transition-colors border ${
                  form.category === c
                    ? 'bg-brand-400 text-white border-brand-400'
                    : 'bg-amber-50 text-gray-600 border-amber-200'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        {/* Title with autocomplete from existing group expenses */}
        <div>
          <label className="label">{askTitle ? 'Title *' : 'Description (optional)'}</label>
          <input
            className="input"
            placeholder="e.g. dinner at Punjab Grill"
            autoFocus={askTitle}
            value={form.title}
            onChange={set('title')}
            list="expense-title-suggestions"
            autoComplete="off"
          />
          {existingTitles.length > 0 && (
            <datalist id="expense-title-suggestions">
              {existingTitles.map((t) => <option key={t} value={t} />)}
            </datalist>
          )}
        </div>

        {/* Date */}
        <div>
          <label className="label">Date</label>
          <input className="input" type="date" value={form.date} onChange={set('date')} />
        </div>

        {/* Time of the transaction - monthly trackers only, optional. Kept
            for later analysis, which groups on the time-of-day bucket the
            server derives from it (00-06, 06-12, 12-18, 18-24). */}
        {isMonthly && (
          <div>
            <label className="label">Time (optional)</label>
            <input className="input" type="time" value={form.txn_time} onChange={set('txn_time')} />
          </div>
        )}

        {/* Notes */}
        <div>
          <label className="label">Notes (optional)</label>
          <textarea className="input resize-none" rows={2} placeholder="Any extra notes…" value={form.notes} onChange={set('notes')} />
        </div>

        {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-4 py-3">{error}</p>}

        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? 'Saving…' : 'Add Expense'}
        </button>
      </form>

      {cropFile && (
        <ReceiptCropper
          file={cropFile}
          onCancel={handleCropCancel}
          onConfirm={handleScan}
        />
      )}
    </div>
  )
}
