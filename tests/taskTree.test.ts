import assert from 'node:assert/strict'
import test from 'node:test'
import type { VikunjaTask } from '../src/types/vikunja.ts'
import { buildTree } from '../src/utils/taskTree.ts'

const orderDate = (minutes: number) => new Date(Date.UTC(2000, 0, 1, 0, minutes)).toISOString()

function makeTask(
  id: number,
  title: string,
  position: number,
  related_tasks: VikunjaTask['related_tasks'] = {},
  root = false
): VikunjaTask {
  return {
    id,
    title,
    description: '',
    done: false,
    done_at: null,
    due_date: orderDate(position),
    project_id: 1,
    labels: root ? [{ id: 1, title: 'Honey-Do' }] : [],
    created: orderDate(0),
    updated: orderDate(0),
    related_tasks,
  }
}

test('buildTree uses persisted due_date positions for root and child sibling order', () => {
  const relationOrder = [
    { id: 11, title: 'Child A' },
    { id: 12, title: 'Child B' },
    { id: 13, title: 'Child C' },
  ]
  const flat = [
    makeTask(1, 'Parent', 20, { subtask: relationOrder }, true),
    makeTask(2, 'Root B', 30, {}, true),
    makeTask(3, 'Root A', 10, {}, true),
    makeTask(11, 'Child A', 40, { parenttask: [{ id: 1, title: 'Parent' }] }),
    makeTask(12, 'Child B', 20, { parenttask: [{ id: 1, title: 'Parent' }] }),
    makeTask(13, 'Child C', 30, { parenttask: [{ id: 1, title: 'Parent' }] }),
  ]

  const tree = buildTree(flat, 'Honey-Do')

  assert.deepEqual(tree.map((root) => root.id), [3, 1, 2])
  assert.deepEqual(tree[1].children.map((child) => child.id), [12, 13, 11])
  assert.deepEqual(flat[0].related_tasks?.subtask?.map((child) => child.id), [11, 12, 13])
  assert.deepEqual(flat.slice(3).map((child) => child.related_tasks?.parenttask?.[0].id), [1, 1, 1])
})

test('a stale parent subtask reference cannot render one child under two parents', () => {
  const child = makeTask(40, 'Single-parent child', 30, {
    parenttask: [{ id: 2, title: 'Actual parent' }],
  })
  const flat = [
    makeTask(1, 'Stale parent', 10, { subtask: [{ id: 40, title: child.title }] }, true),
    makeTask(2, 'Actual parent', 20, { subtask: [{ id: 40, title: child.title }] }, true),
    child,
  ]

  const tree = buildTree(flat, 'Honey-Do')

  assert.deepEqual(tree[0].children, [])
  assert.deepEqual(tree[1].children.map((node) => node.id), [40])
})

test('labeled child of an unlabeled task outside the Honey-Do tree is shown with parent context', () => {
  const flat = [
    makeTask(20, 'Hidden parent', 10, { subtask: [{ id: 21, title: 'Prioritized child' }] }),
    makeTask(21, 'Prioritized child', 20, { parenttask: [{ id: 20, title: 'Hidden parent' }] }, true),
  ]

  const tree = buildTree(flat, 'Honey-Do')

  assert.deepEqual(tree.map((node) => node.id), [21])
  assert.equal(tree[0].parentContext, 'Subtask of: Hidden parent')
  assert.deepEqual(tree[0].children, [])
})

test('labeled child with an omitted parent remains visible with the relation title as context', () => {
  const child = makeTask(31, 'Visible child', 10, {
    parenttask: [{ id: 30, title: 'Parent not fetched' }],
  }, true)

  const tree = buildTree([child], 'Honey-Do')

  assert.equal(tree.length, 1)
  assert.equal(tree[0].parentContext, 'Subtask of: Parent not fetched')
})
