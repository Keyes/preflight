import { UniversalCamera, Vector3, type Observer, type Scene } from '@babylonjs/core'

/** Where the camera is and where it looks: position in meters, Babylon's rotation in radians (pitch, yaw, roll). */
export interface CameraState {
  position: [number, number, number]
  rotation: [number, number, number]
}

/** The keys that move the camera, as key codes (see input/keymap.ts). */
export interface MoveKeys {
  forward: readonly number[]
  back: readonly number[]
  left: readonly number[]
  right: readonly number[]
  up: readonly number[]
  down: readonly number[]
}

/** A box around the venue, meters. */
export interface Bounds {
  min: Vector3
  max: Vector3
}

const EYE_HEIGHT = 1.7
const WALK_SPEED = 0.12
const FAST_FACTOR = 4
const JUMP_MS = 700
/** A pose is remembered this long after the camera stops moving. */
const REMEMBER_AFTER_MS = 500

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/** Babylon rotation (pitch down is positive x, yaw around y) for looking from `from` at `to`. */
export function lookRotation(from: Vector3, to: Vector3): Vector3 {
  const d = to.subtract(from)
  return new Vector3(Math.atan2(-d.y, Math.hypot(d.x, d.z)), Math.atan2(d.x, d.z), 0)
}

/** High above the front of the venue, looking at its middle. */
export function overviewPose(bounds: Bounds): CameraState {
  const center = bounds.min.add(bounds.max).scale(0.5)
  const position = new Vector3(center.x, bounds.max.y + 8, bounds.min.z - 14)
  return { position: position.asArray(), rotation: lookRotation(position, center).asArray() }
}

/** At eye height over the floor in the middle of the venue, looking along it. */
export function insidePose(bounds: Bounds, floorY: number): CameraState {
  const center = bounds.min.add(bounds.max).scale(0.5)
  return { position: [center.x, floorY + EYE_HEIGHT, center.z], rotation: [0, 0, 0] }
}

const poseKey = (venueId: string) => `preflight.camera.${venueId}`

function loadPose(venueId: string): CameraState | undefined {
  try {
    const raw = JSON.parse(localStorage.getItem(poseKey(venueId)) ?? 'null') as { position?: unknown; rotation?: unknown } | null
    const ok = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
    if (raw && ok(raw.position) && ok(raw.rotation)) return { position: raw.position, rotation: raw.rotation }
  } catch {
    /* unreadable or unavailable storage: start from the default view */
  }
  return undefined
}

function savePose(venueId: string, state: CameraState) {
  try {
    localStorage.setItem(poseKey(venueId), JSON.stringify(state))
  } catch {
    /* storage unavailable: the pose just won't be remembered */
  }
}

/**
 * The camera you walk through the venue with: the movement keys and the arrows move it, Q and E lower and raise it, Shift
 * makes it faster and dragging turns it. It jumps to a pose with a short ease, which any click or key in the view stops.
 * It remembers, for each venue, where it was, so a venue opens where it was left.
 */
export class ViewerCamera {
  readonly camera: UniversalCamera
  private jump: Observer<Scene> | null = null
  private readonly frame: Observer<Scene>
  /** the venue whose pose is remembered, and whether moves count (the plan view is only a passing look) */
  private venueId: string | null = null
  private remembering = true
  private poseTimer: ReturnType<typeof setTimeout> | undefined
  private lastPose = ''

  constructor(
    private readonly scene: Scene,
    private readonly canvas: HTMLCanvasElement,
    keys: MoveKeys,
    fovDegrees: number,
  ) {
    const camera = new UniversalCamera('cam', new Vector3(0, EYE_HEIGHT, -8), scene)
    camera.fov = (fovDegrees * Math.PI) / 180
    camera.minZ = 0.05
    camera.maxZ = 500
    camera.speed = WALK_SPEED
    camera.inertia = 0.75
    camera.angularSensibility = 2500
    camera.keysUp = [...keys.forward]
    camera.keysDown = [...keys.back]
    camera.keysLeft = [...keys.left]
    camera.keysRight = [...keys.right]
    camera.keysUpward = [...keys.up]
    camera.keysDownward = [...keys.down]
    camera.attachControl(canvas, true)
    this.camera = camera
    // Any manual input stops a running jump.
    canvas.addEventListener('pointerdown', this.stopJump)
    canvas.addEventListener('keydown', this.stopJump)
    window.addEventListener('pagehide', this.flushPose)
    this.frame = scene.onBeforeRenderObservable.add(() => this.trackPose())
  }

