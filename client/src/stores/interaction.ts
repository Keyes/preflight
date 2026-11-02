import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useVenues } from './venues'

/**
 * What the next click in the venue does, when it does something other than select. There is one at a time: starting one
 * ends the one before. The stores that start a mode also finish it, since they hold what the click is for.
 */
export type ClickMode =
  /** places the fixture chosen in the picker */
  | { kind: 'place'; choice: { profileId: string; mode?: string } }
  /** sets the point the selected lights aim at */
  | { kind: 'aim' }
  /** a corner of a new crowd zone: the first, or the opposite one once `first` is set (a point on a surface, meters) */
  | { kind: 'zone'; first: [number, number, number] | null }
  /** the point the people in a zone face */
  | { kind: 'facing'; zoneId: string }
  /** one of the two venue points that place a tech rider's plan */
  | { kind: 'riderPoint'; index: number }

export type ClickModeKind = ClickMode['kind']

export const useInteraction = defineStore('interaction', () => {
  const venues = useVenues()
  const mode = ref<ClickMode | null>(null)

  function start(next: ClickMode) {
    mode.value = next
  }

  /** Ends the mode; with a kind, only when that is the one on (so a store ends its own mode and leaves another's alone). */
  function cancel(kind?: ClickModeKind) {
    if (!kind || mode.value?.kind === kind) mode.value = null
  }

  function is(kind: ClickModeKind) {
    return mode.value?.kind === kind
  }

  // A click mode belongs to the venue it was started in.
  watch(
    () => venues.currentId,
    () => cancel(),
  )

  return { mode, start, cancel, is }
})
