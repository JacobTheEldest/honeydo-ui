import type { VikunjaTask } from '../types/vikunja.ts'
import type { TaskTreeNode } from './taskTree.ts'

/** Deletion scope chosen in the confirmation dialog. */
export type DeleteScope = 'task' | 'subtree'

/**
 * Outcome of the confirmation dialog. A cancel decision yields no plan, so
 * the dialog flow cannot issue any writes.
 */
export type DeleteDecision =
  | { type: 'cancel' }
  | { type: 'confirm'; scope: DeleteScope }

export interface DeletePlan {
  /** The task whose menu initiated the delete; drives the toast message. */
  root: TaskTreeNode
  /** Every task the decision deletes, deepest-first (children before parents). */
  targets: VikunjaTask[]
}

export interface DeleteApi {
  deleteTask: (taskId: number) => Promise<unknown>
  refresh: () => Promise<unknown>
}

/**
 * Resolve which tasks a confirmed decision touches. 'task' deletes only the
 * node itself — its subtasks survive in Vikunja but lose their parent;
 * 'subtree' covers every recursive descendant, ordered deepest-first so a
 * partially failed commit keeps the still-linked parents visible for retry.
 */
export function resolveDeleteTargets(node: TaskTreeNode, scope: DeleteScope): VikunjaTask[] {
  if (scope === 'task') return [node]
  const out: VikunjaTask[] = []
  const visit = (current: TaskTreeNode): void => {
    for (const child of current.children) visit(child)
    out.push(current)
  }
  visit(node)
  return out
}

/** Map a dialog decision to the delete plan. Cancel returns null. */
export function planDelete(decision: DeleteDecision, node: TaskTreeNode): DeletePlan | null {
  if (decision.type === 'cancel') return null
  return {
    root: node,
    targets: resolveDeleteTargets(node, decision.scope),
  }
}

/**
 * Commit deletions against the server.
 *
 * Targets are attempted deepest-first and every target is attempted even if
 * another fails; the server is refetched afterwards so the UI converges on
 * authoritative state, and an aggregated error reports exactly what failed.
 */
export async function applyDelete(targets: VikunjaTask[], api: DeleteApi): Promise<void> {
  const failures: string[] = []
  for (const task of targets) {
    try {
      await api.deleteTask(task.id)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      failures.push(`${task.title} (${detail})`)
    }
  }
  try {
    await api.refresh()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    failures.push(`refresh failed: ${detail}`)
  }
  if (failures.length > 0) {
    throw new Error(
      `Couldn't delete: ${failures.join('; ')}. ` +
      'The list was refreshed to show the server state.'
    )
  }
}
