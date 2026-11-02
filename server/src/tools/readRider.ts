/**
 * Reads a tech rider PDF into a rider file (see server/src/rider/types.ts): the patch table from the PDF's text, and the plan
 * page with a vision model.
 *
 *   ANTHROPIC_API_KEY=... npm run read-rider -w server -- <rider.pdf> <out.json> [--page 2] [--provider anthropic] [--model <id>] [--save-images <dir>]
 *
 * `--save-images` keeps every picture that is sent to the model (the page, and each band of the drawing, with the grid on it),
 * numbered in the order they were asked, so a wrong answer can be traced to what the model was shown.
 * Without a plan page (`--page 0`) only the patch is read, and no key is needed.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { readPatch } from '../rider/patch.js'
import { readPlan, withPlan } from '../rider/vision/plan.js'
import { createProvider, type VisionProvider } from '../rider/vision/provider.js'
import { renderPage } from '../rider/vision/render.js'
import '../rider/vision/anthropic.js'

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return undefined
  const [value] = args.splice(i, 2).slice(1)
  return value
}

const page = Number(flag('page') ?? 2)
const providerName = flag('provider') ?? 'anthropic'
const model = flag('model')
const flagDir = flag('save-images')
if (args.length < 2) {
  console.error('Usage: npm run read-rider -w server -- <rider.pdf> <out.json> [--page 2] [--provider anthropic] [--model <id>] [--save-images <dir>]')
  process.exit(1)
}
// npm runs a workspace script inside server/; paths are meant relative to where the command was typed.
const here = process.env.INIT_CWD ?? process.cwd()
const input = resolve(here, args[0])
const output = resolve(here, args[1])
const saveDir = flagDir && resolve(here, flagDir)

let rider = await readPatch(input, basename(input))
console.log(`Patch: ${rider.patch.rows.length} rows${rider.patch.date ? `, dated ${rider.patch.date}` : ''}`)

if (page > 0) {
  const real = createProvider(providerName, { model })
  let asked = 0
  if (saveDir) await mkdir(saveDir, { recursive: true })
  const provider: VisionProvider = {
    name: real.name,
    model: real.model,
    async ask(request) {
      asked++
      if (saveDir) await writeFile(join(saveDir, `ask-${String(asked).padStart(2, '0')}.png`), request.image)
      return real.ask(request)
    },
  }
  console.log(`Plan: page ${page}, ${provider.name} ${provider.model}`)
  const image = await renderPage(input, page)
  const reading = await readPlan(provider, image, page, rider.patch.rows)
  rider = withPlan(rider, reading)
  console.log(`Plan: ${reading.lamps.length} lights, ${Object.keys(reading.plan.trusses).length} trusses, ${asked} questions asked`)
}

await writeFile(output, `${JSON.stringify(rider, null, 2)}\n`)
console.log(`Written to ${output}`)
for (const issue of [...rider.issues, ...(rider.planIssues ?? [])]) console.log(`  ! ${issue}`)
