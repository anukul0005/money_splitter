import { useEffect, useRef, useState } from 'react'

const SEARCH_FROM = 10   // options; a longer list gets a filter box

/**
 * A styled stand-in for <select> - the native control pops Safari/iOS's own
 * wheel or list, which looks nothing like the rest of the app. This renders
 * the trigger and the option list entirely in the app's own CSS instead, so
 * both match on every platform. Same value/onChange(value) shape as a plain
 * controlled <select> would use; values compare as strings, so a number
 * and its string form are the same option.
 *
 *   options      [{ value, label }]
 *   placeholder  shown when no option matches `value`
 *   disabled     greys the trigger out and won't open
 *   size         'sm' for a compact trigger (filters, toolbars)
 */
export default function Dropdown({
  options, value, onChange, placeholder = 'Select…', disabled = false,
  size = 'md', className = '',
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef(null)

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

  const current = options.find((o) => String(o.value) === String(value ?? ''))
  const searchable = options.length > SEARCH_FROM
  const q = query.trim().toLowerCase()
  const shown = q ? options.filter((o) => String(o.label).toLowerCase().includes(q)) : options

  const trigger = size === 'sm'
    ? 'border border-amber-200 rounded-md bg-cream text-gray-700 font-bold text-xs px-2 py-1'
    : 'input text-sm'

  return (
    <div className={`relative ${className}`} ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => { setQuery(''); setOpen((o) => !o) }}
        className={`${trigger} w-full flex items-center justify-between gap-2 text-left disabled:opacity-50`}
      >
        <span className={`truncate ${current ? '' : 'text-amber-400'}`}>{current?.label ?? placeholder}</span>
        <svg
          className={`w-3.5 h-3.5 shrink-0 text-amber-400 transition-transform ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 12 12" fill="none"
        >
          <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className={`absolute top-full mt-1 z-30 bg-white border border-amber-200 rounded-md shadow-lg overflow-hidden ${
          size === 'sm' ? 'right-0 min-w-[10rem]' : 'left-0 right-0'
        }`}>
          {searchable && (
            <div className="p-2 border-b border-amber-100">
              <input
                className="w-full border border-amber-200 rounded-md px-2.5 py-1.5 text-xs focus:outline-none focus:border-brand-400"
                placeholder="Search…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}
          <ul data-modal-scroll className="max-h-64 overflow-y-auto overscroll-contain" style={{ touchAction: 'pan-y' }}>
            {shown.length === 0 && <li className="px-3 py-2 text-xs text-gray-400">No matches</li>}
            {shown.map((o) => {
              const active = String(o.value) === String(value ?? '')
              return (
                <li key={String(o.value)}>
                  <button
                    type="button"
                    onClick={() => { onChange(o.value); setOpen(false) }}
                    className={`w-full text-left px-3 py-2.5 text-xs border-b border-amber-50 last:border-0 ${
                      active ? 'text-brand-600 font-bold bg-brand-50' : 'text-gray-700 hover:bg-amber-50'
                    }`}
                  >
                    {o.label}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
