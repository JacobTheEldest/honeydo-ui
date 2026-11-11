export interface UndoEntry {
  id: number
  title: string
}

export type UndoStackAction =
  | { type: 'push'; entry: UndoEntry }
  | { type: 'remove'; id: number }
  | { type: 'clear' }

/**
 * Undo affordance for completed tasks. The stack's last entry is the
 * completion currently surfaced in the toast; earlier entries are preserved
 * so quick successive completions stay undoable one after another.
 */
export function undoStackReducer(stack: UndoEntry[], action: UndoStackAction): UndoEntry[] {
  switch (action.type) {
    case 'push':
      // A task can only be completed once at a time; re-completing after an
      // undo moves its entry to the top instead of duplicating it.
      return [...stack.filter((entry) => entry.id !== action.entry.id), action.entry]
    case 'remove':
      return stack.filter((entry) => entry.id !== action.id)
    case 'clear':
      return []
  }
}

export function currentEntry(stack: UndoEntry[]): UndoEntry | null {
  return stack.length > 0 ? stack[stack.length - 1] : null
}
