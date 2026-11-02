<script setup lang="ts">
import { useLayout } from '../stores/layout'

const layout = useLayout()

function run() {
  const action = layout.toast?.action
  layout.hideToast()
  action?.run()
}
</script>

<template>
  <div v-if="layout.toast" class="toast" role="status" @pointerdown.stop>
    <span>{{ layout.toast.text }}</span>
    <button v-if="layout.toast.action" @click="run">{{ layout.toast.action.label }}</button>
  </div>
</template>

<style scoped>
.toast {
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 100%;
  box-sizing: border-box;
  padding: 7px 8px 7px 14px;
  font: 13px var(--font-sans);
  color: var(--text);
  background: var(--glass);
  backdrop-filter: var(--frost);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow);
}
span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
button {
  flex: none;
  padding: 3px 10px;
  color: var(--accent-text);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
button:hover {
  background: var(--selected);
}
</style>
