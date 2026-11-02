/**
 * Builds the fixture catalog from a checkout of the Open Fixture Library (https://github.com/OpenLightingProject/open-fixture-library).
 *
 *   npm run import-fixtures -w server -- <path to the checkout>
 *   npm run import-fixtures -w server -- --download      (sparse, shallow clone into a temp folder first)
 *
 * Only the `fixtures/` folder is read, and only as JSON data. The result is a trimmed catalog (what the picker and
 * the renderer need, plus per-mode channel lists for DMX patching later) written to `server/catalog/fixtures.json`.
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CatalogFixture, CatalogFile, CatalogMode } from '@preflight/shared'

const OUT_DIR = fileURLToPath(new URL('../../catalog/', import.meta.url))
const REPO_URL = 'https://github.com/OpenLightingProject/open-fixture-library.git'

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** "540deg" -> 540, "0%" -> undefined (not an angle). */
function degrees(v: unknown): number | undefined {
  const m = typeof v === 'string' ? /^(-?\d+(?:\.\d+)?)\s*deg$/.exec(v.trim()) : null
  return m ? Number(m[1]) : undefined
}

const COLOR_ATTRS: Record<string, string> = {
  Red: 'red',
  Green: 'green',
  Blue: 'blue',
  White: 'white',
  Amber: 'amber',
  UV: 'uv',
  Cyan: 'cyan',
  Magenta: 'magenta',
  Yellow: 'yellow',
  Lime: 'lime',
  Indigo: 'indigo',
}

const TYPE_ATTRS: Record<string, string> = {
  Pan: 'pan',
  Tilt: 'tilt',
  PanContinuous: 'pan-rotation',
  TiltContinuous: 'tilt-rotation',
  Intensity: 'dimmer',
  Zoom: 'zoom',
  Focus: 'focus',
  ShutterStrobe: 'strobe',
  StrobeSpeed: 'strobe',
  Prism: 'prism',
  PrismRotation: 'prism',
  Iris: 'iris',
  IrisEffect: 'iris',
  Frost: 'frost',
  FrostEffect: 'frost',
  ColorPreset: 'color-wheel',
  ColorTemperature: 'color-temperature',
  Effect: 'effect',
  EffectSpeed: 'effect',
  PanTiltSpeed: 'speed',
  BladeInsertion: 'framing',
  BladeRotation: 'framing',
  BladeSystemRotation: 'framing',
}

/** What a channel does, in the vocabulary the viewer knows ('' when it does not map to anything we use). */
function channelAttribute(key: string, channel: Json, wheels: Json): string {
  const caps = Array.isArray(channel.capabilities) ? channel.capabilities : channel.capability ? [channel.capability] : []
  for (const cap of caps) {
    if (!isObject(cap)) continue
    const type = str(cap.type)
    if (!type) continue
    if (type === 'ColorIntensity') return COLOR_ATTRS[str(cap.color) ?? ''] ?? 'color'
    if (type.startsWith('Wheel')) {
      const wheel = wheels[str(cap.wheel) ?? key] // a capability without a wheel name refers to the wheel named like the channel
      const slots = isObject(wheel) && Array.isArray(wheel.slots) ? wheel.slots : []
      const kinds = new Set(slots.filter(isObject).map((s) => str(s.type)))
      return kinds.has('Gobo') ? 'gobo' : kinds.has('Color') ? 'color-wheel' : 'wheel'
    }
    const attr = TYPE_ATTRS[type]
    if (attr) return attr
  }
  return ''
}

const escapeRegex = (text: string) => text.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')

