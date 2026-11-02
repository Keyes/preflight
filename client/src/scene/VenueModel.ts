import {
  LoadAssetContainerAsync,
  Matrix,
  Mesh,
  PBRMaterial,
  Plane,
  Quaternion,
  Ray,
  Vector3,
  type AbstractMesh,
  type AssetContainer,
  type Camera,
  type Node,
  type PickingInfo,
  type Scene,
} from '@babylonjs/core'
import '@babylonjs/loaders/glTF'
import { clutterCut, triangleIndices } from './planClutter'
import type { Bounds } from './ViewerCamera'

/** Anisotropic filtering level for venue textures (the GPU's own limit applies if it is lower). */
const MAX_ANISOTROPY = 16
const TAG_PREFIX = 'tag:'

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

/**
 * How a light sits on a surface it is placed on: its base on the surface, turned so the fixture's local +Y (away from the
 * mount) follows the surface's normal, hanging from what faces down and standing on what faces up.
 */
export function mountOnSurface(
  point: Vector3,
  surfaceNormal: Vector3,
  rayDirection?: Vector3,
): { position: [number, number, number]; mount: 'hanging' | 'standing'; rotation: [number, number, number, number] } {
  const normal = surfaceNormal.clone()
  // Venue surfaces are double sided: make sure the normal faces the viewer.
  if (rayDirection && Vector3.Dot(normal, rayDirection) > 0) normal.scaleInPlace(-1)
  const unit = normal.normalizeToNew()
  const rotation =
    unit.y < -0.9999
      ? Quaternion.RotationAxis(Vector3.Right(), Math.PI) // exactly upside down: the shortest-arc turn is ambiguous
      : Quaternion.FromUnitVectorsToRef(Vector3.Up(), unit, new Quaternion())
  return { position: point.add(unit.scale(0.003)).asArray(), mount: unit.y < 0 ? 'hanging' : 'standing', rotation: rotation.asArray() }
}

/** A piece of the model taken out for the plan view, with what puts it back. */
interface ClutterCut {
  mesh: Mesh
  /** the mesh's own triangles; the full list for a mesh drawn without an index buffer */
  original: ArrayLike<number>
  unindexed: boolean
  hiddenAll: boolean
}

/**
 * The room's 3D model: loading it, the parts of it that can be switched off, and what is under the pointer. The plan view
 * cuts it away above a height and takes the clutter standing on the floor out of it; what is cut is not picked either.
 */
