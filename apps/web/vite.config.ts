import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const backendOrigin = "https://127.0.0.1:3001";
const backendWebSocketTarget = "wss://127.0.0.1:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "https://127.0.0.1:3001",
        changeOrigin: true,
        secure: false
      },
      "/ws": {
        target: backendWebSocketTarget,
        changeOrigin: true,
        secure: false,
        ws: true,
        configure: (proxy) => {
          proxy.on("proxyReqWs", (proxyReq) => {
            proxyReq.setHeader("origin", backendOrigin);
          });
        }
      }
    }
  }
});
