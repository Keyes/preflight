/**
 * From the plan page to the venue: the similarity (scale, turn, shift) that maps plan pixels to world meters on the floor
 * plane (world x and z). The client works it out from the two points the user calibrates with; the server places the lights
 * with it.
 *
 * The scene is left-handed (x right, y up, z forward): seen from above with +z at the top of the screen, +x is to the right.
 * A plan has x to the right and y down the page, so the map includes a flip of the plan's y: the plan's "up" is world +z
 * when the turn is zero. Without the flip the lights would come out mirrored about the line through the two reference points.
 */

export interface Similarity {
  /** meters per plan pixel */
  scale: number
  /** turn in radians, applied after the flip of the plan's y */
  theta: number
  tx: number
  tz: number
}

type Point = [number, number]

/**
 * The similarity that takes plan points A and B to world points a and b (x, z), or null when the points are too close
 * together to calibrate from: less than a pixel apart on the plan, or a centimeter in the venue.
 */
export function similarityFromPairs(planA: Point, planB: Point, worldA: Point, worldB: Point): Similarity | null {
  const plan = Math.hypot(planB[0] - planA[0], planB[1] - planA[1])
  const world = Math.hypot(worldB[0] - worldA[0], worldB[1] - worldA[1])
  if (plan < 1 || world < 0.01) return null
  const theta = Math.atan2(worldB[1] - worldA[1], worldB[0] - worldA[0]) - Math.atan2(-(planB[1] - planA[1]), planB[0] - planA[0])
  const s = { scale: world / plan, theta, tx: 0, tz: 0 }
  const [x, z] = toWorld(s, planA)
  return { ...s, tx: worldA[0] - x, tz: worldA[1] - z }
}

/** Where a point of the plan (pixels) lies in the venue (world x, z). */
export function toWorld(s: Similarity, p: Point): Point {
  const c = Math.cos(s.theta) * s.scale
  const n = Math.sin(s.theta) * s.scale
  return [c * p[0] + n * p[1] + s.tx, n * p[0] - c * p[1] + s.tz]
}
