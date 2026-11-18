/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // O servidor só aceita a origem do Vite na porta 5173 (ORCHESTRATOR_DEV_PORTS). Se a porta estiver
    // ocupada, falhar é melhor do que subir em outra porta e receber 403 em toda requisição.
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4317",
      "/ws": { target: "ws://127.0.0.1:4317", ws: true },
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
    passWithNoTests: true,
  },
});
