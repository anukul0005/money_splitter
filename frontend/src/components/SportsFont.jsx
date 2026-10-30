import { useEffect, useState } from 'react'

/**
 * The sports pages (Betting analytics, a match, My bets) in a chosen font -
 * a trial picker while the look is decided; remembered on this device.
 * Baskerville is on Apple devices; elsewhere Libre Baskerville comes from
 * Google Fonts, loaded only when picked.
 */
const KEY = 'sports_font'
export const FONTS = [
  { id: 'plex', name: 'Plex (now)', stack: null },
  { id: 'arial', name: 'Arial', stack: 'Arial, Helvetica, sans-serif' },
  { id: 'helvetica', name: 'Helvetica', stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { id: 'verdana', name: 'Verdana', stack: 'Verdana, Geneva, sans-serif' },
  { id: 'baskerville', name: 'Baskerville', stack: 'Baskerville, "Libre Baskerville", "Baskerville Old Face", Georgia, serif',
    css: 'https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&display=swap' },
  { id: 'georgia', name: 'Georgia', stack: 'Georgia, "Times New Roman", serif' },
]
const read = () => { try { return localStorage.getItem(KEY) || 'plex' } catch { return 'plex' } }

export default function SportsFont({ children }) {
  const [id, setId] = useState(read)
  const [open, setOpen] = useState(false)
  const font = FONTS.find((f) => f.id === id) || FONTS[0]
  useEffect(() => {
    if (!font.css || document.querySelector(`link[href="${font.css}"]`)) return
    const l = document.createElement('link')
    l.rel = 'stylesheet'
    l.href = font.css
    document.head.appendChild(l)
  }, [font.css])
  const pick = (f) => {
    setId(f.id)
    setOpen(false)
    try { localStorage.setItem(KEY, f.id) } catch { /* private mode */ }
  }
  return (
    <div className={font.stack ? 'sports-font' : ''} style={font.stack ? { '--sports-font': font.stack } : undefined}>
      {children}
      <div className="fixed z-40 left-3 bottom-24 md:bottom-4 sports-font-picker">
        {open && (
          <div className="mb-1.5 rounded-xl border border-gray-200 bg-white shadow-lg overflow-hidden">
            {FONTS.map((f) => (
              <button key={f.id} onClick={() => pick(f)}
                className={`block w-full text-left px-3 py-2 text-[13px] border-t border-gray-100 first:border-t-0 ${f.id === id ? 'bg-gray-900 text-white' : 'text-gray-800'}`}
                style={{ fontFamily: f.stack || '"IBM Plex Sans", sans-serif' }}>
                {f.name} <span className={`ml-2 text-[11px] ${f.id === id ? 'text-gray-300' : 'text-gray-400'}`}>7-6 ₹1,250</span>
              </button>
            ))}
          </div>
        )}
        <button onClick={() => setOpen((o) => !o)}
          className="rounded-full border border-gray-200 bg-white/95 shadow-md px-3 py-1.5 text-[11px] font-bold text-gray-700"
          style={{ fontFamily: font.stack || '"IBM Plex Sans", sans-serif' }}>
          Aa · {font.name} {open ? '▾' : '▴'}
        </button>
      </div>
    </div>
  )
}
