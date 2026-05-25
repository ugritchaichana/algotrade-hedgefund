import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './lib/theme'  // Apply data-theme attribute before first render
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
