export type TaskMutation = () => Promise<unknown>

export interface TaskMutationQueue {
  /**
   * Queue a task mutation behind any in-flight mutation for the same task.
   * Vikunja's task write is a full-resource POST, so concurrent writes to one
   * task must reach the server in the order the user issued them (e.g. a
   * complete-then-undo must land as done:false, never done:true). Mutations
   * for different tasks run independently, and a rejected mutation never
   * blocks the ones queued behind it.
   */
  enqueue(taskId: number, mutation: TaskMutation): Promise<unknown>
}

export function createTaskMutationQueue(): TaskMutationQueue {
  const chains = new Map<number, Promise<unknown>>()

  return {
    enqueue(taskId, mutation) {
      const previous = chains.get(taskId) ?? Promise.resolve()
      const next = previous.then(mutation, mutation)
      chains.set(taskId, next)
      const release = () => {
        if (chains.get(taskId) === next) chains.delete(taskId)
      }
      next.then(release, release)
      return next
    },
  }
}
