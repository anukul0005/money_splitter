import { useEffect, useRef, useState } from 'react'
import { useVoice, canRecord as micWorks } from './useVoice'

// New expense's chat box: type or say what was spent ("rs 400 spent with
// utkarsh at xyz store") and `ask` fills the form, resolving to the line
// shown back - or to { text, actions: [{ label, run }] }, buttons under it
// (a `run` may resolve to a line of its own). Follow-ups ("it was
// groceries") go through the same `ask`. `onScan`: the receipt button.
export default function ExpenseChat({ ask, onScan }) {
  const [msgs, setMsgs]       = useState([])   // { who: 'me' | 'ai', text, error?, actions? }
  const [text, setText]       = useState('')
  const [typing, setTyping]   = useState(false)
  const inputRef = useRef(null)
  const [asking, setAsking]   = useState(false)
  const listRef = useRef(null)
  const askRef  = useRef(ask)               // a recording ends in an older render's closure
  askRef.current = ask
  const canRecord = micWorks()
  const oops = (text) => setMsgs((m) => [...m, { who: 'ai', error: true, text }])
  const voice = useVoice({ onText: (said) => send(said), onError: oops })
  const rec = voice.recording
  const seconds = voice.seconds
  const busy = asking || voice.hearing
  const startMic = voice.start
  const stopMic = voice.stop

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }) }, [msgs, busy])

  const send = async (said) => {
    const line = said.trim()
    if (!line || asking) return
    setMsgs((m) => [...m, { who: 'me', text: line }])
    setText('')
    setAsking(true)
    try {
      const reply = await askRef.current(line)
      const { text: said, actions, error } = typeof reply === 'object' && reply ? reply : { text: reply }
      // Buttons only ever on the latest reply
      setMsgs((m) => [...m.map((x) => ({ ...x, actions: undefined })),
        { who: 'ai', error, actions, text: said || 'Filled in below - check it before saving.' }])
    } catch (err) {
      setMsgs((m) => [...m, { who: 'ai', error: true, text: err?.response?.data?.detail || "Couldn't read that just now - try again, or fill the form in." }])
    } finally {
      setAsking(false)
    }
  }

  const runAction = async (a) => {
    setMsgs((m) => m.map((x) => ({ ...x, actions: undefined })))
    setAsking(true)
    try {
      const out = await a.run()
      if (out === 'reset') return setMsgs([])
      if (out) setMsgs((m) => [...m, { who: 'ai', text: out }])
    } catch (err) {
      setMsgs((m) => [...m, { who: 'ai', error: true, text: err?.response?.data?.detail || 'That didn\'t work - try again.' }])
    } finally {
      setAsking(false)
    }
  }

  const openTyping = () => { setTyping(true); setTimeout(() => inputRef.current?.focus(), 30) }
  const submitTyped = () => { if (text.trim()) { send(text); setTyping(false) } }
  const idle = !rec && !typing && !busy && msgs.length === 0

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-md px-4 pt-3 pb-3 flex flex-col min-h-[220px]">
      <p className="text-xs font-bold text-gray-700">
        {msgs.length ? 'Tell me more' : "Let's get started"}
        <span className="font-normal text-gray-400"> - say it, type it, or scan a bill</span>
      </p>

      {/* The middle: suggestions typed out, the conversation, what's being typed, or the mic listening */}
      <div className="flex-1 flex flex-col justify-center py-3 min-h-[110px]">
        {rec ? (
          <div className="text-center">
            <Wave />
            <p className="text-base font-bold text-gray-900 mt-2">Listening…</p>
            <p className="text-[11px] text-gray-500 mt-0.5">{seconds}s · tap ■ when you're done</p>
          </div>
        ) : typing ? (
          <textarea
            ref={inputRef}
            rows={3}
            className="w-full bg-white border border-amber-200 rounded-md px-3 py-2 resize-none outline-none focus:border-brand-400 text-base text-gray-900 placeholder:text-gray-400"
            placeholder="Rs 400 with Utkarsh at Nutriobox"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitTyped() } }}
          />
        ) : msgs.length > 0 ? (
          <div ref={listRef} className="max-h-64 overflow-y-auto space-y-2">
            {msgs.map((m, i) => (
              <div key={i} className={`flex flex-col ${m.who === 'me' ? 'items-end' : 'items-start'}`}>
                <p className={`text-xs px-2.5 py-1.5 rounded-md max-w-[88%] whitespace-pre-wrap ${
                  m.who === 'me' ? 'bg-brand-400 text-white'
                    : m.error ? 'bg-red-50 text-red-700 border border-red-100'
                    : 'bg-white text-gray-800 border border-amber-200'}`}>
                  {m.text}
                </p>
                {m.actions?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {m.actions.map((a) => (
                      <button key={a.label} type="button" disabled={busy} onClick={() => runAction(a)}
                        className={`text-[11px] font-bold px-2.5 py-1 rounded-md border disabled:opacity-50 ${
                          a.danger ? 'text-red-600 bg-white border-red-200' : 'text-brand-700 bg-white border-amber-300'}`}>
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {busy && <p className="text-[11px] text-gray-400">Reading…</p>}
          </div>
        ) : busy ? (
          <p className="text-lg font-bold text-gray-400">Reading…</p>
        ) : (
          <Typewriter running={idle} />
        )}
      </div>

      {/* Scan · type · speak */}
      <div className="flex items-end gap-2">
        {onScan && (
          <button type="button" onClick={onScan} disabled={busy || !!rec} aria-label="Scan a receipt"
            className="w-12 h-12 rounded-md bg-white border border-amber-300 hover:bg-amber-100 flex items-center justify-center active:scale-95 transition-all disabled:opacity-50">
            <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V6a2 2 0 012-2h2M16 4h2a2 2 0 012 2v2M20 16v2a2 2 0 01-2 2h-2M8 20H6a2 2 0 01-2-2v-2M9 8h6v8l-1.5-1-1.5 1-1.5-1L9 16V8zM10.5 10.5h3M10.5 13h3" />
            </svg>
          </button>
        )}
        <div className="flex-1" />
        {!rec && (typing ? (
          <button type="button" onClick={text.trim() ? submitTyped : () => setTyping(false)} disabled={busy}
            aria-label={text.trim() ? 'Send' : 'Close'}
            className={`w-12 h-12 rounded-md flex items-center justify-center active:scale-95 transition-all border ${text.trim() ? 'bg-brand-400 border-brand-400 text-white' : 'bg-white border-amber-300 text-gray-700'}`}>
            {text.trim() ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" /></svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            )}
          </button>
        ) : (
          <button type="button" onClick={openTyping} disabled={busy} aria-label="Type it"
            className="w-12 h-12 rounded-md bg-white border border-amber-300 hover:bg-amber-100 flex items-center justify-center active:scale-95 transition-all disabled:opacity-50">
            <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.2 5.2l3.6 3.6M4 20l1-4.6L16.4 4a1.8 1.8 0 012.6 0l1 1a1.8 1.8 0 010 2.6L8.6 19 4 20zM13 20h7" />
            </svg>
          </button>
        ))}
        {canRecord && !typing && (
          <button type="button" onClick={rec ? stopMic : startMic} disabled={busy} aria-label={rec ? 'Stop' : 'Speak'}
            className={`w-12 h-12 rounded-md flex items-center justify-center active:scale-95 transition-all disabled:opacity-50 shadow-sm ${rec ? 'bg-red-500' : 'bg-brand-400'}`}>
            {rec ? (
              <span className="w-3.5 h-3.5 rounded-sm bg-white" />
            ) : (
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" viewBox="0 0 24 24">
                <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
              </svg>
            )}
          </button>
        )}
      </div>
    </div>
  )
}

// What could be said, typed out and wiped one after another: a grey lead-in,
// then the example in bold
const IDEAS = [
  ['Snap a ', 'receipt'],
  ['Say ', '“400 with Utkarsh at Nutriobox”'],
  ['Type ', '“chai 20, cash”'],
  ['Say ', '“Rahul paid 900 for dinner”'],
  ['Try ', '“petrol 1500 yesterday, card”'],
]

// Also the trip planner's empty box, with its own ideas and size
export function Typewriter({ running, ideas = IDEAS, className = 'text-xl leading-snug min-h-[56px]' }) {
  const [i, setI] = useState(0)
  const [n, setN] = useState(0)        // characters showing
  const [back, setBack] = useState(false)
  const [lead, rest] = ideas[i % ideas.length]
  const full = lead.length + rest.length
  useEffect(() => {
    if (!running) return
    const t = setTimeout(() => {
      if (!back && n < full) setN(n + 1)
      else if (!back) setBack(true)
      else if (n > 0) setN(n - 1)
      else { setBack(false); setI((i + 1) % ideas.length) }
    }, !back && n === full ? 1700 : back ? 22 : 55)
    return () => clearTimeout(t)
  }, [running, n, back, full, i])
  return (
    <p className={className} aria-label={lead + rest}>
      <span className="text-gray-400">{lead.slice(0, n)}</span>
      <span className="font-bold text-gray-900">{rest.slice(0, Math.max(0, n - lead.length))}</span>
      <span className="inline-block w-[2px] h-[0.9em] bg-brand-400 align-[-0.1em] ml-0.5 animate-pulse" />
    </p>
  )
}

// The mic's listening bars
function Wave() {
  return (
    <div className="flex items-center justify-center gap-1.5 h-9">
      {[0, 1, 2, 3, 4, 5, 6].map((k) => (
        <span key={k} className="w-1.5 rounded-full bg-brand-400"
          style={{ height: '100%', animation: `expchat-wave 0.9s ease-in-out ${k * 0.11}s infinite` }} />
      ))}
      <style>{'@keyframes expchat-wave{0%,100%{transform:scaleY(.25)}50%{transform:scaleY(1)}}'}</style>
    </div>
  )
}
