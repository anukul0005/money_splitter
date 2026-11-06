import { useEffect, useRef, useState } from 'react'
import { transcribeExpense } from '../api'

const MAX_SECONDS = 45

// Add Expense's chat box: type or say what was spent ("rs 400 spent with
// utkarsh at xyz store") and `ask` fills the form, resolving to the line
// shown back. Follow-ups ("it was groceries") go through the same `ask`.
export default function ExpenseChat({ ask }) {
  const [msgs, setMsgs]       = useState([])   // { who: 'me' | 'ai', text, error? }
  const [text, setText]       = useState('')
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
      setMsgs((m) => [...m, { who: 'ai', text: reply || 'Filled in below - check it before saving.' }])
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

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3">
      <p className="text-xs font-bold text-gray-700">Tell it what you spent</p>
      <p className="text-[11px] text-gray-500 mb-2">Type or speak - e.g. "Rs 400 spent with Utkarsh at XYZ store" - and the form below fills itself in.</p>

      {msgs.length > 0 && (
        <div ref={listRef} className="max-h-48 overflow-y-auto space-y-1.5 mb-2">
          {msgs.map((m, i) => (
            <div key={i} className={`flex ${m.who === 'me' ? 'justify-end' : 'justify-start'}`}>
              <p className={`text-xs px-2.5 py-1.5 rounded-md max-w-[85%] whitespace-pre-wrap ${
                m.who === 'me' ? 'bg-brand-400 text-white'
                  : m.error ? 'bg-red-50 text-red-700 border border-red-100'
                  : 'bg-white text-gray-800 border border-amber-200'}`}>
                {m.text}
              </p>
            </div>
          ))}
          {busy && <p className="text-[11px] text-gray-400">Reading…</p>}
        </div>
      )}

      {rec ? (
        <button type="button" onClick={stopMic}
          className="w-full py-2.5 text-xs font-bold text-white bg-red-500 rounded-md active:scale-[0.98] transition-all flex items-center justify-center gap-2">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
          Listening… {seconds}s - tap to finish
        </button>
      ) : (
        <div className="flex gap-2">
          <input
            className="input flex-1 text-sm"
            placeholder="Rs 400 with Utkarsh at XYZ store"
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(text) } }}
          />
          {text.trim() ? (
            <button type="button" disabled={busy} onClick={() => send(text)}
              className="px-3 text-xs font-bold text-white bg-brand-400 rounded-md disabled:opacity-50">
              Send
            </button>
          ) : canRecord && (
            <button type="button" disabled={busy} onClick={startMic} title="Speak"
              className="px-3 bg-white border border-amber-300 rounded-md hover:bg-amber-100 disabled:opacity-50">
              <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
