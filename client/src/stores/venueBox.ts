import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { Box } from '../domain/venueCheck'

/** The bounding box of the model that is on screen (set by the viewer, null while there is none). */
export const useVenueBox = defineStore('venueBox', () => {
  const box = ref<Box | null>(null)
  /** The parts of the model that can be hidden: its SketchUp tags (empty for a model converted before tags were kept), or
   *  for a model uploaded as glTF its top-level nodes. */
  const tags = ref<string[]>([])
  /** true when `tags` are the top-level nodes of a glTF model rather than SketchUp tags */
  const tagsFromNodes = ref(false)
  return { box, tags, tagsFromNodes }
})
