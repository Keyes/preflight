import { Constants, RawTexture, RawTexture2DArray, Texture, type Scene } from '@babylonjs/core'

/** Texels along each side of a gobo pattern. */
const SIZE = 128

type Draw = (ctx: CanvasRenderingContext2D, size: number) => void

export interface Gobo {
  name: string
  draw: Draw
}

// Patterns are drawn white where light passes and black where it is blocked, over the square that the beam's circle
// fits in (the middle of the picture is the middle of the beam, and its edge is the beam's edge).

const light = (ctx: CanvasRenderingContext2D) => {
  ctx.fillStyle = '#fff'
  ctx.strokeStyle = '#fff'
}

/** A small seeded random number generator, so "organic" patterns are the same every time. */
function seeded(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

function polygon(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, sides: number, turn = -Math.PI / 2) {
  ctx.beginPath()
  for (let i = 0; i < sides; i++) {
    const a = turn + (i / sides) * Math.PI * 2
    const x = cx + radius * Math.cos(a)
    const y = cy + radius * Math.sin(a)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

function blobs(seed: number, count: number, minR: number, maxR: number, spread: number): Draw {
  return (ctx, size) => {
    const random = seeded(seed)
    light(ctx)
    for (let i = 0; i < count; i++) {
      const x = size / 2 + (random() - 0.5) * size * spread
      const y = size / 2 + (random() - 0.5) * size * spread
      const r = size * (minR + random() * (maxR - minR))
      ctx.beginPath()
      ctx.ellipse(x, y, r, r * (0.5 + random() * 0.6), random() * Math.PI, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

export const GOBOS: readonly Gobo[] = [
  {
    name: 'Dots',
    draw(ctx, size) {
      light(ctx)
      const n = 7
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          ctx.beginPath()
          ctx.arc(((x + 0.5) / n) * size, ((y + 0.5) / n) * size, size * 0.04, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    },
  },
  {
    name: 'Large dots',
    draw(ctx, size) {
      light(ctx)
      const n = 4
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          ctx.beginPath()
          ctx.arc(((x + 0.5) / n) * size, ((y + 0.5) / n) * size, size * 0.09, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    },
  },
  {
    name: 'Star',
    draw(ctx, size) {
      light(ctx)
      ctx.beginPath()
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i / 10) * Math.PI * 2
        const r = size * (i % 2 === 0 ? 0.42 : 0.17)
        const x = size / 2 + r * Math.cos(a)
        const y = size / 2 + r * Math.sin(a)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.fill()
    },
  },
  {
    name: 'Rays',
    draw(ctx, size) {
      light(ctx)
      const rays = 12
      for (let i = 0; i < rays; i++) {
        const a = (i / rays) * Math.PI * 2
        ctx.beginPath()
        ctx.moveTo(size / 2, size / 2)
        ctx.arc(size / 2, size / 2, size * 0.75, a - 0.1, a + 0.1)
        ctx.closePath()
        ctx.fill()
      }
    },
  },
  {
    name: 'Rings',
    draw(ctx, size) {
      light(ctx)
      ctx.lineWidth = size * 0.04
      for (const r of [0.1, 0.22, 0.34, 0.46]) {
        ctx.beginPath()
        ctx.arc(size / 2, size / 2, size * r, 0, Math.PI * 2)
        ctx.stroke()
      }
    },
  },
  {
    name: 'Bars',
    draw(ctx, size) {
      light(ctx)
      const n = 6
      for (let i = 0; i < n; i++) ctx.fillRect(((i + 0.25) / n) * size, 0, (size / n) * 0.5, size)
    },
  },
  {
    name: 'Grid',
    draw(ctx, size) {
      light(ctx)
      ctx.lineWidth = size * 0.035
      const n = 5
      for (let i = 1; i < n; i++) {
        ctx.beginPath()
        ctx.moveTo((i / n) * size, 0)
        ctx.lineTo((i / n) * size, size)
        ctx.moveTo(0, (i / n) * size)
        ctx.lineTo(size, (i / n) * size)
        ctx.stroke()
      }
    },
  },
  {
    name: 'Triangles',
    draw(ctx, size) {
      light(ctx)
      for (const [x, y, flip] of [
        [0.5, 0.3, 1],
        [0.3, 0.68, -1],
        [0.7, 0.68, -1],
      ] as const) {
        polygon(ctx, x * size, y * size, size * 0.17, 3, flip > 0 ? -Math.PI / 2 : Math.PI / 2)
        ctx.fill()
      }
    },
  },
  {
    name: 'Hexagons',
    draw(ctx, size) {
      light(ctx)
      ctx.lineWidth = size * 0.03
      for (const [x, y] of [
        [0.5, 0.5],
        [0.5, 0.2],
        [0.5, 0.8],
        [0.26, 0.35],
        [0.74, 0.35],
        [0.26, 0.65],
        [0.74, 0.65],
      ] as const) {
        polygon(ctx, x * size, y * size, size * 0.13, 6, 0)
        ctx.stroke()
      }
    },
  },
  {
    name: 'Windows',
    draw(ctx, size) {
      light(ctx)
      const gap = size * 0.06
      const half = size / 2 - gap * 1.5
      for (const [x, y] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const)
        ctx.fillRect(gap + x * (half + gap), gap + y * (half + gap), half, half)
    },
  },
  {
    name: 'Spiral',
    draw(ctx, size) {
      light(ctx)
      ctx.lineWidth = size * 0.045
      ctx.lineCap = 'round'
      ctx.beginPath()
      for (let t = 0; t <= 1; t += 0.005) {
        const a = t * Math.PI * 6
        const r = size * 0.46 * t
        const x = size / 2 + r * Math.cos(a)
        const y = size / 2 + r * Math.sin(a)
        if (t === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    },
  },
  {
    name: 'Half moon',
    draw(ctx, size) {
      light(ctx)
      ctx.beginPath()
      ctx.arc(size / 2, size / 2, size * 0.4, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#000'
      ctx.beginPath()
      ctx.arc(size * 0.62, size * 0.45, size * 0.34, 0, Math.PI * 2)
      ctx.fill()
    },
  },
  {
    name: 'Dashes',
    draw(ctx, size) {
      light(ctx)
      const rows = 7
      const random = seeded(7)
      for (let y = 0; y < rows; y++) {
        let x = random() * size * 0.15
        while (x < size) {
          const length = size * (0.08 + random() * 0.14)
          ctx.fillRect(x, ((y + 0.35) / rows) * size, length, (size / rows) * 0.3)
          x += length + size * (0.06 + random() * 0.08)
        }
      }
    },
  },
  {
    name: 'Leaves',
    draw(ctx, size) {
      light(ctx)
      const random = seeded(21)
      for (let i = 0; i < 16; i++) {
        const x = size * (0.1 + random() * 0.8)
        const y = size * (0.1 + random() * 0.8)
        const angle = random() * Math.PI * 2
        const length = size * (0.1 + random() * 0.1)
        ctx.save()
        ctx.translate(x, y)
        ctx.rotate(angle)
        ctx.beginPath()
        ctx.moveTo(-length, 0)
        ctx.quadraticCurveTo(0, -length * 0.55, length, 0)
        ctx.quadraticCurveTo(0, length * 0.55, -length, 0)
        ctx.fill()
        ctx.restore()
      }
    },
  },
  { name: 'Breakup', draw: blobs(5, 34, 0.04, 0.1, 0.9) },
  { name: 'Clouds', draw: blobs(11, 12, 0.12, 0.2, 0.7) },
  {
    name: 'Cross',
    draw(ctx, size) {
      light(ctx)
      ctx.fillRect(size * 0.43, size * 0.1, size * 0.14, size * 0.8)
      ctx.fillRect(size * 0.1, size * 0.43, size * 0.8, size * 0.14)
    },
  },
]

/** Number of patterns. A gobo value of 0 is the open gate, and 1 / GOBO_COUNT up to 1 pick the patterns. */
export const GOBO_COUNT = GOBOS.length

/** The pattern a normalized gobo value picks (0 for none, else 1-based index into GOBOS). */
export const goboIndex = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * GOBO_COUNT)

/** The normalized gobo value that picks pattern `index` (1-based; 0 for none). */
export const goboValue = (index: number) => index / GOBO_COUNT

function drawPattern(gobo: Gobo): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, SIZE, SIZE)
  gobo.draw(ctx, SIZE)
  return canvas
}

let thumbnails: string[] | null = null

/** Each pattern as a picture (white light on black), for the inspector. */
export function goboThumbnails(): string[] {
  thumbnails ??= GOBOS.map((gobo) => drawPattern(gobo).toDataURL('image/png'))
  return thumbnails
}

const textures = new WeakMap<Scene, RawTexture2DArray>()

/** All patterns as one array texture (one layer each, red channel), with mipmaps so the shader can blur them by sampling a smaller level. */
export function goboTexture(scene: Scene): RawTexture2DArray {
  const existing = textures.get(scene)
  if (existing) return existing
  const data = new Uint8Array(SIZE * SIZE * GOBOS.length)
  GOBOS.forEach((gobo, layer) => {
    const pixels = ctxPixels(drawPattern(gobo))
    for (let i = 0; i < SIZE * SIZE; i++) data[layer * SIZE * SIZE + i] = pixels[i * 4]
  })
  const texture = new RawTexture2DArray(
    data,
    SIZE,
    SIZE,
    GOBOS.length,
    Constants.TEXTUREFORMAT_R,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
  )
  texture.wrapU = Texture.CLAMP_ADDRESSMODE
  texture.wrapV = Texture.CLAMP_ADDRESSMODE
  textures.set(scene, texture)
  return texture
}

function ctxPixels(canvas: HTMLCanvasElement): Uint8ClampedArray {
  return canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, SIZE, SIZE).data
}

// --- projection onto surfaces ---------------------------------------------------------------

/** Blur radii in texels, from sharp to very soft, for patterns seen out of focus. */
const BLUR_RADII = [0, 1, 2, 4, 8, 14] as const

/** The blur level (index into the blur radii) that best matches a given edge softness (a fraction of the beam radius, as in the beam shader). */
export function goboBlurLevel(edge: number): number {
  const radius = (1 + Math.max(edge, 0.02) * (SIZE / 2)) / 2
  let best = 0
  for (let i = 1; i < BLUR_RADII.length; i++) {
    if (Math.abs(Math.log(BLUR_RADII[i] + 1) - Math.log(radius + 1)) < Math.abs(Math.log(BLUR_RADII[best] + 1) - Math.log(radius + 1))) best = i
  }
  return best
}

const grayPatterns = new Map<number, Float32Array>()

function grayPattern(pattern: number): Float32Array {
  let gray = grayPatterns.get(pattern)
  if (!gray) {
    const pixels = ctxPixels(drawPattern(GOBOS[pattern]))
    gray = new Float32Array(SIZE * SIZE)
    for (let i = 0; i < gray.length; i++) gray[i] = pixels[i * 4] / 255
    grayPatterns.set(pattern, gray)
  }
  return gray
}

/** One pass of a box blur along rows or columns (edges repeat). */
function boxBlur(source: Float32Array, radius: number, vertical: boolean): Float32Array {
  const out = new Float32Array(source.length)
  const width = 2 * radius + 1
  for (let line = 0; line < SIZE; line++) {
    const at = (i: number) => {
      const clamped = Math.min(SIZE - 1, Math.max(0, i))
      return source[vertical ? clamped * SIZE + line : line * SIZE + clamped]
    }
    let sum = 0
    for (let i = -radius; i <= radius; i++) sum += at(i)
    for (let i = 0; i < SIZE; i++) {
      out[vertical ? i * SIZE + line : line * SIZE + i] = sum / width
      sum += at(i + radius + 1) - at(i - radius)
    }
  }
  return out
}

const blurredPatterns = new Map<string, Float32Array>()

/** A pattern blurred by the radius of the given blur level (three box passes each way, close to a gaussian). */
function blurredPattern(pattern: number, level: number): Float32Array {
  const key = `${pattern}:${level}`
  let blurred = blurredPatterns.get(key)
  if (!blurred) {
    blurred = grayPattern(pattern)
    const radius = BLUR_RADII[level]
    if (radius > 0)
      for (let pass = 0; pass < 3; pass++)
        blurred = boxBlur(boxBlur(blurred, Math.max(1, Math.round(radius / 1.7)), false), Math.max(1, Math.round(radius / 1.7)), true)
    blurredPatterns.set(key, blurred)
  }
  return blurred
}

/**
 * A texture a spot light can project (white where light passes), made for one light because its scale changes with the
 * beam's edge softness. `show` fills it with a pattern at a blur level (0-based pattern index).
 */
export class GoboProjection {
  readonly texture: RawTexture
  private shown = ''

  constructor(scene: Scene) {
    this.texture = new RawTexture(new Uint8Array(SIZE * SIZE * 4), SIZE, SIZE, Constants.TEXTUREFORMAT_RGBA, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
    this.texture.wrapU = Texture.CLAMP_ADDRESSMODE
    this.texture.wrapV = Texture.CLAMP_ADDRESSMODE
  }

  show(pattern: number, level: number) {
    const key = `${pattern}:${level}`
    if (key === this.shown) return
    this.shown = key
    const gray = blurredPattern(pattern, level)
    const rgba = new Uint8Array(SIZE * SIZE * 4)
    for (let i = 0; i < gray.length; i++) {
      const v = Math.round(gray[i] * 255)
      rgba[i * 4] = v
      rgba[i * 4 + 1] = v
      rgba[i * 4 + 2] = v
      rgba[i * 4 + 3] = 255
    }
    this.texture.update(rgba)
  }

  dispose() {
    this.texture.dispose()
  }
}
