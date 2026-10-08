import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { useVikunjaApi } from './hooks/useVikunjaApi.ts'
import TaskItem from './components/TaskItem.tsx'
import FAB from './components/FAB.tsx'
import {
  positionToDueDate,
  dueDateToPosition,
  getMidpointPosition,
  needsRebalance,
  rebalancePositions,
  getTopPosition,
} from './utils/ordering.ts'

const HONEYDO_LABEL = 'Honey-Do'
const DEFAULT_PROJECT_ID = 1 // Inbox

export default function App() {
  const {
    labels,
    tasks,
    loading,
    error,
    fetchTasks,
    createTask,
    updateTask,
    addLabelToTask,
    createLabel,
  } = useVikunjaApi()

  const [showCompleted, setShowCompleted] = useState(false)
  const [honeyDoLabelId, setHoneyDoLabelId] = useState<number | null>(null)

  // Find or create Honey-Do label
  useEffect(() => {
    const existing = labels.find((l) => l.title === HONEYDO_LABEL)
    if (existing) {
      setHoneyDoLabelId(existing.id)
    } else if (labels.length > 0 && honeyDoLabelId === null) {
      // Auto-create label once we know it doesn't exist
      createLabel(HONEYDO_LABEL).then((label) => {
        setHoneyDoLabelId(label.id)
      })
    }
  }, [labels, honeyDoLabelId, createLabel])

  // Fetch tasks on mount
  useEffect(() => {
    fetchTasks().catch(() => {})
  }, [fetchTasks])

  // Filter and sort Honey-Do tasks by due_date
  const honeyDoTasks = useMemo(() => {
    return tasks
      .filter((t) => t.labels?.some((l) => l.title === HONEYDO_LABEL))
      .sort((a, b) => {
        const aPos = a.due_date ? new Date(a.due_date).getTime() : Infinity
        const bPos = b.due_date ? new Date(b.due_date).getTime() : Infinity
        return aPos - bPos
      })
  }, [tasks])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return

      const oldIndex = honeyDoTasks.findIndex((t) => t.id === active.id)
      const newIndex = honeyDoTasks.findIndex((t) => t.id === over.id)
      if (oldIndex === -1 || newIndex === -1) return

      const reordered = arrayMove(honeyDoTasks, oldIndex, newIndex)

      // Compute new due_dates
      const positions = reordered.map((t) =>
        t.due_date ? dueDateToPosition(t.due_date) : 0
      )

      // Check if we need to rebalance
      if (needsRebalance(positions)) {
        const fresh = rebalancePositions(reordered.length)
        reordered.forEach((task, i) => {
          updateTask(task.id, { due_date: positionToDueDate(fresh[i]) })
        })
      } else {
        // Use midpoint for the moved task
        const movedTask = reordered[newIndex]
        let newPos: number
        if (newIndex === 0) {
          newPos = getTopPosition()
        } else if (newIndex === reordered.length - 1) {
          const prevPos = dueDateToPosition(reordered[newIndex - 1].due_date)
          newPos = prevPos + 1
        } else {
          const prevPos = dueDateToPosition(reordered[newIndex - 1].due_date)
          const nextPos = dueDateToPosition(reordered[newIndex + 1].due_date)
          newPos = getMidpointPosition(prevPos, nextPos)
        }
        updateTask(movedTask.id, { due_date: positionToDueDate(newPos) })
      }
    },
    [honeyDoTasks, updateTask]
  )

  const handleToggleDone = useCallback(
    (id: number, done: boolean) => {
      updateTask(id, { done })
    },
    [updateTask]
  )

  const handleUpdateTitle = useCallback(
    (id: number, title: string) => {
      updateTask(id, { title })
    },
    [updateTask]
  )

  const handleCreateTask = useCallback(
    async (title: string) => {
      if (!honeyDoLabelId) return
      const task = await createTask({
        title,
        project_id: DEFAULT_PROJECT_ID,
        due_date: positionToDueDate(getTopPosition()),
      })
      await addLabelToTask(task.id, honeyDoLabelId)
    },
    [honeyDoLabelId, createTask, addLabelToTask]
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  return (
    <div className="min-h-svh bg-white">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white/90 backdrop-blur border-b border-gray-100 px-4 py-3">
        <div className="flex items-center justify-between max-w-xl mx-auto">
          <h1 className="text-xl font-semibold text-honey-dark">HoneyDo</h1>
          <button
            onClick={() => setShowCompleted(!showCompleted)}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5 rounded-lg hover:bg-gray-50"
          >
            {showCompleted ? (
              <>
                <Eye className="w-4 h-4" /> Hide done
              </>
            ) : (
              <>
                <EyeOff className="w-4 h-4" /> Show done
              </>
            )}
          </button>
        </div>
      </header>

      {/* Task list */}
      <main className="max-w-xl mx-auto pb-24">
        {loading && honeyDoTasks.length === 0 && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-honey animate-spin" />
            <span className="ml-2 text-gray-500">Loading tasks...</span>
          </div>
        )}

        {error && (
          <div className="px-4 py-8 text-center">
            <p className="text-red-500">{error}</p>
            <button
              onClick={() => fetchTasks()}
              className="mt-2 text-honey hover:underline"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && honeyDoTasks.length === 0 && (
          <div className="px-4 py-20 text-center">
            <p className="text-gray-400 text-lg">No Honey-Do tasks yet</p>
            <p className="text-gray-400 text-sm mt-1">
              Tap the + button to add one
            </p>
          </div>
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={honeyDoTasks.map((t) => t.id)}
            strategy={verticalListSortingStrategy}
          >
            {honeyDoTasks.map((task) => (
              <TaskItem
                key={task.id}
                task={task}
                onToggleDone={handleToggleDone}
                onUpdateTitle={handleUpdateTitle}
                showCompleted={showCompleted}
              />
            ))}
          </SortableContext>
        </DndContext>
      </main>

      {/* FAB */}
      <FAB onCreate={handleCreateTask} />
    </div>
  )
}
