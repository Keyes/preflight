import { nextTick, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { AMBIENT_DEFAULT, HAZE_DEFAULT } from '../domain/atmosphere'
import { useVenues } from './venues'

export { AMBIENT_DEFAULT, HAZE_DEFAULT }

const STORAGE_KEY = 'preflight.settings'

export const FOV_MIN = 20
export const FOV_MAX = 120
export const FOV_DEFAULT = 60

interface Stored {
  fov?: number
  haze?: number
  ambient?: number
  /** the old on/off choice for native resolution, only read to migrate to renderRest */
  nativeResolution?: boolean
  renderRest?: number
  renderMoving?: number
  adaptive?: boolean
  screenshotScale?: number
  toneMapping?: string
  exposure?: number
  bloom?: number
  showFps?: boolean
  softBeams?: boolean
  shadows?: boolean
  surfaceLight?: number
  hazeWisps?: number
  previewStrobe?: boolean
  animate?: boolean
}

function read(): Stored {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Stored
  } catch {
    return {}
  }
}

export const HAZE_WISPS_DEFAULT = 0.35
/**
 * Render sizes, as fractions of the display's native resolution per axis (1/2 renders a quarter of the pixels).
 * Used for the size while the view is still and for the lowest size while moving.
 */
export const RENDER_FRACTIONS = [1, 3 / 4, 2 / 3, 1 / 2, 1 / 3, 1 / 4] as const
export const RENDER_REST_DEFAULT = 1
export const RENDER_MOVING_DEFAULT = 1 / 4

/** The listed fraction closest to a stored value, or the fallback when it is not a number. */
function nearestFraction(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return RENDER_FRACTIONS.reduce((best, f) => (Math.abs(f - value) < Math.abs(best - value) ? f : best), fallback)
}

export const TONE_MAPPINGS = ['off', 'neutral', 'aces'] as const
export type ToneMapping = (typeof TONE_MAPPINGS)[number]
export const EXPOSURE_MIN = -3
export const EXPOSURE_MAX = 3
export const BLOOM_DEFAULT = 0.35
export const SURFACE_LIGHT_MIN = -2
export const SURFACE_LIGHT_MAX = 4

export const SCREENSHOT_SCALES = [1, 2, 4] as const
export type ScreenshotScale = (typeof SCREENSHOT_SCALES)[number]

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, n))
}

