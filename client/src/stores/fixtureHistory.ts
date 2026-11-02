import type { Fixture, FixtureGroup } from '../api'

/** Keeps at most this many steps per venue. */
const MAX_STEPS = 100
/** Repeated edits of the same kind within this long (dragging a slider) count as one step. */
const COALESCE_MS = 700

interface Change {
  /** the fixture as JSON before the step, or null when the step created it */
  before: string | null
  /** the fixture as JSON after the step, or null when the step deleted it */
  after: string | null
}

export interface HistoryStep {
  label: string
  /** steps with the same key that follow each other closely are merged (null: never merged) */
  key: string | null
  time: number
  /** only the fixtures that this step changed */
  changes: Map<string, Change>
  /** the order of all fixtures before and after the step */
  orderBefore: string[]
  orderAfter: string[]
  /** the groups as JSON before and after, when the step changed them */
  groups?: { before: string; after: string }
}

/** What an undo or redo did, so the caller can show it and select the affected lights. */
export interface HistoryResult {
  fixtures: Fixture[]
  label: string
  /** the fixtures the step touched that exist afterwards */
  ids: string[]
  /** the groups as they are now, when the step changed them */
  groups?: FixtureGroup[]
}

/**
 * Undo and redo for one venue's fixtures. It does not watch anything: the caller says when a batch of edits is
 * finished (`record`), and this works out what changed since the last time by comparing the fixtures as JSON, and
 * stores just those differences. Undoing puts the old JSON back; fixtures that did not change keep their identity.
 */
export class FixtureHistory {
  readonly undoSteps: HistoryStep[] = []
  readonly redoSteps: HistoryStep[] = []
  private baseline = new Map<string, string>()
  private order: string[] = []
  private groupsJson = '[]'

  constructor(fixtures: readonly Fixture[], groups: readonly FixtureGroup[] = []) {
    this.rebaseline(fixtures, groups)
  }

  private rebaseline(fixtures: readonly Fixture[], groups: readonly FixtureGroup[]) {
    this.baseline = new Map(fixtures.map((f) => [f.id, JSON.stringify(f)]))
    this.order = fixtures.map((f) => f.id)
    this.groupsJson = JSON.stringify(groups)
  }

  /**
   * Records what changed since the last call as one step. `candidates` are the fixtures that may have changed
   * ('all' when lights were added or removed). Returns whether anything changed.
   */
  record(
    fixtures: readonly Fixture[],
    candidates: readonly string[] | 'all',
    label: string,
    key: string | null,
    now = performance.now(),
    groups: readonly FixtureGroup[] = [],
  ): boolean {
    const byId = new Map(fixtures.map((f) => [f.id, f]))
    const ids = candidates === 'all' ? new Set([...this.baseline.keys(), ...byId.keys()]) : new Set(candidates)
    const changes = new Map<string, Change>()
    for (const id of ids) {
      const fixture = byId.get(id)
      const after = fixture ? JSON.stringify(fixture) : null
      const before = this.baseline.get(id) ?? null
      if (after !== before) changes.set(id, { before, after })
    }
    const orderAfter = fixtures.map((f) => f.id)
    const orderChanged = orderAfter.join('|') !== this.order.join('|')
    const groupsAfter = JSON.stringify(groups)
    const groupsChanged = groupsAfter !== this.groupsJson
    if (changes.size === 0 && !orderChanged && !groupsChanged) return false

    const orderBefore = this.order
    for (const [id, change] of changes) {
      if (change.after === null) this.baseline.delete(id)
      else this.baseline.set(id, change.after)
    }
    this.order = orderAfter
    const groupsStep = groupsChanged ? { before: this.groupsJson, after: groupsAfter } : undefined
    this.groupsJson = groupsAfter
    this.redoSteps.length = 0

    const count = changes.size
    const step: HistoryStep = {
      label: count > 1 ? `${label} (${count} lights)` : label,
      key,
      time: now,
      changes,
      orderBefore,
      orderAfter,
      ...(groupsStep ? { groups: groupsStep } : {}),
    }
    const top = this.undoSteps[this.undoSteps.length - 1]
    if (key && top && top.key === key && now - top.time < COALESCE_MS) {
      // The same kind of edit again: extend the previous step instead of adding another.
      for (const [id, change] of changes) {
        const earlier = top.changes.get(id)
        if (earlier) earlier.after = change.after
        else top.changes.set(id, change)
      }
      top.orderAfter = orderAfter
      if (groupsStep) top.groups = { before: top.groups?.before ?? groupsStep.before, after: groupsStep.after }
      top.time = now
      const groupsSame = !top.groups || top.groups.before === top.groups.after
      if ([...top.changes.values()].every((c) => c.before === c.after) && top.orderBefore.join('|') === orderAfter.join('|') && groupsSame) this.undoSteps.pop()
    } else {
      this.undoSteps.push(step)
      if (this.undoSteps.length > MAX_STEPS) this.undoSteps.shift()
    }
    return true
  }

  get canUndo() {
    return this.undoSteps.length > 0
  }

  get canRedo() {
    return this.redoSteps.length > 0
  }

  undo(current: readonly Fixture[]): HistoryResult | null {
    const step = this.undoSteps.pop()
    if (!step) return null
    this.redoSteps.push(step)
    return this.apply(step, 'before', current)
  }

  redo(current: readonly Fixture[]): HistoryResult | null {
    const step = this.redoSteps.pop()
    if (!step) return null
    this.undoSteps.push(step)
    return this.apply(step, 'after', current)
  }

  private apply(step: HistoryStep, side: 'before' | 'after', current: readonly Fixture[]): HistoryResult {
    const byId = new Map(current.map((f) => [f.id, f]))
    const order = side === 'before' ? step.orderBefore : step.orderAfter
    const fixtures: Fixture[] = []
    for (const id of order) {
      const change = step.changes.get(id)
      if (change) {
        const json = change[side]
        if (json !== null) fixtures.push(JSON.parse(json) as Fixture)
      } else {
        const fixture = byId.get(id)
        if (fixture) fixtures.push(fixture)
      }
    }
    for (const [id, change] of step.changes) {
      const json = change[side]
      if (json === null) this.baseline.delete(id)
      else this.baseline.set(id, json)
    }
    this.order = order
    const ids = [...step.changes].filter(([, change]) => change[side] !== null).map(([id]) => id)
    if (step.groups) {
      this.groupsJson = step.groups[side]
      return { fixtures, label: step.label, ids, groups: JSON.parse(step.groups[side]) as FixtureGroup[] }
    }
    return { fixtures, label: step.label, ids }
  }
}
