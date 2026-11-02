<script setup lang="ts">
import { computed } from 'vue'
import InfoTip from './InfoTip.vue'
import ValueField from './ValueField.vue'
import type { Fixture } from '../api'
import { FOCUS_FAR, FOCUS_NEAR, beamAngleDegrees, focusDistance, goboSpinTurns, profileFor, strobeHz, travelDegrees } from '../fixtures/profiles'
import { GOBOS, goboIndex, goboThumbnails, goboValue } from '../scene/goboLibrary'
import { MAX_GOBO_LIGHTS, MAX_SHADOW_LIGHTS } from '../scene/FixtureRig'
import { useRig } from '../stores/rig'
import { useSettings } from '../stores/settings'
import { useStats } from '../stores/stats'

const rig = useRig()
const settings = useSettings()
const stats = useStats()
const fixture = computed(() => rig.selected)
const profile = computed(() => (fixture.value ? profileFor(fixture.value.profileId) : undefined))

const SWATCHES: { name: string; rgb: [number, number, number] }[] = [
  { name: 'White', rgb: [1, 1, 1] },
  { name: 'Warm', rgb: [1, 0.78, 0.5] },
  { name: 'Red', rgb: [1, 0, 0] },
  { name: 'Amber', rgb: [1, 0.55, 0] },
  { name: 'Green', rgb: [0, 1, 0.2] },
  { name: 'Cyan', rgb: [0, 0.9, 1] },
  { name: 'Blue', rgb: [0.1, 0.2, 1] },
  { name: 'Magenta', rgb: [1, 0, 0.8] },
]

const value = (key: string) => fixture.value?.values[key] ?? profile.value?.defaults[key] ?? 0

const hex = computed(() => {
  const to = (key: string) => Math.round(value(key) * 255).toString(16).padStart(2, '0')
  return `#${to('red')}${to('green')}${to('blue')}`
})

function setHex(event: Event) {
  const h = (event.target as HTMLInputElement).value
  setRgb([parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255])
}

function setRgb([red, green, blue]: [number, number, number]) {
  if (fixture.value) rig.setValues(fixture.value.id, { red, green, blue })
}

function onSlider(key: string, event: Event) {
  setValue(key, Number((event.target as HTMLInputElement).value))
}

function setValue(key: string, v: number) {
  if (fixture.value) rig.setValue(fixture.value.id, key, v)
}

/** The typed fields' conversions back from the unit to the 0..1 value (the inverse of beamAngleDegrees and focusDistance). */
function zoomFromDegrees(degrees: number) {
  const [narrow, wide] = profile.value?.beamAngle ?? [0, 0]
  return wide === narrow ? 0 : (degrees - narrow) / (wide - narrow)
}
const focusFromMeters = (meters: number) => Math.log(Math.max(meters, 1e-3) / FOCUS_NEAR) / Math.log(FOCUS_FAR / FOCUS_NEAR)
/** The light has controls that shape its beam. */
const hasBeam = computed(() => !!profile.value && (profile.value.controls.zoom || profile.value.controls.focus || profile.value.controls.gobo))

const castsShadow = computed(() => fixture.value?.castShadows !== false)
/** The light wants to cast a shadow (and shadows are on) but the limit is used up by other lights. */
const shadowBudgetFull = computed(
  () => settings.shadows && castsShadow.value && !!fixture.value && !stats.shadowed.includes(fixture.value.id) && value('dimmer') > 0.001,
)

function setMode(event: Event) {
  if (fixture.value) rig.update(fixture.value.id, { mode: (event.target as HTMLSelectElement).value })
}

function setCastsShadow(event: Event) {
  if (fixture.value) rig.update(fixture.value.id, { castShadows: (event.target as HTMLInputElement).checked })
}

/** Which way the base faces, from where its local up axis (away from the mount) points. */
const orientation = computed(() => {
  const f = fixture.value
  if (!f) return ''
  let upY: number
  if (f.rotation) {
    const [x, , z] = f.rotation
    upY = 1 - 2 * (x * x + z * z) // y component of the rotated +Y axis, for a unit quaternion
  } else {
    upY = f.mount === 'hanging' ? -1 : 1
  }
  return upY > 0.5 ? 'standing' : upY < -0.5 ? 'hanging' : 'mounted on its side'
})

