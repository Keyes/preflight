import type { CatalogFixture } from '../catalog.js'
import { resolveMode, resolveType } from './mapping.js'
import { poseFor, toWorld, type Quaternion, type Similarity } from './placement.js'
import type { RiderFile, RiderLamp, RiderPatchRow } from './types.js'

/**
 * Turns a rider file into the lights it describes, as drafts the import wizard shows for review and then adds to a venue:
 * which catalog fixture and mode each is, where it hangs or stands, and its patch. The patch (the newer list) decides what a
 * light is and which truss it is on; the plan decides where it is on the floor.
 */

export interface DraftOptions {
  /** plan pixels to world meters, from the calibration */
  similarity: Similarity
  /** the user's own choices: by rider number ("#201") or by fixture text ("type:expolite tourled mc60 zoom") to a catalog id */
  overrides?: Readonly<Record<string, string>>
  /** height of the ceiling for lights that hang from no truss, meters (the wizard measures it in the model; this is the fallback) */
  ceilingHeight?: number
  /** how far above the floor a light on a stand sits, meters */
  standHeight?: number
}

export type DraftStatus = 'ready' | 'unmapped' | 'unplaced' | 'ignored'

export interface FixtureDraft {
  /** the lamp's id, or the rider number for a patch row the plan does not show */
  key: string
  fixId: string
  lampId?: string
  name: string
  profileId?: string
  /** the catalog's name for the mode */
  mode?: string
  patch?: { fixId: string; lampId?: string; universe: number; address: number; truss?: string }
  placement?: {
    position: [number, number, number]
    mount: 'hanging' | 'standing'
    rotation: Quaternion
    /** what the height was taken from: a truss's underside, the ceiling (measure it), or a stand */
    height: 'truss' | 'ceiling' | 'stand'
    /** the truss it hangs from, when there is one */
    truss?: string
  }
  status: DraftStatus
  /** things to look at before importing: what was assumed, what disagrees */
  notes: string[]
}

export interface DraftResult {
  drafts: FixtureDraft[]
  /** one group per truss, lights in order from left to right */
  groups: { name: string; keys: string[] }[]
  /** lights that need a person's decision, as plain sentences */
  issues: string[]
}

/** How a light is mounted, by its patch name, where the plan's symbol position alone does not say. */
const PLACEMENT_RULES: { match: RegExp; mode: 'truss' | 'stand' }[] = [
  { match: /^Trusstand/i, mode: 'truss' }, // on the tower that carries the end of a truss: at that truss's height
  { match: /^Gasse/i, mode: 'stand' }, // stage-side stands
]

const DEFAULT_CEILING = 5
const DEFAULT_STAND = 1.5

/** The truss a patch's truss column means ("LX3/4" is whichever of the two the plan puts the light on, else the first). */
function patchTruss(column: string | undefined, planTruss: string | undefined): string | undefined {
  if (!column) return planTruss
  const m = /^(LX)(\d)\/(\d)$/.exec(column)
  if (!m) return column
  const options = [`LX${m[2]}`, `LX${m[3]}`]
  return planTruss && options.includes(planTruss) ? planTruss : options[0]
}

/** Whether a plan point is on the stage deck: upstage of the stage's front edge and between its ends. */
function onStage(rider: RiderFile, px: [number, number]): boolean {
  const edge = rider.plan?.stage?.planPx
  if (!edge) return false
  const [a, b] = edge
  const xs = [a[0], b[0]].sort((p, q) => p - q)
  return px[1] < Math.min(a[1], b[1]) && px[0] >= xs[0] && px[0] <= xs[1]
}

