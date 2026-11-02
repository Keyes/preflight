import { expect, test } from '@playwright/test'
import {
  cameraAtRest,
  cameraPosition,
  clickAt,
  clickInList,
  collectErrors,
  lightsOf,
  openDemoClub,
  rounded,
  setStoreState,
  storeState,
  type DevWindow,
  type Vec3,
} from './viewer.js'

// What the 3D view does with clicks and keys, in the demo club: the floor is at y = 0, the dance floor runs from x -6.5 to
// 6.5 and z 0.3 to 6, and saved view 1 looks at it from behind.

let errors: string[]
let venueId: string

test.beforeEach(async ({ page }) => {
  errors = collectErrors(page)
  venueId = await openDemoClub(page)
})

test.afterEach(() => {
  expect(errors).toEqual([])
})

test('the camera starts at saved view 1, and the view buttons and number keys move it', async ({ page }) => {
  await expect.poll(async () => rounded(await cameraPosition(page))).toEqual([0, 4.6, 9.3])
  await page.keyboard.press('3') // "From the stage"
  await expect.poll(async () => rounded(await cameraPosition(page))).toEqual([0, 2.8, -6.6])
  await page.getByRole('button', { name: 'Inside' }).click()
  await expect.poll(async () => rounded(await cameraPosition(page))[1]).toBe(1.7) // eye height over the floor
})

test('a light selected in the list gets the gizmo, G and R switch it between moving and turning, and several share one', async ({ page }) => {
  const [wash1] = await lightsOf(page, venueId)
  const attached = () =>
    page.evaluate(() => {
      const { gizmos, positionGizmoEnabled, rotationGizmoEnabled } = (window as unknown as DevWindow).__gizmo
      const gizmo = positionGizmoEnabled ? gizmos.positionGizmo : rotationGizmoEnabled ? gizmos.rotationGizmo : null
      return { mode: positionGizmoEnabled ? 'move' : 'rotate', node: gizmo?.attachedNode?.name ?? null }
    })

  await clickInList(page, 'Wash 1')
  await expect.poll(attached).toEqual({ mode: 'move', node: `fixture-${wash1.id}` })
  await page.keyboard.press('r')
  await expect.poll(attached).toEqual({ mode: 'rotate', node: `fixture-${wash1.id}` })
  await page.keyboard.press('g')
  await clickInList(page, 'Wash 2', true)
  await expect.poll(attached).toEqual({ mode: 'move', node: 'selection-pivot' })
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await attached()).node).toBeNull()
})

test('aiming: T, then a click on the floor, points the selected light at that spot', async ({ page }) => {
  const [before] = await lightsOf(page, venueId)
  await cameraAtRest(page)
  await clickInList(page, 'Wash 1')
  await page.keyboard.press('t')
  await expect(page.getByText('Click a surface to aim the selected lights at it.')).toBeVisible()
  const spot: Vec3 = [0, 0, 3]
  await clickAt(page, spot)
  await expect(page.getByText('Click a surface to aim the selected lights at it.')).toBeHidden()
  const { aim } = await storeState<{ aim: { anchor: Vec3 } }>(page, 'rig')
  expect(rounded(aim.anchor, 0)).toEqual(spot)
  const [after] = await lightsOf(page, venueId)
  expect([after.values.pan, after.values.tilt]).not.toEqual([before.values.pan, before.values.tilt])
})

test('placing: the light chosen in the picker stands where the floor is clicked', async ({ page }) => {
  await page.getByRole('button', { name: '+ Place light' }).click()
  await page
    .getByRole('dialog', { name: 'Choose a fixture' })
    .getByRole('button', { name: /^Place / })
    .click()
  await expect(page.getByText(/^Click a ceiling, truss or floor to place the /)).toBeVisible()
  await cameraAtRest(page)
  await clickAt(page, [1, 0, 2])
  await expect(page.getByRole('tab', { name: /Lights\s*19/ })).toBeVisible()
  const placed = (await lightsOf(page, venueId)).at(-1)!
  expect(placed.mount).toBe('standing')
  expect(rounded(placed.position, 0)).toEqual([1, 0, 2])
})

test('a crowd zone is drawn with two clicks on the floor', async ({ page }) => {
  await page.getByRole('tab', { name: /Scene/ }).click()
  await page.getByRole('button', { name: '+ Zone' }).click()
  await cameraAtRest(page)
  await clickAt(page, [-3, 0, 1])
  await expect(page.getByText('Click the opposite corner of the zone.')).toBeVisible()
  await clickAt(page, [-1, 0, 2.5])
  await expect.poll(async () => (await zones()).length).toBe(2)
  const zone = (await zones()).at(-1)!
  expect(rounded([zone.x0, zone.z0, zone.x1, zone.z1])).toEqual([-3, 1, -1, 2.5])

  async function zones() {
    const { venues } = await storeState<{ venues: { id: string; crowd: { zones: { x0: number; z0: number; x1: number; z1: number }[] } }[] }>(page, 'venues')
    return venues.find((v) => v.id === venueId)!.crowd.zones
  }
})

test('hiding a model part takes its meshes out of the picture, and showing it brings them back', async ({ page }) => {
  const enabled = () => page.evaluate(() => (window as unknown as DevWindow).__scene.meshes.filter((m) => m.isEnabled()).length)
  const all = await enabled()
  await page.getByRole('tab', { name: /Scene/ }).click()
  const parts = page.locator('section', { has: page.getByRole('heading', { name: /^Model (parts|tags)/ }) })
  await parts
    .getByRole('button', { name: /^Hide / })
    .first()
    .click()
  await expect.poll(enabled).toBeLessThan(all)
  await page.getByRole('button', { name: 'Show all' }).click()
  await expect.poll(enabled).toBe(all)
})

