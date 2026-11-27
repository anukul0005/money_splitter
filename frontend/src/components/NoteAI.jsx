import { useRef, useState } from 'react'
import { fillNoteRows, noteInsights } from '../api/index.js'
import { useVoice, canRecord } from './useVoice'
import { compressImage } from '../utils/compressImage'

// A picture, made small on the phone, as a data: URL
const asDataUrl = async (file) => {
  const small = await compressImage(file)
  return new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(small) })
}

/**
 * Rows from what you type, paste or say: the AI reads it into the note's
 * columns, you check (and fix) the rows, then add them - as your rows.
 */
export function AddByText({ noteId, columns, onAdd, onClose }) {
  const [text, setText] = useState('')
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [pic, setPic] = useState(null)          // a data: URL
  const fileRef = useRef(null)
  const takePic = async (file) => {
    if (!file || !file.type.startsWith('image/')) return
    setErr('')
    try { setPic(await asDataUrl(file)) } catch { setErr("Couldn't open that picture.") }
  }
  // A screenshot or photo pasted straight into the box
  const onPaste = (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'))
    if (item) { e.preventDefault(); takePic(item.getAsFile()) }
  }
  const read = async (said) => {
    const t = (said ?? text).trim()
    if (!t && !pic) return
    setBusy(true); setErr('')
    try { const { data } = await fillNoteRows(noteId, t, pic); setRows((rs) => [...(rs || []), ...data.rows]); setText(''); setPic(null) }
    catch (e) { setErr(e.response?.data?.detail || "Couldn't read that - try again.") }
    finally { setBusy(false) }
  }
  // Spoken words go straight to the AI; they're kept in the box if it fails
  const voice = useVoice({ onText: (s) => { setText(s); read(s) }, onError: setErr })
  const add = async () => { if (await onAdd(rows)) { setRows(null); onClose() } }

  return (
    <div className="card space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-black text-gray-500 uppercase tracking-widest">Add by typing, speaking or a photo</p>
        <button onClick={onClose} className="text-[11px] font-bold text-gray-500">Close</button>
      </div>
      <p className="text-[11px] text-gray-500">
        Say it, paste it in any order (e.g. <i>"Sharma ji family 4 log, both days; Rohit 2, only Haldi"</i>), or add a
        photo or screenshot - a handwritten list works too. It's filled into the columns for you to check before adding.
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} onPaste={onPaste} rows={3} className="input text-sm"
        placeholder="Type, or paste a list, a WhatsApp message or a screenshot…" disabled={busy || voice.hearing} />
      {pic && (
        <div className="flex items-start gap-2">
          <img src={pic} alt="The picture to read" className="max-h-32 border border-gray-200" />
          <button onClick={() => setPic(null)} className="text-[11px] font-bold text-gray-500">Remove</button>
        </div>
      )}
      <input ref={fileRef} type="file" accept="image/*" className="hidden"
        onChange={(e) => { takePic(e.target.files?.[0]); e.target.value = '' }} />
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => read()} disabled={busy || (!text.trim() && !pic)} className="btn-primary !w-auto text-xs px-4 py-2 disabled:opacity-50">
          {busy ? 'Reading…' : 'Fill the rows'}
        </button>
        <button onClick={() => fileRef.current?.click()} disabled={busy}
          className="text-xs font-bold px-3 py-2 border border-gray-300 text-gray-700 disabled:opacity-50">Photo</button>
        {canRecord() && (
          <button onClick={voice.recording ? voice.stop : voice.start} disabled={busy || voice.hearing}
            className={`text-xs font-bold px-3 py-2 border ${voice.recording ? 'border-red-500 text-red-600 bg-red-50' : 'border-gray-300 text-gray-700'} disabled:opacity-50`}>
            {voice.hearing ? 'Listening back…' : voice.recording ? `Stop · ${voice.seconds}s` : 'Speak'}
          </button>
        )}
        {err && <span className="text-[11px] text-red-600">{err}</span>}
      </div>

      {rows?.length > 0 && (
        <div className="space-y-2 pt-1">
          <p className="text-[11px] font-bold text-gray-600">{rows.length} row{rows.length === 1 ? '' : 's'} to add - fix anything that's off:</p>
          <div className="border border-amber-200 overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead><tr className="bg-amber-50">
                {columns.map((c) => <th key={c} className="text-left font-black text-gray-700 px-2 py-1.5 border-b border-amber-200">{c}</th>)}
                <th className="border-b border-amber-200 w-6" />
              </tr></thead>
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={ri} className="border-b border-amber-100 last:border-0">
                    {columns.map((c, ci) => (
                      <td key={c} className="p-0 border-l first:border-l-0 border-amber-100">
                        <input value={r[ci]} onChange={(e) => setRows((rs) => rs.map((x, i) => (i === ri ? x.map((y, j) => (j === ci ? e.target.value : y)) : x)))}
                          className="w-full min-w-[4rem] px-2 py-1.5 bg-transparent focus:outline-none focus:bg-amber-50" />
                      </td>
                    ))}
                    <td className="text-center">
                      <button onClick={() => setRows((rs) => rs.filter((_, i) => i !== ri))} className="text-gray-300 hover:text-red-600" aria-label="Leave this row out">✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-3 items-center">
            <button onClick={add} className="btn-primary !w-auto text-xs px-4 py-2">Add {rows.length} row{rows.length === 1 ? '' : 's'}</button>
            <button onClick={() => setRows(null)} className="text-xs font-bold text-gray-500">Discard</button>
          </div>
        </div>
      )}
    </div>
  )
}

