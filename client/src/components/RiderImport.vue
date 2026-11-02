<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { FixtureDraft } from '../api'
import { useCatalog } from '../stores/catalog'
import { useRider, type Flag, type RiderStep } from '../stores/rider'
import { useVenues } from '../stores/venues'

const rider = useRider()
const catalog = useCatalog()
const venues = useVenues()

const steps: { id: RiderStep; label: string }[] = [
  { id: 'load', label: 'Rider' },
  { id: 'calibrate', label: 'Place the plan' },
  { id: 'review', label: 'Review' },
]

const pdfInput = ref<HTMLInputElement>()
const jsonInput = ref<HTMLInputElement>()
const done = ref('')

const canCalibrate = computed(() => !!rider.rider?.plan)
const canReview = computed(() => !!rider.similarity)

/** A step is done once the next one can start (the last one once its lights are imported). */
function stepDone(id: RiderStep) {
  return id === 'load' ? canCalibrate.value : id === 'calibrate' ? canReview.value : !!done.value
}
/** Why a step cannot be opened yet, in words; empty when it can. */
function blockedBecause(id: RiderStep) {
  if (id === 'calibrate' && !canCalibrate.value) return rider.rider ? 'Read the plan first.' : 'Add the rider PDF first.'
  if (id === 'review' && !canReview.value) return 'Place the plan first: set points A and B on the plan and in the venue.'
  return ''
}

/** The review step's pages: what to check, the lights themselves, and how lights without a truss are hung. */
const reviewTab = ref<'check' | 'lights' | 'options'>('check')
const flagCount = computed(() => grouped.value.reduce((n, g) => n + g.items.length, 0))
/** Changing the saved API key: the field shows only while there is no key, or when asked for. */
const changingKey = ref(false)

function go(step: RiderStep) {
  if (step === 'calibrate' && !canCalibrate.value) return
  if (step === 'review' && !canReview.value) return
  rider.step = step
  rider.pickingWorld = null
  rider.select([])
  if (step === 'review') void rider.refreshDrafts()
}

async function onPdf(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  ;(event.target as HTMLInputElement).value = ''
  if (file) await rider.uploadPdf(file)
}
async function onJson(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  ;(event.target as HTMLInputElement).value = ''
  if (file) await rider.uploadJson(file)
}

// --- the plan picture: click to set the reference point that is selected ---

const activePoint = ref(0)
const image = ref<HTMLImageElement>()

function onPlanClick(event: MouseEvent) {
  const img = image.value
  const view = rider.planImage
  if (!img || !view) return
  const box = img.getBoundingClientRect()
  const [x0, y0, x1, y1] = view.crop
  const x = x0 + ((event.clientX - box.left) / box.width) * (x1 - x0)
  const y = y0 + ((event.clientY - box.top) / box.height) * (y1 - y0)
  rider.setPlanPoint(activePoint.value, [Math.round(x), Math.round(y)])
}

/** Where a plan point sits on the shown picture, in percent. */
function marker(p: [number, number]) {
  const view = rider.planImage
  if (!view) return { display: 'none' }
  const [x0, y0, x1, y1] = view.crop
  return { left: `${((p[0] - x0) / (x1 - x0)) * 100}%`, top: `${((p[1] - y0) / (y1 - y0)) * 100}%` }
}

/** Dots for the lights the reader found, so the picture shows what was read. */
const lampDots = computed(() => (rider.rider?.lamps ?? []).map((l) => ({ id: l.lampId, style: marker(l.planPx) })))

