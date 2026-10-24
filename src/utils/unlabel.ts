import type { VikunjaTask } from '../types/vikunja.ts'
import type { TaskTreeNode } from './taskTree.ts'

/** Removal scope chosen in the confirmation dialog. */
export type UnlabelScope = 'task' | 'subtree'

/**
 * Outcome of the confirmation dialog. A cancel decision yields no plan, so
 * the dialog flow cannot issue any writes.
 */
export type UnlabelDecision =
  | { type: 'cancel' }
  | { type: 'confirm'; scope: UnlabelScope }

export interface UnlabelPlan {
  /** Tasks whose Honey-Do label/order metadata should be removed. */
  targets: VikunjaTask[]
  honeyDoLabelId: number
}

export interface UnlabelApi {
  removeLabel: (taskId: number, labelId: number) => Promise<void>
  setDueDate: (taskId: number, dueDate: null) => Promise<void>
  refresh: () => Promise<unknown>
}

/** Total number of recursive descendants shown in the subtree-scope option. */
export function countDescendants(node: TaskTreeNode): number {
  return node.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0)
}

/**
 * Resolve which tasks a confirmed decision touches. 'task' keeps descendant
 * label/order data unchanged; 'subtree' covers every recursive descendant.
 */
export function resolveUnlabelTargets(node: TaskTreeNode, scope: UnlabelScope): VikunjaTask[] {
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
export function planUnlabel(
  decision: UnlabelDecision,
  node: TaskTreeNode,
  honeyDoLabelId: number
): UnlabelPlan | null {
  if (decision.type === 'cancel') return null
  return {
    targets: resolveUnlabelTargets(node, decision.scope),
    honeyDoLabelId,
  }
}

/**
 * Apply label/order removal without deleting tasks or changing hierarchy.
 *
 * Per target: remove the Honey-Do label only when present, and clear the
 * Honey-Do sorting due_date only when set. Every target is attempted even if
 * another fails; the server is refetched afterwards so the UI converges on
 * authoritative state, and an aggregated error reports exactly what failed.
 */
export async function applyUnlabel(plan: UnlabelPlan, api: UnlabelApi): Promise<void> {
  const failures: string[] = []
  await Promise.all(plan.targets.map(async (task) => {
    const operations: Array<{ name: string; run: () => Promise<void> }> = []
    if (task.labels?.some((label) => label.id === plan.honeyDoLabelId)) {
      operations.push({ name: 'label', run: () => api.removeLabel(task.id, plan.honeyDoLabelId) })
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
      `Couldn't fully remove these tasks from Honey-Do: ${failures.join('; ')}. ` +
      'The list was refreshed to show the server state.'
    )
  }
}
