import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

/** A part of a venue is saved this long after the last change to it: a slider or a drag makes many changes. */
const SAVE_DELAY_MS = 500
/** A save that failed is tried again this long after (and with the next change before that). */
const RETRY_MS = 5000

interface Waiting {
  /** sends the part as it is when it runs */
  save: () => Promise<unknown>
  timer?: ReturnType<typeof setTimeout>
  running?: Promise<void>
  /** changed while a save ran: save again after it */
  again: boolean
  dropped: boolean
}

/**
 * Saves the parts of venues (lights, haze, crowd, views, hidden model parts) a moment after the last change to each. A part
 * is saved one save at a time; a change made while one runs is saved right after it. A save that fails leaves the change as
 * it is on screen and is tried again later, and with the next change. Plain TypeScript, so it is tested with fake timers.
 */
export class Autosave {
  private readonly waiting = new Map<string, Waiting>()

  constructor(
    private readonly options: {
      delayMs: number
      retryMs: number
      /** hears of each save: null when it went through, else what failed */
      onResult: (key: string, error: Error | null) => void
    },
  ) {}

  /** Saves the part `key` with `save` once no change has come for a moment. */
  schedule(key: string, save: () => Promise<unknown>) {
    const entry = this.waiting.get(key) ?? { save, again: false, dropped: false }
    entry.save = save
    this.waiting.set(key, entry)
    this.wait(key, entry, this.options.delayMs)
  }

  /** Saves at once what waits under keys starting with `prefix` (all of it with none), and resolves when that is done. */
  async flush(prefix = '') {
    await Promise.all([...this.waiting].filter(([key]) => key.startsWith(prefix)).map(([key, entry]) => this.run(key, entry)))
  }

  /** Forgets what waits under keys starting with `prefix` (a venue that was deleted). */
  discard(prefix: string) {
    for (const [key, entry] of this.waiting) {
      if (!key.startsWith(prefix)) continue
      clearTimeout(entry.timer)
      entry.dropped = true
      this.waiting.delete(key)
      this.options.onResult(key, null)
    }
  }

  private wait(key: string, entry: Waiting, ms: number) {
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => void this.run(key, entry), ms)
  }

  private run(key: string, entry: Waiting): Promise<void> {
    const changed = entry.timer !== undefined // a change (or a retry) was waiting; a flush with none only waits
    clearTimeout(entry.timer)
    entry.timer = undefined
    if (entry.running) {
      if (changed) entry.again = true // the running save is followed by one with the change
      return entry.running
    }
    entry.running = (async () => {
      do {
        entry.again = false
        try {
          await entry.save()
          if (entry.dropped) return
          this.options.onResult(key, null)
          if (!entry.again && !entry.timer) this.waiting.delete(key)
        } catch (err) {
          if (entry.dropped) return
          this.options.onResult(key, err instanceof Error ? err : new Error(String(err)))
          if (!entry.again && !entry.timer) this.wait(key, entry, this.options.retryMs)
        }
      } while (entry.again)
    })().finally(() => (entry.running = undefined))
    return entry.running
  }
}

/** A part of a venue, as autosave keys it: everything of one venue starts with its id. */
export const partKey = (venueId: string, part: 'lights' | 'atmosphere' | 'crowd' | 'views' | 'hiddenTags') => `${venueId}/${part}`

/** The one autosave for the app, and what it could not save. */
export const useAutosave = defineStore('autosave', () => {
  /** what failed to save, by part */
  const problems = ref<Record<string, string>>({})
  const saver = new Autosave({
    delayMs: SAVE_DELAY_MS,
    retryMs: RETRY_MS,
    onResult(key, error) {
      if (error) {
        problems.value = { ...problems.value, [key]: error.message }
      } else if (key in problems.value) {
        const { [key]: _, ...rest } = problems.value
        problems.value = rest
      }
    },
  })
  /** What the sidebar says while something is not saved; null when everything is. */
  const problem = computed(() => Object.values(problems.value)[0] ?? null)

  return {
    problems,
    problem,
    schedule: (key: string, save: () => Promise<unknown>) => saver.schedule(key, save),
    /** Saves what waits for a venue (by its id), or for all venues, now. */
    flush: (venueId = '') => saver.flush(venueId && `${venueId}/`),
    /** Drops what waits for a venue (it was deleted). */
    discard: (venueId: string) => saver.discard(`${venueId}/`),
  }
})
