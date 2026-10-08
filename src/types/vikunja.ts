export interface VikunjaLabel {
  id: number
  title: string
}

export interface VikunjaTask {
  id: number
  title: string
  description: string
  done: boolean
  done_at: string | null
  due_date: string | null
  project_id: number
  labels: VikunjaLabel[]
  created: string
  updated: string
}

export interface CreateTaskPayload {
  title: string
  project_id: number
  due_date: string
}

export interface UpdateTaskPayload {
  title?: string
  done?: boolean
  due_date?: string | null
  project_id?: number
  description?: string
}