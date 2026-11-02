import assert from 'node:assert/strict'
import { test } from 'node:test'
import { similarityFromPairs, toWorld } from './similarity.js'

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`)

test('two points fix scale, turn and shift', () => {
  const s = similarityFromPairs([100, 200], [300, 200], [-5, 1], [5, 1])!
  near(s.scale, 0.05)
  near(s.theta, 0)
  const [x, z] = toWorld(s, [200, 300])
  near(x, 0)
  near(z, -4) // 100 px further down the page is 5 m towards -z: the plan's y is flipped, not mirrored
  const turned = similarityFromPairs([0, 0], [100, 0], [0, 0], [0, 10])! // plan "right" is world +z
  const [a, b] = toWorld(turned, [100, 100])
  near(a, 10)
  near(b, 10)
})

test('takes the two calibration points on the plan exactly onto the two in the venue', () => {
  const pairs: [plan: [number, number], world: [number, number]][] = [
    [
      [120, 840],
      [-4, 2],
    ],
    [
      [1620, 300],
      [6.5, 9],
    ],
  ]
  const s = similarityFromPairs(pairs[0][0], pairs[1][0], pairs[0][1], pairs[1][1])!
  for (const [plan, world] of pairs) {
    const [x, z] = toWorld(s, plan)
    near(x, world[0], 1e-9)
    near(z, world[1], 1e-9)
  }
})

test('gives no answer for points that are too close together to calibrate from', () => {
  assert.equal(similarityFromPairs([10, 10], [10.5, 10], [0, 0], [5, 0]), null) // half a pixel apart on the plan
  assert.equal(similarityFromPairs([0, 0], [100, 0], [1, 1], [1.005, 1]), null) // half a centimeter apart in the venue
})
