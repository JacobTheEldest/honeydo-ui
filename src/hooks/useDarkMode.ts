import { useEffect, useState } from 'react'

const STORAGE_KEY = 'honeydo-dark-mode'

export function useDarkMode() {
  const [dark, setDark] = useState<boolean>(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === null) return true // default: dark
    return stored === 'true'
  })

  useEffect(() => {
    const root = document.documentElement
    if (dark) root.classList.add('dark')
    else root.classList.remove('dark')
    localStorage.setItem(STORAGE_KEY, String(dark))
  }, [dark])

  return { dark, toggle: () => setDark((d) => !d) }
}
