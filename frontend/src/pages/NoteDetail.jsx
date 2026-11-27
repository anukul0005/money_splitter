import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getNote, editNote, deleteNote } from '../api/index.js'
import LoadingSpinner from '../components/LoadingSpinner'
import { useUser } from '../UserContext'
import { ago } from './Discussions'
import NotePeople from '../components/NotePeople'

// The number a cell starts with - "3*" is 3, "₹1,200" is 1200; null if none
const num = (c) => {
  const m = String(c || '').replace(/[₹,\s]/g, '').match(/^-?\d+(\.\d+)?/)
  return m ? Number(m[0]) : null
}
const fmt = (n) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })

/**
 * The note at a glance: how many rows, the total of every column that holds
 * numbers, and the same for each person who added rows.
 */
function Summary({ columns, rows, me }) {
  if (!rows.length) return null
  // A column is a number column when most of its filled cells start with one
  const numeric = columns.map((_, ci) => {
    const filled = rows.map((r) => r.cells[ci]).filter((c) => String(c || '').trim())
    return filled.length > 0 && filled.filter((c) => num(c) !== null).length >= filled.length * 0.6
  })
  const sums = (rs) => columns.map((_, ci) => (numeric[ci] ? rs.reduce((t, r) => t + (num(r.cells[ci]) || 0), 0) : null))
  const people = {}
  rows.forEach((r) => { const k = r.by || 'Unknown'; (people[k] = people[k] || []).push(r) })
  const byWho = Object.entries(people).sort((a, b) => b[1].length - a[1].length)
  const total = sums(rows)
  const name = (n) => (n.toLowerCase() === (me || '').toLowerCase() ? 'You' : n)
  return (
    <div className="card max-w-2xl">
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <div>
          <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Rows</p>
          <p className="text-2xl font-black text-gray-900">{rows.length}</p>
        </div>
        {columns.map((c, ci) => total[ci] !== null && (
          <div key={c}>
            <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Total {c}</p>
            <p className="text-2xl font-black text-gray-900">{fmt(total[ci])}</p>
          </div>
        ))}
      </div>
      <table className="w-full text-xs mt-3">
        <thead>
          <tr className="text-[10px] text-gray-400 uppercase tracking-widest">
            <th className="text-left font-black pb-1">Added by</th>
            <th className="text-right font-black pb-1">Rows</th>
            {columns.map((c, ci) => numeric[ci] && <th key={c} className="text-right font-black pb-1 pl-3">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {byWho.map(([who, rs]) => {
            const s2 = sums(rs)
            return (
              <tr key={who} className="border-t border-amber-100">
                <td className="py-1.5 font-bold text-gray-800">{name(who)}</td>
                <td className="py-1.5 text-right font-black text-gray-900">{rs.length}</td>
                {columns.map((c, ci) => numeric[ci] && <td key={c} className="py-1.5 text-right font-black text-gray-900 pl-3">{fmt(s2[ci])}</td>)}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * A note: a table with the columns its owner named. Cells save as you leave
 * them; columns can be added, renamed and removed.
 */
export default function NoteDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const user = useUser()
  const [note, setNote] = useState(null)
  const [rows, setRows] = useState([])
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [editCols, setEditCols] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [cols, setCols] = useState([])
  const [newCol, setNewCol] = useState('')
  const [title, setTitle] = useState('')
  const [q, setQ] = useState('')
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  const [people, setPeople] = useState([])
  const take = (n) => { setNote(n); setRows(n.rows); setCols(n.columns); setTitle(n.title); setPeople(n.people || []); setDirty(false) }
  useEffect(() => {
    getNote(id).then((r) => take(r.data)).catch(() => setErr("Couldn't open this note."))
  }, [id])

  // A save of just the rows keeps what's on screen: the reply mustn't undo
  // typing done while it was on its way
  const save = async (data) => {
    setSaving(true); setErr('')
    if (!data.columns) setDirty(false)
    try {
      const r = await editNote(id, data)
      if (data.columns) take(r.data)
      else setNote(r.data)
      return true
    }
    catch (e) { setErr(e.response?.data?.detail || "Couldn't save - try again."); setDirty(true); return false }
    finally { setSaving(false) }
  }
  const saveRows = () => dirty && save({ rows: rowsRef.current })

  if (err && !note) return <p className="p-6 text-sm text-red-600">{err}</p>
  if (!note) return <LoadingSpinner />

  const setCell = (ri, ci, v) => { setRows((rs) => rs.map((r, i) => (i === ri ? { ...r, cells: r.cells.map((c, j) => (j === ci ? v : c)) } : r))); setDirty(true) }
  // A new row's id is made here, so saves while it's typed into stay one row
  const addRow = () => {
    const next = [...rows, { id: Math.random().toString(36).slice(2, 12), cells: note.columns.map(() => ''), by: user?.name }]
    setRows(next); save({ rows: next })
  }
  const delRow = (ri) => { const next = rows.filter((_, i) => i !== ri); setRows(next); save({ rows: next }) }
  const needle = q.trim().toLowerCase()
  const shown = rows.map((r, i) => [r, i]).filter(([r]) => !needle || [...r.cells, r.by || ''].some((c) => c.toLowerCase().includes(needle)))
  const mine = note.owner.toLowerCase() === user?.name?.toLowerCase()
  // a row is only ever edited by whoever added it
  const isMine = (r) => (r.by || '').toLowerCase() === (user?.name || '').toLowerCase()

  const saveCols = async () => {
    const add = newCol.trim()
    const next = add ? [...cols, add] : cols
    // keep each row's cells under the column they belong to
    const idx = next.map((c) => note.columns.indexOf(c))
    const remapped = rows.map((r) => ({ ...r, cells: idx.map((k) => (k >= 0 ? r.cells[k] : '')) }))
    if (await save({ title, columns: next, rows: remapped })) { setEditCols(false); setNewCol('') }
  }
  const saveSharing = async () => { if (await save({ people: people.map((p) => p.name) })) setSharing(false) }

  return (
    <div className="pb-24 md:pb-8">
      <div className="bg-gradient-to-br from-field-800 to-field-950 text-white px-5 pt-10 md:pt-8 pb-5 border-b border-field-700">
        <button onClick={() => nav('/discuss')} className="text-slate-300/70 text-xs font-bold">‹ Discussions & notes</button>
        <h1 className="text-2xl font-black mt-2 tracking-tight break-words">{note.title}</h1>
        <p className="text-slate-300/70 text-xs mt-1">
          {note.people?.length ? `With ${note.people.map((p) => p.name).join(', ')}` : note.group ? `Shared with ${note.group}` : 'Only you'}
          {!mine && ` · ${note.owner}'s`} · {rows.length} row{rows.length === 1 ? '' : 's'}
          {note.updated_at ? ` · edited ${ago(note.updated_at)}${note.updated_by && note.updated_by !== user?.name ? ` by ${note.updated_by}` : ''}` : ''}
        </p>
        <div className="flex gap-4 mt-3 text-[11px] font-bold">
          <button onClick={() => { setEditCols((v) => !v); setSharing(false) }} className="text-brand-300 hover:text-white">{editCols ? 'Close' : 'Edit columns & name'}</button>
          {mine && (
            <button onClick={() => { setSharing((v) => !v); setEditCols(false); setPeople(note.people || []) }}
              className="text-brand-300 hover:text-white">{sharing ? 'Close' : 'Who can see it'}</button>
          )}
          {mine && (
            <button onClick={async () => { if (window.confirm('Delete this note and everything in it?')) { await deleteNote(id); nav('/discuss') } }}
              className="text-red-300 hover:text-white">Delete note</button>
          )}
        </div>
      </div>

      <div className="px-4 md:px-5 mt-4 space-y-3">
        {editCols && (
          <div className="card space-y-2 max-w-2xl">
            <label className="block text-[11px] font-bold text-gray-600">Name
              <input value={title} onChange={(e) => setTitle(e.target.value)} className="input text-sm mt-1" />
            </label>
            <p className="text-[11px] font-bold text-gray-600">Columns</p>
            {cols.map((c, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input value={c} onChange={(e) => setCols((cs) => cs.map((x, j) => (j === i ? e.target.value : x)))} className="input text-xs py-1.5 flex-1" />
                <button type="button" disabled={cols.length <= 1}
                  onClick={() => window.confirm(`Remove the "${c}" column and what's in it?`) && setCols((cs) => cs.filter((_, j) => j !== i))}
                  className="text-[11px] font-bold text-red-500 disabled:opacity-30">Remove</button>
              </div>
            ))}
            <input value={newCol} onChange={(e) => setNewCol(e.target.value)} className="input text-xs py-1.5" placeholder="Add a column" />
            <button onClick={saveCols} disabled={saving} className="btn-primary !w-auto text-xs px-4 py-2 disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
          </div>
        )}

        {sharing && mine && (
          <div className="card space-y-2 max-w-2xl">
            <p className="text-xs font-black text-gray-500 uppercase tracking-widest">Who can see it</p>
            <p className="text-[11px] text-gray-500">Add people on the app to let them open and edit it; ✕ takes someone off.</p>
            <NotePeople me={user?.name} people={people} setPeople={setPeople} />
            <div className="flex gap-3 items-center">
              <button onClick={saveSharing} disabled={saving} className="btn-primary !w-auto text-xs px-4 py-2 disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
              <button onClick={() => { setSharing(false); setPeople(note.people || []) }} className="text-xs font-bold text-gray-500">Cancel</button>
            </div>
          </div>
        )}

        <Summary columns={note.columns} rows={rows} me={user?.name} />

        {rows.length > 8 && (
          <input value={q} onChange={(e) => setQ(e.target.value)} className="input text-sm max-w-sm" placeholder="Search the rows" />
        )}

        <div className="overflow-x-auto border border-amber-200 bg-white">
          <table className="text-xs border-collapse min-w-full">
            <thead>
              <tr className="bg-amber-50">
                <th className="w-8 border-b border-amber-200" />
                {note.columns.map((c) => (
                  <th key={c} className="text-left font-black text-gray-700 px-2 py-2 border-b border-l border-amber-200 whitespace-nowrap">{c}</th>
                ))}
                <th className="text-left font-black text-gray-400 px-2 py-2 border-b border-l border-amber-200 whitespace-nowrap">Added by</th>
                <th className="w-8 border-b border-amber-200" />
              </tr>
            </thead>
            <tbody>
              {shown.map(([r, ri]) => (
                <tr key={r.id || ri} className="border-b border-amber-100 last:border-0">
                  <td className="text-[10px] text-gray-400 text-center align-top pt-2">{ri + 1}</td>
                  {note.columns.map((c, ci) => (
                    <td key={c} className="border-l border-amber-100 p-0 align-top">
                      <textarea rows={1} value={r.cells[ci] ?? ''} readOnly={!isMine(r)} onChange={(e) => setCell(ri, ci, e.target.value)} onBlur={saveRows}
                        className={`w-full min-w-[8rem] px-2 py-1.5 text-xs bg-transparent resize-y focus:outline-none ${isMine(r) ? "focus:bg-amber-50" : "text-gray-600 cursor-default"}`} />
                    </td>
                  ))}
                  <td className="border-l border-amber-100 px-2 py-1.5 align-top text-[11px] text-gray-500 whitespace-nowrap">
                    {r.by?.toLowerCase() === user?.name?.toLowerCase() ? 'You' : r.by}
                  </td>
                  <td className="text-center align-top pt-1.5">
                    {isMine(r) && <button onClick={() => window.confirm(`Delete row ${ri + 1}?`) && delRow(ri)} className="text-gray-300 hover:text-red-600 px-1" aria-label={`Delete row ${ri + 1}`}>✕</button>}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={note.columns.length + 3} className="text-center text-gray-400 py-6">No rows yet - add the first one.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={addRow} className="text-xs font-bold text-brand-600">+ Add row</button>
          <span className="text-[10px] text-gray-400">{saving ? 'Saving…' : dirty ? 'Unsaved - tap outside the cell' : 'Saved'}</span>
          {err && <span className="text-[11px] text-red-600">{err}</span>}
        </div>
      </div>
    </div>
  )
}
