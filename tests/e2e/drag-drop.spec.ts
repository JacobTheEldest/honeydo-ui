import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

async function dragHandleTo(
  page: Page,
  handle: Locator,
  target: { x: number; y: number },
  activeTask?: Locator,
  expectedMode?: 'sibling' | 'child'
) {
  const source = await handle.boundingBox()
  expect(source, 'drag handle should be visible and measurable').not.toBeNull()
  if (!source) throw new Error('drag handle has no bounding box')

  const start = { x: source.x + source.width / 2, y: source.y + source.height / 2 }
  const initialPointer = { x: start.x + 12, y: start.y + 3 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  // Follow the pointer overlay while the in-list simulated drop space updates.
  await page.mouse.move(initialPointer.x, initialPointer.y, { steps: 3 })
  await page.waitForTimeout(100)
  if (activeTask) {
    const activeRow = activeTask.locator(':scope > div').nth(1)
    const preview = page.locator('[data-drag-preview]')
    await expect(activeRow).toHaveCSS('opacity', '0')
    await expect(activeTask).toHaveJSProperty('offsetHeight', 0)
    await expect(preview).toBeVisible()
    const initialPreviewBox = await preview.boundingBox()
    expect(initialPreviewBox, 'drag preview should be measurable').not.toBeNull()
    if (!initialPreviewBox) throw new Error('drag preview has no bounding box')
    const previewCenterOffset = initialPreviewBox.y + initialPreviewBox.height / 2 - initialPointer.y
    const samples = 16
    for (let step = 1; step <= samples; step++) {
      const progress = step / samples
      const pointerY = initialPointer.y + (target.y - initialPointer.y) * progress
      const pointerX = initialPointer.x + (target.x - initialPointer.x) * progress
      await page.mouse.move(pointerX, pointerY)
      await page.waitForTimeout(16)
      const box = await preview.boundingBox()
      expect(box, 'drag preview should stay mounted during drag').not.toBeNull()
      if (!box) throw new Error('drag preview disappeared during drag')
      const expectedCenterY = pointerY + previewCenterOffset
      const actualCenterY = box.y + box.height / 2
      const drift = Math.abs(actualCenterY - expectedCenterY)
      expect(drift, `drag preview drifted at step ${step}: actualY=${actualCenterY}, expectedY=${expectedCenterY}, pointerY=${pointerY}`)
        .toBeLessThan(20)
      // The grabbed row never leaves an empty space, even while the pointer
      // crosses a region with no valid destination preview.
      await expect(activeRow).toHaveCSS('opacity', '0')
    }
  } else {
    await page.mouse.move(target.x, target.y, { steps: 12 })
  }
  await page.waitForTimeout(100)
  if (expectedMode !== undefined && activeTask) {
    const placeholder = page.locator('[data-drop-preview]')
    const activeId = await activeTask.getAttribute('data-task-id')
    const placeholderBox = await placeholder.boundingBox()
    expect(placeholderBox, 'drop preview should be measurable').not.toBeNull()
    if (!placeholderBox) throw new Error('drop preview has no bounding box')
    const placeholderRow = placeholder.locator(`[data-drop-preview-row="${activeId}"]`).first()
    await expect(placeholderRow).toHaveCSS('padding-left', expectedMode === 'child' ? '16px' : '0px')
    await expect(placeholder).toHaveCSS('opacity', '0.6')
    await expect(page.locator('[data-nest-target]')).toHaveCount(0)
    await expect(page.locator('[data-root-drop-target]')).toHaveCount(0)
    await expect(activeTask.locator(':scope > div').nth(1)).toHaveCSS('opacity', '0')
  }
  await page.mouse.up()
}

async function renderedRootIds(page: Page) {
  return page.locator('[data-task-id]').evaluateAll((rows) =>
    rows
      .filter((row) => row.getAttribute('data-sortable-id')?.startsWith('r::'))
      .map((row) => row.getAttribute('data-task-id'))
  )
}

test.beforeEach(async ({ request }) => {
  const response = await request.post('/api/v1/test-reset')
  expect(response.status()).toBe(204)
})

test('dragging a root task onto a parent creates and renders the subtask relation', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('[data-task-id="1"]')).toBeVisible()
  await expect(page.locator('[data-task-id="2"]')).toBeVisible()

  const source = page.locator('[data-task-id="2"] [data-drag-handle]')
  const belowBox = await page.locator('[data-task-id="11"]').boundingBox()
  const listBox = await page.locator('main').boundingBox()
  expect(belowBox, 'the first child row below the parent should be measurable').not.toBeNull()
  expect(listBox).not.toBeNull()
  if (!belowBox || !listBox) throw new Error('drop slot or task list has no bounding box')

  let holdRelation = false
  let releaseRelation!: () => void
  let relationArrived!: () => void
  const relationGate = new Promise<void>((resolve) => { releaseRelation = resolve })
  const relationRequestArrived = new Promise<void>((resolve) => { relationArrived = resolve })
  await page.route('**/api/v1/tasks/1/relations', async (route) => {
    if (holdRelation && route.request().method() === 'PUT') {
      relationArrived()
      await relationGate
    }
    await route.continue()
  })
  const relationRequest = page.waitForRequest((req) =>
    req.method() === 'PUT' && req.url().endsWith('/api/v1/tasks/1/relations')
  )
  const relationResponse = page.waitForResponse((response) =>
    response.request().method() === 'PUT' && response.url().endsWith('/api/v1/tasks/1/relations')
  )
  holdRelation = true
  await dragHandleTo(page, source, {
    x: listBox.x + listBox.width * 0.75,
    y: belowBox.y + 2,
  }, page.locator('[data-task-id="2"]'), 'child')
  await relationRequest
  await relationRequestArrived
  try {
    await expect(page.locator('[data-task-id="2"]')).toHaveAttribute('data-sortable-id', '1::2', { timeout: 500 })
  } finally {
    releaseRelation()
  }
  await relationResponse

  await expect.poll(async () => {
    const response = await request.get('/api/v1/test-state')
    const state = await response.json() as {
      parents: Record<string, number>
      tasks: Array<{ id: number; done: boolean }>
    }
    expect(state.tasks.find((task) => task.id === 2)?.done).toBe(false)
    return state.parents['2']
  }).toBe(1)

  await expect(page.locator('[data-task-id="2"]')).toHaveAttribute('style', /padding-left:\s*16px/)
  await page.reload()
  await expect(page.locator('[data-task-id="2"]')).toHaveAttribute('data-sortable-id', '1::2')
})

