<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CatalogFixture } from '../api'
import { COLOR_FEATURES, profileFromCatalog } from '../fixtures/profiles'
import { useCatalog } from '../stores/catalog'
import { useRig } from '../stores/rig'

const catalog = useCatalog()
const rig = useRig()

const STORAGE_KEY = 'preflight.lastFixture'

const root = ref<HTMLElement>()
const searchBox = ref<HTMLInputElement>()
const listEl = ref<HTMLElement>()

const query = ref('')
const categories = ref<string[]>([])
const manufacturer = ref('')
const required = ref<string[]>([])
const selectedId = ref<string | null>(null)
const modeName = ref('')

/** Case- and accent-insensitive text for matching. */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

interface Entry {
  item: CatalogFixture
  name: string
  maker: string
  hay: string
}

const entries = computed<Entry[]>(() =>
  catalog.all.map((item) => ({
    item,
    name: fold(item.name),
    maker: fold(item.manufacturer),
    hay: fold(`${item.manufacturer} ${item.name} ${item.categories.join(' ')}`),
  })),
)

const FEATURES: { key: string; label: string; test: (f: CatalogFixture) => boolean }[] = [
  { key: 'pantilt', label: 'Pan / tilt', test: (f) => f.features.includes('pan') && f.features.includes('tilt') },
  { key: 'zoom', label: 'Zoom', test: (f) => f.features.includes('zoom') || (!!f.beamAngle && f.beamAngle[0] !== f.beamAngle[1]) },
  { key: 'focus', label: 'Focus', test: (f) => f.features.includes('focus') },
  { key: 'color', label: 'Color', test: (f) => f.features.some((x) => COLOR_FEATURES.has(x)) },
  { key: 'gobo', label: 'Gobo', test: (f) => f.features.includes('gobo') },
  { key: 'prism', label: 'Prism', test: (f) => f.features.includes('prism') },
  { key: 'strobe', label: 'Strobe', test: (f) => f.features.includes('strobe') },
  { key: 'frost', label: 'Frost', test: (f) => f.features.includes('frost') },
  { key: 'iris', label: 'Iris', test: (f) => f.features.includes('iris') },
]

const categoryCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const { item } of entries.value) for (const c of item.categories) counts.set(c, (counts.get(c) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
})

const manufacturerCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const { item } of entries.value) counts.set(item.manufacturer, (counts.get(item.manufacturer) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
})

const results = computed<CatalogFixture[]>(() => {
  const tokens = fold(query.value)
    .split(/[\s/_-]+/)
    .filter(Boolean)
  const tests = required.value.map((key) => FEATURES.find((f) => f.key === key)!.test)
  const scored: { item: CatalogFixture; score: number }[] = []
  for (const entry of entries.value) {
    const { item } = entry
    if (manufacturer.value && item.manufacturer !== manufacturer.value) continue
    if (categories.value.length && !item.categories.some((c) => categories.value.includes(c))) continue
    if (!tests.every((test) => test(item))) continue
    let score = 0
    let ok = true
    for (const token of tokens) {
      if (entry.name.startsWith(token) || entry.name.includes(` ${token}`)) score += 3
      else if (entry.name.includes(token)) score += 2
      else if (entry.maker.includes(token)) score += 1.5
      else if (entry.hay.includes(token)) score += 1
      else {
        ok = false
        break
      }
    }
    if (ok) scored.push({ item, score })
  }
  const byName = (a: CatalogFixture, b: CatalogFixture) =>
    a.manufacturer.localeCompare(b.manufacturer) || a.name.localeCompare(b.name, undefined, { numeric: true })
  scored.sort(
    (a, b) =>
      (tokens.length ? b.score - a.score : 0) ||
      (a.item.id === 'generic-moving-head' ? -1 : b.item.id === 'generic-moving-head' ? 1 : 0) ||
      byName(a.item, b.item),
  )
  return scored.map((s) => s.item)
})

const selected = computed(() => entries.value.find((e) => e.item.id === selectedId.value)?.item ?? null)
const profile = computed(() => (selected.value ? profileFromCatalog(selected.value) : null))
const filtering = computed(() => !!query.value || categories.value.length > 0 || !!manufacturer.value || required.value.length > 0)

