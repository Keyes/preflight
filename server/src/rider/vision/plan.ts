import type { RiderFile, RiderLamp, RiderPatchRow, RiderPlan, RiderTruss } from '@preflight/shared'
import { parseJsonAnswer, type VisionProvider } from './provider.js'
import { cropPng, toWhole, WHOLE, type PageImage, type Region } from './render.js'

/**
 * Reads the plan page of a tech rider with a vision model, in two steps. First the whole page: where the drawing is, the
 * scale, the stage, the trusses, the legend and the heights from the title block. Then the drawing in overlapping bands, at a
 * size where a symbol and its number are readable, to list every light with its place. Positions are asked for as fractions of
 * the picture (with a labelled grid drawn on it), which models estimate far better than pixels; they are turned into pixels
 * of the page image here.
 */

type Point = [number, number]

interface Layout {
  drawing: Region
  scale?: string
  date?: string
  stage?: { width: number; depth: number; height: number; frontLeft?: Point; frontRight?: Point }
  trusses: { name: string; a: Point; b: Point; area?: 'stage' | 'hall' }[]
  heights: { stage?: number; hall?: number; lowestLight?: number }
  legend: string[]
}

const LAYOUT_PROMPT = `This is the lighting plan page of a venue's technical rider: a top-down floor plan with lights drawn as small symbols, and a title block at the bottom. A thin magenta grid is drawn over the picture; its labels (0.1 ... 0.9) are fractions of the picture's width (along the top) and height (down the left side). Answer every position as [x, y] in those fractions, to two decimals.

Look at the picture and answer with one JSON object, nothing else:
{
  "drawing": { "x0": 0.0, "y0": 0.0, "x1": 1.0, "y1": 1.0 },   // box around the floor plan itself (walls, stage, room), not the title block
  "scale": "1:100" or null,                                      // as printed in the title block
  "date": "15.08.2023" or null,                                  // date of the plan as printed
  "stage": { "width": 10, "depth": 4.7, "height": 0.6, "frontLeft": [x, y], "frontRight": [x, y] } or null,   // from the printed stage dimension (meters); front = the edge towards the audience; left/right as seen on this picture
  "trusses": [ { "name": "LX1", "a": [x, y], "b": [x, y], "area": "stage" or "hall" } ],   // each truss that has a name: the two ends of its drawn line (the grey bar the lights hang on), not the red marker line out to its label
  "heights": { "stage": 4.0, "hall": 4.6, "lowestLight": 3.5 },  // meters, from the title block: underside of the trusses over the stage and over the room, and the lowest lamp; null for what is not printed
  "legend": ["Spot", "LED Zoom PAR", "..."]                       // the symbol names of the legend, in order
}`

const LAMPS_PROMPT = (
  legend: string[],
) => `This is part of a venue's lighting plan: a top-down floor plan with lights drawn as small symbols, each with its number printed beside it (like #201, or 301 without the hash). A thin magenta grid is drawn over the picture; its labels (0.1 ... 0.9) are fractions of this picture's width (along the top) and height (down the left side).

The symbol kinds are, from the plan's legend: ${legend.length ? legend.join('; ') : 'unknown'}.

List EVERY light symbol you can see in this picture, including ones on a truss, on a stand and in a corner, and each of the several symbols that share one number. Do not list walls, doors, the stage, the bar, furniture or text. For each give:
- "label": the number printed beside it, digits only ("201", not "#201"). The numbers are plain digits: a letter you think you see in one (S, O, I) is a digit (5, 0, 1). null if it has none
- "symbol": which legend kind it is, as the legend names it
- "x", "y": the centre of the symbol, in the grid's fractions of this picture, two decimals
- "facingDeg": the direction the light points to, in degrees clockwise from straight up on the picture (0 = up, 90 = right, 180 = down, 270 = left), only when the symbol clearly shows a direction, else null

Answer with one JSON object, nothing else: { "lamps": [ { "label": "201", "symbol": "LED Zoom PAR", "x": 0.31, "y": 0.22, "facingDeg": null } ] }`

const MISSING_PROMPT = (
  numbers: string[],
  legend: string[],
) => `This is part of a venue's lighting plan: a top-down floor plan with lights drawn as small symbols, each with its number printed beside it. A thin magenta grid is drawn over the picture; its labels (0.1 ... 0.9) are fractions of this picture's width (along the top) and height (down the left side).${legend.length ? ` The legend's symbol kinds: ${legend.join('; ')}.` : ''}

