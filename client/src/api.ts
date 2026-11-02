export interface CameraView {
  id: string
  name: string
  position: [number, number, number]
  rotation: [number, number, number]
}

export interface Fixture {
  id: string
  name: string
  profileId: string
  position: [number, number, number]
  mount: 'hanging' | 'standing'
  yaw: number
  /** base orientation as a quaternion [x, y, z, w]; when absent, `mount` and `yaw` describe it */
  rotation?: [number, number, number, number]
  /** the DMX mode this fixture runs in, by the name the fixture catalog gives it */
  mode?: string
  /** whether this light's shadows are drawn (default true; only a limited number of lights can at once) */
  castShadows?: boolean
  /** where the light comes from in the venue's tech rider: its number there and its place in the patch */
  patch?: { fixId: string; lampId?: string; universe: number; address: number; truss?: string }
  /** normalized 0..1 attribute values (pan, tilt, dimmer, zoom, red, green, blue, ...) */
  values: Record<string, number>
}

/** One DMX mode of a catalog fixture: its channels in order, each with its name and what it controls ('' when unused here). */
export interface CatalogMode {
  name: string
  shortName?: string
  channels: [name: string, attribute: string][]
}

/** A fixture from the Open Fixture Library (see server/src/catalog.ts). */
export interface CatalogFixture {
  id: string
  manufacturer: string
  manufacturerKey: string
  name: string
  categories: string[]
  moving: boolean
  beamAngle?: [number, number]
  panDegrees?: number
  tiltDegrees?: number
  lumens?: number
  lumensEstimated?: boolean
  powerW?: number
  weightKg?: number
  sizeMm?: [number, number, number]
  colorTemperature?: number
  features: string[]
  modes: CatalogMode[]
}

export interface CatalogFile {
  source: { name: string; url: string; repository: string; commit: string; license: string } | null
  importedAt: string
  fixtures: CatalogFixture[]
}

/** A named, ordered set of lights (by fixture id). A deleted light may stay listed so that undoing the delete restores its place. */
export interface FixtureGroup {
  id: string
  name: string
  fixtureIds: string[]
}

/** An area where people stand: a rectangle (corners in world meters) on a horizontal plane at height `y`. */
export interface CrowdZone {
  id: string
  name: string
  x0: number
  z0: number
  x1: number
  z1: number
  y: number
  /** the point (x, z) the people face, or null for every direction */
  facing: [number, number] | null
  shown: boolean
}

export interface Crowd {
  shown: boolean
  density: number
  motion: 'still' | 'sway' | 'dance'
  intensity: number
  zones: CrowdZone[]
}

/** How a venue's air and room look, both 0..1. */
export interface Atmosphere {
  haze: number
  ambient: number
}

export type VenueStatus = 'empty' | 'ready' | 'error'

export interface Venue {
  id: string
  name: string
  status: VenueStatus
  error?: string
  /** 'skp': converted from SketchUp; 'glb': uploaded as glTF and used as it is (absent on older, SketchUp venues) */
  modelFormat?: 'skp' | 'glb'
  modelHash?: string
  converterVersion?: string
  sortIndex: number
  views?: CameraView[]
  fixtures?: Fixture[]
  groups?: FixtureGroup[]
  atmosphere?: Atmosphere
  crowd?: Crowd
  /** names of the model's parts switched off in the viewer (SketchUp tags, or a glTF model's top-level nodes) */
  hiddenTags?: string[]
  createdAt: string
  updatedAt: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? body.message ?? `request failed (${res.status})`)
  return body as T
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
  const body = await res.json().catch(() => ({}))
  // 422 still carries the venue record with status "error" and a reason.
  if (!res.ok && !body.id) throw new Error(body.error ?? `upload failed (${res.status})`)
  return body as Venue
}

/** The version in the URL changes with the file or the converter build, so a cached copy is never stale. */
export const modelUrl = (venue: Venue) => `/api/venues/${venue.id}/model.glb?v=${venue.modelHash}-${venue.converterVersion ?? ''}`

// --- tech rider ---------------------------------------------------------------------------------

export interface RiderPatchRow {
  fixId: string
  universe: number
  address: number
  name: string
  modeRaw: string
  mode: string
  typeHint?: string
  modeNote?: string
  channels?: number
  truss: string
}

export interface RiderLamp {
  lampId: string
  fixId: string
  printed?: string
  planPx: [number, number]
  facingDeg?: number
  symbol?: string
  trussOnPlan?: string
}

export interface RiderPlan {
  page: number
  image: { width: number; height: number }
  scale?: string
  date?: string
  stage?: { width: number; depth: number; height: number; planPx?: [[number, number], [number, number]] }
  trusses: Record<string, { underside: number; planPx?: [[number, number], [number, number]] }>
  lowestLight?: number
}

/** What the server read from a venue's tech rider (see server/src/rider/types.ts). */
export interface RiderFile {
  version: 1
  source: string
  readAt: string
  patch: { date?: string; title?: string; rows: RiderPatchRow[] }
  plan?: RiderPlan
  lamps?: RiderLamp[]
  issues: string[]
  planIssues?: string[]
}

export interface FixtureDraft {
  key: string
  fixId: string
  lampId?: string
  name: string
  profileId?: string
  mode?: string
  patch?: { fixId: string; lampId?: string; universe: number; address: number; truss?: string }
  placement?: {
    position: [number, number, number]
    mount: 'hanging' | 'standing'
    rotation: [number, number, number, number]
    height: 'truss' | 'ceiling' | 'stand'
    truss?: string
  }
  status: 'ready' | 'unmapped' | 'unplaced' | 'ignored'
  notes: string[]
}

export interface DraftResult {
  drafts: FixtureDraft[]
  groups: { name: string; keys: string[] }[]
  issues: string[]
}

export interface Similarity {
  scale: number
  theta: number
  tx: number
  tz: number
}

const json = (body: unknown): RequestInit => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** The venue's stored rider, or null when it has none. */
export async function getRider(venueId: string): Promise<RiderFile | null> {
  const res = await fetch(`/api/venues/${venueId}/rider`)
  if (res.status === 404) return null
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`)
  return body as RiderFile
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
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `request failed (${res.status})`)
  const crop = (res.headers.get('x-crop') ?? '').split(',').map(Number)
  if (crop.length !== 4 || crop.some((n) => !Number.isFinite(n))) throw new Error('the plan picture came without its position')
  return { url: URL.createObjectURL(await res.blob()), crop: crop as [number, number, number, number] }
}

export const riderDrafts = (
  venueId: string,
  body: { similarity: Similarity; overrides?: Record<string, string>; ceilingHeight?: number; standHeight?: number },
) => request<DraftResult>(`/venues/${venueId}/rider/drafts`, { method: 'POST', ...json(body) })
