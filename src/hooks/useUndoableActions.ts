import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdateTaskPayload, VikunjaTask } from '../types/vikunja.ts'
import { currentEntry, undoStackReducer, type UndoEntry } from '../utils/undoStack.ts'
import { createTaskMutationQueue } from '../utils/taskMutationQueue.ts'
import { applyDelete, applyRestore, type DeletePlan } from '../utils/delete.ts'

const SAVE_ERROR = 'Could not update this task.'
const DELETE_ERROR = 'Could not delete this task.'
const RESTORE_ERROR = 'Could not restore this task.'

export interface UndoToast {
  message: string
  /** Task id the Undo button reverses; absent for plain notifications. */
  undoTaskId?: number
}

export interface UseUndoableActionsOptions {
  byId: Map<number, VikunjaTask>
  updateTask: (task: VikunjaTask, patch: UpdateTaskPayload) => Promise<VikunjaTask>
  /** Server-side deletion into Vikunja's trash, issued as soon as a delete is confirmed. */
  deleteTask: (taskId: number) => Promise<void>
  /** Undo of a delete: un-deletes a task from Vikunja's trash (2.8.0+, v2 API). */
  restoreTask: (taskId: number) => Promise<unknown>
  /** Re-creates one parent -> child subtask relation row (deletes destroy them). */
  addSubtaskRelation: (parentId: number, childId: number) => Promise<unknown>
  /** Authoritative refetch; settles the tree after writes and backs restore presence checks. */
  refresh: () => Promise<VikunjaTask[]>
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
 * Deletions commit to the server immediately: Vikunja 2.8.0's trash keeps
 * them recoverable for 30 days, so Undo restores the exact tasks from the
 * trash (and re-links the relation rows the delete destroyed) instead of
 * cancelling a pending write. Pending-delete ids stay masked from the tree
 * until the server deletes settle, so a refetch during the round trip cannot
 * resurrect a task that is being deleted.
 */
export function useUndoableActions({
  byId,
  updateTask,
  deleteTask,
  restoreTask,
  addSubtaskRelation,
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
    // The toast is the undo surface; when it goes away, so does undoability.
    // Deletes already committed when they were confirmed — Vikunja's trash
    // holds them for 30 days after the window closes.
    applyStack([])
    applyToast(null)
  }, [])

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
   * Commit a planned deletion at once and hide it behind the undo toast. The
   * tasks leave the tree immediately (via `pendingDeleteIds`) and the server
   * DELETEs go out at once — Vikunja's trash makes them recoverable, so Undo
   * restores from the trash instead of cancelling a pending write.
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
            relationEdges: plan.edges,
          },
        })
      )
      applyPendingDeleteIds(new Set([
        ...pendingDeleteIdsRef.current,
        ...plan.targets.map((task) => task.id),
      ]))
      showTopToast()
      // Keep these ids masked until the server deletes settle so a failed
      // delete reappears only alongside its error, never before.
      applyDelete(plan.targets, {
        deleteTask: (id) => queue.enqueue(id, () => deleteTask(id)),
        refresh,
      })
        .catch((error) => notify(error instanceof Error ? error.message : DELETE_ERROR))
        .finally(() => {
          const settled = new Set(pendingDeleteIdsRef.current)
          for (const task of plan.targets) settled.delete(task.id)
          applyPendingDeleteIds(settled)
        })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deleteTask, refresh, notify]
  )

  const undo = useCallback((id: number) => {
    const entry = stackRef.current.find((candidate) => candidate.id === id)
    if (entry?.kind === 'delete') {
      const targets = entry.deletedTasks ?? []
      removeEntry(id)
      // Restore from the trash, serialized behind any delete still in flight
      // for the same task (the queue is FIFO per task id), then re-link the
      // relation rows the delete destroyed.
      applyRestore(targets, entry.relationEdges ?? [], {
        restoreTask: (taskId) => queue.enqueue(taskId, () => restoreTask(taskId)),
        addSubtaskRelation,
        refresh,
      })
        .catch((error) => notify(error instanceof Error ? error.message : RESTORE_ERROR))
        .finally(() => {
          const restored = new Set(targets.map((task) => task.id))
          applyPendingDeleteIds(new Set(
            [...pendingDeleteIdsRef.current].filter((candidate) => !restored.has(candidate))
          ))
        })
      return
    }
    handleToggleDone(id, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleToggleDone, queue, restoreTask, addSubtaskRelation, refresh, notify])

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
