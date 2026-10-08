import { useState } from 'react'
import { Plus } from 'lucide-react'

interface FABProps {
  onCreate: (title: string) => void
}

export default function FAB({ onCreate }: FABProps) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = value.trim()
    if (trimmed) {
      onCreate(trimmed)
      setValue('')
      setOpen(false)
    }
  }

  return (
    <div className="fixed bottom-6 right-6 z-50">
      {open && (
        <form
          onSubmit={handleSubmit}
          className="absolute bottom-16 right-0 w-72 bg-white rounded-xl shadow-lg border border-gray-200 p-4"
        >
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="New task..."
            autoFocus
            className="w-full px-3 py-2 text-base border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-honey/50"
          />
          <div className="flex justify-end gap-2 mt-3">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 text-sm bg-honey text-white rounded-lg hover:bg-honey-dark"
            >
              Add
            </button>
          </div>
        </form>
      )}
      <button
        onClick={() => setOpen(!open)}
        className="
          w-14 h-14 rounded-full bg-honey text-white shadow-lg
          flex items-center justify-center
          hover:bg-honey-dark active:scale-95 transition-transform
        "
        aria-label={open ? 'Close' : 'Add task'}
      >
        <Plus className={`w-6 h-6 transition-transform duration-200 ${open ? 'rotate-45' : ''}`} />
      </button>
    </div>
  )
}