/** How the scale of the two reference points compares with the stage width the plan states. */
const scaleCheck = computed(() => {
  const s = rider.similarity
  const plan = rider.rider?.plan
  const edge = plan?.stage?.planPx
  if (!s || !plan?.stage || !edge) return null
  const px = Math.hypot(edge[1][0] - edge[0][0], edge[1][1] - edge[0][1])
  const metersPerPx = plan.stage.width / px
  return { ratio: s.scale / metersPerPx, text: `${s.scale.toFixed(4)} m per plan pixel` }
})
const scaleWarning = computed(() => {
  const r = scaleCheck.value?.ratio
  return r !== undefined && Math.abs(r - 1) > 0.08 ? `The plan's stage line says ${(100 * r).toFixed(0)}% of this scale: the two points may not be the same spots in the plan and the venue.` : ''
})

// --- review ---

const KIND_ORDER: Flag['kind'][] = ['choose', 'position', 'disagree', 'assumed', 'skipped', 'read']
const KIND_TITLE: Record<Flag['kind'], string> = {
  choose: 'Needs a fixture type',
  position: 'Patched, but not on the plan (no position)',
  disagree: 'Plan and patch disagree (the newer patch wins)',
  assumed: 'Assumed or approximate: check',
  skipped: 'Not imported',
  read: 'Reading notes',
}
const grouped = computed(() =>
  KIND_ORDER.map((kind) => ({ kind, title: KIND_TITLE[kind], items: rider.flags.filter((f) => f.kind === kind) })).filter((g) => g.items.length),
)
const open = ref(new Set<string>(['choose', 'position', 'disagree']))
const toggleOpen = (kind: string) => {
  const next = new Set(open.value)
  if (next.has(kind)) next.delete(kind)
  else next.add(kind)
  open.value = next
}

const options = computed(() => catalog.all.map((f) => ({ id: f.id, label: `${f.manufacturer} ${f.name}` })))
const labelOf = (id?: string) => options.value.find((o) => o.id === id)?.label ?? ''
function onType(d: FixtureDraft, event: Event) {
  const value = (event.target as HTMLInputElement).value.trim()
  if (!value) return rider.setOverride(d.fixId, '')
  const wanted = value.toLowerCase()
  // an exact name, or text that only one fixture's name contains
  const partial = options.value.filter((o) => o.label.toLowerCase().includes(wanted))
  const hit = options.value.find((o) => o.label.toLowerCase() === wanted) ?? (partial.length === 1 ? partial[0] : undefined)
  if (hit) rider.setOverride(d.fixId, hit.id)
  else (event.target as HTMLInputElement).value = labelOf(d.profileId)
}

const statusText: Record<FixtureDraft['status'], string> = { ready: '', unmapped: 'choose type', unplaced: 'no position', ignored: 'not a light' }

function heightText(d: FixtureDraft) {
  const p = d.placement
  if (!p) return ''
  const y = rider.positionOf(d)[1].toFixed(1)
  const text = p.height === 'truss' ? `${p.truss} ${y} m` : p.height === 'stand' ? `stand ${y} m` : 'ceiling'
  return isMoved(d.key) ? `${text} ✎` : text
}

// moving lights: a distance to move the selection by, typed in meters
const move = ref<[number, number, number]>([0, 0, 0])
function applyMove() {
  rider.nudge(move.value)
  move.value = [0, 0, 0]
}
function setMove(axis: number, event: Event) {
  const n = Number((event.target as HTMLInputElement).value)
  const next: [number, number, number] = [...move.value]
  next[axis] = Number.isFinite(n) ? n : 0
  move.value = next
}
const isAdd = (event: MouseEvent) => event.ctrlKey || event.metaKey || event.shiftKey
const isMoved = (key: string) => (rider.adjust[key] ?? []).some((n) => Math.abs(n) > 1e-6)

function runImport() {
  const r = rider.importNow()
  done.value = `Added ${r.added} lights${r.replaced ? `, replaced ${r.replaced}` : ''}${r.skipped ? `, skipped ${r.skipped} already imported` : ''}.`
}

watch(() => rider.open, (open) => open && catalog.load(), { immediate: true })
watch(() => rider.step, () => (done.value = ''))
const venueName = computed(() => venues.current?.name ?? '')
</script>

