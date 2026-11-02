import { shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type { Fixture } from '@preflight/shared'
import type { AimOptions, AimResult } from '../scene/aim'
import type { CameraState } from '../scene/ViewerCamera'

/**
 * What the rest of the app can ask of the 3D view, which Viewer.vue registers while it is mounted. This is the one way to
 * ask the view something; the other way round, the view follows the stores' state in watchers.
 */
export interface ViewerApi {
  getState(): CameraState
  goTo(state: CameraState): void
  overview(): void
  inside(): void
  /** Pixel size a screenshot at `scale` times the view would have. */
  planShot(scale: number): { width: number; height: number }
  /** Renders a clean (no selection outline or gizmo) PNG of the current view at `scale` times its size. */
  screenshot(scale: number): Promise<{ blob: Blob; width: number; height: number }>
  /** The height of the first surface above a spot, from 0.3 m over the floor: the ceiling's underside, or whatever hangs there. */
  ceilingAt(x: number, z: number): number | null
  /** How to point these lights at a spot (see scene/aim.ts): what to change on each, and which cannot reach it. */
  aim(fixtures: readonly Fixture[], point: readonly [number, number, number], options: AimOptions): AimResult
}

export const useViewer = defineStore('viewer', () => {
  /** null while there is no view (or no venue model in it) */
  const api = shallowRef<ViewerApi | null>(null)
  return { api }
})
