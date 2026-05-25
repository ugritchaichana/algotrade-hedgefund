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
    // Allow remote-tunnel hosts (Vite 5+ blocks by default per CVE-2025-30208).
    // PIN auth still protects /api/* — adding hosts only opens the static asset serving.
    //   - Cloudflare Quick Tunnel: <random>.trycloudflare.com (new on each `cloudflared` restart)
    //   - Tailscale Magic DNS: <hostname>.ts.net
    //   - Future named domains via Cloudflare Access
    // Use leading dot to match all subdomains of the apex.
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      '.trycloudflare.com',
      '.ts.net',
      '.local',
    ],
  },
})