test('a long vertical drag onto a parent stays attached to the pointer and persists nesting', async ({ page, request }) => {
  const seeded = await request.post('/api/v1/test-seed-long-list')
  expect(seeded.status()).toBe(201)
  await page.setViewportSize({ width: 1280, height: 2200 })
  await page.goto('/')
  const sourceTask = page.locator('[data-task-id="3019"]')
  const source = sourceTask.locator('[data-drag-handle]')
  const belowBox = await page.locator('[data-task-id="11"]').boundingBox()
  const listBox = await page.locator('main').boundingBox()
  expect(belowBox).not.toBeNull()
  expect(listBox).not.toBeNull()
  if (!belowBox || !listBox) throw new Error('drop slot or task list has no bounding box')

  const relationRequest = page.waitForRequest((req) =>
    req.method() === 'PUT' && req.url().endsWith('/api/v1/tasks/1/relations')
  )
  await dragHandleTo(page, source, {
    x: listBox.x + listBox.width * 0.75,
    y: belowBox.y + 2,
  }, sourceTask, 'child')
  await relationRequest

  const response = await request.get('/api/v1/test-state')
  const state = await response.json() as {
    parents: Record<string, number>
    tasks: Array<{ id: number; done: boolean }>
  }
  expect(state.parents['3019']).toBe(1)
  expect(state.tasks.find((task) => task.id === 3019)?.done).toBe(false)

  await page.reload()
  const movedTask = page.locator('[data-task-id="3019"]')
  await expect(movedTask).toHaveAttribute('data-sortable-id', /1::3019/)
  await expect(movedTask).toHaveAttribute('style', /padding-left:\s*16px/)
})