An earlier look at this plan missed some lights. Look only for the lights numbered ${numbers.join(', ')} (digits as printed). A symbol may be tilted, partly under a wall or another symbol, or at the edge of the drawing. Report one only if you can actually see that number printed beside a light symbol in this picture; it is normal that most of these numbers are not here, and the answer is then an empty list. Do not guess.

Answer with one JSON object, nothing else: { "lamps": [ { "label": "27", "symbol": "Conv. PAR", "x": 0.31, "y": 0.22, "facingDeg": null } ] }`

const isPoint = (v: unknown): v is Point => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Asks, and asks once more with a stricter request if the answer is not JSON. */
async function askJson(provider: VisionProvider, image: Buffer, prompt: string): Promise<Record<string, unknown>> {
  let text = await provider.ask({ image, prompt })
  try {
    return rec(parseJsonAnswer(text))
  } catch {
    text = await provider.ask({ image, prompt: `${prompt}\n\nYour last answer was not valid JSON. Answer with the JSON object only, no other text.` })
    return rec(parseJsonAnswer(text))
  }
}

export function parseLayout(raw: Record<string, unknown>, issues: string[]): Layout {
  const d = rec(raw.drawing)
  const drawing: Region =
    [d.x0, d.y0, d.x1, d.y1].every(isNum) && (d.x1 as number) > (d.x0 as number) && (d.y1 as number) > (d.y0 as number)
      ? { x0: clamp01(d.x0 as number), y0: clamp01(d.y0 as number), x1: clamp01(d.x1 as number), y1: clamp01(d.y1 as number) }
      : WHOLE
  if (drawing === WHOLE) issues.push('The model gave no usable box for the floor plan; the whole page is searched for lights.')

  let stage: Layout['stage']
  const s = rec(raw.stage)
  if (isNum(s.width) && isNum(s.depth)) {
    stage = {
      width: s.width,
      depth: s.depth,
      height: isNum(s.height) ? s.height : 0,
      ...(isPoint(s.frontLeft) ? { frontLeft: s.frontLeft } : {}),
      ...(isPoint(s.frontRight) ? { frontRight: s.frontRight } : {}),
    }
  }

  const trusses: Layout['trusses'] = []
  for (const t of Array.isArray(raw.trusses) ? raw.trusses : []) {
    const r = rec(t)
    if (typeof r.name === 'string' && isPoint(r.a) && isPoint(r.b)) {
      trusses.push({ name: r.name.trim().toUpperCase(), a: r.a, b: r.b, ...(r.area === 'stage' || r.area === 'hall' ? { area: r.area } : {}) })
    } else issues.push(`A truss in the layout answer was unusable: ${JSON.stringify(t).slice(0, 80)}`)
  }

  const h = rec(raw.heights)
  const heights = {
    ...(isNum(h.stage) ? { stage: h.stage } : {}),
    ...(isNum(h.hall) ? { hall: h.hall } : {}),
    ...(isNum(h.lowestLight) ? { lowestLight: h.lowestLight } : {}),
  }
  const legend = (Array.isArray(raw.legend) ? raw.legend : []).filter((l): l is string => typeof l === 'string' && l.trim() !== '').map((l) => l.trim())
  return {
    drawing,
    ...(typeof raw.scale === 'string' ? { scale: raw.scale } : {}),
    ...(typeof raw.date === 'string' ? { date: raw.date } : {}),
    ...(stage ? { stage } : {}),
    trusses,
    heights,
    legend,
  }
}

/** "201", "#201" and " 201 " are the rider's #201; anything else (S01, "?") is kept as printed, with a hash it cannot have. */
export function normalizeLabel(label: unknown): string | null {
  if (typeof label !== 'string') return null
  const t = label.trim()
  const m = /^#?\s*(\d+)$/.exec(t)
  return m ? `#${Number(m[1])}` : t === '' ? null : t
}

interface RawLamp {
  fixId: string | null
  symbol?: string
  at: Point
  facingDeg?: number
}

