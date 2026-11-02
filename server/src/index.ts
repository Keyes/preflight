import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'
import { HttpError, sendJson } from './http.js'
import { requestAllowed } from './origin.js'
import { createRouter } from './router.js'
import { catalogRoutes } from './routes/catalog.js'
import { modelRoutes } from './routes/models.js'
import { riderRoutes } from './routes/rider.js'
import { venueRoutes } from './routes/venues.js'

const PORT = Number(process.env.PORT ?? 3001)
// Only this machine by default: there is no login. HOST=0.0.0.0 opens it to the network.
const HOST = process.env.HOST ?? '127.0.0.1'

const dispatch = createRouter([
  { method: 'GET', path: '/api/health', handler: ({ res }) => sendJson(res, 200, { ok: true }) },
  ...catalogRoutes,
  ...venueRoutes,
  ...modelRoutes,
  ...riderRoutes,
])

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (!requestAllowed(req.headers)) throw new HttpError(403, 'request from another site or host refused (see PREFLIGHT_ALLOWED_HOSTS in the README)')
  await dispatch(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message })
    console.error(err)
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
    else res.destroy()
  })
})

// Later: DMX/Art-Net frames get pushed to clients over this socket.
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }: { req: IncomingMessage }) => requestAllowed(req.headers) })
wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'hello' }))
})

server.listen(PORT, HOST, () => console.log(`preflight server on ${HOST}:${PORT}`))