function toggle(list: string[], value: string) {
  const i = list.indexOf(value)
  if (i >= 0) list.splice(i, 1)
  else list.push(value)
}

function clearFilters() {
  query.value = ''
  categories.value = []
  manufacturer.value = ''
  required.value = []
}

function select(id: string, scroll = false) {
  selectedId.value = id
  if (scroll) void nextTick(() => listEl.value?.querySelector('.on')?.scrollIntoView({ block: 'nearest' }))
}

// Keep a valid selection as the filters change, and a valid mode as the selection changes.
watch(results, (list) => {
  if (!list.some((f) => f.id === selectedId.value)) selectedId.value = list[0]?.id ?? null
  void nextTick(() => listEl.value?.scrollTo({ top: 0 }))
})
watch(selected, (item) => {
  if (!item) return
  if (!item.modes.some((m) => m.name === modeName.value)) modeName.value = item.modes[0]?.name ?? ''
})

function place() {
  const item = selected.value
  if (!item) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: item.id, mode: modeName.value }))
  } catch {
    /* storage unavailable: the last choice just is not remembered */
  }
  rig.startPlacing(item.id, item.modes.length ? modeName.value : undefined)
}

/** A double click in the list: choose that fixture and start placing it. */
function placeItem(id: string) {
  select(id)
  place()
}

function close() {
  rig.pickerOpen = false
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const list = results.value
    if (!list.length) return
    const i = list.findIndex((f) => f.id === selectedId.value)
    const next = Math.min(list.length - 1, Math.max(0, i + (event.key === 'ArrowDown' ? 1 : -1)))
    select(list[next].id, true)
  } else if (event.key === 'Enter' && (event.target as HTMLElement).tagName !== 'BUTTON' && (event.target as HTMLElement).tagName !== 'SELECT') {
    event.preventDefault()
    place()
  }
}

/** Keys pressed while focus is outside the window must not reach the 3D view (typing "w" would fly the camera). */
function guardOutside(event: KeyboardEvent) {
  if (root.value && !root.value.contains(event.target as Node)) {
    event.stopPropagation()
    if (event.key === 'Escape') close()
  }
}

onMounted(() => {
  window.addEventListener('keydown', guardOutside, true)
  let last: { id?: string; mode?: string } = {}
  try {
    last = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    /* ignore */
  }
  selectedId.value = entries.value.some((e) => e.item.id === last.id) ? (last.id as string) : (results.value[0]?.id ?? null)
  const item = selected.value
  modeName.value = item?.modes.find((m) => m.name === last.mode)?.name ?? item?.modes[0]?.name ?? ''
  void nextTick(() => {
    searchBox.value?.focus()
    listEl.value?.querySelector('.on')?.scrollIntoView({ block: 'center' })
  })
})
onBeforeUnmount(() => window.removeEventListener('keydown', guardOutside, true))

// The catalog may still be loading when the window opens.
watch(
  () => catalog.status,
  (status) => {
    if (status === 'ready' && !selectedId.value) selectedId.value = results.value[0]?.id ?? null
  },
)

const number = new Intl.NumberFormat('en')
const degrees = (v: number) => `${Math.round(v * 10) / 10}°`

function beamText(f: CatalogFixture) {
  const b = f.beamAngle
  if (!b) return ''
  return b[0] === b[1] ? degrees(b[0]) : `${Math.round(b[0])}–${degrees(b[1])}`
}

function summary(f: CatalogFixture) {
  return [beamText(f) && `${beamText(f)} beam`, f.powerW !== undefined && `${number.format(f.powerW)} W`].filter(Boolean).join(' · ')
}

const NOT_SIMULATED: Record<string, string> = {
  gobo: 'Gobos',
  prism: 'Prism',
  strobe: 'Strobe',
  iris: 'Iris',
  frost: 'Frost',
  effect: 'Effects',
  framing: 'Framing shutters',
  wheel: 'Wheels',
}

