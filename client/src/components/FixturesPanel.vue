<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { Fixture } from '@preflight/shared'
import { profileFor } from '../fixtures/profiles'
import { keysFor, MOD } from '../input/keymap'
import { useInteraction } from '../stores/interaction'
import { useRider } from '../stores/rider'
import { useRig } from '../stores/rig'
import { useTransfer } from '../stores/transfer'
import { useVenues } from '../stores/venues'
import ContextMenu from './ContextMenu.vue'
import type { MenuItem } from './contextMenu'
import FixtureIcon from './FixtureIcon.vue'
import InlineRename from './InlineRename.vue'
import SidebarSection from './SidebarSection.vue'

const store = useVenues()
const rig = useRig()
const interaction = useInteraction()
const transfer = useTransfer()
const riderImport = useRider()

const menu = ref<{ x: number; y: number; id: string } | null>(null)
const renamingId = ref<string | null>(null)
const fixturesTip = `Click a light to select it. ${MOD}-click adds or removes one, Shift-click selects a range, ${keysFor('selectAll')} selects all and ${keysFor('escape')} clears. Right-click a light to rename, duplicate, copy it to another venue or delete it. “+ Place light” opens the fixture library, then you click a truss, ceiling or the floor.`

/** The fixture type, shown when hovering a row. */
function typeName(f: Fixture) {
  const profile = profileFor(f.profileId)
  return profile.manufacturer === 'Generic' ? profile.name : `${profile.manufacturer} ${profile.name}`
}

/** The ⋯ menu beside "+ Place light": the other ways lights come in. */
const moreMenu = ref<{ x: number; y: number } | null>(null)
const moreItems = computed<MenuItem[]>(() => [
  { label: 'Import tech rider…', action: () => void riderImport.show() },
  ...(store.venues.length > 1 ? [{ label: 'Import from another venue…', action: () => transfer.openImport() }] : []),
])
function openMore(event: MouseEvent) {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  moreMenu.value = { x: box.left, y: box.bottom + 4 }
}

/** The filter box shows once the list is longer than this. */
const FILTER_FROM = 8
const filter = ref('')
/** The lights the filter lets through, matched on the light's name and its fixture type. */
const shown = computed(() => {
  const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return rig.fixtures
  return rig.fixtures.filter((f) => {
    const profile = profileFor(f.profileId)
    const text = `${f.name} ${profile.manufacturer} ${profile.name}`.toLowerCase()
    return words.every((w) => text.includes(w))
  })
})

// A light selected in the 3D view scrolls into sight in the list.
const list = ref<HTMLElement>()
watch(
  () => rig.selectedIds.at(-1),
  async (id) => {
    if (!id) return
    await nextTick()
    list.value?.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
  },
)

function openMenu(event: MouseEvent, id: string) {
  event.preventDefault()
  if (!rig.isSelected(id)) rig.select(id) // right-clicking inside the selection acts on all of it
  menu.value = { x: event.clientX, y: event.clientY, id }
}

/** The menu entry that copies lights to another venue (left out while there is no other venue). */
function copyItems(ids: readonly string[], label: string): MenuItem[] {
  return store.venues.length > 1 ? [{ label, action: () => transfer.openCopy(ids) }] : []
}

function menuItems(id: string): MenuItem[] {
  if (rig.selectedIds.length > 1) {
    const n = rig.selectedIds.length
    return [
      { label: `Duplicate ${n} lights`, action: () => rig.duplicateMany(rig.selectedIds) },
      ...copyItems(rig.selectedIds, `Copy ${n} lights to another venue…`),
      { label: `Delete ${n} lights`, danger: true, action: deleteSelection },
    ]
  }
  return [
    { label: 'Rename', action: () => (renamingId.value = id) },
    { label: 'Duplicate', action: () => rig.duplicate(id) },
    ...copyItems([id], 'Copy to another venue…'),
    { label: 'Delete', danger: true, action: () => rig.remove(id) },
  ]
}

/** The row last clicked without Shift: where a Shift-click range starts. */
let anchorId: string | null = null

