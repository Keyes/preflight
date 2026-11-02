import {
  BaseTexture,
  ClusteredLightContainer,
  Color3,
  Constants,
  DepthRenderer,
  FreeCamera,
  Light,
  Mesh,
  MeshBuilder,
  Quaternion,
  Ray,
  RenderTargetTexture,
  Scene,
  ShadowGenerator,
  SpotLight,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector2,
  Vector3,
  VertexData,
  VertexBuffer,
  type AbstractMesh,
  type ShaderMaterial,
} from '@babylonjs/core'
import type { Fixture } from '../api'
import { beamAngleDegrees, candela, focusDistance, goboSpinTurns, profileFor, strobeHz, travelDegrees } from '../fixtures/profiles'
import type { Absorber } from '../crowdModel'
import { createBeamMaterial } from './beamMaterial'
import { goboBlurLevel, GoboProjection, goboIndex } from './goboLibrary'
import { buildModel, modelKey, type ModelLayout, type ModelSpec } from './fixtureModel'

const BEAM_LENGTH = 25
const CONE_SEGMENTS = 48
/** How much wider than the true beam the bounding hull is (see hullVertexData). */
const HULL_MARGIN = 1.6
/**
 * Candela is compressed with a square root before it becomes light intensity. Real beam
 * intensities span a huge range (a tight beam is ~30x a wide one) which a display can't show
 * without exposure control; this keeps zoom changes visible without clipping everything.
 */
const LIGHT_SCALE = 0.4
/** The lens is rendered brighter than white (the pipeline works in high dynamic range) so bloom makes it glow. */
const LENS_GLOW = 3
/** The part of each strobe cycle in which the light is on. */
const STROBE_DUTY = 0.35
/** Beams fade out over this many meters before they reach a surface (when soft intersections are on). */
const SOFT_DISTANCE = 0.6
/**
 * Clustered lighting culls each light to the tiles within this radius of it, so it must be finite
 * (the default is unbounded, which would defeat the culling). The venue is far smaller than this.
 */
const LIGHT_RANGE = 40

/** How strongly focus blurs the beam edge away from the focus distance (1 is the plain geometry of a lens of the lens mesh's size). */
const FOCUS_BLUR = 2.5
/** The softest and sharpest spotlight edge on surfaces, as the fraction of the beam radius that fades out. */
const MIN_EDGE = 0.02
const MAX_EDGE = 0.5 // keep in sync with EDGE_MAX in beamMaterial.ts

/** How many lights can cast shadows at once (each is a regular light with its own shadow map, outside the clustered system). */
export const MAX_SHADOW_LIGHTS = 10
/**
 * How many lights can project a gobo pattern onto surfaces at once. The clustered system cannot carry textures, so each
 * of these is a regular light too (and a light that also casts shadows only counts once).
 */
export const MAX_GOBO_LIGHTS = 4
/** Most lights that can be outside the clustered system at once. */
export const MAX_REGULAR_LIGHTS = MAX_SHADOW_LIGHTS + MAX_GOBO_LIGHTS
/** Resolution of each light's shadow map. */
const SHADOW_MAP_SIZE = 1024
/** After the last change, every light's shadows are refreshed once more this long after, so shadows cast by a moved fixture's body on the other lights catch up. */
const SHADOW_SETTLE_MS = 150
/** The beam's own view of the scene (for shadows in the haze) is rendered at this size. The beam shader jitters by 2 texels of 1024. */
const BEAM_SHADOW_SIZE = 1024
/** The lens view of the scene for haze shadows covers at most this half field of view (a tangent: 80 degrees) so very wide beams stay a drawable perspective view. */
const MAX_BEAM_VIEW_TAN = Math.tan((80 * Math.PI) / 180)
/** A point in the haze counts as shadowed once it is this many meters behind the first solid surface seen from the lens. */
const BEAM_SHADOW_BIAS = 0.08

const rad = (deg: number) => (deg * Math.PI) / 180

interface FixtureNode {
  root: TransformNode
  pan: TransformNode
  tilt: TransformNode
  light: SpotLight
  lens: Mesh
  lensMaterial: StandardMaterial
  cone: Mesh
  beamMaterial: ShaderMaterial
  body: Mesh[]
  /** what the body was last built for (see fixtureModel) */
  modelKey: string
  /** the beam leaves through a disc of this radius, meters */
  lensRadius: number
  /** for a strip-shaped lens: how far that disc slides either way along the strip, meters (0 for a round lens) */
  lensHalfLength: number
  /** extra spot lights spread along a strip-shaped lens, so the light on surfaces is a sheet too */
  extras: SpotLight[]
  /** a fixed edge softness for fixtures without focus optics, or -1 when the focus sets it (see FixtureProfile.edge) */
  edgeFixed: number
  /** distance from the tilt axis to the lens plane, meters */
  headHalf: number
  /** half angle the cone geometry was last built for */
  coneHalfAngle: number
  /** where the beam hits a surface, meters from the lens (the beam length when it hits nothing) */
  aimDistance: number
  /** what the fixture looked like when it was last applied, to tell whether it changed */
  poseKey: string
  /** its shadows need re-rendering */
  shadowDirty: boolean
  /** set when the aim changed: counts down frames so world matrices are up to date before measuring */
  aimStale: number
  focusDistance: number
  /** flashes per second (0 for a steady light) */
  strobeHz: number
  /** how much of its light the fixture shows right now: 1 when steady or in the lit part of a flash, 0 between flashes */
  gate: number
  /** what the fixture shows when the gate is fully open (the strobe scales these) */
  lit: { total: number; intensity: number; lightOn: boolean; lensLit: Color3; lensOff: Color3; strength: number; coneOn: boolean }
  /** the light is outside the clustered system (it casts shadows or projects a gobo) */
  regular: boolean
  /** which gobo pattern is in the beam (0-based), or -1 for none, and how it is turned */
  goboPattern: number
  goboAngle: number
  goboSpin: number
  /** the light projects the pattern onto surfaces (there is a limit, see MAX_GOBO_LIGHTS) */
  projected: boolean
  projection: GoboProjection | null
  /** how soft the beam's edge is at the surface it hits (fraction of the beam radius) */
  edge: number
  /** the light's cone angle when its shadows were last rendered (the shadow map covers that cone) */
  shadowAngle: number
  /** present while this fixture's light casts shadows */
  shadow: ShadowGenerator | null
  /** the scene as seen from the lens, for shadows inside the beam (present together with `shadow`) */
  beamShadow: { camera: FreeCamera; depth: DepthRenderer } | null
}