/** One breakdown as thin horizontal bars, each labelled with its value */
function Bars({ chart }) {
  const max = Math.max(...chart.items.map((i) => i.value), 1)
  const fmt = (n) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
  return (
    <div>
      <p className="text-xs font-black text-gray-800">{chart.title}</p>
      <p className="text-[10px] text-gray-400 mb-1.5">{chart.measure === 'Rows' ? 'Rows' : chart.measure === 'Totals' ? 'Column totals' : `Total ${chart.measure}`}</p>
      <div className="space-y-1">
        {chart.items.map((it) => (
          <div key={it.label} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-2 text-[11px] group" title={`${it.label}: ${fmt(it.value)}`}>
            <span className="break-words leading-tight text-gray-600">{it.label}</span>
            <div className="h-2.5 bg-gray-100">
              <div className="h-full bg-brand-500 group-hover:bg-brand-600 rounded-r" style={{ width: `${Math.max(1.5, (it.value / max) * 100)}%` }} />
            </div>
            <span className="font-bold text-gray-800 tabular-nums">{fmt(it.value)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The AI's read of the table: what it shows, what stands out, breakdowns */
export function Insights({ noteId, rowCount, stamp }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [seen, setSeen] = useState(null)       // the table as it was when read
  const [more, setMore] = useState(false)
  if (rowCount < 2) return null
  const run = async () => {
    setBusy(true); setErr('')
    try { setData((await noteInsights(noteId)).data); setSeen(stamp) }
    catch (e) { setErr(e.response?.data?.detail || "Couldn't get insights - try again.") }
    finally { setBusy(false) }
  }
  return (
    <div className="card max-w-2xl space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-black text-gray-500 uppercase tracking-widest">Insights</p>
        <button onClick={run} disabled={busy} className="text-[11px] font-bold text-brand-600 disabled:opacity-50">
          {busy ? 'Reading the table…' : data ? (seen !== stamp ? 'Table changed - refresh' : 'Refresh') : 'Ask AI what it shows'}
        </button>
      </div>
      {err && <p className="text-[11px] text-red-600">{err}</p>}
      {data && (
        <>
          <button onClick={() => setMore((v) => !v)} className="block w-full text-left" aria-expanded={more}>
            {data.headline && <span className="block text-sm font-bold text-gray-900">{data.headline}</span>}
            {data.points?.length > 0 && (
              <span className="block text-[11px] font-bold text-brand-600 mt-1">
                {more ? 'Hide details ▴' : `${data.points.length} things it noticed ▾`}
              </span>
            )}
          </button>
          {more && data.points?.length > 0 && (
            <ul className="list-disc pl-4 space-y-1 text-xs text-gray-700">
              {data.points.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
          )}
          {data.charts?.length > 0 && (
            <div className="grid md:grid-cols-2 gap-4 pt-1">
              {data.charts.map((c, i) => <Bars key={i} chart={c} />)}
            </div>
          )}
          <p className="text-[10px] text-gray-400">Written by AI from the table - the bars are counted exactly; check the sentences.</p>
        </>
      )}
    </div>
  )
}
