import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      // Native module: it has to be loaded from node_modules at runtime, not
      // inlined into the bundle.
      external: ["node-pty", "@anthropic-ai/claude-agent-sdk"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
