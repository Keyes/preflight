<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { MODEL_ACCEPT, type Venue } from '../api'
import { useTransfer } from '../stores/transfer'
import { useVenues } from '../stores/venues'

const store = useVenues()
const transfer = useTransfer()

const root = ref<HTMLElement>()
const message = ref<string | null>(null)

function close() {
  store.windowOpen = false
}

onMounted(() => root.value?.focus())

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    if (renamingId.value || pending.value || showForm.value) {
      renamingId.value = null
      pending.value = null
      showForm.value = false
    } else {
      close()
    }
  }
}

const counts = (venue: Venue) => {
  const lights = venue.fixtures?.length ?? 0
  const groups = venue.groups?.length ?? 0
  const views = venue.views?.length ?? 0
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  return [plural(lights, 'light', 'lights'), plural(groups, 'group', 'groups'), plural(views, 'view', 'views')].join(' · ')
}

function open(venue: Venue) {
  store.select(venue.id)
  close()
}

// --- create ------------------------------------------------------------------------------------
const showForm = ref(false)
const name = ref('')
const file = ref<File | null>(null)
const busy = ref(false)
const formError = ref<string | null>(null)
const fileInput = ref<HTMLInputElement>()

function onFile(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null
  if (file.value && !name.value.trim()) name.value = file.value.name.replace(/\.(skp|glb|gltf)$/i, '')
}

/** Only SketchUp files are converted; a glTF model is just checked and stored. */
const converts = (chosen: File | null | undefined) => !!chosen && /\.skp$/i.test(chosen.name)

