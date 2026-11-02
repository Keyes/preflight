import { expect, test } from '@playwright/test'

test('the demo club opens and renders without errors', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/')
  // With no venues yet, the Venues window opens and offers the demo club.
  const model = page.waitForResponse((res) => res.url().includes('/model.glb') && res.ok())
  await page.getByRole('button', { name: 'Open the demo club' }).click()
  await model
  await expect(page.getByRole('tab', { name: /Lights\s*18/ })).toBeVisible()
  await expect(page.getByText('Loading venue…')).toBeHidden()

  // The picture is more than one flat color: the room and its lights were drawn.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const view = document.querySelector('canvas')
          const sample = document.createElement('canvas')
          sample.width = 64
          sample.height = 36
          const ctx = sample.getContext('2d')
          if (!view || !ctx) return 0
          ctx.drawImage(view, 0, 0, sample.width, sample.height)
          const pixels = ctx.getImageData(0, 0, sample.width, sample.height).data
          let darkest = 765
          let brightest = 0
          for (let i = 0; i < pixels.length; i += 4) {
            const sum = pixels[i] + pixels[i + 1] + pixels[i + 2]
            darkest = Math.min(darkest, sum)
            brightest = Math.max(brightest, sum)
          }
          return brightest - darkest
        }),
      { message: 'the view should show the venue, not one flat color' },
    )
    .toBeGreaterThan(60)

  expect(errors).toEqual([])
})
