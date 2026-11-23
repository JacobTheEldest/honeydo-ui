import assert from 'node:assert/strict'
import test from 'node:test'
import type { ParentChangeApi } from '../src/utils/hierarchyMutations.ts'
import type { VikunjaUser, VikunjaTask } from '../src/types/vikunja.ts'
import {
  applyParentChange,
  applyParentChangeToTasks,
  canNestUnder,
  canPromoteToRoot,
  isSelfOrDescendant,
  reorderAtDropEdge,
} from '../src/utils/hierarchyMutations.ts'
import type { TaskTreeNode } from '../src/utils/taskTree.ts'

const JACOB: VikunjaUser = { id: 1, username: 'jacob', name: 'Jacob' }

function makeApi(initialParents: Array<[number, number]> = []) {
  const parents = new Map(initialParents)
  const dueDates = new Map<number, string | null>([[2, 'old-date']])
  const assignees = new Map<number, Set<number>>()
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
    async assignUser(taskId, userId) {
      calls.push(`assign+:${taskId}:${userId}`)
      const taskAssignees = assignees.get(taskId) ?? new Set<number>()
      taskAssignees.add(userId)
      assignees.set(taskId, taskAssignees)
    },
    async unassignUser(taskId, userId) {
      calls.push(`assign-:${taskId}:${userId}`)
      assignees.get(taskId)?.delete(userId)
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
    assignees,
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
  assignees: [JACOB],
  labels: [],
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
    assignees: [],
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
      assignees: [],
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

test('root promotion removes parent, assigns user, and persists root order', async () => {
  const task = { id: 2, related_tasks: { parenttask: [{ id: 1, title: 'Parent' }] } }
  const parent = { id: 1, assignees: [JACOB] }
  assert.equal(canPromoteToRoot(task, parent, JACOB.id), true)

  const mock = makeApi([[2, 1]])
  await applyParentChange(change({
    oldParentId: 1,
    oldParentIds: [1],
    newParentId: null,
    newDueDate: 'root-top',
    assigneeIdToAdd: JACOB.id,
  }), mock.api)
  assert.equal(mock.parents.has(2), false)
  assert.ok(mock.assignees.get(2)?.has(JACOB.id))
  assert.equal(mock.dueDates.get(2), 'root-top')
})

test('root promotion under an unassigned or unknown parent is rejected before API writes', () => {
  const task = { related_tasks: { parenttask: [{ id: 1, title: 'Hidden parent' }] } }
  const parent = { id: 1, assignees: [] }
  assert.equal(canPromoteToRoot(task, parent, JACOB.id), false)
  assert.equal(canPromoteToRoot(task, undefined, JACOB.id), false)
  assert.equal(canPromoteToRoot({
    related_tasks: { parenttask: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }] } as any,
  }, { id: 1, assignees: [JACOB] } as any, JACOB.id), false)
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

test('nesting eligibility rejects self, descendants, and the existing direct parent', () => {
  const child = {
    ...tree.children[0],
    related_tasks: { parenttask: [{ id: 1, title: 'A' }] },
  }
  assert.equal(canNestUnder(child, 2), false)
  assert.equal(canNestUnder(child, 3), false)
  assert.equal(canNestUnder(child, 1), false)
  assert.equal(canNestUnder(child, 4), true)
})

test('local parent updates immediately reparent roots and promotions', () => {
  const tasks = [
    { ...tree, related_tasks: { subtask: [{ id: 2, title: 'B' }] } },
    { ...tree.children[0], related_tasks: { parenttask: [{ id: 1, title: 'A' }] } },
    { ...tree, id: 4, title: 'D', assignees: [], related_tasks: { subtask: [] } },
  ]
  const nested = applyParentChangeToTasks(tasks, change({
    taskId: 4,
    oldParentId: null,
    oldParentIds: [],
    newParentId: 1,
    oldDueDate: null,
    newDueDate: 'nested-position',
  })) as VikunjaTask[]
  assert.deepEqual(nested.find((task) => task.id === 4)?.related_tasks?.parenttask, [{ id: 1, title: 'A' }])
  assert.equal(nested.find((task) => task.id === 1)?.related_tasks?.subtask?.some((child) => child.id === 4), true)
  assert.equal(nested.find((task) => task.id === 4)?.due_date, 'nested-position')

  const promoted = applyParentChangeToTasks(nested, change({
    taskId: 2,
    oldParentId: 1,
    oldParentIds: [1],
    newParentId: null,
    oldDueDate: null,
    newDueDate: 'root-position',
    assigneeIdToAdd: JACOB.id,
  }), JACOB) as VikunjaTask[]
  assert.deepEqual(promoted.find((task) => task.id === 2)?.related_tasks?.parenttask, [])
  assert.equal(promoted.find((task) => task.id === 1)?.related_tasks?.subtask?.some((child) => child.id === 2), false)
  assert.ok(promoted.find((task) => task.id === 2)?.assignees?.some((a) => a.id === JACOB.id))
  assert.equal(promoted.find((task) => task.id === 2)?.due_date, 'root-position')
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
