/**
 * What a fixture's body is, before anything is drawn: its kind (moving head with a yoke, scanner, can, panel, bar or plain
 * box), its real size, and the shape of its lens. The scene builds the meshes from this (scene/fixtureModel.ts); the
 * profiles use it to tell a flat sheet of light from a round beam. All sizes are meters; +Y is the direction the light
 * leaves in.
 */
export type ModelKind = 'moving-head' | 'scanner' | 'can' | 'bar' | 'panel' | 'box'

export interface ModelSpec {
  kind: ModelKind
  /** width, height and depth of the fixture in its home position (the library's "dimensions") */
  size: [number, number, number]
}

const DEFAULT_SIZE: Record<ModelKind, [number, number, number]> = {
  'moving-head': [0.34, 0.5, 0.33],
  scanner: [0.25, 0.25, 0.25],
  can: [0.2, 0.25, 0.2],
  bar: [1.0, 0.1, 0.1],
  panel: [0.4, 0.12, 0.25],
  box: [0.3, 0.15, 0.3],
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/** What a fixture of these categories looks like. `sizeMm` is the library's [width, height, depth], when it has one. */
export function modelFor(categories: readonly string[], moving: boolean, sizeMm?: readonly [number, number, number]): ModelSpec {
  const has = (c: string) => categories.includes(c)
  const raw = sizeMm ? ([sizeMm[0] / 1000, sizeMm[1] / 1000, sizeMm[2] / 1000] as [number, number, number]) : undefined
  const aspect = raw ? Math.max(raw[0], raw[2]) / Math.max(0.001, Math.min(raw[0], raw[2])) : 1
  let kind: ModelKind
  if (moving && has('Moving Head')) kind = 'moving-head'
  else if (has('Scanner') || has('Barrel Scanner')) kind = 'scanner'
  else if (has('Pixel Bar') || aspect > 3.5) kind = 'bar'
  else if (has('Strobe') || has('Blinder') || has('Matrix')) kind = 'panel'
  else if (has('Color Changer')) kind = aspect > 1.35 ? 'panel' : 'can'
  else kind = 'box'
  const size = raw ?? DEFAULT_SIZE[kind]
  return { kind, size: [clamp(size[0], 0.05, 3), clamp(size[1], 0.04, 1.5), clamp(size[2], 0.04, 3)] }
}

/**
 * The lens of a bar or a panel is a strip: the beam leaves through a disc slid along it (a round-ended strip), with
 * `radius` half the strip's width and `halfLength` how far the disc's centre slides either way along `axis`.
 * Null for round lenses.
 */
export function lensStrip(spec: ModelSpec): { radius: number; halfLength: number; axis: 'x' | 'z' } | null {
  const [W, , D] = spec.size
  let halfX: number
  let halfZ: number
  if (spec.kind === 'panel') {
    halfX = W * 0.44
    halfZ = D * 0.44
  } else if (spec.kind === 'bar') {
    halfX = W * 0.48
    halfZ = D * 0.25
  } else {
    return null
  }
  const radius = Math.min(halfX, halfZ)
  return { radius, halfLength: Math.max(halfX, halfZ) - radius, axis: halfX >= halfZ ? 'x' : 'z' }
}

export const modelKey = (spec: ModelSpec) => `${spec.kind}:${spec.size.map((s) => Math.round(s * 1000)).join('x')}`