test('touch-dragging a handle does not swipe or pull-to-refresh and can nest the task', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  const observedRequests: string[] = []
  page.on('request', (request) => observedRequests.push(`${request.method()} ${request.url()}`))
  try {
    await page.goto('/')
    await expect(page.locator('[data-task-id="2"]')).toBeVisible()
    observedRequests.length = 0
    const handle = page.locator('[data-task-id="2"] [data-drag-handle]')
    const sourceBox = await handle.boundingBox()
    const belowBox = await page.locator('[data-task-id="11"]').boundingBox()
    const listBox = await page.locator('main').boundingBox()
    const initialTargetRowBox = await page.locator('[data-task-id="1"]').boundingBox()
    expect(belowBox, 'the first child row below the parent should be measurable on mobile').not.toBeNull()
    if (!sourceBox || !belowBox || !listBox || !initialTargetRowBox) throw new Error('source, drop slot or parent has no bounding box')

    const source = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 }
    const target = { x: listBox.x + listBox.width * 0.75, y: belowBox.y + 2 }
    const touch = (x: number, y: number) => ({ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 })

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(source.x, source.y)] })
    await page.waitForTimeout(20) // Typical user movement arrives before the old long-press delay.
    const activationPoint = { x: source.x + 12, y: source.y + 3 }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(activationPoint.x, activationPoint.y)] })
    await page.waitForTimeout(100)
    const activeRow = page.locator('[data-task-id="2"] > div').nth(1)
    const preview = page.locator('[data-drag-preview]')
    await expect(activeRow).toHaveCSS('opacity', '0')
    await expect(page.locator('[data-task-id="2"]')).toHaveJSProperty('offsetHeight', 0)
    await expect(page.locator('[data-drop-preview]')).toBeVisible()
    await expect(preview).toBeVisible()
    const initialPreviewBox = await preview.boundingBox()
    expect(initialPreviewBox).not.toBeNull()
    if (!initialPreviewBox) throw new Error('touch drag preview has no bounding box')
    const previewCenterOffset = initialPreviewBox.y + initialPreviewBox.height / 2 - activationPoint.y

    for (let step = 1; step <= 16; step++) {
      const progress = step / 16
      const x = activationPoint.x + (target.x - activationPoint.x) * progress
      const y = activationPoint.y + (target.y - activationPoint.y) * progress
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(x, y)] })
      await page.waitForTimeout(16)
      const previewBox = await preview.boundingBox()
      expect(previewBox, `touch preview should remain mounted at step ${step}`).not.toBeNull()
      if (!previewBox) throw new Error('touch preview disappeared during drag')
      const expectedCenterY = y + previewCenterOffset
      expect(Math.abs(previewBox.y + previewBox.height / 2 - expectedCenterY), `touch preview drifted at step ${step}`)
        .toBeLessThan(20)
      // The grabbed row never leaves an empty space, even while the pointer
      // crosses a region with no valid destination preview.
      await expect(activeRow).toHaveCSS('opacity', '0')
    }

    const nestingPlaceholder = page.locator('[data-drop-preview]')
    const targetRow = page.locator('[data-task-id="1"]')
    const targetRowBox = await targetRow.boundingBox()
    const placeholderBox = await nestingPlaceholder.boundingBox()
    expect(placeholderBox, 'touch nesting preview should be measurable').not.toBeNull()
    if (!placeholderBox || !targetRowBox) throw new Error('touch nesting preview or target has no bounding box')
    expect(placeholderBox.y).toBeGreaterThanOrEqual(targetRowBox.y + targetRowBox.height - 1)
    await expect(nestingPlaceholder.locator('[data-drop-preview-row="2"]').first()).toHaveCSS('padding-left', '16px')
    await expect(nestingPlaceholder).toHaveCSS('opacity', '0.6')
    await expect(page.locator('[data-nest-target]')).toHaveCount(0)
    await expect(page.locator('[data-root-drop-target]')).toHaveCount(0)
    await expect(activeRow).toHaveCSS('opacity', '0')
    expect(observedRequests.some((entry) => entry.includes('/api/v1/projects')))
      .toBe(false)
    await expect(activeRow).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')


    const relationRequest = page.waitForRequest((request) =>
      request.method() === 'PUT' && request.url().endsWith('/api/v1/tasks/1/relations')
    )
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await relationRequest
    await expect.poll(async () => {
      const response = await page.request.get('http://127.0.0.1:3001/api/v1/test-state')
      const state = await response.json() as {
        parents: Record<string, number>
        requests: Array<{ method: string; path: string }>
        tasks: Array<{ id: number; done: boolean }>
      }
      expect(state.parents['2']).toBe(1)
      expect(state.requests.filter((entry) => entry.path.includes('/relations'))).toHaveLength(1)
      expect(state.tasks.find((task) => task.id === 2)?.done).toBe(false)
      return state.parents['2']
    }).toBe(1)
    await page.reload()
    const movedTask = page.locator('[data-task-id="2"]')
    await expect(movedTask).toHaveAttribute('style', /padding-left:\s*16px/)
    await expect(movedTask).toHaveAttribute('data-sortable-id', /1::2/)
  } finally {
    await context.close()
  }
})

