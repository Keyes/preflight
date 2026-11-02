import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Crowd, CrowdZone } from '../api'
import { DEFAULT_CROWD, MIN_ZONE_SIDE, requestedPeople, totalPeople, zoneCounts } from '../crowdModel'
import { useVenues } from './venues'

/** The crowd of the open venue: its zones and options (saved with the venue), and the clicks that draw and aim zones. */
export const useCrowd = defineStore('crowd', () => {
  const venues = useVenues()

  const crowd = computed<Crowd>(() => venues.current?.crowd ?? DEFAULT_CROWD)
  const zones = computed(() => crowd.value.zones)
  const counts = computed(() => zoneCounts(crowd.value))
  const people = computed(() => totalPeople(crowd.value))
  /** What the zones ask for: more than `people` when the overall limit thins the crowd. */
  const requested = computed(() => requestedPeople(crowd.value))

  /** The zone whose outline shows in the venue. */
  const selectedId = ref<string | null>(null)
  /** A zone is being drawn: the first corner is set once it is clicked (a point on a surface, meters). */
  const drawing = ref<{ first: [number, number, number] | null } | null>(null)
  /** The zone waiting for a click on the point its people should face. */
  const facingFor = ref<string | null>(null)
  /** What the last click that could not make a zone said. */
  const message = ref('')

  /** The next click in the venue is for the crowd (a corner or a facing point). */
  const picking = computed(() => !!drawing.value || !!facingFor.value)

  /** Changes the crowd of the open venue (a copy with the change, so the saved object is never edited in place). */
  function write(change: (next: Crowd) => void) {
    const venue = venues.current
    if (!venue) return
    const base = venue.crowd ?? DEFAULT_CROWD
    const next: Crowd = { ...base, zones: base.zones.map((z) => ({ ...z })) }
    change(next)
    venues.setCrowd(venue.id, next)
  }

  const setShown = (shown: boolean) => write((c) => (c.shown = shown))
  const setDensity = (density: number) => write((c) => (c.density = Math.min(1, Math.max(0, density))))
  const setMotion = (motion: Crowd['motion']) => write((c) => (c.motion = motion))
  const setIntensity = (intensity: number) => write((c) => (c.intensity = Math.min(1, Math.max(0, intensity))))

  function nextZoneName() {
    const used = new Set(zones.value.map((z) => z.name))
    for (let n = 1; ; n++) if (!used.has(`Zone ${n}`)) return `Zone ${n}`
  }

  function startDrawing() {
    facingFor.value = null
    message.value = ''
    drawing.value = { first: null }
  }

  function startFacing(zoneId: string) {
    drawing.value = null
    message.value = ''
    facingFor.value = zoneId
  }

  function cancelPicking() {
    drawing.value = null
    facingFor.value = null
  }

  /** The second corner was clicked: makes the zone (too small a rectangle is refused). */
  function finishZone(second: [number, number]) {
    const first = drawing.value?.first
    drawing.value = null
    if (!first) return
    if (Math.abs(second[0] - first[0]) < MIN_ZONE_SIDE || Math.abs(second[1] - first[2]) < MIN_ZONE_SIDE) {
      message.value = `A zone needs at least ${MIN_ZONE_SIDE} m on each side.`
      return
    }
    const zone: CrowdZone = {
      id: crypto.randomUUID(),
      name: nextZoneName(),
      x0: first[0],
      z0: first[2],
      x1: second[0],
      z1: second[1],
      y: first[1],
      facing: null,
      shown: true,
    }
    write((c) => c.zones.push(zone))
    selectedId.value = zone.id
  }

  /** Adds zones copied from another venue (they have new ids). */
  function addZones(added: CrowdZone[]) {
    if (added.length) write((c) => c.zones.push(...added))
  }

  function setFacing(zoneId: string, facing: [number, number] | null) {
    facingFor.value = null
    write((c) => {
      const zone = c.zones.find((z) => z.id === zoneId)
      if (zone) zone.facing = facing
    })
  }

  function renameZone(zoneId: string, name: string) {
    const clean = name.trim()
    if (!clean) return
    write((c) => {
      const zone = c.zones.find((z) => z.id === zoneId)
      if (zone) zone.name = clean
    })
  }

  function toggleZone(zoneId: string) {
    write((c) => {
      const zone = c.zones.find((z) => z.id === zoneId)
      if (zone) zone.shown = !zone.shown
    })
  }

  function removeZone(zoneId: string) {
    write((c) => (c.zones = c.zones.filter((z) => z.id !== zoneId)))
    if (selectedId.value === zoneId) selectedId.value = null
  }

  return {
    crowd,
    zones,
    counts,
    people,
    requested,
    selectedId,
    drawing,
    facingFor,
    message,
    picking,
    setShown,
    setDensity,
    setMotion,
    setIntensity,
    addZones,
    startDrawing,
    startFacing,
    cancelPicking,
    finishZone,
    setFacing,
    renameZone,
    toggleZone,
    removeZone,
  }
})
