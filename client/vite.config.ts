import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the client runs on :5173 and forwards /api to the server on :8095.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8095" } },
});
