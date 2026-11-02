import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { checkGlb, checkGltf, detectModelFormat, gltfToGlb, ModelError, prepareGltfModel } from './model.js'

const dir = await mkdtemp(join(tmpdir(), 'preflight-model-'))
after(() => rm(dir, { recursive: true, force: true }))

/** A minimal glTF document with one mesh; `buffer` is the first buffer entry. */
const doc = (buffer: object = { byteLength: 4 }, extra: object = {}) => ({
  asset: { version: '2.0' },
  buffers: [buffer],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  ...extra,
})

/** Builds a GLB from a JSON document and an optional binary chunk. */
function glb(json: object, bin?: Buffer): Buffer {
  const out = gltfToGlb(json)
  if (!bin) return out
  const chunk = Buffer.alloc(8 + bin.length)
  chunk.writeUInt32LE(bin.length, 0)
  chunk.writeUInt32LE(0x004e4942, 4)
  bin.copy(chunk, 8)
  const whole = Buffer.concat([out, chunk])
  whole.writeUInt32LE(whole.length, 8)
  return whole
}

async function file(name: string, data: Buffer | string) {
  const path = join(dir, name)
  await writeFile(path, data)
  return path
}

test('tells SketchUp, GLB and glTF JSON apart by their first bytes', () => {
  assert.equal(detectModelFormat(Buffer.from([0xff, 0xfe, 0xff, 0x0e])), 'skp')
  assert.equal(detectModelFormat(Buffer.from('glTF')), 'glb')
  assert.equal(detectModelFormat(Buffer.from('{"as')), 'gltf')
  assert.equal(detectModelFormat(Buffer.from('\n  {')), 'gltf')
  assert.equal(detectModelFormat(Buffer.from([0xef, 0xbb, 0xbf, 0x7b])), 'gltf') // UTF-8 byte order mark, then "{"
  assert.equal(detectModelFormat(Buffer.from('    ')), 'gltf') // only white space so far: the JSON check decides
})

test('rejects other files by their first bytes', () => {
  assert.equal(detectModelFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null) // PNG
  assert.equal(detectModelFormat(Buffer.from('PK\x03\x04')), null) // zip, also .3mf and .usdz
  assert.equal(detectModelFormat(Buffer.from('solid')), null) // ASCII STL
  assert.equal(detectModelFormat(Buffer.from('[1,2')), null)
  assert.equal(detectModelFormat(Buffer.alloc(0)), null)
})

test('accepts a glTF 2.0 document with embedded data', () => {
  checkGltf(
    doc({ uri: 'data:application/octet-stream;base64,AAAAAA==', byteLength: 4 }, { images: [{ uri: 'data:image/png;base64,iVBO' }, { bufferView: 1 }] }),
    false,
  )
  checkGltf(doc({ byteLength: 4 }), true) // the GLB's binary chunk
})

test('rejects glTF that is not 2.0, has no meshes or misses its data', () => {
  assert.throws(() => checkGltf([], false), ModelError)
  assert.throws(() => checkGltf({ meshes: [{}] }, false), /no asset version/)
  assert.throws(() => checkGltf({ ...doc(), asset: { version: '1.0' } }, false), /glTF 1\.0 is not supported/)
  assert.throws(() => checkGltf({ ...doc(), meshes: [] }, false), /no meshes/)
  assert.throws(() => checkGltf(doc({ byteLength: 4 }), false), /missing its binary data/)
})

test('rejects glTF that refers to separate files, naming them', () => {
  assert.throws(() => checkGltf(doc({ uri: 'scene.bin', byteLength: 4 }), false), /separate files \(scene\.bin\)\. Export it as a single \.glb/)
  assert.throws(() => checkGltf(doc({ byteLength: 4 }, { images: [{ uri: 'textures/brick.jpg' }] }), true), /textures\/brick\.jpg/)
})

test('checks a GLB from its header and JSON chunk', async () => {
  await checkGlb(await file('ok.glb', glb(doc(), Buffer.alloc(4))))
  await assert.rejects(checkGlb(await file('nobin.glb', glb(doc()))), /missing its binary data/)
  await assert.rejects(checkGlb(await file('nomesh.glb', glb({ ...doc(), meshes: [] }, Buffer.alloc(4)))), /no meshes/)
  await assert.rejects(checkGlb(await file('short.glb', glb(doc(), Buffer.alloc(4)).subarray(0, 40))), /incomplete or damaged/)
  const v1 = glb(doc(), Buffer.alloc(4))
  v1.writeUInt32LE(1, 4)
  await assert.rejects(checkGlb(await file('v1.glb', v1)), /GLB version 1/)
  const badJson = glb(doc(), Buffer.alloc(4))
  badJson.write('}', 20)
  await assert.rejects(checkGlb(await file('badjson.glb', badJson)), /unreadable JSON/)
  await assert.rejects(checkGlb(await file('tiny.glb', 'glTF')), /not a GLB/)
})

test('wraps a self-contained .gltf as a GLB the checks accept', async () => {
  const gltf = doc({ uri: 'data:application/octet-stream;base64,AAAAAA==', byteLength: 4 })
  const upload = await file('model.gltf', `﻿${JSON.stringify(gltf, null, 2)}`)
  const out = join(dir, 'model-from-gltf.glb')
  await prepareGltfModel(upload, 'gltf', out)
  await checkGlb(out)
  const bytes = await readFile(out)
  assert.equal(bytes.length % 4, 0)
  assert.deepEqual(JSON.parse(bytes.subarray(20).toString('utf8')), gltf)
  await assert.rejects(stat(upload)) // the upload is used up
})

test('moves a valid .glb into place and leaves nothing behind for a bad one', async () => {
  const out = join(dir, 'model.glb')
  const good = glb(doc(), Buffer.alloc(4))
  await prepareGltfModel(await file('good.upload', good), 'glb', out)
  assert.deepEqual(await readFile(out), good)
  const bad = await file('bad.upload', glb(doc({ uri: 'model.bin', byteLength: 4 })))
  await assert.rejects(prepareGltfModel(bad, 'glb', join(dir, 'never.glb')), /separate files/)
  await assert.rejects(stat(bad))
  await assert.rejects(stat(join(dir, 'never.glb')))
  await assert.rejects(prepareGltfModel(await file('bad.gltf', '{"asset":'), 'gltf', join(dir, 'never.glb')), /unreadable JSON/)
})
