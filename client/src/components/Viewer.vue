<script setup lang="ts">
// The 3D view. The scene's jobs are controllers in scene/ (camera, model, look, selection gizmo, aim cursor, zone
// outlines, rider plan view and markers, plus FixtureRig and Crowd); this component makes them, passes store state to
// them in watchers, turns their callbacks and the clicks in the view into store actions, and disposes them.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Color4, Engine, PointerEventTypes, Scene, Texture, Vector3, type DepthRenderer, type PointerInfo } from '@babylonjs/core'
import { crowdAbsorbers } from '../domain/crowdModel'
import { MAX_REGULAR_LIGHTS } from '../domain/limits'
import { CAMERA_KEYS } from '../input/keymap'
import { solveAim } from '../scene/aim'
import { AimCursor } from '../scene/AimCursor'
import { Crowd as CrowdScene } from '../scene/Crowd'
import { FixtureRig } from '../scene/FixtureRig'
import { Look } from '../scene/Look'
import { QualityGovernor } from '../scene/quality'
import { RiderMarkers } from '../scene/RiderMarkers'
import { RiderPlanView } from '../scene/RiderPlanView'
import { captureCanvas, planShot, shotFov } from '../scene/screenshot'
import { SelectionGizmo } from '../scene/SelectionGizmo'
import { mountOnSurface, VenueModel } from '../scene/VenueModel'
import { insidePose, overviewPose, ViewerCamera, type Bounds } from '../scene/ViewerCamera'
import { ZoneOutlines } from '../scene/ZoneOutlines'
import { useCameraBridge } from '../stores/camera'
import { useCatalog } from '../stores/catalog'
import { useCrowd } from '../stores/crowd'
import { useInteraction } from '../stores/interaction'
import { useLayout } from '../stores/layout'
import { useRider } from '../stores/rider'
import { useRig } from '../stores/rig'
import { useSettings } from '../stores/settings'
import { useStats } from '../stores/stats'
import { useVenueBox } from '../stores/venueBox'
import { useVenues } from '../stores/venues'

const props = defineProps<{ modelUrl?: string }>()
const emit = defineEmits<{ (e: 'loading', value: boolean): void; (e: 'error', message: string): void }>()

/** Without clustering, venue surfaces accept this many lights at once (Babylon's default of 4 is far too few for a rig). */
const MAX_LIGHTS = 32
/** With clustered lighting a surface sees the ambient light, the clustered container and the few lights that cast shadows or project a gobo. */
const CLUSTERED_MAX_LIGHTS = 4 + MAX_REGULAR_LIGHTS

const bridge = useCameraBridge()
const settings = useSettings()
const catalog = useCatalog()
const stats = useStats()
const rig = useRig()
const venueBox = useVenueBox()
const crowdStore = useCrowd()
const riderStore = useRider()
const venues = useVenues()
const interaction = useInteraction()
const layout = useLayout()
const canvas = ref<HTMLCanvasElement>()

// Babylon objects stay out of Vue's reactivity: plain variables, made when the canvas is there.
let engine: Engine | undefined
let scene: Scene | undefined
let quality: QualityGovernor | undefined
let walkCamera: ViewerCamera | undefined
let look: Look | undefined
let model: VenueModel | undefined
let fixtureRig: FixtureRig | undefined
let crowdScene: CrowdScene | undefined
let selection: SelectionGizmo | undefined
let aimCursor: AimCursor | undefined
let zoneOutlines: ZoneOutlines | undefined
let planView: RiderPlanView | undefined
let riderMarkers: RiderMarkers | undefined
let statsTimer: ReturnType<typeof setInterval> | undefined
let resizeObserver: ResizeObserver | undefined

// --- making the scene ------------------------------------------------------------------------------

