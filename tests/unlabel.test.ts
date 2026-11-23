import assert from 'node:assert/strict'
import test from 'node:test'
import type { VikunjaTask } from '../src/types/vikunja.ts'
import type { TaskTreeNode } from '../src/utils/taskTree.ts'
import { buildTree } from '../src/utils/taskTree.ts'
import { positionToDueDate } from '../src/utils/ordering.ts'
import {
  applyUnassign,
  countDescendants,
  planUnassign,
  resolveUnassignTargets,
  type UnassignApi,
  type UnassignPlan,
} from '../src/utils/unlabel.ts'

const JACOB = { id: 1, username: 'jacob', name: 'Jacob' }
const orderDate = positionToDueDate

function makeNode(
  id: number,
  title: string,
  options: {
    assignees?: VikunjaTask['assignees']
    due?: string | null
    children?: TaskTreeNode[]
    depth?: number
    related_tasks?: VikunjaTask['related_tasks']
    parentContext?: string
  } = {}
): TaskTreeNode {
  return {
    id,
    title,
    description: '',
    done: false,
    done_at: null,
    due_date: options.due ?? null,
    project_id: 1,
    labels: [],
    assignees: options.assignees ?? [],
    created: orderDate(0),
    updated: orderDate(0),
    related_tasks: options.related_tasks,
    children: options.children ?? [],
    depth: options.depth ?? 0,
    parentContext: options.parentContext,
  }
}

/** Nested fixture: 1 (assigned) -> 2 (unassigned) -> 3 (assigned), plus leaf 4. */
function makeTree(): TaskTreeNode {
  return makeNode(1, 'R', {
    assignees: [JACOB],
    due: orderDate(10),
    children: [
      makeNode(2, 'C', {
        due: orderDate(20),
        depth: 1,
        children: [
          makeNode(3, 'G', { assignees: [JACOB], due: orderDate(30), depth: 2 }),
        ],
      }),
      makeNode(4, 'Leaf', { depth: 1 }),
    ],
  })
}

interface MockState {
  assignees: number[]
  due: string | null
}

function makeApi(
  entries: Array<[number, MockState]>,
  failOn: string[] = []
) {
  const state = new Map<number, MockState>(entries.map(([id, value]) => [id, { ...value }]))
  const calls: string[] = []
  let refreshes = 0
  const api: UnassignApi = {
    async unassignUser(taskId, userId) {
      calls.push(`assign-${taskId}:${userId}`)
      if (failOn.includes(`assign-${taskId}`)) throw new Error('fixture assignee failure')
      const task = state.get(taskId)
      if (task) task.assignees = task.assignees.filter((id) => id !== userId)
    },
    async setDueDate(taskId, dueDate) {
      calls.push(`due:${taskId}:${dueDate}`)
      if (failOn.includes(`due:${taskId}`)) throw new Error('fixture ordering failure')
      const task = state.get(taskId)
      if (task) task.due = dueDate
    },
    async refresh() {
      refreshes++
      calls.push('refresh')
      if (failOn.includes('refresh')) throw new Error('fixture refresh failure')
    },
  }
  return {
    api,
    calls,
    state,
    get refreshes() { return refreshes },
  }
}

function planFor(node: TaskTreeNode, scope: 'task' | 'subtree'): UnassignPlan {
  const plan = planUnassign({ type: 'confirm', scope }, node, JACOB.id)
  assert.ok(plan, 'a confirmed decision must produce a plan')
  return plan
}

test('countDescendants counts recursive descendants and leaves report zero', () => {
  assert.equal(countDescendants(makeTree()), 3)
  assert.equal(countDescendants(makeNode(9, 'Leaf')), 0)
})

test('resolveUnassignTargets: task scope is one task, subtree scope is the whole nested subtree', () => {
  const tree = makeTree()
  assert.deepEqual(resolveUnassignTargets(tree, 'task').map((t) => t.id), [1])
  assert.deepEqual(resolveUnassignTargets(tree, 'subtree').map((t) => t.id), [1, 2, 3, 4])
})

