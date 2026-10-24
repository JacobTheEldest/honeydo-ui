import assert from 'node:assert/strict'
import test from 'node:test'
import type { VikunjaTask } from '../src/types/vikunja.ts'
import type { TaskTreeNode } from '../src/utils/taskTree.ts'
import { buildTree } from '../src/utils/taskTree.ts'
import {
  applyUnlabel,
  countDescendants,
  planUnlabel,
  resolveUnlabelTargets,
  type UnlabelApi,
  type UnlabelPlan,
} from '../src/utils/unlabel.ts'

const HONEYDO = { id: 7, title: 'Honey-Do' }
const orderDate = (minutes: number) => new Date(Date.UTC(2000, 0, 1, 0, minutes)).toISOString()

function makeNode(
  id: number,
  title: string,
  options: {
    labels?: VikunjaTask['labels']
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
    labels: options.labels ?? [],
    created: orderDate(0),
    updated: orderDate(0),
    related_tasks: options.related_tasks,
    children: options.children ?? [],
    depth: options.depth ?? 0,
    parentContext: options.parentContext,
  }
}

/** Nested fixture: 1 (labeled) -> 2 (unlabeled) -> 3 (labeled), plus leaf 4. */
function makeTree(): TaskTreeNode {
  return makeNode(1, 'R', {
    labels: [HONEYDO],
    due: orderDate(10),
    children: [
      makeNode(2, 'C', {
        due: orderDate(20),
        depth: 1,
        children: [
          makeNode(3, 'G', { labels: [HONEYDO], due: orderDate(30), depth: 2 }),
        ],
      }),
      makeNode(4, 'Leaf', { depth: 1 }),
    ],
  })
}

interface MockState {
  labels: number[]
  due: string | null
}

