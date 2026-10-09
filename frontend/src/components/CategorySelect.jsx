import { useEffect, useState } from 'react'
import { getCategories } from '../api'

// One icon per category, only to make the long list quicker to scan.
const ICONS = {
  'Food & Dining': '🍽️', 'Groceries': '🛒', 'Alcohol': '🍺', 'Tobacco & Paan': '🚬',
  'Transport': '🚕', 'Travel': '✈️', 'Housing': '🏠', 'Bills & Utilities': '💡',
  'Shopping': '🛍️', 'Health': '💊', 'Personal Care': '💇', 'Entertainment': '🎬',
  'Education': '📚', 'Services': '🧰', 'Donations': '🙏', 'Small vendors': '🧺', 'Other': '📦',
}

// Fetched once per app load and shared by every picker - the list is the
// backend's spend_categories.TAXONOMY, so imports, the LLM and the forms
// all use the same buckets.
let cached = null
const load = () => {
  if (!cached) cached = getCategories().then((r) => r.data).catch((e) => { cached = null; throw e })
  return cached
}

/**
 * Category + subcategory dropdowns for the add/edit expense forms.
 *   category, subcategory - current values ('' for none)
 *   onChange({ category, subcategory })
 * A category from before this list (e.g. "Food", "Travel - Cab") still shows,
 * marked as older, until it's changed.
 */
export default function CategorySelect({ category, subcategory, onChange }) {
  const [list, setList] = useState([])
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    load().then((l) => live && setList(l)).catch(() => live && setFailed(true))
    return () => { live = false }
  }, [])

  const known = list.find((c) => c.category === category)
  const legacy = category && list.length > 0 && !known
  const subs = known?.subcategories ?? []

  return (
    <div className="grid grid-cols-2 gap-2">
      <select
        className="input"
        value={category || ''}
        disabled={!list.length && !category}
        onChange={(e) => onChange({ category: e.target.value, subcategory: '' })}
        aria-label="Category"
      >
        <option value="">{list.length ? 'Choose category' : failed ? 'Could not load' : 'Loading…'}</option>
        {legacy && <option value={category}>{category} (older category)</option>}
        {!list.length && category && <option value={category}>{category}</option>}
        {list.map((c) => (
          <option key={c.category} value={c.category}>
            {ICONS[c.category] ? `${ICONS[c.category]} ` : ''}{c.category}
          </option>
        ))}
      </select>
      <select
        className="input"
        value={subcategory || ''}
        disabled={!subs.length}
        onChange={(e) => onChange({ category, subcategory: e.target.value })}
        aria-label="Subcategory"
      >
        <option value="">{subs.length ? 'Subcategory (optional)' : 'Subcategory'}</option>
        {subs.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </div>
  )
}
