import type { IncomingMessage, ServerResponse } from 'node:http'

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

/** The request body as parsed JSON. The caller checks every field it uses (see the `clean…` functions). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped until request bodies are checked against schemas (docs/architecture.md)
export async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<any> {
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
