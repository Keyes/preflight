/**
 * How many lights can do the costly things at once. The rig keeps to these (scene/FixtureRig.ts), and the inspector and
 * the settings tell the user about them.
 */

/** How many lights can cast shadows at once (each is a regular light with its own shadow map, outside the clustered system). */
export const MAX_SHADOW_LIGHTS = 10
/**
 * How many lights can project a gobo pattern onto surfaces at once. The clustered system cannot carry textures, so each
 * of these is a regular light too (and a light that also casts shadows only counts once).
 */
export const MAX_GOBO_LIGHTS = 4
/** Most lights that can be outside the clustered system at once. */
export const MAX_REGULAR_LIGHTS = MAX_SHADOW_LIGHTS + MAX_GOBO_LIGHTS
