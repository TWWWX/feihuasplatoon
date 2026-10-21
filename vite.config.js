import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/', // Cloudflare Pages 域名根路径部署
  plugins: [vue()],
})
