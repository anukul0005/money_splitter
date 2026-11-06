import { useEffect, useRef, useState } from 'react'
import { transcribeExpense } from '../api'

const MAX_SECONDS = 45

export const canRecord = () =>
  typeof window !== 'undefined' && !!window.MediaRecorder && !!navigator.mediaDevices?.getUserMedia

// The mic, shared by New expense's chat card and the trip planner: start()
// records, stop() ends it, and the words come back through onText (speech to
// text on the server, Groq's Whisper). Anything that goes wrong comes back
// through onError as a line to show - never silently.
export function useVoice({ onText, onError }) {
  const [rec, setRec]         = useState(null)   // { recorder, started }
  const [seconds, setSeconds] = useState(0)
  const [hearing, setHearing] = useState(false)  // the clip is being turned into words
  const cb = useRef({ onText, onError })
  cb.current = { onText, onError }               // a recording ends in an older render's closure

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

  const start = async () => {
    const oops = (text) => cb.current.onError?.(text)
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      return oops('The microphone is blocked - allow it for this site, or type instead.')
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
      .find((t) => window.MediaRecorder.isTypeSupported?.(t))
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
        return oops('Nothing was recorded - the mic may be in use (a call?). Try again, or type it.')
      }
      setHearing(true)
      let said = ''
      try {
        said = ((await transcribeExpense(blob)).data.text || '').trim()
        if (!said) oops("Didn't catch any words - try again a little closer to the mic, or type it.")
      } catch (err) {
        oops(err?.response?.data?.detail || "Couldn't hear that - try again, or type it.")
      }
      setHearing(false)
      if (said) cb.current.onText?.(said)
    }
    // In 1s slices: some iPhones hand over nothing when asked only at the end
    recorder.start(1000)
    setRec({ recorder, started })
  }

  const stop = () => { if (rec?.recorder.state === 'recording') rec.recorder.stop() }

  return { recording: !!rec, seconds, hearing, start, stop }
}
