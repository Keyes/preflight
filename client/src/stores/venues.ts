import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import * as api from '../api'
import type { Atmosphere, CameraView, Crowd, Venue } from '@preflight/shared'
import { AMBIENT_DEFAULT, HAZE_DEFAULT } from '../atmosphere'
import { partKey, useAutosave } from './autosave'

const STORAGE_KEY = 'preflight.currentVenue'

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStored(id: string | null) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage unavailable: selection just won't persist */
  }
}

export const useVenues = defineStore('venues', () => {
  const autosave = useAutosave()
  const venues = ref<Venue[]>([])
  const currentId = ref<string | null>(readStored())
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** The Venues window is open. */
  const windowOpen = ref(false)

  const current = computed(() => venues.value.find((v) => v.id === currentId.value))

  function select(id: string) {
    currentId.value = id
    writeStored(id)
  }

  function upsert(venue: Venue) {
    const i = venues.value.findIndex((v) => v.id === venue.id)
    if (i >= 0) venues.value[i] = venue
    else venues.value.push(venue)
  }

  async function load() {
    loading.value = true
    error.value = null
    try {
      venues.value = await api.listVenues()
      if (!current.value) {
        const first = venues.value.find((v) => v.status === 'ready') ?? venues.value[0]
        currentId.value = first?.id ?? null
        writeStored(currentId.value)
      }
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      loading.value = false
    }
  }

  /** Creates the venue, uploads its model and selects it. On failure the new venue is removed again. */
  async function create(name: string, file: File) {
    const venue = await api.createVenue(name)
    upsert(venue)
    try {
      const withModel = await api.uploadModel(venue.id, file)
      if (withModel.status === 'error') throw new Error(withModel.error ?? 'conversion failed')
      upsert(withModel)
      select(withModel.id)
      setAtmosphere(withModel.id, { haze: HAZE_DEFAULT, ambient: AMBIENT_DEFAULT }) // a new venue starts from the defaults
    } catch (e) {
      venues.value = venues.value.filter((v) => v.id !== venue.id)
      await api.deleteVenue(venue.id).catch(() => {})
      throw e
    }
  }

  async function rename(id: string, name: string) {
    const trimmed = name.trim()
    const venue = venues.value.find((v) => v.id === id)
    if (!venue || !trimmed || trimmed === venue.name) return
    const previous = venue.name
    venue.name = trimmed // optimistic
    try {
      venue.name = (await api.renameVenue(id, trimmed)).name
    } catch (e) {
      venue.name = previous
      throw e
    }
  }

  /** Applies a new order immediately and persists it; reloads from the server if that fails. */
  async function reorder(ids: string[]) {
    const byId = new Map(venues.value.map((v) => [v.id, v]))
    venues.value = ids.map((id) => byId.get(id)).filter((v): v is Venue => !!v)
    try {
      venues.value = await api.reorderVenues(ids)
    } catch (e) {
      error.value = (e as Error).message
      await load()
    }
  }

  const currentViews = computed(() => current.value?.views ?? [])

  /**
   * Saves a part of a venue a moment after the last change to it, as it is then (see autosave.ts). A save that fails
   * leaves the change on screen, says so in the sidebar and is tried again.
   */
  function save(id: string, part: Parameters<typeof partKey>[1], send: (venue: Venue) => Promise<unknown>) {
    autosave.schedule(partKey(id, part), () => {
      const venue = venues.value.find((v) => v.id === id)
      return venue ? send(venue) : Promise.resolve()
    })
  }

  /** The current venue's saved camera views, in order. */
  function setViews(views: CameraView[]) {
    const venue = current.value
    if (!venue) return
    venue.views = views
    save(venue.id, 'views', (v) => api.saveViews(v.id, v.views ?? []))
  }

  /** Deletes a venue with its lights, groups and views. When it was the current one, another venue takes over. */
  async function remove(id: string) {
    autosave.discard(id) // its changes have nowhere to go
    await api.deleteVenue(id)
    venues.value = venues.value.filter((v) => v.id !== id)
    if (currentId.value === id) {
      const next = venues.value.find((v) => v.status === 'ready') ?? venues.value[0]
      currentId.value = next?.id ?? null
      writeStored(currentId.value)
    }
  }

  /** Haze and room light (a slider changes them many times a second). */
  function setAtmosphere(id: string, atmosphere: Atmosphere) {
    const venue = venues.value.find((v) => v.id === id)
    if (!venue) return
    venue.atmosphere = { ...atmosphere }
    save(id, 'atmosphere', (v) => api.saveAtmosphere(id, { ...v.atmosphere! }))
  }

  function setCrowd(id: string, crowd: Crowd) {
    const venue = venues.value.find((v) => v.id === id)
    if (!venue) return
    venue.crowd = crowd
    save(id, 'crowd', (v) => api.saveCrowd(id, JSON.parse(JSON.stringify(v.crowd)) as Crowd))
  }

  /** Makes a whole copy of a venue, listed after it, and opens it. */
  async function duplicate(id: string) {
    await autosave.flush(id) // the copy is made from what the server has
    const copy = await api.duplicateVenue(id)
    const at = venues.value.findIndex((v) => v.id === id)
    venues.value.splice(at + 1, 0, copy)
    select(copy.id)
    return copy
  }

  /** Adds the demo club as a new venue, at the end of the list, and opens it. */
  async function addDemo() {
    const venue = await api.createDemoVenue()
    upsert(venue)
    select(venue.id)
    return venue
  }

  /** Shows or hides a part of the open venue's model, by its SketchUp tag or glTF node name (saved with the venue). */
  function setTagHidden(tag: string, hidden: boolean) {
    const previous = current.value?.hiddenTags ?? []
    setHiddenTags(hidden ? [...new Set([...previous, tag])] : previous.filter((t) => t !== tag))
  }

  /** Sets which parts of the open venue's model are hidden (SketchUp tags or glTF node names). */
  function setHiddenTags(next: string[]) {
    const venue = current.value
    if (!venue) return
    venue.hiddenTags = next
    save(venue.id, 'hiddenTags', (v) => api.saveHiddenTags(v.id, v.hiddenTags ?? []))
  }

  /** Converts a venue's SketchUp file again (for a model made by an older converter, to get what it has learned since). */
  async function reconvert(id: string) {
    upsert(await api.reconvertVenue(id))
  }

  /** Replaces the model of an existing venue. */
  async function replaceModel(id: string, file: File) {
    const updated = await api.uploadModel(id, file)
    upsert(updated)
    if (updated.status === 'error') throw new Error(updated.error ?? 'conversion failed')
  }

  return {
    venues,
    currentId,
    current,
    loading,
    error,
    windowOpen,
    select,
    upsert,
    load,
    create,
    rename,
    remove,
    duplicate,
    addDemo,
    reconvert,
    setTagHidden,
    setHiddenTags,
    reorder,
    replaceModel,
    setAtmosphere,
    setCrowd,
    currentViews,
    setViews,
  }
})
