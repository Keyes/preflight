import type { Engine } from '@babylonjs/core'

/** Upper bound on pixels in one screenshot; a 4096 x 4096 target with MSAA is already hundreds of MB of GPU memory. */
const MAX_PIXELS = 4096 * 4096
const MAX_SIDE = 8192

export interface ShotSize {
  width: number
  height: number
}

/** Screenshots always have this shape, whatever the shape of the window. */
export const SHOT_ASPECT = 16 / 9

/**
 * Size of a screenshot taken `scale` times larger than the view at the display's native pixel density. It is always
 * 16:9, and it is the middle part of the view: a window wider than 16:9 loses its left and right edges, a narrower
 * one its top and bottom, and the pixel density stays that of the view. The size stays within GPU and memory limits.
 */
export function planShot(engine: Engine, canvas: HTMLCanvasElement, scale: number): ShotSize {
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const viewW = Math.max(1, canvas.clientWidth * dpr * scale)
  const viewH = Math.max(1, canvas.clientHeight * dpr * scale)
  // Cover the window's view with a 16:9 frame: the frame keeps the window's height or its width, whichever is the limit.
  const w = viewW / viewH >= SHOT_ASPECT ? viewH * SHOT_ASPECT : viewW
  const h = w / SHOT_ASPECT
  const side = Math.min(engine.getCaps().maxRenderTextureSize || MAX_SIDE, MAX_SIDE)
  const limit = Math.min(1, side / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)))
  // A width that is a multiple of 16 gives a whole number of pixels for 9/16 of it, so the shape is exactly 16:9.
  const width = Math.max(16, Math.floor((w * limit) / 16) * 16)
  return { width, height: (width * 9) / 16 }
}

/**
 * The vertical field of view for a picture of the view. The picture is the middle 16:9 part of the view: a window wider
 * than that only loses its sides, but a narrower one must keep its width and lose top and bottom, so the field of view shrinks.
 */
export function shotFov(fov: number, canvas: HTMLCanvasElement): number {
  const viewAspect = canvas.clientWidth / Math.max(1, canvas.clientHeight)
  return viewAspect < SHOT_ASPECT ? 2 * Math.atan((Math.tan(fov / 2) * viewAspect) / SHOT_ASPECT) : fov
}

/** Frames to let the engine render after resizing before copying: the resize itself, rebuilding the post-processing buffers, then a clean one. */
const SETTLE_FRAMES = 3

/**
 * Returns one frame of the live view rendered at `size` as a PNG, with everything the live view has (tone
 * mapping, bloom, fog, anti-aliasing). It temporarily changes the canvas's internal resolution (width and height
 * separately, so the shape can differ from the window's) and lets the normal render loop draw into it, because
 * camera post-processing only runs on the canvas. The caller adjusts the camera so that the shape shows the right part.
 */
export function captureCanvas(engine: Engine, canvas: HTMLCanvasElement, size: ShotSize): Promise<Blob> {
  const previousLevel = engine.getHardwareScalingLevel()
  engine.setSize(size.width, size.height)
  return new Promise((resolve, reject) => {
    let frames = 0
    const observer = engine.onEndFrameObservable.add(() => {
      if (++frames < SETTLE_FRAMES) return
      engine.onEndFrameObservable.remove(observer)
      // toBlob copies the canvas as it is right now, so the resolution can go back straight away.
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('the browser could not encode the image (the size may be too large)'))), 'image/png')
      engine.setHardwareScalingLevel(previousLevel) // sizes the canvas to the window again
    })
  })
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Give the browser a moment to start the download before releasing the data.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
