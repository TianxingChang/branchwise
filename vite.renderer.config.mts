import path from "node:path";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    // imports.vite.js reaches its 53 asset files through `?url` imports,
    // which rolldown's prebundler opens as literal file names ("cs.json?url",
    // ENOENT). Excluded, the package goes through the normal transform
    // pipeline instead, where `?url` is understood.
    exclude: ["@tldraw/assets"],
  },
  plugins: [
    tanstackRouter({
      target: "react",
    }),
    tailwindcss(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
    preserveSymlinks: true,
  },
});