/**
 * A closed hull around the beam: a truncated cone that starts at the lens plane (at the origin, with the lens
 * radius) and opens along +Y for `length` meters, closed with a cap at each end. It is made wider than the beam by
 * HULL_MARGIN so its (polygonal) outline always lies outside the beam's true, smooth edge. The beam shader only
 * uses the hull to decide which pixels to shade and computes the actual beam shape itself, so the hull's
 * tessellation is never visible.
 */
function hullVertexData(halfAngle: number, length: number, lensRadius: number, halfLength: number): VertexData {
  const startRadius = lensRadius * HULL_MARGIN
  const endRadius = (lensRadius + Math.tan(halfAngle) * length) * HULL_MARGIN
  const n = CONE_SEGMENTS
  const positions: number[] = []
  // For a strip-shaped lens each half of the ring is centered on one end of the strip: a round-ended outline.
  const end = (phi: number) => (Math.cos(phi) >= 0 ? halfLength : -halfLength)
  for (let i = 0; i < n; i++) {
    const phi = (i / n) * Math.PI * 2
    positions.push(startRadius * Math.cos(phi) + end(phi), 0, startRadius * Math.sin(phi))
  }
  for (let i = 0; i < n; i++) {
    const phi = (i / n) * Math.PI * 2
    positions.push(endRadius * Math.cos(phi) + end(phi), length, endRadius * Math.sin(phi))
  }
  positions.push(0, 0, 0, 0, length, 0) // centers of the start and end caps
  const startCap = 2 * n
  const endCap = 2 * n + 1
  const indices: number[] = []
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    indices.push(i, n + i, n + j, i, n + j, j) // side
    indices.push(startCap, j, i) // start cap
    indices.push(endCap, n + i, n + j) // end cap
  }
  const data = new VertexData()
  data.positions = positions
  data.indices = indices
  return data
}

/** Builds and updates the 3D representation (body, spot light, beam) of the placed fixtures. */
export class FixtureRig {
  private nodes = new Map<string, FixtureNode>()
  private bodyMaterial: StandardMaterial
  private selectedIds = new Set<string>()
  /**
   * All spot lights live in one clustered container (forward+ lighting) so the rig is not limited
   * by how many lights a material can loop over. Null when the GPU/engine can't do it or it is
   * switched off; lights are then plain scene lights with physical falloff and a hard cap.
   */
  readonly clustered: ClusteredLightContainer | null

  // Scene depth for the beam shader, so beams can fade softly where they meet surfaces.
  private depthTexture: BaseTexture | null = null
  private softBeams = false
  /** shared with every beam material, so changing it updates them all */
  private screenSize = new Vector2(1, 1)

  // Shadows: only a limited number of lights cast them, each as a regular light with a shadow map.
  private shadowsEnabled = false
  private venueMeshes: AbstractMesh[] = []
  private venueMeshSet = new Set<AbstractMesh>()
  /** every shadow needs re-rendering (the venue or the set of casters changed) */
  private shadowsDirty = false
  /** when to refresh all shadows once a burst of edits has stopped (0 for none pending) */
  private settleAt = 0
  /** called when the set of shadow-casting fixtures changes, with their ids */
  onShadowedChange: ((ids: string[]) => void) | null = null
  private shadowedIds: string[] = []

  constructor(
    private scene: Scene,
    useClustering = true,
  ) {
    const container = useClustering ? new ClusteredLightContainer('fixture-lights', [], scene) : null
    if (container && !container.isSupported) {
      container.dispose()
      this.clustered = null
    } else {
      this.clustered = container
    }

    this.bodyMaterial = new StandardMaterial('fixture-body', scene)
    this.bodyMaterial.diffuseColor = new Color3(0.07, 0.07, 0.08)
    this.bodyMaterial.specularColor = new Color3(0.25, 0.25, 0.28)
  }

  private surfaceGain = 1

  /** Scales how strongly the lights illuminate surfaces (the beams in haze are unaffected). */
  setSurfaceGain(gain: number) {
    this.surfaceGain = gain
  }

  /** Makes the scene match the fixtures list: creates, updates and removes as needed. */
  sync(fixtures: readonly Fixture[], haze: number) {
    const live = new Set(fixtures.map((f) => f.id))
    for (const id of [...this.nodes.keys()]) if (!live.has(id)) this.remove(id)
    for (const fixture of fixtures) {
      const node = this.nodes.get(fixture.id) ?? this.create(fixture)
      this.apply(node, fixture, haze)
    }
    this.assignShadows(fixtures)
    this.assignProjection(fixtures)
    this.applySelection()
    if (this.hidden) this.applyHidden() // fixtures that appeared while hidden
  }

  /** The fixtures' bodies and beams are not drawn (their light on the venue stays), for views where they are in the way. */
  private hidden = false

  setHidden(hidden: boolean) {
    this.hidden = hidden
    this.applyHidden()
  }

  private applyHidden() {
    for (const node of this.nodes.values()) for (const mesh of node.root.getChildMeshes(false)) mesh.isVisible = !this.hidden
  }

  /** Turns shadows on or off for the rig (the per-fixture choice and the limit still apply). */
  setShadows(enabled: boolean) {
    this.shadowsEnabled = enabled
  }

  /** The venue's meshes, which both cast and receive shadows. */
  setVenueMeshes(meshes: readonly AbstractMesh[]) {
    this.venueMeshes = [...meshes]
    this.venueMeshSet = new Set(meshes)
    for (const node of this.nodes.values()) node.aimStale = 2
    this.refreshShadowCasters()
    this.shadowsDirty = true
  }

