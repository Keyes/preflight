import { GizmoManager, MeshBuilder, Quaternion, TransformNode, Vector3, type LinesMesh, type Mesh, type Scene } from '@babylonjs/core'

/** Rotation snaps to multiples of this many degrees (measured from where the drag started) while Shift is held. */
const SNAP_DEGREES = 5
const SNAP_STEP = (SNAP_DEGREES * Math.PI) / 180

type RotationAxis = 'x' | 'y' | 'z'

/** What the readout next to the pointer shows while a rotation ring is dragged. */
export interface RotationReadout {
  /** world axis the light is being turned around */
  axis: RotationAxis
  /** rotation since the drag started, right-hand rule about the positive axis */
  degrees: number
  /** whether Shift snapping is active */
  snapping: boolean
  /** pointer position in the 3D view, CSS pixels */
  x: number
  y: number
}

/** A light the gizmo moved or turned: what changed (turning one light changes only its rotation, so undo calls it a turn). */
export interface MovedLight {
  id: string
  position?: [number, number, number]
  rotation?: [number, number, number, number]
}

export interface SelectionGizmoEvents {
  /** a light's root node, the one the gizmo moves */
  rootOf(id: string): TransformNode | undefined
  /** a drag ended: where the lights it moved are now */
  onMoved(lights: MovedLight[]): void
  /** the angle so far while a rotation ring is dragged; null when the drag ends */
  onReadout(readout: RotationReadout | null): void
  /** something is being dragged */
  onDrag(): void
}

/** Gizmo internals the snapping marks rely on (Babylon keeps them private): the angle display plane and the drag's start angle. */
interface RotationRingInternals {
  _rotationDisplayPlane: Mesh
  _angles: Vector3
}

/**
 * The move and rotate gizmo on the selected lights. With one light it sits on the light; with several it sits on an
 * invisible pivot at their middle, and dragging it carries them all along, turning them about the pivot. While Shift is
 * held, turning snaps to 5° steps and the ring shows tick marks; the angle is reported for the readout next to the pointer.
 */
export class SelectionGizmo {
  /** Babylon's gizmos (in development, `window.__gizmo` for the browser tests) */
  readonly manager: GizmoManager
  private readonly pivot: TransformNode
  private ids: readonly string[] = []
  private groupStart: { pivot: Vector3; items: { id: string; root: TransformNode; position: Vector3; rotation: Quaternion }[] } | null = null
  private snapping = false
  private activeRotation: RotationAxis | null = null
  private readonly ticks: Partial<Record<RotationAxis, LinesMesh>> = {}
  private readout: RotationReadout | null = null

  constructor(
    private readonly scene: Scene,
    private readonly events: SelectionGizmoEvents,
  ) {
    this.manager = new GizmoManager(scene)
    this.manager.usePointerToAttachGizmos = false
    this.manager.scaleGizmoEnabled = false
    this.manager.boundingBoxGizmoEnabled = false
    // Create both gizmos once (enabling creates them), then switch between them with the move/rotate mode.
    this.manager.positionGizmoEnabled = true
    this.manager.rotationGizmoEnabled = true
    const { positionGizmo, rotationGizmo } = this.manager.gizmos
    this.pivot = new TransformNode('selection-pivot', scene)
    this.pivot.rotationQuaternion = Quaternion.Identity()
    for (const g of [positionGizmo, rotationGizmo]) {
      if (!g) continue
      g.updateGizmoRotationToMatchAttachedMesh = false // world-aligned axes, even for an upside-down fixture
      g.onDragStartObservable.add(() => this.beginGroupDrag())
      g.onDragObservable.add(() => this.applyGroupDrag())
    }
    positionGizmo?.onDragEndObservable.add(() => this.endDrag(false))
    rotationGizmo?.onDragEndObservable.add(() => this.endDrag(true))
    if (rotationGizmo) this.setupRotationFeedback(rotationGizmo)
  }

  setMode(mode: 'move' | 'rotate') {
    this.manager.positionGizmoEnabled = mode === 'move'
    this.manager.rotationGizmoEnabled = mode === 'rotate'
  }

  /** Puts the gizmo on these lights: on the light itself, or on the pivot at the middle of several (turned back to neutral). */
  attach(ids: readonly string[]) {
    this.ids = [...ids]
    const roots = this.roots()
    if (roots.length === 0) {
      this.manager.attachToNode(null)
    } else if (roots.length === 1) {
      this.manager.attachToNode(roots[0].root)
    } else {
      const centre = Vector3.Zero()
      for (const { root } of roots) centre.addInPlace(root.position)
      this.pivot.position.copyFrom(centre.scaleInPlace(1 / roots.length))
      this.pivot.rotationQuaternion?.copyFromFloats(0, 0, 0, 1)
      this.manager.attachToNode(this.pivot)
    }
  }

