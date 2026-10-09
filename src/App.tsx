import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { Eye, EyeOff, Loader2, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { useVikunjaApi } from './hooks/useVikunjaApi.ts'
import TaskItem from './components/TaskItem.tsx'
import FAB from './components/FAB.tsx'
import {
  positionToDueDate,
  dueDateToPosition,
  getMidpointPosition,
  needsRebalance,
  rebalancePositions,
  getTopPosition,
} from './utils/ordering.ts'
import {
  buildTree,
  collectParentIds,
  encodeGroupItemId,
  decodeGroupItemId,
  ROOT_PARENT,
  type TaskTreeNode,
  type ParentScope,
} from './utils/taskTree.ts'
import { HONEYDO_LABEL, DEFAULT_PROJECT_ID } from './config.ts'

export default function App() {
  const {
    labels,
    tasks,
    loading,
    error,
    fetchTasks,
    createTask,
    updateTask,
    addLabelToTask,
    createLabel,
  } = useVikunjaApi()

  const [showCompleted, setShowCompleted] = useState(false)
  const [honeyDoLabelId, setHoneyDoLabelId] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set())

  // Find or create Honey-Do label
  useEffect(() => {
    const existing = labels.find((l) => l.title === HONEYDO_LABEL)
    if (existing) {
      setHoneyDoLabelId(existing.id)
    } else if (labels.length > 0 && honeyDoLabelId === null) {
      // Auto-create label once we know it doesn't exist
      createLabel(HONEYDO_LABEL).then((label) => {
        setHoneyDoLabelId(label.id)
      })
    }
  }, [labels, honeyDoLabelId, createLabel])

  // Fetch tasks on mount
  useEffect(() => {
    fetchTasks().catch(() => {})
  }, [fetchTasks])

  // Tree of all Honey-Do-rooted tasks. Children without the Honey-Do label
  // are pulled in transitively via related_tasks.subtask (see useVikunjaApi).
  const taskTree = useMemo<TaskTreeNode[]>(() => {
    return buildTree(tasks, HONEYDO_LABEL)
  }, [tasks])

  // Hidden ancestor ids: any node whose ancestor is `done && !showCompleted`
  // (i.e. the show-done toggle is off and an ancestor was marked done).
  // We use this to mirror the existing "hide done task" behavior across the
  // whole subtree, so a done parent doesn't leave orphan children visible.
  const hiddenByAncestor = useMemo<Set<number>>(() => {
    if (showCompleted) return new Set()
    const hidden = new Set<number>()
    const visit = (node: TaskTreeNode, ancestorHidden: boolean): void => {
      const selfHidden = ancestorHidden || node.done
      if (selfHidden) hidden.add(node.id)
      for (const c of node.children) visit(c, selfHidden)
    }
    for (const r of taskTree) visit(r, false)
    return hidden
  }, [taskTree, showCompleted])

  // Map id -> tree node for O(1) children lookups while rendering.
  const treeById = useMemo<Map<number, TaskTreeNode>>(() => {
    const m = new Map<number, TaskTreeNode>()
    const visit = (n: TaskTreeNode): void => {
      m.set(n.id, n)
      for (const c of n.children) visit(c)
    }
    for (const r of taskTree) visit(r)
    return m
  }, [taskTree])

  const byId = useMemo<Map<number, import('./types/vikunja.ts').VikunjaTask>>(() => {
    const m = new Map<number, import('./types/vikunja.ts').VikunjaTask>()
    for (const t of tasks) m.set(t.id, t)
    return m
  }, [tasks])

  // Sibling-group lookup keyed by (parentScope, orderedTaskIds) — the groups
  // we render as SortableContexts. Root group is keyed by ROOT_PARENT.
  const groups = useMemo<Array<{ parent: ParentScope; items: number[] }>>(() => {
    const list: Array<{ parent: ParentScope; items: number[] }> = []
    const visit = (node: TaskTreeNode): void => {
      // The list of children of `node` is the group at scope `node.id`.
      // We always emit a group, even when empty, so DndContext can find it.
      if (node.children.length > 0) {
        list.push({
          parent: node.id,
          items: node.children.map((c) => c.id),
        })
      }
      for (const c of node.children) visit(c)
    }
    list.push({
      parent: ROOT_PARENT,
      items: taskTree.map((r) => r.id),
    })
    for (const r of taskTree) visit(r)
    return list
  }, [taskTree])

  // Reverse lookup: given a sortable id, return the group it belongs to.
  const groupBySortableId = useMemo<Map<string, { parent: ParentScope; items: number[] }>>(() => {
    const m = new Map<string, { parent: ParentScope; items: number[] }>()
    for (const g of groups) {
      for (const id of g.items) {
        m.set(encodeGroupItemId(g.parent, id), g)
      }
    }
    return m
  }, [groups])

  // Stable handlers
  const handleToggleCollapse = useCallback((taskId: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }, [])

  const handleCollapseAll = useCallback(() => {
    setCollapsed(new Set(collectParentIds(taskTree)))
  }, [taskTree])

  const handleExpandAll = useCallback(() => {
    setCollapsed(new Set())
  }, [])

  const handleToggleDone = useCallback(
    (id: number, done: boolean) => {
      const task = byId.get(id)
      if (task) updateTask(task, { done })
    },
    [byId, updateTask]
  )

  const handleUpdateTitle = useCallback(
    (id: number, title: string) => {
      const task = byId.get(id)
      if (task) updateTask(task, { title })
    },
    [byId, updateTask]
  )

  const handleCreateTask = useCallback(
    async (title: string) => {
      if (!honeyDoLabelId) return
      const task = await createTask({
        title,
        project_id: DEFAULT_PROJECT_ID,
        due_date: positionToDueDate(getTopPosition()),
      })
      await addLabelToTask(task.id, honeyDoLabelId)
    },
    [honeyDoLabelId, createTask, addLabelToTask]
  )

  const handleDragOver = useCallback(
    (_event: DragOverEvent) => {
      // Cross-scope drops are visually rejected by leaving DndContext in
      // its current state; onDragEnd re-checks scope and snaps back.
    },
    []
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return

      const activeDecoded = decodeGroupItemId(String(active.id))
      const overDecoded = decodeGroupItemId(String(over.id))
      if (!activeDecoded || !overDecoded) return

      // Cross-scope drop: snap back, no changes.
      if (activeDecoded.parent !== overDecoded.parent) return

      const group = groupBySortableId.get(String(active.id))
      if (!group) return

      const oldIndex = group.items.indexOf(activeDecoded.taskId)
      const newIndex = group.items.indexOf(overDecoded.taskId)
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return

      // Reorder group items and rebuild the task list for that group.
      const reorderedIds = arrayMove(group.items, oldIndex, newIndex)
      const groupTasks: import('./types/vikunja.ts').VikunjaTask[] = []
      for (const id of reorderedIds) {
        const t = byId.get(id)
        if (t) groupTasks.push(t)
      }

      const positions = groupTasks.map((t) => dueDateToPosition(t.due_date))
      const updates: Array<{ task: import('./types/vikunja.ts').VikunjaTask; due_date: string }> = []

      if (needsRebalance(positions)) {
        const fresh = rebalancePositions(groupTasks.length)
        for (let i = 0; i < groupTasks.length; i++) {
          updates.push({ task: groupTasks[i], due_date: positionToDueDate(fresh[i]) })
        }
      } else {
        const moved = groupTasks[newIndex]
        let newPos: number
        if (newIndex === 0) {
          newPos = group.parent === ROOT_PARENT
            ? getTopPosition()
            : dueDateToPosition(groupTasks[1]?.due_date ?? null) - 1
        } else if (newIndex === groupTasks.length - 1) {
          const prevPos = dueDateToPosition(groupTasks[newIndex - 1].due_date)
          newPos = prevPos + 1
        } else {
          const prevPos = dueDateToPosition(groupTasks[newIndex - 1].due_date)
          const nextPos = dueDateToPosition(groupTasks[newIndex + 1].due_date)
          newPos = getMidpointPosition(prevPos, nextPos)
        }
        updates.push({ task: moved, due_date: positionToDueDate(newPos) })
      }

      // Fire updates. We don't await — UI updates optimistically via the
      // existing setTasks merge.
      for (const u of updates) {
        updateTask(u.task, { due_date: u.due_date }).catch(() => {})
      }
    },
    [groupBySortableId, byId, updateTask]
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  const allCollapsed = collapsed.size > 0

  return (
    <div className="min-h-svh bg-white">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white/90 backdrop-blur border-b border-gray-100 px-4 py-3">
        <div className="flex items-center justify-between max-w-xl mx-auto">
          <h1 className="text-xl font-semibold text-honey-dark">HoneyDo</h1>
          <div className="flex items-center gap-1">
            <button
              onClick={allCollapsed ? handleExpandAll : handleCollapseAll}
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5 rounded-lg hover:bg-gray-50"
              aria-label={allCollapsed ? 'Expand all' : 'Collapse all'}
            >
              {allCollapsed ? (
                <>
                  <ChevronsUpDown className="w-4 h-4" /> Expand all
                </>
              ) : (
                <>
                  <ChevronsDownUp className="w-4 h-4" /> Collapse all
                </>
              )}
            </button>
            <button
              onClick={() => setShowCompleted(!showCompleted)}
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5 rounded-lg hover:bg-gray-50"
            >
              {showCompleted ? (
                <>
                  <Eye className="w-4 h-4" /> Hide done
                </>
              ) : (
                <>
                  <EyeOff className="w-4 h-4" /> Show done
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Task list */}
      <main className="max-w-xl mx-auto pb-24">
        {loading && tasks.length === 0 && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-honey animate-spin" />
            <span className="ml-2 text-gray-500">Loading tasks...</span>
          </div>
        )}

        {error && (
          <div className="px-4 py-8 text-center">
            <p className="text-red-500">{error}</p>
            <button
              onClick={() => fetchTasks()}
              className="mt-2 text-honey hover:underline"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && taskTree.length === 0 && (
          <div className="px-4 py-20 text-center">
            <p className="text-gray-400 text-lg">No Honey-Do tasks yet</p>
            <p className="text-gray-400 text-sm mt-1">
              Tap the + button to add one
            </p>
          </div>
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          {groups.map((g) => {
            // A child group is hidden if its parent is collapsed or its
            // parent (or any ancestor) is `done && !showCompleted`.
            const parentHidden = typeof g.parent === 'number' && (
              collapsed.has(g.parent) || hiddenByAncestor.has(g.parent)
            )
            if (parentHidden) return null
            // Items the SortableContext should track: exclude rows that are
            // hidden-by-done so dnd-kit does not see a stale id whose
            // useSortable is not mounted.
            const visibleItems = g.items.filter((id) => !hiddenByAncestor.has(id))
            if (visibleItems.length === 0) return null
            return (
              <SortableContext
                key={String(g.parent)}
                items={visibleItems.map((id) => encodeGroupItemId(g.parent, id))}
                strategy={verticalListSortingStrategy}
              >
                {visibleItems.map((id) => {
                  const node = treeById.get(id)
                  if (!node) return null
                  return (
                    <TaskItem
                      key={`${g.parent}::${id}`}
                      task={node}
                      sortableId={encodeGroupItemId(g.parent, id)}
                      depth={node.depth}
                      hasChildren={node.children.length > 0}
                      collapsed={collapsed.has(id)}
                      onToggleCollapse={handleToggleCollapse}
                      onToggleDone={handleToggleDone}
                      onUpdateTitle={handleUpdateTitle}
                      showCompleted={showCompleted}
                    />
                  )
                })}
              </SortableContext>
            )
          })}
        </DndContext>
      </main>

      {/* FAB */}
      <FAB onCreate={handleCreateTask} />
    </div>
  )
}
