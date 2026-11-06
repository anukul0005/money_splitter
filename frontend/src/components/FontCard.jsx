import { useEffect, useState } from 'react'
import { FONTS, applyFont, currentFont, loadFont } from '../utils/appFont'

// Account: the app's font. Each choice is shown in its own lettering;
// tapping one switches the whole app to it at once.
export default function FontCard() {
  const [picked, setPicked] = useState(() => currentFont().id)
  useEffect(() => { FONTS.forEach(loadFont) }, [])   // so every preview draws in its own font

  return (
    <div className="card">
      <h2 className="text-sm font-bold text-gray-800">App font</h2>
      <p className="text-xs text-gray-500 leading-relaxed mt-1 mb-3">
        Tap one to use it everywhere in the app, straight away. Numbers keep their own even-width font. Saved on this device.
      </p>
      <div className="space-y-2">
        {FONTS.map((f) => {
          const on = picked === f.id
          return (
            <button key={f.id} type="button" onClick={() => setPicked(applyFont(f.id).id)}
              className={`w-full text-left px-3 py-2.5 border rounded-md transition-colors ${
                on ? 'bg-brand-400/10 border-brand-400' : 'bg-amber-50/50 border-amber-200 hover:bg-amber-50'}`}
              style={{ fontFamily: `${f.css}, system-ui, sans-serif` }}>
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold text-gray-900">{f.name}</span>
                {on && <span className="text-[10px] font-bold text-brand-600" style={{ fontFamily: 'inherit' }}>✓ IN USE</span>}
              </span>
              <span className="block text-[13px] text-gray-700 mt-0.5">Dinner at Punjab Grill, split with Utkarsh</span>
              <span className="block text-[11px] text-gray-400 mt-0.5">{f.note}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
