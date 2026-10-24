import { useState, useCallback, useEffect, useRef } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useDrag } from '@use-gesture/react'
import { ExternalLink, Check, GripVertical, ChevronRight, ChevronDown, MoreHorizontal, Plus } from 'lucide-react'
import { VIKUNJA_BASE_URL } from '../config.ts'
import type { VikunjaTask } from '../types/vikunja.ts'

interface TaskItemProps {
  task: VikunjaTask
  /** Globally-unique id for useSortable — `${parentScope}::${taskId}`. */
  sortableId: string
  depth: number
  hasChildren: boolean
  collapsed: boolean
  onToggleCollapse: (taskId: number) => void
  onToggleDone: (id: number, done: boolean) => void
  onUpdateTitle: (id: number, title: string) => void
  onAddSubtask: (taskId: number) => void
  menuOpen: boolean
  onMenuOpenChange: (taskId: number, open: boolean) => void
  showCompleted: boolean
  isInDraggedSubtree: boolean
  parentContext?: string
  dropEdge?: 'before' | 'after'
  nestingTargetId?: number | null
}

export default function TaskItem({
  task,
  sortableId,
  depth,
  hasChildren,
  collapsed,
  onToggleCollapse,
  onToggleDone,
  onUpdateTitle,
  onAddSubtask,
  menuOpen,
  onMenuOpenChange,
  showCompleted,
  isInDraggedSubtree,
  parentContext,
  dropEdge,
  nestingTargetId,
}: TaskItemProps) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(task.title)
  const [swipeX, setSwipeX] = useState(0)
  const [isSwiping, setIsSwiping] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId })
  const { setNodeRef: setNestTargetRef, isOver: isNestTargetOver } = useDroppable({
    id: `nest::${task.id}`,
  })

  // DnD transition glitch fix: only animate the actively-dragged item. Other
  // items snap to their new positions instead of "settling".
  const dndStyle = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? transition : undefined,
  }

  // Swipe gesture for mobile complete
  const bind = useDrag(
    (state) => {
      const { offset, velocity, direction, last } = state
      const [x] = offset
      const [vx] = velocity
      const [dx] = direction

      if (last) {
        setIsSwiping(false)
        if (Math.abs(vx) > 0.5 && Math.abs(x) > 80) {
          // Swipe threshold met - toggle done
          setSwipeX(dx > 0 ? 100 : -100)
          setTimeout(() => {
            onToggleDone(task.id, !task.done)
            setSwipeX(0)
          }, 150)
        } else {
          setSwipeX(0)
        }
      } else {
        setIsSwiping(true)
        setSwipeX(x)
      }
    },
    {
      axis: 'x',
      filterTaps: true,
      preventScroll: true,
      threshold: 10,
      from: () => [swipeX, 0],
    }
  )

  const handleSave = useCallback(() => {
    if (editValue.trim() && editValue !== task.title) {
      onUpdateTitle(task.id, editValue.trim())
    }
    setEditing(false)
  }, [editValue, task.id, task.title, onUpdateTitle])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSave()
    if (e.key === 'Escape') {
      setEditValue(task.title)
      setEditing(false)
    }
  }

  const vikunjaUrl = `${VIKUNJA_BASE_URL}/tasks/${task.id}`

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) {
        onMenuOpenChange(task.id, false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onMenuOpenChange(task.id, false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen, onMenuOpenChange, task.id])

  // Don't show swipe visuals when dragging via dnd-kit
  const effectiveSwipeX = isDragging ? 0 : swipeX
  const showCompleteBg = effectiveSwipeX < -40 && !task.done
  const showUndoBg = effectiveSwipeX < -40 && task.done

  const indentPx = depth * 16

  return (
    <div
      ref={setNodeRef}
      data-task-id={task.id}
      data-sortable-id={sortableId}
      style={{ ...dndStyle, paddingLeft: indentPx }}
      className={`
        relative overflow-hidden
        ${task.done && !showCompleted ? 'hidden' : ''}
      `}
    >
      {dropEdge && (
        <div
          aria-hidden="true"
          data-reorder-edge={dropEdge}
          className={`absolute left-4 right-4 z-20 h-0.5 bg-honey shadow-[0_0_0_2px_rgba(255,255,255,0.75)] ${
            dropEdge === 'before' ? 'top-0' : 'bottom-0'
          }`}
        />
      )}
      {/* Swipe background layer */}
      <div
        className={`
          absolute inset-0 flex items-center justify-end pr-6
          transition-colors duration-100
          ${showCompleteBg ? 'bg-green-100 dark:bg-green-900' : ''}
          ${showUndoBg ? 'bg-amber-100 dark:bg-amber-900' : ''}
        `}
      >
        {showCompleteBg && <Check className="w-6 h-6 text-green-600 dark:text-green-400" />}
        {showUndoBg && <span className="text-amber-600 dark:text-amber-400 text-sm font-medium">Undo</span>}
      </div>

      {/* Main row */}
      <div
        {...bind()}
        style={{
          transform: `translateX(${effectiveSwipeX}px)`,
          transition: isSwiping || isDragging ? 'none' : 'transform 0.2s ease-out',
          opacity: isDragging ? 0.5 : isInDraggedSubtree ? 0.3 : 1,
        }}
        className="
          relative flex items-center gap-2 px-4 py-3 bg-white dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700
          touch-none select-none
        "
      >
        <div
          ref={setNestTargetRef}
          data-nest-target={task.id}
          aria-label={`Drop a task here to make it a subtask of ${task.title}`}
          className={`absolute left-1/4 right-14 top-1/4 bottom-1/4 z-10 rounded-md border-2 border-dashed pointer-events-none transition-colors ${
            isNestTargetOver || nestingTargetId === task.id
              ? 'border-honey bg-honey/15 dark:bg-honey/20'
              : 'border-transparent'
          }`}
        >
          {nestingTargetId === task.id && (
            <span className="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-honey px-2 py-1 text-xs font-medium text-white shadow">
              Drop to add as subtask
            </span>
          )}
        </div>
        {/* Fold caret (only when this task has children) */}
        {hasChildren ? (
          <button
            onClick={() => onToggleCollapse(task.id)}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 shrink-0 p-0.5 -ml-1"
            aria-label={collapsed ? 'Expand subtasks' : 'Collapse subtasks'}
          >
            {collapsed ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </button>
        ) : (
          <span className="w-4 shrink-0" aria-hidden="true" />
        )}

        {/* Drag handle */}
        <button
          {...attributes}
          {...listeners}
          data-drag-handle
          className="text-gray-300 dark:text-gray-600 cursor-grab active:cursor-grabbing shrink-0 p-1 touch-none"
          aria-label="Drag to reorder"
        >
          <GripVertical className="w-5 h-5" />
        </button>

        {/* Task content */}
        <div className="flex-1 min-w-0">
          {editing ? (
            <input
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              autoFocus
              className="w-full px-2 py-1 text-base border border-honey rounded focus:outline-none focus:ring-2 focus:ring-honey/50 dark:bg-gray-700 dark:text-gray-200 dark:border-honey-dark"
            />
          ) : (
            <button
              onClick={() => setEditing(true)}
              className={`
                w-full text-left text-base truncate
                ${task.done ? 'line-through text-gray-400 dark:text-gray-500' : 'text-gray-800 dark:text-gray-200'}
              `}
            >
              {task.title}
            </button>
          )}
          {!editing && parentContext && (
            <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500 truncate">
              {parentContext}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => onToggleDone(task.id, !task.done)}
            className={`
              w-8 h-8 rounded-full flex items-center justify-center
              ${task.done
                ? 'bg-green-100 dark:bg-green-900 text-green-600 dark:text-green-400'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
              }
            `}
            aria-label={task.done ? 'Mark incomplete' : 'Mark complete'}
          >
            <Check className="w-4 h-4" />
          </button>
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => onMenuOpenChange(task.id, !menuOpen)}
              className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600"
              aria-label="Task actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {menuOpen && (
              <div data-composer-keep-open role="menu" className="absolute right-0 top-9 z-40 min-w-44 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 py-1 shadow-lg">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { onMenuOpenChange(task.id, false); onAddSubtask(task.id) }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  <Plus className="h-4 w-4" /> Add subtask
                </button>
                <a
                  role="menuitem"
                  href={vikunjaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => { event.stopPropagation(); onMenuOpenChange(task.id, false) }}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  <ExternalLink className="h-4 w-4" /> Open in Vikunja
                </a>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
