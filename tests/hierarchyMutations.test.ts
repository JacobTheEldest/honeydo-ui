import assert from 'node:assert/strict'
import test from 'node:test'
import type { ParentChangeApi } from '../src/utils/hierarchyMutations.ts'
import {
  applyParentChange,
  canPromoteToRoot,
  isSelfOrDescendant,
  reorderAtDropEdge,
} from '../src/utils/hierarchyMutations.ts'
import type { TaskTreeNode } from '../src/utils/taskTree.ts'

function makeApi(initialParents: Array<[number, number]> = []) {
  const parents = new Map(initialParents)
  const dueDates = new Map<number, string | null>([[2, 'old-date']])
  const labels = new Map<number, Set<number>>()
  const calls: string[] = []
  let failAddParent: number | null = null
  let refreshes = 0

  const api: ParentChangeApi = {
    async removeRelation(parentId, childId) {
      calls.push(`remove:${parentId}:${childId}`)
      if (parents.get(childId) !== parentId) throw new Error('relation not found')
      parents.delete(childId)
    },
    async addRelation(parentId, childId) {
      calls.push(`add:${parentId}:${childId}`)
      if (failAddParent === parentId) throw new Error('permission denied')
      parents.set(childId, parentId)
    },
    async setDueDate(taskId, dueDate) {
      calls.push(`due:${taskId}:${dueDate}`)
      dueDates.set(taskId, dueDate)
    },
    async addLabel(taskId, labelId) {
      calls.push(`label+:${taskId}:${labelId}`)
      const taskLabels = labels.get(taskId) ?? new Set<number>()
      taskLabels.add(labelId)
      labels.set(taskId, taskLabels)
    },
    async removeLabel(taskId, labelId) {
      calls.push(`label-:${taskId}:${labelId}`)
      labels.get(taskId)?.delete(labelId)
    },
    async refresh() {
      refreshes++
      calls.push('refresh')
    },
  }

  return {
    api,
    calls,
    parents,
    dueDates,
    labels,
    get refreshes() { return refreshes },
    failAdd(parentId: number) { failAddParent = parentId },
  }
}

const tree: TaskTreeNode = {
  id: 1,
  title: 'A',
  description: '',
  done: false,
  done_at: null,
  due_date: null,
  project_id: 1,
  labels: [{ id: 1, title: 'Honey-Do' }],
  created: '',
  updated: '',
  children: [{
    id: 2,
    title: 'B',
    description: '',
    done: false,
    done_at: null,
    due_date: null,
    project_id: 1,
    labels: [],
    created: '',
    updated: '',
    children: [{
      id: 3,
      title: 'C',
      description: '',
      done: false,
      done_at: null,
      due_date: null,
      project_id: 1,
      labels: [],
      created: '',
      updated: '',
      children: [],
      depth: 2,
    }],
    depth: 1,
  }],
  depth: 0,
}

const change = (overrides: Partial<Parameters<typeof applyParentChange>[0]> = {}) => ({
  taskId: 2,
  oldParentId: null,
  newParentId: 1,
  oldDueDate: 'old-date',
  newDueDate: 'new-date',
  ...overrides,
})

test('sibling insertion edge determines the final position, including adjacent moves', () => {
  assert.deepEqual(reorderAtDropEdge([1, 2, 3], 1, 3, 'after'), [2, 3, 1])
  assert.deepEqual(reorderAtDropEdge([1, 2, 3], 3, 1, 'before'), [3, 1, 2])
  assert.deepEqual(reorderAtDropEdge([1, 2, 3], 1, 2, 'before'), [1, 2, 3])
})

test('root -> child keeps the moved subtree attached and writes its sibling order', async () => {
  const mock = makeApi([[3, 2]])
  await applyParentChange(change(), mock.api)
  assert.equal(mock.parents.get(2), 1)
  assert.equal(mock.parents.get(3), 2)
  assert.equal(mock.dueDates.get(2), 'new-date')
  assert.equal(mock.refreshes, 1)
})

test('child A -> child B replaces the old edge without moving descendants', async () => {
  const mock = makeApi([[2, 1], [4, 2]])
  await applyParentChange(change({ oldParentId: 1, oldParentIds: [1], newParentId: 3 }), mock.api)
  assert.equal(mock.parents.has(2), true)
  assert.equal(mock.parents.get(2), 3)
  assert.equal(mock.parents.get(4), 2)
  assert.deepEqual(mock.calls.slice(0, 2), ['remove:1:2', 'add:3:2'])
})

test('root promotion removes parent, applies Honey-Do label, and persists root order', async () => {
  const task = { id: 2, related_tasks: { parenttask: [{ id: 1, title: 'Parent' }] } }
  const parent = { id: 1, labels: [{ id: 7, title: 'Honey-Do' }] }
  assert.equal(canPromoteToRoot(task, parent, 'Honey-Do'), true)

  const mock = makeApi([[2, 1]])
  await applyParentChange(change({
    oldParentId: 1,
    oldParentIds: [1],
    newParentId: null,
    newDueDate: 'root-top',
    labelIdToAdd: 7,
  }), mock.api)
  assert.equal(mock.parents.has(2), false)
  assert.equal(mock.labels.get(2)?.has(7), true)
  assert.equal(mock.dueDates.get(2), 'root-top')
})

test('root promotion under an unlabeled or unknown parent is rejected before API writes', () => {
  const task = { related_tasks: { parenttask: [{ id: 1, title: 'Hidden parent' }] } }
  const parent = { id: 1, labels: [] }
  assert.equal(canPromoteToRoot(task, parent, 'Honey-Do'), false)
  assert.equal(canPromoteToRoot(task, undefined, 'Honey-Do'), false)
  assert.equal(canPromoteToRoot({
    related_tasks: { parenttask: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }] },
  }, { id: 1, labels: [{ id: 7, title: 'Honey-Do' }] }, 'Honey-Do'), false)
})

test('cross-project relations are accepted by the mutation workflow', async () => {
  const mock = makeApi()
  await applyParentChange(change(), mock.api)
  assert.equal(mock.parents.get(2), 1)
  assert.equal(mock.calls.some((call) => call === 'add:1:2'), true)
})

test('self and descendant targets are detected before a relation write', () => {
  assert.equal(isSelfOrDescendant(tree, 1), true)
  assert.equal(isSelfOrDescendant(tree, 3), true)
  assert.equal(isSelfOrDescendant(tree, 4), false)
})

test('failed new relation restores the old parent and refreshes server state', async () => {
  const mock = makeApi([[2, 1], [4, 2]])
  mock.failAdd(3)
  await assert.rejects(
    applyParentChange(change({ oldParentId: 1, oldParentIds: [1], newParentId: 3 }), mock.api),
    /permission denied.*prior relationship was restored/
  )
  assert.equal(mock.parents.get(2), 1)
  assert.equal(mock.parents.get(4), 2)
  assert.equal(mock.refreshes, 1)
  assert.deepEqual(mock.calls.slice(0, 4), ['remove:1:2', 'add:3:2', 'add:1:2', 'refresh'])
})

test('failed relation removal does not create a second parent', async () => {
  const mock = makeApi([[2, 1]])
  mock.api.removeRelation = async () => { throw new Error('delete denied') }
  await assert.rejects(
    applyParentChange(change({ oldParentId: 1, oldParentIds: [1], newParentId: 3 }), mock.api),
    /delete denied/
  )
  assert.equal(mock.parents.get(2), 1)
  assert.equal(mock.calls.some((call) => call === 'add:3:2'), false)
})