onMounted(() => {
  const view = canvas.value!
  engine = new Engine(view, true, { preserveDrawingBuffer: true })
  scene = new Scene(engine)
  scene.clearColor = new Color4(0.02, 0.02, 0.03, 1)
  walkCamera = new ViewerCamera(scene, view, CAMERA_KEYS, settings.fov)
  const camera = walkCamera.camera
  quality = new QualityGovernor(engine, scene, camera)
  quality.setRestFraction(settings.renderRest)
  quality.setEnabled(settings.adaptive)
  quality.setMovingFloor(settings.renderMoving)
  look = new Look(scene, camera, settings)
  model = new VenueModel(scene, camera)
  const depth = makeLights(scene, engine, camera)
  selection = new SelectionGizmo(scene, {
    rootOf: (id) => fixtureRig?.rootOf(id),
    onMoved: (lights) => {
      for (const { id, ...change } of lights) rig.update(id, change)
    },
    onReadout: (readout) => (rig.rotationReadout = readout),
    onDrag: () => quality?.touch(),
  })
  selection.setMode(rig.gizmoMode)
  aimCursor = new AimCursor(scene)
  zoneOutlines = new ZoneOutlines(scene)
  updateZoneOutline()
  planView = new RiderPlanView(walkCamera, model)
  riderMarkers = new RiderMarkers(scene, (delta) => riderStore.nudge(delta))

  scene.onPointerObservable.add(onPointer)
  view.addEventListener('pointerleave', () => aimCursor?.hide())
  scene.onBeforeRenderObservable.add(() => {
    fixtureRig?.update()
    crowdScene?.update(performance.now() / 1000)
  })
  engine.runRenderLoop(() => scene?.render())
  window.addEventListener('resize', onResize)
  resizeObserver = new ResizeObserver(onResize) // the inspector dock folding or unfolding changes the canvas size
  resizeObserver.observe(view)
  window.addEventListener('keydown', onShift)
  window.addEventListener('keyup', onShift)
  window.addEventListener('blur', onBlur)
  // Frame rate and render size for the on-screen counter, refreshed once a second.
  statsTimer = setInterval(() => {
    if (!engine) return
    stats.fps = Math.round(engine.getFps())
    stats.renderScale = quality?.renderScale ?? 1
    stats.width = engine.getRenderWidth()
    stats.height = engine.getRenderHeight()
  }, 1000)

  // what the rest of the app asks of the view
  riderStore.ceilingAt = (x, z) => model?.surfaceAbove(x, 0.3, z, 40) ?? null // the ceiling's underside, or whatever hangs there
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
  // for the browser tests and the console
  if (import.meta.env.DEV) {
    Object.assign(window, {
      __scene: scene,
      __rig: fixtureRig,
      __quality: quality,
      __gizmo: selection.manager,
      __depth: depth,
      __screenshot: screenshot,
      __crowd: crowdScene,
    })
  }
  void showModel(props.modelUrl)
})

/** The rig's lights and the crowd, which share the surfaces' light limit and the depth pass the beams fade against. */
function makeLights(scene: Scene, engine: Engine, camera: ViewerCamera['camera']): DepthRenderer {
  // ?clustered=0 switches clustered lighting off, for comparing against the plain path.
  const lights = new FixtureRig(scene, (id) => catalog.profileFor(id), new URLSearchParams(location.search).get('clustered') !== '0')
  lights.setShadows(settings.shadows)
  lights.onShadowedChange = (ids) => (stats.shadowed = ids)
  lights.onProjectedChange = (ids) => (stats.projected = ids)
  const crowd = new CrowdScene(scene, lights.clustered ? CLUSTERED_MAX_LIGHTS : MAX_LIGHTS)
  crowd.sync(crowdStore.crowd)
  crowd.onPlaced = () => lights.scheduleShadowRefresh()
  crowd.setAnimate(settings.animate)
  lights.setAbsorbers(crowdAbsorbers(crowdStore.crowd))
  lights.setExtraCasters(crowd.casters)
  lights.setAnimate(settings.animate)

  // Camera-space depth of solid surfaces, which the beam shader fades against. Its texture does not follow the canvas size
  // on its own, so it is resized along with it. Nearest sampling avoids halos at depth edges.
  const depth = scene.enableDepthRenderer(camera, false, false, Texture.NEAREST_SAMPLINGMODE, true)
  const depthMap = depth.getDepthMap()
  const syncDepthSize = () => {
    const width = engine.getRenderWidth()
    const height = engine.getRenderHeight()
    depthMap.resize({ width, height })
    lights.setScreenSize(width, height)
  }
  engine.onResizeObservable.add(syncDepthSize)
  syncDepthSize()
  lights.setDepth(depthMap)
  lights.setSoftBeams(settings.softBeams)
  lights.setSurfaceGain(2 ** settings.surfaceLight)
  lights.setHazeWisps(settings.hazeWisps)
  lights.setStrobePreview(settings.previewStrobe)
  lights.sync(rig.fixtures, settings.haze)
  fixtureRig = lights
  crowdScene = crowd
  return depth
}

function onResize() {
  quality?.refresh() // the pixel ratio may have changed (window moved to another screen)
  engine?.resize()
}

/** Shift moves the camera faster and snaps rotation. */
function onShift(event: KeyboardEvent) {
  walkCamera?.setFast(event.shiftKey)
  selection?.setSnapping(event.shiftKey)
}

function onBlur() {
  walkCamera?.setFast(false)
  selection?.setSnapping(false) // Shift released while another window had focus
}

function focusCanvas() {
  canvas.value?.focus()
}

