<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Color3,
  Color4,
  DefaultRenderingPipeline,
  DepthRenderer,
  Engine,
  GizmoManager,
  HemisphericLight,
  ImageProcessingConfiguration,
  PointerEventTypes,
  Scene,
  Texture,
  UniversalCamera,
  Vector3,
} from '@babylonjs/core'
import { profilesVersion } from '../fixtures/profiles'
import { CAMERA_KEYS } from '../input/keymap'
import { solveAim } from '../scene/aim'
import { AimCursor } from '../scene/AimCursor'
import { Crowd as CrowdScene } from '../scene/Crowd'
import { FixtureRig, MAX_REGULAR_LIGHTS } from '../scene/FixtureRig'
import { QualityGovernor } from '../scene/quality'
import { SelectionGizmo } from '../scene/SelectionGizmo'
import { RiderMarkers } from '../scene/RiderMarkers'
import { RiderPlanView } from '../scene/RiderPlanView'
import { mountOnSurface, VenueModel } from '../scene/VenueModel'
import { insidePose, overviewPose, ViewerCamera, type Bounds } from '../scene/ViewerCamera'
import { captureCanvas, planShot, SHOT_ASPECT } from '../scene/screenshot'
import { ZoneOutlines } from '../scene/ZoneOutlines'
import { useCameraBridge } from '../stores/camera'
import { crowdAbsorbers } from '../crowdModel'
import { useCrowd } from '../stores/crowd'
import { useInteraction } from '../stores/interaction'
import { useRider } from '../stores/rider'
import { useRig } from '../stores/rig'
import { useVenueBox } from '../stores/venueBox'
import { useSettings } from '../stores/settings'
import { useStats } from '../stores/stats'
import { useVenues } from '../stores/venues'

const props = defineProps<{ modelUrl?: string }>()
const emit = defineEmits<{ (e: 'loading', value: boolean): void; (e: 'error', message: string): void }>()

/** Without clustering, venue surfaces accept this many lights at once (Babylon's default of 4 is far too few for a rig). */
const MAX_LIGHTS = 32
/** With clustered lighting a surface sees the ambient light, the clustered container and the few lights that cast shadows or project a gobo. */
const CLUSTERED_MAX_LIGHTS = 4 + MAX_REGULAR_LIGHTS

const bridge = useCameraBridge()
const settings = useSettings()
const stats = useStats()
const rig = useRig()
const venueBox = useVenueBox()
const crowdStore = useCrowd()
const riderStore = useRider()
const venues = useVenues()
const interaction = useInteraction()
const canvas = ref<HTMLCanvasElement>()
let engine: Engine | undefined
let scene: Scene | undefined
let walkCamera: ViewerCamera | undefined
/** walkCamera's Babylon camera, which the post-processing, the depth pass and picking use */
let camera: UniversalCamera | undefined
let ambient: HemisphericLight | undefined
let model: VenueModel | undefined
let planView: RiderPlanView | undefined
let riderMarkers: RiderMarkers | undefined
let fixtureRig: FixtureRig | undefined
let crowdScene: CrowdScene | undefined
let aimCursor: AimCursor | undefined
let zoneOutlines: ZoneOutlines | undefined
let selection: SelectionGizmo | undefined
let quality: QualityGovernor | undefined
let pipeline: DefaultRenderingPipeline | undefined
let depthRenderer: DepthRenderer | undefined
let statsTimer: ReturnType<typeof setInterval> | undefined

/** The floor under the middle of the venue: met going down from mid-height, else the bottom of the model. */
function floorUnderMiddle(bounds: Bounds): number {
  const c = bounds.min.add(bounds.max).scale(0.5)
  return model?.surfaceBelow(c.x, c.y, c.z, bounds.max.y - bounds.min.y) ?? bounds.min.y
}

function clearVenue() {
  fixtureRig?.setVenueMeshes([])
  model?.clear()
  fixtureRig?.setVenueBounds(null)
  venueBox.box = null
  venueBox.tags = []
  venueBox.tagsFromNodes = false
  walkCamera?.leaveVenue()
}

/** Shows the model's parts that are on and hides the ones that are switched off for this venue. */
function applyHiddenParts() {
  model?.setHiddenParts(new Set(venues.current?.hiddenTags ?? []))
  fixtureRig?.markShadowsDirty()
}