test('pull-to-refresh remains active from non-handle content', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  const requests: string[] = []
  page.on('request', (request) => requests.push(`${request.method()} ${request.url()}`))
  try {
    await page.goto('/')
    const title = page.getByRole('button', { name: 'Root A' })
    await expect(title).toBeVisible()
    requests.length = 0
    const box = await title.boundingBox()
    expect(box).not.toBeNull()
    if (!box) throw new Error('task title has no bounding box')
    const x = box.x + box.width / 2
    const startY = box.y + box.height / 2
    const touch = (y: number) => ({ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 })
    const refreshRequest = page.waitForRequest((request) =>
      request.method() === 'GET' && request.url().includes('/api/v1/projects?per_page=200')
    )
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(startY)] })
    await page.waitForTimeout(260) // use-gesture preventScroll activation delay.
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [touch(startY + (100 * step / 8))],
      })
      await page.waitForTimeout(16)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await refreshRequest
    expect(requests.filter((entry) => entry.includes('GET ') && entry.includes('/api/v1/projects?per_page=200')))
      .toHaveLength(1)
  } finally {
    await context.close()
  }
})

test('dragging a root task down by one sibling persists exactly one position', async ({ page, request }) => {
  await page.goto('/')
  const source = page.locator('[data-task-id="1"] [data-drag-handle]')
  const targetRow = page.locator('[data-task-id="5"]')
  await expect(source).toBeVisible()
  const targetBox = await targetRow.boundingBox()
  expect(targetBox).not.toBeNull()
  if (!targetBox) throw new Error('target row has no bounding box')

  let holdUpdate = false
  let releaseUpdate!: () => void
  let updateArrived!: () => void
  const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve })
  const updateRequestArrived = new Promise<void>((resolve) => { updateArrived = resolve })
  await page.route('**/api/v1/tasks/1', async (route) => {
    if (holdUpdate && route.request().method() === 'POST') {
      updateArrived()
      await updateGate
    }
    await route.continue()
  })
  const updateResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && response.url().endsWith('/api/v1/tasks/1')
  )
  holdUpdate = true
  await dragHandleTo(page, source, {
    x: targetBox.x + targetBox.width * 0.4,
    y: targetBox.y + 2,
  }, page.locator('[data-task-id="1"]'), 'sibling')
  await updateRequestArrived
  try {
    expect((await renderedRootIds(page)).slice(0, 3)).toEqual(['2', '1', '5'])
  } finally {
    releaseUpdate()
  }
  expect((await updateResponse).ok()).toBe(true)

  await page.reload()
  await expect(page.locator('[data-task-id="1"]')).toBeVisible()
  expect((await renderedRootIds(page)).slice(0, 3)).toEqual(['2', '1', '5'])

  const response = await request.get('/api/v1/test-state')
  const state = await response.json() as { tasks: Array<{ id: number; due_date: string | null }> }
  const orderedRoots = state.tasks
    .filter((task) => [1, 2, 5].includes(task.id))
    .sort((a, b) => Date.parse(a.due_date ?? '') - Date.parse(b.due_date ?? ''))
    .map((task) => task.id)
  expect(orderedRoots).toEqual([2, 1, 5])
})

