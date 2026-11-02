<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { modelUrl } from './api'
import CrowdPanel from './components/CrowdPanel.vue'
import EditBar from './components/EditBar.vue'
import FixtureInspector from './components/FixtureInspector.vue'
import FixturePicker from './components/FixturePicker.vue'
import FpsCounter from './components/FpsCounter.vue'
import HelpPanel from './components/HelpPanel.vue'
import RotationReadout from './components/RotationReadout.vue'
import RiderImport from './components/RiderImport.vue'
import TransferLights from './components/TransferLights.vue'
import ScreenshotButton from './components/ScreenshotButton.vue'
import Viewer from './components/Viewer.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import VenueSidebar from './components/VenueSidebar.vue'
import VenuesWindow from './components/VenuesWindow.vue'
import { KEYMAP, keysFor, keysOf } from './input/keymap'
import { useShortcuts } from './input/shortcuts'
import { useCameraBridge } from './stores/camera'
import { useCatalog } from './stores/catalog'
import { useLayout } from './stores/layout'
import { useRig } from './stores/rig'
import { useRider } from './stores/rider'
import { useTransfer } from './stores/transfer'
import { useVenues } from './stores/venues'

const store = useVenues()
const camera = useCameraBridge()
const catalog = useCatalog()
const rig = useRig()
const layout = useLayout()
const transfer = useTransfer()
const riderImport = useRider()
const loading = ref(false)
const loadError = ref<string | null>(null)

useShortcuts()
/** The keys the empty inspector lists; the help panel has all of them. */
const briefKeys = KEYMAP.filter((e) => e.brief)

const url = computed(() => {
  const venue = store.current
  return venue?.status === 'ready' ? modelUrl(venue) : undefined
})

/** What the view says when there is no model to show, and the step that gets one. */
const emptyState = computed(() => {
  if (store.loading || store.windowOpen) return null
  const venue = store.current
  if (!venue)
    return store.venues.length
      ? { title: 'No venue open', text: 'Open one of your venues to see it here.', action: 'Open a venue…' }
      : {
          title: 'Start with a venue',
          text: 'A venue is the room you light: upload its 3D model (glTF .glb, or SketchUp .skp) and hang lights in it. Or try the demo club first.',
          action: 'Create a venue…',
          demo: true,
        }
  if (venue.status === 'error')
    return {
      title: 'The model could not be converted',
      text: `Something in the SketchUp file of “${venue.name}” stopped the conversion. Try replacing its model, or saving it again from SketchUp.`,
      action: 'Open Venues…',
    }
  if (venue.status !== 'ready')
    return {
      title: 'This venue has no model yet',
      text: `Upload a model (.glb, .gltf or .skp) for “${venue.name}” in the Venues window to see it here.`,
      action: 'Upload a model…',
    }
  return null
})

const addingDemo = ref(false)
const demoError = ref<string | null>(null)

async function addDemo() {
  addingDemo.value = true
  demoError.value = null
  try {
    await store.addDemo()
  } catch (e) {
    demoError.value = (e as Error).message
  } finally {
    addingDemo.value = false
  }
}

onMounted(async () => {
  void catalog.load()
  await store.load()
  if (store.venues.length === 0) store.windowOpen = true // nothing to open yet: start by making a venue
})
</script>

<template>
  <div class="layout">
    <VenueSidebar />
    <main class="stage">
      <Viewer :model-url="url" @loading="(v) => ((loading = v), v && (loadError = null))" @error="(m) => (loadError = m)" />
      <div v-if="url" class="toolbar">
        <button @click="camera.api?.overview()">Overview</button>
        <button @click="camera.api?.inside()">Inside</button>
        <ScreenshotButton />
        <CrowdPanel />
        <HelpPanel />
        <SettingsPanel />
      </div>
      <EditBar v-if="url" />
      <FpsCounter />
      <RotationReadout />
      <FixturePicker v-if="rig.pickerOpen" />
      <VenuesWindow v-if="store.windowOpen" />
      <TransferLights v-if="transfer.open" />
      <RiderImport v-if="riderImport.open" />
      <div v-if="loading" class="overlay">Loading venue…</div>
      <div v-else-if="loadError" class="overlay error">Could not load venue: {{ loadError }}</div>
      <!-- Nothing to show yet: say why, and what to do next. -->
      <div v-else-if="emptyState" class="empty-state">
        <svg
          viewBox="0 0 24 24"
          width="28"
          height="28"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M3 21V9l9-6 9 6v12" />
          <path d="M9 21v-6h6v6" />
        </svg>
        <h2>{{ emptyState.title }}</h2>
        <p>{{ emptyState.text }}</p>
        <div class="buttons">
          <button @click="store.windowOpen = true">{{ emptyState.action }}</button>
          <button v-if="'demo' in emptyState" class="secondary" :disabled="addingDemo" @click="addDemo">
            {{ addingDemo ? 'Opening…' : 'Open the demo club' }}
          </button>
        </div>
        <p v-if="demoError" class="error">{{ demoError }}</p>
      </div>
    </main>
    <!-- The inspector sits beside the view, not over it, so it never hides the part of the picture being judged. -->
    <aside v-if="url" class="dock" :class="{ folded: !layout.dockOpen }">
      <button
        class="fold"
        :title="layout.dockOpen ? 'Fold the inspector' : 'Unfold the inspector'"
        :aria-label="layout.dockOpen ? 'Fold the inspector' : 'Unfold the inspector'"
        :aria-expanded="layout.dockOpen"
        @click="layout.dockOpen = !layout.dockOpen"
      >
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
          <path :d="layout.dockOpen ? 'm9 6 6 6-6 6' : 'm15 6-6 6 6 6'" />
        </svg>
        <span v-if="!layout.dockOpen && rig.selectedIds.length" class="badge">{{ rig.selectedIds.length }}</span>
      </button>
      <template v-if="layout.dockOpen">
        <FixtureInspector v-if="rig.selectedIds.length" />
        <div v-else class="empty">
          <p class="lead">No light selected</p>
          <p>Click a light in the view or the list to edit it, or “+ Place light” to add one.</p>
          <dl class="keys">
            <template v-for="entry in briefKeys" :key="entry.what">
              <dt>{{ keysOf(entry) }}</dt>
              <dd>{{ entry.what }}</dd>
            </template>
          </dl>
          <p class="more">
            All shortcuts: press <kbd>{{ keysFor('help') }}</kbd>
          </p>
        </div>
      </template>
    </aside>
  </div>