function buildFixture(manufacturerKey: string, manufacturerName: string, file: string, data: Json): CatalogFixture | null {
  const categories = Array.isArray(data.categories) ? data.categories.map(str).filter((c): c is string => !!c) : []
  const name = str(data.name)
  if (!name || categories.length === 0 || !isObject(data.availableChannels)) return null // a redirect stub or something unusable

  const wheels = isObject(data.wheels) ? data.wheels : {}
  const available = data.availableChannels

  // Fine channels have their own names in the mode lists: map those back to the channel they refine.
  const info = new Map<string, string>()
  for (const [key, channel] of Object.entries(available)) {
    if (!isObject(channel)) continue
    const attr = channelAttribute(key, channel, wheels)
    info.set(key, attr)
    const fine = Array.isArray(channel.fineChannelAliases) ? channel.fineChannelAliases : []
    fine.forEach((alias, i) => {
      if (typeof alias === 'string') info.set(alias, attr ? `${attr}-${i === 0 ? 'fine' : 'ultra'}` : '')
    })
  }

  // Pixel fixtures (tubes, bars, matrices) define their channels once as templates with a "$pixelKey" placeholder,
  // and the modes use them by name ("Red Master") or through insert blocks that repeat them for pixels or groups.
  const templateAttr = new Map<string, string>() // template key -> what it controls
  const patterns: { pattern: RegExp; attr: string }[] = []
  const toPattern = (key: string) => {
    const [before, after = ''] = key.split('$pixelKey')
    return new RegExp(`^${escapeRegex(before)}.+${escapeRegex(after)}$`)
  }
  const templates = isObject(data.templateChannels) ? data.templateChannels : {}
  for (const [key, channel] of Object.entries(templates)) {
    if (!isObject(channel)) continue
    const attr = channelAttribute(key, channel, wheels)
    templateAttr.set(key, attr)
    patterns.push({ pattern: toPattern(key), attr })
    const fine = Array.isArray(channel.fineChannelAliases) ? channel.fineChannelAliases : []
    fine.forEach((alias, i) => {
      if (typeof alias !== 'string') return
      const fineAttr = attr ? `${attr}-${i === 0 ? 'fine' : 'ultra'}` : ''
      templateAttr.set(alias, fineAttr)
      patterns.push({ pattern: toPattern(alias), attr: fineAttr })
    })
  }
  const attributeOf = (channelName: string) => info.get(channelName) ?? patterns.find((p) => p.pattern.test(channelName))?.attr ?? ''

  const matrix = isObject(data.matrix) ? data.matrix : {}
  const pixelKeys = (): string[] => {
    const keys: string[] = []
    if (Array.isArray(matrix.pixelKeys)) {
      for (const plane of matrix.pixelKeys)
        for (const row of Array.isArray(plane) ? plane : []) for (const key of Array.isArray(row) ? row : []) if (typeof key === 'string') keys.push(key)
    } else if (Array.isArray(matrix.pixelCount)) {
      const [nx = 1, ny = 1, nz = 1] = matrix.pixelCount.map((n: unknown) => num(n) ?? 1)
      for (let z = 1; z <= nz; z++)
        for (let y = 1; y <= ny; y++) for (let x = 1; x <= nx; x++) keys.push(ny === 1 && nz === 1 ? String(x) : `(${x}, ${y}, ${z})`)
    }
    return keys
  }
  const expandInsert = (block: Json): [string, string][] => {
    if (block.insert !== 'matrixChannels') return [['', '']]
    const wanted = Array.isArray(block.templateChannels) ? block.templateChannels : []
    const repeat = block.repeatFor
    let keys: string[]
    if (Array.isArray(repeat)) keys = repeat.filter((k): k is string => typeof k === 'string')
    else if (repeat === 'eachPixelGroup') keys = Object.keys(isObject(matrix.pixelGroups) ? matrix.pixelGroups : {})
    else keys = pixelKeys()
    if (repeat === 'eachPixelABC') keys = [...keys].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    const out: [string, string][] = []
    const add = (template: unknown, key: string) => {
      if (typeof template !== 'string') out.push(['', ''])
      else out.push([template.replace('$pixelKey', key), templateAttr.get(template) ?? ''])
    }
    if (block.channelOrder === 'perChannel') for (const t of wanted) for (const k of keys) add(t, k)
    else for (const k of keys) for (const t of wanted) add(t, k)
    return out.slice(0, 1024)
  }

  const modes: CatalogMode[] = []
  const features = new Set<string>()
  for (const mode of Array.isArray(data.modes) ? data.modes : []) {
    if (!isObject(mode) || !Array.isArray(mode.channels)) continue
    const channels: [string, string][] = mode.channels.flatMap(
      (c): [string, string][] => (typeof c === 'string' ? [[c, attributeOf(c)]] : isObject(c) ? expandInsert(c) : [['', '']]), // null = unused
    )
    for (const [, attr] of channels) if (attr && !attr.endsWith('-fine') && !attr.endsWith('-ultra')) features.add(attr)
    modes.push({ name: str(mode.name) ?? 'Mode', ...(str(mode.shortName) ? { shortName: str(mode.shortName) } : {}), channels })
  }
  if (modes.length === 0) return null

  const physical = isObject(data.physical) ? data.physical : {}
  const bulb = isObject(physical.bulb) ? physical.bulb : {}
  const lens = isObject(physical.lens) ? physical.lens : {}
  const power = num(physical.power)
  let lumens = num(bulb.lumens)
  let lumensEstimated = false
  if (lumens === undefined && power !== undefined) {
    lumens = Math.round(Math.min(60000, Math.max(500, power * 30)))
    lumensEstimated = true
  }
  const angles = Array.isArray(lens.degreesMinMax) ? lens.degreesMinMax.map(num) : []
  const beamAngle = angles.length === 2 && angles[0] !== undefined && angles[1] !== undefined ? ([angles[0], angles[1]] as [number, number]) : undefined
  const dims = Array.isArray(physical.dimensions) ? physical.dimensions.map(num) : []

  const channelOf = (type: string) =>
    Object.values(available).find((c) => isObject(c) && isObject(c.capability) && c.capability.type === type) as Json | undefined
  const travel = (type: string) => {
    const cap = channelOf(type)?.capability
    if (!isObject(cap)) return undefined
    const a = degrees(cap.angleStart)
    const b = degrees(cap.angleEnd)
    return a !== undefined && b !== undefined && b !== a ? Math.abs(b - a) : undefined
  }

  const moving = categories.some((c) => c === 'Moving Head' || c === 'Scanner' || c === 'Barrel Scanner')
  return {
    id: `${manufacturerKey}/${file}`,
    manufacturer: manufacturerName,
    manufacturerKey,
    name,
    categories,
    moving,
    ...(beamAngle ? { beamAngle } : {}),
    ...(travel('Pan') ? { panDegrees: travel('Pan') } : {}),
    ...(travel('Tilt') ? { tiltDegrees: travel('Tilt') } : {}),
    ...(lumens !== undefined ? { lumens, ...(lumensEstimated ? { lumensEstimated } : {}) } : {}),
    ...(power !== undefined ? { powerW: power } : {}),
    ...(num(physical.weight) !== undefined ? { weightKg: num(physical.weight) } : {}),
    ...(dims.length === 3 && dims.every((d) => d !== undefined) ? { sizeMm: dims as [number, number, number] } : {}),
    ...(num(bulb.colorTemperature) !== undefined ? { colorTemperature: num(bulb.colorTemperature) } : {}),
    features: [...features].sort(),
    modes,
  }
}

