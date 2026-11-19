import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { lessonSrc, lessonsList } from '../api'
import { currentFont } from '../utils/appFont'

/**
 * A lesson page (/lessons/:slug): the interactive lesson from the backend
 * (routers/lessons.py) in a frame under the app's header. The frame loads it
 * as an ordinary page from a signed address (iPhone Safari left a frame
 * filled from a string blank); the server dresses it in the app's look and
 * the font picked in Account. Sandboxed: its scripts run (sliders,
 * calculators, chapter list) but it can't touch the app. Three reading
 * sizes (A A A, kept on this device) change the text in place.
 */
const SIZES = [['s', 0.9, 'text-[11px]'], ['m', 1.0, 'text-[13px]'], ['l', 1.15, 'text-[16px]']]
const SIZE_KEY = 'settle_lesson_size'
const savedSize = () => { try { return localStorage.getItem(SIZE_KEY) || 'm' } catch { return 'm' } }
export default function Lesson() {
  const { slug } = useParams()
  const nav = useNavigate()
  const [src, setSrc] = useState(null)
  const [meta, setMeta] = useState(null)
  const [err, setErr] = useState('')
  const head = useRef(null)
  const [height, setHeight] = useState(0)
  const [size, setSize] = useState(savedSize)
  const frame = useRef(null)
  const pickSize = (k, v) => {
    setSize(k)
    try { localStorage.setItem(SIZE_KEY, k) } catch { /* storage blocked */ }
    frame.current?.contentWindow?.postMessage({ lessonScale: v }, '*')
  }
  useEffect(() => {
    setSrc(null); setErr('')
    lessonSrc(slug, currentFont().id, savedSize()).then(setSrc).catch(() => setErr('Could not load this lesson.'))
    lessonsList().then((r) => setMeta((r.data || []).find((x) => x.slug === slug) || null)).catch(() => {})
  }, [slug])
  // an exact pixel height: from under the header to above the bottom bar
  useLayoutEffect(() => {
    const fit = () => {
      const top = head.current ? head.current.getBoundingClientRect().bottom : 0
      const bar = window.matchMedia('(min-width: 768px)').matches ? 0 : 64
      setHeight(Math.max(320, Math.round(window.innerHeight - top - bar)))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [meta, src])
  return (
    <div>
      <div ref={head} className="px-5 pt-10 md:pt-6 pb-3 bg-cream border-b border-amber-100/60">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <div className="flex items-start gap-3">
          <h1 className="text-xl font-black tracking-tight flex-1 min-w-0">{meta?.title || 'Lesson'}</h1>
          <div className="flex shrink-0 border border-amber-300 rounded-md overflow-hidden" role="group" aria-label="Text size">
            {SIZES.map(([k, v, cls]) => (
              <button key={k} onClick={() => pickSize(k, v)} aria-pressed={size === k} aria-label={{ s: 'Small text', m: 'Medium text', l: 'Large text' }[k]}
                className={`w-8 h-8 flex items-center justify-center font-bold rounded-none ${cls} ${size === k ? 'bg-field-950 text-white' : 'bg-white text-gray-600'}`}>A</button>
            ))}
          </div>
        </div>
        {meta?.about && <p className="mt-1 text-[11px] text-gray-400 leading-snug">{meta.about}</p>}
      </div>
      {err && <p className="text-xs text-red-600 p-5">{err}</p>}
      {!src && !err && <p className="text-xs text-gray-400 text-center py-10">Loading…</p>}
      {src && (
        <iframe ref={frame} title={meta?.title || 'Lesson'} src={src} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          style={{ display: 'block', width: '100%', height: `${height}px`, border: 0, background: '#f8fafc' }} />
      )}
    </div>
  )
}
