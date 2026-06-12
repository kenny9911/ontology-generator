import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Standalone Ontology Generator: a Vite SPA whose `/api` calls are proxied to
// the local API server (scripts/dev-api.mts) in dev. In production on Vercel the
// `api/**` files are served as serverless functions, so no proxy is needed.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 3598,
    proxy: {
      '/api': {
        target: 'http://localhost:5111',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (/[\\/]node_modules[\\/](react|react-dom)[\\/]/.test(id)) return 'vendor-react'
        },
      },
    },
  },
})