/** Viewer preferences, kept in this browser. Haze and room light belong to the venue (see below). */
export const useSettings = defineStore('settings', () => {
  /** Vertical field of view in degrees. */
  const stored = read()
  const fov = ref(clamp(stored.fov, FOV_MIN, FOV_MAX, FOV_DEFAULT))
  /** Haze density 0..1: how visible light beams are in the air. */
  const haze = ref(clamp(stored.haze, 0, 1, HAZE_DEFAULT))
  /** How much the haze in the beams varies in space and drifts over time, 0..1 (0 is an even haze). */
  const hazeWisps = ref(clamp(stored.hazeWisps, 0, 1, HAZE_WISPS_DEFAULT))
  /** Room fill light 0..1, a stand-in for house lights / bounce until real room lighting exists. */
  const ambient = ref(clamp(stored.ambient, 0, 1, AMBIENT_DEFAULT))

  // Haze and room light are saved with the venue: switching venues loads the venue's values, and moving a slider saves
  // them to it. A venue that has none yet (one made before this existed) adopts the values in use now.
  const venues = useVenues()
  let loadingVenue = false
  watch(
    () => venues.current?.id,
    () => {
      const venue = venues.current
      if (!venue) return
      loadingVenue = true
      if (venue.atmosphere) {
        haze.value = clamp(venue.atmosphere.haze, 0, 1, HAZE_DEFAULT)
        ambient.value = clamp(venue.atmosphere.ambient, 0, 1, AMBIENT_DEFAULT)
      } else {
        venues.setAtmosphere(venue.id, { haze: haze.value, ambient: ambient.value })
      }
      void nextTick(() => (loadingVenue = false))
    },
    { immediate: true },
  )
  watch([haze, ambient], () => {
    const venue = venues.current
    if (!loadingVenue && venue) venues.setAtmosphere(venue.id, { haze: haze.value, ambient: ambient.value })
  })

  /**
   * Render size while the view is still, as a fraction of the display's native resolution (see RENDER_FRACTIONS).
   * Older settings only had a native resolution switch: off meant CSS pixel size, which is 1 over the pixel ratio.
   */
  const renderRest = ref<number>(
    stored.renderRest !== undefined
      ? nearestFraction(stored.renderRest, RENDER_REST_DEFAULT)
      : stored.nativeResolution === false
        ? nearestFraction(1 / Math.max(1, window.devicePixelRatio || 1), RENDER_REST_DEFAULT)
        : RENDER_REST_DEFAULT,
  )
  /** The lowest render size while moving, when adaptive quality is on (same fractions; never above the size at rest). */
  const renderMoving = ref<number>(nearestFraction(stored.renderMoving, RENDER_MOVING_DEFAULT))
  /** Drop render resolution while the view or rig is changing if the frame rate needs it. */
  const adaptive = ref(stored.adaptive ?? true)
  /** Screenshot size as a multiple of the current view, capped by GPU limits. */
  const screenshotScale = ref<ScreenshotScale>(
    SCREENSHOT_SCALES.includes(stored.screenshotScale as ScreenshotScale) ? (stored.screenshotScale as ScreenshotScale) : 2,
  )

  /**
   * How scene brightness is compressed to the display. "neutral" (Khronos PBR Neutral) keeps the hue of
   * saturated colors, which suits stage lighting; "aces" is the usual filmic curve but shifts saturated
   * colors; "off" clips.
   */
  const toneMapping = ref<ToneMapping>(TONE_MAPPINGS.includes(stored.toneMapping as ToneMapping) ? (stored.toneMapping as ToneMapping) : 'neutral')
  /** Exposure in stops (EV): 0 is neutral, +1 doubles the brightness. */
  const exposure = ref(clamp(stored.exposure, EXPOSURE_MIN, EXPOSURE_MAX, 0))
  /** Glow around bright lenses, pools and beam cores, 0..1 (0 is off). */
  const bloom = ref(clamp(stored.bloom, 0, 1, BLOOM_DEFAULT))
  const showFps = ref(stored.showFps ?? true)
  /** Beams fade out smoothly before the surfaces they meet instead of ending in a hard cut. */
  const softBeams = ref(stored.softBeams ?? true)
  /** Lights cast shadows (a limited number of them, see MAX_SHADOW_LIGHTS in domain/limits.ts). */
  const shadows = ref(stored.shadows ?? true)
  /** How strongly lights illuminate surfaces, in stops (EV), independent of how visible the beams are in haze. */
  const surfaceLight = ref(clamp(stored.surfaceLight, SURFACE_LIGHT_MIN, SURFACE_LIGHT_MAX, 0))
  /** Strobing lights flash. Off by default: flashing light can trigger seizures in people who are photosensitive. */
  const previewStrobe = ref(stored.previewStrobe ?? false)
  /** Everything that moves with time runs: haze drift, gobo spin, strobe flashes and the crowd. Off freezes it all. */
  const animate = ref(stored.animate ?? true)

  // The lowest size while moving can never be above the size at rest.
  watch(renderRest, (rest) => {
    if (renderMoving.value > rest + 1e-9) renderMoving.value = rest
  })

  watch(
    () => ({
      fov: fov.value,
      haze: haze.value,
      ambient: ambient.value,
      renderRest: renderRest.value,
      renderMoving: renderMoving.value,
      adaptive: adaptive.value,
      screenshotScale: screenshotScale.value,
      toneMapping: toneMapping.value,
      exposure: exposure.value,
      bloom: bloom.value,
      showFps: showFps.value,
      softBeams: softBeams.value,
      shadows: shadows.value,
      surfaceLight: surfaceLight.value,
      hazeWisps: hazeWisps.value,
      previewStrobe: previewStrobe.value,
      animate: animate.value,
    }),
    (all) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
      } catch {
        /* storage unavailable: settings just won't persist */
      }
    },
  )

  function resetFov() {
    fov.value = FOV_DEFAULT
  }

  return {
    fov,
    haze,
    ambient,
    renderRest,
    renderMoving,
    adaptive,
    screenshotScale,
    toneMapping,
    exposure,
    bloom,
    showFps,
    softBeams,
    shadows,
    surfaceLight,
    hazeWisps,
    previewStrobe,
    animate,
    resetFov,
  }
})
