import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'

test.beforeEach(async ({ request }) => {
  const response = await request.post('/api/v1/test-reset')
  expect(response.status()).toBe(204)
})

async function serverDone(request: APIRequestContext, taskId: number) {
  const response = await request.get('/api/v1/test-state')
  const state = (await response.json()) as {
    tasks: Array<{ id: number; done: boolean }>
  }
  return state.tasks.find((task) => task.id === taskId)?.done
}

async function visibleRootIds(page: Page) {
  return page.locator('[data-task-id]').evaluateAll((rows) =>
    rows
      .filter(
        (row) =>
          row.getAttribute('data-sortable-id')?.startsWith('r::') &&
          !row.classList.contains('hidden')
      )
      .map((row) => row.getAttribute('data-task-id'))
  )
}

async function flickRowLeft(page: Page, taskId: number, title: string) {
  const target = page.locator(`[data-task-id="${taskId}"] button`, { hasText: title })
  const box = await target.boundingBox()
  expect(box, 'swipe target should be measurable').not.toBeNull()
  if (!box) throw new Error('swipe target has no bounding box')
  const startX = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(startX, y)
  await page.mouse.down()
  // Model a real fling: fast movement samples with pointerup right after the
  // last one. @use-gesture recomputes velocity on the up event whenever the
  // gap since the last move exceeds 32ms (BEFORE_LAST_KINEMATICS_DELAY),
  // which would replace the flick's velocity with the up event's zero delta.
  for (const distance of [60, 120, 180]) {
    await page.mouse.move(startX - distance, y)
  }
  await page.mouse.up()
}

test('completing via checkbox shows an undo toast that restores the task in place', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await expect(page.locator('[data-task-id="1"]')).toBeVisible()
  const orderBefore = await visibleRootIds(page)

  await page.locator('[data-task-id="1"] button[aria-label="Mark complete"]').click()

  const toast = page.locator('[data-toast]')
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('Completed “Root A”')
  await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible()

  // Completion hides the task (show-done is off by default).
  await expect(page.locator('[data-task-id="1"]')).toBeHidden()
  await expect.poll(async () => serverDone(request, 1)).toBe(true)

  await toast.getByRole('button', { name: 'Undo' }).click()

  await expect(page.locator('[data-task-id="1"]')).toBeVisible()
  await expect(
    page.locator('[data-task-id="1"] button[aria-label="Mark complete"]')
  ).toBeVisible()
  await expect(toast).toBeHidden()
  await expect.poll(async () => serverDone(request, 1)).toBe(false)
  // Restored without a reload and without moving to another slot.
  expect(await visibleRootIds(page)).toEqual(orderBefore)
})

test('undo works after a swipe completion', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('[data-task-id="5"]')).toBeVisible()

  await flickRowLeft(page, 5, 'Root C')

  const toast = page.locator('[data-toast]')
  await expect(toast).toContainText('Completed “Root C”')
  await expect(page.locator('[data-task-id="5"]')).toBeHidden()
  await expect.poll(async () => serverDone(request, 5)).toBe(true)

  await toast.getByRole('button', { name: 'Undo' }).click()

  await expect(page.locator('[data-task-id="5"]')).toBeVisible()
  await expect.poll(async () => serverDone(request, 5)).toBe(false)
})

test('completing several tasks keeps earlier completions undoable', async ({
  page,
  request,
}) => {
  await page.goto('/')
  // Capture baselines only after the initial task fetch has rendered rows.
  await expect(page.locator('[data-task-id="1"]')).toBeVisible()
  const orderBefore = await visibleRootIds(page)

  await page.locator('[data-task-id="1"] button[aria-label="Mark complete"]').click()
  await page.locator('[data-task-id="2"] button[aria-label="Mark complete"]').click()

  const toast = page.locator('[data-toast]')
  // The newest completion surfaces first...
  await expect(toast).toContainText('Completed “Root B”')
  await toast.getByRole('button', { name: 'Undo' }).click()

  // ...and undoing it reveals the previous one instead of discarding it.
  await expect(toast).toContainText('Completed “Root A”')
  await expect(page.locator('[data-task-id="2"]')).toBeVisible()
  await expect.poll(async () => serverDone(request, 2)).toBe(false)
  await expect.poll(async () => serverDone(request, 1)).toBe(true)

  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(toast).toBeHidden()
  await expect(page.locator('[data-task-id="1"]')).toBeVisible()
  await expect.poll(async () => serverDone(request, 1)).toBe(false)
  expect(await visibleRootIds(page)).toEqual(orderBefore)
})

test('manually marking a task incomplete closes its undo toast', async ({ page, request }) => {
  await page.goto('/')
  await page.locator('[data-task-id="1"] button[aria-label="Mark complete"]').click()

  const toast = page.locator('[data-toast]')
  await expect(toast).toContainText('Completed “Root A”')

  await page.getByRole('button', { name: 'Show done' }).click()
  await expect(
    page.locator('[data-task-id="1"] button[aria-label="Mark incomplete"]')
  ).toBeVisible()
  await page.locator('[data-task-id="1"] button[aria-label="Mark incomplete"]').click()

  await expect(toast).toBeHidden()
  await expect.poll(async () => serverDone(request, 1)).toBe(false)
})

test('a failed save reports an error instead of offering undo', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('[data-task-id="1"]')).toBeVisible()

  await page.route('**/api/v1/tasks/1', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
      return
    }
    await route.continue()
  })

  await page.locator('[data-task-id="1"] button[aria-label="Mark complete"]').click()

  const toast = page.locator('[data-toast]')
  await expect(toast).toContainText('Could not update this task.')
  await expect(toast.getByRole('button')).toHaveCount(0)
  await expect(page.locator('[data-task-id="1"]')).toBeVisible()
  expect(await serverDone(request, 1)).toBe(false)
})

test('hovering the toast pauses the undo timer until the pointer leaves', async ({ page }) => {
  await page.goto('/')
  await page.locator('[data-task-id="1"] button[aria-label="Mark complete"]').click()

  const toast = page.locator('[data-toast]')
  await expect(toast).toContainText('Completed “Root A”')

  await toast.hover()
  // Well past the 7s undo timeout: only a paused timer keeps the toast up.
  await page.waitForTimeout(7200)
  await expect(toast).toBeVisible()

  await page.mouse.move(0, 0)
  // The unexpired remainder runs out after the pointer leaves.
  await expect(toast).toBeHidden({ timeout: 8000 })
})
