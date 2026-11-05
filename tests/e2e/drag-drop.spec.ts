import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

async function dragHandleTo(
  page: Page,
  handle: Locator,
  target: { x: number; y: number },
  activeTask?: Locator,
  nestTargetId?: number
) {
  const source = await handle.boundingBox()
  expect(source, 'drag handle should be visible and measurable').not.toBeNull()
  if (!source) throw new Error('drag handle has no bounding box')

  const start = { x: source.x + source.width / 2, y: source.y + source.height / 2 }
  const initialPointer = { x: start.x + 12, y: start.y + 3 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  // Follow the actual overlay during movement. The origin row is dimmed until
  // a nest destination is active, when the target placeholder takes over.
  await page.mouse.move(initialPointer.x, initialPointer.y, { steps: 3 })
  await page.waitForTimeout(100)
  if (activeTask) {
    const activeRow = activeTask.locator(':scope > div').nth(1)
    const preview = page.locator('[data-drag-preview]')
    await expect(activeRow).toHaveCSS('opacity', '0.5')
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
      const hasNestDestination = await page.locator('[data-nest-placeholder]').count() > 0
      await expect(activeRow).toHaveCSS('opacity', hasNestDestination ? '0' : '0.5')
    }
  } else {
    await page.mouse.move(target.x, target.y, { steps: 12 })
  }
  await page.waitForTimeout(100)
  if (nestTargetId !== undefined && activeTask) {
    const placeholder = page.locator(`[data-nest-placeholder="${nestTargetId}"]`)
    await expect(placeholder).toBeVisible()
    const activeId = await activeTask.getAttribute('data-task-id')
    const targetRow = page.locator(`[data-task-id="${nestTargetId}"]`)
    await expect(targetRow).toHaveAttribute('data-nest-preview-target', 'true')
    await expect(targetRow.locator('[data-nest-target-highlight]')).toBeVisible()
    const targetBox = await targetRow.boundingBox()
    const nestZoneBox = await page.locator(`[data-nest-target="${nestTargetId}"]`).boundingBox()
    const placeholderBox = await placeholder.boundingBox()
    expect(targetBox, 'target parent should be measurable').not.toBeNull()
    expect(nestZoneBox, 'right-side child zone should be measurable').not.toBeNull()
    expect(placeholderBox, 'nested preview should be measurable').not.toBeNull()
    if (!targetBox || !nestZoneBox || !placeholderBox) throw new Error('target, child zone or preview has no bounding box')
    expect(nestZoneBox.x).toBeGreaterThan(targetBox.x + targetBox.width * 0.6)
    expect(placeholderBox.y).toBeGreaterThanOrEqual(targetBox.y + targetBox.height - 1)
    const placeholderRow = placeholder.locator(`[data-nest-preview-row="${activeId}"]`).first().locator('div').first()
    await expect(placeholderRow).toHaveCSS('padding-left', '32px')
    await expect(placeholder).toHaveCSS('opacity', '0.4')
    const guide = placeholder.locator('[data-nest-preview-guide]')
    await expect(guide).toBeVisible()
    expect(await guide.boundingBox(), 'indent guide should be measurable').not.toBeNull()
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
  const targetBox = await page.locator('[data-nest-target="1"]').boundingBox()
  expect(targetBox, 'parent nest target should have a non-zero hit box').not.toBeNull()
  if (!targetBox) throw new Error('nest target has no bounding box')

  const relationRequest = page.waitForRequest((req) =>
    req.method() === 'PUT' && req.url().endsWith('/api/v1/tasks/1/relations')
  )
  await dragHandleTo(page, source, {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + targetBox.height / 2,
  }, page.locator('[data-task-id="2"]'), 1)
  await relationRequest

  await expect.poll(async () => {
    const response = await request.get('/api/v1/test-state')
    const state = await response.json() as {
      parents: Record<string, number>
      tasks: Array<{ id: number; done: boolean }>
    }
    expect(state.tasks.find((task) => task.id === 2)?.done).toBe(false)
    return state.parents['2']
  }).toBe(1)

  await page.reload()
  const movedTask = page.locator('[data-task-id="2"]')
  await expect(movedTask).toBeVisible()
  await expect(movedTask).toHaveAttribute('style', /padding-left:\s*16px/)
  await expect(movedTask).toHaveAttribute('data-sortable-id', /1::2/)
})

