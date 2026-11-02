<script setup lang="ts">
import { computed } from 'vue'
import { useRig } from '../stores/rig'

const rig = useRig()
const readout = computed(() => rig.rotationReadout)

const AXIS_COLORS = { x: '#ff6b6b', y: '#5fe08b', z: '#6b8cff' }

/** Whole degrees while snapping (they are multiples of the step), one decimal otherwise. */
const text = computed(() => {
  const r = readout.value
  if (!r) return ''
  const value = r.snapping ? Math.round(r.degrees) : Math.round(r.degrees * 10) / 10
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  return `${sign}${Math.abs(value)}°`
})
</script>

<template>
  <div
    v-if="readout"
    class="readout"
    :style="{ left: `${readout.x + 18}px`, top: `${readout.y + 18}px` }"
    aria-live="off"
  >
    <span class="axis" :style="{ color: AXIS_COLORS[readout.axis] }">{{ readout.axis.toUpperCase() }}</span>
    <span class="value">{{ text }}</span>
    <span class="hint">{{ readout.snapping ? 'snapping 5°' : 'Shift to snap 5°' }}</span>
  </div>
</template>

<style scoped>
.readout {
  position: absolute;
  z-index: 5;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 9px;
  border-radius: 5px;
  background: var(--overlay);
  border: 1px solid var(--border);
  color: var(--text);
  font: 13px var(--font-sans);
  pointer-events: none;
  white-space: nowrap;
}
.axis {
  font-weight: 700;
}
.value {
  min-width: 52px;
  font: 600 16px var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.hint {
  color: var(--text-muted);
  font-size: 12px;
}
</style>
