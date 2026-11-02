import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// venues.ts reads VENUES_DIR when it loads, so it is imported only after pointing that at a scratch folder
const dir = await mkdtemp(join(tmpdir(), 'preflight-demo-'))
process.env.VENUES_DIR = dir
const { createDemoVenue } = await import('./demo.js')
const { getVenue, glbPath, venueDir } = await import('./venues.js')
const { catalogFixtures } = await import('./catalog.js')

after(() => rm(dir, { recursive: true, force: true }))

const samples = fileURLToPath(new URL('../../samples/', import.meta.url))

test('the demo venue opens with its model, lights, groups, haze, crowd and views', async () => {
  const venue = await createDemoVenue()
  assert.equal(venue.name, 'Demo club')
  assert.equal(venue.status, 'ready')
  assert.equal(venue.modelFormat, 'glb')
  assert.match(venue.modelHash ?? '', /^[0-9a-f]{64}$/)
  assert.ok((venue.fixtures?.length ?? 0) > 0)
  assert.ok((venue.groups?.length ?? 0) > 0)
  assert.ok((venue.views?.length ?? 0) > 0)
  assert.ok(venue.atmosphere && venue.crowd)
  assert.deepEqual(await getVenue(venue.id), venue)
  assert.deepEqual((await readdir(venueDir(venue.id))).sort(), ['model.glb', 'venue.json'])
  assert.deepEqual(await readFile(glbPath(venue.id)), await readFile(join(samples, 'demo-club.glb')))
})

test('every demo light is in the fixture catalog, and every group lists demo lights only', async () => {
  const preset = JSON.parse(await readFile(join(samples, 'demo-club.json'), 'utf8'))
  const catalog = new Set((await catalogFixtures()).map((f) => f.id))
  const ids = new Set<string>()
  for (const fixture of preset.fixtures) {
    assert.ok(catalog.has(fixture.profileId), `${fixture.profileId} is not in the catalog`)
    assert.ok(!ids.has(fixture.id), `${fixture.id} is used twice`)
    ids.add(fixture.id)
    for (const [key, value] of Object.entries(fixture.values)) {
      assert.ok(typeof value === 'number' && value >= 0 && value <= 1, `${fixture.name}: ${key} is ${value}, not 0..1`)
    }
  }
  for (const group of preset.groups) for (const id of group.fixtureIds) assert.ok(ids.has(id), `${group.name} lists ${id}`)
})

test('adding the demo again makes a second venue, listed after the first', async () => {
  const a = await createDemoVenue()
  const b = await createDemoVenue()
  assert.notEqual(a.id, b.id)
  assert.ok(b.sortIndex > a.sortIndex)
  assert.ok(await getVenue(a.id))
})