test('a cancelled dialog yields no plan, so the flow issues no writes', () => {
  const tree = makeTree()
  assert.equal(planUnassign({ type: 'cancel' }, tree, JACOB.id), null)
})

test('leaf task: unassigns the user and clears its ordering date only', async () => {
  const leaf = makeNode(9, 'Leaf', { assignees: [JACOB], due: orderDate(5) })
  const mock = makeApi([
    [9, { assignees: [JACOB.id], due: orderDate(5) }],
    [10, { assignees: [JACOB.id], due: orderDate(6) }],
  ])
  await applyUnassign(planFor(leaf, 'task'), mock.api)
  assert.deepEqual(mock.calls, ['assign-9:1', 'due:9:null', 'refresh'])
  assert.deepEqual(mock.state.get(9), { assignees: [], due: null })
  assert.deepEqual(mock.state.get(10), { assignees: [JACOB.id], due: orderDate(6) })
  assert.equal(mock.refreshes, 1)
})

test('task-only scope unassigns one task and leaves descendant assignee/order data unchanged', async () => {
  const tree = makeTree()
  const mock = makeApi([
    [1, { assignees: [JACOB.id], due: orderDate(10) }],
    [2, { assignees: [], due: orderDate(20) }],
    [3, { assignees: [JACOB.id], due: orderDate(30) }],
    [4, { assignees: [], due: null }],
  ])
  await applyUnassign(planFor(tree, 'task'), mock.api)
  assert.deepEqual(mock.calls, ['assign-1:1', 'due:1:null', 'refresh'])
  assert.deepEqual(mock.state.get(1), { assignees: [], due: null })
  assert.deepEqual(mock.state.get(2), { assignees: [], due: orderDate(20) })
  assert.deepEqual(mock.state.get(3), { assignees: [JACOB.id], due: orderDate(30) })
  assert.deepEqual(mock.state.get(4), { assignees: [], due: null })
})

test('subtree scope unassigns assigned descendants and clears ordering metadata throughout', async () => {
  const tree = makeTree()
  const mock = makeApi([
    [1, { assignees: [JACOB.id], due: orderDate(10) }],
    [2, { assignees: [], due: orderDate(20) }],
    [3, { assignees: [JACOB.id], due: orderDate(30) }],
    [4, { assignees: [], due: null }],
  ])
  await applyUnassign(planFor(tree, 'subtree'), mock.api)
  assert.deepEqual(
    [...mock.calls].sort(),
    ['due:1:null', 'due:2:null', 'due:3:null', 'assign-1:1', 'assign-3:1', 'refresh'].sort()
  )
  assert.equal(mock.calls[mock.calls.length - 1], 'refresh')
  assert.ok(!mock.calls.some((call) => call.includes(':4')))
  assert.deepEqual(mock.state.get(1), { assignees: [], due: null })
  assert.deepEqual(mock.state.get(2), { assignees: [], due: null })
  assert.deepEqual(mock.state.get(3), { assignees: [], due: null })
  assert.deepEqual(mock.state.get(4), { assignees: [], due: null })
  assert.equal(mock.state.size, 4)
})

test('an independently assigned descendant survives task-only scope but is unassigned in subtree scope', async () => {
  const tree = makeTree()
  const taskOnly = makeApi([
    [1, { assignees: [JACOB.id], due: orderDate(10) }],
    [3, { assignees: [JACOB.id], due: orderDate(30) }],
  ])
  await applyUnassign(planFor(tree, 'task'), taskOnly.api)
  assert.deepEqual(taskOnly.state.get(3), { assignees: [JACOB.id], due: orderDate(30) })

  const subtree = makeApi([
    [1, { assignees: [JACOB.id], due: orderDate(10) }],
    [3, { assignees: [JACOB.id], due: orderDate(30) }],
  ])
  await applyUnassign(planFor(tree, 'subtree'), subtree.api)
  assert.deepEqual(subtree.state.get(3), { assignees: [], due: null })
})