async function readJson(path: string): Promise<Json | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

async function main() {
  const args = process.argv.slice(2)
  let source = args.find((a) => !a.startsWith('--'))
  if (args.includes('--download')) {
    const dir = await mkdtemp(join(tmpdir(), 'ofl-'))
    console.log(`Cloning the Open Fixture Library (fixtures/ only) into ${dir} ...`)
    execFileSync('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', REPO_URL, dir], { stdio: 'inherit' })
    execFileSync('git', ['-C', dir, 'sparse-checkout', 'set', 'fixtures'], { stdio: 'inherit' })
    source = dir
  }
  if (!source) {
    console.error('Usage: import-fixtures <path to open-fixture-library checkout> | --download')
    process.exit(1)
  }

  const root = join(source, 'fixtures')
  const manufacturers = (await readJson(join(root, 'manufacturers.json'))) ?? {}
  const fixtures: CatalogFixture[] = []
  let skipped = 0
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const manufacturer = manufacturers[entry.name]
    const manufacturerName = (isObject(manufacturer) ? str(manufacturer.name) : undefined) ?? entry.name
    for (const file of (await readdir(join(root, entry.name))).sort()) {
      if (!file.endsWith('.json')) continue
      const data = await readJson(join(root, entry.name, file))
      const fixture = data ? buildFixture(entry.name, manufacturerName, file.slice(0, -5), data) : null
      if (fixture) fixtures.push(fixture)
      else skipped++
    }
  }

  let commit = ''
  try {
    commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    /* not a git checkout */
  }
  const catalog: CatalogFile = {
    source: { name: 'Open Fixture Library', url: 'https://open-fixture-library.org', repository: REPO_URL, commit, license: 'MIT' },
    importedAt: new Date().toISOString().slice(0, 10),
    fixtures,
  }
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(join(OUT_DIR, 'fixtures.json'), JSON.stringify(catalog))
  try {
    await copyFile(join(source, 'LICENSE'), join(OUT_DIR, 'OFL-LICENSE.txt'))
  } catch {
    console.warn('Could not copy the Open Fixture Library LICENSE file; add it to server/catalog/ by hand.')
  }
  console.log(`Wrote ${fixtures.length} fixtures (${skipped} skipped: redirects or unusable) to ${OUT_DIR}fixtures.json`)
}

await main()
