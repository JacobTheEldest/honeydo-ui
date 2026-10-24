/**
 * Pure state transitions for the top-of-list new-task composer.
 *
 * The composer is a transient row rendered above the root task tree; it is
 * not a persisted or sortable task until submitted. Keeping its transitions
 * pure lets the interaction rules be regression-tested without a DOM.
 */

export interface ComposerPlacement {
  parentId: number | null
  beforeTaskId: number | null
  afterTaskId: number | null
}

export interface ComposerState {
  open: boolean
  instanceId: number
  title: string
  error: string | null
  placement: ComposerPlacement
}

export type ComposerEvent =
  | { type: 'open' }
  | { type: 'openAt'; placement: ComposerPlacement }
  | { type: 'move'; placement: ComposerPlacement }
  | { type: 'close' }
  | { type: 'titleChanged'; title: string }
  | { type: 'submitSucceeded'; taskId?: number; instanceId: number }
  | { type: 'submitFailed'; message: string; instanceId: number }

export const initialComposerState: ComposerState = {
  open: false,
  instanceId: 0,
  title: '',
  error: null,
  placement: { parentId: null, beforeTaskId: null, afterTaskId: null },
}

export function composerReducer(state: ComposerState, event: ComposerEvent): ComposerState {
  switch (event.type) {
    case 'open':
      // Fresh root composer starts at the top of the root sibling group.
      return { ...initialComposerState, open: true, instanceId: state.instanceId + 1 }
    case 'openAt':
      return { ...initialComposerState, open: true, instanceId: state.instanceId + 1, placement: event.placement }
    case 'move':
      return state.open ? { ...state, placement: event.placement, error: null } : state
    case 'close':
      return { ...initialComposerState, instanceId: state.instanceId }
    case 'titleChanged':
      return { ...state, title: event.title, error: null }
    case 'submitSucceeded':
      // Ignore responses from a dismissed composer if a newer one was opened.
      if (!state.open || state.instanceId !== event.instanceId) return state
      // After insertion, keep composing immediately after the created task.
      return {
        ...state,
        title: '',
        error: null,
        placement: event.taskId === undefined
          ? state.placement
          : { ...state.placement, beforeTaskId: null, afterTaskId: event.taskId },
      }
    case 'submitFailed':
      return state.open && state.instanceId === event.instanceId
        ? { ...state, error: event.message }
        : state
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
