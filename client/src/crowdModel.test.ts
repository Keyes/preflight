import { expect, test } from 'vitest'
import type { Crowd, CrowdZone } from './api'
import {
  CROWD_ABSORPTION,
  CROWD_HEIGHT,
  crowdAbsorbers,
  crowdThreshold,
  fullCount,
  MAX_ABSORBERS,
  MAX_PEOPLE,
  personRank,
  requestedPeople,
  totalPeople,
  visibleCount,
  zoneCounts,
} from './crowdModel'

const zone = (id: string, width: number, depth: number, over: Partial<CrowdZone> = {}): CrowdZone => ({
  id,
  name: id,
  x0: 0,
  z0: 0,
  x1: width,
  z1: depth,
  y: 0,
  facing: null,
  shown: true,
  ...over,
})

const crowd = (zones: CrowdZone[], density = 1): Crowd => ({ shown: true, density, motion: 'still', intensity: 0.5, zones })

test('a packed zone holds four people per square meter', () => {
  expect(fullCount(zone('a', 5, 2))).toBe(40)
  expect(fullCount(zone('a', 5, 2, { x0: 5, x1: 0 }))).toBe(40) // corners in either order
})

test('the visible count matches the people whose rank is under the threshold, for any zone and threshold', () => {
  for (const full of [1, 7, 40, 333]) {
    for (const limit of [0, 0.013, 0.25, 0.5, 0.731, 1]) {
      const byRank = Array.from({ length: full }, (_, k) => personRank(k, full)).filter((rank) => rank < limit).length
      expect(visibleCount(full, limit)).toBe(byRank)
    }
  }
})

test('the density is lowered so that no more than the most people are drawn', () => {
  expect(crowdThreshold(crowd([], 0.8), 1000)).toBe(0.8)
  expect(crowdThreshold(crowd([], 1), MAX_PEOPLE * 2)).toBe(0.5)
  expect(crowdThreshold(crowd([], 1), 0)).toBe(0)

  const huge = crowd([zone('floor', 100, 100)])
  expect(requestedPeople(huge)).toBe(40000)
  expect(totalPeople(huge)).toBe(MAX_PEOPLE)
})

test('only zones that show are counted', () => {
  const counts = zoneCounts(crowd([zone('front', 5, 2), zone('back', 5, 2, { shown: false })], 0.5))
  expect([...counts]).toEqual([['front', 20]])
})

test('a hidden crowd absorbs no light', () => {
  expect(crowdAbsorbers({ ...crowd([zone('a', 5, 5)]), shown: false })).toEqual([])
  expect(crowdAbsorbers(crowd([zone('a', 5, 5)], 0))).toEqual([])
})

test('the largest zones absorb light, as boxes as tall as a person and as dense as the crowd', () => {
  const zones = Array.from({ length: MAX_ABSORBERS + 2 }, (_, i) => zone(`z${i}`, i + 1, 1, { y: 0.5 }))
  const absorbers = crowdAbsorbers(crowd(zones, 0.5))
  expect(absorbers).toHaveLength(MAX_ABSORBERS)
  expect(absorbers[0].maxX).toBe(MAX_ABSORBERS + 2) // the widest zone first
  expect(absorbers[0]).toMatchObject({ minX: 0, minZ: 0, floor: 0.5, top: 0.5 + CROWD_HEIGHT })
  expect(absorbers[0].strength).toBeCloseTo(CROWD_ABSORPTION * 0.5)
})
