import { useState } from 'react'
import { savePrice } from '../api'

const KINDS = ['whisky', 'rum', 'vodka', 'gin', 'beer', 'wine', 'brandy']
const SIZES = [180, 375, 750, 330, 500, 650, 1000]

/**
 * Correct a bottle's price, or add one the state lists never carried.
 *
 * Opened from a card it arrives prefilled, and sending the published name back
 * verbatim is what makes the correction replace that row instead of sitting
 * beside it as a near-duplicate.
 *
 * Numbers are held as strings while typing: as numbers, clearing the box gave
 * parseFloat('') -> 0 and it refilled itself with a 0 you had to delete first.
 */
export default function PriceEditForm({ state, states = [], initial = {}, onDone, onCancel }) {
  const [brand, setBrand] = useState(initial.brand || '')
  const [kind, setKind]   = useState(initial.kind || 'whisky')
  const [where, setWhere] = useState(initial.state || state || '')
  const [size, setSize]   = useState(String(initial.size_ml || 750))
  const [price, setPrice] = useState(initial.price != null ? String(initial.price) : '')
  // Only prefilled when the figure is a published one. A category typical
  // ("~42.8%") is a guess, and pushing it into the box would turn it into a
  // stated fact the moment the form is saved.
  const [abv, setAbv]     = useState(
    initial.abv != null && initial.abv_known ? String(initial.abv) : ''
  )
  const [note, setNote]   = useState('')
  const [busy, setBusy]   = useState(false)
  const [error, setError] = useState('')

  const priceN = parseFloat(price)
  const sizeN  = parseInt(size, 10)
  const abvN   = abv.trim() === '' ? null : parseFloat(abv)
  const abvBad = abvN != null && (!Number.isFinite(abvN) || abvN <= 0 || abvN > 96)
  const ok = brand.trim().length >= 2 && where && sizeN > 0 && priceN > 0 && !abvBad

  const submit = async () => {
    setError(''); setBusy(true)
    try {
      const r = await savePrice({
        brand: brand.trim(), kind, state: where, size_ml: sizeN,
        price: priceN, abv: abvN, note: note.trim() || null,
      })
      onDone?.(r.data)
    } catch (err) {
      // The server's own validation message is more useful than anything we
      // could invent here, so it is shown as written.
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
        {initial.brand ? 'Correct this price' : 'Add a price'}
      </p>

      <div>
        <label className="label">Brand</label>
        <input className="input text-xs" value={brand} placeholder="e.g. Vat 69"
               onChange={(e) => setBrand(e.target.value)} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Type</label>
          <select className="input text-xs" value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        <div>
          <label className="label">State</label>
          {/* Free text, not a dropdown. A locked list meant a price could only
              be entered for a state we already had — which is exactly the
              state you would never need to correct. Type a new one and it
              becomes selectable everywhere. */}
          <input className="input text-xs" value={where} list="known-states"
                 placeholder="e.g. Punjab"
                 onChange={(e) => setWhere(e.target.value)} />
          <datalist id="known-states">
            {states.map((s) => <option key={s} value={s} />)}
          </datalist>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Size (ml)</label>
          <input className="input text-xs" type="number" inputMode="numeric"
                 list="bottle-sizes" value={size}
                 onChange={(e) => setSize(e.target.value)} />
          {/* A list, not a dropdown: 180/375/750 cover almost everything, but
              a 275ml or a 1-litre is a real bottle and shouldn't be refused. */}
          <datalist id="bottle-sizes">
            {SIZES.map((s) => <option key={s} value={s} />)}
          </datalist>
        </div>
        <div>
          <label className="label">Price you paid (₹)</label>
          <input className="input text-xs font-bold" type="number" inputMode="decimal"
                 value={price} placeholder="e.g. 1250"
                 onChange={(e) => setPrice(e.target.value)} />
        </div>
      </div>

      {/* Strength, off the label. Optional: knowing what you paid without
          knowing the strength is completely normal, and left blank the app
          falls back to the category typical and marks it with a ~. */}
      <div>
        <label className="label">Strength (% v/v) — optional</label>
        <input className="input text-xs" type="number" inputMode="decimal"
               step="0.1" min="0" max="96"
               value={abv} placeholder="e.g. 42.8"
               onChange={(e) => setAbv(e.target.value)} />
        {abvBad ? (
          <p className="text-[10px] text-red-600 mt-1">
            Strength has to be between 0 and 96 % v/v.
          </p>
        ) : (
          <p className="text-[10px] text-gray-400 mt-1">
            Off the bottle. Left blank, we show the usual figure for the type
            with a ~ in front, rather than claiming to know.
          </p>
        )}
      </div>

      <div>
        <label className="label">Note (optional)</label>
        <input className="input text-xs" value={note}
               placeholder="e.g. shop near office charges this"
               onChange={(e) => setNote(e.target.value)} />
      </div>

      {error && <p className="text-[11px] text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button className="btn-primary flex-1 text-xs py-1.5"
                disabled={busy || !ok} onClick={submit}>
          {busy ? 'Saving…' : 'Save price'}
        </button>
        <button className="text-xs font-bold text-gray-400 px-3" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="text-[9px] text-gray-400">
        Everyone sees this, and it replaces the published price for this brand,
        state and size until someone removes it. A state we have no price list
        for is fine — your entry becomes the price there.
      </p>
    </div>
  )
}
