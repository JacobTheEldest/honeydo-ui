import type { VikunjaTask } from '../src/types/vikunja.ts'

/**
 * One-time migration: convert all Honey-Do-labeled tasks to be assigned to Jacob.
 *
 * Fetches all tasks across all projects, identifies those with the Honey-Do
 * label, looks up Jacob's user id by username, and PUTs an assignee for each
 * labeled task. Tasks already assigned to Jacob are skipped.
 *
 * Usage:
 *   HONEYDO_API_URL=http://127.0.0.1:40437 VIKUNJA_API_KEY=<key> \
 *   HONEYDO_ASSIGNEE_USERNAME=jacob npx tsx scripts/migrate-label-to-assignee.ts --dry-run
 *   HONEYDO_API_URL=http://127.0.0.1:40437 VIKUNJA_API_KEY=<key> \
 *   HONEYDO_ASSIGNEE_USERNAME=jacob npx tsx scripts/migrate-label-to-assignee.ts
 */

const API_ORIGIN = process.env.HONEYDO_API_URL ?? 'http://127.0.0.1:3000'
const API_BASE = `${API_ORIGIN.replace(/\/$/, '')}/api/v2`
const API_KEY = process.env.VIKUNJA_API_KEY
const HONEYDO_LABEL = process.env.HONEYDO_LABEL ?? 'Honey-Do'
const ASSIGNEE_USERNAME = process.env.HONEYDO_ASSIGNEE_USERNAME ?? 'jacob'
const DRY_RUN = process.argv.includes('--dry-run')

if (!API_KEY) {
  console.error('VIKUNJA_API_KEY is required')
  process.exitCode = 1
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
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
      Authorization: `Bearer ${API_KEY}`,
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API ${path} failed: ${res.status} ${text}`)
  }
}

interface Paginated<T> {
  items: T[] | null
  total: number
  page: number
  per_page: number
  total_pages: number
}

async function apiList<T>(path: string): Promise<T[]> {
  const page = await apiFetch<Paginated<T>>(path)
  return page.items ?? []
}

interface VikunjaUser {
  id: number
  username: string
  name?: string
}

async function findUserIdByUsername(username: string): Promise<number | null> {
  const users = await apiList<VikunjaUser>(`/users?per_page=200`)
  const match = users.find((u) => u.username === username)
  return match ? match.id : null
}

async function main(): Promise<void> {
  if (!API_KEY) return

  const jacobId = await findUserIdByUsername(ASSIGNEE_USERNAME)
  if (jacobId === null) {
    console.error(`User '${ASSIGNEE_USERNAME}' not found on Vikunja instance`)
    process.exitCode = 1
    return
  }
  console.log(`Found user '${ASSIGNEE_USERNAME}' with id ${jacobId}`)

  // Fetch all tasks across all projects (dedupe by id).
  const projects = await apiList<{ id: number; title: string }>('/projects?per_page=200')
  const tasks = new Map<number, VikunjaTask>()
  for (const p of projects) {
    try {
      const batch = await apiList<VikunjaTask>(`/projects/${p.id}/tasks?per_page=200`)
      for (const t of batch) {
        if (!tasks.has(t.id)) tasks.set(t.id, t)
      }
    } catch {
      // Skip projects we can't read
    }
  }

  const allTasks = Array.from(tasks.values())
  const labeledTasks = allTasks.filter((task) =>
    task.labels?.some((label) => label.title === HONEYDO_LABEL)
  )

  console.log(
    `${labeledTasks.length} of ${allTasks.length} task(s) carry the '${HONEYDO_LABEL}' label`
  )

  const toAssign = labeledTasks.filter(
    (task) => !task.assignees?.some((a) => a.id === jacobId)
  )
  console.log(`${toAssign.length} task(s) need '${ASSIGNEE_USERNAME}' assigned`)

  if (DRY_RUN) {
    for (const task of toAssign) {
      console.log(`would assign ${jacobId} to task ${task.id}: ${task.title}`)
    }
    console.log(`${toAssign.length} task(s) would be updated`)
    return
  }

  let succeeded = 0
  const failures: string[] = []
  for (const task of toAssign) {
    try {
      await apiRequest(`/tasks/${task.id}/assignees`, {
        method: 'PUT',
        body: JSON.stringify({ user_id: jacobId }),
      })
      succeeded++
    } catch (error) {
      failures.push(
        `${task.id}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  console.log(`Assigned '${ASSIGNEE_USERNAME}' to ${succeeded} task(s)`)
  if (failures.length > 0) {
    console.error(`Failed to assign ${failures.length} task(s):`)
    for (const failure of failures) console.error(`  ${failure}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
