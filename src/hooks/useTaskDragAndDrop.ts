import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import {
  closestCenter,
  pointerWithin,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import type { VikunjaTask } from '../types/vikunja.ts'
import { HONEYDO_LABEL } from '../config.ts'
import type { ComposerEvent } from '../utils/composerState.ts'
import type { ParentChange } from '../utils/hierarchyMutations.ts'
import {
  dueDateToPosition,
  getMidpointPosition,
  getTopPosition,
  needsRebalance,
  positionToDueDate,
  rebalancePositions,
} from '../utils/ordering.ts'
import {
  decodeGroupItemId,
  encodeGroupItemId,
  ROOT_PARENT,
  type ParentScope,
  type TaskTreeNode,
} from '../utils/taskTree.ts'
import { canNestUnder, canPromoteToRoot, isSelfOrDescendant } from '../utils/hierarchyMutations.ts'

export const ROOT_DROP_ID = 'root-promote'

type SiblingGroup = { parent: ParentScope; items: number[] }
type ReorderDrop = { taskId: number; edge: 'before' | 'after' } | null

interface UseTaskDragAndDropOptions {
  tasks: VikunjaTask[]
  taskTree: TaskTreeNode[]
  collapsed: Set<number>
  setCollapsed: Dispatch<SetStateAction<Set<number>>>
  composerDispatch: Dispatch<ComposerEvent>
  honeyDoLabelId: number | null
  persistTaskOrdering: (updates: Array<{ task: VikunjaTask; due_date: string }>) => Promise<void>
  changeTaskParent: (change: ParentChange) => Promise<void>
  notify: (message: string) => void
}

function findNode(nodes: TaskTreeNode[], id: number): TaskTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const child = findNode(node.children, id)
    if (child) return child
  }
  return null
}

