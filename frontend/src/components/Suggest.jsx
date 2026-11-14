import { useEffect, useState } from 'react'
import { suggestions } from '../api'

/** Consider / skip on every match still to play (backend suggest.py): bet a
 *  side only when our chance x the price clears the expected-return
 *  threshold I set - the same setting everywhere (P/L dashboard sets it). */
const EDGE_KEY = 'sports.edge'
export const EDGES = [0.1, 0.15, 0.2, 0.3]

export function getEdge() {
  try { return Number(localStorage.getItem(EDGE_KEY)) || 0.2 } catch { return 0.2 }
}

export function useEdge() {
  const [edge, set] = useState(getEdge)
  useEffect(() => {
    const f = () => set(getEdge())
    window.addEventListener('sports-edge', f)
    return () => window.removeEventListener('sports-edge', f)
  }, [])
  const save = (v) => {
    try { localStorage.setItem(EDGE_KEY, String(v)) } catch { /* private mode */ }
    set(v)
    window.dispatchEvent(new Event('sports-edge'))
  }
  return [edge, save]
}

/** {match key: suggestion} for a sport's upcoming matches, refreshed every few minutes. */
export function useSuggestions(sport, active, tick) {
  const [edge] = useEdge()
  const [d, setD] = useState(null)
  useEffect(() => {
    if (!active) return undefined
    let alive = true
    const load = () => suggestions(sport, edge).then((r) => { if (alive) setD(r.data.suggestions) }).catch(() => {})
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, 3 * 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [sport, active, edge, tick])
  return d
}

const last = (n) => (n || '').split(' / ').map((x) => x.split(' ').slice(-1)[0]).join(' / ')
const pc = (x) => `${x > 0 ? '+' : ''}${Math.round(100 * x)}%`

/** One line under a match. */
export function SuggestTag({ s, className = '' }) {
  if (!s) return null
  if (s.verdict === 'consider') {
    return (
      <p className={`text-[10px] font-bold text-green-800 bg-green-50 border border-green-200 rounded px-1.5 py-0.5 mt-1 inline-block ${className}`}>
        ✓ Consider {s.side === 3 ? 'the draw' : last(s.names[s.side - 1])} @ {s.price.toFixed(2)} · {pc(s.expected)} expected
        <span className="font-normal text-green-700"> (we say {Math.round(100 * s.probs[s.side - 1])}%)</span>
      </p>
    )
  }
  if (s.verdict === 'skip') {
    return (
      <p className={`text-[10px] text-gray-400 mt-1 ${className}`}>
        Skip - best is {s.best_side === 3 ? 'the draw' : last(s.names[s.best_side - 1])} at {pc(s.best_expected)} expected, needs {Math.round(100 * s.edge_needed)}%
        {' '}(worth it at ≥ {s.min_price.map((x) => (x ? x.toFixed(2) : '—')).slice(0, 2).join(' / ')})
      </p>
    )
  }
  // no price yet: the model's pick (its favourite), and the price that would make it worth it
  const fav = s.probs[0] >= s.probs[1] ? 0 : 1
  const p = s.probs[fav]
  const strong = p >= 0.7
  return (
    <p className={`text-[10px] text-gray-500 mt-1 ${className}`}>
      <span className={`font-bold rounded px-1 py-px mr-1 border ${strong ? 'text-brand-800 bg-brand-50 border-brand-200' : 'text-gray-700 bg-gray-50 border-gray-200'}`}>
        Model pick: {last(s.names[fav])} {Math.round(100 * p)}%{p < 0.55 ? ' (close)' : ''}
      </span>
      worth it at ≥ <b className="tabular-nums">{s.min_price[fav]?.toFixed(2)}</b>
      <span className="text-gray-400"> · {last(s.names[1 - fav])} at ≥ {s.min_price[1 - fav]?.toFixed(2)} · enter the bookmaker's odds to check</span>
    </p>
  )
}
