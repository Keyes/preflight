import * as z from 'zod'

/**
 * A venue as the server stores it and the client edits it. The parts the client sends are schemas, which the server checks
 * every request body against; their types are inferred from the schemas, so each shape is written once. A schema also says
 * how a value is tidied on the way in (names trimmed, rotations normalized, ids made unique).
 */

/** An id the client made (a UUID). */
const id = z.string().min(1).max(64)

/** What a light, group, view or zone is called. */
export const nameSchema = z.string().trim().min(1, 'must be 1 to 80 characters').max(80, 'must be 1 to 80 characters')

/** A list of things with ids: at most `max` of them, and no id twice. */
function listWithIds<T extends z.ZodType<{ id: string }>>(item: T, max: number) {
  return z
    .array(item)
    .max(max)
    .refine((list) => new Set(list.map((x) => x.id)).size === list.length, 'every id must be unique')
}

const vec3 = z.tuple([z.number(), z.number(), z.number()])

export const cameraViewSchema = z.object({
  id,
  name: nameSchema,
  /** world position in meters (glTF axes, Y up) */
  position: vec3,
  /** Babylon camera rotation in radians: [pitch, yaw, roll] */
  rotation: vec3,
})
export type CameraView = z.infer<typeof cameraViewSchema>
export const viewListSchema = listWithIds(cameraViewSchema, 100)

/** A short text from a rider: a number, a lamp id, a truss name. */
const riderText = z.string().min(1).max(40)

/** Where a light comes from in a venue's tech rider: its number there, and its place in the patch. */
export const fixturePatchSchema = z.object({
  /** the rider's number ("#201") */
  fixId: riderText,
  /** the lamp's id when the rider draws that number more than once ("#1.2") */
  lampId: riderText.optional(),
  universe: z.int().min(1),
  /** DMX start address, 1-512 */
  address: z.int().min(1).max(512),
  /** the truss as the patch names it ("LX2") */
  truss: riderText.optional(),
})
export type FixturePatch = z.infer<typeof fixturePatchSchema>

/** An orientation as a quaternion [x, y, z, w], stored at length 1. */
const quaternion = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine((q) => Math.hypot(...q) >= 1e-6, 'a rotation cannot be all zeros')
  .transform((q): [number, number, number, number] => {
    const length = Math.hypot(...q)
    return [q[0] / length, q[1] / length, q[2] / length, q[3] / length]
  })

/** A fixture's attribute values: at most 32, each 0..1, keyed by attribute name ("pan", "dimmer", "red"). */
const fixtureValues = z
  .record(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,31}$/), z.number().min(0).max(1))
  .refine((values) => Object.keys(values).length <= 32, 'at most 32 values')

/** A placed light. `values` are normalized 0..1 like DMX channels, keyed by attribute name (pan, tilt, dimmer, zoom, red, green, blue, ...). */
export const fixtureSchema = z.object({
  id,
  name: nameSchema,
  profileId: z.string().min(1).max(64),
  /** world position of the base, meters (glTF axes, Y up) */
  position: vec3,
  /** hanging: base on a ceiling or truss, head points down; standing: base on a floor, head points up.
   *  Only the starting point for fixtures without `rotation` (older data); `rotation` wins when present. */
  mount: z.enum(['hanging', 'standing']),
  /** rotation of the base around the vertical axis, radians (see `mount`) */
  yaw: z.number(),
  /** orientation of the base as a quaternion [x, y, z, w]; the fixture's local +Y axis points away from its mount */
  rotation: quaternion.optional(),
  /** the DMX mode this fixture runs in, by the name the fixture catalog gives it (informational for now) */
  mode: z.string().max(80).optional(),
  /** whether this light casts shadows (default true; only a limited number of lights can at once) */
  castShadows: z.boolean().optional(),
  /** the rider's patch data (absent for a light placed by hand) */
  patch: fixturePatchSchema.optional(),
  values: fixtureValues.default({}),
})
export type Fixture = z.infer<typeof fixtureSchema>
export const fixtureListSchema = listWithIds(fixtureSchema, 500)

/** A named, ordered set of lights. The order is the order the lights are meant to be worked in (fans, chases). */
export const fixtureGroupSchema = z.object({
  id,
  name: nameSchema,
  fixtureIds: z.array(z.string()).max(500),
})
export type FixtureGroup = z.infer<typeof fixtureGroupSchema>
export const groupListSchema = listWithIds(fixtureGroupSchema, 100)

const unit = z.number().min(0).max(1)

/** How a venue's air and room look: both 0..1 (see the viewer's Haze and Room light settings). */
export const atmosphereSchema = z.object({ haze: unit, ambient: unit })
export type Atmosphere = z.infer<typeof atmosphereSchema>

/** A coordinate in a venue, meters. */
const coord = z.number().min(-10000).max(10000)

/** An area where people stand: a rectangle (corners in world meters) on a horizontal plane at height `y`. */
export const crowdZoneSchema = z.object({
  id,
  name: nameSchema,
  x0: coord,
  z0: coord,
  x1: coord,
  z1: coord,
  y: coord,
  /** the point (x, z) the people face, or null for every direction */
  facing: z.tuple([coord, coord]).nullable(),
  /** false hides this zone's people */
  shown: z.boolean().default(true),
})
export type CrowdZone = z.infer<typeof crowdZoneSchema>

/** The crowd of a venue: where it stands (zones), and how many people, how they move, and whether it shows at all. */
export const crowdSchema = z.object({
  shown: z.boolean(),
  /** 0..1 of a packed standing crowd */
  density: unit,
  motion: z.enum(['still', 'sway', 'dance']),
  /** 0..1, how strongly they move */
  intensity: unit,
  zones: listWithIds(crowdZoneSchema, 50),
})
export type Crowd = z.infer<typeof crowdSchema>

/** Names of a model's parts switched off in the viewer: each name once. */
export const hiddenTagsSchema = z
  .array(z.string().min(1).max(200))
  .max(500)
  .transform((tags) => [...new Set(tags)])

export type VenueStatus = 'empty' | 'ready' | 'error'

/** A venue as the server stores it. The server makes the record; the client changes it part by part (see requests.ts). */
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