const notSimulated = computed(() =>
  selected.value
    ? Object.keys(NOT_SIMULATED)
        .filter((k) => selected.value!.features.includes(k))
        .map((k) => NOT_SIMULATED[k])
    : [],
)

const simulated = computed(() => {
  const c = profile.value?.controls
  if (!c) return []
  return ['Dimmer', c.color && 'Color', c.pan && 'Pan', c.tilt && 'Tilt', c.zoom && 'Zoom', c.focus && 'Focus'].filter(Boolean) as string[]
})

const mode = computed(() => selected.value?.modes.find((m) => m.name === modeName.value) ?? selected.value?.modes[0])
const libraryUrl = computed(() =>
  selected.value && selected.value.id !== 'generic-moving-head' ? `https://open-fixture-library.org/${selected.value.id}` : '',
)
</script>

<template>
  <div class="backdrop" @pointerdown.self="close">
    <div ref="root" class="window" role="dialog" aria-modal="true" aria-label="Choose a fixture" @keydown.stop="onKeydown" @pointerdown.stop>
      <header>
        <h2>Choose a fixture</h2>
        <input
          ref="searchBox"
          v-model="query"
          class="search"
          type="search"
          placeholder="Search by name or manufacturer, e.g. “robin 600” or “martin”"
          aria-label="Search fixtures"
        />
        <button class="close" title="Close (Esc)" aria-label="Close" @click="close">×</button>
      </header>

      <div v-if="catalog.status === 'loading' || catalog.status === 'idle'" class="state">Loading the fixture library…</div>
      <div v-else-if="catalog.status === 'error'" class="state error">
        Could not load the fixture library: {{ catalog.error }}
        <button class="link" @click="catalog.load()">Try again</button>
      </div>

      <div v-else class="body">
        <aside class="filters">
          <section>
            <h3>Type</h3>
            <div class="chips">
              <button v-for="[name, count] in categoryCounts" :key="name" :class="{ on: categories.includes(name) }" @click="toggle(categories, name)">
                {{ name }} <span class="count">{{ count }}</span>
              </button>
            </div>
          </section>
          <section>
            <h3>Has</h3>
            <div class="chips">
              <button v-for="f in FEATURES" :key="f.key" :class="{ on: required.includes(f.key) }" @click="toggle(required, f.key)">
                {{ f.label }}
              </button>
            </div>
          </section>
          <section>
            <h3>Manufacturer</h3>
            <select v-model="manufacturer" aria-label="Manufacturer">
              <option value="">All manufacturers</option>
              <option v-for="[name, count] in manufacturerCounts" :key="name" :value="name">{{ name }} ({{ count }})</option>
            </select>
          </section>
          <button v-if="filtering" class="link" @click="clearFilters">Clear search and filters</button>
        </aside>

        <section class="results">
          <div class="count-line">{{ results.length }} of {{ catalog.all.length }} fixtures</div>
          <ul ref="listEl" role="listbox" aria-label="Fixtures">
            <li v-for="item in results" :key="item.id">
              <button
                :class="{ on: item.id === selectedId }"
                role="option"
                :aria-selected="item.id === selectedId"
                @click="select(item.id)"
                @dblclick="placeItem(item.id)"
              >
                <span class="line">
                  <span class="maker">{{ item.manufacturer }}</span>
                  <span class="name">{{ item.name }}</span>
                </span>
                <span class="meta"
                  >{{ item.categories.join(', ') }}<template v-if="summary(item)"> · {{ summary(item) }}</template></span
                >
              </button>
            </li>
            <li v-if="results.length === 0" class="empty">
              No fixture matches.
              <button class="link" @click="clearFilters">Clear search and filters</button>
            </li>
          </ul>
        </section>

        <section class="detail">
          <template v-if="selected && profile">
            <h3 class="title">{{ selected.name }}</h3>
            <p class="sub">{{ selected.manufacturer }} · {{ selected.categories.join(', ') }}</p>

            <dl class="specs">
              <template v-if="selected.beamAngle">
                <dt>Beam angle</dt>
                <dd>{{ beamText(selected) }}</dd>
              </template>
              <template v-if="profile.controls.pan || profile.controls.tilt">
                <dt>Pan / tilt</dt>
                <dd>{{ degrees(profile.panRange) }} / {{ degrees(profile.tiltRange) }}</dd>
              </template>
              <template v-if="selected.lumens !== undefined">
                <dt>Light output</dt>
                <dd>{{ number.format(selected.lumens) }} lm<span v-if="selected.lumensEstimated" class="note"> (estimated from power)</span></dd>
              </template>
              <template v-if="selected.powerW !== undefined">
                <dt>Power</dt>
                <dd>{{ number.format(selected.powerW) }} W</dd>
              </template>
              <template v-if="selected.weightKg !== undefined">
                <dt>Weight</dt>
                <dd>{{ selected.weightKg }} kg</dd>
              </template>
              <template v-if="selected.sizeMm">
                <dt>Size</dt>
                <dd>{{ selected.sizeMm.map((n) => Math.round(n)).join(' × ') }} mm</dd>
              </template>
            </dl>

            <p v-if="profile && !profile.emitsLight" class="callout">
              This fixture does not light anything in the preview: it is placed as a plain body (a {{ profile.model.kind.replace('-', ' ') }}).
            </p>
            <p v-else-if="!selected.moving" class="callout">
              Not a moving head: it is placed as a fixed light with a spot-style beam, aimed with the rotate gizmo.
            </p>

            <div class="tags">
              <span class="label">Shown in the preview</span>
              <span v-for="s in simulated" :key="s" class="tag on">{{ s }}</span>
            </div>
            <div v-if="notSimulated.length" class="tags">
              <span class="label">In the fixture, not simulated yet</span>
              <span v-for="s in notSimulated" :key="s" class="tag">{{ s }}</span>
            </div>

            <label v-if="selected.modes.length" class="mode">
              <span class="label">DMX mode</span>
              <select v-model="modeName">
                <option v-for="m in selected.modes" :key="m.name" :value="m.name">{{ m.name }} · {{ m.channels.length }} ch</option>
              </select>
            </label>
            <details v-if="mode && mode.channels.length" class="channels">
              <summary>Channels in this mode</summary>
              <ol>
                <li v-for="([name, attribute], i) in mode.channels" :key="i">
                  <span class="num">{{ i + 1 }}</span>
                  <span>{{ name || '(unused)' }}</span>
                  <span v-if="attribute" class="attr">{{ attribute }}</span>
                </li>
              </ol>
            </details>

            <a v-if="libraryUrl" class="link" :href="libraryUrl" target="_blank" rel="noopener">Open in the Open Fixture Library ↗</a>
          </template>
          <p v-else class="hint">Select a fixture to see its details.</p>
        </section>
      </div>

      <footer>
        <span class="credit">
          Fixture data from the
          <a href="https://open-fixture-library.org" target="_blank" rel="noopener">Open Fixture Library</a>
          <template v-if="catalog.importedAt"> (imported {{ catalog.importedAt }})</template>.
        </span>
        <span class="spacer" />
        <button class="secondary" @click="close">Cancel</button>
        <button class="primary" :disabled="!selected" @click="place">Place {{ selected ? selected.name : '' }}…</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--scrim);
  font: 13px/1.4 var(--font-sans);
  color: var(--text);
}
.window {
  display: flex;
  flex-direction: column;
  width: min(1120px, 100%);
  height: min(700px, 100%);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}
