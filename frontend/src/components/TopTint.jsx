import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

const LIGHT = '#f8fafc'          // tailwind `canvas`

// The colour an element paints, or null if it's see-through
function paint(el) {
  const cs = getComputedStyle(el)
  if (cs.backgroundImage && cs.backgroundImage !== 'none' && cs.backgroundImage.includes('gradient')) {
    const m = cs.backgroundImage.match(/rgba?\([^)]+\)/)
    return m ? m[0] : null
  }
  const c = cs.backgroundColor
  if (!c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c)) return null
  return c
}

function dark(rgb) {
  const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) || []).map(Number)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 90
}

/**
 * iOS Safari tints the strip under the clock - and its fade over the top of
 * the page - from the body's background, not from what's on screen there. The
 * app's body is light, so a page opening on a dark header got a white haze
 * over it. After every page change (and as the content scrolls), this looks
 * at what's at the very top of the screen and gives the body, and
 * theme-color, the same light or dark. Phones only: on a wide screen the
 * body shows beside the page.
 */
export default function TopTint() {
  const { pathname, search } = useLocation()

  useEffect(() => {
    if (!window.matchMedia('(max-width: 767px)').matches) return
    const meta = document.querySelector('meta[name="theme-color"]')
    let frame = 0
    const check = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        let el = document.elementFromPoint(window.innerWidth / 2, 2)
        let color = null
        while (el && el !== document.body && !color) {
          color = paint(el)
          el = el.parentElement
        }
        const tint = color && dark(color) ? color : LIGHT
        document.body.style.backgroundColor = tint
        meta?.setAttribute('content', tint)
      })
    }
    // Now, and again once the page's data has drawn its header
    const timers = [0, 250, 800, 2000].map((ms) => setTimeout(check, ms))
    let last = 0
    let trail = 0
    const onScroll = () => {
      const now = Date.now()
      if (now - last > 150) { last = now; check() }
      clearTimeout(trail)
      trail = setTimeout(check, 200)          // and once it settles
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      timers.forEach(clearTimeout)
      clearTimeout(trail)
      cancelAnimationFrame(frame)
      document.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [pathname, search])

  return null
}