test('dragging a root task down by two siblings persists the full move after reload', async ({ page, request }) => {
  await page.goto('/')
  const source = page.locator('[data-task-id="1"] [data-drag-handle]')
  const targetRow = page.locator('[data-task-id="31"]')
  await expect(source).toBeVisible()
  const targetBox = await targetRow.boundingBox()
  expect(targetBox).not.toBeNull()
  if (!targetBox) throw new Error('target row has no bounding box')

  const updateResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && response.url().endsWith('/api/v1/tasks/1')
  )
  await dragHandleTo(page, source, {
    x: targetBox.x + targetBox.width * 0.4,
    y: targetBox.y + 2,
  }, page.locator('[data-task-id="1"]'), 'sibling')
  expect((await updateResponse).ok()).toBe(true)

  await page.reload()
  await expect(page.locator('[data-task-id="1"]')).toBeVisible()
  expect((await renderedRootIds(page)).slice(0, 3)).toEqual(['2', '5', '1'])

  const response = await request.get('/api/v1/test-state')
  const state = await response.json() as { tasks: Array<{ id: number; due_date: string | null }> }
  const orderedRoots = state.tasks
    .filter((task) => [1, 2, 5].includes(task.id))
    .sort((a, b) => Date.parse(a.due_date ?? '') - Date.parse(b.due_date ?? ''))
    .map((task) => task.id)
  expect(orderedRoots).toEqual([2, 5, 1])
})

test('dragging a root task two siblings up persists the full move after reload', async ({ page, request }) => {
  await page.goto('/')
  const source = page.locator('[data-task-id="5"] [data-drag-handle]')
  const targetRow = page.locator('[data-task-id="1"]')
  await expect(source).toBeVisible()
  const targetBox = await targetRow.boundingBox()
  expect(targetBox).not.toBeNull()
  if (!targetBox) throw new Error('target row has no bounding box')

  const updateResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && response.url().endsWith('/api/v1/tasks/5')
  )
  await dragHandleTo(page, source, {
    x: targetBox.x + targetBox.width * 0.4,
    y: targetBox.y + 2,
  }, page.locator('[data-task-id="5"]'), 'sibling')
  expect((await updateResponse).ok()).toBe(true)

  await page.reload()
  await expect(page.locator('[data-task-id="1"]')).toBeVisible()
  expect((await renderedRootIds(page)).slice(0, 3)).toEqual(['5', '1', '2'])

  const response = await request.get('/api/v1/test-state')
  const state = await response.json() as { tasks: Array<{ id: number; due_date: string | null }> }
  const orderedRoots = state.tasks
    .filter((task) => [1, 2, 5].includes(task.id))
    .sort((a, b) => Date.parse(a.due_date ?? '') - Date.parse(b.due_date ?? ''))
    .map((task) => task.id)
  expect(orderedRoots).toEqual([5, 1, 2])
})

