<script setup lang="ts">
import { computed } from 'vue'
import { profileFor } from '../fixtures/profiles'
import { useCrowd } from '../stores/crowd'
import { useRig } from '../stores/rig'
import ToastMessage from './ToastMessage.vue'

const rig = useRig()
const crowd = useCrowd()

/** The key that adds to a selection by clicking (on a Mac Ctrl-click is a right click). */
const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'
const none = computed(() => rig.selectedIds.length === 0)
const what = computed(() => (rig.selectedIds.length > 1 ? 'the selection' : 'the light'))

/** What the next click in the view does, while it does something other than select. */
const hint = computed(() => {
  if (rig.aim.armed) return 'Click a surface to aim the selected lights at it.'
  if (rig.placing) return `Click a ceiling, truss or floor to place the ${rig.pending ? profileFor(rig.pending.profileId).name : 'light'}.`
  if (crowd.drawing && !crowd.drawing.first) return 'Click the first corner of the zone on the floor.'
  if (crowd.drawing) return 'Click the opposite corner of the zone.'
  if (crowd.facingFor) return 'Click the point the people in this zone should face.'
  return ''
})

function cancel() {
  if (rig.aim.armed) rig.cancelAim()
  else if (rig.placing) rig.togglePlacing()
  else crowd.cancelPicking()
}
</script>

<template>
  <!-- Editing tools at the bottom middle of the view, always in the same place whatever panel is open,
       with what the next click does and the latest message stacked above them. -->
  <div class="stack">
    <ToastMessage />
    <div v-if="hint" class="hint" role="status" @pointerdown.stop>
      {{ hint }}
      <button @click="cancel">Cancel <kbd>Esc</kbd></button>
    </div>
    <div class="editbar" @pointerdown.stop>
      <div class="group">
        <button :disabled="!rig.canUndo" :title="rig.canUndo ? `Undo: ${rig.undoLabel} (${mod}Z)` : 'Nothing to undo'" aria-label="Undo" @click="rig.undo()">
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
          </svg>
        </button>
        <button
          :disabled="!rig.canRedo"
          :title="rig.canRedo ? `Redo: ${rig.redoLabel} (Shift+${mod}Z)` : 'Nothing to redo'"
          aria-label="Redo"
          @click="rig.redo()"
        >
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m15 14 5-5-5-5" />
            <path d="M20 9H10a6 6 0 0 0 0 12h3" />
          </svg>
        </button>
      </div>
      <div class="group tools" role="group" aria-label="Tool for the selected lights">
        <button
          :class="{ on: !none && rig.gizmoMode === 'move' && !rig.aim.armed }"
          :disabled="none"
          :title="none ? 'Select a light first' : `Move ${what} (G)`"
          @click="rig.gizmoMode = 'move'"
        >
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" />
          </svg>
          <span class="label">Move</span> <kbd>G</kbd>
        </button>
        <button
          :class="{ on: !none && rig.gizmoMode === 'rotate' && !rig.aim.armed }"
          :disabled="none"
          :title="none ? 'Select a light first' : `Rotate ${what} (R)`"
          @click="rig.gizmoMode = 'rotate'"
        >
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M20 12a8 8 0 1 1-2.3-5.6" />
            <path d="M20 4v5h-5" />
          </svg>
          <span class="label">Rotate</span> <kbd>R</kbd>
        </button>
        <button
          :class="{ on: rig.aim.armed }"
          :disabled="none"
          :title="none ? 'Select a light first' : `Aim ${what} at a point: click a surface (T)`"
          @click="rig.toggleAim()"
        >
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="8" />
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v4M12 19v4M1 12h4M19 12h4" />
          </svg>
          <span class="label">Aim</span> <kbd>T</kbd>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stack {
  position: absolute;
  bottom: 14px;
  left: 16px;
  right: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none; /* the gaps between the pieces let clicks through to the view */
}
.stack > * {
  pointer-events: auto;
}
.editbar {
  display: flex;
  gap: 6px;
  font: 13px var(--font-sans);
  color: var(--text);
}
.group {
  display: flex;
  background: var(--overlay);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  backdrop-filter: var(--frost);
}
.group button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  color: var(--text-soft);
  background: none;
  border: 0;
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.group button + button {
  border-left: 1px solid var(--border);
}
.group button:hover:not(:disabled) {
  color: var(--text-bright);
  background: var(--surface-2);
}
.group button.on {
  color: var(--text-bright);
  background: var(--selected);
  box-shadow: inset 0 -2px 0 var(--accent);
}
.group button:disabled {
  opacity: 0.35;
  cursor: default;
}
kbd {
  padding: 0 5px;
  border-radius: 3px;
  background: var(--surface-2);
  color: var(--text-muted);
  font: 11px var(--font-mono);
}
/* In a narrow view the tools keep only their icons (the title still names them). */
@container stage (max-width: 620px) {
  .tools .label,
  .tools kbd {
    display: none;
  }
}
.hint {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 100%;
  padding: 6px 6px 6px 12px;
  box-sizing: border-box;
  font: 13px var(--font-sans);
  color: var(--accent-text);
  background: var(--overlay);
  border: 1px solid var(--accent-strong);
  border-radius: 6px;
  backdrop-filter: var(--frost);
}
.hint button {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  color: var(--text);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  font: inherit;
  cursor: pointer;
}
.hint button:hover {
  background: var(--selected);
}
</style>
