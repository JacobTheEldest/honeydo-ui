import assert from 'node:assert/strict'
import test from 'node:test'
import { createTaskMutationQueue } from '../src/utils/taskMutationQueue.ts'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

test('serializes mutations for the same task in issue order', async () => {
  const queue = createTaskMutationQueue()
  const order: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })

  const first = queue.enqueue(1, async () => {
    order.push('first:start')
    await firstGate
    order.push('first:end')
  })
  const second = queue.enqueue(1, async () => {
    order.push('second')
  })

  await tick()
  assert.deepEqual(order, ['first:start'], 'the second mutation must wait for the first')

  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(order, ['first:start', 'first:end', 'second'])
})

test('a complete-then-undo on one task settles in issue order', async () => {
  // Vikunja's task write replaces the resource, so if these two landed out of
  // order the task would end up done. The queue must keep user order.
  const queue = createTaskMutationQueue()
  const serverDoneHistory: boolean[] = []
  let releaseComplete!: () => void
  const completeGate = new Promise<void>((resolve) => {
    releaseComplete = resolve
  })

  const complete = queue.enqueue(1, async () => {
    await completeGate
    serverDoneHistory.push(true)
  })
  const undo = queue.enqueue(1, async () => {
    serverDoneHistory.push(false)
  })

  releaseComplete()
  await Promise.all([complete, undo])
  assert.deepEqual(serverDoneHistory, [true, false])
})

test('runs mutations for different tasks independently', async () => {
  const queue = createTaskMutationQueue()
  const order: string[] = []
  let releaseBlocked!: () => void
  const blockedGate = new Promise<void>((resolve) => {
    releaseBlocked = resolve
  })

  const blocked = queue.enqueue(1, async () => {
    order.push('task-one')
    await blockedGate
  })
  const independent = queue.enqueue(2, async () => {
    order.push('task-two')
  })

  await independent
  assert.deepEqual(order, ['task-one', 'task-two'])
  releaseBlocked()
  await blocked
})

test('a rejected mutation never blocks the ones queued behind it', async () => {
  const queue = createTaskMutationQueue()
  const order: string[] = []

  const failing = queue.enqueue(1, async () => {
    order.push('fail')
    throw new Error('boom')
  })
  const next = queue.enqueue(1, async () => {
    order.push('next')
  })

  await assert.rejects(failing, /boom/)
  await next
  assert.deepEqual(order, ['fail', 'next'])
})
