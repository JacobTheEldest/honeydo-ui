export function startedOnDragHandle(event: Event): boolean {
  const isHandle = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest('[data-drag-handle]') !== null

  if (isHandle(event.target)) return true
  return typeof event.composedPath === 'function' && event.composedPath().some(isHandle)
}
