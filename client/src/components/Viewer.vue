<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  AssetContainer,
  Color3,
  Color4,
  DefaultRenderingPipeline,
  DepthRenderer,
  Engine,
  GizmoManager,
  HemisphericLight,
  ImageProcessingConfiguration,
  LoadAssetContainerAsync,
  Matrix,
  Mesh,
  MeshBuilder,
  Plane,
  Observer,
  PBRMaterial,
  PointerEventTypes,
  PositionGizmo,
  Quaternion,
  Ray,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  UniversalCamera,
  UtilityLayerRenderer,
  Vector3,
  type LinesMesh,
  type PickingInfo,
  type AbstractMesh,
  type Node,
} from '@babylonjs/core'
import '@babylonjs/loaders/glTF'
import { profilesVersion } from '../fixtures/profiles'
import { CAMERA_KEYS } from '../input/keymap'
import { solveAim } from '../scene/aim'
import { Crowd as CrowdScene } from '../scene/Crowd'
import { clutterCut, triangleIndices } from '../scene/planClutter'
import { FixtureRig, MAX_REGULAR_LIGHTS } from '../scene/FixtureRig'
import { QualityGovernor } from '../scene/quality'
import { captureCanvas, planShot, SHOT_ASPECT } from '../scene/screenshot'
import { useCameraBridge, type CameraState } from '../stores/camera'
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

/** Rotation snaps to multiples of this many degrees (measured from where the drag started) while Shift is held. */
const SNAP_DEGREES = 5
const SNAP_STEP = (SNAP_DEGREES * Math.PI) / 180

/** Anisotropic filtering level for venue textures (the GPU's own limit applies if it is lower). */
const MAX_ANISOTROPY = 16

const EYE_HEIGHT = 1.7
const WALK_SPEED = 0.12
const FAST_FACTOR = 4
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
let camera: UniversalCamera | undefined
let ambient: HemisphericLight | undefined
let venue: AssetContainer | undefined
let bounds: { min: Vector3; max: Vector3 } | undefined
let loadToken = 0
let tween: Observer<Scene> | null = null
let fast = false
let fixtureRig: FixtureRig | undefined
let crowdScene: CrowdScene | undefined
let gizmo: GizmoManager | undefined
/** With several lights selected the gizmo sits on this invisible node at their centre: dragging it moves or turns them all. */
let pivot: TransformNode | undefined
let groupStart: {
  pivot: Vector3
  items: { id: string; root: TransformNode; position: Vector3; rotation: Quaternion }[]
} | null = null
let quality: QualityGovernor | undefined
let pipeline: DefaultRenderingPipeline | undefined
let depthRenderer: DepthRenderer | undefined
let statsTimer: ReturnType<typeof setInterval> | undefined
/** id of the venue whose model is currently on screen (what a saved camera pose belongs to) */
let shownVenueId: string | null = null
let poseTimer: ReturnType<typeof setTimeout> | undefined
let lastPoseKey = ''

// --- camera helpers --------------------------------------------------------

/** Babylon rotation (pitch down is positive x, yaw around y) for looking from `from` at `to`. */
function lookRotation(from: Vector3, to: Vector3): Vector3 {
  const d = to.subtract(from)
  return new Vector3(Math.atan2(-d.y, Math.hypot(d.x, d.z)), Math.atan2(d.x, d.z), 0)
}

function getState(): CameraState {
  const c = camera!
  return { position: c.position.asArray(), rotation: c.rotation.asArray() }
}