/** What the spread and fan sliders say: the distance between the spots the lights aim at, and the angle between the outer beams. */
const spreadLabel = computed(() => (Math.abs(rig.aim.spread) < 0.05 ? 'all on the point' : `${rig.aim.spread.toFixed(1)} m apart`))
const fanLabel = computed(() => (Math.abs(rig.aim.fan) < 0.5 ? 'off' : `${Math.round(rig.aim.fan)}°`))
const cannotReach = computed(() =>
  rig.aim.unreachable.map((id) => rig.fixtures.find((f) => f.id === id)?.name).filter((name): name is string => !!name),
)

const gobos = computed(() => goboThumbnails())
const goboPicked = computed(() => goboIndex(value('gobo')))
/** This light has a gobo and is lit, but the lights that project one onto surfaces are all taken. */
const goboBudgetFull = computed(
  () => !!fixture.value && goboPicked.value > 0 && value('dimmer') > 0.001 && !stats.projected.includes(fixture.value.id),
)
function pickGobo(index: number) {
  if (fixture.value) rig.setValue(fixture.value.id, 'gobo', goboValue(index))
}
const spinLabel = computed(() => {
  const turns = goboSpinTurns(value('goboSpin'))
  return turns === 0 ? 'stopped' : `${Math.abs(turns * 60).toFixed(0)} rpm ${turns > 0 ? '↻' : '↺'}`
})

/** The strobe rate as text: "off", or flashes per second. */
const strobeLabel = (strobe: number) => {
  const hz = strobeHz(strobe)
  return hz === 0 ? 'off' : `${hz < 10 ? hz.toFixed(1) : Math.round(hz)} Hz`
}

/** Keys pressed inside the panel (arrow keys on a slider, say) must not also steer the camera. Escape and Ctrl/Cmd shortcuts still get out. */
function keepKeys(event: KeyboardEvent) {
  if (event.key !== 'Escape' && !event.metaKey && !event.ctrlKey) event.stopPropagation() // shortcuts like Undo still work
}

// --- several lights selected ------------------------------------------------------------------

const group = computed(() => (rig.selectedIds.length > 1 ? rig.selection : []))
type GroupControl = 'dimmer' | 'zoom' | 'focus' | 'pan' | 'tilt' | 'color' | 'strobe' | 'gobo' | 'goboAngle' | 'goboSpin'

const valueOf = (f: Fixture, key: string) => f.values[key] ?? profileFor(f.profileId).defaults[key] ?? 0

/** The selected lights that have this control (every light has a dimmer). */
const having = (key: GroupControl) =>
  group.value.filter((f) => key === 'dimmer' || profileFor(f.profileId).controls[key.startsWith('gobo') ? 'gobo' : (key as 'zoom')])

/** The shared value of a control, or its average and `mixed` when the lights differ. */
function summary(key: string, list: Fixture[]) {
  const values = list.map((f) => valueOf(f, key))
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)
  return { mixed: values.length > 0 && Math.max(...values) - Math.min(...values) > 0.004, value: mean }
}

const groupControls = computed(() => {
  const out = {} as Record<GroupControl, { count: number; ids: string[]; mixed: boolean; value: number }>
  for (const key of ['dimmer', 'zoom', 'focus', 'pan', 'tilt', 'color', 'strobe', 'gobo', 'goboAngle', 'goboSpin'] as const) {
    const list = having(key)
    out[key] = { count: list.length, ids: list.map((f) => f.id), ...summary(key === 'color' ? 'red' : key, list) }
  }
  const colorLights = having('color')
  out.color.mixed = ['red', 'green', 'blue'].some((k) => summary(k, colorLights).mixed)
  return out
})

const groupHex = computed(() => {
  const lights = having('color')
  if (!lights.length || groupControls.value.color.mixed) return '#808080'
  const to = (key: string) => Math.round(valueOf(lights[0], key) * 255).toString(16).padStart(2, '0')
  return `#${to('red')}${to('green')}${to('blue')}`
})

/** What to show next to a control's name: its value, or "mixed" when the lights differ. */
const groupText = (key: GroupControl, format: (v: number) => string) => (groupControls.value[key].mixed ? 'mixed' : format(groupControls.value[key].value))
const percent = (v: number) => `${Math.round(v * 100)}%`

