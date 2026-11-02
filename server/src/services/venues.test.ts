import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// venues.ts reads VENUES_DIR when it loads, so it is imported only after pointing that at a scratch folder
const dir = await mkdtemp(join(tmpdir(), 'preflight-venues-'))
process.env.VENUES_DIR = dir
const { createVenue, getVenue, updateVenue, venueDir } = await import('./venues.js')

after(() => rm(dir, { recursive: true, force: true }))

test('changes sent at the same time all land, in the order they came', async () => {
  const venue = await createVenue('Hall')
  // several PATCHes at once, as "Show all" used to send: none may fail, and none may undo another's field
  const updates = await Promise.all([
    updateVenue(venue.id, { atmosphere: { haze: 0.3, ambient: 0.2 } }),
    ...Array.from({ length: 20 }, (_, i) => updateVenue(venue.id, { hiddenTags: [`tag ${i}`] })),
    updateVenue(venue.id, { name: 'Main hall' }),
  ])
  assert.ok(updates.every((v) => v?.id === venue.id))
  const saved = await getVenue(venue.id)
  assert.equal(saved?.name, 'Main hall')
  assert.deepEqual(saved?.atmosphere, { haze: 0.3, ambient: 0.2 })
  assert.deepEqual(saved?.hiddenTags, ['tag 19'])
  assert.deepEqual(await readdir(venueDir(venue.id)), ['venue.json'])
})

test('a change to a venue that is gone returns nothing', async () => {
  assert.equal(await updateVenue('00000000-0000-4000-8000-000000000000', { name: 'x' }), undefined)
})