async function showModel(url?: string) {
  if (!model || !walkCamera) return
  walkCamera.stopJump()
  clearVenue()
  if (!url) return

  emit('loading', true)
  let current = true
  try {
    current = await model.load(url, fixtureRig?.clustered ? CLUSTERED_MAX_LIGHTS : MAX_LIGHTS)
    const bounds = model.bounds
    if (!current || !bounds) return // a newer selection superseded this load
    fixtureRig?.setVenueMeshes([...model.meshes])
    fixtureRig?.setVenueBounds(bounds)
    venueBox.tags = model.partNames
    venueBox.tagsFromNodes = !model.partsFromTags
    applyHiddenParts()
    venueBox.box = { min: bounds.min.asArray(), max: bounds.max.asArray() }
    // where the camera starts: where it was left in this venue, else saved view 1, else the overview
    const first = venues.current?.views?.[0]
    if (venues.currentId) walkCamera.showVenue(venues.currentId, first ? { position: first.position, rotation: first.rotation } : overviewPose(bounds))
  } catch (e) {
    emit('error', (e as Error).message)
  } finally {
    if (current) emit('loading', false)
  }
}

// --- lifecycle -------------------------------------------------------------

function onKey(event: KeyboardEvent) {
  walkCamera?.setFast(event.shiftKey)
  selection?.setSnapping(event.shiftKey)
}

function onBlur() {
  walkCamera?.setFast(false)
  selection?.setSnapping(false) // Shift released while another window had focus
}

