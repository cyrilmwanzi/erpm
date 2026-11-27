import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.SCACE_API_URL || "http://127.0.0.1:3001";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 3000,
    hmr: false,
    proxy: {
      "/api/v1": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/api/auth": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/.well-known": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 3000,
    proxy: {
      "/api/v1": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/api/auth": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/.well-known": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
