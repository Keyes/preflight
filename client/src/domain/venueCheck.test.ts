import { expect, test } from 'vitest'
import { checkVenue, type Box } from './venueCheck'

const room: Box = { min: [-10, 0, -8], max: [10, 9, 8] }
const lightAt = (name: string, x: number, y: number, z: number) => ({ name, position: [x, y, z] as [number, number, number] })

test('a room-sized model with its lights inside has nothing to say', () => {
  expect(checkVenue(room, [lightAt('Spot 1', 0, 8, 0)])).toEqual({ size: [20, 9, 16], warnings: [], notes: [] })
})

test('a model far too small or far too large for a room was probably drawn in other units', () => {
  const small = checkVenue({ min: [0, 0, 0], max: [0.5, 0.3, 0.4] }, [])
  expect(small.warnings).toHaveLength(1)
  expect(small.warnings[0]).toMatch(/other units/)

  const large = checkVenue({ min: [0, 0, 0], max: [500, 300, 400] }, [])
  expect(large.warnings).toHaveLength(1)
  expect(large.warnings[0]).toMatch(/other units/)
})

test('a model floating above the origin is a warning, one reaching below it only a note', () => {
  expect(checkVenue({ min: [-10, 2, -8], max: [10, 11, 8] }, []).warnings[0]).toMatch(/above the origin/)

  const cellar = checkVenue({ min: [-10, -3, -8], max: [10, 9, 8] }, [])
  expect(cellar.warnings).toEqual([])
  expect(cellar.notes[0]).toMatch(/below the origin/)
})

test('lights more than half a meter outside the model are named, the first three of them', () => {
  expect(checkVenue(room, [lightAt('Close', 10.4, 5, 0)]).warnings).toEqual([])

  const outside = ['A', 'B', 'C', 'D'].map((name, i) => lightAt(name, 20 + i, 5, 0))
  const [warning] = checkVenue(room, outside).warnings
  expect(warning).toMatch(/^4 lights stand outside the model \(A, B, C, …\)/)
  expect(checkVenue(room, outside.slice(0, 1)).warnings[0]).toMatch(/^1 light stands outside the model \(A\)/)
})
