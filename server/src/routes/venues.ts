import {
  appendBody,
  createVenueBody,
  crowdSchema,
  fixtureListSchema,
  fixturesBody,
  groupListSchema,
  venueOrderBody,
  venuePatchBody,
  viewsBody,
  type Crowd,
  type Fixture,
  type FixtureGroup,
  type Venue,
} from '@preflight/shared'
import { checked, HttpError, readBody, sendJson } from '../http.js'
import type { Route } from '../router.js'
import { createDemoVenue } from '../services/demo.js'
import { createVenue, deleteVenue, duplicateVenue, getVenue, listVenues, reorderVenues, updateVenue } from '../services/venues.js'

/** Lights, groups and crowd zones copied to another venue arrive in bodies up to this size. */
const LIGHTS_LIMIT = 1024 * 1024

/** The crowd options a venue gets with its first zones, when it has no crowd yet. */
const DEFAULT_CROWD: Crowd = { shown: true, density: 0.5, motion: 'sway', intensity: 0.5, zones: [] }

/** The venue a path names, or a 404. */
export async function venueOf(id: string): Promise<Venue> {
  const venue = await getVenue(id)
  if (!venue) throw new HttpError(404, 'venue not found')
  return venue
}

/** Groups keep only lights that exist in the same save, once each, so deleted lights do not pile up in them. */
function keepKnownMembers(groups: FixtureGroup[], fixtures: readonly Fixture[]): FixtureGroup[] {
  const known = new Set(fixtures.map((f) => f.id))
  return groups.map((group) => ({ ...group, fixtureIds: [...new Set(group.fixtureIds.filter((id) => known.has(id)))] }))
}

/** The venues, and what is saved with each: lights and groups, views, haze, crowd, hidden model parts. */
export const venueRoutes: Route[] = [
  { method: 'GET', path: '/api/venues', handler: async ({ res }) => sendJson(res, 200, await listVenues()) },
  {
    method: 'POST',
    path: '/api/venues',
    handler: async ({ req, res }) => sendJson(res, 201, await createVenue((await readBody(req, createVenueBody)).name)),
  },
  { method: 'POST', path: '/api/venues/demo', handler: async ({ res }) => sendJson(res, 201, await createDemoVenue()) },
  {
    method: 'PUT',
    path: '/api/venues/order',
    handler: async ({ req, res }) => sendJson(res, 200, await reorderVenues((await readBody(req, venueOrderBody)).ids)),
  },
  { method: 'GET', path: '/api/venues/:id', handler: async ({ res, params }) => sendJson(res, 200, await venueOf(params.id)) },
  {
    method: 'PATCH',
    path: '/api/venues/:id',
    handler: async ({ req, res, params }) => {
      const { id } = await venueOf(params.id)
      sendJson(res, 200, await updateVenue(id, await readBody(req, venuePatchBody)))
    },
  },
  {
    method: 'DELETE',
    path: '/api/venues/:id',
    handler: async ({ res, params }) => {
      await deleteVenue((await venueOf(params.id)).id)
      res.writeHead(204).end()
    },
  },
  {
    method: 'POST',
    path: '/api/venues/:id/duplicate',
    handler: async ({ res, params }) => sendJson(res, 201, await duplicateVenue((await venueOf(params.id)).id)),
  },
  {
    method: 'PUT',
    path: '/api/venues/:id/views',
    handler: async ({ req, res, params }) => {
      const { id } = await venueOf(params.id)
      const { views } = await readBody(req, viewsBody)
      sendJson(res, 200, await updateVenue(id, { views }))
    },
  },
  {
    method: 'PUT',
    path: '/api/venues/:id/fixtures',
    handler: async ({ req, res, params }) => {
      const { id } = await venueOf(params.id)
      const { fixtures, groups } = await readBody(req, fixturesBody, LIGHTS_LIMIT)
      sendJson(res, 200, await updateVenue(id, { fixtures, ...(groups ? { groups: keepKnownMembers(groups, fixtures) } : {}) }))
    },
  },
  // Adds lights, groups and crowd zones (copied from another venue) to the ones already there. Their ids must be new; the
  // crowd's options stay as they are.
  {
    method: 'POST',
    path: '/api/venues/:id/append',
    handler: async ({ req, res, params }) => {
      const venue = await venueOf(params.id)
      const added = await readBody(req, appendBody, LIGHTS_LIMIT)
      const fixtures = checked(fixtureListSchema, [...(venue.fixtures ?? []), ...added.fixtures])
      const groups = keepKnownMembers(checked(groupListSchema, [...(venue.groups ?? []), ...added.groups]), fixtures)
      const patch: Partial<Venue> = { fixtures, groups }
      if (added.zones.length) {
        const base = venue.crowd ?? DEFAULT_CROWD
        patch.crowd = checked(crowdSchema, { ...base, zones: [...base.zones, ...added.zones] })
      }
      sendJson(res, 200, await updateVenue(venue.id, patch))
    },
  },
]
