import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { cloudflare } from "@cloudflare/vite-plugin";

// 开发期由 Cloudflare 插件在本地 workerd 里跑 worker/index.ts，/api/* 与线上同一套代码；
// 构建产物 dist/ 里前端与 Worker 各一份，`wrangler deploy` 一起上。
export default defineConfig({
  plugins: [vue(), cloudflare()],
  server: { host: "127.0.0.1" },
});
