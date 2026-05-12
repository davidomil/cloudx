import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "https://127.0.0.1:3001",
        changeOrigin: true,
        secure: false
      },
      "/ws": {
        target: "wss://127.0.0.1:3001",
        changeOrigin: true,
        secure: false,
        ws: true
      }
    }
  }
});
