<script setup lang="ts">
import { ref, watch } from 'vue'

/**
 * A control's value as a number you can type, in the unit people think in (%, degrees, meters), next to its slider.
 * The value comes in and goes out normalized (0..1, like a DMX channel); `toUnit` and `fromUnit` convert.
 */
const props = defineProps<{
  value: number
  toUnit: (value: number) => number
  fromUnit: (unit: number) => number
  unit: string
  /** decimals shown */
  digits?: number
  /** shown instead of a number when the selected lights differ */
  mixed?: boolean
  label: string
}>()
const emit = defineEmits<{ (e: 'set', value: number): void }>()

/** The number shown: empty (with "mixed" as placeholder) when the lights differ. */
const shown = () => (props.mixed ? '' : props.toUnit(props.value).toFixed(props.digits ?? 0))
const text = ref(shown())
const editing = ref(false)
watch([() => props.value, () => props.mixed], () => {
  if (!editing.value) text.value = shown()
})

function commit() {
  if (!editing.value) return // Esc already put the value back
  editing.value = false
  const typed = Number(text.value.replace(',', '.'))
  // Only a changed number sets the light, so clicking in and out leaves no empty undo step.
  if (text.value.trim() !== '' && text.value !== shown() && Number.isFinite(typed)) emit('set', Math.min(1, Math.max(0, props.fromUnit(typed))))
  text.value = shown() // what the light ended up with, after clamping to its range
}

function cancel(event: KeyboardEvent) {
  editing.value = false
  text.value = shown()
  ;(event.target as HTMLInputElement).blur()
}
</script>

<template>
  <span class="field">
    <input
      v-model="text"
      type="text"
      inputmode="decimal"
      :placeholder="mixed ? 'mixed' : ''"
      :aria-label="label"
      @focus="editing = true"
      @blur="commit"
      @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
      @keydown.esc.stop.prevent="cancel"
    />
    <span class="unit">{{ unit }}</span>
  </span>
</template>

<style scoped>
.field {
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
}
input {
  width: 46px;
  padding: 1px 4px;
  text-align: right;
  font: inherit;
  font-variant-numeric: tabular-nums;
  color: var(--accent-text);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
}
input:hover {
  border-color: var(--border);
}
input:focus {
  outline: none;
  color: var(--text-bright);
  background: var(--well);
  border-color: var(--accent);
}
input::placeholder {
  color: var(--text-muted);
}
.unit {
  color: var(--text-muted);
  font-size: 12px;
}
</style>