  /**
   * Finds where each changed light's beam hits a surface, which sets how soft its edge looks there (the spotlight
   * lighting surfaces cannot blur with distance, so it takes the softness at the distance the beam is aimed at).
   */
  private measureAims() {
    for (const node of this.nodes.values()) {
      if (node.aimStale <= 0) continue
      if (--node.aimStale > 0) continue
      const origin = node.light.getAbsolutePosition()
      const direction = Vector3.TransformNormal(node.light.direction, node.light.getWorldMatrix()).normalize()
      const hit = this.scene.pickWithRay(new Ray(origin, direction, BEAM_LENGTH), (m) => this.venueMeshSet.has(m))
      node.aimDistance = hit?.hit && hit.distance > 0.1 ? hit.distance : BEAM_LENGTH
      this.applyEdgeSoftness(node)
    }
  }

  /** The spotlight's cone: its edge fades over the same part of the radius, around the geometric edge, as the beam in haze does at the aimed distance. */
  private applyEdgeSoftness(node: FixtureNode) {
    const tanHalf = Math.tan(node.coneHalfAngle)
    const beamRadius = node.lensRadius + tanHalf * node.aimDistance
    const blur = (FOCUS_BLUR * node.lensRadius * Math.abs(node.aimDistance - node.focusDistance)) / node.focusDistance
    const edge = node.edgeFixed >= 0 ? Math.min(MAX_EDGE, node.edgeFixed) : Math.min(MAX_EDGE, Math.max(MIN_EDGE, blur / beamRadius + MIN_EDGE))
    node.edge = edge
    if (node.projected && node.projection) {
      // The light's cone is as wide as the soft edge reaches, and the pattern must keep the beam's own size inside it.
      // (The picture is mirrored: the light looks along the beam with its right where the beam's local x points left.)
      // The haze projects the pattern from the beam's apex, behind the lens, and this light sits at the lens: the scale is
      // matched at the surface the beam hits.
      const reach = node.aimDistance / (node.aimDistance + node.lensRadius / tanHalf)
      node.projection.texture.uScale = -(1 + edge) * reach
      node.projection.texture.vScale = (1 + edge) * reach
      node.projection.show(node.goboPattern, goboBlurLevel(edge))
    }
    const angle = 2 * Math.atan(tanHalf * (1 + edge))
    // The shadow map covers the light's cone, and a light looks its shadows up with its cone as it is now. The measured
    // aim (a couple of frames after load, or when something moves in the beam) changes the soft edge and with it the
    // cone, so shadows rendered before that no longer line up: render them again.
    if (Math.abs(node.light.angle - angle) > 1e-4) node.shadowDirty = true
    for (const light of [node.light, ...node.extras]) {
      light.angle = angle
      light.innerAngle = 2 * Math.atan(tanHalf * (1 - edge))
    }
  }

  /**
   * Call once per frame. A fixture that was just edited gets its shadows re-rendered in that very frame, so they follow
   * the light without lagging behind. The other lights' shadows only change when something moves in front of them, so
   * they are refreshed once when the edits have stopped.
   */
  update() {
    // With animations off, time stands still: the haze stops drifting, gobos stop turning, and strobes show steady light.
    if (this.animate) this.clock = (performance.now() / 1000) % 7200
    const time = this.clock
    for (const node of this.nodes.values()) node.beamMaterial.setFloat('hazeTime', time)
    this.updateStrobes(time)
    for (const node of this.nodes.values()) if (node.projected) this.updateProjectionFrame(node, time)
    this.measureAims()
    let changed = false
    let all = this.shadowsDirty
    this.shadowsDirty = false
    for (const node of this.nodes.values()) {
      if (all || node.shadowDirty) {
        node.shadowDirty = false
        this.refreshShadow(node)
        changed = true
      }
    }
    const now = performance.now()
    if (changed && !all) {
      this.settleAt = now + SHADOW_SETTLE_MS
    } else if (this.settleAt && now >= this.settleAt) {
      this.settleAt = 0
      for (const node of this.nodes.values()) this.refreshShadow(node)
    }
  }

  private refreshShadow(node: FixtureNode) {
    node.shadowAngle = node.light.angle
    node.shadow?.getShadowMap()?.resetRefreshCounter()
    this.renderBeamViewOnce(node)
  }

  /**
   * The beam's view of the scene is a depth renderer, which Babylon renders every frame while it is enabled
   * (its refresh rate is not honoured), so it is kept disabled and enabled for exactly one render when needed.
   */
  private renderBeamViewOnce(node: FixtureNode) {
    const shadow = node.beamShadow
    if (!shadow) return
    shadow.depth.enabled = true
    shadow.depth.getDepthMap().onAfterRenderObservable.addOnce(() => {
      shadow.depth.enabled = false
    })
  }

  /** The depth map (camera-space distance per pixel) the beams fade against. */
  setDepth(texture: BaseTexture | null) {
    this.depthTexture = texture
    for (const node of this.nodes.values()) this.applyDepth(node.beamMaterial, !!node.beamShadow)
  }

  setSoftBeams(on: boolean) {
    this.softBeams = on
    for (const node of this.nodes.values()) this.applyDepth(node.beamMaterial, !!node.beamShadow)
  }

  /** Render size in pixels, which the beam shader needs to look up the depth map. */
  setScreenSize(width: number, height: number) {
    this.screenSize.set(width, height)
  }

  setSelected(ids: readonly string[]) {
    this.selectedIds = new Set(ids)
    this.applySelection()
  }

  rootOf(id: string): TransformNode | undefined {
    return this.nodes.get(id)?.root
  }

  /** Where the beam turns: the tilt axis in world space (the lens lies on the line from here along the beam). */
  pivotOf(id: string): Vector3 | undefined {
    const node = this.nodes.get(id)
    if (!node) return undefined
    node.root.computeWorldMatrix(true)
    node.pan.computeWorldMatrix(true)
    return Vector3.TransformCoordinates(Vector3.Zero(), node.tilt.computeWorldMatrix(true))
  }