async function create() {
  if (!name.value.trim() || !file.value || busy.value) return
  busy.value = true
  formError.value = null
  try {
    await store.create(name.value.trim(), file.value)
    name.value = ''
    file.value = null
    showForm.value = false
    close() // the new venue is the current one now
  } catch (e) {
    formError.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

// --- rename ------------------------------------------------------------------------------------
const renamingId = ref<string | null>(null)
const renameText = ref('')
const renameInput = ref<HTMLInputElement[]>()

async function startRename(venue: Venue) {
  pending.value = null
  renamingId.value = venue.id
  renameText.value = venue.name
  await nextTick()
  renameInput.value?.[0]?.focus()
  renameInput.value?.[0]?.select()
}

async function commitRename() {
  const id = renamingId.value
  if (!id) return
  renamingId.value = null // also guards against the blur that follows Enter
  try {
    await store.rename(id, renameText.value)
  } catch (e) {
    message.value = (e as Error).message
  }
}

// --- delete and replace the model, both after a confirmation in the row -------------------------------
const pending = ref<{ id: string; kind: 'delete' | 'replace'; file?: File } | null>(null)
const working = ref<string | null>(null)
const replaceInputs = ref<Record<string, HTMLInputElement | null>>({})

function askDelete(venue: Venue) {
  renamingId.value = null
  pending.value = { id: venue.id, kind: 'delete' }
}

function chooseModel(venue: Venue) {
  replaceInputs.value[venue.id]?.click()
}

function onReplaceFile(event: Event, venue: Venue) {
  const input = event.target as HTMLInputElement
  const chosen = input.files?.[0]
  input.value = ''
  if (!chosen) return
  renamingId.value = null
  pending.value = { id: venue.id, kind: 'replace', file: chosen }
}

async function confirm() {
  const action = pending.value
  if (!action) return
  working.value = action.id
  message.value = null
  try {
    if (action.kind === 'delete') await store.remove(action.id)
    else if (action.file) await store.replaceModel(action.id, action.file)
    pending.value = null
  } catch (e) {
    message.value = (e as Error).message
  } finally {
    working.value = null
  }
}

async function duplicate(venue: Venue) {
  working.value = venue.id
  message.value = null
  try {
    await store.duplicate(venue.id)
    close() // the copy is the open venue now
  } catch (e) {
    message.value = (e as Error).message
  } finally {
    working.value = null
  }
}

const addingDemo = ref(false)

async function addDemo() {
  addingDemo.value = true
  message.value = null
  try {
    await store.addDemo()
    close() // the demo is the open venue now
  } catch (e) {
    message.value = (e as Error).message
  } finally {
    addingDemo.value = false
  }
}

async function reconvert(venue: Venue) {
  working.value = venue.id
  message.value = null
  try {
    await store.reconvert(venue.id)
  } catch (e) {
    message.value = (e as Error).message
  } finally {
    working.value = null
  }
}

function importFrom(venue: Venue) {
  close()
  transfer.openImport(venue.id)
}

// --- drag to reorder ---------------------------------------------------------------------------
const dragId = ref<string | null>(null)
/** Slot the dragged venue would be inserted at: 0 = before the first item, n = after the last. */
const dropSlot = ref<number | null>(null)

function onDragStart(event: DragEvent, id: string) {
  dragId.value = id
  event.dataTransfer?.setData('text/plain', id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(event: DragEvent, index: number) {
  if (!dragId.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const slot = index + (event.clientY > rect.top + rect.height / 2 ? 1 : 0)
  const from = store.venues.findIndex((v) => v.id === dragId.value)
  dropSlot.value = slot === from || slot === from + 1 ? null : slot
}

function onDrop(event: DragEvent) {
  if (!dragId.value) return
  event.preventDefault()
  const from = store.venues.findIndex((v) => v.id === dragId.value)
  const slot = dropSlot.value
  if (from >= 0 && slot !== null) {
    const ids = store.venues.map((v) => v.id)
    const [moved] = ids.splice(from, 1)
    ids.splice(slot > from ? slot - 1 : slot, 0, moved)
    void store.reorder(ids)
  }
  endDrag()
}

function endDrag() {
  dragId.value = null
  dropSlot.value = null
}

function onListDragLeave(event: DragEvent) {
  const list = event.currentTarget as HTMLElement
  if (!list.contains(event.relatedTarget as Node | null)) dropSlot.value = null
}
</script>

<template>
  <div class="backdrop" @pointerdown.self="close">
    <div ref="root" class="window" role="dialog" aria-modal="true" aria-label="Venues" tabindex="-1" @keydown.stop="onKeydown" @pointerdown.stop>
      <header>
        <h2>Venues</h2>
        <button class="primary" @click="showForm = !showForm">{{ showForm ? 'Cancel' : '+ New venue' }}</button>
        <button class="close" title="Close (Esc)" aria-label="Close" @click="close">×</button>
      </header>

      <div class="body">
        <form v-if="showForm" class="new-venue" @submit.prevent="create">
          <div class="fields">
            <input v-model="name" type="text" placeholder="Venue name" maxlength="80" :disabled="busy" aria-label="Venue name" />
            <input ref="fileInput" type="file" :accept="MODEL_ACCEPT" :disabled="busy" aria-label="Model file" @change="onFile" />
          </div>
          <p class="hint">
            A glTF model (.glb, or a .gltf with everything embedded) in meters, as Blender and most 3D programs export it, or a
            SketchUp file (.skp), which needs the SketchUp converter to be built.
          </p>
          <button class="primary" type="submit" :disabled="busy || !name.trim() || !file">
            {{ busy ? (converts(file) ? 'Uploading and converting…' : 'Uploading…') : 'Create venue' }}
          </button>
          <p v-if="formError" class="error">{{ formError }}</p>
        </form>

        <p v-if="store.error" class="error">{{ store.error }}</p>
        <p v-if="message" class="error">{{ message }}</p>
        <div v-if="!store.loading && store.venues.length === 0 && !showForm" class="empty">
          <p>
            No venues yet. Create one from a 3D model of the room (glTF or SketchUp); its lights, groups and camera views are kept with it.
            Or look around the demo club first: a small club with a stage, a truss rig and 18 lights already hung.
          </p>
          <button class="primary" :disabled="addingDemo" @click="addDemo">{{ addingDemo ? 'Opening…' : 'Open the demo club' }}</button>
        </div>

        <ul class="venues" @dragleave="onListDragLeave" @drop="onDrop">
          <li
            v-for="(venue, i) in store.venues"
            :key="venue.id"
            :class="{
              current: venue.id === store.currentId,
              dragging: venue.id === dragId,
              'drop-before': dropSlot === i,
              'drop-after': dropSlot === i + 1 && i === store.venues.length - 1,
            }"
            :draggable="renamingId !== venue.id && !pending"
            @dragstart="onDragStart($event, venue.id)"
            @dragover="onDragOver($event, i)"
            @dragend="endDrag"
          >
            <div class="row">
              <input
                v-if="renamingId === venue.id"
                ref="renameInput"
                v-model="renameText"
                class="rename"
                type="text"
                maxlength="80"
                @keydown.enter.prevent="commitRename"
                @keydown.esc.stop.prevent="renamingId = null"
                @blur="commitRename"
              />
              <button v-else class="main" :title="venue.error" @click="open(venue)">
                <span class="name">{{ venue.name }}</span>
                <span v-if="venue.id === store.currentId" class="badge current">open</span>
                <span v-if="venue.status === 'error'" class="badge failed">conversion failed</span>
                <span v-else-if="venue.status === 'empty'" class="badge">no model</span>
                <span class="meta">{{ venue.status === 'ready' ? counts(venue) : '' }}</span>
              </button>
              <span class="actions">
                <button v-if="venue.id !== store.currentId && venue.status === 'ready' && venue.fixtures?.length" title="Bring lights and groups of this venue into the open one" @click="importFrom(venue)">
                  Import lights…
                </button>
                <button :disabled="working === venue.id" title="Make a whole copy of this venue: model, lights, groups, crowd, haze and views" @click="duplicate(venue)">
                  {{ working === venue.id ? 'Copying…' : 'Duplicate' }}
                </button>
                <button @click="startRename(venue)">Rename</button>
                <button v-if="venue.status === 'ready' && venue.modelFormat !== 'glb'" :disabled="working === venue.id" title="Convert this venue's SketchUp file again with the current converter, to pick up what it has learned since (for example SketchUp tags). Lights and groups stay as they are." @click="reconvert(venue)">Re-convert</button>
                <button title="Upload a new model for this venue (.glb, .gltf or .skp)" @click="chooseModel(venue)">Replace model…</button>
                <button class="danger" @click="askDelete(venue)">Delete…</button>
                <input :ref="(el) => (replaceInputs[venue.id] = el as HTMLInputElement | null)" type="file" :accept="MODEL_ACCEPT" hidden @change="onReplaceFile($event, venue)" />
              </span>
            </div>

            <div v-if="pending?.id === venue.id" class="confirm" :class="{ danger: pending.kind === 'delete' }">
              <p v-if="pending.kind === 'delete'">
                Delete “{{ venue.name }}” with its {{ counts(venue) }}? This cannot be undone.
              </p>
              <p v-else>
                Replace the model of “{{ venue.name }}” with “{{ pending.file?.name }}”? The lights, groups and views stay where
                they are, so check them against the new model afterwards.
              </p>
              <div class="buttons">
                <button class="primary" :class="{ danger: pending.kind === 'delete' }" :disabled="working === venue.id" @click="confirm">
                  {{ working === venue.id ? (pending.kind === 'delete' ? 'Deleting…' : converts(pending.file) ? 'Converting…' : 'Uploading…') : pending.kind === 'delete' ? 'Delete venue' : 'Replace model' }}
                </button>
                <button :disabled="working === venue.id" @click="pending = null">Cancel</button>
              </div>
            </div>
          </li>
        </ul>

        <p v-if="store.venues.length > 0" class="demo">
          <button class="link" :disabled="addingDemo" @click="addDemo">{{ addingDemo ? 'Adding…' : '+ Add the demo club' }}</button>
          <span>a sample venue with lights, to try things out</span>
        </p>
      </div>
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
  font: 14px/1.4 var(--font-sans);
  color: var(--text);
}
.window {
  display: flex;
  flex-direction: column;
  width: min(720px, 100%);
  max-height: min(640px, 100%);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  outline: none;
}
header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
h2 {
  margin: 0;
  margin-right: auto;
  font-size: 16px;
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
}
button {
  font: inherit;
  cursor: pointer;
}
button.primary {
  color: var(--text-bright);
  background: var(--accent-strong);
  border: 0;
  border-radius: 4px;
  padding: 6px 12px;
}
button.primary.danger {
  background: #c0392b;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.new-venue {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--well);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.fields {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
input[type='text'] {
  flex: 1;
  min-width: 180px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: inherit;
  padding: 6px 8px;
  border-radius: 4px;
  font: inherit;
}
input[type='file'] {
  font-size: 12px;
  color: var(--text-muted);
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  color: var(--text-muted);
}
.empty p {
  margin: 0;
}
.demo {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
}
button.link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font-size: 13px;
}
button.link:hover:not(:disabled) {
  text-decoration: underline;
}
.hint {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
}
.error {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}
.venues {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.venues li {
  position: relative;
  background: var(--well);
  border: 1px solid var(--selected);
  border-radius: 6px;
}
.venues li.current {
  border-color: #3b4a8a;
  background: #191a2c;
}
.venues li.dragging {
  opacity: 0.4;
}
.venues li.drop-before::before,
.venues li.drop-after::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 3px;
  border-radius: 2px;
  background: var(--accent-text);
  box-shadow: 0 0 6px rgba(124, 156, 255, 0.9);
  pointer-events: none;
}
.venues li.drop-before::before {
  top: -5px;
}
.venues li.drop-after::after {
  bottom: -5px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 4px;
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  text-align: left;
  background: none;
  border: 0;
  color: inherit;
  padding: 8px 10px;
  border-radius: 4px;
}
.main:hover {
  background: #1f1f2e;
}
.name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  color: var(--text-muted);
  font-size: 12px;
}
.badge {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 8px;
  background: var(--border);
  color: var(--text-soft);
}
.badge.current {
  background: #25316b;
  color: #b9c8ff;
}
.badge.failed {
  background: var(--danger-bg);
  color: var(--danger);
}
.rename {
  flex: 1;
  border-color: var(--accent);
}
.actions {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}
.actions button {
  padding: 3px 8px;
  color: #b8b8c8;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 12px;
}
.actions button:hover {
  color: var(--text-bright);
  border-color: #3c3c52;
}
.actions .danger {
  color: var(--danger);
}
.confirm {
  padding: 10px 14px 12px;
  border-top: 1px solid var(--selected);
}
.confirm.danger {
  background: rgba(192, 57, 43, 0.08);
}
.confirm p {
  margin: 0 0 8px;
}
.buttons {
  display: flex;
  gap: 8px;
}
.buttons button:not(.primary) {
  padding: 6px 12px;
  color: var(--text-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
}
</style>
