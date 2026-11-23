import ConfirmScopeDialog from './ConfirmScopeDialog.tsx'
import type { UnassignScope } from '../utils/unlabel.ts'

interface UnassignConfirmDialogProps {
  taskTitle: string
  /** Recursive descendant count; when 0 the dialog is the compact leaf form. */
  descendantCount: number
  busy: boolean
  onCancel: () => void
  onConfirm: (scope: UnassignScope) => void
  /** Focused after close when the opening control is gone (task left the view). */
  returnFocusSelector?: string
}

/** Confirmation dialog for unassigning tasks from the selected user. */
export default function UnassignConfirmDialog({
  taskTitle,
  descendantCount,
  busy,
  onCancel,
  onConfirm,
  returnFocusSelector,
}: UnassignConfirmDialogProps) {
  return (
    <ConfirmScopeDialog<UnassignScope>
      title="Unassign task?"
      taskTitle={taskTitle}
      scopeQuestion="Which tasks should be unassigned?"
      scopeName="unassign-scope"
      options={descendantCount > 0 ? [
        { value: 'task', label: 'This task only' },
        { value: 'subtree', label: `This task and all subtasks (${descendantCount})` },
      ] : undefined}
      defaultScope="task"
      description="This removes the selected user from the task and clears its list ordering metadata. It does not delete any task or change subtask relationships. Subtasks without their own assignment may disappear from this view."
      confirmLabel="Unassign"
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
      returnFocusSelector={returnFocusSelector}
    />
  )
}
