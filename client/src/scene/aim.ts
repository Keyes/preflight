import { Matrix, Quaternion, Vector3 } from '@babylonjs/core'
import type { Fixture } from '../api'
import { profileFor, travelDegrees } from '../fixtures/profiles'
import type { FixtureRig } from './FixtureRig'

/** How a row of lights is pointed at a spot. Both default to 0, which puts every beam on the spot. */
export interface AimOptions {
  /** meters between the spots the lights aim at, along the line the lights stand on (negative crosses the beams over) */
  spread: number
  /** degrees between the outermost beams, about the vertical axis, on top of aiming at the spot (negative turns the other way) */
  fan: number
}

/** What to change on a light to make it aim: pan and tilt for a moving head, a new orientation for any other light. */
export interface AimPatch {
  values?: { pan: number; tilt: number }
  rotation?: [number, number, number, number]
}

export interface AimResult {
  patches: Map<string, AimPatch>
  /** lights whose pan or tilt travel stops short of the direction (they point as close as they can) */
  unreachable: string[]
}

const DEG = 180 / Math.PI
const RAD = Math.PI / 180

/** Degrees as the nearest equivalent of `target` to `reference` (pan can wrap around by whole turns). */
const nearestTurn = (target: number, reference: number) => target + 360 * Math.round((reference - target) / 360)

/**
 * Pan and tilt (as 0..1 values) that point a moving head's beam along `direction` (world space). Tilt turns the head
 * about the base's x axis from the straight-out direction and pan then turns everything about the base's own up axis, so
 * in the base's frame the beam is (sin T sin P, cos T, sin T cos P). A tilt to either side reaches the same direction
 * with the pan half a turn apart, and pan can wrap by whole turns: the way that moves the head least and stays in range wins.
 */
function solveMover(fixture: Fixture, rootRotation: Quaternion, direction: Vector3): { pan: number; tilt: number; reachable: boolean } {
  const profile = profileFor(fixture.profileId)
  const d = direction.applyRotationQuaternion(Quaternion.Inverse(rootRotation))
  const tiltAbs = Math.acos(Math.min(1, Math.max(-1, d.y))) * DEG
  const horizontal = Math.hypot(d.x, d.z)
  const currentPan = travelDegrees(fixture.values.pan ?? profile.defaults.pan ?? 0.5, profile.panRange)
  const currentTilt = travelDegrees(fixture.values.tilt ?? profile.defaults.tilt ?? 0.5, profile.tiltRange)
  const halfPan = profile.panRange / 2
  const halfTilt = profile.tiltRange / 2

  let best: { pan: number; tilt: number; reachable: boolean; cost: number } | null = null
  for (const side of [1, -1]) {
    const tilt = side * tiltAbs
    // looking straight along the pan axis, the pan does not matter: keep it where it is
    const panBase = horizontal < 1e-4 ? currentPan : Math.atan2(d.x, d.z) * DEG + (side < 0 ? 180 : 0)
    for (let turn = -2; turn <= 2; turn++) {
      const pan = nearestTurn(panBase, currentPan) + 360 * turn
      const over = Math.max(0, Math.abs(pan) - halfPan) + Math.max(0, Math.abs(tilt) - halfTilt)
      const cost = over * 1000 + Math.abs(pan - currentPan) + Math.abs(tilt - currentTilt)
      if (!best || cost < best.cost) best = { pan, tilt, reachable: over < 1e-6, cost }
    }
  }
  const chosen = best!
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  return {
    pan: clamp(0.5 + chosen.pan / profile.panRange),
    tilt: clamp(0.5 + chosen.tilt / profile.tiltRange),
    reachable: chosen.reachable,
  }
}

/** The orientation that turns a light so its beam (local +Y) follows `direction`, keeping its roll as far as it can. */
function solveFixed(rootRotation: Quaternion, current: Vector3, direction: Vector3): Quaternion {
  const dot = Vector3.Dot(current, direction)
  let delta: Quaternion
  if (dot < -0.9999) {
    // exactly the other way: any axis across the beam will do
    const across = Vector3.Cross(current, Math.abs(current.x) < 0.9 ? Vector3.Right() : Vector3.Forward()).normalize()
    delta = Quaternion.RotationAxis(across, Math.PI)
  } else {
    delta = Quaternion.FromUnitVectorsToRef(current, direction, new Quaternion())
  }
  return delta.multiply(rootRotation).normalize()
}

/**
 * Works out how to point the given lights (in the order given) at a spot. The lights are spread along the line they
 * stand on: the spots are `spread` meters apart along the horizontal direction from the first light to the last, centered
 * on the point. `fan` then opens the beams out by that many degrees in total, evenly across the row.
 */
export function solveAim(rig: FixtureRig, fixtures: readonly Fixture[], point: Vector3, options: AimOptions): AimResult {
  const patches = new Map<string, AimPatch>()
  const unreachable: string[] = []
  const lights = fixtures.filter((f) => rig.pivotOf(f.id))
  const n = lights.length
  if (n === 0) return { patches, unreachable }

  const pivots = lights.map((f) => rig.pivotOf(f.id)!)
  // the line the lights stand on, horizontally: from the first to the last
  let line = new Vector3(pivots[n - 1].x - pivots[0].x, 0, pivots[n - 1].z - pivots[0].z)
  if (line.length() < 0.05) {
    // lights stacked on one spot: across the view from them to the point instead
    const middle = pivots.reduce((sum, p) => sum.add(p), Vector3.Zero()).scale(1 / n)
    const toPoint = new Vector3(point.x - middle.x, 0, point.z - middle.z)
    line = toPoint.length() < 0.05 ? Vector3.Right() : new Vector3(toPoint.z, 0, -toPoint.x)
  }
  line.normalize()

  lights.forEach((fixture, i) => {
    const centered = i - (n - 1) / 2
    const target = point.add(line.scale(options.spread * centered))
    const aim = target.subtract(pivots[i])
    if (aim.length() < 0.05) {
      unreachable.push(fixture.id)
      return
    }
    let direction = aim.normalize()
    if (options.fan !== 0 && n > 1) {
      const angle = options.fan * RAD * (i / (n - 1) - 0.5)
      direction = Vector3.TransformNormal(direction, Matrix.RotationY(angle)).normalize()
    }
    const profile = profileFor(fixture.profileId)
    const root = rig.rootOf(fixture.id)?.rotationQuaternion
    if (!root) return
    if (profile.controls.pan && profile.controls.tilt && profile.panRange > 0 && profile.tiltRange > 0) {
      const solved = solveMover(fixture, root, direction)
      patches.set(fixture.id, { values: { pan: solved.pan, tilt: solved.tilt } })
      if (!solved.reachable) unreachable.push(fixture.id)
    } else {
      const current = rig.beamDirectionOf(fixture.id)
      if (!current) return
      patches.set(fixture.id, { rotation: solveFixed(root, current, direction).asArray() as [number, number, number, number] })
    }
  })
  return { patches, unreachable }
}
