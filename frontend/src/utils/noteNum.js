// The number a note's cell means, the way people write it: "3*" is 3,
// "₹1,200" is 1200, "10k" / "20 k" is 10000 / 20000, "1.5 lakh" is 150000,
// "2 cr" is 20000000, "Under 40k" is 40000. A range ("10-20k", "10 to 20
// thousand") counts as its top end - the most it could be. null if there's
// no number. backend/routers/notes.py _num reads cells the same way.

const UNITS = {
  k: 1e3, thousand: 1e3, hazar: 1e3, hazaar: 1e3, hajar: 1e3,
  l: 1e5, lac: 1e5, lacs: 1e5, lakh: 1e5, lakhs: 1e5,
  cr: 1e7, crore: 1e7, crores: 1e7, m: 1e6, mn: 1e6, million: 1e6,
}
const N = '(\\d+(?:\\.\\d+)?)'
const U = '(k|thousand|ha[jz]aa?r|lakhs?|lacs?|l|crores?|cr|million|mn|m)?'
const RANGE = new RegExp(`${N}\\s*${U}\\s*(?:-|–|to)\\s*${N}\\s*${U}(?![a-z])`)
const ONE = new RegExp(`${N}\\s*${U}(?![a-z0-9.])`)

export const num = (c) => {
  const s = String(c ?? '').toLowerCase().replace(/₹|\brs\.?|\binr\b/g, ' ').replace(/(\d),(?=\d)/g, '$1')
  const r = s.match(RANGE)
  if (r) return Number(r[3]) * (UNITS[r[4] || r[2]] || 1)
  const m = s.match(ONE)
  if (!m) return null
  const v = Number(m[1]) * (UNITS[m[2]] || 1)
  return /^\s*-/.test(s) ? -v : v
}

export const fmt = (n) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
