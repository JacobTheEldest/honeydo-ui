import type { VikunjaTask } from '../types/vikunja.ts'
import { dueDateToPosition } from './ordering.ts'

export interface TaskTreeNode extends VikunjaTask {
  children: TaskTreeNode[]
  depth: number
  /** Context for a Honey-Do task whose actual parent is outside this tree. */
  parentContext?: string
}

/** Root-id sentinel used by the DnD id-encoding helpers. */
export const ROOT_PARENT = 'r' as const

export type ParentScope = typeof ROOT_PARENT | number

/** Vikunja exposes each task's due_date on task list and detail responses. */
function orderByPersistedDueDate<T extends VikunjaTask>(tasks: T[]): T[] {
  return tasks
    .map((task, index) => ({ task, index, position: dueDateToPosition(task.due_date) }))
    .sort((a, b) => {
      const aPosition = Number.isFinite(a.position) ? a.position : 0
      const bPosition = Number.isFinite(b.position) ? b.position : 0
      return aPosition - bPosition || a.index - b.index
    })
    .map(({ task }) => task)
}

/**
 * Encode a (parentScope, taskId) pair into a single string for useSortable.
 * Roots use the sentinel "r" so their ids are "r::<taskId>" and never collide
 * with child ids, which are "<parentId>::<taskId>".
 */
export function encodeGroupItemId(parent: ParentScope, taskId: number): string {
  return `${parent}::${taskId}`
}

export function decodeGroupItemId(encoded: string | number): { parent: ParentScope; taskId: number } | null {
  if (typeof encoded === 'number') {
    return { parent: ROOT_PARENT, taskId: encoded }
  }
  const idx = encoded.indexOf('::')
  if (idx === -1) {
    const n = Number(encoded)
    if (!Number.isNaN(n)) return { parent: ROOT_PARENT, taskId: n }
    return null
  }
  const parentPart = encoded.slice(0, idx)
  const taskPart = encoded.slice(idx + 2)
  const taskId = Number(taskPart)
  if (!Number.isFinite(taskId)) return null
  if (parentPart === ROOT_PARENT) return { parent: ROOT_PARENT, taskId }
  const parentId = Number(parentPart)
  if (!Number.isFinite(parentId)) return null
  return { parent: parentId, taskId }
}

function getFirstParent(task: VikunjaTask): { id: number; title: string } | null {
  const parent = task.related_tasks?.parenttask?.[0]
  return parent ? { id: parent.id, title: parent.title } : null
}

/**
 * Build the Honey-Do forest. Unlabeled descendants remain in a visible
 * Honey-Do subtree, but a labeled task whose parent is outside that forest is
 * surfaced as a contextual pseudo-root instead of disappearing or making its
 * unlabeled parent look like a prioritized Honey-Do item.
 */
export function buildTree(
  flat: VikunjaTask[],
  honeyDoLabel: string
): TaskTreeNode[] {
  if (flat.length === 0) return []

  const byId = new Map<number, VikunjaTask>()
  for (const task of flat) byId.set(task.id, task)

  const honeyDoIds = new Set<number>()
  for (const task of flat) {
    if (task.labels?.some((label) => label.title === honeyDoLabel)) honeyDoIds.add(task.id)
  }

  const declaredParentOf = new Map<number, number>()
  for (const task of flat) {
    const parent = getFirstParent(task)
    if (parent && parent.id !== task.id) declaredParentOf.set(task.id, parent.id)
  }

  const childOrder = new Map<number, number[]>()
  for (const task of flat) {
    const children = task.related_tasks?.subtask ?? []
    const ordered = children
      .filter((child, index) =>
        byId.has(child.id) &&
        (declaredParentOf.get(child.id) === undefined || declaredParentOf.get(child.id) === task.id) &&
        children.findIndex((item) => item.id === child.id) === index
      )
      .map((child) => child.id)
    if (ordered.length > 0) childOrder.set(task.id, ordered)
  }
  for (const task of flat) {
    const parent = getFirstParent(task)
    if (!parent || parent.id === task.id || !byId.has(parent.id)) continue
    const siblings = childOrder.get(parent.id) ?? []
    if (!siblings.includes(task.id)) childOrder.set(parent.id, [...siblings, task.id])
  }

  const nodes = new Map<number, TaskTreeNode>()
  for (const task of flat) nodes.set(task.id, { ...task, children: [], depth: 0 })

  const attached = new Set<number>()
  const attachChildren = (node: TaskTreeNode, depth: number, visiting: Set<number>): void => {
    if (visiting.has(node.id) || attached.has(node.id)) return
    visiting.add(node.id)
    attached.add(node.id)
    node.depth = depth
    const children: TaskTreeNode[] = []
    for (const childId of childOrder.get(node.id) ?? []) {
      const child = nodes.get(childId)
      if (!child || attached.has(childId)) continue
      attachChildren(child, depth + 1, visiting)
      if (attached.has(childId)) children.push(child)
    }
    node.children = orderByPersistedDueDate(children)
    visiting.delete(node.id)
  }

  const roots: TaskTreeNode[] = []
  // Genuine roots must have no parent relation, not merely a parent omitted
  // from this fetch. The latter are handled below with explicit context.
  for (const task of flat) {
    if (getFirstParent(task) || !honeyDoIds.has(task.id)) continue
    const node = nodes.get(task.id)
    if (!node) continue
    attachChildren(node, 0, new Set())
    roots.push(node)
  }

  // Add labeled tasks disconnected from the Honey-Do forest. Prefer the
  // highest labeled task under an omitted/unlabeled ancestor so its labeled
  // descendants stay attached beneath it.
  const contextualRoots = flat.filter((task) => {
    if (!honeyDoIds.has(task.id) || attached.has(task.id)) return false
    const parent = getFirstParent(task)
    return parent !== null && !honeyDoIds.has(parent.id)
  })
  for (const task of contextualRoots) {
    if (attached.has(task.id)) continue
    const parent = getFirstParent(task)
    const node = nodes.get(task.id)
    if (!parent || !node) continue
    const knownParent = byId.get(parent.id)
    node.parentContext = `Subtask of: ${knownParent?.title ?? parent.title}`
    attachChildren(node, 0, new Set())
    roots.push(node)
  }

  return orderByPersistedDueDate(roots)
}


/**
 * Depth-first flatten. Skips any descendants of a parent whose id is in
 * the `collapsed` set. Preserves sibling order from the tree.
 */
export function flattenVisible(roots: TaskTreeNode[], collapsed: Set<number>): VikunjaTask[] {
  const out: VikunjaTask[] = []
  const visit = (node: TaskTreeNode): void => {
    out.push(node)
    if (collapsed.has(node.id)) return
    for (const c of node.children) visit(c)
  }
  for (const r of roots) visit(r)
  return out
}

/** Collect the ids of every task that has at least one subtask in the tree. */
export function collectParentIds(roots: TaskTreeNode[]): number[] {
  const ids: number[] = []
  const visit = (node: TaskTreeNode): void => {
    if (node.children.length > 0) ids.push(node.id)
    for (const c of node.children) visit(c)
  }
  for (const r of roots) visit(r)
  return ids
}
