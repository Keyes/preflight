import { shallowRef } from 'vue'
import { defineStore } from 'pinia'

export interface CameraState {
  position: [number, number, number]
  rotation: [number, number, number]
}

/** What the 3D viewer offers to the rest of the UI. Registered by Viewer.vue while mounted. */
export interface ViewerApi {
  getState(): CameraState
  goTo(state: CameraState): void
  overview(): void
  inside(): void
  /** Pixel size a screenshot at `scale` times the view would have. */
  planShot(scale: number): { width: number; height: number }
  /** Renders a clean (no selection outline or gizmo) PNG of the current view at `scale` times its size. */
  screenshot(scale: number): Promise<{ blob: Blob; width: number; height: number }>
}

export const useCameraBridge = defineStore('camera', () => {
  const api = shallowRef<ViewerApi | null>(null)
  return { api }
})
