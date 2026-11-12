import ConfirmScopeDialog from './ConfirmScopeDialog.tsx'
import type { DeleteScope } from '../utils/delete.ts'

interface DeleteConfirmDialogProps {
  taskTitle: string
  /** Recursive descendant count; when 0 the dialog is the compact leaf form. */
  descendantCount: number
  busy: boolean
  onCancel: () => void
  onConfirm: (scope: DeleteScope) => void
  /** Focused after close when the opening control is gone (task left the view). */
  returnFocusSelector?: string
}

/** Confirmation dialog for deleting tasks from Vikunja. */
export default function DeleteConfirmDialog({
  taskTitle,
  descendantCount,
  busy,
  onCancel,
  onConfirm,
  returnFocusSelector,
}: DeleteConfirmDialogProps) {
  return (
    <ConfirmScopeDialog<DeleteScope>
      title="Delete task?"
      taskTitle={taskTitle}
      scopeQuestion="Which tasks should be deleted?"
      scopeName="delete-scope"
      options={descendantCount > 0 ? [
        { value: 'task', label: 'This task only' },
        { value: 'subtree', label: `This task and all subtasks (${descendantCount})` },
      ] : undefined}
      defaultScope="task"
      description="The task is deleted from Vikunja. You can undo from the message that appears right
        after. Deleting only this task leaves its subtasks in Vikunja without a parent;
        subtasks without their own Honey-Do label may disappear from this view."
      confirmLabel="Delete"
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
      returnFocusSelector={returnFocusSelector}
    />
  )
}
