import { Color3, MeshBuilder, Vector3, type LinesMesh, type Scene } from '@babylonjs/core'
import type { CrowdZone } from '@preflight/shared'

/** The crowd's rectangles on the floor: the zone being drawn, following the pointer, and the outline of the selected zone. */
export class ZoneOutlines {
  private preview: LinesMesh | undefined
  private outline: LinesMesh | undefined

  constructor(private readonly scene: Scene) {}

  /** The zone being drawn: from its first corner to `corner` (x, z), at the first corner's height. */
  showPreview(first: readonly [number, number, number], corner: readonly [number, number]) {
    this.preview = this.rectangle(this.preview, 'crowd-preview', first[0], first[2], corner[0], corner[1], first[1] + 0.03, new Color3(1, 0.85, 0.5))
    this.preview.setEnabled(true)
  }

  hidePreview() {
    this.preview?.setEnabled(false)
  }

  /** The outline of a zone, or none. */
  showOutline(zone: CrowdZone | null) {
    if (!zone) return this.outline?.setEnabled(false)
    this.outline = this.rectangle(this.outline, 'crowd-outline', zone.x0, zone.z0, zone.x1, zone.z1, zone.y + 0.03, new Color3(0.6, 0.75, 1))
    this.outline.setEnabled(true)
  }

  dispose() {
    this.preview?.dispose()
    this.outline?.dispose()
  }

  /** A rectangle lying on a plane, as a line loop (the same mesh is updated in place when there is one). */
  private rectangle(existing: LinesMesh | undefined, name: string, x0: number, z0: number, x1: number, z1: number, y: number, color: Color3): LinesMesh {
    const points = [new Vector3(x0, y, z0), new Vector3(x1, y, z0), new Vector3(x1, y, z1), new Vector3(x0, y, z1), new Vector3(x0, y, z0)]
    if (existing) return MeshBuilder.CreateLines(name, { points, instance: existing })
    const mesh = MeshBuilder.CreateLines(name, { points, updatable: true }, this.scene)
    mesh.color = color
    mesh.isPickable = false
    mesh.renderingGroupId = 1
    return mesh
  }
}