function stopTween() {
  if (tween && scene) scene.onBeforeRenderObservable.remove(tween)
  tween = null
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

function goTo(state: CameraState, animate = true) {
  if (!camera || !scene) return
  stopTween()
  const toPos = Vector3.FromArray(state.position)
  const toRot = Vector3.FromArray(state.rotation)
  if (!animate) {
    camera.position.copyFrom(toPos)
    camera.rotation.copyFrom(toRot)
    return
  }
  const fromPos = camera.position.clone()
  const fromRot = camera.rotation.clone()
  // Turn the short way around.
  const dYaw = Math.atan2(Math.sin(toRot.y - fromRot.y), Math.cos(toRot.y - fromRot.y))
  const duration = 700
  const start = performance.now()
  tween = scene.onBeforeRenderObservable.add(() => {
    const t = Math.min(1, (performance.now() - start) / duration)
    const k = easeInOut(t)
    camera!.position.copyFrom(Vector3.Lerp(fromPos, toPos, k))
    camera!.rotation.set(fromRot.x + (toRot.x - fromRot.x) * k, fromRot.y + dYaw * k, 0)
    if (t >= 1) stopTween()
  })
}

function overviewState(): CameraState | undefined {
  if (!bounds) return
  const center = bounds.min.add(bounds.max).scale(0.5)
  const position = new Vector3(center.x, bounds.max.y + 8, bounds.min.z - 14)
  return { position: position.asArray(), rotation: lookRotation(position, center).asArray() }
}

/** Eye height above the floor in the middle of the venue; the floor is found with a ray cast down from mid-height. */
function insideState(): CameraState | undefined {
  if (!bounds || !scene || !venue) return
  const center = bounds.min.add(bounds.max).scale(0.5)
  const meshes = new Set(venue.meshes)
  const hit = scene.pickWithRay(new Ray(center, Vector3.Down(), bounds.max.y - bounds.min.y), (m) => meshes.has(m))
  const floorY = hit?.hit && hit.pickedPoint ? hit.pickedPoint.y : bounds.min.y
  const position = new Vector3(center.x, floorY + EYE_HEIGHT, center.z)
  return { position: position.asArray(), rotation: [0, 0, 0] }
}

// --- venue loading ---------------------------------------------------------

// --- remembering where the camera was -----------------------------------------

const poseKey = (venueId: string) => `preflight.camera.${venueId}`

function loadPose(venueId: string): CameraState | undefined {
  try {
    const raw = JSON.parse(localStorage.getItem(poseKey(venueId)) ?? 'null') as { position?: unknown; rotation?: unknown } | null
    const ok = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
    if (raw && ok(raw.position) && ok(raw.rotation)) return { position: raw.position, rotation: raw.rotation }
  } catch {
    /* unreadable or unavailable storage: start from the default view */
  }
  return undefined
}

function savePose(venueId: string, state: CameraState) {
  try {
    localStorage.setItem(poseKey(venueId), JSON.stringify(state))
  } catch {
    /* storage unavailable: the pose just won't be remembered */
  }
}

/** Writes a pending camera pose now (page closing, viewer going away). */
function flushPose() {
  if (!camera || !shownVenueId || !poseTimer) return
  clearTimeout(poseTimer)
  poseTimer = undefined
  savePose(shownVenueId, getState())
}

/** Saves the camera pose shortly after it stops changing, under the venue that is on screen. */
function trackPose() {
  if (!camera || !shownVenueId || planView) return // the plan view is temporary: it is not where the camera should start next time
  const state = getState()
  const key = [...state.position, ...state.rotation].map((n) => n.toFixed(3)).join(',')
  if (key === lastPoseKey) return
  lastPoseKey = key
  const id = shownVenueId
  clearTimeout(poseTimer)
  poseTimer = setTimeout(() => savePose(id, state), 500)
}

/** Where the camera starts for a venue: where it was last time, else saved view 1, else the overview. */
function startState(venueId: string | null): CameraState | undefined {
  const remembered = venueId ? loadPose(venueId) : undefined
  if (remembered) return remembered
  const first = venues.venues.find((v) => v.id === venueId)?.views?.[0]
  return first ? { position: first.position, rotation: first.rotation } : overviewState()
}

function clearVenue() {
  fixtureRig?.setVenueMeshes([])
  venue?.dispose()
  venue = undefined
  bounds = undefined
  fixtureRig?.setVenueBounds(null)
  venueBox.box = null
  venueBox.tags = []
  venueBox.tagsFromNodes = false
  parts = new Map()
  shownVenueId = null
}

const TAG_PREFIX = 'tag:'

/** The parts of the model that can be hidden, by name (see `findParts`). */
let parts = new Map<string, Node[]>()

/** The tag a model mesh belongs to (a node with several materials loads as meshes named "<node>_primitive<n>"), or null. */
function tagOf(mesh: AbstractMesh): string | null {
  return mesh.name.startsWith(TAG_PREFIX) ? mesh.name.slice(TAG_PREFIX.length).replace(/_primitive\d+$/, '') : null
}

/**
 * The parts of a model, by name. A model from SketchUp has one node per tag ("tag:<name>"). Any other model (a GLB from
 * Blender, say) is split by its top-level nodes, below any single node that only wraps the rest, as many exporters add one.
 */
function findParts(container: AssetContainer): { parts: Map<string, Node[]>; fromTags: boolean } {
  const found = new Map<string, Node[]>()
  const add = (name: string, node: Node) => found.set(name, [...(found.get(name) ?? []), node])
  for (const mesh of container.meshes) {
    const tag = tagOf(mesh)
    if (tag !== null) add(tag, mesh)
  }
  if (found.size) return { parts: found, fromTags: true }
  // nodes with something to see (not an empty, a light or a camera), leaving out the meshes a node's own geometry loads
  // as (one per material, named "<node>_primitive<n>")
  const solid = container.meshes.filter((mesh) => mesh.getTotalVertices() > 0)
  const shown = (nodes: Node[]) => nodes.filter((node) => solid.some((mesh) => mesh === node || mesh.isDescendantOf(node)))
  const childNodes = (node: Node) => shown(node.getChildren().filter((child) => !child.name.startsWith(`${node.name}_primitive`)))
  let top = shown(container.rootNodes.flatMap((root) => (root.name === '__root__' ? root.getChildren() : [root])))
  for (let depth = 0; top.length === 1 && childNodes(top[0]).length && depth < 8; depth++) top = childNodes(top[0])
  for (const node of top) add(node.name || 'Unnamed', node)
  return { parts: found, fromTags: false }
}

/** Shows the model's parts that are on and hides the ones that are switched off for this venue. */
function applyTags() {
  if (!venue) return
  const hidden = new Set(venues.current?.hiddenTags ?? [])
  for (const [name, nodes] of parts) for (const node of nodes) node.setEnabled(!hidden.has(name))
  fixtureRig?.markShadowsDirty()
}

async function showModel(url?: string) {
  if (!scene || !camera) return
  const token = ++loadToken
  stopTween()
  clearVenue()
  if (!url) return

  emit('loading', true)
  try {
    const container = await LoadAssetContainerAsync(url, scene)
    if (token !== loadToken) return container.dispose() // a newer selection superseded this load
    // A model exported from Blender and the like can bring its own lights, cameras and animations: the room is lit by the
    // rig and seen through our camera, and it stands still.
    for (const item of [...container.lights, ...container.cameras, ...container.animationGroups]) item.dispose()
    container.lights.length = container.cameras.length = container.animationGroups.length = 0
    container.addAllToScene()
    venue = container
    // Sharper textures on surfaces seen at a grazing angle (brick walls along the room, the floor).
    const anisotropy = Math.min(MAX_ANISOTROPY, engine?.getCaps().maxAnisotropy || 1)
    for (const texture of container.textures) texture.anisotropicFilteringLevel = anisotropy
    fixtureRig?.setVenueMeshes(container.meshes)
    for (const mesh of container.meshes) mesh.receiveShadows = true
    const limit = fixtureRig?.clustered ? CLUSTERED_MAX_LIGHTS : MAX_LIGHTS
    for (const material of container.materials) {
      // The default (physical) spot falloff is a fixed bell shape that ignores the inner angle. The glTF falloff keeps the
      // same inverse-square distance falloff but fades between the inner and outer angle, so a light's edge can be sharp.
      if (material instanceof PBRMaterial) material.useGLTFLightFalloff = true
      if ('maxSimultaneousLights' in material) (material as { maxSimultaneousLights: number }).maxSimultaneousLights = limit
    }

    bounds = container.meshes.reduce(
      (acc, mesh) => {
        const b = mesh.getHierarchyBoundingVectors(true)
        return { min: Vector3.Minimize(acc.min, b.min), max: Vector3.Maximize(acc.max, b.max) }
      },
      { min: new Vector3(Infinity, Infinity, Infinity), max: new Vector3(-Infinity, -Infinity, -Infinity) },
    )
    fixtureRig?.setVenueBounds(bounds)
    const found = findParts(container)
    parts = found.parts
    venueBox.tags = [...parts.keys()].sort()
    venueBox.tagsFromNodes = !found.fromTags
    applyTags()
    venueBox.box = { min: bounds.min.asArray(), max: bounds.max.asArray() }
    const start = startState(venues.currentId)
    if (start) goTo(start, false)
    shownVenueId = venues.currentId
    lastPoseKey = ''
  } catch (e) {
    if (token === loadToken) emit('error', (e as Error).message)
  } finally {
    if (token === loadToken) emit('loading', false)
  }
}

// --- lifecycle -------------------------------------------------------------

function onKey(event: KeyboardEvent) {
  fast = event.shiftKey
  setSnapping(event.shiftKey)
}

function onBlur() {
  fast = false
  setSnapping(false) // Shift released while another window had focus
}

onMounted(() => {
  engine = new Engine(canvas.value!, true, { preserveDrawingBuffer: true })
  scene = new Scene(engine)
  scene.clearColor = new Color4(0.02, 0.02, 0.03, 1)

  camera = new UniversalCamera('cam', new Vector3(0, EYE_HEIGHT, -8), scene)
  camera.fov = (settings.fov * Math.PI) / 180
  camera.minZ = 0.05
  camera.maxZ = 500
  camera.speed = WALK_SPEED
  camera.inertia = 0.75
  camera.angularSensibility = 2500
  camera.keysUp = [...CAMERA_KEYS.forward]
  camera.keysDown = [...CAMERA_KEYS.back]
  camera.keysLeft = [...CAMERA_KEYS.left]
  camera.keysRight = [...CAMERA_KEYS.right]
  camera.keysUpward = [...CAMERA_KEYS.up]
  camera.keysDownward = [...CAMERA_KEYS.down]
  camera.attachControl(canvas.value!, true)
  canvas.value!.addEventListener('pointerleave', hideAimCursor)

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
  // Any manual input cancels a running jump animation.
  canvas.value!.addEventListener('pointerdown', stopTween)
  canvas.value!.addEventListener('keydown', stopTween)

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
  gizmo = new GizmoManager(scene)
  gizmo.usePointerToAttachGizmos = false
  gizmo.scaleGizmoEnabled = false
  gizmo.boundingBoxGizmoEnabled = false
  // Create both gizmos once (enabling creates them), then switch between them with the move/rotate mode.
  gizmo.positionGizmoEnabled = true
  gizmo.rotationGizmoEnabled = true
  const { positionGizmo, rotationGizmo } = gizmo.gizmos
  for (const g of [positionGizmo, rotationGizmo]) {
    if (!g) continue
    g.updateGizmoRotationToMatchAttachedMesh = false // world-aligned axes, even for an upside-down fixture
    g.onDragObservable.add(() => quality?.touch())
  }
  pivot = new TransformNode('selection-pivot', scene)
  pivot.rotationQuaternion = Quaternion.Identity()
  const selectedRoot = () => {
    const id = rig.selectedId
    const root = id ? fixtureRig?.rootOf(id) : undefined
    return id && root ? { id, root } : undefined
  }
  for (const g of [positionGizmo, rotationGizmo]) {
    g?.onDragStartObservable.add(beginGroupDrag)
    g?.onDragObservable.add(applyGroupDrag)
  }
  positionGizmo?.onDragEndObservable.add(() => {
    if (groupStart) return endGroupDrag(false)
    const target = selectedRoot()
    if (target) rig.update(target.id, { position: target.root.position.asArray() })
  })
  rotationGizmo?.onDragEndObservable.add(() => {
    if (groupStart) return endGroupDrag(true)
    const q = selectedRoot()?.root.rotationQuaternion
    const target = selectedRoot()
    if (target && q) rig.update(target.id, { rotation: q.normalizeToNew().asArray() })
  })
  if (rotationGizmo) setupRotationFeedback(rotationGizmo)
  applyGizmoMode(rig.gizmoMode)
  if (import.meta.env.DEV) {
    ;(window as unknown as { __rig: FixtureRig }).__rig = fixtureRig
    ;(window as unknown as { __quality: QualityGovernor }).__quality = quality
    ;(window as unknown as { __gizmo?: GizmoManager }).__gizmo = gizmo
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
    trackPose()
    if (camera) camera.speed = WALK_SPEED * (fast ? FAST_FACTOR : 1)
  })
  engine.runRenderLoop(() => scene?.render())
  window.addEventListener('resize', onResize)
  resizeObserver = new ResizeObserver(onResize) // the inspector dock folding or unfolding changes the canvas size
  resizeObserver.observe(canvas.value!)
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKey)
  window.addEventListener('pagehide', flushPose)
  window.addEventListener('blur', onBlur)

  riderStore.ceilingAt = ceilingAt
  bridge.api = {
    getState,
    goTo: (state) => goTo(state, true),
    overview: () => {
      const s = overviewState()
      if (s) goTo(s, true)
    },
    inside: () => {
      const s = insideState()
      if (s) goTo(s, true)
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

/** Height above which the venue is cut away while the plan is being placed (null: nothing is cut). */
let clipHeight: number | null = null

/** The venue surface under the pointer. While the venue is cut for plan placing, what is cut away is not hit: the first surface at or below the cut is. */
function pickVenue(): PickingInfo | null {
  if (!scene || !venue) return null
  const venueMeshes = new Set(venue.meshes)
  if (clipHeight === null) {
    const hit = scene.pick(scene.pointerX, scene.pointerY, (mesh) => venueMeshes.has(mesh))
    return hit?.hit ? hit : null
  }
  // A mesh answers a ray with its nearest hit only, and the roof is often part of the same mesh as the floor: go on from each
  // hit that lies in the cut-away part, along the same ray, until one lies below the cut.
  const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), camera ?? null)
  let origin = ray.origin.clone()
  for (let i = 0; i < 12; i++) {
    const hit = scene.pickWithRay(new Ray(origin, ray.direction, 1000), (mesh) => venueMeshes.has(mesh) && mesh.isVisible)
    if (!hit?.hit || !hit.pickedPoint) return null
    if (hit.pickedPoint.y <= clipHeight) return hit
    origin = hit.pickedPoint.add(ray.direction.scale(0.02))
  }
  return null
}

/** The point on a venue surface under the pointer, if there is one. */
function surfaceUnderPointer(): Vector3 | null {
  return pickVenue()?.pickedPoint ?? null
}

/** Where the pointer's ray crosses the horizontal plane at height `y` (a zone's second corner follows the pointer in that plane). */
function planePointUnderPointer(y: number): Vector3 | null {
  if (!scene || !camera) return null
  const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), camera)
  if (Math.abs(ray.direction.y) < 1e-4) return null
  const t = (y - ray.origin.y) / ray.direction.y
  return t > 0 ? ray.origin.add(ray.direction.scale(t)) : null
}

