<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'

/**
 * A small circled "i" that explains something in a tooltip, for text that is helpful once and in the way after that.
 * The tooltip opens on hover and on keyboard focus (click toggles it, for touch screens), closes with Esc, and is drawn
 * at the top of the page so that no scrolling panel can clip it.
 */
defineProps<{ text: string; label?: string }>()

const button = ref<HTMLElement>()
const tip = ref<HTMLElement>()
const open = ref(false)
const style = ref<Record<string, string>>({ left: '0px', top: '0px' })
let timer: ReturnType<typeof setTimeout> | undefined
const id = `tip-${Math.random().toString(36).slice(2, 9)}`

const MARGIN = 8

function place() {
  if (!button.value || !tip.value) return
  const b = button.value.getBoundingClientRect()
  const t = tip.value.getBoundingClientRect()
  const left = Math.min(window.innerWidth - t.width - MARGIN, Math.max(MARGIN, b.left + b.width / 2 - t.width / 2))
  // below the icon, or above it when there is no room below
  const below = b.bottom + 8
  const top = below + t.height > window.innerHeight - MARGIN ? Math.max(MARGIN, b.top - t.height - 8) : below
  style.value = { left: `${left}px`, top: `${top}px` }
}

function show(delay = 120) {
  clearTimeout(timer)
  timer = setTimeout(async () => {
    open.value = true
    await nextTick()
    place()
  }, delay)
}

function hide() {
  clearTimeout(timer)
  open.value = false
}

function toggle() {
  if (open.value) hide()
  else void show(0)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) {
    event.stopPropagation() // closing the tip is all Esc does now
    hide()
  }
}

onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <button
    ref="button"
    type="button"
    class="info"
    :class="{ on: open }"
    :aria-label="label ?? 'More information'"
    :aria-describedby="open ? id : undefined"
    @mouseenter="show()"
    @mouseleave="hide"
    @focus="show(0)"
    @blur="hide"
    @click.stop.prevent="toggle"
    @keydown="onKeydown"
    @pointerdown.stop
  >
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.3" />
      <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
      <path d="M8 7.3v4.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  </button>
  <Teleport to="body">
    <div v-if="open" :id="id" ref="tip" class="tooltip" role="tooltip" :style="style">{{ text }}</div>
  </Teleport>
</template>

<style scoped>
.info {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  color: var(--text-dim);
  background: none;
  border: 0;
  border-radius: 50%;
  cursor: help;
}
.info:hover,
.info.on,
.info:focus-visible {
  color: var(--accent-text);
}
.info:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.tooltip {
  position: fixed;
  z-index: 1000;
  box-sizing: border-box;
  max-width: 280px;
  padding: 8px 10px;
  color: var(--text);
  background: var(--well);
  border: 1px solid #34344a;
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
  font: 12.5px/1.45 var(--font-sans);
  pointer-events: none;
  white-space: normal;
}
</style>