export function useTaskDragAndDrop({
  tasks,
  taskTree,
  collapsed,
  setCollapsed,
  composerDispatch,
  honeyDoLabelId,
  persistTaskOrdering,
  changeTaskParent,
  notify,
}: UseTaskDragAndDropOptions) {
  const [activeTaskId, setActiveTaskId] = useState<number | null>(null)
  const [isComposerDragging, setIsComposerDragging] = useState(false)
  const [nestPreviewTargetId, setNestPreviewTargetId] = useState<number | null>(null)
  const dragStartRectsRef = useRef<Map<string, DOMRectReadOnly>>(new Map())
  const lastCollisionIdRef = useRef<string | null>(null)
  const reorderDropRef = useRef<ReorderDrop>(null)
  const expansionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const expansionTargetRef = useRef<number | null>(null)
  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])

  const groups = useMemo<SiblingGroup[]>(() => {
    const result: SiblingGroup[] = [{ parent: ROOT_PARENT, items: taskTree.map((root) => root.id) }]
    const visit = (node: TaskTreeNode) => {
      if (node.children.length > 0) {
        result.push({ parent: node.id, items: node.children.map((child) => child.id) })
      }
      node.children.forEach(visit)
    }
    taskTree.forEach(visit)
    return result
  }, [taskTree])

  const groupBySortableId = useMemo(() => {
    const result = new Map<string, SiblingGroup>()
    for (const group of groups) {
      for (const taskId of group.items) {
        result.set(encodeGroupItemId(group.parent, taskId), group)
      }
    }
    return result
  }, [groups])

  const activeNode = useMemo(() => activeTaskId === null ? null : findNode(taskTree, activeTaskId), [activeTaskId, taskTree])
  const activeParentIds = activeNode?.related_tasks?.parenttask?.map((parent) => parent.id) ?? []
  const activeParent = activeParentIds.length === 1 ? byId.get(activeParentIds[0]) : undefined
  const canPromoteActiveTaskToRoot = Boolean(
    activeNode &&
    honeyDoLabelId !== null &&
    canPromoteToRoot(activeNode, activeParent, HONEYDO_LABEL)
  )

  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const remember = (collisions: ReturnType<typeof pointerWithin>) => {
      lastCollisionIdRef.current = collisions[0] ? String(collisions[0].id) : null
      return collisions
    }

    if (String(args.active.id) === 'task-composer') return remember(pointerWithin(args))

    // Nest zones move with their rows. Use the drag-start layout for all
    // position-sensitive collisions so sortable transforms cannot make the
    // nesting target jump between rows under a stationary pointer.
    const startGeometry = args.droppableContainers.map((container) => {
      const rect = dragStartRectsRef.current.get(String(container.id))
      return rect ? { ...container, rect: { current: rect } } : container
    })
    const stableHits = pointerWithin({ ...args, droppableContainers: startGeometry })
    const rootHits = stableHits.filter((collision) => String(collision.id) === ROOT_DROP_ID)
    if (rootHits.length > 0) return remember(rootHits)

    const active = decodeGroupItemId(String(args.active.id))
    const nestHits = stableHits.filter((collision) => String(collision.id).startsWith('nest::'))
    if (nestHits.length > 0) return remember(nestHits)
    if (!active) return remember(closestCenter(args))

    const isSameScope = (id: string | number) => decodeGroupItemId(String(id))?.parent === active.parent
    const sameInitialHits = stableHits.filter((collision) => isSameScope(collision.id))
    if (sameInitialHits.length > 0) return remember(sameInitialHits)
    if (stableHits.length > 0) return remember(stableHits)

    const currentHits = pointerWithin(args)
    const sameCurrentHits = currentHits.filter((collision) => isSameScope(collision.id))
    if (sameCurrentHits.length > 0) return remember(sameCurrentHits)
    if (currentHits.length > 0) return remember(currentHits)

    const sameScopeContainers = args.droppableContainers.filter((container) => isSameScope(container.id))
    return remember(sameScopeContainers.length > 0
      ? closestCenter({ ...args, droppableContainers: sameScopeContainers })
      : [])
  }, [])

  const handleDragStart = useCallback((event: DragStartEvent) => {
    dragStartRectsRef.current.clear()
    lastCollisionIdRef.current = null
    reorderDropRef.current = null
    setNestPreviewTargetId(null)
    const isComposerDrag = String(event.active.id) === 'task-composer'
    setIsComposerDragging(isComposerDrag)
    if (isComposerDrag) return

    document.querySelectorAll<HTMLElement>('[data-sortable-id], [data-nest-target]').forEach((element) => {
      const id = element.dataset.sortableId ?? (element.dataset.nestTarget ? `nest::${element.dataset.nestTarget}` : null)
      if (id) dragStartRectsRef.current.set(id, element.getBoundingClientRect())
    })
    const decoded = decodeGroupItemId(String(event.active.id))
    setActiveTaskId(decoded?.taskId ?? null)
  }, [])

  const handleDragCancel = useCallback((_event: DragCancelEvent) => {
    if (expansionTimerRef.current) clearTimeout(expansionTimerRef.current)
    expansionTimerRef.current = null
    expansionTargetRef.current = null
    dragStartRectsRef.current.clear()
    lastCollisionIdRef.current = null
    reorderDropRef.current = null
    setNestPreviewTargetId(null)
    setIsComposerDragging(false)
    setActiveTaskId(null)
  }, [])

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const overId = event.over ? String(event.over.id) : ''
    const nestId = overId.startsWith('nest::') ? Number(overId.slice('nest::'.length)) : null
    const isComposerDrag = String(event.active.id) === 'task-composer'
    const dragged = isComposerDrag ? null : decodeGroupItemId(String(event.active.id))
    const activeNode = dragged ? findNode(taskTree, dragged.taskId) : null
    const targetNode = nestId === null ? null : findNode(taskTree, nestId)
    const validNestTarget =
      nestId !== null &&
      Number.isFinite(nestId) &&
      activeNode !== null &&
      targetNode !== null &&
      canNestUnder(activeNode, nestId)
    const nextPreviewTarget = isComposerDrag
      ? (nestId !== null && targetNode ? nestId : null)
      : validNestTarget ? nestId : null
    setNestPreviewTargetId((current) => current === nextPreviewTarget ? current : nextPreviewTarget)

    if (nestId !== expansionTargetRef.current) {
      if (expansionTimerRef.current) clearTimeout(expansionTimerRef.current)
      expansionTimerRef.current = null
      expansionTargetRef.current = nestId
      if (nestId !== null && collapsed.has(nestId)) {
        expansionTimerRef.current = setTimeout(() => {
          setCollapsed((previous) => {
            const next = new Set(previous)
            next.delete(nestId)
            return next
          })
          expansionTimerRef.current = null
        }, 600)
      }
    }

    if (!event.over || !overId || overId === ROOT_DROP_ID || overId.startsWith('nest::')) {
      reorderDropRef.current = null
      return
    }
    const active = isComposerDrag ? null : decodeGroupItemId(String(event.active.id))
    const over = decodeGroupItemId(overId)
    if (!over || (!isComposerDrag && (!active || active.parent !== over.parent || active.taskId === over.taskId))) {
      reorderDropRef.current = null
      return
    }

    const source = event.activatorEvent as Event & {
      clientY?: number
      touches?: TouchList
      changedTouches?: TouchList
    }
    const startY = source.touches?.[0]?.clientY ?? source.changedTouches?.[0]?.clientY ?? source.clientY
    const translatedRect = event.active.rect.current.translated
    const pointerY = startY === undefined
      ? (translatedRect ? translatedRect.top + translatedRect.height / 2 : event.over.rect.top + event.over.rect.height / 2)
      : startY + event.delta.y
    reorderDropRef.current = {
      taskId: over.taskId,
      edge: pointerY < event.over.rect.top + event.over.rect.height / 2 ? 'before' : 'after',
    }
  }, [collapsed, setCollapsed, taskTree])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const activeId = String(event.active.id)
    const effectiveOverId = lastCollisionIdRef.current ?? (event.over ? String(event.over.id) : null)
    const currentReorderDrop = reorderDropRef.current
    if (expansionTimerRef.current) clearTimeout(expansionTimerRef.current)
    expansionTimerRef.current = null
    expansionTargetRef.current = null
    dragStartRectsRef.current.clear()
    lastCollisionIdRef.current = null
    reorderDropRef.current = null
    setNestPreviewTargetId(null)
    setIsComposerDragging(false)

    if (activeId === 'task-composer') {
      if (!effectiveOverId) return
      if (effectiveOverId.startsWith('nest::')) {
        const parentId = Number(effectiveOverId.slice('nest::'.length))
        if (!Number.isFinite(parentId) || !byId.has(parentId)) return
        setCollapsed((previous) => {
          const next = new Set(previous)
          next.delete(parentId)
          return next
        })
        composerDispatch({ type: 'move', placement: { parentId, beforeTaskId: null, afterTaskId: null } })
        return
      }
      const target = decodeGroupItemId(effectiveOverId)
      if (!target) return
      const group = groupBySortableId.get(effectiveOverId)
      const targetIndex = group?.items.indexOf(target.taskId) ?? -1
      const after = currentReorderDrop?.taskId === target.taskId
        ? currentReorderDrop.edge === 'after'
        : (() => {
            const translatedRect = event.active.rect.current.translated
            const pointerY = translatedRect
              ? translatedRect.top + translatedRect.height / 2
              : event.over
                ? event.over.rect.top + event.over.rect.height / 2
                : 0
            return Boolean(event.over && pointerY >= event.over.rect.top + event.over.rect.height / 2)
          })()
      const beforeTaskId = after ? (group?.items[targetIndex + 1] ?? null) : target.taskId
      const afterTaskId = after ? target.taskId : (group?.items[targetIndex - 1] ?? null)
      composerDispatch({
        type: 'move',
        placement: {
          parentId: target.parent === ROOT_PARENT ? null : target.parent,
          beforeTaskId,
          afterTaskId,
        },
      })
      return
    }

    const activeDecoded = decodeGroupItemId(activeId)
    setActiveTaskId(null)
    if (!activeDecoded || !effectiveOverId) return
    const task = byId.get(activeDecoded.taskId)
    if (!task) return

    if (effectiveOverId === ROOT_DROP_ID) {
      const oldParentIds = task.related_tasks?.parenttask?.map((parentTask) => parentTask.id) ?? []
      const oldParentId = oldParentIds[0] ?? null
      if (oldParentId === null) return
      const parent = byId.get(oldParentId)
      if (oldParentIds.length !== 1 || !canPromoteToRoot(task, parent, HONEYDO_LABEL)) {
        notify('This task can only be promoted when its direct parent is a Honey-Do task.')
        return
      }
      if (honeyDoLabelId === null) {
        notify('The Honey-Do label is unavailable. Refresh the task list and try again.')
        return
      }
      const rootPositions = taskTree.map((root) => dueDateToPosition(root.due_date)).filter(Number.isFinite)
      const labelIdToAdd = task.labels?.some((label) => label.id === honeyDoLabelId) ? undefined : honeyDoLabelId
      changeTaskParent({
        taskId: task.id,
        oldParentId,
        oldParentIds,
        newParentId: null,
        oldDueDate: task.due_date,
        newDueDate: positionToDueDate(Math.min(getTopPosition(), ...rootPositions) - 1),
        labelIdToAdd,
      }).catch((error: unknown) => notify(error instanceof Error ? error.message : 'Could not promote this task. Try again.'))
      return
    }

    if (effectiveOverId.startsWith('nest::')) {
      const targetId = Number(effectiveOverId.slice('nest::'.length))
      if (!Number.isFinite(targetId)) return
      const activeNode = findNode(taskTree, task.id)
      const targetNode = findNode(taskTree, targetId)
      if (activeNode && isSelfOrDescendant(activeNode, targetId)) {
        notify('A task cannot be moved under itself or one of its subtasks.')
        return
      }
      if (!byId.has(targetId) || !targetNode) return
      const oldParentId = task.related_tasks?.parenttask?.[0]?.id ?? null
      if (oldParentId === targetId) return
      const siblingPositions = targetNode.children.map((child) => dueDateToPosition(child.due_date)).filter(Number.isFinite)
      changeTaskParent({
        taskId: task.id,
        oldParentId,
        oldParentIds: task.related_tasks?.parenttask?.map((parentTask) => parentTask.id) ?? [],
        newParentId: targetId,
        oldDueDate: task.due_date,
        newDueDate: positionToDueDate((siblingPositions.length > 0 ? Math.max(...siblingPositions) : 0) + 1),
      }).then(() => {
        setCollapsed((previous) => {
          const next = new Set(previous)
          next.delete(targetId)
          return next
        })
      }).catch((error: unknown) => notify(error instanceof Error ? error.message : 'Could not move this task. Check permissions and try again.'))
      return
    }

    const overDecoded = decodeGroupItemId(effectiveOverId)
    if (!overDecoded || activeDecoded.parent !== overDecoded.parent) return
    const group = groupBySortableId.get(activeId)
    if (!group) return
    const oldIndex = group.items.indexOf(activeDecoded.taskId)
    const overIndex = group.items.indexOf(overDecoded.taskId)
    if (oldIndex === -1 || overIndex === -1 || oldIndex === overIndex) return
    const reorderedIds = arrayMove(group.items, oldIndex, overIndex)
    const orderedTasks = reorderedIds.map((id) => byId.get(id)).filter((sibling): sibling is VikunjaTask => Boolean(sibling))
    const positions = orderedTasks.map((sibling) => dueDateToPosition(sibling.due_date))
    if (needsRebalance(positions)) {
      const positionsAfterRebalance = rebalancePositions(orderedTasks.length)
      persistTaskOrdering(orderedTasks.map((sibling, index) => ({
        task: sibling,
        due_date: positionToDueDate(positionsAfterRebalance[index]),
      }))).catch((error: unknown) => notify(error instanceof Error ? error.message : 'Could not save this order. Refresh and try again.'))
      return
    }

    const newIndex = reorderedIds.indexOf(activeDecoded.taskId)
    let newPosition: number
    if (newIndex === 0) {
      newPosition = group.parent === ROOT_PARENT
        ? getTopPosition()
        : dueDateToPosition(orderedTasks[1]?.due_date ?? null) - 1
    } else if (newIndex === orderedTasks.length - 1) {
      newPosition = dueDateToPosition(orderedTasks[newIndex - 1].due_date) + 1
    } else {
      newPosition = getMidpointPosition(
        dueDateToPosition(orderedTasks[newIndex - 1].due_date),
        dueDateToPosition(orderedTasks[newIndex + 1].due_date)
      )
    }
    persistTaskOrdering([{ task: orderedTasks[newIndex], due_date: positionToDueDate(newPosition) }])
      .catch((error: unknown) => notify(error instanceof Error ? error.message : 'Could not save this order. Refresh and try again.'))
  }, [
    byId,
    changeTaskParent,
    composerDispatch,
    groupBySortableId,
    honeyDoLabelId,
    notify,
    persistTaskOrdering,
    setCollapsed,
    taskTree,
  ])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  return {
    activeTaskId,
    activeNode,
    isComposerDragging,
    canPromoteActiveTaskToRoot,
    nestPreviewTargetId,
    sensors,
    collisionDetection,
    onDragStart: handleDragStart,
    onDragOver: handleDragOver,
    onDragCancel: handleDragCancel,
    onDragEnd: handleDragEnd,
  }
}
