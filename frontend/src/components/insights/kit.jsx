// Shared formatting and chart settings for the Insights and ML analysis pages.
import {
  Chart, BarElement, BarController, LineElement, LineController, PointElement, ScatterController,
  CategoryScale, LinearScale, Tooltip, Legend,
} from 'chart.js'

Chart.register(BarElement, BarController, LineElement, LineController, PointElement, ScatterController,
  CategoryScale, LinearScale, Tooltip, Legend)

export const INR = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
export const K = (v) => (Math.abs(v) >= 1000 ? `${v < 0 ? '−' : ''}₹${(Math.abs(v) / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1)}k` : INR(v))
export const mlabel = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
export const fmtDay = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
export const fmtShort = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
export const fmtWhen = (ts) => new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

export const P = ['Early', 'Day', 'Night']
export const BRAND = '#f97316', SLATE = '#334155', SOFT = '#cbd5e1', UP = '#dc2626', DOWN = '#16a34a'
export const FONT = { family: "'Helvetica Neue', Helvetica, Arial, sans-serif", size: 10 }
Chart.defaults.font.family = FONT.family          // tooltips too

export const base = (extra = {}) => ({
  responsive: true, maintainAspectRatio: false, animation: false,
  plugins: { legend: { labels: { boxWidth: 10, font: FONT } }, ...(extra.plugins || {}) },
  scales: {
    x: { grid: { display: false }, ticks: { font: FONT }, ...(extra.x || {}) },
    y: { grid: { color: '#f1f5f9' }, border: { display: false }, ticks: { font: FONT, callback: (v) => K(v) }, ...(extra.y || {}) },
  },
  ...(extra.top || {}),
})
export const bar = (o) => ({ borderRadius: 0, borderSkipped: false, ...o })

// Low-to-high bar with the likely value marked (and, optionally, what
// actually happened), on a shared scale.
export function RangeBar({ low, likely, high, max, actual }) {
  const pos = (v) => `${Math.min(v / max, 1) * 100}%`
  return (
    <div className="relative h-2 bg-amber-100 mt-1.5">
      <div className="absolute top-0 h-2 bg-brand-300" style={{ left: pos(low), width: `calc(${pos(high)} - ${pos(low)})` }} />
      <div className="absolute -top-1 h-4 w-0.5 bg-gray-900" style={{ left: pos(likely) }} />
      {actual != null && (
        <div className="absolute -top-1 h-4 w-1.5 -ml-0.5 bg-green-600" style={{ left: pos(actual) }} title={`Actual ${INR(actual)}`} />
      )}
    </div>
  )
}

export function CardSpinner({ text }) {
  return (
    <div className="card flex items-center gap-3">
      <div className="w-5 h-5 border-2 border-brand-400/30 border-t-brand-400 rounded-full animate-spin" />
      <p className="text-xs text-gray-500">{text}</p>
    </div>
  )
}

export const Label = ({ children, className = '' }) => (
  <p className={`text-[10px] font-bold text-gray-400 uppercase tracking-widest ${className}`}>{children}</p>
)
