import { computed, reactive, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import * as api from '../api'
import type { Fixture, FixtureGroup } from '@preflight/shared'
import { GENERIC_ID, GENERIC_MOVING_HEAD } from '../domain/profiles'
import type { RotationReadout } from '../scene/SelectionGizmo'
import { partKey, useAutosave } from './autosave'
import { useViewer } from './viewer'
import { useCatalog } from './catalog'
import { FixtureHistory } from '../domain/fixtureHistory'
import { useInteraction } from './interaction'
import { useLayout } from './layout'
import { useVenues } from './venues'

/** The lights placed in the current venue, with their selection, undo, aiming and placing. */
export const useRig = defineStore('rig', () => {
  const venues = useVenues()
  const layout = useLayout()
  const interaction = useInteraction()
  const autosave = useAutosave()
  const catalog = useCatalog()
  const viewer = useViewer()
  /** The selected fixtures, in the order they were selected. */
  const selectedIds = ref<string[]>([])
  /** The selected fixture when exactly one is selected (what single-light editing works on). */
  const selectedId = computed(() => (selectedIds.value.length === 1 ? selectedIds.value[0] : null))
  /** The fixture picker window is open. */
  const pickerOpen = ref(false)
  /** What the gizmo on the selected fixture does: drag it around or turn it. */
  const gizmoMode = ref<'move' | 'rotate'>('move')
  /** Shown next to the pointer while a rotation ring is being dragged. */
  const rotationReadout = ref<RotationReadout | null>(null)

  const fixtures = computed(() => venues.current?.fixtures ?? [])
  const selected = computed(() => fixtures.value.find((f) => f.id === selectedId.value))
  /** All selected fixtures, in selection order. */
  const selection = computed(() => selectedIds.value.map((id) => fixtures.value.find((f) => f.id === id)).filter((f): f is Fixture => !!f))

  /** Edits apply to the venue at once; its lights and groups are saved a moment after the last change (see autosave.ts). */
  function schedulePersist() {
    const id = venues.currentId
    if (!id) return
    autosave.schedule(partKey(id, 'lights'), () => {
      const venue = venues.venues.find((v) => v.id === id)
      return venue ? api.saveFixtures(id, venue.fixtures ?? [], venue.groups ?? []) : Promise.resolve()
    })
  }

  // Leaving a venue drops the selection (its edits are saved all the same).
  watch(
    () => venues.currentId,
    () => {
      selectedIds.value = []
      pickerOpen.value = false
      aim.anchor = null
      aim.ids = []
    },
  )

  // --- undo and redo ---------------------------------------------------------------------------
  //
  // Every edit calls `touch()` before it changes anything. The first call for a venue remembers the lights as they
  // are; the edits of one tick (a bulk action is many small ones) are then recorded together as one step.

  const histories = new Map<string, FixtureHistory>()
  /** Bumped whenever a history changes, so that the computed values below update. */
  const historyVersion = ref(0)
  let applying = false
  let scheduled = false
  let pendingVenue = ''
  let pendingLabel = ''
  let pendingKey: string | null = null
  let pendingAll = false
  const pendingIds = new Set<string>()

  function touch(label: string, key: string | null, ids: readonly string[] | 'all') {
    if (applying) return
    const venue = venues.current
    if (!venue) return
    if (!histories.has(venue.id)) histories.set(venue.id, new FixtureHistory(venue.fixtures ?? [], venue.groups ?? []))
    if (!scheduled) {
      scheduled = true
      pendingVenue = venue.id
      pendingLabel = label
      pendingKey = key
      pendingAll = false
      pendingIds.clear()
      queueMicrotask(commitHistory)
    }
    if (ids === 'all') pendingAll = true
    else for (const id of ids) pendingIds.add(id)
  }

  function commitHistory() {
    scheduled = false
    const history = histories.get(pendingVenue)
    const venue = venues.venues.find((v) => v.id === pendingVenue)
    if (!history || !venue) return
    if (history.record(venue.fixtures ?? [], pendingAll ? 'all' : [...pendingIds], pendingLabel, pendingKey, performance.now(), venue.groups ?? []))
      historyVersion.value++
  }

  const currentHistory = () => (venues.currentId ? histories.get(venues.currentId) : undefined)
  const canUndo = computed(() => (historyVersion.value, !!currentHistory()?.canUndo))
  const canRedo = computed(() => (historyVersion.value, !!currentHistory()?.canRedo))
  const undoLabel = computed(() => (historyVersion.value, currentHistory()?.undoSteps.at(-1)?.label ?? ''))
  const redoLabel = computed(() => (historyVersion.value, currentHistory()?.redoSteps.at(-1)?.label ?? ''))

  /** A short message in the toast at the bottom of the view. */
  function say(text: string) {
    layout.showToast({ text })
  }

  function step(direction: 'undo' | 'redo') {
    const venue = venues.current
    const history = currentHistory()
    if (!venue || !history) return
    if (scheduled) commitHistory() // an edit from this very moment becomes the step to undo
    const result = direction === 'undo' ? history.undo(venue.fixtures ?? []) : history.redo(venue.fixtures ?? [])
    if (!result) return
    applying = true
    venue.fixtures = result.fixtures
    if (result.groups) venue.groups = result.groups
    applying = false
    selectedIds.value = result.ids.filter((id) => result.fixtures.some((f) => f.id === id))
    historyVersion.value++
    say(`${direction === 'undo' ? 'Undid' : 'Redid'}: ${result.label}`)
    schedulePersist()
  }

  const undo = () => step('undo')
  const redo = () => step('redo')

  function list(): Fixture[] {
    const venue = venues.current
    if (!venue) return []
    return (venue.fixtures ??= [])
  }

  function nextName(base: string) {
    const used = new Set(list().map((f) => f.name))
    for (let n = 1; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`
  }

  function baseName(profileId: string) {
    return profileId === GENERIC_ID ? 'Moving head' : catalog.profileFor(profileId).name
  }

  function add(partial: Pick<Fixture, 'position' | 'mount'> & Partial<Fixture>, selectIt = true): Fixture {
    touch('Place light', null, 'all')
    const profile = partial.profileId ? catalog.profileFor(partial.profileId) : GENERIC_MOVING_HEAD
    const fixture: Fixture = {
      id: crypto.randomUUID(),
      name: nextName(baseName(profile.id)),
      profileId: profile.id,
      yaw: 0,
      values: { ...profile.defaults },
      ...partial,
    }
    list().push(fixture)
    if (selectIt) selectedIds.value = [fixture.id]
    schedulePersist()
    return fixture
  }

  /** What an edit of these fields is called in the undo list. */
  function patchLabel(patch: object) {
    const keys = Object.keys(patch)
    if (keys.includes('rotation') && !keys.includes('position')) return 'Rotate'
    if (keys.includes('rotation') || keys.includes('position')) return 'Move'
    if (keys.includes('name')) return 'Rename'
    if (keys.includes('mode')) return 'Change DMX mode'
    if (keys.includes('castShadows')) return 'Change shadows'
    return 'Edit light'
  }

  function update(id: string, patch: Partial<Omit<Fixture, 'id' | 'values'>>) {
    const fixture = list().find((f) => f.id === id)
    if (!fixture) return
    touch(patchLabel(patch), null, [id])
    Object.assign(fixture, patch)
    schedulePersist()
  }

  function setValue(id: string, key: string, value: number) {
    const fixture = list().find((f) => f.id === id)
    if (!fixture) return
    touch(`Change ${key}`, `value:${key}:${id}`, [id])
    fixture.values[key] = Math.min(1, Math.max(0, value))
    schedulePersist()
  }

  function setValues(id: string, values: Record<string, number>) {
    const fixture = list().find((f) => f.id === id)
    if (!fixture) return
    const keys = Object.keys(values).sort()
    touch(keys.join() === 'blue,green,red' ? 'Change color' : 'Change values', `values:${keys.join()}:${id}`, [id])
    for (const [k, v] of Object.entries(values)) fixture.values[k] = Math.min(1, Math.max(0, v))
    schedulePersist()
  }

  /** Removes fixtures and drops them from the selection. */
  function removeMany(ids: readonly string[]) {
    const venue = venues.current
    if (!venue?.fixtures || ids.length === 0) return
    touch('Delete', null, ids)
    const gone = new Set(ids)
    const name = ids.length === 1 ? venue.fixtures.find((f) => f.id === ids[0])?.name : undefined
    // Deleting asks nothing: it says what went and offers Undo, as long as the delete is still the last step.
    layout.showToast({
      text: name ? `Deleted ${name}` : `Deleted ${ids.length} lights`,
      action: { label: 'Undo', run: () => undoLabel.value === 'Delete' && step('undo') },
    })
    venue.fixtures = venue.fixtures.filter((f) => !gone.has(f.id))
    selectedIds.value = selectedIds.value.filter((id) => !gone.has(id))
    schedulePersist()
  }

  function remove(id: string) {
    removeMany([id])
  }

  /** Copies a fixture, 0.5 m to its side. The copy is selected unless `selectIt` is false. */
  function duplicate(id: string, selectIt = true): Fixture | undefined {
    const source = list().find((f) => f.id === id)
    if (!source) return undefined
    touch('Duplicate', null, 'all')
    // Copy field by field: `source` is a reactive proxy, which structuredClone refuses to clone.
    return add(
      {
        profileId: source.profileId,
        ...(source.mode ? { mode: source.mode } : {}),
        mount: source.mount,
        yaw: source.yaw,
        ...(source.rotation ? { rotation: [...source.rotation] as Fixture['rotation'] } : {}),
        ...(source.castShadows !== undefined ? { castShadows: source.castShadows } : {}),
        values: { ...source.values },
        name: nextName(baseName(source.profileId)),
        position: [source.position[0] + 0.5, source.position[1], source.position[2]],
      },
      selectIt,
    )
  }

  /** Copies several fixtures; the copies become the selection. */
  function duplicateMany(ids: readonly string[]) {
    touch('Duplicate', null, 'all')
    const copies = ids.map((id) => duplicate(id, false)).filter((f): f is Fixture => !!f)
    if (copies.length) selectedIds.value = copies.map((f) => f.id)
  }

  /** Several fixtures get the same field values. */
  function updateMany(ids: readonly string[], patch: Partial<Omit<Fixture, 'id' | 'values'>>) {
    for (const id of ids) update(id, patch)
  }

  function setValueMany(ids: readonly string[], key: string, value: number) {
    for (const id of ids) setValue(id, key, value)
  }

  function setValuesMany(ids: readonly string[], values: Record<string, number>) {
    for (const id of ids) setValues(id, values)
  }

  // --- groups ----------------------------------------------------------------------------------
  //
  // A group is a named, ordered list of fixture ids. A deleted light stays listed (the lists below skip it), so that
  // undoing the delete puts it back in its group; the server drops such leftovers when it saves.

  const groups = computed(() => venues.current?.groups ?? [])

  function groupList(): FixtureGroup[] {
    const venue = venues.current
    if (!venue) return []
    return (venue.groups ??= [])
  }

  /** The lights of a group that exist, in the group's order. */
  function groupMembers(group: FixtureGroup): Fixture[] {
    return group.fixtureIds.map((id) => fixtures.value.find((f) => f.id === id)).filter((f): f is Fixture => !!f)
  }

  /** The group whose lights are exactly the selection, if there is one. */
  const activeGroup = computed(() => {
    const ids = new Set(selectedIds.value)
    if (ids.size === 0) return undefined
    return groups.value.find((g) => {
      const members = groupMembers(g)
      return members.length === ids.size && members.every((f) => ids.has(f.id))
    })
  })

  function nextGroupName() {
    const used = new Set(groupList().map((g) => g.name))
    for (let n = 1; ; n++) if (!used.has(`Group ${n}`)) return `Group ${n}`
  }

  /** Makes a group of the given lights (the selection by default), in the order given. */
  function createGroup(ids: readonly string[] = selectedIds.value, name?: string): FixtureGroup | undefined {
    const known = new Set(fixtures.value.map((f) => f.id))
    const members = [...new Set(ids)].filter((id) => known.has(id))
    if (members.length === 0) return undefined
    touch('Create group', null, [])
    const group: FixtureGroup = { id: crypto.randomUUID(), name: name?.trim() || nextGroupName(), fixtureIds: members }
    groupList().push(group)
    schedulePersist()
    return group
  }

  function renameGroup(id: string, name: string) {
    const group = groupList().find((g) => g.id === id)
    const clean = name.trim()
    if (!group || !clean || clean === group.name) return
    touch('Rename group', null, [])
    group.name = clean
    schedulePersist()
  }

  function deleteGroup(id: string) {
    const venue = venues.current
    if (!venue?.groups?.some((g) => g.id === id)) return
    touch('Delete group', null, [])
    venue.groups = venue.groups.filter((g) => g.id !== id)
    schedulePersist()
  }

  /** Gives the group exactly these lights, in this order. */
  function setGroupMembers(id: string, ids: readonly string[], label = 'Edit group') {
    const group = groupList().find((g) => g.id === id)
    if (!group) return
    const known = new Set(fixtures.value.map((f) => f.id))
    const members = [...new Set(ids)].filter((x) => known.has(x))
    touch(label, null, [])
    group.fixtureIds = members
    schedulePersist()
  }

  /** Adds lights to the end of a group (those already in it keep their place). */
  function addToGroup(id: string, ids: readonly string[]) {
    const group = groupList().find((g) => g.id === id)
    if (!group) return
    const have = new Set(group.fixtureIds)
    const added = ids.filter((x) => !have.has(x))
    if (added.length) setGroupMembers(id, [...groupMembers(group).map((f) => f.id), ...added], 'Add to group')
  }

  function removeFromGroup(id: string, fixtureId: string) {
    const group = groupList().find((g) => g.id === id)
    if (!group) return
    setGroupMembers(
      id,
      groupMembers(group)
        .map((f) => f.id)
        .filter((x) => x !== fixtureId),
      'Remove from group',
    )
  }

  /** Moves a light one place earlier (-1) or later (+1) in its group. */
  function moveInGroup(id: string, fixtureId: string, direction: -1 | 1) {
    const group = groupList().find((g) => g.id === id)
    if (!group) return
    const order = groupMembers(group).map((f) => f.id)
    const from = order.indexOf(fixtureId)
    const to = from + direction
    if (from < 0 || to < 0 || to >= order.length) return
    ;[order[from], order[to]] = [order[to], order[from]]
    setGroupMembers(id, order, 'Reorder group')
  }

  /** Selects the lights of a group, in the group's order (adds to the selection when `add` is true). */
  function selectGroup(id: string, add = false) {
    const group = groups.value.find((g) => g.id === id)
    if (!group) return
    const ids = groupMembers(group).map((f) => f.id)
    selectMany(add ? [...selectedIds.value, ...ids] : ids)
  }

  // --- lights from another venue ----------------------------------------------------------------

  /** Adds lights (and the groups they belong to) copied from another venue, and selects the new lights. */
  function importLights(newFixtures: Fixture[], newGroups: FixtureGroup[]) {
    if (!venues.current || newFixtures.length === 0) return
    touch('Import lights', null, 'all')
    list().push(...newFixtures)
    groupList().push(...newGroups)
    selectedIds.value = newFixtures.map((f) => f.id)
    say(
      `Added ${newFixtures.length} ${newFixtures.length === 1 ? 'light' : 'lights'}${newGroups.length ? ` and ${newGroups.length} ${newGroups.length === 1 ? 'group' : 'groups'}` : ''}`,
    )
    schedulePersist()
  }

  /** Drops the undo history of a venue whose lights were changed from outside (so that undo cannot take them out again). */
  function forgetHistory(venueId: string) {
    histories.delete(venueId)
    historyVersion.value++
  }

  // --- aiming ----------------------------------------------------------------------------------
  //
  // "Aim at point" waits for a click on a surface (the 'aim' click mode), then points the selected lights at it: the view
  // works out pan and tilt, or a new orientation, since it knows where the lights are (`viewer.api.aim`). The point is
  // kept, so the spread and fan sliders can re-aim the same lights while it is still their selection.

  const aim = reactive({
    anchor: null as [number, number, number] | null,
    /** the lights that were aimed, in order */
    ids: [] as string[],
    /** meters between the spots the lights aim at, along the line they stand on */
    spread: 0,
    /** degrees between the outermost beams */
    fan: 0,
    /** lights that could not turn far enough */
    unreachable: [] as string[],
  })

  /** The aim point still belongs to the selection, so the sliders apply to it. */
  const aimActive = computed(() => {
    if (!aim.anchor || aim.ids.length === 0 || aim.ids.length !== selectedIds.value.length) return false
    return aim.ids.every((id) => selectedIds.value.includes(id))
  })

  function startAim() {
    if (selectedIds.value.length === 0) return
    pickerOpen.value = false
    interaction.start({ kind: 'aim' })
  }

  function toggleAim() {
    if (interaction.is('aim')) interaction.cancel()
    else startAim()
  }

  /** The point was clicked: aim the selection at it. */
  function aimAt(point: [number, number, number]) {
    interaction.cancel('aim')
    aim.anchor = point
    aim.ids = [...selectedIds.value]
    reaim()
  }

  function setAimSpread(value: number) {
    aim.spread = value
    if (aimActive.value) reaim()
  }

  function setAimFan(value: number) {
    aim.fan = value
    if (aimActive.value) reaim()
  }

  /** Points the aimed lights at the aim point (again), with the current spread and fan, as one undo step (repeated slider changes merge). */
  function reaim() {
    const point = aim.anchor
    const lights = aim.ids.map((id) => fixtures.value.find((f) => f.id === id)).filter((f): f is Fixture => !!f)
    const result = point && viewer.api?.aim(lights, point, { spread: aim.spread, fan: aim.fan })
    if (!result) return
    const { patches, unreachable } = result
    touch('Aim', 'aim', [...patches.keys()])
    for (const [id, patch] of patches) {
      const fixture = list().find((f) => f.id === id)
      if (!fixture) continue
      if (patch.values) {
        fixture.values.pan = patch.values.pan
        fixture.values.tilt = patch.values.tilt
      }
      if (patch.rotation) fixture.rotation = [...patch.rotation]
    }
    aim.unreachable = [...unreachable]
    schedulePersist()
  }

  // --- selection -----------------------------------------------------------

  /** Selects just this fixture (or nothing). */
  function select(id: string | null) {
    selectedIds.value = id ? [id] : []
  }

  function selectMany(ids: readonly string[]) {
    const known = new Set(fixtures.value.map((f) => f.id))
    selectedIds.value = [...new Set(ids)].filter((id) => known.has(id))
  }

  /** Adds the fixture to the selection, or takes it out if it is already in. */
  function toggle(id: string) {
    selectedIds.value = selectedIds.value.includes(id) ? selectedIds.value.filter((x) => x !== id) : [...selectedIds.value, id]
  }

  function isSelected(id: string) {
    return selectedIds.value.includes(id)
  }

  /** The "Place light" button: opens the picker, or cancels a placement that is waiting for a click. */
  function togglePlacing() {
    if (interaction.is('place')) interaction.cancel()
    else pickerOpen.value = true
  }

  /** The picker's choice: the next click on a surface in the venue places this fixture. */
  function startPlacing(profileId: string, mode?: string) {
    pickerOpen.value = false
    interaction.start({ kind: 'place', choice: { profileId, ...(mode ? { mode } : {}) } })
  }

  /** The surface was clicked while placing: adds the chosen fixture there, mounted as the surface says. */
  function placeAt(pose: Pick<Fixture, 'position' | 'mount' | 'rotation'>) {
    const placing = interaction.mode
    if (placing?.kind !== 'place') return
    interaction.cancel()
    add({ ...pose, ...placing.choice })
  }

  return {
    importLights,
    forgetHistory,
    aim,
    aimActive,
    startAim,
    toggleAim,
    aimAt,
    setAimSpread,
    setAimFan,
    groups,
    activeGroup,
    groupMembers,
    createGroup,
    renameGroup,
    deleteGroup,
    setGroupMembers,
    addToGroup,
    removeFromGroup,
    moveInGroup,
    selectGroup,
    undo,
    redo,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
    historyVersion,
    fixtures,
    selected,
    selection,
    selectedId,
    selectedIds,
    select,
    selectMany,
    toggle,
    isSelected,
    removeMany,
    duplicateMany,
    updateMany,
    setValueMany,
    setValuesMany,
    pickerOpen,
    startPlacing,
    placeAt,
    gizmoMode,
    rotationReadout,
    add,
    update,
    setValue,
    setValues,
    remove,
    duplicate,
    togglePlacing,
  }
})
