import { createWriteStream } from 'node:fs'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { catalogFixtures } from '../catalog.js'
import { HttpError, readJson, sendJson } from '../http.js'
import { venueDir } from '../venues.js'
import { buildDrafts } from './draft.js'
import { readPatch } from './patch.js'
import type { Similarity, RiderFile } from '@preflight/shared'
import './vision/anthropic.js'
import { readPlan, withPlan } from './vision/plan.js'
import { createProvider, providerNames } from './vision/provider.js'
import { cropPng, renderPage } from './vision/render.js'

/**
 * The tech rider of a venue: the PDF (`rider.pdf`) and what was read from it (`rider.json`, a RiderFile), both in the
 * venue's folder. The wizard in the client reads the patch from the PDF's text, optionally reads the plan with a vision model,
 * shows the plan picture for calibration, and asks for drafts of the lights.
 */

const MAX_PDF = 40 * 1024 * 1024
const PDF_MAGIC = Buffer.from('%PDF')
const jsonPath = (id: string) => join(venueDir(id), 'rider.json')
const pdfPath = (id: string) => join(venueDir(id), 'rider.pdf')

async function readRider(id: string): Promise<RiderFile> {
  try {
    return JSON.parse(await readFile(jsonPath(id), 'utf8')) as RiderFile
  } catch {
    throw new HttpError(404, 'this venue has no tech rider yet')
  }
}

const writeRider = (id: string, rider: RiderFile) => writeFile(jsonPath(id), JSON.stringify(rider, null, 2))

const isPoint = (p: unknown): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n))

/** A rider file sent by the client (made by `read-rider`, or edited by hand): checked for shape and size, not for sense. */
export function cleanRider(value: unknown): RiderFile {
  const v = value as Partial<RiderFile> | null
  if (!v || v.version !== 1 || !v.patch || !Array.isArray(v.patch.rows) || v.patch.rows.length > 600)
    throw new HttpError(400, 'not a rider file (version 1 with a patch table)')
  for (const row of v.patch.rows) {
    const r = row as Partial<RiderFile['patch']['rows'][number]>
    if (
      typeof r?.fixId !== 'string' ||
      typeof r.name !== 'string' ||
      typeof r.mode !== 'string' ||
      typeof r.truss !== 'string' ||
      !Number.isInteger(r.universe) ||
      !Number.isInteger(r.address)
    ) {
      throw new HttpError(400, 'a patch row is incomplete')
    }
  }
  if (v.lamps !== undefined) {
    if (!Array.isArray(v.lamps) || v.lamps.length > 1000) throw new HttpError(400, 'lamps must be an array of at most 1000')
    for (const lamp of v.lamps) {
      if (typeof lamp?.lampId !== 'string' || typeof lamp.fixId !== 'string' || !isPoint(lamp.planPx))
        throw new HttpError(400, 'a lamp needs lampId, fixId and planPx')
    }
  }
  if (v.plan !== undefined && (typeof v.plan !== 'object' || v.plan === null || typeof v.plan.trusses !== 'object')) throw new HttpError(400, 'invalid plan')
  const strings = (list: unknown) => (Array.isArray(list) ? list.filter((i): i is string => typeof i === 'string').slice(0, 500) : [])
  return { ...(v as RiderFile), issues: strings(v.issues), ...(v.planIssues !== undefined ? { planIssues: strings(v.planIssues) } : {}) }
}

async function receivePdf(req: IncomingMessage, target: string) {
  let size = 0
  let head = Buffer.alloc(0)
  const guard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length
      if (size > MAX_PDF) return cb(new HttpError(413, 'the PDF is too large'))
      if (head.length < PDF_MAGIC.length) {
        head = Buffer.concat([head, chunk]).subarray(0, PDF_MAGIC.length)
        if (head.length === PDF_MAGIC.length && !head.equals(PDF_MAGIC)) return cb(new HttpError(400, 'not a PDF file'))
      }
      cb(null, chunk)
    },
  })
  try {
    await pipeline(req, guard, createWriteStream(target))
  } catch (err) {
    await rm(target, { force: true })
    throw err
  }
  if (size === 0) {
    await rm(target, { force: true })
    throw new HttpError(400, 'empty upload')
  }
}

/** The plan picture the wizard shows for calibration: the part of the page the lights are in, kept for repeat requests. */
const planImages = new Map<string, { png: Buffer; crop: [number, number, number, number]; page: [number, number] }>()

