import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/', // Cloudflare Pages 域名根路径部署
  plugins: [vue()],
  server: {
    // 本地 dev 没有 Pages Functions 环境：把 /fb-proxy 转发到线上 Pages 测试
    proxy: {
      '/fb-proxy': {
        target: 'https://feihuasplatoon.pages.dev',
        changeOrigin: true,
      },
    },
  },
})
