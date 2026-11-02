import type { Camera, Engine, Observer, Scene } from '@babylonjs/core'

/**
 * Frame time we try to stay under while the view is changing (30 fps). This is a planning tool, so sharpness
 * matters more than smoothness; a higher target would trade quality for frame rate during movement.
 */
const TARGET_FRAME_MS = 1000 / 30
/** The view counts as settled, and goes back to full resolution, after this long without changes. */
const IDLE_MS = 450
/** Render-size divisors tried in order while moving: 1 = full resolution. */
const STEPS = [1, 1.25, 1.5, 2, 2.5, 3, 4]
const EPSILON = 1e-5
/** While moving, how soon to try a sharper step after settling on one, and how far that wait can back off. */
const PROBE_MIN_MS = 2500
const PROBE_MAX_MS = 20000
/** How long a sharper step has to hold the frame rate before it counts as good. */
const TRIAL_MS = 800

type Viewpoint = Camera & { position: { asArray(): number[] }; rotation: { asArray(): number[] }; fov: number }

/**
 * Keeps interaction smooth by lowering the render resolution while something changes (camera
 * moves, fixture edits, gizmo drags) and restoring it once things settle. It only steps down
 * when measured frame times need it, so a fast GPU never loses quality. It remembers how far it
 * had to go so the next movement starts at that level instead of stuttering first, and now and
 * then tries one notch sharper, because a frame-rate cap hides how much headroom there is.
 */
export class QualityGovernor {
  enabled = true

  /** the render size while still, as a fraction of the display's native resolution (per axis) */
  private rest = 1
  /** the lowest size, in the same fraction, the governor may go to while moving */
  private floor = 1 / 4
  /** while paused the render size is left alone (a screenshot is changing it on purpose) */
  private paused = false
  private step = 0
  /** step reached during the last movement; where the next movement starts */
  private learned = 0
  private moving = false
  private lastActivity = -Infinity
  private lastStepChange = 0
  private frameMs = TARGET_FRAME_MS
  /** frames to ignore after a resize, which itself causes a hitch */
  private warmup = 0
  /** wait before the next attempt at a sharper step; doubles when an attempt fails */
  private probeMs = PROBE_MIN_MS
  /** set while a sharper step is on trial: the step to fall back to if it can't hold the frame rate */
  private trialFrom: number | null = null
  private slowFrames = 0
  private lastView: number[] = []
  private observer: Observer<Scene> | null

  constructor(
    private engine: Engine,
    scene: Scene,
    private camera: Viewpoint,
  ) {
    this.observer = scene.onBeforeRenderObservable.add(() => this.onFrame())
    this.apply()
  }

  /** The render size while the view is still, as a fraction of the display's native resolution per axis. */
  setRestFraction(fraction: number) {
    this.rest = fraction
    this.apply()
  }

  /** How low the render size may go while moving, as a fraction of the display's native resolution per axis. */
  setMovingFloor(fraction: number) {
    this.floor = fraction
    if (this.moving && this.enabled && this.step > this.maxStep()) this.setStep(this.maxStep())
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled
    if (!enabled) {
      this.step = 0
      this.trialFrom = null
      this.apply()
    }
  }

  pause() {
    this.paused = true
  }

  resume() {
    this.paused = false
    this.apply()
  }

  /** Signals that something visible is changing even though the camera is not (rig edits, haze, ...). */
  touch() {
    this.lastActivity = performance.now()
  }

  /** Re-reads the display pixel ratio, e.g. after the window moved to another screen. */
  refresh() {
    this.apply()
  }

  /** Current render scale relative to CSS pixels (1 = one render pixel per CSS pixel). */
  get renderScale() {
    return 1 / this.engine.getHardwareScalingLevel()
  }

  get isMoving() {
    return this.moving
  }

  dispose() {
    this.observer?.remove()
    this.observer = null
  }

  /** The hardware scaling level for the size at rest (native resolution is 1 over the display's pixel ratio). */
  private baseLevel() {
    return 1 / (Math.max(1, window.devicePixelRatio || 1) * this.rest)
  }

  /** Highest step that still renders at least the moving floor (steps shrink the size at rest further). */
  private maxStep() {
    let max = 0
    STEPS.forEach((factor, i) => {
      if (this.rest / factor >= this.floor - 1e-9) max = i
    })
    return max
  }

  private setStep(step: number) {
    if (step === this.step) return
    this.step = step
    this.learned = step
    this.apply()
  }

  private apply() {
    if (this.paused) return
    const level = this.baseLevel() * STEPS[this.step]
    if (Math.abs(level - this.engine.getHardwareScalingLevel()) > 1e-6) {
      this.engine.setHardwareScalingLevel(level)
      this.warmup = 3
      this.lastStepChange = performance.now()
      this.frameMs = TARGET_FRAME_MS
    }
  }

  private onFrame() {
    if (this.paused) return
    const now = performance.now()

    const view = [...this.camera.position.asArray(), ...this.camera.rotation.asArray(), this.camera.fov]
    if (view.some((v, i) => Math.abs(v - (this.lastView[i] ?? Infinity)) > EPSILON)) this.lastActivity = now
    this.lastView = view

    const moving = now - this.lastActivity < IDLE_MS
    if (moving !== this.moving) {
      this.moving = moving
      this.step = moving && this.enabled ? Math.min(this.learned, this.maxStep()) : 0
      this.trialFrom = null
      this.apply()
    }
    if (!moving || !this.enabled) return

    const dt = this.engine.getDeltaTime()
    if (this.warmup > 0) {
      this.warmup--
      return
    }
    this.frameMs = this.frameMs * 0.6 + dt * 0.4
    const sinceChange = now - this.lastStepChange

    if (this.trialFrom !== null) {
      // A sharper step is on trial: judge it on single frames so a failure reverts within a couple of frames.
      this.slowFrames = dt > TARGET_FRAME_MS * 1.3 ? this.slowFrames + 1 : 0
      if (this.slowFrames >= 2) {
        const back = this.trialFrom
        this.trialFrom = null
        this.probeMs = Math.min(PROBE_MAX_MS, this.probeMs * 2)
        this.setStep(back)
      } else if (sinceChange > TRIAL_MS) {
        this.trialFrom = null // it held; keep going sharper at the normal pace
        this.probeMs = PROBE_MIN_MS
      }
      return
    }

    const max = this.maxStep()
    if (this.frameMs > TARGET_FRAME_MS * 1.15 && sinceChange > 150 && this.step < max) {
      // Cost is mostly per pixel, so it scales with the square of the render-size divisor:
      // jump to the step that should bring the frame time under budget.
      const wanted = STEPS[this.step] * Math.sqrt(this.frameMs / (TARGET_FRAME_MS * 0.9))
      const index = STEPS.findIndex((f) => f >= wanted)
      // Normally at most two steps at a time (one slow frame must not drag quality to the floor), more
      // when frames are far over budget. Wait longer before trying the sharper level again.
      const reach = this.frameMs > TARGET_FRAME_MS * 2.5 ? 4 : 2
      this.probeMs = Math.min(PROBE_MAX_MS, this.probeMs * 2)
      this.setStep(Math.min(max, index === -1 ? max : index, this.step + reach))
    } else if (this.step > 0 && sinceChange > this.probeMs && this.frameMs < TARGET_FRAME_MS * 1.05) {
      this.trialFrom = this.step
      this.slowFrames = 0
      this.setStep(this.step - 1)
    }
  }
}
