import type { RiderLamp, RiderPlan } from './types.js'

/**
 * From the plan page to the venue: the similarity (scale, turn, shift) that maps plan pixels to world meters on the floor plane
 * (world x and z), and the position and orientation of a light drawn at a spot on the plan.
 *
 * The scene is left-handed (x right, y up, z forward): seen from above with +z at the top of the screen, +x is to the right.
 * A plan has x to the right and y down the page, so the map includes a flip of the plan's y: the plan's "up" is world +z
 * when the turn is zero. Without the flip the lights would come out mirrored about the line through the two reference points.
 */

export interface Similarity {
  /** meters per plan pixel */
  scale: number
  /** turn in radians, applied after the flip of the plan's y */
  theta: number
  tx: number
  tz: number
}

type Point = [number, number]

/** The similarity that takes plan points A and B to world points a and b (x, z). */
export function similarityFromPairs(planA: Point, planB: Point, worldA: Point, worldB: Point): Similarity {
  const pdx = planB[0] - planA[0]
  const pdy = planB[1] - planA[1]
  const wdx = worldB[0] - worldA[0]
  const wdz = worldB[1] - worldA[1]
  const plen = Math.hypot(pdx, pdy)
  if (plen < 1e-9 || Math.hypot(wdx, wdz) < 1e-9) throw new Error('The two calibration points must be apart on the plan and in the venue')
  const scale = Math.hypot(wdx, wdz) / plen
  const theta = Math.atan2(wdz, wdx) - Math.atan2(-pdy, pdx)
  const s = { scale, theta, tx: 0, tz: 0 }
  const [x, z] = toWorld(s, planA)
  return { ...s, tx: worldA[0] - x, tz: worldA[1] - z }
}

export function toWorld(s: Similarity, p: Point): Point {
  const c = Math.cos(s.theta) * s.scale
  const n = Math.sin(s.theta) * s.scale
  return [c * p[0] + n * p[1] + s.tx, n * p[0] - c * p[1] + s.tz]
}

/** A direction on the plan (degrees clockwise from up the page) as a unit vector in world (x, z). */
export function facingToWorld(s: Similarity, facingDeg: number): Point {
  const r = (facingDeg * Math.PI) / 180
  const px = Math.sin(r)
  const py = Math.cos(r) // the plan's y is flipped, so "up the page" is +y here
  return [Math.cos(s.theta) * px - Math.sin(s.theta) * py, Math.sin(s.theta) * px + Math.cos(s.theta) * py]
}

/** The scale the plan's stage dimension implies, to compare with a calibration: meters per plan pixel, or undefined without a stage line. */
export function scaleFromStage(plan: RiderPlan): number | undefined {
  const line = plan.stage?.planPx
  if (!line || !plan.stage) return undefined
  const px = Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1])
  return px > 0 ? plan.stage.width / px : undefined
}

export type Quaternion = [number, number, number, number]

/** The rotation that takes the local +Y axis to the unit vector `to`. A light's local +Y points away from its mount, which is also where its beam goes. */
export function rotateYTo(to: [number, number, number]): Quaternion {
  const [x, y, z] = to
  if (y < -0.999999) return [1, 0, 0, 0] // straight down: half a turn about x, as a hanging light has by default
  if (y > 0.999999) return [0, 0, 0, 1]
  // axis = Y x to = (z, 0, -x); the angle's cosine is y
  const w = 1 + y
  const len = Math.hypot(z, -x, w)
  return [z / len, 0, -x / len, w / len]
}

/** How a light's beam leaves in the default: straight along its axis, or along a drawn direction tilted this far below (hanging) or above (standing) horizontal. */
export const FACING_ELEVATION_DEG = { hanging: -50, standing: 15 }

export interface Pose {
  /** unit vector the beam points along, world */
  aim: [number, number, number]
  rotation: Quaternion
}

/** The default orientation of a light: straight down (hanging) or up (standing), or along its drawn direction when the symbol shows one. */
export function poseFor(lamp: Pick<RiderLamp, 'facingDeg'>, mount: 'hanging' | 'standing', s: Similarity, useFacing = true): Pose {
  let aim: [number, number, number] = mount === 'hanging' ? [0, -1, 0] : [0, 1, 0]
  if (useFacing && lamp.facingDeg !== undefined) {
    const [dx, dz] = facingToWorld(s, lamp.facingDeg)
    const e = (FACING_ELEVATION_DEG[mount] * Math.PI) / 180
    aim = [dx * Math.cos(e), Math.sin(e), dz * Math.cos(e)]
  }
  return { aim, rotation: rotateYTo(aim) }
}
