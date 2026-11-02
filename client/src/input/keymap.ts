/**
 * Every app-wide keyboard shortcut and pointer gesture, in the order the help panel lists them. `useShortcuts` runs the
 * commands, and the help panel, the empty inspector and button titles take their key names from here, so a key is
 * changed in one place. Keys that only mean something inside one window or field (Enter and Esc in a name field, the
 * arrows in the fixture picker) stay with that window, which stops them from reaching the app.
 *
 * Plain TypeScript: no Vue, so the matching is tested without a browser.
 */

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
/** How Ctrl, or Cmd on a Mac, is written. Ctrl-click is a right click on a Mac, so Cmd adds to a selection there. */
export const MOD = isMac ? '⌘' : 'Ctrl'

export type Command = 'view' | 'selectAll' | 'escape' | 'move' | 'rotate' | 'aim' | 'delete' | 'undo' | 'redo' | 'crowd' | 'pause' | 'help'

export interface KeyBinding {
  /** `KeyboardEvent.key`, compared without case */
  key: string
  /** Ctrl, or Cmd on a Mac, must be held (left out: must not be). Alt never may be. */
  mod?: boolean
  /** Shift must be held (true) or must not be (false); left out, either */
  shift?: boolean
}

export type HelpGroup = 'Camera' | 'Selecting' | 'Editing' | 'View'

interface Listed {
  group: HelpGroup
  /** what it does, as the help panel says it */
  what: string
  /** listed in the empty inspector too */
  brief?: boolean
}

/** Keys that run a command. */
export interface Shortcut extends Listed {
  command: Command
  bindings: readonly KeyBinding[]
  /** how the keys are written, when the first binding alone would not say it */
  keys?: string
  /** also runs while a slider, checkbox or menu has focus (never while typing in a text field) */
  inControls?: boolean
}

/** Something the camera or a click handles itself, listed so the help is complete. */
export interface Gesture extends Listed {
  keys: string
}

export type KeymapEntry = Shortcut | Gesture

/** The camera's own movement keys, as Babylon wants them (key codes). The first two help entries describe them. */
export const CAMERA_KEYS = {
  forward: [87, 38], // W, ↑
  back: [83, 40], // S, ↓
  left: [65, 37], // A, ←
  right: [68, 39], // D, →
  up: [69], // E
  down: [81], // Q
} as const

export const KEYMAP: readonly KeymapEntry[] = [
  { group: 'Camera', keys: 'W A S D', what: 'Move (or the arrow keys)', brief: true },
  { group: 'Camera', keys: 'Q / E', what: 'Down / up', brief: true },
  { group: 'Camera', keys: 'Shift', what: 'Move faster', brief: true },
  { group: 'Camera', keys: 'Drag', what: 'Look around', brief: true },
  {
    group: 'Camera',
    command: 'view',
    bindings: Array.from({ length: 9 }, (_, i) => ({ key: String(i + 1) })),
    keys: '1 – 9',
    what: 'Jump to a saved view',
    brief: true,
  },
  { group: 'Selecting', keys: 'Click', what: 'Select a light' },
  { group: 'Selecting', keys: `${MOD}-click`, what: 'Add to or take out of the selection' },
  { group: 'Selecting', keys: 'Shift-click', what: 'Select a range in the list' },
  { group: 'Selecting', command: 'selectAll', bindings: [{ key: 'a', mod: true }], what: 'Select all lights' },
  { group: 'Selecting', command: 'escape', bindings: [{ key: 'Escape' }], what: 'Cancel, or deselect', inControls: true },
  { group: 'Editing', command: 'move', bindings: [{ key: 'g' }], what: 'Move gizmo', brief: true },
  { group: 'Editing', command: 'rotate', bindings: [{ key: 'r' }], what: 'Rotate gizmo (Shift snaps to 5°)', brief: true },
  // T for target: A is the camera's
  { group: 'Editing', command: 'aim', bindings: [{ key: 't' }], what: 'Aim: then click a surface', brief: true },
  { group: 'Editing', command: 'delete', bindings: [{ key: 'Delete' }, { key: 'Backspace' }], what: 'Delete the selected lights' },
  // Undo and redo also work from a slider, so a change made with it can be taken back at once.
  { group: 'Editing', command: 'undo', bindings: [{ key: 'z', mod: true, shift: false }], what: 'Undo', inControls: true },
  {
    group: 'Editing',
    command: 'redo',
    bindings: [
      { key: 'z', mod: true, shift: true },
      { key: 'y', mod: true },
    ],
    what: 'Redo',
    inControls: true,
  },
  { group: 'View', command: 'crowd', bindings: [{ key: 'c' }], what: 'Show or hide the crowd', brief: true },
  { group: 'View', command: 'pause', bindings: [{ key: 'p' }], what: 'Pause or resume animations', brief: true },
  { group: 'View', command: 'help', bindings: [{ key: '?' }], what: 'This list' },
]

const SHORTCUTS = KEYMAP.filter((e): e is Shortcut => 'command' in e)

function keyName(key: string) {
  if (key === 'Escape') return 'Esc'
  return key.length === 1 ? key.toUpperCase() : key
}

/** How an entry's keys are written, e.g. "Shift ⌘ Z". */
export function keysOf(entry: KeymapEntry): string {
  if (entry.keys) return entry.keys
  const b = (entry as Shortcut).bindings[0]
  return [b.shift ? 'Shift' : '', b.mod ? MOD : '', keyName(b.key)].filter(Boolean).join(' ')
}

/** How the keys of a command are written, for a button's title. */
export function keysFor(command: Command): string {
  return keysOf(SHORTCUTS.find((s) => s.command === command)!)
}

/** The key goes into a text field, so it is typing and not a shortcut (a slider, checkbox or color field is not typed into). */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el?.tagName) return false
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true
  return el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'color', 'button'].includes((el as HTMLInputElement).type)
}

function inFormControl(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el?.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)
}

export type KeyEventLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'target'>

/** The shortcut a key press runs, or null: none while typing, and in a form control only those marked `inControls`. */
export function findShortcut(event: KeyEventLike): Shortcut | null {
  if (event.altKey || isTyping(event.target)) return null
  const mod = event.ctrlKey || event.metaKey
  const key = event.key.toLowerCase()
  const inControl = inFormControl(event.target)
  const matches = (b: KeyBinding) => b.key.toLowerCase() === key && !!b.mod === mod && (b.shift === undefined || b.shift === event.shiftKey)
  return SHORTCUTS.find((s) => (s.inControls || !inControl) && s.bindings.some(matches)) ?? null
}