onBeforeUnmount(() => {
  riderStore.ceilingAt = null
  bridge.api = null
  window.removeEventListener('resize', onResize)
  window.removeEventListener('keydown', onShift)
  window.removeEventListener('keyup', onShift)
  window.removeEventListener('blur', onBlur)
  resizeObserver?.disconnect()
  clearInterval(statsTimer)
  planView?.leave()
  riderMarkers?.dispose()
  zoneOutlines?.dispose()
  aimCursor?.dispose()
  selection?.dispose()
  crowdScene?.dispose()
  fixtureRig?.dispose()
  model?.dispose()
  look?.dispose()
  quality?.dispose()
  walkCamera?.dispose()
  engine?.dispose()
})

// --- the venue's model -------------------------------------------------------------------------------

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
    venueBox.box = { min: bounds.min.asArray(), max: bounds.max.asArray() }
    applyHiddenParts()
    // where the camera starts: where it was left in this venue, else saved view 1, else the overview
    const first = venues.current?.views?.[0]
    if (venues.currentId) walkCamera.showVenue(venues.currentId, first ? { position: first.position, rotation: first.rotation } : overviewPose(bounds))
  } catch (e) {
    emit('error', (e as Error).message)
  } finally {
    if (current) emit('loading', false)
  }
}

function clearVenue() {
  fixtureRig?.setVenueMeshes([])
  fixtureRig?.setVenueBounds(null)
  model?.clear()
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

/** The floor under the middle of the venue: met going down from mid-height, else the bottom of the model. */
function floorUnderMiddle(bounds: Bounds): number {
  const c = bounds.min.add(bounds.max).scale(0.5)
  return model?.surfaceBelow(c.x, c.y, c.z, bounds.max.y - bounds.min.y) ?? bounds.min.y
}

// --- clicks and the pointer in the view --------------------------------------------------------------

function onPointer(info: PointerInfo) {
  const mode = interaction.mode
  if (info.type === PointerEventTypes.POINTERMOVE) {
    if (showsAimCursor()) updateAimCursor()
    if (mode?.kind === 'zone' && mode.first) updateZonePreview(mode.first)
  }
  if (info.type !== PointerEventTypes.POINTERTAP || info.event.button !== 0) return
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
  const adding = e.ctrlKey || e.metaKey || e.shiftKey
  if (riderMarkerClick(adding)) return
  const id = fixtureRig?.fixtureIdOf(info.pickInfo?.pickedMesh)
  if (adding) {
    if (id) rig.toggle(id) // adding to the selection never clears it by clicking empty space
  } else {
    rig.select(id ?? null)
  }
}

/** Puts the fixture chosen in the picker on the venue surface under the pointer, hanging from ceilings and standing on floors. */
function placeFixture() {
  const hit = model?.pickUnderPointer()
  if (hit?.pickedPoint) rig.placeAt(mountOnSurface(hit.pickedPoint, hit.getNormal(true, true) ?? Vector3.Up(), hit.ray?.direction))
}

/** Aims the selected lights at the venue surface under the pointer. */
function aimAtPointer() {
  const point = model?.pointUnderPointer()
  if (point) rig.aimAt(point.asArray())
}

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

/** A click while the rider wizard waits for a point in the venue. */
function riderPick() {
  const point = model?.pointUnderPointer()
  if (point) riderStore.deliverWorld(point.asArray())
}

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

/** The crosshair on the surface shows in every click mode but placing, which has only the crosshair pointer. */
function showsAimCursor() {
  return !!interaction.mode && interaction.mode.kind !== 'place'
}

function updateAimCursor() {
  if (walkCamera && model) aimCursor?.showAt(model.pickUnderPointer(), walkCamera.camera.position)
}

function updateZonePreview(first: [number, number, number]) {
  const point = model?.pointerAtHeight(first[1])
  if (point) zoneOutlines?.showPreview(first, [point.x, point.z])
}

function updateZoneOutline() {
  zoneOutlines?.showOutline(crowdStore.zones.find((z) => z.id === crowdStore.selectedId) ?? null)
}

// --- the rider wizard: the plan view and the preview of the lights it would add ----------------------------

/** The view's size in render pixels, and how much of it the wizard panel covers, for the plan view to fit the venue beside it. */
function viewport() {
  const width = engine?.getRenderWidth() ?? 1
  const cssScale = width / Math.max(1, canvas.value?.clientWidth ?? width)
  return { width, height: engine?.getRenderHeight() ?? 1, coveredPx: layout.wizardWidth * cssScale }
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
      look?.setRoomLightAtLeast(0.6)
    } else if (!on && planView.active) {
      planView.leave()
      fixtureRig?.setHidden(false)
      crowdScene?.setHidden(false)
      look?.setRoomLightAtLeast(0)
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
watch(
  () => [riderStore.open, riderStore.step, riderStore.result, riderStore.worldPoints, riderStore.excluded, riderStore.adjust, riderStore.selectedKeys],
  () => {
    const showing = riderStore.open && riderStore.step !== 'load'
    const drafts = showing ? (riderStore.result?.drafts ?? []).filter((d) => d.placement && !riderStore.excluded.has(d.key)) : []
    riderMarkers?.show({
      lights: drafts.map((d) => ({ key: d.key, position: riderStore.positionOf(d), onTruss: d.placement!.height === 'truss' })),
      selected: riderStore.selectedKeys,
      references: riderStore.open ? riderStore.worldPoints : [],
      editable: riderStore.open && riderStore.step === 'review',
    })
  },
  { deep: true },
)

// --- screenshots -------------------------------------------------------------------------------------

/** Renders the current view offscreen at `scale` times its size, without selection outline or gizmo. */
async function screenshot(scale: number) {
  if (!engine || !walkCamera || !fixtureRig || !look) throw new Error('viewer not ready')
  const { camera } = walkCamera
  const size = planShot(engine, canvas.value!, scale)
  const selected = [...rig.selectedIds]
  fixtureRig.setSelected([])
  selection?.hide()
  fixtureRig.setStrobeHold(true) // a picture shows strobing lights lit, not caught between flashes
  crowdScene?.setHold(true) // and the crowd standing still
  quality?.pause()
  const fov = camera.fov
  camera.fov = shotFov(fov, canvas.value!)
  const restoreLook = look.forPicture(size.width * size.height)
  try {
    return { blob: await captureCanvas(engine, canvas.value!, size), ...size }
  } finally {
    restoreLook()
    camera.fov = fov
    quality?.resume()
    fixtureRig.setStrobeHold(false)
    crowdScene?.setHold(false)
    fixtureRig.setSelected(selected)
    selection?.attach(selected)
  }
}

// --- the scene follows the stores --------------------------------------------------------------------

// the venue
watch(
  () => props.modelUrl,
  (url) => showModel(url),
)
watch(() => venues.current?.hiddenTags, applyHiddenParts, { deep: true })

// the lights
watch(
  [() => rig.fixtures, () => settings.haze],
  () => {
    quality?.touch()
    fixtureRig?.sync(rig.fixtures, settings.haze)
  },
  { deep: true, flush: 'post' },
)
// Fixtures placed from the catalog look different once the catalog has arrived.
watch(
  () => catalog.profiles,
  () => fixtureRig?.sync(rig.fixtures, settings.haze),
)
watch(
  () => rig.aim.tick,
  () => {
    // the lights that were aimed, pointed at the aim point (again) with the current spread and fan
    if (!fixtureRig || !rig.aim.anchor) return
    const fixtures = rig.aim.ids.map((id) => rig.fixtures.find((f) => f.id === id)).filter((f): f is NonNullable<typeof f> => !!f)
    const result = solveAim(fixtureRig.aimable(fixtures), new Vector3(...rig.aim.anchor), { spread: rig.aim.spread, fan: rig.aim.fan })
    rig.applyAim(result.patches, result.unreachable)
  },
)

// the selection and what the next click does
watch(
  () => rig.selectedIds.join(','),
  () => {
    fixtureRig?.setSelected(rig.selectedIds)
    selection?.attach(rig.selectedIds)
  },
  { flush: 'post' },
)
// After an undo or redo the lights may have moved while the selection stayed the same: put the gizmo back on them.
watch(
  () => rig.historyVersion,
  () => selection?.attach(rig.selectedIds),
  { flush: 'post' },
)
watch(
  () => rig.gizmoMode,
  (mode) => selection?.setMode(mode),
)
watch(
  () => interaction.mode !== null,
  (crosshair) => {
    if (canvas.value) canvas.value.style.cursor = crosshair ? 'crosshair' : ''
  },
)
watch(showsAimCursor, (on) => (on ? updateAimCursor() : aimCursor?.hide()))
watch(
  () => (rig.aimActive ? rig.aim.anchor : null),
  (point) => aimCursor?.setAimPoint(point),
)

// the crowd
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

// the settings
watch(
  () => [settings.toneMapping, settings.exposure, settings.bloom, settings.haze, settings.ambient],
  () => {
    quality?.touch()
    look?.apply(settings)
  },
)
watch(
  () => settings.fov,
  (degrees) => walkCamera?.setFov(degrees),
)
watch(
  () => settings.softBeams,
  (on) => {
    // whether light fades out softly before a surface (the depth pass always runs: beams are occluded with it)
    quality?.touch()
    fixtureRig?.setSoftBeams(on)
  },
)
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
