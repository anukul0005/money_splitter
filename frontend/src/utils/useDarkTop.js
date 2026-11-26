import { useEffect } from 'react'

/**
 * For a page whose header is dark: iOS Safari tints the strip under the
 * clock (and its fade over the page top) from the body's background, not
 * from the header - a light body gave a white haze over the dark header.
 * While the page is open the body (and theme-color) take the header's dark,
 * and the page's own wrapper carries the light canvas (`bg-canvas`).
 */
export default function useDarkTop(active = true, color = '#1e293b') {
  useEffect(() => {
    // phones only - on a wide screen the body shows beside the page
    if (!active || !window.matchMedia('(max-width: 767px)').matches) return
    const body = document.body
    const meta = document.querySelector('meta[name="theme-color"]')
    const prev = { bg: body.style.backgroundColor, theme: meta?.getAttribute('content') }
    body.style.backgroundColor = color
    meta?.setAttribute('content', color)
    return () => {
      body.style.backgroundColor = prev.bg
      if (meta && prev.theme) meta.setAttribute('content', prev.theme)
    }
  }, [active, color])
}
