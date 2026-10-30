import { useState } from 'react'

/**
 * The sports pages (Betting analytics, a match, My bets) in Arial or the app's
 * IBM Plex - a trial switch while the look is decided; remembered on this device.
 */
const KEY = 'sports_font'
const read = () => { try { return localStorage.getItem(KEY) === 'arial' } catch { return false } }

export default function SportsFont({ children }) {
  const [arial, setArial] = useState(read)
  const flip = () => {
    const v = !arial
    setArial(v)
    try { localStorage.setItem(KEY, v ? 'arial' : 'plex') } catch { /* private mode */ }
  }
  return (
    <div className={arial ? 'sports-arial' : ''}>
      {children}
      <button onClick={flip}
        className="fixed z-40 left-3 bottom-24 md:bottom-4 flex items-center rounded-full border border-gray-200 bg-white/95 shadow-md text-[11px] font-bold overflow-hidden">
        <span className={`px-2.5 py-1.5 ${!arial ? 'bg-gray-900 text-white' : 'text-gray-500'}`} style={{ fontFamily: '"IBM Plex Sans", sans-serif' }}>Plex</span>
        <span className={`px-2.5 py-1.5 ${arial ? 'bg-gray-900 text-white' : 'text-gray-500'}`} style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>Arial</span>
      </button>
    </div>
  )
}