test('partial failure reports every failed write, still attempts the rest, and refreshes server state', async () => {
  const tree = makeTree()
  const mock = makeApi(
    [
      [1, { assignees: [JACOB.id], due: orderDate(10) }],
      [2, { assignees: [], due: orderDate(20) }],
      [3, { assignees: [JACOB.id], due: orderDate(30) }],
    ],
    ['assign-1', 'due:3']
  )
  await assert.rejects(
    () => applyUnassign(planFor(tree, 'subtree'), mock.api),
    (error: Error) => {
      assert.match(error.message, /R \(assignee: fixture assignee failure\)/)
      assert.match(error.message, /G \(ordering date: fixture ordering failure\)/)
      assert.match(error.message, /refreshed to show the server state/)
      return true
    }
  )
  assert.ok(mock.calls.includes('due:1:null'))
  assert.ok(mock.calls.includes('due:2:null'))
  assert.ok(mock.calls.includes('assign-3:1'))
  assert.equal(mock.refreshes, 1)
  assert.equal(mock.calls[mock.calls.length - 1], 'refresh')
})

test('a failed refresh is reported instead of claiming success', async () => {
  const leaf = makeNode(9, 'Leaf', { assignees: [JACOB], due: orderDate(5) })
  const mock = makeApi([[9, { assignees: [JACOB.id], due: orderDate(5) }]], ['refresh'])
  await assert.rejects(
    () => applyUnassign(planFor(leaf, 'task'), mock.api),
    /refresh failed/
  )
})

// View semantics after the operation: what the Honey-Do tree shows once the
// server (refetch) reflects the assignee/order removal.

function flatTask(
  id: number,
  title: string,
  position: number,
  options: {
    assignees?: VikunjaTask['assignees']
    related_tasks?: VikunjaTask['related_tasks']
  } = {}
): VikunjaTask {
  return {
    id,
    title,
    description: '',
    done: false,
    done_at: null,
    due_date: orderDate(position),
    project_id: 1,
    labels: [],
    assignees: options.assignees ?? [],
    created: orderDate(0),
    updated: orderDate(0),
    related_tasks: options.related_tasks,
  }
}

test('unassigned descendants stay visible under an assigned ancestor but leave the view with it', () => {
  const before = [
    flatTask(1, 'Parent', 10, {
      assignees: [JACOB],
      related_tasks: { subtask: [{ id: 2, title: 'Unassigned child' }, { id: 3, title: 'Assigned child' }] },
    }),
    flatTask(2, 'Unassigned child', 20, {
      related_tasks: { parenttask: [{ id: 1, title: 'Parent' }] },
    }),
    flatTask(3, 'Assigned child', 30, {
      assignees: [JACOB],
      related_tasks: { parenttask: [{ id: 1, title: 'Parent' }] },
    }),
  ]
  const tree = buildTree(before, 1)
  assert.equal(tree.length, 1)
  assert.equal(tree[0].id, 1)
  assert.deepEqual(tree[0].children.map((child) => child.id), [2, 3])

  // After "This task only" on Parent plus refetch: the unassigned child is no
  // longer reachable from any assigned task and disappears; the independently
  // assigned child remains as a contextual root with its parent hint.
  const after = [
    flatTask(1, 'Parent', 10),
    flatTask(2, 'Unassigned child', 20),
    flatTask(3, 'Assigned child', 30, {
      assignees: [JACOB],
      related_tasks: { parenttask: [{ id: 1, title: 'Parent' }] },
    }),
  ]
  const afterTree = buildTree(after, 1)
  assert.deepEqual(afterTree.map((node) => node.id), [3])
  assert.equal(afterTree[0].parentContext, 'Subtask of: Parent')
  assert.deepEqual(afterTree[0].children, [])
})
