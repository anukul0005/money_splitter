// A phone camera photo is routinely 3-8 MB; OCR.space's free tier
// rejects anything over 1 MB with a 413. Downscaled and re-encoded as
// JPEG here rather than sent as-is - a receipt is flat text on a plain
// background, so 1600px on the long edge loses nothing OCR needs while
// getting comfortably under every provider's limit. Quality steps down
// further only if the first pass still isn't small enough.
export const compressImage = (file) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.onload = () => {
    URL.revokeObjectURL(url)
    const maxDim = 1600
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.width * scale)
    canvas.height = Math.round(img.height * scale)
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)

    const tryQuality = (quality) => {
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error('Could not process that image'))
        if (blob.size > 900_000 && quality > 0.3) {
          tryQuality(quality - 0.15)
        } else {
          resolve(new File([blob], 'receipt.jpg', { type: 'image/jpeg' }))
        }
      }, 'image/jpeg', quality)
    }
    tryQuality(0.75)
  }
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')) }
  img.src = url
})
