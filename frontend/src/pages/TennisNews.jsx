import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { tennisNews } from '../api'
import LoadingSpinner from '../components/LoadingSpinner'

const SEEN_KEY = 'tennisNewsSeen'

// "12m ago", "3h ago", "2d ago"
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (!(s >= 0)) return ''
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function readSeen() {
  try { return localStorage.getItem(SEEN_KEY) } catch { return null }
}

/**
 * /tennis/news - tennis headlines from the publishers' own feeds (Guardian,
 * BBC Sport, Sky Sports, ESPN, Tennis365), newest first, one card per
 * story with the other desks that ran it underneath. Each opens on the
 * publisher's site. New stories since the last visit are marked.
 */
export default function TennisNews() {
  const nav = useNavigate()
  const [data, setData] = useState(null)
  const [source, setSource] = useState('')
  const [seen] = useState(readSeen)

  useEffect(() => {
    let live = true
    const load = () => tennisNews(source || undefined).then((r) => live && setData(r.data)).catch(() => live && setData((d) => d || { items: [], sources: [] }))
    load()
    const t = setInterval(load, 5 * 60 * 1000)
    return () => { live = false; clearInterval(t) }
  }, [source])

  // Opening the page counts as reading what's on it
  useEffect(() => {
    const top = data?.items?.[0]?.published
    if (top && !source) { try { localStorage.setItem(SEEN_KEY, top) } catch { /* private mode */ } }
  }, [data, source])

  if (!data) return <LoadingSpinner />

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-5 pt-6 pb-24 space-y-4">
      <div>
        <button onClick={() => nav(-1)} className="text-xs font-bold text-gray-400 hover:text-gray-600">← Back</button>
        <h1 className="text-2xl font-black text-gray-900 tracking-tight mt-1">Tennis news</h1>
        <p className="text-[11px] text-gray-400">Headlines from the tennis desks, newest first · updates every 10 minutes</p>
      </div>

      <div className="flex gap-1.5 overflow-x-auto -mx-4 px-4 pb-1" style={{ scrollbarWidth: 'none' }}>
        {['', ...(data.sources || [])].map((s) => (
          <button key={s || 'all'} onClick={() => setSource(s)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold border transition-colors ${
              source === s ? 'bg-brand-500 border-brand-500 text-white' : 'bg-white border-amber-200 text-gray-600'}`}>
            {s || 'All'}
          </button>
        ))}
      </div>

      {data.items.length === 0 && <p className="text-sm text-gray-400 text-center py-10">No headlines yet - check back in a few minutes.</p>}

      <div className="space-y-2.5">
        {data.items.map((x) => {
          const isNew = seen && x.published > seen
          return (
            <a key={x.id} href={x.link} target="_blank" rel="noopener noreferrer"
              className="card !p-3 flex gap-3 items-start active:scale-[0.99] transition-transform">
              {x.image && (
                <img src={x.image} alt="" loading="lazy" referrerPolicy="no-referrer"
                  className="w-20 h-16 object-cover rounded-md shrink-0 bg-amber-50"
                  onError={(e) => { e.currentTarget.style.display = 'none' }} />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">
                  {isNew && <span className="text-brand-600 mr-1">● New</span>}
                  {x.source} · {ago(x.published)}
                </p>
                <p className="text-[13px] font-black text-gray-900 leading-snug mt-0.5">{x.headline}</p>
                {x.summary && x.summary !== x.title && (
                  <p className="text-[11px] text-gray-500 leading-snug mt-1 line-clamp-2">{x.summary}</p>
                )}
                {x.also.length > 0 && (
                  <p className="text-[10px] text-gray-400 mt-1">Also on {[...new Set(x.also.map((a) => a.source))].join(', ')}</p>
                )}
              </div>
            </a>
          )
        })}
      </div>
    </div>
  )
}
