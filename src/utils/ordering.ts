import type { VikunjaTask } from '../types/vikunja.ts'

const BASE_DATE = new Date('2100-01-01T00:00:00Z').getTime()
const LEGACY_BASE_DATE = new Date('2000-01-01T00:00:00Z').getTime()
const LEGACY_ORDERING_CUTOFF = new Date('2050-01-01T00:00:00Z').getTime()
const INTERVAL_MS = 60_000 // 60 seconds between positions

/** Exact millisecond offset between the legacy (2000) and current (2100) ordering epochs. */
export const ORDERING_EPOCH_DELTA_MS = BASE_DATE - LEGACY_BASE_DATE

/** ISO timestamp of the current ordering epoch. */
export const ORDERING_EPOCH = new Date(BASE_DATE).toISOString()

export function positionToDueDate(position: number): string {
  const timestamp = BASE_DATE + position * INTERVAL_MS
  return new Date(timestamp).toISOString()
}

export function dueDateToPosition(dueDate: string | null): number {
  if (!dueDate) return 0
  const timestamp = new Date(dueDate).getTime()
  return (timestamp - BASE_DATE) / INTERVAL_MS
}

export function getMidpointPosition(prevPos: number, nextPos: number): number {
  return (prevPos + nextPos) / 2
}

/** Insert after a row without colliding with the next persisted sibling. */
export function getSequentialPosition(afterPosition: number, siblingPositions: number[]): number {
  const nextPosition = siblingPositions
    .filter((position) => Number.isFinite(position) && position > afterPosition)
    .reduce((next, position) => Math.min(next, position), Infinity)
  return Number.isFinite(nextPosition)
    ? getMidpointPosition(afterPosition, nextPosition)
    : afterPosition + 1
}

export function needsRebalance(positions: number[]): boolean {
  for (let i = 1; i < positions.length; i++) {
    const gap = positions[i] - positions[i - 1]
    if (gap < 1 / 60) { // less than 1 second
      return true
    }
  }
  return false
}

export function rebalancePositions(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i)
}

export function getTopPosition(): number {
  return -1 // One interval before base
}

export function isLegacyOrderingDate(dueDate: string): boolean {
  const timestamp = new Date(dueDate).getTime()
  return Number.isFinite(timestamp) && timestamp < LEGACY_ORDERING_CUTOFF
}

/**
 * Shift a legacy ordering due_date to the current epoch while preserving its
 * relative position. Returns the input unchanged if it is not a parseable
 * legacy ordering date.
 */
export function migrateLegacyDueDate(dueDate: string): string {
  if (!isLegacyOrderingDate(dueDate)) return dueDate
  const timestamp = new Date(dueDate).getTime()
  return new Date(timestamp + ORDERING_EPOCH_DELTA_MS).toISOString()
}

export interface GroupRebalance {
  id: number
  due_date: string
}

/**
 * Recompute due_date values for a sibling group after a reorder.
 * Preserves the relative order of `group` and re-emits them with new positions.
 *
 * Strategy:
 *  - Try to keep existing positions and only nudge the moved task to the
 *    midpoint of its new neighbors (cheap, no churn).
 *  - If positions are too tight to insert a midpoint, rebalance the entire
 *    group into fresh integer positions, preserving the current order.
 *  - The caller decides what "outside this group" looks like — we only touch
 *    tasks whose ids are in `group`. Untouched siblings retain their
 *    due_dates.
 */
export function rebalanceGroup(group: VikunjaTask[]): GroupRebalance[] {
  if (group.length === 0) return []
  const positions = group.map((t) => dueDateToPosition(t.due_date))
  if (needsRebalance(positions)) {
    const fresh = rebalancePositions(group.length)
    return group.map((t, i) => ({ id: t.id, due_date: positionToDueDate(fresh[i]) }))
  }
  return group.map((t) => ({ id: t.id, due_date: t.due_date ?? positionToDueDate(0) }))
}
