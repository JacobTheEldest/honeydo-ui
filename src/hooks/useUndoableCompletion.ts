import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdateTaskPayload, VikunjaTask } from '../types/vikunja.ts'
import { currentEntry, undoStackReducer, type UndoEntry } from '../utils/undoStack.ts'
import { createTaskMutationQueue } from '../utils/taskMutationQueue.ts'

const SAVE_ERROR = 'Could not update this task.'

export interface UndoToast {
  message: string
  /** Task id the Undo button reverses; absent for plain notifications. */
  undoTaskId?: number
}

export interface UseUndoableCompletionOptions {
  byId: Map<number, VikunjaTask>
  updateTask: (task: VikunjaTask, patch: UpdateTaskPayload) => Promise<VikunjaTask>
  /** How long an undo toast stays up (ms). */
  undoTimeoutMs?: number
  /** How long a plain notification stays up (ms). */
  infoTimeoutMs?: number
}

/**
 * Completion flow with an undo toast. The single toast surface doubles as the
 * undo affordance: it shows the most recent completion with an Undo button,
 * and undoing reveals the previous still-undoable completion instead of
 * discarding it. Letting the toast time out (or replacing it with a
 * notification) closes the undo window and drops the stack.
 */
export function useUndoableCompletion({
  byId,
  updateTask,
  undoTimeoutMs = 7000,
  infoTimeoutMs = 4000,
}: UseUndoableCompletionOptions) {
  const [stack, setStack] = useState<UndoEntry[]>([])
  const [toast, setToast] = useState<UndoToast | null>(null)
  const stackRef = useRef(stack)
  const toastRef = useRef(toast)
  const applyStack = (next: UndoEntry[]) => {
    stackRef.current = next
    setStack(next)
  }
  const applyToast = (next: UndoToast | null) => {
    toastRef.current = next
    setToast(next)
  }

  const queue = useRef(createTaskMutationQueue()).current

  // Toast timer with hover/focus pause so the Undo button stays reachable.
  const timerRef = useRef<{
    handle: ReturnType<typeof setTimeout> | null
    startedAt: number
    remaining: number
  } | null>(null)
  const clearTimer = () => {
    if (timerRef.current?.handle !== null && timerRef.current?.handle !== undefined) {
      clearTimeout(timerRef.current.handle)
    }
    timerRef.current = null
  }
  const fire = useCallback(() => {
    timerRef.current = null
    // The toast is the undo surface; when it goes away, so does undoability.
    applyStack([])
    applyToast(null)
  }, [])
  const startTimer = (ms: number) => {
    clearTimer()
    timerRef.current = { handle: setTimeout(fire, ms), startedAt: Date.now(), remaining: ms }
  }
  const pauseTimer = () => {
    const timer = timerRef.current
    if (!timer || timer.handle === null) return
    clearTimeout(timer.handle)
    timer.handle = null
    timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt))
  }
  const resumeTimer = () => {
    const timer = timerRef.current
    if (!timer || timer.handle !== null) return
    timer.handle = setTimeout(fire, timer.remaining)
    timer.startedAt = Date.now()
  }
  const hoveredRef = useRef(false)
  const focusedRef = useRef(false)
  const syncPause = () => {
    if (hoveredRef.current || focusedRef.current) pauseTimer()
    else resumeTimer()
  }

  useEffect(() => () => clearTimer(), [])

  const showTopToast = () => {
    const top = currentEntry(stackRef.current)
    if (top) {
      applyToast({ message: `Completed “${top.title}”`, undoTaskId: top.id })
      startTimer(undoTimeoutMs)
    } else {
      clearTimer()
      applyToast(null)
    }
  }

  const removeEntry = (id: number) => {
    applyStack(undoStackReducer(stackRef.current, { type: 'remove', id }))
    if (toastRef.current?.undoTaskId === id) showTopToast()
  }

  const notify = useCallback((message: string) => {
    applyToast({ message })
    startTimer(infoTimeoutMs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoTimeoutMs])

  const handleToggleDone = useCallback(
    (id: number, done: boolean) => {
      const task = byId.get(id)
      if (done) {
        if (!task) return
        applyStack(
          undoStackReducer(stackRef.current, { type: 'push', entry: { id, title: task.title } })
        )
        showTopToast()
      } else {
        removeEntry(id)
      }
      if (!task) return
      queue
        .enqueue(id, () => updateTask(task, { done }))
        .catch(() => {
          if (done) removeEntry(id)
          notify(SAVE_ERROR)
        })
    },
    // Stack/toast transitions go through refs, so only the API inputs matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byId, updateTask, queue, notify, undoTimeoutMs]
  )

  const undo = useCallback((id: number) => handleToggleDone(id, false), [handleToggleDone])

  const handleUpdateTitle = useCallback(
    (id: number, title: string) => {
      const task = byId.get(id)
      if (!task) return
      queue
        .enqueue(id, () => updateTask(task, { title }))
        .catch(() => notify(SAVE_ERROR))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byId, updateTask, queue, notify]
  )

  return {
    handleToggleDone,
    handleUpdateTitle,
    undo,
    notify,
    toast,
    toastHandlers: {
      onMouseEnter: () => {
        hoveredRef.current = true
        syncPause()
      },
      onMouseLeave: () => {
        hoveredRef.current = false
        syncPause()
      },
      onFocus: () => {
        focusedRef.current = true
        syncPause()
      },
      onBlur: () => {
        focusedRef.current = false
        syncPause()
      },
    },
  }
}
