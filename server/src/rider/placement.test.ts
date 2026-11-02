import assert from 'node:assert/strict'
import { test } from 'node:test'
import { facingToWorld, poseFor, rotateYTo, scaleFromStage, similarityFromPairs, toWorld, type Quaternion } from './placement.js'

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`)

/** Rotates a vector by a quaternion [x, y, z, w]. */
function rotate(q: Quaternion, v: [number, number, number]): [number, number, number] {
  const [x, y, z, w] = q
  const [vx, vy, vz] = v
  const tx = 2 * (y * vz - z * vy)
  const ty = 2 * (z * vx - x * vz)
  const tz = 2 * (x * vy - y * vx)
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)]
}

test('two points fix scale, turn and shift', () => {
  const s = similarityFromPairs([100, 200], [300, 200], [-5, 1], [5, 1])
  near(s.scale, 0.05)
  near(s.theta, 0)
  const [x, z] = toWorld(s, [200, 300])
  near(x, 0)
  near(z, -4) // 100 px further down the page is 5 m towards -z: the plan's y is flipped
  const turned = similarityFromPairs([0, 0], [100, 0], [0, 0], [0, 10]) // plan "right" is world +z
  const [a, b] = toWorld(turned, [100, 100])
  near(a, 10)
  near(b, 10)
  // both reference points land where they were put
  const ends = similarityFromPairs([842, 1686], [2841, 1686], [-3, 2], [7, 2])
  const [ax, az] = toWorld(ends, [842, 1686])
  const [bx, bz] = toWorld(ends, [2841, 1686])
  near(ax, -3)
  near(az, 2)
  near(bx, 7)
  near(bz, 2)
})

test('a drawn direction turns with the plan: up the page is world +z when the plan is not turned', () => {
  const s = { scale: 0.01, theta: 0, tx: 0, tz: 0 }
  const [x, z] = facingToWorld(s, 0)
  near(x, 0)
  near(z, 1)
  const [rx, rz] = facingToWorld(s, 90)
  near(rx, 1)
  near(rz, 0)
})

test('rotateYTo takes the +Y axis to the wanted direction', () => {
  for (const to of [
    [0, -1, 0],
    [0, 1, 0],
    [1, 0, 0],
    [0, 0, -1],
    [0.6, -0.64, 0.48],
  ] as [number, number, number][]) {
    const len = Math.hypot(...to)
    const unit = to.map((n) => n / len) as [number, number, number]
    const out = rotate(rotateYTo(unit), [0, 1, 0])
    unit.forEach((n, i) => near(out[i], n))
  }
})

test('a hanging light points down by default and along its drawn direction, tilted down, when it has one', () => {
  const s = { scale: 0.01, theta: 0, tx: 0, tz: 0 }
  assert.deepEqual(poseFor({}, 'hanging', s).aim, [0, -1, 0])
  assert.deepEqual(poseFor({}, 'standing', s).aim, [0, 1, 0])
  const faced = poseFor({ facingDeg: 180 }, 'hanging', s)
  assert.ok(faced.aim[2] < -0.5 && faced.aim[1] < -0.7) // 180 degrees is down the page: towards -z
  assert.deepEqual(poseFor({ facingDeg: 180 }, 'hanging', s, false).aim, [0, -1, 0])
})

test('the plan scale follows from the stage line', () => {
  near(
    scaleFromStage({
      page: 2,
      image: { width: 1, height: 1 },
      trusses: {},
      stage: {
        width: 10,
        depth: 4.7,
        height: 0.6,
        planPx: [
          [0, 50],
          [2000, 50],
        ],
      },
    })!,
    0.005,
  )
})
