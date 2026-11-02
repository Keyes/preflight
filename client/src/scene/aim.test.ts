import { Quaternion, Vector3 } from '@babylonjs/core'
import { expect, test } from 'vitest'
import type { CatalogFixture, Fixture } from '../api'
import { profileFor, registerCatalog, travelDegrees } from '../fixtures/profiles'
import { solveAim, type AimPatch } from './aim'
import type { FixtureRig } from './FixtureRig'

const catalogEntry = (id: string, over: Partial<CatalogFixture>): CatalogFixture => ({
  id,
  manufacturer: 'Acme',
  manufacturerKey: 'acme',
  name: id,
  categories: ['Moving Head'],
  moving: true,
  features: [],
  modes: [],
  ...over,
})

registerCatalog([
  catalogEntry('acme/narrow-tilt', { features: ['pan', 'tilt'], panDegrees: 540, tiltDegrees: 90 }),
  catalogEntry('acme/par', { categories: ['Color Changer'], moving: false, features: ['red', 'green', 'blue'] }),
])

const light = (id: string, profileId = 'generic-moving-head'): Fixture => ({
  id,
  name: id,
  profileId,
  position: [0, 0, 0],
  mount: 'standing',
  yaw: 0,
  values: { pan: 0.5, tilt: 0.5 },
})

interface Pose {
  pivot: Vector3
  rotation: Quaternion
}

/** Just what solveAim asks a rig: where each light turns about, how its base is turned, and where its beam points. */
function rigOf(poses: Record<string, Pose>): FixtureRig {
  const rig: Pick<FixtureRig, 'pivotOf' | 'rootOf' | 'beamDirectionOf'> = {
    pivotOf: (id) => poses[id]?.pivot,
    rootOf: (id) => (poses[id] ? ({ rotationQuaternion: poses[id].rotation } as ReturnType<FixtureRig['rootOf']>) : undefined),
    beamDirectionOf: (id) => (poses[id] ? Vector3.Up().applyRotationQuaternion(poses[id].rotation) : undefined),
  }
  return rig as FixtureRig
}

const standing = (x: number, y = 0, z = 0): Pose => ({ pivot: new Vector3(x, y, z), rotation: Quaternion.Identity() })

/** Where a moving head's beam points after the patch: in its base's frame (sin T sin P, cos T, sin T cos P). */
function moverBeam(fixture: Fixture, pose: Pose, patch: AimPatch): Vector3 {
  const profile = profileFor(fixture.profileId)
  const pan = (travelDegrees(patch.values!.pan, profile.panRange) * Math.PI) / 180
  const tilt = (travelDegrees(patch.values!.tilt, profile.tiltRange) * Math.PI) / 180
  const local = new Vector3(Math.sin(tilt) * Math.sin(pan), Math.cos(tilt), Math.sin(tilt) * Math.cos(pan))
  return local.applyRotationQuaternion(pose.rotation)
}

const expectSameDirection = (actual: Vector3, expected: Vector3) => {
  const [a, e] = [actual.normalizeToNew(), expected.normalizeToNew()]
  expect(Vector3.Dot(a, e)).toBeCloseTo(1, 6)
}

test('a moving head gets the pan and tilt that point its beam at the spot', () => {
  const fixture = light('a')
  const pose = standing(0)
  // all within the generic head's tilt of ±135° from straight up
  for (const target of [new Vector3(5, 0, 0), new Vector3(-2, 3, 4), new Vector3(1, -1, -3)]) {
    const { patches, unreachable } = solveAim(rigOf({ a: pose }), [fixture], target, { spread: 0, fan: 0 })
    expect(unreachable).toEqual([])
    expectSameDirection(moverBeam(fixture, pose, patches.get('a')!), target.subtract(pose.pivot))
  }
})

test('a hanging moving head is aimed in its own frame', () => {
  const fixture = light('a')
  const pose: Pose = { pivot: new Vector3(0, 6, 0), rotation: Quaternion.RotationAxis(Vector3.Right(), Math.PI) }
  const target = new Vector3(3, 0, 2)
  const patch = solveAim(rigOf({ a: pose }), [fixture], target, { spread: 0, fan: 0 }).patches.get('a')!
  expectSameDirection(moverBeam(fixture, pose, patch), target.subtract(pose.pivot))
})

test('a light whose tilt cannot reach the spot points as close as it can and says so', () => {
  const fixture = light('a', 'acme/narrow-tilt')
  const { patches, unreachable } = solveAim(rigOf({ a: standing(0) }), [fixture], new Vector3(5, 0, 0), { spread: 0, fan: 0 })
  expect(unreachable).toEqual(['a'])
  expect(patches.get('a')!.values!.tilt).toBe(1) // as far as it goes
})

test('a light that cannot pan or tilt is turned as a whole', () => {
  const fixture = light('a', 'acme/par')
  const target = new Vector3(2, 5, -1)
  const patch = solveAim(rigOf({ a: standing(0) }), [fixture], target, { spread: 0, fan: 0 }).patches.get('a')!
  expect(patch.values).toBeUndefined()
  const [x, y, z, w] = patch.rotation!
  expectSameDirection(Vector3.Up().applyRotationQuaternion(new Quaternion(x, y, z, w)), target)
})

test('spread puts the spots that far apart along the line the lights stand on', () => {
  const fixtures = [light('a'), light('b')]
  const rig = rigOf({ a: standing(-1), b: standing(1) })
  const { patches } = solveAim(rig, fixtures, new Vector3(0, 5, 0), { spread: 2, fan: 0 })
  // the spots are (-1, 5, 0) and (1, 5, 0): each light points straight up
  expectSameDirection(moverBeam(fixtures[0], standing(-1), patches.get('a')!), Vector3.Up())
  expectSameDirection(moverBeam(fixtures[1], standing(1), patches.get('b')!), Vector3.Up())
})

test('skips lights the rig does not have, and gives up on a spot at the light itself', () => {
  const { patches, unreachable } = solveAim(rigOf({ a: standing(0) }), [light('a'), light('gone')], new Vector3(0, 0.01, 0), {
    spread: 0,
    fan: 0,
  })
  expect(patches.size).toBe(0)
  expect(unreachable).toEqual(['a'])
})
