<script setup lang="ts">
import { computed } from 'vue'
import { useSettings } from '../stores/settings'
import { useStats } from '../stores/stats'

const settings = useSettings()
const stats = useStats()

/** "58 fps", plus the render size when it is below the display's native resolution. */
const detail = computed(() => {
  const native = Math.max(1, window.devicePixelRatio || 1)
  return stats.renderScale < native - 0.01 ? ` · ${stats.width}×${stats.height}` : ''
})
</script>

<template>
  <div v-if="settings.showFps && stats.fps > 0" class="fps" title="Frames per second (updated every second)">
    {{ stats.fps }} fps<span class="detail">{{ detail }}</span>
  </div>
</template>

<style scoped>
.fps {
  position: absolute;
  right: 16px;
  bottom: 12px;
  font: 12px var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: rgba(216, 216, 224, 0.6);
  pointer-events: none;
}
.detail {
  color: rgba(216, 216, 224, 0.4);
}
</style>
