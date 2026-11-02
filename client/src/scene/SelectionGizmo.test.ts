import { NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core'
import { afterEach, expect, test } from 'vitest'
import { SelectionGizmo, type MovedLight, type RotationReadout } from './SelectionGizmo'

// A scene without a GPU: the gizmo's drags are played by notifying its observables, as Babylon does during a real drag.

const engine = new NullEngine()
let scene: Scene
afterEach(() => scene.dispose())

function setup(positions: Record<string, [number, number, number]>) {
  scene = new Scene(engine)
  const roots = new Map<string, TransformNode>()
  for (const [id, p] of Object.entries(positions)) {
    const root = new TransformNode(`fixture-${id}`, scene)
    root.position.set(...p)
    root.rotationQuaternion = Quaternion.Identity()
    roots.set(id, root)
  }
  const moved: MovedLight[][] = []
  const readouts: (RotationReadout | null)[] = []
  const gizmo = new SelectionGizmo(scene, {
    rootOf: (id) => roots.get(id),
    onMoved: (l) => moved.push(l),
    onReadout: (r) => readouts.push(r),
    onDrag: () => {},
  })
  return { gizmo, roots, moved, readouts }
}

const round = (v: readonly number[]) => v.map((n) => Math.round(n * 1000) / 1000 || 0)

test('one light: the gizmo sits on it, and a move reports its new position only', () => {
  const { gizmo, roots, moved } = setup({ a: [1, 2, 3] })
  gizmo.attach(['a'])
  const position = gizmo.manager.gizmos.positionGizmo!
  expect(position.attachedNode?.name).toBe('fixture-a')
  position.onDragStartObservable.notifyObservers({} as never)
  roots.get('a')!.position.x = 4
  position.onDragEndObservable.notifyObservers({} as never)
  expect(moved).toEqual([[{ id: 'a', position: [4, 2, 3] }]])
})

test('one light turned: only its rotation is reported, so undo calls it a turn', () => {
  const { gizmo, roots, moved } = setup({ a: [0, 0, 0] })
  gizmo.setMode('rotate')
  gizmo.attach(['a'])
  const rotation = gizmo.manager.gizmos.rotationGizmo!
  rotation.onDragStartObservable.notifyObservers({} as never)
  roots.get('a')!.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), Math.PI / 2)
  rotation.onDragEndObservable.notifyObservers({} as never)
  expect(moved).toHaveLength(1)
  expect(Object.keys(moved[0][0])).toEqual(['id', 'rotation'])
  expect(round(moved[0][0].rotation!)).toEqual(round(Quaternion.RotationAxis(Vector3.Up(), Math.PI / 2).asArray()))
})

test('several lights share a pivot at their middle; turning it turns them about it', () => {
  const { gizmo, moved } = setup({ a: [-1, 3, 0], b: [1, 3, 0] })
  gizmo.setMode('rotate')
  gizmo.attach(['a', 'b'])
  const rotation = gizmo.manager.gizmos.rotationGizmo!
  const pivot = rotation.attachedNode as TransformNode
  expect(pivot.name).toBe('selection-pivot')
  expect(round(pivot.position.asArray())).toEqual([0, 3, 0])

  rotation.onDragStartObservable.notifyObservers({} as never)
  pivot.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), Math.PI) // half a turn about the vertical
  rotation.onDragObservable.notifyObservers({} as never)
  rotation.onDragEndObservable.notifyObservers({} as never)

  const [lights] = moved
  expect(lights.map((l) => [l.id, round(l.position!)])).toEqual([
    ['a', [1, 3, 0]],
    ['b', [-1, 3, 0]],
  ])
  expect(lights.every((l) => l.rotation)).toBe(true)
  expect(round(pivot.rotationQuaternion!.asArray())).toEqual([0, 0, 0, 1]) // back to neutral for the next drag
})

test('several lights moved together keep their spacing', () => {
  const { gizmo, moved } = setup({ a: [0, 3, 0], b: [2, 3, 1] })
  gizmo.attach(['a', 'b'])
  const position = gizmo.manager.gizmos.positionGizmo!
  const pivot = position.attachedNode as TransformNode
  position.onDragStartObservable.notifyObservers({} as never)
  pivot.position.addInPlace(new Vector3(0, 0, -5))
  position.onDragObservable.notifyObservers({} as never)
  position.onDragEndObservable.notifyObservers({} as never)
  expect(moved[0].map((l) => [l.id, round(l.position!), l.rotation])).toEqual([
    ['a', [0, 3, -5], undefined],
    ['b', [2, 3, -4], undefined],
  ])
})

test('no lights, no gizmo; hiding keeps the lights for when it comes back', () => {
  const { gizmo } = setup({ a: [0, 0, 0] })
  gizmo.attach([])
  expect(gizmo.manager.gizmos.positionGizmo!.attachedNode).toBeNull()
  gizmo.attach(['a'])
  gizmo.hide()
  expect(gizmo.manager.gizmos.positionGizmo!.attachedNode).toBeNull()
})
