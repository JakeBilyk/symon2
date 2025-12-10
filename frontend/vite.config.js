import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,          // so others on LAN can hit 192.168.x.x:5173
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4000", // your backend API
        changeOrigin: true
      }
    }
  }
});
