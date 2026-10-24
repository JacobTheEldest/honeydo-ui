import assert from 'node:assert/strict'
import test from 'node:test'
import { getSequentialPosition, positionToDueDate, dueDateToPosition } from '../src/utils/ordering.ts'
import { buildTree } from '../src/utils/taskTree.ts'
import type { VikunjaTask } from '../src/types/vikunja.ts'

function task(id: number, title: string, position: number, parentId?: number): VikunjaTask {
  return {
    id,
    title,
    description: '',
    done: false,
    done_at: null,
    due_date: positionToDueDate(position),
    project_id: 1,
    labels: parentId === undefined ? [{ id: 1, title: 'Honey-Do' }] : [],
    created: '',
    updated: '',
    priority: 0,
    ...(parentId === undefined ? {} : { related_tasks: { parenttask: [{ id: parentId, title: 'Parent' }] } }),
  }
}

test('sequential composer positions bisect existing adjacent siblings without ties', () => {
  const roots = [-4, -3, -2]
  let created = getSequentialPosition(-5, roots)
  assert.equal(created, -4.5)
  created = getSequentialPosition(created, [...roots, created])
  assert.equal(created, -4.25)
  assert.notEqual(positionToDueDate(created), positionToDueDate(-4))

  const children = [0, 1, 2]
  created = getSequentialPosition(-1, children)
  assert.equal(created, -0.5)
  created = getSequentialPosition(created, [...children, created])
  assert.equal(created, -0.25)
  assert.notEqual(positionToDueDate(created), positionToDueDate(0))
})

test('persisted tree order honors sequential insertions ahead of existing siblings', () => {
  const parent = task(1, 'Parent', 0)
  const first = task(2, 'First created', -0.5, 1)
  const second = task(3, 'Second created', -0.25, 1)
  const existing = task(4, 'Existing', 0, 1)
  const forest = buildTree([parent, existing, second, first], 'Honey-Do')
  assert.deepEqual(forest[0].children.map((child) => child.title), ['First created', 'Second created', 'Existing'])
  assert.equal(dueDateToPosition(forest[0].children[1].due_date), -0.25)
})