<template>
  <aside class="panel" role="dialog" aria-label="Import tech rider" @pointerdown.stop @keydown.stop>
    <header>
      <h2>Import tech rider <span class="venue">· {{ venueName }}</span></h2>
      <button class="close" aria-label="Close" @click="rider.close()">×</button>
    </header>
    <nav class="steps">
      <button
        v-for="(s, i) in steps"
        :key="s.id"
        :class="{ active: rider.step === s.id, done: stepDone(s.id) }"
        :disabled="!!blockedBecause(s.id)"
        :title="blockedBecause(s.id)"
        @click="go(s.id)"
      >
        <span class="mark">{{ stepDone(s.id) && rider.step !== s.id ? '✓' : i + 1 }}</span>{{ s.label }}
      </button>
    </nav>

    <div class="body">
      <p v-if="rider.busy" class="busy">{{ rider.busy }}</p>
      <p v-if="rider.error" class="error">{{ rider.error }}</p>

      <!-- 1: the rider -->
      <template v-if="rider.step === 'load'">
        <section v-if="rider.rider">
          <h3>This venue's rider</h3>
          <p>
            Patch: <b>{{ rider.rider.patch.rows.length }}</b> rows<span v-if="rider.rider.patch.date"> (table dated {{ rider.rider.patch.date }})</span>.
            <template v-if="rider.rider.plan">Plan: <b>{{ rider.rider.lamps?.length ?? 0 }}</b> lights on {{ Object.keys(rider.rider.plan.trusses).length }} trusses<span v-if="rider.rider.plan.date"> (plan dated {{ rider.rider.plan.date }})</span>.</template>
            <template v-else>The plan has not been read yet.</template>
          </p>
          <ul v-if="rider.rider.issues.length" class="plain">
            <li v-for="i in rider.rider.issues" :key="i" class="flag">{{ i }}</li>
          </ul>
        </section>

        <section>
          <h3>{{ rider.rider ? 'Replace it' : 'Add the rider' }}</h3>
          <div class="row">
            <button @click="pdfInput?.click()">Choose the rider PDF…</button>
            <button v-if="rider.rider" class="link" @click="jsonInput?.click()">or a rider file (.json)…</button>
            <button v-if="rider.rider" class="link danger" @click="rider.removeRider()">Remove</button>
          </div>
          <input ref="pdfInput" type="file" accept="application/pdf,.pdf" hidden @change="onPdf" />
          <input ref="jsonInput" type="file" accept="application/json,.json" hidden @change="onJson" />
          <p class="hint">The patch table is read from the PDF's text right away. The plan is a picture, so a vision model reads it.</p>
        </section>

        <section v-if="rider.rider">
          <h3>Read the plan</h3>
          <div v-if="rider.apiKey && !changingKey" class="row key">
            <span class="hint">Anthropic API key saved in this browser.</span>
            <button class="link" @click="changingKey = true">Change</button>
          </div>
          <div v-else class="row">
            <select v-model="rider.provider" aria-label="Vision provider"><option value="anthropic">Anthropic</option></select>
            <input v-model="rider.apiKey" type="password" placeholder="API key" autocomplete="off" aria-label="API key" />
          </div>
          <div class="row">
            <button class="primary" :disabled="!!rider.busy" @click="rider.readPlan()">{{ rider.rider.plan ? 'Read the plan again' : 'Read the plan' }}</button>
          </div>
          <p class="hint">The key stays in this browser and goes to the server only with this request. It takes about a minute.</p>
        </section>
      </template>

      <!-- 2: place the plan -->
      <template v-else-if="rider.step === 'calibrate'">
        <p class="hint">Tell preflight where the plan sits in the venue: pick two spots that are easy to find in both, such as the two front corners of the stage. Select a point, click it on the plan, then click <b>Pick in venue</b> and click the same spot in the 3D view. The view looks down on the venue and hides the crowd and the lights meanwhile; it goes back when you leave this step.</p>
        <div class="row">
          <button @click="rider.viewTurns++">Turn the view ⟳</button>
          <span class="hint">so the stage is at the top, like on the plan</span>
        </div>
        <label class="check"><input v-model="rider.hideClutter" type="checkbox" /> Hide small objects on the floor (speaker stacks, truss towers…) so the spots under them can be picked</label>
        <div v-if="rider.planImage" class="plan" :class="{ crosshair: true }">
          <img ref="image" :src="rider.planImage.url" alt="The plan page of the rider" @click="onPlanClick" />
          <span v-for="dot in lampDots" :key="dot.id" class="dot" :style="dot.style" />
          <span v-for="(p, i) in rider.planPoints" :key="i" v-show="p" class="ref" :class="{ on: activePoint === i }" :style="p ? marker(p) : {}">{{ 'AB'[i] }}</span>
        </div>
        <ul class="plain points">
          <li v-for="i in [0, 1]" :key="i" :class="{ on: activePoint === i }">
            <label><input v-model="activePoint" type="radio" :value="i" /> Point {{ 'AB'[i] }}</label>
            <span class="coords">{{ rider.planPoints[i] ? `plan ${rider.planPoints[i]![0]}, ${rider.planPoints[i]![1]}` : 'click it on the plan' }}</span>
            <button :class="{ armed: rider.pickingWorld === i }" @click="rider.pickingWorld = rider.pickingWorld === i ? null : i">{{ rider.pickingWorld === i ? 'Click in the 3D view…' : 'Pick in venue' }}</button>
            <span class="coords">{{ rider.worldPoints[i] ? `venue ${rider.worldPoints[i]![0].toFixed(2)}, ${rider.worldPoints[i]![1].toFixed(2)} m` : 'not set' }}</span>
          </li>
        </ul>
        <p v-if="rider.similarity" class="ok">Placed: {{ scaleCheck?.text ?? `${rider.similarity.scale.toFixed(4)} m per plan pixel` }}.</p>
        <p v-if="scaleWarning" class="warn">{{ scaleWarning }}</p>
      </template>

      <!-- 3: review -->
      <template v-else>
        <nav v-if="rider.result" class="pages" role="tablist" aria-label="Review">
          <button role="tab" :aria-selected="reviewTab === 'check'" :class="{ on: reviewTab === 'check' }" @click="reviewTab = 'check'">Check <span class="count">{{ flagCount }}</span></button>
          <button role="tab" :aria-selected="reviewTab === 'lights'" :class="{ on: reviewTab === 'lights' }" @click="reviewTab = 'lights'">Lights <span class="count">{{ rider.importable.length }}</span></button>
          <button role="tab" :aria-selected="reviewTab === 'options'" :class="{ on: reviewTab === 'options' }" @click="reviewTab = 'options'">Options</button>
        </nav>

        <section v-if="rider.result" v-show="reviewTab === 'check'">
          <h3>Check these before importing</h3>
          <p v-if="!grouped.length" class="ok">Nothing flagged.</p>
          <div v-for="g in grouped" :key="g.kind" class="flags" :class="g.kind">
            <button class="flaghead" @click="toggleOpen(g.kind)">
              <span class="caret">{{ open.has(g.kind) ? '▾' : '▸' }}</span> {{ g.title }} <span class="count">{{ g.items.length }}</span>
            </button>
            <ul v-if="open.has(g.kind)" class="plain">
              <li v-for="f in g.items" :key="f.text">
                {{ f.text }}
                <span v-if="f.ids.length" class="ids">{{ f.ids.slice(0, 14).join(' ') }}{{ f.ids.length > 14 ? ` +${f.ids.length - 14}` : '' }}</span>
              </li>
            </ul>
          </div>
        </section>
        <p v-else-if="!rider.busy" class="hint">Working out the lights…</p>

        <section v-if="rider.result" v-show="reviewTab === 'lights'">
          <h3>Lights ({{ rider.importable.length }} of {{ rider.result.drafts.length }} will be imported)</h3>
          <div class="tablewrap">
            <table>
              <thead><tr><th /><th>#</th><th>Name</th><th>Type</th><th>Mode</th><th>Addr</th><th>Hangs</th><th /></tr></thead>
              <tbody>
                <tr v-for="d in rider.result.drafts" :key="d.key" :class="[d.status, { off: rider.excluded.has(d.key), picked: rider.selectedKeys.includes(d.key) }]" :title="d.notes.join('\n')" @click="d.placement && (isAdd($event) ? rider.toggleSelected(d.key) : rider.select([d.key]))">
                  <td><input type="checkbox" :checked="!rider.excluded.has(d.key)" :disabled="!d.profileId || !d.placement" :aria-label="`Import ${d.name}`" @click.stop @change="rider.toggleIncluded(d.key)" /></td>
                  <td>{{ d.lampId ?? d.fixId }}</td>
                  <td class="name">{{ d.name }}</td>
                  <td><input class="type" list="rider-types" :value="labelOf(d.profileId)" :placeholder="d.status === 'ignored' ? '' : 'choose…'" :aria-label="`Fixture type of ${d.name}`" :disabled="d.status === 'ignored'" @click.stop @change="onType(d, $event)" /></td>
                  <td>{{ d.mode ?? '' }}</td>
                  <td>{{ d.patch ? `${d.patch.universe}.${d.patch.address}` : '' }}</td>
                  <td>{{ heightText(d) }}</td>
                  <td class="state">{{ statusText[d.status] }}{{ d.notes.length && d.status === 'ready' ? ' ⓘ' : '' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <datalist id="rider-types"><option v-for="o in options" :key="o.id" :value="o.label" /></datalist>
        </section>

        <section v-if="rider.result" v-show="reviewTab === 'lights'" class="move">
          <h3>Move lights</h3>
          <p class="hint">Select lights by clicking a dot in the 3D view or a row (Ctrl or Shift adds), or a whole truss below. Drag the arrows in the view, or type a distance. Dots: green on a truss, amber height assumed, white selected.</p>
          <div class="row chips">
            <button v-for="g in rider.result.groups" :key="g.name" @click="rider.selectGroup(g.name, isAdd($event))">{{ g.name }} ({{ g.keys.length }})</button>
            <button @click="rider.selectAll()">All</button>
            <button class="link" :disabled="!rider.selectedKeys.length" @click="rider.select([])">None</button>
          </div>
          <div v-if="rider.selectedKeys.length" class="row">
            <span>{{ rider.selectedKeys.length }} selected · move by</span>
            <label v-for="(axis, i) in ['X', 'Y', 'Z']" :key="axis" class="axis">{{ axis }}
              <input type="number" step="0.1" :value="move[i]" :aria-label="`Move by ${axis} in meters`" @change="setMove(i, $event)" @keydown.enter="applyMove" />
            </label>
            <span>m</span>
            <button :disabled="move.every((n) => n === 0)" @click="applyMove">Move</button>
            <button class="link" @click="rider.resetAdjust(rider.selectedKeys)">Undo moves of these</button>
          </div>
          <p v-if="rider.movedCount" class="hint">
            {{ rider.movedCount }} {{ rider.movedCount === 1 ? 'light' : 'lights' }} moved by hand (✎ in the table).
            <button class="link" @click="rider.resetAdjust()">Undo all moves</button>
          </p>
        </section>

        <section v-if="rider.result" v-show="reviewTab === 'options'" class="settings">
          <label>Ceiling height if it cannot be measured <input v-model.number="rider.ceilingHeight" type="number" step="0.1" min="1" max="30" /> m</label>
          <label>Lights on a stand sit <input v-model.number="rider.standHeight" type="number" step="0.1" min="0" max="10" /> m above the floor</label>
          <label><input v-model="rider.measure" type="checkbox" /> Hang lights that are on no truss from the ceiling measured in the model</label>
          <label v-if="rider.alreadyThere.length">
            {{ rider.alreadyThere.length }} of these came from this rider before:
            <select v-model="rider.onExisting"><option value="skip">keep them as they are</option><option value="replace">replace them</option></select>
          </label>
        </section>
      </template>
    </div>

    <footer>
      <template v-if="rider.step === 'load'">
        <span v-if="blockedBecause('calibrate')" class="why">{{ blockedBecause('calibrate') }}</span>
        <button class="primary" :disabled="!canCalibrate" @click="go('calibrate')">Place the plan →</button>
      </template>
      <template v-else-if="rider.step === 'calibrate'">
        <button @click="go('load')">← Back</button>
        <span v-if="blockedBecause('review')" class="why">Set points A and B first.</span>
        <button class="primary" :disabled="!canReview" @click="go('review')">Review →</button>
      </template>
      <template v-else>
        <button @click="go('calibrate')">← Back</button>
        <span v-if="done" class="ok">{{ done }}</span>
        <button class="primary" :disabled="!rider.importable.length || !!rider.busy" @click="runImport">Import {{ rider.importable.length }} lights</button>
      </template>
    </footer>
  </aside>
</template>

<style scoped>
.panel {
  position: absolute;
  top: 12px;
  right: 12px;
  bottom: 12px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  width: min(560px, calc(100% - 24px));
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow-lg);
  font: 13px/1.4 var(--font-sans);
  color: var(--text);
  overflow: hidden;
}
header,
footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
}
header {
  border-bottom: 1px solid var(--border);
}
footer {
  border-top: 1px solid var(--border);
  justify-content: flex-end;
}
footer > :first-child:not(.primary) {
  margin-right: auto;
}
h2 {
  margin: 0;
  margin-right: auto;
  font-size: 15px;
}
.venue {
  font-weight: normal;
  color: var(--text-muted);
}
h3 {
  margin: 0 0 6px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  font-weight: 600;
}
.close {
  background: none;
  border: 0;
  color: var(--text-muted);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}
