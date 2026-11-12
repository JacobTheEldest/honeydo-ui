import type { VikunjaTask } from '../types/vikunja.ts'
import type { TaskTreeNode } from './taskTree.ts'
import type { RelationEdge } from './undoStack.ts'

export type { RelationEdge }

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
  /**
   * Relation rows the delete destroys (Vikunja removes them at delete time,
   * orphaning surviving subtasks). Undo restores the tasks from the trash and
   * re-links these edges.
   */
  edges: RelationEdge[]
}

export interface DeleteApi {
  deleteTask: (taskId: number) => Promise<unknown>
  refresh: () => Promise<unknown>
}

export interface RestoreApi {
  /** POST /api/v2/tasks/{id}/restore — un-deletes a task from Vikunja's trash. */
  restoreTask: (taskId: number) => Promise<unknown>
  /** Re-creates one parent -> child subtask relation row. */
  addSubtaskRelation: (parentId: number, childId: number) => Promise<unknown>
  /** Authoritative refetch; returns the fresh task list for presence checks. */
  refresh: () => Promise<VikunjaTask[]>
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

/**
 * Capture every relation row a delete is about to destroy. Vikunja removes
 * relation rows at delete time, so restoring a task from the trash does not
 * bring its parent/child links back — undo must re-create them. Both
 * directions are collected (parenttask and subtask views of the same row)
 * and de-duplicated.
 */
export function collectRelationEdges(targets: VikunjaTask[]): RelationEdge[] {
  const seen = new Set<string>()
  const out: RelationEdge[] = []
  const add = (parentId: number, childId: number) => {
    const key = `${parentId}:${childId}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ parentId, childId })
  }
  for (const task of targets) {
    for (const ref of task.related_tasks?.parenttask ?? []) add(ref.id, task.id)
    for (const ref of task.related_tasks?.subtask ?? []) add(task.id, ref.id)
  }
  return out
}

/** Map a dialog decision to the delete plan. Cancel returns null. */
export function planDelete(decision: DeleteDecision, node: TaskTreeNode): DeletePlan | null {
  if (decision.type === 'cancel') return null
  const targets = resolveDeleteTargets(node, decision.scope)
  return {
    root: node,
    targets,
    edges: collectRelationEdges(targets),
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

/**
 * Undo a deletion via Vikunja 2.8.0's trash: restore each target from the
 * trash, then re-create the relation rows the delete destroyed.
 *
 * A restore that throws is not immediately a failure — the target may never
 * have been deleted (a racing undo). The refreshed list decides: only targets
 * that both failed to restore and are absent afterwards count as failures
 * (they remain in Vikunja's trash, recoverable there). Relation edges are
 * re-linked only when both endpoints are back and the row is missing, so this
 * is correct whether or not a restore resurrects relation rows.
 */
export async function applyRestore(
  targets: VikunjaTask[],
  edges: RelationEdge[],
  api: RestoreApi
): Promise<void> {
  const restoredIds = new Set<number>()
  for (const task of targets) {
    try {
      await api.restoreTask(task.id)
      restoredIds.add(task.id)
    } catch {
      // Presence check below decides whether this actually failed.
    }
  }

  let fresh: VikunjaTask[]
  try {
    fresh = await api.refresh()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Couldn't restore: the list could not be refreshed (${detail}). ` +
      "Deleted tasks remain in Vikunja's trash."
    )
  }

  const present = new Map(fresh.map((task) => [task.id, task]))
  const failures: string[] = []
  for (const task of targets) {
    if (!restoredIds.has(task.id) && !present.has(task.id)) {
      failures.push(`${task.title} (still in Vikunja's trash)`)
    }
  }

  const relinkFailures: string[] = []
  let relinkAttempts = 0
  for (const edge of edges) {
    const parent = present.get(edge.parentId)
    const child = present.get(edge.childId)
    if (!parent || !child) continue
    const linked = (parent.related_tasks?.subtask ?? []).some((ref) => ref.id === edge.childId)
    if (linked) continue
    relinkAttempts++
    try {
      await api.addSubtaskRelation(edge.parentId, edge.childId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      relinkFailures.push(`${parent.title} → ${child.title} (${detail})`)
    }
  }
  // Any relink changes the relation rows the UI renders from; reconcile once
  // more whether the writes succeeded or failed.
  if (relinkAttempts > 0) await api.refresh().catch(() => {})

  if (failures.length > 0 || relinkFailures.length > 0) {
    throw new Error(
      `Couldn't restore: ${[...failures, ...relinkFailures].join('; ')}. ` +
      "Deleted tasks remain in Vikunja's trash."
    )
  }
}
