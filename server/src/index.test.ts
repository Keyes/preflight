import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { DraftResult, RiderFile, Venue } from '@preflight/shared'

// The server as it runs: started as its own process, with its venues in a scratch folder, and asked over HTTP.

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

const dir = await mkdtemp(join(tmpdir(), 'preflight-http-'))
const port = await freePort()
const server = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./index.ts', import.meta.url))], {
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', VENUES_DIR: dir },
  stdio: ['ignore', 'pipe', 'inherit'],
})
await new Promise<void>((resolve, reject) => {
  server.stdout.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('preflight server on')) resolve()
  })
  server.once('exit', (code) => reject(new Error(`the server stopped before it was ready (exit code ${code})`)))
})

after(async () => {
  server.kill()
  await rm(dir, { recursive: true, force: true })
})

const base = `http://127.0.0.1:${port}/api`

/** Sends a request; an object body goes as JSON, a string as it is. */
async function call<T = { error: string }>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const json = body !== undefined && typeof body !== 'string'
  const res = await fetch(base + path, {
    method,
    headers: json ? { 'content-type': 'application/json', ...headers } : headers,
    body: json ? JSON.stringify(body) : body,
  })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T }
}

async function newVenue(name = 'Hall') {
  const { status, body } = await call<Venue>('POST', '/venues', { name })
  assert.equal(status, 201)
  return body
}

const light = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  profileId: 'generic-moving-head',
  position: [0, 3, 0],
  mount: 'hanging',
  yaw: 0,
  values: { dimmer: 1 },
  ...over,
})

const zone = { id: 'z', name: 'Front', x0: 0, z0: 0, x1: 4, z1: 3, y: 0, facing: [0, 10] }
const crowd = { shown: true, density: 0.5, motion: 'sway', intensity: 0.5, zones: [zone] }

/** A glTF model with one mesh and its data embedded. */
const gltf = {
  asset: { version: '2.0' },
  buffers: [{ byteLength: 4, uri: 'data:application/octet-stream;base64,AAAAAA==' }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
}

const rider = {
  version: 1,
  source: 'rider.pdf',
  readAt: '2026-01-01T00:00:00.000Z',
  patch: { rows: [{ fixId: '#1', universe: 1, address: 1, name: 'Spot', modeRaw: '16ch', mode: '16ch', truss: 'LX1' }] },
  issues: [],
}

test('refuses a request from another site', async () => {
  assert.equal((await call('POST', '/venues', { name: 'Hall' }, { origin: 'https://example.com' })).status, 403)
  assert.equal((await call('GET', '/health', undefined, { origin: `http://127.0.0.1:${port}` })).status, 200)
})

test('creates, renames, orders and deletes venues, and checks their names', async () => {
  for (const name of ['', '   ', 'x'.repeat(81), 42]) assert.equal((await call('POST', '/venues', { name })).status, 400, `name ${name}`)
  const a = await newVenue('Hall')
  const b = await newVenue('Club')
  assert.equal(a.status, 'empty')

  assert.equal((await call<Venue>('PATCH', `/venues/${a.id}`, { name: '  Main hall ' })).body.name, 'Main hall')
  assert.equal((await call('PATCH', `/venues/${a.id}`, {})).status, 400)

  assert.equal((await call('PUT', '/venues/order', { ids: [1, 2] })).status, 400)
  const ordered = await call<Venue[]>('PUT', '/venues/order', { ids: [b.id, a.id] })
  assert.deepEqual(
    ordered.body.map((v) => v.id).filter((id) => id === a.id || id === b.id),
    [b.id, a.id],
  )

  assert.equal((await call('DELETE', `/venues/${b.id}`)).status, 204)
  assert.equal((await call('GET', `/venues/${b.id}`)).status, 404)
})

test('checks haze, room light, crowd and hidden tags before it stores them', async () => {
  const { id } = await newVenue()
  for (const atmosphere of [{ haze: 1.5, ambient: 0.2 }, { haze: 0.5 }, null]) {
    assert.equal((await call('PATCH', `/venues/${id}`, { atmosphere })).status, 400, JSON.stringify(atmosphere))
  }
  const badCrowds = [
    { ...crowd, motion: 'jump' },
    { ...crowd, density: 2 },
    { ...crowd, zones: [zone, zone] },
    { ...crowd, zones: [{ ...zone, x1: 'far' }] },
    { ...crowd, zones: [{ ...zone, facing: [1] }] },
  ]
  for (const bad of badCrowds) assert.equal((await call('PATCH', `/venues/${id}`, { crowd: bad })).status, 400, JSON.stringify(bad))
  assert.equal((await call('PATCH', `/venues/${id}`, { hiddenTags: 'Ceiling' })).status, 400)

  const saved = await call<Venue>('PATCH', `/venues/${id}`, {
    atmosphere: { haze: 0.3, ambient: 0.1 },
    crowd,
    hiddenTags: ['Ceiling', 'Ceiling', 'Bar'],
  })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.atmosphere, { haze: 0.3, ambient: 0.1 })
  assert.equal(saved.body.crowd?.zones[0].shown, true) // a zone shows unless it says otherwise
  assert.deepEqual(saved.body.hiddenTags, ['Ceiling', 'Bar'])
})