  state(): CameraState {
    return { position: this.camera.position.asArray(), rotation: this.camera.rotation.asArray() }
  }

  /** Moves the camera to a pose: at once, or with a short ease that turns the short way around. */
  goTo(state: CameraState, animate = true) {
    this.stopJump()
    const camera = this.camera
    const toPos = Vector3.FromArray(state.position)
    const toRot = Vector3.FromArray(state.rotation)
    if (!animate) {
      camera.position.copyFrom(toPos)
      camera.rotation.copyFrom(toRot)
      return
    }
    const fromPos = camera.position.clone()
    const fromRot = camera.rotation.clone()
    const dYaw = Math.atan2(Math.sin(toRot.y - fromRot.y), Math.cos(toRot.y - fromRot.y))
    const start = performance.now()
    this.jump = this.scene.onBeforeRenderObservable.add(() => {
      const t = Math.min(1, (performance.now() - start) / JUMP_MS)
      const k = easeInOut(t)
      camera.position.copyFrom(Vector3.Lerp(fromPos, toPos, k))
      camera.rotation.set(fromRot.x + (toRot.x - fromRot.x) * k, fromRot.y + dYaw * k, 0)
      if (t >= 1) this.stopJump()
    })
  }

  readonly stopJump = () => {
    if (this.jump) this.scene.onBeforeRenderObservable.remove(this.jump)
    this.jump = null
  }

  setFov(degrees: number) {
    this.camera.fov = (degrees * Math.PI) / 180
  }

  /** Shift held: moves several times as fast. */
  setFast(on: boolean) {
    this.camera.speed = WALK_SPEED * (on ? FAST_FACTOR : 1)
  }

  /** A venue is on screen: the camera goes where it was left in it, else to `fallback`, and remembers its moves for it. */
  showVenue(venueId: string, fallback: CameraState | undefined) {
    const start = loadPose(venueId) ?? fallback
    if (start) this.goTo(start, false)
    this.venueId = venueId
    this.lastPose = ''
  }

  /** No venue on screen: moves are not remembered. */
  leaveVenue() {
    this.venueId = null
  }

  /** While off, moves are not remembered (a temporary look, such as the plan view, is not where to start next time). */
  setRemembering(on: boolean) {
    this.remembering = on
  }

  /** Writes a pending pose now (the page closing, the view going away). */
  readonly flushPose = () => {
    if (!this.venueId || !this.poseTimer) return
    clearTimeout(this.poseTimer)
    this.poseTimer = undefined
    savePose(this.venueId, this.state())
  }

  dispose() {
    this.stopJump()
    this.flushPose()
    this.scene.onBeforeRenderObservable.remove(this.frame)
    this.canvas.removeEventListener('pointerdown', this.stopJump)
    this.canvas.removeEventListener('keydown', this.stopJump)
    window.removeEventListener('pagehide', this.flushPose)
    this.camera.dispose()
  }

  /** Saves the pose shortly after it stops changing, under the venue on screen. */
  private trackPose() {
    if (!this.venueId || !this.remembering) return
    const state = this.state()
    const key = [...state.position, ...state.rotation].map((n) => n.toFixed(3)).join(',')
    if (key === this.lastPose) return
    this.lastPose = key
    const id = this.venueId
    clearTimeout(this.poseTimer)
    this.poseTimer = setTimeout(() => savePose(id, state), REMEMBER_AFTER_MS)
  }
}
