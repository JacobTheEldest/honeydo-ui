import { useState, useCallback } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useDrag } from '@use-gesture/react'
import { ExternalLink, Check, GripVertical } from 'lucide-react'
import type { VikunjaTask } from '../types/vikunja.ts'

interface TaskItemProps {
  task: VikunjaTask
  onToggleDone: (id: number, done: boolean) => void
  onUpdateTitle: (id: number, title: string) => void
  showCompleted: boolean
}

export default function TaskItem({
  task,
  onToggleDone,
  onUpdateTitle,
  showCompleted,
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
  } = useSortable({ id: task.id })

  const dndStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
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

  const vikunjaUrl = `https://vikunja.jacobsteward.me/tasks/${task.id}`

  // Don't show swipe visuals when dragging via dnd-kit
  const effectiveSwipeX = isDragging ? 0 : swipeX
  const showCompleteBg = effectiveSwipeX < -40 && !task.done
  const showUndoBg = effectiveSwipeX < -40 && task.done

  return (
    <div
      ref={setNodeRef}
      style={dndStyle}
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
          ${showCompleteBg ? 'bg-green-100' : ''}
          ${showUndoBg ? 'bg-amber-100' : ''}
        `}
      >
        {showCompleteBg && <Check className="w-6 h-6 text-green-600" />}
        {showUndoBg && <span className="text-amber-600 text-sm font-medium">Undo</span>}
      </div>

      {/* Main row */}
      <div
        {...bind()}
        style={{
          transform: `translateX(${effectiveSwipeX}px)`,
          transition: isSwiping || isDragging ? 'none' : 'transform 0.2s ease-out',
          opacity: isDragging ? 0.5 : 1,
        }}
        className="
          relative flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-100
          touch-none select-none
        "
      >
        {/* Drag handle */}
        <button
          {...attributes}
          {...listeners}
          className="text-gray-300 cursor-grab active:cursor-grabbing shrink-0 p-1 touch-none"
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
              className="w-full px-2 py-1 text-base border border-honey rounded focus:outline-none focus:ring-2 focus:ring-honey/50"
            />
          ) : (
            <button
              onClick={() => setEditing(true)}
              className={`
                w-full text-left text-base truncate
                ${task.done ? 'line-through text-gray-400' : 'text-gray-800'}
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
                ? 'bg-green-100 text-green-600'
                : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
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
            className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200"
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
