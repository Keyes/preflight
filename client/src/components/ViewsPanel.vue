<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { CameraView } from '@preflight/shared'
import { useCameraBridge } from '../stores/camera'
import { useVenues } from '../stores/venues'
import ContextMenu from './ContextMenu.vue'
import type { MenuItem } from './contextMenu'
import SidebarSection from './SidebarSection.vue'

const store = useVenues()
const bridge = useCameraBridge()

const error = ref<string | null>(null)
const menu = ref<{ x: number; y: number; id: string } | null>(null)
const renamingId = ref<string | null>(null)
const renameText = ref('')
const renameInput = ref<HTMLInputElement[]>()

function newId() {
  return crypto.randomUUID()
}

async function saveCurrent() {
  const state = bridge.api?.getState()
  if (!state) return
  const view: CameraView = { id: newId(), name: `View ${store.currentViews.length + 1}`, ...state }
  error.value = null
  try {
    await store.setViews([...store.currentViews, view])
    void startRename(view)
  } catch (e) {
    error.value = (e as Error).message
  }
}

function jump(view: CameraView) {
  bridge.api?.goTo({ position: view.position, rotation: view.rotation })
}

function openMenu(event: MouseEvent, id: string) {
  event.preventDefault()
  menu.value = { x: event.clientX, y: event.clientY, id }
}

function menuItems(id: string): MenuItem[] {
  const view = store.currentViews.find((v) => v.id === id)
  if (!view) return []
  return [
    { label: 'Rename', action: () => void startRename(view) },
    { label: 'Update to current camera', action: () => void updateToCurrent(id) },
    { label: 'Delete', danger: true, action: () => void remove(id) },
  ]
}

async function startRename(view: CameraView) {
  renamingId.value = view.id
  renameText.value = view.name
  await nextTick()
  renameInput.value?.[0]?.focus()
  renameInput.value?.[0]?.select()
}

async function commitRename() {
  const id = renamingId.value
  if (!id) return
  renamingId.value = null // also guards against the blur that follows Enter
  const name = renameText.value.trim()
  const view = store.currentViews.find((v) => v.id === id)
  if (!view || !name || name === view.name) return
  await mutate((views) => views.map((v) => (v.id === id ? { ...v, name } : v)))
}

async function updateToCurrent(id: string) {
  const state = bridge.api?.getState()
  if (state) await mutate((views) => views.map((v) => (v.id === id ? { ...v, ...state } : v)))
}

async function remove(id: string) {
  await mutate((views) => views.filter((v) => v.id !== id))
}

async function mutate(change: (views: CameraView[]) => CameraView[]) {
  error.value = null
  try {
    await store.setViews(change(store.currentViews))
  } catch (e) {
    error.value = (e as Error).message
  }
}

// Number keys 1–9 jump to the matching saved view, unless the user is typing.
function onKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
  if (event.ctrlKey || event.metaKey || event.altKey) return
  const n = Number(event.key)
  if (n >= 1 && n <= 9) {
    const view = store.currentViews[n - 1]
    if (view) jump(view)
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <SidebarSection
    v-if="store.current?.status === 'ready'"
    id="views"
    title="Views"
    tip="Fly to a spot and save it with “+ Save current” to come back to it later. The number keys 1 to 9 jump to the first nine views. Right-click a view for more."
    :count="store.currentViews.length || undefined"
  >
    <template #actions><button class="link" @click="saveCurrent">+ Save current</button></template>

    <p v-if="error" class="error">{{ error }}</p>

    <ul>
      <li v-for="(view, i) in store.currentViews" :key="view.id" @contextmenu="openMenu($event, view.id)">
        <input
          v-if="renamingId === view.id"
          ref="renameInput"
          v-model="renameText"
          class="rename"
          type="text"
          maxlength="80"
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent="renamingId = null"
          @blur="commitRename"
        />
        <button v-else @click="jump(view)">
          <span class="name">{{ view.name }}</span>
          <kbd v-if="i < 9">{{ i + 1 }}</kbd>
        </button>
      </li>
    </ul>

    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menuItems(menu.id)" @close="menu = null" />
  </SidebarSection>
</template>

<style scoped>
.link {
  background: none;
  border: 0;
  color: var(--accent);
  padding: 0;
  font: inherit;
  cursor: pointer;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
li > button {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  text-align: left;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
  padding: 8px 10px;
  border-radius: 4px;
}
li > button:hover {
  background: var(--surface);
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
kbd {
  font: 11px var(--font-mono);
  padding: 0 6px;
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--text-muted);
}
.rename {
  width: 100%;
  box-sizing: border-box;
  background: var(--surface);
  border: 1px solid var(--accent);
  color: inherit;
  padding: 7px 9px;
  border-radius: 4px;
  font: inherit;
}
.error {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}
.hint {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
}
</style>
