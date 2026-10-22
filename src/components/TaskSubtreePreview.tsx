import { ChevronDown, ChevronRight } from 'lucide-react'
import type { TaskTreeNode } from '../utils/taskTree.ts'

interface TaskSubtreePreviewProps {
  node: TaskTreeNode
  collapsed: Set<number>
}

/** A non-interactive visual copy used only inside DragOverlay. */
export default function TaskSubtreePreview({ node, collapsed }: TaskSubtreePreviewProps) {
  const renderNode = (current: TaskTreeNode, relativeDepth: number) => {
    const isCollapsed = collapsed.has(current.id)
    const hasChildren = current.children.length > 0

    return (
      <div key={current.id} data-drag-preview-row={current.id}>
        <div
          className="flex items-center gap-2 border-b border-gray-100 bg-white px-4 py-3 text-gray-800 last:border-b-0 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
          style={{ paddingLeft: `${16 + relativeDepth * 16}px` }}
        >
          <span className="flex w-4 shrink-0 items-center justify-center text-gray-400 dark:text-gray-500" aria-hidden="true">
            {hasChildren ? (
              isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />
            ) : null}
          </span>
          <span className={`min-w-0 flex-1 truncate ${current.done ? 'text-gray-400 line-through dark:text-gray-500' : ''}`}>
            {current.title}
          </span>
        </div>
        {!isCollapsed && current.children.map((child) => renderNode(child, relativeDepth + 1))}
      </div>
    )
  }

  return (
    <div
      data-drag-preview
      aria-hidden="true"
      className="pointer-events-none w-full max-w-xl overflow-hidden rounded-lg bg-white opacity-90 shadow-xl ring-1 ring-black/10 dark:bg-gray-800 dark:ring-white/10"
    >
      {renderNode(node, 0)}
    </div>
  )
}
