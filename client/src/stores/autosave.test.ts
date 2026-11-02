import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Autosave } from './autosave'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/** A server whose saves can be held open or made to fail, recording what reached it. */
function fakeServer() {
  const saved: string[] = []
  const results: [string, string | null][] = []
  let failing = false
  let hold: (() => void) | null = null
  let holding = false
  const save = (value: string) => () =>
    new Promise<void>((resolve, reject) => {
      const finish = () => (failing ? reject(new Error('server down')) : (saved.push(value), resolve()))
      if (holding) hold = finish
      else finish()
    })
  const autosave = new Autosave({ delayMs: 500, retryMs: 5000, onResult: (key, error) => results.push([key, error ? error.message : null]) })
  return {
    autosave,
    save,
    saved,
    results,
    fail: (on: boolean) => (failing = on),
    holdNext: () => (holding = true),
    release: () => {
      holding = false
      hold?.()
      hold = null
    },
  }
}

test('a part is saved once, a moment after the last of many changes, as it is then', async () => {
  const server = fakeServer()
  for (const v of ['a', 'b', 'c']) {
    server.autosave.schedule('v1/lights', server.save(v))
    await vi.advanceTimersByTimeAsync(200)
  }
  expect(server.saved).toEqual([])
  await vi.advanceTimersByTimeAsync(500)
  expect(server.saved).toEqual(['c'])
  expect(server.results).toEqual([['v1/lights', null]])
})

test('parts are saved on their own', async () => {
  const server = fakeServer()
  server.autosave.schedule('v1/lights', server.save('lights'))
  server.autosave.schedule('v1/crowd', server.save('crowd'))
  await vi.advanceTimersByTimeAsync(500)
  expect(server.saved.sort()).toEqual(['crowd', 'lights'])
})

test('one save at a time: a change made while one runs is saved right after it', async () => {
  const server = fakeServer()
  server.holdNext()
  server.autosave.schedule('v1/lights', server.save('first'))
  await vi.advanceTimersByTimeAsync(500) // the first save is now on its way
  server.autosave.schedule('v1/lights', server.save('second'))
  await vi.advanceTimersByTimeAsync(500) // its moment comes while the first is still out
  expect(server.saved).toEqual([])
  server.release()
  await vi.advanceTimersByTimeAsync(0)
  expect(server.saved).toEqual(['first', 'second'])
})

test('a failed save keeps the change, says so, and is tried again until it goes through', async () => {
  const server = fakeServer()
  server.fail(true)
  server.autosave.schedule('v1/views', server.save('views'))
  await vi.advanceTimersByTimeAsync(500)
  expect(server.results).toEqual([['v1/views', 'server down']])
  await vi.advanceTimersByTimeAsync(5000)
  expect(server.results).toHaveLength(2) // tried again, failed again
  server.fail(false)
  await vi.advanceTimersByTimeAsync(5000)
  expect(server.saved).toEqual(['views'])
  expect(server.results.at(-1)).toEqual(['v1/views', null])
})

test('a change after a failure is saved after the usual moment, not after the retry wait', async () => {
  const server = fakeServer()
  server.fail(true)
  server.autosave.schedule('v1/crowd', server.save('old'))
  await vi.advanceTimersByTimeAsync(500)
  server.fail(false)
  server.autosave.schedule('v1/crowd', server.save('new'))
  await vi.advanceTimersByTimeAsync(500)
  expect(server.saved).toEqual(['new'])
})

test("flush saves one venue's waiting parts at once, and waits for a save that is running", async () => {
  const server = fakeServer()
  server.autosave.schedule('v1/lights', server.save('v1 lights'))
  server.autosave.schedule('v2/lights', server.save('v2 lights'))
  await server.autosave.flush('v1/')
  expect(server.saved).toEqual(['v1 lights'])

  server.holdNext()
  server.autosave.schedule('v1/crowd', server.save('crowd'))
  await vi.advanceTimersByTimeAsync(500)
  const flushed = server.autosave.flush('v1/')
  server.release()
  await flushed
  expect(server.saved).toEqual(['v1 lights', 'crowd'])
})

test("discard drops a deleted venue's waiting saves, and does not retry one that was out", async () => {
  const server = fakeServer()
  server.autosave.schedule('v1/lights', server.save('lights'))
  server.autosave.discard('v1/')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(server.saved).toEqual([])

  server.fail(true)
  server.holdNext()
  server.autosave.schedule('v1/crowd', server.save('crowd'))
  await vi.advanceTimersByTimeAsync(500)
  server.autosave.discard('v1/')
  server.release()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(server.results.filter(([, error]) => error)).toEqual([])
})