/** A click while a crowd zone is being drawn: the first corner on a surface, then the opposite one at the same height. */
function zoneClick(first: [number, number, number] | null) {
  if (!first) {
    const point = surfaceUnderPointer()
    if (point) crowdStore.setFirstCorner(point.asArray())
  } else {
    const point = planePointUnderPointer(first[1])
    if (point) crowdStore.finishZone([point.x, point.z])
  }
}

/** A click on the point the people in a zone should face. */
function facingClick(zoneId: string) {
  const point = surfaceUnderPointer()
  if (point) crowdStore.setFacing(zoneId, [point.x, point.z])
}

// --- tech rider import: a point asked for, the ceiling, and a preview of where the lights would go ----------------

/** A click while the rider wizard waits for a point in the venue. */
function riderPick() {
  const point = surfaceUnderPointer()
  if (point) riderStore.deliverWorld(point.asArray())
}

/** The height of the first surface above a spot, from 0.3 m over the floor: the ceiling's underside, or whatever hangs there. */
function ceilingAt(x: number, z: number): number | null {
  if (!scene || !venue) return null
  const venueMeshes = new Set(venue.meshes)
  const hit = scene.pickWithRay(new Ray(new Vector3(x, 0.3, z), Vector3.Up(), 40), (mesh) => venueMeshes.has(mesh))
  return hit?.hit && hit.pickedPoint ? hit.pickedPoint.y : null
}

