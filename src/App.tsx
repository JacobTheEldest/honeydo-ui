import { useEffect, useState, useCallback, useMemo, useRef, Fragment, type ReactNode } from 'react'
import { useDrag } from '@use-gesture/react'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  pointerWithin,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
  type CollisionDetection,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { Eye, EyeOff, Loader2, ChevronsDownUp, ChevronsUpDown, Sun, Moon } from 'lucide-react'
import { useVikunjaApi } from './hooks/useVikunjaApi.ts'
import { useDarkMode } from './hooks/useDarkMode.ts'
import TaskItem from './components/TaskItem.tsx'
import TaskSubtreePreview from './components/TaskSubtreePreview.tsx'
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
    persistTaskOrdering,
    addLabelToTask,
    createLabel,
  } = useVikunjaApi()

  const { dark, toggle: toggleDarkMode } = useDarkMode()
  const [showCompleted, setShowCompleted] = useState(false)
  const [honeyDoLabelId, setHoneyDoLabelId] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set())
  const [activeTaskId, setActiveTaskId] = useState<number | null>(null)
  const dragStartRectsRef = useRef<Map<string, DOMRectReadOnly>>(new Map())
  const lastCollisionIdRef = useRef<string | null>(null)

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

  const activeNode = useMemo<TaskTreeNode | null>(() => {
    if (activeTaskId === null) return null
    const find = (nodes: TaskTreeNode[]): TaskTreeNode | null => {
      for (const node of nodes) {
        if (node.id === activeTaskId) return node
        const child = find(node.children)
        if (child) return child
      }
      return null
    }
    return find(taskTree)
  }, [activeTaskId, taskTree])

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

  const siblingGroupCollisionDetection = useCallback<CollisionDetection>((args) => {
    const remember = (collisions: ReturnType<typeof pointerWithin>) => {
      lastCollisionIdRef.current = collisions[0] ? String(collisions[0].id) : null
      return collisions
    }

    const active = decodeGroupItemId(String(args.active.id))
    if (!active) return remember(closestCenter(args))

    const isSameScope = (id: string | number) => {
      const decoded = decodeGroupItemId(String(id))
      return decoded?.parent === active.parent
    }

    // Use drag-start geometry first. Sortable transforms can move rows from
    // other nested groups under the pointer during a drag; their original
    // location still identifies an attempted cross-scope drop correctly.
    const initialContainers = args.droppableContainers.map((container) => {
      const rect = dragStartRectsRef.current.get(String(container.id))
      return rect ? { ...container, rect: { current: rect } } : container
    })
    const initialHits = pointerWithin({ ...args, droppableContainers: initialContainers })
    const sameInitialHits = initialHits.filter((collision) => isSameScope(collision.id))
    if (sameInitialHits.length > 0) return remember(sameInitialHits)
    if (initialHits.length > 0) return remember(initialHits)

    const currentHits = pointerWithin(args)
    const sameCurrentHits = currentHits.filter((collision) => isSameScope(collision.id))
    if (sameCurrentHits.length > 0) return remember(sameCurrentHits)
    if (currentHits.length > 0) return remember(currentHits)

    const sameScopeContainers = args.droppableContainers.filter((container) =>
      isSameScope(container.id)
    )
    return remember(sameScopeContainers.length > 0
      ? closestCenter({ ...args, droppableContainers: sameScopeContainers })
      : [])
  }, [])

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

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const decoded = decodeGroupItemId(String(event.active.id))
    const rects = new Map<string, DOMRectReadOnly>()
    document.querySelectorAll<HTMLElement>('[data-sortable-id]').forEach((element) => {
      const id = element.dataset.sortableId
      if (id) rects.set(id, element.getBoundingClientRect())
    })
    dragStartRectsRef.current = rects
    lastCollisionIdRef.current = null
    setActiveTaskId(decoded?.taskId ?? null)
  }, [])

  const handleDragCancel = useCallback(() => {
    dragStartRectsRef.current.clear()
    lastCollisionIdRef.current = null
    setActiveTaskId(null)
  }, [])

  const handleDragOver = useCallback(
    (_event: DragOverEvent) => {
      // Cross-scope drops remain visible as foreign collisions and are rejected
      // by handleDragEnd; the active item never changes groups mid-drag.
    },
    []
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const effectiveOverId = lastCollisionIdRef.current ?? (event.over ? String(event.over.id) : null)
      dragStartRectsRef.current.clear()
      lastCollisionIdRef.current = null
      setActiveTaskId(null)
      const { active } = event
      if (!effectiveOverId || active.id === effectiveOverId) return

      const activeDecoded = decodeGroupItemId(String(active.id))
      const overDecoded = decodeGroupItemId(effectiveOverId)
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

      // The hook applies every due_date position locally before issuing the
      // backend writes, so buildTree reorders immediately and after refetch.
      persistTaskOrdering(updates).catch(() => {})
    },
    [groupBySortableId, byId, persistTaskOrdering]
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

  // Pull-to-refresh on mobile
  const mainRef = useRef<HTMLElement>(null)
  const [pullDistance, setPullDistance] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const pullThreshold = 72
  const pullStartedOnDragHandle = useRef(false)

  const bindPull = useDrag(
    (state) => {
      const { offset, last, first } = state
      const [, dy] = offset

      if (first) {
        // state.target is the element bound to the gesture, not necessarily
        // the original touch target. Inspect the event target and composed
        // path so touches that begin on the handle's child SVG are excluded.
        const event = state.event
        const eventTarget = event.target
        const startedOnHandle =
          (eventTarget instanceof Element && eventTarget.closest('[data-drag-handle]') !== null) ||
          (typeof event.composedPath === 'function' &&
            event.composedPath().some(
              (target) => target instanceof Element && target.closest('[data-drag-handle]') !== null
            ))
        pullStartedOnDragHandle.current = startedOnHandle

        // Only enable pull-to-refresh when scrolled to top.
        const el = mainRef.current
        if (!pullStartedOnDragHandle.current && el && el.scrollTop > 0) return
      }

      // Keep the entire gesture out of pull-to-refresh after a handle start;
      // dnd-kit remains responsible for the same touch sequence.
      if (pullStartedOnDragHandle.current) {
        if (last) pullStartedOnDragHandle.current = false
        return
      }

      if (last) {
        if (dy >= pullThreshold && !isRefreshing) {
          setIsRefreshing(true)
          fetchTasks().catch(() => {}).finally(() => {
            setIsRefreshing(false)
          })
        }
        setPullDistance(0)
      } else {
        // Dampen the pull: move at 1/3 speed, only downward
        const dampened = Math.max(0, dy / 3)
        setPullDistance(dampened)
      }
    },
    {
      axis: 'y',
      from: () => [0, pullDistance],
      filterTaps: true,
      preventScroll: true,
      pointer: { touch: true },
    }
  )

  const allCollapsed = collapsed.size > 0

  // Recursive tree walker: renders each sibling group in its own
  // <SortableContext>, then immediately recurses into each node's children.
  // This keeps subtasks directly beneath their parent, in tree order.
  const renderNodes = (
    nodes: TaskTreeNode[],
    parentScope: ParentScope,
    ancestorDragging = false
  ): ReactNode => {
    const visible = nodes.filter((n) => !hiddenByAncestor.has(n.id))
    if (visible.length === 0) return null
    return (
      <SortableContext
        key={String(parentScope)}
        items={visible.map((n) => encodeGroupItemId(parentScope, n.id))}
        strategy={verticalListSortingStrategy}
      >
        {visible.map((node) => {
          const isCollapsed = collapsed.has(node.id)
          const isActive = activeTaskId === node.id
          const subtreeIsDragging = ancestorDragging || isActive
          return (
            <Fragment key={`${parentScope}:${node.id}`}>
              <TaskItem
                task={node}
                sortableId={encodeGroupItemId(parentScope, node.id)}
                depth={node.depth}
                hasChildren={node.children.length > 0}
                collapsed={isCollapsed}
                onToggleCollapse={handleToggleCollapse}
                onToggleDone={handleToggleDone}
                onUpdateTitle={handleUpdateTitle}
                showCompleted={showCompleted}
                isInDraggedSubtree={ancestorDragging && !isActive}
              />
              {!isCollapsed && node.children.length > 0 &&
                renderNodes(node.children, node.id, subtreeIsDragging)}
            </Fragment>
          )
        })}
      </SortableContext>
    )
  }

  return (
    <div className="min-h-svh bg-white dark:bg-gray-900">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white/90 dark:bg-gray-800/90 backdrop-blur border-b border-gray-100 dark:border-gray-700 px-4 py-3">
        <div className="flex items-center justify-between max-w-xl mx-auto">
          <h1 className="text-xl font-semibold text-honey-dark">HoneyDo</h1>
          <div className="flex items-center gap-1">
            <button
              onClick={toggleDarkMode}
              className="flex items-center justify-center w-8 h-8 text-gray-500 dark:text-gray-300 hover:text-gray-700 dark:hover:text-gray-100 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
              aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {dark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
            <button
              onClick={allCollapsed ? handleExpandAll : handleCollapseAll}
              className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-3 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
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
              className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-3 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
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
      <main
        ref={mainRef}
        className="max-w-xl mx-auto pb-24 overscroll-none"
        style={{ transform: `translateY(${pullDistance}px)` }}
        {...bindPull()}
      >
        <div
          className="flex justify-center transition-all duration-200"
          style={{ height: isRefreshing ? 40 : pullDistance > 0 ? pullDistance : 0 }}
        >
          {(pullDistance > 0 || isRefreshing) && (
            <Loader2
              className={`w-5 h-5 text-honey animate-spin mt-3 ${isRefreshing ? 'opacity-100' : 'opacity-60'}`}
            />
          )}
        </div>
        {loading && tasks.length === 0 && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-honey animate-spin" />
            <span className="ml-2 text-gray-500 dark:text-gray-400">Loading tasks...</span>
          </div>
        )}

        {error && (
          <div className="px-4 py-8 text-center">
            <p className="text-red-500 dark:text-red-400">{error}</p>
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
            <p className="text-gray-400 dark:text-gray-500 text-lg">No Honey-Do tasks yet</p>
            <p className="text-gray-400 dark:text-gray-500 text-sm mt-1">
              Tap the + button to add one
            </p>
          </div>
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={siblingGroupCollisionDetection}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragCancel={handleDragCancel}
          onDragEnd={handleDragEnd}
        >
          {renderNodes(taskTree, ROOT_PARENT)}
          <DragOverlay dropAnimation={null}>
            {activeNode ? <TaskSubtreePreview node={activeNode} collapsed={collapsed} /> : null}
          </DragOverlay>
        </DndContext>
      </main>

      {/* FAB */}
      <FAB onCreate={handleCreateTask} />
    </div>
  )
}
