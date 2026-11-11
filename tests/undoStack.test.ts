import assert from 'node:assert/strict'
import test from 'node:test'
import {
  currentEntry,
  undoStackReducer,
  type UndoEntry,
} from '../src/utils/undoStack.ts'

const entry = (id: number, title: string): UndoEntry => ({ id, title })

test('push records a completion and surfaces it as the current entry', () => {
  const stack = undoStackReducer([], { type: 'push', entry: entry(1, 'Root A') })
  assert.deepEqual(stack, [entry(1, 'Root A')])
  assert.deepEqual(currentEntry(stack), entry(1, 'Root A'))
})

test('undo pops the newest completion and surfaces the previous one', () => {
  let stack = undoStackReducer([], { type: 'push', entry: entry(1, 'Root A') })
  stack = undoStackReducer(stack, { type: 'push', entry: entry(2, 'Root B') })
  assert.deepEqual(currentEntry(stack), entry(2, 'Root B'))

  stack = undoStackReducer(stack, { type: 'remove', id: 2 })
  assert.deepEqual(currentEntry(stack), entry(1, 'Root A'))

  stack = undoStackReducer(stack, { type: 'remove', id: 1 })
  assert.equal(currentEntry(stack), null)
  assert.deepEqual(stack, [])
})

test('remove drops any entry and keeps the rest in order', () => {
  let stack = undoStackReducer([], { type: 'push', entry: entry(1, 'Root A') })
  stack = undoStackReducer(stack, { type: 'push', entry: entry(2, 'Root B') })
  stack = undoStackReducer(stack, { type: 'push', entry: entry(5, 'Root C') })

  stack = undoStackReducer(stack, { type: 'remove', id: 2 })
  assert.deepEqual(stack, [entry(1, 'Root A'), entry(5, 'Root C')])
  assert.deepEqual(currentEntry(stack), entry(5, 'Root C'))
})

test('re-completing a task moves its entry to the top', () => {
  let stack = undoStackReducer([], { type: 'push', entry: entry(1, 'Root A') })
  stack = undoStackReducer(stack, { type: 'push', entry: entry(2, 'Root B') })
  stack = undoStackReducer(stack, { type: 'remove', id: 1 })
  stack = undoStackReducer(stack, { type: 'push', entry: entry(1, 'Root A') })

  assert.deepEqual(stack, [entry(2, 'Root B'), entry(1, 'Root A')])
  assert.deepEqual(currentEntry(stack), entry(1, 'Root A'))
})

test('pushing a completed id twice never duplicates the entry', () => {
  let stack = undoStackReducer([], { type: 'push', entry: entry(1, 'Root A') })
  stack = undoStackReducer(stack, { type: 'push', entry: entry(1, 'Root A') })
  assert.deepEqual(stack, [entry(1, 'Root A')])
})

test('clear empties the stack', () => {
  let stack = undoStackReducer([], { type: 'push', entry: entry(1, 'Root A') })
  stack = undoStackReducer(stack, { type: 'push', entry: entry(2, 'Root B') })
  stack = undoStackReducer(stack, { type: 'clear' })
  assert.deepEqual(stack, [])
  assert.equal(currentEntry(stack), null)
})