  /** The direction the beam points in right now, in world space. */
  beamDirectionOf(id: string): Vector3 | undefined {
    const node = this.nodes.get(id)
    if (!node) return undefined
    node.root.computeWorldMatrix(true)
    node.pan.computeWorldMatrix(true)
    return Vector3.TransformNormal(Vector3.Up(), node.tilt.computeWorldMatrix(true)).normalize()
  }

  fixtureIdOf(mesh: AbstractMesh | null | undefined): string | undefined {
    return (mesh?.metadata as { fixtureId?: string } | null | undefined)?.fixtureId
  }

  get count() {
    return this.nodes.size
  }

  /** How many fixture lights can light a surface at once: unlimited-ish when clustered, else the material cap. */
  get lightLimit() {
    return this.clustered ? Infinity : 32
  }

  dispose() {
    for (const id of [...this.nodes.keys()]) this.remove(id)
    this.bodyMaterial.dispose()
    this.clustered?.dispose()
  }

  // --- internals -------------------------------------------------------------

  private create(fixture: Fixture): FixtureNode {
    const id = fixture.id
    const scene = this.scene
    const meta = { fixtureId: id }

    const root = new TransformNode(`fixture-${id}`, scene)
    const pan = new TransformNode(`fixture-pan-${id}`, scene)
    pan.parent = root
    const tilt = new TransformNode(`fixture-tilt-${id}`, scene)
    tilt.parent = pan

    const lensMaterial = new StandardMaterial(`fx-lens-mat-${id}`, scene)
    lensMaterial.disableLighting = true
    const model = profileFor(fixture.profileId).model
    const built = buildModel({ scene, id, root, pan, tilt, bodyMaterial: this.bodyMaterial, lensMaterial, metadata: meta }, model)
    const { layout, lens } = built
    pan.position.y = layout.baseHeight
    tilt.position.y = layout.tiltHeight

    const light = new SpotLight(`fx-light-${id}`, new Vector3(0, layout.headHalf + 0.02, 0), new Vector3(0, 1, 0), rad(30), 1, scene)
    light.parent = tilt
    if (this.clustered) {
      // The clustered system only accepts the default falloff type; the venue's PBR materials
      // apply their own falloff to clustered lights (glTF falloff, set in the viewer: inverse-square, with a sharp-edged cone).
      light.range = LIGHT_RANGE
      this.clustered.addLight(light)
    } else {
      light.falloffType = Light.FALLOFF_GLTF
    }

    const cone = new Mesh(`fx-beam-${id}`, scene)
    hullVertexData(rad(15), BEAM_LENGTH, layout.lensRadius, layout.lensHalfLength).applyToMesh(cone, true)
    cone.parent = tilt
    cone.position.y = layout.headHalf + 0.01
    cone.isPickable = false
    cone.alwaysSelectAsActiveMesh = true
    const beamMaterial = createBeamMaterial(scene, `fx-beam-mat-${id}`)
    beamMaterial.setFloat('beamLength', BEAM_LENGTH)
    beamMaterial.setFloat('lensRadius', layout.lensRadius)
    beamMaterial.setFloat('lensHalfLength', layout.lensHalfLength)
    beamMaterial.setFloat('hazeMotion', this.hazeWisps)
    beamMaterial.setFloat('hazeTime', 0)
    beamMaterial.setFloat('edgeFixed', -1)
    this.applyDepth(beamMaterial)
    beamMaterial.setFloat('shadowEnabled', 0)
    beamMaterial.setFloat('shadowBias', BEAM_SHADOW_BIAS)
    cone.material = beamMaterial

    const node: FixtureNode = {
      root,
      pan,
      tilt,
      light,
      lens,
      lensMaterial,
      cone,
      beamMaterial,
      body: built.body,
      modelKey: modelKey(model),
      lensRadius: layout.lensRadius,
      lensHalfLength: layout.lensHalfLength,
      edgeFixed: -1,
      extras: [],
      headHalf: layout.headHalf,
      coneHalfAngle: rad(15),
      poseKey: '',
      shadowDirty: true,
      aimDistance: BEAM_LENGTH,
      aimStale: 2,
      focusDistance: 8,
      strobeHz: 0,
      gate: 1,
      regular: false,
      goboPattern: -1,
      goboAngle: 0,
      goboSpin: 0,
      projected: false,
      projection: null,
      edge: MIN_EDGE,
      lit: { total: 0, intensity: 0, lightOn: false, lensLit: new Color3(0, 0, 0), lensOff: new Color3(0, 0, 0), strength: 0, coneOn: false },
      shadowAngle: 0,
      shadow: null,
      beamShadow: null,
    }
    this.applyHullMode(node)
    this.syncExtras(node, layout)
    this.applyAbsorbers(node)
    this.applyVenueBounds(node)
    this.nodes.set(id, node)
    return node
  }

  /**
   * Makes the beam shader run once per pixel. A round hull is wound consistently, so the hardware can draw just the
   * faces seen from inside (from outside those are the far faces). A strip-shaped hull (bars, tubes) has seam faces
   * that are not wound consistently, so it is drawn with both faces and the shader drops the near one itself.
   */
  private applyHullMode(node: FixtureNode) {
    const strip = node.lensHalfLength > 0
    node.beamMaterial.backFaceCulling = !strip
    node.beamMaterial.cullBackFaces = false
    node.beamMaterial.setFloat('faceTest', strip ? 1 : 0)
  }

  private applyDepth(material: ShaderMaterial, hasOwnShadowView = false) {
    if (this.depthTexture) {
      material.setTexture('depthSampler', this.depthTexture)
      // A shader sampler must always have something bound: the scene depth stands in unless the beam has its own view.
      if (!hasOwnShadowView) material.setTexture('shadowSampler', this.depthTexture)
    }
    material.setVector2('screenSize', this.screenSize)
    material.setFloat('softDistance', this.depthTexture && this.softBeams ? SOFT_DISTANCE : 0)
  }

  /** 0 for an even haze, up to 1 for strongly varying wisps. */
  private hazeWisps = 0

  setHazeWisps(amount: number) {
    this.hazeWisps = amount
    for (const node of this.nodes.values()) node.beamMaterial.setFloat('hazeMotion', amount)
  }