export interface Band {
  /** what is shown to the model */
  region: Region
  /** the part of the region this band answers for: the bands overlap so that a symbol on a seam is seen whole, and a light found in the overlap is kept only from the band whose core it is in */
  core: { y0: number; y1: number }
}

/** The bands of the drawing to read, top to bottom. They overlap by `overlap` of a band's height on each side (a symbol with its number is about a tenth of a band tall). */
export function bands(drawing: Region, count = 3, overlap = 0.25): Band[] {
  const height = drawing.y1 - drawing.y0
  const step = height / count
  return Array.from({ length: count }, (_, i) => {
    const core = { y0: i === 0 ? drawing.y0 : drawing.y0 + i * step, y1: i === count - 1 ? drawing.y1 : drawing.y0 + (i + 1) * step }
    return { core, region: { x0: drawing.x0, x1: drawing.x1, y0: Math.max(0, core.y0 - overlap * step), y1: Math.min(1, core.y1 + overlap * step) } }
  })
}

export function parseLamps(raw: Record<string, unknown>, region: Region, issues: string[]): RawLamp[] {
  const out: RawLamp[] = []
  for (const item of Array.isArray(raw.lamps) ? raw.lamps : []) {
    const r = rec(item)
    if (!isNum(r.x) || !isNum(r.y) || r.x < 0 || r.x > 1 || r.y < 0 || r.y > 1) {
      issues.push(`A light in the answer had no usable position: ${JSON.stringify(item).slice(0, 80)}`)
      continue
    }
    out.push({
      fixId: normalizeLabel(r.label),
      ...(typeof r.symbol === 'string' ? { symbol: r.symbol } : {}),
      at: toWhole(region, [r.x, r.y]),
      ...(isNum(r.facingDeg) ? { facingDeg: ((Math.round(r.facingDeg) % 360) + 360) % 360 } : {}),
    })
  }
  return out
}

/**
 * The same light seen twice (a seam, or a light the model listed with and without its number): the same spot, give or take a
 * symbol's width, and the same number or one of them without. The model's symbol class is not compared: it differs between
 * looks at one light more often than it tells lights apart. The numbered one is kept.
 */
export function mergeLamps(lamps: RawLamp[], pageWidth: number, pageHeight: number, tolerancePx = 80): RawLamp[] {
  const out: RawLamp[] = []
  for (const lamp of lamps) {
    const twin = out.find(
      (o) =>
        (o.fixId === lamp.fixId || o.fixId === null || lamp.fixId === null) &&
        Math.hypot((o.at[0] - lamp.at[0]) * pageWidth, (o.at[1] - lamp.at[1]) * pageHeight) < tolerancePx,
    )
    if (!twin) out.push(lamp)
    else {
      if (twin.fixId === null) twin.fixId = lamp.fixId
      if (twin.facingDeg === undefined && lamp.facingDeg !== undefined) twin.facingDeg = lamp.facingDeg
    }
  }
  return out
}

/** A number printed once is the lamp `#201`; printed several times, each is `#1.1`, `#1.2` ... in reading order (left to right, then top to bottom). */
export function numberLamps(lamps: RawLamp[], width: number, height: number): RiderLamp[] {
  const byId = new Map<string, RawLamp[]>()
  const unnumbered: RawLamp[] = []
  for (const lamp of lamps) {
    if (!lamp.fixId) unnumbered.push(lamp)
    else byId.set(lamp.fixId, [...(byId.get(lamp.fixId) ?? []), lamp])
  }
  const make = (lampId: string, fixId: string, l: RawLamp): RiderLamp => ({
    lampId,
    fixId,
    planPx: [Math.round(l.at[0] * width), Math.round(l.at[1] * height)],
    ...(l.facingDeg !== undefined ? { facingDeg: l.facingDeg } : {}),
    ...(l.symbol ? { symbol: l.symbol } : {}),
  })
  const out: RiderLamp[] = []
  for (const [fixId, group] of byId) {
    const sorted = [...group].sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1])
    sorted.forEach((l, i) => out.push(make(sorted.length === 1 ? fixId : `${fixId}.${i + 1}`, fixId, l)))
  }
  unnumbered.forEach((l, i) => out.push(make(`?${i + 1}`, '?', l)))
  return out
}