/**
 * The view for placing a plan: the camera high over the middle of the venue looking straight down, the venue cut away above
 * 2.2 m (like an architect's plan, which shows the walls and what stands on the floor, not the roof), the crowd and the lights
 * hidden, and the room light raised so the floor shows. Returns what puts everything back.
 */
const PLAN_CUT = 2.2

/** Where the camera is for the plan view: set while it is on. */
let planView: { center: Vector3; floorY: number; height: number; metersPerPixel: number; shiftPx: number; yaw: number } | null = null

/** The camera over the venue at a yaw, shifted sideways so the venue sits in the part of the view the wizard panel leaves free. */
function planPose(yaw: number): CameraState {
  const v = planView!
  const shift = v.shiftPx * v.metersPerPixel // to the right, so the venue moves left on the screen
  return {
    position: [v.center.x + Math.cos(yaw) * shift, v.floorY + v.height, v.center.z - Math.sin(yaw) * shift],
    rotation: [Math.PI / 2 - 0.0005, yaw, 0],
  }
}

function enterTopDown(): (() => void) | null {
  if (!camera || !scene || !bounds || !venue || !engine) return null
  const center = bounds.min.add(bounds.max).scale(0.5)
  const meshes = new Set(venue.meshes)
  // the floor: the first surface met going up from below the model (a ray down from above would meet the roof)
  const floorHit = scene.pickWithRay(new Ray(new Vector3(center.x, bounds.min.y - 1, center.z), Vector3.Up(), bounds.max.y - bounds.min.y + 2), (m) =>
    meshes.has(m),
  )
  const floorY = floorHit?.hit && floorHit.pickedPoint ? floorHit.pickedPoint.y : bounds.min.y
  const halfW = (bounds.max.x - bounds.min.x) / 2
  const halfD = (bounds.max.z - bounds.min.z) / 2
  const saved = { pose: getState(), fov: camera.fov, clip: scene.clipPlane, maxZ: camera.maxZ }
  const fov = (50 * Math.PI) / 180
  // the wizard panel covers the right of the view: fit the venue into what is left of it
  const panel = document.querySelector('aside[aria-label="Import tech rider"]')?.getBoundingClientRect().width ?? 0
  const width = engine.getRenderWidth()
  const heightPx = Math.max(1, engine.getRenderHeight())
  const cssScale = width / Math.max(1, canvas.value?.clientWidth ?? width)
  const panelPx = panel * cssScale
  const aspect = Math.max(0.5, (width - panelPx) / heightPx)
  const height = (1.1 * Math.max(halfD, halfW / aspect)) / Math.tan(fov / 2)
  const metersPerPixel = (2 * Math.tan(fov / 2) * height) / heightPx
  // look along an axis of the venue: the nearest quarter turn to where the camera looks now
  const yaw = Math.round(camera.rotation.y / (Math.PI / 2)) * (Math.PI / 2)
  planView = { center, floorY, height, metersPerPixel, shiftPx: panelPx / 2, yaw }
  camera.fov = fov
  camera.maxZ = Math.max(camera.maxZ, height + (bounds.max.y - bounds.min.y) + 50)
  clipHeight = floorY + PLAN_CUT
  scene.clipPlane = new Plane(0, 1, 0, -clipHeight)
  goTo(planPose(yaw), true)
  setPlanClutter(riderStore.hideClutter)
  fixtureRig?.setHidden(true)
  crowdScene?.setHidden(true)
  if (ambient) ambient.intensity = Math.max(ambient.intensity, 0.6) // the floor must be seen, whatever the room light is set to
  return () => {
    setPlanClutter(false)
    planView = null
    clipHeight = null
    if (scene) scene.clipPlane = saved.clip
    if (ambient) ambient.intensity = settings.ambient
    if (camera) {
      camera.fov = saved.fov
      camera.maxZ = saved.maxZ
    }
    goTo(saved.pose, true)
    fixtureRig?.setHidden(false)
    crowdScene?.setHidden(false)
  }
}

