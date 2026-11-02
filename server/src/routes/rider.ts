import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { riderDraftsBody, riderFileSchema, riderPlanBody, type RiderFile } from '@preflight/shared'
import { HttpError, readBody, sendJson } from '../http.js'
import { buildDrafts } from '../rider/draft.js'
import { readPatch } from '../rider/patch.js'
import '../rider/vision/anthropic.js'
import { readPlan, withPlan } from '../rider/vision/plan.js'
import { createProvider, providerNames } from '../rider/vision/provider.js'
import { cropPng, renderPage } from '../rider/vision/render.js'
import type { Route } from '../router.js'
import { catalogFixtures } from '../services/catalog.js'
import { venueDir } from '../services/venues.js'
import { receiveFile, type UploadRules } from '../upload.js'
import { venueOf } from './venues.js'

/**
 * The tech rider of a venue: the PDF (`rider.pdf`) and what was read from it (`rider.json`, a RiderFile), both in the
 * venue's folder. The wizard in the client reads the patch from the PDF's text, optionally reads the plan with a vision model,
 * shows the plan picture for calibration, and asks for drafts of the lights.
 */

const PDF_MAGIC = Buffer.from('%PDF')

/** A rider upload: a PDF of at most 40 MB. */
const PDF_UPLOAD: UploadRules = {
  maxBytes: 40 * 1024 * 1024,
  tooLarge: 'the PDF is too large',
  headBytes: PDF_MAGIC.length,
  checkHead: (head) => (head.equals(PDF_MAGIC) ? null : 'not a PDF file'),
}

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

/** A venue's tech rider: the stored file, the PDF it was read from, reading the plan, the plan picture, and drafts of the lights. */
export const riderRoutes: Route[] = [
  { method: 'GET', path: '/api/venues/:id/rider', handler: async ({ res, params }) => sendJson(res, 200, await readRider((await venueOf(params.id)).id)) },
  {
    method: 'DELETE',
    path: '/api/venues/:id/rider',
    handler: async ({ res, params }) => {
      const { id } = await venueOf(params.id)
      await Promise.all([rm(jsonPath(id), { force: true }), rm(pdfPath(id), { force: true })])
      res.writeHead(204).end()
    },
  },
  // A PDF: kept, and its patch table read from the text (the plan is read in a second step: it needs a vision model).
  {
    method: 'POST',
    path: '/api/venues/:id/rider',
    handler: async ({ req, res, params }) => {
      const { id } = await venueOf(params.id)
      const upload = `${pdfPath(id)}.upload`
      await receiveFile(req, upload, PDF_UPLOAD)
      await rename(upload, pdfPath(id))
      const rider = await readPatch(pdfPath(id), 'rider.pdf')
      await writeRider(id, rider)
      sendJson(res, 200, rider)
    },
  },
  // A rider file made elsewhere (the read-rider command): replaces what is stored.
  {
    method: 'PUT',
    path: '/api/venues/:id/rider',
    handler: async ({ req, res, params }) => {
      const { id } = await venueOf(params.id)
      const rider = await readBody(req, riderFileSchema, 8 * 1024 * 1024)
      await writeRider(id, rider)
      sendJson(res, 200, rider)
    },
  },
  {
    method: 'POST',
    path: '/api/venues/:id/rider/plan',
    handler: async ({ req, res, params }) => {
      const { id } = await venueOf(params.id)
      const body = await readBody(req, riderPlanBody)
      if (!providerNames().includes(body.provider)) throw new HttpError(400, `unknown provider "${body.provider}" (available: ${providerNames().join(', ')})`)
      let provider
      try {
        provider = createProvider(body.provider, { apiKey: body.apiKey || undefined, model: body.model || undefined })
      } catch (err) {
        throw new HttpError(400, (err as Error).message)
      }
      const rider = await readRider(id)
      if (!(await stat(pdfPath(id)).catch(() => null))) throw new HttpError(404, 'the rider PDF is not stored (upload it again)')
      const page = body.page ?? rider.plan?.page ?? 2
      try {
        const image = await renderPage(pdfPath(id), page)
        const reading = await readPlan(provider, image, page, rider.patch.rows)
        const next = withPlan(rider, reading)
        await writeRider(id, next)
        sendJson(res, 200, next)
      } catch (err) {
        throw new HttpError(502, `reading the plan failed: ${(err as Error).message}`)
      }
    },
  },
  {
    method: 'GET',
    path: '/api/venues/:id/rider/plan.png',
    handler: async ({ res, params }) => {
      const { id } = await venueOf(params.id)
      const entry = await planImage(id, await readRider(id))
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': entry.png.length,
        'cache-control': 'no-cache',
        'x-crop': entry.crop.join(','),
        'x-page': entry.page.join(','),
        'access-control-expose-headers': 'x-crop, x-page',
      })
      res.end(entry.png)
    },
  },
  {
    method: 'POST',
    path: '/api/venues/:id/rider/drafts',
    handler: async ({ req, res, params }) => {
      const { id } = await venueOf(params.id)
      const { similarity, overrides, ceilingHeight, standHeight } = await readBody(req, riderDraftsBody)
      const options = {
        similarity,
        overrides,
        ...(ceilingHeight !== undefined ? { ceilingHeight } : {}),
        ...(standHeight !== undefined ? { standHeight } : {}),
      }
      sendJson(res, 200, buildDrafts(await readRider(id), await catalogFixtures(), options))
    },
  },
]
