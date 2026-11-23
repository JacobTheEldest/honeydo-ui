import { useEffect, useState, useCallback, useMemo, useReducer, useRef, Fragment, type ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { Eye, EyeOff, Loader2, ChevronsDownUp, ChevronsUpDown, Sun, Moon, User } from 'lucide-react'
import { useVikunjaApi } from './hooks/useVikunjaApi.ts'
import { useUndoableActions } from './hooks/useUndoableActions.ts'
import { useDarkMode } from './hooks/useDarkMode.ts'
import { useTaskDragAndDrop } from './hooks/useTaskDragAndDrop.ts'
import { usePullToRefresh } from './hooks/usePullToRefresh.ts'
import TaskItem from './components/TaskItem.tsx'
import TaskSubtreePreview from './components/TaskSubtreePreview.tsx'
import TaskComposer from './components/TaskComposer.tsx'
import UnassignConfirmDialog from './components/UnassignConfirmDialog.tsx'
import DeleteConfirmDialog from './components/DeleteConfirmDialog.tsx'
import FAB from './components/FAB.tsx'
import { composerReducer, initialComposerState } from './utils/composerState.ts'
import {
  positionToDueDate,
  dueDateToPosition,
  getSequentialPosition,
  getTopPosition,
} from './utils/ordering.ts'
import {
  buildTree,
  collectParentIds,
  encodeGroupItemId,
  ROOT_PARENT,
  type TaskTreeNode,
  type ParentScope,
} from './utils/taskTree.ts'
import { countDescendants, planUnassign, type UnassignDecision } from './utils/unlabel.ts'
import { planDelete, type DeleteDecision, type DeleteScope } from './utils/delete.ts'
import { HONEYDO_ASSIGNEE_ID, DEFAULT_PROJECT_ID } from './config.ts'

function findNode(nodes: TaskTreeNode[], id: number): TaskTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const child = findNode(node.children, id)
    if (child) return child
  }
  return null
}

