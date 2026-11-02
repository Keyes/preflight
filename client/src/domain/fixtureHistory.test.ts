import { expect, test } from 'vitest'
import type { Fixture, FixtureGroup } from '@preflight/shared'
import { FixtureHistory } from './fixtureHistory'

const light = (id: string, x = 0): Fixture => ({
  id,
  name: id,
  profileId: 'generic-moving-head',
  position: [x, 3, 0],
  mount: 'hanging',
  yaw: 0,
  values: { dimmer: 1 },
})

test('undoes and redoes an edit, and leaves the lights it did not touch as they were', () => {
  const a = light('a')
  const b = light('b')
  const history = new FixtureHistory([a, b])
  a.values.dimmer = 0.5
  expect(history.record([a, b], ['a'], 'Change dimmer', null, 0)).toBe(true)

  const undone = history.undo([a, b])!
  expect(undone.label).toBe('Change dimmer')
  expect(undone.ids).toEqual(['a'])
  expect(undone.fixtures[0].values.dimmer).toBe(1)
  expect(undone.fixtures[1]).toBe(b) // the same object: an untouched light keeps its identity

  const redone = history.redo(undone.fixtures)!
  expect(redone.fixtures[0].values.dimmer).toBe(0.5)
  expect(history.canRedo).toBe(false)
})

test('records nothing when nothing changed', () => {
  const a = light('a')
  const history = new FixtureHistory([a])
  expect(history.record([a], ['a'], 'Edit light', null, 0)).toBe(false)
  expect(history.canUndo).toBe(false)
})

test('names a step that changed several lights after how many', () => {
  const a = light('a')
  const b = light('b')
  const history = new FixtureHistory([a, b])
  a.position = [1, 3, 0]
  b.position = [2, 3, 0]
  history.record([a, b], ['a', 'b'], 'Move', null, 0)
  expect(history.undoSteps.at(-1)?.label).toBe('Move (2 lights)')
})

test('merges repeated edits of the same kind within 0.7 s into one step', () => {
  const a = light('a')
  const history = new FixtureHistory([a])
  for (const [i, time] of [0, 300, 600].entries()) {
    a.values.dimmer = 0.9 - i * 0.1
    history.record([a], ['a'], 'Change dimmer', 'value:dimmer:a', time)
  }
  expect(history.undoSteps).toHaveLength(1)

  a.values.dimmer = 0.1
  history.record([a], ['a'], 'Change dimmer', 'value:dimmer:a', 1400) // 0.8 s after the last one: a step of its own
  expect(history.undoSteps).toHaveLength(2)

  const first = history.undo([a])!
  expect(first.fixtures[0].values.dimmer).toBeCloseTo(0.7)
  expect(history.undo(first.fixtures)!.fixtures[0].values.dimmer).toBe(1)
})

test('keeps edits of different kinds, or without a key, as separate steps', () => {
  const a = light('a')
  const history = new FixtureHistory([a])
  a.values.dimmer = 0.5
  history.record([a], ['a'], 'Change dimmer', 'value:dimmer:a', 0)
  a.values.tilt = 0.2
  history.record([a], ['a'], 'Change tilt', 'value:tilt:a', 100)
  a.name = 'Spot'
  history.record([a], ['a'], 'Rename', null, 200)
  a.name = 'Spot 2'
  history.record([a], ['a'], 'Rename', null, 300)
  expect(history.undoSteps.map((s) => s.label)).toEqual(['Change dimmer', 'Change tilt', 'Rename', 'Rename'])
})

test('drops a merged step that ends where it began', () => {
  const a = light('a')
  const history = new FixtureHistory([a])
  a.values.dimmer = 0.5
  history.record([a], ['a'], 'Change dimmer', 'value:dimmer:a', 0)
  a.values.dimmer = 1
  history.record([a], ['a'], 'Change dimmer', 'value:dimmer:a', 100)
  expect(history.canUndo).toBe(false)
})

test('undoing a delete puts the light back in its place, and redoing it takes the light out again', () => {
  const a = light('a')
  const b = light('b')
  const c = light('c')
  const history = new FixtureHistory([a, b, c])
  history.record([a, c], 'all', 'Delete', null, 0)

  const undone = history.undo([a, c])!
  expect(undone.fixtures.map((f) => f.id)).toEqual(['a', 'b', 'c'])
  expect(undone.ids).toEqual(['b'])

  const redone = history.redo(undone.fixtures)!
  expect(redone.fixtures.map((f) => f.id)).toEqual(['a', 'c'])
  expect(redone.ids).toEqual([])
})

test('undoing a placement takes the new light out', () => {
  const a = light('a')
  const history = new FixtureHistory([a])
  const b = light('b', 2)
  history.record([a, b], 'all', 'Place light', null, 0)
  expect(history.undo([a, b])!.fixtures.map((f) => f.id)).toEqual(['a'])
})

test('gives the groups back when the step changed them', () => {
  const a = light('a')
  const history = new FixtureHistory([a], [])
  const groups: FixtureGroup[] = [{ id: 'g', name: 'Group 1', fixtureIds: ['a'] }]
  expect(history.record([a], [], 'Create group', null, 0, groups)).toBe(true)
  expect(history.undo([a])!.groups).toEqual([])
  expect(history.redo([a])!.groups).toEqual(groups)
})

test('a new edit after an undo drops what could have been redone', () => {
  const a = light('a')
  const history = new FixtureHistory([a])
  a.values.dimmer = 0.5
  history.record([a], ['a'], 'Change dimmer', null, 0)
  const [undone] = history.undo([a])!.fixtures
  undone.values.dimmer = 0.2
  history.record([undone], ['a'], 'Change dimmer', null, 1000)
  expect(history.canRedo).toBe(false)
})

test('keeps the last 100 steps', () => {
  const a = light('a')
  const history = new FixtureHistory([a])
  for (let i = 1; i <= 105; i++) {
    a.position = [i, 3, 0]
    history.record([a], ['a'], 'Move', null, i * 1000)
  }
  expect(history.undoSteps).toHaveLength(100)
})
