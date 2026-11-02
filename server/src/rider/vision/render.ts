import { readFile } from 'node:fs/promises'
import { createCanvas, type Canvas } from '@napi-rs/canvas'

/** A region of an image, as fractions of its width and height (0..1). */
export interface Region {
  x0: number
  y0: number
  x1: number
  y1: number
}

export const WHOLE: Region = { x0: 0, y0: 0, x1: 1, y1: 1 }

/** A PDF page drawn to pixels. */
export interface PageImage {
  canvas: Canvas
  width: number
  height: number
}

/** Draws a PDF page. `dpi` 300 gives an A4 page of about 2480 x 3508 pixels. */
export async function renderPage(pdfPath: string, page: number, dpi = 300): Promise<PageImage> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await readFile(pdfPath))
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise
  if (page < 1 || page > doc.numPages) throw new Error(`The PDF has ${doc.numPages} pages, there is no page ${page}`)
  const pdfPage = await doc.getPage(page)
  const viewport = pdfPage.getViewport({ scale: dpi / 72 })
  const width = Math.round(viewport.width)
  const height = Math.round(viewport.height)
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, height)
  // pdf.js types its render target as the browser's canvas; the napi canvas has the same drawing surface.
  await pdfPage.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise
  return { canvas, width, height }
}

/**
 * A region of the image as a PNG, at most `maxSide` pixels on its long side (the size models read well; larger images are
 * shrunk by the service anyway, so the fractions the model answers in stay right). With `grid`, thin labelled lines every
 * tenth of the region are drawn over it, which makes the model's position estimates much better.
 */
export function cropPng(image: PageImage, region: Region = WHOLE, opts: { maxSide?: number; grid?: boolean } = {}): { png: Buffer; width: number; height: number } {
  const sx = Math.round(region.x0 * image.width)
  const sy = Math.round(region.y0 * image.height)
  const sw = Math.max(1, Math.round((region.x1 - region.x0) * image.width))
  const sh = Math.max(1, Math.round((region.y1 - region.y0) * image.height))
  const scale = Math.min(1, (opts.maxSide ?? 1568) / Math.max(sw, sh))
  const width = Math.max(1, Math.round(sw * scale))
  const height = Math.max(1, Math.round(sh * scale))
  const out = createCanvas(width, height)
  const context = out.getContext('2d')
  context.drawImage(image.canvas, sx, sy, sw, sh, 0, 0, width, height)
  if (opts.grid) drawGrid(context, width, height)
  return { png: out.toBuffer('image/png'), width, height }
}

function drawGrid(context: ReturnType<Canvas['getContext']>, width: number, height: number) {
  context.lineWidth = 1
  context.font = `${Math.max(11, Math.round(Math.min(width, height) / 70))}px sans-serif`
  for (let i = 1; i < 10; i++) {
    const x = Math.round((i / 10) * width)
    const y = Math.round((i / 10) * height)
    context.strokeStyle = 'rgba(255, 0, 255, 0.35)'
    context.beginPath()
    context.moveTo(x, 0)
    context.lineTo(x, height)
    context.moveTo(0, y)
    context.lineTo(width, y)
    context.stroke()
    context.fillStyle = 'rgba(200, 0, 200, 0.95)'
    context.fillText(`${i / 10}`, x + 2, 12)
    context.fillText(`${i / 10}`, 2, y - 2)
  }
}

/** A point in a region's own fractions, as a fraction of the whole image. */
export function toWhole(region: Region, p: [number, number]): [number, number] {
  return [region.x0 + p[0] * (region.x1 - region.x0), region.y0 + p[1] * (region.y1 - region.y0)]
}
