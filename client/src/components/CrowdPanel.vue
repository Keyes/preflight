<script setup lang="ts">
import { useCrowd } from '../stores/crowd'

const crowd = useCrowd()
</script>

<template>
  <!-- Only shows or hides the crowd: where it stands, how dense and how it moves are in the Crowd section of the sidebar. -->
  <button
    class="icon"
    :class="{ off: !crowd.crowd.shown }"
    :aria-pressed="crowd.crowd.shown"
    :title="`${crowd.crowd.shown ? 'Hide' : 'Show'} the crowd (C)${crowd.people ? ` · ${crowd.people.toLocaleString()} people` : ''}`"
    :aria-label="crowd.crowd.shown ? 'Hide the crowd' : 'Show the crowd'"
    @click="crowd.setShown(!crowd.crowd.shown)"
  >
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="9" cy="7" r="3" />
      <path d="M3 20v-1.5A4.5 4.5 0 0 1 7.5 14h3A4.5 4.5 0 0 1 15 18.5V20" />
      <circle cx="17.5" cy="8.5" r="2.4" />
      <path d="M17 13.6a4 4 0 0 1 4 3.9V19" />
      <path v-if="!crowd.crowd.shown" d="M2 2l20 20" />
    </svg>
    <span v-if="crowd.crowd.shown && crowd.people" class="number">{{ crowd.people.toLocaleString() }}</span>
  </button>
</template>

<style scoped>
.icon {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 30px;
  height: 100%;
  padding: 0 7px;
  color: var(--text);
  background: var(--overlay);
  backdrop-filter: var(--frost);
  border: 1px solid var(--border);
  border-radius: 4px;
  font: 13px var(--font-sans);
  cursor: pointer;
}
.icon:hover {
  background: var(--selected);
}
.icon.off {
  color: var(--text-dim);
}
.number {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--accent-text);
}
</style>