  /**
   * Places the fixture's spot lights: one at the middle of the lens, and for a strip-shaped lens (bars, panels) a few
   * more spread along it, so the light on surfaces is a sheet like the beam in the haze. They share the fixture's light.
   */
  private syncExtras(node: FixtureNode, layout: ModelLayout) {
    for (const extra of node.extras) {
      this.clustered?.removeLight(extra)
      extra.dispose()
    }
    node.extras = []
    node.cone.rotation.y = layout.lensAxis === 'z' ? Math.PI / 2 : 0
    const id = node.root.name.slice('fixture-'.length)
    const y = layout.headHalf + 0.02
    const place = (light: SpotLight, offset: number) => {
      light.position.set(layout.lensAxis === 'x' ? offset : 0, y, layout.lensAxis === 'z' ? offset : 0)
    }
    place(node.light, 0)
    const half = layout.lensHalfLength
    const k = half > 0.02 ? Math.min(2, Math.max(1, Math.round(half / 0.25))) : 0
    for (let i = -k; i <= k; i++) {
      if (i === 0) continue
      const light = new SpotLight(`fx-light-${id}-${i}`, Vector3.Zero(), new Vector3(0, 1, 0), rad(30), 1, this.scene)
      light.parent = node.tilt
      place(light, (i / k) * half)
      if (this.clustered) {
        light.range = LIGHT_RANGE
        this.clustered.addLight(light)
      } else {
        light.falloffType = Light.FALLOFF_GLTF
      }
      node.extras.push(light)
    }
  }

  /** Rebuilds a fixture's body when its profile changed (for example once the catalog has loaded). */
  private ensureModel(node: FixtureNode, spec: ModelSpec) {
    const key = modelKey(spec)
    if (key === node.modelKey) return
    for (const mesh of node.body) mesh.dispose()
    const built = buildModel(
      {
        scene: this.scene,
        id: node.root.name.slice('fixture-'.length),
        root: node.root,
        pan: node.pan,
        tilt: node.tilt,
        bodyMaterial: this.bodyMaterial,
        lensMaterial: node.lensMaterial,
        metadata: { fixtureId: node.root.name.slice('fixture-'.length) },
      },
      spec,
    )
    const { layout } = built
    node.body = built.body
    node.lens = built.lens
    node.modelKey = key
    node.lensRadius = layout.lensRadius
    node.lensHalfLength = layout.lensHalfLength
    this.applyHullMode(node)
    node.headHalf = layout.headHalf
    node.pan.position.y = layout.baseHeight
    node.tilt.position.y = layout.tiltHeight
    this.syncExtras(node, layout)
    node.cone.position.y = layout.headHalf + 0.01
    node.beamMaterial.setFloat('lensRadius', layout.lensRadius)
    node.beamMaterial.setFloat('lensHalfLength', layout.lensHalfLength)
    node.coneHalfAngle = -1 // the beam hull starts at the lens, so it is rebuilt too
    this.applySelection()
    this.refreshShadowCasters()
    this.shadowsDirty = true
  }

  private apply(node: FixtureNode, fixture: Fixture, haze: number) {
    const profile = profileFor(fixture.profileId)
    const v = fixture.values
    const get = (key: string, fallback: number) => v[key] ?? profile.defaults[key] ?? fallback

    this.ensureModel(node, profile.model)
    const poseKey = JSON.stringify([
      fixture.position,
      fixture.rotation,
      fixture.yaw,
      fixture.mount,
      v,
      profile.id,
      profile.beamAngle,
      profile.panRange,
      profile.tiltRange,
    ])
    if (poseKey !== node.poseKey) {
      node.poseKey = poseKey
      node.shadowDirty = true // anything about a fixture may change what its shadow looks like
    }

    // placement: older fixtures only have a mount and a yaw (hanging ones are turned upside down)
    node.root.position.set(...fixture.position)
    if (fixture.rotation) {
      node.root.rotationQuaternion = Quaternion.FromArray(fixture.rotation)
    } else {
      const yaw = Quaternion.RotationAxis(Vector3.Up(), fixture.yaw)
      node.root.rotationQuaternion = fixture.mount === 'hanging' ? yaw.multiply(Quaternion.RotationAxis(Vector3.Right(), Math.PI)) : yaw
    }

    node.pan.rotation.y = rad(travelDegrees(get('pan', 0.5), profile.panRange))
    node.tilt.rotation.x = rad(travelDegrees(get('tilt', 0.5), profile.tiltRange))

    const dimmer = get('dimmer', 1)
    const angle = beamAngleDegrees(profile, get('zoom', 0.5))
    const color = new Color3(get('red', 1), get('green', 1), get('blue', 1))

    const lights = [node.light, ...node.extras]
    for (const light of lights) light.angle = rad(angle)
    node.focusDistance = focusDistance(get('focus', 0.5))
    node.edgeFixed = profile.edge
    node.beamMaterial.setFloat('edgeFixed', profile.edge)
    node.aimStale = Math.max(node.aimStale, 2)
    this.applyEdgeSoftness(node)
    for (const light of lights) {
      light.diffuse = color.toLinearSpace()
      light.specular = light.diffuse
    }
    node.lit.total = dimmer * Math.sqrt(candela(profile, angle)) * LIGHT_SCALE * this.surfaceGain
    node.lit.lightOn = profile.emitsLight && dimmer > 0.001
    this.applyLightSet(node)

    const linear = color.toLinearSpace()
    const dark = new Color3(0.02, 0.02, 0.025)
    node.lit.lensLit = profile.emitsLight ? linear.scale(Math.max(0.05, dimmer) * LENS_GLOW) : dark
    node.lit.lensOff = profile.emitsLight ? linear.scale(0.05 * LENS_GLOW) : dark
    node.strobeHz = profile.controls.strobe ? strobeHz(get('strobe', 0)) : 0
    if (!this.strobing(node)) node.gate = 1

    const half = rad(angle / 2)
    if (Math.abs(half - node.coneHalfAngle) > 1e-4) {
      const data = hullVertexData(half, BEAM_LENGTH, node.lensRadius, node.lensHalfLength)
      node.cone.updateVerticesData(VertexBuffer.PositionKind, data.positions!)
      node.cone.refreshBoundingInfo()
      node.coneHalfAngle = half
    }
    node.beamMaterial.setFloat('tanHalf', Math.tan(half))
    this.applyEdgeSoftness(node) // the cone angle may just have changed
    node.beamMaterial.setFloat('focusDistance', node.focusDistance)
    node.beamMaterial.setFloat('focusBlur', FOCUS_BLUR)
    const gobo = profile.controls.gobo ? goboIndex(get('gobo', 0)) : 0
    node.goboPattern = gobo - 1
    node.goboAngle = rad(get('goboAngle', 0) * 360)
    node.goboSpin = goboSpinTurns(get('goboSpin', 0.5))
    node.beamMaterial.setFloat('goboOn', gobo > 0 ? 1 : 0)
    node.beamMaterial.setFloat('goboLayer', Math.max(0, gobo - 1))
    node.beamMaterial.setFloat('goboAngle', node.goboAngle)
    node.beamMaterial.setFloat('goboSpin', node.goboSpin)
    // narrower beams concentrate the same light, so they read a bit brighter in haze
    const concentration = Math.sqrt(profile.beamAngle[1] / angle)
    node.beamMaterial.setColor3('beamColor', linear)
    node.lit.strength = haze * dimmer * 1.3 * concentration
    node.lit.coneOn = profile.emitsLight && haze > 0.01 && dimmer > 0.01
    this.applyGate(node)
    this.updateBeamShadow(node)
  }

