<script setup lang="ts">
import { ref } from 'vue'
import type { FixtureGroup } from '../api'
import { useRig } from '../stores/rig'
import { useTransfer } from '../stores/transfer'
import { useVenues } from '../stores/venues'
import ContextMenu, { type MenuItem } from './ContextMenu.vue'
import FixtureIcon from './FixtureIcon.vue'
import InlineRename from './InlineRename.vue'
import SidebarSection from './SidebarSection.vue'

const store = useVenues()
const rig = useRig()
const transfer = useTransfer()

/** The key that adds to a selection by clicking (on a Mac Ctrl-click is a right click). */
const addKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
const open = ref<Record<string, boolean>>({})
const groupsTip = `Select lights, then “+ From selection” keeps them together as a named group, in the order you selected them. Click a group to select its lights (${addKey}-click adds it to the selection). The arrow shows the lights in it, where you can reorder them. Right-click a group to rename it, add or replace its lights, copy it to another venue or delete it.`
const renamingId = ref<string | null>(null)
const menu = ref<{ x: number; y: number; id: string } | null>(null)

function createFromSelection() {
  const group = rig.createGroup()
  if (!group) return
  open.value[group.id] = true
  renamingId.value = group.id // a group is named right away
}

function onGroupClick(event: MouseEvent, group: FixtureGroup) {
  rig.selectGroup(group.id, event.ctrlKey || event.metaKey || event.shiftKey)
}

function commitRename(id: string, value: string) {
  renamingId.value = null
  rig.renameGroup(id, value)
}

function openMenu(event: MouseEvent, id: string) {
  event.preventDefault()
  menu.value = { x: event.clientX, y: event.clientY, id }
}

function menuItems(id: string): MenuItem[] {
  const n = rig.selectedIds.length
  return [
    { label: 'Rename', action: () => (renamingId.value = id) },
    ...(n ? [{ label: `Set to the ${n} selected`, action: () => rig.setGroupMembers(id, rig.selectedIds, 'Set group to selection') }] : []),
    ...(n ? [{ label: `Add the ${n} selected`, action: () => rig.addToGroup(id, rig.selectedIds) }] : []),
    ...(store.venues.length > 1
      ? [
          {
            label: 'Copy to another venue…',
            action: () =>
              transfer.openCopy(
                rig.groupMembers(rig.groups.find((g) => g.id === id)!).map((f) => f.id),
                [id],
              ),
          },
        ]
      : []),
    { label: 'Delete group', danger: true, action: () => rig.deleteGroup(id) },
  ]
}
</script>

<template>
  <SidebarSection v-if="store.current?.status === 'ready'" id="groups" title="Groups" :tip="groupsTip" :count="rig.groups.length || undefined">
    <template #actions>
      <button
        class="link"
        :disabled="!rig.selectedIds.length"
        :title="rig.selectedIds.length ? 'Save the selected lights as a group' : 'Select some lights first'"
        @click="createFromSelection"
      >
        + From selection
      </button>
    </template>

    <ul v-if="rig.groups.length">
      <li v-for="group in rig.groups" :key="group.id">
        <div class="row" @contextmenu="openMenu($event, group.id)">
          <button
            class="chevron"
            :aria-label="open[group.id] ? 'Hide lights' : 'Show lights'"
            :aria-expanded="!!open[group.id]"
            @click="open[group.id] = !open[group.id]"
          >
            <svg
              viewBox="0 0 24 24"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              :style="{ transform: open[group.id] ? 'rotate(90deg)' : 'none' }"
            >
              <path d="m9 6 6 6-6 6" />
            </svg>
          </button>
          <InlineRename v-if="renamingId === group.id" :initial="group.name" @commit="commitRename(group.id, $event)" @cancel="renamingId = null" />
          <button v-else class="main" :class="{ active: rig.activeGroup?.id === group.id }" @click="onGroupClick($event, group)">
            <span class="name">{{ group.name }}</span>
            <span class="count">{{ rig.groupMembers(group).length }}</span>
          </button>
        </div>

        <div v-if="open[group.id]" class="members">
          <p v-if="!rig.groupMembers(group).length" class="hint">No lights left in this group.</p>
          <ol v-else>
            <li v-for="(light, i) in rig.groupMembers(group)" :key="light.id">
              <button class="light" :class="{ active: rig.isSelected(light.id) }" @click="rig.select(light.id)">
                <span class="index">{{ i + 1 }}</span>
                <FixtureIcon :fixture="light" />
                <span class="name">{{ light.name }}</span>
              </button>
              <span class="tools">
                <button :disabled="i === 0" title="Move earlier" aria-label="Move earlier" @click="rig.moveInGroup(group.id, light.id, -1)">↑</button>
                <button
                  :disabled="i === rig.groupMembers(group).length - 1"
                  title="Move later"
                  aria-label="Move later"
                  @click="rig.moveInGroup(group.id, light.id, 1)"
                >
                  ↓
                </button>
                <button title="Take out of the group" aria-label="Take out of the group" @click="rig.removeFromGroup(group.id, light.id)">×</button>
              </span>
            </li>
          </ol>
        </div>
      </li>
    </ul>

    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menuItems(menu.id)" @close="menu = null" />
  </SidebarSection>
</template>

<style scoped>
.link {
  background: none;
  border: 0;
  color: var(--accent);
  padding: 0;
  font: inherit;
  cursor: pointer;
}
.link:disabled {
  color: var(--text-disabled);
  cursor: default;
}
.hint {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
}
.hint.active {
  color: var(--accent-text);
}
ul,
ol {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row {
  display: flex;
  align-items: center;
  gap: 2px;
}
.chevron {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 28px;
  padding: 0;
  color: var(--text-muted);
  background: none;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}
.chevron:hover {
  color: var(--text-bright);
  background: var(--surface);
}
.chevron svg {
  transition: transform 0.12s;
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
  padding: 7px 10px;
  border-radius: 4px;
}
.main:hover {
  background: var(--surface);
}
.main.active {
  background: var(--selected);
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.count {
  flex: none;
  color: var(--text-muted);
  font-size: 12px;
}
.members {
  margin: 2px 0 6px 24px;
  padding-left: 8px;
  border-left: 1px solid var(--selected);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
ol > li {
  display: flex;
  align-items: center;
}
.light {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  padding: 5px 6px;
  border-radius: 4px;
}
.light:hover {
  background: var(--surface);
}
.light.active {
  background: var(--selected);
}
.index {
  flex: none;
  width: 14px;
  text-align: right;
  color: var(--text-dim);
  font-size: 11px;
}
.tools {
  flex: none;
  display: flex;
}
.tools button {
  width: 22px;
  height: 22px;
  padding: 0;
  color: var(--text-soft);
  background: none;
  border: 0;
  border-radius: 4px;
  font: inherit;
  cursor: pointer;
}
.tools button:hover:not(:disabled) {
  color: var(--text-bright);
  background: var(--selected);
}
.tools button:disabled {
  opacity: 0.25;
  cursor: default;
}
</style>
