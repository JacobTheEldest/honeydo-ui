import type { VikunjaTask } from '../src/types/vikunja.ts'
import {
  isLegacyOrderingDate,
  migrateLegacyDueDate,
  ORDERING_EPOCH,
} from '../src/utils/ordering.ts'

/**
 * One-time migration for the ordering due_date epoch shift (2000 -> 2100).
 *
 * Honey-Do stores manual ordering in `due_date`. Existing tasks persisted
 * under the legacy 2000 epoch are shifted by the exact epoch delta so their
 * relative order is preserved. Only tasks in the Honey-Do forest are touched;
 * unrelated tasks keep their real due dates.
 *
 * Usage:
 *   HONEYDO_API_URL=http://127.0.0.1:40437 npx tsx scripts/migrate-ordering-epoch.ts --dry-run
 *   HONEYDO_API_URL=http://127.0.0.1:40437 npx tsx scripts/migrate-ordering-epoch.ts
 */

const API_ORIGIN = process.env.HONEYDO_API_URL ?? 'http://127.0.0.1:3000'
const API_BASE = `${API_ORIGIN.replace(/\/$/, '')}/api/v1`
const HONEYDO_LABEL = process.env.HONEYDO_LABEL ?? 'Honey-Do'
const DRY_RUN = process.argv.includes('--dry-run')
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

async function fetchTaskDetail(id: number): Promise<VikunjaTask> {
  return apiFetch<VikunjaTask>(`/tasks/${id}`)
}

/**
 * Walk subtask references reachable from any task in `seed`, following
 * related_tasks.subtask links. Depth is bounded and visited-set guarded so
 * cycles cannot spin. Each discovered task detail is merged into `sink`
 * (keyed by id).
 */
async function collectSubtaskDetails(
  seed: VikunjaTask[],
  sink: Map<number, VikunjaTask>
): Promise<void> {
  const detailed = new Set<number>()
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
}

async function main(): Promise<void> {
  const projects = await apiFetch<{ id: number; title: string }[]>('/projects?per_page=200')
  const tasks = new Map<number, VikunjaTask>()

  for (const project of projects) {
    try {
      const batch = await apiFetch<VikunjaTask[]>(`/projects/${project.id}/tasks?per_page=200`)
      for (const task of batch) {
        if (!tasks.has(task.id)) tasks.set(task.id, task)
      }
    } catch {
      // Skip projects we cannot read, matching the app's fetch behavior.
    }
  }

  const seed = Array.from(tasks.values())
  const honeyDoIds = seed
    .filter((task) => task.labels?.some((label) => label.title === HONEYDO_LABEL))
    .map((task) => task.id)
  const honeyDoDetails = await runWithConcurrency(honeyDoIds, DETAIL_CONCURRENCY, (id) =>
    fetchTaskDetail(id).catch(() => null)
  )
  for (const detail of honeyDoDetails) {
    if (!detail) continue
    const existing = tasks.get(detail.id)
    tasks.set(detail.id, {
      ...existing,
      ...detail,
      labels: detail.labels?.length ? detail.labels : (existing?.labels ?? []),
    })
  }

  await collectSubtaskDetails(Array.from(tasks.values()), tasks)

  const updates: Array<{ id: number; due_date: string }> = []
  for (const task of tasks.values()) {
    if (!task.due_date) continue
    if (!isLegacyOrderingDate(task.due_date)) continue
    updates.push({ id: task.id, due_date: migrateLegacyDueDate(task.due_date) })
  }

  if (DRY_RUN) {
    for (const update of updates) {
      console.log(`would migrate task ${update.id}: ${tasks.get(update.id)?.due_date} -> ${update.due_date}`)
    }
    console.log(`${updates.length} task(s) would be updated`)
    return
  }

  const failures: string[] = []
  await runWithConcurrency(updates, DETAIL_CONCURRENCY, async (update) => {
    const task = tasks.get(update.id)
    if (!task) return
    try {
      // POST /tasks/{id} is a full-resource write; send the complete task so
      // fields not modeled by this migration survive.
      await apiRequest(`/tasks/${update.id}`, {
        method: 'POST',
        body: JSON.stringify({ ...task, due_date: update.due_date }),
      })
    } catch (error) {
      failures.push(`${update.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  if (failures.length > 0) {
    console.error(`Migration failed for ${failures.length} task(s):`)
    for (const failure of failures) console.error(`  ${failure}`)
    process.exitCode = 1
    return
  }

  console.log(`Migrated ${updates.length} task(s) to the ${ORDERING_EPOCH.slice(0, 10)} ordering epoch`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
