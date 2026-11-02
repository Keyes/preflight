import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCanvas } from '@napi-rs/canvas'
import type { RiderLamp, RiderPatchRow } from '../types.js'
import { bands, crossCheck, mergeLamps, normalizeLabel, numberLamps, parseLamps, parseLayout, readPlan, reconcileLabels, trussOnPlan } from './plan.js'
import { parseJsonAnswer, type VisionProvider } from './provider.js'
import { cropPng, toWhole, type PageImage } from './render.js'

const row = (fixId: string, truss: string, name = fixId): RiderPatchRow => ({
  fixId,
  universe: 1,
  address: 1,
  name,
  modeRaw: 'Dim',
  mode: 'Dim',
  channels: 1,
  truss,
})

test('parseJsonAnswer takes bare, fenced and chatty answers', () => {
  assert.deepEqual(parseJsonAnswer('{"a":1}'), { a: 1 })
  assert.deepEqual(parseJsonAnswer('Here you go:\n```json\n{"a":[1,2]}\n```\nDone.'), { a: [1, 2] })
  assert.deepEqual(parseJsonAnswer('The result is {"a":1} as asked'), { a: 1 })
  assert.throws(() => parseJsonAnswer('no json here'))
})

test('normalizeLabel gives rider numbers a hash and leaves other text alone', () => {
  assert.equal(normalizeLabel('201'), '#201')
  assert.equal(normalizeLabel(' #07 '), '#7')
  assert.equal(normalizeLabel('S01'), 'S01')
  assert.equal(normalizeLabel(''), null)
  assert.equal(normalizeLabel(null), null)
})

test('bands overlap, own a core each, and stay inside the drawing', () => {
  const b = bands({ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.7 }, 3, 0.25)
  assert.equal(b.length, 3)
  assert.ok(b[0].region.y0 >= 0 && b[2].region.y1 <= 1)
  assert.ok(b[0].region.y0 <= 0.1 && b[2].region.y1 >= 0.7, 'the bands cover the drawing')
  assert.ok(b[0].region.y1 > b[1].region.y0, 'neighbours overlap')
  assert.ok(b.every((x) => x.region.x0 === 0.1 && x.region.x1 === 0.9))
  assert.ok(Math.abs(b[0].core.y1 - b[1].core.y0) < 1e-9, 'cores meet without gap')
  assert.equal(b[0].core.y0, 0.1)
  assert.equal(b[2].core.y1, 0.7)
})

test('toWhole maps a band-local point to the page', () => {
  const [x, y] = toWhole({ x0: 0.1, y0: 0.4, x1: 0.9, y1: 0.8 }, [0.5, 0.5])
  assert.ok(Math.abs(x - 0.5) < 1e-9 && Math.abs(y - 0.6) < 1e-9)
})

test('parseLayout falls back to the whole page and reports unusable parts', () => {
  const issues: string[] = []
  const layout = parseLayout(
    {
      drawing: { x0: 0.5, y0: 0.5, x1: 0.2, y1: 0.9 },
      trusses: [{ name: 'lx1', a: [0.1, 0.2], b: [0.8, 0.2], area: 'stage' }, { name: 'LX2' }],
      heights: { stage: 4, hall: null },
      legend: ['Spot', 3],
    },
    issues,
  )
  assert.deepEqual(layout.drawing, { x0: 0, y0: 0, x1: 1, y1: 1 })
  assert.deepEqual(
    layout.trusses.map((t) => t.name),
    ['LX1'],
  )
  assert.deepEqual(layout.heights, { stage: 4 })
  assert.deepEqual(layout.legend, ['Spot'])
  assert.equal(issues.length, 2)
})

test('the same light seen in two bands is one, two lights with one number are numbered', () => {
  const region = { x0: 0, y0: 0, x1: 1, y1: 1 }
  const issues: string[] = []
  const a = parseLamps(
    {
      lamps: [
        { label: '1', symbol: 'Conv. PAR', x: 0.3, y: 0.2 },
        { label: '1', symbol: 'Conv. PAR', x: 0.6, y: 0.4 },
        { label: '5', symbol: 'Fresnel', x: 0.1, y: 0.5, facingDeg: 450 },
        { x: 2, y: 0 },
      ],
    },
    region,
    issues,
  )
  const b = parseLamps({ lamps: [{ label: '1', symbol: 'Spot', x: 0.301, y: 0.201 }] }, region, issues)
  assert.equal(issues.length, 1)
  const merged = mergeLamps([...a, ...b], 2000, 3000)
  assert.equal(merged.length, 3)
  const lamps = numberLamps(merged, 2000, 3000)
  assert.deepEqual(lamps.map((l) => l.lampId).sort(), ['#1.1', '#1.2', '#5'])
  assert.deepEqual(lamps.find((l) => l.lampId === '#1.1')?.planPx, [600, 600])
  assert.equal(lamps.find((l) => l.lampId === '#5')?.facingDeg, 90)
})

