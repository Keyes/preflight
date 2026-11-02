import { randomUUID } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Venue } from '@preflight/shared'

/** where venues are stored; VENUES_DIR points it elsewhere (the tests use a scratch folder) */
export const DATA_DIR = process.env.VENUES_DIR ?? fileURLToPath(new URL('../../data/venues/', import.meta.url))
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const isValidId = (id: string) => ID_PATTERN.test(id)
export const venueDir = (id: string) => join(DATA_DIR, id)
/** the uploaded SketchUp file (absent for a model uploaded as glTF) */
export const skpPath = (id: string) => join(venueDir(id), 'model.skp')
export const glbPath = (id: string) => join(venueDir(id), 'model.glb')
const metaPath = (id: string) => join(venueDir(id), 'venue.json')

async function writeMeta(venue: Venue) {
  // a name of its own per write, so two writes never rename each other's file away
  const tmp = `${metaPath(venue.id)}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(venue, null, 2))
    await rename(tmp, metaPath(venue.id))
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

// Changes to one venue's venue.json run one after another, so a read-change-write never works from a copy another
// change is about to replace (several PATCHes at once would otherwise lose all but the last).
const queues = new Map<string, Promise<unknown>>()

function queued<T>(id: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(id) ?? Promise.resolve()).then(task)
  const tail = run.catch(() => {})
  queues.set(id, tail)
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id)
  })
  return run
}

/** Reads a venue, changes it and writes it back, in turn with every other change to that venue. */
function changeVenue(id: string, change: (current: Venue) => Venue): Promise<Venue | undefined> {
  return queued(id, async () => {
    const current = await getVenue(id)
    if (!current) return undefined
    const next = change(current)
    if (next !== current) await writeMeta(next)
    return next
  })
}

export async function getVenue(id: string): Promise<Venue | undefined> {
  if (!isValidId(id)) return undefined
  try {
    return JSON.parse(await readFile(metaPath(id), 'utf8')) as Venue
  } catch {
    return undefined
  }
}

export async function listVenues(): Promise<Venue[]> {
  await mkdir(DATA_DIR, { recursive: true })
  const ids = (await readdir(DATA_DIR)).filter(isValidId)
  const venues = await Promise.all(ids.map(getVenue))
  return venues.filter((v): v is Venue => !!v).sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0) || a.createdAt.localeCompare(b.createdAt))
}

/** Persists a new list order. Ids not mentioned keep their relative order after the listed ones. */
export async function reorderVenues(ids: string[]): Promise<Venue[]> {
  const all = await listVenues()
  const known = new Set(all.map((v) => v.id))
  const ordered = [...ids.filter((id) => known.has(id)), ...all.map((v) => v.id).filter((id) => !ids.includes(id))]
  await Promise.all(ordered.map((id, i) => changeVenue(id, (v) => (v.sortIndex === i ? v : { ...v, sortIndex: i }))))
  return listVenues()
}

export async function createVenue(name: string): Promise<Venue> {
  const now = new Date().toISOString()
  const sortIndex = Math.max(-1, ...(await listVenues()).map((v) => v.sortIndex ?? 0)) + 1
  const venue: Venue = { id: randomUUID(), name, status: 'empty', sortIndex, createdAt: now, updatedAt: now }
  await mkdir(venueDir(venue.id), { recursive: true })
  await writeMeta(venue)
  return venue
}

/**
 * Copies a venue whole: model, lights, groups, crowd, atmosphere and views. Ids inside the venue stay as they are, because
 * they only have to be unique within one venue. The copy is listed right after the original.
 */
export async function duplicateVenue(id: string): Promise<Venue | undefined> {
  const original = await getVenue(id)
  if (!original) return undefined
  const now = new Date().toISOString()
  const copy: Venue = { ...original, id: randomUUID(), name: `${original.name} (copy)`.slice(0, 80), createdAt: now, updatedAt: now }
  await cp(venueDir(id), venueDir(copy.id), { recursive: true, filter: (src) => !/\.(tmp|upload|new)$|model\.new\./.test(src) })
  await writeMeta(copy)
  const order = (await listVenues()).map((v) => v.id).filter((v) => v !== copy.id)
  order.splice(order.indexOf(id) + 1, 0, copy.id)
  await reorderVenues(order)
  return getVenue(copy.id)
}

export function deleteVenue(id: string): Promise<boolean> {
  return queued(id, async () => {
    if (!(await getVenue(id))) return false
    await rm(venueDir(id), { recursive: true, force: true })
    return true
  })
}

export function updateVenue(id: string, patch: Partial<Venue>): Promise<Venue | undefined> {
  return changeVenue(id, (current) => {
    const next: Venue = { ...current, ...patch, id, updatedAt: new Date().toISOString() }
    if (patch.status !== 'error' && !('error' in patch)) delete next.error
    return next
  })
}
