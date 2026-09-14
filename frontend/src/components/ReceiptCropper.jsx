import { useEffect, useRef, useState } from 'react'

const VIEWPORT_H = 380   // fixed crop-frame height; width tracks the modal

/**
 * A minimal pan/zoom cropper for one receipt photo, shown between picking
 * the photo and sending it to OCR.
 *
 * No cropping library: this is one rectangle (drag to pan, slider to zoom)
 * rather than free-form resizable corners, which covers the actual need —
 * a phone photo usually has a table edge, a hand, or a second receipt in
 * frame, and panning/zooming a fixed frame removes that in two seconds.
 * `onConfirm` gets back a real cropped image file — the frame you see is
 * exactly what's exported.
 */
export default function ReceiptCropper({ file, onCancel, onConfirm }) {
  const containerRef = useRef(null)
  const imgRef = useRef(null)
  const dragState = useRef(null)

  const [imgUrl, setImgUrl] = useState('')
  const [natural, setNatural] = useState({ w: 0, h: 0 })
  const [containerW, setContainerW] = useState(320)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const url = URL.createObjectURL(file)
    setImgUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  useEffect(() => {
    if (containerRef.current) setContainerW(containerRef.current.clientWidth)
  }, [imgUrl])

  // "Contain", not "cover" - zoom 1 shows the WHOLE photo inside the
  // frame (letterboxed on whichever side is shorter), rather than filling
  // the frame and cropping off the rest before the person has touched
  // anything. A receipt is almost always much taller than this fixed-height
  // frame, so a "cover" default silently trimmed the top and/or bottom on
  // load with no way to zoom back out and see them again - the slider only
  // ever went up from 1, never below the fit it started at.
  const baseScale = natural.w && natural.h
    ? Math.min(containerW / natural.w, VIEWPORT_H / natural.h)
    : 1

  // Below the current display size, an axis is entirely visible already -
  // centered and locked, not clamped toward an edge - rather than only
  // ever handling the "image bigger than the frame" case a cover-fit
  // cropper never needed to.
  const clampAxis = (pos, dispSize, viewSize) => {
    if (dispSize <= viewSize) return (viewSize - dispSize) / 2
    return Math.min(0, Math.max(viewSize - dispSize, pos))
  }
  const clampOffset = (x, y, z) => {
    const dispW = natural.w * baseScale * z
    const dispH = natural.h * baseScale * z
    return { x: clampAxis(x, dispW, containerW), y: clampAxis(y, dispH, VIEWPORT_H) }
  }

  const onImgLoad = () => {
    const el = imgRef.current
    const w = el.naturalWidth, h = el.naturalHeight
    setNatural({ w, h })
    const scale = Math.min(containerW / w, VIEWPORT_H / h)
    setOffset({ x: (containerW - w * scale) / 2, y: (VIEWPORT_H - h * scale) / 2 })
    setZoom(1)
    setReady(true)
  }

  const onZoomChange = (z) => {
    setZoom(z)
    setOffset((o) => clampOffset(o.x, o.y, z))
  }

  const startDrag = (clientX, clientY) => {
    dragState.current = { startX: clientX, startY: clientY, origin: offset }
  }
  const moveDrag = (clientX, clientY) => {
    if (!dragState.current) return
    const { startX, startY, origin } = dragState.current
    setOffset(clampOffset(origin.x + (clientX - startX), origin.y + (clientY - startY), zoom))
  }
  const endDrag = () => { dragState.current = null }

  const handleConfirm = () => {
    const scale = baseScale * zoom
    const sx = Math.max(0, -offset.x / scale)
    const sy = Math.max(0, -offset.y / scale)
    const sw = Math.min(natural.w - sx, containerW / scale)
    const sh = Math.min(natural.h - sy, VIEWPORT_H / scale)

    const canvas = document.createElement('canvas')
    canvas.width = Math.round(sw)
    canvas.height = Math.round(sh)
    canvas.getContext('2d').drawImage(imgRef.current, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((blob) => {
      if (blob) onConfirm(new File([blob], 'receipt.jpg', { type: 'image/jpeg' }))
    }, 'image/jpeg', 0.9)
  }

  return (
    <div className="fixed inset-0 bg-field-950/80 flex items-center justify-center z-50 px-5">
      <div className="bg-cream border border-amber-200 rounded-xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="px-4 pt-4 pb-2">
          <h2 className="text-sm font-bold text-gray-800">Frame the receipt</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">Drag to move, use the slider to zoom in on just the receipt.</p>
        </div>

        <div
          ref={containerRef}
          className="relative w-full bg-black/90 overflow-hidden touch-none select-none"
          style={{ height: VIEWPORT_H }}
          onMouseDown={(e) => startDrag(e.clientX, e.clientY)}
          onMouseMove={(e) => e.buttons === 1 && moveDrag(e.clientX, e.clientY)}
          onMouseUp={endDrag}
          onMouseLeave={endDrag}
          onTouchStart={(e) => startDrag(e.touches[0].clientX, e.touches[0].clientY)}
          onTouchMove={(e) => moveDrag(e.touches[0].clientX, e.touches[0].clientY)}
          onTouchEnd={endDrag}
        >
          {imgUrl && (
            <img
              ref={imgRef}
              src={imgUrl}
              alt="Receipt to crop"
              onLoad={onImgLoad}
              draggable={false}
              className="absolute top-0 left-0 max-w-none pointer-events-none"
              style={{
                width: natural.w * baseScale * zoom,
                height: natural.h * baseScale * zoom,
                transform: `translate(${offset.x}px, ${offset.y}px)`,
              }}
            />
          )}
        </div>

        <div className="px-4 py-3 space-y-3">
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500 font-bold">Zoom</span>
            <input
              type="range" min="1" max="6" step="0.05"
              value={zoom}
              onChange={(e) => onZoomChange(parseFloat(e.target.value))}
              className="flex-1"
            />
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className="flex-1 py-2.5 text-xs font-bold text-gray-600 bg-amber-50 border border-amber-200 rounded-md">
              Cancel
            </button>
            <button type="button" onClick={handleConfirm} disabled={!ready} className="flex-1 py-2.5 text-xs font-bold text-white bg-brand-400 rounded-md disabled:opacity-50">
              Use this crop
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
