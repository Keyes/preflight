<script setup lang="ts">
import { ref } from 'vue'
import { useCameraBridge } from '../stores/camera'
import { useSettings } from '../stores/settings'
import { useVenues } from '../stores/venues'

const bridge = useCameraBridge()
const settings = useSettings()
const venues = useVenues()

const busy = ref(false)
const message = ref<{ text: string; error?: boolean } | null>(null)
let clearTimer: ReturnType<typeof setTimeout> | undefined

function say(text: string, error = false) {
  message.value = { text, error }
  clearTimeout(clearTimer)
  clearTimer = setTimeout(() => (message.value = null), error ? 6000 : 3500)
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
const slug = (text: string) =>
  text
    .trim()
    .replace(/[^\w-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'preflight'

async function shoot() {
  if (busy.value || !bridge.api) return
  busy.value = true
  try {
    // Let the busy state paint before the GPU work blocks the main thread for a moment.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    const { blob, width, height } = await bridge.api.screenshot(settings.screenshotScale)
    downloadBlob(blob, `${slug(venues.current?.name ?? '')}-${stamp()}.png`)
    say(`Saved ${width} × ${height} px`)
  } catch (e) {
    say(`Screenshot failed: ${(e as Error).message}`, true)
  } finally {
    busy.value = false
  }
}

/** Saves the picture as a file, the way a browser downloads a link. */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Give the browser a moment to start the download before releasing the data.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
</script>

<template>
  <div class="shot">
    <button class="icon" :disabled="busy" title="Save screenshot" aria-label="Save screenshot" @click="shoot">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
        <circle cx="12" cy="13" r="4" />
      </svg>
    </button>
    <div v-if="busy || message" class="note" :class="{ error: message?.error }">
      {{ busy ? 'Rendering…' : message?.text }}
    </div>
  </div>
</template>

<style scoped>
.shot {
  position: relative;
  font: 13px var(--font-sans);
}
.icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 100%;
  padding: 0;
  color: var(--text);
  background: var(--overlay);
  backdrop-filter: var(--frost);
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
}
.icon:hover:not(:disabled) {
  background: var(--selected);
}
.icon:disabled {
  opacity: 0.5;
  cursor: default;
}
.note {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  white-space: nowrap;
  padding: 5px 9px;
  border-radius: 4px;
  background: rgba(26, 26, 36, 0.95);
  border: 1px solid var(--border);
  color: var(--text);
}
.note.error {
  color: var(--danger);
}
</style>
