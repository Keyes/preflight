import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HttpError } from './http.js'

/** What an upload may be: how large, and what its first bytes must look like. */
export interface UploadRules {
  maxBytes: number
  /** the 413 message, naming the kind of file */
  tooLarge: string
  /** how many bytes from the start tell the kind of file */
  headBytes: number
  /** what is wrong with a file that starts like this (the head can be shorter for a small file), or null when it is fine */
  checkHead: (head: Buffer) => string | null
}

/**
 * Streams an upload to `target`, hashing it and checking its size and its first bytes as they arrive, so a wrong or too
 * large file is refused without being stored whole. When it is refused, nothing is left at `target`.
 */
export async function receiveFile(body: Readable, target: string, rules: UploadRules): Promise<{ hash: string; head: Buffer }> {
  const hash = createHash('sha256')
  let size = 0
  let head = Buffer.alloc(0)
  const guard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length
      if (size > rules.maxBytes) return cb(new HttpError(413, rules.tooLarge))
      if (head.length < rules.headBytes) {
        head = Buffer.concat([head, chunk]).subarray(0, rules.headBytes)
        const problem = head.length === rules.headBytes ? rules.checkHead(head) : null
        if (problem) return cb(new HttpError(400, problem))
      }
      hash.update(chunk)
      cb(null, chunk)
    },
  })
  try {
    await pipeline(body, guard, createWriteStream(target))
    // a file shorter than the head has not been checked yet
    const problem = size === 0 ? 'empty upload' : head.length < rules.headBytes ? rules.checkHead(head) : null
    if (problem) throw new HttpError(400, problem)
  } catch (err) {
    await rm(target, { force: true })
    throw err
  }
  return { hash: hash.digest('hex'), head }
}
