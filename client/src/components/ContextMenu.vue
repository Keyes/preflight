<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'

export interface MenuItem {
  label: string
  action: () => void
  danger?: boolean
}

defineProps<{ x: number; y: number; items: MenuItem[] }>()
const emit = defineEmits<{ (e: 'close'): void }>()

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
}
function close() {
  emit('close')
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('blur', close)
  // Any click elsewhere closes the menu; clicks inside it are stopped below.
  window.addEventListener('pointerdown', close)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('blur', close)
  window.removeEventListener('pointerdown', close)
})
</script>

<template>
  <ul class="context-menu" :style="{ left: `${x}px`, top: `${y}px` }" @pointerdown.stop @contextmenu.prevent>
    <li v-for="item in items" :key="item.label">
      <button :class="{ danger: item.danger }" @click="item.action(); emit('close')">{{ item.label }}</button>
    </li>
  </ul>
</template>

<style scoped>
.context-menu {
  position: fixed;
  z-index: 10;
  list-style: none;
  margin: 0;
  padding: 4px;
  min-width: 140px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow);
  font: 14px/1.4 var(--font-sans);
}
button {
  width: 100%;
  text-align: left;
  background: none;
  border: 0;
  color: var(--text);
  font: inherit;
  cursor: pointer;
  padding: 6px 10px;
  border-radius: 4px;
}
button:hover {
  background: var(--selected);
}
button.danger {
  color: var(--danger);
}
</style>