async function planImage(id: string, rider: RiderFile) {
  if (!rider.plan) throw new HttpError(409, 'the plan has not been read yet')
  const info = await stat(pdfPath(id)).catch(() => null)
  if (!info) throw new HttpError(404, 'the rider PDF is not stored (upload it again)')
  const lamps = rider.lamps ?? []
  const key = `${id}:${info.mtimeMs}:${rider.plan.page}:${lamps.length}`
  const cached = planImages.get(key)
  if (cached) return cached
  const image = await renderPage(pdfPath(id), rider.plan.page)
  const margin = 160
  const xs = lamps.map((l) => l.planPx[0])
  const ys = lamps.map((l) => l.planPx[1])
  const crop: [number, number, number, number] = lamps.length
    ? [
        Math.max(0, Math.min(...xs) - margin),
        Math.max(0, Math.min(...ys) - margin),
        Math.min(image.width, Math.max(...xs) + margin),
        Math.min(image.height, Math.max(...ys) + margin),
      ]
    : [0, 0, image.width, image.height]
  const shot = cropPng(
    image,
    { x0: crop[0] / image.width, y0: crop[1] / image.height, x1: crop[2] / image.width, y1: crop[3] / image.height },
    { maxSide: 2200 },
  )
  const entry = { png: shot.png, crop, page: [image.width, image.height] as [number, number] }
  for (const k of planImages.keys()) if (k.startsWith(`${id}:`)) planImages.delete(k)
  planImages.set(key, entry)
  return entry
}

const num = (v: unknown, name: string, min = -1e6, max = 1e6) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `${name} must be a number`)
  return v
}

export async function handleRider(req: IncomingMessage, res: ServerResponse, id: string, sub: string | undefined, method: string) {
  if (!sub) {
    if (method === 'GET') return sendJson(res, 200, await readRider(id))
    if (method === 'DELETE') {
      await Promise.all([rm(jsonPath(id), { force: true }), rm(pdfPath(id), { force: true })])
      return void res.writeHead(204).end()
    }
    // A PDF: kept, and its patch table read from the text (the plan is read in a second step: it needs a vision model).
    if (method === 'POST') {
      const upload = `${pdfPath(id)}.upload`
      await receivePdf(req, upload)
      await rename(upload, pdfPath(id))
      const rider = await readPatch(pdfPath(id), 'rider.pdf')
      await writeRider(id, rider)
      return sendJson(res, 200, rider)
    }
    // A rider file made elsewhere (the read-rider command): replaces what is stored.
    if (method === 'PUT') {
      const rider = cleanRider(await readJson(req, 8 * 1024 * 1024))
      await writeRider(id, rider)
      return sendJson(res, 200, rider)
    }
  }

  if (sub === 'plan' && method === 'POST') {
    const body = await readJson(req)
    const name = typeof body.provider === 'string' ? body.provider : 'anthropic'
    if (!providerNames().includes(name)) throw new HttpError(400, `unknown provider "${name}" (available: ${providerNames().join(', ')})`)
    let provider
    try {
      provider = createProvider(name, {
        apiKey: typeof body.apiKey === 'string' && body.apiKey ? body.apiKey : undefined,
        model: typeof body.model === 'string' && body.model ? body.model : undefined,
      })
    } catch (err) {
      throw new HttpError(400, (err as Error).message)
    }
    const rider = await readRider(id)
    if (!(await stat(pdfPath(id)).catch(() => null))) throw new HttpError(404, 'the rider PDF is not stored (upload it again)')
    const page = Number.isInteger(body.page) && body.page > 0 ? body.page : (rider.plan?.page ?? 2)
    try {
      const image = await renderPage(pdfPath(id), page)
      const reading = await readPlan(provider, image, page, rider.patch.rows)
      const next = withPlan(rider, reading)
      await writeRider(id, next)
      return sendJson(res, 200, next)
    } catch (err) {
      throw new HttpError(502, `reading the plan failed: ${(err as Error).message}`)
    }
  }

  if (sub === 'plan.png' && method === 'GET') {
    const entry = await planImage(id, await readRider(id))
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': entry.png.length,
      'cache-control': 'no-cache',
      'x-crop': entry.crop.join(','),
      'x-page': entry.page.join(','),
      'access-control-expose-headers': 'x-crop, x-page',
    })
    return void res.end(entry.png)
  }

  if (sub === 'drafts' && method === 'POST') {
    const body = await readJson(req)
    const s = body.similarity
    const similarity: Similarity = {
      scale: num(s?.scale, 'scale', 1e-6, 1e3),
      theta: num(s?.theta, 'theta', -100, 100),
      tx: num(s?.tx, 'tx'),
      tz: num(s?.tz, 'tz'),
    }
    const overrides: Record<string, string> = {}
    for (const [k, v] of Object.entries(body.overrides ?? {})) if (typeof v === 'string' && v.length <= 80 && k.length <= 120) overrides[k] = v
    const result = buildDrafts(await readRider(id), await catalogFixtures(), {
      similarity,
      overrides,
      ...(body.ceilingHeight !== undefined ? { ceilingHeight: num(body.ceilingHeight, 'ceilingHeight', 0, 100) } : {}),
      ...(body.standHeight !== undefined ? { standHeight: num(body.standHeight, 'standHeight', 0, 20) } : {}),
    })
    return sendJson(res, 200, result)
  }

  throw new HttpError(404, 'not found')
}
