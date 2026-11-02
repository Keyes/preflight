import { onBeforeUnmount, onMounted } from 'vue'
import { useCameraBridge } from '../stores/camera'
import { useCrowd } from '../stores/crowd'
import { useInteraction } from '../stores/interaction'
import { useLayout } from '../stores/layout'
import { useRig } from '../stores/rig'
import { useSettings } from '../stores/settings'
import { useVenues } from '../stores/venues'
import { findShortcut, type Command } from './keymap'

/**
 * Runs the keymap's commands: one key listener on the window for the whole app, set up by App.vue. Windows that keep
 * keys for themselves (the fixture picker, the Venues window, a context menu) stop them before they get here.
 */
export function useShortcuts() {
  const rig = useRig()
  const crowd = useCrowd()
  const layout = useLayout()
  const settings = useSettings()
  const interaction = useInteraction()
  const venues = useVenues()
  const camera = useCameraBridge()

  const run: Record<Command, (event: KeyboardEvent) => void> = {
    view(event) {
      const view = venues.currentViews[Number(event.key) - 1]
      if (view) camera.api?.goTo({ position: view.position, rotation: view.rotation })
    },
    selectAll: () => rig.selectMany(rig.fixtures.map((f) => f.id)),
    // The nearest thing first: an open popover, then what the next click does, then the selection.
    escape() {
      if (layout.popover) layout.popover = null
      else if (interaction.mode) interaction.cancel()
      else rig.select(null)
    },
    move() {
      if (rig.selectedIds.length) rig.gizmoMode = 'move'
    },
    rotate() {
      if (rig.selectedIds.length) rig.gizmoMode = 'rotate'
    },
    aim() {
      if (rig.selectedIds.length) rig.toggleAim()
    },
    // Deletes without asking: the message that follows offers Undo.
    delete: () => rig.removeMany(rig.selectedIds),
    undo: () => rig.undo(),
    redo: () => rig.redo(),
    crowd: () => crowd.setShown(!crowd.crowd.shown),
    pause() {
      settings.animate = !settings.animate
    },
    help: () => layout.togglePopover('help'),
  }

  function onKeydown(event: KeyboardEvent) {
    const shortcut = findShortcut(event)
    if (!shortcut) return
    if (event.ctrlKey || event.metaKey) event.preventDefault() // the browser's own Ctrl/Cmd keys (select the page, its undo)
    run[shortcut.command](event)
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
}
