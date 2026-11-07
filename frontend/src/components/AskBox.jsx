import { useEffect, useRef, useState } from 'react'
import { Typewriter } from './ExpenseChat'
import { useVoice, canRecord as micWorks } from './useVoice'

/**
 * Recommend's chat box (Drinks, Food): type or say what you're after - a
 * recommendation, or a question about one bottle or place. `ask(text)`
 * resolves to the line(s) shown back. The page does the work: fills its own
 * settings and runs, or looks the bottle / place up in its data.
 */
export default function AskBox({ title, ideas, placeholder, ask, busy: outerBusy = false }) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const [msgs, setMsgs] = useState([])      // { who: 'me' | 'ai', text, error? }
  const [asking, setAsking] = useState(false)
  const listRef = useRef(null)
  const send = async (said) => {
    const line = (said ?? text).trim()
    if (line.length < 2 || asking) return
    setMsgs((m) => [...m, { who: 'me', text: line }])
    setText(''); setAsking(true)
    try {
      const reply = await ask(line)
      setMsgs((m) => [...m, { who: 'ai', text: reply || 'Done - see below.' }])
    } catch (err) {
      setMsgs((m) => [...m, { who: 'ai', error: true, text: err?.response?.data?.detail || "Couldn't do that just now - try again." }])
    } finally { setAsking(false) }
  }
  const voice = useVoice({ onText: (s) => send(s), onError: (t) => setMsgs((m) => [...m, { who: 'ai', error: true, text: t }]) })
  const busy = asking || voice.hearing || outerBusy
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }) }, [msgs, busy])

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3">
      <p className="text-xs font-bold text-gray-700">{title} <span className="font-normal text-gray-400">- type it or say it</span></p>
      {msgs.length > 0 && (
        <div ref={listRef} className="max-h-60 overflow-y-auto space-y-1.5 mt-2">
          {msgs.map((m, i) => (
            <div key={i} className={`flex ${m.who === 'me' ? 'justify-end' : 'justify-start'}`}>
              <p className={`text-xs px-2.5 py-1.5 rounded-md max-w-[90%] whitespace-pre-wrap ${
                m.who === 'me' ? 'bg-brand-400 text-white'
                  : m.error ? 'bg-red-50 text-red-700 border border-red-100'
                  : 'bg-white text-gray-800 border border-amber-200'}`}>{m.text}</p>
            </div>
          ))}
          {busy && <p className="text-[11px] text-gray-400">Working it out…</p>}
        </div>
      )}
      <div className="relative mt-2">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder={focused ? placeholder : ''} aria-label={title}
          className="input text-sm bg-white" />
        {!text && !focused && (
          <div className="absolute inset-0 px-4 py-3 pointer-events-none overflow-hidden">
            {voice.recording ? <p className="text-sm font-bold text-brand-600">● Listening… {voice.seconds}s - tap ■ when you're done</p>
              : voice.hearing ? <p className="text-sm text-gray-400">Writing down what you said…</p>
              : <Typewriter running ideas={ideas} className="text-sm leading-relaxed" />}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 mt-2">
        <button onClick={() => send()} disabled={busy || text.trim().length < 2} className="btn-primary text-xs py-2 px-5 disabled:opacity-50">
          {busy ? 'Working…' : 'Ask'}
        </button>
        {micWorks() && (
          <button type="button" onClick={voice.recording ? voice.stop : voice.start} disabled={voice.hearing || asking}
            aria-label={voice.recording ? 'Stop' : 'Say it'}
            className={`w-9 h-9 rounded-md flex items-center justify-center active:scale-95 transition-all disabled:opacity-50 ${voice.recording ? 'bg-red-500' : 'bg-white border border-amber-300 hover:bg-amber-100'}`}>
            {voice.recording ? <span className="w-3 h-3 rounded-sm bg-white" /> : (
              <svg className="w-4 h-4 text-gray-700" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" viewBox="0 0 24 24"><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" /></svg>
            )}
          </button>
        )}
      </div>
    </div>
  )
}
