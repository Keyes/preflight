import { rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Venue } from '@preflight/shared'
import { convertSkp, converterVersion } from './convert.js'
import { ModelError, prepareGltfModel, type ModelFormat } from './model.js'
import { glbPath, skpPath, updateVenue, venueDir } from './venues.js'

/**
 * A venue's model: putting an uploaded file in place, and converting a stored SketchUp file again. Whatever can fail is
 * prepared next to the old files and renamed over them only when it worked, so a bad file leaves a working venue as it was.
 */

/** The venue as it is now, or why the model could not be used (with the venue too when that changed: a first conversion that failed). */
export type ModelOutcome = { venue: Venue | undefined } | { error: string; venue?: Venue }

/** Where an upload is received before it is put in place. */
export const uploadPath = (id: string) => join(venueDir(id), 'model.upload')

/** Puts the received upload in place: glTF is checked and used as it is, SketchUp is converted to GLB. */
export async function installModel(venue: Venue, upload: string, file: { hash: string; format: ModelFormat }): Promise<ModelOutcome> {
  if (file.format !== 'skp') return installGltf(venue.id, upload, file.format, file.hash)
  if (venue.status === 'ready') return replaceSkp(venue.id, upload, file.hash)
  return firstSkp(venue, upload, file.hash)
}

async function installGltf(id: string, upload: string, format: Exclude<ModelFormat, 'skp'>, hash: string): Promise<ModelOutcome> {
  const nextGlb = `${glbPath(id)}.new`
  try {
    await prepareGltfModel(upload, format, nextGlb)
  } catch (err) {
    await rm(nextGlb, { force: true })
    if (!(err instanceof ModelError)) throw err
    return { error: `The model could not be used: ${err.message}.` }
  }
  await rename(nextGlb, glbPath(id))
  await rm(skpPath(id), { force: true }) // a SketchUp file from before would no longer match the model
  return { venue: await updateVenue(id, { status: 'ready', modelFormat: 'glb', modelHash: hash, converterVersion: undefined, error: undefined }) }
}

/** Replacing the model of a working venue: the new file is converted on the side, and swapped in only when that worked. */
async function replaceSkp(id: string, upload: string, hash: string): Promise<ModelOutcome> {
  const next = join(venueDir(id), 'model.new.skp')
  const nextGlb = `${glbPath(id)}.new`
  await rename(upload, next)
  const version = await converterVersion()
  try {
    await convertSkp(next, nextGlb)
  } catch (err) {
    await rm(next, { force: true })
    await rm(nextGlb, { force: true })
    return { error: `The new model could not be converted: ${(err as Error).message}` }
  }
  await rename(next, skpPath(id))
  await rename(nextGlb, glbPath(id))
  return { venue: await updateVenue(id, { status: 'ready', modelFormat: 'skp', modelHash: hash, converterVersion: version, error: undefined }) }
}

/** A venue's first model (or one after a failed conversion): converted in place, unless the same file was converted by this build already. */
async function firstSkp(venue: Venue, upload: string, hash: string): Promise<ModelOutcome> {
  const id = venue.id
  await rename(upload, skpPath(id))
  const version = await converterVersion()
  const cached = venue.modelFormat !== 'glb' && hash === venue.modelHash && venue.converterVersion === version && (await stat(glbPath(id)).catch(() => null))
  if (!cached) {
    try {
      await convertSkp(skpPath(id), glbPath(id))
    } catch (err) {
      const message = (err as Error).message
      return { error: message, venue: await updateVenue(id, { status: 'error', modelHash: undefined, error: message }) }
    }
  }
  return { venue: await updateVenue(id, { status: 'ready', modelFormat: 'skp', modelHash: hash, converterVersion: version }) }
}

/**
 * Converts a venue's stored SketchUp file again with the converter as built now (for models made by an older build). The
 * hash gets a suffix, so the client's cached copy of the model is not used.
 */
export async function reconvertModel(venue: Venue): Promise<ModelOutcome> {
  const id = venue.id
  const nextGlb = `${glbPath(id)}.new`
  const version = await converterVersion()
  try {
    await convertSkp(skpPath(id), nextGlb)
  } catch (err) {
    await rm(nextGlb, { force: true })
    return { error: `The model could not be converted: ${(err as Error).message}` }
  }
  await rename(nextGlb, glbPath(id))
  const modelHash = `${venue.modelHash ?? ''}`.replace(/\+.*$/, '') + `+${Date.now()}`
  return { venue: await updateVenue(id, { converterVersion: version, modelHash }) }
}
