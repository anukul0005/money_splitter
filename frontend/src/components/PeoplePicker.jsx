import { useState } from 'react'

/**
 * Who this recommendation/forecast is for, as a type-ahead rather than a
 * wall of one button per friend. A handful of friends fit fine as buttons,
 * but the list only grows, never shrinks, and a wide friend circle turned
 * this into several rows of pills to scan through just to find one name -
 * the same "app's own suggestion list" pattern the brand and restaurant
 * search boxes already use, applied to people instead of bottles.
 *
 * Selected people show as removable chips above the box; the box itself
 * only ever suggests names not already picked.
 */
export default function PeoplePicker({ options, selected, onChange, placeholder = 'Add a person', allowNew = false }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)

  const qLower = query.trim().toLowerCase()
  const suggestions = qLower.length === 0 ? [] : options
    .filter((n) => !selected.includes(n) && n.toLowerCase().includes(qLower))
    .sort((a, b) => {
      const aStarts = a.toLowerCase().startsWith(qLower)
      const bStarts = b.toLowerCase().startsWith(qLower)
      if (aStarts !== bStarts) return aStarts ? -1 : 1
      return a.length - b.length
    })
    .slice(0, 8)

  // A typed name that isn't already an option or picked - offered as a new
  // person when the caller allows it (loans and bills can name someone who
  // isn't in any group yet).
  const typed = query.trim()
  const canAddNew = allowNew && typed.length > 0 &&
    ![...options, ...selected].some((n) => n.toLowerCase() === qLower)

  const add = (name) => {
    onChange([...selected, name])
    setQuery('')
    setOpen(false)
  }
  const remove = (name) => onChange(selected.filter((x) => x !== name))

  return (
    <div>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {selected.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => remove(n)}
              className="rounded-md pl-2.5 pr-1.5 py-1 text-xs font-bold border bg-brand-400 border-brand-400 text-white active:scale-95 transition-all flex items-center gap-1"
            >
              {n}
              <span className="opacity-80">✕</span>
            </button>
          ))}
        </div>
      )}
      <div className="relative">
        <input
          className="input text-xs"
          value={query}
          placeholder={placeholder}
          onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          // Delayed so a tap on a suggestion registers before the blur
          // closes the list out from under it - same trick the brand and
          // restaurant search suggestions already use.
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (suggestions.length > 0) add(suggestions[0])
              else if (canAddNew) add(typed)
            }
          }}
        />
        {open && (suggestions.length > 0 || canAddNew) && (
          <ul className="absolute left-0 right-0 top-full mt-1 z-20 bg-white border border-amber-200 rounded-md shadow-lg overflow-hidden max-h-56 overflow-y-auto">
            {suggestions.map((n) => (
              <li key={n}>
                <button
                  type="button"
                  onMouseDown={() => add(n)}
                  className="w-full text-left px-3 py-2 text-xs text-gray-700 hover:bg-amber-50 border-b border-amber-50 last:border-0"
                >
                  {n}
                </button>
              </li>
            ))}
            {canAddNew && (
              <li>
                <button
                  type="button"
                  onMouseDown={() => add(typed)}
                  className="w-full text-left px-3 py-2 text-xs font-bold text-brand-600 hover:bg-amber-50"
                >
                  + Add "{typed}" as a new person
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  )
}
