/**
 * Pure state transitions for the top-of-list new-task composer.
 *
 * The composer is a transient row rendered above the root task tree; it is
 * not a persisted or sortable task until submitted. Keeping its transitions
 * pure lets the interaction rules be regression-tested without a DOM.
 */

export interface ComposerState {
  open: boolean
  title: string
  error: string | null
}

export type ComposerEvent =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'titleChanged'; title: string }
  | { type: 'submitSucceeded' }
  | { type: 'submitFailed'; message: string }

export const initialComposerState: ComposerState = { open: false, title: '', error: null }

export function composerReducer(state: ComposerState, event: ComposerEvent): ComposerState {
  switch (event.type) {
    case 'open':
      // Fresh open starts empty; a stale error from a prior attempt is gone.
      return { open: true, title: '', error: null }
    case 'close':
      // Escape, outside click, and the FAB all cancel without creating anything.
      return { open: false, title: '', error: null }
    case 'titleChanged':
      return { ...state, title: event.title, error: null }
    case 'submitSucceeded':
      // Keep the composer open with an empty title and restored focus so
      // another task can be added immediately. A composer the user already
      // dismissed mid-request stays closed.
      return { ...state, title: '', error: null }
    case 'submitFailed':
      // Keep the composer open with the title preserved for a retry.
      return { ...state, error: event.message }
  }
}

/**
 * Decide whether a document-level click should dismiss the composer.
 * Clicks inside the composer row (including its submit affordance) and on
 * the FAB toggle must not dismiss it through this path.
 */
export function shouldCloseOnOutsideClick(
  target: unknown,
  isInsideComposer: (target: unknown) => boolean,
  isToggleControl: (target: unknown) => boolean
): boolean {
  if (target === null || target === undefined) return true
  return !isInsideComposer(target) && !isToggleControl(target)
}
