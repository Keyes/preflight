<script setup lang="ts">
import { onMounted, ref } from 'vue'

const props = defineProps<{ initial: string }>()
const emit = defineEmits<{ (e: 'commit', value: string): void; (e: 'cancel'): void }>()

const text = ref(props.initial)
const input = ref<HTMLInputElement>()
let done = false

function commit() {
  if (done) return // Enter is followed by a blur
  done = true
  emit('commit', text.value)
}
function cancel() {
  done = true
  emit('cancel')
}

onMounted(() => {
  input.value?.focus()
  input.value?.select()
})
</script>

<template>
  <input
    ref="input"
    v-model="text"
    class="rename"
    type="text"
    maxlength="80"
    @keydown.enter.prevent="commit"
    @keydown.esc.prevent="cancel"
    @blur="commit"
    @click.stop
  />
</template>

<style scoped>
.rename {
  width: 100%;
  box-sizing: border-box;
  background: var(--surface);
  border: 1px solid var(--accent);
  color: var(--text);
  padding: 7px 9px;
  border-radius: 4px;
  font: 14px/1.4 var(--font-sans);
}
</style>
