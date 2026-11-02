<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { computed } from 'vue'
import { useCameraBridge } from '../stores/camera'
import {
  EXPOSURE_MAX,
  EXPOSURE_MIN,
  FOV_DEFAULT,
  FOV_MAX,
  FOV_MIN,
  RENDER_FRACTIONS,
  SURFACE_LIGHT_MAX,
  SURFACE_LIGHT_MIN,
  SCREENSHOT_SCALES,
  TONE_MAPPINGS,
  useSettings,
} from '../stores/settings'
import { MAX_SHADOW_LIGHTS } from '../scene/FixtureRig'
import { useLayout } from '../stores/layout'
import SidebarSection from './SidebarSection.vue'

const settings = useSettings()
const bridge = useCameraBridge()

const TONE_LABELS = { off: 'Off (clips)', neutral: 'Neutral (hue-true)', aces: 'ACES (filmic)' } as const

const surfaceLabel = computed(() => `${settings.surfaceLight > 0 ? '+' : ''}${settings.surfaceLight.toFixed(1)} EV`)
const FRACTION_TEXT: [number, string][] = [[1, '1/1'], [3 / 4, '3/4'], [2 / 3, '2/3'], [1 / 2, '1/2'], [1 / 3, '1/3'], [1 / 4, '1/4']]

/** A render size as a fraction of the display's native resolution, with its pixel size when known: "1/2 · 764 × 384 px". */
function sizeLabel(fraction: number) {
  const text = FRACTION_TEXT.find(([value]) => Math.abs(value - fraction) < 1e-6)?.[1] ?? fraction.toFixed(2)
  const native = bridge.api?.planShot(1)
  const pixels = native ? ` · ${Math.round(native.width * fraction)} × ${Math.round(native.height * fraction)} px` : ''
  return `${text}${fraction === 1 ? ' (native)' : ''}${pixels}`
}

const exposureLabel = computed(() => `${settings.exposure > 0 ? '+' : ''}${settings.exposure.toFixed(1)} EV`)

