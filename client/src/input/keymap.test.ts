import { expect, test } from 'vitest'
import { CAMERA_KEYS, findShortcut, KEYMAP, keysFor, MOD, type KeyBinding, type KeyEventLike, type Shortcut } from './keymap'

const press = (key: string, mods: Partial<KeyEventLike> = {}, target: object | null = null): KeyEventLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  target: target as EventTarget | null,
  ...mods,
})
const commandOf = (key: string, mods: Partial<KeyEventLike> = {}, target: object | null = null) => findShortcut(press(key, mods, target))?.command ?? null

const shortcuts = KEYMAP.filter((e): e is Shortcut => 'command' in e)

test('plain keys run their command in either case, and not with Ctrl, Cmd or Alt held', () => {
  expect(commandOf('g')).toBe('move')
  expect(commandOf('G', { shiftKey: true })).toBe('move')
  expect(commandOf('?', { shiftKey: true })).toBe('help')
  expect(commandOf('5')).toBe('view')
  expect(commandOf('Escape')).toBe('escape')
  expect(commandOf('Backspace')).toBe('delete')
  expect(commandOf('g', { ctrlKey: true })).toBeNull()
  expect(commandOf('g', { altKey: true })).toBeNull()
  expect(commandOf('a')).toBeNull() // the camera's
})

test('Ctrl or Cmd chords: undo, redo with Shift or Y, select all', () => {
  expect(commandOf('z', { metaKey: true })).toBe('undo')
  expect(commandOf('Z', { ctrlKey: true, shiftKey: true })).toBe('redo')
  expect(commandOf('y', { ctrlKey: true })).toBe('redo')
  expect(commandOf('a', { metaKey: true })).toBe('selectAll')
  expect(commandOf('z', { metaKey: true, altKey: true })).toBeNull()
})

test('nothing runs while typing in a text field; from a slider or menu only Esc, undo and redo do', () => {
  const text = { tagName: 'INPUT', type: 'text' }
  const editable = { tagName: 'DIV', isContentEditable: true }
  const slider = { tagName: 'INPUT', type: 'range' }
  const menu = { tagName: 'SELECT' }
  expect(commandOf('z', { metaKey: true }, text)).toBeNull()
  expect(commandOf('Escape', {}, text)).toBeNull()
  expect(commandOf('g', {}, editable)).toBeNull()
  expect(commandOf('g', {}, slider)).toBeNull()
  expect(commandOf('Delete', {}, slider)).toBeNull()
  expect(commandOf('c', {}, menu)).toBeNull()
  expect(commandOf('z', { metaKey: true }, slider)).toBe('undo')
  expect(commandOf('Escape', {}, slider)).toBe('escape')
  expect(commandOf('g', {}, { tagName: 'CANVAS' })).toBe('move')
})

test('every command has one entry, and no two shortcuts or the camera answer to the same key', () => {
  const commands = shortcuts.map((s) => s.command)
  expect(new Set(commands).size).toBe(commands.length)

  const overlap = (a: KeyBinding, b: KeyBinding) =>
    a.key.toLowerCase() === b.key.toLowerCase() && !!a.mod === !!b.mod && (a.shift === undefined || b.shift === undefined || a.shift === b.shift)
  const bindings = shortcuts.flatMap((s) => s.bindings.map((b) => ({ command: s.command, b })))
  for (const [i, x] of bindings.entries()) {
    for (const y of bindings.slice(i + 1)) expect(overlap(x.b, y.b), `${x.command} and ${y.command} share ${x.b.key}`).toBe(false)
  }

  const cameraCodes = new Set<number>(Object.values(CAMERA_KEYS).flat())
  for (const { command, b } of bindings) {
    if (!b.mod && /^[a-z]$/i.test(b.key)) expect(cameraCodes.has(b.key.toUpperCase().charCodeAt(0)), `${command} uses a camera key`).toBe(false)
  }
})

test('keys are written the way the help panel shows them', () => {
  expect(keysFor('undo')).toBe(`${MOD} Z`)
  expect(keysFor('redo')).toBe(`Shift ${MOD} Z`)
  expect(keysFor('escape')).toBe('Esc')
  expect(keysFor('delete')).toBe('Delete')
  expect(keysFor('view')).toBe('1 – 9')
})