/** Click selects the light, Ctrl/Cmd-click adds or removes it, Shift-click selects everything from the last click. */
function onRowClick(event: MouseEvent, id: string) {
  if (event.shiftKey && anchorId) {
    const ids = shown.value.map((f) => f.id) // the range runs over the rows you see
    const a = ids.indexOf(anchorId)
    const b = ids.indexOf(id)
    if (a >= 0 && b >= 0) {
      rig.selectMany(ids.slice(Math.min(a, b), Math.max(a, b) + 1))
      return
    }
  }
  anchorId = id
  if (event.ctrlKey || event.metaKey) rig.toggle(id)
  else rig.select(id)
}

/** Deletes without asking: the toast that follows offers Undo. */
function deleteSelection() {
  rig.removeMany(rig.selectedIds)
}

function commitRename(id: string, value: string) {
  renamingId.value = null
  const name = value.trim()
  if (name) rig.update(id, { name })
}
</script>

<template>
  <SidebarSection v-if="store.current?.status === 'ready'" id="fixtures" title="Fixtures" :tip="fixturesTip">
    <template #actions>
      <button
        class="primary"
        :class="{ on: interaction.is('place') }"
        :title="interaction.is('place') ? `Stop placing (${keysFor('escape')})` : 'Pick a fixture, then click where it hangs'"
        @click="rig.togglePlacing()"
      >
        {{ interaction.is('place') ? 'Cancel' : '+ Place light' }}
      </button>
      <button class="more" title="More ways to add lights" aria-label="More ways to add lights" aria-haspopup="menu" @click="openMore">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
    </template>

    <p v-if="rig.error" class="error">{{ rig.error }}</p>

    <input
      v-if="rig.fixtures.length > FILTER_FROM"
      v-model="filter"
      class="filter"
      type="search"
      placeholder="Filter by name or type"
      aria-label="Filter lights"
      @keydown.esc.stop="filter = ''"
    />
    <p v-if="filter && !shown.length" class="hint">No light matches “{{ filter }}”.</p>

    <ul v-if="shown.length" ref="list" class="list">
      <li v-for="fixture in shown" :key="fixture.id" :data-id="fixture.id" @contextmenu="openMenu($event, fixture.id)">
        <InlineRename v-if="renamingId === fixture.id" :initial="fixture.name" @commit="commitRename(fixture.id, $event)" @cancel="renamingId = null" />
        <button v-else :class="{ active: rig.isSelected(fixture.id) }" :title="typeName(fixture)" @click="onRowClick($event, fixture.id)">
          <FixtureIcon :fixture="fixture" />
          <span class="name">{{ fixture.name }}</span>
          <span v-if="fixture.patch" class="address" :title="`DMX universe ${fixture.patch.universe}, address ${fixture.patch.address}`"
            >{{ fixture.patch.universe }}.{{ fixture.patch.address }}</span
          >
        </button>
      </li>
    </ul>

    <p v-if="!rig.fixtures.length" class="hint">
      No lights yet. “+ Place light” picks one from the fixture library; the ⋯ menu imports a tech rider or lights from another venue.
    </p>

    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menuItems(menu.id)" @close="menu = null" />
    <ContextMenu v-if="moreMenu" :x="moreMenu.x" :y="moreMenu.y" :items="moreItems" @close="moreMenu = null" />
  </SidebarSection>
</template>

<style scoped>
.primary {
  padding: 3px 9px;
  color: var(--text-bright);
  background: var(--accent-strong);
  border: 0;
  border-radius: 4px;
  font: 13px var(--font-sans);
  white-space: nowrap;
  cursor: pointer;
}
.primary:hover {
  background: var(--accent-strong-hover);
}
.primary.on {
  color: var(--text);
  background: var(--surface-2);
}
.more {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--text-soft);
  background: none;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}
.more:hover {
  color: var(--text-bright);
  background: var(--selected);
}
.filter {
  box-sizing: border-box;
  width: 100%;
  padding: 6px 9px;
  color: inherit;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  font: 13px var(--font-sans);
}
.filter:focus {
  outline: none;
  border-color: var(--accent);
}
/* A long rig scrolls inside the list, so the sections below stay in reach. */
.list {
  max-height: 40vh;
  overflow-y: auto;
  overscroll-behavior: contain;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
li > button {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
  padding: 8px 10px;
  border-radius: 4px;
}
li > button:hover {
  background: var(--surface);
}
li > button.active {
  background: var(--selected);
}
.address {
  flex: none;
  margin-left: auto;
  font: 11px var(--font-mono);
  color: var(--text-dim);
}
.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hint {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
}
.error {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}
</style>