  /**
   * The lights of a fixture that light surfaces: the middle one, and for a strip lens the others along it, which share
   * the fixture's output. A fixture that casts shadows has its shadow map on the middle light only, so it is lit from
   * there alone (the others would shine through whatever the shadow stops).
   */
  private applyLightSet(node: FixtureNode) {
    const spread = !node.shadow && node.extras.length > 0
    node.lit.intensity = node.lit.total / (spread ? node.extras.length + 1 : 1)
    node.light.setEnabled(node.lit.lightOn)
    for (const extra of node.extras) extra.setEnabled(node.lit.lightOn && spread)
    this.applyGate(node)
  }

  // --- strobe ------------------------------------------------------------------

  /** Whether strobing fixtures flash (otherwise they show steady light, so a rig can be looked at without flicker). */
  private strobePreview = false
  /** Holds every fixture in the lit part of its flash, for screenshots. */
  private strobeHold = false

  setStrobePreview(on: boolean) {
    this.strobePreview = on
    this.refreshGates()
  }

  setStrobeHold(on: boolean) {
    this.strobeHold = on
    this.refreshGates()
  }

  private strobing(node: FixtureNode) {
    return this.strobePreview && this.animate && !this.strobeHold && node.strobeHz > 0
  }

  /** False stops everything that moves with time: haze drift, gobo spin and strobe flashes (the lights show steady). */
  private animate = true
  /** The time the beams and gobos see (seconds); it stops while animations are off. */
  private clock = 0

  setAnimate(on: boolean) {
    this.animate = on
    this.refreshGates()
  }

  private refreshGates() {
    for (const node of this.nodes.values()) {
      if (!this.strobing(node)) node.gate = 1
      this.applyGate(node)
    }
  }

  /** Scales what the fixture shows (its lights, lens glow and beam) by the current gate. */
  private applyGate(node: FixtureNode) {
    const gate = node.gate
    const intensity = node.lit.intensity * gate
    // A light in the clustered container keeps shining when it is switched off (the container does not look at that), so a
    // light that is not to shine, whether the fixture is dark or the extra lights along a strip are out because the middle
    // light casts the shadows, gets an intensity of 0 as well.
    const spread = !node.shadow && node.extras.length > 0
    node.light.intensity = node.lit.lightOn ? intensity : 0
    for (const light of node.extras) light.intensity = node.lit.lightOn && spread ? intensity : 0
    node.lensMaterial.emissiveColor = Color3.Lerp(node.lit.lensOff, node.lit.lensLit, gate)
    node.beamMaterial.setFloat('strength', node.lit.strength * gate)
    node.cone.setEnabled(node.lit.coneOn && gate > 0.001)
  }

  /**
   * Where a strobing fixture is in its flash cycle. A flash is short (about a third of the cycle). When the frame rate
   * cannot show a flash at this rate (fewer than three frames to a cycle) the light would alias into a slow throb, so it
   * shows its average brightness instead.
   */
  private updateStrobes(time: number) {
    const fps = this.scene.getEngine().getFps()
    for (const node of this.nodes.values()) {
      if (!this.strobing(node)) continue
      const gate = fps / node.strobeHz < 3 ? STROBE_DUTY : (time * node.strobeHz) % 1 < STROBE_DUTY ? 1 : 0
      if (gate !== node.gate) {
        node.gate = gate
        this.applyGate(node)
      }
    }
  }

  // --- shadows -----------------------------------------------------------------

  /** Picks which fixtures cast shadows (those that want to, are lit, and fit in the limit) and switches the rest off. */
  private assignShadows(fixtures: readonly Fixture[]) {
    const wanted = new Set<string>()
    if (this.shadowsEnabled) {
      for (const fixture of fixtures) {
        if (wanted.size >= MAX_SHADOW_LIGHTS) break
        const profile = profileFor(fixture.profileId)
        const dimmer = fixture.values.dimmer ?? profile.defaults.dimmer ?? 1
        if (profile.emitsLight && fixture.castShadows !== false && dimmer > 0.001) wanted.add(fixture.id)
      }
    }
    for (const [id, node] of this.nodes) {
      if (wanted.has(id) && !node.shadow) this.enableShadow(node)
      else if (!wanted.has(id) && node.shadow) this.disableShadow(node)
    }
    const ids = fixtures.filter((f) => wanted.has(f.id)).map((f) => f.id)
    if (ids.length !== this.shadowedIds.length || ids.some((id, i) => id !== this.shadowedIds[i])) {
      this.shadowedIds = ids
      this.onShadowedChange?.(ids)
    }
  }

