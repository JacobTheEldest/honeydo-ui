import assert from 'node:assert/strict'
import test from 'node:test'
import type { TaskTreeNode } from '../src/utils/taskTree.ts'
import type { VikunjaTask } from '../src/types/vikunja.ts'
import { positionToDueDate } from '../src/utils/ordering.ts'
import {
  applyDelete,
  applyRestore,
  collectRelationEdges,
  planDelete,
  resolveDeleteTargets,
  type DeleteApi,
  type RestoreApi,
} from '../src/utils/delete.ts'

const orderDate = positionToDueDate

function makeNode(
  id: number,
  title: string,
  options: {
    children?: TaskTreeNode[]
    depth?: number
  } = {}
): TaskTreeNode {
  return {
    id,
    title,
    description: '',
    done: false,
    done_at: null,
    due_date: orderDate(id),
    project_id: 1,
    labels: [],
    created: orderDate(0),
    updated: orderDate(0),
    children: options.children ?? [],
    depth: options.depth ?? 0,
  }
}

/** Nested fixture: 1 -> (2 -> 3, 4). */
function makeTree(): TaskTreeNode {
  return makeNode(1, 'R', {
    children: [
      makeNode(2, 'C', {
        depth: 1,
        children: [makeNode(3, 'G', { depth: 2 })],
      }),
      makeNode(4, 'Leaf', { depth: 1 }),
    ],
  })
}

function makeApi(failOn: number[] = []) {
  const deleted: number[] = []
  const calls: string[] = []
  let refreshes = 0
  const api: DeleteApi = {
    async deleteTask(taskId) {
      calls.push(`delete ${taskId}`)
      if (failOn.includes(taskId)) throw new Error(`delete ${taskId} failed`)
      deleted.push(taskId)
    },
    async refresh() {
      calls.push('refresh')
      refreshes++
    },
  }
  return { api, deleted, calls, refreshes: () => refreshes }
}

test("resolveDeleteTargets('task') targets only the node itself", () => {
  const node = makeTree()
  const targets = resolveDeleteTargets(node, 'task')
  assert.deepEqual(targets.map((task) => task.id), [1])
})

test("resolveDeleteTargets('subtree') targets every descendant deepest-first", () => {
  const targets = resolveDeleteTargets(makeTree(), 'subtree')
  // Children land before parents so a partial failure keeps still-linked
  // parents visible for retry.
  assert.deepEqual(targets.map((task) => task.id), [3, 2, 4, 1])
})

test('planDelete maps a cancel to no plan', () => {
  assert.equal(planDelete({ type: 'cancel' }, makeTree()), null)
})

test('planDelete keeps the root and resolves the scope', () => {
  const node = makeTree()
  const plan = planDelete({ type: 'confirm', scope: 'subtree' }, node)
  assert.ok(plan)
  assert.equal(plan.root.id, 1)
  assert.deepEqual(plan.targets.map((task) => task.id), [3, 2, 4, 1])
})

test('applyDelete deletes every target and refreshes once', async () => {
  const { api, deleted, calls } = makeApi()
  await applyDelete(resolveDeleteTargets(makeTree(), 'subtree'), api)
  assert.deepEqual(deleted, [3, 2, 4, 1])
  assert.deepEqual(calls, ['delete 3', 'delete 2', 'delete 4', 'delete 1', 'refresh'])
})