/** The gobo the lights that have one share (-1 when they differ). */
const groupGobo = computed(() => {
  const gobo = groupControls.value.gobo
  return gobo.mixed ? -1 : goboIndex(gobo.value)
})
/** Some light of the selection has a gobo in the beam, so rotation and spin mean something. */
const groupHasGobo = computed(() => having('gobo').some((f) => goboIndex(valueOf(f, 'gobo')) > 0))
function pickGroupGobo(index: number) {
  rig.setValueMany(groupControls.value.gobo.ids, 'gobo', goboValue(index))
}
const groupSpinLabel = computed(() => {
  const spin = groupControls.value.goboSpin
  if (spin.mixed) return 'mixed'
  const turns = goboSpinTurns(spin.value)
  return turns === 0 ? 'stopped' : `${Math.abs(turns * 60).toFixed(0)} rpm ${turns > 0 ? '↻' : '↺'}`
})

/** The group's sliders in the order of the sections: strobe ends Output, zoom and focus start Beam, pan and tilt are Position. */
const GROUP_SLIDERS = ['strobe', 'zoom', 'focus', 'pan', 'tilt'] as const
const groupHasBeam = computed(() => ['zoom', 'focus', 'gobo'].some((k) => groupControls.value[k as GroupControl].count > 0))

function onGroupSlider(key: GroupControl, event: Event) {
  rig.setValueMany(groupControls.value[key].ids, key, Number((event.target as HTMLInputElement).value))
}

function setGroupRgb([red, green, blue]: [number, number, number]) {
  rig.setValuesMany(groupControls.value.color.ids, { red, green, blue })
}

function setGroupHex(event: Event) {
  const h = (event.target as HTMLInputElement).value
  setGroupRgb([parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255])
}

/** Lights that can cast shadows (not bars and panels), and whether all, none or some of them do. */
const shadowLights = computed(() => group.value.filter((f) => profileFor(f.profileId).emitsLight))
const groupShadow = computed(() => {
  const on = shadowLights.value.filter((f) => f.castShadows !== false).length
  return on === 0 ? 'none' : on === shadowLights.value.length ? 'all' : 'mixed'
})

function setGroupShadows(event: Event) {
  rig.updateMany(shadowLights.value.map((f) => f.id), { castShadows: (event.target as HTMLInputElement).checked })
}

</script>

