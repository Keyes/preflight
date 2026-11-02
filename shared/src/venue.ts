/** A venue as the server stores it and the client edits it. */

export interface CameraView {
  id: string
  name: string
  /** world position in meters (glTF axes, Y up) */
  position: [number, number, number]
  /** Babylon camera rotation in radians: [pitch, yaw, roll] */
  rotation: [number, number, number]
}

/** Where a light comes from in a venue's tech rider: its number there, and its place in the patch. */
export interface FixturePatch {
  /** the rider's number ("#201") */
  fixId: string
  /** the lamp's id when the rider draws that number more than once ("#1.2") */
  lampId?: string
  universe: number
  /** DMX start address, 1-512 */
  address: number
  /** the truss as the patch names it ("LX2") */
  truss?: string
}

/** A placed light. `values` are normalized 0..1 like DMX channels, keyed by attribute name (pan, tilt, dimmer, zoom, red, green, blue, ...). */
export interface Fixture {
  id: string
  name: string
  profileId: string
  /** world position of the base, meters (glTF axes, Y up) */
  position: [number, number, number]
  /** hanging: base on a ceiling or truss, head points down; standing: base on a floor, head points up.
   *  Only the starting point for fixtures without `rotation` (older data); `rotation` wins when present. */
  mount: 'hanging' | 'standing'
  /** rotation of the base around the vertical axis, radians (see `mount`) */
  yaw: number
  /** orientation of the base as a quaternion [x, y, z, w]; the fixture's local +Y axis points away from its mount */
  rotation?: [number, number, number, number]
  /** the DMX mode this fixture runs in, by the name the fixture catalog gives it (informational for now) */
  mode?: string
  /** whether this light casts shadows (default true; only a limited number of lights can at once) */
  castShadows?: boolean
  /** the rider's patch data (absent for a light placed by hand) */
  patch?: FixturePatch
  values: Record<string, number>
}

/** A named, ordered set of lights. The order is the order the lights are meant to be worked in (fans, chases). */
export interface FixtureGroup {
  id: string
  name: string
  fixtureIds: string[]
}

/** How a venue's air and room look: both 0..1 (see the viewer's Haze and Room light settings). */
export interface Atmosphere {
  haze: number
  ambient: number
}

/** An area where people stand: a rectangle (corners in world meters) on a horizontal plane at height `y`. */
export interface CrowdZone {
  id: string
  name: string
  x0: number
  z0: number
  x1: number
  z1: number
  y: number
  /** the point (x, z) the people face, or null for every direction */
  facing: [number, number] | null
  /** false hides this zone's people */
  shown: boolean
}

/** The crowd of a venue: where it stands (zones), and how many people, how they move, and whether it shows at all. */
export interface Crowd {
  shown: boolean
  /** 0..1 of a packed standing crowd */
  density: number
  motion: 'still' | 'sway' | 'dance'
  /** 0..1, how strongly they move */
  intensity: number
  zones: CrowdZone[]
}

export type VenueStatus = 'empty' | 'ready' | 'error'

export interface Venue {
  id: string
  name: string
  status: VenueStatus
  error?: string
  /** placed lights, in display order */
  fixtures?: Fixture[]
  /** named groups of the placed lights, in display order */
  groups?: FixtureGroup[]
  /** haze and room light for this venue (absent until they are first saved) */
  atmosphere?: Atmosphere
  /** the crowd (absent until the first zone or option is saved) */
  crowd?: Crowd
  /** names of the model's parts switched off in the viewer (SketchUp tags, or a glTF model's top-level nodes) */
  hiddenTags?: string[]
  /** saved camera positions, in display order */
  views?: CameraView[]
  /** position in the venue list; lower comes first */
  sortIndex: number
  /** what the model was uploaded as: 'skp' is converted to model.glb, 'glb' (also a .gltf, wrapped as GLB) is model.glb
   *  as uploaded. Absent for venues from before glTF uploads, which are all SketchUp. */
  modelFormat?: 'skp' | 'glb'
  /** sha256 of the uploaded file; changes when the model is replaced */
  modelHash?: string
  /** build of the converter that produced model.glb (SketchUp models only); a different build converts the model again */
  converterVersion?: string
  createdAt: string
  updatedAt: string
}
