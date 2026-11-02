import { Vector3 } from '@babylonjs/core'
import { expect, test } from 'vitest'
import { fitPlan, planPose } from './RiderPlanView'

const round = (v: readonly number[]) => v.map((n) => Math.round(n * 100) / 100 || 0)
// the demo club's box: 20 m wide (x), 18 m deep (z), its middle at (0, 1)
const bounds = { min: new Vector3(-10, 0, -8), max: new Vector3(10, 7, 10) }
const tan25 = Math.tan((25 * Math.PI) / 180)

test('with the whole view free, the camera is high enough for the deeper side plus a margin', () => {
  const fit = fitPlan(bounds, 0, { width: 1000, height: 800, coveredPx: 0 })
  expect(fit.height).toBeCloseTo((1.1 * 9) / tan25) // half the depth, 9 m, decides: 10 m / (1000/800) is less
  expect(fit.shiftPx).toBe(0)
  expect(fit.metersPerPixel).toBeCloseTo((2 * tan25 * fit.height) / 800)
})

test('a covered part makes the free part narrower, so the camera goes higher and the venue moves left of the middle', () => {
  const fit = fitPlan(bounds, 0, { width: 1000, height: 800, coveredPx: 500 })
  expect(fit.height).toBeCloseTo((1.1 * 10) / (500 / 800) / tan25) // now half the width decides
  expect(fit.shiftPx).toBe(250)
  // a sliver of free view is not fitted into: the narrowest it counts is half as wide as high
  expect(fitPlan(bounds, 0, { width: 1000, height: 800, coveredPx: 900 }).height).toBeCloseTo((1.1 * 10) / 0.5 / tan25)
})

test('the plan pose looks straight down, shifted across the view whichever way the plan is turned', () => {
  const fit = { center: { x: 0, z: 1 }, floorY: 0.5, height: 30, metersPerPixel: 0.02, shiftPx: 100 }
  const north = planPose(fit, 0)
  expect(round(north.position)).toEqual([2, 30.5, 1])
  expect(north.rotation[0]).toBeCloseTo(Math.PI / 2, 2)
  expect(round(planPose(fit, Math.PI / 2).position)).toEqual([0, 30.5, -1])
})
