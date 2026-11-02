<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import * as api from '../api'
import { useCrowd } from '../stores/crowd'
import { useRig } from '../stores/rig'
import InfoTip from './InfoTip.vue'
import { planTransfer, useTransfer } from '../stores/transfer'
import { useVenues } from '../stores/venues'

const MAX_LIGHTS = 500 // the most a venue can hold (the server's limit)
const MAX_ZONES = 50

const transfer = useTransfer()
const venues = useVenues()
const rig = useRig()
const crowd = useCrowd()

const root = ref<HTMLElement>()
const busy = ref(false)
const error = ref<string | null>(null)
const done = ref<{ text: string; venueId: string } | null>(null)

const copying = computed(() => transfer.mode === 'copy')
/** The venue on the other end: where the lights go in 'copy' mode, where they come from in 'import' mode. */
const otherId = ref<string | null>(null)
const others = computed(() => venues.venues.filter((v) => v.id !== venues.currentId))
const other = computed(() => venues.venues.find((v) => v.id === otherId.value))
const source = computed(() => (copying.value ? venues.current : other.value))
const destination = computed(() => (copying.value ? other.value : venues.current))

const sourceFixtures = computed(() => source.value?.fixtures ?? [])
const sourceGroups = computed(() => source.value?.groups ?? [])
const pickedFixtures = ref(new Set<string>())
const sourceZones = computed(() => source.value?.crowd?.zones ?? [])
const pickedGroups = ref(new Set<string>())
const pickedZones = ref(new Set<string>())
/** Meters added to every position, for venues that are drawn at different origins. */
const offset = ref<[number, number, number]>([0, 0, 0])
const moved = computed(() => offset.value.some((n) => n !== 0))
function setOffset(axis: number, event: Event) {
  const n = Number((event.target as HTMLInputElement).value)
  const next: [number, number, number] = [...offset.value]
  next[axis] = Number.isFinite(n) ? n : 0
  offset.value = next
}

const membersOf = (group: { fixtureIds: string[] }) => group.fixtureIds.filter((id) => sourceFixtures.value.some((f) => f.id === id))

function reset() {
  offset.value = [0, 0, 0]
  error.value = null
  done.value = null
  if (copying.value) {
    pickedFixtures.value = new Set(transfer.preFixtureIds)
    pickedGroups.value = new Set(transfer.preGroupIds)
    pickedZones.value = new Set(transfer.preZoneIds)
    // a group whose lights are all in the selection comes along as a group
    for (const g of sourceGroups.value) {
      const members = membersOf(g)
      if (members.length && members.every((id) => pickedFixtures.value.has(id))) pickedGroups.value.add(g.id)
    }
  } else {
    pickedFixtures.value = new Set()
    pickedGroups.value = new Set()
    pickedZones.value = new Set()
  }
}

onMounted(() => {
  otherId.value = (copying.value ? others.value[0]?.id : transfer.sourceId) ?? others.value[0]?.id ?? null
  reset()
  root.value?.focus()
})
// choosing another venue in 'import' mode shows that venue's lights, so the ticks start over
watch(otherId, () => {
  if (!copying.value) reset()
})

