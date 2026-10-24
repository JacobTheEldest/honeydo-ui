import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'
import type { UnlabelScope } from '../utils/unlabel.ts'

interface UnlabelConfirmDialogProps {
  taskTitle: string
  /** Recursive descendant count; when 0 the dialog is the compact leaf form. */
  descendantCount: number
  busy: boolean
  onCancel: () => void
  onConfirm: (scope: UnlabelScope) => void
  /** Focused after close when the opening control is gone (task left the view). */
  returnFocusSelector?: string
}

/**
 * Accessible confirmation dialog for removing tasks from Honey-Do. Focus is
 * moved into the dialog on open and restored on close; Escape and outside
 * clicks cancel; Tab is trapped inside the dialog.
 */
export default function UnlabelConfirmDialog({
  taskTitle,
  descendantCount,
  busy,
  onCancel,
  onConfirm,
  returnFocusSelector,
}: UnlabelConfirmDialogProps) {
  const [scope, setScope] = useState<UnlabelScope>('task')
  const containerRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    containerRef.current?.focus()
    return () => {
      const previous = previousFocusRef.current
      if (previous && previous.isConnected) {
        previous.focus()
        return
      }
      if (returnFocusSelector) {
        document.querySelector<HTMLElement>(returnFocusSelector)?.focus()
      }
    }
  }, [returnFocusSelector])

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      if (!busy) onCancel()
      return
    }
    if (event.key !== 'Tab') return
    const focusables = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>(
        'input[type="radio"]:not([disabled]), button:not([disabled])'
      ) ?? []
    )
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement
    if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const handleOverlayClick = (event: React.MouseEvent) => {
    if (event.target === event.currentTarget && !busy) onCancel()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      onClick={handleOverlayClick}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="unlabel-dialog-title"
        aria-describedby="unlabel-dialog-description"
        aria-busy={busy}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl outline-none dark:bg-gray-800"
      >
        <h2
          id="unlabel-dialog-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          Remove from Honey-Do?
        </h2>
        <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
          <span className="font-medium">{taskTitle}</span>
        </p>

        {descendantCount > 0 && (
          <fieldset className="mt-3">
            <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Which tasks should leave Honey-Do?
            </legend>
            <label className="mt-2 flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-gray-200 px-3 py-2.5 dark:border-gray-600">
              <input
                type="radio"
                name="unlabel-scope"
                value="task"
                checked={scope === 'task'}
                onChange={() => setScope('task')}
                className="h-4 w-4 accent-honey"
              />
              <span className="text-sm text-gray-800 dark:text-gray-200">This task only</span>
            </label>
            <label className="mt-2 flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-gray-200 px-3 py-2.5 dark:border-gray-600">
              <input
                type="radio"
                name="unlabel-scope"
                value="subtree"
                checked={scope === 'subtree'}
                onChange={() => setScope('subtree')}
                className="h-4 w-4 accent-honey"
              />
              <span className="text-sm text-gray-800 dark:text-gray-200">
                This task and all subtasks ({descendantCount})
              </span>
            </label>
          </fieldset>
        )}

        <p
          id="unlabel-dialog-description"
          className="mt-3 text-sm text-gray-500 dark:text-gray-400"
        >
          This removes the Honey-Do label and its list ordering metadata. It does not delete any
          task or change subtask relationships. Subtasks without their own Honey-Do label may
          disappear from this view.
        </p>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="min-h-11 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(scope)}
            disabled={busy}
            className="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            Remove from Honey-Do
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
