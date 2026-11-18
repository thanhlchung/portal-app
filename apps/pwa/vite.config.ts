import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the API is a separate process; proxying /api keeps the
    // browser on a single origin, which is also how production works (the
    // static site rewrites /api/* to the web service). Same-origin means the
    // session cookie is first-party in both environments.
    proxy: {
      "/api": {
        target: process.env.API_ORIGIN ?? "http://localhost:8787",
        changeOrigin: false,
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
