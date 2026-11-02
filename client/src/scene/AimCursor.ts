import { Color3, MeshBuilder, Quaternion, StandardMaterial, TransformNode, Vector3, type Mesh, type PickingInfo, type Scene } from '@babylonjs/core'

/**
 * What picking a point shows in the room: a crosshair lying on the surface under the pointer (a ring with four ticks,
 * turned to the surface and sized with the distance, so it looks about the same size near and far), and a small sphere
 * on the point the selected lights are aimed at.
 */
export class AimCursor {
  private readonly cursor: TransformNode
  private readonly marker: Mesh

  constructor(scene: Scene) {
    const color = new Color3(0.7, 0.85, 1)
    const material = new StandardMaterial('aim-cursor-mat', scene)
    material.disableLighting = true
    material.emissiveColor = color
    this.cursor = new TransformNode('aim-cursor', scene)
    const ring = MeshBuilder.CreateTorus('aim-cursor-ring', { diameter: 1, thickness: 0.03, tessellation: 48 }, scene)
    ring.material = material
    ring.parent = this.cursor
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
    ticks.parent = this.cursor
    for (const mesh of [ring, ticks]) {
      mesh.isPickable = false
      mesh.renderingGroupId = 1 // drawn over the scene, so haze and the beams never hide it
    }
    this.cursor.rotationQuaternion = new Quaternion()
    this.cursor.setEnabled(false)

    this.marker = MeshBuilder.CreateSphere('aim-marker', { diameter: 0.14, segments: 12 }, scene)
    const markerMaterial = new StandardMaterial('aim-marker-mat', scene)
    markerMaterial.disableLighting = true
    markerMaterial.emissiveColor = new Color3(0.6, 0.75, 1)
    this.marker.material = markerMaterial
    this.marker.isPickable = false
    this.marker.setEnabled(false)
  }

  /** Lays the crosshair on the surface that was hit, seen from `eye`; hides it when nothing was. */
  showAt(hit: PickingInfo | null, eye: Vector3) {
    if (!hit?.pickedPoint) return this.hide()
    const normal = hit.getNormal(true, true) ?? Vector3.Up()
    if (hit.ray && Vector3.Dot(normal, hit.ray.direction) > 0) normal.scaleInPlace(-1) // double-sided surfaces: face the viewer
    const unit = normal.normalizeToNew()
    const distance = Vector3.Distance(eye, hit.pickedPoint)
    this.cursor.position.copyFrom(hit.pickedPoint.add(unit.scale(0.004)))
    this.cursor.rotationQuaternion = Quaternion.FromUnitVectorsToRef(Vector3.Up(), unit, new Quaternion())
    this.cursor.scaling.setAll(Math.max(0.12, distance * 0.07))
    this.cursor.setEnabled(true)
  }

  hide() {
    this.cursor.setEnabled(false)
  }

  /** The sphere on the aim point, or none. */
  setAimPoint(point: readonly [number, number, number] | null) {
    this.marker.setEnabled(!!point)
    if (point) this.marker.position.set(point[0], point[1], point[2])
  }

  dispose() {
    this.cursor.dispose(false, true)
    this.marker.dispose(false, true)
  }
}
