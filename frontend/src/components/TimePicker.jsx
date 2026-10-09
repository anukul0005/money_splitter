import { useEffect, useRef, useState } from 'react'

const pad2 = (n) => String(n).padStart(2, '0')
const MINUTES = Array.from({ length: 12 }, (_, i) => pad2(i * 5))

/**
 * A styled stand-in for <input type="time"> - same reasoning as Dropdown
 * and DatePicker: the native control is iOS's wheel, not the app's UI.
 * Value/onChange use "HH:MM" (24-hour) like <input type="time">, '' for
 * none. Hours on a grid, minutes in fives - plus the stored minute if it
 * isn't one (an imported "14:37" stays exactly as it was).
 */
export default function TimePicker({ value, onChange, placeholder = 'Select time', className = '' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const [h, m] = value ? value.split(':') : ['', '']

  useEffect(() => {
    if (!open) return
    const onOutside = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('touchstart', onOutside, { passive: true })
    return () => {
      document.removeEventListener('mousedown', onOutside)
      document.removeEventListener('touchstart', onOutside)
    }
  }, [open])

  const label = value
    ? new Date(2000, 0, 1, +h, +m).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })
    : placeholder
  const minutes = m && !MINUTES.includes(m) ? [...MINUTES, m].sort() : MINUTES

  const setHour = (hh) => onChange(`${hh}:${m || '00'}`)
  const setMinute = (mm) => { onChange(`${h || pad2(new Date().getHours())}:${mm}`); setOpen(false) }
  const now = () => {
    const d = new Date()
    onChange(`${pad2(d.getHours())}:${pad2(d.getMinutes())}`)
    setOpen(false)
  }

  const cell = (active) => `text-xs rounded-md py-1.5 transition-colors ${
    active ? 'bg-brand-400 text-white font-bold' : 'text-gray-700 hover:bg-amber-50'
  }`

  return (
    <div className={`relative ${className}`} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="input text-sm flex items-center justify-between gap-2 text-left"
      >
        <span className={value ? 'text-gray-800' : 'text-amber-400'}>{label}</span>
        <svg className="w-3.5 h-3.5 shrink-0 text-amber-400" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 4.8V8l2.2 1.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-30 bg-white border border-amber-200 rounded-md shadow-lg p-3 w-72">
          <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest mb-1.5">Hour</p>
          <div className="grid grid-cols-6 gap-1 text-center">
            {Array.from({ length: 24 }, (_, i) => pad2(i)).map((hh) => (
              <button key={hh} type="button" onClick={() => setHour(hh)} className={cell(hh === h)}>{hh}</button>
            ))}
          </div>
          <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest mt-3 mb-1.5">Minute</p>
          <div className="grid grid-cols-6 gap-1 text-center">
            {minutes.map((mm) => (
              <button key={mm} type="button" onClick={() => setMinute(mm)} className={cell(mm === m)}>:{mm}</button>
            ))}
          </div>
          <div className="flex justify-between mt-2 pt-2 border-t border-amber-100">
            <button type="button" onClick={now} className="text-xs font-bold text-brand-600 px-1">Now</button>
            {value && (
              <button type="button" onClick={() => { onChange(''); setOpen(false) }} className="text-xs font-bold text-gray-400 px-1">
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
