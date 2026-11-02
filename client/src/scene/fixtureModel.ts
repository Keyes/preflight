import { MeshBuilder, type Material, type Mesh, type Scene, type StandardMaterial, type TransformNode } from '@babylonjs/core'
import { lensStrip, type ModelSpec } from '../domain/fixtureBody'

/**
 * Procedural fixture bodies, built from what domain/fixtureBody.ts says a fixture is: its kind and its real dimensions, so
 * a big wash and a small spot differ in size and silhouette without any model files. All sizes are meters; +Y is the
 * direction the light leaves in.
 */

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/** Where the moving parts and the lens are, in the fixture's own frame. */
export interface ModelLayout {
  /** height of the pan axis above the mounting surface */
  baseHeight: number
  /** height of the tilt axis above the pan axis */
  tiltHeight: number
  /** distance from the tilt axis to the lens plane, along the head's +Y */
  headHalf: number
  /** the beam leaves through a disc of this radius (half the width of a strip-shaped lens) */
  lensRadius: number
  /** for a strip-shaped lens (bars, panels): how far the disc's centre slides either way along the strip, else 0 */
  lensHalfLength: number
  /** which of the head's horizontal axes the strip lies along */
  lensAxis: 'x' | 'z'
}

export interface BuiltModel {
  layout: ModelLayout
  /** every mesh of the body, the lens included (the lens is also returned on its own) */
  body: Mesh[]
  lens: Mesh
}

export interface ModelContext {
  scene: Scene
  id: string
  root: TransformNode
  pan: TransformNode
  tilt: TransformNode
  bodyMaterial: StandardMaterial
  lensMaterial: Material
  /** put on every mesh, so clicking one finds the fixture */
  metadata: object
}