test('trussOnPlan picks the nearest line in reach and none for a stand', () => {
  const trusses = {
    LX1: {
      underside: 4,
      planPx: [
        [100, 100],
        [900, 100],
      ] as [[number, number], [number, number]],
    },
    LX2: {
      underside: 4,
      planPx: [
        [100, 300],
        [900, 300],
      ] as [[number, number], [number, number]],
    },
  }
  assert.equal(trussOnPlan([500, 130], trusses, 60), 'LX1')
  assert.equal(trussOnPlan([500, 270], trusses, 60), 'LX2')
  assert.equal(trussOnPlan([500, 200], trusses, 60), undefined)
  assert.equal(trussOnPlan([1500, 100], trusses, 60), undefined)
})

test('crossCheck reports numbers on one side only and a truss that differs, and lets LX3/4 be either', () => {
  const rows = [row('#201', 'LX2'), row('#326', 'LX3/4'), row('#9', 'LX3')]
  const lamps = [
    { lampId: '#201', fixId: '#201', planPx: [0, 0] as [number, number] },
    { lampId: '#326', fixId: '#326', planPx: [0, 0] as [number, number] },
    { lampId: '#232', fixId: '#232', planPx: [0, 0] as [number, number] },
  ]
  const issues = crossCheck(
    rows,
    lamps,
    new Map([
      ['#201', 'LX1'],
      ['#326', 'LX4'],
    ]),
  )
  assert.equal(issues.length, 3)
  assert.ok(issues.some((i) => i.includes('#232') && i.includes('no row')))
  assert.ok(issues.some((i) => i.includes('#9') && i.includes('does not show it')))
  assert.ok(issues.some((i) => i.includes('#201') && i.includes('LX1') && i.includes('LX2')))
})

test('cropPng returns a PNG of the region at the requested size', () => {
  const canvas = createCanvas(1000, 2000)
  const image: PageImage = { canvas, width: 1000, height: 2000 }
  const shot = cropPng(image, { x0: 0, y0: 0, x1: 1, y1: 0.5 }, { maxSide: 500, grid: true })
  assert.deepEqual([shot.width, shot.height], [500, 500])
  assert.equal(shot.png.subarray(1, 4).toString(), 'PNG')
})

test('a light listed with and without its number is one light, and the numbered one wins', () => {
  const lamps = mergeLamps(
    [
      { fixId: null, at: [0.5, 0.5] },
      { fixId: '#26', at: [0.501, 0.5] },
      { fixId: '#26', at: [0.6, 0.5] },
    ],
    2000,
    3000,
  )
  assert.deepEqual(
    lamps.map((l) => l.fixId),
    ['#26', '#26'],
  )
})

test('reconcileLabels reads S01 as #501 and a DMX address as its row, but only when it is unambiguous', () => {
  const rows = [row('#101', 'LX1'), row('#501', 'LX2', 'Robin LED 150'), { ...row('#326', 'LX3/4', 'Spiegelkugel'), address: 41 }]
  const lamps: RiderLamp[] = ['#101', 'S01', '#41'].map((fixId) => ({ lampId: fixId, fixId, planPx: [0, 0] }))
  const notes = reconcileLabels(rows, lamps)
  assert.deepEqual(
    lamps.map((l) => l.fixId),
    ['#101', '#501', '#326'],
  )
  assert.equal(lamps[1].printed, 'S01')
  assert.equal(notes.length, 2)
  // "01" also ends #601, which the plan does not show either: no guess
  const again = [{ lampId: 'S01', fixId: 'S01', planPx: [0, 0] as [number, number] }]
  assert.equal(reconcileLabels([row('#501', 'LX2'), row('#601', 'LX2')], again).length, 0)
  assert.equal(again[0].fixId, 'S01')
})

