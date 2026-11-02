import { expect, type Page } from '@playwright/test'

/** Helpers for tests that use the 3D view: open a venue, look at the scene and the stores, click a point in the room. */

export type Vec3 = [number, number, number]

/** What the page logs as an error, and exceptions it does not catch, with the address they came from. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`)
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

/**
 * Makes a demo club through the API and opens the app on it, with its model loaded and the camera placed. These tests are
 * about clicks and keys, not the look: shadows, soft beams, bloom and animation are off and the view renders at half size,
 * which makes software rendering several times faster (the smoke test keeps the full look).
 */
export async function openDemoClub(page: Page): Promise<string> {
  const response = await page.request.post('/api/venues/demo')
  expect(response.ok()).toBe(true)
  const { id } = (await response.json()) as { id: string }
  await page.addInitScript((venueId) => {
    localStorage.setItem('preflight.currentVenue', venueId)
    const cheap = { shadows: false, softBeams: false, bloom: 0, animate: false, renderRest: 0.5, renderMoving: 0.5 }
    localStorage.setItem('preflight.settings', JSON.stringify(cheap))
  }, id)
  const model = page.waitForResponse((res) => res.url().includes(`/api/venues/${id}/model.glb`) && res.ok())
  await page.goto('/')
  await model
  await expect(page.getByText('Loading venue…')).toBeHidden()
  await expect(page.getByRole('tab', { name: /Lights\s*18/ })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as unknown as DevWindow).__scene.meshes.length)).toBeGreaterThan(50)
  return id
}

/** What Viewer.vue puts on `window` in development, as far as the tests use it (`window as unknown as DevWindow`). */
export interface DevWindow {
  __scene: {
    activeCamera: { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } }
    clipPlane: unknown
    getTransformMatrix(): { m: ArrayLike<number> }
    meshes: { name: string; position: { x: number; y: number; z: number }; scaling: { x: number }; isEnabled(): boolean }[]
  }
  __gizmo: {
    positionGizmoEnabled: boolean
    rotationGizmoEnabled: boolean
    gizmos: { positionGizmo: { attachedNode: { name: string } | null } | null; rotationGizmo: { attachedNode: { name: string } | null } | null }
  }
  __screenshot(scale: number): Promise<{ blob: Blob; width: number; height: number }>
}

/** A store's state, as plain data (Pinia's `state`: what the store holds, not what it works out). */
export function storeState<T>(page: Page, id: string): Promise<T> {
  return page.evaluate((storeId) => {
    const app = (
      document.querySelector('#app') as unknown as { __vue_app__: { config: { globalProperties: { $pinia: { state: { value: Record<string, unknown> } } } } } }
    ).__vue_app__
    return JSON.parse(JSON.stringify(app.config.globalProperties.$pinia.state.value[storeId])) as T
  }, id)
}

/** Sets values in a store's state, for what a test cannot do through the screen. */
export function setStoreState(page: Page, id: string, values: Record<string, unknown>): Promise<void> {
  return page.evaluate(
    ([storeId, next]) => {
      const app = (
        document.querySelector('#app') as unknown as {
          __vue_app__: { config: { globalProperties: { $pinia: { state: { value: Record<string, Record<string, unknown>> } } } } }
        }
      ).__vue_app__
      Object.assign(app.config.globalProperties.$pinia.state.value[storeId], next)
    },
    [id, values] as const,
  )
}

/** A venue as the server has it: what has been saved. */
export async function venueOnServer(page: Page, venueId: string) {
  const response = await page.request.get(`/api/venues/${venueId}`)
  return (await response.json()) as { fixtures?: unknown[]; hiddenTags?: string[] }
}

/** The lights of a venue as the app holds them. */
export async function lightsOf(page: Page, venueId: string) {
  const { venues } = await storeState<{
    venues: { id: string; fixtures: { id: string; name: string; position: Vec3; mount: string; values: Record<string, number> }[] }[]
  }>(page, 'venues')
  return venues.find((v) => v.id === venueId)?.fixtures ?? []
}

export const cameraPosition = (page: Page) =>
  page.evaluate(() => {
    const { x, y, z } = (window as unknown as DevWindow).__scene.activeCamera.position
    return [x, y, z] as Vec3
  })

/** Rounds to `places` decimals, so positions can be compared after the floating point maths. */
export const rounded = (v: readonly number[], places = 1) => v.map((n) => Math.round(n * 10 ** places) / 10 ** places || 0) // || 0: no -0

/** Where a point of the room is on the screen, in the page's CSS pixels. */
export function screenPoint(page: Page, point: Vec3): Promise<{ x: number; y: number }> {
  return page.evaluate(([x, y, z]) => {
    const scene = (window as unknown as DevWindow).__scene
    const m = scene.getTransformMatrix().m
    const w = x * m[3] + y * m[7] + z * m[11] + m[15]
    const nx = (x * m[0] + y * m[4] + z * m[8] + m[12]) / w
    const ny = (x * m[1] + y * m[5] + z * m[9] + m[13]) / w
    const canvas = document.querySelector('canvas')!
    const box = canvas.getBoundingClientRect()
    const at = { x: box.left + ((nx + 1) / 2) * box.width, y: box.top + ((1 - ny) / 2) * box.height }
    // a panel or the edit bar over that spot would take the click instead
    const top = document.elementFromPoint(at.x, at.y)
    if (top !== canvas) throw new Error(`(${x}, ${y}, ${z}) is under ${top ? top.outerHTML.slice(0, 80) : 'nothing'}, not on the view`)
    return at
  }, point)
}

/** Clicks the point of the room. Babylon takes two clicks within 300 ms as a double tap, so a click waits that long first. */
export async function clickAt(page: Page, point: Vec3) {
  await page.waitForTimeout(350)
  const { x, y } = await screenPoint(page, point)
  await page.mouse.click(x, y)
}

/** Waits until the camera stops moving (a jump to a view takes 0.7 s). */
export async function cameraAtRest(page: Page) {
  await expect
    .poll(async () => {
      const before = rounded(await cameraPosition(page), 3).join()
      await page.waitForTimeout(150)
      return rounded(await cameraPosition(page), 3).join() === before
    })
    .toBe(true)
}

/** Clicks a light in the sidebar's list (with `add`, Ctrl or Cmd is held: it joins the selection). */
export async function clickInList(page: Page, name: string, add = false) {
  await page
    .locator('li[data-id] .name')
    .filter({ hasText: new RegExp(`^${name}$`) })
    .click(add ? { modifiers: ['ControlOrMeta'] } : {})
}
