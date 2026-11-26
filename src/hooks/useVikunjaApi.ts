import { useCallback, useEffect, useRef, useState } from 'react'
import type { VikunjaTask, VikunjaUser, CreateTaskPayload, UpdateTaskPayload, AssignUserPayload } from '../types/vikunja.ts'
import { HONEYDO_ASSIGNEE_ID } from '../config.ts'
import { applyParentChangeToTasks, applyParentChange, type ParentChange } from '../utils/hierarchyMutations.ts'
import { applyUnassign } from '../utils/unlabel.ts'

const API_BASE = '/api/v2'
const DETAIL_CONCURRENCY = 8
const MAX_SUBTASK_DEPTH = 8

/** v2 list responses wrap rows in a pagination envelope. */
interface Paginated<T> {
  items: T[] | null
  total: number
  page: number
  per_page: number
  total_pages: number
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API ${path} failed: ${res.status} ${text}`)
  }
  return res.json() as Promise<T>
}

async function apiRequest(path: string, options?: RequestInit): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API ${path} failed: ${res.status} ${text}`)
  }
}

/** Fetch a v2 list endpoint and unwrap its pagination envelope. */
async function apiList<T>(path: string): Promise<T[]> {
  const page = await apiFetch<Paginated<T>>(path)
  return page.items ?? []
}

function mergeUsers(...groups: VikunjaUser[][]): VikunjaUser[] {
  const byId = new Map<number, VikunjaUser>()
  for (const user of groups.flat()) byId.set(user.id, user)
  return [...byId.values()]
}

/** Run a list of promise-producing functions with a fixed concurrency cap. */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

