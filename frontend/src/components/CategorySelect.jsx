import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { getCategories } from '../api'

// Fetched once per app load and shared by every picker - the list is the
// backend's spend_categories.TAXONOMY, so imports, the LLM and the forms
// all use the same buckets.
let cached = null
const load = () => {
  if (!cached) cached = getCategories().then((r) => r.data).catch((e) => { cached = null; throw e })
  return cached
}

/**
 * Category + subcategory picker for the add/edit expense forms, in the
 * app's own UI rather than the phone's native select wheel: a field that
 * opens a bottom sheet with search, the categories, and - under the one
 * tapped - its subcategories.
 *   category, subcategory - current values ('' for none)
 *   onChange({ category, subcategory })
 * A category from before this list (e.g. "Food", "Travel - Cab") still
 * shows, marked as older, until it's changed.
 */
export default function CategorySelect({ category, subcategory, onChange }) {
  const [list, setList]     = useState([])
  const [failed, setFailed] = useState(false)
  const [open, setOpen]     = useState(false)
  const [expanded, setExpanded] = useState('')
  const [query, setQuery]   = useState('')

  useEffect(() => {
    let live = true
    load().then((l) => live && setList(l)).catch(() => live && setFailed(true))
    return () => { live = false }
  }, [])

  const known = list.find((c) => c.category === category)
  const legacy = category && list.length > 0 && !known

  const openSheet = () => {
    setQuery('')
    setExpanded(known ? category : '')
    setOpen(true)
  }
  const pick = (cat, sub = '') => {
    onChange({ category: cat, subcategory: sub })
    setOpen(false)
  }

  // Search matches a category name or any of its subcategories; a match on
  // a subcategory opens that category so the hit is visible.
  const q = query.trim().toLowerCase()
  const shown = useMemo(() => {
    if (!q) return list.map((c) => ({ ...c, subs: c.subcategories }))
    return list
      .map((c) => {
        const catHit = c.category.toLowerCase().includes(q)
        const subs = c.subcategories.filter((s) => s.toLowerCase().includes(q))
        return catHit ? { ...c, subs: c.subcategories } : subs.length ? { ...c, subs } : null
      })
      .filter(Boolean)
  }, [list, q])

  return (
    <>
      <button
        type="button"
        onClick={openSheet}
        disabled={!list.length && !category}
        className="input flex items-center justify-between text-left gap-2 disabled:opacity-60"
      >
        <span className={`truncate ${category ? 'text-gray-900' : 'text-amber-400'}`}>
          {category ? (
            <>
              {category}
              {legacy && <span className="text-gray-400"> (older)</span>}
              {subcategory && <span className="text-gray-500"> › {subcategory}</span>}
            </>
          ) : list.length ? 'Choose a category' : failed ? 'Could not load categories' : 'Loading…'}
        </span>
        <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && createPortal(
        <div
          className="fixed inset-0 z-[300] flex items-end md:items-center justify-center bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false) }}
        >
          <div className="bg-cream w-full md:max-w-md max-h-[80svh] flex flex-col border-t border-amber-200 md:border shadow-2xl">
            <div className="px-4 pt-4 pb-3 border-b border-amber-100 flex-shrink-0">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-black tracking-widest text-gray-800">Category</h2>
                <button type="button" onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-700 p-1" aria-label="Close">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <input
                className="input py-2 text-xs"
                placeholder="Search, e.g. coffee, cab, rent"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            {/* data-modal-scroll: the edit-expense modal underneath blocks
                touch scrolling everywhere except elements marked with it. */}
            <div
              data-modal-scroll
              className="overflow-y-auto overscroll-contain flex-1 min-h-0"
              style={{ touchAction: 'pan-y', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
            >
              {category && (
                <button
                  type="button"
                  onClick={() => pick('', '')}
                  className="w-full text-left px-4 py-2.5 text-[11px] font-bold text-gray-400 border-b border-amber-100 hover:bg-amber-50"
                >
                  Clear category
                </button>
              )}
              {shown.length === 0 && (
                <p className="px-4 py-6 text-xs text-gray-400 text-center">Nothing matches “{query}”.</p>
              )}
              {shown.map((c) => {
                const isOpen = q ? true : expanded === c.category
                const isCurrent = c.category === category
                return (
                  <div key={c.category} className="border-b border-amber-100">
                    <button
                      type="button"
                      onClick={() => setExpanded((e) => (e === c.category ? '' : c.category))}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-amber-50 ${isCurrent ? 'bg-brand-50' : ''}`}
                    >
                      <span className={`flex-1 text-[12.5px] font-bold ${isCurrent ? 'text-brand-600' : 'text-gray-800'}`}>{c.category}</span>
                      <span className="text-[10px] text-gray-400">{c.subcategories.length}</span>
                      <svg className={`w-4 h-4 text-gray-300 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {isOpen && (
                      <div className="px-4 pb-3 flex flex-wrap gap-1.5">
                        <Chip active={isCurrent && !subcategory} onClick={() => pick(c.category, '')}>
                          Just {c.category}
                        </Chip>
                        {c.subs.map((s) => (
                          <Chip key={s} active={isCurrent && subcategory === s} onClick={() => pick(c.category, s)}>
                            {s}
                          </Chip>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1.5 text-[11px] font-bold border transition-colors ${
        active ? 'bg-brand-400 text-white border-brand-400' : 'bg-cream text-gray-600 border-amber-200 hover:text-gray-900'
      }`}
    >
      {children}
    </button>
  )
}
