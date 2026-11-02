import { rm } from 'node:fs/promises'

/** Removes the scratch folder the server kept its venues in during the tests (see playwright.config.ts). */
export default async function teardown() {
  const dir = process.env.PREFLIGHT_E2E_DATA
  if (dir) await rm(dir, { recursive: true, force: true })
}
