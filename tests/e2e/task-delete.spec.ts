import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'

test.beforeEach(async ({ request }) => {
  const response = await request.post('/api/v1/test-reset')
  expect(response.status()).toBe(204)
})

interface FixtureState {
  parents: Record<string, number>
  tasks: Array<{ id: number; title: string }>
  trashed: Array<{ id: number; title: string }>
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

async function restoreRequests(request: APIRequestContext) {
  const state = await serverState(request)
  return state.requests.filter(
    (entry) => entry.method === 'POST' && entry.path.endsWith('/restore')
  )
}

async function trashedIds(request: APIRequestContext) {
  const state = await serverState(request)
  return state.trashed.map((task) => task.id).sort((a, b) => a - b)
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

test('deleting a leaf task hides it at once, commits to the trash, and Undo restores it', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await expect(row(page, 5)).toBeVisible()
  const orderBefore = await visibleRootIds(page)

  await openTaskMenu(page, 5)
  await row(page, 5).getByRole('menuitem', { name: 'Delete' }).click()

  // No dialog for a leaf: the row is hidden immediately and the undo toast
  // takes over — while the server delete is already on its way.
  const toast = page.locator('[data-toast]')
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('Deleted “Root C”')
  await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible()
  await expect(row(page, 5)).toHaveCount(0)

  // The delete commits immediately: the task lands in Vikunja's trash.
  await expect.poll(async () => (await deleteRequests(request)).map((entry) => entry.path))
    .toEqual(['/api/v1/tasks/5'])
  expect(await trashedIds(request)).toEqual([5])

  await toast.getByRole('button', { name: 'Undo' }).click()

  await expect(toast).toBeHidden()
  await expect(row(page, 5)).toBeVisible()
  // Restored from the trash exactly: same slot in the order.
  expect(await visibleRootIds(page)).toEqual(orderBefore)
  expect(await trashedIds(request)).toEqual([])
  await expect.poll(async () => (await restoreRequests(request)).map((entry) => entry.path))
    .toEqual(['/api/v2/tasks/5/restore'])
  await page.reload()
  await expect(row(page, 5)).toBeVisible()
})

test('letting the undo window close keeps the delete committed with no second write', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await expect(row(page, 5)).toBeVisible()

  await openTaskMenu(page, 5)
  await row(page, 5).getByRole('menuitem', { name: 'Delete' }).click()
  const toast = page.locator('[data-toast]')
  await expect(toast).toContainText('Deleted “Root C”')
  await expect(row(page, 5)).toHaveCount(0)

  // The delete already landed while the toast was up.
  await expect.poll(async () => (await deleteRequests(request)).map((entry) => entry.path))
    .toEqual(['/api/v1/tasks/5'])

  // Do not hover the toast; the 7s undo timer must run out on its own.
  await page.mouse.move(0, 0)
  await expect(toast).toBeHidden({ timeout: 12000 })
  // Window expiry issues no writes: still exactly one delete, still trashed.
  expect((await deleteRequests(request)).map((entry) => entry.path)).toEqual(['/api/v1/tasks/5'])
  expect(await trashedIds(request)).toEqual([5])

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

  await expect.poll(async () => (await deleteRequests(request)).map((entry) => entry.path))
    .toEqual(['/api/v1/tasks/1'])

  // Only the parent was deleted: the subtasks themselves survive in Vikunja.
  // The relation rows survive too (verified live 2.8.0) — hidden from views
  // while the parent is trashed, and re-exposed by a later restore.
  const state = await serverState(request)
  expect(state.tasks.some((task) => task.id === 11)).toBe(true)
  expect(state.tasks.some((task) => task.id === 12)).toBe(true)
  expect(await trashedIds(request)).toEqual([1])
  expect(state.parents).toMatchObject({ '11': 1, '12': 1 })

  await page.reload()
  await expect(row(page, 1)).toHaveCount(0)
  await expect(row(page, 11)).toHaveCount(0)
  await expect(row(page, 12)).toHaveCount(0)
})

