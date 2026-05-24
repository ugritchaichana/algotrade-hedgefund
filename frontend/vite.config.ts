import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Listen on all interfaces for LAN access.
    // Access from phone/other PC: http://<BACKEND-PC-IP>:5173
    host: true,
    port: 5173,
    strictPort: true,
  },
})