export function useVikunjaApi() {
  const [users, setUsers] = useState<VikunjaUser[]>([])
  const [tasks, setTasks] = useState<VikunjaTask[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Keep the freshest task list in a ref, updated synchronously with state.
  const tasksRef = useRef<VikunjaTask[]>(tasks)
  const setTasksAndRef = useCallback(
    (value: VikunjaTask[] | ((previous: VikunjaTask[]) => VikunjaTask[])) => {
      setTasks((previous) => {
        const next = typeof value === 'function' ? value(previous) : value
        tasksRef.current = next
        return next
      })
    },
    []
  )

  const fetchUsers = useCallback(async () => {
    // Vikunja's /users endpoint is a search and returns no rows without q.
    // The authenticated user is the seed; assignments found in task lists add
    // the other users who can actually be selected in this task view.
    const currentUser = await apiFetch<VikunjaUser>('/user')
    setUsers((previous) => mergeUsers(previous, [currentUser]))
    return [currentUser]
  }, [])

  const fetchTaskDetail = useCallback(async (id: number): Promise<VikunjaTask> => {
    return apiFetch<VikunjaTask>(`/tasks/${encodeURIComponent(String(id))}`)
  }, [])

  /**
   * Walk subtask references reachable from any task in `seed`, following
   * related_tasks.subtask links. Depth is bounded and visited-set guarded so
   * cycles cannot spin. Each discovered task detail is merged into `sink`
   * (keyed by id) and the function returns the set of newly-discovered ids.
   */
  const collectSubtaskDetails = useCallback(
    async (
      seed: VikunjaTask[],
      sink: Map<number, VikunjaTask>,
      alreadyDetailed: Set<number>
    ): Promise<Set<number>> => {
      const detailed = new Set(alreadyDetailed)
      const queue: number[] = []
      for (const task of seed) {
        for (const ref of task.related_tasks?.subtask ?? []) {
          if (!detailed.has(ref.id) && !queue.includes(ref.id)) queue.push(ref.id)
        }
      }

      let depth = 0
      while (queue.length > 0 && depth < MAX_SUBTASK_DEPTH) {
        const batch = queue.splice(0, queue.length).filter((id) => !detailed.has(id))
        if (batch.length === 0) {
          depth++
          continue
        }
        // Mark attempted before fetching so a failed/cyclic reference cannot
        // repeatedly consume requests at deeper levels.
        for (const id of batch) detailed.add(id)
        const details = await runWithConcurrency(batch, DETAIL_CONCURRENCY, (id) =>
          fetchTaskDetail(id).catch(() => null)
        )
        const nextQueue: number[] = []
        for (const detail of details) {
          if (!detail) continue
          const existing = sink.get(detail.id)
          sink.set(detail.id, {
            ...existing,
            ...detail,
            assignees: detail.assignees?.length ? detail.assignees : (existing?.assignees ?? []),
            labels: detail.labels?.length ? detail.labels : (existing?.labels ?? []),
          })
          for (const child of detail.related_tasks?.subtask ?? []) {
            if (!detailed.has(child.id) && !nextQueue.includes(child.id)) nextQueue.push(child.id)
          }
        }
        queue.push(...nextQueue)
        depth++
      }
      return detailed
    },
    [fetchTaskDetail]
  )

  /**
   * Fetch all tasks across every project, then enrich the tasks assigned to
   * the target user with full detail (which exposes related_tasks). When
   * `assigneeId` is omitted, falls back to the `HONEYDO_ASSIGNEE_ID` config.
   */
  const fetchTasks = useCallback(
    async (assigneeId?: number) => {
      const targetAssigneeId = assigneeId ?? HONEYDO_ASSIGNEE_ID
      setLoading(true)
      setError(null)
      try {
        // v2.5.0: GET /tasks does NOT include assignees on tasks.
        // GET /projects/{id}/tasks DOES include assignees.
        // Assigned tasks can be in any project, so fetch from all projects
        // and deduplicate by ID (system views like Favorites/Prioritized
        // contain the same tasks as real projects).
        const projects = await apiList<{ id: number; title: string }>('/projects?per_page=200')
        const seen = new Map<number, VikunjaTask>()
        for (const p of projects) {
          try {
            const batch = await apiList<VikunjaTask>(`/projects/${p.id}/tasks?per_page=200`)
            for (const t of batch) {
              if (!seen.has(t.id)) seen.set(t.id, t)
            }
          } catch {
            // Skip projects we can't read
          }
        }
        const seed = Array.from(seen.values())

        // Tasks assigned to the target user need their full detail to expose
        // related_tasks.{subtask,parenttask}.
        const assignedIds = targetAssigneeId === undefined
          ? []
          : seed
              .filter((t) => t.assignees?.some((a) => a.id === targetAssigneeId))
              .map((t) => t.id)
        const assignedDetails = await runWithConcurrency(assignedIds, DETAIL_CONCURRENCY, (id) =>
          fetchTaskDetail(id).catch(() => null)
        )
        const detailedIds = new Set<number>()
        for (const detail of assignedDetails) {
          if (!detail) continue
          const existing = seen.get(detail.id)
          seen.set(detail.id, {
            ...existing,
            ...detail,
            assignees: detail.assignees?.length ? detail.assignees : (existing?.assignees ?? []),
            labels: detail.labels?.length ? detail.labels : (existing?.labels ?? []),
          })
          detailedIds.add(detail.id)
        }
        const enrichedSeed = Array.from(seen.values())

        // Fetch each reachable subtask's detail even when it was already present
        // in the project list: list endpoints contain no parenttask relation.
        await collectSubtaskDetails(enrichedSeed, seen, detailedIds)

        const allTasks = Array.from(seen.values())
        const assignedUsers = allTasks.flatMap((task) => task.assignees ?? [])
        setUsers((previous) => mergeUsers(previous, assignedUsers))
        setTasksAndRef(allTasks)
        return allTasks
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to fetch tasks')
        throw e
      } finally {
        setLoading(false)
      }
    },
    [collectSubtaskDetails, fetchTaskDetail, setTasksAndRef]
  )

  const createTask = useCallback(async (payload: CreateTaskPayload) => {
    const task = await apiFetch<VikunjaTask>(`/projects/${payload.project_id}/tasks`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    setTasksAndRef((prev) => [task, ...prev])
    return task
  }, [setTasksAndRef])

  const deleteTask = useCallback(async (taskId: number) => {
    await apiRequest(`/tasks/${encodeURIComponent(String(taskId))}`, { method: 'DELETE' })
    setTasksAndRef((previous) => previous.filter((task) => task.id !== taskId))
  }, [setTasksAndRef])

  /** Un-delete a task from Vikunja's trash (2.8.0+). */
  const restoreTask = useCallback(async (taskId: number) => {
    await apiRequest(`/tasks/${encodeURIComponent(String(taskId))}/restore`, { method: 'POST' })
  }, [])

  /** Re-create one parent -> child subtask relation row. */
  const addSubtaskRelation = useCallback(async (parentId: number, childId: number) => {
    await apiRequest(`/tasks/${encodeURIComponent(String(parentId))}/relations`, {
      method: 'POST',
      body: JSON.stringify({
        task_id: parentId,
        other_task_id: childId,
        relation_kind: 'subtask',
      }),
    })
  }, [])

  const createSubtask = useCallback(async (payload: CreateTaskPayload, parentId: number) => {
    const task = await apiFetch<VikunjaTask>(`/projects/${payload.project_id}/tasks`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    setTasksAndRef((prev) => [task, ...prev])
    try {
      await apiRequest(`/tasks/${encodeURIComponent(String(parentId))}/relations`, {
        method: 'POST',
        body: JSON.stringify({
          task_id: parentId,
          other_task_id: task.id,
          relation_kind: 'subtask',
        }),
      })
      await fetchTasks()
      return task
    } catch (error) {
      // A created-but-unlinked task must not remain as a false root in the UI.
      await deleteTask(task.id).catch(() => {})
      await fetchTasks().catch(() => {})
      throw error
    }
  }, [fetchTasks, deleteTask, setTasksAndRef])

  const updateTaskRaw = useCallback(async (current: VikunjaTask, payload: UpdateTaskPayload) => {
    const task = await apiFetch<VikunjaTask>(`/tasks/${encodeURIComponent(String(current.id))}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    })
    // PATCH /tasks/{id} is a JSON Merge Patch write; relation and assignee
    // writes are separate. Merge the response into the latest local task, not
    // the request's stale snapshot, so a response cannot undo an optimistic
    // parent change made while the write was in flight.
    const merged: VikunjaTask = { ...current, ...task, assignees: current.assignees }
    setTasksAndRef((previous) => previous.map((latest) => latest.id === current.id
      ? {
          ...latest,
          ...task,
          assignees: latest.assignees ?? current.assignees,
          related_tasks: latest.related_tasks ?? current.related_tasks ?? task.related_tasks,
        }
      : latest
    ))
    return merged
  }, [setTasksAndRef])

  /**
   * Partial update (JSON Merge Patch): only the fields in `patch` are sent,
   * so fields not modeled by this UI (priority, dates, repeat settings, etc.)
   * are preserved server-side without a read-modify-write round trip.
   */
  const updateTask = useCallback(async (current: VikunjaTask, patch: UpdateTaskPayload) => {
    const latest = tasksRef.current.find((task) => task.id === current.id) ?? current
    const merged = { ...latest, ...patch }
    return updateTaskRaw(latest, merged)
  }, [updateTaskRaw])

  const persistTaskOrdering = useCallback(async (
    updates: Array<{ task: VikunjaTask; due_date: string }>
  ) => {
    const dueDates = new Map(updates.map(({ task, due_date }) => [task.id, due_date]))
    setTasksAndRef((prev) => prev.map((task) => {
      const due_date = dueDates.get(task.id)
      return due_date === undefined ? task : { ...task, due_date }
    }))

    const results = await Promise.allSettled(updates.map(({ task, due_date }) =>
      updateTask({ ...task, due_date }, { due_date })
    ))
    if (results.some((result) => result.status === 'rejected')) {
      // Restore the backend's authoritative state if any position write failed.
      await fetchTasks().catch(() => {})
      throw new Error('One or more task order updates failed')
    }
  }, [fetchTasks, updateTask, setTasksAndRef])

  /**
   * Assign the given user to a task (PUT /tasks/{id}/assignees) and mirror
   * the assignment in local state so buildTree picks it up without waiting
   * for a full fetchTasks() refresh.
   */
  const assignUserToTask = useCallback(async (taskId: number, userId: number) => {
    await apiFetch(`/tasks/${encodeURIComponent(String(taskId))}/assignees`, {
      method: 'PUT',
      body: JSON.stringify({ user_id: userId } as AssignUserPayload),
    })
    const user = users.find((u) => u.id === userId)
    if (!user) return
    setTasksAndRef((prev) =>
      prev.map((t) => {
        if (t.id !== taskId) return t
        if (t.assignees?.some((a) => a.id === userId)) return t
        return { ...t, assignees: [...(t.assignees ?? []), user] }
      })
    )
  }, [users, setTasksAndRef])

  /**
   * Unassign the given user from a task (DELETE /tasks/{id}/assignees/{userId})
   * and mirror the removal in local state for immediate rendering.
   */
  const unassignUserFromTask = useCallback(async (taskId: number, userId: number) => {
    await apiRequest(`/tasks/${encodeURIComponent(String(taskId))}/assignees/${userId}`, {
      method: 'DELETE',
    })
    setTasksAndRef((prev) => prev.map((task) => task.id === taskId
      ? { ...task, assignees: (task.assignees ?? []).filter((a) => a.id !== userId) }
      : task
    ))
  }, [setTasksAndRef])

  const changeTaskParent = useCallback(async (change: ParentChange) => {
    const previousTasks = tasks
    const assigneeToAdd = change.assigneeIdToAdd === undefined
      ? undefined
      : users.find((user) => user.id === change.assigneeIdToAdd)
    setTasksAndRef((current) => applyParentChangeToTasks(current, change, assigneeToAdd))

    const writeDueDate = async (taskId: number, dueDate: string | null) => {
      const current = tasks.find((task) => task.id === taskId)
      if (!current) throw new Error(`Task ${taskId} is no longer loaded`)
      await updateTask(current, { due_date: dueDate })
    }

    try {
      await applyParentChange(change, {
        removeRelation: async (parentId, childId) => {
          await apiRequest(`/tasks/${encodeURIComponent(String(parentId))}/relations/subtask/${childId}`, { method: 'DELETE' })
        },
        addRelation: addSubtaskRelation,
        setDueDate: writeDueDate,
        assignUser: assignUserToTask,
        unassignUser: unassignUserFromTask,
        refresh: fetchTasks,
      })
    } catch (error) {
      setTasksAndRef(previousTasks)
      await fetchTasks().catch(() => {})
      throw error
    }
  }, [tasks, users, updateTask, assignUserToTask, unassignUserFromTask, addSubtaskRelation, fetchTasks, setTasksAndRef])

  /**
   * Unassign the selected user from each target task and clear its sorting
   * due_date. Vikunja PATCH /tasks/{id} is a JSON Merge Patch write, so
   * due-date clearing sends { due_date: null } and Vikunja stores the cleared
   * value as the Go zero-time sentinel (0001-01-01T00:00:00Z), verified live
   * on 2.8.0. Refetches at the end and reports partial failures.
   */
  const unassignFromHoneyDo = useCallback(async (
    plan: { targets: VikunjaTask[]; userId: number }
  ) => {
    await applyUnassign(plan, {
      unassignUser: unassignUserFromTask,
      setDueDate: async (taskId: number, dueDate: string | null) => {
        const current = tasks.find((task) => task.id === taskId)
        if (!current) throw new Error(`Task ${taskId} is no longer loaded`)
        await updateTask(current, { due_date: dueDate })
      },
      refresh: fetchTasks,
    })
  }, [tasks, updateTask, unassignUserFromTask, fetchTasks])

  useEffect(() => {
    fetchUsers().catch(() => {})
  }, [fetchUsers])

  return {
    users,
    tasks,
    loading,
    error,
    fetchTasks,
    fetchUsers,
    createTask,
    createSubtask,
    deleteTask,
    restoreTask,
    addSubtaskRelation,
    updateTask,
    persistTaskOrdering,
    changeTaskParent,
    assignUserToTask,
    unassignUserFromTask,
    unassignFromHoneyDo,
  }
}