test('undoing a task-only delete restores the parent with its subtask links intact', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await expect(row(page, 11)).toHaveAttribute('data-sortable-id', '1::11')

  await openTaskMenu(page, 1)
  await row(page, 1).getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('radio', { name: 'This task only' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(row(page, 1)).toHaveCount(0)

  const toast = page.locator('[data-toast]')
  await toast.getByRole('button', { name: 'Undo' }).click()

  // Verified live on Vikunja 2.8.0: restore re-exposes the relation rows
  // itself, so undo must issue no relink writes — only the restore.
  await expect(row(page, 1)).toBeVisible()
  await expect(row(page, 11)).toHaveAttribute('data-sortable-id', '1::11')
  await expect(row(page, 12)).toHaveAttribute('data-sortable-id', '1::12')
  await expect.poll(async () => (await serverState(request)).parents)
    .toMatchObject({ '11': 1, '12': 1 })
  expect(await trashedIds(request)).toEqual([])
  expect(
    (await serverState(request)).requests.filter(
      (entry) => entry.method === 'PUT' && entry.path.includes('/relations'),
    ),
  ).toEqual([])

  await page.reload()
  await expect(row(page, 11)).toHaveAttribute('data-sortable-id', '1::11')
})

test('deleting a subtree hides it, commits every descendant, and Undo restores it intact', async ({
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

  // Every descendant is committed to the trash immediately (deepest-first).
  await expect.poll(async () =>
    (await deleteRequests(request)).map((entry) => entry.path).sort()
  ).toEqual(['/api/v1/tasks/1', '/api/v1/tasks/11', '/api/v1/tasks/12'])
  expect(await trashedIds(request)).toEqual([1, 11, 12])

  await toast.getByRole('button', { name: 'Undo' }).click()

  await expect(toast).toBeHidden()
  await expect(row(page, 1)).toBeVisible()
  await expect(row(page, 11)).toHaveAttribute('data-sortable-id', '1::11')
  await expect(row(page, 12)).toHaveAttribute('data-sortable-id', '1::12')
  // All restored from the trash; Vikunja re-exposes the relation rows itself,
  // so no relink writes may fire during the undo.
  expect(await trashedIds(request)).toEqual([])
  await expect.poll(async () => (await serverState(request)).parents)
    .toMatchObject({ '11': 1, '12': 1 })
  expect(
    (await serverState(request)).requests.filter(
      (entry) => entry.method === 'PUT' && entry.path.includes('/relations'),
    ),
  ).toEqual([])
  await page.reload()
  await expect(row(page, 1)).toBeVisible()
  await expect(row(page, 11)).toBeVisible()
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
  expect(await trashedIds(request)).toEqual([])
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

  const toast = page.locator('[data-toast]')
  await expect(toast).toContainText(/Couldn.t delete/)

  // The failed task is no longer masked, so it reappears from state.
  await expect(row(page, 5)).toBeVisible()
  const state = await serverState(request)
  expect(state.tasks.some((task) => task.id === 5)).toBe(true)
  expect(state.trashed).toEqual([])
})

test('a failed restore keeps the task in the trash and says where to find it', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await expect(row(page, 5)).toBeVisible()
  await page.route('**/api/v2/tasks/5/restore', async (route) => {
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
  })

  await openTaskMenu(page, 5)
  await row(page, 5).getByRole('menuitem', { name: 'Delete' }).click()
  const toast = page.locator('[data-toast]')
  await expect(toast).toContainText('Deleted “Root C”')
  await toast.getByRole('button', { name: 'Undo' }).click()

  await expect(toast).toContainText(/Couldn.t restore/)
  await expect(toast).toContainText(/trash/)
  // Honest recovery: the row stays hidden, the task stays in Vikunja's trash.
  await expect(row(page, 5)).toHaveCount(0)
  expect(await trashedIds(request)).toEqual([5])
})

test('the row hides before a held delete settles and a racing undo still restores', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await expect(row(page, 5)).toBeVisible()

  // Hold the DELETE response so the optimistic UI can be observed mid-flight.
  let releaseDelete: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    releaseDelete = resolve
  })
  await page.route('**/api/v1/tasks/5', async (route) => {
    if (route.request().method() === 'DELETE') {
      await held
      await route.continue()
      return
    }
    await route.continue()
  })

  await openTaskMenu(page, 5)
  await row(page, 5).getByRole('menuitem', { name: 'Delete' }).click()
  const toast = page.locator('[data-toast]')
  await expect(toast).toContainText('Deleted “Root C”')
  // Hidden and masked while the delete is still pending...
  await expect(row(page, 5)).toHaveCount(0)
  expect((await serverState(request)).requests.filter((entry) => entry.method === 'DELETE')).toEqual([])

  // ...and a racing Undo is serialized behind the pending delete: no restore
  // may fire until the held delete settles.
  await toast.getByRole('button', { name: 'Undo' }).click()
  expect(await restoreRequests(request)).toEqual([])

  releaseDelete()
  await expect.poll(async () => {
    const state = await serverState(request)
    return {
      deletes: state.requests.filter((entry) => entry.method === 'DELETE').map((entry) => entry.path),
      restores: state.requests
        .filter((entry) => entry.method === 'POST' && entry.path.endsWith('/restore'))
        .map((entry) => entry.path),
      trashed: state.trashed.map((task) => task.id),
      present: state.tasks.some((task) => task.id === 5),
    }
  }).toEqual({
    deletes: ['/api/v1/tasks/5'],
    restores: ['/api/v2/tasks/5/restore'],
    trashed: [],
    present: true,
  })
  await expect(row(page, 5)).toBeVisible()
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
