import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, test, vi } from 'vitest'
import type { Fixture } from '@preflight/shared'
import type { AimOptions, AimResult } from '../scene/aim'
import { useRig } from './rig'
import { useVenues } from './venues'
import { useViewer, type ViewerApi } from './viewer'

// Aiming: the rig store asks the view (which knows where the lights are) and applies its answer. The API is mocked.
vi.mock('../api')
beforeEach(() => setActivePinia(createPinia()))

/** Edits of one tick are one undo step: waiting a tick keeps the next edit apart. */
const nextTick = () => new Promise((resolve) => setTimeout(resolve))

async function venueWithLights(count: number) {
  const venues = useVenues()
  const rig = useRig()
  const now = new Date().toISOString()
  venues.venues.push({ id: 'v1', name: 'v1', status: 'ready', sortIndex: 0, fixtures: [], createdAt: now, updatedAt: now })
  venues.select('v1')
  await nextTick() // opening a venue clears the selection
  const ids = Array.from({ length: count }, (_, i) => rig.add({ position: [i, 3, 0], mount: 'hanging' }).id)
  rig.selectMany(ids)
  await nextTick()
  return { rig, ids }
}

/** A view that points every light it is asked about the same way, says the last one cannot reach, and notes each question. */
function fakeView() {
  const asked: { ids: string[]; point: readonly number[]; options: AimOptions }[] = []
  const aim = (fixtures: readonly Fixture[], point: readonly [number, number, number], options: AimOptions): AimResult => {
    asked.push({ ids: fixtures.map((f) => f.id), point, options })
    return { patches: new Map(fixtures.map((f) => [f.id, { values: { pan: 0.25, tilt: 0.75 } }])), unreachable: fixtures.slice(-1).map((f) => f.id) }
  }
  useViewer().api = { aim } as unknown as ViewerApi
  return asked
}

test('aiming asks the view how to point the selected lights, and applies its answer as one undo step', async () => {
  const { rig, ids } = await venueWithLights(2)
  const asked = fakeView()
  rig.aimAt([1, 0, 2])
  expect(asked).toEqual([{ ids, point: [1, 0, 2], options: { spread: 0, fan: 0 } }])
  expect(rig.fixtures.map((f) => [f.values.pan, f.values.tilt])).toEqual([
    [0.25, 0.75],
    [0.25, 0.75],
  ])
  expect(rig.aim.unreachable).toEqual([ids[1]])
  await nextTick() // the undo step is recorded at the end of the tick
  expect(rig.undoLabel).toBe('Aim (2 lights)')
})

test('the spread and fan sliders aim again while the aim still belongs to the selection, and not after', async () => {
  const { rig, ids } = await venueWithLights(2)
  const asked = fakeView()
  rig.aimAt([0, 0, 0])
  rig.setAimSpread(2)
  expect(asked.at(-1)!.options).toEqual({ spread: 2, fan: 0 })
  rig.select(ids[0]) // another selection: the aim point is no longer theirs
  rig.setAimFan(30)
  expect(asked).toHaveLength(2)
})

test('without a view, aiming changes nothing', async () => {
  const { rig } = await venueWithLights(1)
  const before = { ...rig.fixtures[0].values }
  rig.aimAt([0, 0, 0])
  expect(rig.fixtures[0].values).toEqual(before)
})