test('the composer uses the simulated split preview when being placed', async ({ page }) => {
  const writes: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`)
  })
  await page.goto('/')
  await page.locator('[data-composer-toggle]').click()
  const composer = page.locator('[data-task-composer]')
  const handle = composer.locator('[data-drag-handle]')
  const handleBox = await handle.boundingBox()
  const belowBox = await page.locator('[data-task-id="11"]').boundingBox()
  const listBox = await page.locator('main').boundingBox()
  expect(handleBox).not.toBeNull()
  expect(belowBox).not.toBeNull()
  expect(listBox).not.toBeNull()
  if (!handleBox || !belowBox || !listBox) throw new Error('composer or target rows have no bounding box')

  const start = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 12, start.y + 3, { steps: 3 })
  await page.mouse.move(listBox.x + listBox.width * 0.75, belowBox.y + 2, { steps: 12 })
  const preview = page.locator('[data-drop-preview]')
  await expect(preview.locator('[data-drop-preview-row="-1"]')).toBeVisible()
  await expect(page.locator('[data-nest-target]')).toHaveCount(0)
  await expect(page.locator('[data-root-drop-target]')).toHaveCount(0)

  await page.mouse.up()
  await expect(composer).toBeVisible()
  await expect(composer).toHaveAttribute('data-composer-depth', '1')
  await expect(composer).toHaveCSS('padding-left', '32px')
  expect(writes).toEqual([])
})

test('Add subtask from a leaf task menu opens an indented composer under that task', async ({ page }) => {
  await page.goto('/')
  const leaf = page.locator('[data-task-id="5"]')
  await leaf.getByRole('button', { name: 'Task actions' }).click()
  await leaf.getByRole('menuitem', { name: 'Add subtask' }).click()

  const composer = page.locator('[data-task-composer]')
  await expect(composer).toBeVisible()
  await expect(composer).toHaveAttribute('data-composer-depth', '1')
  await expect(composer.getByRole('textbox', { name: 'New task title' })).toBeFocused()
})

test('the left half of the simulated slot promotes a task as a sibling of the row below', async ({ page, request }) => {
  await page.goto('/')
  const handle = page.locator('[data-task-id="11"] [data-drag-handle]')
  const belowRow = page.locator('[data-task-id="2"]')
  const handleBox = await handle.boundingBox()
  const belowBox = await belowRow.boundingBox()
  const listBox = await page.locator('main').boundingBox()
  expect(handleBox, 'subtask handle should be measurable').not.toBeNull()
  expect(belowBox, 'the next root row should be measurable').not.toBeNull()
  expect(listBox).not.toBeNull()
  if (!handleBox || !belowBox || !listBox) throw new Error('source or simulated drop slot has no bounding box')

  const start = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 }
  let holdRemoval = false
  let releaseRemoval!: () => void
  let removalArrived!: () => void
  const removalGate = new Promise<void>((resolve) => { releaseRemoval = resolve })
  const removalRequestArrived = new Promise<void>((resolve) => { removalArrived = resolve })
  await page.route('**/api/v1/tasks/1/relations/subtask/11', async (route) => {
    if (holdRemoval && route.request().method() === 'DELETE') {
      removalArrived()
      await removalGate
    }
    await route.continue()
  })
  const relationRemoval = page.waitForRequest((req) =>
    req.method() === 'DELETE' && req.url().endsWith('/api/v1/tasks/1/relations/subtask/11')
  )
  const relationRemovalResponse = page.waitForResponse((response) =>
    response.request().method() === 'DELETE' && response.url().endsWith('/api/v1/tasks/1/relations/subtask/11')
  )
  holdRemoval = true
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 12, start.y + 3, { steps: 3 })
  await page.mouse.move(listBox.x + listBox.width * 0.25, belowBox.y + 2, { steps: 12 })
  await expect(page.locator('[data-nest-target]')).toHaveCount(0)
  await expect(page.locator('[data-root-drop-target]')).toHaveCount(0)

  await page.mouse.up()
  await relationRemoval
  await removalRequestArrived
  try {
    await expect(page.locator('[data-task-id="11"]')).toHaveAttribute('data-sortable-id', 'r::11', { timeout: 500 })
    expect((await renderedRootIds(page)).slice(0, 3)).toEqual(['1', '11', '2'])
  } finally {
    releaseRemoval()
  }
  await relationRemovalResponse
  await expect.poll(async () => {
    const response = await request.get('/api/v1/test-state')
    const state = await response.json() as {
      parents: Record<string, number>
      tasks: Array<{ id: number; labels: Array<{ title: string }> }>
    }
    expect(state.parents['11']).toBeUndefined()
    return state.tasks.find((task) => task.id === 11)?.labels.some((label) => label.title === 'Honey-Do')
  }).toBe(true)
  await expect(page.locator('[data-task-id="11"]')).toHaveAttribute('data-sortable-id', 'r::11')
  await page.reload()
  await expect(page.locator('[data-task-id="11"]')).toHaveAttribute('data-sortable-id', 'r::11')
})
