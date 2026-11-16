import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: { environment: 'node' },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
})
