/**
 * Builds the demo venue that ships with pre(f)light: a made-up club with a stage, a ground-supported truss rig, PA, a bar,
 * a FOH desk and a mirror ball, plus a preset with lights already hung and aimed, haze, a crowd and saved views.
 *
 *   npm run demo-venue -w server
 *
 * Writes `samples/demo-club.glb` (meters, Y up, one top-level node per part so each can be hidden) and
 * `samples/demo-club.json` (everything else a venue holds). Both are committed; run this again after changing it.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { CatalogFile } from '../catalog.js'
import type { DemoPreset } from '../demo.js'
import type { CameraView, Fixture, FixtureGroup } from '../venues.js'

const OUT_DIR = fileURLToPath(new URL('../../../samples/', import.meta.url))
const CATALOG = fileURLToPath(new URL('../../catalog/fixtures.json', import.meta.url))

type V3 = [number, number, number]

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const length = (a: V3) => Math.hypot(a[0], a[1], a[2])
const normalize = (a: V3): V3 => scale(a, 1 / length(a))
const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits

// ---------------------------------------------------------------------------------------------------------------------
// Geometry: triangles with flat normals, collected per part and material.

interface Material {
  name: string
  color: [number, number, number]
  metallic?: number
  roughness?: number
  emissive?: [number, number, number]
}

const MATERIALS = {
  floor: { name: 'Concrete floor', color: [0.2, 0.2, 0.21], roughness: 0.8 },
  wall: { name: 'Painted wall', color: [0.32, 0.3, 0.29], roughness: 0.95 },
  ceiling: { name: 'Ceiling', color: [0.12, 0.12, 0.13], roughness: 1 },
  stage: { name: 'Stage deck', color: [0.08, 0.08, 0.08], roughness: 0.6 },
  skirt: { name: 'Stage skirt', color: [0.02, 0.02, 0.02], roughness: 1 },
  fabric: { name: 'Black drape', color: [0.015, 0.015, 0.018], roughness: 1 },
  truss: { name: 'Aluminium', color: [0.8, 0.8, 0.82], metallic: 0.9, roughness: 0.35 },
  steel: { name: 'Steel', color: [0.25, 0.25, 0.27], metallic: 0.8, roughness: 0.5 },
  speaker: { name: 'Speaker cabinet', color: [0.025, 0.025, 0.025], roughness: 0.8 },
  grille: { name: 'Speaker grille', color: [0.05, 0.05, 0.05], metallic: 0.4, roughness: 0.6 },
  wood: { name: 'Bar wood', color: [0.22, 0.1, 0.045], roughness: 0.55 },
  counter: { name: 'Bar top', color: [0.04, 0.04, 0.045], roughness: 0.25 },
  column: { name: 'Concrete column', color: [0.4, 0.4, 0.38], roughness: 0.9 },
  desk: { name: 'Desk', color: [0.06, 0.06, 0.065], roughness: 0.7 },
  mirror: { name: 'Mirror ball', color: [0.85, 0.85, 0.88], metallic: 0.5, roughness: 0.15 }, // fully metallic reads black: there is no environment to reflect
  exit: { name: 'Exit sign', color: [0.05, 0.6, 0.2], roughness: 0.5, emissive: [0.1, 1, 0.35] },
} satisfies Record<string, Material>

type MaterialKey = keyof typeof MATERIALS

class Part {
  readonly triangles = new Map<MaterialKey, { positions: number[]; normals: number[] }>()
  constructor(readonly name: string) {}

  private target(material: MaterialKey) {
    let t = this.triangles.get(material)
    if (!t) this.triangles.set(material, (t = { positions: [], normals: [] }))
    return t
  }

  /** A flat polygon (convex, corners counter-clockwise seen from the side it faces). */
  polygon(material: MaterialKey, corners: V3[]) {
    const normal = normalize(cross(sub(corners[1], corners[0]), sub(corners[2], corners[0])))
    const t = this.target(material)
    for (let i = 1; i + 1 < corners.length; i++) {
      for (const c of [corners[0], corners[i], corners[i + 1]]) {
        t.positions.push(...c)
        t.normals.push(...normal)
      }
    }
  }

  /** An axis-aligned box from `min` to `max`. `skip` leaves out faces nobody sees (such as one standing on the floor). */
  box(material: MaterialKey, min: V3, max: V3, skip: ('bottom' | 'top')[] = []) {
    const [x0, y0, z0] = min
    const [x1, y1, z1] = max
    this.polygon(material, [
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ]) // +z
    this.polygon(material, [
      [x1, y0, z0],
      [x0, y0, z0],
      [x0, y1, z0],
      [x1, y1, z0],
    ]) // -z
    this.polygon(material, [
      [x1, y0, z1],
      [x1, y0, z0],
      [x1, y1, z0],
      [x1, y1, z1],
    ]) // +x
    this.polygon(material, [
      [x0, y0, z0],
      [x0, y0, z1],
      [x0, y1, z1],
      [x0, y1, z0],
    ]) // -x
    if (!skip.includes('top'))
      this.polygon(material, [
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y1, z0],
        [x0, y1, z0],
      ])
    if (!skip.includes('bottom'))
      this.polygon(material, [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
      ])
  }

  /** A round tube from `a` to `b`, as a prism with `sides` faces (no caps: tubes meet other tubes or the floor). */
  tube(material: MaterialKey, a: V3, b: V3, radius: number, sides = 8) {
    const axis = normalize(sub(b, a))
    const helper: V3 = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    const u = normalize(cross(axis, helper))
    const v = cross(axis, u)
    const ring = (center: V3, i: number) => {
      const angle = (i / sides) * Math.PI * 2
      return add(center, add(scale(u, Math.cos(angle) * radius), scale(v, Math.sin(angle) * radius)))
    }
    for (let i = 0; i < sides; i++) this.polygon(material, [ring(a, i), ring(b, i), ring(b, i + 1), ring(a, i + 1)])
  }

  /** A faceted sphere (flat faces, so a mirror ball sparkles). */
  sphere(material: MaterialKey, center: V3, radius: number, rings = 12, segments = 20) {
    const point = (r: number, s: number): V3 => {
      const theta = (r / rings) * Math.PI
      const phi = (s / segments) * Math.PI * 2
      return add(center, [radius * Math.sin(theta) * Math.cos(phi), radius * Math.cos(theta), radius * Math.sin(theta) * Math.sin(phi)])
    }
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < segments; s++) {
        const quad = [point(r, s), point(r, s + 1), point(r + 1, s + 1), point(r + 1, s)]
        if (r === 0) this.polygon(material, [quad[0], quad[2], quad[3]])
        else if (r === rings - 1) this.polygon(material, [quad[0], quad[1], quad[2]])
        else this.polygon(material, quad)
      }
    }
  }

  /**
   * A square box truss along the line from `a` to `b` (the truss's center line): four chords and zigzag lacing on each
   * face. `width` is the outside size of the square.
   */
  truss(a: V3, b: V3, width = 0.29) {
    const axis = normalize(sub(b, a))
    const up: V3 = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    const side = normalize(cross(axis, up))
    const across = cross(side, axis)
    const chord = 0.024
    const half = width / 2 - chord
    const corners = [
      add(scale(side, half), scale(across, half)),
      add(scale(side, -half), scale(across, half)),
      add(scale(side, -half), scale(across, -half)),
      add(scale(side, half), scale(across, -half)),
    ]
    for (const c of corners) this.tube('truss', add(a, c), add(b, c), chord)
    const run = length(sub(b, a))
    const steps = Math.max(1, Math.round(run / 0.5))
    for (let face = 0; face < 4; face++) {
      const c0 = corners[face]
      const c1 = corners[(face + 1) % 4]
      for (let i = 0; i < steps; i++) {
        const p0 = add(a, scale(axis, (run * i) / steps))
        const p1 = add(a, scale(axis, (run * (i + 1)) / steps))
        const [from, to] = i % 2 === 0 ? [c0, c1] : [c1, c0]
        this.tube('truss', add(p0, from), add(p1, to), 0.009, 6)
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The club. Meters, Y up; the audience faces -z, toward the stage at the back.

const ROOM = { x0: -10, x1: 10, z0: -8, z1: 10, height: 7 }
const STAGE = { x0: -6, x1: 6, z0: -8, z1: -3, height: 1 }
/** height of the truss rig's center line, and the underside where lights hang */
const RIG_Y = 6
const HANG_Y = RIG_Y - 0.145
const RIG = { x: 7, front: -2.5, mid: -5, back: -7.2 }
const MIRROR_BALL: V3 = [0, 5.6, 3.5]

function buildParts(): Part[] {
  const { x0, x1, z0, z1, height } = ROOM

  const room = new Part('Floor')
  room.polygon('floor', [
    [x0, 0, z1],
    [x1, 0, z1],
    [x1, 0, z0],
    [x0, 0, z0],
  ])

  const walls = new Part('Walls')
  walls.polygon('wall', [
    [x0, 0, z0],
    [x1, 0, z0],
    [x1, height, z0],
    [x0, height, z0],
  ])
  walls.polygon('wall', [
    [x1, 0, z1],
    [x0, 0, z1],
    [x0, height, z1],
    [x1, height, z1],
  ])
  walls.polygon('wall', [
    [x0, 0, z1],
    [x0, 0, z0],
    [x0, height, z0],
    [x0, height, z1],
  ])
  walls.polygon('wall', [
    [x1, 0, z0],
    [x1, 0, z1],
    [x1, height, z1],
    [x1, height, z0],
  ])
  // a door at the back of the room, with its exit sign
  walls.box('desk', [-6.6, 0, z1 - 0.06], [-5.0, 2.25, z1], ['bottom'])
  walls.box('exit', [-6.15, 2.4, z1 - 0.08], [-5.45, 2.65, z1])

  const ceiling = new Part('Ceiling')
  ceiling.polygon('ceiling', [
    [x0, height, z0],
    [x1, height, z0],
    [x1, height, z1],
    [x0, height, z1],
  ])

  const stage = new Part('Stage')
  stage.box('stage', [STAGE.x0, STAGE.height - 0.05, STAGE.z0], [STAGE.x1, STAGE.height, STAGE.z1], [])
  stage.box('skirt', [STAGE.x0, 0, STAGE.z1 - 0.02], [STAGE.x1, STAGE.height - 0.05, STAGE.z1], ['bottom'])
  stage.box('skirt', [STAGE.x0, 0, STAGE.z0], [STAGE.x0 + 0.02, STAGE.height - 0.05, STAGE.z1], ['bottom'])
  stage.box('skirt', [STAGE.x1 - 0.02, 0, STAGE.z0], [STAGE.x1, STAGE.height - 0.05, STAGE.z1], ['bottom'])
  // steps down on stage right
  for (let i = 1; i <= 3; i++) {
    const top = STAGE.height - 0.25 * i
    stage.box('stage', [STAGE.x1 + 0.3 * (i - 1), 0, -4.6], [STAGE.x1 + 0.3 * i, top, -3.6], ['bottom'])
  }
  // two monitor wedges at the front edge
  for (const x of [-2.2, 2.2]) stage.box('speaker', [x - 0.3, STAGE.height, -3.75], [x + 0.3, STAGE.height + 0.35, -3.25], ['bottom'])

  const backdrop = new Part('Backdrop')
  backdrop.box('fabric', [-6.6, STAGE.height, -7.92], [6.6, 6.6, -7.86])

  const truss = new Part('Truss')
  const top = RIG_Y + 0.145
  for (const x of [-RIG.x, RIG.x]) {
    for (const z of [RIG.front, RIG.back]) {
      truss.truss([x, 0.05, z], [x, top, z]) // tower
      truss.box('steel', [x - 0.4, 0, z - 0.4], [x + 0.4, 0.05, z + 0.4], ['bottom']) // base plate
      truss.box('steel', [x - 0.17, RIG_Y - 0.17, z - 0.17], [x + 0.17, RIG_Y + 0.17, z + 0.17]) // corner block
    }
    truss.truss([x, RIG_Y, RIG.back + 0.17], [x, RIG_Y, RIG.front - 0.17]) // side
  }
  for (const z of [RIG.front, RIG.mid, RIG.back]) truss.truss([-RIG.x + 0.17, RIG_Y, z], [RIG.x - 0.17, RIG_Y, z])

  const pa = new Part('PA')
  for (const side of [-1, 1]) {
    const x = side * 8.3
    pa.box('speaker', [x - 0.6, 0, -2.6], [x + 0.6, 0.7, -1.8], ['bottom']) // sub
    pa.box('speaker', [x - 0.45, 0.7, -2.5], [x + 0.45, 1.9, -1.9]) // top
    pa.box('grille', [x - 0.4, 0.75, -1.91], [x + 0.4, 1.85, -1.88])
    pa.box('grille', [x - 0.55, 0.05, -1.81], [x + 0.55, 0.65, -1.78])
  }

  const bar = new Part('Bar')
  bar.box('wood', [8.2, 0, 1.2], [9.0, 1.05, 8.0], ['bottom'])
  bar.box('counter', [8.05, 1.05, 1.1], [9.05, 1.12, 8.1])
  bar.box('wood', [9.55, 0, 1.2], [10, 2.3, 8.0], ['bottom'])
  for (const y of [1.3, 1.75]) bar.box('counter', [9.3, y, 1.2], [9.55, y + 0.04, 8.0])

  const foh = new Part('FOH')
  foh.box('stage', [-2.2, 0, 6.4], [2.2, 0.2, 8.6], ['bottom'])
  foh.box('desk', [-1.6, 0.2, 7.0], [1.6, 0.95, 7.75], ['bottom'])
  foh.polygon('grille', [
    [-1.6, 0.95, 7.75],
    [1.6, 0.95, 7.75],
    [1.6, 1.05, 7.15],
    [-1.6, 1.05, 7.15],
  ]) // sloped console

  const columns = new Part('Columns')
  for (const x of [-7.6, 7.6]) columns.box('column', [x - 0.25, 0, 3.75], [x + 0.25, height, 4.25], ['bottom', 'top'])

  const ball = new Part('Mirror ball')
  ball.sphere('mirror', MIRROR_BALL, 0.3)
  ball.tube('steel', add(MIRROR_BALL, [0, 0.3, 0]), [MIRROR_BALL[0], height, MIRROR_BALL[2]], 0.008, 6)

  return [room, walls, ceiling, stage, backdrop, truss, pa, bar, foh, columns, ball]
}

// ---------------------------------------------------------------------------------------------------------------------
// GLB writing

function toGlb(parts: Part[]): Buffer {
  const keys = Object.keys(MATERIALS) as MaterialKey[]
  const chunks: Buffer[] = []
  let offset = 0
  const bufferViews: object[] = []
  const accessors: object[] = []
  const pushFloats = (values: number[], withBounds: boolean) => {
    const data = Buffer.alloc(values.length * 4)
    values.forEach((v, i) => data.writeFloatLE(v, i * 4))
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, target: 34962 })
    chunks.push(data)
    offset += data.length
    const accessor: Record<string, unknown> = { bufferView: bufferViews.length - 1, componentType: 5126, count: values.length / 3, type: 'VEC3' }
    if (withBounds) {
      const min: number[] = [Infinity, Infinity, Infinity]
      const max: number[] = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < values.length; i++) {
        min[i % 3] = Math.min(min[i % 3], values[i])
        max[i % 3] = Math.max(max[i % 3], values[i])
      }
      accessor.min = min
      accessor.max = max
    }
    accessors.push(accessor)
    return accessors.length - 1
  }
  const meshes = parts.map((part) => ({
    name: part.name,
    primitives: [...part.triangles].map(([material, t]) => ({
      attributes: { POSITION: pushFloats(t.positions, true), NORMAL: pushFloats(t.normals, false) },
      material: keys.indexOf(material),
    })),
  }))
  const gltf = {
    asset: { version: '2.0', generator: 'pre(f)light demo venue (server/src/tools/demoVenue.ts)' },
    scene: 0,
    scenes: [{ name: 'Demo club', nodes: parts.map((_, i) => i) }],
    nodes: parts.map((part, i) => ({ name: part.name, mesh: i })),
    meshes,
    materials: keys.map((key) => {
      const m: Material = MATERIALS[key]
      return {
        name: m.name,
        pbrMetallicRoughness: { baseColorFactor: [...m.color, 1], metallicFactor: m.metallic ?? 0, roughnessFactor: m.roughness ?? 0.8 },
        ...(m.emissive ? { emissiveFactor: m.emissive } : {}),
      }
    }),
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  }
  const text = Buffer.from(JSON.stringify(gltf), 'utf8')
  const json = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)])
  const bin = Buffer.concat(chunks) // floats only, so already a multiple of 4
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8)
  const chunkHeader = (length: number, type: number) => {
    const b = Buffer.alloc(8)
    b.writeUInt32LE(length, 0)
    b.writeUInt32LE(type, 4)
    return b
  }
  return Buffer.concat([header, chunkHeader(json.length, 0x4e4f534a), json, chunkHeader(bin.length, 0x004e4942), bin])
}

