<script setup lang="ts">
import { computed } from 'vue'
import type { Fixture } from '@preflight/shared'
import { profileFor } from '../fixtures/profiles'

/** A light in the lists: the outline of its body type (as drawn in the view), in its color, as bright as its dimmer. */
const props = defineProps<{ fixture: Fixture }>()

const profile = computed(() => profileFor(props.fixture.profileId))
const color = computed(() => {
  const v = props.fixture.values
  if (!profile.value.emitsLight) return 'var(--text-dim)'
  return `rgb(${Math.round((v.red ?? 1) * 255)}, ${Math.round((v.green ?? 1) * 255)}, ${Math.round((v.blue ?? 1) * 255)})`
})
const lit = computed(() => (profile.value.emitsLight ? 0.3 + 0.7 * (props.fixture.values.dimmer ?? 1) : 1))

/** One outline per body kind, in a 16 × 16 box. */
const PATHS: Record<string, string> = {
  'moving-head': 'M4 14h8M8 14v-2M4.5 4v6h7V4M5.5 9.5a2.5 2.5 0 1 0 5 0V5h-5z',
  scanner: 'M3 13h10M5 13V6h6v7M11 9.5l3 2',
  can: 'M5 3h6l1 9H4zM4 12h8M6 14h4',
  bar: 'M2 6h12v4H2zM4.5 8h.01M8 8h.01M11.5 8h.01',
  panel: 'M3 3h10v10H3zM6 6h.01M10 6h.01M6 10h.01M10 10h.01',
  box: 'M3 4h10v8H3z',
}
const path = computed(() => PATHS[profile.value.model.kind] ?? PATHS.box)
</script>

<template>
  <svg class="fixture-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" :style="{ color, opacity: lit }">
    <path :d="path" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
</template>

<style scoped>
.fixture-icon {
  flex: none;
  filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.6));
}
</style>