test('a long vertical drag onto a parent stays attached to the pointer and persists nesting', async ({ page, request }) => {
  const seeded = await request.post('/api/v1/test-seed-long-list')
  expect(seeded.status()).toBe(201)
  await page.setViewportSize({ width: 1280, height: 2200 })
  await page.goto('/')
  const sourceTask = page.locator('[data-task-id="3019"]')
  const source = sourceTask.locator('[data-drag-handle]')
  const targetBox = await page.locator('[data-nest-target="1"]').boundingBox()
  expect(targetBox).not.toBeNull()
  if (!targetBox) throw new Error('parent nest target has no bounding box')

  const relationRequest = page.waitForRequest((req) =>
    req.method() === 'PUT' && req.url().endsWith('/api/v1/tasks/1/relations')
  )
  await dragHandleTo(page, source, {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + targetBox.height / 2,
  }, sourceTask, 1)
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
    const targetBox = await page.locator('[data-nest-target="1"]').boundingBox()
    const initialTargetRowBox = await page.locator('[data-task-id="1"]').boundingBox()
    expect(targetBox, 'right-side child zone should be measurable on mobile').not.toBeNull()
    if (!sourceBox || !targetBox || !initialTargetRowBox) throw new Error('source, target row or child zone has no bounding box')
    expect(targetBox.x).toBeGreaterThan(initialTargetRowBox.x + initialTargetRowBox.width * 0.6)

    const source = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 }
    const target = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 }
    const touch = (x: number, y: number) => ({ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 })

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(source.x, source.y)] })
    await page.waitForTimeout(20) // Typical user movement arrives before the old long-press delay.
    const activationPoint = { x: source.x + 12, y: source.y + 3 }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(activationPoint.x, activationPoint.y)] })
    await page.waitForTimeout(100)
    const activeRow = page.locator('[data-task-id="2"] > div').nth(1)
    const preview = page.locator('[data-drag-preview]')
    await expect(activeRow).toHaveCSS('opacity', '0.5')
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
      const hasNestDestination = await page.locator('[data-nest-placeholder]').count() > 0
      await expect(activeRow).toHaveCSS('opacity', hasNestDestination ? '0' : '0.5')
    }

    const nestingPlaceholder = page.locator('[data-nest-placeholder="1"]')
    await expect(nestingPlaceholder).toBeVisible()
    const targetRow = page.locator('[data-task-id="1"]')
    await expect(targetRow).toHaveAttribute('data-nest-preview-target', 'true')
    const targetRowBox = await targetRow.boundingBox()
    const placeholderBox = await nestingPlaceholder.boundingBox()
    expect(placeholderBox, 'touch nesting preview should be measurable').not.toBeNull()
    if (!placeholderBox || !targetRowBox) throw new Error('touch nesting preview or target has no bounding box')
    expect(placeholderBox.y).toBeGreaterThanOrEqual(targetRowBox.y + targetRowBox.height - 1)
    await expect(nestingPlaceholder.locator('[data-nest-preview-row="2"]').first().locator('div').first()).toHaveCSS('padding-left', '32px')
    await expect(nestingPlaceholder).toHaveCSS('opacity', '0.4')
    await expect(nestingPlaceholder.locator('[data-nest-preview-guide]')).toBeVisible()
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
  const targetRow = page.locator('[data-task-id="2"]')
  await expect(source).toBeVisible()
  const targetBox = await targetRow.boundingBox()
  expect(targetBox).not.toBeNull()
  if (!targetBox) throw new Error('target row has no bounding box')

  const updateResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && response.url().endsWith('/api/v1/tasks/1')
  )
  await dragHandleTo(page, source, {
    x: targetBox.x + targetBox.width * 0.5,
    y: targetBox.y + targetBox.height * 0.9,
  }, page.locator('[data-task-id="1"]'))
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
  const targetRow = page.locator('[data-task-id="5"]')
  await expect(source).toBeVisible()
  const targetBox = await targetRow.boundingBox()
  expect(targetBox).not.toBeNull()
  if (!targetBox) throw new Error('target row has no bounding box')

  const updateResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && response.url().endsWith('/api/v1/tasks/1')
  )
  await dragHandleTo(page, source, {
    x: targetBox.x + targetBox.width * 0.5,
    y: targetBox.y + targetBox.height * 0.9,
  }, page.locator('[data-task-id="1"]'))
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
    x: targetBox.x + targetBox.width * 0.5,
    y: targetBox.y + 2,
  }, page.locator('[data-task-id="5"]'))
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