test('checks every light, normalizes its rotation, and drops group members that do not exist', async () => {
  const { id } = await newVenue()
  const bad = [
    light('a', { profileId: '' }),
    light('a', { position: [0, 'up', 0] }),
    light('a', { mount: 'floating' }),
    light('a', { values: { dimmer: 1.5 } }),
    light('a', { values: { 'Dimmer!': 1 } }),
    light('a', { rotation: [0, 0, 0, 0] }),
    light('a', { patch: { fixId: '#1', universe: 1, address: 513 } }),
  ]
  for (const fixture of bad) assert.equal((await call('PUT', `/venues/${id}/fixtures`, { fixtures: [fixture] })).status, 400, JSON.stringify(fixture))
  assert.equal((await call('PUT', `/venues/${id}/fixtures`, { fixtures: [light('a'), light('a')] })).status, 400)
  // the answer says where the problem is
  const where = await call('PUT', `/venues/${id}/fixtures`, { fixtures: [light('a'), light('b', { position: [0, 'up', 0] })] })
  assert.match(where.body.error, /^fixtures\.1\.position\.1: /)

  const saved = await call<Venue>('PUT', `/venues/${id}/fixtures`, {
    fixtures: [light('a', { rotation: [0, 0, 0, 2], patch: { fixId: '#1', universe: 1, address: 1, truss: 'LX1' } }), light('b')],
    groups: [{ id: 'g', name: 'Front', fixtureIds: ['b', 'gone', 'a', 'b'] }],
  })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.fixtures?.[0].rotation, [0, 0, 0, 1])
  assert.deepEqual(saved.body.fixtures?.[0].patch, { fixId: '#1', universe: 1, address: 1, truss: 'LX1' })
  assert.deepEqual(saved.body.groups?.[0].fixtureIds, ['b', 'a'])
})

test('appends lights, groups and crowd zones to those already there, and refuses ids that are taken', async () => {
  const { id } = await newVenue()
  await call('PUT', `/venues/${id}/fixtures`, { fixtures: [light('a')] })
  const appended = await call<Venue>('POST', `/venues/${id}/append`, {
    fixtures: [light('b')],
    groups: [{ id: 'g', name: 'Copied', fixtureIds: ['b'] }],
    zones: [zone],
  })
  assert.equal(appended.status, 200)
  assert.deepEqual(
    appended.body.fixtures?.map((f) => f.id),
    ['a', 'b'],
  )
  assert.deepEqual(appended.body.groups?.[0].fixtureIds, ['b'])
  assert.equal(appended.body.crowd?.zones.length, 1) // a venue without a crowd gets one with the defaults
  assert.equal((await call('POST', `/venues/${id}/append`, { fixtures: [light('a')] })).status, 400)
})

test('saved views need unique ids and a finite position and rotation', async () => {
  const { id } = await newVenue()
  const view = { id: 'v1', name: 'FOH', position: [0, 1.7, -5], rotation: [0, 0, 0] }
  assert.equal((await call('PUT', `/venues/${id}/views`, { views: [view, view] })).status, 400)
  assert.equal((await call('PUT', `/venues/${id}/views`, { views: [{ ...view, position: [0, null, 0] }] })).status, 400)
  assert.deepEqual((await call<Venue>('PUT', `/venues/${id}/views`, { views: [view] })).body.views, [view])
})

