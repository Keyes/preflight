import { DynamicTexture, Matrix, Mesh, MeshBuilder, PBRMaterial, Quaternion, StandardMaterial, Vector3, type AbstractMesh, type Scene } from '@babylonjs/core'
import type { Crowd as CrowdData, CrowdZone } from '../api'
import { crowdThreshold, fullCount, personRank, visibleCount } from '../crowdModel'

/** Radius of the soft dark disc on the floor under each person, meters, and how dark its middle is. */
const CONTACT_RADIUS = 0.34
const CONTACT_DARKNESS = 0.6
/** The disc floats this far above the floor (and is pulled toward the camera in depth), so it never flickers against it. */
const CONTACT_LIFT = 0.012

/** Share of the people who stand with their arms up. */
const ARMS_UP_SHARE = 0.12
/** Motion is worked out this many times a second (the matrices of thousands of people are rewritten each time). */
const MOTION_RATE = 30
/** How far a person's facing strays from the facing point, radians either way. */
const FACING_SPREAD = 0.35
const TAU = Math.PI * 2

/** A small seeded generator, so a zone always fills with the same people. */
function seeded(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * Where everyone stands: x, y, z, yaw, size and a phase for the motion, six numbers each, sorted by `ranks`. A person's
 * rank (0 to 1) says when they appear as the density goes up: they show while the rank is below the density, so
 * dragging the density only changes how many of the first people are drawn, and nobody moves.
 */
interface People {
  data: Float32Array
  ranks: Float64Array
  count: number
  /** how many of them (the first ones) are drawn now */
  visible: number
}

const empty = (): People => ({ data: new Float32Array(0), ranks: new Float64Array(0), count: 0, visible: 0 })

/** How many entries of an ascending list are below `limit`. */
function countBelow(ranks: Float64Array, limit: number): number {
  let lo = 0
  let hi = ranks.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ranks[mid] < limit) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** How many random spots are tried for each new person; the one farthest from everybody already placed wins. */
const CANDIDATES = 8

/**
 * `n` spots in a width x depth rectangle, in an order in which every first stretch is spread out evenly but has no
 * regular pattern (Mitchell's best-candidate method: each new spot is the best of a few random ones, the one with
 * the most room around it). The same random numbers always give the same first spots, whatever `n` is, so the
 * first people of a zone never move when more are added. A grid of the spots so far finds the nearest one quickly.
 */
function spreadSpots(n: number, width: number, depth: number, random: () => number): Float32Array {
  const spots = new Float32Array(n * 2)
  if (n === 0) return spots
  const cell = Math.max(Math.sqrt((width * depth) / n) * 0.7, Math.max(width, depth) / 400)
  const cols = Math.max(1, Math.ceil(width / cell))
  const rows = Math.max(1, Math.ceil(depth / cell))
  const grid: number[][] = new Array<number[]>(cols * rows)
  const cellOf = (x: number, z: number) => [Math.min(cols - 1, Math.floor(x / cell)), Math.min(rows - 1, Math.floor(z / cell))]

  /** Squared distance from a point to the nearest spot placed so far. */
  const nearest = (x: number, z: number): number => {
    const [cx, cz] = cellOf(x, z)
    let best = Infinity
    const reach = Math.max(cols, rows)
    for (let r = 0; r <= reach; r++) {
      if (best < Infinity && r * cell > Math.sqrt(best)) break // every cell further out is farther than the best spot found
      for (let gz = Math.max(0, cz - r); gz <= Math.min(rows - 1, cz + r); gz++) {
        for (let gx = Math.max(0, cx - r); gx <= Math.min(cols - 1, cx + r); gx++) {
          if (Math.max(Math.abs(gx - cx), Math.abs(gz - cz)) !== r) continue // only the ring at distance r
          const bucket = grid[gz * cols + gx]
          if (!bucket) continue
          for (const j of bucket) {
            const dx = spots[j * 2] - x
            const dz = spots[j * 2 + 1] - z
            const d = dx * dx + dz * dz
            if (d < best) best = d
          }
        }
      }
    }
    return best
  }

  for (let i = 0; i < n; i++) {
    let bx = 0
    let bz = 0
    let bestRoom = -1
    for (let c = 0; c < (i === 0 ? 1 : CANDIDATES); c++) {
      const x = random() * width
      const z = random() * depth
      const room = i === 0 ? 0 : nearest(x, z)
      if (room > bestRoom) {
        bestRoom = room
        bx = x
        bz = z
      }
    }
    spots[i * 2] = bx
    spots[i * 2 + 1] = bz
    const [gx, gz] = cellOf(bx, bz)
    ;(grid[gz * cols + gx] ??= []).push(i)
  }
  return spots
}

/**
 * The crowd of a venue: faceless dark mannequins standing in rectangular zones, drawn as thin instances of two
 * meshes (arms down and arms up) so thousands cost little. They do not take part in picking. They cast shadows
 * from the lights that cast shadows (the fixture rig adds `casters` to those shadow maps), and every person also has
 * a soft dark disc on the floor, which darkens it where a crowd stands whatever the lights do.
 * Motion (sway or dance) is worked out per person from a phase, and the instance matrices are rewritten at 30 Hz.
 */
export class Crowd {
  private meshes: [Mesh, Mesh]
  private contact: Mesh
  private material: PBRMaterial
  private paused = false
  /** Called when the people were placed again, so that shadows can be rendered again. */
  onPlaced: (() => void) | null = null
  private people: [People, People] = [empty(), empty()]
  /** the floor discs, one per person in rank order over both kinds: x, y, z and size, with their ranks */
  private discs = { data: new Float32Array(0), ranks: new Float64Array(0), visible: 0 }
  private matrices: [Float32Array, Float32Array] = [new Float32Array(0), new Float32Array(0)]
  private crowd: CrowdData | null = null
  private signature = ''
  private lastMotion = 0
  private hold = false
  private readonly q = new Quaternion()
  private readonly m = new Matrix()
  private readonly s = new Vector3()
  private readonly p = new Vector3()

  constructor(
    private scene: Scene,
    maxLights: number,
  ) {
    const material = new PBRMaterial('crowd-material', scene)
    material.albedoColor.set(0.045, 0.045, 0.055)
    material.roughness = 0.9
    material.metallic = 0
    material.useGLTFLightFalloff = true
    material.maxSimultaneousLights = maxLights
    this.material = material
    this.meshes = [this.buildMannequin(false), this.buildMannequin(true)]
    this.contact = this.buildContactDisc()
  }

  /** The meshes that cast shadows (the people, not the floor discs). */
  get casters(): AbstractMesh[] {
    return [...this.meshes]
  }

  /** A flat disc with a soft dark middle, lying just above the floor, one instance per person. */
  private buildContactDisc(): Mesh {
    const scene = this.scene
    const size = 64
    const texture = new DynamicTexture('crowd-contact-texture', { width: size, height: size }, scene, true)
    const ctx = texture.getContext() as CanvasRenderingContext2D
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    gradient.addColorStop(0, `rgba(0, 0, 0, ${CONTACT_DARKNESS})`)
    gradient.addColorStop(0.45, `rgba(0, 0, 0, ${CONTACT_DARKNESS * 0.7})`)
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
    ctx.clearRect(0, 0, size, size)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, size, size)
    texture.hasAlpha = true
    texture.update()
    const material = new StandardMaterial('crowd-contact-material', scene)
    material.diffuseTexture = texture
    material.useAlphaFromDiffuseTexture = true
    material.disableLighting = true
    material.emissiveColor.set(0, 0, 0)
    material.backFaceCulling = false
    material.disableDepthWrite = true
    material.zOffset = -2
    const disc = MeshBuilder.CreateDisc('crowd-contact', { radius: CONTACT_RADIUS, tessellation: 24 }, scene)
    disc.rotation.x = Math.PI / 2 // lie flat, facing up
    disc.bakeCurrentTransformIntoVertices()
    disc.material = material
    disc.isPickable = false
    disc.alwaysSelectAsActiveMesh = true
    disc.doNotSyncBoundingInfo = true
    disc.setEnabled(false)
    return disc
  }

  /** One mannequin, feet at the origin, about 1.65 m tall: legs, a flat-chested torso (so the way it faces shows), a head, and optionally raised arms. */
  private buildMannequin(armsUp: boolean): Mesh {
    const scene = this.scene
    const pieces: Mesh[] = []
    const legs = MeshBuilder.CreateCylinder('crowd-legs', { height: 0.85, diameterTop: 0.22, diameterBottom: 0.15, tessellation: 10 }, scene)
    legs.position.y = 0.425
    legs.scaling.z = 0.85
    const torso = MeshBuilder.CreateCylinder('crowd-torso', { height: 0.58, diameterTop: 0.42, diameterBottom: 0.3, tessellation: 12 }, scene)
    torso.position.y = 1.14
    torso.scaling.z = 0.58
    const head = MeshBuilder.CreateSphere('crowd-head', { diameter: 0.23, segments: 8 }, scene)
    head.position.y = 1.54
    pieces.push(legs, torso, head)
    if (armsUp) {
      for (const side of [-1, 1]) {
        const arm = MeshBuilder.CreateCylinder('crowd-arm', { height: 0.64, diameter: 0.09, tessellation: 8 }, scene)
        arm.position.set(side * 0.27, 1.62, 0)
        arm.rotation.z = -side * 0.24
        pieces.push(arm)
      }
    }
    const mesh = Mesh.MergeMeshes(pieces, true, true)!
    mesh.name = armsUp ? 'crowd-arms-up' : 'crowd-arms-down'
    mesh.material = this.material
    mesh.isPickable = false
    mesh.alwaysSelectAsActiveMesh = true // thin instances do not update the bounding box
    mesh.doNotSyncBoundingInfo = true
    mesh.setEnabled(false)
    return mesh
  }

  /** Follows the crowd of the open venue: places the people again when zones change, and otherwise only how many are shown. */
  sync(crowd: CrowdData) {
    this.crowd = crowd
    const zones = crowd.zones.map((z) => [z.id, z.x0, z.z0, z.x1, z.z1, z.y, z.facing, z.shown])
    const signature = JSON.stringify(zones) // the density is not part of it: it only reveals more or fewer of the same people
    if (signature !== this.signature) {
      this.signature = signature
      this.place(crowd)
    }
    this.reveal(crowd)
  }

  /**
   * Stands the whole crowd at full density, once. In each zone person k is the k-th of a spread-out random order of spots, and has
   * the rank (k + 0.5) / (people at full density), so at any density the first people of every zone are the ones shown.
   * Only as many are made as can ever be drawn at once.
   */
  private place(crowd: CrowdData) {
    const lists: { rank: number; v: number; values: number[] }[] = []
    const shownZones = crowd.zones.filter((z) => z.shown)
    const totalFull = shownZones.reduce((sum, z) => sum + fullCount(z), 0)
    const limit = crowdThreshold({ ...crowd, density: 1 }, totalFull)
    for (const zone of shownZones) this.fillZone(zone, limit, lists)
    lists.sort((a, b) => a.rank - b.rank)
    for (let v = 0; v < 2; v++) {
      const mine = lists.filter((l) => l.v === v)
      const data = new Float32Array(mine.length * 6)
      mine.forEach((l, i) => data.set(l.values, i * 6))
      this.people[v] = { data, ranks: Float64Array.from(mine.map((l) => l.rank)), count: mine.length, visible: 0 }
      this.matrices[v] = new Float32Array(mine.length * 16)
      if (mine.length > 0) this.meshes[v].thinInstanceSetBuffer('matrix', this.matrices[v], 16, false)
    }
    // the floor discs: one per person in rank order, where they stand (they do not move with the sway)
    const discData = new Float32Array(lists.length * 16)
    lists.forEach((l, i) => {
      this.s.setAll(l.values[4])
      this.p.set(l.values[0], l.values[1] + CONTACT_LIFT, l.values[2])
      Matrix.ComposeToRef(this.s, Quaternion.Identity(), this.p, this.m)
      this.m.copyToArray(discData, i * 16)
    })
    this.discs = { data: discData, ranks: Float64Array.from(lists.map((l) => l.rank)), visible: 0 }
    if (lists.length > 0) this.contact.thinInstanceSetBuffer('matrix', discData, 16, true)
  }

  private fillZone(zone: CrowdZone, limit: number, lists: { rank: number; v: number; values: number[] }[]) {
    // two streams, so the people's looks do not change when the number of people made does
    const random = seeded(hash(zone.id + ':looks'))
    const full = fullCount(zone)
    const made = visibleCount(full, limit)
    const minX = Math.min(zone.x0, zone.x1)
    const minZ = Math.min(zone.z0, zone.z1)
    const width = Math.abs(zone.x1 - zone.x0)
    const depth = Math.abs(zone.z1 - zone.z0)
    const spots = spreadSpots(made, width, depth, seeded(hash(zone.id)))
    for (let k = 0; k < made; k++) {
      const x = minX + spots[k * 2]
      const z = minZ + spots[k * 2 + 1]
      const yaw = zone.facing ? Math.atan2(zone.facing[0] - x, zone.facing[1] - z) + (random() - 0.5) * 2 * FACING_SPREAD : random() * TAU
      const size = 0.93 + random() * 0.2
      const phase = random() * TAU
      const armsUp = random() < ARMS_UP_SHARE ? 1 : 0
      lists.push({ rank: personRank(k, full), v: armsUp, values: [x, zone.y, z, yaw, size, phase] })
    }
  }

  /** The people are not drawn (they stay in the crowd, and absorb light as before), for views where they are in the way. */
  setHidden(hidden: boolean) {
    for (const mesh of [...this.meshes, this.contact]) mesh.isVisible = !hidden
  }

  /** Shows the first people of the crowd up to the density (and the overall limit), and hides the rest. */
  private reveal(crowd: CrowdData) {
    const totalFull = crowd.zones.reduce((sum, z) => (z.shown ? sum + fullCount(z) : sum), 0)
    const limit = crowdThreshold(crowd, totalFull)
    let changed = false
    for (let v = 0; v < 2; v++) {
      const visible = crowd.shown ? countBelow(this.people[v].ranks, limit) : 0
      if (visible !== this.people[v].visible) changed = true
      this.people[v].visible = visible
      this.meshes[v].thinInstanceCount = visible
      this.meshes[v].setEnabled(visible > 0)
    }
    const discs = crowd.shown ? countBelow(this.discs.ranks, limit) : 0
    this.discs.visible = discs
    this.contact.thinInstanceCount = discs
    this.contact.setEnabled(discs > 0)
    // the people who just appeared need their matrices (a still crowd is not rewritten every frame)
    this.write(this.hold || crowd.motion === 'still' ? 0 : this.lastMotion)
    if (changed) this.onPlaced?.()
  }

  /** Writes the matrix of every person who is shown, for the moment `time` (0 for standing still), and sends it to the GPU. */
  private write(time: number) {
    const crowd = this.crowd
    if (!crowd) return
    const still = this.hold || crowd.motion === 'still' || time === 0
    const intensity = crowd.intensity
    const { q, m, s, p } = this
    for (let v = 0; v < 2; v++) {
      const { data, visible } = this.people[v]
      if (visible === 0) continue
      const out = this.matrices[v]
      for (let i = 0; i < visible; i++) {
        const o = i * 6
        const phase = data[o + 5]
        let bob = 0
        let leanX = 0
        let leanZ = 0
        let twist = 0
        if (!still) {
          if (crowd.motion === 'sway') {
            leanZ = (0.03 + 0.09 * intensity) * Math.sin(1.4 * time + phase)
            leanX = (0.015 + 0.03 * intensity) * Math.sin(0.9 * time + phase * 1.7)
          } else {
            // dance: a bounce on every beat (120 bpm) with the sway and twist of a slower step
            bob = (0.015 + 0.055 * intensity) * Math.abs(Math.sin(TAU * time * 1.0 + phase * 0.5))
            leanZ = (0.05 + 0.12 * intensity) * Math.sin(TAU * time * 0.5 + phase * 0.4)
            leanX = (0.03 + 0.08 * intensity) * Math.sin(TAU * time + phase * 0.5)
            twist = (0.15 + 0.35 * intensity) * Math.sin(TAU * time * 0.5 + phase * 0.4 + 1)
          }
        }
        Quaternion.RotationYawPitchRollToRef(data[o + 3] + twist, leanX, leanZ, q)
        s.setAll(data[o + 4])
        p.set(data[o], data[o + 1] + bob, data[o + 2])
        Matrix.ComposeToRef(s, q, p, m)
        m.copyToArray(out, i * 16)
      }
      this.meshes[v].thinInstanceBufferUpdated('matrix')
    }
  }

  /** Call once per frame with the time in seconds. */
  update(time: number) {
    const crowd = this.crowd
    if (!crowd || !crowd.shown || this.hold || this.paused || crowd.motion === 'still') return
    if (time - this.lastMotion < 1 / MOTION_RATE) return
    this.lastMotion = time
    this.write(time)
  }

  /** Stops all movement where it is (animations off) or lets people move again. */
  setAnimate(on: boolean) {
    this.paused = !on
  }

  /** Holds everyone in a neutral pose (for a screenshot) or lets them move again. */
  setHold(on: boolean) {
    if (this.hold === on) return
    this.hold = on
    this.write(0)
  }

  /** The number of people drawn. */
  get count() {
    return this.people[0].visible + this.people[1].visible
  }

  dispose() {
    this.contact.dispose(false, true)
    for (const mesh of this.meshes) mesh.dispose()
    this.material.dispose()
  }
}