// ---------------------------------------------------------------------------------------------------------------------
// The preset: lights, groups, haze, crowd and views.

/** A stable id from a name, in the UUID format the app uses, so running this again gives the same file. */
function stableId(name: string): string {
  const h = createHash('sha1').update(`preflight-demo:${name}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const HANGING: [number, number, number, number] = [1, 0, 0, 0] // half a turn about x: the base's +Y points down
const STANDING: [number, number, number, number] = [0, 0, 0, 1]

/** Pan and tilt (0..1) that point a moving head at `target`, the same way the app's aim tool solves it. */
function aimMover(position: V3, mount: 'hanging' | 'standing', target: V3, panRange: number, tiltRange: number) {
  const d = normalize(sub(target, position))
  const local: V3 = mount === 'hanging' ? [d[0], -d[1], -d[2]] : d // into the base's frame
  const tilt = (Math.acos(Math.max(-1, Math.min(1, local[1]))) * 180) / Math.PI
  const pan = Math.hypot(local[0], local[2]) < 1e-4 ? 0 : (Math.atan2(local[0], local[2]) * 180) / Math.PI
  return { pan: round(0.5 + pan / panRange), tilt: round(0.5 + tilt / tiltRange) }
}

/** The orientation that turns a fixed light's beam (its local +Y) toward `target`. */
function aimFixed(position: V3, target: V3): [number, number, number, number] {
  const d = normalize(sub(target, position))
  // shortest turn from +Y to d: axis +Y × d, half the angle in the quaternion
  const q: [number, number, number, number] = [d[2], 0, -d[0], 1 + d[1]]
  const n = Math.hypot(...q)
  return q.map((c) => round(c / n, 6)) as [number, number, number, number]
}

const BASE_VALUES = { pan: 0.5, tilt: 0.5, dimmer: 0, zoom: 0.4, focus: 0.5, red: 1, green: 1, blue: 1, strobe: 0, gobo: 0, goboAngle: 0, goboSpin: 0.5 }

function view(name: string, position: V3, lookAt: V3): CameraView {
  const d = sub(lookAt, position)
  const yaw = Math.atan2(d[0], d[2])
  const pitch = Math.atan2(-d[1], Math.hypot(d[0], d[2]))
  return { id: stableId(`view:${name}`), name, position, rotation: [round(pitch), round(yaw), 0] }
}

async function buildPreset(): Promise<DemoPreset> {
  const catalog = JSON.parse(await readFile(CATALOG, 'utf8')) as CatalogFile
  const byId = new Map(catalog.fixtures.map((f) => [f.id, f]))
  const profile = (id: string) => {
    const f = byId.get(id)
    if (!f) throw new Error(`${id} is not in the fixture catalog`)
    return f
  }

  const fixtures: Fixture[] = []
  const groups: FixtureGroup[] = []
  const rig = (group: string, items: Fixture[]) => {
    fixtures.push(...items)
    groups.push({ id: stableId(`group:${group}`), name: group, fixtureIds: items.map((f) => f.id) })
  }
  const mover = (name: string, profileId: string, position: V3, mount: 'hanging' | 'standing', target: V3, values: Record<string, number>): Fixture => {
    const p = profile(profileId)
    return {
      id: stableId(`fixture:${name}`),
      name,
      profileId,
      position,
      mount,
      yaw: 0,
      rotation: mount === 'hanging' ? HANGING : STANDING,
      mode: p.modes[0]?.name,
      values: { ...BASE_VALUES, ...values, ...aimMover(position, mount, target, p.panDegrees ?? 540, p.tiltDegrees ?? 270) },
    }
  }
  const fixed = (name: string, profileId: string, position: V3, target: V3, values: Record<string, number>): Fixture => ({
    id: stableId(`fixture:${name}`),
    name,
    profileId,
    position,
    mount: 'hanging',
    yaw: 0,
    rotation: aimFixed(position, target),
    mode: profile(profileId).modes[0]?.name,
    values: { ...BASE_VALUES, ...values },
  })

  const deepBlue = { red: 0.08, green: 0.2, blue: 1 }
  const magenta = { red: 1, green: 0.08, blue: 0.75 }
  rig(
    'Washes (mid truss)',
    [-5, -3, -1, 1, 3, 5].map((x, i) =>
      mover(`Wash ${i + 1}`, 'chauvet-professional/rogue-r1-wash', [x, HANG_Y, RIG.mid], 'hanging', [x * 0.8, STAGE.height, -3.4], {
        dimmer: 0.85,
        zoom: 0.65,
        ...(i % 2 === 0 ? deepBlue : magenta),
      }),
    ),
  )
  rig(
    'Beams (back truss)',
    [-4.5, -1.5, 1.5, 4.5].map((x, i) => mover(`Beam ${i + 1}`, 'clay-paky/sharpy', [x, HANG_Y, RIG.back], 'hanging', [x * 2.2, 0, 2.5], { dimmer: 1 })),
  )
  rig(
    'Floor beams',
    [-5.2, 5.2].map((x, i) =>
      mover(`Floor beam ${i + 1}`, 'clay-paky/sharpy', [x, STAGE.height, -7.3], 'standing', [-x * 0.6, ROOM.height, -1], { dimmer: 1 }),
    ),
  )
  rig(
    'Front light',
    [-5, -3, -1, 1, 3, 5].map((x, i) =>
      fixed(`Front ${i + 1}`, 'cameo/flat-pro-18', [x, HANG_Y, RIG.front], [x * 0.75, STAGE.height + 0.8, -4.8], {
        dimmer: 0.55,
        red: 1,
        green: 0.82,
        blue: 0.6,
      }),
    ),
  )

  return {
    name: 'Demo club',
    atmosphere: { haze: 0.5, ambient: 0.12 },
    crowd: {
      shown: true,
      density: 0.55,
      motion: 'sway',
      intensity: 0.6,
      zones: [{ id: stableId('zone:Dance floor'), name: 'Dance floor', x0: -6.5, z0: 0.3, x1: 6.5, z1: 6, y: 0, facing: [0, -5], shown: true }],
    },
    views: [
      view('Overview', [0, 4.6, 9.3], [0, 1.6, -4]),
      view('Front row', [1.2, 1.7, 0.4], [0, 3.2, -6]),
      view('From the stage', [0, 2.8, -6.6], [0, 1.2, 6]),
      view('At the bar', [7.6, 1.65, 6.2], [-2, 3, -4]),
    ],
    fixtures,
    groups,
  }
}

const parts = buildParts()
const glb = toGlb(parts)
const preset = await buildPreset()
await mkdir(OUT_DIR, { recursive: true })
await writeFile(new URL('demo-club.glb', `file://${OUT_DIR}`), glb)
await writeFile(new URL('demo-club.json', `file://${OUT_DIR}`), `${JSON.stringify(preset, null, 2)}\n`)
const triangles = parts.reduce((sum, p) => sum + [...p.triangles.values()].reduce((s, t) => s + t.positions.length / 9, 0), 0)
console.log(
  `demo-club.glb: ${(glb.length / 1024).toFixed(0)} KB, ${triangles} triangles in ${parts.length} parts; demo-club.json: ${preset.fixtures.length} lights`,
)