<template>
  <div v-if="group.length > 1" class="inspector" @pointerdown.stop @keydown="keepKeys">
    <header>
      <div>
        <span class="titleline">
          <strong>{{ rig.activeGroup ? rig.activeGroup.name : `${group.length} lights selected` }}</strong>
          <InfoTip text="Moving a slider sets that value on every selected light that has it. Mixed values show as “mixed” until you move the slider." label="About editing several lights" />
        </span>
        <small v-if="rig.activeGroup">Group of {{ group.length }} lights</small>
        <small class="names">{{ group.map((f) => f.name).join(', ') }}</small>
      </div>
      <button class="close" title="Deselect" aria-label="Deselect" @click="rig.select(null)">×</button>
    </header>

    <template v-if="rig.aimActive">
      <label class="row">
        <span class="label">Spread <output>{{ spreadLabel }}</output></span>
        <input type="range" min="-4" max="4" step="0.1" :value="rig.aim.spread" @input="rig.setAimSpread(Number(($event.target as HTMLInputElement).value))" />
      </label>
      <label class="row">
        <span class="label">Fan <output>{{ fanLabel }}</output></span>
        <input type="range" min="-90" max="90" step="1" :value="rig.aim.fan" @input="rig.setAimFan(Number(($event.target as HTMLInputElement).value))" />
      </label>
      <p v-if="cannotReach.length" class="note">{{ cannotReach.join(', ') }} cannot turn that far and point as close as they can.</p>
    </template>

    <h3 class="part">Output</h3>
    <label class="row">
      <span class="label">Dimmer <ValueField label="Dimmer in percent" :value="groupControls.dimmer.value" :mixed="groupControls.dimmer.mixed" :to-unit="(v) => v * 100" :from-unit="(u) => u / 100" unit="%" @set="rig.setValueMany(groupControls.dimmer.ids, 'dimmer', $event)" /></span>
      <input type="range" min="0" max="1" step="0.01" :value="groupControls.dimmer.value" @input="onGroupSlider('dimmer', $event)" />
    </label>

    <div v-if="groupControls.color.count" class="row">
      <span class="label">
        Color
        <small v-if="groupControls.color.count < group.length">{{ groupControls.color.count }} of {{ group.length }}</small>
        <output v-else-if="groupControls.color.mixed">mixed</output>
      </span>
      <div class="swatches">
        <input type="color" :value="groupHex" aria-label="Color" @input="setGroupHex" />
        <button
          v-for="s in SWATCHES"
          :key="s.name"
          :title="s.name"
          :aria-label="s.name"
          :style="{ background: `rgb(${s.rgb.map((c) => Math.round(c * 255)).join(',')})` }"
          @click="setGroupRgb(s.rgb)"
        />
      </div>
    </div>

    <template v-for="control in GROUP_SLIDERS.slice(0, 3)" :key="control">
      <h3 v-if="control === 'zoom' && groupHasBeam" class="part">Beam</h3>
      <label v-if="groupControls[control].count" class="row">
        <span class="label">
          {{ control[0].toUpperCase() + control.slice(1) }}
          <small v-if="groupControls[control].count < group.length">{{ groupControls[control].count }} of {{ group.length }}</small>
          <output>{{ groupText(control, control === 'strobe' ? strobeLabel : percent) }}</output>
        </span>
        <input type="range" min="0" max="1" :step="control === 'pan' || control === 'tilt' ? 0.0005 : 0.005" :value="groupControls[control].value" @input="onGroupSlider(control, $event)" />
      </label>
    </template>
    <div v-if="groupControls.gobo.count" class="row">
      <span class="label">
        Gobo
        <small v-if="groupControls.gobo.count < group.length">{{ groupControls.gobo.count }} of {{ group.length }}</small>
        <output>{{ groupGobo < 0 ? 'mixed' : groupGobo ? GOBOS[groupGobo - 1].name : 'open' }}</output>
      </span>
      <div class="gobos" role="group" aria-label="Gobo">
        <button :class="{ on: groupGobo === 0 }" title="Open (no gobo)" aria-label="Open" @click="pickGroupGobo(0)">○</button>
        <button
          v-for="(src, i) in gobos"
          :key="GOBOS[i].name"
          :class="{ on: groupGobo === i + 1 }"
          :title="GOBOS[i].name"
          :aria-label="GOBOS[i].name"
          @click="pickGroupGobo(i + 1)"
        >
          <img :src="src" alt="" />
        </button>
      </div>
    </div>
    <template v-if="groupControls.gobo.count && groupHasGobo">
      <label class="row">
        <span class="label">Gobo rotation <output>{{ groupText('goboAngle', (v) => `${Math.round(v * 360)}°`) }}</output></span>
        <input type="range" min="0" max="1" step="0.0025" :value="groupControls.goboAngle.value" @input="onGroupSlider('goboAngle', $event)" />
      </label>
      <label class="row">
        <span class="label">Gobo spin <output>{{ groupSpinLabel }}</output></span>
        <input type="range" min="0" max="1" step="0.005" :value="groupControls.goboSpin.value" @input="onGroupSlider('goboSpin', $event)" />
      </label>
    </template>

    <template v-for="control in GROUP_SLIDERS.slice(3)" :key="control">
      <h3 v-if="control === 'pan' && (groupControls.pan.count || groupControls.tilt.count)" class="part">Position</h3>
      <label v-if="groupControls[control].count" class="row">
        <span class="label">
          {{ control[0].toUpperCase() + control.slice(1) }}
          <small v-if="groupControls[control].count < group.length">{{ groupControls[control].count }} of {{ group.length }}</small>
          <output>{{ groupText(control, control === 'strobe' ? strobeLabel : percent) }}</output>
        </span>
        <input type="range" min="0" max="1" :step="control === 'pan' || control === 'tilt' ? 0.0005 : 0.005" :value="groupControls[control].value" @input="onGroupSlider(control, $event)" />
      </label>
    </template>

    <h3 v-if="shadowLights.length" class="part">Setup</h3>
    <label v-if="shadowLights.length" class="shadow">
      <input type="checkbox" :checked="groupShadow === 'all'" :indeterminate="groupShadow === 'mixed'" :disabled="!settings.shadows" @change="setGroupShadows" />
      <span>Casts shadows<small v-if="groupShadow === 'mixed'"> (some)</small></span>
    </label>

    <footer>
      <button v-if="!rig.activeGroup" title="Keep these lights together as a named group" @click="rig.createGroup()">Save as group</button>
      <button @click="rig.duplicateMany(rig.selectedIds)">Duplicate</button>
      <button class="danger" @click="rig.removeMany(rig.selectedIds)">Delete {{ group.length }}</button>
    </footer>
  </div>
  <div v-else-if="fixture && profile" class="inspector" @pointerdown.stop @keydown="keepKeys">
    <header>
      <div>
        <strong>{{ fixture.name }}</strong>
        <small>{{ profile.manufacturer === 'Generic' ? '' : `${profile.manufacturer} ` }}{{ profile.name }} · {{ orientation }}</small>
      </div>
      <button class="close" title="Deselect" aria-label="Deselect" @click="rig.select(null)">×</button>
    </header>

    <p v-if="rig.aimActive && cannotReach.length" class="note">It cannot turn that far and points as close as it can.</p>

    <h3 class="part">Output</h3>
    <label class="row">
      <span class="label">Dimmer <ValueField label="Dimmer in percent" :value="value('dimmer')" :to-unit="(v) => v * 100" :from-unit="(u) => u / 100" unit="%" @set="setValue('dimmer', $event)" /></span>
      <input type="range" min="0" max="1" step="0.01" :value="value('dimmer')" @input="onSlider('dimmer', $event)" />
    </label>

    <div v-if="profile.controls.color" class="row">
      <span class="label">Color</span>
      <div class="swatches">
        <input type="color" :value="hex" aria-label="Color" @input="setHex" />
        <button
          v-for="s in SWATCHES"
          :key="s.name"
          :title="s.name"
          :aria-label="s.name"
          :style="{ background: `rgb(${s.rgb.map((c) => Math.round(c * 255)).join(',')})` }"
          @click="setRgb(s.rgb)"
        />
      </div>
    </div>

    <label v-if="profile.controls.strobe" class="row">
      <span class="label">Strobe <output>{{ strobeLabel(value('strobe')) }}</output></span>
      <input type="range" min="0" max="1" step="0.005" :value="value('strobe')" @input="onSlider('strobe', $event)" />
      <small v-if="value('strobe') > 0.01 && !settings.previewStrobe" class="hint">Shown steady. Turn on “Flash strobing lights” under Settings › Preferences to see it flash.</small>
    </label>

    <h3 v-if="hasBeam" class="part">Beam</h3>
    <label v-if="profile.controls.zoom" class="row">
      <span class="label">Zoom <ValueField label="Beam angle in degrees" :value="value('zoom')" :to-unit="(v) => beamAngleDegrees(profile!, v)" :from-unit="zoomFromDegrees" unit="° beam" @set="setValue('zoom', $event)" /></span>
      <input type="range" min="0" max="1" step="0.005" :value="value('zoom')" @input="onSlider('zoom', $event)" />
    </label>

    <label v-if="profile.controls.focus" class="row">
      <span class="label">Focus <span>sharp at <ValueField label="Focus distance in meters" :value="value('focus')" :to-unit="focusDistance" :from-unit="focusFromMeters" :digits="1" unit="m" @set="setValue('focus', $event)" /></span></span>
      <input type="range" min="0" max="1" step="0.005" :value="value('focus')" @input="onSlider('focus', $event)" />
    </label>

    <div v-if="profile.controls.gobo" class="row">
      <span class="label">Gobo <output>{{ goboPicked ? GOBOS[goboPicked - 1].name : 'open' }}</output></span>
      <div class="gobos" role="group" aria-label="Gobo">
        <button :class="{ on: !goboPicked }" title="Open (no gobo)" aria-label="Open" @click="pickGobo(0)">○</button>
        <button
          v-for="(src, i) in gobos"
          :key="GOBOS[i].name"
          :class="{ on: goboPicked === i + 1 }"
          :title="GOBOS[i].name"
          :aria-label="GOBOS[i].name"
          @click="pickGobo(i + 1)"
        >
          <img :src="src" alt="" />
        </button>
      </div>
    </div>
    <template v-if="profile.controls.gobo && goboPicked">
      <p v-if="goboBudgetFull" class="note">Only {{ MAX_GOBO_LIGHTS }} lights project a gobo onto surfaces at once, and they are all taken. This one shows its pattern in the haze only.</p>
      <label class="row">
        <span class="label">Gobo rotation <output>{{ Math.round(value('goboAngle') * 360) }}°</output></span>
        <input type="range" min="0" max="1" step="0.0025" :value="value('goboAngle')" @input="onSlider('goboAngle', $event)" />
      </label>
      <label class="row">
        <span class="label">Gobo spin <output>{{ spinLabel }}</output></span>
        <input type="range" min="0" max="1" step="0.005" :value="value('goboSpin')" @input="onSlider('goboSpin', $event)" />
      </label>
    </template>

    <h3 v-if="profile.controls.pan || profile.controls.tilt" class="part">Position</h3>
    <label v-if="profile.controls.pan" class="row">
      <span class="label">Pan <ValueField label="Pan in degrees" :value="value('pan')" :to-unit="(v) => travelDegrees(v, profile!.panRange)" :from-unit="(u) => u / profile!.panRange + 0.5" unit="°" @set="setValue('pan', $event)" /></span>
      <input type="range" min="0" max="1" step="0.0005" :value="value('pan')" @input="onSlider('pan', $event)" />
    </label>

    <label v-if="profile.controls.tilt" class="row">
      <span class="label">Tilt <ValueField label="Tilt in degrees" :value="value('tilt')" :to-unit="(v) => travelDegrees(v, profile!.tiltRange)" :from-unit="(u) => u / profile!.tiltRange + 0.5" unit="°" @set="setValue('tilt', $event)" /></span>
      <input type="range" min="0" max="1" step="0.0005" :value="value('tilt')" @input="onSlider('tilt', $event)" />
    </label>

    <h3 class="part">Setup</h3>
    <label v-if="profile.modes.length > 1" class="row">
      <span class="label">DMX mode</span>
      <select :value="fixture.mode ?? profile.modes[0].name" @change="setMode">
        <option v-for="m in profile.modes" :key="m.name" :value="m.name">{{ m.name }} · {{ m.channels.length }} ch</option>
      </select>
    </label>

    <label class="shadow">
      <input type="checkbox" :checked="castsShadow" :disabled="!settings.shadows" @change="setCastsShadow" />
      <span>Casts shadows</span>
    </label>
    <p v-if="shadowBudgetFull" class="note">Only {{ MAX_SHADOW_LIGHTS }} lights cast shadows at once, and they are all taken. Turn it off on another light to free one.</p>

    <footer>
      <button @click="rig.duplicate(fixture.id)">Duplicate</button>
      <button class="danger" @click="rig.remove(fixture.id)">Delete</button>
    </footer>
  </div>