.close:hover {
  color: var(--text-bright);
}
.steps {
  display: flex;
  border-bottom: 1px solid var(--border);
}
.steps button {
  flex: 1;
  padding: 8px;
  color: var(--text-muted);
  background: none;
  border: 0;
  border-bottom: 2px solid transparent;
}
.steps button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
}
.mark {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  border: 1px solid var(--border);
}
.steps button.active .mark {
  color: var(--text-bright);
  background: var(--accent-strong);
  border-color: var(--accent-strong);
}
.steps button.done:not(.active) .mark {
  color: var(--ok);
  border-color: var(--ok);
}
.steps button.active {
  color: var(--text-bright);
  border-bottom-color: var(--accent-strong);
}
.steps button:disabled {
  opacity: 0.4;
  cursor: default;
}
.body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px;
  overflow-y: auto;
  min-height: 0;
  flex: 1;
}
section p,
.body > p {
  margin: 0 0 6px;
}
button {
  font: inherit;
  cursor: pointer;
  padding: 6px 12px;
  color: var(--text-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
}
button.primary {
  color: var(--text-bright);
  background: var(--accent-strong);
  border: 0;
}
button.primary:disabled {
  opacity: 0.5;
  cursor: default;
}
button.link {
  background: none;
  border: 0;
  color: var(--accent);
  padding: 0 4px;
}
button.link.danger {
  color: var(--danger);
  margin-left: auto;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
input[type='password'],
input[type='number'],
select,
input.type {
  padding: 4px 8px;
  color: inherit;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  font: inherit;
}
input[type='password'] {
  flex: 1;
  min-width: 160px;
}
input[type='number'] {
  width: 64px;
}
.hint {
  color: var(--text-muted);
}
.busy {
  color: var(--accent);
}
.error,
.warn {
  color: #f0a060;
}
.error {
  color: var(--danger);
}
.ok {
  color: var(--ok);
  margin: 0;
}
ul.plain {
  list-style: none;
  margin: 0;
  padding: 0;
}
.flag {
  color: #f0a060;
  padding: 2px 0;
}
.plan {
  position: relative;
  border: 1px solid var(--border);
  background: #fff;
  line-height: 0;
}
.plan img {
  display: block;
  width: 100%;
  cursor: crosshair;
}
.plan .dot {
  position: absolute;
  width: 6px;
  height: 6px;
  margin: -3px 0 0 -3px;
  border-radius: 50%;
  background: rgba(220, 0, 90, 0.75);
  pointer-events: none;
}
.plan .ref {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin: -11px 0 0 -11px;
  color: var(--text-bright);
  font: bold 12px system-ui;
  background: var(--accent-strong);
  border: 2px solid #fff;
  border-radius: 50%;
  pointer-events: none;
}
.plan .ref.on {
  background: #e8590c;
}
.points li {
  display: grid;
  grid-template-columns: 90px 1fr auto 1fr;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 4px;
}
.points li.on {
  background: var(--surface-2);
}
.coords {
  color: var(--text-muted);
  font-size: 12px;
}
button.armed {
  color: var(--text-bright);
  background: #e8590c;
  border-color: #e8590c;
}
.flags {
  margin-bottom: 6px;
  border-left: 3px solid #555;
  background: #1f1f2a;
  border-radius: 0 4px 4px 0;
}
.flags.choose,
.flags.position {
  border-left-color: var(--danger);
}
.flags.disagree,
.flags.assumed {
  border-left-color: #f0a060;
}
.flaghead {
  width: 100%;
  text-align: left;
  background: none;
  border: 0;
  padding: 6px 8px;
}
.count {
  float: right;
  color: var(--text-muted);
}
.flags ul {
  padding: 0 10px 8px 22px;
}
.flags li {
  margin: 3px 0;
  color: var(--text-2);
}
.ids {
  display: block;
  color: var(--text-muted);
  font-size: 12px;
}
.tablewrap {
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 4px;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
th {
  position: sticky;
  top: 0;
  background: var(--surface-2);
  text-align: left;
  font-weight: 600;
  color: var(--text-muted);
  padding: 4px 6px;
}
td {
  padding: 3px 6px;
  border-top: 1px solid #25252f;
  white-space: nowrap;
}
td.name {
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
}
input.type {
  width: 150px;
  padding: 2px 6px;
  font-size: 12px;
}
tr.unmapped td,
tr.unplaced td {
  color: #f0a060;
}
tr.ignored td,
tr.off td {
  color: var(--text-dim);
}
td.state {
  color: var(--text-muted);
}
.chips button {
  padding: 3px 10px;
}
.axis input {
  width: 56px;
}
tr.picked td {
  background: #2a2f4a;
}
tr {
  cursor: default;
}
.check {
  display: block;
  color: var(--text-2);
}
.settings label {
  display: block;
  margin: 4px 0;
}
.pages {
  display: flex;
  gap: 2px;
  margin-bottom: 12px;
  padding: 3px;
  background: var(--well);
  border: 1px solid var(--line);
  border-radius: 7px;
}
.pages button {
  flex: 1;
  padding: 5px 4px;
  color: var(--text-muted);
  background: none;
  border: 0;
  border-radius: 5px;
  font: inherit;
  cursor: pointer;
}
.pages button.on {
  color: var(--text-bright);
  background: var(--selected);
}
.pages .count {
  margin-left: 4px;
  font-size: 11px;
  color: var(--text-muted);
}
.why {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-muted);
}
.key {
  align-items: center;
}
</style>
