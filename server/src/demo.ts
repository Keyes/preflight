import { createHash } from 'node:crypto'
import { copyFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { checkGlb } from './model.js'
import type { Venue } from '@preflight/shared'
import { createVenue, deleteVenue, glbPath, updateVenue } from './venues.js'

/** What the demo venue starts with besides its model (`samples/demo-club.json`, made by `npm run demo-venue -w server`). */
export type DemoPreset = Required<Pick<Venue, 'name' | 'atmosphere' | 'crowd' | 'views' | 'fixtures' | 'groups'>>

/** where the demo venue's files are; DEMO_DIR points it elsewhere */
const SAMPLES_DIR = process.env.DEMO_DIR ?? fileURLToPath(new URL('../../samples/', import.meta.url))

/** Creates a new venue from the demo club: its model, lights, groups, haze, crowd and views. */
export async function createDemoVenue(): Promise<Venue> {
  const model = `${SAMPLES_DIR}/demo-club.glb`
  const preset = JSON.parse(await readFile(`${SAMPLES_DIR}/demo-club.json`, 'utf8')) as DemoPreset
  await checkGlb(model)
  const venue = await createVenue(preset.name)
  try {
    await copyFile(model, glbPath(venue.id))
    const hash = createHash('sha256')
      .update(await readFile(model))
      .digest('hex')
    const { name: _, ...rest } = preset
    return (await updateVenue(venue.id, { ...rest, status: 'ready', modelFormat: 'glb', modelHash: hash }))!
  } catch (err) {
    await deleteVenue(venue.id)
    throw err
  }
}
