<script setup lang="ts">
import { computed, ref } from 'vue'
import { useCrowd } from '../stores/crowd'
import { useTransfer } from '../stores/transfer'
import { useVenues } from '../stores/venues'
import ContextMenu, { type MenuItem } from './ContextMenu.vue'
import InlineRename from './InlineRename.vue'
import SidebarSection from './SidebarSection.vue'

const store = useVenues()
const crowd = useCrowd()
const transfer = useTransfer()

const menu = ref<{ x: number; y: number; id: string } | null>(null)
const renamingId = ref<string | null>(null)

function openMenu(event: MouseEvent, id: string) {
  event.preventDefault()
  crowd.selectedId = id
  menu.value = { x: event.clientX, y: event.clientY, id }
}

function menuItems(id: string): MenuItem[] {
  const zone = crowd.zones.find((z) => z.id === id)
  return [
    { label: 'Rename', action: () => (renamingId.value = id) },
    { label: 'Face a point…', action: () => crowd.startFacing(id) },
    ...(zone?.facing ? [{ label: 'Face every direction', action: () => crowd.setFacing(id, null) }] : []),
    ...(store.venues.length > 1 ? [{ label: 'Copy to another venue…', action: () => transfer.openCopy([], [], [id]) }] : []),
    { label: 'Delete zone', danger: true, action: () => crowd.removeZone(id) },
  ]
}

function commitRename(id: string, value: string) {
  renamingId.value = null
  crowd.renameZone(id, value)
}

/** The total in the header: everyone drawn, "hidden" when the whole crowd is switched off, and the limit when it thins the crowd. */
const total = computed(() => {
  if (!crowd.zones.length) return ''
  if (!crowd.crowd.shown) return 'hidden'
  const n = crowd.people.toLocaleString()
  return crowd.requested > crowd.people ? `${n} (limit)` : `${n} ${crowd.people === 1 ? 'person' : 'people'}`
})
const totalTitle = computed(() =>
  crowd.requested > crowd.people
    ? `The zones ask for ${crowd.requested.toLocaleString()} people at this density; ${crowd.people.toLocaleString()} is the most that is drawn.`
    : 'People in all zones that show, at the current density',
)

const PRESETS = [0.1, 0.5, 1] as const
const MOTIONS = [
  { value: 'still', label: 'Still' },
  { value: 'sway', label: 'Sway' },
  { value: 'dance', label: 'Dance' },
] as const
const percent = computed(() => Math.round(crowd.crowd.density * 100))

const eye = 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'
</script>

