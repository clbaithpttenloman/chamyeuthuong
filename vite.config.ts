import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: { environment: 'node' },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        // Inject the dev Access JWT from the environment so the worker can verify it.
        // Set DEV_ACCESS_JWT (printed by `npm run dev:access`) before starting `npm run dev`.
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq) => {
            const jwt = process.env['DEV_ACCESS_JWT']
            if (jwt) proxyReq.setHeader('Cf-Access-Jwt-Assertion', jwt)
          })
        },
      },
    },
  },
})
