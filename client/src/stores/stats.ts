import { ref } from 'vue'
import { defineStore } from 'pinia'

/** Live render statistics, refreshed about once a second by the viewer. */
export const useStats = defineStore('stats', () => {
  const fps = ref(0)
  /** Render pixels per CSS pixel per axis (1 = CSS resolution, 2 = a 2x display at full quality). */
  const renderScale = ref(1)
  const width = ref(0)
  const height = ref(0)
  /** ids of the fixtures whose lights currently cast shadows (a limited number can at once) */
  const shadowed = ref<string[]>([])
  /** ids of the fixtures whose gobo is currently projected onto surfaces (a limited number can at once) */
  const projected = ref<string[]>([])
  return { fps, renderScale, width, height, shadowed, projected }
})
