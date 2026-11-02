import type { CatalogFixture, CatalogMode, RiderPatchRow } from '@preflight/shared'

/**
 * Which catalog fixture a rider row is, and in which of its DMX modes. The rider names a fixture in the mode column when it
 * can ("9Ch. SSP, Expolite Tourled MC60 Zoom"); a plain "Dim" row names none, and then the light's name decides ("ACL<<",
 * "Profil Back<"). Anything the user decided before (`overrides`) beats both.
 */

export type MappingSource = 'override' | 'alias' | 'name rule' | 'none'

export interface TypeMatch {
  /** the catalog id, absent when nothing fits (the row is then left for the user to map) */
  profileId?: string
  source: MappingSource
  /** a row that is not a light at all (a mirror ball's motor): nothing to place */
  ignore?: string
  /** what the user should know about the match */
  note?: string
}

/** Names that tell what a "Dim" or "Wash" row is, for the venues that do not name the fixture in the mode column. Tried in order. */
export interface NameRule {
  match: RegExp
  profileId?: string
  /** this is not a light */
  ignore?: string
  note?: string
}

export const NAME_RULES: NameRule[] = [
  { match: /^ACL/i, profileId: 'generic/acl-par64-250w', note: 'The rider names no lamp for the ACL bars: placeholder.' },
  { match: /^DWE/i, profileId: 'generic/dwe-2-light-blinder' },
  { match: /^(Gasse\s?S[RL]|Front\s?[<>]|Arri)/i, profileId: 'arri/junior-650-plus', note: 'The rider lists one fresnel, the ARRI Junior 650.' },
  { match: /^Profil/i, profileId: 'etc/source-four-750-conventional', note: 'The rider names the ETC Source Four but not its lens: 26 degrees assumed.' },
  {
    match: /^(Audience\s+(front|back)|Merch)/i,
    profileId: 'generic/conventional-par',
    note: 'The rider names no lamp for the conventional PARs: placeholder.',
  },
  { match: /^(Robin|Robe)/i, profileId: 'robe/robin-ledbeam-150' },
  { match: /^Strobe/i, profileId: 'martin/atomic-3000', note: 'The rider names no model for the 2-channel strobes: Atomic 3000 assumed.' },
  { match: /Spiegelkugel|mirror\s?ball/i, ignore: 'a mirror ball motor, not a light' },
]

/** "Stairville mini Stage PAR 45°" and "stairville mini stage par 45" are the same thing. */
export const normalize = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

interface Key {
  text: string
  fixture: CatalogFixture
}

/** Every name a catalog fixture can be called by: its full name, its name alone, its id, and the aliases of custom fixtures. */
function keysOf(catalog: readonly CatalogFixture[]): Key[] {
  const keys: Key[] = []
  for (const fixture of catalog) {
    const names = new Set([`${fixture.manufacturer} ${fixture.name}`, fixture.name, fixture.id.split('/')[1] ?? '', ...(fixture.aliases ?? [])])
    for (const name of names) {
      const text = normalize(name)
      if (text.length >= 3) keys.push({ text, fixture })
    }
  }
  return keys
}

/**
 * The catalog fixture a free-text name stands for: an exact name first, then the longest catalog name found inside the text
 * ("Stairville mini Stage PAR 45°" holds the alias "Stairville mini stage PAR"), then a text that is part of a name ("Atomic 3000").
 * Words must match whole; a tie between different fixtures is no match.
 */
export function findByName(text: string, catalog: readonly CatalogFixture[]): CatalogFixture | undefined {
  const wanted = normalize(text)
  if (!wanted) return undefined
  const keys = keysOf(catalog)
  const padded = ` ${wanted} `
  const pick = (candidates: Key[], score: (k: Key) => number) => {
    if (candidates.length === 0) return undefined
    const best = Math.max(...candidates.map(score))
    const ids = new Set(candidates.filter((k) => score(k) === best).map((k) => k.fixture.id))
    return ids.size === 1 ? candidates.find((k) => score(k) === best)!.fixture : undefined
  }
  const exact = keys.filter((k) => k.text === wanted)
  if (exact.length) return pick(exact, () => 1)
  const inside = keys.filter((k) => k.text.length >= 6 && padded.includes(` ${k.text} `))
  if (inside.length) return pick(inside, (k) => k.text.length)
  const part = keys.filter((k) => wanted.length >= 6 && ` ${k.text} `.includes(padded))
  return pick(part, (k) => -k.text.length)
}

