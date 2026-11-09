import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { defaultClientConditions, defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    // Read workspace packages from source so edits to @clipforge/shared hot-reload without a rebuild.
    conditions: ["source", ...defaultClientConditions],
  },
  clearScreen: false, // keep Rust errors visible
  server: {
    port: 1420,
    strictPort: true, // Tauri expects a fixed port
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