test('the composer exposes the same right-side child zones while being placed', async ({ page }) => {
  const writes: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`)
  })
  await page.goto('/')
  await page.locator('[data-composer-toggle]').click()
  const composer = page.locator('[data-task-composer]')
  const handle = composer.locator('[data-drag-handle]')
  const handleBox = await handle.boundingBox()
  const childZone = page.locator('[data-nest-target="1"]')
  const childZoneBox = await childZone.boundingBox()
  expect(handleBox).not.toBeNull()
  expect(childZoneBox).not.toBeNull()
  if (!handleBox || !childZoneBox) throw new Error('composer handle or child zone has no bounding box')

  const start = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 12, start.y + 3, { steps: 3 })
  await page.mouse.move(childZoneBox.x + childZoneBox.width / 2, childZoneBox.y + childZoneBox.height / 2, { steps: 12 })
  await expect(page.locator('[data-task-id="1"]')).toHaveAttribute('data-nest-preview-target', 'true')
  await expect(childZone).toContainText('Child')
  await expect(page.locator('[data-root-drop-target]')).not.toBeVisible()

  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(composer).toBeVisible()
  expect(writes).toEqual([])
})

test('hovering the left-side top-level lane clearly previews root promotion', async ({ page, request }) => {
  await page.goto('/')
  const handle = page.locator('[data-task-id="11"] [data-drag-handle]')
  const zone = page.locator('[data-root-drop-target]')
  const handleBox = await handle.boundingBox()
  const zoneBox = await zone.boundingBox()
  const childZoneBox = await page.locator('[data-nest-target="1"]').boundingBox()
  expect(handleBox, 'subtask handle should be measurable').not.toBeNull()
  expect(zoneBox, 'top-level lane should have measurable geometry').not.toBeNull()
  expect(childZoneBox, 'child zone should have measurable geometry').not.toBeNull()
  if (!handleBox || !zoneBox || !childZoneBox) throw new Error('source or level drop zone has no bounding box')
  expect(zoneBox.x + zoneBox.width).toBeLessThan(childZoneBox.x + childZoneBox.width / 2)

  const start = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 12, start.y + 3, { steps: 3 })
  await expect(zone).toBeVisible()
  await page.mouse.move(zoneBox.x + zoneBox.width / 2, zoneBox.y + zoneBox.height / 2, { steps: 12 })
  await expect(zone).toHaveAttribute('data-root-drop-active', 'true')
  await expect(zone).toHaveCSS('border-right-style', 'solid')

  const relationRemoval = page.waitForRequest((req) =>
    req.method() === 'DELETE' && req.url().endsWith('/api/v1/tasks/1/relations/subtask/11')
  )
  await page.mouse.up()
  await relationRemoval
  await expect.poll(async () => {
    const response = await request.get('/api/v1/test-state')
    const state = await response.json() as { parents: Record<string, number> }
    return state.parents['11']
  }).toBeUndefined()
})
