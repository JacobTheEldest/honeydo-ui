import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdateTaskPayload, VikunjaTask } from '../types/vikunja.ts'
import { currentEntry, undoStackReducer, type UndoEntry } from '../utils/undoStack.ts'
import { createTaskMutationQueue } from '../utils/taskMutationQueue.ts'
import { applyDelete, type DeletePlan } from '../utils/delete.ts'

const SAVE_ERROR = 'Could not update this task.'
const DELETE_ERROR = 'Could not delete this task.'

export interface UndoToast {
  message: string
  /** Task id the Undo button reverses; absent for plain notifications. */
  undoTaskId?: number
}

export interface UseUndoableActionsOptions {
  byId: Map<number, VikunjaTask>
  updateTask: (task: VikunjaTask, patch: UpdateTaskPayload) => Promise<VikunjaTask>
  /** Server-side deletion, issued when a delete's undo window closes. */
  deleteTask: (taskId: number) => Promise<void>
  /** Authoritative refetch run after a delete commit settles the tree. */
  refresh: () => Promise<unknown>
  /** How long an undo toast stays up (ms). */
  undoTimeoutMs?: number
  /** How long a plain notification stays up (ms). */
  infoTimeoutMs?: number
}

/**
 * Task actions with a shared undo toast. The single toast surface doubles as
 * the undo affordance: it shows the most recent completion or deletion with
 * an Undo button, and undoing reveals the previous still-undoable entry
 * instead of discarding it. Letting the toast time out (or replacing it with
 * a notification) closes the undo window and drops the stack.
 *
 * Deletions are deferred: the task is hidden from the tree immediately and
 * the server DELETE is issued only when the undo window closes, so Undo can
 * restore the exact task (Vikunja has no undelete). Pending-delete ids stay
 * masked from the tree until the server deletes settle, so a refetch during
 * the window cannot resurrect a task that is about to be deleted.
 */
export function useUndoableActions({
  byId,
  updateTask,
  deleteTask,
  refresh,
  undoTimeoutMs = 7000,
  infoTimeoutMs = 4000,
}: UseUndoableActionsOptions) {
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

  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<number>>(() => new Set())
  const pendingDeleteIdsRef = useRef(pendingDeleteIds)
  const applyPendingDeleteIds = (next: Set<number>) => {
    pendingDeleteIdsRef.current = next
    setPendingDeleteIds(next)
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
  const startTimer = (ms: number) => {
    clearTimer()
    // `fire` is initialized later in this render; the timeout only calls it
    // after render completes.
    timerRef.current = { handle: setTimeout(fire, ms), startedAt: Date.now(), remaining: ms }
  }

  const notify = useCallback((message: string) => {
    applyToast({ message })
    startTimer(infoTimeoutMs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoTimeoutMs])

  const fire = useCallback(() => {
    timerRef.current = null
    const entries = stackRef.current
    const deleteEntries = entries.filter((entry) => entry.kind === 'delete')
    // The toast is the undo surface; when it goes away, so does undoability.
    applyStack([])
    applyToast(null)
    if (deleteEntries.length === 0) return
    const targets = deleteEntries.flatMap((entry) => entry.deletedTasks ?? [])
    // Keep these ids masked until the server deletes settle so a failed
    // delete reappears only alongside its error, never before.
    applyDelete(targets, {
      deleteTask: (id) => queue.enqueue(id, () => deleteTask(id)),
      refresh,
    })
      .catch((error) => notify(error instanceof Error ? error.message : DELETE_ERROR))
      .finally(() => {
        const settled = new Set(pendingDeleteIdsRef.current)
        for (const task of targets) settled.delete(task.id)
        applyPendingDeleteIds(settled)
      })
  }, [queue, deleteTask, refresh, notify])

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
      const message = top.kind === 'delete'
        ? (top.deletedTasks && top.deletedTasks.length > 1
            ? `Deleted “${top.title}” and ${top.deletedTasks.length - 1} subtasks`
            : `Deleted “${top.title}”`)
        : `Completed “${top.title}”`
      applyToast({ message, undoTaskId: top.id })
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

  const handleToggleDone = useCallback(
    (id: number, done: boolean) => {
      const task = byId.get(id)
      if (done) {
        if (!task) return
        applyStack(
          undoStackReducer(stackRef.current, {
            type: 'push',
            entry: { id, title: task.title, kind: 'complete' },
          })
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

  /**
   * Hide a planned deletion behind the undo toast. The tasks leave the tree
   * at once (via `pendingDeleteIds`); the server DELETEs are issued when the
   * undo window closes (see `fire`).
   */
  const handleDelete = useCallback(
    (plan: DeletePlan) => {
      applyStack(
        undoStackReducer(stackRef.current, {
          type: 'push',
          entry: {
            id: plan.root.id,
            title: plan.root.title,
            kind: 'delete',
            deletedTasks: plan.targets,
          },
        })
      )
      applyPendingDeleteIds(new Set([
        ...pendingDeleteIdsRef.current,
        ...plan.targets.map((task) => task.id),
      ]))
      showTopToast()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [undoTimeoutMs]
  )

  const undo = useCallback((id: number) => {
    const entry = stackRef.current.find((candidate) => candidate.id === id)
    if (entry?.kind === 'delete') {
      const restored = new Set((entry.deletedTasks ?? []).map((task) => task.id))
      applyPendingDeleteIds(new Set(
        [...pendingDeleteIdsRef.current].filter((candidate) => !restored.has(candidate))
      ))
      removeEntry(id)
      return
    }
    handleToggleDone(id, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleToggleDone])

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
    handleDelete,
    undo,
    notify,
    toast,
    pendingDeleteIds,
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
