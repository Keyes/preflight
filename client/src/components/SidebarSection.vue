<script setup lang="ts">
import { computed } from 'vue'
import { useLayout } from '../stores/layout'
import InfoTip from './InfoTip.vue'

const props = defineProps<{
  /** Key under which the folded state is remembered. */
  id: string
  title: string
  tip?: string
  /** Shown next to the title, also while folded (a count, a total). */
  count?: string | number
}>()

const layout = useLayout()
const open = computed(() => !layout.collapsed.has(props.id))
</script>

<template>
  <section class="section" :class="{ folded: !open }">
    <div class="section-head">
      <button class="toggle" :aria-expanded="open" :title="open ? `Fold ${title}` : `Unfold ${title}`" @click="layout.toggleSection(id)">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        <h2>{{ title }}</h2>
        <span v-if="count !== undefined && count !== ''" class="count">{{ count }}</span>
      </button>
      <InfoTip v-if="tip" :text="tip" :label="`About ${title.toLowerCase()}`" />
      <span class="actions"><slot name="actions" /></span>
    </div>
    <div v-if="open" class="body"><slot /></div>
  </section>
</template>

<style scoped>
.section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font: 14px/1.4 var(--font-sans);
  color: var(--text);
}
.section-head {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 24px;
}
.toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-left: -4px;
  padding: 2px 4px;
  color: var(--text-muted);
  background: none;
  border: 0;
  border-radius: 4px;
  font: inherit;
  cursor: pointer;
}
.toggle:hover h2,
.toggle:hover {
  color: var(--text-bright);
}
.toggle svg {
  flex: none;
  transform: rotate(90deg);
  transition: transform 0.12s;
}
.folded .toggle svg {
  transform: none;
}
h2 {
  margin: 0;
  font-size: 13px;
  letter-spacing: 0.01em;
  color: var(--text-strong);
  font-weight: 600;
  white-space: nowrap;
}
.count {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-soft);
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  padding-left: 8px;
}
.actions :deep(.link) {
  background: none;
  border: 0;
  color: var(--accent);
  padding: 0;
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.actions :deep(.link:disabled) {
  color: var(--text-disabled);
  cursor: default;
}
.body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
