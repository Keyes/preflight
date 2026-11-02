import type { Crowd, CrowdZone } from './api'

/** People per square meter at density 100%: a packed standing crowd. */
export const MAX_PER_M2 = 4
/** The most people drawn at once, over all zones (the crowd is thinned to fit). */
export const MAX_PEOPLE = 4000
/** The smallest side of a zone, meters. */
export const MIN_ZONE_SIDE = 0.8

export const DEFAULT_CROWD: Crowd = { shown: true, density: 0.5, motion: 'sway', intensity: 0.5, zones: [] }

export const zoneArea = (zone: CrowdZone) => Math.abs(zone.x1 - zone.x0) * Math.abs(zone.z1 - zone.z0)

/** How many people a zone holds at full density (100%). */
export const fullCount = (zone: CrowdZone) => Math.round(zoneArea(zone) * MAX_PER_M2)

/** The rank of person k of a zone that holds `full` people at full density. */
export const personRank = (k: number, full: number) => (k + 0.5) / full

/** How many of a zone's people show at a threshold: those whose rank is below it (worked out with the very comparison the scene makes, so the two always agree). */
export function visibleCount(full: number, limit: number): number {
  let n = Math.min(full, Math.max(0, Math.ceil(full * limit - 0.5)))
  while (n > 0 && !(personRank(n - 1, full) < limit)) n--
  while (n < full && personRank(n, full) < limit) n++
  return n
}

/**
 * The share of every zone's full crowd that is shown: the density, but never so much that more than MAX_PEOPLE
 * people are drawn in all. `totalFull` is the full headcount of the zones that show. The person at position k of a zone
 * has the rank (k + 0.5) / full and shows while the rank is below this.
 */
export function crowdThreshold(crowd: Crowd, totalFull: number): number {
  if (totalFull <= 0) return 0
  return Math.min(crowd.density, MAX_PEOPLE / totalFull)
}

const shownFull = (crowd: Crowd) => crowd.zones.reduce((sum, z) => (z.shown ? sum + fullCount(z) : sum), 0)

/** How many people stand in each zone that shows (the same people the scene draws). */
export function zoneCounts(crowd: Crowd): Map<string, number> {
  const limit = crowdThreshold(crowd, shownFull(crowd))
  const counts = new Map<string, number>()
  for (const zone of crowd.zones) if (zone.shown) counts.set(zone.id, visibleCount(fullCount(zone), limit))
  return counts
}

/** How many people the zones that show ask for at this density, before the overall limit is applied. */
export function requestedPeople(crowd: Crowd): number {
  return crowd.zones.reduce((sum, zone) => (zone.shown ? sum + Math.round(fullCount(zone) * crowd.density) : sum), 0)
}

/** How high a standing person reaches, meters (the crowd absorbs light up to here). */
export const CROWD_HEIGHT = 1.75
/** How strongly a packed crowd (100 %) absorbs light, per meter of crowd the light crosses: 90 % is gone after 2.5 m. */
export const CROWD_ABSORPTION = Math.LN10 / 2.5
/** The most zones the beam shader takes into account. */
export const MAX_ABSORBERS = 8

/** A crowd zone as a box that absorbs light (world meters). */
export interface Absorber {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
  floor: number
  top: number
  /** per meter of the zone that the light crosses */
  strength: number
}

/**
 * The boxes the beams are dimmed by: the zones that show, as tall as a person, absorbing in proportion to how many
 * people stand in them (the density, as limited by the overall maximum). With more zones than the shader takes, the
 * largest ones count.
 */
export function crowdAbsorbers(crowd: Crowd): Absorber[] {
  if (!crowd.shown) return []
  const shown = crowd.zones.filter((z) => z.shown)
  const limit = crowdThreshold(
    crowd,
    shown.reduce((sum, z) => sum + fullCount(z), 0),
  )
  if (limit <= 0) return []
  return shown
    .sort((a, b) => zoneArea(b) - zoneArea(a))
    .slice(0, MAX_ABSORBERS)
    .map((z) => ({
      minX: Math.min(z.x0, z.x1),
      minZ: Math.min(z.z0, z.z1),
      maxX: Math.max(z.x0, z.x1),
      maxZ: Math.max(z.z0, z.z1),
      floor: z.y,
      top: z.y + CROWD_HEIGHT,
      strength: CROWD_ABSORPTION * limit,
    }))
}

export const totalPeople = (crowd: Crowd) => [...zoneCounts(crowd).values()].reduce((a, b) => a + b, 0)
