import { Constants, RawTexture, RawTexture2DArray, Texture, type Scene } from '@babylonjs/core'
import { drawPattern, GOBO_SIZE, GOBOS } from '../domain/gobos'

/** The GPU side of the gobo patterns (domain/gobos.ts): the patterns as a texture, blurred for focus, and projected onto surfaces. */

const textures = new WeakMap<Scene, RawTexture2DArray>()

/** All patterns as one array texture (one layer each, red channel), with mipmaps so the shader can blur them by sampling a smaller level. */
export function goboTexture(scene: Scene): RawTexture2DArray {
  const existing = textures.get(scene)
  if (existing) return existing
  const data = new Uint8Array(GOBO_SIZE * GOBO_SIZE * GOBOS.length)
  GOBOS.forEach((gobo, layer) => {
    const pixels = ctxPixels(drawPattern(gobo))
    for (let i = 0; i < GOBO_SIZE * GOBO_SIZE; i++) data[layer * GOBO_SIZE * GOBO_SIZE + i] = pixels[i * 4]
  })
  const texture = new RawTexture2DArray(
    data,
    GOBO_SIZE,
    GOBO_SIZE,
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
  return canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, GOBO_SIZE, GOBO_SIZE).data
}

// --- projection onto surfaces ---------------------------------------------------------------

/** Blur radii in texels, from sharp to very soft, for patterns seen out of focus. */
const BLUR_RADII = [0, 1, 2, 4, 8, 14] as const

/** The blur level (index into the blur radii) that best matches a given edge softness (a fraction of the beam radius, as in the beam shader). */
export function goboBlurLevel(edge: number): number {
  const radius = (1 + Math.max(edge, 0.02) * (GOBO_SIZE / 2)) / 2
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
    gray = new Float32Array(GOBO_SIZE * GOBO_SIZE)
    for (let i = 0; i < gray.length; i++) gray[i] = pixels[i * 4] / 255
    grayPatterns.set(pattern, gray)
  }
  return gray
}

/** One pass of a box blur along rows or columns (edges repeat). */
function boxBlur(source: Float32Array, radius: number, vertical: boolean): Float32Array {
  const out = new Float32Array(source.length)
  const width = 2 * radius + 1
  for (let line = 0; line < GOBO_SIZE; line++) {
    const at = (i: number) => {
      const clamped = Math.min(GOBO_SIZE - 1, Math.max(0, i))
      return source[vertical ? clamped * GOBO_SIZE + line : line * GOBO_SIZE + clamped]
    }
    let sum = 0
    for (let i = -radius; i <= radius; i++) sum += at(i)
    for (let i = 0; i < GOBO_SIZE; i++) {
      out[vertical ? i * GOBO_SIZE + line : line * GOBO_SIZE + i] = sum / width
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
    this.texture = new RawTexture(
      new Uint8Array(GOBO_SIZE * GOBO_SIZE * 4),
      GOBO_SIZE,
      GOBO_SIZE,
      Constants.TEXTUREFORMAT_RGBA,
      scene,
      true,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
    )
    this.texture.wrapU = Texture.CLAMP_ADDRESSMODE
    this.texture.wrapV = Texture.CLAMP_ADDRESSMODE
  }

  show(pattern: number, level: number) {
    const key = `${pattern}:${level}`
    if (key === this.shown) return
    this.shown = key
    const gray = blurredPattern(pattern, level)
    const rgba = new Uint8Array(GOBO_SIZE * GOBO_SIZE * 4)
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
