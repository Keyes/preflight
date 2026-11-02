import { ref } from 'vue'
import type { CatalogFixture, CatalogMode } from '../api'
import { lensStrip, modelFor, type ModelSpec } from '../scene/fixtureModel'

/**
 * Fixture profiles describe what a light can do and how its normalized (0..1, DMX-like)
 * attribute values map to physical quantities. They come from the fixture catalog (imported from the
 * Open Fixture Library, see server/src/tools/importOfl.ts), plus one generic moving head that is always available.
 */
export interface FixtureProfile {
  id: string
  name: string
  manufacturer: string
  categories: string[]
  /** total pan travel in degrees (0 when the fixture cannot pan); value 0.5 is the home position */
  panRange: number
  /** total tilt travel in degrees (0 when it cannot tilt); value 0.5 is the home position (beam straight out of the base axis) */
  tiltRange: number
  /** beam angle at zoom 0 and zoom 1, degrees (full cone) */
  beamAngle: [number, number]
  /** luminous flux in lumens at full dimmer */
  lumens: number
  /** which controls the inspector offers */
  controls: { pan: boolean; tilt: boolean; zoom: boolean; focus: boolean; color: boolean; strobe: boolean; gobo: boolean }
  defaults: Record<string, number>
  /** what the body looks like: its kind and real size */
  model: ModelSpec
  /** the beam is a flat sheet (a strip-shaped lens: bars and panels), lit with several spot lights and without shadows */
  sheet: boolean
  /**
   * How soft the beam edge is, as a fraction of the beam radius (the fade spans this much either side of the geometric
   * edge), or -1 when the focus sets it. Fixtures without a focus channel have no optics to sharpen the edge:
   * the wider the beam, the softer.
   */
  edge: number
  /** false for fixtures that do not light anything (smoke machines, hazers, fans, dimmer packs, stands) */
  emitsLight: boolean
  powerW?: number
  weightKg?: number
  sizeMm?: [number, number, number]
  modes: CatalogMode[]
}

const BASE_DEFAULTS = { pan: 0.5, tilt: 0.5, dimmer: 1, zoom: 0.4, focus: 0.5, red: 1, green: 1, blue: 1, strobe: 0, gobo: 0, goboAngle: 0, goboSpin: 0.5 }

export const GENERIC_ID = 'generic-moving-head'

export const GENERIC_MOVING_HEAD: FixtureProfile = {
  id: GENERIC_ID,
  name: 'Moving head (spot)',
  manufacturer: 'Generic',
  categories: ['Moving Head'],
  panRange: 540,
  tiltRange: 270,
  beamAngle: [8, 40],
  lumens: 8000,
  controls: { pan: true, tilt: true, zoom: true, focus: true, color: true, strobe: true, gobo: true },
  defaults: BASE_DEFAULTS,
  model: modelFor(['Moving Head'], true),
  sheet: false,
  edge: -1,
  emitsLight: true,
  modes: [],
}

/** The generic fixture as a catalog entry, so the picker can list it like any other. */
export const GENERIC_CATALOG_ENTRY: CatalogFixture = {
  id: GENERIC_ID,
  manufacturer: 'Generic',
  manufacturerKey: 'generic',
  name: GENERIC_MOVING_HEAD.name,
  categories: ['Moving Head'],
  moving: true,
  beamAngle: GENERIC_MOVING_HEAD.beamAngle,
  panDegrees: GENERIC_MOVING_HEAD.panRange,
  tiltDegrees: GENERIC_MOVING_HEAD.tiltRange,
  lumens: GENERIC_MOVING_HEAD.lumens,
  features: ['pan', 'tilt', 'dimmer', 'red', 'green', 'blue', 'zoom', 'focus', 'strobe', 'gobo'],
  modes: [],
}

export const COLOR_FEATURES = new Set([
  'red', 'green', 'blue', 'white', 'amber', 'uv', 'cyan', 'magenta', 'yellow', 'lime', 'indigo',
  'color', 'color-wheel', 'color-temperature',
])

/** Categories of fixtures that do not light anything. */
const NON_EMITTING = new Set(['Smoke', 'Hazer', 'Fan', 'Stand', 'Dimmer'])