/** The pieces taken out of the model for the plan view (see planClutter.ts), with what puts them back. */
interface ClutterCut {
  mesh: Mesh
  /** the mesh's own triangles; the full list for a mesh drawn without an index buffer */
  original: ArrayLike<number>
  unindexed: boolean
  hiddenAll: boolean
}
let planClutter: ClutterCut[] = []

function setPlanClutter(hidden: boolean) {
  if (!planView || !venue) return
  if (hidden && planClutter.length === 0) {
    for (const mesh of venue.meshes) {
      const positions = mesh.getVerticesData('position')
      if (!(mesh instanceof Mesh) || !positions) continue
      const original = triangleIndices(mesh.getIndices(), mesh.getTotalVertices())
      const cut = clutterCut(positions, original, mesh.computeWorldMatrix(true).m, planView.floorY)
      if (!cut) continue
      const entry: ClutterCut = { mesh, original, unindexed: mesh.isUnIndexed, hiddenAll: cut.keep.length === 0 }
      if (entry.hiddenAll) {
        mesh.isVisible = false
      } else {
        mesh.setIndices(cut.keep, mesh.getTotalVertices())
        mesh.isUnIndexed = false // drawn and picked by the indices now, also when the model came without them
      }
      planClutter.push(entry)
    }
  } else if (!hidden) {
    for (const { mesh, original, unindexed, hiddenAll } of planClutter) {
      if (hiddenAll) {
        mesh.isVisible = true
      } else {
        mesh.setIndices(Array.from(original), mesh.getTotalVertices())
        mesh.isUnIndexed = unindexed
      }
    }
    planClutter = []
  }
}
watch(
  () => riderStore.hideClutter,
  (hidden) => setPlanClutter(hidden),
)

/** A quarter turn of the plan view, for venues whose stage is not at the top of the screen. */
watch(
  () => riderStore.viewTurns,
  () => {
    if (!planView) return
    planView.yaw += Math.PI / 2
    goTo(planPose(planView.yaw), true)
  },
)

let leaveTopDown: (() => void) | null = null
watch(
  () => riderStore.calibrating,
  (on) => {
    if (on && !leaveTopDown) leaveTopDown = enterTopDown()
    else if (!on && leaveTopDown) {
      leaveTopDown()
      leaveTopDown = null
    }
  },
)

/** One small sphere for each light the wizard would add, keyed by its draft: picked to select it, moved with the gizmo. */
const riderMarkers = new Map<string, Mesh>()
let riderRefMarkers: Mesh[] = []
const riderMaterials = new Map<string, StandardMaterial>()

function riderMaterial(name: string, color: Color3): StandardMaterial {
  let material = riderMaterials.get(name)
  if (!material && scene) {
    material = new StandardMaterial(`rider-${name}`, scene)
    material.disableLighting = true
    material.emissiveColor = color
    riderMaterials.set(name, material)
  }
  return material!
}

// the move gizmo: on a pivot at the middle of the selected lights, so that moving it moves them all
let markerUtility: UtilityLayerRenderer | undefined
let markerGizmo: PositionGizmo | undefined
let markerPivot: TransformNode | undefined
let markerDragging = false
const pivotLast = new Vector3()

function ensureMarkerGizmo() {
  if (!scene || markerGizmo) return
  markerUtility = new UtilityLayerRenderer(scene)
  markerPivot = new TransformNode('rider-pivot', scene)
  markerGizmo = new PositionGizmo(markerUtility)
  markerGizmo.updateGizmoRotationToMatchAttachedMesh = false // world axes
  const axes = [markerGizmo.xGizmo, markerGizmo.yGizmo, markerGizmo.zGizmo, markerGizmo.xPlaneGizmo, markerGizmo.yPlaneGizmo, markerGizmo.zPlaneGizmo]
  for (const axis of axes) {
    axis.dragBehavior.onDragStartObservable.add(() => {
      markerDragging = true
    })
    axis.dragBehavior.onDragObservable.add(() => {
      if (!markerPivot) return
      const d = markerPivot.position.subtract(pivotLast)
      pivotLast.copyFrom(markerPivot.position)
      riderStore.nudge([d.x, d.y, d.z])
    })
    axis.dragBehavior.onDragEndObservable.add(() => {
      markerDragging = false
      syncMarkerGizmo()
    })
  }
}

function syncMarkerGizmo() {
  const keys = riderStore.selectedKeys.filter((k) => riderMarkers.has(k))
  if (keys.length === 0 || !riderStore.open || riderStore.step !== 'review') {
    if (markerGizmo) markerGizmo.attachedNode = null
    return
  }
  ensureMarkerGizmo()
  if (!markerGizmo || !markerPivot) return
  if (!markerDragging) {
    const centroid = Vector3.Zero()
    for (const k of keys) centroid.addInPlace(riderMarkers.get(k)!.position)
    centroid.scaleInPlace(1 / keys.length)
    markerPivot.position.copyFrom(centroid)
    pivotLast.copyFrom(centroid)
  }
  markerGizmo.attachedNode = markerPivot
}

/** The draft a rider marker stands for (set in `updateRiderPreview`); undefined for any other mesh. */
const riderKeyOf = (mesh: AbstractMesh | null | undefined) => (mesh?.metadata as { riderKey?: string } | null | undefined)?.riderKey

/** A click in the review: a light's sphere selects it (Ctrl, Shift or Cmd adds), a click on nothing clears the selection. Returns true when it was for the wizard. */
function riderMarkerClick(add: boolean): boolean {
  if (!scene || !riderStore.open || riderStore.step !== 'review' || markerDragging) return false
  const hit = scene.pick(scene.pointerX, scene.pointerY, (mesh) => !!riderKeyOf(mesh))
  const key = hit?.hit ? riderKeyOf(hit.pickedMesh) : undefined
  if (key) {
    if (add) riderStore.toggleSelected(key)
    else riderStore.select([key])
    return true
  }
  if (!add && riderStore.selectedKeys.length) riderStore.select([])
  return false
}

