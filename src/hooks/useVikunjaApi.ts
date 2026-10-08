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
      // v2.5.0 label filtering is broken; fetch all tasks and filter client-side
      const data = await apiFetch<VikunjaTask[]>('/tasks?per_page=200&page=1')
      setTasks(data)
      return data
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

  const updateTask = useCallback(async (id: number, payload: UpdateTaskPayload) => {
    const task = await apiFetch<VikunjaTask>(`/tasks/${id}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    setTasks(prev => prev.map(t => t.id === id ? task : t))
    return task
  }, [])

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