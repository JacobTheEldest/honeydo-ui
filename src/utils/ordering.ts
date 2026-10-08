const BASE_DATE = new Date('2000-01-01T00:00:00Z').getTime()
const INTERVAL_MS = 60_000 // 60 seconds between positions

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