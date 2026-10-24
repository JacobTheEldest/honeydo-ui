import { useEffect, useRef, useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Plus } from 'lucide-react'
import {
  shouldCloseOnOutsideClick,
  type ComposerEvent,
  type ComposerState,
} from '../utils/composerState.ts'

interface TaskComposerProps {
  state: ComposerState
  dispatch: (event: ComposerEvent) => void
  onCreate: (title: string, placement: ComposerState['placement']) => Promise<number>
}

/** A transient, draggable insertion row; it is persisted only on submit. */
export default function TaskComposer({ state, dispatch, onCreate }: TaskComposerProps) {
  const containerRef = useRef<HTMLFormElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [submitting, setSubmitting] = useState(false)
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: 'task-composer',
    disabled: !state.open,
  })
  const dragStyle = transform
    ? { transform: CSS.Translate.toString(transform), zIndex: 30 }
    : undefined

  // Auto-focus when newly opened and after each insertion.
  useEffect(() => {
    if (state.open) inputRef.current?.focus()
  }, [state.open, state.placement.afterTaskId])

  // Dismiss on click/tap anywhere outside the composer (the FAB toggle is
  // excluded here; its own handler toggles the composer).
  useEffect(() => {
    if (!state.open) return
    const handleClick = (event: MouseEvent) => {
      const composer = containerRef.current
      const outside = shouldCloseOnOutsideClick(
        event.target,
        (target) => composer !== null && target instanceof Node && composer.contains(target),
        (target) => target instanceof Element && (
          target.closest('[data-composer-toggle]') !== null ||
          target.closest('[data-composer-keep-open]') !== null ||
          target.closest('[data-sortable-id] button') !== null
        )
      )
      if (outside) dispatch({ type: 'close' })
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [state.open, dispatch])

  if (!state.open) return null

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = state.title.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    try {
      await onCreate(trimmed, state.placement).then((taskId) => {
        dispatch({ type: 'submitSucceeded', taskId, instanceId: state.instanceId })
      })
    } catch (error) {
      dispatch({
        type: 'submitFailed',
        message: error instanceof Error ? error.message : 'Could not add this task. Try again.',
        instanceId: state.instanceId,
      })
    } finally {
      setSubmitting(false)
      inputRef.current?.focus()
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      dispatch({ type: 'close' })
    }
  }

  return (
    <form
      ref={(node) => {
        containerRef.current = node
        setNodeRef(node)
      }}
      data-task-composer
      style={{ ...dragStyle, opacity: isDragging ? 0.55 : 1 }}
      onSubmit={handleSubmit}
      className="relative flex items-center gap-2 px-4 py-3 bg-white dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700"
    >
      <span aria-hidden="true" className="w-4 shrink-0" />
      <button
        type="button"
        {...attributes}
        {...listeners}
        data-drag-handle
        aria-label="Drag to place new task"
        className="text-gray-300 dark:text-gray-600 cursor-grab active:cursor-grabbing shrink-0 p-1 touch-none"
      >
        <GripVertical className="w-5 h-5" />
      </button>
      <div className="flex-1 min-w-0">
        <input
          ref={inputRef}
          type="text"
          value={state.title}
          onChange={(event) => dispatch({ type: 'titleChanged', title: event.target.value })}
          onKeyDown={handleKeyDown}
          placeholder="New task..."
          aria-label="New task title"
          className="w-full px-2 py-1 text-base border border-honey rounded focus:outline-none focus:ring-2 focus:ring-honey/50 dark:bg-gray-700 dark:text-gray-200 dark:border-honey-dark"
        />
        {state.error && (
          <p role="alert" className="mt-1 text-xs text-red-500 dark:text-red-400 truncate">
            {state.error}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="submit"
          disabled={submitting}
          aria-label="Add task"
          className="w-8 h-8 rounded-full bg-honey text-white flex items-center justify-center hover:bg-honey-dark disabled:opacity-50"
        >
          <Plus className="w-4 h-4" />
        </button>
        {/* Inert spacer mirroring TaskItem's second action slot so the input
            matches the rename field's width exactly. */}
        <span aria-hidden="true" className="w-8 h-8 shrink-0" />
      </div>
    </form>
  )
}
