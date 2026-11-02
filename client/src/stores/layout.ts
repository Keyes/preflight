import { ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'

const STORAGE_KEY = 'preflight.layout'

/** The sidebar's pages: what you hang and aim, what stands in the room, where you look from. */
export type SidebarTab = 'lights' | 'scene' | 'views'

interface Stored {
  collapsed?: string[]
  dockOpen?: boolean
  tab?: SidebarTab
}

function read(): Stored {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Stored
  } catch {
    return {}
  }
}

/** Which toolbar popover is open. Only one at a time, so they never stack. */
export type Popover = 'settings' | 'help'

/** A short message at the bottom of the view, with an optional button such as Undo. */
export interface Toast {
  text: string
  action?: { label: string; run: () => void }
}

/** How the panels around the 3D view are arranged: folded sidebar sections, the inspector dock, the open popover. */
export const useLayout = defineStore('layout', () => {
  const stored = read()
  // The rarely changed settings groups start folded.
  const collapsed = ref(new Set(stored.collapsed ?? ['settings.quality', 'settings.prefs']))
  const dockOpen = ref(stored.dockOpen ?? true)
  const tab = ref<SidebarTab>(stored.tab ?? 'lights')
  const popover = ref<Popover | null>(null)
  /** How wide the rider wizard's panel over the view is, CSS pixels (0 while it is closed): the plan view fits the venue beside it. */
  const wizardWidth = ref(0)
  const toast = shallowRef<Toast | null>(null)
  let toastTimer: ReturnType<typeof setTimeout> | undefined

  watch(
    [collapsed, dockOpen, tab],
    () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ collapsed: [...collapsed.value], dockOpen: dockOpen.value, tab: tab.value }))
      } catch {
        /* storage unavailable: the layout just won't persist */
      }
    },
    { deep: true },
  )

  function toggleSection(id: string) {
    if (collapsed.value.has(id)) collapsed.value.delete(id)
    else collapsed.value.add(id)
  }

  function togglePopover(which: Popover) {
    popover.value = popover.value === which ? null : which
  }

  /** Shows a toast for a few seconds (longer when it offers a button), replacing any toast before it. */
  function showToast(next: Toast) {
    toast.value = next
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toast.value = null), next.action ? 7000 : 3000)
  }

  function hideToast() {
    clearTimeout(toastTimer)
    toast.value = null
  }

  return { collapsed, dockOpen, tab, popover, wizardWidth, toast, toggleSection, togglePopover, showToast, hideToast }
})
