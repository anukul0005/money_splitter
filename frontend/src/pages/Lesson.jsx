import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { lessonHtml, lessonsList } from '../api'
import { currentFont } from '../utils/appFont'

/**
 * A lesson page (/lessons/:slug): the self-contained HTML from the backend
 * (routers/lessons.py), shown full height in a sandboxed frame - its scripts
 * run (sliders, calculators, chapter list) but it can't touch the app.
 *
 * The lessons were made with their own look; on the way in they're re-dressed
 * in the app's: light canvas, white cards with the 0.375rem radius, orange
 * accents, slate text, the font picked in Account with numbers in Plex Mono.
 */
const GF = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap'

function dress(html) {
  const font = currentFont()
  const links = [GF, font.google ? `https://fonts.googleapis.com/css2?family=${font.google}&display=swap` : null]
    .filter(Boolean).map((h) => `<link rel="stylesheet" href="${h}">`).join('')
  const body = `${font.css}, "IBM Plex Sans", system-ui, sans-serif`
  const css = `<style id="app-theme">
:root[data-theme="light"] {
  --bg: #f8fafc; --surface: #ffffff; --ink: #111827; --muted: #64748b; --line: #e2e8f0;
  --pitch: #ea580c; --pitch-soft: #fff7ed; --market: #b45309; --market-soft: #fefce8; --loss: #dc2626; --loss-soft: #fef2f2;
  --slate: #475569; --code: #f1f5f9;
  --f-display: ${body}; --f-body: ${body}; --f-mono: "IBM Plex Mono", ui-monospace, monospace;
}
body { letter-spacing: -0.01em; -webkit-font-smoothing: antialiased; }
h1, h2, h3 { font-weight: 700; letter-spacing: -0.02em; }
h1 { font-size: 1.75rem; } h2 { font-size: 1.3rem; } h3 { font-size: 1.05rem; }
.panel, .card, .callout, .formula, .stat, details.qa, .calc, .btn, .chip, .tnode, input[type=text], #tocSheet .sheet, table { border-radius: .375rem; }
.panel, .card, .stat, details.qa { box-shadow: 0 1px 2px rgba(15, 23, 42, .05); }
.callout, .formula, .panel { overflow: hidden; }
.pos { color: #15803d !important; }
.res.W { background: #16a34a; } .res.L { background: #dc2626; }
.verdict.bet { color: #15803d; border-color: #15803d; }
td.bet { background: #f0fdf4 !important; color: #15803d; }
.stat b, .out { font-weight: 700; }
.part { border-radius: .375rem; background: #0f172a; color: #f8fafc; }
.part .eyebrow, .part p { color: #f8fafc; }
.eyebrow { color: #ea580c; }
.chip[aria-pressed="true"] { background: #0f172a; color: #fff; border-color: #0f172a; }
header.top { background: #f8fafc; }
</style>`
  let h = html.replace(/<html([^>]*)>/i, (m, a) => (/data-theme/.test(a) ? m : `<html${a} data-theme="light">`))
  h = /<\/head>/i.test(h) ? h.replace(/<\/head>/i, `${links}${css}</head>`) : `${links}${css}${h}`
  return h
}

export default function Lesson() {
  const { slug } = useParams()
  const nav = useNavigate()
  const [html, setHtml] = useState(null)
  const [meta, setMeta] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    setHtml(null); setErr('')
    lessonHtml(slug).then((r) => setHtml(r.data)).catch(() => setErr('Could not load this lesson.'))
    lessonsList().then((r) => setMeta((r.data || []).find((x) => x.slug === slug) || null)).catch(() => {})
  }, [slug])
  const doc = useMemo(() => (html ? dress(html) : null), [html])
  return (
    <div className="flex flex-col h-[100dvh] md:h-screen pb-16 md:pb-0">
      <div className="px-5 pt-10 md:pt-6 pb-3 bg-cream border-b border-amber-100/60 shrink-0">
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 mb-2">← Back</button>
        <h1 className="text-xl font-black tracking-tight">{meta?.title || 'Lesson'}</h1>
        {meta?.about && <p className="mt-1 text-[11px] text-gray-400 leading-snug">{meta.about}</p>}
      </div>
      {err && <p className="text-xs text-red-600 p-5">{err}</p>}
      {!doc && !err && <p className="text-xs text-gray-400 text-center py-10">Loading…</p>}
      {doc && (
        <iframe title={meta?.title || 'Lesson'} srcDoc={doc} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          className="flex-1 w-full border-0 bg-canvas" />
      )}
    </div>
  )
}