</template>

<style>
html,
body,
#app {
  margin: 0;
  height: 100%;
  background: var(--bg);
}
.layout {
  display: flex;
  height: 100%;
}
.stage {
  position: relative;
  flex: 1;
  min-width: 0;
  container: stage / inline-size; /* panels over the view adapt to its width, not the window's */
}
.overlay {
  position: absolute;
  top: 16px;
  left: 16px;
  padding: 6px 10px;
  border-radius: 4px;
  background: var(--overlay);
  backdrop-filter: var(--frost);
  color: var(--text);
  font: 13px var(--font-sans);
  pointer-events: none;
}
.empty-state {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(360px, calc(100% - 32px));
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 28px 24px 24px;
  text-align: center;
  font: 14px/1.5 var(--font-sans);
  color: var(--text-muted);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow);
}
.empty-state svg {
  color: var(--tint-text);
}
.empty-state h2 {
  margin: 0;
  font-size: 16px;
  color: var(--text-strong);
}
.empty-state p {
  margin: 0 0 6px;
}
.empty-state button {
  padding: 7px 16px;
  color: var(--text-bright);
  background: var(--accent-strong);
  border: 0;
  border-radius: 5px;
  font: 600 14px var(--font-sans);
  cursor: pointer;
}
.empty-state button:hover {
  background: var(--accent-strong-hover);
}
.empty-state .buttons {
  display: flex;
  gap: 8px;
}
.empty-state button.secondary {
  color: var(--text);
  background: none;
  border: 1px solid var(--border);
}
.empty-state button.secondary:hover:not(:disabled) {
  background: var(--surface);
}
.empty-state .error {
  color: var(--danger);
}
.overlay.error {
  color: var(--danger);
}
.toolbar {
  position: absolute;
  top: 16px;
  right: 16px;
  display: flex;
  gap: 6px;
}
.toolbar button {
  font: 13px var(--font-sans);
  color: var(--text);
  background: var(--overlay);
  backdrop-filter: var(--frost);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 5px 10px;
  cursor: pointer;
}
.toolbar button:hover {
  background: var(--selected);
}
.dock {
  position: relative;
  width: 276px;
  flex: none;
  box-sizing: border-box;
  overflow-y: auto;
  background: var(--panel);
  border-left: 1px solid var(--line);
  color: var(--text);
  font: 13px/1.4 var(--font-sans);
}
.dock.folded {
  width: 32px;
  overflow: hidden;
}
.dock .fold {
  position: absolute;
  top: 10px;
  right: 6px;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 20px;
  height: 22px;
  padding: 0;
  color: var(--text-muted);
  background: none;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}
.dock .fold:hover {
  color: var(--text-bright);
  background: var(--selected);
}
.dock .badge {
  position: absolute;
  top: 24px;
  min-width: 16px;
  font-size: 10px;
  border-radius: 8px;
  background: var(--tint-strong);
  color: var(--text-strong);
}
.dock .empty {
  padding: 14px 16px;
  color: var(--text-muted);
}
.dock .empty p {
  margin: 0 0 10px;
}
.dock .empty .lead {
  color: var(--text);
  font-weight: 600;
}
.dock .keys {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  margin: 18px 0 0;
  font-size: 12px;
}
.dock .keys dt {
  font: 11px var(--font-mono);
  color: var(--text-soft);
  white-space: nowrap;
}
.dock .keys dd {
  margin: 0;
}
.dock .empty .more {
  margin-top: 16px;
  font-size: 12px;
}
.dock .empty kbd {
  padding: 0 5px;
  border-radius: 3px;
  background: var(--surface-2);
  color: var(--text);
  font: 11px var(--font-mono);
}
</style>
