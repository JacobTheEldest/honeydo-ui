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
