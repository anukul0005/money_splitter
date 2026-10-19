import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getGroup, readLedgerPage, saveLedgerPage } from '../api'

const INR = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const today = () => new Date().toISOString().slice(0, 10)
const isLatin = (s) => /^[\x00-\x7F]*$/.test(s || '')
// "Saree (साड़ी)" - the English the page reader gave, with what was written.
const defaultTitle = (r) => (isLatin(r.item) || r.item_en === r.item ? r.item : `${r.item_en} (${r.item})`)

/**
 * A photographed notebook page of shared spending -> reviewed -> saved as
 * expenses, each with every person's share (backend routers/ledger.py).
 * Nobody owes anybody from these: each share is what that person spent.
 */
export default function LedgerImport() {
  const { id } = useParams()
  const nav = useNavigate()
  const cameraRef = useRef(null)
  const galleryRef = useRef(null)
  const [group, setGroup]     = useState(null)
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState('')
  const [page, setPage]       = useState(null)     // what the reader returned
  const [mapping, setMapping] = useState({})       // column -> member ('' = skip)
  const [rows, setRows]       = useState([])       // [{ title, read_as, total, shares: {column: amount}, notes }]
  const [date, setDate]       = useState(today())

  useEffect(() => { getGroup(id).then((r) => setGroup(r.data)).catch(() => {}) }, [id])

  const read = async (file) => {
    if (!file) return
    setBusy(true); setError(''); setPage(null)
    try {
      // Sent as taken: the server scales it to what the reader reads best -
      // squeezing it here first loses handwriting detail.
      const { data } = await readLedgerPage(id, file)
      if (data.kind === 'bill') {
        // A printed bill, not a notebook page: one expense, filled in on
        // the ordinary form, where who paid and how it splits are chosen.
        nav(`/add?group=${id}`, { state: { bill: data } })
        return
      }
      setPage(data)
      setMapping(Object.fromEntries(data.share_columns.map((c) => [c, data.mapping[c] || ''])))
      setRows(data.rows.map((r) => ({
        title: defaultTitle(r), read_as: r.item, total: r.total ?? '',
        shares: Object.fromEntries(data.share_columns.map((c) => [c, r.shares[c] ?? 0])), notes: r.notes,
      })))
    } catch (err) {
      setError(err.response?.data?.detail || "Couldn't read that page.")
    } finally {
      setBusy(false)
      if (cameraRef.current) cameraRef.current.value = ''
      if (galleryRef.current) galleryRef.current.value = ''
    }
  }

  const cols = page?.share_columns ?? []
  const num = (v) => (v === '' || v == null ? 0 : Number(v))
  const sumOf = (r) => cols.reduce((s, c) => s + (mapping[c] ? num(r.shares[c]) : 0), 0)
  const rowOk = (r) => r.title.trim() && num(r.total) > 0 && Math.abs(sumOf(r) - num(r.total)) <= 1
  const setRow = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch, notes: [] } : r)))
  const setShare = (i, c, v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, shares: { ...r.shares, [c]: v }, notes: [] } : r)))
  const unmapped = cols.filter((c) => !mapping[c] && rows.some((r) => num(r.shares[c]) > 0))
  const dupMember = Object.values(mapping).filter(Boolean).length !== new Set(Object.values(mapping).filter(Boolean)).size
  const allOk = rows.length > 0 && rows.every(rowOk) && !unmapped.length && !dupMember
  const grand = rows.reduce((s, r) => s + num(r.total), 0)

  const save = async () => {
    setBusy(true); setError('')
    try {
      await saveLedgerPage({
        group_id: Number(id), date,
        columns: Object.fromEntries(Object.entries(mapping).filter(([, m]) => m)),
        rows: rows.map((r, i) => ({
          title: r.title.trim(), total: num(r.total),
          shares: Object.fromEntries(cols.filter((c) => mapping[c] && num(r.shares[c]) > 0).map((c) => [mapping[c], num(r.shares[c])])),
          // what the page reader made of it, when the person changed it - the reader learns from these
          read_as: page.rows[i] && r.title.trim() !== defaultTitle(page.rows[i]) ? page.rows[i].item : null,
        })),
      })
      nav(`/groups/${id}`)
    } catch (err) {
      setError(err.response?.data?.detail || "Couldn't save these.")
      setBusy(false)
    }
  }

  return (
    <div className="pb-28 md:pb-10">
      <div className="px-5 pt-10 md:pt-6 pb-4 bg-cream border-b border-amber-100/60 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => nav(-1)} className="btn-ghost" aria-label="Back">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="min-w-0">
            <h1 className="text-xl font-bold">Notebook page</h1>
            <p className="text-[11px] text-gray-400 mt-0.5 truncate">{group?.name} · each row becomes an expense with everyone's share</p>
          </div>
        </div>
      </div>

      <div className="px-5 mt-5 space-y-4 max-w-2xl">
        {!page && (
          <div className="card space-y-3">
            <p className="text-sm text-gray-700">
              Photograph a handwritten page of expenses - Hindi or English, an amount column per person.
              You'll check every row before anything is saved. A printed bill works too: it opens as one
              expense to split.
            </p>
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => cameraRef.current?.click()} className="btn-primary text-[11.9px] disabled:opacity-50">
                📷 Take photo
              </button>
              <button type="button" disabled={busy} onClick={() => galleryRef.current?.click()}
                className="w-full py-3 text-[11.9px] font-bold text-gray-700 bg-white border border-amber-300 rounded-md disabled:opacity-50">
                🖼️ From gallery
              </button>
            </div>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => read(e.target.files?.[0])} />
            <input ref={galleryRef} type="file" accept="image/*" className="hidden" onChange={(e) => read(e.target.files?.[0])} />
            {busy && <p className="text-xs text-gray-500">Reading the page… this takes a few seconds.</p>}
          </div>
        )}

        {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-4 py-3">{error}</p>}

        {page && (
          <>
            <div className="card space-y-3">
              {page.title && <p className="text-xs text-gray-500">Page: <b className="text-gray-800">{page.title}</b></p>}
              <div>
                <label htmlFor="ledger-date" className="label">Date of these expenses</label>
                <input id="ledger-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div>
                <p className="label">Whose is each column?</p>
                <div className="space-y-2">
                  {cols.map((c) => (
                    <div key={c} className="flex items-center gap-3">
                      <span className="w-12 text-sm font-black text-gray-800 text-center bg-amber-50 border border-amber-200 rounded-md py-1.5">{c}</span>
                      <select className="input flex-1" value={mapping[c]} onChange={(e) => setMapping((m) => ({ ...m, [c]: e.target.value }))}>
                        <option value="">Not a person - skip</option>
                        {page.members.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
                {page.total_column && <p className="text-[11px] text-gray-400 mt-1.5">Column {page.total_column} is the row total.</p>}
                {dupMember && <p className="text-xs text-red-600 mt-1">Two columns are set to the same person.</p>}
              </div>
            </div>

            {rows.map((r, i) => {
              const ok = rowOk(r)
              return (
                <div key={i} className={`card space-y-2 border ${ok ? 'border-transparent' : 'border-amber-400'}`}>
                  <div className="flex items-start gap-2">
                    <input className="input flex-1 font-semibold" value={r.title} aria-label="Description"
                      onChange={(e) => setRow(i, { title: e.target.value })} />
                    <button type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                      className="text-gray-400 hover:text-red-500 px-2 py-2.5" aria-label="Remove row">✕</button>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <label className="text-[11px] font-semibold text-gray-500">Total
                      <input className="input mt-0.5 font-bold" inputMode="decimal" value={r.total}
                        onChange={(e) => setRow(i, { total: e.target.value.replace(/[^\d.]/g, '') })} />
                    </label>
                    {cols.filter((c) => mapping[c]).map((c) => (
                      <label key={c} className="text-[11px] font-semibold text-gray-500">{mapping[c]} ({c})
                        <input className="input mt-0.5" inputMode="decimal" value={r.shares[c] ?? ''}
                          onChange={(e) => setShare(i, c, e.target.value.replace(/[^\d.]/g, ''))} />
                      </label>
                    ))}
                  </div>
                  <p className={`text-[11px] font-bold ${ok ? 'text-green-700' : 'text-amber-700'}`}>
                    {ok ? '✓ Shares add up' : `⚠ Shares add up to ${INR(sumOf(r))}, total is ${INR(num(r.total))}`}
                  </p>
                  {r.notes?.length > 0 && <p className="text-[10px] text-gray-400">{r.notes.join(' · ')}</p>}
                </div>
              )
            })}

            <button type="button" onClick={() => setRows((rs) => [...rs, { title: '', read_as: null, total: '', shares: Object.fromEntries(cols.map((c) => [c, 0])), notes: [] }])}
              className="w-full py-2.5 text-xs font-bold text-gray-600 bg-white border border-dashed border-amber-300 rounded-md">
              + Add a row
            </button>

            <button type="button" onClick={save} disabled={busy || !allOk} className="btn-primary disabled:opacity-50">
              {busy ? 'Saving…' : `Save ${rows.length} expense${rows.length === 1 ? '' : 's'} · ${INR(grand)}`}
            </button>
            <button type="button" onClick={() => { setPage(null); setRows([]) }} className="w-full text-xs font-bold text-gray-500 py-2">
              Read a different photo
            </button>
          </>
        )}
      </div>
    </div>
  )
}
