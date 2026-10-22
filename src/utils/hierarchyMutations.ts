import type { VikunjaTask } from '../types/vikunja.ts'
import type { TaskTreeNode } from './taskTree.ts'

export interface ParentChangeApi {
  removeRelation: (parentId: number, childId: number) => Promise<void>
  addRelation: (parentId: number, childId: number) => Promise<void>
  setDueDate: (taskId: number, dueDate: string | null) => Promise<void>
  addLabel: (taskId: number, labelId: number) => Promise<void>
  removeLabel: (taskId: number, labelId: number) => Promise<void>
  refresh: () => Promise<unknown>
}

export interface ParentChange {
  taskId: number
  oldParentId: number | null
  /** All known parents; oldParentId is retained as the single-parent fallback. */
  oldParentIds?: number[]
  newParentId: number | null
  oldDueDate: string | null
  newDueDate: string
  labelIdToAdd?: number
}

export function isSelfOrDescendant(node: TaskTreeNode, targetId: number): boolean {
  if (node.id === targetId) return true
  return node.children.some((child) => isSelfOrDescendant(child, targetId))
}

export function reorderAtDropEdge(
  ids: number[],
  activeId: number,
  targetId: number,
  edge: 'before' | 'after'
): number[] {
  const from = ids.indexOf(activeId)
  const target = ids.indexOf(targetId)
  if (from === -1 || target === -1 || activeId === targetId) return ids

  const next = ids.filter((id) => id !== activeId)
  const targetIndex = next.indexOf(targetId)
  next.splice(targetIndex + (edge === 'after' ? 1 : 0), 0, activeId)
  return next
}

export function canPromoteToRoot(
  task: { related_tasks?: VikunjaTask['related_tasks'] },
  directParent: Pick<VikunjaTask, 'id' | 'labels'> | undefined,
  honeyDoLabel: string
): boolean {
  const parents = task.related_tasks?.parenttask ?? []
  if (parents.length !== 1) return false
  const parentId = parents[0].id
  return directParent?.id === parentId &&
    directParent.labels?.some((label) => label.title === honeyDoLabel) === true
}

/**
 * Apply a non-atomic Vikunja parent change, compensating completed writes if a
 * later relation/order/label write fails. Always refetch after failure so the
 * UI converges on the server's authoritative graph, even if compensation fails.
 */
export async function applyParentChange(change: ParentChange, api: ParentChangeApi): Promise<void> {
  const {
    taskId,
    oldParentId,
    newParentId,
    oldDueDate,
    newDueDate,
    labelIdToAdd,
  } = change
  const oldParentIds = [...new Set(change.oldParentIds ?? (oldParentId === null ? [] : [oldParentId]))]
  if (oldParentIds.length === 1 && oldParentIds[0] === newParentId &&
      !labelIdToAdd && oldDueDate === newDueDate) return

  const removedParentIds: number[] = []
  let newRelationAdded = false
  let dueDateChanged = false
  let labelAdded = false

  try {
    for (const parentId of oldParentIds) {
      if (parentId === newParentId) continue
      await api.removeRelation(parentId, taskId)
      removedParentIds.push(parentId)
    }
    if (newParentId !== null && !oldParentIds.includes(newParentId)) {
      await api.addRelation(newParentId, taskId)
      newRelationAdded = true
    }
    if (oldDueDate !== newDueDate) {
      await api.setDueDate(taskId, newDueDate)
      dueDateChanged = true
    }
    if (labelIdToAdd !== undefined) {
      await api.addLabel(taskId, labelIdToAdd)
      labelAdded = true
    }
    await api.refresh()
  } catch (cause) {
    const rollbackErrors: unknown[] = []
    const compensate = async (operation: () => Promise<void>) => {
      try {
        await operation()
      } catch (error) {
        rollbackErrors.push(error)
      }
    }

    if (labelAdded && labelIdToAdd !== undefined) {
      await compensate(() => api.removeLabel(taskId, labelIdToAdd))
    }
    if (dueDateChanged) {
      await compensate(() => api.setDueDate(taskId, oldDueDate))
    }
    if (newRelationAdded && newParentId !== null) {
      await compensate(() => api.removeRelation(newParentId, taskId))
    }
    for (const parentId of removedParentIds.reverse()) {
      await compensate(() => api.addRelation(parentId, taskId))
    }
    await compensate(async () => { await api.refresh() })

    const detail = cause instanceof Error ? cause.message : String(cause)
    const recovery = rollbackErrors.length > 0
      ? ' Rollback was incomplete; the task list was refreshed, so verify its parent before retrying.'
      : ' The prior relationship was restored.'
    throw new Error(`Couldn't move task: ${detail}.${recovery}`)
  }
}
