import { useCallback, useEffect, useState } from 'react'
import type { VikunjaTask, VikunjaLabel, CreateTaskPayload, UpdateTaskPayload } from '../types/vikunja.ts'

const API_BASE = '/api/v1'

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
      const allTasks = Array.from(seen.values())
      setTasks(allTasks)
      return allTasks
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch tasks')
      throw e
    } finally {
      setLoading(false)
    }
  }, [])

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