/** The distance from a point to a line segment, same units as the inputs. */
function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** The truss a light hangs on according to the plan: the nearest one within about a symbol's reach of its line, else none (a stand, a wall, the ceiling). */
export function trussOnPlan(planPx: Point, trusses: Record<string, RiderTruss>, reachPx: number): string | undefined {
  let best: { name: string; d: number } | undefined
  for (const [name, truss] of Object.entries(trusses)) {
    if (!truss.planPx) continue
    const d = distanceToSegment(planPx, truss.planPx[0], truss.planPx[1])
    if (d <= reachPx && (!best || d < best.d)) best = { name, d }
  }
  return best?.name
}

/** Whether the truss on the plan is the one the patch names ("LX3/4" is either LX3 or LX4). */
const trussMatches = (patch: string, plan: string) => patch.replace(/^LX/, '').split('/').includes(plan.replace(/^LX/, ''))

/**
 * A number on the plan that is not in the patch may still be one that is: a small printed 501 read as "S01", or the mirror
 * ball #326 printed as its DMX address 41. When exactly one patch row that the plan does not otherwise show fits, the lamp
 * takes that row's number (the printed label is kept in `printed`) and the change is reported so a person can overrule it.
 */
export function reconcileLabels(rows: readonly RiderPatchRow[], lamps: RiderLamp[]): string[] {
  const notes: string[] = []
  const drawn = new Set(lamps.filter((l) => rows.some((r) => r.fixId === l.fixId)).map((l) => l.fixId))
  const free = () => rows.filter((r) => !drawn.has(r.fixId))
  for (const lamp of lamps) {
    if (lamp.fixId === '?' || rows.some((r) => r.fixId === lamp.fixId)) continue
    const digits = lamp.fixId.replace(/\D/g, '')
    if (!digits) continue
    const byEnding = free().filter((r) => r.fixId.length > digits.length + 1 && r.fixId.endsWith(digits) && digits.length >= 2)
    const byAddress = free().filter((r) => r.address === Number(digits))
    const match = byEnding.length === 1 ? byEnding[0] : byAddress.length === 1 ? byAddress[0] : undefined
    if (!match) continue
    notes.push(
      `${lamp.fixId} on the plan was read as ${match.fixId} ${match.name} (${byEnding.length === 1 ? `the number ends like it and ${match.fixId} is otherwise not on the plan` : `${digits} is its DMX address and ${match.fixId} is otherwise not on the plan`}); check it`,
    )
    lamp.printed = lamp.fixId
    lamp.fixId = match.fixId
    lamp.lampId = lamp.lampId.replace(lamp.printed, match.fixId)
    drawn.add(match.fixId)
  }
  return notes
}

/** What does not fit between the patch (the newer list) and the plan: numbers on one side only, and a truss that differs. */
export function crossCheck(rows: readonly RiderPatchRow[], lamps: readonly RiderLamp[], lampTruss: ReadonlyMap<string, string>): string[] {
  const issues: string[] = []
  const patched = new Map(rows.map((r) => [r.fixId, r]))
  const drawn = new Set(lamps.map((l) => l.fixId))
  for (const id of [...drawn].filter((i) => i !== '?' && !patched.has(i))) {
    const count = lamps.filter((l) => l.fixId === id).length
    issues.push(
      `The plan shows ${id}${count > 1 ? ` (${count} times)` : ''} but the patch has no row for it, so it has no address or type (it will be imported unpatched)`,
    )
  }
  const strays = lamps.filter((l) => l.fixId === '?').length
  if (strays) issues.push(`${strays} ${strays === 1 ? 'light on the plan has' : 'lights on the plan have'} no readable number`)
  for (const row of rows) {
    if (!drawn.has(row.fixId)) issues.push(`The patch has ${row.fixId} ${row.name} (${row.truss}) but the plan does not show it, so it has no position yet`)
  }
  for (const lamp of lamps) {
    const row = patched.get(lamp.fixId)
    const plan = lampTruss.get(lamp.lampId)
    if (row && plan && !trussMatches(row.truss, plan)) {
      issues.push(`${lamp.lampId} ${row.name}: the plan puts it on ${plan}, the patch (newer) says ${row.truss}`)
    }
  }
  return issues
}

export interface PlanReading {
  plan: RiderPlan
  lamps: RiderLamp[]
  issues: string[]
}

