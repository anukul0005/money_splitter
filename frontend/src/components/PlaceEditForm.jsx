import { useState } from 'react'
import { savePlace } from '../api'

/**
 * Add a restaurant, or correct one the published listings got wrong.
 *
 * This is the half that makes the food table improve with use: a listing is a
 * blog post from a few months ago, and somebody who paid the bill last week
 * knows better. A place added here is recommended from then on, filters by
 * cuisine and kind exactly like a published one, and can be entered for a city
 * that has no listings at all.
 *
 * Cuisines are picked from the controlled list rather than typed. Free text
 * would be invisible to the cuisine filter, so the place would be saved and
 * then never come back.
 */
export default function PlaceEditForm({
  city, cities = [], cuisines = [], kinds = [], initial = {}, onDone, onCancel,
}) {
  const [name, setName]   = useState(initial.name || '')
  const [where, setWhere] = useState(initial.city || city || '')
  const [area, setArea]   = useState(initial.area || '')
  const [picked, setPicked] = useState(initial.cuisines || [])
  const [kind, setKind]   = useState(initial.kind || 'dine-in')
  const [veg, setVeg]     = useState(!!initial.veg_only)
  const [forTwo, setForTwo] = useState(
    initial.for_two != null ? String(initial.for_two) : ''
  )
  const [note, setNote]   = useState('')
  const [busy, setBusy]   = useState(false)
  const [error, setError] = useState('')

  const costN = parseFloat(forTwo)
  const ok = name.trim().length >= 2 && where && costN > 0

  const toggle = (c) => setPicked((p) =>
    p.includes(c) ? p.filter((x) => x !== c) : [...p, c])

  const submit = async () => {
    setError(''); setBusy(true)
    try {
      const r = await savePlace({
        name: name.trim(), city: where, area: area.trim() || null,
        cuisines: picked, kind, veg_only: veg, for_two: costN,
        note: note.trim() || null,
      })
      onDone?.(r.data)
    } catch (err) {
      const d = err.response?.data?.detail
      setError(
        Array.isArray(d) ? (d[0]?.msg || 'That did not look right')
          : d || `Could not save (${err.response?.status || 'network error'})`
      )
    } finally { setBusy(false) }
  }

  return (
    <div className="mt-2 pt-2 border-t border-amber-100 space-y-2">
      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
        {initial.name ? 'Correct this place' : 'Add a place'}
      </p>

      <div>
        <label className="label">Name</label>
        <input className="input text-xs" value={name} placeholder="e.g. Sagar Ratna"
               onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">City</label>
          {/* Free text, not a dropdown: the whole point is being able to add
              somewhere we have no listings for at all. */}
          <input className="input text-xs" value={where} list="known-cities"
                 onChange={(e) => setWhere(e.target.value)} />
          <datalist id="known-cities">
            {cities.map((c) => <option key={c} value={c} />)}
          </datalist>
        </div>
        <div>
          <label className="label">Area</label>
          <input className="input text-xs" value={area} placeholder="e.g. Sector 15"
                 onChange={(e) => setArea(e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Kind of place</label>
          <select className="input text-xs" value={kind} onChange={(e) => setKind(e.target.value)}>
            {(kinds.length ? kinds : [{ value: 'dine-in', name: 'Sit-down meal' }])
              .map((k) => <option key={k.value} value={k.value}>{k.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Cost for two (₹)</label>
          <input className="input text-xs font-bold" type="number" inputMode="decimal"
                 value={forTwo} placeholder="e.g. 1200"
                 onChange={(e) => setForTwo(e.target.value)} />
        </div>
      </div>

      <div>
        <label className="label">Cuisine</label>
        <div className="flex flex-wrap gap-1">
          {cuisines.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => toggle(c)}
              className={`rounded px-2 py-0.5 text-[10px] font-bold border transition-all ${
                picked.includes(c)
                  ? 'bg-brand-400 border-brand-400 text-white'
                  : 'bg-cream border-amber-200 text-gray-500 hover:bg-amber-50'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" className="accent-brand-400"
               checked={veg} onChange={(e) => setVeg(e.target.checked)} />
        <span className="text-xs font-bold text-gray-600">Pure veg</span>
      </label>

      <div>
        <label className="label">Note (optional)</label>
        <input className="input text-xs" value={note}
               placeholder="e.g. ate here last week, bill was higher"
               onChange={(e) => setNote(e.target.value)} />
      </div>

      {error && <p className="text-[11px] text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button className="btn-primary flex-1 text-xs py-1.5"
                disabled={busy || !ok} onClick={submit}>
          {busy ? 'Saving…' : 'Save place'}
        </button>
        <button className="text-xs font-bold text-gray-400 px-3" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="text-[9px] text-gray-400">
        Everyone sees this, and it replaces the published entry for this place
        and city until someone removes it.
      </p>
    </div>
  )
}
