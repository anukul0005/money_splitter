import { useEffect, useState } from 'react'
import { getProductReviews, submitProductReview } from '../api'

// 0-5 for every dimension, same scale the enrichment pipeline already uses -
// so a submitted value sits on the same axis as the catalogue's own guess it
// may end up replacing (see the backend's _recompute_product_aggregate).
const DIMENSIONS = [
  ['sweetness',         'Sweetness'],
  ['smokiness',         'Smokiness'],
  ['smoothness',        'Smoothness'],
  ['spice',             'Spice'],
  ['fruit_citrus',      'Fruit / citrus'],
  ['oak',               'Oak / wood'],
  ['intensity',         'Intensity'],
  ['beginner_friendly', 'Beginner friendly'],
  ['sipping_score',     'Good for sipping neat'],
  ['mixer_score',       'Good as a mixer'],
]

const BODIES = ['light', 'medium', 'full']

/**
 * Rate a bottle, and optionally correct what the app thinks it tastes like.
 *
 * Deliberately not the same form as PriceEditForm: a price is one shared
 * fact that the last person to correct it owns, but a review is one
 * person's own opinion - submitting again updates *your* review, never
 * anyone else's, and the card shows the average across everyone who has
 * rated it plus how many people that is, never one person's number
 * presented as if it were the community's.
 */
export default function ProductReviewForm({ productId, myName, onDone, onCancel }) {
  const [loading, setLoading] = useState(true)
  const [reviews, setReviews] = useState([])
  const [communityRating, setCommunityRating] = useState(null)
  const [communityCount, setCommunityCount] = useState(0)

  const [score, setScore] = useState('')
  const [reviewText, setReviewText] = useState('')
  const [style, setStyle] = useState('')
  const [body, setBody] = useState('')
  const [tastingNotes, setTastingNotes] = useState('')
  const [dims, setDims] = useState({})
  const [showTaste, setShowTaste] = useState(false)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    getProductReviews(productId).then((r) => {
      if (cancelled) return
      const d = r.data
      setReviews(d.reviews || [])
      setCommunityRating(d.community_rating)
      setCommunityCount(d.community_review_count || 0)
      // Opens prefilled with your own last review, if you have one - so
      // refining a score is editing what you said, not starting over.
      if (d.my_review) {
        setScore(String(d.my_review.score))
        setReviewText(d.my_review.review_text || '')
        setStyle(d.my_review.style || '')
        setBody(d.my_review.body || '')
        setTastingNotes(d.my_review.tasting_notes || '')
        const filled = {}
        for (const [key] of DIMENSIONS) {
          if (d.my_review[key] != null) filled[key] = String(d.my_review[key])
        }
        setDims(filled)
        if (Object.keys(filled).length || d.my_review.style || d.my_review.body) {
          setShowTaste(true)
        }
      }
    }).catch(() => {}).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [productId])

  const scoreN = parseFloat(score)
  const scoreOk = Number.isFinite(scoreN) && scoreN >= 0 && scoreN <= 5
  const myExisting = reviews.find((r) => r.reviewer === myName)

  const submit = async () => {
    setError(''); setBusy(true)
    try {
      const payload = {
        score: scoreN,
        review_text: reviewText.trim() || null,
        style: style.trim() || null,
        body: body || null,
        tasting_notes: tastingNotes.trim() || null,
      }
      for (const [key] of DIMENSIONS) {
        const v = dims[key]
        payload[key] = v != null && v !== '' ? parseFloat(v) : null
      }
      const r = await submitProductReview(productId, payload)
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
        {myExisting ? 'Update your review' : 'Rate this bottle'}
      </p>

      {!loading && communityCount > 0 && (
        <p className="text-[10px] text-gray-500">
          ★ {communityRating?.toFixed(1)}/5 average from {communityCount}{' '}
          {communityCount === 1 ? 'review' : 'reviews'} in the app so far.
        </p>
      )}

      <div>
        <label className="label">Your score (0–5)</label>
        <input
          className="input text-sm font-bold" type="number" inputMode="decimal"
          min="0" max="5" step="0.5" value={score} placeholder="e.g. 4"
          onChange={(e) => setScore(e.target.value)}
        />
      </div>

      <div>
        <label className="label">Your review (optional)</label>
        <textarea
          className="input text-xs resize-none" rows={2} value={reviewText}
          placeholder="What did you think?"
          onChange={(e) => setReviewText(e.target.value)}
        />
      </div>

      <button
        type="button"
        onClick={() => setShowTaste((s) => !s)}
        className="text-[10px] font-bold text-brand-600 hover:text-brand-700"
      >
        {showTaste ? 'Hide taste details' : "Also correct what it's like (style, taste profile)"}
      </button>

      {showTaste && (
        <div className="space-y-2 pt-1">
          <p className="text-[9px] text-gray-400">
            Optional. Once anyone rates this bottle, these replace the
            catalogue's own guess at its taste profile — most of which was
            never researched for this specific bottle, just assumed from its
            category.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">Style</label>
              <input className="input text-xs" value={style}
                     placeholder="e.g. Blended Scotch Whisky"
                     onChange={(e) => setStyle(e.target.value)} />
            </div>
            <div>
              <label className="label">Body</label>
              <select className="input text-xs" value={body}
                      onChange={(e) => setBody(e.target.value)}>
                <option value="">—</option>
                {BODIES.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="label">Tasting notes</label>
            <textarea
              className="input text-xs resize-none" rows={2} value={tastingNotes}
              placeholder="e.g. vanilla, honey, light oak, smooth finish"
              onChange={(e) => setTastingNotes(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
            {DIMENSIONS.map(([key, label]) => (
              <div key={key}>
                <label className="text-[9px] font-bold text-gray-500 block mb-0.5">{label}</label>
                <input
                  className="input text-xs py-1" type="number" inputMode="decimal"
                  min="0" max="5" step="0.5" value={dims[key] ?? ''}
                  placeholder="0-5"
                  onChange={(e) => setDims((d) => ({ ...d, [key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {error && <p className="text-[11px] text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button className="btn-primary flex-1 text-xs py-1.5"
                disabled={busy || !scoreOk} onClick={submit}>
          {busy ? 'Saving…' : myExisting ? 'Update review' : 'Submit review'}
        </button>
        <button className="text-xs font-bold text-gray-400 px-3" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="text-[9px] text-gray-400">
        Visible to everyone as part of this bottle's average — submitting
        again updates your own review, it never adds a second one.
      </p>
    </div>
  )
}
