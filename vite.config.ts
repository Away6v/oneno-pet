import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Tauri 开发主机（用于移动/局域网调试；桌面开发一般为空）
const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig({
  // 让 Tauri CLI 的输出不被 Vite 清屏覆盖
  clearScreen: false,
  server: {
    // Tauri 需要固定端口；被占用时直接失败而非静默切换
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // 无需监听 Rust 侧变更
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
    // 多页面：桌宠主窗口 / 右键菜单 / 设置 / 气泡会话框 / 下班倒计时面板
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        menu: fileURLToPath(new URL("./menu.html", import.meta.url)),
        settings: fileURLToPath(new URL("./settings.html", import.meta.url)),
        speech: fileURLToPath(new URL("./speech.html", import.meta.url)),
        countdown: fileURLToPath(new URL("./countdown.html", import.meta.url)),
      },
    },
  },
});
