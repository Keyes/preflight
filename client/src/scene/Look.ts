import { Color3, DefaultRenderingPipeline, HemisphericLight, ImageProcessingConfiguration, Scene, Vector3, type Camera } from '@babylonjs/core'

/** What the look is set from: the settings' Look section, and the venue's haze and room light. */
export interface LookSettings {
  toneMapping: 'off' | 'neutral' | 'aces'
  /** stops: 0 is as rendered */
  exposure: number
  /** 0..1 */
  bloom: number
  /** 0..1 */
  haze: number
  /** the room light, 0..1 */
  ambient: number
}

/**
 * How the picture looks: the scene is rendered in high dynamic range, then bloom and tone mapping are applied; haze lays
 * fog over distant surfaces; and the room light, a soft light from all around, lights what the rig does not.
 */
export class Look {
  private readonly pipeline: DefaultRenderingPipeline
  private readonly roomLight: HemisphericLight
  private roomLightAsSet = 0
  private roomLightAtLeast = 0

  constructor(
    private readonly scene: Scene,
    camera: Camera,
    settings: LookSettings,
  ) {
    this.pipeline = new DefaultRenderingPipeline('look', true, scene, [camera])
    this.pipeline.samples = 4 // anti-aliasing (the canvas's own is bypassed while rendering through the pipeline)
    this.pipeline.fxaaEnabled = false
    this.pipeline.bloomKernel = 48
    this.pipeline.bloomScale = 0.5
    this.pipeline.bloomThreshold = 1.0
    this.roomLight = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene)
    this.roomLight.groundColor = new Color3(0.45, 0.45, 0.5) // also lights surfaces that face down (the ceiling)
    this.apply(settings)
  }

  apply(settings: LookSettings) {
    const processing = this.scene.imageProcessingConfiguration
    processing.toneMappingEnabled = settings.toneMapping !== 'off'
    processing.toneMappingType =
      settings.toneMapping === 'aces' ? ImageProcessingConfiguration.TONEMAPPING_ACES : ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL
    processing.exposure = 2 ** settings.exposure

    this.pipeline.bloomEnabled = settings.bloom > 0.001
    this.pipeline.bloomWeight = settings.bloom * 0.7

    // Haze also thins out the view of distant surfaces. The fog color stays dark and rises a little with the room light,
    // so house lights up means a lighter haze, as in a real room.
    this.scene.fogMode = Scene.FOGMODE_EXP2
    this.scene.fogDensity = settings.haze * 0.04
    const level = 0.02 + settings.ambient * 0.1
    this.scene.fogColor.set(level, level, level * 1.2)

    this.roomLightAsSet = settings.ambient
    this.roomLight.intensity = Math.max(this.roomLightAsSet, this.roomLightAtLeast)
  }

  /** At least this much room light, whatever it is set to (the plan view must show the floor); 0 goes back to as set. */
  setRoomLightAtLeast(level: number) {
    this.roomLightAtLeast = level
    this.roomLight.intensity = Math.max(this.roomLightAsSet, level)
  }

  /** Less multisampling for a very large picture, so it fits in GPU memory (FXAA for the largest). Returns what puts it back. */
  forPicture(pixels: number): () => void {
    const previous = { samples: this.pipeline.samples, fxaa: this.pipeline.fxaaEnabled }
    this.pipeline.samples = pixels > 9_000_000 ? 1 : pixels > 5_000_000 ? 2 : 4
    this.pipeline.fxaaEnabled = this.pipeline.samples === 1
    return () => {
      this.pipeline.samples = previous.samples
      this.pipeline.fxaaEnabled = previous.fxaa
    }
  }

  dispose() {
    this.pipeline.dispose()
    this.roomLight.dispose()
  }
}
