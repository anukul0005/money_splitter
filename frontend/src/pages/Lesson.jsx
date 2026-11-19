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
 * calculators, chapter list) but it can't touch the app.
 */
export default function Lesson() {
  const { slug } = useParams()
  const nav = useNavigate()
  const [src, setSrc] = useState(null)
  const [meta, setMeta] = useState(null)
  const [err, setErr] = useState('')
  const head = useRef(null)
  const [height, setHeight] = useState(0)
  useEffect(() => {
    setSrc(null); setErr('')
    lessonSrc(slug, currentFont().id).then(setSrc).catch(() => setErr('Could not load this lesson.'))
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
        <h1 className="text-xl font-black tracking-tight">{meta?.title || 'Lesson'}</h1>
        {meta?.about && <p className="mt-1 text-[11px] text-gray-400 leading-snug">{meta.about}</p>}
      </div>
      {err && <p className="text-xs text-red-600 p-5">{err}</p>}
      {!src && !err && <p className="text-xs text-gray-400 text-center py-10">Loading…</p>}
      {src && (
        <iframe title={meta?.title || 'Lesson'} src={src} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          style={{ display: 'block', width: '100%', height: `${height}px`, border: 0, background: '#f8fafc' }} />
      )}
    </div>
  )
}
