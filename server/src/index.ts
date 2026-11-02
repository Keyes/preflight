import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { WebSocketServer } from 'ws'
import { catalogJson } from './catalog.js'
import { HttpError, readJson, sendJson } from './http.js'
import { handleRider } from './rider/api.js'
import { convertSkp, converterVersion } from './convert.js'
import { createDemoVenue } from './demo.js'
import { requestAllowed } from './origin.js'
import { HEAD_BYTES, ModelError, type ModelFormat, detectModelFormat, prepareGltfModel } from './model.js'
import {
  type CameraView,
  type FixtureGroup,
  type FixturePatch,
  type Atmosphere,
  type Crowd,
  type CrowdZone,
  type Fixture,
  type Venue,
  createVenue,
  deleteVenue,
  duplicateVenue,
  getVenue,
  glbPath,
  isValidId,
  listVenues,
  reorderVenues,
  skpPath,
  updateVenue,
  venueDir,
} from './venues.js'

const PORT = Number(process.env.PORT ?? 3001)
// Only this machine by default: there is no login. HOST=0.0.0.0 opens it to the network.
const HOST = process.env.HOST ?? '127.0.0.1'
const MAX_UPLOAD = 500 * 1024 * 1024

const isVec3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))

function cleanViews(value: unknown): CameraView[] {
  if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, 'views must be an array of at most 100')
  const seen = new Set<string>()
  return value.map((raw) => {
    const id = typeof raw?.id === 'string' && raw.id.length <= 64 ? raw.id : ''
    if (!id || seen.has(id)) throw new HttpError(400, 'every view needs a unique id')
    seen.add(id)
    if (!isVec3(raw.position) || !isVec3(raw.rotation)) throw new HttpError(400, 'invalid camera position or rotation')
    return { id, name: cleanName(raw.name), position: raw.position, rotation: raw.rotation }
  })
}

/** Groups keep only lights that exist in the same save, so deleted lights do not pile up in them. */
function cleanGroups(value: unknown, known: ReadonlySet<string>): FixtureGroup[] {
  if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, 'groups must be an array of at most 100')
  const seen = new Set<string>()
  return value.map((raw) => {
    const id = typeof raw?.id === 'string' && raw.id.length <= 64 ? raw.id : ''
    if (!id || seen.has(id)) throw new HttpError(400, 'every group needs a unique id')
    seen.add(id)
    if (!Array.isArray(raw.fixtureIds) || raw.fixtureIds.length > 500) throw new HttpError(400, 'a group holds at most 500 lights')
    const members = raw.fixtureIds.filter((x: unknown): x is string => typeof x === 'string' && known.has(x))
    return { id, name: cleanName(raw.name), fixtureIds: [...new Set<string>(members)] }
  })
}

function cleanAtmosphere(value: unknown): Atmosphere {
  const v = value as Partial<Atmosphere> | null
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
  if (!v || !ok(v.haze) || !ok(v.ambient)) throw new HttpError(400, 'haze and ambient must be numbers from 0 to 1')
  return { haze: v.haze, ambient: v.ambient }
}

function cleanCrowd(value: unknown): Crowd {
  const v = value as Partial<Crowd> | null
  const unit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
  const coord = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 10000
  if (!v || typeof v.shown !== 'boolean' || !unit(v.density) || !unit(v.intensity) || !['still', 'sway', 'dance'].includes(v.motion as string)) {
    throw new HttpError(400, 'invalid crowd options')
  }
  if (!Array.isArray(v.zones) || v.zones.length > 50) throw new HttpError(400, 'a venue holds at most 50 crowd zones')
  const seen = new Set<string>()
  const zones = v.zones.map((raw): CrowdZone => {
    const id = typeof raw?.id === 'string' && raw.id.length <= 64 ? raw.id : ''
    if (!id || seen.has(id)) throw new HttpError(400, 'every crowd zone needs a unique id')
    seen.add(id)
    if (![raw.x0, raw.z0, raw.x1, raw.z1, raw.y].every(coord)) throw new HttpError(400, 'invalid crowd zone corners')
    const facing = raw.facing
    if (facing !== null && !(Array.isArray(facing) && facing.length === 2 && facing.every(coord))) throw new HttpError(400, 'invalid crowd facing')
    return { id, name: cleanName(raw.name), x0: raw.x0, z0: raw.z0, x1: raw.x1, z1: raw.z1, y: raw.y, facing: facing === null ? null : [facing[0], facing[1]], shown: raw.shown !== false }
  })
  return { shown: v.shown, density: v.density, motion: v.motion as Crowd['motion'], intensity: v.intensity, zones }
}

function cleanHiddenTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500 || !value.every((t) => typeof t === 'string' && t.length > 0 && t.length <= 200)) {
    throw new HttpError(400, 'hiddenTags must be an array of tag names')
  }
  return [...new Set(value as string[])]
}

const VALUE_KEY = /^[a-z][a-zA-Z0-9_]{0,31}$/

function cleanFixtures(value: unknown): Fixture[] {
  if (!Array.isArray(value) || value.length > 500) throw new HttpError(400, 'fixtures must be an array of at most 500')
  const seen = new Set<string>()
  return value.map((raw) => {
    const id = typeof raw?.id === 'string' && raw.id.length <= 64 ? raw.id : ''
    if (!id || seen.has(id)) throw new HttpError(400, 'every fixture needs a unique id')
    seen.add(id)
    const profileId = typeof raw.profileId === 'string' && raw.profileId.length <= 64 ? raw.profileId : ''
    if (!profileId) throw new HttpError(400, 'fixture needs a profileId')
    if (!isVec3(raw.position)) throw new HttpError(400, 'invalid fixture position')
    if (raw.mount !== 'hanging' && raw.mount !== 'standing') throw new HttpError(400, 'invalid fixture mount')
    if (typeof raw.yaw !== 'number' || !Number.isFinite(raw.yaw)) throw new HttpError(400, 'invalid fixture yaw')
    let rotation: [number, number, number, number] | undefined
    if (raw.rotation !== undefined) {
      const q = raw.rotation
      if (!Array.isArray(q) || q.length !== 4 || !q.every((n: unknown) => typeof n === 'number' && Number.isFinite(n))) {
        throw new HttpError(400, 'invalid fixture rotation')
      }
      const length = Math.hypot(q[0], q[1], q[2], q[3])
      if (length < 1e-6) throw new HttpError(400, 'invalid fixture rotation')
      rotation = [q[0] / length, q[1] / length, q[2] / length, q[3] / length]
    }
    const entries = Object.entries(raw.values ?? {})
    if (entries.length > 32) throw new HttpError(400, 'too many fixture values')
    const values: Record<string, number> = {}
    for (const [key, v] of entries) {
      if (!VALUE_KEY.test(key) || typeof v !== 'number' || !(v >= 0 && v <= 1)) {
        throw new HttpError(400, `invalid fixture value "${key}"`)
      }
      values[key] = v
    }
    const fixture: Fixture = { id, name: cleanName(raw.name), profileId, position: raw.position, mount: raw.mount, yaw: raw.yaw, values }
    if (rotation) fixture.rotation = rotation
    if (raw.mode !== undefined) {
      if (typeof raw.mode !== 'string' || raw.mode.length > 80) throw new HttpError(400, 'invalid fixture mode')
      fixture.mode = raw.mode
    }
    if (raw.castShadows !== undefined) {
      if (typeof raw.castShadows !== 'boolean') throw new HttpError(400, 'invalid fixture castShadows')
      fixture.castShadows = raw.castShadows
    }
    if (raw.patch !== undefined) fixture.patch = cleanPatch(raw.patch)
    return fixture
  })
}

function cleanPatch(value: unknown): FixturePatch {
  const v = (value ?? {}) as Partial<FixturePatch>
  const text = (s: unknown) => typeof s === 'string' && s.length > 0 && s.length <= 40
  if (!text(v.fixId) || !Number.isInteger(v.universe) || (v.universe as number) < 1 || !Number.isInteger(v.address) || (v.address as number) < 1 || (v.address as number) > 512) {
    throw new HttpError(400, 'invalid fixture patch')
  }
  const patch: FixturePatch = { fixId: v.fixId as string, universe: v.universe as number, address: v.address as number }
  if (v.lampId !== undefined) {
    if (!text(v.lampId)) throw new HttpError(400, 'invalid fixture patch lampId')
    patch.lampId = v.lampId
  }
  if (v.truss !== undefined) {
    if (!text(v.truss)) throw new HttpError(400, 'invalid fixture patch truss')
    patch.truss = v.truss
  }
  return patch
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > 80) throw new HttpError(400, 'name must be 1-80 characters')
  return name
}

const UNKNOWN_FORMAT = 'not a SketchUp (.skp) or glTF (.glb, .gltf) file'

