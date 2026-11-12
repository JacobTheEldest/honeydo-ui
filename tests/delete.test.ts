import assert from 'node:assert/strict'
import test from 'node:test'
import type { TaskTreeNode } from '../src/utils/taskTree.ts'
import { positionToDueDate } from '../src/utils/ordering.ts'
import {
  applyDelete,
  planDelete,
  resolveDeleteTargets,
  type DeleteApi,
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