onMounted(() => {
  engine = new Engine(canvas.value!, true, { preserveDrawingBuffer: true })
  scene = new Scene(engine)
  scene.clearColor = new Color4(0.02, 0.02, 0.03, 1)

  walkCamera = new ViewerCamera(scene, canvas.value!, CAMERA_KEYS, settings.fov)
  camera = walkCamera.camera
  model = new VenueModel(scene, camera)
  planView = new RiderPlanView(walkCamera, model)
  riderMarkers = new RiderMarkers(scene, (delta) => riderStore.nudge(delta))
  canvas.value!.addEventListener('pointerleave', () => aimCursor?.hide())

  quality = new QualityGovernor(engine, scene, camera)
  quality.setRestFraction(settings.renderRest)
  quality.setEnabled(settings.adaptive)
  quality.setMovingFloor(settings.renderMoving)

  // Post-processing: scene colors are rendered in high dynamic range, then bloom and tone mapping are applied.
  pipeline = new DefaultRenderingPipeline('look', true, scene, [camera])
  pipeline.samples = 4 // anti-aliasing (the canvas's own is bypassed while rendering through the pipeline)
  pipeline.fxaaEnabled = false
  pipeline.bloomKernel = 48
  pipeline.bloomScale = 0.5
  pipeline.bloomThreshold = 1.0
  applyLook()

  // Frame rate and render size for the on-screen counter, refreshed once a second.
  statsTimer = setInterval(() => {
    if (!engine) return
    stats.fps = Math.round(engine.getFps())
    stats.renderScale = quality?.renderScale ?? 1
    stats.width = engine.getRenderWidth()
    stats.height = engine.getRenderHeight()
  }, 1000)

  ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene)
  ambient.intensity = settings.ambient
  // Temporary fill until fixtures light the room: also lights surfaces that face down (ceiling).
  ambient.groundColor = new Color3(0.45, 0.45, 0.5)

  if (import.meta.env.DEV) (window as unknown as { __scene: Scene }).__scene = scene

  // ?clustered=0 switches clustered lighting off, for comparing against the plain path.
  fixtureRig = new FixtureRig(scene, new URLSearchParams(location.search).get('clustered') !== '0')
  fixtureRig.setShadows(settings.shadows)
  fixtureRig.onShadowedChange = (ids) => (stats.shadowed = ids)
  fixtureRig.onProjectedChange = (ids) => (stats.projected = ids)
  crowdScene = new CrowdScene(scene, fixtureRig.clustered ? CLUSTERED_MAX_LIGHTS : MAX_LIGHTS)
  crowdScene.sync(crowdStore.crowd)
  fixtureRig.setAbsorbers(crowdAbsorbers(crowdStore.crowd))
  crowdScene.onPlaced = () => fixtureRig?.scheduleShadowRefresh()
  fixtureRig.setExtraCasters(crowdScene.casters)
  crowdScene.setAnimate(settings.animate)
  fixtureRig.setAnimate(settings.animate)
  aimCursor = new AimCursor(scene)
  zoneOutlines = new ZoneOutlines(scene)
  updateZoneOutline()

  // Camera-space depth of solid surfaces, which the beam shader fades against. Its texture does not follow the
  // canvas size on its own, so it is resized along with it. Nearest sampling avoids halos at depth edges.
  depthRenderer = scene.enableDepthRenderer(camera, false, false, Texture.NEAREST_SAMPLINGMODE, true)
  const depthMap = depthRenderer.getDepthMap()
  const syncDepthSize = () => {
    if (!engine) return
    const width = engine.getRenderWidth()
    const height = engine.getRenderHeight()
    depthMap.resize({ width, height })
    fixtureRig?.setScreenSize(width, height)
  }
  engine.onResizeObservable.add(syncDepthSize)
  syncDepthSize()
  fixtureRig.setDepth(depthMap)
  applySoftBeams()
  selection = new SelectionGizmo(scene, {
    rootOf: (id) => fixtureRig?.rootOf(id),
    onMoved: (lights) => {
      for (const { id, ...change } of lights) rig.update(id, change)
    },
    onReadout: (readout) => (rig.rotationReadout = readout),
    onDrag: () => quality?.touch(),
  })
  selection.setMode(rig.gizmoMode)
  if (import.meta.env.DEV) {
    ;(window as unknown as { __rig: FixtureRig }).__rig = fixtureRig
    ;(window as unknown as { __quality: QualityGovernor }).__quality = quality
    ;(window as unknown as { __gizmo?: GizmoManager }).__gizmo = selection.manager
    ;(window as unknown as { __depth?: DepthRenderer }).__depth = depthRenderer
    ;(window as unknown as { __screenshot: typeof screenshot }).__screenshot = screenshot
    ;(window as unknown as { __crowd?: CrowdScene }).__crowd = crowdScene
  }

  scene.onPointerObservable.add((info) => {
    const mode = interaction.mode
    if (info.type === PointerEventTypes.POINTERMOVE) {
      if (showsAimCursor()) updateAimCursor()
      if (mode?.kind === 'zone' && mode.first) updateZonePreview(mode.first)
    }
    if (info.type !== PointerEventTypes.POINTERTAP || info.event.button !== 0 || !scene) return
    // A click mode takes the click; otherwise it selects (a rider marker first, while the rider wizard shows them).
    switch (mode?.kind) {
      case 'place':
        return placeFixture()
      case 'aim':
        return aimAtPointer()
      case 'zone':
        return zoneClick(mode.first)
      case 'facing':
        return facingClick(mode.zoneId)
      case 'riderPoint':
        return riderPick()
    }
    const e = info.event as PointerEvent
    if (riderMarkerClick(e.ctrlKey || e.metaKey || e.shiftKey)) return
    const id = fixtureRig?.fixtureIdOf(info.pickInfo?.pickedMesh)
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      if (id) rig.toggle(id) // adding to the selection never clears it by clicking empty space
    } else {
      rig.select(id ?? null)
    }
  })

  scene.onBeforeRenderObservable.add(() => {
    fixtureRig?.update()
    crowdScene?.update(performance.now() / 1000)
  })
  engine.runRenderLoop(() => scene?.render())
  window.addEventListener('resize', onResize)
  resizeObserver = new ResizeObserver(onResize) // the inspector dock folding or unfolding changes the canvas size
  resizeObserver.observe(canvas.value!)
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKey)
  window.addEventListener('blur', onBlur)

  // the height of the first surface above a spot, from 0.3 m over the floor: the ceiling's underside, or whatever hangs there
  riderStore.ceilingAt = (x, z) => model?.surfaceAbove(x, 0.3, z, 40) ?? null
  bridge.api = {
    getState: () => walkCamera!.state(),
    goTo: (state) => walkCamera?.goTo(state),
    overview: () => {
      if (model?.bounds) walkCamera?.goTo(overviewPose(model.bounds))
    },
    inside: () => {
      if (model?.bounds) walkCamera?.goTo(insidePose(model.bounds, floorUnderMiddle(model.bounds)))
    },
    planShot: (scale) => planShot(engine!, canvas.value!, scale),
    screenshot,
  }
  void showModel(props.modelUrl)
  fixtureRig.setSurfaceGain(2 ** settings.surfaceLight)
  fixtureRig.setHazeWisps(settings.hazeWisps)
  fixtureRig.setStrobePreview(settings.previewStrobe)
  fixtureRig.sync(rig.fixtures, settings.haze)
})

