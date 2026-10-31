import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { tennisArticle } from '../api'
import LoadingSpinner from '../components/LoadingSpinner'

function when(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })
}

/** /tennis/news/:id - one story read in the app: the publisher's text,
 *  headline and picture, credited to them. */
export default function TennisArticle() {
  const { id } = useParams()
  const nav = useNavigate()
  const [a, setA] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setA(null); setFailed(false)
    tennisArticle(id).then((r) => setA(r.data)).catch(() => setFailed(true))
  }, [id])

  if (failed) return <p className="text-sm text-gray-400 text-center py-16">Couldn't open this story.</p>
  if (!a) return <LoadingSpinner />

  return (
    <article className="max-w-2xl mx-auto px-4 sm:px-5 pt-6 pb-24">
      <button onClick={() => nav('/tennis/news')} className="text-xs font-bold text-gray-400 hover:text-gray-600">← Sports news</button>
      <p className="text-[10px] font-bold text-brand-600 uppercase tracking-widest mt-3">{a.sport === 'football' ? '⚽' : '🎾'} {a.source} · {when(a.published)}</p>
      <h1 className="text-xl font-black text-gray-900 leading-tight tracking-tight mt-1">{a.title}</h1>
      {a.image && (
        <img src={a.image} alt="" referrerPolicy="no-referrer" className="w-full rounded-lg mt-3 bg-amber-50 object-cover max-h-72"
          onError={(e) => { e.currentTarget.style.display = 'none' }} />
      )}

      <div className="mt-4 space-y-3">
        {a.body.length === 0 ? (
          <>
            {a.summary && <p className="text-[15px] text-gray-800 leading-relaxed">{a.summary}</p>}
            <p className="text-xs text-gray-400">The full story couldn't be read in the app this time - try again in a bit.</p>
          </>
        ) : a.body.map((b, i) => (
          b.type === 'h' ? <h2 key={i} className="text-base font-black text-gray-900 pt-2">{b.text}</h2>
            : b.type === 'quote' ? <blockquote key={i} className="border-l-4 border-brand-400 pl-3 text-[15px] italic text-gray-700 leading-relaxed">{b.text}</blockquote>
              : <p key={i} className="text-[15px] text-gray-800 leading-relaxed">{b.text}</p>
        ))}
      </div>

      <p className="text-[10px] text-gray-400 mt-6 border-t border-amber-100 pt-3">
        Story: {a.source}{a.also.length ? ` · also covered by ${[...new Set(a.also.map((x) => x.source))].join(', ')}` : ''}
      </p>
    </article>
  )
}