export class VenueModel {
  private container: AssetContainer | undefined
  private parts = new Map<string, Node[]>()
  private loading = 0
  private cutHeight: number | null = null
  private clutter: ClutterCut[] = []
  /** whether the parts are SketchUp tags, or else the model's top-level nodes */
  partsFromTags = true
  bounds: Bounds | undefined

  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
  ) {}

  get meshes(): readonly AbstractMesh[] {
    return this.container?.meshes ?? []
  }

  /** The names of the parts that can be switched off, sorted. */
  get partNames(): string[] {
    return [...this.parts.keys()].sort()
  }

  /**
   * Loads a model in place of the one shown. Lights, cameras and animations it brings are dropped: the room is lit by the
   * rig and seen through our camera, and it stands still. A surface takes up to `maxLights` lights. Resolves false when
   * another load or a `clear` came before it finished.
   */
  async load(url: string, maxLights: number): Promise<boolean> {
    this.clear()
    const token = this.loading
    let container: AssetContainer
    try {
      container = await LoadAssetContainerAsync(url, this.scene)
    } catch (err) {
      if (token !== this.loading) return false
      throw err
    }
    if (token !== this.loading) {
      container.dispose()
      return false
    }
    for (const item of [...container.lights, ...container.cameras, ...container.animationGroups]) item.dispose()
    container.lights.length = container.cameras.length = container.animationGroups.length = 0
    container.addAllToScene()
    this.container = container
    // Sharper textures on surfaces seen at a grazing angle (brick walls along the room, the floor).
    const anisotropy = Math.min(MAX_ANISOTROPY, this.scene.getEngine().getCaps().maxAnisotropy || 1)
    for (const texture of container.textures) texture.anisotropicFilteringLevel = anisotropy
    for (const mesh of container.meshes) mesh.receiveShadows = true
    for (const material of container.materials) {
      // The default (physical) spot falloff is a fixed bell shape that ignores the inner angle. The glTF falloff keeps the
      // same inverse-square distance falloff but fades between the inner and outer angle, so a light's edge can be sharp.
      if (material instanceof PBRMaterial) material.useGLTFLightFalloff = true
      if ('maxSimultaneousLights' in material) (material as { maxSimultaneousLights: number }).maxSimultaneousLights = maxLights
    }
    this.bounds = container.meshes.reduce(
      (acc, mesh) => {
        const b = mesh.getHierarchyBoundingVectors(true)
        return { min: Vector3.Minimize(acc.min, b.min), max: Vector3.Maximize(acc.max, b.max) }
      },
      { min: new Vector3(Infinity, Infinity, Infinity), max: new Vector3(-Infinity, -Infinity, -Infinity) },
    )
    const found = findParts(container)
    this.parts = found.parts
    this.partsFromTags = found.fromTags
    return true
  }

  /** Takes the model out; a load still running is dropped when it arrives. */
  clear() {
    this.loading++
    this.setClutterHidden(false, 0)
    this.container?.dispose()
    this.container = undefined
    this.bounds = undefined
    this.parts = new Map()
  }

  /** Shows every part but the ones named. */
  setHiddenParts(hidden: ReadonlySet<string>) {
    for (const [name, nodes] of this.parts) for (const node of nodes) node.setEnabled(!hidden.has(name))
  }

  // --- what is under the pointer ---------------------------------------------------------------

  /** The surface of the model under the pointer. While the model is cut, what is cut away is not hit: the first surface at or below the cut is. */
  pickUnderPointer(): PickingInfo | null {
    if (!this.container) return null
    const meshes = new Set(this.container.meshes)
    const { pointerX, pointerY } = this.scene
    if (this.cutHeight === null) {
      const hit = this.scene.pick(pointerX, pointerY, (mesh) => meshes.has(mesh))
      return hit?.hit ? hit : null
    }
    // A mesh answers a ray with its nearest hit only, and the roof is often part of the same mesh as the floor: go on from
    // each hit that lies in the cut-away part, along the same ray, until one lies below the cut.
    const ray = this.scene.createPickingRay(pointerX, pointerY, Matrix.Identity(), this.camera)
    let origin = ray.origin.clone()
    for (let i = 0; i < 12; i++) {
      const hit = this.scene.pickWithRay(new Ray(origin, ray.direction, 1000), (mesh) => meshes.has(mesh) && mesh.isVisible)
      if (!hit?.hit || !hit.pickedPoint) return null
      if (hit.pickedPoint.y <= this.cutHeight) return hit
      origin = hit.pickedPoint.add(ray.direction.scale(0.02))
    }
    return null
  }

  /** The point of the model under the pointer, if there is one. */
  pointUnderPointer(): Vector3 | null {
    return this.pickUnderPointer()?.pickedPoint ?? null
  }

  /** Where the pointer's ray crosses the horizontal plane at height `y` (a zone's second corner follows the pointer in that plane). */
  pointerAtHeight(y: number): Vector3 | null {
    const ray = this.scene.createPickingRay(this.scene.pointerX, this.scene.pointerY, Matrix.Identity(), this.camera)
    if (Math.abs(ray.direction.y) < 1e-4) return null
    const t = (y - ray.origin.y) / ray.direction.y
    return t > 0 ? ray.origin.add(ray.direction.scale(t)) : null
  }

  /** The height of the first surface met going up from (x, y, z), within `distance`: a floor seen from below, a ceiling seen from the floor. */
  surfaceAbove(x: number, y: number, z: number, distance: number): number | null {
    return this.firstHit(new Vector3(x, y, z), Vector3.Up(), distance)
  }

  /** The height of the first surface met going down from (x, y, z), within `distance`. */
  surfaceBelow(x: number, y: number, z: number, distance: number): number | null {
    return this.firstHit(new Vector3(x, y, z), Vector3.Down(), distance)
  }

  // --- the plan view's cut ---------------------------------------------------------------------

  /** Cuts the model away above `height` (as an architect's plan does), in the picture and for picking; null puts it back. */
  cutAbove(height: number | null) {
    this.cutHeight = height
    this.scene.clipPlane = height === null ? null : new Plane(0, 1, 0, -height)
  }

  /**
   * Takes the objects standing on the floor at `floorY` out of the model (speaker stacks, truss legs: see planClutter.ts),
   * so the spots under them can be picked; false puts them back.
   */
  setClutterHidden(hidden: boolean, floorY: number) {
    if (hidden && this.clutter.length === 0) {
      for (const mesh of this.meshes) {
        const positions = mesh.getVerticesData('position')
        if (!(mesh instanceof Mesh) || !positions) continue
        const original = triangleIndices(mesh.getIndices(), mesh.getTotalVertices())
        const cut = clutterCut(positions, original, mesh.computeWorldMatrix(true).m, floorY)
        if (!cut) continue
        const entry: ClutterCut = { mesh, original, unindexed: mesh.isUnIndexed, hiddenAll: cut.keep.length === 0 }
        if (entry.hiddenAll) {
          mesh.isVisible = false
        } else {
          mesh.setIndices(cut.keep, mesh.getTotalVertices())
          mesh.isUnIndexed = false // drawn and picked by the indices now, also when the model came without them
        }
        this.clutter.push(entry)
      }
    } else if (!hidden) {
      for (const { mesh, original, unindexed, hiddenAll } of this.clutter) {
        if (hiddenAll) {
          mesh.isVisible = true
        } else {
          mesh.setIndices(Array.from(original), mesh.getTotalVertices())
          mesh.isUnIndexed = unindexed
        }
      }
      this.clutter = []
    }
  }

  dispose() {
    this.clear()
  }

  private firstHit(from: Vector3, direction: Vector3, distance: number): number | null {
    const meshes = new Set(this.meshes)
    const hit = this.scene.pickWithRay(new Ray(from, direction, distance), (m) => meshes.has(m))
    return hit?.hit && hit.pickedPoint ? hit.pickedPoint.y : null
  }
}
