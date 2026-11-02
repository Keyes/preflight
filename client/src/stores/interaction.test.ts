import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, test, vi } from 'vitest'
import { nextTick } from 'vue'
import { useCrowd } from './crowd'
import { useInteraction } from './interaction'
import { useRider } from './rider'
import { useRig } from './rig'
import { useVenues } from './venues'

// The stores save through the API: here nothing is sent.
vi.mock('../api')

beforeEach(() => setActivePinia(createPinia()))

function openVenue(id: string) {
  const venues = useVenues()
  const now = new Date().toISOString()
  venues.venues.push({ id, name: id, status: 'ready', sortIndex: venues.venues.length, fixtures: [], createdAt: now, updatedAt: now })
  venues.select(id)
}

test('starting a click mode ends the one before, so two are never on at once', () => {
  const rig = useRig()
  const crowd = useCrowd()
  const interaction = useInteraction()
  openVenue('v1')
  rig.add({ position: [0, 3, 0], mount: 'hanging' }) // and selects it, so it can be aimed

  rig.startAim()
  expect(interaction.mode).toEqual({ kind: 'aim' })
  crowd.startDrawing()
  expect(interaction.mode).toEqual({ kind: 'zone', first: null })
  rig.startPlacing('generic-moving-head')
  expect(interaction.is('place')).toBe(true)
  expect(interaction.is('zone')).toBe(false)
})

test('a store ends its own click mode and leaves another one alone', () => {
  const crowd = useCrowd()
  const interaction = useInteraction()
  openVenue('v1')

  crowd.startFacing('z1')
  useRig().aimAt([0, 0, 0])
  useRider().close()
  expect(interaction.mode).toEqual({ kind: 'facing', zoneId: 'z1' })
  crowd.setFacing('z1', [1, 2])
  expect(interaction.mode).toBeNull()
})

test('placing adds the fixture chosen in the picker where the surface was clicked, once', () => {
  const rig = useRig()
  const interaction = useInteraction()
  openVenue('v1')

  rig.togglePlacing()
  expect(rig.pickerOpen).toBe(true)
  rig.startPlacing('generic-moving-head', 'Basic')
  expect(rig.pickerOpen).toBe(false)
  rig.placeAt({ position: [1, 4, 2], mount: 'hanging', rotation: [0, 0, 0, 1] })
  rig.placeAt({ position: [5, 4, 2], mount: 'hanging', rotation: [0, 0, 0, 1] })
  expect(rig.fixtures).toHaveLength(1)
  expect(rig.fixtures[0]).toMatchObject({ profileId: 'generic-moving-head', mode: 'Basic', position: [1, 4, 2] })
  expect(interaction.mode).toBeNull()

  rig.startPlacing('generic-moving-head')
  rig.togglePlacing() // the button reads "Cancel" while a placement waits for a click
  expect(interaction.mode).toBeNull()
  expect(rig.pickerOpen).toBe(false)
})

test('a crowd zone takes two clicks, and one too small is refused with a message', () => {
  const crowd = useCrowd()
  const interaction = useInteraction()
  openVenue('v1')

  crowd.setFirstCorner([0, 0, 0]) // no zone is being drawn: ignored
  expect(interaction.mode).toBeNull()
  crowd.startDrawing()
  crowd.setFirstCorner([0, 0.2, 0])
  expect(interaction.mode).toEqual({ kind: 'zone', first: [0, 0.2, 0] })
  crowd.finishZone([4, 3])
  expect(crowd.zones).toHaveLength(1)
  expect(crowd.zones[0]).toMatchObject({ x0: 0, z0: 0, x1: 4, z1: 3, y: 0.2 })
  expect(interaction.mode).toBeNull()

  crowd.startDrawing()
  crowd.setFirstCorner([0, 0, 0])
  crowd.finishZone([0.1, 0.1])
  expect(crowd.zones).toHaveLength(1)
  expect(crowd.message).toMatch(/at least/)
  expect(interaction.mode).toBeNull()
})

test('a rider point is set by the click asked for, and pressing its button again cancels', () => {
  const rider = useRider()
  const interaction = useInteraction()

  rider.pickWorld(1)
  expect(interaction.mode).toEqual({ kind: 'riderPoint', index: 1 })
  rider.deliverWorld([2, 0.5, 3])
  expect(rider.worldPoints).toEqual([null, [2, 3]])
  expect(interaction.mode).toBeNull()

  rider.pickWorld(0)
  rider.pickWorld(0)
  expect(interaction.mode).toBeNull()
})

test('opening another venue ends the click mode', async () => {
  const crowd = useCrowd()
  const interaction = useInteraction()
  openVenue('v1')
  crowd.startDrawing()
  openVenue('v2')
  await nextTick()
  expect(interaction.mode).toBeNull()
})