export function buildModel(ctx: ModelContext, spec: ModelSpec): BuiltModel {
  const [W, H, D] = spec.size
  const body: Mesh[] = []

  const add = (mesh: Mesh, parent: TransformNode, x: number, y: number, z: number) => {
    mesh.parent = parent
    mesh.position.set(x, y, z)
    mesh.material = ctx.bodyMaterial
    mesh.metadata = ctx.metadata
    mesh.isPickable = true
    body.push(mesh)
    return mesh
  }
  const box = (name: string, w: number, h: number, d: number, parent: TransformNode, x: number, y: number, z: number) =>
    add(MeshBuilder.CreateBox(`fx-${name}-${ctx.id}`, { width: w, height: h, depth: d }, ctx.scene), parent, x, y, z)
  const cylinder = (name: string, diameter: number, length: number, parent: TransformNode, x: number, y: number, z: number) =>
    add(MeshBuilder.CreateCylinder(`fx-${name}-${ctx.id}`, { diameter, height: length, tessellation: 28 }, ctx.scene), parent, x, y, z)

  const makeLens = (mesh: Mesh, y: number) => {
    mesh.parent = ctx.tilt
    mesh.position.y = y
    mesh.material = ctx.lensMaterial
    mesh.metadata = ctx.metadata
    mesh.isPickable = true
    body.push(mesh)
    return mesh
  }
  const lensDisc = (diameter: number, y: number) =>
    makeLens(MeshBuilder.CreateCylinder(`fx-lens-${ctx.id}`, { diameter, height: 0.01, tessellation: 28 }, ctx.scene), y)
  const lensPlate = (w: number, d: number, y: number) =>
    makeLens(MeshBuilder.CreateBox(`fx-lens-${ctx.id}`, { width: w, height: 0.008, depth: d }, ctx.scene), y)

  let layout: ModelLayout
  let lens: Mesh

  if (spec.kind === 'moving-head') {
    const baseHeight = clamp(H * 0.1, 0.04, 0.1)
    const baseDia = clamp(Math.min(W, D) * 0.8, 0.12, 0.45)
    const armThickness = clamp(W * 0.07, 0.025, 0.05)
    const headDia = clamp((W - 2 * armThickness) * 0.82, 0.1, 0.5)
    const headLength = clamp(D * 0.9, headDia * 0.9, headDia * 1.9)
    const headHalf = headLength / 2
    const tiltHeight = Math.max(H - baseHeight - headHalf, headHalf + 0.03)
    const armHeight = tiltHeight + headDia * 0.35
    const armDepth = clamp(headDia * 0.45, 0.05, 0.2)
    const armX = headDia / 2 + armThickness / 2 + 0.01
    cylinder('base', baseDia, baseHeight, ctx.root, 0, baseHeight / 2, 0)
    box('yoke', armX * 2 + armThickness, 0.03, armDepth, ctx.pan, 0, 0.015, 0)
    for (const side of [-1, 1]) {
      box(`arm${side}`, armThickness, armHeight, armDepth, ctx.pan, side * armX, armHeight / 2, 0)
      const motor = cylinder(`motor${side}`, armDepth * 0.9, 0.02, ctx.pan, side * (armX + armThickness / 2 + 0.008), tiltHeight, 0)
      motor.rotation.z = Math.PI / 2
    }
    cylinder('head', headDia, headLength, ctx.tilt, 0, 0, 0)
    cylinder('back', headDia * 0.72, headLength * 0.28, ctx.tilt, 0, -headHalf - headLength * 0.14, 0)
    cylinder('bezel', headDia * 1.04, 0.02, ctx.tilt, 0, headHalf - 0.01, 0)
    lens = lensDisc(headDia * 0.82, headHalf + 0.003)
    layout = { baseHeight, tiltHeight, headHalf, lensRadius: headDia * 0.41, lensHalfLength: 0, lensAxis: 'x' }
  } else if (spec.kind === 'scanner') {
    const housing = H * 0.62
    const headDia = clamp(Math.min(W, D) * 0.55, 0.06, 0.25)
    const headLength = headDia * 0.8
    box('housing', W, housing, D, ctx.root, 0, housing / 2, 0)
    cylinder('head', headDia, headLength, ctx.tilt, 0, 0, 0)
    cylinder('bezel', headDia * 1.06, 0.015, ctx.tilt, 0, headLength / 2 - 0.008, 0)
    lens = lensDisc(headDia * 0.8, headLength / 2 + 0.003)
    layout = { baseHeight: housing, tiltHeight: headLength / 2 + 0.01, headHalf: headLength / 2, lensRadius: headDia * 0.4, lensHalfLength: 0, lensAxis: 'x' }
  } else if (spec.kind === 'can') {
    const dia = clamp((W + D) / 2, 0.05, 0.6)
    const length = clamp(H, 0.05, 0.8)
    const plate = 0.015
    box('plate', dia * 0.55, plate, dia * 0.55, ctx.root, 0, plate / 2, 0)
    cylinder('body', dia, length, ctx.tilt, 0, 0, 0)
    cylinder('bezel', dia * 1.04, 0.02, ctx.tilt, 0, length / 2 - 0.01, 0)
    lens = lensDisc(dia * 0.8, length / 2 + 0.003)
    layout = { baseHeight: plate, tiltHeight: length / 2, headHalf: length / 2, lensRadius: dia * 0.4, lensHalfLength: 0, lensAxis: 'x' }
  } else {
    // Panel, bar and plain box: a housing with the light leaving through its top face.
    box('housing', W, H, D, ctx.tilt, 0, 0, 0)
    const strip = lensStrip(spec)
    if (spec.kind === 'panel' || spec.kind === 'bar') {
      lens = lensPlate(
        strip!.radius * 2 + (strip!.axis === 'x' ? strip!.halfLength * 2 : 0),
        strip!.radius * 2 + (strip!.axis === 'z' ? strip!.halfLength * 2 : 0),
        H / 2 + 0.003,
      )
    } else {
      lens = lensDisc(Math.min(W, D) * 0.5, H / 2 + 0.003)
    }
    layout = {
      baseHeight: 0,
      tiltHeight: H / 2,
      headHalf: H / 2,
      lensRadius: strip ? strip.radius : Math.min(W, D) * 0.25,
      lensHalfLength: strip ? strip.halfLength : 0,
      lensAxis: strip ? strip.axis : 'x',
    }
  }
  return { layout, body, lens }
}
