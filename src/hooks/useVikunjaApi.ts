import { useCallback, useEffect, useState } from 'react'
import type { VikunjaTask, VikunjaLabel, CreateTaskPayload, UpdateTaskPayload } from '../types/vikunja.ts'
import { HONEYDO_LABEL } from '../config.ts'

const API_BASE = '/api/v1'
const DETAIL_CONCURRENCY = 8
const MAX_SUBTASK_DEPTH = 8

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
    const data = await apiFetch<VikunjaLabel[]>('/labels?per_page=200')
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
    async (seed: VikunjaTask[], sink: Map<number, VikunjaTask>): Promise<Set<number>> => {
      const reachable = new Set<number>()
      const queue: number[] = []
      for (const t of seed) {
        const subs = t.related_tasks?.subtask ?? []
        for (const r of subs) {
          if (!sink.has(r.id) && !reachable.has(r.id) && !queue.includes(r.id)) {
            queue.push(r.id)
          }
        }
      }
      let depth = 0
      while (queue.length > 0 && depth < MAX_SUBTASK_DEPTH) {
        const batch = queue.splice(0, queue.length)
        const missing = batch.filter((id) => !sink.has(id) && !reachable.has(id))
        if (missing.length === 0) {
          depth++
          continue
        }
        const details = await runWithConcurrency(missing, DETAIL_CONCURRENCY, (id) =>
          fetchTaskDetail(id).catch(() => null)
        )
        const nextQueue: number[] = []
        for (const d of details) {
          if (!d) continue
          sink.set(d.id, d)
          reachable.add(d.id)
          const subs = d.related_tasks?.subtask ?? []
          for (const s of subs) {
            if (!sink.has(s.id) && !reachable.has(s.id) && !nextQueue.includes(s.id)) {
              nextQueue.push(s.id)
            }
          }
        }
        queue.push(...nextQueue)
        depth++
      }
      return reachable
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
      const projects = await apiFetch<{ id: number; title: string }[]>('/projects?per_page=200')
      const seen = new Map<number, VikunjaTask>()
      for (const p of projects) {
        try {
          const batch = await apiFetch<VikunjaTask[]>(`/projects/${p.id}/tasks?per_page=200`)
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
      for (const d of honeyDoDetails) {
        if (d) seen.set(d.id, d)
      }
      const enrichedSeed = Array.from(seen.values())

      // Walk subtask links out to a bounded depth and fetch their details too.
      await collectSubtaskDetails(enrichedSeed, seen)

      const allTasks = Array.from(seen.values())
      setTasks(allTasks)
      return allTasks
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch tasks')
      throw e
    } finally {
      setLoading(false)
    }
  }, [collectSubtaskDetails, fetchTaskDetail])

  const createTask = useCallback(async (payload: CreateTaskPayload) => {
    const task = await apiFetch<VikunjaTask>(`/projects/${payload.project_id}/tasks`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
    setTasks(prev => [task, ...prev])
    return task
  }, [])

  const updateTaskRaw = useCallback(async (current: VikunjaTask, payload: UpdateTaskPayload) => {
    const task = await apiFetch<VikunjaTask>(`/tasks/${current.id}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    // POST /tasks/{id} response does NOT include labels (v2.5.0).
    // Merge with current task to preserve labels and other omitted fields.
    const merged: VikunjaTask = { ...current, ...task, labels: current.labels }
    setTasks(prev => prev.map(t => t.id === current.id ? merged : t))
    return merged
  }, [])

  /** Read-modify-write update that preserves fields the caller does not touch.
   *  Vikunja POST /tasks/{id} replaces the full resource, so partial updates
   *  silently clear omitted fields (e.g. due_date). */
  const updateTask = useCallback(async (current: VikunjaTask, patch: UpdateTaskPayload) => {
    const merged: UpdateTaskPayload = {
      title: current.title,
      done: current.done,
      due_date: current.due_date,
      project_id: current.project_id,
      description: current.description,
      ...patch,
    }
    return updateTaskRaw(current, merged)
  }, [updateTaskRaw])

  const addLabelToTask = useCallback(async (taskId: number, labelId: number) => {
    await apiFetch(`/tasks/${taskId}/labels`, {
      method: 'PUT',
      body: JSON.stringify({ label_id: labelId }),
    })
  }, [])

  const createLabel = useCallback(async (title: string) => {
    const label = await apiFetch<VikunjaLabel>('/labels', {
      method: 'PUT',
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
    updateTask,
    addLabelToTask,
    createLabel,
  }
}
