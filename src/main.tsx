import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Apply persisted dark mode before first paint to avoid flash
const stored = localStorage.getItem('honeydo-dark-mode')
if (stored === null || stored === 'true') {
  document.documentElement.classList.add('dark')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)