/** Streams the request body to disk, hashing it, telling its format from the first bytes and enforcing the size limit. */
async function receiveModel(req: IncomingMessage, target: string): Promise<{ hash: string; format: ModelFormat }> {
  const hash = createHash('sha256')
  let size = 0
  let head = Buffer.alloc(0)
  let format: ModelFormat | null = null
  const guard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length
      if (size > MAX_UPLOAD) return cb(new HttpError(413, 'file too large'))
      if (head.length < HEAD_BYTES) {
        head = Buffer.concat([head, chunk]).subarray(0, HEAD_BYTES)
        if (head.length === HEAD_BYTES && !(format = detectModelFormat(head))) return cb(new HttpError(400, UNKNOWN_FORMAT))
      }
      hash.update(chunk)
      cb(null, chunk)
    },
  })
  try {
    await pipeline(req, guard, createWriteStream(target))
  } catch (err) {
    await rm(target, { force: true })
    throw err
  }
  format ??= size > 0 ? detectModelFormat(head) : null // a file shorter than the head
  if (!format) {
    await rm(target, { force: true })
    throw new HttpError(400, size === 0 ? 'empty upload' : UNKNOWN_FORMAT)
  }
  return { hash: hash.digest('hex'), format }
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (!requestAllowed(req.headers)) throw new HttpError(403, 'request from another site or host refused (see PREFLIGHT_ALLOWED_HOSTS in the README)')
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'

  if (path === '/api/health') return sendJson(res, 200, { ok: true })

  if (path === '/api/fixtures/catalog' && method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
    return res.end(await catalogJson())
  }

  if (path === '/api/venues') {
    if (method === 'GET') return sendJson(res, 200, await listVenues())
    if (method === 'POST') {
      const body = await readJson(req)
      return sendJson(res, 201, await createVenue(cleanName(body.name)))
    }
  }

  if (path === '/api/venues/demo' && method === 'POST') return sendJson(res, 201, await createDemoVenue())

  if (path === '/api/venues/order' && method === 'PUT') {
    const body = await readJson(req)
    if (!Array.isArray(body.ids) || !body.ids.every((id: unknown) => typeof id === 'string')) {
      throw new HttpError(400, 'ids must be an array of venue ids')
    }
    return sendJson(res, 200, await reorderVenues(body.ids))
  }

  const rider = path.match(/^\/api\/venues\/([^/]+)\/rider(?:\/(plan|plan\.png|drafts))?$/)
  if (rider) {
    if (!isValidId(rider[1]) || !(await getVenue(rider[1]))) throw new HttpError(404, 'venue not found')
    return handleRider(req, res, rider[1], rider[2], method)
  }

  const m = path.match(/^\/api\/venues\/([^/]+)(?:\/(model|model\.glb|views|fixtures|append|duplicate|reconvert))?$/)
  if (m) {
    const [, id, sub] = m
    const venue = await getVenue(id)
    if (!venue) throw new HttpError(404, 'venue not found')

    if (!sub && method === 'GET') return sendJson(res, 200, venue)

    if (!sub && method === 'DELETE') {
      await deleteVenue(id)
      return void res.writeHead(204).end()
    }

    if (!sub && method === 'PATCH') {
      const body = await readJson(req)
      const patch: Partial<Venue> = {}
      if (body.name !== undefined) patch.name = cleanName(body.name)
      if (body.atmosphere !== undefined) patch.atmosphere = cleanAtmosphere(body.atmosphere)
      if (body.crowd !== undefined) patch.crowd = cleanCrowd(body.crowd)
      if (body.hiddenTags !== undefined) patch.hiddenTags = cleanHiddenTags(body.hiddenTags)
      if (Object.keys(patch).length === 0) throw new HttpError(400, 'nothing to change')
      return sendJson(res, 200, await updateVenue(id, patch))
    }

    if (sub === 'duplicate' && method === 'POST') {
      return sendJson(res, 201, await duplicateVenue(id))
    }

    // Converts the stored SketchUp file again with the converter as built now (for models made by an older build), and
    // swaps the result in only when that worked.
    if (sub === 'reconvert' && method === 'POST') {
      if (venue.status !== 'ready') throw new HttpError(409, 'the venue has no model to convert')
      if (venue.modelFormat === 'glb') throw new HttpError(409, 'the model was uploaded as glTF, so there is nothing to convert')
      const nextGlb = `${glbPath(id)}.new`
      const version = await converterVersion()
      try {
        await convertSkp(skpPath(id), nextGlb)
      } catch (err) {
        await rm(nextGlb, { force: true })
        return sendJson(res, 422, { error: `The model could not be converted: ${(err as Error).message}` })
      }
      await rename(nextGlb, glbPath(id))
      return sendJson(res, 200, await updateVenue(id, { converterVersion: version, modelHash: `${venue.modelHash ?? ''}`.replace(/\+.*$/, '') + `+${Date.now()}` }))
    }

    if (sub === 'views' && method === 'PUT') {
      const body = await readJson(req)
      return sendJson(res, 200, await updateVenue(id, { views: cleanViews(body.views) }))
    }

    // Adds lights and groups (copied from another venue) to the ones already placed. The ids must be new.
    if (sub === 'append' && method === 'POST') {
      const body = await readJson(req, 1024 * 1024)
      const fixtures = cleanFixtures([...(venue.fixtures ?? []), ...(Array.isArray(body.fixtures) ? body.fixtures : [])])
      const groups = cleanGroups(
        [...(venue.groups ?? []), ...(Array.isArray(body.groups) ? body.groups : [])],
        new Set(fixtures.map((f) => f.id)),
      )
      const patch: Partial<Venue> = { fixtures, groups }
      // crowd zones come along too; the crowd's options stay as they are (a venue without a crowd gets the defaults)
      if (Array.isArray(body.zones) && body.zones.length) {
        const base = venue.crowd ?? { shown: true, density: 0.5, motion: 'sway' as const, intensity: 0.5, zones: [] }
        patch.crowd = cleanCrowd({ ...base, zones: [...base.zones, ...body.zones] })
      }
      return sendJson(res, 200, await updateVenue(id, patch))
    }

    if (sub === 'fixtures' && method === 'PUT') {
      const body = await readJson(req, 1024 * 1024)
      const fixtures = cleanFixtures(body.fixtures)
      const patch: Partial<Venue> = { fixtures }
      if (body.groups !== undefined) patch.groups = cleanGroups(body.groups, new Set(fixtures.map((f) => f.id)))
      return sendJson(res, 200, await updateVenue(id, patch))
    }

    // Upload a model (raw body): a .skp is converted to GLB, a .glb or self-contained .gltf is checked and used as it is.
    if (sub === 'model' && method === 'POST') {
      const upload = join(venueDir(id), 'model.upload')
      const { hash, format } = await receiveModel(req, upload)
      if (format !== 'skp') {
        // Prepared on the side and swapped in only when it is fine, so a bad file leaves the venue as it was.
        const nextGlb = `${glbPath(id)}.new`
        try {
          await prepareGltfModel(upload, format, nextGlb)
        } catch (err) {
          await rm(nextGlb, { force: true })
          if (!(err instanceof ModelError)) throw err
          return sendJson(res, 422, { error: `The model could not be used: ${err.message}.` })
        }
        await rename(nextGlb, glbPath(id))
        await rm(skpPath(id), { force: true }) // a SketchUp file from before would no longer match the model
        return sendJson(res, 200, await updateVenue(id, { status: 'ready', modelFormat: 'glb', modelHash: hash, converterVersion: undefined, error: undefined }))
      }
      if (venue.status === 'ready') {
        // Replacing the model of a working venue: convert the new file on the side, and only swap it in when that worked,
        // so a bad file leaves the venue as it was.
        const next = join(venueDir(id), 'model.new.skp')
        const nextGlb = `${glbPath(id)}.new`
        await rename(upload, next)
        const version = await converterVersion()
        try {
          await convertSkp(next, nextGlb)
        } catch (err) {
          await rm(next, { force: true })
          await rm(nextGlb, { force: true })
          return sendJson(res, 422, { error: `The new model could not be converted: ${(err as Error).message}` })
        }
        await rename(next, skpPath(id))
        await rename(nextGlb, glbPath(id))
        return sendJson(res, 200, await updateVenue(id, { status: 'ready', modelFormat: 'skp', modelHash: hash, converterVersion: version, error: undefined }))
      }
      await rename(upload, skpPath(id))
      const version = await converterVersion()
      const cached =
        venue.modelFormat !== 'glb' && hash === venue.modelHash && venue.converterVersion === version && (await stat(glbPath(id)).catch(() => null))
      if (!cached) {
        try {
          await convertSkp(skpPath(id), glbPath(id))
        } catch (err) {
          const updated = await updateVenue(id, {
            status: 'error',
            modelHash: undefined,
            error: (err as Error).message,
          })
          return sendJson(res, 422, updated)
        }
      }
      return sendJson(res, 200, await updateVenue(id, { status: 'ready', modelFormat: 'skp', modelHash: hash, converterVersion: version }))
    }

    if (sub === 'model.glb' && method === 'GET') {
      const info = await stat(glbPath(id)).catch(() => null)
      if (!info) throw new HttpError(404, 'no model yet')
      res.writeHead(200, {
        'content-type': 'model/gltf-binary',
        'content-length': info.size,
        // The client appends ?v=<modelHash>, so a given URL never changes.
        'cache-control': 'public, max-age=31536000, immutable',
      })
      return void createReadStream(glbPath(id)).pipe(res)
    }
  }

  throw new HttpError(404, 'not found')
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message })
    console.error(err)
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
    else res.destroy()
  })
})

// Later: DMX/Art-Net frames get pushed to clients over this socket.
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }: { req: IncomingMessage }) => requestAllowed(req.headers) })
wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'hello' }))
})

server.listen(PORT, HOST, () => console.log(`preflight server on ${HOST}:${PORT}`))
