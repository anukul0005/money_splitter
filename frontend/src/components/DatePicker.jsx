import { useEffect, useRef, useState } from 'react'

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const pad2 = (n) => String(n).padStart(2, '0')
const toValue = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const fromValue = (v) => {
  if (!v) return null
  const [y, m, d] = v.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/**
 * A styled stand-in for <input type="date"> - same reasoning as Dropdown:
 * the native control is Safari/iOS's own picker, not the app's UI. Value/
 * onChange both use the same "YYYY-MM-DD" string <input type="date"> does,
 * so this drops in wherever that did.
 */
export default function DatePicker({ value, onChange, placeholder = 'Select date', className = '' }) {
  const [open, setOpen] = useState(false)
  const selected = fromValue(value)
  const [viewMonth, setViewMonth] = useState(selected || new Date())
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  useEffect(() => {
    if (open) setViewMonth(selected || new Date())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const y = viewMonth.getFullYear(), m = viewMonth.getMonth()
  const firstDow = new Date(y, m, 1).getDay()
  const daysInMonth = new Date(y, m + 1, 0).getDate()
  const cells = [...Array(firstDow).fill(null), ...Array(daysInMonth).fill(0).map((_, i) => i + 1)]

  const pick = (day) => { onChange(toValue(new Date(y, m, day))); setOpen(false) }
  const isSelected = (day) =>
    selected && selected.getFullYear() === y && selected.getMonth() === m && selected.getDate() === day
  const isToday = (day) => {
    const t = new Date()
    return t.getFullYear() === y && t.getMonth() === m && t.getDate() === day
  }

  return (
    <div className={`relative ${className}`} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="input text-sm flex items-center justify-between gap-2"
      >
        <span className={value ? 'text-gray-800' : 'text-amber-400'}>
          {selected ? selected.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : placeholder}
        </span>
        <svg className="w-3.5 h-3.5 shrink-0 text-amber-400" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M2 6.5h12M5 1.5v3M11 1.5v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 bg-white border border-amber-200 rounded-md shadow-lg p-3 w-64">
          <div className="flex items-center justify-between mb-2">
            <button
              type="button" onClick={() => setViewMonth(new Date(y, m - 1, 1))}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-amber-50 text-gray-500"
            >‹</button>
            <span className="text-xs font-bold text-gray-700">
              {viewMonth.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
            </span>
            <button
              type="button" onClick={() => setViewMonth(new Date(y, m + 1, 1))}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-amber-50 text-gray-500"
            >›</button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center">
            {WEEKDAYS.map((w, i) => (
              <span key={i} className="text-[10px] text-amber-400 font-bold">{w}</span>
            ))}
            {cells.map((day, i) => day === null ? <span key={i} /> : (
              <button
                key={i} type="button" onClick={() => pick(day)}
                className={`text-xs rounded-md py-1.5 transition-colors ${
                  isSelected(day) ? 'bg-brand-400 text-white font-bold'
                    : isToday(day) ? 'text-brand-600 font-bold hover:bg-amber-50'
                    : 'text-gray-700 hover:bg-amber-50'
                }`}
              >
                {day}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
