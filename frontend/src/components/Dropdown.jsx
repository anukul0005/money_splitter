import { useState } from 'react'

/**
 * A picker that looks and behaves like the app's own search-suggestion
 * list, not a native <select> - iOS and Android both render a native
 * select's open list as a full system overlay (their own font, their own
 * sizing, a checkmark instead of the app's own highlight), completely
 * outside CSS's reach. No amount of styling the closed box ever touched
 * that overlay, which is why "State" still popped up as a plain iOS sheet
 * even once the box itself matched the search bar.
 *
 * `options` is `[{ value, label }]` - callers with a plain list of strings
 * (states, cities) map them to `{ value: s, label: s }` themselves, since
 * a few pickers already carry a real label distinct from the value (state
 * display names, for one).
 */
export default function Dropdown({ value, options, onChange, className = '', align = 'right' }) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)

  return (
    <div className={`relative ${align === 'right' ? 'text-right' : ''}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        // Closed just late enough for a tap on an option below to land
        // first - the same delayed-blur trick the brand search suggestions
        // already use, so a tap doesn't get eaten by this closing first.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        // .input bakes in w-full for the app's usual full-width fields;
        // every caller of this component wants a compact, content-sized
        // trigger instead (that's the whole point of it), so w-auto is
        // fixed here rather than left to each caller to remember. min-w
        // guards against a real flexbox trap: `truncate`'s overflow:hidden
        // gives its span an automatic minimum width of 0, so a caller's
        // max-w that left too little room didn't truncate the text - it
        // shrank it clean away to nothing, chevron and all, which is what
        // "State" was actually showing.
        className={`input w-auto min-w-[88px] inline-flex items-center justify-between gap-1.5 ${className}`}
      >
        <span className="truncate">{current?.label ?? value}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
             className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <ul className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-full mt-1 z-20
                        bg-white border border-amber-200 rounded-md shadow-lg overflow-hidden
                        max-h-64 overflow-y-auto min-w-full`}>
          {options.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                // Fires before the trigger's onBlur closes the list, same
                // reason the brand suggestions use onMouseDown here too.
                onMouseDown={() => { onChange(o.value); setOpen(false) }}
                className={`w-full text-left px-3 py-2 text-xs whitespace-nowrap border-b border-amber-50 last:border-0 ${
                  o.value === value
                    ? 'bg-amber-50 text-brand-700 font-bold'
                    : 'text-gray-700 hover:bg-amber-50'
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
