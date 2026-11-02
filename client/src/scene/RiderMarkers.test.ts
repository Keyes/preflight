import { NullEngine, Scene, type Mesh, type StandardMaterial } from '@babylonjs/core'
import { afterEach, expect, test } from 'vitest'
import { RiderMarkers } from './RiderMarkers'

const engine = new NullEngine()
let scene: Scene
afterEach(() => scene.dispose())

function setup() {
  scene = new Scene(engine)
  const nudges: [number, number, number][] = []
  return { markers: new RiderMarkers(scene, (d) => nudges.push(d)), nudges }
}

const spheres = (name: string) => scene.meshes.filter((m) => m.name === name) as Mesh[]
const look = (m: Mesh) => ({ at: m.position.asArray(), material: (m.material as StandardMaterial).name, big: m.scaling.x > 1, pickable: m.isPickable })

const lights = [
  { key: '#1', position: [-1, 5, 1] as [number, number, number], onTruss: true },
  { key: '#2', position: [3, 5, 1] as [number, number, number], onTruss: false },
]

test('a marker per light, coloured by where its height comes from, and the selected ones white and larger', () => {
  const { markers } = setup()
  markers.show({ lights, selected: ['#2'], references: [[0, 0], null], editable: true })
  expect(spheres('rider-marker').map(look)).toEqual([
    { at: [-1, 5, 1], material: 'rider-ok', big: false, pickable: true },
    { at: [3, 5, 1], material: 'rider-selected', big: true, pickable: true },
  ])
  expect(spheres('rider-ref').map((m) => m.position.asArray())).toEqual([[0, 0.05, 0]])
})

test('the move gizmo sits between the selected lights, only while they can be edited', () => {
  const { markers } = setup()
  markers.show({ lights, selected: ['#1', '#2'], references: [], editable: true })
  expect(scene.getTransformNodeByName('rider-pivot')!.position.asArray()).toEqual([1, 5, 1])
  markers.show({ lights, selected: ['#1', '#2'], references: [], editable: false })
  expect(spheres('rider-marker').every((m) => !m.isPickable)).toBe(true)
})

test('lights no longer shown lose their marker; showing nothing clears the venue', () => {
  const { markers } = setup()
  markers.show({ lights, selected: [], references: [[1, 1]], editable: false })
  markers.show({ lights: lights.slice(0, 1), selected: [], references: [], editable: false })
  expect(spheres('rider-marker')).toHaveLength(1)
  expect(spheres('rider-ref')).toHaveLength(0)
  markers.show({ lights: [], selected: [], references: [], editable: false })
  expect(spheres('rider-marker')).toHaveLength(0)
})
