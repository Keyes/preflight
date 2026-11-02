import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import type { CatalogFixture } from '@preflight/shared'
import { catalogFixtures } from '../services/catalog.js'
import { findByName, resolveMode, resolveType } from './mapping.js'

let catalog: CatalogFixture[]
before(async () => {
  catalog = await catalogFixtures()
})
const byId = (id: string) => catalog.find((f) => f.id === id)!

test('fixtures named in the rider are found in the catalog, by alias, by part of a name, and with a changed number', () => {
  assert.equal(findByName('Expolite Tourled MC60 Zoom', catalog)?.id, 'expolite/tourled-mc60-zoom')
  assert.equal(findByName('Chauvet RX1 Spot', catalog)?.id, 'chauvet-professional/rogue-r1x-spot')
  assert.equal(findByName('Stairville mini stage PAR 25°', catalog)?.id, 'stairville/mini-stage-par-7x4w-rgbw')
  assert.equal(findByName('Stairville mini Stage PAR 45°', catalog)?.id, 'stairville/mini-stage-par-7x4w-rgbw')
  assert.equal(findByName('Atomic 3000', catalog)?.id, 'martin/atomic-3000')
  assert.equal(findByName('CB-100', catalog)?.id, 'unknown/cb-100-led-color-beam')
  assert.equal(findByName('something nobody makes', catalog), undefined)
  assert.equal(findByName('', catalog), undefined)
})

test('a "Dim" row is resolved by its name, an override wins, and a mirror ball is not a light', () => {
  const row = (name: string, typeHint?: string) => ({ fixId: '#9', name, ...(typeHint ? { typeHint } : {}) })
  assert.equal(resolveType(row('ACL<<'), catalog).profileId, 'generic/acl-par64-250w')
  assert.equal(resolveType(row('DWE vorn'), catalog).profileId, 'generic/dwe-2-light-blinder')
  assert.equal(resolveType(row('Front<<'), catalog).profileId, 'arri/junior-650-plus')
  assert.equal(resolveType(row('Profil Back<'), catalog).profileId, 'etc/source-four-750-conventional')
  assert.equal(resolveType(row('Audience back'), catalog).profileId, 'generic/conventional-par')
  assert.equal(resolveType(row('Robin LED 150'), catalog).profileId, 'robe/robin-ledbeam-150')
  assert.ok(resolveType(row('Spiegelkugel Motor'), catalog).ignore)
  assert.equal(resolveType(row('Zoom1', 'Expolite Tourled MC60 Zoom'), catalog).source, 'alias')
  assert.equal(resolveType(row('ACL<<'), catalog, { '#9': 'martin/atomic-3000' }).profileId, 'martin/atomic-3000')
  assert.equal(resolveType(row('Zoom1', 'Expolite Tourled MC60 Zoom'), catalog, { 'type:expolite tourled mc60 zoom': 'martin/atomic-3000' }).source, 'override')
  const none = resolveType(row('Mystery', 'Acme Foo 3000'), catalog)
  assert.equal(none.profileId, undefined)
  assert.ok(none.note?.includes('custom.json'))
})

test('the DMX mode is found by name, then by channel count with the personality word', () => {
  assert.equal(resolveMode(byId('expolite/tourled-mc60-zoom'), { mode: '9Ch. SSP', channels: 9 }).mode, '9ch SSP')
  assert.equal(resolveMode(byId('chauvet-professional/rogue-r1x-spot'), { mode: '19Ch.', channels: 19 }).mode, '19ch')
  assert.equal(resolveMode(byId('martin/atomic-3000'), { mode: '4ch.', channels: 4 }).mode, '4-channel')
  assert.equal(resolveMode(byId('generic/acl-par64-250w'), { mode: 'Dim', channels: 1 }).mode, 'Dimmer')
  assert.equal(resolveMode(byId('stairville/mini-stage-par-7x4w-rgbw'), { mode: '4Ch. RGBW', channels: 4 }).mode, '4ch RGBW')
})

test('a mode that is only nearly right is returned with a note, and a missing one says what exists', () => {
  const rgb = resolveMode(byId('stairville/mini-stage-par-7x4w-rgbw'), { mode: '4Ch. RGB', channels: 4 })
  assert.equal(rgb.mode, '4ch RGBW')
  assert.ok(rgb.note?.includes('closest'))
  const none = resolveMode(byId('martin/atomic-3000'), { mode: '2ch.', channels: 2 })
  assert.equal(none.mode, undefined)
  assert.ok(none.note?.includes('1-channel'))
  assert.equal(resolveMode(byId('robe/robin-ledbeam-150'), { mode: 'Wash' }).mode, undefined)
})
