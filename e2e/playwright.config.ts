import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

// Ports of their own, so the tests never talk to a pre(f)light you have running.
const SERVER_PORT = 3199
const CLIENT_PORT = 5199

// The server keeps its venues in a scratch folder, so the tests start from no venues and never touch yours. Only the
// name is chosen here (the server makes the folder), since other tools load this file too; it is set once and inherited
// by the workers, which load this file again, and removed in teardown.ts.
process.env.PREFLIGHT_E2E_DATA ??= join(tmpdir(), `preflight-e2e-${randomUUID()}`)

export default defineConfig({
  testDir: '.',
  globalTeardown: './teardown.ts',
  // Rendering in software (as headless browsers and CI do) is slow: loading the demo club takes a while.
  timeout: 90_000,
  expect: { timeout: 30_000 },
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    browserName: 'chromium',
    viewport: { width: 1280, height: 800 },
  },
  webServer: [
    {
      command: 'npm run start -w server',
      cwd: '..',
      env: { PORT: String(SERVER_PORT), HOST: '127.0.0.1', VENUES_DIR: process.env.PREFLIGHT_E2E_DATA },
      url: `http://127.0.0.1:${SERVER_PORT}/api/health`,
    },
    {
      // the client reads PORT as the server's port, to pass API calls on to it
      command: `npm run dev -w client -- --port ${CLIENT_PORT} --strictPort`,
      cwd: '..',
      env: { PORT: String(SERVER_PORT) },
      url: `http://localhost:${CLIENT_PORT}`,
    },
  ],
})
