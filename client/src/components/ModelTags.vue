<script setup lang="ts">
import { computed } from 'vue'
import { useVenueBox } from '../stores/venueBox'
import { useVenues } from '../stores/venues'
import SidebarSection from './SidebarSection.vue'

const venues = useVenues()
const box = useVenueBox()

const hidden = computed(() => new Set(venues.current?.hiddenTags ?? []))
const eye = 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'
const anyHidden = computed(() => box.tags.some((t) => hidden.value.has(t)))

const noun = computed(() => (box.tagsFromNodes ? 'part' : 'tag'))
const tagsTip =
  'The parts of the SketchUp model, by tag. Hide a tag to take those parts out of the picture, for example a ceiling or a set piece that is in the way. Hidden parts also stop casting shadows and stop catching the aim click. Tags that are hidden in the SketchUp file are not in the model at all.'
const partsTip =
  'The parts of the model, by its top-level objects (as named in Blender or the program that exported it). Hide one to take it out of the picture, for example a ceiling or a set piece that is in the way. Hidden parts also stop casting shadows and stop catching the aim click.'

function showAll() {
  // keeps hidden names this model no longer has, as switching each tag on by itself did
  void venues.setHiddenTags([...hidden.value].filter((t) => !box.tags.includes(t)))
}
</script>

<template>
  <SidebarSection
    v-if="box.tags.length > 1"
    id="tags"
    :title="box.tagsFromNodes ? 'Model parts' : 'Model tags'"
    :tip="box.tagsFromNodes ? partsTip : tagsTip"
    :count="box.tags.length"
  >
    <template #actions><button v-if="anyHidden" class="link" @click="showAll">Show all</button></template>
    <ul>
      <li v-for="tag in box.tags" :key="tag">
        <button
          class="eye"
          :class="{ off: hidden.has(tag) }"
          :title="hidden.has(tag) ? `Show this ${noun}` : `Hide this ${noun}`"
          :aria-label="hidden.has(tag) ? `Show ${tag}` : `Hide ${tag}`"
          @click="venues.setTagHidden(tag, !hidden.has(tag))"
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path :d="eye" />
            <path v-if="hidden.has(tag)" d="M3 3l18 18" />
          </svg>
        </button>
        <span class="name" :class="{ off: hidden.has(tag) }">{{ tag }}</span>
      </li>
    </ul>
  </SidebarSection>
</template>

<style scoped>
.link {
  background: none;
  border: 0;
  color: var(--accent);
  padding: 0;
  font: inherit;
  cursor: pointer;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
li {
  display: flex;
  align-items: center;
  gap: 2px;
}
.eye {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 28px;
  padding: 0;
  color: var(--text-soft);
  background: none;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}
.eye:hover {
  color: var(--text-bright);
  background: var(--surface);
}
.eye.off {
  color: var(--text-disabled);
}
.name {
  flex: 1;
  min-width: 0;
  padding: 0 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.name.off {
  color: var(--text-dim);
}
</style>
