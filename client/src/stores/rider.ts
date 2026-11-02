import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import * as api from '../api'
import type { DraftResult, Fixture, FixtureDraft, FixtureGroup, RiderFile, Similarity } from '../api'
import { profileFor } from '../fixtures/profiles'
import { useRig } from './rig'
import { useVenues } from './venues'

type Pt = [number, number]

/** The similarity that takes plan points A and B to world points a and b (x, z), as the server's placement module does (with the plan's y flipped: the scene is left-handed). */
export function similarityFromPairs(planA: Pt, planB: Pt, worldA: Pt, worldB: Pt): Similarity | null {
  const pdx = planB[0] - planA[0]
  const pdy = planB[1] - planA[1]
  const wdx = worldB[0] - worldA[0]
  const wdz = worldB[1] - worldA[1]
  const plen = Math.hypot(pdx, pdy)
  const wlen = Math.hypot(wdx, wdz)
  if (plen < 1 || wlen < 0.01) return null
  const scale = wlen / plen
  const theta = Math.atan2(wdz, wdx) - Math.atan2(-pdy, pdx)
  const c = Math.cos(theta) * scale
  const n = Math.sin(theta) * scale
  return { scale, theta, tx: worldA[0] - (c * planA[0] + n * planA[1]), tz: worldA[1] - (n * planA[0] - c * planA[1]) }
}

