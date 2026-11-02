import type { RiderLamp, RiderPlan, Similarity } from '@preflight/shared'

/**
 * The position and orientation of a light drawn at a spot on the plan. Plan points are mapped to the venue with the
 * similarity from @preflight/shared, which also explains the flip of the plan's y.
 */

type Point = [number, number]

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