test('a screenshot is the view as a PNG of the size asked for', async ({ page }) => {
  const shot = await page.evaluate(async () => {
    const { blob, width, height } = await (window as unknown as DevWindow).__screenshot(0.5)
    return { type: blob.type, bytes: blob.size, width, height }
  })
  expect(shot.type).toBe('image/png')
  expect(shot.bytes).toBeGreaterThan(10_000)
  expect(shot.width / shot.height).toBeCloseTo(16 / 9, 1)
})

test('the rider wizard looks down on the plan, takes venue points from clicks, and previews the lights it would add', async ({ page }) => {
  test.setTimeout(180_000) // many steps, each drawn in software
  // A rider with a plan but no PDF: the wizard cannot show the plan picture, which it says, and the rest works.
  const rider = {
    version: 1,
    source: 'test.pdf',
    readAt: '2026-01-01',
    patch: {
      rows: ['#1', '#2'].map((fixId, i) => ({ fixId, universe: 1, address: 1 + i * 10, name: `Wash ${i + 1}`, modeRaw: 'Dim', mode: 'Dim', truss: 'LX1' })),
    },
    lamps: [
      { lampId: '#1', fixId: '#1', planPx: [100, 100] },
      { lampId: '#2', fixId: '#2', planPx: [300, 100] },
    ],
    plan: { page: 2, image: { width: 1000, height: 800 }, trusses: {} },
    issues: [],
  }
  expect((await page.request.put(`/api/venues/${venueId}/rider`, { data: rider })).ok()).toBe(true)
  await page.getByRole('button', { name: 'More ways to add lights' }).click()
  await page.getByRole('button', { name: 'Import tech rider…' }).click()
  const wizard = page.getByRole('dialog', { name: 'Import tech rider' })
  const steps = wizard.getByRole('navigation')
  await steps.getByRole('button', { name: /Place the plan/ }).click()

  // Looking straight down, with the room cut away above the floor.
  await expect.poll(() => page.evaluate(() => (window as unknown as DevWindow).__scene.activeCamera.rotation.x)).toBeGreaterThan(1.5)
  await cameraAtRest(page)
  expect(await page.evaluate(() => (window as unknown as DevWindow).__scene.clipPlane !== null)).toBe(true)

  // The two points on the plan are set here (the plan picture is not there to click); the venue points are clicked.
  await setStoreState(page, 'rider', { planPoints: [rider.lamps[0].planPx, rider.lamps[1].planPx] })
  // near the middle of the venue, which the plan view puts in the part of the view the wizard leaves free
  const venuePoints: Vec3[] = [
    [-1, 0, 1],
    [1, 0, 1],
  ]
  for (const [i, point] of venuePoints.entries()) {
    await wizard.getByRole('button', { name: 'Pick in venue' }).nth(i).click()
    await clickAt(page, point)
    await expect.poll(async () => (await storeState<{ worldPoints: ([number, number] | null)[] }>(page, 'rider')).worldPoints[i]).not.toBeNull()
  }
  const { worldPoints } = await storeState<{ worldPoints: [number, number][] }>(page, 'rider')
  expect(worldPoints.map((p) => rounded(p, 0))).toEqual([
    [-1, 1],
    [1, 1],
  ])

  // In the review the camera is back, and a sphere marks each light; a click on one selects it.
  await steps.getByRole('button', { name: /Review/ }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as DevWindow).__scene.activeCamera.rotation.x)).toBeLessThan(1.5)
  await cameraAtRest(page)
  const markers = () =>
    page.evaluate(() =>
      (window as unknown as DevWindow).__scene.meshes
        .filter((m) => m.name === 'rider-marker')
        .map((m) => ({ x: Math.round(m.position.x), z: Math.round(m.position.z), selected: m.scaling.x > 1 })),
    )
  await expect.poll(markers).toEqual([
    { x: -1, z: 1, selected: false },
    { x: 1, z: 1, selected: false },
  ])
  // the wizard's selection shows on the markers
  await setStoreState(page, 'rider', { selectedKeys: ['#2'] })
  await expect.poll(async () => (await markers()).map((m) => m.selected)).toEqual([false, true])
  // and a click on a marker selects its light; the wizard panel covers the markers from this camera, so it steps aside
  const first = await page.evaluate(() => {
    const marker = (window as unknown as DevWindow).__scene.meshes.find((m) => m.name === 'rider-marker')!
    return [marker.position.x, marker.position.y, marker.position.z] as Vec3
  })
  const stepAside = (hidden: boolean) =>
    page.evaluate((h) => (document.querySelector<HTMLElement>('aside[aria-label="Import tech rider"]')!.style.visibility = h ? 'hidden' : ''), hidden)
  await stepAside(true)
  await clickAt(page, first)
  await stepAside(false)
  await expect.poll(async () => (await markers()).map((m) => m.selected)).toEqual([true, false])

  await wizard.getByRole('button', { name: 'Close' }).click()
  await expect.poll(async () => (await markers()).length).toBe(0)
  // the plan picture was asked for and is not there; that is the one error this test expects
  errors = errors.filter((e) => !e.includes('/rider/plan.png'))
})
