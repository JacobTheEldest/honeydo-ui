import type { VikunjaTask } from '../types/vikunja.ts'
import type { TaskTreeNode } from './taskTree.ts'

/** Removal scope chosen in the confirmation dialog. */
export type UnassignScope = 'task' | 'subtree'

/**
 * Outcome of the confirmation dialog. A cancel decision yields no plan, so
 * the dialog flow cannot issue any writes.
 */
export type UnassignDecision =
  | { type: 'cancel' }
  | { type: 'confirm'; scope: UnassignScope }

export interface UnassignPlan {
  /** Tasks whose assignee/order metadata should be removed. */
  targets: VikunjaTask[]
  userId: number
}

export interface UnassignApi {
  unassignUser: (taskId: number, userId: number) => Promise<void>
  setDueDate: (taskId: number, dueDate: null) => Promise<void>
  refresh: () => Promise<unknown>
}

/** Total number of recursive descendants shown in the subtree-scope option. */
export function countDescendants(node: TaskTreeNode): number {
  return node.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0)
}

/**
 * Resolve which tasks a confirmed decision touches. 'task' keeps descendant
 * assignee/order data unchanged; 'subtree' covers every recursive descendant.
 */
export function resolveUnassignTargets(node: TaskTreeNode, scope: UnassignScope): VikunjaTask[] {
  if (scope === 'task') return [node]
  const out: VikunjaTask[] = []
  const visit = (current: TaskTreeNode): void => {
    out.push(current)
    for (const child of current.children) visit(child)
  }
  visit(node)
  return out
}

/**
 * Map a dialog decision to the write plan. Cancel returns null so the caller
 * performs zero API writes.
 */
export function planUnassign(
  decision: UnassignDecision,
  node: TaskTreeNode,
  userId: number
): UnassignPlan | null {
  if (decision.type === 'cancel') return null
  return {
    targets: resolveUnassignTargets(node, decision.scope),
    userId,
  }
}

/**
 * Apply user unassignment/order removal without deleting tasks or changing
 * hierarchy.
 *
 * Per target: unassign the user only when assigned, and clear the sorting
 * due_date only when set. Every target is attempted even if another fails;
 * the server is refetched afterwards so the UI converges on authoritative
 * state, and an aggregated error reports exactly what failed.
 */
export async function applyUnassign(plan: UnassignPlan, api: UnassignApi): Promise<void> {
  const failures: string[] = []
  await Promise.all(plan.targets.map(async (task) => {
    const operations: Array<{ name: string; run: () => Promise<void> }> = []
    if (task.assignees?.some((a) => a.id === plan.userId)) {
      operations.push({ name: 'assignee', run: () => api.unassignUser(task.id, plan.userId) })
    }
    if (task.due_date !== null) {
      operations.push({ name: 'ordering date', run: () => api.setDueDate(task.id, null) })
    }
    for (const operation of operations) {
      try {
        await operation.run()
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        failures.push(`${task.title} (${operation.name}: ${detail})`)
      }
    }
  }))

  try {
    await api.refresh()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    failures.push(`refresh failed: ${detail}`)
  }
  if (failures.length > 0) {
    throw new Error(
      `Couldn't fully unassign these tasks: ${failures.join('; ')}. ` +
      'The list was refreshed to show the server state.'
    )
  }
}