/** The fixture a patch row is: the user's own choice for it, else the fixture its mode column names, else a rule on its name. */
export function resolveType(
  row: Pick<RiderPatchRow, 'fixId' | 'name' | 'typeHint'>,
  catalog: readonly CatalogFixture[],
  overrides: Readonly<Record<string, string>> = {},
): TypeMatch {
  const chosen = overrides[row.fixId] ?? overrides[`type:${normalize(row.typeHint ?? '')}`]
  if (chosen && catalog.some((f) => f.id === chosen)) return { profileId: chosen, source: 'override' }
  if (row.typeHint) {
    const found = findByName(row.typeHint, catalog)
    if (found) return { profileId: found.id, source: 'alias' }
  }
  for (const rule of NAME_RULES) {
    if (!rule.match.test(row.name) && !(row.typeHint && rule.match.test(row.typeHint))) continue
    if (rule.ignore) return { source: 'name rule', ignore: rule.ignore }
    if (rule.profileId && catalog.some((f) => f.id === rule.profileId))
      return { profileId: rule.profileId, source: 'name rule', ...(rule.note ? { note: rule.note } : {}) }
  }
  return { source: 'none', ...(row.typeHint ? { note: `"${row.typeHint}" is not in the fixture catalog (add it to server/catalog/custom.json)` } : {}) }
}

const channelCountOf = (mode: CatalogMode) => mode.channelCount ?? mode.channels.length

export interface ModeMatch {
  /** the catalog's name for the mode */
  mode?: string
  note?: string
}

/** Words that tell personalities of one channel count apart ("9Ch. SSP" against "9ch HSIC"). */
const PERSONALITY = /\b(ssp|hsic|tour|tr16|rgbw|rgb|cmy|wash|spot)\b/g

/**
 * The DMX mode of a catalog fixture that a row's mode column means: by name when the catalog names it alike, else by channel
 * count (the personality word breaking a tie), else none. A mode that is only nearly the one written is returned with a note.
 */
export function resolveMode(fixture: CatalogFixture, row: Pick<RiderPatchRow, 'mode' | 'channels'>): ModeMatch {
  const modes = fixture.modes
  if (modes.length === 0) return {}
  const wanted = normalize(row.mode)
  const same = modes.find((m) => normalize(m.name) === wanted || (m.shortName && normalize(m.shortName) === wanted))
  if (same) return { mode: same.name }
  const words = wanted.match(PERSONALITY) ?? []
  const inName = (m: CatalogMode) => normalize(`${m.name} ${m.shortName ?? ''}`)
  const channels = row.channels ?? (/^dim\b/.test(wanted) ? 1 : undefined)
  const byCount = channels === undefined ? [] : modes.filter((m) => channelCountOf(m) === channels)
  const pool = byCount.length ? byCount : []
  if (pool.length === 0) return { note: `the rider's mode "${row.mode}" is not among ${fixture.name}'s modes (${modes.map((m) => m.name).join(', ')})` }
  const exactWords = pool.filter((m) => words.every((w) => new RegExp(`\\b${w}\\b`).test(inName(m))))
  const chosen = exactWords.length === 1 ? exactWords[0] : pool.length === 1 ? pool[0] : undefined
  if (!chosen) return { mode: pool[0].name, note: `"${row.mode}" fits several modes of ${fixture.name}; ${pool[0].name} taken` }
  const missing = words.filter((w) => !new RegExp(`\\b${w}\\b`).test(inName(chosen)))
  return { mode: chosen.name, ...(missing.length ? { note: `the rider writes "${row.mode}", the closest mode is ${chosen.name}` } : {}) }
}
