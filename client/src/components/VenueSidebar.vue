<script setup lang="ts">
import { computed } from 'vue'
import { useAutosave } from '../stores/autosave'
import { useCrowd } from '../stores/crowd'
import { useLayout, type SidebarTab } from '../stores/layout'
import { useRig } from '../stores/rig'
import { useVenueBox } from '../stores/venueBox'
import { useVenues } from '../stores/venues'
import { checkVenue } from '../domain/venueCheck'
import InfoTip from './InfoTip.vue'
import FixturesPanel from './FixturesPanel.vue'
import CrowdZones from './CrowdZones.vue'
import GroupsPanel from './GroupsPanel.vue'
import ModelTags from './ModelTags.vue'
import ViewsPanel from './ViewsPanel.vue'

const store = useVenues()
const autosave = useAutosave()
const venueBox = useVenueBox()
const layout = useLayout()
const rig = useRig()
const crowd = useCrowd()

const tabs = computed<{ id: SidebarTab; label: string; count: number }[]>(() => [
  { id: 'lights', label: 'Lights', count: rig.fixtures.length },
  { id: 'scene', label: 'Scene', count: crowd.zones.length },
  { id: 'views', label: 'Views', count: store.currentViews.length },
])

/** Size of the model and anything about its scale or position that looks wrong. */
const check = computed(() => (venueBox.box && store.current?.status === 'ready' ? checkVenue(venueBox.box, store.current.fixtures ?? []) : null))
const sizeText = computed(() =>
  check.value ? `${check.value.size[0].toFixed(1)} × ${check.value.size[2].toFixed(1)} m, ${check.value.size[1].toFixed(1)} m high` : '',
)
</script>

<template>
  <aside class="sidebar">
    <header>
      <h1>pre(f)light</h1>
    </header>

    <!-- The venue is the project: everything below belongs to it, and the Venues window is where projects are managed. -->
    <button class="project" title="Switch, create or manage venues" @click="store.windowOpen = true">
      <span class="label">Venue</span>
      <span class="title">
        <span class="name">{{ store.current?.name ?? (store.loading ? 'Loading…' : 'No venue yet') }}</span>
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="m7 15 5 5 5-5" />
          <path d="m7 9 5-5 5 5" />
        </svg>
      </span>
      <span v-if="store.current && store.current.status !== 'ready'" class="badge" :class="store.current.status">
        {{ store.current.status === 'error' ? 'conversion failed' : 'no model yet' }}
      </span>
    </button>
    <p v-if="check" class="size" :class="{ warn: check.warnings.length }">
      <span>{{ sizeText }}</span>
      <InfoTip v-if="check.warnings.length" :text="check.warnings.join(' ')" label="Problems with this venue's scale or position" />
      <InfoTip
        v-else
        :text="
          [
            'Width × depth, and height, of the model in meters. Nothing about its scale or position looks wrong: it is room-sized and every light stands inside it.',
            ...check.notes,
          ].join(' ')
        "
        label="About the model size"
      />
    </p>
    <p v-if="store.error" class="error">{{ store.error }}</p>
    <p v-if="autosave.problem" class="error" role="status">Changes not saved yet: {{ autosave.problem }}. Trying again…</p>

    <!-- The venue's contents in three pages. Hidden pages stay mounted (v-show), so they keep their scroll position and filter. -->
    <nav v-if="store.current?.status === 'ready'" class="tabs" role="tablist" aria-label="Venue contents">
      <button v-for="t in tabs" :key="t.id" role="tab" :aria-selected="layout.tab === t.id" :class="{ on: layout.tab === t.id }" @click="layout.tab = t.id">
        {{ t.label }}<span v-if="t.count" class="tabcount">{{ t.count }}</span>
      </button>
    </nav>

    <div v-show="layout.tab === 'lights'" class="contents" role="tabpanel">
      <FixturesPanel />
      <GroupsPanel />
    </div>
    <div v-show="layout.tab === 'scene'" class="contents" role="tabpanel">
      <CrowdZones />
      <ModelTags />
    </div>
    <div v-show="layout.tab === 'views'" class="contents" role="tabpanel">
      <ViewsPanel />
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 276px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  box-sizing: border-box;
  background: var(--panel);
  color: var(--text);
  border-right: 1px solid var(--line);
  overflow-y: auto;
  font: 14px/1.4 var(--font-sans);
}
h1 {
  margin: 0;
  font-size: 16px;
  letter-spacing: 0.02em;
}
.project {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  width: 100%;
  padding: 9px 12px;
  text-align: left;
  color: inherit;
  font: inherit;
  background: var(--tint-surface);
  border: 1px solid var(--tint-border);
  border-radius: 6px;
  cursor: pointer;
}
.project:hover {
  background: var(--tint-surface-hover);
  border-color: var(--tint-border-hover);
}
.size {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: -6px 2px 0;
  font-size: 12px;
  color: var(--text-muted);
}
.size.warn {
  color: var(--caution);
}
.size.warn :deep(.info) {
  color: var(--caution);
}
.label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--tint-text);
  font-weight: 600;
}
.title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--tint-text);
}
.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-strong);
}
.badge {
  align-self: flex-start;
  margin-top: 2px;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 8px;
  background: var(--border);
  color: var(--text-soft);
}
.badge.error {
  background: var(--danger-bg);
  color: var(--danger);
}
.tabs {
  display: flex;
  gap: 2px;
  padding: 3px;
  background: var(--well);
  border: 1px solid var(--line);
  border-radius: 7px;
}
.tabs button {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 5px 4px;
  color: var(--text-muted);
  background: none;
  border: 0;
  border-radius: 5px;
  font: 13px var(--font-sans);
  cursor: pointer;
}
.tabs button:hover {
  color: var(--text);
}
.tabs button.on {
  color: var(--text-bright);
  background: var(--selected);
}
.tabcount {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}
/* What belongs to the open venue: a left rule ties the sections to the venue above them. */
.contents {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-left: 5px;
  padding-left: 12px;
  border-left: 2px solid var(--tint-line);
}
.error {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}
</style>
