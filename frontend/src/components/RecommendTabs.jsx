/**
 * Drinks / food switch, shared by both halves of the recommender.
 *
 * It lives in its own file rather than in either page because both pages
 * render their own sticky header, and a tab bar that shifted by a pixel
 * between them would read as the page jumping on every switch.
 */
export default function RecommendTabs({ tab, setTab }) {
  const tabs = [
    ['drinks', 'Drinks'],
    ['food',   'Food'],
  ]
  return (
    <div className="flex gap-1 mt-3 bg-amber-100/60 rounded-lg p-0.5">
      {tabs.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => setTab(v)}
          className={`flex-1 rounded-md py-1.5 text-xs font-bold transition-all ${
            tab === v
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
