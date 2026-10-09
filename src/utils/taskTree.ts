import type { VikunjaTask } from '../types/vikunja.ts'

export interface TaskTreeNode extends VikunjaTask {
  children: TaskTreeNode[]
  depth: number
}

/** Root-id sentinel used by the DnD id-encoding helpers. */
export const ROOT_PARENT = 'r' as const

export type ParentScope = typeof ROOT_PARENT | number

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

/** A task is a parent (has at least one subtask) iff related_tasks.subtask
 *  has at least one entry that references a task in the fetched set. */
export function hasSubtasks(task: VikunjaTask, byId: Map<number, VikunjaTask>): boolean {
  const refs = task.related_tasks?.subtask
  if (!refs || refs.length === 0) return false
  return refs.some((r) => byId.has(r.id))
}

/** A task is "Honey-Do rooted" if it carries the Honey-Do label, or if any of
 *  its ancestors does. Used by buildTree to decide which nodes become roots. */
function isHoneyDoRooted(
  task: VikunjaTask,
  byId: Map<number, VikunjaTask>,
  honeyDoIds: Set<number>
): boolean {
  if (honeyDoIds.has(task.id)) return true
  const visited = new Set<number>()
  let cur: VikunjaTask | undefined = task
  while (cur) {
    if (visited.has(cur.id)) return false // cycle guard
    visited.add(cur.id)
    const parents = cur.related_tasks?.parenttask
    if (!parents || parents.length === 0) return false
    for (const p of parents) {
      const parentTask = byId.get(p.id)
      if (!parentTask) continue
      if (honeyDoIds.has(parentTask.id)) return true
      // Walk up; the outer loop picks up where we left off.
      cur = parentTask
      break
    }
  }
  return false
}

function getFirstParentId(task: VikunjaTask): number | null {
  const parents = task.related_tasks?.parenttask
  if (!parents || parents.length === 0) return null
  return parents[0].id
}

/**
 * Build a forest of TaskTreeNodes from a flat list of Vikunja tasks.
 *
 * Rules:
 *  - Roots are honey-do-rooted tasks with no parenttask in the input set.
 *  - A child whose parent isn't in the fetched set becomes a root (orphan).
 *  - Cycles are broken by visiting each id at most once.
 *  - depth is assigned from 0 at the root.
 *  - Sibling order: parent tasks appear in the order they were in the input;
 *    child tasks appear in the order their parent listed them in
 *    related_tasks.subtask (with any task missing from that list appended
 *    in input order).
 */
export function buildTree(
  flat: VikunjaTask[],
  honeyDoLabel: string
): TaskTreeNode[] {
  if (flat.length === 0) return []

  const byId = new Map<number, VikunjaTask>()
  for (const t of flat) byId.set(t.id, t)

  const honeyDoIds = new Set<number>()
  for (const t of flat) {
    if (t.labels?.some((l) => l.title === honeyDoLabel)) honeyDoIds.add(t.id)
  }

  // Decide each task's parent (id) and the order children should be rendered.
  const childOrder = new Map<number, number[]>() // parentId -> ordered child ids
  const parentOf = new Map<number, number>() // childId -> parentId

  for (const t of flat) {
    const refs = t.related_tasks?.subtask ?? []
    if (refs.length > 0) {
      const ordered: number[] = []
      for (const r of refs) {
        if (byId.has(r.id) && !ordered.includes(r.id)) ordered.push(r.id)
      }
      // Append any children that exist in the flat list but weren't listed
      // by the parent (defensive).
      childOrder.set(t.id, ordered)
    }
  }

  for (const t of flat) {
    const parentId = getFirstParentId(t)
    if (parentId === null) continue
    if (parentId === t.id) continue // self-parent: ignore
    if (!byId.has(parentId)) continue
    parentOf.set(t.id, parentId)
    // Ensure every child has a slot in childOrder, even if the parent didn't
    // list it (so we still emit it under that parent).
    const existing = childOrder.get(parentId) ?? []
    if (!existing.includes(t.id)) {
      childOrder.set(parentId, [...existing, t.id])
    }
  }

  // Build nodes recursively. A node is a root iff it has no parent and it
  // is honey-do-rooted (or it has no parent and no honey-do label, in which
  // case it's a top-level orphan that we surface in case the user wants it).
  const nodes = new Map<number, TaskTreeNode>()
  for (const t of flat) {
    nodes.set(t.id, { ...t, children: [], depth: 0 })
  }

  const visiting = new Set<number>()
  const attachChildren = (node: TaskTreeNode, depth: number): void => {
    if (visiting.has(node.id)) {
      // Cycle: stop descending.
      return
    }
    visiting.add(node.id)
    node.depth = depth
    const ordered = childOrder.get(node.id) ?? []
    for (const childId of ordered) {
      const child = nodes.get(childId)
      if (!child) continue
      child.depth = depth + 1
      attachChildren(child, depth + 1)
      node.children.push(child)
    }
    visiting.delete(node.id)
  }

  const roots: TaskTreeNode[] = []
  for (const t of flat) {
    if (parentOf.has(t.id)) continue
    if (!isHoneyDoRooted(t, byId, honeyDoIds)) continue
    const node = nodes.get(t.id)
    if (!node) continue
    attachChildren(node, 0)
    roots.push(node)
  }

  return roots
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
