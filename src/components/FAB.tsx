import { Plus } from 'lucide-react'

interface FABProps {
  open: boolean
  onToggle: () => void
}

/**
 * Floating add button. Tapping it opens the new-task composer at the top of
 * the task list; tapping it again closes the composer (outside clicks and
 * Escape close it too).
 */
export default function FAB({ open, onToggle }: FABProps) {
  return (
    <div className="fixed bottom-6 right-6 z-50">
      <button
        data-composer-toggle
        onClick={onToggle}
        className="
          w-14 h-14 rounded-full bg-honey text-white shadow-lg
          flex items-center justify-center
          hover:bg-honey-dark active:scale-95 transition-transform
        "
        aria-label={open ? 'Close' : 'Add task'}
        aria-expanded={open}
      >
        <Plus className={`w-6 h-6 transition-transform duration-200 ${open ? 'rotate-45' : ''}`} />
      </button>
    </div>
  )
}
