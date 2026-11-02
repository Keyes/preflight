import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { CameraView, Venue } from '@preflight/shared'
import * as api from '../api'
import { useAutosave } from './autosave'
import { useRig } from './rig'
import { useVenues } from './venues'

// How the stores save a venue: what reaches the API, and when. The API is mocked; time is faked.
vi.mock('../api')

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  setActivePinia(createPinia())
})
afterEach(() => vi.useRealTimers())

function openVenue(id: string): Venue {
  const venues = useVenues()
  const now = new Date().toISOString()
  venues.venues.push({ id, name: id, status: 'ready', sortIndex: venues.venues.length, fixtures: [], views: [], createdAt: now, updatedAt: now })
  venues.select(id)
  return venues.current!
}

const view = (name: string): CameraView => ({ id: name, name, position: [0, 1.7, 0], rotation: [0, 0, 0] })

test('a change is saved a moment after the last one, and a failed save keeps it, says so, and goes through later', async () => {
  const venues = useVenues()
  const autosave = useAutosave()
  const venue = openVenue('v1')
  vi.mocked(api.saveViews).mockRejectedValueOnce(new Error('server down'))

  venues.setViews([view('Front')])
  venues.setViews([view('Front'), view('Bar')])
  await vi.advanceTimersByTimeAsync(500)
  expect(api.saveViews).toHaveBeenCalledTimes(1)
  expect(venue.views!.map((v) => v.name)).toEqual(['Front', 'Bar']) // kept on screen, not put back
  expect(autosave.problem).toBe('server down')

  await vi.advanceTimersByTimeAsync(5000)
  expect(api.saveViews).toHaveBeenCalledTimes(2)
  expect(vi.mocked(api.saveViews).mock.calls[1][1].map((v) => v.name)).toEqual(['Front', 'Bar'])
  expect(autosave.problem).toBeNull()
})

test('lights, haze, crowd and hidden parts are each saved on their own, after the same moment', async () => {
  const venues = useVenues()
  const rig = useRig()
  openVenue('v1')
  rig.add({ position: [0, 3, 0], mount: 'hanging' })
  venues.setAtmosphere('v1', { haze: 0.4, ambient: 0.2 })
  venues.setCrowd('v1', { shown: true, density: 0.5, motion: 'sway', intensity: 0.5, zones: [] })
  venues.setHiddenTags(['Ceiling'])
  await vi.advanceTimersByTimeAsync(499)
  expect(api.saveFixtures).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(vi.mocked(api.saveFixtures).mock.calls[0][1]).toHaveLength(1)
  expect(api.saveAtmosphere).toHaveBeenCalledWith('v1', { haze: 0.4, ambient: 0.2 })
  expect(api.saveCrowd).toHaveBeenCalledTimes(1)
  expect(api.saveHiddenTags).toHaveBeenCalledWith('v1', ['Ceiling'])
})

test('duplicating a venue sends its waiting changes first, the lights included', async () => {
  const venues = useVenues()
  const rig = useRig()
  openVenue('v1')
  const order: string[] = []
  vi.mocked(api.saveFixtures).mockImplementation(() => (order.push('lights'), Promise.resolve({} as Venue)))
  vi.mocked(api.duplicateVenue).mockImplementation(() => (order.push('duplicate'), Promise.resolve({ ...venues.current!, id: 'v2' })))
  rig.add({ position: [0, 3, 0], mount: 'hanging' })
  await venues.duplicate('v1')
  expect(order).toEqual(['lights', 'duplicate'])
})

test('deleting a venue drops its waiting changes, so they do not fail against a venue that is gone', async () => {
  const venues = useVenues()
  const autosave = useAutosave()
  openVenue('v1')
  // the delete takes a second, so the crowd's moment comes while it is on its way
  vi.mocked(api.deleteVenue).mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 1000)))
  venues.setCrowd('v1', { shown: true, density: 0.5, motion: 'sway', intensity: 0.5, zones: [] })
  const removing = venues.remove('v1')
  await vi.advanceTimersByTimeAsync(10_000)
  await removing
  expect(api.saveCrowd).not.toHaveBeenCalled()
  expect(autosave.problem).toBeNull()
})