test('applyDelete attempts every target even after a failure and reports all of them', async () => {
  const { api, deleted, calls, refreshes } = makeApi([3, 4])
  await assert.rejects(
    applyDelete(resolveDeleteTargets(makeTree(), 'subtree'), api),
    (error: Error) => {
      assert.match(error.message, /Couldn't delete/)
      assert.match(error.message, /G \(delete 3 failed\)/)
      assert.match(error.message, /Leaf \(delete 4 failed\)/)
      assert.doesNotMatch(error.message, /C \(/)
      return true
    }
  )
  // Deepest-first order kept, failures skipped, successes still applied.
  assert.deepEqual(deleted, [2, 1])
  assert.deepEqual(calls, ['delete 3', 'delete 2', 'delete 4', 'delete 1', 'refresh'])
  assert.equal(refreshes(), 1)
})

test('applyDelete surfaces a refresh failure alongside delete failures', async () => {
  const { api } = makeApi()
  api.refresh = async () => {
    throw new Error('refresh down')
  }
  await assert.rejects(applyDelete([makeNode(9, 'Solo')], api), /refresh failed: refresh down/)
})

function freshTask(
  id: number,
  related?: { subtask?: Array<{ id: number; title: string }>; parenttask?: Array<{ id: number; title: string }> }
): VikunjaTask {
  return { ...makeNode(id, `Task ${id}`), related_tasks: related ?? {} }
}

function makeRestoreApi(options: { failRestore?: number[]; fresh?: VikunjaTask[]; failRelink?: boolean } = {}) {
  const restored: number[] = []
  const relinked: Array<[number, number]> = []
  const calls: string[] = []
  let refreshes = 0
  const api: RestoreApi = {
    async restoreTask(taskId) {
      calls.push(`restore ${taskId}`)
      if (options.failRestore?.includes(taskId)) throw new Error(`restore ${taskId} failed`)
      restored.push(taskId)
    },
    async addSubtaskRelation(parentId, childId) {
      calls.push(`relink ${parentId}->${childId}`)
      if (options.failRelink) throw new Error('relink down')
      relinked.push([parentId, childId])
    },
    async refresh() {
      calls.push('refresh')
      refreshes++
      return options.fresh ?? []
    },
  }
  return { api, restored, relinked, calls, refreshes: () => refreshes }
}

test('collectRelationEdges captures both views of a row exactly once', () => {
  const parent = makeNode(1, 'R')
  parent.related_tasks = { subtask: [{ id: 2, title: 'C' }] }
  const child = makeNode(2, 'C')
  child.related_tasks = { parenttask: [{ id: 1, title: 'R' }] }
  assert.deepEqual(collectRelationEdges([parent, child]), [{ parentId: 1, childId: 2 }])
})

test('planDelete captures the relation rows a task-only delete destroys', () => {
  const node = makeTree()
  node.related_tasks = {
    parenttask: [{ id: 9, title: 'Outside parent' }],
    subtask: [{ id: 2, title: 'C' }, { id: 4, title: 'Leaf' }],
  }
  const plan = planDelete({ type: 'confirm', scope: 'task' }, node)
  assert.ok(plan)
  assert.deepEqual(plan.edges, [
    { parentId: 9, childId: 1 },
    { parentId: 1, childId: 2 },
    { parentId: 1, childId: 4 },
  ])
})

test('applyRestore restores every target and re-links only missing relation rows', async () => {
  const targets = [makeNode(3, 'G'), makeNode(1, 'R')]
  const { api, restored, relinked, calls } = makeRestoreApi({
    fresh: [
      freshTask(1, { subtask: [] }),
      freshTask(2, { subtask: [{ id: 3, title: 'G' }], parenttask: [{ id: 1, title: 'R' }] }),
      freshTask(3, { parenttask: [{ id: 2, title: 'C' }] }),
    ],
  })
  await applyRestore(targets, [
    { parentId: 1, childId: 2 }, // missing after restore -> re-linked
    { parentId: 2, childId: 3 }, // present -> skipped
    { parentId: 7, childId: 8 }, // endpoint absent -> skipped
  ], api)
  assert.deepEqual(restored, [3, 1])
  assert.deepEqual(relinked, [[1, 2]])
  // A relink always triggers one more reconciliation refresh afterwards.
  assert.deepEqual(calls, ['restore 3', 'restore 1', 'refresh', 'relink 1->2', 'refresh'])
})

test('applyRestore treats a failed restore of a present task as already fine', async () => {
  // A racing undo can restore before the delete settles; the delete then 404s
  // at restore time but the task is present, which is what counts.
  const { api, calls } = makeRestoreApi({ failRestore: [5], fresh: [freshTask(5)] })
  await applyRestore([makeNode(5, 'Root C')], [], api)
  assert.deepEqual(calls, ['restore 5', 'refresh'])
})

test('applyRestore reports tasks that failed to restore and are absent', async () => {
  const { api } = makeRestoreApi({ failRestore: [5, 6], fresh: [freshTask(6)] })
  await assert.rejects(
    applyRestore([makeNode(5, 'Root C'), makeNode(6, 'Other')], [], api),
    (error: Error) => {
      assert.match(error.message, /Couldn't restore/)
      assert.match(error.message, /Root C \(still in Vikunja's trash\)/)
      assert.doesNotMatch(error.message, /Other/)
      return true
    }
  )
})

test('applyRestore reports relation rows that could not be re-linked', async () => {
  const { api, refreshes } = makeRestoreApi({
    failRelink: true,
    fresh: [freshTask(1, { subtask: [] }), freshTask(2, { parenttask: [{ id: 1, title: 'R' }] })],
  })
  await assert.rejects(
    applyRestore([makeNode(1, 'R')], [{ parentId: 1, childId: 2 }], api),
    (error: Error) => {
      assert.match(error.message, /Couldn't restore/)
      assert.match(error.message, /Task 1 → Task 2 \(relink down\)/)
      return true
    }
  )
  // A relink failure triggers one more reconciliation refresh.
  assert.equal(refreshes(), 2)
})

test('applyRestore surfaces a refresh failure without attempting relinks', async () => {
  const { api } = makeRestoreApi()
  api.refresh = async () => {
    throw new Error('refresh down')
  }
  await assert.rejects(
    applyRestore([makeNode(5, 'Root C')], [{ parentId: 5, childId: 6 }], api),
    (error: Error) => {
      assert.match(error.message, /Couldn't restore/)
      assert.match(error.message, /could not be refreshed \(refresh down\)/)
      return true
    }
  )
})
