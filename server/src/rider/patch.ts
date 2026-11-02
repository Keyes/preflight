import { readFile } from 'node:fs/promises'
import type { RiderFile, RiderPatchRow } from './types.js'

interface TextItem {
  str: string
  /** left edge and baseline, PDF units */
  x: number
  y: number
  width: number
}

/**
 * The text of the pages that have any, as lines laid out like the page: items are put on one line when their baselines are
 * within a few units, and a gap wider than a space becomes at least three spaces (so a column break is told from the single
 * spaces inside a name). Pages made of pictures give empty text and are skipped.
 */
export async function pdfLayoutText(path: string): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await readFile(path))
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise
  const out: string[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    const items: TextItem[] = content.items
      .filter((i): i is typeof i & { str: string; transform: number[]; width: number } => 'str' in i && i.str.trim() !== '')
      .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], width: i.width }))
    const rows: TextItem[][] = []
    for (const item of items.sort((a, b) => b.y - a.y || a.x - b.x)) {
      const row = rows.find((r) => Math.abs(r[0].y - item.y) < 3)
      if (row) row.push(item)
      else rows.push([item])
    }
    for (const row of rows) {
      row.sort((a, b) => a.x - b.x)
      let line = ''
      let end = row[0].x
      for (const item of row) {
        const gap = item.x - end
        line += line ? (gap > 8 ? '   ' : gap > 0.5 ? ' ' : '') + item.str : item.str
        end = item.x + item.width
      }
      out.push(line)
    }
  }
  return out
}

const RECORD_START = /(?=#\d+\s+\d+\s)/
const RECORD = /^#(\d+)\s+(\d+)\s+(.+?)\s+((?:Dim|Wash)\b.*?|\d+\s*[Cc]h\b.*?)\s+(LX\d(?:\/\d)?)\s*$/
const UNIVERSE = /Universum\s+(\d+)/i
const DATE = /(\d{1,2})\.(\d{1,2})\.(\d{2,4})/

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The channel count a mode column states ("9Ch. SSP, ..." is 9); a "Dim" row is one channel. */
function channelsOf(mode: string): number | undefined {
  const m = /^(\d+)\s*[Cc]h/.exec(mode)
  if (m) return Number(m[1])
  return /^Dim\b/.test(mode) ? 1 : undefined
}

/**
 * Splits a mode column into the mode, the fixture it names and a note in brackets:
 * "9Ch. SSP, Expolite Tourled MC60 Zoom" is mode "9Ch. SSP" for the fixture "Expolite Tourled MC60 Zoom";
 * "4ch. CB-100 (1.dim,2.colwheel,...)" is mode "4ch." for "CB-100" with the channel list as a note;
 * "Dim" and "Wash" are just modes.
 */
function splitMode(raw: string): { mode: string; typeHint?: string; modeNote?: string } {
  const m = /^(\d+\s*[Cc]h\.?)(?:\s+((?:SSP|RGBW|RGB|HSIC|TOUR)\b))?[,\s]*(.*)$/.exec(raw)
  if (!m) return { mode: raw }
  let rest = m[3]
  let modeNote: string | undefined
  const note = /\(([^)]*)\)\s*$/.exec(rest)
  if (note) {
    modeNote = tidy(note[1])
    rest = rest.slice(0, note.index)
  }
  const typeHint = tidy(rest)
  return { mode: tidy(m[2] ? `${m[1]} ${m[2]}` : m[1]), ...(typeHint ? { typeHint } : {}), ...(modeNote ? { modeNote } : {}) }
}

/** Reads the patch table from layout lines (two records fit on a line: the table is printed in two blocks side by side). */
export function parsePatchLines(lines: readonly string[]): { rows: RiderPatchRow[]; date?: string; issues: string[] } {
  const rows: RiderPatchRow[] = []
  const issues: string[] = []
  let universe = 1
  let date: string | undefined
  for (const line of lines) {
    const header = UNIVERSE.exec(line)
    if (header) universe = Number(header[1])
    const d = DATE.exec(line)
    if (d && /patch/i.test(line)) {
      const year = d[3].length === 2 ? 2000 + Number(d[3]) : Number(d[3])
      date = `${year}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}`
    }
    for (const chunk of line.split(RECORD_START)) {
      if (!chunk.startsWith('#')) continue
      const m = RECORD.exec(chunk.trim())
      if (!m) {
        issues.push(`Could not read the patch row "${tidy(chunk)}"`)
        continue
      }
      const raw = tidy(m[4])
      const { mode, typeHint, modeNote } = splitMode(raw)
      const channels = channelsOf(mode)
      rows.push({
        fixId: `#${m[1]}`,
        universe,
        address: Number(m[2]),
        name: tidy(m[3]),
        modeRaw: raw,
        mode,
        ...(typeHint ? { typeHint } : {}),
        ...(modeNote ? { modeNote } : {}),
        ...(channels !== undefined ? { channels } : {}),
        truss: m[5],
      })
    }
  }
  return { rows, ...(date ? { date } : {}), issues }
}

/** Checks a table for the mistakes a typed-up patch has: a number twice, two rows on one address, an address past 512. */
export function checkPatch(rows: readonly RiderPatchRow[]): string[] {
  const issues: string[] = []
  const seen = new Map<string, RiderPatchRow>()
  for (const row of rows) {
    const same = seen.get(row.fixId)
    if (same) issues.push(`${row.fixId} is in the patch twice (${same.name}, ${row.name})`)
    seen.set(row.fixId, row)
    if (row.address < 1 || row.address + (row.channels ?? 1) - 1 > 512) issues.push(`${row.fixId} ${row.name}: address ${row.address} does not fit in a universe`)
  }
  const byAddress = [...rows].sort((a, b) => a.universe - b.universe || a.address - b.address)
  for (let i = 1; i < byAddress.length; i++) {
    const a = byAddress[i - 1]
    const b = byAddress[i]
    if (a.universe === b.universe && a.address + (a.channels ?? 1) > b.address && a.address !== b.address) {
      issues.push(`${a.fixId} ${a.name} (${a.address}-${a.address + (a.channels ?? 1) - 1}) overlaps ${b.fixId} ${b.name} (from ${b.address})`)
    }
  }
  return issues
}

/** The patch part of a rider file, read from the text of a rider PDF. */
export async function readPatch(pdfPath: string, source = pdfPath): Promise<RiderFile> {
  const lines = await pdfLayoutText(pdfPath)
  const { rows, date, issues } = parsePatchLines(lines)
  if (rows.length === 0) issues.push('No patch table found in the text of this PDF (a table that is a picture needs the vision reader).')
  return {
    version: 1,
    source,
    readAt: new Date().toISOString(),
    patch: { ...(date ? { date } : {}), rows },
    issues: [...issues, ...checkPatch(rows)],
  }
}
