import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError } from './http.js'

/** What a route's handler is given: the request, the response, and the varying parts of the path by name. */
export interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  params: Record<string, string>
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** the path as it is requested, with `:name` for a part that varies: "/api/venues/:id/model.glb" */
  path: string
  handler: (ctx: RouteContext) => void | Promise<void>
}

/** A path with `:name` parts as a regular expression with a named group for each. */
function pattern(path: string): RegExp {
  const parts = path.split('/').map((part) => (part.startsWith(':') ? `(?<${part.slice(1)}>[^/]+)` : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  return new RegExp(`^${parts.join('/')}$`)
}

/**
 * Hands a request to the first route whose method and path match. Routes are tried in the order given, so a fixed path
 * goes before one with a `:name` part that would match it too. A path no route has is a 404; a known path asked for with
 * another method is a 405.
 */
export function createRouter(routes: readonly Route[]) {
  const table = routes.map((route) => ({ ...route, pattern: pattern(route.path) }))
  return async function dispatch(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    let pathKnown = false
    for (const route of table) {
      const match = route.pattern.exec(path)
      if (!match) continue
      pathKnown = true
      if (route.method === req.method) return route.handler({ req, res, params: match.groups ?? {} })
    }
    throw pathKnown ? new HttpError(405, `${req.method} is not allowed here`) : new HttpError(404, 'not found')
  }
}