test('refuses a body that is not JSON or is too large', async () => {
  const { id } = await newVenue()
  assert.equal((await call('PATCH', `/venues/${id}`, '{"name":')).status, 400)
  assert.equal((await call('PATCH', `/venues/${id}`, { hiddenTags: Array<string>(20000).fill('tag') })).status, 413)
})

test('takes a self-contained glTF as the model and serves it as a GLB', async () => {
  const { id } = await newVenue()
  const uploaded = await call<Venue>('POST', `/venues/${id}/model`, JSON.stringify(gltf))
  assert.equal(uploaded.status, 200)
  assert.equal(uploaded.body.status, 'ready')
  assert.equal(uploaded.body.modelFormat, 'glb')

  const res = await fetch(`${base}/venues/${id}/model.glb?v=${uploaded.body.modelHash}`)
  assert.equal(res.headers.get('content-type'), 'model/gltf-binary')
  assert.equal(
    Buffer.from(await res.arrayBuffer())
      .subarray(0, 4)
      .toString(),
    'glTF',
  )

  assert.equal((await call('POST', `/venues/${id}/reconvert`)).status, 409) // nothing to convert
})

test('refuses a model that is empty, of another kind, or a glTF without meshes, and keeps the venue as it was', async () => {
  const { id } = await newVenue()
  assert.equal((await call('POST', `/venues/${id}/model`, '')).status, 400)
  assert.equal((await call('POST', `/venues/${id}/model`, 'hello, this is not a model')).status, 400)
  const noMeshes = await call('POST', `/venues/${id}/model`, JSON.stringify({ ...gltf, meshes: [] }))
  assert.equal(noMeshes.status, 422)
  assert.match(noMeshes.body.error, /no meshes/)
  assert.equal((await call<Venue>('GET', `/venues/${id}`)).body.status, 'empty')
})

test('checks a rider file before it stores it, and drafts the lights only for a sensible calibration', async () => {
  const { id } = await newVenue()
  assert.equal((await call('GET', `/venues/${id}/rider`)).status, 404)
  assert.equal((await call('PUT', `/venues/${id}/rider`, { ...rider, version: 2 })).status, 400)
  assert.equal((await call('PUT', `/venues/${id}/rider`, { ...rider, patch: { rows: [{ fixId: '#1' }] } })).status, 400)
  assert.equal((await call('PUT', `/venues/${id}/rider`, rider)).status, 200)
  assert.equal((await call<RiderFile>('GET', `/venues/${id}/rider`)).body.patch.rows[0].name, 'Spot')

  const similarity = { scale: 0.01, theta: 0, tx: 0, tz: 0 }
  assert.equal((await call('POST', `/venues/${id}/rider/drafts`, { similarity: { ...similarity, scale: 0 } })).status, 400)
  assert.equal((await call('POST', `/venues/${id}/rider/drafts`, { similarity, ceilingHeight: 500 })).status, 400)
  const drafts = await call<DraftResult>('POST', `/venues/${id}/rider/drafts`, { similarity })
  assert.equal(drafts.status, 200)
  assert.deepEqual(
    drafts.body.drafts.map((d) => d.fixId),
    ['#1'],
  )
})

test('takes only a PDF as the rider', async () => {
  const { id } = await newVenue()
  const notPdf = await call('POST', `/venues/${id}/rider`, 'plain text, not a PDF')
  assert.equal(notPdf.status, 400)
  assert.match(notPdf.body.error, /not a PDF/)
  const tooShort = await call('POST', `/venues/${id}/rider`, '%P')
  assert.equal(tooShort.status, 400)
  assert.match(tooShort.body.error, /not a PDF/)
})

test('answers 404 for a venue or a path that does not exist, and 405 for a method a path does not take', async () => {
  const missing = '00000000-0000-4000-8000-000000000000'
  assert.equal((await call('GET', `/venues/${missing}`)).status, 404)
  assert.equal((await call('GET', `/venues/${missing}/rider`)).status, 404)
  assert.equal((await call('GET', '/venues/not-an-id/rider')).status, 404)
  assert.equal((await call('GET', '/nothing')).status, 404)
  assert.equal((await call('PUT', `/venues/${missing}/model.glb`)).status, 405)
})
