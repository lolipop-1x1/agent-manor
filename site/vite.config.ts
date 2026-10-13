import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  base: process.env.SITE_BASE_PATH ?? "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: { output: { manualChunks: id => id.includes("/node_modules/three/") ? "three" : undefined } },
  },
  server: { host: "127.0.0.1", port: 4175, strictPort: true },
  preview: { host: "127.0.0.1", port: 4175, strictPort: true },
});