/** A click while a crowd zone is being drawn: the first corner on a surface, then the opposite one at the same height. */
function zoneClick(first: [number, number, number] | null) {
  if (!first) {
    const point = model?.pointUnderPointer()
    if (point) crowdStore.setFirstCorner(point.asArray())
  } else {
    const point = model?.pointerAtHeight(first[1])
    if (point) crowdStore.finishZone([point.x, point.z])
  }
}

/** A click on the point the people in a zone should face. */
function facingClick(zoneId: string) {
  const point = model?.pointUnderPointer()
  if (point) crowdStore.setFacing(zoneId, [point.x, point.z])
}

// --- tech rider import: a point asked for, the ceiling, and a preview of where the lights would go ----------------

/** A click while the rider wizard waits for a point in the venue. */
function riderPick() {
  const point = model?.pointUnderPointer()
  if (point) riderStore.deliverWorld(point.asArray())
}

/** The rider wizard's panel covers the right of the view: how many render pixels of it, for the plan view to fit the venue beside. */
function viewport() {
  const width = engine?.getRenderWidth() ?? 1
  const panel = document.querySelector('aside[aria-label="Import tech rider"]')?.getBoundingClientRect().width ?? 0
  const cssScale = width / Math.max(1, canvas.value?.clientWidth ?? width)
  return { width, height: engine?.getRenderHeight() ?? 1, coveredPx: panel * cssScale }
}

// While the wizard places the plan, the view looks down on the venue, with the lights and the crowd out of the way and
// the room light raised so the floor shows, whatever it is set to.
watch(
  () => riderStore.calibrating,
  (on) => {
    if (!planView) return
    if (on && !planView.active) {
      if (!planView.enter(viewport(), riderStore.hideClutter)) return
      fixtureRig?.setHidden(true)
      crowdScene?.setHidden(true)
      if (ambient) ambient.intensity = Math.max(ambient.intensity, 0.6)
    } else if (!on && planView.active) {
      planView.leave()
      fixtureRig?.setHidden(false)
      crowdScene?.setHidden(false)
      if (ambient) ambient.intensity = settings.ambient
    }
  },
)
watch(
  () => riderStore.hideClutter,
  (hidden) => planView?.setClutterHidden(hidden),
)
watch(
  () => riderStore.viewTurns,
  () => planView?.turn(),
)

/** The lights the wizard would add, as markers in the venue, from the step it is on. */
function updateRiderPreview() {
  const showing = riderStore.open && riderStore.step !== 'load'
  const drafts = showing ? (riderStore.result?.drafts ?? []).filter((d) => d.placement && !riderStore.excluded.has(d.key)) : []
  riderMarkers?.show({
    lights: drafts.map((d) => ({ key: d.key, position: riderStore.positionOf(d), onTruss: d.placement!.height === 'truss' })),
    selected: riderStore.selectedKeys,
    references: riderStore.open ? riderStore.worldPoints : [],
    editable: riderStore.open && riderStore.step === 'review',
  })
}
watch(
  () => [riderStore.open, riderStore.step, riderStore.result, riderStore.worldPoints, riderStore.excluded, riderStore.adjust, riderStore.selectedKeys],
  updateRiderPreview,
  { deep: true },
)

/** A click in the review: a light's marker selects it (Ctrl, Shift or Cmd adds), a click on nothing clears the selection. Returns true when it was for the wizard. */
function riderMarkerClick(add: boolean): boolean {
  if (!riderMarkers || !riderStore.open || riderStore.step !== 'review' || riderMarkers.dragging) return false
  const key = riderMarkers.keyUnderPointer()
  if (key) {
    if (add) riderStore.toggleSelected(key)
    else riderStore.select([key])
    return true
  }
  if (!add && riderStore.selectedKeys.length) riderStore.select([])
  return false
}

// --- crowd zone rectangles: the one being drawn, and the outline of the selected zone -----------------

function updateZonePreview(first: [number, number, number]) {
  const point = model?.pointerAtHeight(first[1])
  if (point) zoneOutlines?.showPreview(first, [point.x, point.z])
}

function updateZoneOutline() {
  zoneOutlines?.showOutline(crowdStore.zones.find((z) => z.id === crowdStore.selectedId) ?? null)
}

/** Aims the selected lights at the venue surface under the pointer. */
function aimAtPointer() {
  const point = model?.pointUnderPointer()
  if (point) rig.aimAt(point.asArray())
}

