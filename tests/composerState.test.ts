import assert from 'node:assert/strict'
import test from 'node:test'
import {
  composerReducer,
  initialComposerState,
  shouldCloseOnOutsideClick,
  type ComposerState,
} from '../src/utils/composerState.ts'

/** Open the composer with a draft title already typed. */
function openWith(title: string): ComposerState {
  const opened = composerReducer(initialComposerState, { type: 'open' })
  return composerReducer(opened, { type: 'titleChanged', title })
}

test('repeated Enter submissions keep the composer open and clear the title', () => {
  let state = openWith('First task')
  state = composerReducer(state, { type: 'submitSucceeded' })
  assert.deepEqual(state, { open: true, title: '', error: null })

  state = composerReducer(state, { type: 'titleChanged', title: 'Second task' })
  state = composerReducer(state, { type: 'submitSucceeded' })
  assert.deepEqual(state, { open: true, title: '', error: null })

  state = composerReducer(state, { type: 'titleChanged', title: 'Third task' })
  state = composerReducer(state, { type: 'submitSucceeded' })
  assert.equal(state.open, true)
  assert.equal(state.title, '')
})

test('a failed submit keeps the composer open, preserves the title, and shows the error', () => {
  let state = openWith('Buy milk')
  state = composerReducer(state, { type: 'submitFailed', message: 'API /projects/1/tasks failed: 500' })
  assert.deepEqual(state, {
    open: true,
    title: 'Buy milk',
    error: 'API /projects/1/tasks failed: 500',
  })
  // Editing the title clears the stale error for the retry.
  state = composerReducer(state, { type: 'titleChanged', title: 'Buy oat milk' })
  assert.equal(state.title, 'Buy oat milk')
  assert.equal(state.error, null)
})

test('outside-click dismissal (and Escape/FAB close) resets the composer', () => {
  for (const event of [
    { type: 'close' as const }, // dispatched by the outside-click handler
  ]) {
    const state = composerReducer(openWith('Draft'), event)
    assert.deepEqual(state, initialComposerState)
  }
})

test('clicks inside the composer or on its FAB toggle do not dismiss it', () => {
  const isInsideComposer = (target: unknown) => target === 'input' || target === 'submit-button'
  const isToggleControl = (target: unknown) => target === 'fab'
  assert.equal(shouldCloseOnOutsideClick('input', isInsideComposer, isToggleControl), false)
  assert.equal(shouldCloseOnOutsideClick('submit-button', isInsideComposer, isToggleControl), false)
  assert.equal(shouldCloseOnOutsideClick('fab', isInsideComposer, isToggleControl), false)
  assert.equal(shouldCloseOnOutsideClick('task-row', isInsideComposer, isToggleControl), true)
  assert.equal(shouldCloseOnOutsideClick(null, isInsideComposer, isToggleControl), true)
})

test('open resets a stale draft and error', () => {
  const failed = composerReducer(openWith('Buy milk'), { type: 'submitFailed', message: 'boom' })
  const closed = composerReducer(failed, { type: 'close' })
  assert.deepEqual(composerReducer(closed, { type: 'open' }), { open: true, title: '', error: null })
})

test('a completed submit does not reopen a composer dismissed mid-request', () => {
  const dismissedMidFlight = composerReducer(openWith('Draft'), { type: 'close' })
  const after = composerReducer(dismissedMidFlight, { type: 'submitSucceeded' })
  assert.equal(after.open, false)
  assert.equal(after.title, '')
})
