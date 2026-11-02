import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendBody, check, fixturesBody, riderDraftsBody, venuePatchBody } from './requests.js'
import { riderFileSchema } from './rider.js'
import { crowdZoneSchema, fixtureSchema, hiddenTagsSchema, viewListSchema } from './venue.js'

const light = { id: 'a', name: ' Wash 1 ', profileId: 'generic-moving-head', position: [0, 3, 0], mount: 'hanging', yaw: 0 }

const problemOf = (result: ReturnType<typeof check>) => (result.ok ? null : result.problem)

test('a light comes back tidied: name trimmed, rotation at length 1, no values given is none, unknown fields dropped', () => {
  const result = check(fixtureSchema, { ...light, rotation: [0, 0, 0, 2], extra: 'dropped' })
  assert.ok(result.ok)
  assert.deepEqual(result.value, { ...light, name: 'Wash 1', rotation: [0, 0, 0, 1], values: {} })
})

test('a light that does not fit says what and where', () => {
  assert.equal(problemOf(check(fixtureSchema, { ...light, name: '   ' })), 'name: must be 1 to 80 characters')
  assert.equal(problemOf(check(fixtureSchema, { ...light, rotation: [0, 0, 0, 0] })), 'rotation: a rotation cannot be all zeros')
  assert.match(problemOf(check(fixtureSchema, { ...light, position: [0, null, 0] }))!, /^position\.1: /)
  assert.match(problemOf(check(fixtureSchema, { ...light, values: { Pan: 0.5 } }))!, /^values\.Pan: /)
  assert.match(problemOf(check(fixtureSchema, { ...light, values: { pan: 1.5 } }))!, /^values\.pan: /)
  assert.match(problemOf(check(fixtureSchema, { ...light, patch: { fixId: '#1', universe: 1, address: 513 } }))!, /^patch\.address: /)
})

test('lists refuse an id twice, and too many', () => {
  assert.equal(problemOf(check(fixturesBody, { fixtures: [light, light] })), 'fixtures: every id must be unique')
  const view = { id: 'v', name: 'Stage', position: [0, 1, 0], rotation: [0, 0, 0] }
  assert.match(
    problemOf(
      check(
        viewListSchema,
        Array.from({ length: 101 }, (_, i) => ({ ...view, id: `v${i}` })),
      ),
    )!,
    /too big/i,
  )
})

test('a crowd zone shows unless it says otherwise, and hidden tags are kept once each', () => {
  const zone = { id: 'z', name: 'Floor', x0: 0, z0: 0, x1: 4, z1: 3, y: 0, facing: null }
  assert.deepEqual(check(crowdZoneSchema, zone), { ok: true, value: { ...zone, shown: true } })
  assert.deepEqual(check(hiddenTagsSchema, ['Ceiling', 'Ceiling', 'Roof']), { ok: true, value: ['Ceiling', 'Roof'] })
})

test('request bodies: a PATCH must change something, append lists default to empty, draft options have limits', () => {
  assert.equal(problemOf(check(venuePatchBody, {})), 'nothing to change')
  assert.deepEqual(check(appendBody, {}), { ok: true, value: { fixtures: [], groups: [], zones: [] } })
  const similarity = { scale: 0.01, theta: 0, tx: 0, tz: 0 }
  assert.ok(check(riderDraftsBody, { similarity }).ok)
  assert.match(problemOf(check(riderDraftsBody, { similarity: { ...similarity, scale: 0 } }))!, /^similarity\.scale: /)
  assert.match(problemOf(check(riderDraftsBody, { similarity, ceilingHeight: 500 }))!, /^ceilingHeight: /)
})

test('a rider file keeps what it was sent with, and its notes are strings only', () => {
  const rider = {
    version: 1,
    source: 'rider.pdf',
    readAt: '2026-01-01',
    patch: { rows: [{ fixId: '#1', universe: 1, address: 1, name: 'Zoom1', modeRaw: 'Dim', mode: 'Dim', truss: 'LX1' }] },
    issues: ['row 3 unreadable', 42],
  }
  const result = check(riderFileSchema, rider)
  assert.ok(result.ok)
  assert.deepEqual(result.value, { ...rider, issues: ['row 3 unreadable'] })
  assert.match(problemOf(check(riderFileSchema, { ...rider, version: 2 }))!, /^version: /)
  assert.match(problemOf(check(riderFileSchema, { ...rider, patch: { rows: [{ fixId: '#1' }] } }))!, /^patch\.rows\.0\./)
})