/** Points the lights that were aimed at the aim point (again), with the current spread and fan. */
function applyAim() {
  if (!fixtureRig || !rig.aim.anchor) return
  const lights = rig.aim.ids.map((id) => rig.fixtures.find((f) => f.id === id)).filter((f): f is NonNullable<typeof f> => !!f)
  const result = solveAim(fixtureRig, lights, new Vector3(...rig.aim.anchor), { spread: rig.aim.spread, fan: rig.aim.fan })
  rig.applyAim(result.patches, result.unreachable)
}

/** The crosshair on the surface shows in every click mode but placing, which has only the crosshair pointer. */
function showsAimCursor() {
  return !!interaction.mode && interaction.mode.kind !== 'place'
}

function updateAimCursor() {
  if (camera && model) aimCursor?.showAt(model.pickUnderPointer(), camera.position)
}

/** Puts the fixture chosen in the picker on the venue surface under the pointer, hanging from ceilings and standing on floors. */
function placeFixture() {
  const hit = model?.pickUnderPointer()
  if (hit?.pickedPoint) rig.placeAt(mountOnSurface(hit.pickedPoint, hit.getNormal(true, true) ?? Vector3.Up(), hit.ray?.direction))
}

/** Whether light fades out softly before a surface (the depth pass itself always runs: beams are occluded with it). */
function applySoftBeams() {
  quality?.touch()
  fixtureRig?.setSoftBeams(settings.softBeams)
}

/** Tone mapping, exposure, bloom and the haze-driven fog, from the settings. */
function applyLook() {
  if (!scene || !pipeline) return
  quality?.touch()

  const processing = scene.imageProcessingConfiguration
  processing.toneMappingEnabled = settings.toneMapping !== 'off'
  processing.toneMappingType =
    settings.toneMapping === 'aces' ? ImageProcessingConfiguration.TONEMAPPING_ACES : ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL
  processing.exposure = 2 ** settings.exposure

  pipeline.bloomEnabled = settings.bloom > 0.001
  pipeline.bloomWeight = settings.bloom * 0.7

  // Haze also thins out the view of distant surfaces. The fog color stays dark and rises a little with the
  // room light, so house lights up means a lighter haze, as in a real room.
  scene.fogMode = Scene.FOGMODE_EXP2
  scene.fogDensity = settings.haze * 0.04
  const level = 0.02 + settings.ambient * 0.1
  scene.fogColor.set(level, level, level * 1.2)
}

/** Renders the current view offscreen at `scale` times its size, without selection outline or gizmo. */
async function screenshot(scale: number) {
  if (!engine || !scene || !camera || !fixtureRig || !pipeline) throw new Error('viewer not ready')
  const size = planShot(engine, canvas.value!, scale)
  const selected = [...rig.selectedIds]
  fixtureRig.setSelected([])
  fixtureRig.setStrobeHold(true) // a picture shows strobing lights lit, not caught between flashes
  crowdScene?.setHold(true) // and the crowd standing still
  selection?.hide()
  // Very large frames need less multisampling to fit in GPU memory; fall back to FXAA for the biggest ones.
  quality?.pause()
  // The picture is the middle 16:9 part of the view. A window wider than that only loses its sides, but a narrower
  // one must keep its width and lose top and bottom: the vertical field of view shrinks to match.
  const viewAspect = canvas.value!.clientWidth / Math.max(1, canvas.value!.clientHeight)
  const previousFov = camera.fov
  if (viewAspect < SHOT_ASPECT) camera.fov = 2 * Math.atan((Math.tan(previousFov / 2) * viewAspect) / SHOT_ASPECT)
  const previous = { samples: pipeline.samples, fxaa: pipeline.fxaaEnabled }
  const pixels = size.width * size.height
  pipeline.samples = pixels > 9_000_000 ? 1 : pixels > 5_000_000 ? 2 : 4
  pipeline.fxaaEnabled = pipeline.samples === 1
  try {
    const blob = await captureCanvas(engine, canvas.value!, size)
    return { blob, ...size }
  } finally {
    camera.fov = previousFov
    pipeline.samples = previous.samples
    pipeline.fxaaEnabled = previous.fxaa
    quality?.resume()
    fixtureRig.setStrobeHold(false)
    crowdScene?.setHold(false)
    fixtureRig.setSelected(selected)
    selection?.attach(selected)
  }
}

