import { useCallback, useEffect, useState } from 'react'
import type { VikunjaTask, VikunjaLabel, CreateTaskPayload, UpdateTaskPayload } from '../types/vikunja.ts'
import { HONEYDO_LABEL } from '../config.ts'
import { applyParentChangeToTasks, applyParentChange, type ParentChange } from '../utils/hierarchyMutations.ts'
import { applyUnlabel, type UnlabelPlan } from '../utils/unlabel.ts'

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
  const [labels, setLabels] = useState<VikunjaLabel[]>([])
  const [tasks, setTasks] = useState<VikunjaTask[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchLabels = useCallback(async () => {
    const data = await apiList<VikunjaLabel>('/labels?per_page=200')
    setLabels(data)
    return data
  }, [])

  const fetchTaskDetail = useCallback(async (id: number): Promise<VikunjaTask> => {
    return apiFetch<VikunjaTask>(`/tasks/${id}`)
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

  const fetchTasks = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // v2.5.0: GET /tasks does NOT include labels on tasks.
      // GET /projects/{id}/tasks DOES include labels.
      // Honey-Do tasks can be in any project, so fetch from all projects
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

      // Honey-Do roots need their full detail to expose related_tasks.{subtask,parenttask}.
      const honeyDoIds = seed
        .filter((t) => t.labels?.some((l) => l.title === HONEYDO_LABEL))
        .map((t) => t.id)
      const honeyDoDetails = await runWithConcurrency(honeyDoIds, DETAIL_CONCURRENCY, (id) =>
        fetchTaskDetail(id).catch(() => null)
      )
      const detailedIds = new Set<number>()
      for (const detail of honeyDoDetails) {
        if (!detail) continue
        const existing = seen.get(detail.id)
        seen.set(detail.id, {
          ...existing,
          ...detail,
          labels: detail.labels?.length ? detail.labels : (existing?.labels ?? []),
        })
        detailedIds.add(detail.id)
      }
      const enrichedSeed = Array.from(seen.values())

      // Fetch each reachable subtask's detail even when it was already present
      // in the project list: list endpoints contain no parenttask relation.
      await collectSubtaskDetails(enrichedSeed, seen, detailedIds)

      const allTasks = Array.from(seen.values())
      setTasks(allTasks)
      return allTasks
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch tasks')
      throw e
    } finally {
      setLoading(false)
    }
  }, [collectSubtaskDetails, fetchTaskDetail, setTasks])

  const createTask = useCallback(async (payload: CreateTaskPayload) => {
    const task = await apiFetch<VikunjaTask>(`/projects/${payload.project_id}/tasks`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    setTasks((prev) => [task, ...prev])
    return task
  }, [setTasks])

  const deleteTask = useCallback(async (taskId: number) => {
    await apiRequest(`/tasks/${taskId}`, { method: 'DELETE' })
    setTasks((previous) => previous.filter((task) => task.id !== taskId))
  }, [setTasks])

  /** Un-delete a task from Vikunja's trash (2.8.0+). */
  const restoreTask = useCallback(async (taskId: number) => {
    await apiRequest(`/tasks/${taskId}/restore`, { method: 'POST' })
  }, [])

  /** Re-create one parent -> child subtask relation row. */
  const addSubtaskRelation = useCallback(async (parentId: number, childId: number) => {
    await apiRequest(`/tasks/${parentId}/relations`, {
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
    setTasks((prev) => [task, ...prev])
    try {
      await apiRequest(`/tasks/${parentId}/relations`, {
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
  }, [fetchTasks, deleteTask, setTasks])

  const updateTaskRaw = useCallback(async (current: VikunjaTask, payload: UpdateTaskPayload) => {
    const task = await apiFetch<VikunjaTask>(`/tasks/${encodeURIComponent(current.id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    })
    // PATCH /tasks/{id} is a JSON Merge Patch write; relation and label writes
    // are separate. Merge the response into the latest local task, not the
    // request's stale snapshot, so a response cannot undo an optimistic parent
    // change made while the write was in flight.
    const merged: VikunjaTask = { ...current, ...task, labels: current.labels }
    setTasks((previous) => previous.map((latest) => latest.id === current.id
      ? {
          ...latest,
          ...task,
          labels: latest.labels ?? current.labels,
          related_tasks: latest.related_tasks ?? current.related_tasks ?? task.related_tasks,
        }
      : latest
    ))
    return merged
  }, [setTasks])

  /**
   * Partial update (JSON Merge Patch): only the fields in `patch` are sent,
   * so fields not modeled by this UI (priority, dates, repeat settings, etc.)
   * are preserved server-side without a read-modify-write round trip.
   */
  const updateTask = useCallback(async (current: VikunjaTask, patch: UpdateTaskPayload) => {
    return updateTaskRaw(current, patch)
  }, [updateTaskRaw])

  const persistTaskOrdering = useCallback(async (
    updates: Array<{ task: VikunjaTask; due_date: string }>
  ) => {
    const dueDates = new Map(updates.map(({ task, due_date }) => [task.id, due_date]))
    setTasks((prev) => prev.map((task) => {
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
  }, [fetchTasks, updateTask, setTasks])

  const addLabelToTask = useCallback(async (taskId: number, labelId: number) => {
    await apiFetch(`/tasks/${taskId}/labels`, {
      method: 'POST',
      body: JSON.stringify({ label_id: labelId }),
    })
    // Merge the label into the task in local state so buildTree picks it up
    // without waiting for a full fetchTasks() refresh.
    const label = labels.find((l) => l.id === labelId)
    if (!label) return
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== taskId) return t
        if (t.labels?.some((l) => l.id === labelId)) return t
        return { ...t, labels: [...(t.labels ?? []), label] }
      })
    )
  }, [labels, setTasks])

  /**
   * Delete a label link (the labels array in a task write body is ignored by
   * Vikunja) and mirror the removal in local state for immediate rendering.
   */
  const removeLabelFromTask = useCallback(async (taskId: number, labelId: number) => {
    await apiRequest(`/tasks/${taskId}/labels/${labelId}`, { method: 'DELETE' })
    setTasks((prev) => prev.map((task) => task.id === taskId
      ? { ...task, labels: (task.labels ?? []).filter((label) => label.id !== labelId) }
      : task
    ))
  }, [setTasks])

  const changeTaskParent = useCallback(async (change: ParentChange) => {
    const previousTasks = tasks
    const labelToAdd = change.labelIdToAdd === undefined
      ? undefined
      : labels.find((label) => label.id === change.labelIdToAdd)
    setTasks((current) => applyParentChangeToTasks(current, change, labelToAdd))

    const writeDueDate = async (taskId: number, dueDate: string | null) => {
      const current = tasks.find((task) => task.id === taskId)
      if (!current) throw new Error(`Task ${taskId} is no longer loaded`)
      await updateTask(current, { due_date: dueDate })
    }

    try {
      await applyParentChange(change, {
        removeRelation: async (parentId, childId) => {
          await apiRequest(`/tasks/${parentId}/relations/subtask/${childId}`, { method: 'DELETE' })
        },
        addRelation: addSubtaskRelation,
        setDueDate: writeDueDate,
        addLabel: addLabelToTask,
        removeLabel: removeLabelFromTask,
        refresh: fetchTasks,
      })
    } catch (error) {
      setTasks(previousTasks)
      await fetchTasks().catch(() => {})
      throw error
    }
  }, [tasks, labels, updateTask, addLabelToTask, removeLabelFromTask, addSubtaskRelation, fetchTasks, setTasks])

  /**
   * Remove the Honey-Do label and its sorting due_date from each target task.
   * Vikunja PATCH /tasks/{id} is a JSON Merge Patch write, so due-date
   * clearing sends { due_date: null } and Vikunja stores the cleared value as
   * the Go zero-time sentinel (0001-01-01T00:00:00Z), verified live on 2.8.0.
   * applyUnlabel refetches at the end and reports partial failures.
   */
  const removeFromHoneyDo = useCallback(async (plan: UnlabelPlan) => {
    await applyUnlabel(plan, {
      removeLabel: removeLabelFromTask,
      setDueDate: async (taskId, dueDate) => {
        const current = tasks.find((task) => task.id === taskId)
        if (!current) throw new Error(`Task ${taskId} is no longer loaded`)
        await updateTask(current, { due_date: dueDate })
      },
      refresh: fetchTasks,
    })
  }, [tasks, updateTask, removeLabelFromTask, fetchTasks])

  const createLabel = useCallback(async (title: string) => {
    const label = await apiFetch<VikunjaLabel>('/labels', {
      method: 'POST',
      body: JSON.stringify({ title }),
    })
    setLabels(prev => [...prev, label])
    return label
  }, [])

  useEffect(() => {
    fetchLabels().catch(() => {})
  }, [fetchLabels])

  return {
    labels,
    tasks,
    loading,
    error,
    fetchTasks,
    createTask,
    createSubtask,
    deleteTask,
    restoreTask,
    addSubtaskRelation,
    updateTask,
    persistTaskOrdering,
    changeTaskParent,
    removeFromHoneyDo,
    addLabelToTask,
    createLabel,
  }
}
