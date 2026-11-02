import type { Atmosphere, CameraView, CatalogFile, Crowd, CrowdZone, DraftResult, Fixture, FixtureGroup, RiderFile, Similarity, Venue } from '@preflight/shared'

/** What the server, or the dev proxy in front of it, answers with when a request fails. */
interface Failure {
  error?: string
  message?: string
}

/** A response's JSON ({} when it has none). The server is ours: what it sends is taken to have the shape its route promises. */
const jsonOf = async <T>(res: Response) => (await res.json().catch(() => ({}))) as T

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init)
  const body = await jsonOf<T & Failure>(res)
  if (!res.ok) throw new Error(body.error ?? body.message ?? `request failed (${res.status})`)
  return body
}

export async function deleteVenue(id: string): Promise<void> {
  const res = await fetch(`/api/venues/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`delete failed (${res.status})`)
}

export const saveViews = (id: string, views: CameraView[]) =>
  request<Venue>(`/venues/${id}/views`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ views }),
  })

export const saveFixtures = (id: string, fixtures: Fixture[], groups: FixtureGroup[]) =>
  request<Venue>(`/venues/${id}/fixtures`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fixtures, groups }),
  })

export const saveCrowd = (id: string, crowd: Crowd) =>
  request<Venue>(`/venues/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ crowd }),
  })

export const saveAtmosphere = (id: string, atmosphere: Atmosphere) =>
  request<Venue>(`/venues/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ atmosphere }),
  })

/** A whole copy of a venue (model, lights, groups, crowd, haze, views). */
export const duplicateVenue = (id: string) => request<Venue>(`/venues/${id}/duplicate`, { method: 'POST' })

/** A new venue made from the demo club that ships with pre(f)light (model, lights, groups, haze, crowd, views). */
export const createDemoVenue = () => request<Venue>('/venues/demo', { method: 'POST' })

/** Adds lights, groups and crowd zones with new ids to a venue's own. */
export const appendToVenue = (id: string, fixtures: Fixture[], groups: FixtureGroup[], zones: CrowdZone[] = []) =>
  request<Venue>(`/venues/${id}/append`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fixtures, groups, zones }),
  })

export const saveHiddenTags = (id: string, hiddenTags: string[]) =>
  request<Venue>(`/venues/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hiddenTags }),
  })

/** Converts the stored SketchUp file again with the converter as built now. */
export const reconvertVenue = (id: string) => request<Venue>(`/venues/${id}/reconvert`, { method: 'POST' })

export const renameVenue = (id: string, name: string) =>
  request<Venue>(`/venues/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })

export const reorderVenues = (ids: string[]) =>
  request<Venue[]>('/venues/order', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  })

export const fetchCatalog = () => request<CatalogFile>('/fixtures/catalog')

export const listVenues = () => request<Venue[]>('/venues')

export const createVenue = (name: string) =>
  request<Venue>('/venues', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })

/** The model files a venue can be made from, for file inputs. */
export const MODEL_ACCEPT = '.skp,.glb,.gltf'

/** Uploads a model (.skp, which the server converts, or .glb / self-contained .gltf) and returns the updated venue. */
export async function uploadModel(id: string, file: File): Promise<Venue> {
  const res = await fetch(`/api/venues/${id}/model`, { method: 'POST', body: file })
  const body = await jsonOf<Partial<Venue> & Failure>(res)
  // 422 still carries the venue record with status "error" and a reason.
  if (!res.ok && !body.id) throw new Error(body.error ?? `upload failed (${res.status})`)
  return body as Venue
}

/** The version in the URL changes with the file or the converter build, so a cached copy is never stale. */
export const modelUrl = (venue: Venue) => `/api/venues/${venue.id}/model.glb?v=${venue.modelHash}-${venue.converterVersion ?? ''}`

// --- tech rider ---------------------------------------------------------------------------------

const json = (body: unknown): RequestInit => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** The venue's stored rider, or null when it has none. */
export async function getRider(venueId: string): Promise<RiderFile | null> {
  const res = await fetch(`/api/venues/${venueId}/rider`)
  if (res.status === 404) return null
  const body = await jsonOf<RiderFile & Failure>(res)
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`)
  return body
}

/** Sends the rider PDF; the server keeps it and reads its patch table. */
export async function uploadRiderPdf(venueId: string, file: File): Promise<RiderFile> {
  return request<RiderFile>(`/venues/${venueId}/rider`, { method: 'POST', body: file })
}

/** Stores a rider file made elsewhere (the read-rider command). */
export const putRider = (venueId: string, rider: RiderFile) => request<RiderFile>(`/venues/${venueId}/rider`, { method: 'PUT', ...json(rider) })

export const deleteRider = async (venueId: string) => void (await fetch(`/api/venues/${venueId}/rider`, { method: 'DELETE' }))

/** Has a vision model read the plan page of the stored PDF. Takes a minute. */
export const readRiderPlan = (venueId: string, options: { provider?: string; model?: string; apiKey?: string; page?: number }) =>
  request<RiderFile>(`/venues/${venueId}/rider/plan`, { method: 'POST', ...json(options) })

/** The plan picture and the part of the page it shows (plan pixels: x0, y0, x1, y1). */
export async function riderPlanImage(venueId: string): Promise<{ url: string; crop: [number, number, number, number] }> {
  const res = await fetch(`/api/venues/${venueId}/rider/plan.png`)
  if (!res.ok) throw new Error((await jsonOf<Failure>(res)).error ?? `request failed (${res.status})`)
  const crop = (res.headers.get('x-crop') ?? '').split(',').map(Number)
  if (crop.length !== 4 || crop.some((n) => !Number.isFinite(n))) throw new Error('the plan picture came without its position')
  return { url: URL.createObjectURL(await res.blob()), crop: crop as [number, number, number, number] }
}

export const riderDrafts = (
  venueId: string,
  body: { similarity: Similarity; overrides?: Record<string, string>; ceilingHeight?: number; standHeight?: number },
) => request<DraftResult>(`/venues/${venueId}/rider/drafts`, { method: 'POST', ...json(body) })