watch(
  () => props.modelUrl,
  (url) => showModel(url),
)
watch(() => venues.current?.hiddenTags, applyHiddenParts, { deep: true })
watch(
  [() => rig.fixtures, () => settings.haze],
  () => {
    quality?.touch()
    fixtureRig?.sync(rig.fixtures, settings.haze)
  },
  { deep: true, flush: 'post' },
)
watch(
  () => rig.gizmoMode,
  (mode) => selection?.setMode(mode),
)
// After an undo or redo the lights may have moved while the selection stayed the same: put the gizmo back on them.
watch(
  () => rig.historyVersion,
  () => selection?.attach(rig.selectedIds),
  { flush: 'post' },
)
// Fixtures placed from the catalog look different once the catalog has arrived.
watch(profilesVersion, () => fixtureRig?.sync(rig.fixtures, settings.haze))
watch(() => settings.softBeams, applySoftBeams)
watch(
  () => settings.hazeWisps,
  (amount) => fixtureRig?.setHazeWisps(amount),
)
watch(
  () => settings.previewStrobe,
  (on) => fixtureRig?.setStrobePreview(on),
)
watch(
  () => settings.animate,
  (on) => {
    fixtureRig?.setAnimate(on)
    crowdScene?.setAnimate(on)
  },
)
watch(
  () => settings.surfaceLight,
  (ev) => {
    fixtureRig?.setSurfaceGain(2 ** ev)
    fixtureRig?.sync(rig.fixtures, settings.haze)
  },
)
watch(
  () => settings.shadows,
  (on) => {
    fixtureRig?.setShadows(on)
    fixtureRig?.sync(rig.fixtures, settings.haze)
  },
)
watch(() => [settings.toneMapping, settings.exposure, settings.bloom, settings.haze, settings.ambient], applyLook)
watch(
  () => settings.renderRest,
  (fraction) => quality?.setRestFraction(fraction),
)
watch(
  () => settings.adaptive,
  (enabled) => quality?.setEnabled(enabled),
)
watch(
  () => settings.renderMoving,
  (fraction) => quality?.setMovingFloor(fraction),
)
watch(
  () => rig.selectedIds.join(','),
  () => {
    fixtureRig?.setSelected(rig.selectedIds)
    selection?.attach(rig.selectedIds)
  },
  { flush: 'post' },
)
watch(
  () => interaction.mode !== null,
  (crosshair) => {
    if (canvas.value) canvas.value.style.cursor = crosshair ? 'crosshair' : ''
  },
)
watch(() => rig.aim.tick, applyAim)
watch(
  () => crowdStore.crowd,
  (crowd) => {
    crowdScene?.sync(crowd)
    fixtureRig?.setAbsorbers(crowdAbsorbers(crowd)) // beams are dimmed by the crowd in their way
  },
  { deep: true },
)
watch(() => [crowdStore.selectedId, crowdStore.zones], updateZoneOutline, { deep: true })
watch(
  () => (interaction.mode?.kind === 'zone' ? interaction.mode.first : null),
  (first) => {
    if (!first) zoneOutlines?.hidePreview()
  },
)
watch(showsAimCursor, (on) => (on ? updateAimCursor() : aimCursor?.hide()))
watch(
  () => (rig.aimActive ? rig.aim.anchor : null),
  (point) => aimCursor?.setAimPoint(point),
)
watch(
  () => settings.ambient,
  (value) => {
    quality?.touch()
    if (ambient) ambient.intensity = value
  },
)
watch(
  () => settings.fov,
  (degrees) => walkCamera?.setFov(degrees),
)

let resizeObserver: ResizeObserver | null = null

function onResize() {
  quality?.refresh() // the pixel ratio may have changed (window moved to another screen)
  engine?.resize()
}

function focusCanvas() {
  canvas.value?.focus()
}

onBeforeUnmount(() => {
  riderMarkers?.dispose()
  planView?.leave()
  riderStore.ceilingAt = null
  bridge.api = null
  window.removeEventListener('resize', onResize)
  resizeObserver?.disconnect()
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('keyup', onKey)
  model?.dispose()
  window.removeEventListener('blur', onBlur)
  clearInterval(statsTimer)
  pipeline?.dispose()
  quality?.dispose()
  selection?.dispose()
  walkCamera?.dispose()
  aimCursor?.dispose()
  zoneOutlines?.dispose()
  crowdScene?.dispose()
  fixtureRig?.dispose()
  engine?.dispose()
})
</script>

<template>
  <!-- tabindex lets the canvas take keyboard focus so WASD reaches the camera -->
  <canvas ref="canvas" class="viewport" tabindex="0" @pointerdown="focusCanvas" />
</template>

<style scoped>
.viewport {
  width: 100%;
  height: 100%;
  display: block;
  outline: none;
}
</style>
