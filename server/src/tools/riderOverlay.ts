/**
 * Draws what a rider file says about the plan onto the plan page, to check a reading by eye: a dot and the lamp id at every
 * light, the trusses as lines with their names and heights, and the stage's front edge.
 *
 *   npm run rider-overlay -w server -- <rider.pdf> <rider.json> <overlay.png>
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import type { RiderFile } from '../rider/types.js'
import { renderPage } from '../rider/vision/render.js'

if (process.argv.length < 5) {
  console.error('Usage: npm run rider-overlay -w server -- <rider.pdf> <rider.json> <overlay.png>')
  process.exit(1)
}
const here = process.env.INIT_CWD ?? process.cwd()
const [pdf, json, out] = process.argv.slice(2, 5).map((p) => resolve(here, p))

const rider = JSON.parse(await readFile(json, 'utf8')) as RiderFile
if (!rider.plan) {
  console.error('This rider file has no plan part (read it without --page 0).')
  process.exit(1)
}
const image = await renderPage(pdf, rider.plan.page)
const lamps = rider.lamps ?? []

// Only the part of the page the lights are in, with a margin.
const xs = lamps.map((l) => l.planPx[0])
const ys = lamps.map((l) => l.planPx[1])
const margin = 160
const x0 = Math.max(0, Math.min(...xs) - margin)
const y0 = Math.max(0, Math.min(...ys) - margin)
const x1 = Math.min(image.width, Math.max(...xs) + margin)
const y1 = Math.min(image.height, Math.max(...ys) + margin)

const canvas = createCanvas(x1 - x0, y1 - y0)
const g = canvas.getContext('2d')
g.drawImage(image.canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0)
const at = (p: [number, number]): [number, number] => [p[0] - x0, p[1] - y0]

g.lineWidth = 5
g.font = 'bold 34px sans-serif'
for (const [name, truss] of Object.entries(rider.plan.trusses)) {
  if (!truss.planPx) continue
  const [a, b] = truss.planPx.map(at)
  g.strokeStyle = 'rgba(0, 150, 0, 0.8)'
  g.beginPath()
  g.moveTo(...a)
  g.lineTo(...b)
  g.stroke()
  g.fillStyle = 'rgb(0, 110, 0)'
  g.fillText(`${name} ${truss.underside} m`, a[0] + 10, a[1] - 12)
}
const stage = rider.plan.stage?.planPx
if (stage) {
  const [a, b] = stage.map(at)
  g.strokeStyle = 'rgba(220, 120, 0, 0.9)'
  g.beginPath()
  g.moveTo(...a)
  g.lineTo(...b)
  g.stroke()
}

g.font = 'bold 26px sans-serif'
for (const lamp of lamps) {
  const [x, y] = at(lamp.planPx)
  g.fillStyle = lamp.trussOnPlan ? 'rgba(220, 0, 90, 0.9)' : 'rgba(0, 90, 220, 0.9)'
  g.beginPath()
  g.arc(x, y, 12, 0, Math.PI * 2)
  g.fill()
  if (lamp.facingDeg !== undefined) {
    const r = (lamp.facingDeg * Math.PI) / 180
    g.strokeStyle = g.fillStyle
    g.lineWidth = 4
    g.beginPath()
    g.moveTo(x, y)
    g.lineTo(x + Math.sin(r) * 45, y - Math.cos(r) * 45)
    g.stroke()
  }
  g.fillStyle = 'rgb(160, 0, 70)'
  g.fillText(lamp.lampId.replace('#', ''), x + 14, y - 14)
}
await writeFile(out, canvas.toBuffer('image/png'))
console.log(`${lamps.length} lights drawn to ${out}`)
