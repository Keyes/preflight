import { Vector3 } from '@babylonjs/core'
import { expect, test } from 'vitest'
import { insidePose, lookRotation, overviewPose } from './ViewerCamera'

const round = (v: readonly number[]) => v.map((n) => Math.round(n * 1000) / 1000 || 0)
// the demo club's box
const bounds = { min: new Vector3(-10, 0, -8), max: new Vector3(10, 7, 10) }

test('a look rotation: yaw turns from +z towards +x, pitch is positive looking down', () => {
  expect(round(lookRotation(Vector3.Zero(), new Vector3(0, 0, 5)).asArray())).toEqual([0, 0, 0])
  expect(round(lookRotation(Vector3.Zero(), new Vector3(5, 0, 0)).asArray())).toEqual([0, round([Math.PI / 2])[0], 0])
  expect(round(lookRotation(Vector3.Zero(), new Vector3(0, -1, 1)).asArray())).toEqual([round([Math.PI / 4])[0], 0, 0])
})

test('the overview looks from high in front of the venue at its middle', () => {
  const pose = overviewPose(bounds)
  expect(pose.position).toEqual([0, 15, -22])
  expect(round(pose.rotation)).toEqual(round(lookRotation(new Vector3(0, 15, -22), new Vector3(0, 3.5, 1)).asArray()))
})

test('inside is at eye height over the floor in the middle of the venue, looking along it', () => {
  expect(insidePose(bounds, 0.4)).toEqual({ position: [0, 2.1, 1], rotation: [0, 0, 0] })
})
