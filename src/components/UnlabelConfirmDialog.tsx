import ConfirmScopeDialog from './ConfirmScopeDialog.tsx'
import type { UnlabelScope } from '../utils/unlabel.ts'

interface UnlabelConfirmDialogProps {
  taskTitle: string
  /** Recursive descendant count; when 0 the dialog is the compact leaf form. */
  descendantCount: number
  busy: boolean
  onCancel: () => void
  onConfirm: (scope: UnlabelScope) => void
  /** Focused after close when the opening control is gone (task left the view). */
  returnFocusSelector?: string
}

/** Confirmation dialog for removing tasks from Honey-Do. */
export default function UnlabelConfirmDialog({
  taskTitle,
  descendantCount,
  busy,
  onCancel,
  onConfirm,
  returnFocusSelector,
}: UnlabelConfirmDialogProps) {
  return (
    <ConfirmScopeDialog<UnlabelScope>
      title="Remove from Honey-Do?"
      taskTitle={taskTitle}
      scopeQuestion="Which tasks should leave Honey-Do?"
      scopeName="unlabel-scope"
      options={descendantCount > 0 ? [
        { value: 'task', label: 'This task only' },
        { value: 'subtree', label: `This task and all subtasks (${descendantCount})` },
      ] : undefined}
      defaultScope="task"
      description="This removes the Honey-Do label and its list ordering metadata. It does not delete any
        task or change subtask relationships. Subtasks without their own Honey-Do label may
        disappear from this view."
      confirmLabel="Remove from Honey-Do"
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
      returnFocusSelector={returnFocusSelector}
    />
  )
}
