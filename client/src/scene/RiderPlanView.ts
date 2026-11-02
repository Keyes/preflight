import type { VenueModel } from './VenueModel'
import type { Bounds, CameraState, ViewerCamera } from './ViewerCamera'

/** The model is cut away this far over the floor, like an architect's plan, which shows the walls and what stands on the floor. */
const PLAN_CUT = 2.2
const PLAN_FOV = (50 * Math.PI) / 180

/** Where the camera hangs over the venue for the plan view, and how the view is shifted to clear the wizard. */
export interface PlanFit {
  center: { x: number; z: number }
  floorY: number
  /** camera height over the floor, meters */
  height: number
  /** meters one render pixel spans on the floor */
  metersPerPixel: number
  /** how far the venue's middle moves left of the view's middle, render pixels */
  shiftPx: number
}

/** The view's size in render pixels, and how much of it the wizard panel covers at the right. */
export interface Viewport {
  width: number
  height: number
  coveredPx: number
}

/** Fits the venue into the part of the view the wizard panel leaves free, with a margin. */
export function fitPlan(bounds: Bounds, floorY: number, view: Viewport): PlanFit {
  const halfW = (bounds.max.x - bounds.min.x) / 2
  const halfD = (bounds.max.z - bounds.min.z) / 2
  const heightPx = Math.max(1, view.height)
  const aspect = Math.max(0.5, (view.width - view.coveredPx) / heightPx)
  const height = (1.1 * Math.max(halfD, halfW / aspect)) / Math.tan(PLAN_FOV / 2)
  return {
    center: { x: (bounds.min.x + bounds.max.x) / 2, z: (bounds.min.z + bounds.max.z) / 2 },
    floorY,
    height,
    metersPerPixel: (2 * Math.tan(PLAN_FOV / 2) * height) / heightPx,
    shiftPx: view.coveredPx / 2,
  }
}

/** The camera over the venue at a yaw, looking straight down, shifted sideways so the venue sits in the free part of the view. */
export function planPose(fit: PlanFit, yaw: number): CameraState {
  const shift = fit.shiftPx * fit.metersPerPixel // to the right, so the venue moves left on the screen
  return {
    position: [fit.center.x + Math.cos(yaw) * shift, fit.floorY + fit.height, fit.center.z - Math.sin(yaw) * shift],
    rotation: [Math.PI / 2 - 0.0005, yaw, 0],
  }
}

/**
 * The view for placing a tech rider's plan on the venue: the camera high over the middle looking straight down, the model
 * cut away above 2.2 m and, on request, the clutter on the floor taken out. Leaving puts the camera and the model back.
 * The lights, the crowd and the room light are the caller's to hide and restore.
 */
export class RiderPlanView {
  private fit: (PlanFit & { yaw: number }) | null = null
  private saved: { pose: CameraState; fov: number; maxZ: number } | null = null

  constructor(
    private readonly walk: ViewerCamera,
    private readonly model: VenueModel,
  ) {}

  get active() {
    return this.fit !== null
  }

  /** Looks down on the venue; false when there is no model to look at. */
  enter(view: Viewport, hideClutter: boolean): boolean {
    const bounds = this.model.bounds
    if (!bounds || this.fit) return false
    const camera = this.walk.camera
    const center = bounds.min.add(bounds.max).scale(0.5)
    // the floor: the first surface met going up from below the model (a ray down from above would meet the roof)
    const floorY = this.model.surfaceAbove(center.x, bounds.min.y - 1, center.z, bounds.max.y - bounds.min.y + 2) ?? bounds.min.y
    // look along an axis of the venue: the nearest quarter turn to where the camera looks now
    const yaw = Math.round(camera.rotation.y / (Math.PI / 2)) * (Math.PI / 2)
    this.fit = { ...fitPlan(bounds, floorY, view), yaw }
    this.saved = { pose: this.walk.state(), fov: camera.fov, maxZ: camera.maxZ }
    camera.fov = PLAN_FOV
    camera.maxZ = Math.max(camera.maxZ, this.fit.height + (bounds.max.y - bounds.min.y) + 50)
    this.model.cutAbove(floorY + PLAN_CUT)
    this.walk.setRemembering(false) // a passing look, not where the camera should start next time
    this.walk.goTo(planPose(this.fit, yaw))
    this.setClutterHidden(hideClutter)
    return true
  }

  /** A quarter turn, for venues whose stage is not at the top of the screen. */
  turn() {
    if (!this.fit) return
    this.fit.yaw += Math.PI / 2
    this.walk.goTo(planPose(this.fit, this.fit.yaw))
  }

  setClutterHidden(hidden: boolean) {
    if (this.fit) this.model.setClutterHidden(hidden, this.fit.floorY)
  }

  leave() {
    if (!this.fit || !this.saved) return
    this.model.setClutterHidden(false, this.fit.floorY)
    this.model.cutAbove(null)
    const camera = this.walk.camera
    camera.fov = this.saved.fov
    camera.maxZ = this.saved.maxZ
    this.walk.goTo(this.saved.pose)
    this.walk.setRemembering(true)
    this.fit = null
    this.saved = null
  }
}
