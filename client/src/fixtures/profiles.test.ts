import { expect, test } from 'vitest'
import type { CatalogFixture } from '../api'
import {
  beamAngleDegrees,
  candela,
  focusDistance,
  GENERIC_ID,
  GENERIC_MOVING_HEAD,
  goboSpinTurns,
  profileFor,
  profileFromCatalog,
  profilesVersion,
  registerCatalog,
  strobeHz,
  travelDegrees,
} from './profiles'

const fixture = (over: Partial<CatalogFixture> = {}): CatalogFixture => ({
  id: 'acme/spot',
  manufacturer: 'Acme',
  manufacturerKey: 'acme',
  name: 'Spot',
  categories: ['Moving Head'],
  moving: true,
  features: [],
  modes: [],
  ...over,
})

test('a moving head gets pan, tilt and zoom, with the usual travel when the library gives none', () => {
  const profile = profileFromCatalog(fixture({ features: ['pan', 'tilt', 'zoom', 'dimmer'], beamAngle: [10, 30] }))
  expect(profile.panRange).toBe(540)
  expect(profile.tiltRange).toBe(270)
  expect(profile.controls).toMatchObject({ pan: true, tilt: true, zoom: true, color: false, gobo: false })
  expect(profile.beamAngle).toEqual([10, 30])
})

test('uses the travel the library gives', () => {
  const profile = profileFromCatalog(fixture({ panDegrees: 360, tiltDegrees: 180 }))
  expect([profile.panRange, profile.tiltRange]).toEqual([360, 180])
  expect(profile.controls.pan && profile.controls.tilt).toBe(true)
})

test('a fixed light cannot pan or tilt', () => {
  const profile = profileFromCatalog(fixture({ categories: ['Color Changer'], moving: false, features: ['red', 'green', 'blue'] }))
  expect([profile.panRange, profile.tiltRange]).toEqual([0, 0])
  expect(profile.controls).toMatchObject({ pan: false, tilt: false, color: true })
})

test('picks a beam angle when the library has none, and keeps a cone drawable', () => {
  expect(profileFromCatalog(fixture()).beamAngle).toEqual([20, 20])
  expect(profileFromCatalog(fixture({ features: ['zoom'] })).beamAngle).toEqual(GENERIC_MOVING_HEAD.beamAngle)
  expect(profileFromCatalog(fixture({ beamAngle: [120, 200] })).beamAngle).toEqual([120, 170])
})

test('softens the beam edge by the beam angle, unless the light has a focus', () => {
  expect(profileFromCatalog(fixture({ features: ['focus'] })).edge).toBe(-1)
  expect(profileFromCatalog(fixture({ beamAngle: [20, 20] })).edge).toBeCloseTo(0.1 + (0.35 * 20) / 160)
  expect(profileFromCatalog(fixture({ beamAngle: [170, 170] })).edge).toBe(0.45)
})

test('hazers and other machines that light nothing do not emit light', () => {
  expect(profileFromCatalog(fixture({ categories: ['Hazer'] })).emitsLight).toBe(false)
  expect(profileFromCatalog(fixture({ categories: ['Hazer', 'Color Changer'] })).emitsLight).toBe(true)
})

test('a bar has a strip-shaped lens: its beam is a sheet and it projects no gobo', () => {
  const profile = profileFromCatalog(fixture({ categories: ['Pixel Bar'], moving: false, features: ['gobo'] }))
  expect(profile.sheet).toBe(true)
  expect(profile.controls.gobo).toBe(false)
})

test('an unknown fixture falls back to the generic moving head until the catalog has it', () => {
  expect(profileFor('acme/later').id).toBe(GENERIC_ID)
  const before = profilesVersion.value
  registerCatalog([fixture({ id: 'acme/later', name: 'Later' })])
  expect(profileFor('acme/later').name).toBe('Later')
  expect(profilesVersion.value).toBe(before + 1)
})

test('turns 0..1 values into physical quantities', () => {
  expect([travelDegrees(0, 540), travelDegrees(0.5, 540), travelDegrees(1, 540)]).toEqual([-270, 0, 270])
  expect(beamAngleDegrees({ ...GENERIC_MOVING_HEAD, beamAngle: [10, 30] }, 0.25)).toBe(15)
  expect([focusDistance(0), focusDistance(1)]).toEqual([2, 40])
})

test('the strobe is off near 0 and runs from 1 to 20 flashes per second', () => {
  expect(strobeHz(0)).toBe(0)
  expect(strobeHz(0.005)).toBe(0)
  expect(strobeHz(1)).toBeCloseTo(20)
  expect(strobeHz(0.5)).toBeCloseTo(Math.sqrt(20))
})

test('a gobo stands still around 0.5 and spins either way above and below it', () => {
  expect(goboSpinTurns(0.5)).toBe(0)
  expect(goboSpinTurns(0.505)).toBe(0)
  expect(goboSpinTurns(1)).toBe(1)
  expect(goboSpinTurns(0)).toBe(-1)
})

test('the same lumens in a narrower beam are brighter', () => {
  // a 60 degree cone covers a solid angle of 2π(1 − cos 30°)
  expect(candela(GENERIC_MOVING_HEAD, 60)).toBeCloseTo(8000 / (2 * Math.PI * (1 - Math.cos(Math.PI / 6))))
  expect(candela(GENERIC_MOVING_HEAD, 10)).toBeGreaterThan(candela(GENERIC_MOVING_HEAD, 40))
})
