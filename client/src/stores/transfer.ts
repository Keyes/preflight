import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { CrowdZone, Fixture, FixtureGroup, Venue } from '../api'
import { useVenues } from './venues'

/** The window for copying lights (and the groups they are in) from one venue to another. */
export const useTransfer = defineStore('transfer', () => {
  const venues = useVenues()
  const open = ref(false)
  /** 'copy' sends lights of the current venue to another one, 'import' brings lights from another venue into the current one. */
  const mode = ref<'copy' | 'import'>('import')
  /** The venue the lights come from (in 'copy' mode always the current one). */
  const sourceId = ref<string | null>(null)
  const preFixtureIds = ref<string[]>([])
  const preGroupIds = ref<string[]>([])
  const preZoneIds = ref<string[]>([])

  /** Opens the window to copy these lights (and groups, and crowd zones) of the current venue to another venue. */
  function openCopy(fixtureIds: readonly string[], groupIds: readonly string[] = [], zoneIds: readonly string[] = []) {
    mode.value = 'copy'
    sourceId.value = venues.currentId
    preFixtureIds.value = [...fixtureIds]
    preGroupIds.value = [...groupIds]
    preZoneIds.value = [...zoneIds]
    open.value = true
  }

  /** Opens the window to bring lights into the current venue from another one. */
  function openImport(fromId?: string) {
    mode.value = 'import'
    sourceId.value = fromId ?? venues.venues.find((v) => v.id !== venues.currentId)?.id ?? null
    preFixtureIds.value = []
    preGroupIds.value = []
    preZoneIds.value = []
    open.value = true
  }

  function close() {
    open.value = false
  }

  return { open, mode, sourceId, preFixtureIds, preGroupIds, preZoneIds, openCopy, openImport, close }
})

/** A name not in `used`: the name itself, or with " (2)", " (3)"... after it. Adds the result to `used`. */
function uniqueName(name: string, used: Set<string>): string {
  let result = name
  for (let n = 2; used.has(result); n++) result = `${name} (${n})`
  used.add(result)
  return result
}

/**
 * Copies of the chosen lights of `source` with new ids, and of the chosen groups with the new ids of their lights in
 * the same order (only the chosen lights come along). Names are made different from those in the destination. Lights and
 * zones are moved by `offset` (meters), for venues drawn at different origins.
 */
export function planTransfer(
  source: Venue,
  fixtureIds: ReadonlySet<string>,
  groupIds: ReadonlySet<string>,
  destination: { fixtures: readonly Fixture[]; groups: readonly FixtureGroup[]; zones?: readonly CrowdZone[] },
  zoneIds: ReadonlySet<string> = new Set(),
  offset: readonly [number, number, number] = [0, 0, 0],
): { fixtures: Fixture[]; groups: FixtureGroup[]; zones: CrowdZone[] } {
  const usedFixtureNames = new Set(destination.fixtures.map((f) => f.name))
  const usedGroupNames = new Set(destination.groups.map((g) => g.name))
  const idMap = new Map<string, string>()
  const fixtures: Fixture[] = []
  for (const original of source.fixtures ?? []) {
    if (!fixtureIds.has(original.id)) continue
    // a plain copy through JSON: the stores hand out reactive objects, which structuredClone refuses
    const copy = JSON.parse(JSON.stringify(original)) as Fixture
    copy.id = crypto.randomUUID()
    copy.position = [copy.position[0] + offset[0], copy.position[1] + offset[1], copy.position[2] + offset[2]]
    copy.name = uniqueName(original.name, usedFixtureNames)
    idMap.set(original.id, copy.id)
    fixtures.push(copy)
  }
  const groups: FixtureGroup[] = []
  for (const original of source.groups ?? []) {
    if (!groupIds.has(original.id)) continue
    const members = original.fixtureIds.map((id) => idMap.get(id)).filter((id): id is string => !!id)
    if (members.length) groups.push({ id: crypto.randomUUID(), name: uniqueName(original.name, usedGroupNames), fixtureIds: members })
  }
  const usedZoneNames = new Set((destination.zones ?? []).map((z) => z.name))
  const zones = (source.crowd?.zones ?? [])
    .filter((z) => zoneIds.has(z.id))
    .map((z): CrowdZone => ({
      ...z,
      id: crypto.randomUUID(),
      name: uniqueName(z.name, usedZoneNames),
      x0: z.x0 + offset[0],
      x1: z.x1 + offset[0],
      y: z.y + offset[1],
      z0: z.z0 + offset[2],
      z1: z.z1 + offset[2],
      facing: z.facing ? [z.facing[0] + offset[0], z.facing[1] + offset[2]] : null,
    }))
  return { fixtures, groups, zones }
}
