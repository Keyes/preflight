import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import type { CatalogFixture, RiderFile, RiderLamp, RiderPatchRow } from '@preflight/shared'
import { catalogFixtures } from '../services/catalog.js'
import { buildDrafts } from './draft.js'

let catalog: CatalogFixture[]
before(async () => {
  catalog = await catalogFixtures()
})

const row = (fixId: string, name: string, truss: string, extra: Partial<RiderPatchRow> = {}): RiderPatchRow => ({
  fixId,
  universe: 1,
  address: 1,
  name,
  modeRaw: 'Dim',
  mode: 'Dim',
  channels: 1,
  truss,
  ...extra,
})
const lamp = (lampId: string, x: number, y: number, extra: Partial<RiderLamp> = {}): RiderLamp => ({
  lampId,
  fixId: lampId.replace(/\.\d+$/, ''),
  planPx: [x, y],
  ...extra,
})
const similarity = { scale: 0.01, theta: 0, tx: 0, tz: 0 }

const rider: RiderFile = {
  version: 1,
  source: 't.pdf',
  readAt: '',
  patch: {
    rows: [
      row('#201', 'Zoom1', 'LX1', { modeRaw: '9Ch. SSP, Expolite Tourled MC60 Zoom', mode: '9Ch. SSP', typeHint: 'Expolite Tourled MC60 Zoom', channels: 9 }),
      row('#1', 'ACL<<', 'LX1'),
      row('#5', 'GasseSR', 'LX3'),
      row('#101', 'Spot 1', 'LX1', { modeRaw: '19Ch., Chauvet RX1 Spot', mode: '19Ch.', typeHint: 'Chauvet RX1 Spot', channels: 19 }),
      row('#25', 'Audience front', 'LX3'),
      row('#326', 'Spiegelkugel Motor', 'LX3/4'),
      row('#331', 'Spiku LED', 'LX3', { modeRaw: '4ch. CB-100', mode: '4ch.', typeHint: 'CB-100', channels: 4 }),
    ],
  },
  plan: {
    page: 2,
    image: { width: 3000, height: 3000 },
    trusses: { LX1: { underside: 4 }, LX3: { underside: 4.6 } },
    stage: {
      width: 10,
      depth: 4.7,
      height: 0.6,
      planPx: [
        [500, 1000],
        [1500, 1000],
      ],
    },
  },
  lamps: [
    lamp('#201', 600, 300, { trussOnPlan: 'LX1' }),
    lamp('#1.1', 700, 300, { trussOnPlan: 'LX1' }),
    lamp('#1.2', 900, 300, { trussOnPlan: 'LX1' }),
    lamp('#5', 520, 900), // on the stage deck, off any truss
    lamp('#101', 800, 320, { trussOnPlan: 'LX1', facingDeg: 180 }),
    lamp('#331', 520, 1400), // off any truss
    lamp('#232', 1000, 1300, { symbol: 'LED Zoom PAR' }), // not in the patch
  ],
  issues: [],
}

test('every patched light becomes a draft with its type, mode, patch, position and orientation', () => {
  const { drafts } = buildDrafts(rider, catalog, { similarity })
  const get = (key: string) => drafts.find((d) => d.key === key)!
  const zoom = get('#201')
  assert.equal(zoom.status, 'ready')
  assert.equal(zoom.profileId, 'expolite/tourled-mc60-zoom')
  assert.equal(zoom.mode, '9ch SSP')
  assert.deepEqual(zoom.patch, { fixId: '#201', universe: 1, address: 1, truss: 'LX1' })
  assert.deepEqual(zoom.placement?.position, [6, 4, -3])
  assert.equal(zoom.placement?.height, 'truss')
  assert.equal(zoom.placement?.mount, 'hanging')
  assert.deepEqual(zoom.placement?.rotation, [1, 0, 0, 0])
})

test('a number drawn twice gives two lights with their own lamp ids and one patch row', () => {
  const { drafts } = buildDrafts(rider, catalog, { similarity })
  const acl = drafts.filter((d) => d.fixId === '#1')
  assert.deepEqual(
    acl.map((d) => d.name),
    ['ACL<< 1', 'ACL<< 2'],
  )
  assert.deepEqual(
    acl.map((d) => d.patch?.lampId),
    ['#1.1', '#1.2'],
  )
  assert.ok(acl.every((d) => d.patch?.address === 1))
})

test('off a truss a light hangs from the ceiling, a Gasse light stands on the stage deck, and a moving head ignores the drawn direction', () => {
  const { drafts } = buildDrafts(rider, catalog, { similarity, ceilingHeight: 5.2, standHeight: 1.5 })
  const get = (key: string) => drafts.find((d) => d.key === key)!
  assert.equal(get('#331').placement?.height, 'ceiling')
  assert.equal(get('#331').placement?.position[1], 5.2)
  assert.equal(get('#5').placement?.mount, 'standing')
  assert.equal(get('#5').placement?.position[1], 0.6 + 1.5)
  assert.deepEqual(get('#101').placement?.rotation, [1, 0, 0, 0])
})

test('a light the plan shows and the patch does not needs its type chosen; one the patch has and the plan lacks has no position; a mirror ball is skipped', () => {
  const { drafts, issues } = buildDrafts(rider, catalog, { similarity })
  const get = (key: string) => drafts.find((d) => d.key === key)!
  assert.equal(get('#232').status, 'unmapped')
  assert.equal(get('#232').placement?.height, 'ceiling')
  assert.equal(get('#25').status, 'unplaced')
  assert.equal(get('#25').placement, undefined)
  assert.equal(get('#326').status, 'ignored')
  assert.ok(issues.some((i) => i.includes('#232')))
  assert.ok(issues.some((i) => i.includes('#25')))
})

test('a truss that differs between plan and patch uses the patch height and says so', () => {
  const conflicting = { ...rider, lamps: [lamp('#1.1', 700, 300, { trussOnPlan: 'LX3' })] }
  const d = buildDrafts(conflicting, catalog, { similarity }).drafts.find((x) => x.key === '#1.1')!
  assert.equal(d.placement?.position[1], 4)
  assert.ok(d.notes.some((n) => n.includes('LX3') && n.includes('LX1')))
})

test('truss groups list their lights from left to right', () => {
  const { groups } = buildDrafts(rider, catalog, { similarity })
  assert.deepEqual(groups.find((g) => g.name === 'LX1')?.keys, ['#201', '#1.1', '#101', '#1.2'])
})

test('a user override replaces the mapped type', () => {
  const { drafts } = buildDrafts(rider, catalog, { similarity, overrides: { '#1': 'martin/atomic-3000' } })
  assert.ok(drafts.filter((d) => d.fixId === '#1').every((d) => d.profileId === 'martin/atomic-3000'))
})

test("a light the patch lacks is typed by the user's choice, and is then ready", () => {
  const plain = buildDrafts(rider, catalog, { similarity }).drafts.find((d) => d.key === '#232')!
  assert.equal(plain.status, 'unmapped')
  const typed = buildDrafts(rider, catalog, { similarity, overrides: { '#232': 'stairville/mini-stage-par-7x4w-rgbw' } }).drafts.find((d) => d.key === '#232')!
  assert.equal(typed.status, 'ready')
  assert.equal(typed.profileId, 'stairville/mini-stage-par-7x4w-rgbw')
  assert.equal(typed.patch, undefined)
  assert.ok(typed.placement)
  assert.ok(!typed.notes.some((n) => n.startsWith('Choose')))
})
