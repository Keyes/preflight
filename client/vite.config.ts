import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// the server's port: PORT, as the server reads it, so `PORT=3002 npm run dev` moves both ends
const SERVER = `127.0.0.1:${process.env.PORT ?? 3001}`

export default defineConfig({
  plugins: [vue()],
  server: {
    // The server only answers requests whose Origin matches their Host, so the proxy passes the browser's Host on as it is
    // (the short form, '/api': url, would replace it with the server's address).
    proxy: {
      '/api': { target: `http://${SERVER}`, changeOrigin: false },
      '/ws': { target: `ws://${SERVER}`, ws: true },
    },
  },
})
