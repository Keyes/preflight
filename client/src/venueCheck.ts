import type { Fixture } from './api'

export interface Box {
  min: [number, number, number]
  max: [number, number, number]
}

export interface VenueCheck {
  /** width (x), height (y) and depth (z) of the model in meters */
  size: [number, number, number]
  /** things that look wrong, as plain sentences */
  warnings: string[]
  /** things worth knowing that are often fine (a cellar below the floor) */
  notes: string[]
}

const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1))

/**
 * Looks at the size and position of a venue's model, and where its lights stand, for signs of a wrong scale or origin:
 * a model far too small or too large for a room (the usual sign of a unit mix-up, such as inches read as meters), a
 * model whose lowest point is far from the origin (lights and zones copied from a venue drawn at the origin land off),
 * and lights outside the model.
 */
export function checkVenue(box: Box, fixtures: readonly Pick<Fixture, 'name' | 'position'>[]): VenueCheck {
  const size: [number, number, number] = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]]
  const warnings: string[] = []
  const notes: string[] = []
  const footprint = Math.max(size[0], size[2])
  if (footprint < 4 || size[1] < 1.5) {
    warnings.push(
      `The model is only ${fmt(size[0])} × ${fmt(size[2])} m and ${fmt(size[1])} m high. If it should be larger, it was probably drawn in other units (inches or millimeters read as meters).`,
    )
  } else if (footprint > 300 || size[1] > 80) {
    warnings.push(
      `The model is ${fmt(size[0])} × ${fmt(size[2])} m and ${fmt(size[1])} m high, far larger than a room. It was probably drawn in other units, or holds something large besides the venue.`,
    )
  }
  if (box.min[1] > 0.5) {
    warnings.push(
      `The lowest point of the model is ${fmt(box.min[1])} m above the origin, so the model floats and a floor at height 0 would be in the air. A light placed on a surface is fine, but lights and zones copied from another venue keep their heights.`,
    )
  } else if (box.min[1] < -0.5) {
    notes.push(
      `The lowest point of the model is ${fmt(-box.min[1])} m below the origin (a cellar or a base, usually). The floor is normally at height 0, so a light copied from another venue lands at the right height only when that venue's floor is at 0 too.`,
    )
  }
  const margin = 0.5
  const outside = fixtures.filter((f) => f.position.some((v, i) => v < box.min[i] - margin || v > box.max[i] + margin))
  if (outside.length) {
    const names = outside
      .slice(0, 3)
      .map((f) => f.name)
      .join(', ')
    warnings.push(
      `${outside.length} ${outside.length === 1 ? 'light stands' : 'lights stand'} outside the model (${names}${outside.length > 3 ? ', …' : ''}). Copied lights keep their coordinates, so this often means the two venues are drawn at different origins.`,
    )
  }
  return { size, warnings, notes }
}
