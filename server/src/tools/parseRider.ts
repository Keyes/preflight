/**
 * Reads the patch table of a tech rider PDF and writes it as a rider file (see server/src/rider/types.ts).
 *
 *   npm run parse-rider -w server -- <rider.pdf> [out.json]
 *
 * Without an output path the JSON goes to the terminal. Pages that are pictures (plans, spec sheets) are not read here.
 */
import { writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { readPatch } from '../rider/patch.js'

const [inputArg, outputArg] = process.argv.slice(2)
if (!inputArg) {
  console.error('Usage: npm run parse-rider -w server -- <rider.pdf> [out.json]')
  process.exit(1)
}
// npm runs a workspace script inside server/; paths are meant relative to where the command was typed.
const here = process.env.INIT_CWD ?? process.cwd()
const input = resolve(here, inputArg)
const output = outputArg && resolve(here, outputArg)

const rider = await readPatch(input, basename(input))
const json = JSON.stringify(rider, null, 2)
if (output) {
  await writeFile(output, `${json}\n`)
  console.log(`${rider.patch.rows.length} patch rows${rider.patch.date ? ` (table dated ${rider.patch.date})` : ''} written to ${output}`)
  for (const issue of rider.issues) console.log(`  ! ${issue}`)
} else {
  console.log(json)
}
