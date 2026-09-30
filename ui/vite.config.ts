import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 3000,
  },
  optimizeDeps: {
    include: ["d3"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.VITE_BACKEND_PORT ?? 3100}`,
        ws: true,
      },
      "/_plugins": {
        target: `http://localhost:${process.env.VITE_BACKEND_PORT ?? 3100}`,
      },
    },
  },
});