  /** Everything that blocks light: the venue and the fixtures' bodies (not their lenses, which are part of the light). */
  /**
   * Everything that blocks the light of `owner`: the venue, the crowd, and the bodies of the other fixtures. Its own body
   * does not (its light starts on or in it, and a tube's body would otherwise shadow most of what the tube lights).
   */
  private shadowCasters(owner?: FixtureNode): AbstractMesh[] {
    const casters = [...this.venueMeshes, ...this.extraCasters]
    for (const node of this.nodes.values()) {
      if (node === owner) continue
      for (const mesh of node.body) if (mesh !== node.lens) casters.push(mesh)
    }
    return casters
  }

  /** The crowd zones that absorb light on its way through haze (see the beam shader), as given to every beam. */
  private absorbers: Absorber[] = []

  setAbsorbers(absorbers: readonly Absorber[]) {
    this.absorbers = [...absorbers]
    for (const node of this.nodes.values()) this.applyAbsorbers(node)
  }

  private venueBounds: { min: Vector3; max: Vector3 } | null = null

  /** The venue's bounding box: the haze, and so every beam, ends at it (null when no venue is shown). */
  setVenueBounds(bounds: { min: Vector3; max: Vector3 } | null) {
    this.venueBounds = bounds
    for (const node of this.nodes.values()) this.applyVenueBounds(node)
  }

  private applyVenueBounds(node: FixtureNode) {
    const b = this.venueBounds
    const margin = 0.05 // so a beam that ends on a wall is not cut a hair short
    node.beamMaterial.setVector3('venueMin', b ? b.min.subtractFromFloats(margin, margin, margin) : Vector3.Zero())
    node.beamMaterial.setVector3('venueMax', b ? b.max.add(new Vector3(margin, margin, margin)) : Vector3.Zero())
    node.beamMaterial.setFloat('venueClip', b ? 1 : 0)
  }

  private applyAbsorbers(node: FixtureNode) {
    const rect: number[] = new Array(32).fill(0)
    const info: number[] = new Array(32).fill(0)
    this.absorbers.forEach((a, i) => {
      rect.splice(i * 4, 4, a.minX, a.minZ, a.maxX, a.maxZ)
      info.splice(i * 4, 4, a.floor, a.top, a.strength, 0)
    })
    node.beamMaterial.setArray4('crowdRect', rect)
    node.beamMaterial.setArray4('crowdInfo', info)
    const a = this.absorbers
    node.beamMaterial.setArray4(
      'crowdBounds',
      a.length
        ? [Math.min(...a.map((z) => z.minX)), Math.min(...a.map((z) => z.minZ)), Math.max(...a.map((z) => z.maxX)), Math.max(...a.map((z) => z.maxZ))]
        : [0, 0, 0, 0],
    )
    node.beamMaterial.setArray2('crowdLevels', a.length ? [Math.min(...a.map((z) => z.floor)), Math.max(...a.map((z) => z.top))] : [0, 0])
    node.beamMaterial.setInt('crowdCount', this.absorbers.length)
  }

  /** Other things that cast shadows (the crowd): they join the shadow maps of the lights that cast shadows. */
  private extraCasters: AbstractMesh[] = []

  setExtraCasters(meshes: readonly AbstractMesh[]) {
    this.extraCasters = [...meshes]
    this.refreshShadowCasters()
    this.shadowsDirty = true
  }

  /** Something that casts shadows changed (the crowd was placed again): every shadow map is rendered again. */
  markShadowsDirty() {
    this.shadowsDirty = true
  }

  /** The same, but once changes have stopped for a moment (a slider that adds and removes people fires many). */
  scheduleShadowRefresh() {
    this.settleAt = performance.now() + SHADOW_SETTLE_MS
  }

  private refreshShadowCasters() {
    for (const node of this.nodes.values()) {
      const map = node.shadow?.getShadowMap()
      if (map) map.renderList = this.shadowCasters(node)
    }
  }

  private enableShadow(node: FixtureNode) {
    // The clustered system cannot do shadows: the light leaves it and becomes a plain scene light.
    this.setRegular(node, true)
    node.light.shadowMinZ = 0.1
    node.light.shadowMaxZ = 60

    const generator = new ShadowGenerator(SHADOW_MAP_SIZE, node.light)
    generator.usePercentageCloserFiltering = true
    generator.filteringQuality = ShadowGenerator.QUALITY_MEDIUM
    generator.bias = 0.0008
    generator.normalBias = 0.02
    generator.setDarkness(0)
    const map = generator.getShadowMap()!
    map.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE // re-rendered only when something changed (see update)
    map.renderList = this.shadowCasters(node)
    node.shadow = generator
    this.applyLightSet(node)

    // The beam's own view of the scene, so the haze can be shadowed too (a square view from the lens along the beam).
    const camera = new FreeCamera(`fx-shadowcam-${node.root.name}`, Vector3.Zero(), this.scene)
    camera.minZ = 0.05
    camera.maxZ = 60
    const depth = this.scene.enableDepthRenderer(camera, false, false, Texture.NEAREST_SAMPLINGMODE, true)
    const depthMap = depth.getDepthMap()
    depthMap.resize({ width: BEAM_SHADOW_SIZE, height: BEAM_SHADOW_SIZE })
    node.beamShadow = { camera, depth }
    node.beamMaterial.setTexture('shadowSampler', depthMap)
    node.beamMaterial.setFloat('shadowEnabled', 1)
    this.updateBeamShadow(node)
    this.renderBeamViewOnce(node)
    this.shadowsDirty = true
  }

