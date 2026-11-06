import { useEffect, useRef, useState } from 'react'
import { transcribeExpense } from '../api'

const MAX_SECONDS = 45

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
  const [busy, setBusy]       = useState(false)
  const [rec, setRec]         = useState(null) // { recorder, started }
  const [seconds, setSeconds] = useState(0)
  const listRef = useRef(null)
  const askRef  = useRef(ask)               // a recording ends in an older render's closure
  askRef.current = ask
  const canRecord = typeof window !== 'undefined' && !!window.MediaRecorder && !!navigator.mediaDevices?.getUserMedia

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }) }, [msgs, busy])

  useEffect(() => {
    if (!rec) return
    const t = setInterval(() => {
      const s = Math.floor((Date.now() - rec.started) / 1000)
      setSeconds(s)
      if (s >= MAX_SECONDS && rec.recorder.state === 'recording') rec.recorder.stop()
    }, 250)
    return () => clearInterval(t)
  }, [rec])

  // Stop the mic if the page is left mid-recording
  useEffect(() => () => { if (rec?.recorder.state === 'recording') rec.recorder.stop() }, [rec])

  const send = async (said) => {
    const line = said.trim()
    if (!line || busy) return
    setMsgs((m) => [...m, { who: 'me', text: line }])
    setText('')
    setBusy(true)
    try {
      const reply = await askRef.current(line)
      const { text: said, actions, error } = typeof reply === 'object' && reply ? reply : { text: reply }
      // Buttons only ever on the latest reply
      setMsgs((m) => [...m.map((x) => ({ ...x, actions: undefined })),
        { who: 'ai', error, actions, text: said || 'Filled in below - check it before saving.' }])
    } catch (err) {
      setMsgs((m) => [...m, { who: 'ai', error: true, text: err?.response?.data?.detail || "Couldn't read that just now - try again, or fill the form in." }])
    } finally {
      setBusy(false)
    }
  }

  const startMic = async () => {
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setMsgs((m) => [...m, { who: 'ai', error: true, text: 'The microphone is blocked - allow it for this site, or type instead.' }])
      return
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
      .find((t) => window.MediaRecorder.isTypeSupported?.(t))
    const oops = (text) => setMsgs((m) => [...m, { who: 'ai', error: true, text }])
    let recorder
    try {
      recorder = new window.MediaRecorder(stream, type ? { mimeType: type } : undefined)
    } catch {
      stream.getTracks().forEach((t) => t.stop())
      return oops("This browser can't record here - type it instead.")
    }
    const chunks = []
    const started = Date.now()
    recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data) }
    recorder.onerror = () => oops('The recording stopped with an error - try again, or type it.')
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      setRec(null); setSeconds(0)
      const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' })
      if (Date.now() - started < 700) return     // a tap, not speech
      if (blob.size < 500) {
        // An iPhone on a phone call hands the mic to the call: nothing records
        return oops("Nothing was recorded - the mic may be in use (a call?). Try again, or type it.")
      }
      setBusy(true)
      let said = ''
      try {
        said = (await transcribeExpense(blob)).data.text || ''
        if (!said.trim()) oops("Didn't catch any words - try again a little closer to the mic, or type it.")
      } catch (err) {
        oops(err?.response?.data?.detail || "Couldn't hear that - try again, or type it.")
      }
      setBusy(false)
      if (said.trim()) send(said)
    }
    // In 1s slices: some iPhones hand over nothing when asked only at the end
    recorder.start(1000)
    setRec({ recorder, started })
  }

  const stopMic = () => { if (rec?.recorder.state === 'recording') rec.recorder.stop() }

  const runAction = async (a) => {
    setMsgs((m) => m.map((x) => ({ ...x, actions: undefined })))
    setBusy(true)
    try {
      const out = await a.run()
      if (out === 'reset') return setMsgs([])
      if (out) setMsgs((m) => [...m, { who: 'ai', text: out }])
    } catch (err) {
      setMsgs((m) => [...m, { who: 'ai', error: true, text: err?.response?.data?.detail || 'That didn\'t work - try again.' }])
    } finally {
      setBusy(false)
    }
  }

  const openTyping = () => { setTyping(true); setTimeout(() => inputRef.current?.focus(), 30) }
  const submitTyped = () => { if (text.trim()) { send(text); setTyping(false) } }
  const idle = !rec && !typing && !busy && msgs.length === 0

  return (
    <div className="relative rounded-[28px] border border-gray-200/80 shadow-[0_8px_30px_rgba(0,0,0,0.06)] px-6 pt-5 pb-5 flex flex-col min-h-[300px]"
      style={{ background: 'linear-gradient(160deg, #fafafa 0%, #f0f0f0 100%)' }}>
      <p className="text-[22px] text-gray-900 leading-tight" style={SERIF}>
        {msgs.length ? <>Tell me <i className="font-bold">more</i></> : <>Let's get <i className="font-bold">started</i></>}
      </p>

      {/* The middle: suggestions typed out, the conversation, what's being typed, or the mic listening */}
      <div className="flex-1 flex flex-col justify-center py-4 min-h-[150px]">
        {rec ? (
          <div className="text-center">
            <Wave />
            <p className="text-[28px] text-gray-900 mt-3" style={SERIF}>Listening<i className="font-bold">…</i></p>
            <p className="text-xs text-gray-500 mt-1">{seconds}s · tap ■ when you're done</p>
          </div>
        ) : typing ? (
          <textarea
            ref={inputRef}
            rows={3}
            className="w-full bg-transparent resize-none outline-none text-[26px] leading-snug text-gray-900 placeholder:text-gray-400"
            style={SERIF}
            placeholder="Rs 400 with Utkarsh at Nutriobox"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitTyped() } }}
          />
        ) : msgs.length > 0 ? (
          <div ref={listRef} className="max-h-64 overflow-y-auto space-y-2">
            {msgs.map((m, i) => (
              <div key={i} className={`flex flex-col ${m.who === 'me' ? 'items-end' : 'items-start'}`}>
                {m.who === 'me' ? (
                  <p className="text-[19px] text-gray-500 text-right max-w-[90%]" style={SERIF}>“{m.text}”</p>
                ) : (
                  <p className={`text-sm max-w-[95%] whitespace-pre-wrap ${m.error ? 'text-red-600' : 'text-gray-900'}`}>{m.text}</p>
                )}
                {m.actions?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {m.actions.map((a) => (
                      <button key={a.label} type="button" disabled={busy} onClick={() => runAction(a)}
                        className={`text-xs font-bold px-3 py-1.5 rounded-full border disabled:opacity-50 ${
                          a.danger ? 'text-red-600 bg-white border-red-200' : 'text-gray-900 bg-white border-gray-300'}`}>
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {busy && <p className="text-[19px] text-gray-400" style={SERIF}><i>Reading…</i></p>}
          </div>
        ) : busy ? (
          <p className="text-[30px] text-gray-400" style={SERIF}><i>Reading…</i></p>
        ) : (
          <Typewriter running={idle} />
        )}
      </div>

      {/* Scan · type · speak */}
      <div className="flex items-end gap-3">
        {onScan && (
          <button type="button" onClick={onScan} disabled={busy || !!rec} aria-label="Scan a receipt"
            className="w-14 h-14 rounded-2xl bg-gray-200/70 border-[3px] border-gray-300 flex items-center justify-center active:scale-95 transition-all disabled:opacity-50">
            <svg className="w-6 h-6 text-gray-900" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V6a2 2 0 012-2h2M16 4h2a2 2 0 012 2v2M20 16v2a2 2 0 01-2 2h-2M8 20H6a2 2 0 01-2-2v-2M9 8h6v8l-1.5-1-1.5 1-1.5-1L9 16V8zM10.5 10.5h3M10.5 13h3" />
            </svg>
          </button>
        )}
        <div className="flex-1" />
        {!rec && (typing ? (
          <button type="button" onClick={text.trim() ? submitTyped : () => setTyping(false)} disabled={busy}
            aria-label={text.trim() ? 'Send' : 'Close'}
            className={`w-14 h-14 rounded-2xl flex items-center justify-center active:scale-95 transition-all shadow-sm ${text.trim() ? 'bg-gray-900 text-white' : 'bg-white text-gray-900'}`}>
            {text.trim() ? (
              <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" /></svg>
            ) : (
              <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            )}
          </button>
        ) : (
          <button type="button" onClick={openTyping} disabled={busy} aria-label="Type it"
            className="w-14 h-14 rounded-2xl bg-white flex items-center justify-center active:scale-95 transition-all shadow-sm disabled:opacity-50">
            <svg className="w-6 h-6 text-gray-900" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.2 5.2l3.6 3.6M4 20l1-4.6L16.4 4a1.8 1.8 0 012.6 0l1 1a1.8 1.8 0 010 2.6L8.6 19 4 20zM13 20h7" />
            </svg>
          </button>
        ))}
        {canRecord && !typing && (
          <button type="button" onClick={rec ? stopMic : startMic} disabled={busy} aria-label={rec ? 'Stop' : 'Speak'}
            className={`w-14 h-14 rounded-2xl flex items-center justify-center active:scale-95 transition-all disabled:opacity-50 ${rec ? 'bg-red-500' : 'bg-gray-900'}`}>
            {rec ? (
              <span className="w-4 h-4 rounded-sm bg-white" />
            ) : (
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" viewBox="0 0 24 24">
                <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
              </svg>
            )}
          </button>
        )}
      </div>
    </div>
  )
}

const SERIF = { fontFamily: "'Newsreader', Georgia, 'Times New Roman', serif" }

// What could be said, typed out and wiped one after another: a grey lead-in,
// then the example in bold italic
const IDEAS = [
  ['Snap a ', 'receipt'],
  ['Say ', '“400 with Utkarsh at Nutriobox”'],
  ['Type ', '“chai 20, cash”'],
  ['Say ', '“Rahul paid 900 for dinner”'],
  ['Try ', '“petrol 1500 yesterday, card”'],
]

function Typewriter({ running }) {
  const [i, setI] = useState(0)
  const [n, setN] = useState(0)        // characters showing
  const [back, setBack] = useState(false)
  const [lead, rest] = IDEAS[i]
  const full = lead.length + rest.length
  useEffect(() => {
    if (!running) return
    const t = setTimeout(() => {
      if (!back && n < full) setN(n + 1)
      else if (!back) setBack(true)
      else if (n > 0) setN(n - 1)
      else { setBack(false); setI((i + 1) % IDEAS.length) }
    }, !back && n === full ? 1700 : back ? 22 : 55)
    return () => clearTimeout(t)
  }, [running, n, back, full, i])
  return (
    <p className="text-[32px] leading-tight min-h-[84px]" style={SERIF} aria-label={lead + rest}>
      <span className="text-gray-500">{lead.slice(0, n)}</span>
      <i className="font-bold text-gray-900">{rest.slice(0, Math.max(0, n - lead.length))}</i>
      <span className="inline-block w-[2px] h-[0.9em] bg-gray-700 align-[-0.1em] ml-0.5 animate-pulse" />
    </p>
  )
}

// The mic's listening bars
function Wave() {
  return (
    <div className="flex items-center justify-center gap-1.5 h-12">
      {[0, 1, 2, 3, 4, 5, 6].map((k) => (
        <span key={k} className="w-1.5 rounded-full bg-gray-900"
          style={{ height: '100%', animation: `expchat-wave 0.9s ease-in-out ${k * 0.11}s infinite` }} />
      ))}
      <style>{'@keyframes expchat-wave{0%,100%{transform:scaleY(.25)}50%{transform:scaleY(1)}}'}</style>
    </div>
  )
}