test('an answer that is not JSON is asked for again', async () => {
  let n = 0
  const provider: VisionProvider = {
    name: 'fake',
    model: 'fake',
    ask: () => Promise.resolve(n++ === 0 ? 'oops, not json' : '{"drawing":{"x0":0,"y0":0,"x1":1,"y1":1}}'),
  }
  const canvas = createCanvas(100, 100)
  const reading = await readPlan(provider, { canvas, width: 100, height: 100 }, 1, [])
  assert.ok(n >= 2)
  assert.equal(Object.keys(reading.plan.trusses).length, 0)
})

test('readPlan keeps each light from the band it belongs to, skips projectors, and cross-checks against the patch', async () => {
  const layout = JSON.stringify({
    drawing: { x0: 0, y0: 0, x1: 1, y1: 1 },
    scale: '1:100',
    stage: { width: 10, depth: 4.7, height: 0.6, frontLeft: [0.2, 0.5], frontRight: [0.8, 0.5] },
    trusses: [{ name: 'LX1', a: [0.1, 0.1], b: [0.9, 0.1], area: 'stage' }],
    heights: { stage: 4, hall: 4.6, lowestLight: 3.5 },
    legend: ['Zoom PAR'],
  })
  // Each band answers in its own fractions: band 0 shows page y 0..0.417, band 1 0.25..0.75, band 2 0.583..1.
  const bandAnswers = [
    '```json\n{"lamps":[{"label":"201","symbol":"Zoom PAR","x":0.5,"y":0.24},{"label":"7","symbol":"Fresnel","x":0.3,"y":0.9}]}\n```', // the second is page y 0.375, band 1's core: dropped here
    '{"lamps":[{"label":"7","symbol":"Fresnel","x":0.3,"y":0.5},{"label":null,"symbol":"Projektor Panasonic","x":0.5,"y":0.3}]}',
    '{"lamps":[{"label":"999","symbol":"Zoom PAR","x":0.5,"y":0.5}]}',
  ]
  let n = 0
  const provider: VisionProvider = { name: 'fake', model: 'fake', ask: () => Promise.resolve(n++ === 0 ? layout : bandAnswers[n - 2]) }
  const canvas = createCanvas(1000, 1000)
  const reading = await readPlan(provider, { canvas, width: 1000, height: 1000 }, 2, [row('#201', 'LX1', 'Zoom1')])
  assert.equal(reading.plan.trusses.LX1.underside, 4)
  assert.deepEqual(reading.plan.stage?.planPx, [
    [200, 500],
    [800, 500],
  ])
  assert.deepEqual(reading.lamps.map((l) => l.lampId).sort(), ['#201', '#7', '#999'])
  assert.equal(reading.lamps.find((l) => l.fixId === '#201')?.trussOnPlan, 'LX1')
  assert.ok(reading.issues.some((i) => i.includes('projector')))
  assert.ok(reading.issues.some((i) => i.includes('#999') && i.includes('no row')))
})

test('readPlan looks again, band by band, for patch rows it did not find, and keeps only those it asked for', async () => {
  const layout = JSON.stringify({ drawing: { x0: 0, y0: 0, x1: 1, y1: 1 }, trusses: [], heights: {}, legend: [] })
  const seen = '{"lamps":[{"label":"201","x":0.5,"y":0.5}]}'
  const second = ['{"lamps":[]}', '{"lamps":[{"label":"27","symbol":"Conv. PAR","x":0.5,"y":0.5},{"label":"999","x":0.5,"y":0.5}]}', '{"lamps":[]}']
  const answers = [layout, seen, '{"lamps":[]}', '{"lamps":[]}', ...second]
  let n = 0
  const provider: VisionProvider = { name: 'fake', model: 'fake', ask: () => Promise.resolve(answers[n++] ?? '{"lamps":[]}') }
  const canvas = createCanvas(1000, 1000)
  const reading = await readPlan(provider, { canvas, width: 1000, height: 1000 }, 2, [row('#201', 'LX1'), row('#27', 'LX4', 'Merch')])
  assert.equal(n, 7)
  assert.deepEqual(reading.lamps.map((l) => l.lampId).sort(), ['#201', '#27'])
  assert.ok(!reading.issues.some((i) => i.includes('#27') && i.includes('does not show')))
})