  /** Points the lens camera along the beam and tells the beam shader how to look things up in its view. */
  private updateBeamShadow(node: FixtureNode) {
    const shadow = node.beamShadow
    if (!shadow) return
    // Bring the transforms up to date (they were just changed) before reading them.
    node.root.computeWorldMatrix(true)
    node.pan.computeWorldMatrix(true)
    const world = node.tilt.computeWorldMatrix(true)
    const position = Vector3.TransformCoordinates(new Vector3(0, node.headHalf + 0.02, 0), world)
    const forward = Vector3.TransformNormal(Vector3.Up(), world).normalize()
    const up = Vector3.TransformNormal(new Vector3(0, 0, 1), world).normalize()
    const camera = shadow.camera
    camera.position.copyFrom(position)
    camera.upVector.copyFrom(up)
    camera.setTarget(position.add(forward))
    // Wide enough to contain the whole beam beyond about a meter from the lens (the beam starts lens-wide, not at a point).
    const tanHalf = Math.min(MAX_BEAM_VIEW_TAN, Math.tan(node.coneHalfAngle) * 1.6 + 0.1)
    camera.fov = 2 * Math.atan(tanHalf)
    node.beamMaterial.setMatrix('lightView', camera.getViewMatrix(true))
    node.beamMaterial.setFloat('lightTanHalf', tanHalf)
  }

  private disposeBeamShadow(node: FixtureNode) {
    const shadow = node.beamShadow
    if (!shadow) return
    node.beamMaterial.setFloat('shadowEnabled', 0)
    if (this.depthTexture) node.beamMaterial.setTexture('shadowSampler', this.depthTexture)
    this.scene.disableDepthRenderer(shadow.camera)
    shadow.camera.dispose()
    node.beamShadow = null
  }

  private disableShadow(node: FixtureNode) {
    node.shadow?.dispose()
    node.shadow = null
    this.disposeBeamShadow(node)
    this.setRegular(node, node.projected)
    this.applyLightSet(node)
  }

  /**
   * Takes a light out of the clustered system (it then is a plain scene light, which can cast shadows and project a
   * texture) or puts it back (the clustered system only accepts the default falloff and a finite range).
   */
  private setRegular(node: FixtureNode, regular: boolean) {
    if (node.regular === regular) return
    node.regular = regular
    if (regular) {
      this.clustered?.removeLight(node.light)
      node.light.falloffType = Light.FALLOFF_GLTF
      node.light.range = Number.MAX_VALUE
    } else {
      node.light.falloffType = Light.FALLOFF_DEFAULT
      node.light.range = LIGHT_RANGE
      if (this.clustered) this.clustered.addLight(node.light)
      else node.light.falloffType = Light.FALLOFF_GLTF
    }
  }

  // --- gobos on surfaces ---------------------------------------------------------

  /** Picks which lights project their gobo onto surfaces (those with one, lit, and within the limit). */
  private assignProjection(fixtures: readonly Fixture[]) {
    const wanted = new Set<string>()
    for (const fixture of fixtures) {
      if (wanted.size >= MAX_GOBO_LIGHTS) break
      const node = this.nodes.get(fixture.id)
      if (node && node.goboPattern >= 0 && node.light.isEnabled()) wanted.add(fixture.id)
    }
    for (const [id, node] of this.nodes) {
      node.projected = wanted.has(id)
      this.setRegular(node, !!node.shadow || node.projected)
      this.applyProjection(node)
    }
    const ids = fixtures.filter((f) => wanted.has(f.id)).map((f) => f.id)
    if (ids.length !== this.projectedIds.length || ids.some((id, i) => id !== this.projectedIds[i])) {
      this.projectedIds = ids
      this.onProjectedChange?.(ids)
    }
  }

  private projectedIds: string[] = []
  /** called when the set of lights that project a gobo onto surfaces changes, with their ids */
  onProjectedChange: ((ids: string[]) => void) | null = null

  private applyProjection(node: FixtureNode) {
    if (node.projected) {
      node.projection ??= new GoboProjection(this.scene)
      if (node.light.projectionTexture !== node.projection.texture) {
        node.light.projectionTexture = node.projection.texture
        this.lightsChanged()
      }
      this.applyEdgeSoftness(node)
    } else if (node.projection) {
      node.light.projectionTexture = null
      this.lightsChanged()
      // The materials still point at the texture until they have been rebuilt, which happens in the next frame.
      const projection = node.projection
      this.scene.onAfterRenderObservable.addOnce(() => projection.dispose())
      node.projection = null
    }
  }

  /**
   * Babylon does not tell materials when a light gains or loses its projection texture, and a material that still expects
   * one reads a missing texture as black, which switches that light off on every surface. So say so.
   */
  private lightsChanged() {
    this.scene.markAllMaterialsAsDirty(Constants.MATERIAL_LightDirtyFlag)
  }

  /** Turns the projected picture with the fixture and its gobo's rotation and spin (the picture's up is the fixture's local z). */
  private updateProjectionFrame(node: FixtureNode, time: number) {
    const world = node.tilt.getWorldMatrix()
    const forward = Vector3.TransformNormal(Vector3.Up(), world).normalize()
    const up = Vector3.TransformNormal(new Vector3(0, 0, 1), world).normalize()
    const turn = node.goboAngle + node.goboSpin * time * Math.PI * 2
    node.light.projectionTextureUpDirection = up.applyRotationQuaternion(Quaternion.RotationAxis(forward, turn))
    // Babylon only rebuilds the light's view matrix when it moves, but the picture's up is part of that matrix.
    ;(node.light as unknown as { _projectionTextureViewLightDirty: boolean })._projectionTextureViewLightDirty = true
  }

  private applySelection() {
    for (const [id, node] of this.nodes) {
      const selected = this.selectedIds.has(id)
      for (const mesh of node.body) {
        mesh.renderOutline = selected
        mesh.outlineColor = new Color3(0.49, 0.61, 1)
        mesh.outlineWidth = 0.012
      }
    }
  }

  private remove(id: string) {
    const node = this.nodes.get(id)
    if (!node) return
    node.shadow?.dispose()
    node.projection?.dispose()
    this.disposeBeamShadow(node)
    for (const extra of node.extras) {
      this.clustered?.removeLight(extra)
      extra.dispose()
    }
    this.clustered?.removeLight(node.light)
    node.light.dispose()
    node.cone.dispose(false, true)
    node.lensMaterial.dispose()
    node.root.dispose(false, false)
    for (const mesh of node.body) mesh.dispose()
    this.nodes.delete(id)
  }
}
