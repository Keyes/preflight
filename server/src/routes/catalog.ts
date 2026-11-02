import type { Route } from '../router.js'
import { catalogJson } from '../services/catalog.js'

/** The fixture catalog the picker offers, as one JSON file. */
export const catalogRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/fixtures/catalog',
    handler: async ({ res }) => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
      res.end(await catalogJson())
    },
  },
]