function toggleZone(id: string) {
  const next = new Set(pickedZones.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  pickedZones.value = next
}

function toggleFixture(id: string) {
  const next = new Set(pickedFixtures.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  pickedFixtures.value = next
}

/** A group's box ticks the group and all its lights, and clears the group and all its lights. */
function toggleGroup(id: string) {
  const group = sourceGroups.value.find((g) => g.id === id)
  if (!group) return
  const groups = new Set(pickedGroups.value)
  const lights = new Set(pickedFixtures.value)
  if (groups.has(id)) {
    groups.delete(id)
    for (const m of membersOf(group)) lights.delete(m)
  } else {
    groups.add(id)
    for (const m of membersOf(group)) lights.add(m)
  }
  pickedGroups.value = groups
  pickedFixtures.value = lights
}

function selectAll(on: boolean) {
  pickedFixtures.value = new Set(on ? sourceFixtures.value.map((f) => f.id) : [])
  pickedGroups.value = new Set(on ? sourceGroups.value.map((g) => g.id) : [])
  pickedZones.value = new Set(on ? sourceZones.value.map((z) => z.id) : [])
}

/** Groups that will be made: ticked, and with at least one of their lights ticked. */
const groupCount = computed(() => sourceGroups.value.filter((g) => pickedGroups.value.has(g.id) && membersOf(g).some((id) => pickedFixtures.value.has(id))).length)
const lightCount = computed(() => pickedFixtures.value.size)
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const zoneCount = computed(() => sourceZones.value.filter((z) => pickedZones.value.has(z.id)).length)
const itemCount = computed(() => lightCount.value + zoneCount.value)
const summary = computed(() => {
  const parts = []
  if (lightCount.value) parts.push(plural(lightCount.value, 'light', 'lights'))
  if (groupCount.value) parts.push(plural(groupCount.value, 'group', 'groups'))
  if (zoneCount.value) parts.push(plural(zoneCount.value, 'zone', 'zones'))
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? 'nothing')
})

const dot = (f: { values: Record<string, number> }) => `rgb(${(f.values.red ?? 1) * 255}, ${(f.values.green ?? 1) * 255}, ${(f.values.blue ?? 1) * 255})`

async function run() {
  const from = source.value
  const to = destination.value
  if (!from || !to || itemCount.value === 0 || busy.value) return
  const plan = planTransfer(from, pickedFixtures.value, pickedGroups.value, { fixtures: to.fixtures ?? [], groups: to.groups ?? [], zones: to.crowd?.zones ?? [] }, pickedZones.value, offset.value)
  if ((to.fixtures?.length ?? 0) + plan.fixtures.length > MAX_LIGHTS) {
    error.value = `${to.name} can hold at most ${MAX_LIGHTS} lights.`
    return
  }
  if ((to.crowd?.zones.length ?? 0) + plan.zones.length > MAX_ZONES) {
    error.value = `${to.name} can hold at most ${MAX_ZONES} crowd zones.`
    return
  }
  error.value = null
  if (!copying.value) {
    // into the open venue: the same as placing lights by hand, so it can be undone
    rig.importLights(plan.fixtures, plan.groups)
    crowd.addZones(plan.zones)
    transfer.close()
    return
  }
  busy.value = true
  try {
    const saved = await api.appendToVenue(to.id, plan.fixtures, plan.groups, plan.zones)
    venues.upsert(saved)
    rig.forgetHistory(to.id)
    done.value = { text: `Copied ${summary.value} to ${to.name}.`, venueId: to.id }
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

function openDestination() {
  if (done.value) venues.select(done.value.venueId)
  transfer.close()
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') transfer.close()
}
</script>

<template>
  <div class="backdrop" @pointerdown.self="transfer.close()">
    <div ref="root" class="window" role="dialog" aria-modal="true" :aria-label="copying ? 'Copy to another venue' : 'Import from another venue'" tabindex="-1" @keydown.stop="onKeydown" @pointerdown.stop>
      <header>
        <h2>{{ copying ? 'Copy to another venue' : 'Import from another venue' }}</h2>
        <button class="close" title="Close (Esc)" aria-label="Close" @click="transfer.close()">×</button>
      </header>

      <div v-if="others.length === 0" class="body">
        <p class="empty">There is no other venue yet. Create one from the Venues window first.</p>
      </div>

      <div v-else-if="done" class="body">
        <p class="success">{{ done.text }}</p>
        <p class="note">{{ moved ? 'They were moved by the offset you gave.' : 'Lights and zones kept their coordinates. If the two venues are not drawn at the same origin, move them there (lights with the gizmo).' }}</p>
        <div class="buttons">
          <button class="primary" @click="openDestination">Open that venue</button>
          <button @click="transfer.close()">Done</button>
        </div>
      </div>

      <div v-else class="body">
        <label class="venue">
          <span>{{ copying ? 'Copy from' : 'Import from' }}</span>
          <strong v-if="copying">{{ venues.current?.name }}</strong>
          <select v-else v-model="otherId">
            <option v-for="v in others" :key="v.id" :value="v.id">{{ v.name }}</option>
          </select>
          <span>{{ copying ? 'to' : 'into' }}</span>
          <select v-if="copying" v-model="otherId">
            <option v-for="v in others" :key="v.id" :value="v.id">{{ v.name }}</option>
          </select>
          <strong v-else>{{ venues.current?.name }}</strong>
        </label>

        <p v-if="sourceFixtures.length === 0 && sourceZones.length === 0" class="empty">{{ source?.name }} has no lights or crowd zones to copy.</p>
        <template v-else>
          <div class="chosen">
            <span>{{ summary }} chosen</span>
            <button class="link" @click="selectAll(true)">All</button>
            <button class="link" @click="selectAll(false)">None</button>
          </div>

          <div class="lists">
            <section v-if="sourceGroups.length">
              <h3>Groups</h3>
              <ul>
                <li v-for="group in sourceGroups" :key="group.id">
                  <label>
                    <input type="checkbox" :checked="pickedGroups.has(group.id)" @change="toggleGroup(group.id)" />
                    <span class="name">{{ group.name }}</span>
                    <span class="count">{{ membersOf(group).length }}</span>
                  </label>
                </li>
              </ul>
            </section>
            <section v-if="sourceZones.length">
              <h3>Crowd zones</h3>
              <ul>
                <li v-for="zone in sourceZones" :key="zone.id">
                  <label>
                    <input type="checkbox" :checked="pickedZones.has(zone.id)" @change="toggleZone(zone.id)" />
                    <span class="name">{{ zone.name }}</span>
                  </label>
                </li>
              </ul>
            </section>
            <section v-if="sourceFixtures.length">
              <h3>Lights</h3>
              <ul>
                <li v-for="light in sourceFixtures" :key="light.id">
                  <label>
                    <input type="checkbox" :checked="pickedFixtures.has(light.id)" @change="toggleFixture(light.id)" />
                    <span class="dot" :style="{ background: dot(light) }" />
                    <span class="name">{{ light.name }}</span>
                  </label>
                </li>
              </ul>
            </section>
          </div>

          <div class="offset">
            <span>Move by</span>
            <label v-for="(axis, i) in ['X', 'Y', 'Z']" :key="axis">
              {{ axis }}
              <input type="number" step="0.1" :value="offset[i]" :aria-label="`Move by ${axis} in meters`" @change="setOffset(i, $event)" />
            </label>
            <span>m</span>
            <button v-if="moved" class="link" @click="offset = [0, 0, 0]">Reset</button>
          </div>
        </template>

        <p v-if="error" class="error">{{ error }}</p>
      </div>

      <footer v-if="others.length && !done">
        <InfoTip text="Lights and zones keep their coordinates unless you move them by an offset (for venues drawn at different origins), and a group comes along with the lights of it that you chose. Names that are taken get a number." label="About copying lights" />
        <button class="primary" :disabled="busy || itemCount === 0" @click="run">
          {{ busy ? 'Copying…' : copying ? `Copy ${summary}` : `Import ${summary}` }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--scrim);
  font: 14px/1.4 var(--font-sans);
  color: var(--text);
}
.window {
  display: flex;
  flex-direction: column;
  width: min(640px, 100%);
  max-height: min(640px, 100%);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  outline: none;
}
header,
footer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
}
header {
  border-bottom: 1px solid var(--border);
}
footer {
  border-top: 1px solid var(--border);
  justify-content: space-between;
}
h2 {
  margin: 0;
  margin-right: auto;
  font-size: 16px;
}
h3 {
  margin: 0 0 6px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  font-weight: 600;
}
.close {
  background: none;
  border: 0;
  color: var(--text-muted);
  font-size: 22px;
  line-height: 1;
  padding: 0 4px;
  cursor: pointer;
}
.close:hover {
  color: var(--text-bright);
}
.body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  overflow-y: auto;
  min-height: 0;
}
button {
  font: inherit;
  cursor: pointer;
}
button.primary {
  flex: none;
  color: var(--text-bright);
  background: var(--accent-strong);
  border: 0;
  border-radius: 4px;
  padding: 7px 14px;
}
button.primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.buttons {
  display: flex;
  gap: 8px;
}
.buttons button:not(.primary) {
  padding: 7px 14px;
  color: var(--text-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
}
.link {
  background: none;
  border: 0;
  color: var(--accent);
  padding: 0;
}
.venue {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.venue span {
  color: var(--text-muted);
}
select {
  padding: 5px 8px;
  color: inherit;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  font: inherit;
}
.offset {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-muted);
}
.offset label {
  display: flex;
  align-items: center;
  gap: 4px;
}
.offset input {
  width: 64px;
  padding: 4px 6px;
  color: inherit;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  font: inherit;
}
.chosen {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--accent-text);
}
.chosen span {
  margin-right: auto;
}
.lists {
  display: flex;
  gap: 24px;
  align-items: flex-start;
}
.lists section {
  flex: 1;
  min-width: 0;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
li label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
}
li label:hover {
  background: var(--surface-2);
}
input[type='checkbox'] {
  accent-color: var(--accent);
  margin: 0;
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.count {
  color: var(--text-muted);
  font-size: 12px;
}
.dot {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25);
}
.empty,
.note {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
}
.success {
  margin: 0;
  color: var(--ok);
}
.error {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}
</style>
