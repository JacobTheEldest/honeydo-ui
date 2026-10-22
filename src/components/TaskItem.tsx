import { useState, useCallback } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useDrag } from '@use-gesture/react'
import { ExternalLink, Check, GripVertical, ChevronRight, ChevronDown } from 'lucide-react'
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
  showCompleted: boolean
  isInDraggedSubtree: boolean
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
  showCompleted,
  isInDraggedSubtree,
}: TaskItemProps) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(task.title)
  const [swipeX, setSwipeX] = useState(0)
  const [isSwiping, setIsSwiping] = useState(false)

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId })

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
          <a
            href={vikunjaUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600"
            onClick={(e) => e.stopPropagation()}
            aria-label="Open in Vikunja"
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        </div>
      </div>
    </div>
  )
}