<template>
  <SidebarSection
    v-if="store.current?.status === 'ready'"
    id="crowd"
    title="Crowd"
    tip="Draw an area where people stand: “+ Zone”, then click two opposite corners on the floor. Density and movement below apply to every zone and are saved with the venue; the crowd button at the top right (or C) shows or hides everyone. Right-click a zone to rename it, make its people face a point, or delete it."
  >
    <template #actions>
      <span v-if="total" class="total" :title="totalTitle">{{ total }}</span>
      <button class="link" :disabled="crowd.picking" @click="crowd.startDrawing()">+ Zone</button>
    </template>

    <p v-if="crowd.message && !crowd.picking" class="hint error">{{ crowd.message }}</p>
    <p v-if="!crowd.zones.length && !crowd.picking" class="hint">No zones yet. “+ Zone”, then click two corners on the floor.</p>

    <ul v-if="crowd.zones.length">
      <li v-for="zone in crowd.zones" :key="zone.id" @contextmenu="openMenu($event, zone.id)">
        <button class="eye" :class="{ off: !zone.shown }" :title="zone.shown ? 'Hide this zone' : 'Show this zone'" :aria-label="zone.shown ? 'Hide this zone' : 'Show this zone'" @click="crowd.toggleZone(zone.id)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path :d="eye" />
            <path v-if="!zone.shown" d="M3 3l18 18" />
          </svg>
        </button>
        <InlineRename v-if="renamingId === zone.id" :initial="zone.name" @commit="commitRename(zone.id, $event)" @cancel="renamingId = null" />
        <button v-else class="main" :class="{ active: crowd.selectedId === zone.id }" @click="crowd.selectedId = crowd.selectedId === zone.id ? null : zone.id">
          <span class="name">{{ zone.name }}</span>
          <span class="count">{{ zone.shown ? `≈ ${crowd.counts.get(zone.id) ?? 0}` : 'hidden' }}</span>
        </button>
      </li>
    </ul>

    <!-- Options for the whole crowd, next to the zones they apply to. -->
    <div v-if="crowd.zones.length" class="options">
      <label class="check">
        <input type="checkbox" :checked="crowd.crowd.shown" @change="crowd.setShown(($event.target as HTMLInputElement).checked)" />
        <span>Show the crowd <kbd>C</kbd></span>
      </label>
      <label class="row">
        <span class="label">Density <output>{{ percent }}%</output></span>
        <input type="range" min="0" max="1" step="0.01" :value="crowd.crowd.density" :disabled="!crowd.crowd.shown" :title="'100% is a packed standing crowd, about 4 people per square meter, up to 4,000 people in all'" @input="crowd.setDensity(Number(($event.target as HTMLInputElement).value))" />
      </label>
      <div class="segments" role="group" aria-label="Density presets">
        <button v-for="p in PRESETS" :key="p" :class="{ on: Math.abs(crowd.crowd.density - p) < 0.005 }" :disabled="!crowd.crowd.shown" @click="crowd.setDensity(p)">{{ Math.round(p * 100) }}%</button>
      </div>
      <span class="label">Movement</span>
      <div class="segments" role="group" aria-label="Movement" title="Sway leans people gently. Dance adds a bounce on every beat at 120 bpm. Pausing animations (P) freezes them too.">
        <button v-for="m in MOTIONS" :key="m.value" :class="{ on: crowd.crowd.motion === m.value }" :disabled="!crowd.crowd.shown" @click="crowd.setMotion(m.value)">{{ m.label }}</button>
      </div>
      <label v-if="crowd.crowd.motion !== 'still'" class="row">
        <span class="label">Intensity <output>{{ Math.round(crowd.crowd.intensity * 100) }}%</output></span>
        <input type="range" min="0" max="1" step="0.01" :value="crowd.crowd.intensity" :disabled="!crowd.crowd.shown" @input="crowd.setIntensity(Number(($event.target as HTMLInputElement).value))" />
      </label>
    </div>

    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menuItems(menu.id)" @close="menu = null" />
  </SidebarSection>
</template>

<style scoped>
.total {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--accent-text);
}
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
.hint.error {
  color: var(--danger);
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
li {
  display: flex;
  align-items: center;
  gap: 2px;
}
.eye {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 28px;
  padding: 0;
  color: var(--text-soft);
  background: none;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}
.eye:hover {
  color: var(--text-bright);
  background: var(--surface);
}
.eye.off {
  color: var(--text-disabled);
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
.options {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
  padding: 10px;
  font-size: 13px;
  background: var(--surface);
  border-radius: 6px;
}
.row {
  display: flex;
  flex-direction: column;
  gap: 5px;
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
  margin: 0;
  accent-color: var(--accent);
}
input:disabled {
  opacity: 0.45;
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
kbd {
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 3px;
  background: var(--surface-2);
  color: var(--text-muted);
  font: 11px var(--font-mono);
}
.segments {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 5px;
  overflow: hidden;
}
.segments button {
  flex: 1;
  background: var(--panel);
  border: 0;
  color: var(--text-soft);
  font: inherit;
  padding: 4px 6px;
  cursor: pointer;
}
.segments button + button {
  border-left: 1px solid var(--border);
}
.segments button:hover:not(:disabled) {
  background: var(--surface-2);
}
.segments button.on {
  background: var(--selected);
  color: var(--text);
}
.segments button:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
