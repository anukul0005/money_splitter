import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { getNote, editNote, deleteNote, noteInviteLink, joinNote, noteLive } from '../api/index.js'
import { downloadNotePdf } from '../utils/notePdf'
import LoadingSpinner from '../components/LoadingSpinner'
import { useUser } from '../UserContext'
import { ago } from './Discussions'
import NotePeople from '../components/NotePeople'
import { AddByText, Insights } from '../components/NoteAI'

// The number a cell starts with - "3*" is 3, "₹1,200" is 1200; null if none
const num = (c) => {
  const m = String(c || '').replace(/[₹,\s]/g, '').match(/^-?\d+(\.\d+)?/)
  return m ? Number(m[0]) : null
}
const fmt = (n) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })

// A heading may break after a comma or slash, not inside a word
const soft = (t) => String(t).replace(/([,/])/g, '$1\u200B')

/** A table cell that grows to show all its text - never a box that scrolls */
function Cell({ value, ...rest }) {
  const ref = useRef(null)
  const fit = () => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }
  useLayoutEffect(fit, [value])
  useEffect(() => { window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit) }, [])
  return <textarea ref={ref} rows={1} value={value} {...rest} />
}

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
  const [colFrom, setColFrom] = useState([])   // each column's place before editing (null: new)
  const [newCol, setNewCol] = useState('')
  const [title, setTitle] = useState('')
  const [q, setQ] = useState('')
  const [aiOpen, setAiOpen] = useState(false)
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  // Live: who else has the note open, and their changes as they're saved
  const [here, setHere] = useState([])
  const [flash, setFlash] = useState(() => new Set())
  const noteRef = useRef(null)
  noteRef.current = note
  const edited = useRef(new Set())     // my rows with typing not yet saved
  const inFlight = useRef(0)           // saves on their way
  const seq = useRef(0)                // saves started
  const focused = useRef(false)        // a cell is being typed in
  const ui = useRef({})
  ui.current = { editCols, sharing, aiOpen, me: (user?.name || '').toLowerCase() }

  const [people, setPeople] = useState([])
  const take = (n) => { setNote(n); setRows(n.rows); setCols(n.columns); setColFrom(n.columns.map((_, i) => i)); setTitle(n.title); setPeople(n.people || []); setDirty(false) }
  const [params, setParams] = useSearchParams()
  const [notice, setNotice] = useState('')
  const [busyTop, setBusyTop] = useState('')
  useEffect(() => {
    (async () => {
      // Opened from an invite link: join the note first (after logging in -
      // the login screen keeps this address), then show it
      const invite = params.get('invite')
      if (invite) {
        try { const { data } = await joinNote(id, invite); if (data.joined) setNotice(`You've been added to ${data.title}.`) }
        catch (e) { setNotice(e.response?.data?.detail || "That invite link didn't work.") }
        setParams((p) => { const n = new URLSearchParams(p); n.delete('invite'); return n }, { replace: true })
      }
      getNote(id).then((r) => take(r.data)).catch(() => setErr("Couldn't open this note - ask its owner for the link."))
    })()
  }, [id])

  // A save of just the rows keeps what's on screen: the reply mustn't undo
  // typing done while it was on its way
  const save = async (data) => {
    setSaving(true); setErr('')
    if (!data.columns) setDirty(false)
    const was = new Set(edited.current)
    edited.current.clear()
    seq.current += 1; inFlight.current += 1
    try {
      const r = await editNote(id, data)
      // the reply carries anyone else's changes too
      if (data.columns) take(r.data)
      else merge(r.data)
      return true
    }
    catch (e) {
      was.forEach((x) => edited.current.add(x))
      setErr(e.response?.data?.detail || "Couldn't save - try again."); setDirty(true); return false
    }
    finally { inFlight.current -= 1; setSaving(false) }
  }

  // The note as saved, folded into what's on screen: everyone's rows as they
  // are now, except my rows with typing not yet saved; others' changes flash
  const merge = (fresh) => {
    const cur = noteRef.current
    if (!cur) return take(fresh)
    const { editCols: ec, sharing: sh, me } = ui.current
    if (JSON.stringify(fresh.columns) !== JSON.stringify(cur.columns)) {
      if (edited.current.size || ec) return            // after my edits are saved
      return take(fresh)
    }
    const local = Object.fromEntries(rowsRef.current.map((r) => [r.id, r]))
    const changed = []
    const next = fresh.rows.map((r) => {
      const l = local[r.id]
      if (l && edited.current.has(r.id)) return l
      if ((r.by || '').toLowerCase() !== me && (!l || l.cells.join('\u0001') !== r.cells.join('\u0001'))) changed.push(r.id)
      return r
    })
    const there = new Set(fresh.rows.map((r) => r.id))
    rowsRef.current.forEach((l) => { if (!there.has(l.id) && edited.current.has(l.id)) next.push(l) })
    setRows(next); setNote(fresh)
    if (!ec) setTitle(fresh.title)
    if (!sh) setPeople(fresh.people || [])
    if (changed.length) {
      setFlash(new Set(changed))
      setTimeout(() => setFlash(new Set()), 2500)
    }
  }
  const mergeRef = useRef(merge)
  mergeRef.current = merge

  // Every 3s while the page is in view (and at once on coming back to it)
  useEffect(() => {
    let gone = false
    const tick = async () => {
      if (document.hidden || !noteRef.current) return
      const at = seq.current
      const { aiOpen: adding } = ui.current
      try {
        const { data } = await noteLive(id, noteRef.current.rev, adding ? 'adding' : focused.current ? 'editing' : 'viewing')
        if (gone) return
        setHere(data.here || [])
        // a save started meanwhile brings a newer copy itself
        if (data.note && at === seq.current && !inFlight.current) mergeRef.current(data.note)
      } catch { /* next time */ }
    }
    const t = setInterval(tick, 3000)
    const back = () => { if (!document.hidden) tick() }
    document.addEventListener('visibilitychange', back)
    window.addEventListener('focus', back)
    return () => { gone = true; clearInterval(t); document.removeEventListener('visibilitychange', back); window.removeEventListener('focus', back) }
  }, [id])
  const saveRows = () => dirty && save({ rows: rowsRef.current })

  if (err && !note) return <p className="p-6 text-sm text-red-600">{err}</p>
  if (!note) return <LoadingSpinner />

  const setCell = (ri, ci, v) => { if (rows[ri]) edited.current.add(rows[ri].id); setRows((rs) => rs.map((r, i) => (i === ri ? { ...r, cells: r.cells.map((c, j) => (j === ci ? v : c)) } : r))); setDirty(true) }
  // A new row's id is made here, so saves while it's typed into stay one row
  // A new row stays on this screen until something's typed into it (an
  // empty row isn't saved); the page goes to it and its first cell is ready
  const addRow = () => {
    const rid = Math.random().toString(36).slice(2, 12)
    edited.current.add(rid)
    setQ('')
    setRows((rs) => [...rs, { id: rid, cells: note.columns.map(() => ''), by: user?.name }])
    setTimeout(() => {
      const el = document.querySelector(`[data-row="${rid}"] textarea`)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); el?.focus({ preventScroll: true })
    }, 60)
  }
  // Rows the AI read from text or speech, checked by the caller: theirs now
  const addRows = (cellRows) => {
    const next = [...rowsRef.current, ...cellRows.map((cells) => ({ id: Math.random().toString(36).slice(2, 12), cells, by: user?.name }))]
    setRows(next); return save({ rows: next })
  }
  const delRow = (ri) => { const next = rows.filter((_, i) => i !== ri); setRows(next); save({ rows: next }) }
  const needle = q.trim().toLowerCase()
  const shown = rows.map((r, i) => [r, i]).filter(([r]) => !needle || [...r.cells, r.by || ''].some((c) => c.toLowerCase().includes(needle)))
  const mine = note.owner.toLowerCase() === user?.name?.toLowerCase()
  // a row is only ever edited by whoever added it
  // Each column's share of the width, from what it holds: its longest word
  // (header or cell) so words aren't split, and how long its entries run
  const widths = (() => {
    const longest = (t) => Math.max(0, ...String(t || '').split(/[\s,/-]+/).map((w) => w.length))
    const ws = note.columns.map((c, ci) => {
      const cells = rows.map((r) => r.cells[ci] || '').filter(Boolean)
      const word = Math.max(longest(c) * 1.15, ...cells.map(longest))      // headers are bold
      const avg = cells.length ? cells.reduce((t, x) => t + x.length, 0) / cells.length : 4
      return Math.min(24, Math.max(4, word, avg * 0.7))
    })
    const sum = ws.reduce((t, w) => t + w, 0)
    return ws.map((w) => (w / sum) * 100)
  })()
  const pageLink = `${window.location.origin}/notes/${id}`
  // The owner's link adds whoever opens it; anyone else shares the plain page
  const shareLink = async () => {
    if (!mine) return pageLink
    const { data } = await noteInviteLink(id)
    return `${pageLink}?invite=${encodeURIComponent(data.token)}`
  }
  const onShare = async () => {
    setBusyTop('link'); setNotice('')
    try {
      const url = await shareLink()
      const text = `${note.title} - open it in Settle (log in first)`
      if (navigator.share && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
        try { await navigator.share({ title: note.title, text, url }) } catch { /* closed */ }
      } else {
        await navigator.clipboard.writeText(url)
        setNotice(mine ? 'Invite link copied - whoever opens it and logs in is added to this note.' : 'Link copied.')
      }
    } catch (e) { setNotice(e.response?.data?.detail || "Couldn't make the link.") }
    finally { setBusyTop('') }
  }
  const onPdf = async () => {
    setBusyTop('pdf'); setNotice('')
    try { await downloadNotePdf(note, rows, { me: user?.name, link: await shareLink() }) }
    catch (e) { setNotice(e.response?.data?.detail || "Couldn't make the PDF.") }
    finally { setBusyTop('') }
  }
  const isMine = (r) => (r.by || '').toLowerCase() === (user?.name || '').toLowerCase()

  const saveCols = async () => {
    const add = newCol.trim()
    const next = add ? [...cols, add] : cols
    // each column says which one it was, so a renamed column keeps its cells
    // (the server moves everyone's cells itself)
    const from = add ? [...colFrom, null] : colFrom
    if (await save({ title, columns: next, column_from: from, columns_was: note.columns })) { setEditCols(false); setNewCol('') }
  }
  const saveSharing = async () => { if (await save({ people: people.map((p) => p.name) })) setSharing(false) }

  return (
    <div className="pb-24 md:pb-8">
      <div className="bg-gradient-to-br from-field-800 to-field-950 text-white px-5 pt-10 md:pt-8 pb-5 border-b border-field-700">
        <div className="flex items-center justify-between gap-2">
          <button onClick={() => nav('/discuss')} className="text-slate-300/70 text-xs font-bold">‹ Discussions & notes</button>
          <div className="flex gap-1.5">
            <button onClick={onPdf} disabled={!!busyTop}
              className="text-[10px] font-bold px-2 py-1 border border-slate-300/40 text-slate-200 hover:bg-white/10 disabled:opacity-50">
              {busyTop === 'pdf' ? 'Making…' : 'PDF'}
            </button>
            <button onClick={onShare} disabled={!!busyTop}
              className="text-[10px] font-bold px-2 py-1 border border-slate-300/40 text-slate-200 hover:bg-white/10 disabled:opacity-50">
              {busyTop === 'link' ? '…' : mine ? 'Invite link' : 'Link'}
            </button>
          </div>
        </div>
        {notice && <p className="text-[11px] text-brand-300 mt-2">{notice}</p>}
        <h1 className="text-2xl font-black mt-2 tracking-tight break-words">{note.title}</h1>
        <p className="text-slate-300/70 text-xs mt-1">
          {note.people?.length ? `With ${note.people.map((p) => p.name).join(', ')}` : note.group ? `Shared with ${note.group}` : 'Only you'}
          {!mine && ` · ${note.owner}'s`} · {rows.length} row{rows.length === 1 ? '' : 's'}
          {note.updated_at ? ` · edited ${ago(note.updated_at)}${note.updated_by && note.updated_by !== user?.name ? ` by ${note.updated_by}` : ''}` : ''}
        </p>
        <div className="flex gap-4 mt-3 text-[11px] font-bold">
          <button onClick={() => { setEditCols((v) => !v); setSharing(false); setCols(note.columns); setColFrom(note.columns.map((_, i) => i)); setTitle(note.title); setNewCol('') }} className="text-brand-300 hover:text-white">{editCols ? 'Close' : 'Edit columns & name'}</button>
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
                  onClick={() => window.confirm(`Remove the "${c}" column and what's in it?`) && (setCols((cs) => cs.filter((_, j) => j !== i)), setColFrom((cs) => cs.filter((_, j) => j !== i)))}
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
        <Insights noteId={id} rowCount={rows.length} stamp={JSON.stringify([note.columns, rows.map((r) => r.cells)])} />

        {here.length > 0 && (
          <p className="flex items-center gap-1.5 text-[11px] text-gray-600">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            {here.map((h) => `${h.name} ${h.doing === 'adding' ? 'is adding rows' : h.doing === 'editing' ? 'is typing' : 'is here'}`).join(' · ')}
          </p>
        )}
        {/* Adding rows and searching them, in one line above the table */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button onClick={addRow} className="text-xs font-bold text-brand-600 whitespace-nowrap">+ Add row</button>
          <button onClick={() => setAiOpen((v) => !v)} className="text-xs font-bold text-brand-600 whitespace-nowrap">
            {aiOpen ? 'Close' : '+ Type, speak or photo'}
          </button>
          {rows.length > 1 && (
            <input value={q} onChange={(e) => setQ(e.target.value)} className="input text-xs py-1.5 flex-1 min-w-[8rem] max-w-xs" placeholder="Search the rows" />
          )}
          <span className="text-[10px] text-gray-400 whitespace-nowrap">{saving ? 'Saving…' : dirty ? 'Unsaved - tap outside the cell' : 'Saved'}</span>
          {err && <span className="text-[11px] text-red-600">{err}</span>}
        </div>
        {aiOpen && <AddByText noteId={id} columns={note.columns} onAdd={addRows} onClose={() => setAiOpen(false)} />}

        <div className="border border-amber-200 bg-white">
          <table className="w-full table-fixed text-xs border-collapse">
            <colgroup>
              <col style={{ width: '2.75rem' }} />
              {widths.map((w, i) => <col key={i} style={{ width: `${w}%` }} />)}
              <col style={{ width: '1.5rem' }} />
            </colgroup>
            <thead>
              <tr className="bg-amber-50">
                <th className="border-b border-amber-200 text-[9px] font-bold text-gray-400 align-bottom pb-2">#</th>
                {note.columns.map((c) => (
                  <th key={c} className="text-left font-black text-gray-700 px-2 py-2 border-b border-l border-amber-200 align-bottom break-words">{soft(c)}</th>
                ))}
                <th className="border-b border-amber-200" />
              </tr>
            </thead>
            <tbody>
              {shown.map(([r, ri]) => (
                <tr key={r.id || ri} data-row={r.id} className={`border-b border-amber-100 last:border-0 transition-colors duration-700 ${flash.has(r.id) ? 'bg-amber-100' : ''}`}>
                  <td className="text-center align-top pt-1.5 pb-1 px-0.5">
                    <span className="block text-[10px] text-gray-400 leading-tight">{ri + 1}</span>
                    {/* who added the row - set from their profile, for good */}
                    <span className="block text-[8px] text-gray-400 leading-tight truncate" title={`Added by ${r.by}`}>
                      {r.by?.toLowerCase() === user?.name?.toLowerCase() ? 'You' : r.by}
                    </span>
                  </td>
                  {note.columns.map((c, ci) => (
                    <td key={c} className="border-l border-amber-100 p-0 align-top">
                      <Cell value={r.cells[ci] ?? ''} readOnly={!isMine(r)} onChange={(e) => setCell(ri, ci, e.target.value)}
                        onFocus={() => { focused.current = isMine(r) }} onBlur={() => { focused.current = false; saveRows() }}
                        className={`w-full px-2 py-1.5 text-xs bg-transparent resize-none overflow-hidden block break-words focus:outline-none ${isMine(r) ? "focus:bg-amber-50" : "text-gray-600 cursor-default"}`} />
                    </td>
                  ))}
                  <td className="text-center align-top pt-1.5">
                    {isMine(r) && <button onClick={() => window.confirm(`Delete row ${ri + 1}?`) && delRow(ri)} className="text-gray-300 hover:text-red-600" aria-label={`Delete row ${ri + 1}`}>✕</button>}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={note.columns.length + 2} className="text-center text-gray-400 py-6">No rows yet - add the first one.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