const KEY_STORAGE = 'preflight.visionKey'
const read = (key: string) => {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

export interface Flag {
  kind: 'choose' | 'position' | 'disagree' | 'assumed' | 'skipped' | 'read'
  text: string
  /** the rider numbers it is about, when it is about lights */
  ids: string[]
}

export type RiderStep = 'load' | 'calibrate' | 'review'

/** The tech rider import: the rider read for the open venue, the calibration that puts its plan into the venue, and the lights it would add. */
export const useRider = defineStore('rider', () => {
  const venues = useVenues()
  const rig = useRig()

  const open = ref(false)
  const step = ref<RiderStep>('load')
  const rider = ref<RiderFile | null>(null)
  const busy = ref('')
  const error = ref<string | null>(null)
  const provider = ref('anthropic')
  const apiKey = ref(read(KEY_STORAGE))

  // calibration
  const planImage = ref<{ url: string; crop: [number, number, number, number] } | null>(null)
  const planPoints = ref<(Pt | null)[]>([null, null])
  const worldPoints = ref<(Pt | null)[]>([null, null])
  /** Which world point the next click in the venue sets (0 or 1), or null when the viewer is not asked. */
  const pickingWorld = ref<number | null>(null)
  /** Set by the viewer: the height of the first surface above (x, z), or null where there is none. */
  const ceilingAt = ref<((x: number, z: number) => number | null) | null>(null)

  /** In the plan view, hide the small objects standing on the floor (speaker stacks, truss towers) so the spots under them can be picked. */
  const hideClutter = ref(true)
  /** Bumped to turn the plan view a quarter turn. */
  const viewTurns = ref(0)
  /** The wizard is on the step that places the plan: the viewer looks down on the venue and hides the crowd and the lights. */
  const calibrating = computed(() => open.value && step.value === 'calibrate')

  const similarity = computed(() => {
    const [a, b] = planPoints.value
    const [wa, wb] = worldPoints.value
    return a && b && wa && wb ? similarityFromPairs(a, b, wa, wb) : null
  })

  // review
  const result = ref<DraftResult | null>(null)
  const overrides = ref<Record<string, string>>({})
  const excluded = ref(new Set<string>())
  const ceilingHeight = ref(5)
  const standHeight = ref(1.5)
  const measure = ref(true)
  const onExisting = ref<'skip' | 'replace'>('skip')
  /** Moves made by hand, in meters on top of where the plan puts a light, by draft key. */
  const adjust = ref<Record<string, [number, number, number]>>({})
  /** The lights selected in the review (by draft key), for moving. */
  const selectedKeys = ref<string[]>([])

  function remember(key: string) {
    apiKey.value = key
    try {
      localStorage.setItem(KEY_STORAGE, key)
    } catch {
      /* private window: the key is only kept for this visit */
    }
  }

  async function run<T>(what: string, job: () => Promise<T>): Promise<T | undefined> {
    busy.value = what
    error.value = null
    try {
      return await job()
    } catch (e) {
      error.value = (e as Error).message
      return undefined
    } finally {
      busy.value = ''
    }
  }

  function reset() {
    rider.value = null
    planImage.value = null
    planPoints.value = [null, null]
    worldPoints.value = [null, null]
    pickingWorld.value = null
    result.value = null
    overrides.value = {}
    excluded.value = new Set()
    adjust.value = {}
    selectedKeys.value = []
    error.value = null
    step.value = 'load'
  }

  /** Opens the wizard for the open venue, on the rider it already has if any. */
  async function show() {
    const venue = venues.current
    if (!venue) return
    open.value = true
    reset()
    await run('Looking for a stored rider…', async () => {
      rider.value = await api.getRider(venue.id)
      if (rider.value?.plan) await loadPlan()
    })
  }

  function close() {
    open.value = false
    pickingWorld.value = null
    if (planImage.value) URL.revokeObjectURL(planImage.value.url)
    planImage.value = null
  }

  async function loadPlan() {
    const venue = venues.current
    if (!venue || !rider.value?.plan) return
    if (planImage.value) URL.revokeObjectURL(planImage.value.url)
    planImage.value = await api.riderPlanImage(venue.id)
    // the stage's front edge is the natural first reference: two points that are also easy to find in the model
    const edge = rider.value.plan.stage?.planPx
    if (edge && !planPoints.value.some(Boolean)) planPoints.value = [edge[0], edge[1]]
  }

  async function uploadPdf(file: File) {
    const venue = venues.current
    if (!venue) return
    await run('Reading the patch table…', async () => {
      rider.value = await api.uploadRiderPdf(venue.id, file)
      planImage.value = null
      result.value = null
    })
  }

  async function uploadJson(file: File) {
    const venue = venues.current
    if (!venue) return
    await run('Storing the rider file…', async () => {
      let parsed: RiderFile
      try {
        parsed = JSON.parse(await file.text()) as RiderFile
      } catch {
        throw new Error('That file is not JSON')
      }
      rider.value = await api.putRider(venue.id, parsed)
      result.value = null
      await loadPlan().catch(() => {
        error.value = 'The rider file is stored, but its plan picture needs the rider PDF too: upload the PDF first'
      })
    })
  }

  async function readPlan() {
    const venue = venues.current
    if (!venue) return
    if (!apiKey.value) {
      error.value = 'Enter an API key for the vision model first'
      return
    }
    remember(apiKey.value)
    await run('Reading the plan with the vision model (about a minute)…', async () => {
      rider.value = await api.readRiderPlan(venue.id, { provider: provider.value, apiKey: apiKey.value })
      result.value = null
      await loadPlan()
    })
  }

  async function removeRider() {
    const venue = venues.current
    if (!venue) return
    await api.deleteRider(venue.id)
    reset()
  }

  // --- calibration ---

  function setPlanPoint(index: number, point: Pt) {
    const next = [...planPoints.value]
    next[index] = point
    planPoints.value = next
  }

  /** Called by the viewer with the surface point that was clicked while a world point was asked for. */
  function deliverWorld(point: [number, number, number]) {
    const index = pickingWorld.value
    if (index === null) return
    const next = [...worldPoints.value]
    next[index] = [point[0], point[2]]
    worldPoints.value = next
    pickingWorld.value = null
  }

  // --- drafts ---

  let requestId = 0
  async function refreshDrafts() {
    const venue = venues.current
    const s = similarity.value
    if (!venue || !s || !rider.value) {
      result.value = null
      return
    }
    const mine = ++requestId
    try {
      const next = await api.riderDrafts(venue.id, {
        similarity: s,
        overrides: overrides.value,
        ceilingHeight: ceilingHeight.value,
        standHeight: standHeight.value,
      })
      if (mine === requestId) {
        result.value = next
        error.value = null
      }
    } catch (e) {
      if (mine === requestId) error.value = (e as Error).message
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  watch(
    [similarity, overrides, ceilingHeight, standHeight],
    () => {
      clearTimeout(timer)
      timer = setTimeout(refreshDrafts, 250)
    },
    { deep: true },
  )

  function setOverride(fixId: string, profileId: string) {
    const next = { ...overrides.value }
    if (profileId) next[fixId] = profileId
    else delete next[fixId]
    overrides.value = next
  }

  function toggleIncluded(key: string) {
    const next = new Set(excluded.value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    excluded.value = next
  }

  // --- moving lights by hand ---

  /** Where a draft's light would go: where the plan puts it, plus what was moved by hand. */
  function positionOf(d: FixtureDraft): [number, number, number] {
    const base = d.placement?.position ?? [0, 0, 0]
    const a = adjust.value[d.key]
    return a ? [base[0] + a[0], base[1] + a[1], base[2] + a[2]] : [base[0], base[1], base[2]]
  }

  const placed = computed(() => (result.value?.drafts ?? []).filter((d) => d.placement))

  /** Selects lights (adds to the selection when `add`); keys that have no position are left out. */
  function select(keys: readonly string[], add = false) {
    const known = new Set(placed.value.map((d) => d.key))
    const wanted = keys.filter((k) => known.has(k))
    selectedKeys.value = add ? [...new Set([...selectedKeys.value, ...wanted])] : [...new Set(wanted)]
  }

  function toggleSelected(key: string) {
    selectedKeys.value = selectedKeys.value.includes(key) ? selectedKeys.value.filter((k) => k !== key) : [...selectedKeys.value, key]
  }

  function selectGroup(name: string, add = false) {
    select(result.value?.groups.find((g) => g.name === name)?.keys ?? [], add)
  }

  const selectAll = () => select(placed.value.map((d) => d.key))

  /** Moves the selected lights by a distance in meters. */
  function nudge(delta: readonly [number, number, number], keys: readonly string[] = selectedKeys.value) {
    if (delta.every((n) => n === 0)) return
    const next = { ...adjust.value }
    for (const key of keys) {
      const a = next[key] ?? [0, 0, 0]
      next[key] = [a[0] + delta[0], a[1] + delta[1], a[2] + delta[2]]
    }
    adjust.value = next
  }

  /** Takes back the moves made by hand: for these lights, or for all. */
  function resetAdjust(keys?: readonly string[]) {
    if (!keys) return void (adjust.value = {})
    const next = { ...adjust.value }
    for (const key of keys) delete next[key]
    adjust.value = next
  }

  const movedCount = computed(() => Object.values(adjust.value).filter((a) => a.some((n) => Math.abs(n) > 1e-6)).length)

  /** The drafts that will be imported: placed, with a type, and not switched off. */
  const importable = computed(() => (result.value?.drafts ?? []).filter((d) => d.profileId && d.placement && !excluded.value.has(d.key)))

  /** Lights of the open venue that came from this rider already (same rider number and lamp). */
  const existingKeys = computed(() => {
    const map = new Map<string, string>()
    for (const f of rig.fixtures) if (f.patch) map.set(f.patch.lampId ?? f.patch.fixId, f.id)
    return map
  })
  const alreadyThere = computed(() => importable.value.filter((d) => existingKeys.value.has(d.key)))

  /** Adds the lights to the open venue (one undo step), with a group for each truss. */
  function importNow(): { added: number; replaced: number; skipped: number } {
    const wanted = importable.value
    const there = existingKeys.value
    let skipped = 0
    const list = wanted.filter((d) => {
      if (!there.has(d.key)) return true
      if (onExisting.value === 'skip') {
        skipped++
        return false
      }
      return true
    })
    const replaced = list.filter((d) => there.has(d.key)).length
    if (replaced) rig.removeMany(list.filter((d) => there.has(d.key)).map((d) => there.get(d.key)!))

    const ids = new Map<string, string>()
    const fixtures: Fixture[] = list.map((d) => {
      const id = crypto.randomUUID()
      ids.set(d.key, id)
      const placement = d.placement!
      let [x, y, z] = placement.position
      if (measure.value && placement.height === 'ceiling' && ceilingAt.value) {
        const hit = ceilingAt.value(x, z)
        if (hit !== null) y = hit
      }
      const moved = adjust.value[d.key]
      if (moved) {
        x += moved[0]
        y += moved[1]
        z += moved[2]
      }
      return {
        id,
        name: d.name,
        profileId: d.profileId!,
        position: [x, y, z],
        mount: placement.mount,
        yaw: 0,
        rotation: placement.rotation,
        ...(d.mode ? { mode: d.mode } : {}),
        ...(d.patch ? { patch: d.patch } : {}),
        values: { ...profileFor(d.profileId!).defaults },
      }
    })
    const groups: FixtureGroup[] = (result.value?.groups ?? [])
      .map((g) => ({ id: crypto.randomUUID(), name: `Truss ${g.name}`, fixtureIds: g.keys.map((k) => ids.get(k)).filter((x): x is string => !!x) }))
      .filter((g) => g.fixtureIds.length > 0)
    rig.importLights(fixtures, groups)
    return { added: fixtures.length - replaced, replaced, skipped }
  }

  // --- what to look at -------------------------------------------------------------------------

  /** Everything the reading and the mapping flagged, grouped for the review step; the same sentence for several lights is one entry with their numbers. */
  const flags = computed<Flag[]>(() => {
    const r = rider.value
    if (!r) return []
    const map = new Map<string, Flag>()
    const add = (kind: Flag['kind'], text: string, id?: string) => {
      const key = `${kind}:${text}`
      const entry = map.get(key) ?? { kind, text, ids: [] }
      if (id && !entry.ids.includes(id)) entry.ids.push(id)
      map.set(key, entry)
    }
    for (const text of r.issues) add('read', text)
    // With the lights worked out, what the plan reader said about missing, unpatched and disagreeing numbers is said again, per light, below.
    const covered = /puts it on|does not show it|no row for it/
    for (const text of r.planIssues ?? []) {
      if (result.value && covered.test(text)) continue
      const kind: Flag['kind'] = /puts it on/.test(text) ? 'disagree' : /does not show it/.test(text) ? 'position' : /projector/.test(text) ? 'skipped' : 'read'
      add(kind, text)
    }
    for (const d of result.value?.drafts ?? []) {
      const id = d.lampId ?? d.fixId
      if (d.status === 'unmapped') add('choose', d.notes.join('; ') || 'No fixture type found', id)
      else if (d.status === 'unplaced') add('position', `Patched (${d.name}) but not on the plan, so it has no position`, id)
      else if (d.status === 'ignored') add('skipped', d.notes.join('; '), id)
      else for (const n of d.notes) add(/^The plan has it on/.test(n) ? 'disagree' : 'assumed', n, id)
    }
    return [...map.values()]
  })

  return {
    open,
    step,
    rider,
    busy,
    error,
    provider,
    apiKey,
    planImage,
    planPoints,
    worldPoints,
    pickingWorld,
    ceilingAt,
    similarity,
    calibrating,
    viewTurns,
    hideClutter,
    adjust,
    selectedKeys,
    movedCount,
    placed,
    positionOf,
    select,
    toggleSelected,
    selectGroup,
    selectAll,
    nudge,
    resetAdjust,
    result,
    overrides,
    excluded,
    ceilingHeight,
    standHeight,
    measure,
    onExisting,
    importable,
    alreadyThere,
    flags,
    show,
    close,
    loadPlan,
    uploadPdf,
    uploadJson,
    readPlan,
    removeRider,
    setPlanPoint,
    deliverWorld,
    refreshDrafts,
    setOverride,
    toggleIncluded,
    importNow,
    remember,
  }
})
