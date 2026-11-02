import * as z from 'zod'
import {
  atmosphereSchema,
  crowdSchema,
  crowdZoneSchema,
  fixtureGroupSchema,
  fixtureListSchema,
  fixtureSchema,
  groupListSchema,
  hiddenTagsSchema,
  nameSchema,
  viewListSchema,
} from './venue.js'

/**
 * The body of every JSON request the client sends, by route. The server checks each body against its schema before it
 * touches anything, and works with what the schema returns.
 */

/** POST /api/venues */
export const createVenueBody = z.object({ name: nameSchema })

/** PUT /api/venues/order: every venue's id, in the new order */
export const venueOrderBody = z.object({ ids: z.array(z.string()).max(1000) })

/** PATCH /api/venues/:id: any of these, at least one */
export const venuePatchBody = z
  .object({ name: nameSchema.optional(), atmosphere: atmosphereSchema.optional(), crowd: crowdSchema.optional(), hiddenTags: hiddenTagsSchema.optional() })
  .refine((body) => Object.values(body).some((v) => v !== undefined), 'nothing to change')

/** PUT /api/venues/:id/views: all of the venue's saved views */
export const viewsBody = z.object({ views: viewListSchema })

/** PUT /api/venues/:id/fixtures: all of the venue's lights, and its groups when they changed */
export const fixturesBody = z.object({ fixtures: fixtureListSchema, groups: groupListSchema.optional() })

/** POST /api/venues/:id/append: lights, groups and crowd zones (copied from another venue, with new ids) to add */
export const appendBody = z.object({
  fixtures: z.array(fixtureSchema).default([]),
  groups: z.array(fixtureGroupSchema).default([]),
  zones: z.array(crowdZoneSchema).default([]),
})

const meters = z.number().min(-1e6).max(1e6)

/** POST /api/venues/:id/rider/plan: which vision model reads the plan, and on which page */
export const riderPlanBody = z.object({
  provider: z.string().default('anthropic'),
  /** the user's own key for the provider; the server's environment has one otherwise */
  apiKey: z.string().max(500).optional(),
  model: z.string().max(200).optional(),
  /** 1-based; the page the plan was found on before, else 2 */
  page: z.int().positive().optional(),
})

/** POST /api/venues/:id/rider/drafts: how the plan lies in the venue, and the user's choices so far */
export const riderDraftsBody = z.object({
  /** plan pixels to venue meters (see similarity.ts) */
  similarity: z.object({ scale: z.number().min(1e-6).max(1e3), theta: z.number().min(-100).max(100), tx: meters, tz: meters }),
  /** a catalog fixture id, by rider number ("#201") or fixture text ("type:expolite tourled mc60 zoom") */
  overrides: z.record(z.string().max(120), z.string().max(80)).default({}),
  ceilingHeight: z.number().min(0).max(100).optional(),
  standHeight: z.number().min(0).max(20).optional(),
})

/** A schema from this package, for code that checks values against one without importing zod itself. */
export type Schema<T> = z.ZodType<T>

/**
 * Checks a value against a schema: the value as the schema returns it, or what is wrong with it in words, with where in the
 * value it is ("fixtures.3.position: …").
 */
export function check<T>(schema: Schema<T>, value: unknown): { ok: true; value: T } | { ok: false; problem: string } {
  const result = schema.safeParse(value)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  return { ok: false, problem: issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message }
}