  /** Takes the gizmo off the picture, keeping its lights (`attach` puts it back). */
  hide() {
    this.manager.attachToNode(null)
  }

  setSnapping(on: boolean) {
    if (this.snapping === on) return
    this.snapping = on
    const rotationGizmo = this.manager.gizmos.rotationGizmo
    if (rotationGizmo) rotationGizmo.snapDistance = on ? SNAP_STEP : 0
    this.refreshRotationFeedback()
  }

  dispose() {
    this.pivot.dispose()
    this.manager.dispose()
  }

  private roots() {
    return this.ids.map((id) => ({ id, root: this.events.rootOf(id) })).filter((x): x is { id: string; root: TransformNode } => !!x.root)
  }

  private beginGroupDrag() {
    if (this.ids.length < 2) return
    this.groupStart = {
      pivot: this.pivot.position.clone(),
      items: this.roots().map(({ id, root }) => ({
        id,
        root,
        position: root.position.clone(),
        rotation: (root.rotationQuaternion ?? Quaternion.Identity()).clone(),
      })),
    }
  }

  /** Carries every light along with the pivot: its movement, and its turn about the pivot's position. */
  private applyGroupDrag() {
    this.events.onDrag()
    const start = this.groupStart
    if (!start) return
    const turn = this.pivot.rotationQuaternion ?? Quaternion.Identity()
    const offset = new Vector3()
    for (const item of start.items) {
      item.position.subtractToRef(start.pivot, offset)
      offset.rotateByQuaternionToRef(turn, offset)
      item.root.position.copyFrom(this.pivot.position).addInPlace(offset)
      item.root.rotationQuaternion = turn.multiply(item.rotation)
    }
  }

  private endDrag(rotated: boolean) {
    const start = this.groupStart
    if (start) {
      this.applyGroupDrag()
      this.groupStart = null
      this.events.onMoved(
        start.items.map(({ id, root }) => ({
          id,
          position: root.position.asArray(),
          ...(rotated && root.rotationQuaternion ? { rotation: root.rotationQuaternion.normalizeToNew().asArray() } : {}),
        })),
      )
      this.attach(this.ids) // the pivot moves to the lights' new centre
      return
    }
    const [one] = this.roots()
    if (!one) return
    if (!rotated) this.events.onMoved([{ id: one.id, position: one.root.position.asArray() }])
    else if (one.root.rotationQuaternion) this.events.onMoved([{ id: one.id, rotation: one.root.rotationQuaternion.normalizeToNew().asArray() }])
  }

  // --- rotation snapping, tick marks and readout -------------------------------------------------

  /**
   * Tick marks around the ring, one per snap step: short for each step, longer every 15 degrees and longest every 90.
   * Built in the local frame of the gizmo's angle display plane (ring radius 0.3).
   */
  private createTickMarks(utilityScene: Scene): LinesMesh {
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

  private setupRotationFeedback(rotationGizmo: NonNullable<GizmoManager['gizmos']['rotationGizmo']>) {
    const rings = { x: rotationGizmo.xGizmo, y: rotationGizmo.yGizmo, z: rotationGizmo.zGizmo }
    for (const axis of ['x', 'y', 'z'] as const) {
      const ring = rings[axis]
      const internals = ring as unknown as RotationRingInternals
      const ticks = this.createTickMarks(ring.gizmoLayer.utilityLayerScene)
      ticks.parent = internals._rotationDisplayPlane // inherits its placement, scale and visibility
      ticks.setEnabled(false)
      this.ticks[axis] = ticks

      ring.dragBehavior.onDragStartObservable.add(() => {
        this.activeRotation = axis
        // The angle display starts at the drag's start angle; line the marks up with it so every snapped position lands
        // exactly on a mark.
        ticks.rotation.z = internals._angles.x - Math.PI
        this.report(axis, ring.angle)
        this.refreshRotationFeedback()
      })
      ring.dragBehavior.onDragObservable.add(() => this.report(axis, ring.angle))
      ring.dragBehavior.onDragEndObservable.add(() => {
        this.activeRotation = null
        this.readout = null
        this.events.onReadout(null)
        this.refreshRotationFeedback()
      })
    }
  }

  private report(axis: RotationAxis, radians: number) {
    const degrees = (radians * 180) / Math.PI
    this.readout = { axis, degrees: Math.abs(degrees) < 0.05 ? 0 : degrees, snapping: this.snapping, x: this.scene.pointerX, y: this.scene.pointerY }
    this.events.onReadout(this.readout)
  }

  private refreshRotationFeedback() {
    for (const axis of ['x', 'y', 'z'] as const) this.ticks[axis]?.setEnabled(this.activeRotation === axis && this.snapping)
    if (this.readout) {
      this.readout = { ...this.readout, snapping: this.snapping }
      this.events.onReadout(this.readout)
    }
  }
}
