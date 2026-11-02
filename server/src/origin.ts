import { isIP } from 'node:net'
import type { IncomingHttpHeaders } from 'node:http'

/**
 * Who may talk to the server. There is no login, so two things keep other websites out:
 *
 * - The Host header must name this machine or an address (localhost, *.localhost, or an IP like 127.0.0.1 or a LAN
 *   address), or a name listed in PREFLIGHT_ALLOWED_HOSTS. A website that points its own name at 127.0.0.1 (DNS
 *   rebinding) is refused, so it cannot read or change venues as if it were the app.
 * - A request that carries an Origin header (browsers send one on cross-site requests and on every POST, PUT and DELETE)
 *   must come from the same host it is sent to. A page on another site cannot create, upload or delete anything here.
 *
 * Requests without an Origin, such as curl or the command line tools, only need an allowed Host.
 */

const extraHosts = () =>
  (process.env.PREFLIGHT_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)

/** The host name of a Host header value ("localhost:5173" -> "localhost", "[::1]:3001" -> "::1"), lower case. */
function hostname(host: string): string {
  const h = host.trim().toLowerCase()
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'))
  const colon = h.lastIndexOf(':')
  return colon >= 0 && h.indexOf(':') === colon ? h.slice(0, colon) : h
}

export function hostAllowed(host: string | undefined): boolean {
  if (!host) return false
  const name = hostname(host)
  return name === 'localhost' || name.endsWith('.localhost') || isIP(name) !== 0 || extraHosts().includes(name)
}

export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true
  if (!host) return false
  try {
    return new URL(origin).host.toLowerCase() === host.trim().toLowerCase()
  } catch {
    return false // "null" (sandboxed frames, files) and anything else that is not a URL
  }
}

/** Whether a request (or WebSocket handshake) with these headers may be served. */
export function requestAllowed(headers: IncomingHttpHeaders): boolean {
  return hostAllowed(headers.host) && originAllowed(headers.origin, headers.host)
}
