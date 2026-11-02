import { expect, test } from 'vitest'
import type { Similarity } from '../api'
import { similarityFromPairs } from './rider'

type Point = [number, number]

/** How the server places a plan point with the similarity (toWorld in server/src/rider/placement.ts). */
function toWorld(s: Similarity, [px, py]: Point): Point {
  const c = Math.cos(s.theta) * s.scale
  const n = Math.sin(s.theta) * s.scale
  return [c * px + n * py + s.tx, n * px - c * py + s.tz]
}

test('takes the two calibration points on the plan exactly onto the two in the venue', () => {
  const planA: Point = [120, 840]
  const planB: Point = [1620, 300]
  const worldA: Point = [-4, 2]
  const worldB: Point = [6.5, 9]
  const s = similarityFromPairs(planA, planB, worldA, worldB)!
  for (const [plan, world] of [
    [planA, worldA],
    [planB, worldB],
  ]) {
    const [x, z] = toWorld(s, plan)
    expect(x).toBeCloseTo(world[0], 9)
    expect(z).toBeCloseTo(world[1], 9)
  }
})

test('keeps the plan the right way round: the page is flipped onto the left-handed scene, not mirrored', () => {
  // plan x to the right and plan y down the page; in the venue +x stays +x, and down the page is −z
  const s = similarityFromPairs([0, 0], [100, 0], [0, 0], [10, 0])!
  expect(s.scale).toBeCloseTo(0.1)
  const [x, z] = toWorld(s, [0, 100])
  expect(x).toBeCloseTo(0, 9)
  expect(z).toBeCloseTo(-10, 9)
})

test('gives no answer for points that are too close together to calibrate from', () => {
  expect(similarityFromPairs([10, 10], [10.5, 10], [0, 0], [5, 0])).toBeNull()
  expect(similarityFromPairs([0, 0], [100, 0], [1, 1], [1.005, 1])).toBeNull()
})