</template>

<style scoped>
/* Fills the dock beside the view (App.vue). */
.inspector {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 16px 16px;
  color: var(--text);
  font: 13px/1.4 var(--font-sans);
}
header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding-right: 22px; /* room for the dock's fold button */
}
header div {
  display: flex;
  flex-direction: column;
}
small {
  color: var(--text-muted);
  font-size: 12px;
}
header div {
  min-width: 0;
}
.names {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.label small {
  margin: 0 6px 0 auto;
}
.close {
  background: none;
  border: 0;
  color: var(--text-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}
.close:hover {
  color: var(--text);
}
.titleline {
  display: flex;
  align-items: center;
  gap: 4px;
}
.row {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
/* Output, Beam, Position, Setup: the inspector's parts, each opened by a rule and a small title. */
.part {
  margin: 6px 0 -4px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.label {
  align-items: baseline;
}
.label {
  display: flex;
  justify-content: space-between;
}
output {
  font-variant-numeric: tabular-nums;
  color: var(--accent-text);
}
select {
  padding: 4px 6px;
  color: inherit;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  font: inherit;
}
input[type='range'] {
  width: 100%;
  margin: 0;
  accent-color: var(--accent);
}
.swatches {
  display: flex;
  align-items: center;
  gap: 5px;
}
.swatches input[type='color'] {
  width: 28px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: none;
  cursor: pointer;
}
.gobos {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(30px, 1fr));
  gap: 4px;
}
.gobos button {
  aspect-ratio: 1;
  padding: 0;
  display: grid;
  place-items: center;
  color: #9aa0b4;
  background: var(--well);
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
  overflow: hidden;
}
.gobos button.on {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
.gobos img {
  width: 100%;
  height: 100%;
  display: block;
}
.swatches button {
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 50%;
  cursor: pointer;
}
.shadow {
  display: flex;
  align-items: center;
  gap: 8px;
}
.shadow input {
  accent-color: var(--accent);
  margin: 0;
}
.note {
  margin: -4px 0 0;
  font-size: 12px;
  color: var(--warn);
}
.hint {
  font-size: 12px;
  color: var(--warn);
}
footer {
  display: flex;
  gap: 8px;
}
footer button {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: inherit;
  font: inherit;
  padding: 4px 10px;
  cursor: pointer;
}
footer button:hover {
  background: var(--border);
}
footer .danger {
  color: var(--danger);
}
</style>
