import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'

test.beforeEach(async ({ request }) => {
  const response = await request.post('/api/v1/test-reset')
  expect(response.status()).toBe(204)
})

interface FixtureState {
  parents: Record<string, number>
  tasks: Array<{ id: number; title: string }>
  requests: Array<{ method: string; path: string }>
}

async function serverState(request: APIRequestContext): Promise<FixtureState> {
  const response = await request.get('/api/v1/test-state')
  return (await response.json()) as FixtureState
}

async function deleteRequests(request: APIRequestContext) {
  const state = await serverState(request)
  return state.requests.filter((entry) => entry.method === 'DELETE')
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

function row(page: Page, taskId: number) {
  return page.locator(`[data-task-id="${taskId}"]`)
}

async function openTaskMenu(page: Page, taskId: number) {
  await row(page, taskId).getByRole('button', { name: 'Task actions' }).click()
}

test('deleting a leaf task hides it at once and Undo restores it with no server write', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await expect(row(page, 5)).toBeVisible()
  const orderBefore = await visibleRootIds(page)

  await openTaskMenu(page, 5)
  await row(page, 5).getByRole('menuitem', { name: 'Delete' }).click()

  // No dialog for a leaf: the row is hidden immediately and the undo toast
  // takes over — while the server still holds the task (deferred commit).
  const toast = page.locator('[data-toast]')
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('Deleted “Root C”')
  await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible()
  await expect(row(page, 5)).toHaveCount(0)
  expect(await deleteRequests(request)).toEqual([])
  expect((await serverState(request)).tasks.some((task) => task.id === 5)).toBe(true)

  await toast.getByRole('button', { name: 'Undo' }).click()

  await expect(toast).toBeHidden()
  await expect(row(page, 5)).toBeVisible()
  // Restored exactly: same slot, and nothing ever reached the server.
  expect(await visibleRootIds(page)).toEqual(orderBefore)
  expect(await deleteRequests(request)).toEqual([])
  await page.reload()
  await expect(row(page, 5)).toBeVisible()
})

test('the server delete lands only after the undo window closes', async ({ page, request }) => {
  await page.goto('/')
  await expect(row(page, 5)).toBeVisible()

  await openTaskMenu(page, 5)
  await row(page, 5).getByRole('menuitem', { name: 'Delete' }).click()
  const toast = page.locator('[data-toast]')
  await expect(toast).toContainText('Deleted “Root C”')
  await expect(row(page, 5)).toHaveCount(0)

  // Held mutation: while the undo toast is up the task survives on the server.
  expect(await deleteRequests(request)).toEqual([])
  expect((await serverState(request)).tasks.some((task) => task.id === 5)).toBe(true)

  // Do not hover the toast; the 7s undo timer must run out on its own.
  await page.mouse.move(0, 0)
  await expect(toast).toBeHidden({ timeout: 12000 })
  await expect.poll(async () => {
    const state = await serverState(request)
    const deletes = state.requests.filter((entry) => entry.method === 'DELETE')
    expect(deletes).toEqual([{ method: 'DELETE', path: '/api/v1/tasks/5' }])
    return state.tasks.some((task) => task.id === 5)
  }, { timeout: 10000 }).toBe(false)

  await page.reload()
  await expect(row(page, 5)).toHaveCount(0)
})