export default function App() {
  const {
    users,
    tasks,
    loading,
    error,
    fetchTasks,
    fetchUsers,
    createTask,
    createSubtask,
    deleteTask,
    updateTask,
    persistTaskOrdering,
    changeTaskParent,
    assignUserToTask,
    unassignFromHoneyDo,
    restoreTask,
    addSubtaskRelation,
  } = useVikunjaApi()

  const { dark, toggle: toggleDarkMode } = useDarkMode()
  const [showCompleted, setShowCompleted] = useState(false)
  const [assigneeId, setAssigneeId] = useState<number | undefined>(HONEYDO_ASSIGNEE_ID)
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set())
  const [openTaskMenuId, setOpenTaskMenuId] = useState<number | null>(null)
  const [unassignRequest, setUnassignRequest] = useState<{ taskId: number; busy: boolean } | null>(null)
  const [deleteRequest, setDeleteRequest] = useState<number | null>(null)
  const createdPositionsRef = useRef(new Map<number, { parentId: number | null; position: number }>())
  const [composerState, composerDispatch] = useReducer(composerReducer, initialComposerState)

  // Fetch users on mount for the user dropdown
  useEffect(() => {
    fetchUsers().catch(() => {})
  }, [fetchUsers])

  // Fetch tasks on mount, filtered by the default assignee
  useEffect(() => {
    fetchTasks(assigneeId).catch(() => {})
  }, [fetchTasks, assigneeId])

  const byId = useMemo<Map<number, import('./types/vikunja.ts').VikunjaTask>>(() => {
    const m = new Map<number, import('./types/vikunja.ts').VikunjaTask>()
    for (const t of tasks) m.set(t.id, t)
    return m
  }, [tasks])

  const selectedUser = users.find((u) => u.id === assigneeId)

  // Stable handlers
  const {
    handleToggleDone,
    handleUpdateTitle,
    handleDelete,
    undo,
    notify,
    toast,
    pendingDeleteIds,
    toastHandlers,
  } = useUndoableActions({ byId, updateTask, deleteTask, restoreTask, addSubtaskRelation, refresh: fetchTasks })

  // Tasks hidden behind a pending delete stay out of the tree — including
  // through refetches — until the server deletes settle, so Undo can restore
  // them exactly and a refetch cannot resurrect them before the commit.
  const activeTasks = useMemo(
    () => pendingDeleteIds.size === 0
      ? tasks
      : tasks.filter((task) => !pendingDeleteIds.has(task.id)),
    [tasks, pendingDeleteIds]
  )

  // Tree of all tasks assigned to the selected user. Children without an
  // assignee are pulled in transitively via related_tasks.subtask.
  const taskTree = useMemo<TaskTreeNode[]>(() => {
    return buildTree(activeTasks, assigneeId)
  }, [activeTasks, assigneeId])

  // Hidden ancestor ids: any node whose ancestor is `done && !showCompleted`
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

  const handleAddSubtask = useCallback((parentId: number) => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      next.delete(parentId)
      return next
    })
    composerDispatch({
      type: 'openAt',
      placement: { parentId, beforeTaskId: null, afterTaskId: null },
    })
  }, [])

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

  const handleMenuOpenChange = useCallback((taskId: number, open: boolean) => {
    setOpenTaskMenuId((current) => open ? taskId : current === taskId ? null : current)
  }, [])

  const unassignNode = useMemo<TaskTreeNode | null>(() => {
    return unassignRequest === null ? null : findNode(taskTree, unassignRequest.taskId)
  }, [unassignRequest, taskTree])

  const handleUnassignOpen = useCallback((taskId: number) => {
    setOpenTaskMenuId(null)
    setUnassignRequest({ taskId, busy: false })
  }, [])

  const handleUnassignDecision = useCallback(async (decision: UnassignDecision) => {
    if (decision.type === 'cancel') {
      setUnassignRequest(null)
      return
    }
    const node = unassignNode
    if (!node || unassignRequest === null || unassignRequest.busy || assigneeId === undefined) return
    const plan = planUnassign(decision, node, assigneeId)
    if (!plan) {
      setUnassignRequest(null)
      return
    }
    setUnassignRequest((current) => current === null ? null : { ...current, busy: true })
    try {
      await unassignFromHoneyDo(plan)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not unassign this task.')
    } finally {
      setUnassignRequest(null)
    }
  }, [unassignNode, unassignRequest, assigneeId, unassignFromHoneyDo, notify])

  const deleteNode = useMemo<TaskTreeNode | null>(() => {
    return deleteRequest === null ? null : findNode(taskTree, deleteRequest)
  }, [deleteRequest, taskTree])

  const executeDelete = useCallback((node: TaskTreeNode, scope: DeleteScope) => {
    const plan = planDelete({ type: 'confirm', scope }, node)
    if (plan) handleDelete(plan)
  }, [handleDelete])

  const handleDeleteOpen = useCallback((taskId: number) => {
    setOpenTaskMenuId(null)
    const node = findNode(taskTree, taskId)
    if (!node) return
    if (countDescendants(node) === 0) {
      // Leaf tasks skip the dialog; the undo toast is the recovery affordance.
      executeDelete(node, 'task')
      return
    }
    setDeleteRequest(taskId)
  }, [taskTree, executeDelete])

  const handleDeleteDecision = useCallback((decision: DeleteDecision) => {
    const node = deleteNode
    setDeleteRequest(null)
    if (decision.type === 'cancel' || !node) return
    executeDelete(node, decision.scope)
  }, [deleteNode, executeDelete])

  const handleCreateTask = useCallback(
    async (title: string, placement: import('./utils/composerState.ts').ComposerPlacement) => {
      const parent = placement.parentId === null ? undefined : byId.get(placement.parentId)
      const siblingIds = placement.parentId === null
        ? taskTree.map((node) => node.id)
        : (() => {
            const find = (nodes: TaskTreeNode[]): TaskTreeNode | undefined => {
              for (const node of nodes) {
                if (node.id === placement.parentId) return node
                const found = find(node.children)
                if (found) return found
              }
              return undefined
            }
            return find(taskTree)?.children.map((node) => node.id) ?? []
          })()
      const beforeIndex = placement.beforeTaskId === null ? -1 : siblingIds.indexOf(placement.beforeTaskId)
      const beforeTask = byId.get(placement.beforeTaskId ?? -1)
      const afterTask = byId.get(placement.afterTaskId ?? -1)
      const firstTask = byId.get(siblingIds[0] ?? -1)
      const lastTask = byId.get(siblingIds[siblingIds.length - 1] ?? -1)
      const createdPositions = createdPositionsRef.current
      const createdAfter = placement.afterTaskId === null ? undefined : createdPositions.get(placement.afterTaskId)
      const createdBefore = placement.beforeTaskId === null ? undefined : createdPositions.get(placement.beforeTaskId)
      const isSequentialInsertion = createdAfter?.parentId === placement.parentId
      const createdSiblingPositions = [...createdPositions.entries()]
        .filter(([, entry]) => entry.parentId === placement.parentId)
        .map(([, entry]) => entry.position)
      const effectiveLastPosition = Math.max(
        lastTask ? dueDateToPosition(lastTask.due_date) : -Infinity,
        ...createdSiblingPositions
      )
      let position: number
      if (isSequentialInsertion && createdAfter) {
        const siblingPositions = [
          ...siblingIds.map((id) => {
            const cached = createdPositions.get(id)
            const sibling = byId.get(id)
            return cached?.position ?? (sibling ? dueDateToPosition(sibling.due_date) : NaN)
          }),
          ...createdSiblingPositions,
        ]
        position = getSequentialPosition(createdAfter.position, siblingPositions)
      } else if (placement.beforeTaskId !== null && beforeTask) {
        const nextPosition = dueDateToPosition(beforeTask.due_date)
        const previousTask = beforeIndex > 0 ? byId.get(siblingIds[beforeIndex - 1]) : undefined
        position = previousTask
          ? (dueDateToPosition(previousTask.due_date) + nextPosition) / 2
          : nextPosition - 1
      } else if (placement.afterTaskId !== null && afterTask) {
        const previousPosition = dueDateToPosition(afterTask.due_date)
        const afterIndex = siblingIds.indexOf(placement.afterTaskId)
        const nextTask = byId.get(siblingIds[afterIndex + 1] ?? -1)
        position = nextTask
          ? (previousPosition + dueDateToPosition(nextTask.due_date)) / 2
          : previousPosition + 1
      } else if (placement.parentId !== null && createdBefore) {
        position = createdBefore.position - 1
      } else if (placement.parentId !== null && firstTask) {
        position = dueDateToPosition(firstTask.due_date) - 1
      } else if (placement.parentId !== null) {
        position = Number.isFinite(effectiveLastPosition) ? effectiveLastPosition + 1 : 0
      } else {
        const rootPositions = taskTree.map((root) => dueDateToPosition(root.due_date)).filter(Number.isFinite)
        position = Math.min(getTopPosition(), ...rootPositions) - 1
      }
      if (parent && createdSiblingPositions.length > 0 && !beforeTask && !afterTask && !isSequentialInsertion) {
        position = Math.max(position, effectiveLastPosition + 1)
      }
      if (!parent && createdSiblingPositions.length > 0 && !beforeTask && !afterTask && !isSequentialInsertion) {
        position = effectiveLastPosition + 1
      }
      if (!parent && assigneeId === undefined) {
        throw new Error('No user is selected. Select a user before adding a task.')
      }
      const createdTask = parent
        ? await createSubtask({ title, project_id: parent.project_id, due_date: positionToDueDate(position) }, parent.id)
        : await createTask({ title, project_id: DEFAULT_PROJECT_ID, due_date: positionToDueDate(position) })
      createdPositionsRef.current.set(createdTask.id, { parentId: placement.parentId, position })
      const task = createdTask
      if (!parent && assigneeId !== undefined) {
        try {
          await assignUserToTask(task.id, assigneeId)
        } catch (error) {
          await fetchTasks(assigneeId).catch(() => {})
          throw error
        }
      }
      return task.id
    },
    [byId, taskTree, createTask, createSubtask, assigneeId, assignUserToTask, fetchTasks]
  )

  const dragAndDrop = useTaskDragAndDrop({
    tasks: activeTasks,
    taskTree,
    collapsed,
    setCollapsed,
    composerDispatch,
    assigneeId,
    persistTaskOrdering,
    changeTaskParent,
    notify,
  })

  const composerPreviewNode = useMemo<TaskTreeNode>(() => ({
    id: -1,
    title: composerState.title.trim() || 'New task',
    description: '',
    done: false,
    done_at: null,
    due_date: null,
    project_id: DEFAULT_PROJECT_ID,
    assignees: [],
    labels: [],
    created: '',
    updated: '',
    children: [],
    depth: 0,
  }), [composerState.title])
  const dragPreviewNode = dragAndDrop.activeNode ?? (dragAndDrop.isComposerDragging ? composerPreviewNode : null)

  const { mainRef, pullDistance, isRefreshing, bindPull, rememberPullOrigin } = usePullToRefresh(fetchTasks)

  const allCollapsed = collapsed.size > 0

  // Recursive tree walker: renders each sibling group in its own
  // <SortableContext>, then immediately recurses into each node's children.
  // This keeps subtasks directly beneath their parent, in tree order.
  const renderNodes = (
    nodes: TaskTreeNode[],
    parentScope: ParentScope,
    ancestorDragging = false,
    baseDepth = 0
  ): ReactNode => {
    const visible = nodes.filter((n) => !hiddenByAncestor.has(n.id))
    const parentId = parentScope === ROOT_PARENT ? null : parentScope
    const placement = composerState.placement
    const placementMatches = composerState.open && placement.parentId === parentId
    const beforeIndex = placement.beforeTaskId === null ? -1 : visible.findIndex((node) => node.id === placement.beforeTaskId)
    const afterIndex = placement.afterTaskId === null ? -1 : visible.findIndex((node) => node.id === placement.afterTaskId)
    const insertionIndex = beforeIndex >= 0 ? beforeIndex : afterIndex >= 0 ? afterIndex + 1 : 0
    const drop = dragAndDrop.dropPreview
    const dropMatches = drop !== null && drop.parentId === parentId && dragPreviewNode !== null
    const dropBeforeIndex = drop?.beforeTaskId == null ? -1 : visible.findIndex((node) => node.id === drop.beforeTaskId)
    const dropAfterIndex = drop?.afterTaskId == null ? -1 : visible.findIndex((node) => node.id === drop.afterTaskId)
    const requestedDropIndex = dropBeforeIndex >= 0 ? dropBeforeIndex : dropAfterIndex >= 0 ? dropAfterIndex + 1 : 0
    const dropIndex = dropMatches ? requestedDropIndex : -1
    if (visible.length === 0 && !placementMatches && !dropMatches) return null
    const renderDropPreview = () => dropMatches && drop && dragPreviewNode ? (
      <TaskSubtreePreview
        node={dragPreviewNode}
        collapsed={collapsed}
        baseDepth={drop.baseDepth}
        placeholder
        dropMode={drop.mode}
      />
    ) : null
    return (
      <SortableContext
        key={String(parentScope)}
        items={visible.map((n) => encodeGroupItemId(parentScope, n.id))}
        strategy={verticalListSortingStrategy}
      >
        {dropIndex === 0 && renderDropPreview()}
        {placementMatches && insertionIndex === 0 && (
          <TaskComposer state={composerState} dispatch={composerDispatch} onCreate={handleCreateTask} depth={baseDepth} />
        )}
        {visible.map((node, index) => {
          const isCollapsed = collapsed.has(node.id)
          const isActive = dragAndDrop.activeTaskId === node.id
          const subtreeIsDragging = ancestorDragging || isActive
          const childDropPreview = drop?.mode === 'child' && drop.parentId === node.id
          const childComposerOpen = composerState.open && placement.parentId === node.id
          return (
            <Fragment key={`${parentScope}:${node.id}`}>
              {dropIndex === index && index > 0 && renderDropPreview()}
              {placementMatches && insertionIndex === index && index > 0 && (
                <TaskComposer state={composerState} dispatch={composerDispatch} onCreate={handleCreateTask} depth={baseDepth} />
              )}
              <TaskItem
                task={node}
                sortableId={encodeGroupItemId(parentScope, node.id)}
                depth={node.depth}
                hasChildren={node.children.length > 0}
                collapsed={isCollapsed}
                onToggleCollapse={handleToggleCollapse}
                onToggleDone={handleToggleDone}
                onUpdateTitle={handleUpdateTitle}
                onAddSubtask={handleAddSubtask}
                onUnassign={handleUnassignOpen}
                onDelete={handleDeleteOpen}
                isAssigned={Boolean(node.assignees?.some((a) => a.id === assigneeId))}
                menuOpen={openTaskMenuId === node.id}
                onMenuOpenChange={handleMenuOpenChange}
                showCompleted={showCompleted}
                isInDraggedSubtree={ancestorDragging && !isActive}
                hideDraggedSource={dragAndDrop.activeTaskId !== null && (isActive || ancestorDragging)}
                dragActive={dragAndDrop.activeTaskId !== null}
                parentContext={node.parentContext}
              />
              {!isCollapsed && (node.children.length > 0 || childDropPreview || childComposerOpen) &&
                renderNodes(node.children, node.id, subtreeIsDragging, node.depth + 1)}
              {isCollapsed && (childDropPreview || childComposerOpen) && renderNodes([], node.id, subtreeIsDragging, node.depth + 1)}
            </Fragment>
          )
        })}
        {dropIndex === visible.length && dropIndex !== 0 && renderDropPreview()}
        {placementMatches && insertionIndex === visible.length && insertionIndex !== 0 && (
          <TaskComposer state={composerState} dispatch={composerDispatch} onCreate={handleCreateTask} depth={baseDepth} />
        )}
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
            {/* User dropdown */}
            <div className="relative">
              <button
                onClick={() => {}}
                className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-3 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
                aria-label={selectedUser ? `Assigned to ${selectedUser.name ?? selectedUser.username}` : 'No user selected'}
                aria-haspopup="listbox"
              >
                <User className="w-4 h-4" />
                {selectedUser ? (
                  <span className="truncate max-w-[120px]">{selectedUser.name ?? selectedUser.username}</span>
                ) : (
                  <span className="text-gray-400 truncate max-w-[120px]">Select user</span>
                )}
              </button>
              {/* Simple user list — clicking a user switches the view */}
              <div
                className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 py-1 shadow-lg hidden"
              >
                {users.map((user) => (
                  <button
                    key={user.id}
                    onClick={() => {
                      setAssigneeId(user.id)
                      fetchTasks(user.id).catch(() => {})
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${assigneeId === user.id ? 'bg-gray-100 dark:bg-gray-700 text-honey-dark' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
                  >
                    {user.name ?? user.username}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Task list */}
      <DndContext
        sensors={dragAndDrop.sensors}
        collisionDetection={dragAndDrop.collisionDetection}
        onDragStart={dragAndDrop.onDragStart}
        onDragMove={dragAndDrop.onDragMove}
        onDragOver={dragAndDrop.onDragOver}
        onDragCancel={dragAndDrop.onDragCancel}
        onDragEnd={dragAndDrop.onDragEnd}
      >
        <main
        ref={mainRef}
        className="max-w-xl mx-auto pb-24 overscroll-none"
        style={{ transform: `translateY(${pullDistance}px)` }}
        {...bindPull()}
        onPointerDownCapture={rememberPullOrigin}
        onTouchStartCapture={rememberPullOrigin}
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
              onClick={() => fetchTasks(assigneeId)}
              className="mt-2 text-honey hover:underline"
            >
              Retry
            </button>
          </div>
        )}

        {!composerState.open && !loading && !error && taskTree.length === 0 && (
          <div className="px-4 py-20 text-center">
            <p className="text-gray-400 dark:text-gray-500 text-lg">
              {assigneeId === undefined ? 'Select a user to see their tasks' : 'No tasks yet'}
            </p>
            {assigneeId !== undefined && (
              <p className="text-gray-400 dark:text-gray-500 text-sm mt-1">
                Tap the + button to add one
              </p>
            )}
          </div>
        )}

        {renderNodes(taskTree, ROOT_PARENT)}
      </main>
      <DragOverlay dropAnimation={null}>
        {dragAndDrop.activeNode ? <TaskSubtreePreview node={dragAndDrop.activeNode} collapsed={collapsed} /> : null}
      </DragOverlay>
      </DndContext>

      {unassignRequest && unassignNode && (
        <UnassignConfirmDialog
          taskTitle={unassignNode.title}
          descendantCount={countDescendants(unassignNode)}
          busy={unassignRequest.busy}
          onCancel={() => handleUnassignDecision({ type: 'cancel' })}
          onConfirm={(scope) => handleUnassignDecision({ type: 'confirm', scope })}
          returnFocusSelector={`[data-task-id="${unassignRequest.taskId}"] button[aria-label="Task actions"]`}
        />
      )}

      {deleteRequest !== null && deleteNode && (
        <DeleteConfirmDialog
          taskTitle={deleteNode.title}
          descendantCount={countDescendants(deleteNode)}
          busy={false}
          onCancel={() => handleDeleteDecision({ type: 'cancel' })}
          onConfirm={(scope) => handleDeleteDecision({ type: 'confirm', scope })}
          returnFocusSelector={`[data-task-id="${deleteRequest}"] button[aria-label="Task actions"]`}
        />
      )}

      {toast && (
        <div
          role="status"
          aria-live="polite"
          data-toast
          {...toastHandlers}
          className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-800 shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 max-w-[calc(100vw-2rem)]"
        >
          <span>{toast.message}</span>
          {toast.undoTaskId !== undefined && (
            <button
              type="button"
              onClick={() => {
                if (toast.undoTaskId !== undefined) undo(toast.undoTaskId)
              }}
              className="shrink-0 min-h-11 rounded-lg bg-honey px-4 py-2.5 text-sm font-semibold text-white hover:bg-honey-dark focus-visible:ring-2 focus-visible:ring-honey-dark focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800"
            >
              Undo
            </button>
          )}
        </div>
      )}

      {/* FAB */}
      <FAB
        open={composerState.open}
        onToggle={() => composerDispatch({ type: composerState.open ? 'close' : 'open' })}
      />
    </div>
  )
}
