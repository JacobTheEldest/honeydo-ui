import { expect, test } from '@playwright/test'
import type { Locator } from '@playwright/test'

test.beforeEach(async ({ request }) => {
  const response = await request.post('/api/v1/test-reset')
  expect(response.status()).toBe(204)
})

async function expectLargerHitAreaThanIcon(
  control: Locator,
  label: string,
  minWidthGrowth: number,
  minHeightGrowth: number
) {
  const box = await control.boundingBox()
  const iconBox = await control.locator('svg').boundingBox()
  expect(box, `${label} should be visible and measurable`).not.toBeNull()
  expect(iconBox, `${label} icon should be visible and measurable`).not.toBeNull()
  if (!box || !iconBox) throw new Error(`${label} has no bounding box`)
  // The clickable box is meaningfully larger than the icon on every side.
  expect(box.width, `${label} hit area should extend past its icon horizontally`)
    .toBeGreaterThanOrEqual(iconBox.width + minWidthGrowth)
  expect(box.height, `${label} hit area should extend past its icon vertically`)
    .toBeGreaterThanOrEqual(iconBox.height + minHeightGrowth)
  expect(iconBox.x, `${label} icon should sit inside the hit area`).toBeGreaterThanOrEqual(box.x + 4)
  expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(box.x + box.width - 4)
  expect(iconBox.y).toBeGreaterThanOrEqual(box.y + 4)
  expect(iconBox.y + iconBox.height).toBeLessThanOrEqual(box.y + box.height - 4)
}

test('fold caret and drag handle hit areas extend well beyond their icons', async ({ page }) => {
  await page.goto('/')
  const task = page.locator('[data-task-id="1"]')
  await expect(task).toBeVisible()

  await expectLargerHitAreaThanIcon(
    task.getByRole('button', { name: 'Collapse subtasks' }),
    'fold caret',
    12,
    20
  )
  await expectLargerHitAreaThanIcon(task.locator('[data-drag-handle]'), 'drag handle', 12, 20)

  await page.locator('[data-composer-toggle]').click()
  const composerHandle = page.locator('[data-task-composer] [data-drag-handle]')
  await expect(composerHandle).toBeVisible()
  await expectLargerHitAreaThanIcon(composerHandle, 'composer drag handle', 12, 20)
})

test('the fold caret toggles when clicked near its edge, away from the icon', async ({ page }) => {
  await page.goto('/')
  const task = page.locator('[data-task-id="1"]')
  await expect(task).toBeVisible()
  const caret = task.getByRole('button', { name: 'Collapse subtasks' })
  await expect(caret).toBeVisible()

  await caret.click({ position: { x: 3, y: 3 } })
  await expect(task.getByRole('button', { name: 'Expand subtasks' })).toBeVisible()
  await expect(page.locator('[data-task-id="11"]'), 'collapsing should unmount the child rows').toHaveCount(0)

  await task.getByRole('button', { name: 'Expand subtasks' }).click({ position: { x: 3, y: 3 } })
  await expect(page.locator('[data-task-id="11"]'), 'expanding should bring the child rows back').toBeVisible()
})

test('dragging activates from the drag handle hit area edge, away from the icon', async ({ page }) => {
  await page.goto('/')
  const task = page.locator('[data-task-id="2"]')
  await expect(task).toBeVisible()
  const handle = task.locator('[data-drag-handle]')
  const box = await handle.boundingBox()
  expect(box, 'drag handle should be visible and measurable').not.toBeNull()
  if (!box) throw new Error('drag handle has no bounding box')

  // Press near the button's top-left corner: inside the hit area, off the icon.
  const edge = { x: box.x + 3, y: box.y + 3 }
  await page.mouse.move(edge.x, edge.y)
  await page.mouse.down()
  await page.mouse.move(edge.x + 15, edge.y + 6, { steps: 3 })
  await page.waitForTimeout(100)

  await expect(page.locator('[data-drop-preview]'), 'drag should activate from the hit area edge').toBeVisible()
  await expect(task).toHaveJSProperty('offsetHeight', 0)
  await page.mouse.up()
})