test('deleting a parent asks for scope and this-task-only orphans its subtasks', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await expect(row(page, 11)).toBeVisible()

  await openTaskMenu(page, 1)
  await row(page, 1).getByRole('menuitem', { name: 'Delete' }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Delete task?')
  await expect(dialog).toContainText('Root A')
  await expect(dialog.getByRole('radio', { name: 'This task only' })).toBeVisible()
  await expect(dialog.getByRole('radio', { name: 'This task and all subtasks (2)' })).toBeVisible()
  await expect(dialog).toContainText('may disappear from this view')

  // Cancel keeps everything untouched.
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(row(page, 1)).toBeVisible()
  expect(await deleteRequests(request)).toEqual([])

  await openTaskMenu(page, 1)
  await row(page, 1).getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('radio', { name: 'This task only' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()

  const toast = page.locator('[data-toast]')
  await expect(toast).toContainText('Deleted “Root A”')
  await expect(toast).not.toContainText('subtasks')
  // Deleting only the parent drops its subtasks out of this view at once.
  await expect(row(page, 1)).toHaveCount(0)
  await expect(row(page, 11)).toHaveCount(0)
  await expect(row(page, 12)).toHaveCount(0)
  expect(await deleteRequests(request)).toEqual([])

  await page.mouse.move(0, 0)
  await expect(toast).toBeHidden({ timeout: 12000 })
  await expect.poll(async () => {
    const state = await serverState(request)
    return state.tasks.some((task) => task.id === 1)
  }, { timeout: 10000 }).toBe(false)

  // Only the parent was deleted: the subtasks survive in Vikunja, orphaned.
  const state = await serverState(request)
  expect(state.tasks.some((task) => task.id === 11)).toBe(true)
  expect(state.tasks.some((task) => task.id === 12)).toBe(true)
  expect(state.parents['11']).toBeUndefined()
  expect(state.parents['12']).toBeUndefined()
  expect(
    state.requests.filter((entry) => entry.method === 'DELETE').map((entry) => entry.path)
  ).toEqual(['/api/v1/tasks/1'])

  await page.reload()
  await expect(row(page, 1)).toHaveCount(0)
  await expect(row(page, 11)).toHaveCount(0)
  await expect(row(page, 12)).toHaveCount(0)
})

test('deleting a subtree hides the whole subtree and Undo restores it intact', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await expect(row(page, 11)).toBeVisible()
  await expect(row(page, 11)).toHaveAttribute('data-sortable-id', '1::11')

  await openTaskMenu(page, 1)
  await row(page, 1).getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('radio', { name: 'This task and all subtasks (2)' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()

  const toast = page.locator('[data-toast]')
  await expect(toast).toContainText('Deleted “Root A” and 2 subtasks')
  await expect(row(page, 1)).toHaveCount(0)
  await expect(row(page, 11)).toHaveCount(0)
  await expect(row(page, 12)).toHaveCount(0)

  await toast.getByRole('button', { name: 'Undo' }).click()

  await expect(toast).toBeHidden()
  await expect(row(page, 1)).toBeVisible()
  await expect(row(page, 11)).toHaveAttribute('data-sortable-id', '1::11')
  await expect(row(page, 12)).toHaveAttribute('data-sortable-id', '1::12')
  // Undo canceled the commit: the server never saw a delete.
  expect(await deleteRequests(request)).toEqual([])
  await page.reload()
  await expect(row(page, 1)).toBeVisible()
  await expect(row(page, 11)).toBeVisible()
})

test('a subtree delete commits every descendant after the undo window closes', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await expect(row(page, 11)).toBeVisible()

  await openTaskMenu(page, 1)
  await row(page, 1).getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('radio', { name: 'This task and all subtasks (2)' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(row(page, 1)).toHaveCount(0)

  await page.mouse.move(0, 0)
  await expect(page.locator('[data-toast]')).toBeHidden({ timeout: 12000 })
  await expect.poll(async () => {
    const state = await serverState(request)
    return [1, 11, 12].some((id) => state.tasks.some((task) => task.id === id))
  }, { timeout: 10000 }).toBe(false)

  const state = await serverState(request)
  expect(
    state.requests.filter((entry) => entry.method === 'DELETE').map((entry) => entry.path).sort()
  ).toEqual(['/api/v1/tasks/1', '/api/v1/tasks/11', '/api/v1/tasks/12'])

  await page.reload()
  await expect(row(page, 1)).toHaveCount(0)
  await expect(row(page, 11)).toHaveCount(0)
  await expect(row(page, 12)).toHaveCount(0)
})

test('stacked deletes stay undoable one after another', async ({ page, request }) => {
  await page.goto('/')
  await expect(row(page, 5)).toBeVisible()
  const orderBefore = await visibleRootIds(page)

  await openTaskMenu(page, 5)
  await row(page, 5).getByRole('menuitem', { name: 'Delete' }).click()
  await openTaskMenu(page, 11)
  await row(page, 11).getByRole('menuitem', { name: 'Delete' }).click()

  const toast = page.locator('[data-toast]')
  // The newest delete surfaces first...
  await expect(toast).toContainText('Deleted “Promotable child”')
  await toast.getByRole('button', { name: 'Undo' }).click()

  // ...and undoing it reveals the previous one instead of discarding it.
  await expect(toast).toContainText('Deleted “Root C”')
  await expect(row(page, 11)).toBeVisible()
  await toast.getByRole('button', { name: 'Undo' }).click()

  await expect(toast).toBeHidden()
  await expect(row(page, 5)).toBeVisible()
  expect(await visibleRootIds(page)).toEqual(orderBefore)
  expect(await deleteRequests(request)).toEqual([])
})

test('a failed delete reports an error and the task comes back', async ({ page, request }) => {
  await page.goto('/')
  await expect(row(page, 5)).toBeVisible()
  await page.route('**/api/v1/tasks/5', async (route) => {
    if (route.request().method() === 'DELETE') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
      return
    }
    await route.continue()
  })

  await openTaskMenu(page, 5)
  await row(page, 5).getByRole('menuitem', { name: 'Delete' }).click()
  await expect(row(page, 5)).toHaveCount(0)

  await page.mouse.move(0, 0)
  const toast = page.locator('[data-toast]')
  await expect(toast).toContainText(/Couldn.t delete/, { timeout: 12000 })

  // The failed task is no longer masked, so it reappears from state.
  await expect(row(page, 5)).toBeVisible()
  expect((await serverState(request)).tasks.some((task) => task.id === 5)).toBe(true)
})

test('the Unlabel dialog still opens with scope options and cancels without writes', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await expect(row(page, 1)).toBeVisible()

  await openTaskMenu(page, 1)
  await row(page, 1).getByRole('menuitem', { name: 'Unlabel' }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Remove from Honey-Do?')
  await expect(dialog.getByRole('radio', { name: 'This task only' })).toBeVisible()
  await expect(dialog.getByRole('radio', { name: 'This task and all subtasks (2)' })).toBeVisible()

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(row(page, 1)).toBeVisible()
  expect((await serverState(request)).requests).toEqual([])
})
