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
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
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
import { canNestUnder, canPromoteToRoot } from '../utils/hierarchyMutations.ts'

type SiblingGroup = { parent: ParentScope; items: number[] }
type DropPreview = {
  mode: 'sibling' | 'child'
  parentId: number | null
  beforeTaskId: number | null
  afterTaskId: number | null
  baseDepth: number
}
type VisibleDropRow = {
  taskId: number
  sortableId: string
  parent: ParentScope
  node: TaskTreeNode
  rect: DOMRectReadOnly
}

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
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null)
  const dragStartRectsRef = useRef<Map<string, DOMRectReadOnly>>(new Map())
  const dropPreviewRef = useRef<DropPreview | null>(null)
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

  const collisionDetection = useCallback<CollisionDetection>((args) => {
    if (String(args.active.id) === 'task-composer') return pointerWithin(args)

    // The active subtree can never anchor its own drop: filter it out so the
    // destination preview survives while the pointer crosses the collapsed
    // source's old space.
    const excluded = new Set<number>()
    const active = decodeGroupItemId(String(args.active.id))
    const activeNodeForCollision = active ? findNode(taskTree, active.taskId) : null
    const excludeSubtree = (node: TaskTreeNode) => {
      excluded.add(node.id)
      node.children.forEach(excludeSubtree)
    }
    if (activeNodeForCollision) excludeSubtree(activeNodeForCollision)
    const isExcluded = (id: string | number) => {
      const decoded = decodeGroupItemId(String(id))
      return decoded !== null && excluded.has(decoded.taskId)
    }

    // Use drag-start row geometry so the insertion gap is stable even as
    // sortable transforms animate siblings around the moving preview.
    const startGeometry = args.droppableContainers.map((container) => {
      const rect = dragStartRectsRef.current.get(String(container.id))
      return rect ? { ...container, rect: { current: rect } } : container
    })
    const stableHits = pointerWithin({ ...args, droppableContainers: startGeometry })
      .filter((collision) => !isExcluded(collision.id))
    if (!active) return stableHits.length > 0 ? stableHits : pointerWithin(args)

    const isSameScope = (id: string | number) => decodeGroupItemId(String(id))?.parent === active.parent
    const sameInitialHits = stableHits.filter((collision) => isSameScope(collision.id))
    if (sameInitialHits.length > 0) return sameInitialHits
    if (stableHits.length > 0) return stableHits

    const currentHits = pointerWithin(args).filter((collision) => !isExcluded(collision.id))
    const sameCurrentHits = currentHits.filter((collision) => isSameScope(collision.id))
    if (sameCurrentHits.length > 0) return sameCurrentHits
    if (currentHits.length > 0) return currentHits

    // Pointer is over the collapsed source's old space: fall back to the
    // nearest remaining row so the preview never disappears mid-drag.
    const candidates = args.droppableContainers.filter((container) => !isExcluded(container.id))
    const sameScopeContainers = candidates.filter((container) => isSameScope(container.id))
    if (sameScopeContainers.length > 0) return closestCenter({ ...args, droppableContainers: sameScopeContainers })
    return candidates.length > 0 ? closestCenter({ ...args, droppableContainers: candidates }) : []
  }, [taskTree])

  const updateDropPreview = useCallback((event: DragMoveEvent | DragOverEvent) => {
    const setPreview = (next: DropPreview | null) => {
      const current = dropPreviewRef.current
      if (current?.mode === next?.mode && current?.parentId === next?.parentId &&
        current?.beforeTaskId === next?.beforeTaskId && current?.afterTaskId === next?.afterTaskId &&
        current?.baseDepth === next?.baseDepth) return
      dropPreviewRef.current = next
      setDropPreview(next)
    }

    if (!event.over) {
      setPreview(null)
      return
    }

    const activeId = String(event.active.id)
    const isComposer = activeId === 'task-composer'
    const active = isComposer ? null : decodeGroupItemId(activeId)
    const activeNode = active ? findNode(taskTree, active.taskId) : null
    const excludedIds = new Set<number>()
    const excludeSubtree = (node: TaskTreeNode) => {
      excludedIds.add(node.id)
      node.children.forEach(excludeSubtree)
    }
    if (activeNode) excludeSubtree(activeNode)

    const rows: VisibleDropRow[] = Array.from(document.querySelectorAll<HTMLElement>('[data-sortable-id]'))
      .map((element) => {
        const sortableId = element.dataset.sortableId
        const decoded = sortableId ? decodeGroupItemId(sortableId) : null
        const node = decoded ? findNode(taskTree, decoded.taskId) : null
        const rect = sortableId ? (dragStartRectsRef.current.get(sortableId) ?? element.getBoundingClientRect()) : null
        return decoded && node && rect && rect.height > 0 && !excludedIds.has(decoded.taskId)
          ? { taskId: decoded.taskId, sortableId: sortableId!, parent: decoded.parent, node, rect }
          : null
      })
      .filter((row): row is VisibleDropRow => row !== null)

    const overId = String(event.over.id)
    const overDecoded = decodeGroupItemId(overId)
    if (rows.length === 0 || !overDecoded) {
      setPreview(null)
      return
    }

    let overIndex = rows.findIndex((row) => row.sortableId === overId)
    if (overIndex < 0) overIndex = rows.findIndex((row) => row.taskId === overDecoded.taskId)
    if (overIndex < 0) {
      setPreview(null)
      return
    }

    const source = event.activatorEvent as Event & {
      clientX?: number
      clientY?: number
      touches?: TouchList
      changedTouches?: TouchList
    }
    const touch = source.touches?.[0] ?? source.changedTouches?.[0]
    const startX = touch?.clientX ?? source.clientX
    const startY = touch?.clientY ?? source.clientY
    const translatedRect = event.active.rect.current.translated
    const pointerX = startX === undefined
      ? (translatedRect ? translatedRect.left + translatedRect.width / 2 : event.over.rect.left + event.over.rect.width / 2)
      : startX + event.delta.x
    const pointerY = startY === undefined
      ? (translatedRect ? translatedRect.top + translatedRect.height / 2 : event.over.rect.top + event.over.rect.height / 2)
      : startY + event.delta.y
    const targetRect = dragStartRectsRef.current.get(overId) ?? event.over.rect
    const gapIndex = pointerY < targetRect.top + targetRect.height / 2 ? overIndex : overIndex + 1
    const above = rows[gapIndex - 1] ?? null
    const below = rows[gapIndex] ?? null
    const listRect = document.querySelector<HTMLElement>('main')?.getBoundingClientRect()
    const splitX = (listRect?.left ?? event.over.rect.left) + (listRect?.width ?? event.over.rect.width) / 2

    let nextPreview: DropPreview | null = null
    if (pointerX < splitX) {
      const anchor = below ?? above
      if (!anchor) {
        setPreview(null)
        return
      }
      const parentId = anchor.parent === ROOT_PARENT ? null : anchor.parent
      const oldParentIds = activeNode?.related_tasks?.parenttask?.map((parent) => parent.id) ?? []
      const oldParentId = oldParentIds[0] ?? null
      if (activeNode && parentId === null && oldParentId !== null &&
        (oldParentIds.length !== 1 || !canPromoteToRoot(activeNode, byId.get(oldParentId), HONEYDO_LABEL) || honeyDoLabelId === null)) {
        setPreview(null)
        return
      }
      const beforeTaskId = below?.taskId ?? null
      const afterTaskId = below ? null : (above?.taskId ?? null)
      nextPreview = {
        mode: 'sibling',
        parentId,
        beforeTaskId,
        afterTaskId,
        baseDepth: below?.node.depth ?? above?.node.depth ?? 0,
      }
    } else {
      if (!above || (activeNode && !canNestUnder(activeNode, above.taskId))) {
        setPreview(null)
        return
      }
      const parent = findNode(taskTree, above.taskId)
      if (!parent) {
        setPreview(null)
        return
      }
      nextPreview = {
        mode: 'child',
        parentId: above.taskId,
        beforeTaskId: parent.children[0]?.id ?? null,
        afterTaskId: null,
        baseDepth: above.node.depth + 1,
      }
    }
    setPreview(nextPreview)
  }, [byId, honeyDoLabelId, taskTree])

  const updateExpansionTarget = useCallback(() => {
    const parentId = dropPreviewRef.current?.mode === 'child' ? dropPreviewRef.current.parentId : null
    if (parentId === expansionTargetRef.current) return
    if (expansionTimerRef.current) clearTimeout(expansionTimerRef.current)
    expansionTimerRef.current = null
    expansionTargetRef.current = parentId
    if (parentId !== null && collapsed.has(parentId)) {
      expansionTimerRef.current = setTimeout(() => {
        setCollapsed((previous) => {
          const next = new Set(previous)
          next.delete(parentId)
          return next
        })
        expansionTimerRef.current = null
      }, 600)
    }
  }, [collapsed, setCollapsed])

  const handleDragStart = useCallback((event: DragStartEvent) => {
    dragStartRectsRef.current.clear()
    dropPreviewRef.current = null
    setDropPreview(null)
    const isComposerDrag = String(event.active.id) === 'task-composer'
    setIsComposerDragging(isComposerDrag)
    document.querySelectorAll<HTMLElement>('[data-sortable-id]').forEach((element) => {
      const id = element.dataset.sortableId
      if (id) dragStartRectsRef.current.set(id, element.getBoundingClientRect())
    })
    const decoded = decodeGroupItemId(String(event.active.id))
    setActiveTaskId(decoded?.taskId ?? null)
    if (decoded) {
      const group = groupBySortableId.get(String(event.active.id))
      const node = findNode(taskTree, decoded.taskId)
      const index = group?.items.indexOf(decoded.taskId) ?? -1
      if (group && node && index >= 0) {
        const initialPreview: DropPreview = {
          mode: 'sibling',
          parentId: group.parent === ROOT_PARENT ? null : group.parent,
          beforeTaskId: group.items[index + 1] ?? null,
          afterTaskId: group.items[index - 1] ?? null,
          baseDepth: node.depth,
        }
        dropPreviewRef.current = initialPreview
        setDropPreview(initialPreview)
      }
    }
  }, [groupBySortableId, taskTree])

  const handleDragCancel = useCallback((_event: DragCancelEvent) => {
    if (expansionTimerRef.current) clearTimeout(expansionTimerRef.current)
    expansionTimerRef.current = null
    expansionTargetRef.current = null
    dragStartRectsRef.current.clear()
    dropPreviewRef.current = null
    setDropPreview(null)
    setIsComposerDragging(false)
    setActiveTaskId(null)
  }, [])

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    updateDropPreview(event)
    updateExpansionTarget()
  }, [updateDropPreview, updateExpansionTarget])

  const handleDragOver = useCallback((event: DragOverEvent) => {
    updateDropPreview(event)
    updateExpansionTarget()
  }, [updateDropPreview, updateExpansionTarget])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const activeId = String(event.active.id)
    const preview = dropPreviewRef.current
    if (expansionTimerRef.current) clearTimeout(expansionTimerRef.current)
    expansionTimerRef.current = null
    expansionTargetRef.current = null
    dragStartRectsRef.current.clear()
    dropPreviewRef.current = null
    setDropPreview(null)
    setIsComposerDragging(false)

    if (activeId === 'task-composer') {
      if (preview) {
        if (preview.mode === 'child' && preview.parentId !== null) {
          setCollapsed((previous) => {
            const next = new Set(previous)
            next.delete(preview.parentId!)
            return next
          })
        }
        composerDispatch({
          type: 'move',
          placement: {
            parentId: preview.parentId,
            beforeTaskId: preview.beforeTaskId,
            afterTaskId: preview.afterTaskId,
          },
        })
      }
      return
    }

    const activeDecoded = decodeGroupItemId(activeId)
    setActiveTaskId(null)
    if (!activeDecoded || !preview) return
    const task = byId.get(activeDecoded.taskId)
    if (!task) return

    const oldParentIds = task.related_tasks?.parenttask?.map((parent) => parent.id) ?? []
    const oldParentId = oldParentIds[0] ?? null
    if (preview.parentId !== oldParentId) {
      if (oldParentIds.length > 1) {
        notify('A task with multiple parents cannot be moved this way.')
        return
      }
      let labelIdToAdd: number | undefined
      if (preview.parentId === null && oldParentId !== null) {
        const parent = byId.get(oldParentId)
        if (!canPromoteToRoot(task, parent, HONEYDO_LABEL)) {
          notify('This task can only be promoted when its direct parent is a Honey-Do task.')
          return
        }
        if (honeyDoLabelId === null) {
          notify('The Honey-Do label is unavailable. Refresh the task list and try again.')
          return
        }
        if (!task.labels?.some((label) => label.id === honeyDoLabelId)) labelIdToAdd = honeyDoLabelId
      }

      const siblings = preview.parentId === null ? taskTree : findNode(taskTree, preview.parentId)?.children ?? []
      const siblingsWithoutActive = siblings.filter((sibling) => sibling.id !== task.id)
      let newPosition: number
      const beforeIndex = preview.beforeTaskId === null ? -1 : siblingsWithoutActive.findIndex((sibling) => sibling.id === preview.beforeTaskId)
      if (beforeIndex >= 0) {
        const nextPosition = dueDateToPosition(siblingsWithoutActive[beforeIndex].due_date)
        const previousPosition = beforeIndex > 0 ? dueDateToPosition(siblingsWithoutActive[beforeIndex - 1].due_date) : null
        newPosition = previousPosition === null
          ? Math.min(getTopPosition(), nextPosition) - 1
          : getMidpointPosition(previousPosition, nextPosition)
      } else if (preview.afterTaskId !== null) {
        const afterIndex = siblingsWithoutActive.findIndex((sibling) => sibling.id === preview.afterTaskId)
        const previousPosition = afterIndex >= 0 ? dueDateToPosition(siblingsWithoutActive[afterIndex].due_date) : 0
        const nextPosition = afterIndex >= 0 && afterIndex + 1 < siblingsWithoutActive.length
          ? dueDateToPosition(siblingsWithoutActive[afterIndex + 1].due_date)
          : null
        newPosition = nextPosition === null ? previousPosition + 1 : getMidpointPosition(previousPosition, nextPosition)
      } else {
        const siblingPositions = siblingsWithoutActive.map((sibling) => dueDateToPosition(sibling.due_date)).filter(Number.isFinite)
        newPosition = (siblingPositions.length > 0 ? Math.max(...siblingPositions) : 0) + 1
      }

      changeTaskParent({
        taskId: task.id,
        oldParentId,
        oldParentIds,
        newParentId: preview.parentId,
        oldDueDate: task.due_date,
        newDueDate: positionToDueDate(newPosition),
        labelIdToAdd,
      }).then(() => {
        if (preview.mode === 'child' && preview.parentId !== null) {
          setCollapsed((previous) => {
            const next = new Set(previous)
            next.delete(preview.parentId!)
            return next
          })
        }
      }).catch((error: unknown) => notify(error instanceof Error ? error.message : 'Could not move this task. Check permissions and try again.'))
      return
    }

    const group = groupBySortableId.get(activeId)
    if (!group) return
    const oldIndex = group.items.indexOf(activeDecoded.taskId)
    if (oldIndex < 0) return
    const reorderedIds = group.items.filter((id) => id !== activeDecoded.taskId)
    let newIndex = preview.beforeTaskId === null ? -1 : reorderedIds.indexOf(preview.beforeTaskId)
    if (newIndex < 0 && preview.afterTaskId !== null) {
      const afterIndex = reorderedIds.indexOf(preview.afterTaskId)
      if (afterIndex >= 0) newIndex = afterIndex + 1
    }
    if (newIndex < 0) newIndex = reorderedIds.length
    reorderedIds.splice(newIndex, 0, activeDecoded.taskId)
    if (reorderedIds.every((id, index) => id === group.items[index])) return

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
    dropPreview,
    sensors,
    collisionDetection,
    onDragStart: handleDragStart,
    onDragMove: handleDragMove,
    onDragOver: handleDragOver,
    onDragCancel: handleDragCancel,
    onDragEnd: handleDragEnd,
  }
}
