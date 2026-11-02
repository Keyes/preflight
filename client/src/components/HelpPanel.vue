<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useLayout } from '../stores/layout'

const layout = useLayout()
const open = computed(() => layout.popover === 'help')
const root = ref<HTMLElement>()

const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

/** Every shortcut, by what it is for. The README's controls table says the same in more words. */
const groups = [
  {
    title: 'Camera',
    keys: [
      ['W A S D', 'Move (or the arrow keys)'],
      ['Q / E', 'Down / up'],
      ['Shift', 'Move faster'],
      ['Drag', 'Look around'],
      ['1 – 9', 'Jump to a saved view'],
    ],
  },
  {
    title: 'Selecting',
    keys: [
      ['Click', 'Select a light'],
      [`${mod}-click`, 'Add to or take out of the selection'],
      ['Shift-click', 'Select a range in the list'],
      [`${mod} A`, 'Select all lights'],
      ['Esc', 'Cancel, or deselect'],
    ],
  },
  {
    title: 'Editing',
    keys: [
      ['G', 'Move gizmo'],
      ['R', 'Rotate gizmo (Shift snaps to 5°)'],
      ['T', 'Aim: then click a surface'],
      ['Delete', 'Delete the selected lights'],
      [`${mod} Z`, 'Undo'],
      [`Shift ${mod} Z`, 'Redo'],
    ],
  },
  {
    title: 'View',
    keys: [
      ['C', 'Show or hide the crowd'],
      ['P', 'Pause or resume animations'],
      ['?', 'This list'],
    ],
  },
]

function onPointerDown(event: PointerEvent) {
  if (open.value && root.value && !root.value.contains(event.target as Node)) layout.popover = null
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) layout.popover = null
}
onMounted(() => {
  window.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onPointerDown)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="root" class="help">
    <button class="icon" :class="{ active: open }" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" @click="layout.togglePopover('help')">?</button>
    <div v-if="open" class="panel" role="dialog" aria-label="Keyboard shortcuts">
      <section v-for="g in groups" :key="g.title">
        <h2>{{ g.title }}</h2>
        <dl>
          <template v-for="[key, what] in g.keys" :key="key">
            <dt><kbd>{{ key }}</kbd></dt>
            <dd>{{ what }}</dd>
          </template>
        </dl>
      </section>
    </div>
  </div>
</template>

<style scoped>
.help {
  position: relative;
  font: 13px var(--font-sans);
  color: var(--text);
}
.icon {
  width: 30px;
  height: 100%;
  padding: 0;
  color: inherit;
  background: var(--overlay);
  backdrop-filter: var(--frost);
  border: 1px solid var(--border);
  border-radius: 4px;
  font: 600 14px var(--font-sans);
  cursor: pointer;
}
.icon:hover,
.icon.active {
  background: var(--selected);
}
.panel {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 290px;
  max-height: calc(100vh - 90px);
  overflow-y: auto;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 12px 14px;
  background: var(--glass);
  backdrop-filter: var(--frost);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow);
}
h2 {
  margin: 0 0 6px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  font-weight: 600;
}
dl {
  display: grid;
  grid-template-columns: 96px 1fr; /* the same in every group, so the descriptions line up */
  gap: 5px 12px;
  margin: 0;
}
dt {
  white-space: nowrap;
}
dd {
  margin: 0;
  color: var(--text-2);
}
kbd {
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text);
  font: 11px var(--font-mono);
}
</style>