function makeApi(
  entries: Array<[number, MockState]>,
  failOn: string[] = []
) {
  const state = new Map<number, MockState>(entries.map(([id, value]) => [id, { ...value }]))
  const calls: string[] = []
  let refreshes = 0
  const api: UnlabelApi = {
    async removeLabel(taskId, labelId) {
      calls.push(`label-:${taskId}:${labelId}`)
      if (failOn.includes(`label-:${taskId}`)) throw new Error('fixture label failure')
      const task = state.get(taskId)
      if (task) task.labels = task.labels.filter((id) => id !== labelId)
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

function planFor(node: TaskTreeNode, scope: 'task' | 'subtree'): UnlabelPlan {
  const plan = planUnlabel({ type: 'confirm', scope }, node, HONEYDO.id)
  assert.ok(plan, 'a confirmed decision must produce a plan')
  return plan
}

test('countDescendants counts recursive descendants and leaves report zero', () => {
  assert.equal(countDescendants(makeTree()), 3)
  assert.equal(countDescendants(makeNode(9, 'Leaf')), 0)
})

test('resolveUnlabelTargets: task scope is one task, subtree scope is the whole nested subtree', () => {
  const tree = makeTree()
  assert.deepEqual(resolveUnlabelTargets(tree, 'task').map((t) => t.id), [1])
  assert.deepEqual(resolveUnlabelTargets(tree, 'subtree').map((t) => t.id), [1, 2, 3, 4])
})

test('a cancelled dialog yields no plan, so the flow issues no writes', () => {
  const tree = makeTree()
  assert.equal(planUnlabel({ type: 'cancel' }, tree, HONEYDO.id), null)
})

test('leaf task: removes its label and clears its ordering date only', async () => {
  const leaf = makeNode(9, 'Leaf', { labels: [HONEYDO], due: orderDate(5) })
  const mock = makeApi([
    [9, { labels: [HONEYDO.id], due: orderDate(5) }],
    [10, { labels: [HONEYDO.id], due: orderDate(6) }],
  ])
  await applyUnlabel(planFor(leaf, 'task'), mock.api)
  assert.deepEqual(mock.calls, ['label-:9:7', 'due:9:null', 'refresh'])
  assert.deepEqual(mock.state.get(9), { labels: [], due: null })
  assert.deepEqual(mock.state.get(10), { labels: [HONEYDO.id], due: orderDate(6) })
  assert.equal(mock.refreshes, 1)
})

test('task-only scope removes one task and leaves descendant label/order data unchanged', async () => {
  const tree = makeTree()
  const mock = makeApi([
    [1, { labels: [HONEYDO.id], due: orderDate(10) }],
    [2, { labels: [], due: orderDate(20) }],
    [3, { labels: [HONEYDO.id], due: orderDate(30) }],
    [4, { labels: [], due: null }],
  ])
  await applyUnlabel(planFor(tree, 'task'), mock.api)
  assert.deepEqual(mock.calls, ['label-:1:7', 'due:1:null', 'refresh'])
  assert.deepEqual(mock.state.get(1), { labels: [], due: null })
  assert.deepEqual(mock.state.get(2), { labels: [], due: orderDate(20) })
  assert.deepEqual(mock.state.get(3), { labels: [HONEYDO.id], due: orderDate(30) })
  assert.deepEqual(mock.state.get(4), { labels: [], due: null })
})

test('subtree scope removes labels from labeled descendants and clears ordering metadata throughout', async () => {
  const tree = makeTree()
  const mock = makeApi([
    [1, { labels: [HONEYDO.id], due: orderDate(10) }],
    [2, { labels: [], due: orderDate(20) }],
    [3, { labels: [HONEYDO.id], due: orderDate(30) }],
    [4, { labels: [], due: null }],
  ])
  await applyUnlabel(planFor(tree, 'subtree'), mock.api)
  assert.deepEqual(
    [...mock.calls].sort(),
    ['due:1:null', 'due:2:null', 'due:3:null', 'label-:1:7', 'label-:3:7', 'refresh'].sort()
  )
  assert.equal(mock.calls[mock.calls.length - 1], 'refresh')
  // Unlabeled node 4 needs no label write and had no ordering date to clear.
  assert.ok(!mock.calls.some((call) => call.includes(':4')))
  // Every task still exists with its ordering date cleared; hierarchy and
  // relations were never part of this operation's API surface.
  assert.deepEqual(mock.state.get(1), { labels: [], due: null })
  assert.deepEqual(mock.state.get(2), { labels: [], due: null })
  assert.deepEqual(mock.state.get(3), { labels: [], due: null })
  assert.deepEqual(mock.state.get(4), { labels: [], due: null })
  assert.equal(mock.state.size, 4)
})

test('an independently labeled descendant survives task-only scope but is unlabeled in subtree scope', async () => {
  const tree = makeTree()
  const taskOnly = makeApi([
    [1, { labels: [HONEYDO.id], due: orderDate(10) }],
    [3, { labels: [HONEYDO.id], due: orderDate(30) }],
  ])
  await applyUnlabel(planFor(tree, 'task'), taskOnly.api)
  assert.deepEqual(taskOnly.state.get(3), { labels: [HONEYDO.id], due: orderDate(30) })

  const subtree = makeApi([
    [1, { labels: [HONEYDO.id], due: orderDate(10) }],
    [3, { labels: [HONEYDO.id], due: orderDate(30) }],
  ])
  await applyUnlabel(planFor(tree, 'subtree'), subtree.api)
  assert.deepEqual(subtree.state.get(3), { labels: [], due: null })
})

test('partial failure reports every failed write, still attempts the rest, and refreshes server state', async () => {
  const tree = makeTree()
  const mock = makeApi(
    [
      [1, { labels: [HONEYDO.id], due: orderDate(10) }],
      [2, { labels: [], due: orderDate(20) }],
      [3, { labels: [HONEYDO.id], due: orderDate(30) }],
    ],
    ['label-:1', 'due:3']
  )
  await assert.rejects(
    () => applyUnlabel(planFor(tree, 'subtree'), mock.api),
    (error: Error) => {
      assert.match(error.message, /R \(label: fixture label failure\)/)
      assert.match(error.message, /G \(ordering date: fixture ordering failure\)/)
      assert.match(error.message, /refreshed to show the server state/)
      return true
    }
  )
  // The independent writes on other tasks were still attempted.
  assert.ok(mock.calls.includes('due:1:null'))
  assert.ok(mock.calls.includes('due:2:null'))
  assert.ok(mock.calls.includes('label-:3:7'))
  assert.equal(mock.refreshes, 1)
  assert.equal(mock.calls[mock.calls.length - 1], 'refresh')
})

test('a failed refresh is reported instead of claiming success', async () => {
  const leaf = makeNode(9, 'Leaf', { labels: [HONEYDO], due: orderDate(5) })
  const mock = makeApi([[9, { labels: [HONEYDO.id], due: orderDate(5) }]], ['refresh'])
  await assert.rejects(
    () => applyUnlabel(planFor(leaf, 'task'), mock.api),
    /refresh failed/
  )
})

// View semantics after the operation: what the Honey-Do tree shows once the
// server (refetch) reflects the label/order removal.

function flatTask(
  id: number,
  title: string,
  position: number,
  options: {
    labels?: VikunjaTask['labels']
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
    labels: options.labels ?? [],
    created: orderDate(0),
    updated: orderDate(0),
    related_tasks: options.related_tasks,
  }
}

test('unlabeled descendants stay visible under a labeled ancestor but leave the view with it', () => {
  const before = [
    flatTask(1, 'Parent', 10, {
      labels: [HONEYDO],
      related_tasks: { subtask: [{ id: 2, title: 'Unlabeled child' }, { id: 3, title: 'Labeled child' }] },
    }),
    flatTask(2, 'Unlabeled child', 20, {
      related_tasks: { parenttask: [{ id: 1, title: 'Parent' }] },
    }),
    flatTask(3, 'Labeled child', 30, {
      labels: [HONEYDO],
      related_tasks: { parenttask: [{ id: 1, title: 'Parent' }] },
    }),
  ]
  const tree = buildTree(before, 'Honey-Do')
  assert.equal(tree.length, 1)
  assert.equal(tree[0].id, 1)
  assert.deepEqual(tree[0].children.map((child) => child.id), [2, 3])

  // After "This task only" on Parent plus refetch: the unlabeled child is no
  // longer reachable from any Honey-Do task and disappears; the independently
  // labeled child remains as a contextual root with its parent hint.
  const after = [
    flatTask(1, 'Parent', 10),
    flatTask(2, 'Unlabeled child', 20),
    flatTask(3, 'Labeled child', 30, {
      labels: [HONEYDO],
      related_tasks: { parenttask: [{ id: 1, title: 'Parent' }] },
    }),
  ]
  const afterTree = buildTree(after, 'Honey-Do')
  assert.deepEqual(afterTree.map((node) => node.id), [3])
  assert.equal(afterTree[0].parentContext, 'Subtask of: Parent')
  assert.deepEqual(afterTree[0].children, [])
})
