import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { test } from 'node:test'
import { HttpError } from './http.js'
import { createRouter, type Route } from './router.js'

const res = {} as ServerResponse
const request = (method: string) => ({ method }) as IncomingMessage

/** A router whose handlers say which route answered, with what parameters. */
function routerOf(paths: [Route['method'], string][]) {
  let answered = ''
  const dispatch = createRouter(
    paths.map(([method, path]) => ({ method, path, handler: ({ params }) => void (answered = `${method} ${path} ${JSON.stringify(params)}`) })),
  )
  return async (method: string, path: string) => {
    answered = ''
    await dispatch(request(method), res, path)
    return answered
  }
}

test('hands a request to the first route that matches, with the parts of the path by name', async () => {
  const route = routerOf([
    ['POST', '/api/venues/demo'],
    ['GET', '/api/venues/:id'],
    ['GET', '/api/venues/:id/model.glb'],
  ])
  assert.equal(await route('POST', '/api/venues/demo'), 'POST /api/venues/demo {}')
  assert.equal(await route('GET', '/api/venues/demo'), 'GET /api/venues/:id {"id":"demo"}')
  assert.equal(await route('GET', '/api/venues/abc/model.glb'), 'GET /api/venues/:id/model.glb {"id":"abc"}')
})

test('a path no route has is a 404, a known path with another method a 405', async () => {
  const route = routerOf([['GET', '/api/venues/:id/model.glb']])
  const status = (method: string, path: string) =>
    route(method, path).then(
      () => 200,
      (err: HttpError) => err.status,
    )
  assert.equal(await status('GET', '/api/venues/abc/modelxglb'), 404) // the dot is a dot, not any character
  assert.equal(await status('GET', '/api/venues/a/b/model.glb'), 404) // a parameter is one part of the path
  assert.equal(await status('DELETE', '/api/venues/abc/model.glb'), 405)
})