header,
footer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
footer {
  border-bottom: 0;
  border-top: 1px solid var(--border);
}
h2 {
  margin: 0;
  font-size: 14px;
  white-space: nowrap;
}
h3 {
  margin: 0 0 6px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  font-weight: 600;
}
.search {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  color: inherit;
  background: var(--well);
  border: 1px solid var(--border);
  border-radius: 4px;
  font: inherit;
}
.search:focus {
  outline: none;
  border-color: var(--accent);
}
.close {
  width: 28px;
  height: 28px;
  padding: 0;
  font-size: 18px;
  line-height: 1;
  color: var(--text-muted);
  background: none;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}
.close:hover {
  color: var(--text-bright);
  background: var(--selected);
}
.state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-muted);
}
.state.error {
  color: var(--danger);
}
.body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr) 320px;
}
.filters,
.results,
.detail {
  min-height: 0;
  overflow-y: auto;
}
.filters {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 14px 16px;
  border-right: 1px solid var(--border);
}
.detail {
  padding: 14px 16px;
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.chips button {
  padding: 3px 8px;
  color: #b8b8c6;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 12px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.chips button:hover {
  border-color: #4a4a60;
}
.chips button.on {
  color: var(--text-bright);
  background: #3a4a8a;
  border-color: var(--accent);
}
.count {
  color: var(--text-dim);
  font-size: 11px;
}
select {
  width: 100%;
  padding: 5px 6px;
  color: inherit;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  font: inherit;
}
.results {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.count-line {
  padding: 8px 16px;
  color: var(--text-muted);
  font-size: 12px;
  border-bottom: 1px solid #23232f;
}
ul {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 4px 0;
  list-style: none;
  overflow-y: auto;
}
ul button {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  padding: 6px 16px;
  text-align: left;
  color: inherit;
  background: none;
  border: 0;
  border-left: 3px solid transparent;
  font: inherit;
  cursor: pointer;
}
ul button:hover {
  background: #20202c;
}
ul button.on {
  background: var(--selected);
  border-left-color: var(--accent);
}
.line {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.maker {
  color: var(--text-muted);
  white-space: nowrap;
}
.name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  color: var(--text-dim);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty {
  padding: 24px 16px;
  color: var(--text-muted);
}
.title {
  margin: 0;
  font-size: 16px;
  text-transform: none;
  letter-spacing: 0;
  color: var(--text-bright);
}
.sub {
  margin: -6px 0 0;
  color: var(--text-muted);
}
.specs {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  margin: 0;
}
.specs dt {
  color: var(--text-muted);
}
.specs dd {
  margin: 0;
}
.note {
  color: var(--text-muted);
  font-size: 12px;
}
.callout {
  margin: 0;
  padding: 8px 10px;
  color: var(--text-2);
  background: var(--surface-2);
  border-left: 3px solid var(--accent);
  border-radius: 3px;
  font-size: 12px;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
}
.label {
  flex-basis: 100%;
  color: var(--text-muted);
  font-size: 12px;
}
.tag {
  padding: 2px 8px;
  color: var(--text-muted);
  background: var(--surface-2);
  border-radius: 10px;
  font-size: 12px;
}
.tag.on {
  color: #cfe0ff;
  background: #2b3a66;
}
.mode {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.channels summary {
  cursor: pointer;
  color: var(--text-muted);
}
.channels ol {
  margin: 6px 0 0;
  padding: 0;
  max-height: 200px;
  overflow-y: auto;
  list-style: none;
  font-size: 12px;
}
.channels li {
  display: flex;
  gap: 8px;
  padding: 1px 0;
}
.num {
  width: 22px;
  text-align: right;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.attr {
  margin-left: auto;
  color: var(--accent);
}
.hint {
  color: var(--text-muted);
}
.link,
a {
  align-self: flex-start;
  padding: 0;
  color: var(--accent);
  background: none;
  border: 0;
  font: inherit;
  cursor: pointer;
  text-decoration: none;
}
.credit {
  color: var(--text-dim);
  font-size: 12px;
}
.spacer {
  flex: 1;
}
.primary,
.secondary {
  padding: 7px 14px;
  font: inherit;
  border-radius: 4px;
  cursor: pointer;
}
.secondary {
  color: var(--text);
  background: none;
  border: 1px solid var(--border);
}
.primary {
  color: var(--text-bright);
  background: var(--accent-strong-hover);
  border: 1px solid #5c7cff;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.primary:disabled {
  opacity: 0.5;
  cursor: default;
}
@media (max-width: 900px) {
  .body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr) auto;
    overflow-y: auto;
  }
  .filters {
    border-right: 0;
    border-bottom: 1px solid var(--border);
    max-height: 160px;
  }
  .detail {
    border-left: 0;
    border-top: 1px solid var(--border);
    max-height: 240px;
  }
}
</style>
