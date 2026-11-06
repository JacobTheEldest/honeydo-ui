import { ChevronDown, ChevronRight } from 'lucide-react'
import type { TaskTreeNode } from '../utils/taskTree.ts'

interface TaskSubtreePreviewProps {
  node: TaskTreeNode
  collapsed: Set<number>
  baseDepth?: number
  placeholder?: boolean
  dropMode?: 'sibling' | 'child'
  siblingAnchor?: 'above' | 'below'
}

/** Rendered either as the pointer-following overlay or as the in-list drop destination. */
export default function TaskSubtreePreview({
  node,
  collapsed,
  baseDepth = 0,
  placeholder = false,
  dropMode,
  siblingAnchor = 'below',
}: TaskSubtreePreviewProps) {
  const renderNode = (current: TaskTreeNode, relativeDepth: number) => {
    const isCollapsed = collapsed.has(current.id)
    const hasChildren = current.children.length > 0

    return (
      <div
        key={current.id}
        data-drag-preview-row={current.id}
        data-drop-preview-row={placeholder ? current.id : undefined}
        className={placeholder && relativeDepth === 0 ? 'relative' : undefined}
      >
        {placeholder && relativeDepth === 0 && (
          <span
            data-drop-preview-guide
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-honey/70"
            style={{ left: `${8 + baseDepth * 16}px` }}
          />
        )}
        <div
          className={`relative flex items-center gap-2 border-b px-4 py-3 last:border-b-0 ${
            placeholder
              ? 'border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-400'
              : 'border-gray-100 bg-white text-gray-800 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200'
          }`}
          style={{ paddingLeft: `${16 + (baseDepth + relativeDepth) * 16}px` }}
        >
          <span className="flex w-4 shrink-0 items-center justify-center text-gray-400 dark:text-gray-500" aria-hidden="true">
            {hasChildren ? (
              isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />
            ) : null}
          </span>
          <span className={`min-w-0 flex-1 truncate ${current.done ? 'text-gray-400 line-through dark:text-gray-500' : ''}`}>
            {current.title}
          </span>
          {placeholder && relativeDepth === 0 && dropMode && (
            <div data-drop-preview-halves className="pointer-events-none absolute inset-0 z-20 grid grid-cols-2" aria-hidden="true">
              <div
                data-drop-preview-half="sibling"
                className={`flex items-center justify-center border-r border-honey/50 px-1 text-center text-[10px] font-semibold uppercase tracking-wide ${
                  dropMode === 'sibling'
                    ? 'bg-honey/55 text-amber-950 dark:text-amber-100'
                    : 'bg-gray-100/40 text-gray-500 dark:bg-gray-900/30 dark:text-gray-300'
                }`}
              >
                Sibling of {siblingAnchor}
              </div>
              <div
                data-drop-preview-half="child"
                className={`flex items-center justify-center px-1 text-center text-[10px] font-semibold uppercase tracking-wide ${
                  dropMode === 'child'
                    ? 'bg-honey/55 text-amber-950 dark:text-amber-100'
                    : 'bg-gray-100/40 text-gray-500 dark:bg-gray-900/30 dark:text-gray-300'
                }`}
              >
                Child of above
              </div>
            </div>
          )}
        </div>
        {!isCollapsed && current.children.map((child) => renderNode(child, relativeDepth + 1))}
      </div>
    )
  }

  return (
    <div
      data-drag-preview={!placeholder || undefined}
      data-drop-preview={placeholder ? 'true' : undefined}
      data-drop-preview-mode={placeholder ? dropMode : undefined}
      aria-hidden="true"
      className={placeholder
        ? 'relative pointer-events-none w-full opacity-60'
        : 'pointer-events-none w-full max-w-xl overflow-hidden rounded-lg bg-white opacity-90 shadow-xl ring-1 ring-black/10 dark:bg-gray-800 dark:ring-white/10'}
    >
      {renderNode(node, 0)}
    </div>
  )
}