/** Reads the plan on `page` of the PDF image. `patch` (if given) is only used to cross-check what was seen. */
export async function readPlan(provider: VisionProvider, image: PageImage, page: number, patch: readonly RiderPatchRow[] = []): Promise<PlanReading> {
  const issues: string[] = []

  const whole = cropPng(image, WHOLE, { grid: true })
  const layout = parseLayout(await askJson(provider, whole.png, LAYOUT_PROMPT), issues)

  const answers = await Promise.all(
    bands(layout.drawing).map(async ({ region, core }) => {
      const shot = cropPng(image, region, { grid: true })
      return parseLamps(await askJson(provider, shot.png, LAMPS_PROMPT(layout.legend)), region, issues).filter((l) => l.at[1] >= core.y0 && l.at[1] < core.y1)
    }),
  )
  let found = mergeLamps(answers.flat(), image.width, image.height)
  // Lights the patch has and the plan reading did not show: look again for exactly those, in every band.
  const seen = new Set(found.map((l) => l.fixId))
  const absent = patch.map((r) => r.fixId).filter((id) => !seen.has(id))
  if (absent.length) {
    const wanted = new Set(absent)
    const extra = await Promise.all(
      bands(layout.drawing).map(async ({ region, core }) => {
        const shot = cropPng(image, region, { grid: true })
        const raw = await askJson(
          provider,
          shot.png,
          MISSING_PROMPT(
            absent.map((id) => id.replace('#', '')),
            layout.legend,
          ),
        )
        return parseLamps(raw, region, issues).filter((l) => l.fixId !== null && wanted.has(l.fixId) && l.at[1] >= core.y0 && l.at[1] < core.y1)
      }),
    )
    found = mergeLamps([...found, ...extra.flat()], image.width, image.height)
  }
  const projectors = found.filter((l) => /proj/i.test(l.symbol ?? ''))
  if (projectors.length)
    issues.push(
      `${projectors.length} projector ${projectors.length === 1 ? 'symbol' : 'symbols'} on the plan skipped (video is for rent only and is not a light)`,
    )
  const lamps = numberLamps(
    found.filter((l) => !projectors.includes(l)),
    image.width,
    image.height,
  )
  issues.push(...reconcileLabels(patch, lamps))

  const px = (p: Point): Point => [Math.round(p[0] * image.width), Math.round(p[1] * image.height)]
  const trusses: Record<string, RiderTruss> = {}
  for (const t of layout.trusses) {
    const underside = t.area === 'hall' ? layout.heights.hall : t.area === 'stage' ? layout.heights.stage : undefined
    if (underside === undefined) issues.push(`The height of ${t.name} could not be read from the title block`)
    trusses[t.name] = { underside: underside ?? 0, planPx: [px(t.a), px(t.b)] }
  }
  if (layout.trusses.length === 0) issues.push('No trusses were found on the plan')

  const reach = 0.035 * image.width
  const lampTruss = new Map<string, string>()
  for (const lamp of lamps) {
    const name = trussOnPlan(lamp.planPx, trusses, reach)
    if (name) {
      lamp.trussOnPlan = name
      lampTruss.set(lamp.lampId, name)
    }
  }

  const plan: RiderPlan = {
    page,
    image: { width: image.width, height: image.height },
    ...(layout.scale ? { scale: layout.scale } : {}),
    ...(layout.date ? { date: layout.date } : {}),
    ...(layout.stage
      ? {
          stage: {
            width: layout.stage.width,
            depth: layout.stage.depth,
            height: layout.stage.height,
            ...(layout.stage.frontLeft && layout.stage.frontRight
              ? { planPx: [px(layout.stage.frontLeft), px(layout.stage.frontRight)] as [Point, Point] }
              : {}),
          },
        }
      : {}),
    trusses,
    ...(layout.heights.lowestLight !== undefined ? { lowestLight: layout.heights.lowestLight } : {}),
  }
  if (!layout.stage) issues.push('No stage size was found on the plan, so the plan cannot be scaled from it')

  issues.push(...crossCheck(patch, lamps, lampTruss))
  return { plan, lamps, issues }
}

/** A rider file with the plan part added to one that has the patch. */
export function withPlan(rider: RiderFile, reading: PlanReading): RiderFile {
  return { ...rider, plan: reading.plan, lamps: reading.lamps, planIssues: reading.issues }
}
