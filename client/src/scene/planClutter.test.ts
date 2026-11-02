import { expect, test } from 'vitest'
import { clutterCut, triangleIndices } from './planClutter'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** A box from (x0, y0, z0) to (x1, y1, z1) as 12 triangles, each with corners of its own (as exporters write them, unindexed). */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const c = (i: number) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0]
  const faces = [
    [0, 1, 3, 2],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [0, 2, 6, 4],
    [1, 3, 7, 5],
  ]
  return faces.flatMap(([a, b, cc, d]) => [a, b, cc, a, cc, d].flatMap(c))
}

/** A floor of `w` by `d` meters at height 0, as two triangles without shared corners. */
const floor = (w: number, d: number) => [0, 0, 0, w, 0, 0, w, 0, d, 0, 0, 0, w, 0, d, 0, 0, d]

const cut = (positions: number[]) => clutterCut(positions, triangleIndices(null, positions.length / 3), IDENTITY, 0)

test('a mesh without an index buffer is read as consecutive triangles', () => {
  expect(Array.from(triangleIndices(null, 6))).toEqual([0, 1, 2, 3, 4, 5])
  expect(Array.from(triangleIndices([], 7))).toEqual([0, 1, 2, 3, 4, 5])
  expect(Array.from(triangleIndices([2, 1, 0], 3))).toEqual([2, 1, 0])
})

test('a floor stays, also when it comes without an index buffer', () => {
  expect(cut(floor(20, 18))).toBeNull()
})

test('a speaker stack and a thin post on the floor are taken out, the floor and a high truss stay', () => {
  const floorPart = floor(20, 18)
  const stack = box(2, 0, 2, 3, 2, 3) // 1 x 1 m, 2 m high
  const post = box(8, 0, 8, 8.2, 3.8, 8.2) // a truss leg
  const highTruss = box(0, 5, 0, 10, 5.3, 0.3) // long, hanging high
  const result = cut([...floorPart, ...stack, ...post, ...highTruss])!
  expect(result.hidden).toBe(24) // the stack's and the post's triangles
  const kept = new Set(result.keep)
  expect([0, 1, 2, 3, 4, 5].every((i) => kept.has(i))).toBe(true) // the floor
  expect(result.keep.length).toBe(3 * (2 + 12)) // the floor and the high truss
})

test('a mesh that is all clutter keeps no triangles', () => {
  expect(cut(box(0, 0, 0, 1, 1, 1))).toEqual({ keep: [], hidden: 12 })
})