export function buildDrafts(rider: RiderFile, catalog: readonly CatalogFixture[], options: DraftOptions): DraftResult {
  const rows = new Map(rider.patch.rows.map((r) => [r.fixId, r]))
  const lamps = rider.lamps ?? []
  const byId = new Map(catalog.map((f) => [f.id, f]))
  const issues: string[] = []
  const drafts: FixtureDraft[] = []
  const trusses = rider.plan?.trusses ?? {}

  const draftFor = (row: RiderPatchRow | undefined, lamp: RiderLamp | undefined, sub: string | undefined): FixtureDraft => {
    const fixId = row?.fixId ?? lamp!.fixId
    const notes: string[] = []
    const key = lamp?.lampId ?? fixId
    const name = row ? (sub ? `${row.name} ${sub}` : row.name) : `Light ${key.replace('#', '')}`
    const draft: FixtureDraft = { key, fixId, ...(lamp && lamp.lampId !== fixId ? { lampId: lamp.lampId } : {}), name, status: 'ready', notes }

    if (row) {
      draft.patch = { fixId, ...(draft.lampId ? { lampId: draft.lampId } : {}), universe: row.universe, address: row.address, truss: row.truss }
      const type = resolveType(row, catalog, options.overrides)
      if (type.ignore) {
        draft.status = 'ignored'
        notes.push(`Not imported: ${type.ignore}`)
        return draft
      }
      if (type.note) notes.push(type.note)
      if (type.profileId) {
        draft.profileId = type.profileId
        const mode = resolveMode(byId.get(type.profileId)!, row)
        if (mode.mode) draft.mode = mode.mode
        if (mode.note) notes.push(mode.note)
      } else {
        draft.status = 'unmapped'
      }
    } else {
      notes.push(`The plan shows ${fixId} but the patch has no row for it: no address`)
      const chosen = options.overrides?.[fixId]
      if (chosen && byId.has(chosen)) {
        draft.profileId = chosen // the user's choice stands in for the row that is missing
      } else {
        draft.status = 'unmapped'
        const symbol = lamp?.symbol ? ` (the plan symbol reads "${lamp.symbol}")` : ''
        notes.push(`Choose its type${symbol}`)
      }
    }

    if (!lamp) {
      if (draft.status === 'ready') draft.status = 'unplaced'
      notes.push('Not on the plan: no position')
      return draft
    }

    // where it is
    const profile = draft.profileId ? byId.get(draft.profileId) : undefined
    const [x, z] = toWorld(options.similarity, lamp.planPx)
    const rule = PLACEMENT_RULES.find((r) => row && r.match.test(row.name))
    const truss = rule?.mode === 'stand' ? undefined : rule?.mode === 'truss' || lamp.trussOnPlan ? patchTruss(row?.truss, lamp.trussOnPlan) : undefined
    let mount: 'hanging' | 'standing' = 'hanging'
    let height: 'truss' | 'ceiling' | 'stand' = 'ceiling'
    let y = options.ceilingHeight ?? DEFAULT_CEILING
    if (rule?.mode === 'stand') {
      mount = 'standing'
      height = 'stand'
      y = (onStage(rider, lamp.planPx) ? (rider.plan?.stage?.height ?? 0) : 0) + (options.standHeight ?? DEFAULT_STAND)
      notes.push(`On a stand: ${(options.standHeight ?? DEFAULT_STAND).toFixed(1)} m above the floor assumed`)
    } else if (truss && trusses[truss] && trusses[truss].underside > 0) {
      height = 'truss'
      y = trusses[truss].underside
      if (row && lamp.trussOnPlan && lamp.trussOnPlan !== truss && !(row.truss.includes('/') && row.truss.includes(lamp.trussOnPlan.replace('LX', '')))) {
        notes.push(`The plan has it on ${lamp.trussOnPlan}, the patch (newer) on ${truss}: hung at ${truss}'s height, plan position kept`)
      }
    } else {
      notes.push(`On no truss: hangs from the ceiling (${y.toFixed(1)} m assumed until measured in the model)`)
    }

    // which way it points: straight down or up, unless it is a fixed light whose symbol shows a direction (moving heads are aimed in the viewer)
    const pose = poseFor(lamp, mount, options.similarity, !profile?.moving)
    draft.placement = { position: [x, y, z], mount, rotation: pose.rotation, height, ...(height === 'truss' && truss ? { truss } : {}) }
    return draft
  }

  const seen = new Set<string>()
  for (const lamp of lamps) {
    const row = rows.get(lamp.fixId)
    const group = lamps.filter((l) => l.fixId === lamp.fixId)
    const sub = group.length > 1 ? String(group.indexOf(lamp) + 1) : undefined
    seen.add(lamp.fixId)
    drafts.push(draftFor(row, lamp, sub))
  }
  for (const row of rider.patch.rows) if (!seen.has(row.fixId)) drafts.push(draftFor(row, undefined, undefined))

  const groups = new Map<string, FixtureDraft[]>()
  for (const d of drafts) {
    const truss = d.placement?.truss
    if (truss) groups.set(truss, [...(groups.get(truss) ?? []), d])
  }
  const orderedGroups = [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, list]) => ({ name, keys: list.sort((a, b) => a.placement!.position[0] - b.placement!.position[0]).map((d) => d.key) }))

  const unmapped = drafts.filter((d) => d.status === 'unmapped')
  if (unmapped.length) issues.push(`${unmapped.length} ${unmapped.length === 1 ? 'light needs' : 'lights need'} a fixture type chosen: ${unmapped.map((d) => d.fixId).slice(0, 12).join(', ')}${unmapped.length > 12 ? ', …' : ''}`)
  const unplaced = drafts.filter((d) => d.status === 'unplaced')
  if (unplaced.length) issues.push(`${unplaced.length} patched ${unplaced.length === 1 ? 'light is' : 'lights are'} not on the plan, so they have no position: ${unplaced.map((d) => d.fixId).join(', ')}`)
  return { drafts, groups: orderedGroups, issues }
}