/** Small spheres at the lights the wizard would add (green: on a truss, amber: height assumed, white: selected, blue: reference points picked). */
function updateRiderPreview() {
  for (const marker of riderRefMarkers) marker.dispose()
  riderRefMarkers = []
  const drafts =
    riderStore.open && riderStore.step !== 'load' ? (riderStore.result?.drafts ?? []).filter((d) => d.placement && !riderStore.excluded.has(d.key)) : []
  const wanted = new Set(drafts.map((d) => d.key))
  for (const [key, marker] of riderMarkers) {
    if (!wanted.has(key)) {
      marker.dispose()
      riderMarkers.delete(key)
    }
  }
  if (!scene) return
  for (const d of drafts) {
    let marker = riderMarkers.get(d.key)
    if (!marker) {
      marker = MeshBuilder.CreateSphere('rider-marker', { diameter: 0.2, segments: 8 }, scene)
      marker.metadata = { riderKey: d.key }
      riderMarkers.set(d.key, marker)
    }
    const [x, y, z] = riderStore.positionOf(d)
    marker.position.set(x, y, z)
    const selected = riderStore.selectedKeys.includes(d.key)
    marker.material = selected
      ? riderMaterial('selected', new Color3(1, 1, 1))
      : d.placement!.height === 'truss'
        ? riderMaterial('ok', new Color3(0.3, 0.9, 0.5))
        : riderMaterial('assumed', new Color3(1, 0.7, 0.2))
    marker.scaling.setAll(selected ? 1.5 : 1)
    marker.isPickable = riderStore.step === 'review'
  }
  if (riderStore.open) {
    for (const w of riderStore.worldPoints) {
      if (!w) continue
      const sphere = MeshBuilder.CreateSphere('rider-ref', { diameter: 0.35, segments: 8 }, scene)
      sphere.position.set(w[0], 0.05, w[1])
      sphere.material = riderMaterial('ref', new Color3(0.4, 0.6, 1))
      sphere.isPickable = false
      riderRefMarkers.push(sphere)
    }
  }
  syncMarkerGizmo()
}
watch(
  () => [riderStore.open, riderStore.step, riderStore.result, riderStore.worldPoints, riderStore.excluded, riderStore.adjust, riderStore.selectedKeys],
  updateRiderPreview,
  { deep: true },
)

// --- crowd zone rectangles: the one being drawn, and the outline of the selected zone -----------------

let zonePreview: LinesMesh | undefined
let zoneOutline: LinesMesh | undefined

/** A rectangle lying on a plane, as a line loop (the same mesh is updated in place when there is one). */
function rectangle(
  existing: LinesMesh | undefined,
  name: string,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y: number,
  color: Color3,
): LinesMesh | undefined {
  if (!scene) return existing
  const points = [new Vector3(x0, y, z0), new Vector3(x1, y, z0), new Vector3(x1, y, z1), new Vector3(x0, y, z1), new Vector3(x0, y, z0)]
  if (existing) return MeshBuilder.CreateLines(name, { points, instance: existing })
  const mesh = MeshBuilder.CreateLines(name, { points, updatable: true }, scene)
  mesh.color = color
  mesh.isPickable = false
  mesh.renderingGroupId = 1
  return mesh
}

function updateZonePreview(first: [number, number, number]) {
  const point = planePointUnderPointer(first[1])
  if (!point) return
  zonePreview = rectangle(zonePreview, 'crowd-preview', first[0], first[2], point.x, point.z, first[1] + 0.03, new Color3(1, 0.85, 0.5))
  zonePreview?.setEnabled(true)
}

function updateZoneOutline() {
  const zone = crowdStore.zones.find((z) => z.id === crowdStore.selectedId)
  if (!zone) return zoneOutline?.setEnabled(false)
  zoneOutline = rectangle(zoneOutline, 'crowd-outline', zone.x0, zone.z0, zone.x1, zone.z1, zone.y + 0.03, new Color3(0.6, 0.75, 1))
  zoneOutline?.setEnabled(true)
}

/** Aims the selected lights at the venue surface under the pointer. */
function aimAtPointer() {
  if (!scene || !venue) return
  const venueMeshes = new Set(venue.meshes)
  const hit = scene.pick(scene.pointerX, scene.pointerY, (mesh) => venueMeshes.has(mesh))
  if (!hit?.hit || !hit.pickedPoint) return
  rig.aimAt(hit.pickedPoint.asArray())
}

/** Points the lights that were aimed at the aim point (again), with the current spread and fan. */
function applyAim() {
  if (!fixtureRig || !rig.aim.anchor) return
  const lights = rig.aim.ids.map((id) => rig.fixtures.find((f) => f.id === id)).filter((f): f is NonNullable<typeof f> => !!f)
  const result = solveAim(fixtureRig, lights, new Vector3(...rig.aim.anchor), { spread: rig.aim.spread, fan: rig.aim.fan })
  rig.applyAim(result.patches, result.unreachable)
}

/**
 * A crosshair lying on the surface under the pointer while aiming: a ring with four ticks, turned to the surface's
 * normal and sized with the distance so that it looks about the same size on screen near and far.
 */
let aimCursor: TransformNode | undefined
function ensureAimCursor(): TransformNode | undefined {
  if (aimCursor || !scene) return aimCursor
  const color = new Color3(0.7, 0.85, 1)
  const material = new StandardMaterial('aim-cursor-mat', scene)
  material.disableLighting = true
  material.emissiveColor = color
  const root = new TransformNode('aim-cursor', scene)
  const ring = MeshBuilder.CreateTorus('aim-cursor-ring', { diameter: 1, thickness: 0.03, tessellation: 48 }, scene)
  ring.material = material
  ring.parent = root
  const ticks = MeshBuilder.CreateLineSystem(
    'aim-cursor-ticks',
    {
      lines: [
        [new Vector3(-0.85, 0, 0), new Vector3(-0.3, 0, 0)],
        [new Vector3(0.3, 0, 0), new Vector3(0.85, 0, 0)],
        [new Vector3(0, 0, -0.85), new Vector3(0, 0, -0.3)],
        [new Vector3(0, 0, 0.3), new Vector3(0, 0, 0.85)],
      ],
    },
    scene,
  )
  ticks.color = color
  ticks.parent = root
  for (const mesh of [ring, ticks]) {
    mesh.isPickable = false
    mesh.renderingGroupId = 1 // drawn over the scene, so haze and the beams never hide it
  }
  root.rotationQuaternion = new Quaternion()
  root.setEnabled(false)
  aimCursor = root
  return root
}