/** Pixel size label for a screenshot scale, e.g. "2× · 3056 × 3072 px". */
function shotLabel(scale: number) {
  const size = bridge.api?.planShot(scale)
  return size ? `${scale}× · ${size.width} × ${size.height} px` : `${scale}×`
}
const layout = useLayout()
const open = computed(() => layout.popover === 'settings')
const root = ref<HTMLElement>()

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
  <div ref="root" class="settings">
    <button class="gear" :class="{ active: open }" title="Settings" aria-label="Settings" @click="layout.togglePopover('settings')">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </svg>
    </button>

    <div v-if="open" class="panel" role="dialog" aria-label="Settings">
      <p class="scope-note">Kept in this browser, except values marked <span class="scope">venue</span>, which are saved with the venue.</p>

      <SidebarSection id="settings.camera" title="Camera" tip="Vertical angle. Wider shows more of the room; narrower looks more like a long lens.">
        <label class="row">
          <span class="label">
            Field of view
            <output>{{ Math.round(settings.fov) }}°</output>
          </span>
          <input
            v-model.number="settings.fov"
            type="range"
            :min="FOV_MIN"
            :max="FOV_MAX"
            step="1"
          />
        </label>
        <button class="reset" :disabled="settings.fov === FOV_DEFAULT" @click="settings.resetFov()">
          Reset to {{ FOV_DEFAULT }}°
        </button>
      </SidebarSection>

      <SidebarSection id="settings.atmosphere" title="Atmosphere" tip="Haze makes beams visible in the air, and wisps make it drift and vary like real haze (0 is an even haze). Room light is a stand-in for house lights.">
        <label class="row">
          <span class="label"><span>Haze <span class="scope">venue</span></span><output>{{ Math.round(settings.haze * 100) }}%</output></span>
          <input v-model.number="settings.haze" type="range" min="0" max="1" step="0.01" />
        </label>
        <label class="row">
          <span class="label">Haze wisps <output>{{ Math.round(settings.hazeWisps * 100) }}%</output></span>
          <input v-model.number="settings.hazeWisps" type="range" min="0" max="1" step="0.01" />
        </label>
        <label class="row">
          <span class="label"><span>Room light <span class="scope">venue</span></span><output>{{ Math.round(settings.ambient * 100) }}%</output></span>
          <input v-model.number="settings.ambient" type="range" min="0" max="1" step="0.01" />
        </label>
      </SidebarSection>

      <SidebarSection id="settings.look" title="Look" tip="Surface light sets how strongly lights illuminate surfaces, separately from the beams, which helps with dark materials. Tone mapping keeps bright overlapping beams from clipping to white. Neutral keeps colors true; ACES is the filmic curve.">
        <label class="row">
          <span class="label">Surface light <output>{{ surfaceLabel }}</output></span>
          <input v-model.number="settings.surfaceLight" type="range" :min="SURFACE_LIGHT_MIN" :max="SURFACE_LIGHT_MAX" step="0.1" />
        </label>
        <label class="row">
          <span class="label">Tone mapping</span>
          <select v-model="settings.toneMapping">
            <option v-for="mode in TONE_MAPPINGS" :key="mode" :value="mode">{{ TONE_LABELS[mode] }}</option>
          </select>
        </label>
        <label class="row">
          <span class="label">Exposure <output>{{ exposureLabel }}</output></span>
          <input v-model.number="settings.exposure" type="range" :min="EXPOSURE_MIN" :max="EXPOSURE_MAX" step="0.1" />
        </label>
        <label class="row">
          <span class="label">Bloom <output>{{ Math.round(settings.bloom * 100) }}%</output></span>
          <input v-model.number="settings.bloom" type="range" min="0" max="1" step="0.01" />
        </label>
      </SidebarSection>

      <SidebarSection id="settings.quality" title="Quality" :tip="`Shadows are limited to ${MAX_SHADOW_LIGHTS} lights at once (choose which in a light's panel), and the others stay unshadowed. Sizes are fractions of the width and height of your display's native resolution, so 1/2 renders a quarter of the pixels. Moving the view or a light lowers the size only as far as needed to stay near 30 fps, down to the lowest size chosen.`">
        <label class="row">
          <span class="label">Size when still</span>
          <select v-model.number="settings.renderRest">
            <option v-for="fraction in RENDER_FRACTIONS" :key="fraction" :value="fraction">{{ sizeLabel(fraction) }}</option>
          </select>
        </label>
        <label class="check">
          <input v-model="settings.adaptive" type="checkbox" />
          <span>Lower resolution while moving, if needed</span>
        </label>
        <label v-if="settings.adaptive" class="row">
          <span class="label">Lowest size while moving</span>
          <select v-model.number="settings.renderMoving">
            <option v-for="fraction in RENDER_FRACTIONS" :key="fraction" :value="fraction" :disabled="fraction > settings.renderRest + 1e-9">
              {{ sizeLabel(fraction) }}
            </option>
          </select>
        </label>
        <label class="check">
          <input v-model="settings.shadows" type="checkbox" />
          <span>Shadows</span>
        </label>
        <label class="check">
          <input v-model="settings.softBeams" type="checkbox" />
          <span>Soft beam edges at surfaces</span>
        </label>
      </SidebarSection>

      <SidebarSection id="settings.prefs" title="Preferences" tip="A screenshot is one frame of the live view rendered at its own size, always 16:9: the middle part of what you see (a wide window loses its sides, a narrow one its top and bottom).">
        <label class="check" title="Stops haze drift, gobo spin, strobe flashes and the crowd, for a still picture and less work (P)">
          <input v-model="settings.animate" type="checkbox" />
          <span>Animations <kbd>P</kbd></span>
        </label>
        <label class="check" title="Flashing light can trigger seizures in people who are photosensitive">
          <input v-model="settings.previewStrobe" type="checkbox" />
          <span>Flash strobing lights</span>
        </label>
        <label class="check">
          <input v-model="settings.showFps" type="checkbox" />
          <span>Show frame rate</span>
        </label>
        <label class="row">
          <span class="label">Screenshot size</span>
          <select v-model.number="settings.screenshotScale">
            <option v-for="scale in SCREENSHOT_SCALES" :key="scale" :value="scale">{{ shotLabel(scale) }}</option>
          </select>
        </label>
      </SidebarSection>
    </div>
  </div>
</template>

<style scoped>
.settings {
  position: relative;
  font: 13px var(--font-sans);
  color: var(--text);
}
.gear {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 100%;
  padding: 0;
  color: inherit;
  background: var(--overlay);
  backdrop-filter: var(--frost);
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
}
.gear:hover,
.gear.active {
  background: var(--selected);
}
.panel {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 240px;
  max-height: calc(100vh - 90px); /* taller than the window: scroll inside the panel */
  overflow-y: auto;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 12px;
  background: var(--glass);
  backdrop-filter: var(--frost);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow);
}
.row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.label {
  display: flex;
  justify-content: space-between;
}
output {
  font-variant-numeric: tabular-nums;
  color: var(--accent-text);
}
input[type='range'] {
  width: 100%;
  accent-color: var(--accent);
}
.panel :deep(.section) {
  font-size: 13px;
}
.scope-note {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}
.scope {
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 3px;
  background: var(--tint-line);
  color: var(--tint-text-bright);
  font-size: 10px;
  letter-spacing: 0.04em;
  vertical-align: 1px;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
}
.check input {
  accent-color: var(--accent);
  margin: 0;
}
select {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: inherit;
  font: inherit;
  padding: 4px 6px;
}
kbd {
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 3px;
  background: var(--surface-2);
  color: var(--text-muted);
  font: 11px var(--font-mono);
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}
.reset {
  align-self: flex-start;
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
}
.reset:disabled {
  color: var(--text-disabled);
  cursor: default;
}
</style>
