import {
  Color3,
  MeshBuilder,
  PositionGizmo,
  StandardMaterial,
  TransformNode,
  UtilityLayerRenderer,
  Vector3,
  type AbstractMesh,
  type Mesh,
  type Scene,
} from '@babylonjs/core'

/** A light the rider wizard would add: where it would go, and whether its height comes from a truss (else it is assumed). */
export interface MarkedLight {
  key: string
  position: [number, number, number]
  onTruss: boolean
}

export interface RiderPreview {
  lights: readonly MarkedLight[]
  /** keys of the selected lights: drawn white and larger, with the move gizmo between them */
  selected: readonly string[]
  /** the calibration points picked in the venue, on the floor (x, z) */
  references: readonly (readonly [number, number] | null)[]
  /** whether the markers can be clicked and moved (the wizard's review) */
  editable: boolean
}

/** The draft a marker stands for; undefined for any other mesh. */
const keyOf = (mesh: AbstractMesh | null | undefined) => (mesh?.metadata as { riderKey?: string } | null | undefined)?.riderKey

/**
 * The rider wizard's preview in the venue: a small sphere for each light it would add (green on a truss, amber where its
 * height is assumed, white when selected), blue spheres on the calibration points picked in the venue, and a move gizmo
 * between the selected lights that shifts them all.
 */
export class RiderMarkers {
  private readonly markers = new Map<string, Mesh>()
  private references: Mesh[] = []
  private readonly materials: Record<'selected' | 'ok' | 'assumed' | 'ref', StandardMaterial>
  /** the move gizmo, made when first needed (its layer is drawn every frame); it sits on the pivot at the selection's middle */
  private gizmo: { utility: UtilityLayerRenderer; gizmo: PositionGizmo; pivot: TransformNode } | undefined
  private readonly pivotLast = new Vector3()
  private selected: readonly string[] = []
  private editable = false
  private moving = false

  /** `onNudge` gets each step of a drag of the gizmo, meters. */
  constructor(
    private readonly scene: Scene,
    private readonly onNudge: (delta: [number, number, number]) => void,
  ) {
    const material = (name: string, color: Color3) => {
      const m = new StandardMaterial(`rider-${name}`, scene)
      m.disableLighting = true
      m.emissiveColor = color
      return m
    }
    this.materials = {
      selected: material('selected', new Color3(1, 1, 1)),
      ok: material('ok', new Color3(0.3, 0.9, 0.5)),
      assumed: material('assumed', new Color3(1, 0.7, 0.2)),
      ref: material('ref', new Color3(0.4, 0.6, 1)),
    }
  }

  /** The gizmo is being dragged (a click then is not a selection). */
  get dragging() {
    return this.moving
  }

  show(preview: RiderPreview) {
    for (const marker of this.references) marker.dispose()
    this.references = []
    const wanted = new Set(preview.lights.map((l) => l.key))
    for (const [key, marker] of this.markers) {
      if (wanted.has(key)) continue
      marker.dispose()
      this.markers.delete(key)
    }
    for (const light of preview.lights) {
      let marker = this.markers.get(light.key)
      if (!marker) {
        marker = MeshBuilder.CreateSphere('rider-marker', { diameter: 0.2, segments: 8 }, this.scene)
        marker.metadata = { riderKey: light.key }
        this.markers.set(light.key, marker)
      }
      marker.position.set(...light.position)
      const selected = preview.selected.includes(light.key)
      marker.material = selected ? this.materials.selected : light.onTruss ? this.materials.ok : this.materials.assumed
      marker.scaling.setAll(selected ? 1.5 : 1)
      marker.isPickable = preview.editable
    }
    for (const point of preview.references) {
      if (!point) continue
      const sphere = MeshBuilder.CreateSphere('rider-ref', { diameter: 0.35, segments: 8 }, this.scene)
      sphere.position.set(point[0], 0.05, point[1])
      sphere.material = this.materials.ref
      sphere.isPickable = false
      this.references.push(sphere)
    }
    this.selected = preview.selected
    this.editable = preview.editable
    this.placeGizmo()
  }

  /** The light whose marker is under the pointer, if any. */
  keyUnderPointer(): string | undefined {
    const hit = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (mesh) => !!keyOf(mesh))
    return hit?.hit ? keyOf(hit.pickedMesh) : undefined
  }

  dispose() {
    this.gizmo?.gizmo.dispose()
    this.gizmo?.utility.dispose()
    this.gizmo?.pivot.dispose()
    for (const marker of [...this.markers.values(), ...this.references]) marker.dispose()
    for (const material of Object.values(this.materials)) material.dispose()
  }

  /** The gizmo at the middle of the selected markers, while they can be moved (left alone during a drag). */
  private placeGizmo() {
    const markers = this.selected.map((k) => this.markers.get(k)).filter((m): m is Mesh => !!m)
    if (markers.length === 0 || !this.editable) {
      if (this.gizmo) this.gizmo.gizmo.attachedNode = null
      return
    }
    const { gizmo, pivot } = (this.gizmo ??= this.makeGizmo())
    if (!this.moving) {
      const centroid = Vector3.Zero()
      for (const m of markers) centroid.addInPlace(m.position)
      centroid.scaleInPlace(1 / markers.length)
      pivot.position.copyFrom(centroid)
      this.pivotLast.copyFrom(centroid)
    }
    gizmo.attachedNode = pivot
  }

  private makeGizmo() {
    const utility = new UtilityLayerRenderer(this.scene)
    const pivot = new TransformNode('rider-pivot', this.scene)
    const gizmo = new PositionGizmo(utility)
    gizmo.updateGizmoRotationToMatchAttachedMesh = false // world axes
    for (const axis of [gizmo.xGizmo, gizmo.yGizmo, gizmo.zGizmo, gizmo.xPlaneGizmo, gizmo.yPlaneGizmo, gizmo.zPlaneGizmo]) {
      axis.dragBehavior.onDragStartObservable.add(() => (this.moving = true))
      axis.dragBehavior.onDragObservable.add(() => {
        const d = pivot.position.subtract(this.pivotLast)
        this.pivotLast.copyFrom(pivot.position)
        this.onNudge([d.x, d.y, d.z])
      })
      axis.dragBehavior.onDragEndObservable.add(() => {
        this.moving = false
        this.placeGizmo()
      })
    }
    return { utility, gizmo, pivot }
  }
}