function hideAimCursor() {
  aimCursor?.setEnabled(false)
}

/** The crosshair on the surface shows in every click mode but placing, which has only the crosshair pointer. */
function showsAimCursor() {
  return !!interaction.mode && interaction.mode.kind !== 'place'
}

function updateAimCursor() {
  if (!scene || !venue || !camera) return
  const cursor = ensureAimCursor()
  if (!cursor) return
  const hit = pickVenue()
  if (!hit?.pickedPoint) return hideAimCursor()
  const normal = hit.getNormal(true, true) ?? Vector3.Up()
  if (hit.ray && Vector3.Dot(normal, hit.ray.direction) > 0) normal.scaleInPlace(-1) // double-sided surfaces: face the viewer
  const unit = normal.normalizeToNew()
  const distance = Vector3.Distance(camera.position, hit.pickedPoint)
  cursor.position.copyFrom(hit.pickedPoint.add(unit.scale(0.004)))
  cursor.rotationQuaternion = Quaternion.FromUnitVectorsToRef(Vector3.Up(), unit, new Quaternion())
  cursor.scaling.setAll(Math.max(0.12, distance * 0.07))
  cursor.setEnabled(true)
}

/** A small marker on the aim point while it belongs to the selection. */
let aimMarker: Mesh | undefined
function updateAimMarker() {
  if (!scene) return
  if (!aimMarker) {
    aimMarker = MeshBuilder.CreateSphere('aim-marker', { diameter: 0.14, segments: 12 }, scene)
    const material = new StandardMaterial('aim-marker-mat', scene)
    material.disableLighting = true
    material.emissiveColor = new Color3(0.6, 0.75, 1)
    aimMarker.material = material
    aimMarker.isPickable = false
  }
  const anchor = rig.aim.anchor
  aimMarker.setEnabled(!!anchor && rig.aimActive)
  if (anchor) aimMarker.position.set(anchor[0], anchor[1], anchor[2])
}

/** Puts a fixture on the venue surface under the pointer, hanging from ceilings and standing on floors. */
function placeFixture() {
  if (!scene || !venue) return
  const venueMeshes = new Set(venue.meshes)
  const hit = scene.pick(scene.pointerX, scene.pointerY, (mesh) => venueMeshes.has(mesh))
  if (!hit?.hit || !hit.pickedPoint) return
  const normal = hit.getNormal(true, true) ?? Vector3.Up()
  // Venue surfaces are double sided: make sure the normal faces the viewer.
  if (hit.ray && Vector3.Dot(normal, hit.ray.direction) > 0) normal.scaleInPlace(-1)
  const point = hit.pickedPoint.add(normal.scale(0.003))
  // The base sits on the surface: turn the fixture so its local +Y (away from the mount) follows the surface normal.
  const unit = normal.normalizeToNew()
  const rotation =
    unit.y < -0.9999
      ? Quaternion.RotationAxis(Vector3.Right(), Math.PI) // exactly upside down: the shortest-arc turn is ambiguous
      : Quaternion.FromUnitVectorsToRef(Vector3.Up(), unit, new Quaternion())
  rig.placeAt({ position: point.asArray(), mount: unit.y < 0 ? 'hanging' : 'standing', rotation: rotation.asArray() })
}

// --- rotation snapping, tick marks and readout --------------------------------

type RotationAxis = 'x' | 'y' | 'z'
let snapping = false
let activeRotation: RotationAxis | null = null
const tickMeshes: Partial<Record<RotationAxis, LinesMesh>> = {}

/**
 * Tick marks around the ring, one per snap step: short for each step, longer every 15 degrees and
 * longest every 90. Built in the local frame of the gizmo's angle display plane (ring radius 0.3).
 */
function createTickMarks(utilityScene: Scene): LinesMesh {
  const stepsPerTurn = Math.round(360 / SNAP_DEGREES)
  const lines: Vector3[][] = []
  for (let k = 0; k < stepsPerTurn; k++) {
    const degrees = k * SNAP_DEGREES
    const [inner, outer] = degrees % 90 === 0 ? [0.19, 0.41] : degrees % 15 === 0 ? [0.25, 0.35] : [0.275, 0.325]
    const a = (degrees * Math.PI) / 180
    lines.push([new Vector3(Math.cos(a) * inner, Math.sin(a) * inner, 0), new Vector3(Math.cos(a) * outer, Math.sin(a) * outer, 0)])
  }
  const ticks = MeshBuilder.CreateLineSystem('rotation-ticks', { lines }, utilityScene)
  ticks.color.set(1, 1, 1)
  ticks.isPickable = false
  ticks.alwaysSelectAsActiveMesh = true
  return ticks
}

/** Gizmo internals this relies on (Babylon keeps them private): the angle display plane and the drag's start angle. */
interface RotationRingInternals {
  _rotationDisplayPlane: Mesh
  _angles: Vector3
}

function setupRotationFeedback(rotationGizmo: NonNullable<GizmoManager['gizmos']['rotationGizmo']>) {
  const rings: Record<RotationAxis, typeof rotationGizmo.xGizmo> = {
    x: rotationGizmo.xGizmo,
    y: rotationGizmo.yGizmo,
    z: rotationGizmo.zGizmo,
  }
  for (const axis of ['x', 'y', 'z'] as const) {
    const ring = rings[axis]
    const internals = ring as unknown as RotationRingInternals
    const ticks = createTickMarks(ring.gizmoLayer.utilityLayerScene)
    ticks.parent = internals._rotationDisplayPlane // inherits its placement, scale and visibility
    ticks.setEnabled(false)
    tickMeshes[axis] = ticks

    ring.dragBehavior.onDragStartObservable.add(() => {
      activeRotation = axis
      // The angle display starts at the drag's start angle; line the marks up with it so every
      // snapped position lands exactly on a mark.
      ticks.rotation.z = internals._angles.x - Math.PI
      updateReadout(axis, ring.angle)
      refreshRotationFeedback()
    })
    ring.dragBehavior.onDragObservable.add(() => updateReadout(axis, ring.angle))
    ring.dragBehavior.onDragEndObservable.add(() => {
      activeRotation = null
      rig.rotationReadout = null
      refreshRotationFeedback()
    })
  }
}

