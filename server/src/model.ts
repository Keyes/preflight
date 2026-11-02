import { open, readFile, rename, rm, writeFile } from 'node:fs/promises'

/** What an uploaded venue model is: a SketchUp file (converted to GLB) or a glTF model (used as it is). */
export type ModelFormat = 'skp' | 'glb' | 'gltf'

/** How many leading bytes `detectModelFormat` needs. */
export const HEAD_BYTES = 4

// SketchUp files start with a UTF-16 BOM followed by a length-prefixed header.
const SKP_MAGIC = Buffer.from([0xff, 0xfe, 0xff, 0x0e])
const GLB_MAGIC = 0x46546c67 // "glTF"
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

export class ModelError extends Error {}

/** Tells the format from the first bytes of a file (at least `HEAD_BYTES`, fewer only for a shorter file), or null. */
export function detectModelFormat(head: Buffer): ModelFormat | null {
  if (head.length >= 4 && head.subarray(0, 4).equals(SKP_MAGIC)) return 'skp'
  if (head.length >= 4 && head.readUInt32LE(0) === GLB_MAGIC) return 'glb'
  // glTF JSON: an object, maybe after a UTF-8 byte order mark and white space (the rest is checked once it is all there)
  const text = head.subarray(head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0).toString('latin1')
  if (/^\s*(\{|$)/.test(text) && text.length > 0) return 'gltf'
  return null
}

interface GltfJson {
  asset?: { version?: unknown }
  buffers?: { uri?: unknown }[]
  images?: { uri?: unknown }[]
  meshes?: unknown[]
}

const isEmbedded = (uri: unknown) => uri === undefined || (typeof uri === 'string' && uri.startsWith('data:'))

/** Checks the parts of a glTF document the viewer relies on. `binChunk` tells whether a GLB carries a binary chunk. */
export function checkGltf(gltf: unknown, binChunk: boolean): void {
  if (!gltf || typeof gltf !== 'object' || Array.isArray(gltf)) throw new ModelError('not a glTF model')
  const doc = gltf as GltfJson
  const version = typeof doc.asset?.version === 'string' ? doc.asset.version : ''
  if (!version) throw new ModelError('not a glTF model (no asset version)')
  if (!version.startsWith('2.')) throw new ModelError(`glTF ${version} is not supported, only glTF 2.0`)
  if (!Array.isArray(doc.meshes) || doc.meshes.length === 0) throw new ModelError('the model has no meshes')
  const external = [...(doc.buffers ?? []), ...(doc.images ?? [])].map((item) => item?.uri).filter((uri) => !isEmbedded(uri))
  if (external.length) {
    const names = external
      .slice(0, 3)
      .map((uri) => String(uri))
      .join(', ')
    throw new ModelError(`the model refers to separate files (${names}${external.length > 3 ? ', …' : ''}). Export it as a single .glb (glTF Binary) instead`)
  }
  // a buffer without uri is the GLB's binary chunk; a plain .gltf has none
  if ((doc.buffers ?? []).some((b, i) => b?.uri === undefined && !(binChunk && i === 0))) {
    throw new ModelError('the model is missing its binary data')
  }
}

/** Reads and checks the header and JSON chunk of a GLB file, without loading the binary chunk. */
export async function checkGlb(path: string): Promise<void> {
  const file = await open(path)
  try {
    const { size } = await file.stat()
    const header = Buffer.alloc(20)
    await file.read(header, 0, 20, 0)
    if (size < 20 || header.readUInt32LE(0) !== GLB_MAGIC) throw new ModelError('not a GLB file')
    const version = header.readUInt32LE(4)
    if (version !== 2) throw new ModelError(`GLB version ${version} is not supported, only glTF 2.0`)
    if (header.readUInt32LE(8) !== size) throw new ModelError('the GLB file is incomplete or damaged')
    const jsonLength = header.readUInt32LE(12)
    if (header.readUInt32LE(16) !== CHUNK_JSON || 20 + jsonLength > size) throw new ModelError('the GLB file is damaged')
    const json = Buffer.alloc(jsonLength)
    await file.read(json, 0, jsonLength, 20)
    let gltf: unknown
    try {
      gltf = JSON.parse(json.toString('utf8'))
    } catch {
      throw new ModelError('the GLB file is damaged (unreadable JSON)')
    }
    let binChunk = false
    const next = 20 + jsonLength
    if (next + 8 <= size) {
      const chunk = Buffer.alloc(8)
      await file.read(chunk, 0, 8, next)
      binChunk = chunk.readUInt32LE(4) === CHUNK_BIN && next + 8 + chunk.readUInt32LE(0) <= size
    }
    checkGltf(gltf, binChunk)
  } finally {
    await file.close()
  }
}

/** Wraps a glTF JSON document as a GLB that has only a JSON chunk (its buffers and images stay data: URIs). */
export function gltfToGlb(gltf: unknown): Buffer {
  const text = Buffer.from(JSON.stringify(gltf), 'utf8')
  const json = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]) // chunks are padded to 4 bytes
  const out = Buffer.alloc(20 + json.length)
  out.writeUInt32LE(GLB_MAGIC, 0)
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(out.length, 8)
  out.writeUInt32LE(json.length, 12)
  out.writeUInt32LE(CHUNK_JSON, 16)
  json.copy(out, 20)
  return out
}

/**
 * Checks an uploaded glTF model and writes it to `glb` as a GLB, ready for the viewer: a .glb as it is, a self-contained
 * .gltf wrapped in a GLB. The upload is consumed either way.
 */
export async function prepareGltfModel(upload: string, format: 'glb' | 'gltf', glb: string): Promise<void> {
  try {
    if (format === 'glb') {
      await checkGlb(upload)
      await rename(upload, glb)
      return
    }
    let gltf: unknown
    try {
      gltf = JSON.parse((await readFile(upload, 'utf8')).replace(/^﻿/, ''))
    } catch {
      throw new ModelError('not a glTF model (unreadable JSON)')
    }
    checkGltf(gltf, false)
    await writeFile(glb, gltfToGlb(gltf))
  } finally {
    await rm(upload, { force: true })
  }
}
