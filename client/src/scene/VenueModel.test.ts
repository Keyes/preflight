import { Quaternion, Vector3 } from '@babylonjs/core'
import { expect, test } from 'vitest'
import { mountOnSurface } from './VenueModel'

const round = (v: readonly number[]) => v.map((n) => Math.round(n * 1000) / 1000 || 0)

test('a light placed on the floor stands, upright', () => {
  const pose = mountOnSurface(new Vector3(1, 0, 2), Vector3.Up())
  expect(pose.mount).toBe('standing')
  expect(round(pose.position)).toEqual([1, 0.003, 2]) // just above the surface
  expect(round(pose.rotation)).toEqual([0, 0, 0, 1])
})

test('a light placed on a ceiling hangs, turned upside down', () => {
  const pose = mountOnSurface(new Vector3(0, 5, 0), Vector3.Down())
  expect(pose.mount).toBe('hanging')
  expect(round(pose.position)).toEqual([0, 4.997, 0])
  expect(round(pose.rotation)).toEqual(round(Quaternion.RotationAxis(Vector3.Right(), Math.PI).asArray()))
})

test('a surface seen from behind is used from the side the click came from', () => {
  // a floor whose normal points down, clicked from above: the light still stands on it
  expect(mountOnSurface(new Vector3(0, 0, 0), Vector3.Down(), new Vector3(0, -1, 0)).mount).toBe('standing')
})

test('on a wall the light sits sideways, its base against the wall', () => {
  const pose = mountOnSurface(new Vector3(0, 2, -8), new Vector3(0, 0, 1))
  expect(pose.mount).toBe('standing') // not facing down
  const up = Vector3.Up().rotateByQuaternionToRef(Quaternion.FromArray(pose.rotation), new Vector3())
  expect(round(up.asArray())).toEqual([0, 0, 1])
})