function updateReadout(axis: RotationAxis, radians: number) {
  const degrees = (radians * 180) / Math.PI
  rig.rotationReadout = {
    axis,
    degrees: Math.abs(degrees) < 0.05 ? 0 : degrees,
    snapping,
    x: scene?.pointerX ?? 0,
    y: scene?.pointerY ?? 0,
  }
}

function setSnapping(on: boolean) {
  if (snapping === on) return
  snapping = on
  const rotationGizmo = gizmo?.gizmos.rotationGizmo
  if (rotationGizmo) rotationGizmo.snapDistance = on ? SNAP_STEP : 0
  refreshRotationFeedback()
}

function refreshRotationFeedback() {
  for (const axis of ['x', 'y', 'z'] as const) tickMeshes[axis]?.setEnabled(activeRotation === axis && snapping)
  if (rig.rotationReadout) rig.rotationReadout = { ...rig.rotationReadout, snapping }
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

function applyGizmoMode(mode: 'move' | 'rotate') {
  if (!gizmo) return
  gizmo.positionGizmoEnabled = mode === 'move'
  gizmo.rotationGizmoEnabled = mode === 'rotate'
}

/** Renders the current view offscreen at `scale` times its size, without selection outline or gizmo. */
async function screenshot(scale: number) {
  if (!engine || !scene || !camera || !fixtureRig || !pipeline) throw new Error('viewer not ready')
  const size = planShot(engine, canvas.value!, scale)
  const selected = [...rig.selectedIds]
  fixtureRig.setSelected([])
  fixtureRig.setStrobeHold(true) // a picture shows strobing lights lit, not caught between flashes
  crowdScene?.setHold(true) // and the crowd standing still
  gizmo?.attachToNode(null)
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
    attachGizmo()
  }
}

// --- group selection: one gizmo for several lights ----------------------------

function selectedRoots() {
  return rig.selectedIds.map((id) => ({ id, root: fixtureRig?.rootOf(id) })).filter((x): x is { id: string; root: TransformNode } => !!x.root)
}

/** Attaches the gizmo to the selected light, or to the pivot at the middle of several (turned back to neutral). */
function attachGizmo() {
  if (!gizmo || !pivot) return
  const roots = selectedRoots()
  if (roots.length === 0) {
    gizmo.attachToNode(null)
  } else if (roots.length === 1) {
    gizmo.attachToNode(roots[0].root)
  } else {
    const centre = Vector3.Zero()
    for (const { root } of roots) centre.addInPlace(root.position)
    pivot.position.copyFrom(centre.scaleInPlace(1 / roots.length))
    pivot.rotationQuaternion?.copyFromFloats(0, 0, 0, 1)
    gizmo.attachToNode(pivot)
  }
}

function beginGroupDrag() {
  if (!pivot || rig.selectedIds.length < 2) return
  groupStart = {
    pivot: pivot.position.clone(),
    items: selectedRoots().map(({ id, root }) => ({
      id,
      root,
      position: root.position.clone(),
      rotation: (root.rotationQuaternion ?? Quaternion.Identity()).clone(),
    })),
  }
}

/** Carries every light along with the pivot: its movement, and its turn about the pivot's position. */
function applyGroupDrag() {
  quality?.touch()
  if (!pivot || !groupStart) return
  const turn = pivot.rotationQuaternion ?? Quaternion.Identity()
  const offset = new Vector3()
  for (const item of groupStart.items) {
    item.position.subtractToRef(groupStart.pivot, offset)
    offset.rotateByQuaternionToRef(turn, offset)
    item.root.position.copyFrom(pivot.position).addInPlace(offset)
    item.root.rotationQuaternion = turn.multiply(item.rotation)
  }
}

function endGroupDrag(rotated: boolean) {
  applyGroupDrag()
  const start = groupStart
  groupStart = null
  if (!start) return
  for (const { id, root } of start.items) {
    const position = root.position.asArray()
    if (rotated && root.rotationQuaternion) {
      rig.update(id, { position, rotation: root.rotationQuaternion.normalizeToNew().asArray() })
    } else {
      rig.update(id, { position })
    }
  }
  attachGizmo() // the pivot moves to the lights' new centre
}

watch(
  () => props.modelUrl,
  (url) => showModel(url),
)
watch(() => venues.current?.hiddenTags, applyTags, { deep: true })
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
  (mode) => applyGizmoMode(mode),
)
// After an undo or redo the lights may have moved while the selection stayed the same: put the gizmo back on them.
watch(
  () => rig.historyVersion,
  () => attachGizmo(),
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
    attachGizmo()
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
    if (!first) zonePreview?.setEnabled(false)
  },
)
watch(showsAimCursor, (on) => (on ? updateAimCursor() : hideAimCursor()))
watch(() => [rig.aim.anchor, rig.aimActive], updateAimMarker)
watch(
  () => settings.ambient,
  (value) => {
    quality?.touch()
    if (ambient) ambient.intensity = value
  },
)
watch(
  () => settings.fov,
  (degrees) => {
    if (camera) camera.fov = (degrees * Math.PI) / 180
  },
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
  markerGizmo?.dispose()
  markerUtility?.dispose()
  for (const marker of riderMarkers.values()) marker.dispose()
  leaveTopDown?.()
  leaveTopDown = null
  riderStore.ceilingAt = null
  for (const marker of riderRefMarkers) marker.dispose()
  bridge.api = null
  window.removeEventListener('resize', onResize)
  resizeObserver?.disconnect()
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('keyup', onKey)
  loadToken++
  stopTween()
  window.removeEventListener('pagehide', flushPose)
  window.removeEventListener('blur', onBlur)
  flushPose()
  clearInterval(statsTimer)
  pipeline?.dispose()
  quality?.dispose()
  pivot?.dispose()
  gizmo?.dispose()
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
