import { useEffect, useRef, useState } from 'react'

/**
 * A styled stand-in for <select> - the native control pops Safari/iOS's own
 * wheel or list, which looks nothing like the rest of the app. This renders
 * the trigger and the option list entirely in the app's own CSS instead, so
 * both match on every platform. Same value/onChange(value) shape as a plain
 * controlled <select> would use.
 */
export default function Dropdown({ options, value, onChange, className = '' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const current = options.find((o) => o.value === value)

  return (
    <div className={`relative ${className}`} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="input text-sm flex items-center justify-between gap-2"
      >
        <span className="truncate">{current?.label ?? 'Select…'}</span>
        <svg
          className={`w-3.5 h-3.5 shrink-0 text-amber-400 transition-transform ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 12 12" fill="none"
        >
          <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul className="absolute left-0 right-0 top-full mt-1 z-20 bg-white border border-amber-200 rounded-md shadow-lg overflow-hidden max-h-64 overflow-y-auto">
          {options.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                onClick={() => { onChange(o.value); setOpen(false) }}
                className={`w-full text-left px-3 py-2 text-xs border-b border-amber-50 last:border-0 ${
                  o.value === value ? 'text-brand-600 font-bold bg-brand-50' : 'text-gray-700 hover:bg-amber-50'
                }`}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
