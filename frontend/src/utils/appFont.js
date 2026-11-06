// The app's font, picked in Account: one of six, applied at once everywhere
// through the --app-font variable (tailwind.config.js sans), kept on this
// device. Numbers stay in Plex Mono ('Num' comes first in the stack) - only
// the letters change. Fonts other than Plex load from Google Fonts when
// first wanted.

export const FONTS = [
  { id: 'plex',    name: 'IBM Plex Sans', css: '"IBM Plex Sans"', note: 'The original - crisp, technical' },
  { id: 'inter',   name: 'Inter',         css: '"Inter"',         note: 'Neutral, very readable', google: 'Inter:wght@400;500;600;700' },
  { id: 'dmsans',  name: 'DM Sans',       css: '"DM Sans"',       note: 'Soft, geometric', google: 'DM+Sans:wght@400;500;600;700' },
  { id: 'poppins', name: 'Poppins',       css: '"Poppins"',       note: 'Round and bold', google: 'Poppins:wght@400;500;600;700' },
  { id: 'nunito',  name: 'Nunito',        css: '"Nunito"',        note: 'Friendly, rounded ends', google: 'Nunito:wght@400;500;600;700' },
  { id: 'lora',    name: 'Lora',          css: '"Lora"',          note: 'A serif - bookish', google: 'Lora:wght@400;500;600;700' },
]

const KEY = 'settle_app_font'
const loaded = new Set()

export function loadFont(font) {
  if (!font?.google || loaded.has(font.id)) return
  loaded.add(font.id)
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?family=${font.google}&display=swap`
  document.head.appendChild(link)
}

export function currentFont() {
  let id = 'plex'
  try { id = localStorage.getItem(KEY) || 'plex' } catch { /* storage blocked */ }
  return FONTS.find((f) => f.id === id) || FONTS[0]
}

export function applyFont(id) {
  const font = FONTS.find((f) => f.id === id) || FONTS[0]
  loadFont(font)
  document.documentElement.style.setProperty('--app-font', font.css)
  try { localStorage.setItem(KEY, font.id) } catch { /* storage blocked */ }
  return font
}

// At start-up, before the first paint
export function initFont() {
  const font = currentFont()
  if (font.id !== 'plex') applyFont(font.id)
}