export function profileFromCatalog(item: CatalogFixture): FixtureProfile {
  const model = modelFor(item.categories, item.moving, item.sizeMm)
  const has = (feature: string) => item.features.includes(feature)
  const hasZoomChannel = has('zoom')
  const raw = item.beamAngle ?? (hasZoomChannel ? GENERIC_MOVING_HEAD.beamAngle : ([20, 20] as [number, number]))
  // A full cone must stay well under 180 degrees to be drawable as a spot.
  const beamAngle: [number, number] = [Math.min(raw[0], 170), Math.min(raw[1], 170)]
  return {
    id: item.id,
    name: item.name,
    manufacturer: item.manufacturer,
    categories: item.categories,
    panRange: item.panDegrees ?? (has('pan') ? 540 : 0),
    tiltRange: item.tiltDegrees ?? (has('tilt') ? 270 : 0),
    beamAngle,
    lumens: item.lumens ?? GENERIC_MOVING_HEAD.lumens,
    controls: {
      pan: has('pan') || item.panDegrees !== undefined,
      tilt: has('tilt') || item.tiltDegrees !== undefined,
      zoom: beamAngle[0] !== beamAngle[1],
      focus: has('focus'),
      color: item.features.some((f) => COLOR_FEATURES.has(f)),
      strobe: has('strobe'),
      // a pattern is projected from a round lens: bars and panels (strip-shaped lenses) have none
      gobo: has('gobo') && (lensStrip(model)?.halfLength ?? 0) <= 0.02,
    },
    defaults: BASE_DEFAULTS,
    model,
    sheet: (lensStrip(model)?.halfLength ?? 0) > 0.02,
    edge: has('focus') ? -1 : Math.min(0.45, Math.max(0.1, 0.1 + (0.35 * Math.max(beamAngle[0], beamAngle[1])) / 160)),
    emitsLight: !item.categories.every((c) => NON_EMITTING.has(c)),
    ...(item.powerW !== undefined ? { powerW: item.powerW } : {}),
    ...(item.weightKg !== undefined ? { weightKg: item.weightKg } : {}),
    ...(item.sizeMm ? { sizeMm: item.sizeMm } : {}),
    modes: item.modes,
  }
}

const catalogProfiles = new Map<string, FixtureProfile>()
/** Bumped when the catalog is loaded, so anything that looked up a profile before can look again. */
export const profilesVersion = ref(0)

export function registerCatalog(items: readonly CatalogFixture[]) {
  catalogProfiles.clear()
  for (const item of items) catalogProfiles.set(item.id, profileFromCatalog(item))
  profilesVersion.value++
}

/** The profile for a fixture; fixtures whose profile is not in the catalog (yet) fall back to the generic moving head. */
export function profileFor(id: string): FixtureProfile {
  void profilesVersion.value // makes computed values that call this update when the catalog arrives
  return catalogProfiles.get(id) ?? GENERIC_MOVING_HEAD
}

/** Pan or tilt in degrees from a normalized value, centered on 0 at the home position. */
export const travelDegrees = (value: number, range: number) => (value - 0.5) * range

export const beamAngleDegrees = (profile: FixtureProfile, zoom: number) =>
  profile.beamAngle[0] + (profile.beamAngle[1] - profile.beamAngle[0]) * zoom

/** Flashes per second at the slowest and the fastest strobe setting. */
export const STROBE_MIN_HZ = 1
export const STROBE_MAX_HZ = 20

/** Flash rate in hertz from a normalized strobe value (0 is no strobe, then spread evenly in log scale up to the fastest). */
export const strobeHz = (strobe: number) => (strobe < 0.01 ? 0 : STROBE_MIN_HZ * (STROBE_MAX_HZ / STROBE_MIN_HZ) ** strobe)

/** How fast a gobo turns at full spin, in turns per second. */
export const GOBO_MAX_TURNS = 1

/** Gobo spin in turns per second from a normalized value: 0.5 is stopped, above it turns one way, below it the other. */
export const goboSpinTurns = (spin: number) => (Math.abs(spin - 0.5) < 0.01 ? 0 : (spin - 0.5) * 2 * GOBO_MAX_TURNS)

/** The nearest and farthest distance (meters from the lens) the focus can be set to. */
export const FOCUS_NEAR = 2
export const FOCUS_FAR = 40

/** The distance at which the beam edge is sharpest, from a normalized focus value (spread evenly in log scale, as a lens would). */
export const focusDistance = (focus: number) => FOCUS_NEAR * (FOCUS_FAR / FOCUS_NEAR) ** focus

/** Luminous intensity in candela for the current beam angle: the same lumens in a narrower cone is brighter. */
export function candela(profile: FixtureProfile, beamAngleDeg: number): number {
  const solidAngle = 2 * Math.PI * (1 - Math.cos((beamAngleDeg * Math.PI) / 360))
  return profile.lumens / solidAngle
}
