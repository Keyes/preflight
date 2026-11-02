import type { IncomingMessage, ServerResponse } from 'node:http'
import { check, type Schema } from '@preflight/shared'

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** The request body as parsed JSON, up to `limit` bytes (an empty body is `{}`). */
async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'body too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new HttpError(400, 'invalid JSON')
  }
}

/** A value checked against a schema from shared/, as the schema returns it; a 400 says what does not fit. */
export function checked<T>(schema: Schema<T>, value: unknown): T {
  const result = check(schema, value)
  if (!result.ok) throw new HttpError(400, result.problem)
  return result.value
}

/** The JSON body checked against its schema from shared/ (see requests.ts), as the schema returns it. */
export async function readBody<T>(req: IncomingMessage, schema: Schema<T>, limit = 64 * 1024): Promise<T> {
  return checked(schema, await readJson(req, limit))
}
