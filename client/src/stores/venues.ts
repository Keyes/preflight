import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import * as api from '../api'
import type { Atmosphere, CameraView, Crowd, Venue } from '../api'
import { AMBIENT_DEFAULT, HAZE_DEFAULT } from '../atmosphere'

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

  /** Applies a new views list to the current venue immediately; restores the old one if saving fails. */
  async function setViews(views: CameraView[]) {
    const venue = current.value
    if (!venue) return
    const previous = venue.views
    venue.views = views
    try {
      const saved = await api.saveViews(venue.id, views)
      venue.views = saved.views
    } catch (e) {
      venue.views = previous
      error.value = (e as Error).message
      throw e
    }
  }

  /** Deletes a venue with its lights, groups and views. When it was the current one, another venue takes over. */
  async function remove(id: string) {
    await api.deleteVenue(id)
    venues.value = venues.value.filter((v) => v.id !== id)
    if (currentId.value === id) {
      const next = venues.value.find((v) => v.status === 'ready') ?? venues.value[0]
      currentId.value = next?.id ?? null
      writeStored(currentId.value)
    }
  }

  // Haze and room light are saved a moment after the last change (a slider fires many).
  const pendingAtmosphere = new Map<string, Atmosphere>()
  let atmosphereTimer: ReturnType<typeof setTimeout> | undefined

  function setAtmosphere(id: string, atmosphere: Atmosphere) {
    const venue = venues.value.find((v) => v.id === id)
    if (!venue) return
    venue.atmosphere = { ...atmosphere }
    pendingAtmosphere.set(id, venue.atmosphere)
    clearTimeout(atmosphereTimer)
    atmosphereTimer = setTimeout(flushAtmosphere, 500)
  }

  async function flushAtmosphere() {
    const batch = [...pendingAtmosphere]
    pendingAtmosphere.clear()
    for (const [id, atmosphere] of batch) {
      try {
        await api.saveAtmosphere(id, atmosphere)
      } catch (e) {
        error.value = (e as Error).message
      }
    }
  }

  // The crowd is saved the same way: a moment after the last change.
  const pendingCrowd = new Map<string, Crowd>()
  let crowdTimer: ReturnType<typeof setTimeout> | undefined

  function setCrowd(id: string, crowd: Crowd) {
    const venue = venues.value.find((v) => v.id === id)
    if (!venue) return
    venue.crowd = crowd
    pendingCrowd.set(id, crowd)
    clearTimeout(crowdTimer)
    crowdTimer = setTimeout(flushCrowd, 500)
  }

  async function flushCrowd() {
    const batch = [...pendingCrowd]
    pendingCrowd.clear()
    for (const [id, crowd] of batch) {
      try {
        await api.saveCrowd(id, JSON.parse(JSON.stringify(crowd)) as Crowd)
      } catch (e) {
        error.value = (e as Error).message
      }
    }
  }

  /** Makes a whole copy of a venue, listed after it, and opens it. */
  async function duplicate(id: string) {
    await Promise.all([flushAtmosphere(), flushCrowd()]) // the copy is made from what the server has
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
  async function setTagHidden(tag: string, hidden: boolean) {
    const previous = current.value?.hiddenTags ?? []
    await setHiddenTags(hidden ? [...new Set([...previous, tag])] : previous.filter((t) => t !== tag))
  }

  /** Sets which parts of the open venue's model are hidden (SketchUp tags or glTF node names), all in one save. */
  async function setHiddenTags(next: string[]) {
    const venue = current.value
    if (!venue) return
    const previous = venue.hiddenTags ?? []
    venue.hiddenTags = next
    try {
      await api.saveHiddenTags(venue.id, next)
    } catch (e) {
      venue.hiddenTags = previous
      error.value = (e as Error).message
    }
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

  return { venues, currentId, current, loading, error, windowOpen, select, upsert, load, create, rename, remove, duplicate, addDemo, reconvert, setTagHidden, setHiddenTags, reorder, replaceModel, setAtmosphere, setCrowd, currentViews, setViews }
})
