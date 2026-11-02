import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { CatalogFile, CatalogFixture } from '@preflight/shared'

const CATALOG_FILE = fileURLToPath(new URL('../catalog/fixtures.json', import.meta.url))
const CUSTOM_FILE = fileURLToPath(new URL('../catalog/custom.json', import.meta.url))

let cached: Promise<string> | undefined

/** The library catalog with the hand-kept fixtures of custom.json added (an entry there replaces a library one with the same id). */
async function loadCatalog(): Promise<string> {
  const library: CatalogFile = await readFile(CATALOG_FILE, 'utf8')
    .then((text) => JSON.parse(text) as CatalogFile)
    .catch(() => ({ source: null as never, importedAt: '', fixtures: [] }))
  const custom: CatalogFixture[] = await readFile(CUSTOM_FILE, 'utf8')
    .then((text) => (JSON.parse(text) as { fixtures: CatalogFixture[] }).fixtures)
    .catch(() => [])
  const replaced = new Set(custom.map((f) => f.id))
  return JSON.stringify({ ...library, fixtures: [...library.fixtures.filter((f) => !replaced.has(f.id)), ...custom] })
}

/** The catalog as objects (parsed once with the JSON text). */
export async function catalogFixtures(): Promise<CatalogFixture[]> {
  return (JSON.parse(await catalogJson()) as CatalogFile).fixtures
}

/** The catalog as JSON text, read once (it is only replaced by running the import script and restarting). */
export function catalogJson(): Promise<string> {
  cached ??= loadCatalog()
  return cached
}
